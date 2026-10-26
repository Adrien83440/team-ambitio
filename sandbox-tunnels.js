/* ═══════════════════════════════════════════════════════════════════════
   sandbox-tunnels.js — LABO TUNNELS (16/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Lien de test à envoyer à l'équipe (public, sans connexion) :
     sandbox-tunnels.html?p=<chemin>&v=<variante>   (p= vide : accueil)
     sandbox-tunnels.html                            (admins : tous les liens)

   La VRAIE page du tunnel tourne dans le cadre pare-feu
   (sandbox-tunnel-frame.js) ; booking.html et AlteoForms tournent dans le
   cadre du bac à sable (sandbox-frame.js) sur une fausse base éphémère
   (sandbox-db.js, window.__SBX_EPHEMERAL). Cette fenêtre :
     · fournit la fausse base et le faux serveur (__SBX_STORE /
       __SBX_SERVER) aux cadres ;
     · LIT en réel (get() uniquement, jamais d'écriture) ce que la page de
       réservation et les formulaires ont besoin d'afficher : types de RDV
       et agendas (booking_config), créneaux occupés (calendar_busy, RDV à
       venir), formulaires (alteo_forms) — tous en lecture publique dans les
       règles. Les adresses www.adrienemily.com de ces réglages (redirection
       après RDV vers /merci…) sont réécrites vers le Labo ;
     · tient le journal de « ce qui serait parti en vrai » (opt-in, Make,
       pixel, RDV, formulaire, appels serveur, blocages), gardé le temps de
       l'onglet (sessionStorage) pour survivre à la redirection après RDV.
   Rien ne touche la vraie base : un RDV posé ici ne bloque pas le créneau.
   ES5 strict (Safari ancien).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Le Labo rouvert DANS un de ses cadres (redirection après RDV hors mode
     embed) : c'est la fenêtre principale qui suit. */
  try {
    if (window.top !== window.self && window.top.__SBX_LABO) { window.top.location.href = location.href; return; }
  } catch (e) {}
  if (window.top !== window.self) { document.body.innerHTML = '<p style="padding:30px;text-align:center">🧪 Le Labo Tunnels s\'ouvre dans son propre onglet.</p>'; return; }

  var ST = window.__SBX_STORE;
  if (!ST) { document.body.innerHTML = '<p style="padding:30px;text-align:center">🧪 Base de test indisponible.</p>'; return; }
  window.__SBX_LABO = true;

  var ORIGIN = location.origin;
  var LAB = '/sandbox-tunnels.html';
  var FRAME = '/sandbox-tunnel-frame.html';
  var MIRROR = '/sandbox-frame.html';
  var SS_J = 'sbxtn_journal', SS_START = 'sbxtn_start';
  var $ = function (id) { return document.getElementById(id); };
  var real = firebase.firestore();

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ssGet(k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} }
  function rand(n) { var c = 'abcdefghijklmnopqrstuvwxyz0123456789', s = ''; for (var i = 0; i < (n || 10); i++) s += c.charAt(Math.floor(Math.random() * c.length)); return s; }
  function parisToday() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
    catch (e) { return new Date().toISOString().slice(0, 10); }
  }

  /* ═══ Journal ════════════════════════════════════════════════════════ */
  var ICONS = { optin: '📨', make: '🔗', pixel: '📈', booking: '📅', form: '📝', api: '🛰️', block: '🧱', nav: '🧭', stats: '📊', info: 'ℹ️' };
  var J = [];
  try { J = JSON.parse(ssGet(SS_J) || '[]') || []; } catch (e) { J = []; }
  var dedupe = {};
  J.forEach(function (e) { if (e.d) dedupe[e.d] = 1; });
  var toastTimer = null;
  function toast(msg) {
    var t = $('toast');
    t.textContent = msg;
    t.className = 'on';
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.className = ''; }, 3800);
  }
  function hhmm(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2) + ':' + ('0' + d.getSeconds()).slice(-2); }
  function renderJournal() {
    $('bCount').textContent = String(J.length);
    var el = $('jList');
    if (!J.length) { el.innerHTML = '<div class="empty">Rien pour l\'instant. Remplis un formulaire, réserve un créneau : tout ce qui serait parti s\'affiche ici.</div>'; return; }
    var h = '';
    for (var i = J.length - 1; i >= 0; i--) {
      var e = J[i];
      h += '<div class="je k-' + esc(e.k) + '"><div class="h"><i>' + (ICONS[e.k] || '•') + '</i><b>' + esc(e.t) + '</b><small>' + hhmm(e.at) + '</small></div>';
      if (e.l && e.l.length) {
        h += '<dl>';
        e.l.forEach(function (kv) { h += '<dt>' + esc(kv[0]) + '</dt><dd>' + esc(kv[1]) + '</dd>'; });
        h += '</dl>';
      }
      h += '</div>';
    }
    el.innerHTML = h;
  }
  function log(kind, title, lines, opts) {
    opts = opts || {};
    if (opts.dedupe) { if (dedupe[opts.dedupe]) return; dedupe[opts.dedupe] = 1; }
    var clean = [];
    (lines || []).forEach(function (kv) {
      if (!kv || kv[1] == null || kv[1] === '') return;
      clean.push([String(kv[0]).slice(0, 60), String(kv[1]).slice(0, 400)]);
    });
    J.push({ k: kind, t: String(title || '').slice(0, 200), l: clean, at: Date.now(), d: opts.dedupe || null });
    if (J.length > 250) J = J.slice(J.length - 250);
    ssSet(SS_J, JSON.stringify(J));
    renderJournal();
    if (opts.toast || kind === 'optin' || kind === 'make' || kind === 'booking' || kind === 'form') toast((ICONS[kind] || '') + ' ' + title);
  }

  /* Objet envoyé → lignes lisibles (champs connus d'abord). */
  var KNOWN = ['prenom', 'firstname', 'first_name', 'nom', 'lastname', 'last_name', 'name', 'email', 'telephone', 'phone', 'tel',
               'secteur', 'ca', 'ca_mensuel', 'objectif', 'defi', 'message', 'lp', 'v', 'utm_source', 'utm_campaign'];
  function isQA(a) { return Array.isArray(a) && a.length && a[0] && typeof a[0] === 'object' && 'value' in a[0] && ('label' in a[0] || 'name' in a[0]); }
  function summarize(obj) {
    var out = [];
    if (!obj || typeof obj !== 'object') return out;
    /* Réponses de formulaire [{label, value}] → une ligne par question. */
    if (isQA(obj)) {
      obj.forEach(function (q) { if (q && q.value !== '' && q.value != null) out.push([String(q.label || q.name).slice(0, 60), typeof q.value === 'object' ? JSON.stringify(q.value) : q.value]); });
      return out;
    }
    var flat = {}, qa = null;
    Object.keys(obj).forEach(function (k) {
      var v = obj[k];
      if ((k === 'fields' || k === 'contact' || k === 'prospect') && v && typeof v === 'object' && !Array.isArray(v)) { Object.keys(v).forEach(function (k2) { if (flat[k2] == null || flat[k2] === '') flat[k2] = v[k2]; }); return; }
      if (isQA(v)) { qa = v; return; }
      flat[k] = v;
    });
    function show(v) {
      if (v == null) return '';
      if (typeof v === 'object') { var s = ''; try { s = JSON.stringify(v); } catch (e) { s = '[objet]'; } return s.length > 160 ? s.slice(0, 160) + '…' : s; }
      v = String(v);
      return v.length > 200 ? v.slice(0, 200) + '… (' + v.length + ' caractères)' : v;
    }
    var used = {};
    KNOWN.forEach(function (k) { if (flat[k] != null && flat[k] !== '') { out.push([k, show(flat[k])]); used[k] = 1; } });
    var rest = Object.keys(flat).filter(function (k) { return !used[k] && flat[k] != null && flat[k] !== ''; });
    rest.slice(0, 10).forEach(function (k) { out.push([k, show(flat[k])]); });
    if (rest.length > 10) out.push(['…', (rest.length - 10) + ' autre(s) champ(s)']);
    if (qa) out = out.concat(summarize(qa));
    return out;
  }

  /* ═══ Faux serveur : tout envoi est simulé ici ═══════════════════════ */
  function reply(obj) { return Promise.resolve({ status: 200, text: JSON.stringify(obj), type: 'application/json' }); }
  var API_LABELS = {
    '/api/booking-guard': 'Liste de blocage vérifiée (simulé)',
    '/api/booking-attribution': 'Provenance du RDV posée sur la fiche (simulé)',
    '/api/booking-setter-attribution': 'Setter attribué au RDV (simulé)',
    '/api/booking-check-coaching-quota': 'Quota coaching vérifié (simulé)',
    '/api/alteoform-submit': 'Réponse de formulaire envoyée au serveur (simulé)',
    '/api/lead-optin': 'Création de lead (simulé)'
  };
  function simulate(req) {
    var d = req.data, path = req.path || '';
    if (req.team && path === '/api/tunnel-optin') {
      var lines = summarize(d && d.fields ? d.fields : d);
      if (d && d.extras && d.extras.length) d.extras.slice(0, 8).forEach(function (x) { lines.push([x.label || x.name, x.value]); });
      log('optin', 'Opt-in du tunnel — fiche Leads Live NON créée', lines);
      return reply({ ok: true, leadId: 'sbx_' + rand(12), sandbox: true });
    }
    if (req.team && path === '/api/tunnel-event') {
      log('stats', 'Statistique du tunnel coupée', [['Événement', d && d.e]], { dedupe: 'ev:' + (d && d.e) });
      return reply({ ok: true, sandbox: true });
    }
    if (/(^|\.)(make\.com|integromat\.com)$/i.test(req.host || '')) {
      var ml = summarize(d);
      ml.unshift(['Webhook', String(req.path || '').slice(0, 60)]);
      log('make', 'Envoi à Make bloqué — scénario NON déclenché', ml);
      return Promise.resolve({ status: 200, text: 'Accepted', type: 'text/plain' });
    }
    if (req.team && path.indexOf('/api/') === 0) {
      log('api', API_LABELS[path] || ('Appel serveur simulé : ' + path), summarize(d));
      if (path === '/api/booking-check-coaching-quota') return reply({ allowed: true, sandbox: true });
      return reply({ ok: true, sandbox: true });
    }
    log('api', 'Envoi simulé vers ' + (req.host || '') + path, summarize(d));
    return reply({ ok: true, sandbox: true });
  }
  /* Interface attendue par sandbox-frame.js (booking.html, AlteoForms). */
  window.__SBX_SERVER = {
    handle: function (pathQ, opts) {
      opts = opts || {};
      var u; try { u = new URL(pathQ, ORIGIN); } catch (e) { return Promise.resolve({ status: 400, body: '{}' }); }
      var data = null;
      if (typeof opts.body === 'string') { try { data = JSON.parse(opts.body); } catch (e2) { data = { contenu: opts.body.slice(0, 400) }; } }
      return simulate({ href: u.href, host: u.hostname, path: u.pathname, team: true, method: opts.method, data: data }).then(function (r) {
        return { status: r.status, body: r.text };
      });
    }
  };
  window.SBX = { toast: function (msg) { log('block', String(msg).replace(/^🧱\s*/, ''), null, { toast: true, dedupe: 'sbx:' + msg }); } };

  /* ═══ Pixel Meta (faux fbq des cadres) ═══════════════════════════════ */
  function pixel(args, from) {
    var cmd = String(args[0] || '');
    var where = from === 'page' ? 'page du tunnel' : String(from || '').replace(/\.html$/, '');
    if (cmd === 'init') { log('pixel', 'Pixel Meta remplacé par un faux (rien n\'est envoyé)', [['Pixel', args[1]], ['Depuis', where]], { dedupe: 'init:' + args[1] + ':' + where }); return; }
    if (cmd === 'track' || cmd === 'trackCustom' || cmd === 'trackSingle' || cmd === 'trackSingleCustom') {
      var ev = cmd.indexOf('Single') > 0 ? args[2] : args[1];
      var data = cmd.indexOf('Single') > 0 ? args[3] : args[2];
      var lines = [['Depuis', where]].concat(summarize(data));
      /* Une ligne par événement et par page (le quiz en envoie un par question). */
      log('pixel', 'Pixel Meta « ' + ev + ' » — NON envoyé', lines, { dedupe: 'px:' + ev + ':' + where + ':' + (info.p || '') });
    }
  }

  /* ═══ Fausse base : lectures réelles en surcouche ════════════════════ */
  ST.identity = { uid: 'labo-tunnels', email: '', name: 'Visiteur test', role: 'public' };
  function isPlain(v) { return v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype; }
  /* www.adrienemily.com/<chemin>?… → le Labo, même étape. */
  function labUrlFromSite(s) {
    var m = /^https?:\/\/(?:www\.)?adrienemily\.com(\/[^?#]*)?(\?[^#]*)?(#.*)?$/i.exec(s);
    if (!m) return s;
    var p = String(m[1] || '').replace(/^\/+|\/+$/g, '');
    return ORIGIN + LAB + '?p=' + encodeURIComponent(p) + (m[2] && m[2].length > 1 ? '&' + m[2].slice(1) : '') + (m[3] || '');
  }
  function rewriteUrls(v) {
    if (typeof v === 'string') return labUrlFromSite(v);
    if (Array.isArray(v)) return v.map(rewriteUrls);
    if (isPlain(v)) { var o = {}; Object.keys(v).forEach(function (k) { o[k] = rewriteUrls(v[k]); }); return o; }
    return v;
  }
  function put(col, rw) {
    return function (sn) {
      sn.forEach(function (d) { ST.setOverlay(col + '/' + d.id, window.SBXDB.encode(rw ? rewriteUrls(d.data()) : d.data())); });
    };
  }
  function quiet(what) { return function (e) { if (window.console) console.warn('[labo-tunnels] lecture ' + what + ' impossible', e && e.message); }; }
  ST.addOverlayLoader(function (col) {
    if (col === 'booking_config') return real.collection('booking_config').get().then(put(col, true)).catch(quiet(col));
    if (col === 'calendar_busy') return real.collection('calendar_busy').get().then(put(col)).catch(quiet(col));
    if (col === 'alteo_forms') return real.collection('alteo_forms').get().then(put(col, true)).catch(quiet(col));
    if (col === 'bookings') {
      /* RDV réels à venir : la page de réservation masque leurs créneaux. */
      return real.collection('bookings').where('date', '>=', parisToday()).get().then(put(col)).catch(quiet(col));
    }
    return Promise.resolve();
  });

  /* Ce que les cadres écrivent dans la fausse base → journal. */
  var seenDocs = {};
  ST.listen(function (paths) {
    (paths || []).forEach(function (p) {
      if (seenDocs[p]) return;
      var s = String(p).split('/'), d = ST.read(p);
      if (!d) return;
      if (s[0] === 'bookings' && s.length === 2) {
        seenDocs[p] = 1;
        var pr = d.prospect || {};
        log('booking', 'RDV réservé — NON créé dans l\'agenda', [
          ['Quand', (d.date || '') + ' à ' + (d.time || '')], ['Avec', d.personName], ['Type', d.typeLabel || d.type],
          ['Prospect', [pr.prenom, pr.nom].join(' ').trim()], ['Email', pr.email], ['Téléphone', pr.telephone],
          ['Provenance', d.landing && d.landing.page ? d.landing.page + (d.landing.variant ? ' · ' + d.landing.variant : '') : '']
        ]);
      } else if (s[0] === 'alteo_forms' && s[2] === 'responses' && s.length === 4) {
        seenDocs[p] = 1;
        log('form', 'Formulaire AlteoForms rempli — réponse et lead NON créés', summarize(d.answers || d));
      } else if (s[0] === 'leads') {
        seenDocs[p] = 1;
        log('info', 'Fiche lead modifiée (simulé)', [['Fiche', s[1]]]);
      }
    });
  }, window);

  /* ═══ API des cadres ═════════════════════════════════════════════════ */
  var info = { p: '', qs: '', tunnel: '', step: '', variant: '' };
  function fetchPage(p, qs) {
    var url = '/t/' + String(p || '').split('/').map(encodeURIComponent).join('/') + (qs ? '?' + qs : '');
    return fetch(url, { cache: 'no-store', credentials: 'same-origin', headers: { 'X-Alteo-Labo': '1' } }).then(function (r) {
      return r.text().then(function (html) {
        if (r.status === 404) log('info', 'Page introuvable : /' + p, [['Note', 'Chemin inconnu, ou étape sans page publiée']], { dedupe: '404:' + p });
        return { status: r.status, html: html, served: r.headers.get('X-Alteo-Tunnel') || '' };
      });
    });
  }
  function pageInfo(i) {
    info = i || info;
    var label = [info.tunnel, info.step].filter(Boolean).join(' › ') || ('/' + (info.p || ''));
    $('bInfo').textContent = label + (info.variant ? ' · variante ' + String(info.variant).toUpperCase() : '');
    document.title = '🧪 ' + label + ' — Labo Tunnels';
  }
  /* Adresse d'un cadre → adresse du Labo (onglet, lien partagé). */
  function labUrlFor(rel) {
    var u; try { u = new URL(rel, ORIGIN); } catch (e) { return LAB; }
    if (u.pathname === FRAME) return LAB + u.search + u.hash;
    if (u.pathname === MIRROR) return LAB + '?frame=' + encodeURIComponent(u.pathname + u.search);
    if (u.pathname === LAB) return u.pathname + u.search + u.hash;
    return LAB;
  }
  var stage = $('stage');
  var lastFrame = '';
  function setFrame(rel) { lastFrame = rel; stage.setAttribute('src', rel); }
  window.SBX_TN = {
    log: log, summarize: summarize, simulate: simulate, pixel: pixel,
    fetchPage: fetchPage, pageInfo: pageInfo,
    openTab: function (rel) { window.open(labUrlFor(rel), '_blank', 'noopener'); },
    go: function (rel) { if (String(rel).indexOf(LAB) === 0) location.href = rel; else setFrame(rel); }
  };

  /* Le cadre a atterri ailleurs (navigation par script sans API Navigation,
     Safari ancien) : on le ramène dans le test. */
  /* Coupe-circuit : plus de 3 rattrapages en 10 s = boucle — on s'arrête
     et on le dit, au lieu de recharger sans fin. */
  var remaps = [];
  function remapAllowed() {
    var now = Date.now();
    remaps = remaps.filter(function (t) { return now - t < 10000; });
    remaps.push(now);
    if (remaps.length <= 3) return true;
    log('nav', 'Rechargements en boucle arrêtés', [['Note', 'Recharge la page (↻) ; si ça recommence, signale-le avec ce journal.']], { toast: true, dedupe: 'loop:' + Math.floor(now / 10000) });
    return false;
  }
  stage.addEventListener('load', function () {
    var loc = null;
    try { loc = stage.contentWindow.location; void loc.pathname; } catch (e) { loc = null; }
    if (!loc) {
      log('nav', 'La page a voulu quitter le test (site externe) — retour à la dernière étape', null, { toast: true });
      if (lastFrame && remapAllowed()) setFrame(lastFrame);
      return;
    }
    if (loc.href === 'about:blank') return;
    var path = loc.pathname;
    if (path === FRAME || path === MIRROR) {
      lastFrame = path + loc.search + loc.hash;
      try { history.replaceState(null, '', labUrlFor(lastFrame)); } catch (e2) {}
      if (path === MIRROR) pageInfo({ p: '', tunnel: 'Page de réservation / formulaire', step: '', variant: '' });
      return;
    }
    var p = path.replace(/^\/(t\/|__sbx_tn\/?)?/, '').replace(/\/+$/, '');
    /* Le cadre porte l'adresse du Labo lui-même (ancien Safari, voir
       sandbox-tunnel-frame.js) : la page est bien celle du test, on ne
       recharge rien. */
    if (path === LAB) return;
    if (!remapAllowed()) return;
    if (/^[A-Za-z0-9_-]*$/.test(p)) {
      var q = String(loc.search || '').replace(/^\?/, '');
      setFrame(FRAME + '?p=' + encodeURIComponent(p) + (q ? '&' + q : ''));
      return;
    }
    log('nav', 'Page hors test bloquée : ' + path, null, { toast: true, dedupe: 'out:' + path });
    if (lastFrame) setFrame(lastFrame);
  });

  /* ═══ Boutons ════════════════════════════════════════════════════════ */
  function copyText(txt) {
    function done() { toast('🔗 Lien de test copié'); }
    if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(txt).then(done, function () { prompt('Lien de test :', txt); }); return; }
    prompt('Lien de test :', txt);
  }
  function testLink(p, v) { return ORIGIN + LAB + '?p=' + encodeURIComponent(p || '') + (v ? '&v=' + encodeURIComponent(v) : ''); }
  function reset() {
    var start = ssGet(SS_START) || (LAB + location.search);
    try { sessionStorage.clear(); } catch (e) {}
    try { localStorage.removeItem('alteo_attr_v1'); } catch (e2) {}
    ST.wipe();
    location.href = start;
  }
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-act]') : null;
    if (!b) return;
    var act = b.getAttribute('data-act');
    if (act === 'journal') { $('journal').classList.toggle('open'); return; }
    if (act === 'clear') { J = []; dedupe = {}; ssSet(SS_J, '[]'); renderJournal(); return; }
    if (act === 'copy') {
      if (document.body.classList.contains('run')) copyText(lastFrame.indexOf(FRAME) === 0 ? testLink(info.p, info.variant) : ORIGIN + labUrlFor(lastFrame));
      else copyText(ORIGIN + LAB);
      return;
    }
    if (act === 'reset') { reset(); return; }
    if (act === 'copyLink') { copyText(b.getAttribute('data-url')); return; }
  });

  /* ═══ Liste des liens (admins) ═══════════════════════════════════════ */
  var KIND_LABEL = { test: '🧪 Pages de test (visibles seulement ici)', funnel: 'Tunnels de vente', site: 'Site adrienemily.com', pages: 'Pages communes', raw: 'Pages simples' };
  function renderIndex(tunnels, msg) {
    var h = '<h1>🧪 Labo Tunnels</h1><p class="lead">Les vraies pages des tunnels, à tester sans que rien ne parte : aucun lead dans Leads Live, aucun RDV dans l\'agenda, aucun scénario Make, aucun événement pixel Meta. Les agendas et formulaires affichés sont les vrais (lecture seule). Envoie un lien 🧪 à l\'équipe : il s\'ouvre sur un téléphone sans connexion.</p>';
    if (msg) { $('index').innerHTML = h + '<div class="note">' + msg + '</div>'; return; }
    var groups = {};
    tunnels.forEach(function (t) { var k = t.kind || 'funnel'; (groups[k] = groups[k] || []).push(t); });
    ['test', 'funnel', 'site', 'pages', 'raw'].forEach(function (k) {
      if (!groups[k]) return;
      h += '<div class="grp">' + esc(KIND_LABEL[k] || k) + '</div>';
      groups[k].sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }).forEach(function (t) {
        h += '<div class="tn"><h2>' + esc(t.name || t.slug) + ' ' + (k === 'test' ? '<span class="pill">test uniquement</span>' : '<span class="pill' + (t.status === 'live' ? ' live' : '') + '">' + (t.status === 'live' ? 'en ligne' : 'brouillon') + '</span>') + '</h2>';
        (t.steps || []).filter(function (s) { return s && s.archived !== true; }).forEach(function (s) {
          var p = (t.homeStepId && t.homeStepId === s.id) ? '' : String(s.slug || '');
          var vars = (s.variants || []).filter(function (v) { return v && !v.archived && v.html && v.html.path; });
          h += '<div class="st"><div class="nm">' + esc(s.name || s.slug) + (k === 'test' ? '' : ' <span class="pill' + (s.status === 'live' ? ' live' : '') + '">' + (s.status === 'live' ? 'en ligne' : 'brouillon') + '</span>') + '<code>/' + esc(p) + '</code></div><div class="vs">';
          if (!vars.length) h += '<span class="pill">aucune page publiée</span>';
          vars.forEach(function (v) {
            var url = testLink(p, vars.length > 1 ? v.id : '');
            h += '<span class="vb"><a href="' + esc(url) + '" target="_blank" rel="noopener">🧪 ' + (vars.length > 1 ? esc(String(v.id).toUpperCase()) : 'Tester') + '</a><button data-act="copyLink" data-url="' + esc(url) + '" title="Copier le lien de test">🔗</button></span>';
          });
          h += '</div></div>';
        });
        h += '</div>';
      });
    });
    $('index').innerHTML = h;
  }
  function startIndex() {
    document.body.className = 'idx';
    $('bInfo').textContent = 'Labo Tunnels — liens de test';
    renderIndex(null, 'Chargement…');
    firebase.auth().onAuthStateChanged(function (user) {
      if (!user) { renderIndex(null, 'Ouvre un lien de test reçu (bouton 🧪 dans Tunnels de vente), ou <a href="/index.html" style="color:#fde68a">connecte-toi</a> en admin pour voir la liste de tous les liens.'); return; }
      real.collection('tunnels').get().then(function (sn) {
        var list = [];
        sn.forEach(function (d) { var t = d.data(); t.id = d.id; if (t.archived !== true) list.push(t); });
        if (!list.length) { renderIndex(null, 'Aucun tunnel.'); return; }
        renderIndex(list);
      }).catch(function () { renderIndex(null, 'La liste des tunnels est réservée aux admins. Un lien de test reçu s\'ouvre, lui, sans connexion.'); });
    });
  }

  /* ═══ Démarrage ══════════════════════════════════════════════════════ */
  renderJournal();
  var Q = new URLSearchParams(location.search);
  var frameParam = Q.get('frame');
  if (frameParam && /^\/?sandbox-frame\.html\?page=(booking|alteoforms-render)\.html(&|$)/.test(frameParam)) {
    document.body.className = 'run';
    if (!ssGet(SS_START)) ssSet(SS_START, LAB + location.search);
    setFrame(frameParam.charAt(0) === '/' ? frameParam : '/' + frameParam);
  } else if (Q.has('p')) {
    document.body.className = 'run';
    if (!ssGet(SS_START)) ssSet(SS_START, LAB + location.search);
    pageInfo({ p: Q.get('p') || '', tunnel: '', step: '', variant: Q.get('v') || '' });
    setFrame(FRAME + location.search);
    if (!J.length) toast('🧪 Mode test : remplis, réserve, clique — rien n\'est envoyé (ni lead, ni RDV, ni Make, ni pixel).');
  } else {
    startIndex();
  }
})();
