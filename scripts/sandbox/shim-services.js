/* ═══════════════════════════════════════════════════════════════════════
   Bac à sable — les services externes du code serveur, simulés.
   Source de scripts/build-sandbox-server.js. Remplace, pour le code api/*
   empaqueté : firebase-admin (→ sandbox-db.js), Twilio, Gmail, Ringover,
   l'horodatage RFC 3161, l'annuaire des entreprises et l'API GoCardless.
   RÈGLE : rien ne sort. Les SMS et e-mails arrivent dans le téléphone
   simulé (store.host.deliver) ; tout appel réseau non prévu est REFUSÉ.
   ═══════════════════════════════════════════════════════════════════════ */

function __store() { return window.top.__SBX_STORE; }
function __host() { const h = __store().host; if (!h) throw new Error('Bac à sable non initialisé'); return h; }
function __admin() { if (!__store().__admin) __store().__admin = window.SBXDB.admin(); return __store().__admin; }
function __firstUrl(s) { const m = String(s || '').match(/https?:\/\/[^\s<>"')]+/); return m ? m[0] : ''; }
function __id(prefix) { return prefix + Math.random().toString(36).slice(2, 10).toUpperCase() + Date.now().toString(36).slice(-4).toUpperCase(); }

/* ── Messagerie simulée ── */
function __deliver(o) {
  try { __host().deliver(o); } catch (e) { console.warn('[bac à sable] dépôt du message', e && e.message); }
}

const __shim = {};

__shim['firebase-admin'] = new Proxy({}, { get: function (t, k) { return __admin()[k]; } });
__shim['./_firebaseAdmin'] = {
  get admin() { return __admin(); },
  get db() { return __admin().firestore(); },
  storage: null
};

/* Twilio : messages.create dépose le SMS ; le rappel de statut est simulé
   comme api/twilio-sms-status.js l'écrirait (signature_otp/{reqId}). */
__shim['twilio'] = function () {
  return {
    messages: Object.assign(function (sid) { return { fetch: function () { return Promise.resolve({ sid: sid, status: 'delivered' }); } }; }, {
      create: async function (o) {
        const sid = __id('SM');
        __deliver({ channel: 'sms', to: o.to, from: o.from || 'Ambitio', text: o.body || '', url: __firstUrl(o.body) });
        const m = String(o.statusCallback || '').match(/[?&]reqId=([^&]+)/);
        if (m) {
          const reqId = decodeURIComponent(m[1]);
          setTimeout(function () {
            __admin().firestore().collection('signature_otp').doc(reqId).set({ livraison: { sid: sid, statut: 'delivered', echec: false, errorCode: null, explication: '', at: Date.now() } }, { merge: true }).catch(function () {});
          }, 1500);
        }
        return { sid: sid, status: 'queued', to: o.to, from: o.from };
      }
    })
  };
};

/* Gmail (deux helpers historiques) : l'e-mail arrive dans la boîte simulée. */
function __mail(to, subject, text, html, attachments) {
  const body = text || String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;/g, '\'').replace(/&quot;/g, '"').trim();
  (Array.isArray(to) ? to : [to]).forEach(function (dest) {
    __deliver({ channel: 'email', to: dest, from: 'Ambitio <contact@adrienemily.com>', subject: subject || '', text: body, url: __firstUrl(body + ' ' + (html || '')), attachments: (attachments || []).map(function (a) { return a.filename; }) });
  });
}
__shim['./_billing-gmail'] = {
  sendGmailWithAttachment: async function (o) { __mail(o.to, o.subject, o.bodyText, o.bodyHtml, o.attachments); return { messageId: __id('GM'), threadId: __id('TH') }; },
  getValidAccessToken: async function () { return 'bac-a-sable'; },
  encodeRfc2047: function (s) { return s; },
  plainToHtml: function (s) { return String(s || '').replace(/\n/g, '<br>'); }
};
__shim['./_gmailSend'] = {
  sendEmailFromAccount: async function (o) { __mail(o.to, o.subject, o.bodyText, o.bodyHtml, o.attachments); return { ok: true, messageId: __id('GM') }; }
};

/* Ringover (SMS du lien mandat). */
__shim['./_ringoverClient'] = {
  getRingoverCreds: async function () { return { fromNumber: '+33939240397', apiKey: 'bac-a-sable' }; },
  getRingoverCredsForUser: async function () { return { fromNumber: '+33939240397', apiKey: 'bac-a-sable' }; },
  ringoverFetch: async function (path, o) {
    if (path === '/push/sms') {
      const b = (o && o.body) || {};
      __deliver({ channel: 'sms', to: b.to_number, from: b.from_number || 'Ambitio', text: b.content || '', url: __firstUrl(b.content) });
      return { message_id: __id('RO') };
    }
    throw new Error('Ringover ' + path + ' : bloqué par le bac à sable');
  }
};

/* Horodatage RFC 3161 : jamais d'appel à une autorité réelle. Le code
   serveur sait déjà vivre sans sceau (il le note au dossier de preuve). */
__shim['./_tsa'] = {
  timestamp: async function () { throw new Error('Horodatage désactivé dans le bac à sable'); },
  AUTHORITIES: []
};

__shim['pdf-lib'] = window.PDFLib;
__shim['@pdf-lib/fontkit'] = window.fontkit;

/* ═══ GoCardless simulé (API v2015-07-06, sous-ensemble utilisé) ═══════
   État dans la fausse base : _sandbox_gc/{id}. La page de mandat
   (sandbox-gc.html) appelle __SBX_SERVER.gc.complete() quand le client
   valide son IBAN ; les « webhooks » sont rejoués par sandbox-core.js. */
const __gc = {
  col: function () { return __admin().firestore().collection('_sandbox_gc'); },
  put: function (id, d) { return __gc.col().doc(id).set(d, { merge: true }).then(function () { return d; }); },
  get: function (id) { return __gc.col().doc(id).get().then(function (s) { return s.exists ? s.data() : null; }); },
  plusDays: function (n) { const d = new Date(Date.now() + n * 86400000); return d.toISOString().slice(0, 10); },
  handle: async function (method, path, body) {
    let m;
    if (method === 'POST' && path === '/billing_requests') {
      const id = __id('BRQ000');
      const br = { kind: 'billing_request', id: id, status: 'pending', created_at: new Date().toISOString(), metadata: (body.billing_requests || {}).metadata || {}, mandate_request: (body.billing_requests || {}).mandate_request || {}, links: {} };
      await __gc.put(id, br);
      return { status: 201, json: { billing_requests: br } };
    }
    if (method === 'POST' && path === '/billing_request_flows') {
      const id = __id('BRF000'), f = body.billing_request_flows || {};
      const flow = { kind: 'flow', id: id, authorisation_url: 'https://pay.gocardless.com/billing/static/flow?id=' + id, prefilled_customer: f.prefilled_customer || {}, redirect_uri: f.redirect_uri || '', exit_uri: f.exit_uri || '', links: f.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, flow);
      return { status: 201, json: { billing_request_flows: flow } };
    }
    if (method === 'GET' && (m = path.match(/^\/billing_requests\/([A-Za-z0-9]+)$/))) {
      const br = await __gc.get(m[1]);
      return br ? { status: 200, json: { billing_requests: br } } : { status: 404, json: { error: { message: 'Resource not found', code: 404 } } };
    }
    if (method === 'GET' && (m = path.match(/^\/mandates\/([A-Za-z0-9]+)$/))) {
      const md = await __gc.get(m[1]);
      return md ? { status: 200, json: { mandates: md } } : { status: 404, json: { error: { message: 'Resource not found', code: 404 } } };
    }
    if (method === 'POST' && path === '/payments') {
      const p = body.payments || {}, id = __id('PM00');
      const pm = { kind: 'payment', id: id, amount: p.amount, currency: p.currency, description: p.description, status: 'pending_submission', charge_date: __gc.plusDays(3), links: p.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, pm);
      return { status: 201, json: { payments: pm } };
    }
    if (method === 'POST' && path === '/subscriptions') {
      const s = body.subscriptions || {}, id = __id('SB00');
      const sb = { kind: 'subscription', id: id, amount: s.amount, currency: s.currency, interval_unit: s.interval_unit, interval: s.interval, count: s.count, start_date: s.start_date, name: s.name, status: 'active', paid: 0, links: s.links || {}, created_at: new Date().toISOString() };
      await __gc.put(id, sb);
      return { status: 201, json: { subscriptions: sb } };
    }
    return { status: 400, json: { error: { message: 'Endpoint GoCardless non simulé : ' + method + ' ' + path, code: 400 } } };
  },
  /* Le client a validé son IBAN sur la page de mandat. */
  complete: async function (flowId, info) {
    const flow = await __gc.get(flowId);
    if (!flow) throw new Error('Lien GoCardless inconnu');
    const br = await __gc.get(flow.links.billing_request);
    if (!br) throw new Error('Demande GoCardless introuvable');
    if (br.status === 'fulfilled') return br;
    const cu = __id('CU00'), md = __id('MD00');
    await __gc.put(md, { kind: 'mandate', id: md, status: 'pending_submission', scheme: 'sepa_core', next_possible_charge_date: __gc.plusDays(3), created_at: new Date().toISOString(), links: { customer: cu }, iban: info.ibanMasked, holder: info.holder });
    await __gc.put(cu, { kind: 'customer', id: cu, given_name: info.given_name, family_name: info.family_name, email: info.email, company_name: info.company_name || '', address_line1: info.address_line1, postal_code: info.postal_code, city: info.city, country_code: 'FR' });
    br.status = 'fulfilled'; br.links = { customer: cu, mandate_request_mandate: md }; br.fulfilled_at = new Date().toISOString();
    await __gc.put(br.id, br);
    return br;
  }
};

/* ═══ Annuaire des entreprises simulé (format de l'API DINUM) ═════════ */
function __registry(q) {
  const list = (__host().registry && __host().registry(q)) || [];
  return { results: list, total_results: list.length, page: 1, per_page: 10, total_pages: 1 };
}

/* ═══ fetch du « serveur » : rien ne sort, sauf les polices du PDF ═════ */
async function __sbxFetch(url, opts) {
  url = String(url && url.url ? url.url : url);
  opts = opts || {};
  const method = String(opts.method || 'GET').toUpperCase();
  let u;
  try { u = new URL(url, location.origin); } catch (e) { throw new Error('URL invalide : ' + url); }
  function resp(status, json) {
    return new Response(JSON.stringify(json), { status: status, headers: { 'Content-Type': 'application/json' } });
  }
  if (/gocardless\.com$/.test(u.hostname)) {
    const body = opts.body ? JSON.parse(opts.body) : {};
    const r = await __gc.handle(method, u.pathname, body);
    return resp(r.status, r.json);
  }
  if (u.hostname === 'recherche-entreprises.api.gouv.fr') {
    return resp(200, __registry(u.searchParams.get('q') || ''));
  }
  /* Polices du PDF composé (Source Serif 4, Montserrat) : simples
     téléchargements de fichiers publics, sans aucun effet. */
  if (method === 'GET' && (u.hostname === 'cdn.jsdelivr.net' || u.hostname === 'raw.githubusercontent.com' || u.hostname === 'fonts.gstatic.com')) {
    return window.fetch.__sbxNative ? window.fetch.__sbxNative(url, opts) : window.fetch(url, opts);
  }
  throw new Error('Bloqué par le bac à sable : ' + u.hostname + u.pathname);
}
