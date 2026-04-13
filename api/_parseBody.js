// ============================================================================
// api/_parseBody.js
// ----------------------------------------------------------------------------
// Helper de normalisation du body HTTP pour les Vercel Functions.
//
// Vercel passe `req.body` de façon inconsistante selon le Content-Type, la
// présence d'un bodyParser en amont, et l'état du stream :
//   - objet JSON parsé          (cas nominal Content-Type: application/json)
//   - string brute              (si un middleware a lu le stream avant)
//   - undefined                 (si aucun body)
//   - Buffer                    (rare, selon runtime)
//
// Ce helper garantit qu'on récupère toujours un objet exploitable, ou un
// objet vide en cas d'échec de parsing.
//
// Usage :
//   const parseBody = require('./_parseBody');
//   module.exports = async (req, res) => {
//     const body = parseBody(req);
//     const { phoneNumber } = body;
//     ...
//   };
// ============================================================================

/**
 * Normalise req.body en objet JS exploitable.
 * Ne lance jamais d'exception — retourne {} en cas de body invalide.
 *
 * @param {import('http').IncomingMessage & { body?: any }} req
 * @returns {Object}
 */
function parseBody(req) {
  let body = req && req.body;

  if (body == null) return {};

  // Buffer → string → JSON
  if (Buffer.isBuffer(body)) {
    try {
      body = body.toString('utf8');
    } catch (_) {
      return {};
    }
  }

  // String → JSON
  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return {};
    try {
      body = JSON.parse(trimmed);
    } catch (_) {
      return {};
    }
  }

  // À ce stade on attend un objet plain
  if (typeof body !== 'object' || Array.isArray(body)) return {};

  return body;
}

module.exports = parseBody;
module.exports.parseBody = parseBody;
