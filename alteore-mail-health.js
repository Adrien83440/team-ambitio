/* ═══════════════════════════════════════════════════════════════════════════
   alteore-mail-health.js — COMPTES GOOGLE DÉCONNECTÉS — 15/10/2026
   ─────────────────────────────────────────────────────────────────────────
   Incident du 10/10/2026 : strategie@ révoqué côté Google, 5 jours d'emails
   perdus sans que personne ne le voie.

   Ce script, injecté par nav.js sur toutes les pages internes, affiche aux
   ADMINS un encart rouge tant qu'un compte figure dans _config/mail_health
   (écrit par api/_mailHealth.js : échec invalid_grant à l'envoi ou au
   contrôle horaire api/mail-health-cron.js) → « Reconnecter » ouvre
   admin-email-auth.html. « Masquer » le met en sourdine 2 h ; il revient
   tant que le compte n'est pas reconnecté.

   + AGENDAS D'EXPERT PLUS LUS (28/10/2026) : même encart pour les entrées de
   _config/calendar_health (écrit par fetchAndStoreBusy, Cloud Functions) —
   un agenda Google d'expert révoqué ne bloque plus ses créneaux (incident
   Thomas Pinet, 22/10). « Ouvrir la fiche » → booking-admin.html?calExpert=

   Aucune dépendance à un SDK Firebase (compat sur les pages sales, modulaire
   ailleurs — jamais mélangés, CLAUDE.md) : API REST Firestore avec le jeton
   de l'utilisateur. Règle _config/{docId} : lecture admin seulement.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__alteoMailHealthLoaded) return;
  window.__alteoMailHealthLoaded = true;

  var PROJECT = 'ambitio-team';
  var DOC_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/_config/mail_health';
  var CAL_URL = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents/_config/calendar_health';
  var POLL_MS = 5 * 60 * 1000;
  var SNOOZE_MS = 2 * 60 * 60 * 1000;
  var LS_SNOOZE = 'alteo_mail_health_snooze';

  var LABELS = {
    strategie: 'confirmations de RDV, mandats, emails aux leads, invitations',
    coaching: 'emails aux clients coaching',
    contact: 'factures, relevés, notifications admin',
    meet_closing: 'Replay closing',
    drive_temoignages: 'mur de témoignages',
    drive_formations: 'formations internes'
  };

  var S = { list: [], cal: [], busy: false };

  function getAuthUser() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

  function snoozeKey() {
    return S.list.map(function (a) { return a.key + '@' + a.since; })
      .concat(S.cal.map(function (c) { return c.key + '@' + c.since; })).join('|');
  }
  function snoozed() {
    try {
      var o = JSON.parse(localStorage.getItem(LS_SNOOZE) || 'null');
      return !!(o && o.key === snoozeKey() && o.until > Date.now());
    } catch (e) { return false; }
  }
  function snooze() {
    try { localStorage.setItem(LS_SNOOZE, JSON.stringify({ key: snoozeKey(), until: Date.now() + SNOOZE_MS })); } catch (e) {}
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' à ' +
      d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  }

  function getDoc(url, t) {
    return fetch(url, { headers: { 'Authorization': 'Bearer ' + t } }).then(function (r) {
      if (r.status === 404) return null;
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }

  function loadCal(t) {
    return getDoc(CAL_URL, t).then(function (doc) {
      var con = (doc && doc.fields && doc.fields.connections && doc.fields.connections.mapValue && doc.fields.connections.mapValue.fields) || {};
      S.cal = Object.keys(con).map(function (k) {
        var f = (con[k].mapValue && con[k].mapValue.fields) || {};
        function str(n) { return f[n] ? (f[n].stringValue || f[n].timestampValue || '') : ''; }
        return { key: k, personId: str('personId'), personName: str('personName'), email: str('email'), sourceKey: str('sourceKey'), since: str('since') };
      }).filter(function (c) { return c.personId; });
      S.cal.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    }).catch(function (e) { console.warn('[mail-health] agendas :', e && e.message); });
  }

  function load() {
    var u = getAuthUser();
    if (!u) return Promise.resolve();
    return u.getIdToken().then(function (t) {
      return Promise.all([getDoc(DOC_URL, t), loadCal(t)]);
    }).then(function (both) {
      var doc = both[0];
      var acc = (doc && doc.fields && doc.fields.accounts && doc.fields.accounts.mapValue && doc.fields.accounts.mapValue.fields) || {};
      S.list = Object.keys(acc).map(function (k) {
        var f = (acc[k].mapValue && acc[k].mapValue.fields) || {};
        function str(n) { return f[n] ? (f[n].stringValue || f[n].timestampValue || '') : ''; }
        return { key: k, email: str('email'), since: str('lastSuccessAt') || str('firstFailedAt') };
      }).filter(function (a) { return a.key; });
      S.list.sort(function (a, b) { return a.key < b.key ? -1 : 1; });
    }).catch(function (e) { console.warn('[mail-health] chargement :', e && e.message); });
  }

  function injectCss() {
    if (document.getElementById('alteoMhCss')) return;
    var css =
      '#alteoMh{position:fixed;right:16px;bottom:16px;z-index:99990;width:380px;max-width:calc(100vw - 32px);background:linear-gradient(160deg,#2a1215 0%,#111827 75%);border:1px solid rgba(239,68,68,.45);border-radius:16px;padding:16px 18px;color:#f1f5f9;font-family:inherit;box-shadow:0 18px 50px rgba(0,0,0,.5);display:none}' +
      '#alteoMh.show{display:block}' +
      '#alteoMh .mh-title{font-size:14px;font-weight:800;margin-bottom:6px;color:#fca5a5}' +
      '#alteoMh .mh-sub{font-size:12px;color:#cbd5e1;line-height:1.5;margin-bottom:10px}' +
      '#alteoMh .mh-row{font-size:12px;line-height:1.45;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);margin-bottom:6px}' +
      '#alteoMh .mh-row b{color:#f8fafc}' +
      '#alteoMh .mh-meta{color:#94a3b8;font-size:11px}' +
      '#alteoMh .mh-actions{display:flex;gap:8px;align-items:center;margin-top:12px}' +
      '#alteoMh .mh-link{color:#c4b5fd;font-weight:700;text-decoration:none}' +
      '#alteoMh .mh-go{flex:1;text-align:center;padding:9px 14px;border-radius:10px;background:linear-gradient(135deg,#dc2626,#b91c1c);color:#fff;font-size:12px;font-weight:700;text-decoration:none}' +
      '#alteoMh .mh-later{background:none;border:none;color:#94a3b8;font-size:12px;font-weight:600;cursor:pointer;font-family:inherit;padding:9px 6px}' +
      'body.light-theme #alteoMh{background:linear-gradient(160deg,#fef2f2 0%,#ffffff 75%);border-color:rgba(220,38,38,.35);color:#0f172a;box-shadow:0 18px 50px rgba(15,23,42,.18)}' +
      'body.light-theme #alteoMh .mh-title{color:#b91c1c}' +
      'body.light-theme #alteoMh .mh-sub{color:#334155}' +
      'body.light-theme #alteoMh .mh-row{background:rgba(15,23,42,.03);border-color:rgba(15,23,42,.08)}' +
      'body.light-theme #alteoMh .mh-row b{color:#0f172a}' +
      'body.light-theme #alteoMh .mh-link{color:#6d28d9}' +
      'body.light-theme #alteoMh .mh-meta,body.light-theme #alteoMh .mh-later{color:#64748b}';
    var st = document.createElement('style');
    st.id = 'alteoMhCss';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function box() {
    var el = document.getElementById('alteoMh');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'alteoMh';
    el.setAttribute('role', 'alert');
    document.body.appendChild(el);
    el.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== el) {
        if (t.getAttribute && t.getAttribute('data-mh-act') === 'later') { snooze(); el.classList.remove('show'); return; }
        t = t.parentNode;
      }
    });
    return el;
  }

  function render() {
    if ((!S.list.length && !S.cal.length) || snoozed()) {
      var old = document.getElementById('alteoMh');
      if (old) old.classList.remove('show');
      return;
    }
    injectCss();
    var el = box();
    var n = S.list.length;
    var h = '';
    if (n) {
      h += '<div class="mh-title">📭 ' + (n > 1 ? n + ' comptes Google déconnectés' : 'Compte Google déconnecté') + '</div>' +
        '<div class="mh-sub">Google a révoqué l\'accès de la plateforme. Tant qu\'il n\'est pas reconnecté, ce qui passe par ' +
        (n > 1 ? 'ces comptes' : 'ce compte') + ' ne part pas.</div>';
      S.list.forEach(function (a) {
        var since = fmtDate(a.since);
        h += '<div class="mh-row"><b>' + esc(a.email || a.key) + '</b> <span class="mh-meta">(' + esc(a.key) + ')</span><br>' +
          '<span class="mh-meta">' + esc(LABELS[a.key] || 'compte Google') + (since ? ' · dernier fonctionnement : ' + since : '') + '</span></div>';
      });
    }
    if (S.cal.length) {
      var nc = S.cal.length;
      h += '<div class="mh-title"' + (n ? ' style="margin-top:12px"' : '') + '>📅 ' + (nc > 1 ? nc + ' agendas d\'expert plus lus' : 'Agenda d\'expert plus lu') + '</div>' +
        '<div class="mh-sub">Les RDV notés dans ' + (nc > 1 ? 'ces agendas' : 'cet agenda') + ' ne bloquent plus les créneaux de réservation : ' +
        'l\'expert doit se reconnecter (« Resynchroniser » ne suffit pas).</div>';
      S.cal.forEach(function (c) {
        var since = fmtDate(c.since);
        var what = c.sourceKey === 'main' ? 'Google Agenda principal' : 'agenda perso ' + (c.email || '');
        h += '<div class="mh-row"><b>' + esc(c.personName || c.personId) + '</b> <span class="mh-meta">· ' + esc(what) + '</span><br>' +
          '<span class="mh-meta">' + (since ? 'dernier fonctionnement : ' + since + ' · ' : '') + '</span>' +
          '<a class="mh-link" href="booking-admin.html?calExpert=' + encodeURIComponent(c.personId) + '">Ouvrir la fiche →</a></div>';
      });
    }
    h += '<div class="mh-actions">' + (n ? '<a class="mh-go" href="admin-email-auth.html">Reconnecter</a>' : '') +
      '<button class="mh-later" data-mh-act="later">Masquer 2 h</button></div>';
    el.innerHTML = h;
    el.classList.add('show');
  }

  function tick() {
    if (S.busy || document.hidden) return;
    S.busy = true;
    load().then(function () { S.busy = false; render(); }, function () { S.busy = false; });
  }

  function boot() {
    if (localStorage.getItem('ambitio_role') !== 'admin') return;
    if (/admin-email-auth\.html/.test(window.location.pathname)) return;
    var t0 = Date.now();
    var iv = setInterval(function () {
      var u = getAuthUser();
      if (!u) { if (Date.now() - t0 > 40000) clearInterval(iv); return; }
      clearInterval(iv);
      tick();
      setInterval(tick, POLL_MS);
      document.addEventListener('visibilitychange', function () { if (!document.hidden) tick(); });
    }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
