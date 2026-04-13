// ==========================================================================
// api/gocardless-payment.js
// --------------------------------------------------------------------------
// Déclenche un paiement GoCardless sur un mandat existant.
// - Paiement intégral  → POST /payments
// - Fractionné         → POST /subscriptions
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

async function gcRequest(method, path, body) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
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
    if (!pay.gcMandateId) {
      res.status(400).json({ error: 'Aucun mandat actif — le client doit d\'abord renseigner son IBAN' }); return;
    }
    if (pay.gcPaymentId || pay.gcSubscriptionId) {
      res.status(400).json({ error: 'Un paiement ou abonnement existe déjà pour ce mandat' }); return;
    }

    const amountCents = Math.round(pay.installmentAmount * 100);
    const description = pay.description || 'Programme Business Phénix';

    let gcId, gcType, update;

    if (pay.type === 'installments' && pay.installmentsCount > 1) {
      // Abonnement mensuel
      const startDate = pay.startDate || new Date().toISOString().slice(0, 10);
      const subResp = await gcRequest('POST', '/subscriptions', {
        subscriptions: {
          amount: amountCents,
          currency: 'EUR',
          interval_unit: 'monthly',
          interval: 1,
          count: pay.installmentsCount,
          start_date: startDate,
          name: description,
          links: { mandate: pay.gcMandateId }
        }
      });
      gcId = subResp.subscriptions.id;
      gcType = 'subscription';
      update = {
        gcSubscriptionId: gcId,
        status: 'active',
        paidCount: 0,
        startDate,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
    } else {
      // Paiement unique
      const payResp = await gcRequest('POST', '/payments', {
        payments: {
          amount: Math.round(pay.totalAmount * 100),
          currency: 'EUR',
          description,
          links: { mandate: pay.gcMandateId }
        }
      });
      gcId = payResp.payments.id;
      gcType = 'payment';
      update = {
        gcPaymentId: gcId,
        status: 'active',
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      };
    }

    await db.collection('payments').doc(paymentId).update(update);
    res.json({ gcId, gcType });

  } catch (e) {
    console.error('[gocardless-payment]', e.message);
    res.status(500).json({ error: e.message });
  }
};
