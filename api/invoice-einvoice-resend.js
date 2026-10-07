// ============================================================================
// api/invoice-einvoice-resend.js — RENVOYER SUR LE RÉSEAU UNE FACTURE NON REMISE
// ----------------------------------------------------------------------------
// POST /api/invoice-einvoice-resend   { invoiceId }
//   Auth : Bearer admin
//   → 200 { success, resent, events, resentAt }
//
// Cas d'origine : F2026-00115 (L'ATELIER 2C). Déposée chez Qonto le 09/09,
// mais le journal porte « Facture non transmise au destinataire — L'acheteur
// n'a pas de ligne active dans l'Annuaire » : le client a désigné sa
// plateforme le soir même. La facture est marquée transmise de notre côté,
// donc ni la validation ni le rattrapage ne la renverront jamais.
//
// Une retransmission réseau ne s'annule pas : on ne renvoie QUE si les trois
// conditions sont réunies, toutes relues à l'instant (jamais depuis le cache
// Firestore) :
//   1. le journal Qonto dit explicitement que la facture n'a pas été remise ;
//   2. aucun statut réseau positif depuis (submitted / approved) ;
//   3. le client est désormais joignable (Annuaire + Peppol).
// Plus un verrou de 10 minutes contre le double clic.
// ============================================================================

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const qontoFlow = require('./_qonto-invoice-flow');
const qonto = require('./_qonto-client');

const RESEND_LOCK_MS = 10 * 60 * 1000;

/* Le motif « non remise » ne passe pas par einvoicing_status (resté vide sur
   F2026-00115) mais par le texte du journal. On reconnaît les deux. */
function isUndeliveredEvent(e) {
  e = e || {};
  const txt = String(e.reason || '') + ' ' + String(e.reason_message || '');
  return /non transmise/i.test(txt) || /ligne active dans l.Annuaire/i.test(txt);
}

function mapEvent(e) {
  e = e || {};
  return {
    statusCode: e.status_code != null ? e.status_code : null,
    reason: e.reason || null,
    reasonMessage: e.reason_message || null,
    timestamp: e.timestamp || null,
  };
}

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'POST') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    const user = await requireAuth(req, ['admin']);

    const body = req.body || {};
    const invoiceId = typeof body.invoiceId === 'string' ? body.invoiceId.trim() : '';
    if (!invoiceId) {
      const e = new Error('invoiceId requis'); e.status = 400; throw e;
    }

    if (!qonto.isConfigured()) {
      const e = new Error('Connexion Qonto non configurée : ' + qonto.missingConfig().join(', '));
      e.status = 409; throw e;
    }

    const invRef = db.collection('invoices').doc(invoiceId);
    const invSnap = await invRef.get();
    if (!invSnap.exists) {
      const e = new Error('Facture introuvable'); e.status = 404; throw e;
    }
    const invoice = invSnap.data() || {};
    const q = invoice.qonto || {};
    if (!q.invoiceId) {
      const e = new Error('Cette facture n\'existe pas chez Qonto : utilise « Resynchroniser ».');
      e.status = 409; throw e;
    }

    const lastTry = q.einvoiceResendAt && q.einvoiceResendAt.toMillis ? q.einvoiceResendAt.toMillis() : 0;
    if (lastTry && Date.now() - lastTry < RESEND_LOCK_MS) {
      const e = new Error('Un renvoi a déjà été demandé il y a moins de 10 minutes. Relis le statut réseau avant de réessayer.');
      e.status = 409; throw e;
    }

    if (!invoice.clientId) {
      const e = new Error('Facture sans client rattaché.'); e.status = 409; throw e;
    }
    const cRef = db.collection('invoice_clients').doc(invoice.clientId);
    const cSnap = await cRef.get();
    if (!cSnap.exists) {
      const e = new Error('Fiche client introuvable.'); e.status = 404; throw e;
    }
    if ((cSnap.data() || {}).billingScope === 'ei') {
      const e = new Error('Client rattaché à l\'entreprise individuelle : renvoi refusé.');
      e.status = 409; throw e;
    }

    /* 1 et 2 — état réel chez Qonto, à l'instant. */
    const resp = await qonto.qontoFetch('GET', '/v2/client_invoices/' + encodeURIComponent(q.invoiceId));
    const qInv = (resp && resp.client_invoice) ? resp.client_invoice : resp;
    const rawEvents = (qInv && Array.isArray(qInv.einvoicing_lifecycle_events)) ? qInv.einvoicing_lifecycle_events : [];
    const status = (qInv && qInv.einvoicing_status) || null;

    if (status === 'submitted' || status === 'approved') {
      const e = new Error('Qonto indique un statut réseau « ' + status + ' » : la facture est en cours d\'acheminement, pas de renvoi.');
      e.status = 409; throw e;
    }
    /* Après un premier renvoi, l'ancien « non transmise » reste dans le
       journal : seuls les événements postérieurs au dernier renvoi comptent. */
    const lastResent = q.resentByEinvoiceAt && q.resentByEinvoiceAt.toMillis ? q.resentByEinvoiceAt.toMillis() : 0;
    const recent = rawEvents.filter(function (ev) {
      const t = ev && ev.timestamp ? Date.parse(ev.timestamp) : NaN;
      return !lastResent || (!isNaN(t) && t > lastResent);
    });
    if (!recent.some(isUndeliveredEvent) && status !== 'not_delivered') {
      const e = new Error('Le journal Qonto ne signale pas de facture non remise : renvoi refusé par prudence.');
      e.status = 409; throw e;
    }

    /* 3 — le client est-il joignable aujourd'hui ? Relu chez Qonto (force). */
    await qontoFlow.upsertClient({ db: db, admin: admin, clientId: invoice.clientId, force: true });
    const cAfter = (await cRef.get()).data() || {};
    if (cAfter.einvoicingReachable !== true) {
      const e = new Error('Le client n\'est toujours pas joignable dans l\'Annuaire : un renvoi échouerait de la même façon.');
      e.status = 409; throw e;
    }

    /* Verrou posé AVANT l'appel : un double clic pendant la requête bute dessus. */
    await invRef.update({ 'qonto.einvoiceResendAt': admin.firestore.FieldValue.serverTimestamp() });

    let resent = false;
    let errMsg = null;
    try {
      await qonto.qontoFetch('POST', '/v2/client_invoices/' + encodeURIComponent(q.invoiceId) + '/send_by_einvoice', {});
      resent = true;
    } catch (sendErr) {
      errMsg = String((sendErr && sendErr.message) || sendErr).substring(0, 300);
      console.error('[einvoice-resend] send_by_einvoice:', errMsg);
    }

    /* Trace écrite AVANT la réponse : Vercel coupe la fonction dès res.end(). */
    await invRef.update({
      'qonto.einvoiceResends': admin.firestore.FieldValue.arrayUnion({
        at: new Date().toISOString(),
        by: (user && user.uid) || null,
        ok: resent,
        error: errMsg,
      }),
      'qonto.einvoiceResendError': errMsg,
      'qonto.resentByEinvoiceAt': resent ? admin.firestore.FieldValue.serverTimestamp() : (q.resentByEinvoiceAt || null),
    });

    if (!resent) {
      const e = new Error('Qonto a refusé le renvoi : ' + errMsg
        + ' — renvoie-la depuis l\'interface Qonto, ou envoie le PDF par email.');
      e.status = 502; throw e;
    }

    res.status(200).json({
      success: true,
      resent: true,
      events: rawEvents.map(mapEvent),
      resentAt: new Date().toISOString(),
    });
  } catch (err) {
    sendError(res, err);
  }
};
