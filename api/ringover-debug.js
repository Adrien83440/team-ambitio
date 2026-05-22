// api/ringover-debug.js — TEMPORAIRE diagnostic
const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

async function t(label, url, headers) {
  const r = await fetch(url, { headers });
  const body = await r.text();
  return { label, status: r.status, body: body.substring(0, 200) };
}

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const snap   = await db.collection('_config').doc('telco_credentials').get();
  const apiKey = snap.data()?.ringover?.apiKey;
  const BASE1  = 'https://public-api.ringover.com/v2';
  const BASE2  = 'https://public-api.ringover.com';

  const tests = await Promise.all([
    // Formats Authorization
    t('1_plain',         `${BASE1}/users`,            { 'Authorization': apiKey }),
    t('2_bearer',        `${BASE1}/users`,            { 'Authorization': `Bearer ${apiKey}` }),
    t('3_token',         `${BASE1}/users`,            { 'Authorization': `Token ${apiKey}` }),
    t('4_apikey_header', `${BASE1}/users`,            { 'x-api-key': apiKey }),
    // Sans Content-Type (parfois ça change tout)
    t('5_no_ct',         `${BASE1}/users`,            { 'Authorization': apiKey, 'Accept': 'application/json' }),
    // Endpoints alternatifs
    t('6_user_singular', `${BASE1}/user`,             { 'Authorization': apiKey }),
    t('7_me',            `${BASE1}/me`,               { 'Authorization': apiKey }),
    t('8_base_ping',     `${BASE2}/v2/users`,         { 'Authorization': apiKey }),
    // Query param
    t('9_query_param',   `${BASE1}/users?api_key=${apiKey}`, {}),
  ]);

  res.json({ apiKeyLength: apiKey?.length, tests });
};
