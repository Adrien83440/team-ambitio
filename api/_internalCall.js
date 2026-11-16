// ============================================================================
// api/_internalCall.js — appeler une route api/* DANS LE MÊME PROCESSUS
// ----------------------------------------------------------------------------
// Pour qu'une tâche planifiée fasse exactement ce que fait un humain depuis
// une page (même code, mêmes garde-fous), sans dupliquer la logique et sans
// jeton Firebase : on construit une requête en mémoire portant
// req._internalAuth (reconnu par _verifyFirebaseAuth.js), on appelle le
// handler, et on récupère sa réponse JSON.
//
//   const appeler = require('./_internalCall');
//   const r = await appeler(require('./coaching-send-replay'), { clientId, sessionNumero, auto: true }, { par: 'coaching-auto-sync' });
//   // r = { status, body }
//
// Identité interne : { internal:true, uid:null, role:'admin', email:<par> }.
// uid null → _ai.js traite l'appel comme une tâche automatique (budget IA
// coupé plus tôt, comme tous les crons).
// ============================================================================

function appelerInterne(handler, body, opts) {
  const o = opts || {};
  const auth = {
    internal: true,
    uid: null,
    role: o.role || 'admin',
    email: o.par || 'tache-automatique',
    userData: { role: o.role || 'admin', internal: true },
  };
  return new Promise(function (resolve, reject) {
    let statusCode = 200;
    let fini = false;
    const headers = {};
    function finir(payload) {
      if (fini) return;
      fini = true;
      resolve({ status: statusCode, body: payload });
    }
    const res = {
      status: function (c) { statusCode = c; return res; },
      setHeader: function (k, v) { headers[String(k).toLowerCase()] = v; return res; },
      getHeader: function (k) { return headers[String(k).toLowerCase()]; },
      json: function (obj) { finir(obj); return res; },
      send: function (x) {
        if (typeof x === 'string') { try { finir(JSON.parse(x)); } catch (_) { finir({ raw: x }); } }
        else finir(x);
        return res;
      },
      end: function (x) {
        if (x == null) { finir(null); return res; }
        return res.send(Buffer.isBuffer(x) ? x.toString('utf8') : x);
      },
    };
    Object.defineProperty(res, 'statusCode', {
      get: function () { return statusCode; },
      set: function (v) { statusCode = v; },
    });
    const req = {
      method: o.method || 'POST',
      headers: { 'content-type': 'application/json' },
      query: o.query || {},
      body: body || {},
      url: o.url || '/internal',
      _internalAuth: auth,
    };
    Promise.resolve()
      .then(function () { return handler(req, res); })
      .then(function () { if (!fini) finir(null); })
      .catch(function (e) { if (!fini) { fini = true; reject(e); } });
  });
}

module.exports = appelerInterne;
