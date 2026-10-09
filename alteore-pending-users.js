/* ═══════════════════════════════════════════════════════════════════════════
   alteore-pending-users.js — COMPTES À ACTIVER — 09/10/2026
   ─────────────────────────────────────────────────────────────────────────
   Quand une personne invitée choisit son mot de passe (set-password.html →
   /api/user-invite setPassword), sa fiche users/{uid} passe en
   status 'pending_activation' et son compte Auth reste désactivé.

   Ce script, injecté par nav.js sur toutes les pages internes, affiche aux
   ADMINS une pop-up « 🔓 Anthony REIGAZA a créé son accès → Ouvrir sa
   fiche ». Elle revient tant que le compte n'est pas activé ; « Plus tard »
   la met en sourdine 1 h pour cet utilisateur.

   Aucune dépendance à un SDK Firebase (compat sur les pages sales, modulaire
   ailleurs — jamais mélangés, CLAUDE.md) : API REST Firestore avec le jeton
   de l'utilisateur. Les règles (users : lecture admin) font le reste — un
   non-admin qui forcerait la requête serait refusé.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__alteoPendingUsersLoaded) return;
  window.__alteoPendingUsersLoaded = true;

  var PROJECT = 'ambitio-team';
  var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  var POLL_MS = 60 * 1000;
  var SNOOZE_MS = 60 * 60 * 1000;
  var LS_SNOOZE = 'alteo_pending_users_snooze';

  var S = { user: null, list: [], showing: false, busy: false };

  function getAuthUser() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function api(method, path, body) {
    var u = getAuthUser();
    if (!u) return Promise.reject(new Error('Non connecté'));
    return u.getIdToken().then(function (t) {
      var opts = { method: method, headers: { 'Authorization': 'Bearer ' + t, 'Content-Type': 'application/json' } };
      if (body) opts.body = JSON.stringify(body);
      return fetch(BASE + path, opts);
    }).then(function (r) {
      if (!r.ok) return r.text().then(function (tx) { throw new Error('HTTP ' + r.status + ' ' + tx.slice(0, 200)); });
      return r.json();
    });
  }
  function fromVal(v) {
    if (v == null) return null;
    if (v.stringValue !== undefined) return v.stringValue;
    if (v.booleanValue !== undefined) return v.booleanValue;
    if (v.integerValue !== undefined) return Number(v.integerValue);
    if (v.doubleValue !== undefined) return v.doubleValue;
    if (v.timestampValue !== undefined) return v.timestampValue;
    return null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function snoozes() { try { return JSON.parse(localStorage.getItem(LS_SNOOZE) || '{}') || {}; } catch (e) { return {}; } }
  function snooze(uids) {
    var o = snoozes();
    var until = Date.now() + SNOOZE_MS;
    uids.forEach(function (id) { o[id] = until; });
    try { localStorage.setItem(LS_SNOOZE, JSON.stringify(o)); } catch (e) {}
  }

  // Sur admin-users.html?activate=<uid>, la fiche est déjà ouverte : inutile
  // de la proposer en pop-up.
  function openedHere() {
    try {
      if (!/admin-users\.html/.test(window.location.pathname)) return '';
      return new URLSearchParams(window.location.search).get('activate') || '';
    } catch (e) { return ''; }
  }

  function load() {
    var q = { structuredQuery: {
      from: [{ collectionId: 'users' }],
      where: { fieldFilter: { field: { fieldPath: 'status' }, op: 'EQUAL', value: { stringValue: 'pending_activation' } } },
      limit: 20
    } };
    return api('POST', ':runQuery', q).then(function (rows) {
      var sn = snoozes();
      var now = Date.now();
      var here = openedHere();
      S.list = (rows || []).filter(function (x) { return x.document; }).map(function (x) {
        var f = x.document.fields || {};
        return {
          uid: x.document.name.split('/').pop(),
          name: fromVal(f.displayName) || fromVal(f.email) || '',
          email: fromVal(f.email) || '',
          role: fromVal(f.role) || '',
          at: fromVal(f.activationRequestedAt) || ''
        };
      }).filter(function (u) { return !(sn[u.uid] && sn[u.uid] > now) && u.uid !== here; });
    }).catch(function (e) { console.warn('[pending-users] chargement :', e && e.message); });
  }

  function injectCss() {
    if (document.getElementById('alteoPendCss')) return;
    var css =
      '#alteoPendBg{position:fixed;inset:0;z-index:100000;background:rgba(5,8,18,.6);backdrop-filter:blur(4px);-webkit-backdrop-filter:blur(4px);display:none;align-items:center;justify-content:center;padding:16px}' +
      '#alteoPendBg.show{display:flex}' +
      '#alteoPendCard{width:100%;max-width:440px;background:linear-gradient(160deg,#1a1430 0%,#111827 70%);border:1px solid rgba(167,139,250,.35);border-radius:18px;padding:24px;color:#f1f5f9;font-family:inherit;box-shadow:0 24px 70px rgba(0,0,0,.5)}' +
      '#alteoPendCard .ap-title{font-size:17px;font-weight:800;margin-bottom:6px}' +
      '#alteoPendCard .ap-sub{font-size:13px;color:#94a3b8;line-height:1.5;margin-bottom:16px}' +
      '#alteoPendCard .ap-row{display:flex;align-items:center;gap:12px;padding:12px;border-radius:12px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);margin-bottom:8px}' +
      '#alteoPendCard .ap-who{flex:1;min-width:0}' +
      '#alteoPendCard .ap-name{font-size:14px;font-weight:700;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#alteoPendCard .ap-meta{font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}' +
      '#alteoPendCard .ap-open{flex-shrink:0;padding:9px 14px;border-radius:10px;background:linear-gradient(135deg,#7c3aed,#6d28d9);color:#fff;font-size:12px;font-weight:700;text-decoration:none;border:none;cursor:pointer;font-family:inherit}' +
      '#alteoPendCard .ap-later{display:block;margin:14px auto 0;background:none;border:none;color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit}' +
      'body.light-theme #alteoPendBg{background:rgba(226,232,240,.6)}' +
      'body.light-theme #alteoPendCard{background:linear-gradient(160deg,#f5f3ff 0%,#ffffff 70%);border-color:rgba(124,58,237,.3);color:#0f172a;box-shadow:0 24px 70px rgba(15,23,42,.18)}' +
      'body.light-theme #alteoPendCard .ap-sub,body.light-theme #alteoPendCard .ap-meta,body.light-theme #alteoPendCard .ap-later{color:#64748b}' +
      'body.light-theme #alteoPendCard .ap-row{background:rgba(15,23,42,.03);border-color:rgba(15,23,42,.08)}';
    var st = document.createElement('style');
    st.id = 'alteoPendCss';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildDom() {
    if (document.getElementById('alteoPendBg')) return;
    var bg = document.createElement('div');
    bg.id = 'alteoPendBg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.innerHTML = '<div id="alteoPendCard"></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== bg) {
        if (t.getAttribute && t.getAttribute('data-ap-act') === 'later') { close(true); return; }
        t = t.parentNode;
      }
    });
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' à ' +
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function render() {
    var n = S.list.length;
    var h = '<div class="ap-title">🔓 ' + (n > 1 ? n + ' comptes attendent leur activation' : esc(S.list[0].name) + ' a créé son accès') + '</div>' +
      '<div class="ap-sub">' + (n > 1 ? 'Ces personnes ont choisi leur mot de passe.' : 'Cette personne a choisi son mot de passe.') +
      ' Leur compte reste verrouillé tant que vous n\'avez pas vérifié leurs droits et cliqué sur « Activer l\'accès ».</div>';
    S.list.forEach(function (u) {
      var meta = [];
      if (u.email) meta.push(esc(u.email));
      if (u.role) meta.push(esc(u.role));
      var when = fmtDate(u.at);
      if (when) meta.push(when);
      h += '<div class="ap-row"><div class="ap-who"><div class="ap-name">' + esc(u.name) + '</div>' +
        '<div class="ap-meta">' + meta.join(' · ') + '</div></div>' +
        '<a class="ap-open" href="admin-users.html?activate=' + encodeURIComponent(u.uid) + '">Ouvrir sa fiche</a></div>';
    });
    h += '<button class="ap-later" data-ap-act="later">Plus tard</button>';
    document.getElementById('alteoPendCard').innerHTML = h;
  }

  function showIfAny() {
    if (S.showing || !S.list.length) return;
    S.showing = true;
    injectCss(); buildDom();
    render();
    document.getElementById('alteoPendBg').classList.add('show');
  }

  function close(doSnooze) {
    if (doSnooze) snooze(S.list.map(function (u) { return u.uid; }));
    S.showing = false;
    var bg = document.getElementById('alteoPendBg');
    if (bg) bg.classList.remove('show');
  }

  function tick() {
    if (S.busy || S.showing || document.hidden) return;
    S.busy = true;
    load().then(function () { S.busy = false; showIfAny(); }, function () { S.busy = false; });
  }

  function boot() {
    if (localStorage.getItem('ambitio_role') !== 'admin') return;
    var t0 = Date.now();
    var iv = setInterval(function () {
      var u = getAuthUser();
      if (!u) { if (Date.now() - t0 > 40000) clearInterval(iv); return; }
      clearInterval(iv);
      S.user = u;
      tick();
      setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
