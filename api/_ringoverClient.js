// ============================================================================
// api/_ringoverClient.js
// ----------------------------------------------------------------------------
// Helper partagé : charge les credentials Ringover depuis _config/telco_credentials
// et expose un wrapper fetch pour l'API Ringover v2.
//
// Credentials attendus dans Firestore _config/telco_credentials.ringover :
//   apiKey      : "d26c4b9ef8246a2b81494c4691067b3b2e107ec6"
//   fromNumber  : "+33755546371"
//   userId      : 22855712  (integer — ID Ringover d'Élodie)
// ============================================================================

const { db } = require('./_firebaseAdmin');

const RINGOVER_API_BASE = 'https://public-api.ringover.com/v2';

let _cachedCreds = null;

async function getRingoverCreds() {
  if (_cachedCreds) return _cachedCreds;
  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) throw new Error('_config/telco_credentials introuvable');
  const data = snap.data();
  const creds = data.ringover || data.Ringover;
  if (!creds || !creds.apiKey) throw new Error('telco_credentials missing ringover.apiKey');
  _cachedCreds = creds;
  return creds;
}

async function ringoverFetch(path, { method = 'GET', body = null } = {}) {
  const creds = await getRingoverCreds();
  const opts = {
    method,
    headers: {
      'Authorization': creds.apiKey,
      'Content-Type': 'application/json',
    },
  };
  if (body !== null) opts.body = JSON.stringify(body);

  const res = await fetch(`${RINGOVER_API_BASE}${path}`, opts);
  let data = null;
  try { data = await res.json(); } catch (_) {}

  if (!res.ok) {
    const msg = (data && (data.message || data.error)) || `Ringover API error ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    err.ringoverData = data;
    throw err;
  }
  return data;
}

module.exports = { getRingoverCreds, ringoverFetch };
