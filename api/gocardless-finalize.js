// ==========================================================================
// api/gocardless-finalize.js   (nouveau — 2026-04-17)
// --------------------------------------------------------------------------
// Récupère l'état d'un billing request GoCardless et synchronise le doc
// payment Firestore correspondant (gcCustomerId, gcMandateId, status).
//
// Rôle : filet de sécurité côté client. Quand le sales ouvre un paiement
// en `pending_mandate` sans gcMandateId, payments.html appelle cette route
// pour récupérer immédiatement l'état du BR depuis GoCardless, sans
// attendre le webhook. Utile si :
//   - le webhook onWebhookInbox est en retard (retry GC)
//   - le webhook a été perdu (indisponibilité)
//   - le sales veut forcer un refresh manuel via le bouton dédié
//
// Le webhook `onWebhookInbox` (Cloud Function) reste la source async
// principale. Cette route est purement best-effort côté client.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { status, billingRequestStatus, gcMandateId, gcCustomerId }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
// Version API GoCardless — voir commentaire dans gocardless-billing-request.js
const GC_VERSION = '2015-07-06';

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': GC_VERSION,
      'Accept': 'application/json'
    }
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé' });
      return;
    }
    if (!pay.gcBillingRequestId) {
      res.status(400).json({ error: 'Aucun billing request sur ce paiement' });
      return;
    }

    // ─── Fetch le BR pour lire son statut + ses liens ───
    const brResp = await gcGet('/billing_requests/' + pay.gcBillingRequestId);
    if (!brResp || !brResp.billing_requests) {
      res.status(404).json({ error: 'Billing request introuvable côté GoCardless' });
      return;
    }
    const br = brResp.billing_requests;
    const brStatus = br.status; // pending | ready_to_fulfil | fulfilled | cancelled
    const links = br.links || {};

    const customerId = links.customer || null;
    const mandateId = links.mandate_request_mandate || null;

    const update = {
      gcLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    if (customerId && customerId !== pay.gcCustomerId) update.gcCustomerId = customerId;
    if (mandateId && mandateId !== pay.gcMandateId) update.gcMandateId = mandateId;

    // ─── Mapping statut BR → statut Firestore payment ───
    if (brStatus === 'fulfilled' && mandateId) {
      update.status = 'mandate_active';
      if (!pay.mandateCreatedAt) update.mandateCreatedAt = admin.firestore.FieldValue.serverTimestamp();
    } else if (brStatus === 'cancelled') {
      // Le client a abandonné sur la page hébergée
      update.status = 'draft';
      update.gcBillingRequestFlowUrl = null; // force la regénération d'un nouveau lien
    } else {
      // pending / ready_to_fulfil → on reste en pending_mandate
      update.status = 'pending_mandate';
    }

    await paySnap.ref.update(update);

    console.log('[gocardless-finalize] ✅', {
      paymentId,
      brStatus,
      mandateId,
      customerId,
      newStatus: update.status
    });

    res.json({
      status: update.status,
      billingRequestStatus: brStatus,
      gcMandateId: mandateId,
      gcCustomerId: customerId
    });

  } catch (e) {
    console.error('[gocardless-finalize]', e.message);
    res.status(500).json({ error: e.message });
  }
};
