// ============================================================================
// api/_twilioClient.js
// ----------------------------------------------------------------------------
// Helper partagé : charge les credentials Twilio depuis _config/telco_credentials
// et instancie un client Twilio réutilisable.
//
// Les credentials sont cachés au niveau module (une seule lecture Firestore
// par cold start Vercel Function).
// ============================================================================

const { db } = require('./_firebaseAdmin');
const twilio = require('twilio');

// Caches niveau module (vidés au cold start)
let _cachedCreds = null;
let _cachedClient = null;

/**
 * Charge les credentials Twilio depuis Firestore.
 * Accepte "twilio" (lowercase) ou "Twilio" (défensif) comme nom de champ.
 */
async function getTwilioCreds() {
  if (_cachedCreds) return _cachedCreds;

  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) {
    throw new Error('_config/telco_credentials document not found');
  }

  const data = snap.data();
  const creds = data.twilio || data.Twilio;
  if (!creds || !creds.accountSid) {
    throw new Error('telco_credentials missing twilio block (accountSid required)');
  }

  _cachedCreds = creds;
  return creds;
}

/**
 * Retourne un client Twilio initialisé (avec cache).
 */
async function getTwilioClient() {
  if (_cachedClient) return _cachedClient;
  const creds = await getTwilioCreds();
  _cachedClient = twilio(creds.accountSid, creds.authToken);
  return _cachedClient;
}

module.exports = {
  getTwilioCreds,
  getTwilioClient,
};
