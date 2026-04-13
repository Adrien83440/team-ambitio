// ==========================================================================
// api/gocardless-billing-request.js
// --------------------------------------------------------------------------
// Crée un customer GoCardless + billing request + flow URL (lien mandat IBAN)
//
// Body : { paymentId, leadName, leadEmail, leadPhone }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { billingRequestId, flowUrl, customerId }
// ==========================================================================

const { db } = require('./_firebaseAdmin');
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
  if (!resp.ok) {
    const err = json.error || json;
    throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(err)}`);
  }
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId, leadName, leadEmail, leadPhone } = parseBody(req);

    if (!paymentId || !leadEmail) {
      res.status(400).json({ error: 'paymentId et leadEmail requis' });
      return;
    }

    // Vérifier que le paiement existe et appartient au caller (ou admin)
    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) {
      res.status(404).json({ error: 'Paiement introuvable' });
      return;
    }
    const pay = paySnap.data();
    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (pay.gcMandateId) {
      res.status(400).json({ error: 'Un mandat existe déjà pour ce paiement' });
      return;
    }

    // Parse name
    const nameParts = (leadName || '').trim().split(' ');
    const givenName = nameParts[0] || 'Client';
    const familyName = nameParts.slice(1).join(' ') || '-';

    // 1. Créer le customer GoCardless
    const custResp = await gcRequest('POST', '/customers', {
      customers: {
        given_name: givenName,
        family_name: familyName,
        email: leadEmail,
        phone_number: leadPhone || undefined,
        country_code: 'FR'
      }
    });
    const customerId = custResp.customers.id;

    // 2. Créer le billing request
    const brResp = await gcRequest('POST', '/billing_requests', {
      billing_requests: {
        mandate_request: { currency: 'EUR' },
        links: { customer: customerId }
      }
    });
    const billingRequestId = brResp.billing_requests.id;

    // 3. Créer le flow (lien de redirection)
    const baseUrl = process.env.APP_BASE_URL || 'https://team.alteore.com';
    const flowResp = await gcRequest('POST', '/billing_request_flows', {
      billing_request_flows: {
        redirect_uri: `${baseUrl}/payments.html?mandateDone=1&paymentId=${paymentId}`,
        exit_uri: `${baseUrl}/payments.html?mandateCancelled=1&paymentId=${paymentId}`,
        prefilled_customer: {
          given_name: givenName,
          family_name: familyName,
          email: leadEmail,
          phone_number: leadPhone || undefined
        },
        links: { billing_request: billingRequestId }
      }
    });
    const flowUrl = flowResp.billing_request_flows.authorisation_url;

    // 4. Mettre à jour le document paiement
    await db.collection('payments').doc(paymentId).update({
      gcCustomerId: customerId,
      gcBillingRequestId: billingRequestId,
      gcBillingRequestFlowUrl: flowUrl,
      status: 'pending_mandate',
      updatedAt: db.constructor.name ? require('firebase-admin').firestore.FieldValue.serverTimestamp() : new Date()
    });

    res.json({ billingRequestId, flowUrl, customerId });

  } catch (e) {
    console.error('[gocardless-billing-request]', e.message);
    res.status(500).json({ error: e.message });
  }
};
