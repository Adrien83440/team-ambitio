/* ═══════════════════════════════════════════════════════════════════════
   Bac à sable — le « serveur » : routage des appels /api/* des vraies
   pages vers le VRAI code des endpoints (api/*.js, empaqueté tel quel),
   avec une requête et une réponse façon Vercel.
   Endpoints absents de ROUTES : réponse inerte (FAKE) ou refus explicite.
   Source de scripts/build-sandbox-server.js.
   ═══════════════════════════════════════════════════════════════════════ */

const ROUTES = {
  '/api/sign-session': './api/sign-session.js',
  '/api/signature-otp': './api/signature-otp.js',
  '/api/signature-send-link': './api/signature-send-link.js',
  '/api/signature-completed': './api/signature-completed.js',
  '/api/gocardless-billing-request': './api/gocardless-billing-request.js',
  '/api/gocardless-finalize': './api/gocardless-finalize.js',
  '/api/gocardless-payment': './api/gocardless-payment.js',
  '/api/payments-send-mandate-sms': './api/payments-send-mandate-sms.js',
  '/api/payments-send-mandate-email': './api/payments-send-mandate-email.js'
};

/* Ce qui ne doit JAMAIS s'exécuter, même simulé : l'ouverture d'un accès
   AE Academy, l'envoi de secours hors signature électronique, l'IA. Les
   statistiques et notifications répondent « vide ». */
const FAKE = {
  '/api/academy-grant': function () { return [200, { granted: false, reason: 'disabled_by_template', sandbox: true }]; },
  '/api/academy-courses': function () { return [200, { ok: true, courses: [] }]; },
  '/api/signature-fallback': function () { return [409, { error: 'Envoi de secours désactivé dans le bac à sable.' }]; },
  '/api/payments-unpaid': function () { return [200, { ok: true, kpis: {}, items: [], events: [], note: '' }]; },
  '/api/user-activity': function () { return [200, { ok: true }]; },
  '/api/ai-followup': function () { return [200, { ok: true, items: [] }]; },
  '/api/twilio-sms-status': function () { return [200, {}]; },
  /* Réservation (booking.html) : attribution setting et quota coaching —
     sans effet dans le bac à sable (le RDV est écrit dans la fausse base). */
  '/api/booking-setter-attribution': function () { return [200, { ok: true, sandbox: true }]; },
  '/api/booking-attribution': function () { return [200, { ok: true, sandbox: true }]; },
  '/api/booking-check-coaching-quota': function () { return [200, { allowed: true }]; }
};

async function __handle(path, init) {
  init = init || {};
  const u = new URL(path, location.origin);
  const route = u.pathname.replace(/\/+$/, '');
  const method = String(init.method || 'GET').toUpperCase();
  const hdrs = {};
  const h = init.headers || {};
  if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach(function (v, k) { hdrs[String(k).toLowerCase()] = v; });
  else Object.keys(h).forEach(function (k) { hdrs[k.toLowerCase()] = h[k]; });
  hdrs['user-agent'] = hdrs['user-agent'] || navigator.userAgent;
  hdrs['accept-language'] = hdrs['accept-language'] || navigator.language || 'fr-FR';
  hdrs['host'] = 'team.alteore.com';
  hdrs['x-forwarded-proto'] = 'https';
  hdrs['x-forwarded-for'] = '127.0.0.1';
  hdrs['x-vercel-ip-city'] = encodeURIComponent('Bac à sable');
  hdrs['x-vercel-ip-country'] = 'FR';

  if (FAKE[route]) { const r = FAKE[route](); return { status: r[0], body: JSON.stringify(r[1]) }; }
  if (!ROUTES[route]) return { status: 503, body: JSON.stringify({ error: 'Bloqué par le bac à sable : ' + route }) };

  let body = init.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { /* laissé brut */ } }
  const query = {};
  u.searchParams.forEach(function (v, k) { query[k] = v; });
  const req = { method: method, url: u.pathname + u.search, headers: hdrs, body: body == null ? {} : body, query: query, socket: { remoteAddress: '127.0.0.1' } };

  return new Promise(function (resolve) {
    let status = 200, done = false;
    const outHeaders = {};
    function finish(b) { if (done) return; done = true; resolve({ status: status, body: b == null ? '' : b, headers: outHeaders }); }
    const res = {
      statusCode: 200,
      status: function (c) { status = c; res.statusCode = c; return res; },
      setHeader: function (k, v) { outHeaders[k] = v; return res; },
      getHeader: function (k) { return outHeaders[k]; },
      json: function (o) { finish(JSON.stringify(o)); return res; },
      send: function (b) { finish(typeof b === 'string' ? b : JSON.stringify(b)); return res; },
      end: function (b) { finish(b || ''); return res; },
      writeHead: function (c) { status = c; return res; },
      redirect: function (c, loc) { status = typeof c === 'number' ? c : 302; finish(''); return res; }
    };
    Promise.resolve().then(function () { return __require(ROUTES[route])(req, res); }).then(function () {
      finish('');
    }).catch(function (e) {
      console.error('[bac à sable] ' + route, e);
      if (!done) { status = 500; finish(JSON.stringify({ error: (e && e.message) || 'Erreur serveur (bac à sable)' })); }
    });
  });
}

window.__SBX_SERVER = {
  handle: __handle,
  gc: { complete: __gc.complete, get: __gc.get },
  require: __require
};
