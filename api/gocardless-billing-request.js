// ==========================================================================
// api/gocardless-billing-request.js  (v3 — fix 403 "create_customer")
// --------------------------------------------------------------------------
// Crée un billing request + billing request flow (lien mandat IBAN hébergé).
//
// CHANGEMENT CLÉ vs v2 :
//   v2 appelait POST /customers pour créer le customer avant le BR. Support
//   GoCardless (Vlad, ticket 4258993) a confirmé que POST /customers est
//   restreint au niveau compte car nos pages de paiement custom ne sont pas
//   activées → 403 systématique. On laisse donc GoCardless créer lui-même le
//   customer + le compte bancaire + le mandat via la page hébergée. Les
//   infos client sont juste pré-remplies via `prefilled_customer` sur le
//   flow (ça c'est autorisé, c'est juste de la pré-pop UI).
//
// On ajoute aussi `metadata.paymentId` sur le BR → le Cloud Function
// `onWebhookInbox` et la route `/api/gocardless-finalize` pourront retrouver
// notre doc Firestore `payments/{id}` à partir du billing request.
//
// Body : { paymentId, leadName, leadEmail, leadPhone }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { billingRequestId, flowUrl, reused? }
// ==========================================================================

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_ENV = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
const GC_BASE = GC_ENV === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';
// Version API GoCardless. 2015-07-06 est la version de base (celle utilisée
// partout ailleurs dans le repo : gocardless-payment, gocardless-lookup,
// gocardless-status). Elle couvre les billing requests en rétro-compat.
// Ne pas remettre de date "moderne" sans vérifier qu'elle existe dans
// https://developer.gocardless.com/api-reference → sinon HTTP 400
// "Version not found".
const GC_VERSION = '2015-07-06';

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
      'GoCardless-Version': GC_VERSION,
      'Content-Type': 'application/json',
      'Accept': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });

  let json;
  try { json = await resp.json(); } catch (e) { json = { parseError: true }; }

  if (!resp.ok) {
    // Dump explicite en string pour que Vercel n'affiche pas "[Array]"
    // sur les sous-objets (errors détaillés sont cruciaux pour le debug GC).
    console.error('[gocardless-billing-request] ❌ ' + stepName + ' failed',
      'env=' + GC_ENV,
      'status=' + resp.status,
      'path=' + path,
      'response=' + JSON.stringify(json)
    );
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

    // Idempotence : si un BR + flow existent déjà, on les renvoie tels quels
    // plutôt que d'en créer un nouveau (protection contre le double-clic).
    if (pay.gcBillingRequestId && pay.gcBillingRequestFlowUrl) {
      res.json({
        billingRequestId: pay.gcBillingRequestId,
        flowUrl: pay.gcBillingRequestFlowUrl,
        reused: true
      });
      return;
    }

    const nameParts = (leadName || '').trim().split(/\s+/).filter(Boolean);
    const givenName = nameParts[0] || 'Client';
    const familyName = nameParts.slice(1).join(' ') || '-';

    console.log('[gocardless-billing-request] start', {
      env: GC_ENV,
      paymentId,
      leadEmail,
    });

    // ─── 1. Créer le billing request ───
    // Pas de `links.customer` — on laisse GoCardless créer le customer via
    // la page hébergée. `metadata.paymentId` permet aux webhooks GC et à la
    // route finalize de retrouver notre doc payment Firestore.
    const brResp = await gcRequest('create_billing_request', 'POST', '/billing_requests', {
      billing_requests: {
        mandate_request: {
          currency: 'EUR',
          scheme: 'sepa_core'
        },
        metadata: {
          paymentId: paymentId
        }
      }
    });
    const billingRequestId = brResp.billing_requests.id;

    // ─── 2. Créer le flow (URL vers la page hébergée GoCardless) ───
    // `prefilled_customer` pré-remplit les champs pour le client. La page
    // hébergée accepte ce champ sans nécessiter de validation custom pages.
    // Construction conditionnelle : on n'inclut que les champs présents
    // (éviter undefined qui peut être sérialisé différemment selon runtime).
    const prefilled = {
      given_name: givenName,
      family_name: familyName,
      email: leadEmail
    };
    if (leadPhone) prefilled.phone_number = leadPhone;

    const baseUrl = process.env.APP_BASE_URL || 'https://team.alteore.com';
    const flowResp = await gcRequest('create_billing_request_flow', 'POST', '/billing_request_flows', {
      billing_request_flows: {
        redirect_uri: `${baseUrl}/payments.html?mandateDone=1&paymentId=${paymentId}`,
        exit_uri: `${baseUrl}/payments.html?mandateCancelled=1&paymentId=${paymentId}`,
        prefilled_customer: prefilled,
        links: { billing_request: billingRequestId }
      }
    });
    const flowUrl = flowResp.billing_request_flows.authorisation_url;

    // ─── 3. MAJ Firestore ───
    await db.collection('payments').doc(paymentId).update({
      gcBillingRequestId: billingRequestId,
      gcBillingRequestFlowUrl: flowUrl,
      status: 'pending_mandate',
      updatedAt: require('firebase-admin').firestore.FieldValue.serverTimestamp()
    });

    console.log('[gocardless-billing-request] ✅ success', { paymentId, billingRequestId });
    res.json({ billingRequestId, flowUrl });

  } catch (e) {
    if (e instanceof GoCardlessError) {
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
