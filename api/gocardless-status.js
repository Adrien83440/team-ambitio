// ==========================================================================
// api/gocardless-status.js
// --------------------------------------------------------------------------
// Récupère le statut live d'un paiement/abonnement GoCardless
// + liste des prélèvements passés pour un mandat donné
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { mandate, subscription|payment, payments: [] }
// ==========================================================================

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
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
    res.status(403).json({ error: 'Rôle sales ou admin requis' }); return;
  }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé' }); return;
    }

    const result = { mandate: null, subscription: null, payment: null, payments: [] };

    // Fetch mandate
    if (pay.gcMandateId) {
      const md = await gcGet(`/mandates/${pay.gcMandateId}`);
      if (md) result.mandate = {
        id: md.mandates.id,
        status: md.mandates.status,
        reference: md.mandates.reference,
        createdAt: md.mandates.created_at,
        nextPossibleChargeDate: md.mandates.next_possible_charge_date
      };
    }

    // Fetch subscription
    if (pay.gcSubscriptionId) {
      const sub = await gcGet(`/subscriptions/${pay.gcSubscriptionId}`);
      if (sub) result.subscription = {
        id: sub.subscriptions.id,
        status: sub.subscriptions.status,
        amount: sub.subscriptions.amount / 100,
        currency: sub.subscriptions.currency,
        interval: sub.subscriptions.interval,
        intervalUnit: sub.subscriptions.interval_unit,
        count: sub.subscriptions.count,
        paidCount: sub.subscriptions.payment_reference ? null : undefined,
        upcomingPayments: sub.subscriptions.upcoming_payments || [],
        createdAt: sub.subscriptions.created_at,
        endDate: sub.subscriptions.end_date
      };
    }

    // Fetch single payment
    if (pay.gcPaymentId) {
      const pm = await gcGet(`/payments/${pay.gcPaymentId}`);
      if (pm) result.payment = {
        id: pm.payments.id,
        status: pm.payments.status,
        amount: pm.payments.amount / 100,
        currency: pm.payments.currency,
        chargeDate: pm.payments.charge_date,
        description: pm.payments.description
      };
    }

    // Fetch all payments for this mandate
    if (pay.gcMandateId) {
      const pmList = await gcGet(`/payments?mandate=${pay.gcMandateId}&sort_field=charge_date&sort_direction=desc`);
      if (pmList && pmList.payments) {
        result.payments = pmList.payments.map(p => ({
          id: p.id,
          status: p.status,
          amount: p.amount / 100,
          currency: p.currency,
          chargeDate: p.charge_date,
          description: p.description
        }));
      }
    }

    // Sync Firestore avec les données live
    const paidRaw = result.payments.filter(p => p.status === 'paid_out' || p.status === 'confirmed');
    // Déduplique par gcPaymentId (protection contre double-sync)
    const seenIds = new Set();
    const paidPayments = paidRaw.filter(p => { if (seenIds.has(p.id)) return false; seenIds.add(p.id); return true; });
    const paidAmount = paidPayments.reduce((s, p) => s + p.amount, 0);
    const updateData = {
      paidCount: paidPayments.length,
      paidAmount: Math.round(paidAmount * 100) / 100,
      paymentsHistory: paidPayments.map(p => ({ gcPaymentId: p.id, amount: p.amount, date: p.chargeDate, status: p.status })),
      gcLastSyncAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    };
    if (result.subscription) {
      const subStatus = result.subscription.status;
      if (subStatus === 'finished') updateData.status = 'completed';
      else if (subStatus === 'cancelled') updateData.status = 'cancelled';
      else if (subStatus === 'active') updateData.status = 'active';
    }
    await paySnap.ref.update(updateData);

    res.json(result);
  } catch (e) {
    console.error('[gocardless-status]', e.message);
    res.status(500).json({ error: e.message });
  }
};
