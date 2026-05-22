// api/ringover-debug.js  — TEMPORAIRE, supprimer après diagnostic
// Teste la clé Ringover et retourne la réponse brute

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  try {
    const snap = await db.collection('_config').doc('telco_credentials').get();
    const apiKey = snap.data()?.ringover?.apiKey;

    const results = {};

    // Test 1 : GET /v2/users sans Bearer
    const r1 = await fetch('https://public-api.ringover.com/v2/users', {
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }
    });
    results.test1_noBearer = { status: r1.status, body: await r1.text() };

    // Test 2 : GET /v2/users avec Bearer
    const r2 = await fetch('https://public-api.ringover.com/v2/users', {
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' }
    });
    results.test2_bearer = { status: r2.status, body: await r2.text() };

    // Test 3 : GET sur URL alternative
    const r3 = await fetch('https://public-api.ringover.com/v2/team', {
      headers: { 'Authorization': apiKey, 'Content-Type': 'application/json' }
    });
    results.test3_team = { status: r3.status, body: await r3.text() };

    res.json({ apiKeyLength: apiKey?.length, apiKeyPrefix: apiKey?.substring(0,8), results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
};
