// api/ringover-debug.js — TEMPORAIRE diagnostic v4
const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

async function t(label, url, method, body, headers) {
  const opts = { method, headers: { 'Content-Type': 'application/json', ...headers } };
  if (body) opts.body = JSON.stringify(body);
  const r = await fetch(url, opts);
  const text = await r.text();
  return { label, status: r.status, body: text.substring(0, 300) };
}

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const snap  = await db.collection('_config').doc('telco_credentials').get();
  const creds = snap.data()?.ringover || {};
  const k     = creds.apiKey;
  const uid   = 22855712;
  const from  = creds.fromNumber;
  const to    = req.query.to || '+33688121402';
  const B     = 'https://public-api.ringover.com/v2';
  const h     = { 'Authorization': k };
  const body  = { to_number: to, from_number: from, user_id: uid };

  const tests = await Promise.all([
    // Patterns user-based
    t('POST_user_calls',      `${B}/users/${uid}/calls`,      'POST', body, h),
    t('POST_user_callback',   `${B}/users/${uid}/callback`,   'POST', body, h),
    t('POST_user_call',       `${B}/users/${uid}/call`,       'POST', body, h),
    t('POST_user_dial',       `${B}/users/${uid}/dial`,       'POST', body, h),
    // Patterns directs
    t('POST_dial',            `${B}/dial`,                    'POST', body, h),
    t('POST_direct',          `${B}/direct`,                  'POST', body, h),
    t('POST_click_to_call',   `${B}/click_to_call`,           'POST', body, h),
    t('POST_click2call',      `${B}/click2call`,              'POST', body, h),
    t('POST_calls_initiate',  `${B}/calls/initiate`,          'POST', body, h),
    // GET user detail (pour voir les champs disponibles)
    t('GET_user_detail',      `${B}/users/${uid}`,            'GET',  null, h),
    // Numbers
    t('GET_numbers',          `${B}/numbers`,                 'GET',  null, h),
  ]);

  res.json({ uid, from, to, tests });
};
