/**
 * api/invoice-mark-paid.js
 *
 * Endpoint POST de marquage manuel d'une facture comme payée.
 *
 * Transition autorisée : `validated` ou `sent` → `paid`
 * (le marquage payée sans envoi préalable est autorisé : cas où le client
 *  paye via GoCardless avant qu'on lui envoie le PDF de la facture).
 *
 * POST body :
 *   {
 *     invoiceId: string,
 *     paidAmount: number,           // Total TTC normalement, peut être différent
 *     paidAt: string ISO date,       // Date du paiement (default = now)
 *     paidVia: string,               // 'gocardless'|'transfer'|'card'|'check'|'cash'|'other'
 *     paymentRef?: string            // Référence transaction (ID GC, n° chèque, etc.)
 *   }
 *
 * Response 200 : { success, paidAt, paidAmount }
 */

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const qontoFlow = require('./_qonto-invoice-flow');

const VALID_PAYMENT_METHODS = ['gocardless', 'transfer', 'card', 'check', 'cash', 'other'];

module.exports = async function(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  try {
    const user = await requireAuth(req, ['admin']);

    const body = req.body || {};
    const invoiceId = body.invoiceId;
    const paidAmount = parseFloat(body.paidAmount);
    const paidAtRaw = body.paidAt;
    const paidVia = body.paidVia;
    const paymentRef = (body.paymentRef || '').trim() || null;

    if (!invoiceId || typeof invoiceId !== 'string') {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }
    if (isNaN(paidAmount) || paidAmount <= 0) {
      const e = new Error('Montant payé invalide (doit être strictement positif)'); e.status = 400; throw e;
    }
    if (!paidVia || VALID_PAYMENT_METHODS.indexOf(paidVia) === -1) {
      const e = new Error('Méthode de paiement invalide. Valeurs autorisées : ' + VALID_PAYMENT_METHODS.join(', ')); e.status = 400; throw e;
    }

    let paidAtDate;
    if (paidAtRaw) {
      paidAtDate = new Date(paidAtRaw);
      if (isNaN(paidAtDate.getTime())) {
        const e = new Error('Date paidAt invalide'); e.status = 400; throw e;
      }
    } else {
      paidAtDate = new Date();
    }

    /* Lecture facture */
    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data();

    if (invoice.status === 'draft') {
      const e = new Error('Validez la facture avant de la marquer payée'); e.status = 400; throw e;
    }
    if (invoice.status === 'paid') {
      const e = new Error('Facture déjà marquée comme payée'); e.status = 409; throw e;
    }

    /* Update */
    await invRef.update({
      status: 'paid',
      paidAt: admin.firestore.Timestamp.fromDate(paidAtDate),
      paidAmount: paidAmount,
      paidVia: paidVia,
      paymentRef: paymentRef,
      paidBy: user.uid,
      paidByEmail: user.email || null,
      paidMarkedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeline: admin.firestore.FieldValue.arrayUnion({
        type: 'invoice_paid',
        at: new Date().toISOString(),
        by: user.uid,
        byEmail: user.email || null,
        amount: paidAmount,
        via: paidVia,
        ref: paymentRef,
      }),
    });

    /* ── Report du paiement chez Qonto ──
       Uniquement si la facture y existe déjà : une facture en PDF maison n'a
       rien à y synchroniser. On ne regarde volontairement PAS le flag
       d'activation — si la facture est chez Qonto, elle doit y rester juste,
       même si la génération a été désactivée entre-temps.

       Best-effort strict : le marquage dans Alteore est déjà écrit et fait
       foi. Un échec Qonto est tracé sur la facture, jamais remonté en erreur —
       sinon un incident chez eux empêcherait d'encaisser chez nous.

       L'écriture de la trace précède la réponse HTTP : Vercel coupe la
       fonction dès res.end(). */
    let qontoPaid = null;
    const qontoInvoiceId = (invoice.qonto && invoice.qonto.invoiceId) || null;
    if (qontoInvoiceId) {
      qontoPaid = await qontoFlow.markPaidAtQonto(qontoInvoiceId, paidAtDate);
      try {
        await invRef.update({
          'qonto.paidSyncedAt': qontoPaid.ok ? admin.firestore.FieldValue.serverTimestamp() : null,
          'qonto.paidSyncError': qontoPaid.ok ? null : (qontoPaid.reason || 'échec'),
        });
      } catch (traceErr) {
        console.error('[invoice-mark-paid] trace Qonto non écrite:', traceErr && traceErr.message);
      }
    }

    res.status(200).json({
      success: true,
      paidAt: paidAtDate.toISOString(),
      paidAmount: paidAmount,
      paidVia: paidVia,
      paymentRef: paymentRef,
      qontoPaid: qontoPaid,
    });
  } catch (err) {
    sendError(res, err);
  }
};
