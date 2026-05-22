// api/_ringoverClient.js
const { db } = require('./_firebaseAdmin');

const RINGOVER_API_BASE = 'https://public-api.ringover.com/v2';
let _cachedCreds = null;

async function getRingoverCreds() {
  if (_cachedCreds) return _cachedCreds;
  const snap = await db.collection('_config').doc('telco_credentials').get();
  if (!snap.exists) throw new Error('_config/telco_credentials introuvable');
  const creds = (snap.data().ringover) || {};
  if (!creds.apiKey) throw new Error('telco_credentials missing ringover.apiKey');
  _cachedCreds = creds;
  return creds;
}

async function ringoverFetch(path, { method = 'GET', body = null } = {}) {
  const creds = await getRingoverCreds();

  // Ringover v2 : essayer Bearer en premier, fallback sans Bearer
  // (les deux formats existent selon les comptes)
  const tryFetch = async (authHeader) => {
    const opts = {
      method,
      headers: { 'Authorization': authHeader, 'Content-Type': 'application/json' },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    return fetch(`${RINGOVER_API_BASE}${path}`, opts);
  };

  let res = await tryFetch(`Bearer ${creds.apiKey}`);

  // Si 401 avec Bearer → réessayer sans
  if (res.status === 401) {
    res = await tryFetch(creds.apiKey);
  }

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
