// ==========================================================================
// api/_twilioSignature.js
// --------------------------------------------------------------------------
// Vérifie la signature X-Twilio-Signature d'une requête entrante.
// Twilio signe chaque webhook qu'il envoie avec HMAC-SHA1 de (URL + params)
// en utilisant l'Auth Token du compte. Toute requête non signée ou signée
// avec une mauvaise clé est rejetée avant tout traitement.
//
// IMPORTANT : Vercel termine TLS en amont, donc req.headers.host et
// x-forwarded-proto doivent être utilisés pour reconstruire l'URL exacte
// que Twilio a signée (sinon le HMAC ne matche pas).
//
// Pour Twilio POST (le cas de tous nos webhooks), la signature inclut les
// params du body. Vercel parse automatiquement application/x-www-form-urlencoded
// en objet JS, donc req.body est directement utilisable.
// ==========================================================================

const twilio = require('twilio');

/**
 * Verifies a Twilio webhook signature.
 *
 * @param {import('http').IncomingMessage} req - Vercel request object
 * @param {string} authToken - Twilio Auth Token (from env var)
 * @returns {boolean} true if the signature is valid, false otherwise
 */
function verifyTwilioSignature(req, authToken) {
  if (!authToken) {
    console.error('[twilio-signature] TWILIO_AUTH_TOKEN not configured');
    return false;
  }

  const signature = req.headers['x-twilio-signature'];
  if (!signature) {
    console.warn('[twilio-signature] Missing X-Twilio-Signature header');
    return false;
  }

  // Reconstruct the exact URL Twilio used to compute the signature
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const url = `${proto}://${host}${req.url}`;

  // For POST with form-urlencoded body, validateRequest expects the parsed
  // params object. For GET, it expects an empty object.
  const params = req.method === 'POST' ? (req.body || {}) : {};

  try {
    return twilio.validateRequest(authToken, signature, url, params);
  } catch (err) {
    console.error('[twilio-signature] validateRequest threw:', err);
    return false;
  }
}

/**
 * Convenience helper : rejects the request with 403 if signature is invalid.
 * Returns true if the caller should continue, false if the response was sent.
 */
function requireValidSignature(req, res) {
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  if (!verifyTwilioSignature(req, authToken)) {
    res.status(403).json({ error: 'Invalid or missing Twilio signature' });
    return false;
  }
  return true;
}

module.exports = { verifyTwilioSignature, requireValidSignature };
