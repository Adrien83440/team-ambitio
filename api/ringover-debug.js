// api/ringover-debug.js — TEMPORAIRE diagnostic
const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

async function t(label, url, method, body, headers) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  return { label, status: r.status, body: text.substring(0, 500) };
}

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const snap   = await db.collection('_config').doc('telco_credentials').get();
  const creds  = snap.data()?.ringover || {};
  const apiKey = creds.apiKey;
  const BASE   = 'https://public-api.ringover.com/v2';
  const h      = { 'Authorization': apiKey };

  const testPhone = req.query.to || '+33600000000'; // numéro test via ?to=+336...

  const tests = await Promise.all([
    // 1. GET /users — liste les users et leurs IDs
    t('GET_users',      `${BASE}/users`,            'GET',  null, h),
    // 2. GET /team — info compte
    t('GET_team',       `${BASE}/team`,             'GET',  null, h),
    // 3. POST /calls avec body callback (original)
    t('POST_calls_cb',  `${BASE}/calls`,            'POST',
      { to_number: testPhone, from_number: creds.fromNumber, user_id: Number(creds.userId) }, h),
    // 4. Variantes de path création d'appel
    t('POST_call_new',  `${BASE}/call`,             'POST',
      { to_number: testPhone, from_number: creds.fromNumber, user_id: Number(creds.userId) }, h),
    t('POST_calls_out', `${BASE}/calls/outbound`,   'POST',
      { to_number: testPhone, from_number: creds.fromNumber, user_id: Number(creds.userId) }, h),
    t('POST_calls_create', `${BASE}/calls/create`,  'POST',
      { to_number: testPhone, from_number: creds.fromNumber, user_id: Number(creds.userId) }, h),
    t('POST_outbound',  `${BASE}/outbound`,         'POST',
      { to_number: testPhone, from_number: creds.fromNumber, user_id: Number(creds.userId) }, h),
    // 5. Avec "number" au lieu de "from_number"
    t('POST_calls_num', `${BASE}/calls`,            'POST',
      { number: testPhone, user_id: Number(creds.userId) }, h),
    // 6. Format alternatif body
    t('POST_calls_alt', `${BASE}/calls`,            'POST',
      { destination: testPhone, user_id: Number(creds.userId), caller: creds.fromNumber }, h),
  ]);

  res.json({ userId: creds.userId, fromNumber: creds.fromNumber, testPhone, tests });
};
