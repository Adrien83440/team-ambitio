/* ═══════════════════════════════════════════════════════════════════════
   sandbox-tunnel-frame.js — LABO TUNNELS : fait tourner une VRAIE page de
   tunnel, sans que rien ne parte (16/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   sandbox-tunnel-frame.html?p=<chemin>&v=<variante>&…  (dans le Labo,
   sandbox-tunnels.html, jamais seul)

   1. PARE-FEU sur la fenêtre, posé avant tout code de la page :
        · fetch / XMLHttpRequest / sendBeacon : l'opt-in du tunnel
          (/api/tunnel-optin), le webhook Make du quiz, tout /api/* et tout
          envoi (POST) sont SIMULÉS — la page reçoit une réponse « ok » et
          continue son parcours ; le Labo note dans son journal ce qui serait
          parti. Une lecture (GET) n'est permise que vers les vidéos (Wistia,
          Vimeo, YouTube), les polices et les images ; les mesures d'audience
          (Meta, Google, statistiques Wistia…) sont coupées ;
        · pixel Meta : faux `fbq` (le vrai script n'est jamais chargé) ;
        · formulaires : aucun envoi natif (form.submit(), action=…) ;
        · cadres : booking.html et AlteoForms tournent dans leur version
          isolée (sandbox-frame.html, fausse base) ; tout autre cadre du
          logiciel est refusé ;
        · navigation : les pages du tunnel restent dans le Labo, les liens
          externes, WhatsApp, mailto, tel sont bloqués et notés ;
        · politique de sécurité du navigateur (CSP, ci-dessous et dans le
          .html) : filet de dernier recours si un code contournait le JS.
   2. La page est celle de l'aperçu /t/<chemin> (brouillons visibles, sans
      mesure ni pixel), lue par le Labo, réécrite (adresses du tunnel et du
      logiciel vers leurs miroirs) puis écrite dans ce cadre. Aucune copie :
      quand la vraie page change, le test suit.
   ES5 strict (Safari ancien).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var CSP = "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://fast.wistia.com https://fast.wistia.net https://*.wistia.com https://*.wistia.net https://player.vimeo.com https://www.youtube.com https://s.ytimg.com https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://d1yei2z3i6k35z.cloudfront.net; style-src 'self' 'unsafe-inline' https:; font-src https: data:; img-src https: data: blob:; media-src https: data: blob:; connect-src https://*.wistia.com https://*.wistia.net https://*.vimeo.com https://*.vimeocdn.com https://fonts.googleapis.com https://fonts.gstatic.com https://firebasestorage.googleapis.com https://d1yei2z3i6k35z.cloudfront.net data: blob:; frame-src 'self' https://player.vimeo.com https://www.youtube.com https://www.youtube-nocookie.com https://fast.wistia.net https://fast.wistia.com https://*.wistia.com https://*.wistia.net; worker-src blob:; form-action 'none'; base-uri 'none'; object-src 'none'";

  function fail(msg) {
    document.open();
    document.write('<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><body style="font-family:system-ui,sans-serif;background:#0b0b14;color:#fde68a;padding:40px 20px;text-align:center;line-height:1.6">🧪 ' + msg + '</body>');
    document.close();
  }
  var top_ = null;
  try { top_ = window.top; if (top_ === window.self || !top_.__SBX_LABO || !top_.SBX_TN) top_ = null; } catch (e) { top_ = null; }
  if (!top_) { fail('Cette page s\'ouvre uniquement dans le <b>Labo Tunnels</b> (lien 🧪 de test).'); return; }
  var TN = top_.SBX_TN;

  var ORIGIN = location.origin;
  var SENT = '/__sbx_tn';                // préfixe des adresses du tunnel réécrites
  var FRAME = '/sandbox-tunnel-frame.html';
  var MIRROR = '/sandbox-frame.html';

  var VIDEO_HOST = /(^|\.)(wistia\.com|wistia\.net|vimeo\.com|vimeocdn\.com|youtube\.com|youtube-nocookie\.com|ytimg\.com|googlevideo\.com)$/i;
  var STATIC_HOST = /^(fonts\.googleapis\.com|fonts\.gstatic\.com|firebasestorage\.googleapis\.com|lh3\.googleusercontent\.com|d1yei2z3i6k35z\.cloudfront\.net|cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)$/i;
  var STATS_HOST = /(^|\.)(pipedream\.wistia\.com|distillery\.wistia\.com|google-analytics\.com|analytics\.google\.com|googletagmanager\.com|doubleclick\.net|facebook\.com|facebook\.net|tiktok\.com|clarity\.ms|hotjar\.com|sentry-cdn\.com|sentry\.io)$/i;
  var MAKE_HOST = /(^|\.)(make\.com|integromat\.com)$/i;
  var TUNNEL_HOST = /^(www\.)?adrienemily\.com$/i;
  var TEAM_HOST = /^team\.alteore\.com$/i;
  var BLANK_GIF = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  var params = new URLSearchParams(location.search);
  var P = String(params.get('p') || '');
  params.delete('p');
  /* Adresse réécrite avec sa propre requête (…?p=merci?x=1) : on la sépare. */
  var qi = P.indexOf('?');
  if (qi >= 0) { var extra = P.slice(qi + 1); P = P.slice(0, qi); new URLSearchParams(extra).forEach(function (v, k) { if (!params.has(k)) params.append(k, v); }); }
  P = P.replace(/^\/+|\/+$/g, '').replace(/^t\//, '');
  var QS = params.toString();

  /* ═══ Adresses ═══════════════════════════════════════════════════════ */
  function parse(url) { try { return new URL(String(url), location.href); } catch (e) { return null; } }
  function isTeam(u) { return u.origin === ORIGIN || TEAM_HOST.test(u.hostname); }
  function stripQ(search, drop) {
    var q = new URLSearchParams(search || '');
    (drop || []).forEach(function (k) { q.delete(k); });
    return q.toString();
  }
  /* Chemin de tunnel désigné par une adresse, ou null. */
  function tunnelPathOf(u) {
    if (TUNNEL_HOST.test(u.hostname)) return u.pathname;
    if (!isTeam(u)) return null;
    var p = u.pathname;
    if (p === FRAME) return u.searchParams.get('p') || '';
    if (p === SENT || p.indexOf(SENT + '/') === 0) return p.slice(SENT.length);
    if (p.indexOf('/t/') === 0) return p.slice(3);
    /* Lien relatif d'une page de tunnel (« /merci », « / ») : un seul
       segment, sans extension — jamais un fichier du logiciel. */
    if (/^\/[A-Za-z0-9_-]*\/?$/.test(p)) return p;
    return null;
  }
  function frameTarget(path, search, hash) {
    var p = String(path || '').replace(/^\/+|\/+$/g, '');
    var q = stripQ(search, ['p']);
    return FRAME + '?p=' + encodeURIComponent(p) + (q ? '&' + q : '') + (hash || '');
  }
  /* Page du logiciel jouée en miroir (fausse base), ou null. */
  function mirrorOf(u) {
    if (!isTeam(u)) return null;
    var p = u.pathname, q = stripQ(u.search, ['page']);
    if (p === MIRROR) return MIRROR + u.search + u.hash;
    if (p === '/booking.html' || p === '/alteoforms-render.html') return MIRROR + '?page=' + p.slice(1) + (q ? '&' + q : '') + u.hash;
    var m = /^\/f\/([A-Za-z0-9_-]{1,60})\/?$/.exec(p);
    if (m) return MIRROR + '?page=alteoforms-render.html&slug=' + m[1] + (q ? '&' + q : '') + u.hash;
    return null;
  }
  function sameDoc(u) {
    return u.origin === location.origin && u.pathname === location.pathname && u.search === location.search && !!u.hash;
  }
  /* Navigation (lien, location, window.open) → { kind: same|go|top|block, url, why } */
  function mapNav(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || s.charAt(0) === '#' || /^javascript:/i.test(s)) return { kind: 'same' };
    var u = parse(s);
    if (!u) return { kind: 'block', why: 'Adresse invalide', url: s };
    if (/^(mailto|tel|sms|whatsapp):$/i.test(u.protocol)) return { kind: 'block', why: 'Lien ' + u.protocol.replace(':', ''), url: s };
    if (u.protocol === 'blob:' || u.protocol === 'data:' || u.protocol === 'about:') return { kind: 'same' };
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { kind: 'block', why: 'Lien ' + u.protocol, url: s };
    if (sameDoc(u)) return { kind: 'same' };
    if (isTeam(u) && u.pathname === '/sandbox-tunnels.html') return { kind: 'top', url: u.pathname + u.search + u.hash };
    var tp = tunnelPathOf(u);
    if (tp != null) return { kind: 'go', url: frameTarget(tp, u.search, u.hash) };
    var mr = mirrorOf(u);
    if (mr) return { kind: 'go', url: mr };
    if (/(^|\.)(wa\.me|whatsapp\.com)$/i.test(u.hostname)) return { kind: 'block', why: 'WhatsApp', url: s };
    if (isTeam(u)) return { kind: 'block', why: 'Page du logiciel', url: s };
    return { kind: 'block', why: 'Site externe', url: s };
  }
  /* Source d'un cadre (iframe) → adresse autorisée. */
  function mapFrameSrc(raw) {
    var s = String(raw == null ? '' : raw).trim();
    if (!s || /^about:/i.test(s) || /^javascript:/i.test(s)) return s;
    var u = parse(s);
    if (!u) return 'about:blank';
    if (u.protocol === 'data:' || u.protocol === 'blob:') return s;
    if (isTeam(u) && (u.pathname === FRAME || u.pathname === MIRROR)) return s;
    var mr = mirrorOf(u);
    if (mr) return mr;
    var tp = tunnelPathOf(u);
    if (tp != null) return frameTarget(tp, u.search, u.hash);
    if (VIDEO_HOST.test(u.hostname)) return s;
    TN.log('block', 'Cadre bloqué', [['Adresse', s.slice(0, 200)]]);
    return 'about:blank';
  }
  function mapImg(raw) {
    var u = parse(raw);
    if (!u || (u.protocol !== 'https:' && u.protocol !== 'http:')) return raw;
    var r = route(raw, 'GET');
    if (r.k === 'stats' || r.k === 'sim') { blocked(r, 'GET'); return BLANK_GIF; }
    return raw;
  }

  /* ═══ 1. PARE-FEU ════════════════════════════════════════════════════ */
  function route(url, method) {
    var u = parse(url);
    if (!u) return { k: 'block', u: null, raw: url };
    if (u.protocol === 'data:' || u.protocol === 'blob:') return { k: 'native', u: u };
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return { k: 'block', u: u };
    var m = String(method || 'GET').toUpperCase(), read = m === 'GET' || m === 'HEAD';
    if (isTeam(u)) {
      if (u.pathname.indexOf('/api/') === 0) return { k: 'sim', u: u };
      return read ? { k: 'native', u: u } : { k: 'sim', u: u };
    }
    if (MAKE_HOST.test(u.hostname)) return { k: 'sim', u: u };
    if (STATS_HOST.test(u.hostname)) return { k: 'stats', u: u };
    if (read && (VIDEO_HOST.test(u.hostname) || STATIC_HOST.test(u.hostname))) return { k: 'native', u: u };
    return read ? { k: 'block', u: u } : { k: 'sim', u: u };
  }
  function blocked(r, method) {
    var where = r.u ? r.u.hostname + r.u.pathname : String(r.raw || '');
    if (r.k === 'stats') TN.log('stats', 'Mesure d\'audience coupée', [['Service', r.u ? r.u.hostname : where]], { dedupe: 'stats:' + (r.u ? r.u.hostname : where) });
    else TN.log('block', 'Appel réseau bloqué', [['Adresse', where.slice(0, 200)], ['Méthode', method || 'GET']], { dedupe: 'block:' + where });
  }
  /* Corps d'un envoi → objet lisible (journal). */
  function textToData(t) {
    t = String(t == null ? '' : t);
    if (!t) return null;
    try { return JSON.parse(t); } catch (e) {}
    if (t.indexOf('=') > 0 && !/\s/.test(t.slice(0, 40))) {
      var o = {};
      try { new URLSearchParams(t).forEach(function (v, k) { o[k] = v; }); return o; } catch (e2) {}
    }
    return { contenu: t.slice(0, 500) };
  }
  function readBody(body) {
    try {
      if (body == null) return Promise.resolve(null);
      if (typeof body === 'string') return Promise.resolve(textToData(body));
      if (window.URLSearchParams && body instanceof URLSearchParams) return Promise.resolve(textToData(body.toString()));
      if (window.FormData && body instanceof FormData) {
        var o = {};
        if (body.forEach) body.forEach(function (v, k) { o[k] = typeof v === 'string' ? v : '[fichier]'; });
        return Promise.resolve(o);
      }
      if (window.Blob && body instanceof Blob) {
        if (body.text) return body.text().then(textToData, function () { return null; });
        return new Promise(function (ok) {
          var fr = new FileReader();
          fr.onload = function () { ok(textToData(fr.result)); };
          fr.onerror = function () { ok(null); };
          fr.readAsText(body);
        });
      }
    } catch (e) {}
    return Promise.resolve(null);
  }
  function simulate(u, method, body) {
    return readBody(body).then(function (data) {
      return TN.simulate({ href: u.href, host: u.hostname, path: u.pathname, team: isTeam(u), method: method, data: data });
    });
  }

  var nativeFetch = window.fetch ? window.fetch.bind(window) : null;
  if (nativeFetch) {
    window.fetch = function (input, init) {
      init = init || {};
      var url = typeof input === 'string' ? input : (input && input.url) || String(input);
      var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
      var r = route(url, method);
      if (r.k === 'native') return nativeFetch(input, init);
      if (r.k === 'sim') {
        return simulate(r.u, method, init.body).then(function (res) {
          return new Response(res.text, { status: res.status, headers: { 'Content-Type': res.type } });
        });
      }
      blocked(r, method);
      return Promise.reject(new TypeError('Bloqué par le Labo Tunnels'));
    };
  }

  var NativeXHR = window.XMLHttpRequest;
  function def(o, k, v) { try { Object.defineProperty(o, k, { value: v, configurable: true, writable: true }); } catch (e) {} }
  function fire(x, type) { try { x.dispatchEvent(new Event(type)); } catch (e) {} }
  function fakeDone(x, status, text, type) {
    def(x, 'readyState', 4); def(x, 'status', status); def(x, 'statusText', status ? 'OK' : '');
    def(x, 'responseText', text); def(x, 'response', text); def(x, 'responseURL', '');
    def(x, 'getResponseHeader', function (h) { return String(h).toLowerCase() === 'content-type' ? type : null; });
    def(x, 'getAllResponseHeaders', function () { return 'content-type: ' + type + '\r\n'; });
    fire(x, 'readystatechange'); fire(x, status ? 'load' : 'error'); fire(x, 'loadend');
  }
  function SbxXHR() {
    var x = new NativeXHR(), st = { r: null, m: 'GET' };
    var open = x.open, send = x.send, setH = x.setRequestHeader;
    x.open = function (method, url) {
      st.m = String(method || 'GET').toUpperCase();
      st.r = route(url, st.m);
      if (st.r.k === 'native') return open.apply(x, arguments);
      def(x, 'readyState', 1);
    };
    x.setRequestHeader = function () { if (st.r && st.r.k === 'native') return setH.apply(x, arguments); };
    x.send = function (body) {
      if (!st.r || st.r.k === 'native') return send.apply(x, arguments);
      if (st.r.k !== 'sim') { blocked(st.r, st.m); setTimeout(function () { fakeDone(x, 0, '', 'text/plain'); }, 0); return; }
      simulate(st.r.u, st.m, body).then(function (res) { fakeDone(x, res.status, res.text, res.type); });
    };
    return x;
  }
  SbxXHR.prototype = NativeXHR.prototype;
  SbxXHR.UNSENT = 0; SbxXHR.OPENED = 1; SbxXHR.HEADERS_RECEIVED = 2; SbxXHR.LOADING = 3; SbxXHR.DONE = 4;
  window.XMLHttpRequest = SbxXHR;

  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      var r = route(url, 'POST');
      if (r.k === 'sim') simulate(r.u, 'POST', data);
      else blocked(r, 'POST');
      return true;
    };
  }
  window.WebSocket = function () { TN.log('block', 'Connexion WebSocket bloquée'); throw new Error('WebSocket bloqué par le Labo Tunnels'); };
  window.EventSource = function () { TN.log('block', 'Flux EventSource bloqué'); throw new Error('EventSource bloqué par le Labo Tunnels'); };

  /* Pixel Meta : faux fbq — le code de base de Meta (« if (f.fbq) return; »)
     ne charge jamais fbevents.js. */
  function fakeFbq() { TN.pixel(Array.prototype.slice.call(arguments), 'page'); }
  fakeFbq.queue = []; fakeFbq.loaded = true; fakeFbq.version = '2.0'; fakeFbq.push = fakeFbq; fakeFbq.callMethod = null;
  window.fbq = window._fbq = fakeFbq;

  /* Formulaires : aucun envoi natif. */
  function formData(form) {
    var o = {};
    try {
      var els = form.elements;
      for (var i = 0; i < els.length; i++) {
        var el = els[i], n = el.name, t = String(el.type || '').toLowerCase();
        if (!n || t === 'submit' || t === 'button' || t === 'file' || t === 'password') continue;
        if ((t === 'checkbox' || t === 'radio') && !el.checked) continue;
        if (el.value) o[n] = String(el.value).slice(0, 300);
      }
    } catch (e) {}
    return o;
  }
  HTMLFormElement.prototype.submit = function () {
    TN.log('form', 'Formulaire envoyé (simulé)', TN.summarize(formData(this)));
  };

  /* Cadres et images : la source passe par le pare-feu. */
  function wrapSetter(proto, prop, mapFn) {
    var d = Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set) return;
    Object.defineProperty(proto, prop, {
      configurable: true, enumerable: d.enumerable, get: d.get,
      set: function (v) { d.set.call(this, mapFn(v)); }
    });
  }
  wrapSetter(HTMLIFrameElement.prototype, 'src', mapFrameSrc);
  wrapSetter(HTMLImageElement.prototype, 'src', mapImg);
  var nativeSetAttr = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    var n = String(name).toLowerCase(), tag = this.tagName;
    if (n === 'src' && tag === 'IFRAME') value = mapFrameSrc(value);
    else if (n === 'src' && tag === 'IMG') value = mapImg(value);
    return nativeSetAttr.call(this, name, value);
  };

  var nativeOpen = window.open;
  window.open = function (url) {
    var m = mapNav(url);
    if (m.kind === 'go' || m.kind === 'top') { TN.openTab(m.url); return null; }
    if (m.kind === 'same') return null;
    TN.log('nav', m.why + ' : ouverture bloquée', [['Adresse', String(m.url).slice(0, 200)]], { toast: true });
    return null;
  };
  void nativeOpen;

  function navTo(m) {
    if (m.kind === 'top') { TN.go(m.url); return; }
    location.href = m.url;
  }

  /* Écouteurs posés APRÈS document.open() (qui efface ceux d'avant) :
     appelé par un script injecté en tête de la page écrite. */
  function onClick(e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || a.hasAttribute('download')) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href)) return;
    /* Même provenance que la vraie page (lp, v, utm, leadId). */
    try { if (window.ALTEO && window.ALTEO.decorate) href = window.ALTEO.decorate(href); } catch (er) {}
    var m = mapNav(href);
    if (m.kind === 'same') return;
    e.preventDefault();
    if (m.kind === 'go' || m.kind === 'top') {
      if (a.target === '_blank') TN.openTab(m.url); else navTo(m);
      return;
    }
    TN.log('nav', m.why + ' : lien non suivi', [['Adresse', String(m.url).slice(0, 200)]], { toast: true });
  }
  function onSubmit(e) {
    var form = e.target;
    if (form && form.hasAttribute && form.hasAttribute('data-alteo-optin')) return;   // le runtime s'en charge
    e.preventDefault();
    TN.log('form', 'Formulaire envoyé (simulé)', TN.summarize(form ? formData(form) : {}));
  }
  function onCsp(e) {
    var u = String(e.blockedURI || '');
    if (!u || u === 'inline' || u === 'eval') return;
    var host = u; try { host = new URL(u).hostname || u; } catch (er) {}
    if (STATS_HOST.test(host)) TN.log('stats', 'Mesure d\'audience coupée', [['Service', host]], { dedupe: 'stats:' + host });
    else TN.log('block', 'Ressource bloquée par la politique du Labo', [['Adresse', u.slice(0, 200)], ['Type', String(e.violatedDirective || e.effectiveDirective || '')]], { dedupe: 'csp:' + host + ':' + e.violatedDirective });
  }
  function onNavigate(e) {
    if (e.hashChange || e.downloadRequest || !e.destination) return;
    var u = parse(e.destination.url);
    if (!u) return;
    if (isTeam(u) && (u.pathname === FRAME || u.pathname === MIRROR)) return;
    var m = mapNav(u.href);
    if (m.kind === 'same') return;
    if (!e.cancelable) return;   // le Labo rattrape la page au chargement du cadre
    e.preventDefault();
    if (m.kind === 'go' || m.kind === 'top') setTimeout(function () { navTo(m); }, 0);
    else TN.log('nav', m.why + ' : navigation bloquée', [['Adresse', String(m.url).slice(0, 200)]], { toast: true });
  }
  function fixFrame(f) {
    var s = f.getAttribute('src');
    if (s == null) return;
    var m = mapFrameSrc(s);
    if (m !== s) nativeSetAttr.call(f, 'src', m);
  }
  function fixFrames(root) {
    if (root.tagName === 'IFRAME') { fixFrame(root); return; }
    var list = root.getElementsByTagName ? root.getElementsByTagName('iframe') : [];
    for (var i = 0; i < list.length; i++) fixFrame(list[i]);
  }
  window.__sbxArm = function () {
    document.addEventListener('click', onClick, true);
    document.addEventListener('submit', onSubmit, true);
    document.addEventListener('securitypolicyviolation', onCsp, true);
    if (window.MutationObserver) {
      try {
        new MutationObserver(function (muts) {
          for (var i = 0; i < muts.length; i++) {
            var add = muts[i].addedNodes;
            for (var j = 0; j < add.length; j++) {
              var n = add[j];
              if (n.nodeType === 1) fixFrames(n);
            }
          }
        }).observe(document.documentElement, { childList: true, subtree: true });
      } catch (e) {}
    }
    if (window.navigation && window.navigation.addEventListener) {
      if (window.__sbxNavFn) { try { window.navigation.removeEventListener('navigate', window.__sbxNavFn); } catch (e) {} }
      window.__sbxNavFn = onNavigate;
      window.navigation.addEventListener('navigate', onNavigate);
    }
    window.__sbxPatch();
  };

  /* Config du runtime (window.ALTEO_TUNNEL), corrigée avant qu'il ne
     démarre : mode aperçu, aucun pixel, étape suivante et booking dans le
     Labo. Rappelée juste après le bloc de config de la page. */
  window.__sbxPatch = function () {
    var C = window.ALTEO_TUNNEL;
    if (C && !C.__sbx) {
      C.__sbx = true;
      C.preview = true; C.sandbox = true; C.pixelId = ''; C.consent = null; C.hosts = [];
      if (C.nextUrl) { var m = mapNav(C.nextUrl); C.nextUrl = (m.kind === 'go') ? m.url : null; }
      if (C.bookingUrl) C.bookingUrl = mapFrameSrc(C.bookingUrl);
    }
    TN.pageInfo({
      p: P, qs: QS,
      tunnel: C ? C.tunnelName : '', step: C ? (C.stepName || C.stepSlug) : '', variant: C ? C.variant : '',
      page: C ? C.page : ''
    });
  };

  /* ═══ 2. LA VRAIE PAGE ═══════════════════════════════════════════════ */
  function rewrite(html) {
    /* Adresses du tunnel → préfixe du Labo (rattrapé par le pare-feu, même
       quand le code les assemble lui-même). */
    html = html.replace(/https?:\/\/(?:www\.)?adrienemily\.com(?![A-Za-z0-9.-])/gi, ORIGIN + SENT);
    /* Pages du logiciel embarquées → leur miroir. */
    html = html.replace(/https:\/\/team\.alteore\.com\/(booking\.html|alteoforms-render\.html)(\?)?/gi, function (m, pg, q) {
      return ORIGIN + MIRROR + '?page=' + pg.toLowerCase() + (q ? '&' : '');
    });
    html = html.replace(/https:\/\/team\.alteore\.com\/f\/([A-Za-z0-9_-]{1,60})(\?)?/gi, function (m, slug, q) {
      return ORIGIN + MIRROR + '?page=alteoforms-render.html&slug=' + slug + (q ? '&' : '');
    });
    var stamp = '<meta http-equiv="Content-Security-Policy" content="' + CSP + '">'
      + '<script>window.__sbxArm&&window.__sbxArm();</script>';
    if (/<head(\s[^>]*)?>/i.test(html)) html = html.replace(/<head(\s[^>]*)?>/i, function (h) { return h + stamp; });
    else html = stamp + html;
    var ci = html.indexOf('window.ALTEO_TUNNEL=');
    if (ci >= 0) {
      var ce = html.indexOf('</script>', ci);
      if (ce >= 0) html = html.slice(0, ce + 9) + '<script>window.__sbxPatch&&window.__sbxPatch();</script>' + html.slice(ce + 9);
    }
    return html;
  }

  TN.fetchPage(P, QS).then(function (r) {
    var html = rewrite(r.html);
    document.open();
    document.write(html);
    document.close();
  }).catch(function (e) { fail('Impossible de charger la page « /' + P + ' » : ' + (e && e.message)); });
})();
