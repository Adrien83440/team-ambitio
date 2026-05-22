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

  const doFetch = async (authValue) => {
    const opts = {
      method,
      headers: { 'Authorization': authValue, 'Content-Type': 'application/json' },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    const res  = await fetch(`${RINGOVER_API_BASE}${path}`, opts);
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) {}
    return { res, text, data };
  };

  // Essai 1 : sans Bearer (format documenté Ringover v2)
  let { res, text, data } = await doFetch(creds.apiKey);

  // Essai 2 : avec Bearer si 401
  if (res.status === 401) {
    console.warn(`[ringoverClient] 401 sans Bearer, retry avec Bearer. Body: ${text}`);
    ({ res, text, data } = await doFetch(`Bearer ${creds.apiKey}`));
  }

  if (!res.ok) {
    const msg = (data && (data.message || data.error || data.detail)) || text || `Ringover API error ${res.status}`;
    console.error(`[ringoverClient] ${method} ${path} → ${res.status}: ${text}`);
    const err = new Error(msg);
    err.status = res.status;
    err.rawResponse = text;
    throw err;
  }
  return data;
}

module.exports = { getRingoverCreds, ringoverFetch };
