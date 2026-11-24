/**
 * api/invoice-rejets.js  (24/11/2026)
 *
 * Prélèvements GoCardless REJETÉS → factures impayées.
 *
 * Avant : seule la réception d'un prélèvement encaissé (paid_out) créait une
 * facture. Un prélèvement rejeté ne laissait aucune trace en facturation, donc
 * aucune pièce à transmettre au cabinet de recouvrement.
 *
 * Désormais, chaque prélèvement GoCardless en échec crée un BROUILLON dans
 * « À valider » (section « ❌ Prélèvements rejetés »). L'admin le valide :
 * numéro + PDF à la date du prélèvement, la facture reste IMPAYÉE (jamais
 * marquée encaissée ici).
 *
 * Statuts GoCardless pris en compte : failed, customer_approval_denied,
 * charged_back (ce dernier seulement si aucune facture n'existe déjà pour le
 * prélèvement — sinon il est signalé, rien n'est créé). « cancelled » est
 * exclu (annulation de notre côté, en général).
 *
 * Prélèvement encaissé PUIS rejeté (échec tardif, contestation) : son
 * brouillon d'encaissement (« Paiement reçu ») est CONVERTI en brouillon de
 * rejet ; s'il a déjà été émis, il est seulement signalé
 * (facture_emise_rejet : correction / avoir = décision humaine).
 *
 * Jamais de nouveau brouillon quand :
 *   - une facture (non archivée) porte déjà ce gcPaymentId ;
 *   - le client est facturé sur l'EI (_config/billing.eiCustomerIds ou
 *     fiche invoice_clients billingScope 'ei') ;
 *   - le prélèvement a été RATTRAPÉ par un autre prélèvement du même mandat,
 *     même montant, encaissé (paid_out / confirmed) à une date postérieure
 *     (sa facture naît de ce prélèvement-là : pas de double facture).
 *
 * Rapprochement (à chaque passage) des brouillons / factures de rejet encore
 * « actifs » (_rejetGc.etat === 'actif') :
 *   - le MÊME prélèvement a fini par passer (représentation GoCardless) :
 *       brouillon  → redevient un brouillon d'encaissement normal ;
 *       déjà émise → signalée « à marquer encaissée » (rien de marqué seul).
 *     Les compteurs (payments.paidCount/paymentsHistory, subscriptions.
 *     installmentsPaidOnGC) sont mis à jour une seule fois : la Cloud Function
 *     ne le fait pas, elle s'arrête dès qu'une facture porte le gcPaymentId.
 *   - rattrapé par un AUTRE prélèvement :
 *       brouillon  → archivé (_archived, motif, trace) ;
 *       déjà émise → signalée (risque de double facture : avoir à décider).
 *
 * Accès :
 *   GET  Bearer <CRON_SECRET>   cron quotidien — n'écrit que si
 *        _config/billing.rejetsAuto === true (fenêtre : 60 derniers jours).
 *   GET  ?key=<REJETS_KEY>[&apply=1][&since=][&until=] | [&auto=1|0]   accès manuel
 *        temporaire (variable Vercel), à blanc par défaut, aucune donnée
 *        personnelle en sortie hormis le nom du client de facturation.
 *   POST (admin) { action: 'scan', since, until, apply }
 *        { action: 'etat' } | { action: 'auto', enabled }
 *
 * Trace : audit_log (type 'gocardless_rejets') à chaque passage qui écrit.
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox' ? 'https://api-sandbox.gocardless.com' : 'https://api.gocardless.com';
const GC_VERSION = '2015-07-06';

const REJET_STATUSES = ['failed', 'customer_approval_denied', 'charged_back'];
const PAID_STATUSES = ['paid_out', 'confirmed'];
const FAIL_ACTIONS = ['failed', 'charged_back', 'customer_approval_denied', 'chargeback_settled', 'late_failure_settled'];
const MAX_CREATE = 100;
const TIME_BUDGET_MS = 50000;

const CAUSES_FR = {
  insufficient_funds: 'provision insuffisante',
  refer_to_payer: 'refusé par la banque du débiteur',
  bank_account_closed: 'compte bancaire clôturé',
  bank_account_transferred: 'compte bancaire transféré',
  invalid_bank_details: 'coordonnées bancaires invalides',
  direct_debit_not_enabled: 'prélèvements non autorisés sur ce compte',
  mandate_cancelled: 'mandat annulé',
  mandate_expired: 'mandat expiré',
  mandate_suspended_by_payer: 'mandat suspendu par le débiteur',
  authorisation_disputed: 'prélèvement contesté par le débiteur',
  return_on_odp: 'rejeté par la banque du débiteur',
  customer_approval_denied: 'refusé par le client',
  bank_account_disabled: 'compte bancaire désactivé',
  test_failure: 'échec de test',
  other: 'autre motif bancaire',
};
const STATUS_FR = {
  failed: 'rejeté',
  customer_approval_denied: 'refusé par le client',
  charged_back: 'contesté après encaissement',
};

function round2(n) { return Math.round((parseFloat(n) || 0) * 100) / 100; }
function lower(s) { return (s || '').toString().trim().toLowerCase(); }
function ymd(d) { return d.toISOString().substring(0, 10); }
function frDate(s) {
  const p = String(s || '').substring(0, 10).split('-');
  return p.length === 3 ? (p[2] + '/' + p[1] + '/' + p[0]) : String(s || '');
}

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN non configuré');
  const resp = await fetch(GC_BASE + path, {
    headers: { 'Authorization': 'Bearer ' + token, 'GoCardless-Version': GC_VERSION, 'Accept': 'application/json' },
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error('GoCardless ' + resp.status + ' sur ' + path.split('?')[0] + ' : ' + JSON.stringify(json.error || json).substring(0, 200));
  return json;
}

async function gcPaginate(resource, params, maxPages) {
  const out = [];
  let after = null;
  for (let page = 0; page < maxPages; page++) {
    const qp = Object.assign({ limit: 500 }, params || {});
    if (after) qp.after = after;
    const qs = Object.keys(qp).map(function (k) { return encodeURIComponent(k) + '=' + encodeURIComponent(qp[k]); }).join('&');
    const data = await gcGet('/' + resource + '?' + qs);
    if (!data) break;
    const items = data[resource] || [];
    out.push.apply(out, items);
    after = (data.meta && data.meta.cursors && data.meta.cursors.after) || null;
    if (!after || !items.length) break;
  }
  return out;
}

/* ── Caches par passage ───────────────────────────────────────── */
function makeCtx(billing, opts) {
  return {
    billing: billing,
    apply: !!opts.apply,
    by: opts.by || 'system',
    startedAt: Date.now(),
    mandates: {},
    customers: {},
    mandatePayments: {},
    consumed: {},  /* id de prélèvement encaissé déjà utilisé pour « rattraper » un rejet */
  };
}

async function mandateOf(ctx, mandateId) {
  if (!ctx.mandates[mandateId]) {
    const r = await gcGet('/mandates/' + mandateId);
    ctx.mandates[mandateId] = (r && r.mandates) || null;
  }
  return ctx.mandates[mandateId];
}

async function customerOf(ctx, customerId) {
  if (!ctx.customers[customerId]) {
    const r = await gcGet('/customers/' + customerId);
    ctx.customers[customerId] = (r && r.customers) || null;
  }
  return ctx.customers[customerId];
}

async function paymentsOfMandate(ctx, mandateId) {
  if (!ctx.mandatePayments[mandateId]) {
    ctx.mandatePayments[mandateId] = await gcPaginate('payments', { mandate: mandateId }, 4);
  }
  return ctx.mandatePayments[mandateId];
}

/* Prélèvement ponctuel encaissé (hors abonnement / échéancier), même mandat,
   même montant, à une date >= celle du rejet, pas déjà utilisé pour un autre
   rejet. */
async function findRattrapage(ctx, gp) {
  const mandateId = gp.links && gp.links.mandate;
  if (!mandateId) return null;
  const list = await paymentsOfMandate(ctx, mandateId);
  /* Un rattrapage est un prélèvement PONCTUEL relancé à la main : jamais
     une échéance d'abonnement ou d'échéancier (la mensualité suivante a le
     même montant, ce n'est pas un rattrapage). */
  const cands = list.filter(function (o) {
    const l = o.links || {};
    if (l.subscription || l.instalment_schedule) return false;
    return o.id !== gp.id && PAID_STATUSES.indexOf(o.status) >= 0 && o.amount === gp.amount &&
      (o.charge_date || '') >= (gp.charge_date || '') && !ctx.consumed[o.id];
  }).sort(function (a, b) { return (a.charge_date || '') < (b.charge_date || '') ? -1 : 1; });
  if (!cands.length) return null;
  ctx.consumed[cands[0].id] = gp.id;
  return { gcPaymentId: cands[0].id, chargeDate: cands[0].charge_date, status: cands[0].status };
}

async function causeOf(gp) {
  try {
    const e = await gcGet('/events?payment=' + encodeURIComponent(gp.id) + '&limit=50');
    const evs = ((e && e.events) || []).filter(function (x) { return FAIL_ACTIONS.indexOf(x.action) >= 0; });
    evs.sort(function (a, b) { return (a.created_at || '') < (b.created_at || '') ? 1 : -1; });
    const ev = evs[0];
    if (!ev) return { cause: null, detail: null, reasonCode: null, at: null };
    const d = ev.details || {};
    return { cause: d.cause || null, detail: d.description || null, reasonCode: d.reason_code || null, at: ev.created_at || null };
  } catch (err) {
    return { cause: null, detail: 'Cause indisponible (' + err.message + ')', reasonCode: null, at: null };
  }
}

function motifFr(gp, c) {
  if (c && c.cause && CAUSES_FR[c.cause]) return CAUSES_FR[c.cause];
  if (gp.status === 'customer_approval_denied') return CAUSES_FR.customer_approval_denied;
  if (gp.status === 'charged_back') return 'prélèvement contesté par le débiteur';
  return 'rejet bancaire';
}

async function findInvoiceByGcPayment(gcPaymentId) {
  const snap = await db.collection('invoices').where('gcPaymentId', '==', gcPaymentId).limit(5).get();
  let found = null;
  snap.forEach(function (d) {
    if (!found && d.data()._archived !== true) found = Object.assign({ id: d.id }, d.data());
  });
  return found;
}

async function findInvoiceClient(gcCustomerId, gcCustomer) {
  let snap = await db.collection('invoice_clients').where('gcCustomerId', '==', gcCustomerId).limit(1).get();
  if (snap.empty) snap = await db.collection('invoice_clients').where('gocardlessCustomerId', '==', gcCustomerId).limit(1).get();
  if (snap.empty && gcCustomer && gcCustomer.email) {
    snap = await db.collection('invoice_clients').where('email', '==', lower(gcCustomer.email)).limit(1).get();
  }
  return snap.empty ? null : Object.assign({ id: snap.docs[0].id }, snap.docs[0].data());
}

/* Même création que la synchro GoCardless (admin-gocardless-sync.js) :
   fiche B2B, adresse reprise de GoCardless. */
async function createInvoiceClient(gcCustomerId, c) {
  const doc = {
    clientType: 'company',
    companyName: c.company_name || '',
    companyLegalForm: '', companyRcs: '',
    contactFirstName: c.given_name || '',
    contactLastName: c.family_name || '',
    email: lower(c.email),
    telephone: c.phone_number || '', phone: c.phone_number || '',
    siret: '', vatNumber: '', vatExempt: false,
    address: {
      line1: c.address_line1 || '', line2: c.address_line2 || '',
      postalCode: c.postal_code || '', city: c.city || '',
      country: c.country_code === 'FR' ? 'France' : (c.country_code || 'France'),
    },
    gcCustomerId: gcCustomerId, gocardlessCustomerId: gcCustomerId,
    salesOwner: null, personId: null, archived: false,
    _needsAddressCompletion: !(c.address_line1 && c.city),
    _autoCreatedFromGc: true,
    _autoCreatedFromGcAt: admin.firestore.FieldValue.serverTimestamp(),
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    _createdBy: 'vercel:invoice-rejets',
  };
  const ref = await db.collection('invoice_clients').add(doc);
  return Object.assign({ id: ref.id }, doc);
}

async function findPaymentDoc(gp) {
  const links = gp.links || {};
  const tries = [['gcMandateId', links.mandate], ['gcSubscriptionId', links.subscription], ['gcPaymentId', gp.id]];
  for (const t of tries) {
    if (!t[1]) continue;
    const s = await db.collection('payments').where(t[0], '==', t[1]).limit(1).get();
    if (!s.empty) return s.docs[0];
  }
  return null;
}

async function findSubscription(gp) {
  const sid = gp.links && gp.links.subscription;
  if (!sid) return null;
  const s = await db.collection('subscriptions').where('gcSubscriptionId', '==', sid).limit(1).get();
  return s.empty ? null : Object.assign({ id: s.docs[0].id }, s.docs[0].data());
}

function descriptionOf(gp, sub, payDoc) {
  const gcDesc = (gp.description || '').trim();
  if (gcDesc) return gcDesc;
  const chargeDate = gp.charge_date || ymd(new Date());
  if (sub) {
    const M = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const dt = new Date(chargeDate + 'T12:00:00');
    const tpl = sub.descriptionTemplate || sub.description || 'Mensualité {month_name} {year}';
    return tpl
      .replace(/\{month_name\}/g, M[dt.getMonth()])
      .replace(/\{month_number\}/g, String(dt.getMonth() + 1).padStart(2, '0'))
      .replace(/\{year\}/g, dt.getFullYear())
      .replace(/\{installment\}/g, String((sub.installmentsPaidOnGC || 0) + 1))
      .replace(/\{total\}/g, sub.totalInstallments != null ? String(sub.totalInstallments) : '?');
  }
  if (gp.links && gp.links.subscription) return 'Mensualité ' + chargeDate;
  if (payDoc && payDoc.data().description) return payDoc.data().description;
  return 'Paiement intégral';
}

function clientName(client, gcCustomer) {
  if (client) {
    return client.companyName || ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')).trim() || client.email || client.id;
  }
  if (gcCustomer) {
    return gcCustomer.company_name || ((gcCustomer.given_name || '') + ' ' + (gcCustomer.family_name || '')).trim() || gcCustomer.id;
  }
  return '?';
}

/* ── 1. Rejets → brouillons ───────────────────────────────────── */
async function traiterRejet(ctx, gp) {
  const base = {
    gcPaymentId: gp.id,
    gcStatus: gp.status,
    amount: (gp.amount || 0) / 100,
    chargeDate: gp.charge_date || null,
  };

  const existing = await findInvoiceByGcPayment(gp.id);
  if (existing) {
    const cs = existing.clientSnapshot || {};
    base.clientName = cs.companyName || ((cs.contactFirstName || '') + ' ' + (cs.contactLastName || '')).trim() || cs.email || '?';
    base.clientId = existing.clientId || null;
    base.invoiceId = existing.id;
    base.number = existing.number || null;
    base.invoiceStatus = existing.status;
    if (existing._rejetGc) return Object.assign(base, { action: 'deja_cree' });

    /* Prélèvement encaissé (paid_out → brouillon d'encaissement créé), puis
       rejeté après coup (échec tardif / contestation). Le brouillon dit
       « Paiement reçu » : le valider tel quel le marquerait encaissé à tort.
       Encore brouillon → il devient un brouillon de rejet. Déjà émise →
       signalé seulement (avoir ou correction : décision humaine). */
    const causeE = await causeOf(gp);
    base.motif = motifFr(gp, causeE);
    if (existing.status !== 'draft') {
      return Object.assign(base, {
        action: 'facture_emise_rejet',
        note: 'Facture ' + (existing.number || '') + ' (' + existing.status + ') émise comme encaissée, mais le prélèvement est ' +
          (STATUS_FR[gp.status] || 'rejeté') + ' : à corriger à la main.',
      });
    }
    if (!ctx.apply) return Object.assign(base, { action: 'brouillon_a_convertir' });
    const chargeDateE = gp.charge_date || existing.gcChargeDate || ymd(new Date());
    const nowE = new Date().toISOString();
    await db.collection('invoices').doc(existing.id).update({
      notesPublic: 'Prélèvement SEPA du ' + frDate(chargeDateE) + ' ' + (STATUS_FR[gp.status] || 'rejeté') +
        ' — motif : ' + base.motif + '. Montant restant dû.',
      notesInternal: String(existing.notesInternal || '') + ' | Converti en facture de prélèvement rejeté le ' + nowE.substring(0, 10) +
        ' — GoCardless ' + gp.id + ' (' + gp.status + ')' + (causeE.reasonCode ? ', code ' + causeE.reasonCode : ''),
      _notesPublicAvantRejet: existing.notesPublic || '',
      _pendingValidation: true,
      gcChargeDate: chargeDateE,
      _rejetGc: {
        etat: 'actif',
        gcStatus: gp.status,
        chargeDate: chargeDateE,
        cause: causeE.cause,
        motif: base.motif,
        reasonCode: causeE.reasonCode,
        detail: causeE.detail,
        rejeteLe: causeE.at,
        detecteLe: nowE,
        convertiDepuisEncaissement: true,
        historique: [{ at: nowE, etat: 'actif', par: ctx.by, note: 'brouillon d\'encaissement converti' }],
      },
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: ctx.by,
    });
    return Object.assign(base, { action: 'converti' });
  }

  const mandateId = gp.links && gp.links.mandate;
  if (!mandateId) return Object.assign(base, { action: 'erreur', error: 'prélèvement sans mandat' });
  const mandate = await mandateOf(ctx, mandateId);
  const gcCustomerId = mandate && mandate.links && mandate.links.customer;
  if (!gcCustomerId) return Object.assign(base, { action: 'erreur', error: 'mandat sans client' });

  const eiIds = Array.isArray(ctx.billing.eiCustomerIds) ? ctx.billing.eiCustomerIds : [];
  if (eiIds.indexOf(gcCustomerId) >= 0) return Object.assign(base, { action: 'ignore_ei' });

  const gcCustomer = await customerOf(ctx, gcCustomerId);
  let client = await findInvoiceClient(gcCustomerId, gcCustomer);
  base.clientName = clientName(client, gcCustomer);
  base.clientId = client ? client.id : null;
  if (client && client.billingScope === 'ei') return Object.assign(base, { action: 'ignore_ei' });

  const rattrapage = await findRattrapage(ctx, gp);
  if (rattrapage) return Object.assign(base, { action: 'rattrape', rattrapage: rattrapage });

  const cause = await causeOf(gp);
  const motif = motifFr(gp, cause);
  base.motif = motif;

  if (!ctx.apply) return Object.assign(base, { action: 'a_creer', clientACreer: !client });

  if (!client) {
    if (!gcCustomer) return Object.assign(base, { action: 'erreur', error: 'client GoCardless introuvable' });
    client = await createInvoiceClient(gcCustomerId, gcCustomer);
    base.clientId = client.id;
  }

  const billing = ctx.billing;
  const payDoc = await findPaymentDoc(gp);
  const sub = await findSubscription(gp);
  const description = descriptionOf(gp, sub, payDoc);
  const amountTtc = base.amount;
  const vatRate = client.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
  const unitPriceHt = round2(amountTtc / (1 + vatRate / 100));
  const lineHt = round2(unitPriceHt);
  const lineVat = round2(lineHt * vatRate / 100);
  const lineTtc = round2(lineHt + lineVat);
  const line = {
    productId: null, variantId: null, productName: '', variantLabel: '',
    description: description, unit: 'forfait', qty: 1,
    unitPriceHt: unitPriceHt, vatRate: vatRate, discountPct: 0,
    lineHtBeforeDiscount: lineHt, discountAmount: 0, lineHtAfterDiscount: lineHt,
    lineVat: lineVat, lineTtc: lineTtc,
  };
  const chargeDate = gp.charge_date || ymd(new Date());

  const draft = {
    status: 'draft',
    paymentTermsDays: billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30,
    paymentMethod: 'gocardless',
    poNumber: '',
    clientId: client.id,
    clientSnapshot: {
      clientType: 'company',
      companyName: client.companyName || '',
      contactFirstName: client.contactFirstName || '',
      contactLastName: client.contactLastName || '',
      email: client.email || '',
      phone: client.phone || client.telephone || '',
      siret: client.siret || '',
      vatNumber: client.vatNumber || '',
      vatExempt: !!client.vatExempt,
      address: Object.assign({ line1: '', line2: '', postalCode: '', city: '', country: 'France' }, client.address || {}),
    },
    issuerSnapshot: null, cgvSnapshot: null,
    lines: [line],
    totalGrossHt: lineHt, totalDiscount: 0, totalHt: lineHt, totalVat: lineVat, totalTtc: lineTtc,
    vatBreakdown: [{ rate: vatRate, base: lineHt, vat: vatRate > 0 ? lineVat : 0 }],
    notesPublic: 'Prélèvement SEPA du ' + frDate(chargeDate) + ' ' + (STATUS_FR[gp.status] || 'rejeté') +
      ' — motif : ' + motif + '. Montant restant dû.',
    notesInternal: 'Facture de prélèvement rejeté — GoCardless ' + gp.id + ' (' + gp.status + ')' +
      (cause.reasonCode ? ', code ' + cause.reasonCode : '') + (cause.detail ? ' : ' + cause.detail : ''),
    linkedPaymentId: payDoc ? payDoc.id : null,
    linkedSubscriptionId: sub ? sub.id : null,
    gcPaymentId: gp.id,
    gcMandateId: mandateId,
    gcCustomerId: gcCustomerId,
    gcSubscriptionId: (gp.links && gp.links.subscription) || null,
    pdfHash: null, isLocked: false,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    createdBy: ctx.by,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedBy: ctx.by,
    _autoGenerated: true,
    _autoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    _pendingValidation: true,
    gcChargeDate: chargeDate,
    suggestedPaidAmount: amountTtc,
    _rejetGc: {
      etat: 'actif',
      gcStatus: gp.status,
      chargeDate: chargeDate,
      cause: cause.cause,
      motif: motif,
      reasonCode: cause.reasonCode,
      detail: cause.detail,
      rejeteLe: cause.at,
      detecteLe: new Date().toISOString(),
      historique: [{ at: new Date().toISOString(), etat: 'actif', par: ctx.by }],
    },
  };
  const ref = await db.collection('invoices').add(draft);
  return Object.assign(base, { action: 'cree', invoiceId: ref.id });
}

/* ── 2. Rapprochement des rejets actifs ───────────────────────── */
async function compterEncaissement(inv, gp) {
  const amount = (gp.amount || 0) / 100;
  const payDoc = await findPaymentDoc(gp);
  if (payDoc) {
    const p = payDoc.data() || {};
    const already = Array.isArray(p.paymentsHistory) && p.paymentsHistory.some(function (h) { return h && h.gcPaymentId === gp.id; });
    if (!already) {
      await payDoc.ref.update({
        paidCount: admin.firestore.FieldValue.increment(1),
        paidAmount: admin.firestore.FieldValue.increment(amount),
        paymentsHistory: admin.firestore.FieldValue.arrayUnion({
          amount: amount, date: gp.charge_date, gcPaymentId: gp.id, status: 'paid_out',
          invoiceId: inv.id, invoiceNumber: inv.number || null,
          eventAt: new Date().toISOString(), source: 'invoice-rejets',
        }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
  }
  const sub = await findSubscription(gp);
  if (sub && sub.lastPaidGcPaymentId !== gp.id) {
    await db.collection('subscriptions').doc(sub.id).update({
      installmentsPaidOnGC: admin.firestore.FieldValue.increment(1),
      lastPaidGcPaymentId: gp.id,
      lastPaidAt: admin.firestore.Timestamp.fromDate(new Date((gp.charge_date || ymd(new Date())) + 'T12:00:00')),
      lastPaidInvoiceId: inv.id,
      lastPaidInvoiceNumber: inv.number || null,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  }
}

async function rapprocher(ctx, inv) {
  const out = { invoiceId: inv.id, number: inv.number || null, gcPaymentId: inv.gcPaymentId, invoiceStatus: inv.status, clientName: clientName(Object.assign({ id: inv.clientId || '?' }, inv.clientSnapshot || {}), null) };
  const r = await gcGet('/payments/' + encodeURIComponent(inv.gcPaymentId));
  const gp = r && r.payments;
  if (!gp) return Object.assign(out, { action: 'erreur', error: 'prélèvement introuvable chez GoCardless' });
  out.gcStatus = gp.status;
  const now = new Date().toISOString();
  const draftEncore = inv.status === 'draft';

  if (gp.status === 'paid_out') {
    out.action = draftEncore ? 'encaisse_brouillon_normal' : 'encaisse_apres_validation';
    if (ctx.apply) {
      const etat = draftEncore ? 'encaisse_apres_rejet' : 'encaisse_apres_validation';
      const upd = {
        '_rejetGc.etat': etat,
        '_rejetGc.resoluLe': now,
        '_rejetGc.encaisseLe': gp.charge_date || null,
        '_rejetGc.historique': admin.firestore.FieldValue.arrayUnion({ at: now, etat: etat, par: ctx.by }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (draftEncore) {
        upd.gcChargeDate = gp.charge_date || inv.gcChargeDate;
        upd.notesPublic = 'Paiement reçu via GoCardless le ' + (gp.charge_date || '') + '.';
        upd._pendingValidation = true;
      }
      await db.collection('invoices').doc(inv.id).update(upd);
      /* Brouillon converti : son paid_out initial a déjà été compté. */
      if (!(inv._rejetGc && inv._rejetGc.convertiDepuisEncaissement)) await compterEncaissement(inv, gp);
    }
    return out;
  }

  if (REJET_STATUSES.indexOf(gp.status) >= 0 || gp.status === 'cancelled') {
    const rattrapage = await findRattrapage(ctx, gp);
    if (!rattrapage) return Object.assign(out, { action: 'toujours_impaye' });
    out.rattrapage = rattrapage;
    out.action = draftEncore ? 'rattrape_archive' : 'rattrape_apres_validation';
    if (ctx.apply) {
      const etat = draftEncore ? 'rattrape' : 'rattrape_apres_validation';
      const upd = {
        '_rejetGc.etat': etat,
        '_rejetGc.resoluLe': now,
        '_rejetGc.rattrapePar': rattrapage.gcPaymentId,
        '_rejetGc.rattrapeLe': rattrapage.chargeDate || null,
        '_rejetGc.historique': admin.firestore.FieldValue.arrayUnion({ at: now, etat: etat, par: ctx.by, rattrapePar: rattrapage.gcPaymentId }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (draftEncore) {
        /* Rien n'est supprimé : brouillon jamais numéroté, archivé avec trace. */
        upd._archived = true;
        upd._archivedReason = 'rejet_rattrape_par_' + rattrapage.gcPaymentId;
        upd._archivedAt = admin.firestore.FieldValue.serverTimestamp();
        upd._pendingValidation = false;
      }
      await db.collection('invoices').doc(inv.id).update(upd);
    }
    return out;
  }

  /* pending_submission / submitted : représentation en cours, on attend. */
  return Object.assign(out, { action: 'representation_en_cours' });
}

/* ── Passage complet ──────────────────────────────────────────── */
async function run(opts) {
  const billingSnap = await db.collection('_config').doc('billing').get();
  const billing = billingSnap.exists ? billingSnap.data() : {};
  const ctx = makeCtx(billing, opts);

  const result = {
    ok: true, apply: ctx.apply, window: { since: opts.since, until: opts.until },
    rejets: [], rapprochements: [], warnings: [],
    totaux: { scannes: 0, aCreer: 0, crees: 0, aConvertir: 0, convertis: 0, facturesEmisesRejet: 0, dejaCrees: 0, rattrapes: 0, ei: 0, erreurs: 0 },
  };

  /* Rapprochement d'abord : un rattrapage déjà connu « consomme » son
     prélèvement encaissé avant la recherche de nouveaux rejets. */
  const actifs = await db.collection('invoices').where('_rejetGc.etat', '==', 'actif').get();
  for (const d of actifs.docs) {
    const inv = Object.assign({ id: d.id }, d.data());
    if (inv._archived === true || !inv.gcPaymentId) continue;
    if (Date.now() - ctx.startedAt > TIME_BUDGET_MS) { result.warnings.push('Temps écoulé pendant le rapprochement — relancer.'); break; }
    try {
      const r = await rapprocher(ctx, inv);
      if (r.action !== 'toujours_impaye') result.rapprochements.push(r);
    } catch (e) {
      result.rapprochements.push({ invoiceId: inv.id, action: 'erreur', error: e.message });
    }
  }

  let pays = [];
  for (const st of REJET_STATUSES) {
    const list = await gcPaginate('payments', { status: st, 'charge_date[gte]': opts.since, 'charge_date[lte]': opts.until }, 10);
    pays = pays.concat(list);
  }
  pays.sort(function (a, b) {
    const da = a.charge_date || '', dbb = b.charge_date || '';
    return da !== dbb ? (da < dbb ? -1 : 1) : (a.id < b.id ? -1 : 1);
  });
  result.totaux.scannes = pays.length;

  let crees = 0;
  for (const gp of pays) {
    if (Date.now() - ctx.startedAt > TIME_BUDGET_MS) { result.warnings.push('Temps écoulé — ' + (pays.length - result.rejets.length) + ' prélèvement(s) non examiné(s), relancer.'); break; }
    if (ctx.apply && crees >= MAX_CREATE) { result.warnings.push('Plafond de ' + MAX_CREATE + ' brouillons atteint — relancer.'); break; }
    let r;
    try { r = await traiterRejet(ctx, gp); }
    catch (e) { r = { gcPaymentId: gp.id, gcStatus: gp.status, amount: (gp.amount || 0) / 100, chargeDate: gp.charge_date, action: 'erreur', error: e.message }; }
    result.rejets.push(r);
    if (r.action === 'cree') { crees++; result.totaux.crees++; }
    else if (r.action === 'a_creer') result.totaux.aCreer++;
    else if (r.action === 'deja_cree') result.totaux.dejaCrees++;
    else if (r.action === 'brouillon_a_convertir') result.totaux.aConvertir++;
    else if (r.action === 'converti') result.totaux.convertis++;
    else if (r.action === 'facture_emise_rejet') result.totaux.facturesEmisesRejet++;
    else if (r.action === 'rattrape') result.totaux.rattrapes++;
    else if (r.action === 'ignore_ei') result.totaux.ei++;
    else if (r.action === 'erreur') result.totaux.erreurs++;
  }

  result.durationMs = Date.now() - ctx.startedAt;
  const ecrit = ctx.apply && (result.totaux.crees > 0 || result.totaux.convertis > 0 || result.rapprochements.some(function (x) { return x.action !== 'representation_en_cours' && x.action !== 'erreur'; }));
  if (ctx.apply) {
    try {
      await db.collection('_config').doc('billing').set({
        rejetsDernierPassage: { at: new Date().toISOString(), par: ctx.by, totaux: result.totaux, rapprochements: result.rapprochements.length },
      }, { merge: true });
    } catch (_) {}
  }
  if (ecrit) {
    try {
      await db.collection('audit_log').add({
        type: 'gocardless_rejets', actor: ctx.by, window: result.window, totaux: result.totaux,
        rapprochements: result.rapprochements.map(function (x) { return { invoiceId: x.invoiceId, action: x.action }; }),
        durationMs: result.durationMs,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (_) {}
  }
  return result;
}

function dateParam(v, def) {
  const s = String(v || '');
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : def;
}

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const today = ymd(new Date());

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      const authHeader = req.headers.authorization || '';
      const cronSecret = process.env.CRON_SECRET;
      const manualKey = process.env.REJETS_KEY;

      /* Cron quotidien */
      if (cronSecret && authHeader === 'Bearer ' + cronSecret) {
        const b = await db.collection('_config').doc('billing').get();
        if (!(b.exists && b.data().rejetsAuto === true)) { res.status(200).json({ ok: true, skipped: 'rejetsAuto désactivé' }); return; }
        const since = ymd(new Date(Date.now() - 60 * 86400000));
        const r = await run({ since: since, until: today, apply: true, by: 'cron:invoice-rejets' });
        res.status(200).json({ ok: true, totaux: r.totaux, rapprochements: r.rapprochements.length, warnings: r.warnings });
        return;
      }

      /* Accès manuel temporaire (clé Vercel) */
      if (manualKey && q.key && String(q.key) === manualKey) {
        if (q.auto === '1' || q.auto === '0') {
          const en = q.auto === '1';
          await db.collection('_config').doc('billing').set({
            rejetsAuto: en,
            rejetsAutoHistorique: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), enabled: en, by: 'key:invoice-rejets' }),
          }, { merge: true });
          res.status(200).json({ ok: true, rejetsAuto: en });
          return;
        }
        const r = await run({
          since: dateParam(q.since, '2026-01-01'), until: dateParam(q.until, today),
          apply: q.apply === '1', by: 'key:invoice-rejets',
        });
        res.status(200).json(r);
        return;
      }
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
    const user = await requireAuth(req, ['admin']);
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

    if (body.action === 'etat') {
      const b = await db.collection('_config').doc('billing').get();
      const d = b.exists ? b.data() : {};
      res.status(200).json({ ok: true, rejetsAuto: d.rejetsAuto === true, dernierPassage: d.rejetsDernierPassage || null });
      return;
    }

    if (body.action === 'auto') {
      const enabled = body.enabled === true;
      await db.collection('_config').doc('billing').set({
        rejetsAuto: enabled,
        rejetsAutoHistorique: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), enabled: enabled, by: user.email || user.uid }),
      }, { merge: true });
      res.status(200).json({ ok: true, rejetsAuto: enabled });
      return;
    }

    if (body.action === 'scan') {
      const since = dateParam(body.since, null);
      const until = dateParam(body.until, today);
      if (!since) { const e = new Error('since invalide (AAAA-MM-JJ)'); e.status = 400; throw e; }
      const r = await run({ since: since, until: until, apply: body.apply === true, by: user.uid });
      res.status(200).json(r);
      return;
    }

    res.status(400).json({ error: 'action inconnue' });
  } catch (err) {
    sendError(res, err);
  }
};
