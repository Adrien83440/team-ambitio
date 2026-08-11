// ============================================================================
// api/_qonto-invoice-flow.js — ORCHESTRATION QONTO D'UNE FACTURE
// ----------------------------------------------------------------------------
// Helper partagé (préfixe « _ » : hors routing Vercel). Utilisé par
// invoice-validate.js (émission) et invoice-qonto-sync.js (rattrapage).
//
// Le flux, en quatre étapes reprises exactement dans le même ordre par les
// deux appelants :
//   1. upsert du client chez Qonto        → invoice_clients/{id}.qontoClientId
//   2. création de la facture             → invoices/{id}.qonto.invoiceId
//   3. envoi réseau e-invoicing (B2B)     → invoices/{id}.qonto.sentByEinvoiceAt
//   4. récupération du PDF Factur-X       → buffer, stocké par l'appelant
//
// IDEMPOTENCE — c'est tout l'enjeu
// --------------------------------
// Chaque étape commence par vérifier si elle a déjà été faite. Un rattrapage
// peut donc être relancé dix fois de suite sans créer de doublon chez la
// Plateforme Agréée : un doublon dans un flux légal ne se rattrape pas.
//
// Deux protections spécifiques :
//   - avant toute création, si un précédent essai a échoué, on RECHERCHE la
//     facture par son numéro chez Qonto. Un POST qui expire côté réseau peut
//     très bien avoir abouti côté Qonto — la réponse seule ne fait pas foi.
//   - un 409 « invoice_number_already_exists » n'est pas un échec : la facture
//     existe, on récupère son identifiant et on continue.
//
// LE NUMÉRO N'EST JAMAIS REJOUÉ. Si une étape échoue, la facture reste
// numérotée et validée côté Alteore ; seul qontoSyncStatus passe à 'failed'.
// La chronologie légale des numéros doit rester continue.
// ============================================================================

const qonto = require('./_qonto-client');
const { sha256 } = require('./_billing-helpers');

/* Le PDF Factur-X est produit de façon asynchrone par Qonto : l'attachment_id
   n'existe pas immédiatement après la création. On réessaie en espaçant. */
const PDF_RETRY_DELAYS_MS = [2000, 4000, 8000, 12000];

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Réglages non secrets. Absence de document = désactivé : en cas de doute on
 * reste sur le comportement existant, jamais l'inverse.
 */
async function loadQontoConfig(db) {
  try {
    const snap = await db.collection('_config').doc('qonto').get();
    const cfg = snap.exists ? (snap.data() || {}) : {};
    return {
      enabled: cfg.enabled === true,
      iban: String(cfg.iban || '').replace(/\s+/g, ''),
      autoSendEinvoice: cfg.autoSendEinvoice !== false,
      cgvShortText: cfg.cgvShortText || '',
    };
  } catch (e) {
    console.error('[qonto-flow] lecture _config/qonto:', e && e.message);
    return { enabled: false, iban: '', autoSendEinvoice: true, cgvShortText: '' };
  }
}

/* Empreinte des champs envoyés : permet de ne PATCHer le client que s'il a
   réellement changé, plutôt qu'à chaque facture. */
function fieldsHash(payload) {
  return sha256(Buffer.from(JSON.stringify(payload), 'utf8'));
}

/**
 * Étape 1 — le client existe chez Qonto, et il est à jour.
 * @returns {Promise<string>} identifiant Qonto du client
 */
async function upsertClient(ctx) {
  const db = ctx.db;
  const admin = ctx.admin;
  const clientId = ctx.clientId;

  const ref = db.collection('invoice_clients').doc(clientId);
  const snap = await ref.get();
  if (!snap.exists) {
    const e = new Error('Client de facturation introuvable (' + clientId + ')'); e.status = 404; throw e;
  }
  const client = snap.data() || {};
  const payload = qonto.mapClientToQonto(client);

  if (!payload.email) {
    const e = new Error('Le client n\'a pas d\'email — Qonto l\'exige pour créer une facture.'); e.status = 400; throw e;
  }
  if (payload.kind === 'company' && !payload.name) {
    const e = new Error('Le client est de type société mais n\'a pas de raison sociale.'); e.status = 400; throw e;
  }

  const hash = fieldsHash(payload);
  const existingId = client.qontoClientId || null;

  if (existingId && client.qontoFieldsHash === hash) return existingId;

  let qontoClientId = existingId;
  if (existingId) {
    try {
      await qonto.qontoFetch('PATCH', '/v2/clients/' + encodeURIComponent(existingId), payload);
    } catch (patchErr) {
      /* Le client a pu être supprimé côté Qonto : on repart sur une création
         plutôt que de bloquer une facture pour ça. */
      if (patchErr.status === 404) qontoClientId = null;
      else throw patchErr;
    }
  }

  if (!qontoClientId) {
    /* Corps PLAT, sans enveloppe : Qonto attend les champs à la racine. Avec
       { client: … } l'API ne voit rien et répond « kind required » puis
       « name required_without_all » — quatre erreurs pour une seule cause,
       et aucune ne parle de l'enveloppe. Idem pour PATCH et pour les
       factures. */
    const created = await qonto.qontoFetch('POST', '/v2/clients', payload);
    const c = (created && created.client) ? created.client : created;
    qontoClientId = c && c.id ? c.id : null;
    if (!qontoClientId) {
      const e = new Error('Qonto n\'a pas renvoyé d\'identifiant client.'); e.status = 502; throw e;
    }
  }

  await ref.set({
    qontoClientId: qontoClientId,
    qontoFieldsHash: hash,
    qontoSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });

  return qontoClientId;
}

/* Recherche d'une facture par son numéro : filet contre le POST qui a abouti
   alors que la réponse s'est perdue. */
async function findInvoiceByNumber(number) {
  if (!number) return null;
  try {
    const res = await qonto.qontoFetch('GET', '/v2/client_invoices?filter[number]=' + encodeURIComponent(number) + '&per_page=25');
    const list = (res && Array.isArray(res.client_invoices)) ? res.client_invoices : [];
    for (let i = 0; i < list.length; i++) {
      if (String(list[i].number || '') === String(number)) return list[i];
    }
    return null;
  } catch (e) {
    console.error('[qonto-flow] recherche par numéro échouée:', e && e.message);
    return null;
  }
}

/**
 * Étape 2 — la facture existe chez Qonto.
 * @returns {Promise<Object>} objet facture Qonto
 */
async function createInvoice(ctx) {
  const invoice = ctx.invoice;
  const already = (invoice.qonto && invoice.qonto.invoiceId) ? invoice.qonto.invoiceId : null;
  if (already) {
    const res = await qonto.qontoFetch('GET', '/v2/client_invoices/' + encodeURIComponent(already));
    return (res && res.client_invoice) ? res.client_invoice : res;
  }

  /* Un essai précédent a échoué : la facture a peut-être été créée malgré
     tout. On regarde AVANT de poster, sinon on crée un doublon légal. */
  if (invoice.qontoSyncStatus === 'failed') {
    const found = await findInvoiceByNumber(invoice.number);
    if (found) {
      console.log('[qonto-flow] facture déjà présente chez Qonto (' + invoice.number + ') — reprise sans création');
      return found;
    }
  }

  const payload = qonto.mapInvoiceToQonto({
    invoice: invoice,
    qontoClientId: ctx.qontoClientId,
    iban: ctx.config.iban,
    issuer: ctx.issuer,
    qontoConfig: {
      transactionType: ctx.billing.transactionType || 'services',
      vatPaymentCondition: ctx.billing.vatPaymentCondition || 'on_receipts',
      cgvShortText: ctx.config.cgvShortText,
    },
  });

  try {
    const created = await qonto.qontoFetch('POST', '/v2/client_invoices', payload);
    return (created && created.client_invoice) ? created.client_invoice : created;
  } catch (err) {
    /* Numéro déjà pris chez Qonto = la facture existe. Ce n'est pas un échec :
       on la récupère et on continue. Ne JAMAIS incrémenter le compteur ici. */
    if (err.status === 409 || err.qontoCode === 'invoice_number_already_exists') {
      const found = await findInvoiceByNumber(invoice.number);
      if (found) return found;
    }
    throw err;
  }
}

/**
 * Étape 3 — transmission réseau, uniquement pour un client société identifié.
 * Best-effort : un échec ici ne doit pas priver la facture de son PDF.
 */
async function sendByEinvoice(ctx, qontoInvoice) {
  const invoice = ctx.invoice;
  if (!ctx.config.autoSendEinvoice) return { sent: false, reason: 'désactivé dans les réglages' };
  if (invoice.qonto && invoice.qonto.sentByEinvoiceAt) return { sent: false, reason: 'déjà transmise' };

  const snapshot = invoice.clientSnapshot || {};
  const isCompany = snapshot.clientType === 'company';
  const siret = String(snapshot.siret || '').replace(/\s+/g, '');
  if (!isCompany) return { sent: false, reason: 'client particulier — relève de l\'e-reporting' };
  if (!siret) return { sent: false, reason: 'SIRET absent' };

  try {
    await qonto.qontoFetch('POST', '/v2/client_invoices/' + encodeURIComponent(qontoInvoice.id) + '/send_by_einvoice', {});
    return { sent: true };
  } catch (e) {
    console.error('[qonto-flow] send_by_einvoice:', e && e.message);
    return { sent: false, reason: String((e && e.message) || e).substring(0, 200), failed: true };
  }
}

/**
 * Étape 4 — le PDF Factur-X. Produit de façon asynchrone : on réessaie.
 * @returns {Promise<{buffer: Buffer, attachmentId: string}>}
 */
async function fetchFacturX(qontoInvoiceId) {
  let attachmentId = null;

  for (let i = 0; i <= PDF_RETRY_DELAYS_MS.length; i++) {
    const res = await qonto.qontoFetch('GET', '/v2/client_invoices/' + encodeURIComponent(qontoInvoiceId));
    const inv = (res && res.client_invoice) ? res.client_invoice : res;
    attachmentId = (inv && (inv.attachment_id || inv.invoice_attachment_id)) || null;
    if (attachmentId) break;
    if (i < PDF_RETRY_DELAYS_MS.length) await sleep(PDF_RETRY_DELAYS_MS[i]);
  }

  if (!attachmentId) {
    const e = new Error('Qonto n\'a pas encore produit le PDF Factur-X. Relance la synchronisation dans une minute.');
    e.status = 503;
    throw e;
  }

  const att = await qonto.qontoFetch('GET', '/v2/attachments/' + encodeURIComponent(attachmentId));
  const meta = (att && att.attachment) ? att.attachment : att;
  const url = meta && (meta.url || meta.file_url);
  if (!url) {
    const e = new Error('Qonto n\'a pas renvoyé de lien de téléchargement pour le PDF.'); e.status = 502; throw e;
  }

  /* L'URL de téléchargement est signée et publique : pas d'en-tête Qonto ici. */
  const response = await fetch(url);
  if (!response.ok) {
    const e = new Error('Téléchargement du PDF Factur-X échoué (' + response.status + ')'); e.status = 502; throw e;
  }
  const arrayBuf = await response.arrayBuffer();
  return { buffer: Buffer.from(arrayBuf), attachmentId: attachmentId };
}

/**
 * Le flux complet.
 *
 * @param {Object} ctx { db, admin, invoice, invoiceId, issuer, billing, config }
 * @returns {Promise<{ pdfBuf: Buffer, qonto: Object, einvoice: Object }>}
 */
async function runQontoFlow(ctx) {
  const invoice = ctx.invoice;
  if (!ctx.config.iban) {
    const e = new Error('Aucun IBAN Qonto configuré (Paramètres → Facturation électronique).'); e.status = 400; throw e;
  }

  const qontoClientId = await upsertClient({
    db: ctx.db, admin: ctx.admin, clientId: invoice.clientId,
  });

  const qontoInvoice = await createInvoice({
    invoice: invoice, qontoClientId: qontoClientId,
    issuer: ctx.issuer, billing: ctx.billing, config: ctx.config,
  });

  const einvoice = await sendByEinvoice({ invoice: invoice, config: ctx.config }, qontoInvoice);

  const pdf = await fetchFacturX(qontoInvoice.id);

  return {
    pdfBuf: pdf.buffer,
    einvoice: einvoice,
    qonto: {
      clientId: qontoClientId,
      invoiceId: qontoInvoice.id,
      invoiceUrl: qontoInvoice.invoice_url || qontoInvoice.url || null,
      attachmentId: pdf.attachmentId,
      status: qontoInvoice.status || null,
      einvoicingStatus: qontoInvoice.einvoicing_status || null,
    },
  };
}

module.exports = {
  loadQontoConfig: loadQontoConfig,
  runQontoFlow: runQontoFlow,
  upsertClient: upsertClient,
  createInvoice: createInvoice,
  sendByEinvoice: sendByEinvoice,
  fetchFacturX: fetchFacturX,
  findInvoiceByNumber: findInvoiceByNumber,
};
