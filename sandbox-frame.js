/* ═══════════════════════════════════════════════════════════════════════
   sandbox-frame.js — BAC À SABLE : fait tourner une VRAIE page, isolée
   ─────────────────────────────────────────────────────────────────────────
   sandbox-frame.html?page=sales-signatures.html&embed=1&leadId=…
   1. pose un PARE-FEU sur la fenêtre : fetch, XMLHttpRequest, sendBeacon,
      WebSocket, EventSource, window.open, liens et navigations. Les appels
      /api/* partent vers le faux serveur (window.top.__SBX_SERVER, le vrai
      code api/* empaqueté). Seuls les fichiers statiques et les CDN de
      polices / pdf.js passent ; tout le reste est refusé ;
   2. remplace Firebase par la fausse base (sandbox-db.js) ;
   3. charge le code source de la vraie page, retire ses balises Firebase et
      nav.js, et l'écrit dans cette fenêtre. L'URL reste celle-ci : les
      paramètres (?t=, ?embed=1, ?leadId=) sont lus par la page comme en vrai.
   Aucune copie d'écran : quand la vraie page change, le bac à sable suit.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Pages que le bac à sable sait faire tourner. Toute autre page est
     bloquée : elle chargerait le VRAI Firebase. */
  var MIRRORED = { 'sign.html': 1, 'sales-signatures.html': 1, 'payments.html': 1, 'booking.html': 1 };
  var STATIC_HOSTS = { 'cdnjs.cloudflare.com': 1, 'fonts.googleapis.com': 1, 'fonts.gstatic.com': 1, 'cdn.jsdelivr.net': 1, 'unpkg.com': 1 };

  var params = new URLSearchParams(location.search);
  var page = params.get('page') || '';

  function fail(msg) {
    document.open();
    document.write('<!doctype html><meta charset="utf-8"><body style="font-family:system-ui,sans-serif;background:#0b0b14;color:#fde68a;padding:40px;text-align:center;line-height:1.6">🧪 ' + msg + '</body>');
    document.close();
  }
  var top_ = null;
  try { top_ = window.top; if (!top_.__SBX_STORE || !top_.__SBX_SERVER) top_ = null; } catch (e) { top_ = null; }
  if (!top_) { fail('Cette page du bac à sable s\'ouvre uniquement depuis <b>Outils → Bac à sable closer</b>.'); return; }
  if (!MIRRORED[page]) { fail('Page non disponible dans le bac à sable.'); return; }

  function warn(msg) {
    try { if (top_.SBX && top_.SBX.toast) { top_.SBX.toast('🧱 ' + msg); return; } } catch (e) {}
    if (window.console) console.warn('[bac à sable] ' + msg);
  }

  /* ═══ 1. PARE-FEU ════════════════════════════════════════════════════ */
  function classify(url) {
    var u;
    try { u = new URL(String(url), location.href); } catch (e) { return { kind: 'block', u: null }; }
    if (u.protocol === 'blob:' || u.protocol === 'data:') return { kind: 'native', u: u };
    if (u.origin === location.origin) {
      if (u.pathname.indexOf('/api/') === 0) return { kind: 'api', u: u };
      return { kind: 'static', u: u };
    }
    if (STATIC_HOSTS[u.hostname]) return { kind: 'cdn', u: u };
    return { kind: 'block', u: u };
  }

  var nativeFetch = window.fetch.bind(window);
  function sbxFetch(input, init) {
    init = init || {};
    var url = typeof input === 'string' ? input : (input && input.url) || String(input);
    var method = String(init.method || (input && input.method) || 'GET').toUpperCase();
    var c = classify(url);
    if (c.kind === 'api') {
      return top_.__SBX_SERVER.handle(c.u.pathname + c.u.search, { method: method, headers: init.headers || {}, body: init.body }).then(function (r) {
        return new Response(r.body, { status: r.status, headers: { 'Content-Type': 'application/json' } });
      });
    }
    if (c.kind === 'native') return nativeFetch(input, init);
    if ((c.kind === 'static' || c.kind === 'cdn') && method === 'GET') return nativeFetch(input, init);
    warn('Appel réseau bloqué : ' + (c.u ? c.u.hostname + c.u.pathname : url));
    return Promise.reject(new TypeError('Bloqué par le bac à sable'));
  }
  sbxFetch.__sbxNative = nativeFetch;
  window.fetch = sbxFetch;

  var NativeXHR = window.XMLHttpRequest;
  function SbxXHR() {
    var x = new NativeXHR(), allowed = true;
    var origOpen = x.open, origSend = x.send;
    x.open = function (method, url) {
      var c = classify(url);
      allowed = (c.kind === 'static' || c.kind === 'cdn' || c.kind === 'native') && String(method).toUpperCase() === 'GET';
      if (!allowed) warn('Requête bloquée : ' + url);
      return origOpen.apply(x, arguments);
    };
    x.send = function () { if (!allowed) throw new Error('Bloqué par le bac à sable'); return origSend.apply(x, arguments); };
    return x;
  }
  window.XMLHttpRequest = SbxXHR;

  if (navigator.sendBeacon) {
    navigator.sendBeacon = function (url, data) {
      var c = classify(url);
      if (c.kind === 'api') { sbxFetch(url, { method: 'POST', body: typeof data === 'string' ? data : '' }).catch(function () {}); return true; }
      return false;
    };
  }
  window.WebSocket = function () { throw new Error('WebSocket bloqué par le bac à sable'); };
  window.EventSource = function () { throw new Error('EventSource bloqué par le bac à sable'); };

  /* Une page du logiciel → sa version bac à sable ; le reste est bloqué. */
  function mirrorUrl(url) {
    var c = classify(url);
    if (c.kind === 'native') return url;
    if (c.kind === 'static') {
      var name = c.u.pathname.replace(/^\//, '');
      if (MIRRORED[name]) { var q = new URLSearchParams(c.u.search); q.set('page', name); return 'sandbox-frame.html?' + q.toString() + c.u.hash; }
      if (/^sandbox-/.test(name)) return url;
    }
    return null;
  }
  var nativeOpen = window.open;
  window.open = function (url, target, feat) {
    if (!url) return nativeOpen.call(window, url, target, feat);
    var m = mirrorUrl(url);
    if (!m) { warn('Ouverture bloquée : ' + url); return null; }
    return nativeOpen.call(window, m, target, feat);
  };
  /* Écouteurs posés APRÈS document.open() (qui efface ceux d'avant) :
     appelé par un script injecté en tête de la vraie page. */
  window.__sbxArm = function () {
  document.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var href = a.getAttribute('href');
    if (!href || href.charAt(0) === '#' || /^javascript:/i.test(href) || a.hasAttribute('download')) return;
    var m = mirrorUrl(a.href);
    if (!m) { e.preventDefault(); e.stopPropagation(); warn('Lien bloqué dans le bac à sable : ' + href); return; }
    if (m !== a.href && m !== href) { e.preventDefault(); if (a.target === '_blank') nativeOpen.call(window, m, '_blank'); else location.href = m; }
  }, true);
  document.addEventListener('submit', function (e) { e.preventDefault(); warn('Envoi de formulaire bloqué.'); }, true);
  window.addEventListener('pagehide', function () { try { top_.__SBX_STORE.dropWindow(window); } catch (e) {} });
  };
  /* Navigations par script (location.href = …) : API Navigation quand le
     navigateur la fournit ; sinon la fenêtre principale vide le cadre s'il
     atterrit sur une page non autorisée (sandbox-closer.js). */
  if (window.navigation && window.navigation.addEventListener) {
    window.navigation.addEventListener('navigate', function (e) {
      if (e.hashChange || e.downloadRequest) return;
      var dest = e.destination && e.destination.url;
      if (!dest || dest === location.href) return;
      var m = mirrorUrl(dest);
      if (m === dest) return;
      if (e.cancelable) e.preventDefault();
      if (m) setTimeout(function () { location.href = m; }, 0);
      else warn('Navigation bloquée : ' + dest);
    });
  }

  /* ═══ 2. FIREBASE → fausse base ══════════════════════════════════════ */
  window.firebase = window.SBXDB.compat(window);
  /* Ce que nav.js fournit d'habitude (retiré : il parle au vrai Firestore). */
  var I = top_.__SBX_STORE.identity;
  window._currentRole = I.role; window._currentUserName = I.name; window._currentUserEmail = I.email;
  var members = (top_.__SBX_STORE.read('_meta/team_members') || {}).members || [];
  window.TEAM_MEMBERS = {}; members.forEach(function (m) { window.TEAM_MEMBERS[m.slug] = m; });
  window.TEAM_MEMBERS_LIST = members; window.TEAM_MEMBERS_ACTIVE = members.filter(function (m) { return m.active !== false; });

  /* ═══ 3. LA VRAIE PAGE ═══════════════════════════════════════════════ */
  nativeFetch(page + '?sbx=' + Date.now(), { cache: 'no-store' }).then(function (r) {
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.text();
  }).then(function (html) {
    var removed = 0;
    html = html.replace(/<script[^>]*src=["'][^"']*firebasejs[^"']*["'][^>]*>\s*<\/script>/gi, function () { removed++; return ''; });
    html = html.replace(/<script[^>]*src=["']\/?nav\.js[^"']*["'][^>]*>\s*<\/script>/gi, '');
    /* Garde-fou : si une balise Firebase subsistait sous une autre forme,
       on ne charge pas la page. */
    if (/gstatic\.com\/firebasejs/i.test(html)) { fail('Page non chargée : une référence à Firebase n\'a pas pu être neutralisée.'); return; }
    var stamp = '<script>window.__SBX_FRAME_PAGE=' + JSON.stringify(page) + ';window.__sbxArm();</script>';
    html = html.replace(/<head([^>]*)>/i, '<head$1>' + stamp);
    document.open();
    document.write(html);
    document.close();
  }).catch(function (e) { fail('Impossible de charger ' + page + ' : ' + (e && e.message)); });
})();
