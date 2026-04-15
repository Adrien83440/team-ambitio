// ==========================================================================
// api/gocardless-debug.js — DIAGNOSTIC v2 (READ + WRITE)
// --------------------------------------------------------------------------
// À SUPPRIMER après debug.
// Auth : admin uniquement.
// ==========================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

module.exports = async (req, res) => {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') {
    res.status(403).json({ error: 'Admin uniquement' });
    return;
  }

  const token = process.env.GOCARDLESS_ACCESS_TOKEN || '';
  const env = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'sandbox' : 'live';
  const base = env === 'sandbox'
    ? 'https://api-sandbox.gocardless.com'
    : 'https://api.gocardless.com';

  async function gc(method, path, body) {
    try {
      const resp = await fetch(`${base}${path}`, {
        method,
        headers: {
          'Authorization': `Bearer ${token}`,
          'GoCardless-Version': '2015-07-06',
          'Content-Type': 'application/json',
          'Accept': 'application/json',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      let json = null;
      try { json = await resp.json(); } catch (e) { json = { parseError: true }; }
      return { status: resp.status, body: json };
    } catch (e) {
      return { status: null, error: e.message };
    }
  }

  // 1. READ test
  const readTest = await gc('GET', '/customers?limit=1');

  // 2. WRITE test avec email random (élimine doublon)
  const randomId = Math.random().toString(36).substring(2, 12);
  const randomEmail = `debug+${randomId}@team-alteore-test.com`;
  const writeTest = await gc('POST', '/customers', {
    customers: {
      given_name: 'Debug',
      family_name: 'Test',
      email: randomEmail,
      country_code: 'FR',
    },
  });

  // 3. WRITE test bare-minimum (sans country_code)
  const randomEmail2 = `debug+${randomId}b@team-alteore-test.com`;
  const writeTestMinimal = await gc('POST', '/customers', {
    customers: {
      email: randomEmail2,
    },
  });

  res.json({
    env,
    base,
    tokenInfo: {
      prefix: token.substring(0, 8),
      suffix: token.substring(Math.max(0, token.length - 4)),
      length: token.length,
    },
    readTest: { status: readTest.status, customerCount: readTest.body && readTest.body.customers ? readTest.body.customers.length : null },
    writeTest: {
      status: writeTest.status,
      attemptedEmail: randomEmail,
      body: writeTest.body,
    },
    writeTestMinimal: {
      status: writeTestMinimal.status,
      attemptedEmail: randomEmail2,
      body: writeTestMinimal.body,
    },
  });
};
