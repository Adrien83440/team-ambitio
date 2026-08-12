// ============================================================================
// api/invoice-qonto-sync.js — RATTRAPAGE QONTO D'UNE FACTURE
// ----------------------------------------------------------------------------
// POST /api/invoice-qonto-sync   { invoiceId, force? }
//   Auth : Bearer admin OU x-system-key (purpose invoiceGeneration)
//   → 200 { success, invoiceId, number, qontoSyncStatus, pdfHash, pdfSource }
//
// C'est le filet de sécurité de tout le dispositif. Une facture peut avoir
// échoué à n'importe quelle étape — client, création, transmission réseau,
// récupération du PDF. Cet endpoint la reprend là où elle en est.
//
// STRICTEMENT IDEMPOTENT : appelable dix fois de suite sans effet de bord.
//   - client déjà créé chez Qonto        → réutilisé
//   - facture déjà créée                 → jamais recréée
//   - facture déjà transmise             → jamais retransmise
//   - PDF déjà récupéré et pdfSource=qonto → rien à faire (sauf force:true)
//
// Le numéro de facture n'est jamais retouché : la chronologie légale des
// numéros doit rester continue, même après un incident.
// ============================================================================

const {
  admin, db, requireAuthOrSystemKey, sha256, chunkBufferToBase64, sendError, setCors,
} = require('./_billing-helpers');
const qontoFlow = require('./_qonto-invoice-flow');

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    const user = await requireAuthOrSystemKey(req, ['admin'], 'invoiceGeneration');

    const body = req.body || {};
    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId.trim() : '';
    const force = body.force === true;
    if (!invoiceId) {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }

    const cfg = await qontoFlow.loadQontoConfig(db);
    if (!cfg.enabled) {
      const e = new Error('La facturation via Qonto est désactivée (Paramètres → Facturation électronique).');
      e.status = 409; throw e;
    }

    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data() || {};

    if (invoice.status === 'draft' || !invoice.number) {
      const e = new Error('Cette facture n\'est pas encore validée — il n\'y a rien à synchroniser.');
      e.status = 409; throw e;
    }

    /* Même garde-fou qu'à la validation : un client rattaché à l'entreprise
       individuelle ne doit jamais atteindre Qonto, donc jamais le réseau.
       Ce chemin-ci est celui du rattrapage, souvent lancé en série sur
       d'anciennes factures — c'est précisément là qu'une fiche EI passerait
       inaperçue. */
    if (invoice.clientId) {
      const cSnap = await db.collection('invoice_clients').doc(invoice.clientId).get();
      if (cSnap.exists && (cSnap.data() || {}).billingScope === 'ei') {
        const e = new Error(
          'Ce client est rattaché à l\'entreprise individuelle : ses factures ne '
          + 'transitent pas par Qonto. Synchronisation refusée.'
        );
        e.status = 409; throw e;
      }
    }

    /* Déjà complète : on ne retélécharge pas un PDF déjà stocké.
       Une exception : le report du paiement. Il peut avoir échoué alors que
       la facture, elle, est bien passée — c'est même le cas le plus courant,
       Qonto ayant pu être injoignable une seconde au mauvais moment. Ce
       chemin doit donc pouvoir le rejouer seul, sinon le bouton ⚡ n'aurait
       aucun effet sur une facture par ailleurs complète. */
    if (!force && invoice.pdfHash && invoice.pdfSource === 'qonto'
        && invoice.qonto && invoice.qonto.invoiceId) {
      let retryPaid = null;
      const needsPaidRetry = invoice.status === 'paid'
        && !(invoice.qonto && invoice.qonto.paidSyncedAt);
      if (needsPaidRetry) {
        const paidAtDate = (invoice.paidAt && invoice.paidAt.toDate)
          ? invoice.paidAt.toDate()
          : new Date();
        retryPaid = await qontoFlow.markPaidAtQonto(invoice.qonto.invoiceId, paidAtDate);
        try {
          await invRef.update({
            'qonto.paidSyncedAt': retryPaid.ok ? admin.firestore.FieldValue.serverTimestamp() : null,
            'qonto.paidSyncError': retryPaid.ok ? null : (retryPaid.reason || 'échec'),
          });
        } catch (traceErr) {
          console.error('[invoice-qonto-sync] trace paiement non écrite:', traceErr && traceErr.message);
        }
      }
      res.status(200).json({
        success: true, invoiceId: invoiceId, number: invoice.number,
        qontoSyncStatus: invoice.qontoSyncStatus || 'created',
        alreadySynced: true, pdfHash: invoice.pdfHash, pdfSource: 'qonto',
        qontoPaid: retryPaid,
      });
      return;
    }

    const billingSnap = await db.collection('_config').doc('billing').get();
    if (!billingSnap.exists) {
      const e = new Error('Configuration de facturation manquante'); e.status = 500; throw e;
    }
    const issuerData = billingSnap.data();
    /* On repart de l'émetteur figé sur la facture : c'est lui qui fait foi
       pour un document déjà validé, pas la config du jour. */
    const issuer = invoice.issuerSnapshot || issuerData;

    let result;
    try {
      result = await qontoFlow.runQontoFlow({
        db: db, admin: admin,
        invoice: Object.assign({}, invoice, { id: invoiceId }),
        invoiceId: invoiceId,
        issuer: issuer,
        billing: issuerData,
        config: cfg,
      });
    } catch (qErr) {
      console.error('[invoice-qonto-sync] échec:', qErr);
      await invRef.update({
        qontoSyncStatus: 'failed',
        'qonto.lastError': String(qErr.message || qErr).substring(0, 500),
        'qonto.lastErrorAt': admin.firestore.FieldValue.serverTimestamp(),
        'qonto.attempts': admin.firestore.FieldValue.increment(1),
      });
      throw qErr;
    }

    /* ── Stockage du PDF : mêmes champs et même découpage que l'existant ── */
    const pdfBuf = result.pdfBuf;
    const pdfHash = sha256(pdfBuf);
    const chunks = chunkBufferToBase64(pdfBuf);

    const pdfCol = invRef.collection('pdf');
    const previousChunks = await pdfCol.get();
    const batch = db.batch();
    previousChunks.forEach(function (d) { batch.delete(d.ref); });
    chunks.forEach(function (data, i) {
      const chunkRef = pdfCol.doc('chunk_' + String(i).padStart(4, '0'));
      batch.set(chunkRef, { index: i, total: chunks.length, data: data });
    });

    batch.update(invRef, {
      pdfHash: pdfHash,
      pdfChunkCount: chunks.length,
      pdfSizeBytes: pdfBuf.length,
      pdfGeneratedAt: admin.firestore.FieldValue.serverTimestamp(),
      pdfPending: false,
      pdfError: null,
      pdfErrorAt: null,
      pdfSource: 'qonto',
      qontoSyncStatus: (result.einvoice && result.einvoice.sent) ? 'sent' : 'created',
      qonto: Object.assign({}, result.qonto, {
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        sentByEinvoiceAt: (result.einvoice && result.einvoice.sent)
          ? admin.firestore.FieldValue.serverTimestamp()
          : ((invoice.qonto && invoice.qonto.sentByEinvoiceAt) || null),
        einvoiceSkipReason: (result.einvoice && !result.einvoice.sent)
          ? (result.einvoice.reason || null) : null,
        lastError: null,
        lastErrorAt: null,
        syncedBy: user.uid || 'system',
      }),
    });
    await batch.commit();

    /* ── Report du paiement ──
       Une facture encaissée avant d'exister chez Qonto — typiquement un
       rattrapage — y serait créée en « impayée ». On répercute donc l'état
       réel dans la foulée. Best-effort : la facture et son PDF sont déjà
       enregistrés, un échec ici ne doit pas les remettre en cause. */
    let qontoPaid = null;
    if (invoice.status === 'paid') {
      const paidAtDate = (invoice.paidAt && invoice.paidAt.toDate)
        ? invoice.paidAt.toDate()
        : new Date();
      qontoPaid = await qontoFlow.markPaidAtQonto(result.qonto.invoiceId, paidAtDate);
      try {
        await invRef.update({
          'qonto.paidSyncedAt': qontoPaid.ok ? admin.firestore.FieldValue.serverTimestamp() : null,
          'qonto.paidSyncError': qontoPaid.ok ? null : (qontoPaid.reason || 'échec'),
        });
      } catch (traceErr) {
        console.error('[invoice-qonto-sync] trace paiement non écrite:', traceErr && traceErr.message);
      }
    }

    res.status(200).json({
      success: true,
      invoiceId: invoiceId,
      number: invoice.number,
      qontoSyncStatus: (result.einvoice && result.einvoice.sent) ? 'sent' : 'created',
      einvoice: result.einvoice || null,
      qontoPaid: qontoPaid,
      pdfHash: pdfHash,
      pdfSource: 'qonto',
      pdfChunkCount: chunks.length,
    });
  } catch (err) {
    sendError(res, err);
  }
};
