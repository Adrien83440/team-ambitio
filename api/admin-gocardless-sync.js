/**
 * api/admin-gocardless-sync.js
 *
 * Synchronisation manuelle GoCardless → Firestore.
 *
 * Scanne l'API GoCardless live (mandates / subscriptions / payments) sur une
 * fenêtre temporelle et réconcilie l'état Firestore :
 *
 *   1. CUSTOMERS (action: 'customers')
 *      Pour chaque GC customer dans la fenêtre :
 *        - Cherche invoice_clients(gcCustomerId=customerId)
 *        - Si introuvable → alerte 'sync_orphan_gc_customer' (à matcher manuellement)
 *
 *   2. SUBSCRIPTIONS (action: 'subscriptions')
 *      Pour chaque GC subscription dans la fenêtre :
 *        - Cherche subscriptions Firestore(gcSubscriptionId=subId)
 *        - Si introuvable → alerte 'sync_orphan_gc_subscription'
 *        - Si trouvée → met à jour installmentsPaidOnGC depuis le compteur GC
 *
 *   3. PAYMENTS (action: 'payments')
 *      Pour chaque GC payment status=paid_out|confirmed dans la fenêtre :
 *        a. Si payment.links.subscription PRÉSENT (= mensualité d'abonnement) :
 *           → Cherche une facture Firestore avec linkedSubscriptionId + montant match
 *           → Si trouvée et status != paid → la marquer paid
 *           → Si introuvable → alerte 'sync_unmatched_subscription_payment'
 *        b. Si payment.links.subscription ABSENT (= one-shot) :
 *           → Cherche une invoices Firestore avec gcPaymentId=paymentId
 *           → Si trouvée → skip (déjà traité)
 *           → Sinon : crée une facture one-shot (draft + validate + mark paid)
 *
 * EI vs SARL : la liste _config/billing.eiCustomerIds (array de gcCustomerId)
 * est ignorée dans toutes les actions ci-dessus (ces clients sont sur EI uniquement).
 *
 * ─── Auth ───
 * Bearer admin uniquement.
 *
 * ─── POST body ───
 * {
 *   since: 'YYYY-MM-DD',          // défaut '2026-01-01' (démarrage SARL)
 *   until?: 'YYYY-MM-DD',         // défaut today
 *   dryRun?: boolean,             // défaut true
 *   actions: {
 *     customers: boolean,         // défaut true
 *     subscriptions: boolean,     // défaut true
 *     payments: boolean,          // défaut true
 *   },
 *   maxPages?: number             // cap pagination GC (défaut 20 = 1000 items max)
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   dryRun: bool,
 *   window: { since, until },
 *   customers: { scanned, orphans: [...] },
 *   subscriptions: { scanned, orphans: [...], updated: number },
 *   payments: {
 *     scanned,
 *     subscriptionPaymentsMatched: number,
 *     subscriptionPaymentsUnmatched: [...],
 *     oneOffInvoicesCreated: [...],
 *     oneOffInvoicesAlreadyExist: number,
 *     skippedEI: number,
 *   },
 *   warnings: [...],
 *   durationMs: number,
 * }
 *
 * ─── Pagination GC ───
 * Cap maxPages = 20 par défaut (≈ 1000 items). Si la fenêtre est très large,
 * relancer en réduisant la fenêtre. Pas de cron : l'admin lance manuellement
 * depuis l'onglet Sync de admin-facturation.html.
 *
 * ─── Performance ───
 * Pour un paiement one-shot à créer, on appelle invoice-validate via HTTP local
 * (même pattern que admin-rattrapage-historique.js). C'est ~2-5s par facture.
 * Sur une grosse sync, on garde un compteur et on bail si > 50 factures créées
 * pour éviter le timeout Vercel (60s hobby, 300s pro).
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
const GC_VERSION = '2015-07-06';

const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

const MAX_ONE_OFF_INVOICES_PER_RUN = 50;  /* garde-fou timeout Vercel */

/* ─── Helpers GC ─── */
async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetchFn(GC_BASE + path, {
    headers: {
      'Authorization': 'Bearer ' + token,
      'GoCardless-Version': GC_VERSION,
      'Accept': 'application/json',
    },
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error('GC ' + resp.status + ' on ' + path + ': ' + JSON.stringify(json.error || json));
  return json;
}

/**
 * Paginate une collection GC.
 * GC retourne meta.cursors.after = id du dernier item → réutiliser comme `after=<id>`.
 * Limite par défaut 50 items/page, max 500.
 */
async function gcPaginate(resource, queryParams, maxPages) {
  const out = [];
  let after = null;
  let page = 0;
  while (page < maxPages) {
    const qp = Object.assign({ limit: 500 }, queryParams || {});
    if (after) qp.after = after;
    const qs = Object.keys(qp).map(function(k){ return encodeURIComponent(k) + '=' + encodeURIComponent(qp[k]); }).join('&');
    const path = '/' + resource + (qs ? '?' + qs : '');
    const data = await gcGet(path);
    if (!data) break;
    const items = data[resource] || [];
    out.push.apply(out, items);
    page++;
    after = (data.meta && data.meta.cursors && data.meta.cursors.after) || null;
    if (!after || items.length === 0) break;
  }
  return { items: out, pages: page, truncated: !!after };
}

/* ─── Helpers Firestore ─── */
function lower(s) { return (s || '').toString().trim().toLowerCase(); }

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}

async function findInvoiceClientByGc(gcCustomerId) {
  if (!gcCustomerId) return null;
  /* Double-write : on cherche sur les deux noms de champ (gcCustomerId + gocardlessCustomerId) */
  const snap1 = await db.collection('invoice_clients').where('gcCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap1.empty) return Object.assign({ id: snap1.docs[0].id }, snap1.docs[0].data());
  const snap2 = await db.collection('invoice_clients').where('gocardlessCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap2.empty) return Object.assign({ id: snap2.docs[0].id }, snap2.docs[0].data());
  return null;
}

async function findFirestoreSubByGc(gcSubscriptionId) {
  if (!gcSubscriptionId) return null;
  const snap = await db.collection('subscriptions').where('gcSubscriptionId', '==', gcSubscriptionId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
  return null;
}

async function findInvoiceByGcPayment(gcPaymentId) {
  if (!gcPaymentId) return null;
  const snap = await db.collection('invoices').where('gcPaymentId', '==', gcPaymentId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
  return null;
}

/**
 * Cherche une facture team correspondant à un payment GC d'abonnement.
 * Match : linkedSubscriptionId + totalTtc (à 0.01€ près) + status validated/sent.
 * Retourne la candidate la plus ancienne non encore payée.
 */
async function findInvoiceForSubscriptionPayment(firestoreSubId, amountTtc) {
  const snap = await db.collection('invoices')
    .where('linkedSubscriptionId', '==', firestoreSubId)
    .get();
  const candidates = [];
  snap.forEach(function(d) {
    const inv = d.data();
    const sameAmount = Math.abs(round2(inv.totalTtc || 0) - round2(amountTtc)) < 0.01;
    const notYetPaid = inv.status !== 'paid';
    const isValidated = inv.status === 'validated' || inv.status === 'sent';
    if (sameAmount && notYetPaid && isValidated) {
      candidates.push(Object.assign({ id: d.id }, inv));
    }
  });
  /* FIFO : la plus ancienne candidates en premier (issueDate ASC) */
  candidates.sort(function(a, b) {
    const da = a.issueDate && a.issueDate.toDate ? a.issueDate.toDate().getTime() : 0;
    const db_ = b.issueDate && b.issueDate.toDate ? b.issueDate.toDate().getTime() : 0;
    return da - db_;
  });
  return candidates[0] || null;
}

/**
 * Crée une facture one-shot à partir d'un GC payment qui n'est PAS lié
 * à une subscription. Suit le même pattern que admin-rattrapage-historique.js
 * mais sans avancer aucune subscription.
 *
 * Returns { invoiceId, number } on success.
 */
async function createOneOffInvoice(gcPayment, gcMandate, invoiceClient, user, billing, systemKey, validateUrl) {
  /* Montant : GC stocke en cents, convertir en euros TTC */
  const amountTtc = (gcPayment.amount || 0) / 100;
  const chargeDate = gcPayment.charge_date || (gcPayment.created_at && gcPayment.created_at.substring(0, 10));
  const paidOutDate = gcPayment.charge_date || chargeDate;

  /* Description : si GC a posé une description, on la prend ; sinon générique */
  const description = gcPayment.description || 'Paiement intégral';

  /* Calcul TVA — TTC réf, on retro-calcule HT */
  const vatRate = invoiceClient.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
  const unitPriceHt = round2(amountTtc / (1 + vatRate / 100));

  const line = {
    productId: null,
    variantId: null,
    productName: '',
    variantLabel: '',
    description: description,
    unit: 'forfait',
    qty: 1,
    unitPriceHt: unitPriceHt,
    vatRate: vatRate,
    discountPct: 0,
  };

  const lineHt = round2(line.qty * line.unitPriceHt);
  const lineVat = round2(lineHt * vatRate / 100);
  const lineTtc = round2(lineHt + lineVat);
  line.lineHtBeforeDiscount = lineHt;
  line.discountAmount = 0;
  line.lineHtAfterDiscount = lineHt;
  line.lineVat = lineVat;
  line.lineTtc = lineTtc;

  const totalGrossHt = lineHt;
  const totalHt = lineHt;
  const totalVat = lineVat;
  const totalTtc = lineTtc;
  const vatBreakdown = vatRate > 0
    ? [{ rate: vatRate, base: totalHt, vat: totalVat }]
    : [{ rate: 0, base: totalHt, vat: 0 }];

  const clientSnapshot = {
    clientType: invoiceClient.clientType || 'individual',
    companyName: invoiceClient.companyName || '',
    contactFirstName: invoiceClient.contactFirstName || '',
    contactLastName: invoiceClient.contactLastName || '',
    email: invoiceClient.email || '',
    phone: invoiceClient.phone || invoiceClient.telephone || '',
    siret: invoiceClient.siret || '',
    vatNumber: invoiceClient.vatNumber || '',
    vatExempt: !!invoiceClient.vatExempt,
    address: Object.assign({ line1: '', line2: '', postalCode: '', city: '', country: 'France' },
      invoiceClient.address || {}),
  };

  const paymentTermsDays = billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30;

  const draftDoc = {
    status: 'draft',
    paymentTermsDays: paymentTermsDays,
    paymentMethod: 'gocardless',
    poNumber: '',
    clientId: invoiceClient.id,
    clientSnapshot: clientSnapshot,
    issuerSnapshot: null,  /* posé par invoice-validate */
    cgvSnapshot: null,
    lines: [line],
    totalGrossHt: totalGrossHt,
    totalDiscount: 0,
    totalHt: totalHt,
    totalVat: totalVat,
    totalTtc: totalTtc,
    vatBreakdown: vatBreakdown,
    notesPublic: 'Paiement reçu via GoCardless le ' + paidOutDate + '.',
    notesInternal: 'Sync GoCardless one-shot — payment ' + gcPayment.id +
      ' (mandate ' + (gcMandate ? gcMandate.id : 'inconnu') + ') — ' +
      new Date().toISOString().substring(0, 10),
    linkedPaymentId: null,  /* pas de payments Firestore associé en sync historique */
    linkedSubscriptionId: null,
    pdfHash: null,
    isLocked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: user.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: user.uid,
    _autoGenerated: true,
    _autoGeneratedFromSyncGc: true,
    _autoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    _syncSourceGcPaymentId: gcPayment.id,
    _syncSourceGcMandateId: gcMandate ? gcMandate.id : null,
    _syncSourceChargeDate: chargeDate,
  };

  const draftRef = await db.collection('invoices').add(draftDoc);
  const invoiceId = draftRef.id;

  /* Appel invoice-validate (numérotation + PDF) via system key */
  const validateResp = await fetchFn(validateUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-system-key': systemKey,
    },
    body: JSON.stringify({ invoiceId: invoiceId }),
  });

  let validateData = {};
  try { validateData = await validateResp.json(); } catch (_) {}

  if (!validateResp.ok) {
    /* Rollback du draft */
    try { await draftRef.delete(); } catch (_) {}
    throw new Error('invoice-validate failed for sync one-shot ' + gcPayment.id + ' : ' +
      (validateData.error || 'HTTP ' + validateResp.status));
  }

  const invoiceNumber = validateData.number;

  /* Marquer paid */
  await draftRef.update({
    status: 'paid',
    paidAt: admin.firestore.Timestamp.fromDate(new Date(paidOutDate + 'T12:00:00')),
    paidVia: 'gocardless',
    gcPaymentId: gcPayment.id,
    paidAmount: amountTtc,
    paidBySync: true,
    syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    syncedBy: user.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return {
    invoiceId: invoiceId,
    number: invoiceNumber,
    amount: amountTtc,
    chargeDate: chargeDate,
    gcPaymentId: gcPayment.id,
    clientName: clientSnapshot.companyName ||
      (clientSnapshot.contactFirstName + ' ' + clientSnapshot.contactLastName).trim() ||
      clientSnapshot.email,
  };
}

/* ═════════════════════════════════════════════════════════════════════════
   HANDLER PRINCIPAL
   ═════════════════════════════════════════════════════════════════════════ */
module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const startedAt = Date.now();
  const warnings = [];

  try {
    /* ── Auth Bearer admin ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body ── */
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const since = body.since || '2026-01-01';
    const until = body.until || new Date().toISOString().substring(0, 10);
    const dryRun = body.dryRun !== false;  /* défaut TRUE */
    const actions = Object.assign({ customers: true, subscriptions: true, payments: true }, body.actions || {});
    const maxPages = Math.min(parseInt(body.maxPages, 10) || 20, 100);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      const e = new Error('since invalide (YYYY-MM-DD requis)'); e.status = 400; throw e;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      const e = new Error('until invalide (YYYY-MM-DD requis)'); e.status = 400; throw e;
    }

    /* ── Config : EI customer IDs à exclure ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};
    const eiCustomerIds = Array.isArray(billing.eiCustomerIds) ? billing.eiCustomerIds : [];
    const eiSet = {};
    eiCustomerIds.forEach(function(id) { eiSet[id] = true; });

    /* ── Pour les paiements one-shot : système key + URL invoice-validate ── */
    let systemKey = null;
    let validateUrl = null;
    if (!dryRun && actions.payments) {
      const keysSnap = await db.collection('_config').doc('system_keys').get();
      const keys = keysSnap.exists ? keysSnap.data() : {};
      systemKey = keys.invoiceGeneration;
      if (!systemKey) {
        warnings.push('_config/system_keys.invoiceGeneration manquant → impossible de valider les factures one-shot.');
      }
      const appBase = (billing.appBaseUrl || process.env.APP_BASE_URL || 'https://team.alteore.com').replace(/\/$/, '');
      validateUrl = appBase + '/api/invoice-validate';
    }

    const result = {
      success: true,
      dryRun: dryRun,
      window: { since: since, until: until },
      actions: actions,
      customers: { scanned: 0, orphans: [] },
      subscriptions: { scanned: 0, orphans: [], updated: 0 },
      payments: {
        scanned: 0,
        subscriptionPaymentsMatched: 0,
        subscriptionPaymentsAlreadyPaid: 0,
        subscriptionPaymentsUnmatched: [],
        oneOffInvoicesCreated: [],
        oneOffInvoicesAlreadyExist: 0,
        skippedEI: 0,
        skippedNoInvoiceClient: 0,
      },
      warnings: warnings,
    };

    /* ═══ ACTION 1 : CUSTOMERS ═══ */
    if (actions.customers) {
      const pag = await gcPaginate('customers', {
        'created_at[gte]': since + 'T00:00:00Z',
        'created_at[lte]': until + 'T23:59:59Z',
      }, maxPages);
      if (pag.truncated) warnings.push('customers pagination truncated at ' + pag.pages + ' pages');
      result.customers.scanned = pag.items.length;
      for (const c of pag.items) {
        if (eiSet[c.id]) continue;
        const ic = await findInvoiceClientByGc(c.id);
        if (!ic) {
          result.customers.orphans.push({
            gcCustomerId: c.id,
            email: (c.email || '').toLowerCase(),
            name: ((c.given_name || '') + ' ' + (c.family_name || '')).trim() || (c.company_name || ''),
            createdAt: c.created_at,
          });
          /* Alerte _alerts/billing/items pour traitement manuel */
          if (!dryRun) {
            try {
              await db.collection('_alerts').doc('billing').collection('items').add({
                code: 'sync_orphan_gc_customer',
                gcCustomerId: c.id,
                email: (c.email || '').toLowerCase(),
                name: ((c.given_name || '') + ' ' + (c.family_name || '')).trim() || (c.company_name || ''),
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: 'sync:' + user.uid,
                resolved: false,
              });
            } catch (e) { warnings.push('alert write failed for customer ' + c.id + ': ' + e.message); }
          }
        }
      }
    }

    /* ═══ ACTION 2 : SUBSCRIPTIONS ═══ */
    /* Cache mandates → customers pour résoudre les liens (évite N appels GC) */
    const mandateCustomerCache = {};
    async function resolveMandateCustomer(mandateId) {
      if (!mandateId) return null;
      if (mandateCustomerCache[mandateId] !== undefined) return mandateCustomerCache[mandateId];
      try {
        const m = await gcGet('/mandates/' + mandateId);
        const cid = m && m.mandates && m.mandates.links && m.mandates.links.customer || null;
        mandateCustomerCache[mandateId] = cid;
        return cid;
      } catch (e) {
        warnings.push('mandate fetch failed for ' + mandateId + ': ' + e.message);
        mandateCustomerCache[mandateId] = null;
        return null;
      }
    }

    if (actions.subscriptions) {
      const pag = await gcPaginate('subscriptions', {
        'created_at[gte]': since + 'T00:00:00Z',
        'created_at[lte]': until + 'T23:59:59Z',
      }, maxPages);
      if (pag.truncated) warnings.push('subscriptions pagination truncated at ' + pag.pages + ' pages');
      result.subscriptions.scanned = pag.items.length;
      for (const s of pag.items) {
        const mandateId = (s.links && s.links.mandate) || null;
        const customerId = await resolveMandateCustomer(mandateId);
        if (customerId && eiSet[customerId]) continue;

        const fSub = await findFirestoreSubByGc(s.id);
        if (!fSub) {
          result.subscriptions.orphans.push({
            gcSubscriptionId: s.id,
            gcCustomerId: customerId,
            amount: s.amount,
            count: s.count,
            status: s.status,
            createdAt: s.created_at,
          });
          if (!dryRun) {
            try {
              await db.collection('_alerts').doc('billing').collection('items').add({
                code: 'sync_orphan_gc_subscription',
                gcSubscriptionId: s.id,
                gcCustomerId: customerId,
                gcMandateId: mandateId,
                amount: s.amount,
                count: s.count,
                status: s.status,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: 'sync:' + user.uid,
                resolved: false,
              });
            } catch (e) { warnings.push('alert write failed for subscription ' + s.id + ': ' + e.message); }
          }
        } else {
          /* Subscription trouvée — sync compteur installmentsPaidOnGC depuis GC */
          /* GC ne fournit pas directement le compteur. On compte les payments
             status='paid_out'|'confirmed' pour cette subscription. */
          const paymentsPag = await gcPaginate('payments', {
            subscription: s.id,
            'status[]': 'paid_out',
            limit: 100,
          }, 5);
          const paidCount = paymentsPag.items.length;
          if (paidCount !== fSub.installmentsPaidOnGC) {
            if (!dryRun) {
              await db.collection('subscriptions').doc(fSub.id).update({
                installmentsPaidOnGC: paidCount,
                _lastGcSyncAt: admin.firestore.FieldValue.serverTimestamp(),
                _lastGcSyncBy: user.uid,
                updatedAt: admin.firestore.FieldValue.serverTimestamp(),
              });
            }
            result.subscriptions.updated++;
          }
        }
      }
    }

    /* ═══ ACTION 3 : PAYMENTS ═══ */
    if (actions.payments) {
      const pag = await gcPaginate('payments', {
        'charge_date[gte]': since,
        'charge_date[lte]': until,
        /* On scan paid_out + confirmed (en cours de versement) */
      }, maxPages);
      if (pag.truncated) warnings.push('payments pagination truncated at ' + pag.pages + ' pages');
      result.payments.scanned = pag.items.length;

      let createdCount = 0;

      for (const p of pag.items) {
        /* Filter status : on traite uniquement les payments effectivement réussis */
        if (p.status !== 'paid_out' && p.status !== 'confirmed') continue;

        const mandateId = (p.links && p.links.mandate) || null;
        const subscriptionId = (p.links && p.links.subscription) || null;
        const customerId = await resolveMandateCustomer(mandateId);

        /* Filter EI */
        if (customerId && eiSet[customerId]) {
          result.payments.skippedEI++;
          continue;
        }

        /* ─── 3a. SUBSCRIPTION PAYMENT (mensualité) ─── */
        if (subscriptionId) {
          /* Cherche la subscription Firestore pour récupérer son ID interne */
          const fSub = await findFirestoreSubByGc(subscriptionId);
          if (!fSub) {
            result.payments.subscriptionPaymentsUnmatched.push({
              gcPaymentId: p.id,
              gcSubscriptionId: subscriptionId,
              amount: p.amount / 100,
              chargeDate: p.charge_date,
              reason: 'no_firestore_subscription',
            });
            continue;
          }
          /* Vérifie si la facture team est déjà marquée paid pour ce gcPaymentId */
          const alreadyPaid = await findInvoiceByGcPayment(p.id);
          if (alreadyPaid) {
            result.payments.subscriptionPaymentsAlreadyPaid++;
            continue;
          }
          /* Cherche la facture team validated/sent du bon montant */
          const inv = await findInvoiceForSubscriptionPayment(fSub.id, p.amount / 100);
          if (!inv) {
            result.payments.subscriptionPaymentsUnmatched.push({
              gcPaymentId: p.id,
              gcSubscriptionId: subscriptionId,
              firestoreSubId: fSub.id,
              amount: p.amount / 100,
              chargeDate: p.charge_date,
              reason: 'no_matching_team_invoice',
            });
            continue;
          }
          /* Marquer paid */
          if (!dryRun) {
            await db.collection('invoices').doc(inv.id).update({
              status: 'paid',
              paidAt: admin.firestore.Timestamp.fromDate(new Date((p.charge_date || new Date().toISOString().substring(0,10)) + 'T12:00:00')),
              paidVia: 'gocardless',
              gcPaymentId: p.id,
              paidAmount: p.amount / 100,
              paidBySync: true,
              syncedAt: admin.firestore.FieldValue.serverTimestamp(),
              syncedBy: user.uid,
              updatedAt: admin.firestore.FieldValue.serverTimestamp(),
            });
          }
          result.payments.subscriptionPaymentsMatched++;
          continue;
        }

        /* ─── 3b. ONE-SHOT (pas de subscription liée) ─── */
        const existing = await findInvoiceByGcPayment(p.id);
        if (existing) {
          result.payments.oneOffInvoicesAlreadyExist++;
          continue;
        }

        /* Trouve l'invoice_client */
        const ic = await findInvoiceClientByGc(customerId);
        if (!ic) {
          result.payments.skippedNoInvoiceClient++;
          warnings.push('one-shot payment ' + p.id + ' skipped : no invoice_clients for gcCustomerId ' + customerId);
          if (!dryRun) {
            try {
              await db.collection('_alerts').doc('billing').collection('items').add({
                code: 'sync_orphan_one_off_payment',
                gcPaymentId: p.id,
                gcCustomerId: customerId,
                gcMandateId: mandateId,
                amount: p.amount / 100,
                chargeDate: p.charge_date,
                createdAt: admin.firestore.FieldValue.serverTimestamp(),
                createdBy: 'sync:' + user.uid,
                resolved: false,
              });
            } catch (e) { warnings.push('alert write failed for one-shot ' + p.id); }
          }
          continue;
        }

        /* Cap de sécurité — éviter timeout Vercel */
        if (createdCount >= MAX_ONE_OFF_INVOICES_PER_RUN) {
          warnings.push('MAX_ONE_OFF_INVOICES_PER_RUN atteint (' + MAX_ONE_OFF_INVOICES_PER_RUN + ') — relancer la sync pour traiter le reste');
          break;
        }

        if (dryRun) {
          result.payments.oneOffInvoicesCreated.push({
            gcPaymentId: p.id,
            gcCustomerId: customerId,
            amount: p.amount / 100,
            chargeDate: p.charge_date,
            clientName: ic.companyName || ((ic.contactFirstName || '') + ' ' + (ic.contactLastName || '')).trim() || ic.email,
            action: 'would_create',
          });
        } else {
          if (!systemKey) {
            warnings.push('one-shot payment ' + p.id + ' : invoiceGeneration system key manquant, facture non créée');
            continue;
          }
          try {
            const mandateObj = mandateId ? { id: mandateId } : null;
            const created = await createOneOffInvoice(p, mandateObj, ic, user, billing, systemKey, validateUrl);
            result.payments.oneOffInvoicesCreated.push(Object.assign({ action: 'created' }, created));
            createdCount++;
          } catch (e) {
            warnings.push('one-shot create failed for ' + p.id + ' : ' + e.message);
          }
        }
      }
    }

    result.durationMs = Date.now() - startedAt;

    /* ── Audit log ── */
    if (!dryRun) {
      try {
        await db.collection('audit_log').add({
          type: 'gocardless_sync',
          actor: user.uid,
          actorEmail: user.email,
          window: result.window,
          actions: actions,
          customersOrphans: result.customers.orphans.length,
          subscriptionsOrphans: result.subscriptions.orphans.length,
          subscriptionsUpdated: result.subscriptions.updated,
          subscriptionPaymentsMatched: result.payments.subscriptionPaymentsMatched,
          oneOffInvoicesCreated: result.payments.oneOffInvoicesCreated.length,
          durationMs: result.durationMs,
          warnings: warnings.slice(0, 50),
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) {
        console.warn('[admin-gocardless-sync] audit_log write failed:', e.message);
      }
    }

    console.log('[admin-gocardless-sync] ' + (dryRun ? 'DRY-RUN ' : 'EXECUTE ') +
      JSON.stringify({
        window: result.window,
        cOrph: result.customers.orphans.length,
        sOrph: result.subscriptions.orphans.length,
        sUpd: result.subscriptions.updated,
        pMatch: result.payments.subscriptionPaymentsMatched,
        pUnmatch: result.payments.subscriptionPaymentsUnmatched.length,
        oneOff: result.payments.oneOffInvoicesCreated.length,
        ms: result.durationMs,
      }));

    res.status(200).json(result);

  } catch (err) {
    console.error('[admin-gocardless-sync] error:', err.message, err.stack);
    sendError(res, err);
  }
};
