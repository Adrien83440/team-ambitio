/**
 * api/admin-gocardless-sync.js  (refonte 2026-05-27)
 *
 * Synchronisation manuelle GoCardless → Firestore.
 *
 * Règle unique : 1 paiement GC paid_out = 1 facture team, créée à la
 * date du paiement, marquée paid d'emblée.
 *
 * Idempotence forte : clé unique = gcPaymentId.
 * Auto-création des invoice_clients depuis GC customers si manquants.
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
const GC_VERSION = '2015-07-06';
const fetchFn = typeof fetch !== 'undefined' ? fetch : require('node-fetch');

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

function lower(s) { return (s || '').toString().trim().toLowerCase(); }
function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }

async function findInvoiceByGcPayment(gcPaymentId) {
  const snap = await db.collection('invoices').where('gcPaymentId', '==', gcPaymentId).limit(2).get();
  let nonArchived = null;
  snap.forEach(function(d) {
    if (!nonArchived && d.data()._archived !== true) {
      nonArchived = Object.assign({ id: d.id }, d.data());
    }
  });
  return nonArchived;
}

async function findOrCreateInvoiceClient(gcCustomerId) {
  let snap = await db.collection('invoice_clients').where('gcCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
  snap = await db.collection('invoice_clients').where('gocardlessCustomerId', '==', gcCustomerId).limit(1).get();
  if (!snap.empty) return Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());

  const gcResp = await gcGet('/customers/' + gcCustomerId);
  if (!gcResp || !gcResp.customers) throw new Error('Customer GC introuvable : ' + gcCustomerId);
  const c = gcResp.customers;
  const email = lower(c.email);
  const companyName = c.company_name || '';
  const clientType = companyName ? 'company' : 'individual';

  /* Recherche secondaire par email pour rattachement */
  if (email) {
    const emailSnap = await db.collection('invoice_clients').where('email', '==', email).limit(1).get();
    if (!emailSnap.empty) {
      const existing = Object.assign({ id: emailSnap.docs[0].id }, emailSnap.docs[0].data());
      await db.collection('invoice_clients').doc(existing.id).update({
        gcCustomerId: gcCustomerId,
        gocardlessCustomerId: gcCustomerId,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return existing;
    }
  }

  const newIc = {
    clientType: clientType,
    companyName: companyName,
    companyLegalForm: '',
    companyRcs: '',
    contactFirstName: c.given_name || '',
    contactLastName: c.family_name || '',
    email: email,
    telephone: c.phone_number || '',
    phone: c.phone_number || '',
    siret: '',
    vatNumber: '',
    vatExempt: false,
    address: {
      line1: c.address_line1 || '',
      line2: c.address_line2 || '',
      postalCode: c.postal_code || '',
      city: c.city || '',
      country: c.country_code === 'FR' ? 'France' : (c.country_code || 'France'),
    },
    gcCustomerId: gcCustomerId,
    gocardlessCustomerId: gcCustomerId,
    salesOwner: null,
    personId: null,
    archived: false,
    _needsAddressCompletion: !(c.address_line1 && c.city),
    _autoCreatedFromGc: true,
    _autoCreatedFromGcAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _createdBy: 'vercel:admin-gocardless-sync',
  };
  const ref = await db.collection('invoice_clients').add(newIc);
  return Object.assign({ id: ref.id }, newIc);
}

async function createInvoiceForGcPayment(gcPayment, billing, systemKey, validateUrl, user, autoPaid) {
  const gcPaymentId = gcPayment.id;

  const existing = await findInvoiceByGcPayment(gcPaymentId);
  if (existing) {
    return { success: true, skipped: true, reason: 'invoice_exists', invoiceId: existing.id, number: existing.number };
  }

  const amountTtc = (gcPayment.amount || 0) / 100;
  if (amountTtc <= 0) throw new Error('amount invalide');

  const chargeDateStr = gcPayment.charge_date || new Date().toISOString().substring(0, 10);
  const mandateId = gcPayment.links && gcPayment.links.mandate;
  const subscriptionGcId = gcPayment.links && gcPayment.links.subscription;
  if (!mandateId) throw new Error('payment sans mandate');

  const mandateResp = await gcGet('/mandates/' + mandateId);
  if (!mandateResp || !mandateResp.mandates) throw new Error('mandate introuvable');
  const gcCustomerId = mandateResp.mandates.links && mandateResp.mandates.links.customer;
  if (!gcCustomerId) throw new Error('mandate sans customer');

  const eiCustomerIds = Array.isArray(billing.eiCustomerIds) ? billing.eiCustomerIds : [];
  if (eiCustomerIds.indexOf(gcCustomerId) >= 0) {
    return { success: true, skipped: true, reason: 'ei_customer' };
  }

  const client = await findOrCreateInvoiceClient(gcCustomerId);

  /* Description : ordre de priorité
     1. gcPayment.description (libellé que voit le client sur son relevé bancaire)
     2. Template subscription Firestore si dispo
     3. Fallback générique */
  let description = '';
  let firestoreSub = null;
  const gcPaymentDescription = (gcPayment.description || '').trim();

  if (subscriptionGcId) {
    const subSnap = await db.collection('subscriptions').where('gcSubscriptionId', '==', subscriptionGcId).limit(1).get();
    if (!subSnap.empty) {
      firestoreSub = Object.assign({ id: subSnap.docs[0].id }, subSnap.docs[0].data());
    }
  }

  if (gcPaymentDescription) {
    /* Priorité 1 : ce que GC affiche au client sur son relevé */
    description = gcPaymentDescription;
  } else if (firestoreSub) {
    /* Priorité 2 : template subscription Firestore */
    const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dt = new Date(chargeDateStr + 'T12:00:00');
    const tpl = firestoreSub.descriptionTemplate || (firestoreSub.description || 'Mensualité {month_name} {year}');
    description = tpl
      .replace(/\{month_name\}/g, FR_MONTHS[dt.getMonth()])
      .replace(/\{month_number\}/g, String(dt.getMonth() + 1).padStart(2, '0'))
      .replace(/\{year\}/g, dt.getFullYear())
      .replace(/\{installment\}/g, String((firestoreSub.installmentsPaidOnGC || 0) + 1))
      .replace(/\{total\}/g, firestoreSub.totalInstallments != null ? String(firestoreSub.totalInstallments) : '?');
  } else if (subscriptionGcId) {
    description = 'Mensualité ' + chargeDateStr;
  } else {
    description = 'Paiement intégral';
  }

  const vatRate = client.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
  const unitPriceHt = round2(amountTtc / (1 + vatRate / 100));

  const line = {
    productId: null, variantId: null, productName: '', variantLabel: '',
    description: description, unit: 'forfait', qty: 1,
    unitPriceHt: unitPriceHt, vatRate: vatRate, discountPct: 0,
  };
  const lineHt = round2(line.qty * line.unitPriceHt);
  const lineVat = round2(lineHt * vatRate / 100);
  const lineTtc = round2(lineHt + lineVat);
  line.lineHtBeforeDiscount = lineHt;
  line.discountAmount = 0;
  line.lineHtAfterDiscount = lineHt;
  line.lineVat = lineVat;
  line.lineTtc = lineTtc;

  const vatBreakdown = vatRate > 0
    ? [{ rate: vatRate, base: lineHt, vat: lineVat }]
    : [{ rate: 0, base: lineHt, vat: 0 }];

  const clientSnapshot = {
    /* 100 % B2B : aucun client particulier. Un défaut à 'individual'
       produirait une facture jamais transmise sur le réseau e-invoicing
       (voir sendByEinvoice dans api/_qonto-invoice-flow.js), sans erreur. */
    clientType: client.clientType || 'company',
    companyName: client.companyName || '',
    contactFirstName: client.contactFirstName || '',
    contactLastName: client.contactLastName || '',
    email: client.email || '',
    phone: client.phone || client.telephone || '',
    siret: client.siret || '',
    vatNumber: client.vatNumber || '',
    vatExempt: !!client.vatExempt,
    address: Object.assign({ line1: '', line2: '', postalCode: '', city: '', country: 'France' },
      client.address || {}),
  };

  const paymentTermsDays = billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30;
  const draftDoc = {
    status: 'draft',
    paymentTermsDays: paymentTermsDays,
    paymentMethod: 'gocardless',
    poNumber: '',
    clientId: client.id,
    clientSnapshot: clientSnapshot,
    issuerSnapshot: null, cgvSnapshot: null,
    lines: [line],
    totalGrossHt: lineHt, totalDiscount: 0, totalHt: lineHt, totalVat: lineVat, totalTtc: lineTtc,
    vatBreakdown: vatBreakdown,
    notesPublic: 'Paiement reçu via GoCardless le ' + chargeDateStr + '.',
    notesInternal: 'Facture créée par sync GoCardless manuelle — payment ' + gcPaymentId,
    linkedPaymentId: null,
    linkedSubscriptionId: firestoreSub ? firestoreSub.id : null,
    gcPaymentId: gcPaymentId,
    gcMandateId: mandateId,
    gcCustomerId: gcCustomerId,
    gcSubscriptionId: subscriptionGcId || null,
    pdfHash: null, isLocked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: user.uid,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: user.uid,
    _autoGenerated: true,
    _autoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    _autoGeneratedFromSync: true,
    /* ── Contrôle manuel (2026-05-29) : si autoPaid=false, la facture reste
       un brouillon en attente de validation dans l'onglet « À valider ». ── */
    _pendingValidation: !autoPaid,
    gcChargeDate: chargeDateStr,
    suggestedPaidAmount: amountTtc,
  };
  const draftRef = await db.collection('invoices').add(draftDoc);
  const invoiceId = draftRef.id;

  let invoiceNumber = null;
  let pdfPending = false;
  const paidAtTs = admin.firestore.Timestamp.fromDate(new Date(chargeDateStr + 'T12:00:00'));

  /* ── Validation + marquage payée : UNIQUEMENT si autoPaid=true ──
     Sinon (contrôle manuel), on laisse le brouillon en _pendingValidation
     pour traitement depuis l'onglet « À valider » de admin-facturation. */
  if (autoPaid) {
  try {
    const resp = await fetchFn(validateUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-system-key': systemKey },
      body: JSON.stringify({ invoiceId: invoiceId, issueDate: chargeDateStr }),
    });
    const respData = await resp.json().catch(function(){ return {}; });

    if (resp.ok) {
      invoiceNumber = respData.number;
    } else {
      const errMsg = respData.error || ('HTTP ' + resp.status);
      /* "Facture validée mais PDF échouée" → ne PAS supprimer ! */
      if (errMsg.indexOf('Facture validée') >= 0) {
        try {
          const reread = await draftRef.get();
          invoiceNumber = reread.data().number || null;
          pdfPending = true;
        } catch (_) {}
      } else {
        try { await draftRef.delete(); } catch (_) {}
        throw new Error('invoice-validate: ' + errMsg);
      }
    }
  } catch (e) {
    try {
      const reread = await draftRef.get();
      if (reread.exists && reread.data().status === 'validated' && reread.data().number) {
        invoiceNumber = reread.data().number;
        pdfPending = true;
      } else {
        try { await draftRef.delete(); } catch (_) {}
        throw e;
      }
    } catch (e2) {
      try { await draftRef.delete(); } catch (_) {}
      throw e;
    }
  }

  await draftRef.update({
    status: 'paid',
    paidAt: paidAtTs,
    paidAmount: amountTtc,
    paidVia: 'gocardless',
    paymentRef: gcPaymentId,
    paidBy: 'auto_sync',
    paidByEmail: 'system',
    paidMarkedAt: admin.firestore.FieldValue.serverTimestamp(),
    timeline: admin.firestore.FieldValue.arrayUnion({
      type: 'invoice_auto_paid',
      at: new Date().toISOString(),
      source: 'gocardless_sync',
      gcPaymentId: gcPaymentId,
      amount: amountTtc,
      number: invoiceNumber,
    }),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  } /* fin if(autoPaid) */

  if (firestoreSub) {
    try {
      await db.collection('subscriptions').doc(firestoreSub.id).update({
        installmentsPaidOnGC: admin.firestore.FieldValue.increment(1),
        lastPaidGcPaymentId: gcPaymentId,
        lastPaidAt: paidAtTs,
        lastPaidInvoiceId: invoiceId,
        lastPaidInvoiceNumber: invoiceNumber,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }

  return {
    success: true,
    invoiceId: invoiceId,
    number: invoiceNumber,
    amount: amountTtc,
    chargeDate: chargeDateStr,
    gcPaymentId: gcPaymentId,
    gcCustomerId: gcCustomerId,
    pdfPending: pdfPending,
    pendingValidation: !autoPaid,
    clientId: client.id,
    clientName: client.companyName || ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')).trim() || client.email,
  };
}

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const startedAt = Date.now();
  const warnings = [];

  try {
    const user = await requireAuth(req, ['admin']);

    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    const since = body.since || '2026-01-01';
    const until = body.until || new Date().toISOString().substring(0, 10);
    const dryRun = body.dryRun !== false;
    /* autoPaid : true (défaut, rétro-compatible) = valide + marque payée d'office
       (rattrapage historique). false = brouillon envoyé dans « À valider ». */
    const autoPaid = body.autoPaid !== false;
    const maxPages = Math.min(parseInt(body.maxPages, 10) || 20, 100);
    const maxInvoices = Math.min(parseInt(body.maxInvoices, 10) || 100, 500);

    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) {
      const e = new Error('since invalide (YYYY-MM-DD)'); e.status = 400; throw e;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(until)) {
      const e = new Error('until invalide (YYYY-MM-DD)'); e.status = 400; throw e;
    }

    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};

    let systemKey = null;
    let validateUrl = null;
    if (!dryRun) {
      const keysSnap = await db.collection('_config').doc('system_keys').get();
      systemKey = keysSnap.exists ? keysSnap.data().invoiceGeneration : null;
      if (!systemKey) {
        const e = new Error('_config/system_keys.invoiceGeneration manquante'); e.status = 500; throw e;
      }
      const appBase = (billing.publicBaseUrl || process.env.APP_BASE_URL || 'https://team.alteore.com').replace(/\/$/, '');
      validateUrl = appBase + '/api/invoice-validate';
    }

    const pag = await gcPaginate('payments', {
      'charge_date[gte]': since,
      'charge_date[lte]': until,
    }, maxPages);
    if (pag.truncated) warnings.push('payments pagination truncated at ' + pag.pages + ' pages');

    /* Tri chronologique ASC par charge_date pour numérotation séquentielle propre :
       F2026-00001 = paiement le plus ancien, F2026-00153 = plus récent.
       Tie-break par created_at puis par id pour stabilité. */
    pag.items.sort(function(a, b) {
      const da = (a.charge_date || '9999-99-99');
      const db = (b.charge_date || '9999-99-99');
      if (da !== db) return da < db ? -1 : 1;
      const ca = (a.created_at || '');
      const cb = (b.created_at || '');
      if (ca !== cb) return ca < cb ? -1 : 1;
      return (a.id || '').localeCompare(b.id || '');
    });

    const result = {
      success: true,
      dryRun: dryRun,
      autoPaid: autoPaid,
      window: { since: since, until: until },
      payments: {
        scanned: pag.items.length,
        alreadyHaveInvoice: 0,
        wouldCreate: 0,
        created: 0,
        skippedEI: 0,
        pdfPending: 0,
        invoicesCreated: [],
        errors: [],
      },
      warnings: warnings,
    };

    let createdCount = 0;

    for (const p of pag.items) {
      if (p.status !== 'paid_out') continue;

      const existing = await findInvoiceByGcPayment(p.id);
      if (existing) {
        result.payments.alreadyHaveInvoice++;
        continue;
      }

      if (createdCount >= maxInvoices) {
        warnings.push('maxInvoices atteint (' + maxInvoices + ') — relancer pour traiter le reste');
        break;
      }

      if (dryRun) {
        try {
          const mandateId = p.links && p.links.mandate;
          if (!mandateId) {
            result.payments.errors.push({ gcPaymentId: p.id, error: 'no mandate' });
            continue;
          }
          const mResp = await gcGet('/mandates/' + mandateId);
          const gcCustomerId = mResp && mResp.mandates && mResp.mandates.links && mResp.mandates.links.customer;
          const eiCustomerIds = Array.isArray(billing.eiCustomerIds) ? billing.eiCustomerIds : [];
          if (gcCustomerId && eiCustomerIds.indexOf(gcCustomerId) >= 0) {
            result.payments.skippedEI++;
            continue;
          }
          let clientName = '?';
          if (gcCustomerId) {
            const cResp = await gcGet('/customers/' + gcCustomerId);
            if (cResp && cResp.customers) {
              const c = cResp.customers;
              clientName = c.company_name || ((c.given_name || '') + ' ' + (c.family_name || '')).trim() || c.email || gcCustomerId;
            }
          }
          result.payments.wouldCreate++;
          result.payments.invoicesCreated.push({
            gcPaymentId: p.id,
            amount: (p.amount || 0) / 100,
            chargeDate: p.charge_date,
            gcCustomerId: gcCustomerId,
            clientName: clientName,
            action: 'would_create',
          });
        } catch (e) {
          result.payments.errors.push({ gcPaymentId: p.id, error: e.message });
        }
      } else {
        try {
          const created = await createInvoiceForGcPayment(p, billing, systemKey, validateUrl, user, autoPaid);
          if (created.skipped) {
            if (created.reason === 'ei_customer') result.payments.skippedEI++;
            else if (created.reason === 'invoice_exists') result.payments.alreadyHaveInvoice++;
          } else {
            result.payments.created++;
            if (created.pdfPending) result.payments.pdfPending++;
            result.payments.invoicesCreated.push(Object.assign({ action: 'created' }, created));
            createdCount++;
          }
        } catch (e) {
          result.payments.errors.push({ gcPaymentId: p.id, error: e.message });
          console.error('[admin-gocardless-sync] error on ' + p.id + ': ' + e.message);
        }
      }
    }

    result.durationMs = Date.now() - startedAt;

    if (!dryRun && (result.payments.created > 0 || result.payments.errors.length > 0)) {
      try {
        await db.collection('audit_log').add({
          type: 'gocardless_sync',
          actor: user.uid,
          actorEmail: user.email,
          window: result.window,
          scanned: result.payments.scanned,
          created: result.payments.created,
          alreadyHaveInvoice: result.payments.alreadyHaveInvoice,
          skippedEI: result.payments.skippedEI,
          pdfPending: result.payments.pdfPending,
          errors: result.payments.errors.length,
          durationMs: result.durationMs,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (_) {}
    }

    console.log('[admin-gocardless-sync] ' + (dryRun ? 'DRY-RUN ' : 'EXECUTE ') + JSON.stringify({
      scanned: result.payments.scanned,
      created: result.payments.created,
      wouldCreate: result.payments.wouldCreate,
      already: result.payments.alreadyHaveInvoice,
      ei: result.payments.skippedEI,
      pdfPending: result.payments.pdfPending,
      errors: result.payments.errors.length,
      ms: result.durationMs,
    }));

    res.status(200).json(result);

  } catch (err) {
    console.error('[admin-gocardless-sync] fatal: ' + err.message, err.stack);
    sendError(res, err);
  }
};
