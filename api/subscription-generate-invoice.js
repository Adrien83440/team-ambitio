/**
 * api/subscription-generate-invoice.js
 *
 * Endpoint de génération automatique d'une facture à partir d'une subscription.
 *
 * Flux :
 *   1. Auth (Bearer admin manuel OU x-system-key=invoiceGeneration depuis cron)
 *   2. Lit la subscription
 *   3. Construit la ligne de facture depuis subscription (montant, description templatée)
 *   4. Crée le draft Firestore (avec issueDate, dueDate calculés)
 *   5. Appelle invoice-validate via fetch HTTP local pour numérotation + PDF
 *   6. Update subscription : installmentsGenerated++, lastGeneratedInvoiceId, nextScheduledAt
 *   7. Si totalInstallments atteint → mark subscription completed
 *
 * POST body : { subscriptionId: string, force?: boolean }
 *   force=true : bypass les checks "subscription pas active" / "trop tôt"
 *                (utilisé par le bouton "Générer maintenant" pour test manuel)
 *
 * Response 200 : { success, invoiceId, number, subscriptionId, installmentsGenerated, nextScheduledAt }
 */

const { admin, db, requireAuthOrSystemKey, sendError, setCors } = require('./_billing-helpers');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth (Bearer admin OU x-system-key invoiceGeneration) ── */
    const user = await requireAuthOrSystemKey(req, ['admin'], 'invoiceGeneration');

    /* ── Body ── */
    const body = req.body || {};
    const subscriptionId = body.subscriptionId;
    const force = !!body.force;
    if (!subscriptionId || typeof subscriptionId !== 'string') {
      const e = new Error('subscriptionId requis'); e.status = 400; throw e;
    }

    /* ── Lecture subscription ── */
    const subRef = db.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) {
      const e = new Error('Subscription introuvable'); e.status = 404; throw e;
    }
    const sub = subSnap.data();

    /* ── Validations ── */
    if (sub.status !== 'active' && !force) {
      const e = new Error('Subscription non active (statut : ' + sub.status + '). Utiliser force=true pour bypass.'); e.status = 409; throw e;
    }
    /* Cap installmentsGenerated vs totalInstallments */
    const generated = sub.installmentsGenerated || 0;
    const paidOnGC = sub.installmentsPaidOnGC || 0;
    /* Numéro réel de la prochaine mensualité = paid sur GC + générées par nous + 1 */
    const installmentNumber = paidOnGC + generated + 1;
    const total = sub.totalInstallments;
    if (total != null && (paidOnGC + generated) >= total && !force) {
      /* Mark completed et retourne sans erreur (idempotent côté cron) */
      await subRef.update({ status: 'completed', updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      res.status(200).json({ success: true, completed: true, message: 'Toutes les mensualités ont été générées' });
      return;
    }

    /* ── Lecture client ── */
    if (!sub.clientId) {
      const e = new Error('Subscription sans clientId'); e.status = 400; throw e;
    }
    const clientSnap = await db.collection('invoice_clients').doc(sub.clientId).get();
    if (!clientSnap.exists) {
      const e = new Error('Client introuvable : ' + sub.clientId); e.status = 404; throw e;
    }
    const client = clientSnap.data();

    /* ── Lecture _config/billing pour TVA par défaut + délai paiement ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};

    /* ── Snapshot client (mêmes champs que makeClientSnapshot frontend) ── */
    const clientSnapshot = {
      /* 100 % B2B : aucun client particulier. Un défaut à 'individual'
         produirait une facture jamais transmise sur le réseau e-invoicing
         (voir sendByEinvoice dans api/_qonto-invoice-flow.js), sans erreur. */
      clientType: client.clientType || 'company',
      companyName: client.companyName || '',
      contactFirstName: client.contactFirstName || '',
      contactLastName: client.contactLastName || '',
      email: client.email || '',
      phone: client.phone || '',
      siret: client.siret || '',
      vatNumber: client.vatNumber || '',
      vatExempt: !!client.vatExempt,
      address: Object.assign({ line1: '', line2: '', postalCode: '', city: '', country: 'France' },
        client.address || {}),
    };

    /* ── Construire la description templatée ── */
    const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
    const now = new Date();
    /* Le prélèvement GC arrive demain (= nextScheduledAt + 1 jour côté calcul cron),
       le mois facturé = celui du prélèvement à venir */
    const billingMonth = sub.nextScheduledAt && sub.nextScheduledAt.toDate
      ? sub.nextScheduledAt.toDate()
      : now;
    /* Le prélèvement c'est nextScheduledAt + 1 jour */
    const prelevement = new Date(billingMonth.getTime() + 24 * 60 * 60 * 1000);

    let description = sub.descriptionTemplate || 'Mensualité {month_name} {year}';
    description = description
      .replace(/\{month_name\}/g, FR_MONTHS[prelevement.getMonth()])
      .replace(/\{month_number\}/g, String(prelevement.getMonth() + 1).padStart(2, '0'))
      .replace(/\{year\}/g, prelevement.getFullYear())
      .replace(/\{installment\}/g, String(installmentNumber))
      .replace(/\{total\}/g, total != null ? String(total) : '?');

    /* ── Calcul de la ligne (TTC ou HT selon vatType subscription) ── */
    const installmentAmount = parseFloat(sub.installmentAmount || 0);
    if (!installmentAmount || installmentAmount <= 0) {
      const e = new Error('installmentAmount manquant ou invalide sur subscription'); e.status = 400; throw e;
    }

    const vatRate = client.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
    const vatType = sub.vatType || 'ttc';
    let unitPriceHt;
    if (vatType === 'ttc') {
      /* Le montant subscription est TTC → on rétro-calcule le HT */
      unitPriceHt = round2(installmentAmount / (1 + vatRate / 100));
    } else {
      /* HT classique */
      unitPriceHt = installmentAmount;
    }

    const line = {
      productId: sub.productId || null,
      variantId: null,
      productName: '',
      variantLabel: '',
      description: description,
      unit: 'mois',
      qty: 1,
      unitPriceHt: unitPriceHt,
      vatRate: vatRate,
      discountPct: 0,
    };

    /* Calculer totaux comme frontend */
    const lineHtBeforeDiscount = round2(line.qty * line.unitPriceHt);
    const lineHtAfterDiscount = lineHtBeforeDiscount; /* pas de remise */
    const lineVat = round2(lineHtAfterDiscount * line.vatRate / 100);
    const lineTtc = round2(lineHtAfterDiscount + lineVat);
    line.lineHtBeforeDiscount = lineHtBeforeDiscount;
    line.discountAmount = 0;
    line.lineHtAfterDiscount = lineHtAfterDiscount;
    line.lineVat = lineVat;
    line.lineTtc = lineTtc;

    const totalGrossHt = lineHtBeforeDiscount;
    const totalDiscount = 0;
    const totalHt = lineHtAfterDiscount;
    const totalVat = lineVat;
    const totalTtc = lineTtc;
    const vatBreakdown = vatRate > 0
      ? [{ rate: vatRate, base: totalHt, vat: totalVat }]
      : [{ rate: 0, base: totalHt, vat: 0 }];

    /* ── Création du draft ── */
    const paymentTermsDays = billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30;
    const draftDoc = {
      status: 'draft',
      paymentTermsDays: paymentTermsDays,
      paymentMethod: 'gocardless',
      poNumber: '',
      clientId: sub.clientId,
      clientSnapshot: clientSnapshot,
      issuerSnapshot: null,  /* posé par invoice-validate */
      cgvSnapshot: null,     /* posé par invoice-validate */
      lines: [line],
      totalGrossHt: totalGrossHt,
      totalDiscount: totalDiscount,
      totalHt: totalHt,
      totalVat: totalVat,
      totalTtc: totalTtc,
      vatBreakdown: vatBreakdown,
      notesPublic: '',
      notesInternal: 'Facture générée automatiquement depuis l\'abonnement ' + subscriptionId,
      linkedPaymentId: sub.paymentDocId || null,
      linkedSubscriptionId: subscriptionId,
      pdfHash: null,
      isLocked: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: user.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: user.uid,
      _autoGenerated: true,
      _autoGeneratedFromSubscription: subscriptionId,
      _autoGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
    };

    const draftRef = await db.collection('invoices').add(draftDoc);
    const invoiceId = draftRef.id;

    /* ── Appel à invoice-validate (avec x-system-key pour bypass Bearer) ── */
    /* Récupère la clé système pour la propager */
    const keysSnap = await db.collection('_config').doc('system_keys').get();
    const systemKey = keysSnap.exists ? keysSnap.data().invoiceGeneration : null;
    if (!systemKey) {
      const e = new Error('Clé système invoiceGeneration manquante dans _config/system_keys'); e.status = 500; throw e;
    }

    /* Construire l'URL absolue (Vercel met VERCEL_URL ou utilise host header) */
    const protocol = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const validateUrl = protocol + '://' + host + '/api/invoice-validate';

    let validateResp;
    try {
      const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
      validateResp = await fetchFn(validateUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-system-key': systemKey,
        },
        body: JSON.stringify({ invoiceId: invoiceId }),
      });
    } catch (err) {
      /* La call a échoué → rollback : delete le draft */
      try { await draftRef.delete(); } catch (_) {}
      const e = new Error('Échec appel invoice-validate : ' + err.message); e.status = 502; throw e;
    }

    let validateData = {};
    try { validateData = await validateResp.json(); } catch (_) {}

    if (!validateResp.ok) {
      try { await draftRef.delete(); } catch (_) {}
      const e = new Error('invoice-validate erreur : ' + (validateData.error || 'HTTP ' + validateResp.status));
      e.status = 502;
      throw e;
    }

    const invoiceNumber = validateData.number;

    /* ── Update subscription : installmentsGenerated++, nextScheduledAt += 1 mois ── */
    const newGenerated = generated + 1;
    let newStatus = sub.status;
    let newNextScheduledAt = null;

    if (total != null && newGenerated >= total) {
      /* Mensualités atteintes → completed */
      newStatus = 'completed';
    } else {
      /* Avancer nextScheduledAt d'un mois */
      const cur = sub.nextScheduledAt && sub.nextScheduledAt.toDate
        ? sub.nextScheduledAt.toDate()
        : new Date();
      const nx = new Date(cur.getFullYear(), cur.getMonth() + 1, cur.getDate());
      newNextScheduledAt = admin.firestore.Timestamp.fromDate(nx);
    }

    const subUpdate = {
      installmentsGenerated: newGenerated,
      lastGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastGeneratedInvoiceId: invoiceId,
      lastGeneratedInvoiceNumber: invoiceNumber,
      nextScheduledAt: newNextScheduledAt,
      status: newStatus,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    await subRef.update(subUpdate);

    /* ── Réponse ── */
    res.status(200).json({
      success: true,
      invoiceId: invoiceId,
      number: invoiceNumber,
      subscriptionId: subscriptionId,
      installmentsGenerated: newGenerated,
      totalInstallments: total,
      newStatus: newStatus,
      nextScheduledAt: newNextScheduledAt ? newNextScheduledAt.toDate().toISOString() : null,
      pdfHash: validateData.pdfHash,
    });
  } catch (err) {
    sendError(res, err);
  }
};

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}
