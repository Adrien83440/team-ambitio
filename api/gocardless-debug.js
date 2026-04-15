// ==========================================================================
// api/gocardless-debug.js — DIAGNOSTIC TEMPORAIRE
// --------------------------------------------------------------------------
// À SUPPRIMER après debug.
//
// Compare le token chargé par Vercel avec celui qui marche en local,
// et fait un test ping vers GoCardless depuis Vercel.
//
// Auth : admin uniquement.
// Réponse : { tokenPrefix, tokenSuffix, tokenLength, env, pingStatus, pingBody }
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

  // Masque : 8 premiers chars + 4 derniers
  const tokenPrefix = token.substring(0, 8);
  const tokenSuffix = token.substring(Math.max(0, token.length - 4));
  const tokenLength = token.length;
  const hasWhitespace = /\s/.test(token);
  const hasNewline = /[\r\n]/.test(token);

  // Test ping GoCardless
  let pingStatus = null;
  let pingBody = null;
  let pingError = null;
  try {
    const resp = await fetch(`${base}/customers?limit=1`, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'GoCardless-Version': '2015-07-06',
        'Accept': 'application/json',
      },
    });
    pingStatus = resp.status;
    try { pingBody = await resp.json(); } catch (e) { pingBody = { parseError: true }; }
  } catch (e) {
    pingError = e.message;
  }

  res.json({
    env,
    base,
    tokenPrefix,
    tokenSuffix,
    tokenLength,
    hasWhitespace,
    hasNewline,
    pingStatus,
    pingError,
    pingBody,
  });
};
