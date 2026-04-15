// ==========================================================================
// api/gocardless-billing-request.js  (v2 — diagnostic 403)
// --------------------------------------------------------------------------
// Crée un customer GoCardless + billing request + flow URL (lien mandat IBAN)
//
// Body : { paymentId, leadName, leadEmail, leadPhone }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { billingRequestId, flowUrl, customerId }
//
// v2 : ajoute le nom de l'étape dans les erreurs + propage le status HTTP
//      réel renvoyé par GoCardless (au lieu de toujours 500). Permet de
//      diagnostiquer 403 (auth/permissions), 401 (token), 422 (payload), etc.
// ==========================================================================

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

class GoCardlessError extends Error {
  constructor(step, status, body) {
    super('GoCardless ' + status + ' on ' + step + ': ' + JSON.stringify(body));
    this.step = step;
    this.status = status;
    this.body = body;
    this.name = 'GoCardlessError';
  }
}

async function gcRequest(stepName, method, path, body) {
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

  let json;
  try { json = await resp.json(); } catch (e) { json = { parseError: true }; }

  if (!resp.ok) {
    console.error('[gocardless-billing-request] ❌ ' + stepName + ' failed', {
      env: GC_ENV,
      status: resp.status,
      path: path,
      response: json,
    });
    throw new GoCardlessError(stepName, resp.status, json);
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

    console.log('[gocardless-billing-request] start', {
      env: GC_ENV,
      paymentId: paymentId,
      leadEmail: leadEmail,
    });

    // 1. Créer le customer GoCardless
    const custResp = await gcRequest('create_customer', 'POST', '/customers', {
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
    const brResp = await gcRequest('create_billing_request', 'POST', '/billing_requests', {
      billing_requests: {
        mandate_request: { currency: 'EUR' },
        links: { customer: customerId }
      }
    });
    const billingRequestId = brResp.billing_requests.id;

    // 3. Créer le flow (lien de redirection)
    const baseUrl = process.env.APP_BASE_URL || 'https://team.alteore.com';
    const flowResp = await gcRequest('create_billing_request_flow', 'POST', '/billing_request_flows', {
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
      updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    });

    console.log('[gocardless-billing-request] ✅ success', { paymentId, customerId, billingRequestId });
    res.json({ billingRequestId, flowUrl, customerId });

  } catch (e) {
    if (e instanceof GoCardlessError) {
      // Renvoie le vrai code HTTP de GoCardless + l'étape précise
      res.status(e.status).json({
        error: 'GoCardless error on step "' + e.step + '"',
        step: e.step,
        gocardlessStatus: e.status,
        gocardlessBody: e.body,
        env: GC_ENV,
      });
      return;
    }
    console.error('[gocardless-billing-request] unhandled', e);
    res.status(500).json({ error: e.message });
  }
};
