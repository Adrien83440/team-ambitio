/**
 * api/admin-rattrapage-historique.js
 *
 * Endpoint POST pour rattraper les mensualités historiques d'une subscription
 * qui ont été payées chez GoCardless avant la mise en place du module
 * facturation team. Cas typique : subscriptions issues de la migration
 * step4a (_startDateSource === 'from_history') dont les premières mensualités
 * ont déjà été prélevées chez GC sans facture team correspondante.
 *
 * Pour chaque paiement GC déjà versé fourni en input :
 *   1. Crée un draft d'invoice Firestore (mêmes champs que subscription-generate-invoice)
 *   2. Appelle invoice-validate (via x-system-key) pour numérotation + PDF
 *   3. Marque la facture comme paid (status=paid, paidAt, paidVia=gocardless, gcPaymentId)
 *
 * Aucun email envoyé (conforme C2=b : factures créées en archive, l'admin
 * pourra envoyer manuellement plus tard via le bouton "Envoyer" si besoin).
 *
 * La date d'émission de la facture (issueDate) est posée par invoice-validate
 * à la date du jour — c'est légalement correct, une facture émise aujourd'hui
 * pour une prestation passée. Le mois facturé apparaît dans la description
 * de la ligne (ex: "Coaching mensuel — janvier 2026") et la date de paiement
 * réelle est conservée dans `paidAt`.
 *
 * À la fin : update de la subscription, `installmentsGenerated += N`.
 *
 * Trace d'audit : chaque facture est flaggée _isHistoricalCatchUp=true avec
 * les champs _historicalChargeDate, _historicalPaidOutDate, _historicalGcPaymentId.
 *
 * ─── Auth ───
 * Bearer admin uniquement. Cette opération est sensible (création de factures
 * antidatées + marquage paid), donc on impose un admin humain identifié.
 *
 * ─── POST body ───
 * {
 *   subscriptionId: string,
 *   payments: [
 *     {
 *       gcPaymentId: string,          // "PM00XXXXX"
 *       chargeDate: string,            // "YYYY-MM-DD" — date de facturation chez GC
 *       paidOutDate: string,           // "YYYY-MM-DD" — date de versement chez GC
 *       amountGross: number            // montant TTC brut en € (ex: 504.70)
 *     },
 *     ...
 *   ],
 *   dryRun?: boolean                   // si true, ne crée rien, retourne juste la prévision
 * }
 *
 * ─── Response 200 ───
 * {
 *   success: true,
 *   subscriptionId,
 *   created: [{ invoiceId, number, chargeDate, paidOutDate, amount, gcPaymentId, description }],
 *   previousInstallmentsGenerated,
 *   newInstallmentsGenerated
 * }
 *
 * En cas d'erreur à mi-parcours : les factures déjà créées AVANT l'erreur
 * restent en place (status=paid, numéros attribués). Le compteur Subscription
 * n'est mis à jour qu'à la fin si TOUT a réussi, sinon il reste à son ancien
 * niveau et il faudra le corriger manuellement ou relancer.
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    /* ── Auth Bearer admin ── */
    const user = await requireAuth(req, ['admin']);

    /* ── Body parsing (Vercel arrive en string parfois) ── */
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (_) { body = {}; }
    }
    body = body || {};

    const subscriptionId = body.subscriptionId;
    const payments = body.payments;
    const dryRun = !!body.dryRun;

    /* ── Validations input ── */
    if (!subscriptionId || typeof subscriptionId !== 'string') {
      const e = new Error('subscriptionId requis'); e.status = 400; throw e;
    }
    if (!Array.isArray(payments) || payments.length === 0) {
      const e = new Error('payments (array non vide) requis'); e.status = 400; throw e;
    }

    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!p || typeof p !== 'object') {
        const e = new Error('payments[' + i + '] doit être un objet'); e.status = 400; throw e;
      }
      /* gcPaymentId est OPTIONNEL : si absent, on génère un placeholder
         déterministe basé sur subscriptionId + chargeDate, ce qui permet :
         - de garder l'unicité dans la collection invoices (check anti-doublon)
         - de tracer manuellement la facture comme issue d'un rattrapage sans ID GC réel
         L'admin peut quand même fournir le vrai PM00... s'il le veut. */
      if (p.gcPaymentId != null && typeof p.gcPaymentId !== 'string') {
        const e = new Error('payments[' + i + '] : gcPaymentId doit être une string (ou absent)'); e.status = 400; throw e;
      }
      if (!p.chargeDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.chargeDate)) {
        const e = new Error('payments[' + i + '] : chargeDate requise au format YYYY-MM-DD'); e.status = 400; throw e;
      }
      if (!p.paidOutDate || !/^\d{4}-\d{2}-\d{2}$/.test(p.paidOutDate)) {
        const e = new Error('payments[' + i + '] : paidOutDate requise au format YYYY-MM-DD'); e.status = 400; throw e;
      }
      const amt = parseFloat(p.amountGross);
      if (isNaN(amt) || amt <= 0) {
        const e = new Error('payments[' + i + '] : amountGross > 0 requis'); e.status = 400; throw e;
      }
      /* Si gcPaymentId absent → génère un placeholder déterministe */
      if (!p.gcPaymentId) {
        p.gcPaymentId = 'HISTORICAL-' + subscriptionId + '-' + p.chargeDate;
        p._gcPaymentIdPlaceholder = true;
      }
    }

    /* ── Détection des duplicates dans l'input (gcPaymentId unique) ── */
    const seenGcIds = {};
    for (let i = 0; i < payments.length; i++) {
      if (seenGcIds[payments[i].gcPaymentId]) {
        const e = new Error('Doublon dans payments : gcPaymentId ' + payments[i].gcPaymentId + ' apparaît plusieurs fois');
        e.status = 400; throw e;
      }
      seenGcIds[payments[i].gcPaymentId] = true;
    }

    /* ── Tri chronologique par chargeDate ascendant ── */
    payments.sort(function(a, b){ return a.chargeDate.localeCompare(b.chargeDate); });

    /* ── Détection des duplicates VS factures existantes Firestore ── */
    /* On vérifie qu'aucune facture n'a déjà été créée pour ces gcPaymentId
       (cas où le rattrapage aurait déjà été lancé partiellement). */
    const gcIds = payments.map(function(p){ return p.gcPaymentId; });
    /* Firestore IN supporte max 10 valeurs par query. On batche si besoin. */
    const existingInvoices = [];
    for (let i = 0; i < gcIds.length; i += 10) {
      const batch = gcIds.slice(i, i + 10);
      const snap = await db.collection('invoices').where('gcPaymentId', 'in', batch).get();
      snap.forEach(function(d) {
        existingInvoices.push({ id: d.id, gcPaymentId: d.data().gcPaymentId, number: d.data().number });
      });
    }
    if (existingInvoices.length > 0) {
      const e = new Error('Factures déjà existantes pour ces paiements GC : ' +
        existingInvoices.map(function(x){ return x.gcPaymentId + '→' + (x.number || x.id); }).join(', ') +
        '. Retirer ces paiements de l\'input ou supprimer ces factures avant de relancer.');
      e.status = 409;
      throw e;
    }

    /* ── Lecture subscription ── */
    const subRef = db.collection('subscriptions').doc(subscriptionId);
    const subSnap = await subRef.get();
    if (!subSnap.exists) {
      const e = new Error('Subscription introuvable : ' + subscriptionId); e.status = 404; throw e;
    }
    const sub = subSnap.data();

    /* ── Lecture client ── */
    if (!sub.clientId) {
      const e = new Error('Subscription sans clientId — corriger d\'abord la sub'); e.status = 400; throw e;
    }
    const clientSnap = await db.collection('invoice_clients').doc(sub.clientId).get();
    if (!clientSnap.exists) {
      const e = new Error('Client introuvable : ' + sub.clientId); e.status = 404; throw e;
    }
    const client = clientSnap.data();

    /* ── Lecture _config/billing pour TVA + délai paiement ── */
    const billingSnap = await db.collection('_config').doc('billing').get();
    const billing = billingSnap.exists ? billingSnap.data() : {};

    /* ── Snapshot client (mêmes champs que subscription-generate-invoice) ── */
    const clientSnapshot = {
      clientType: client.clientType || 'individual',
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

    const clientDisplayName = (clientSnapshot.companyName ||
      (clientSnapshot.contactFirstName + ' ' + clientSnapshot.contactLastName).trim() ||
      clientSnapshot.email || '(client sans nom)');

    /* ── Mois FR pour description ── */
    const FR_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin',
      'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

    const vatRate = client.vatExempt ? 0 : (billing.vatRate != null ? billing.vatRate : 20);
    const vatType = sub.vatType || 'ttc';
    const paymentTermsDays = billing.defaultPaymentTerms != null ? billing.defaultPaymentTerms : 30;
    const descTemplate = sub.descriptionTemplate || 'Coaching mensuel — {month_name} {year}';

    /* ── DryRun : préparer les résultats sans rien créer ── */
    if (dryRun) {
      const preview = [];
      for (let i = 0; i < payments.length; i++) {
        const p = payments[i];
        const charge = new Date(p.chargeDate + 'T12:00:00');
        const desc = descTemplate
          .replace(/\{month_name\}/g, FR_MONTHS[charge.getMonth()])
          .replace(/\{month_number\}/g, String(charge.getMonth() + 1).padStart(2, '0'))
          .replace(/\{year\}/g, String(charge.getFullYear()))
          .replace(/\{installment\}/g, String((sub.installmentsGenerated || 0) + i + 1))
          .replace(/\{total\}/g, sub.totalInstallments != null ? String(sub.totalInstallments) : '?');

        const amt = parseFloat(p.amountGross);
        const unitPriceHt = vatType === 'ttc'
          ? round2(amt / (1 + vatRate / 100))
          : amt;
        const lineVat = round2(unitPriceHt * vatRate / 100);
        const lineTtc = round2(unitPriceHt + lineVat);

        preview.push({
          chargeDate: p.chargeDate,
          paidOutDate: p.paidOutDate,
          gcPaymentId: p.gcPaymentId,
          description: desc + ' (rattrapage historique)',
          amountGross: amt,
          computedHt: unitPriceHt,
          computedVat: lineVat,
          computedTtc: lineTtc,
        });
      }
      res.status(200).json({
        success: true,
        dryRun: true,
        subscriptionId: subscriptionId,
        clientName: clientDisplayName,
        clientId: sub.clientId,
        currentInstallmentsGenerated: sub.installmentsGenerated || 0,
        totalInstallments: sub.totalInstallments,
        wouldGenerate: payments.length + ' facture(s)',
        wouldUpdateInstallmentsGenerated: (sub.installmentsGenerated || 0) + payments.length,
        vatRate: vatRate,
        vatType: vatType,
        paymentTermsDays: paymentTermsDays,
        preview: preview,
      });
      return;
    }

    /* ── Clé système pour appel à invoice-validate ── */
    const keysSnap = await db.collection('_config').doc('system_keys').get();
    const systemKey = keysSnap.exists ? keysSnap.data().invoiceGeneration : null;
    if (!systemKey) {
      const e = new Error('Clé système invoiceGeneration manquante dans _config/system_keys'); e.status = 500; throw e;
    }

    const protocol = (req.headers['x-forwarded-proto'] || 'https');
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const validateUrl = protocol + '://' + host + '/api/invoice-validate';

    /* ── Boucle : créer draft → valider → marquer paid pour chaque paiement ── */
    const created = [];
    const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');

    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      const amount = parseFloat(p.amountGross);

      /* Description templatée avec le mois historique */
      const charge = new Date(p.chargeDate + 'T12:00:00');
      const description = descTemplate
        .replace(/\{month_name\}/g, FR_MONTHS[charge.getMonth()])
        .replace(/\{month_number\}/g, String(charge.getMonth() + 1).padStart(2, '0'))
        .replace(/\{year\}/g, String(charge.getFullYear()))
        .replace(/\{installment\}/g, String((sub.installmentsGenerated || 0) + i + 1))
        .replace(/\{total\}/g, sub.totalInstallments != null ? String(sub.totalInstallments) : '?');

      /* Calcul TTC ↔ HT (même formule que subscription-generate-invoice) */
      let unitPriceHt;
      if (vatType === 'ttc') {
        unitPriceHt = round2(amount / (1 + vatRate / 100));
      } else {
        unitPriceHt = amount;
      }

      const line = {
        productId: sub.productId || null,
        variantId: null,
        productName: '',
        variantLabel: '',
        description: description + ' (rattrapage historique)',
        unit: 'mois',
        qty: 1,
        unitPriceHt: unitPriceHt,
        vatRate: vatRate,
        discountPct: 0,
      };

      const lineHtBeforeDiscount = round2(line.qty * line.unitPriceHt);
      const lineHtAfterDiscount = lineHtBeforeDiscount;
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

      const draftDoc = {
        status: 'draft',
        paymentTermsDays: paymentTermsDays,
        paymentMethod: 'gocardless',
        poNumber: '',
        clientId: sub.clientId,
        clientSnapshot: clientSnapshot,
        issuerSnapshot: null,  /* posé par invoice-validate */
        cgvSnapshot: null,
        lines: [line],
        totalGrossHt: totalGrossHt,
        totalDiscount: totalDiscount,
        totalHt: totalHt,
        totalVat: totalVat,
        totalTtc: totalTtc,
        vatBreakdown: vatBreakdown,
        notesPublic: 'Mensualité ' + p.chargeDate + ' — paiement déjà reçu via GoCardless le ' + p.paidOutDate + '.',
        notesInternal: 'Rattrapage historique pour subscription ' + subscriptionId +
          ' — paiement GC ' + p.gcPaymentId + ' déjà versé le ' + p.paidOutDate +
          '. Migration step4a + Livraison 2 (' + new Date().toISOString().substring(0,10) + ').',
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
        /* Traçabilité rattrapage historique */
        _isHistoricalCatchUp: true,
        _historicalChargeDate: p.chargeDate,
        _historicalPaidOutDate: p.paidOutDate,
        _historicalGcPaymentId: p.gcPaymentId,
      };

      const draftRef = await db.collection('invoices').add(draftDoc);
      const invoiceId = draftRef.id;

      /* Appel invoice-validate (numérotation + PDF) */
      let validateResp;
      try {
        validateResp = await fetchFn(validateUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-system-key': systemKey,
          },
          body: JSON.stringify({ invoiceId: invoiceId }),
        });
      } catch (err) {
        /* Network fail → rollback du draft */
        try { await draftRef.delete(); } catch (_) {}
        const e = new Error('Échec réseau invoice-validate sur paiement ' + p.gcPaymentId + ' : ' + err.message);
        e.status = 502;
        e.partialCreated = created;
        throw e;
      }

      let validateData = {};
      try { validateData = await validateResp.json(); } catch (_) {}

      if (!validateResp.ok) {
        try { await draftRef.delete(); } catch (_) {}
        const e = new Error('invoice-validate erreur sur paiement ' + p.gcPaymentId + ' : ' +
          (validateData.error || 'HTTP ' + validateResp.status));
        e.status = 502;
        e.partialCreated = created;
        throw e;
      }

      const invoiceNumber = validateData.number;

      /* Marquer la facture comme paid avec les infos GC réelles */
      await draftRef.update({
        status: 'paid',
        paidAt: admin.firestore.Timestamp.fromDate(new Date(p.paidOutDate + 'T12:00:00')),
        paidVia: 'gocardless',
        gcPaymentId: p.gcPaymentId,
        paidAmount: amount,
        paidByCatchUp: true,
        catchUpAt: admin.firestore.FieldValue.serverTimestamp(),
        catchUpBy: user.uid,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      created.push({
        invoiceId: invoiceId,
        number: invoiceNumber,
        chargeDate: p.chargeDate,
        paidOutDate: p.paidOutDate,
        amount: amount,
        gcPaymentId: p.gcPaymentId,
        description: description,
      });
    }

    /* ── Update subscription : installmentsGenerated += N ── */
    const previousGenerated = sub.installmentsGenerated || 0;
    const newGenerated = previousGenerated + created.length;

    /* Si on atteint totalInstallments → completed */
    let newStatus = sub.status;
    if (sub.totalInstallments != null && newGenerated >= sub.totalInstallments) {
      newStatus = 'completed';
    }

    await subRef.update({
      installmentsGenerated: newGenerated,
      lastGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      lastGeneratedInvoiceId: created.length > 0 ? created[created.length - 1].invoiceId : sub.lastGeneratedInvoiceId,
      lastGeneratedInvoiceNumber: created.length > 0 ? created[created.length - 1].number : sub.lastGeneratedInvoiceNumber,
      status: newStatus,
      _lastHistoricalCatchUpAt: admin.firestore.FieldValue.serverTimestamp(),
      _lastHistoricalCatchUpBy: user.uid,
      _lastHistoricalCatchUpCount: created.length,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedBy: user.uid,
    });

    /* ── Réponse ── */
    res.status(200).json({
      success: true,
      subscriptionId: subscriptionId,
      clientName: clientDisplayName,
      created: created,
      previousInstallmentsGenerated: previousGenerated,
      newInstallmentsGenerated: newGenerated,
      newStatus: newStatus,
    });

  } catch (err) {
    /* Si on a partiellement créé des factures avant l'erreur, on l'indique
       dans la réponse pour qu'Adrien sache où on en est. */
    if (err.partialCreated && err.partialCreated.length > 0) {
      console.warn('[admin-rattrapage-historique] PARTIAL FAILURE — ' + err.partialCreated.length + ' factures créées avant erreur :',
        err.partialCreated.map(function(c){ return c.number; }).join(', '));
      res.status(err.status || 500).json({
        error: err.message,
        partialCreated: err.partialCreated,
        warning: 'Certaines factures ont été créées avant l\'erreur. installmentsGenerated de la sub n\'a PAS été mis à jour. Vérifier manuellement dans Firestore.',
      });
      return;
    }
    sendError(res, err);
  }
};

function round2(n) {
  return Math.round((parseFloat(n) || 0) * 100) / 100;
}
