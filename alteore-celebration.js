/* ═══════════════════════════════════════════════════════════════════════════
   alteore-celebration.js — FÉLICITATIONS AU SETTER — 07/10/2026
   ─────────────────────────────────────────────────────────────────────────
   Quand un close crée une commission de setting (AlteoreFlow →
   createSaleCelebration), un document sale_celebrations/{dealKey} est
   déposé pour le setter. Ce script, injecté par nav.js sur toutes les pages
   internes, l'affiche en pop-up au setter concerné :
     « 🎉 Félicitations Steven ! Une vente vient d'être conclue grâce à toi… »
   puis pose seenAt — le pop-up ne revient jamais.

   Si le setter n'est pas connecté au moment du close, il le voit à sa
   prochaine page. Guet léger toutes les 60 s quand l'onglet est visible.

   Aucune dépendance à un SDK Firebase (compat sur les pages sales, modulaire
   ailleurs — jamais mélangés, CLAUDE.md) : API REST Firestore avec le jeton
   de l'utilisateur, les règles s'appliquent à l'identique. Même mécanique
   que alteore-infos.js.

   Données :
     sale_celebrations/{dealKey} { kind:'setting', targetUid, targetSlug,
       targetName, client, offre, offreLabel, comm, closerSlug, closerName,
       closeMonth, payMonth, bookingId, leadId, dealKey, createdAt,
       createdBy, createdByName, seenAt (null tant que non vu) }
   Rien n'est supprimé.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__alteoCelebrationLoaded) return;
  window.__alteoCelebrationLoaded = true;

  var PROJECT = 'ambitio-team';
  var BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';
  var POLL_MS = 60 * 1000;
  var SS_SEEN = 'alteo_celebration_seen';
  var MONTHS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var CONFETTI_COLORS = ['#f59e0b', '#34d399', '#ec4899', '#60a5fa', '#a78bfa', '#fbbf24'];

  var S = { user: null, queue: [], showing: false, busy: false };

  /* ── Auth : compat (sales) ou modulaire (coaching / admin) ────────────── */
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
    if (v.nullValue !== undefined) return null;
    if (v.arrayValue !== undefined) return (v.arrayValue.values || []).map(fromVal);
    if (v.mapValue !== undefined) return fromFields(v.mapValue.fields || {});
    return null;
  }
  function fromFields(f) { var o = {}; Object.keys(f || {}).forEach(function (k) { o[k] = fromVal(f[k]); }); return o; }

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function euro(n) {
    var v = Math.round(Number(n) || 0);
    return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
  }
  function monthLabel(mk) {
    var p = String(mk || '').split('-');
    var mi = parseInt(p[1], 10) - 1;
    if (!p[0] || isNaN(mi) || mi < 0 || mi > 11) return '';
    return MONTHS_FR[mi] + ' ' + p[0];
  }

  /* Filet local : si l'écriture de seenAt échoue (réseau), on ne remontre
     pas le même pop-up dans cet onglet. */
  function seenLocal() { try { return JSON.parse(sessionStorage.getItem(SS_SEEN) || '{}') || {}; } catch (e) { return {}; } }
  function markSeenLocal(id) { var o = seenLocal(); o[id] = 1; try { sessionStorage.setItem(SS_SEEN, JSON.stringify(o)); } catch (e) {} }

  /* ── Données : uniquement MES félicitations non vues ──────────────────── */
  /* Deux égalités (targetUid + seenAt null) : aucun index composite requis.
     Le filtre targetUid est obligatoire — les règles refusent toute requête
     qui pourrait renvoyer les félicitations d'un autre membre. */
  function loadPending() {
    var q = { structuredQuery: {
      from: [{ collectionId: 'sale_celebrations' }],
      where: { compositeFilter: { op: 'AND', filters: [
        { fieldFilter: { field: { fieldPath: 'targetUid' }, op: 'EQUAL', value: { stringValue: S.user.uid } } },
        { unaryFilter: { field: { fieldPath: 'seenAt' }, op: 'IS_NULL' } }
      ] } },
      limit: 20
    } };
    return api('POST', ':runQuery', q).then(function (rows) {
      var local = seenLocal();
      var known = {};
      S.queue.forEach(function (d) { known[d.id] = 1; });
      (rows || []).filter(function (x) { return x.document; }).forEach(function (x) {
        var d = fromFields(x.document.fields || {});
        d.id = x.document.name.split('/').pop();
        if (local[d.id] || known[d.id]) return;
        S.queue.push(d);
      });
      S.queue.sort(function (a, b) { return String(a.createdAt || '') < String(b.createdAt || '') ? -1 : 1; });
    }).catch(function (e) { console.warn('[celebration] chargement :', e && e.message); });
  }

  function markSeen(id) {
    markSeenLocal(id);
    var body = { fields: { seenAt: { timestampValue: new Date().toISOString() } } };
    return api('PATCH', '/sale_celebrations/' + encodeURIComponent(id) + '?updateMask.fieldPaths=seenAt&currentDocument.exists=true', body)
      .catch(function (e) { console.warn('[celebration] seenAt :', e && e.message); });
  }

  /* ── Affichage ─────────────────────────────────────────────────────────── */
  function injectCss() {
    if (document.getElementById('alteoCelebCss')) return;
    var css =
      '#alteoCelebBg{position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;padding:16px;background:rgba(5,6,12,.72);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px)}' +
      '#alteoCelebBg.show{display:flex}' +
      '#alteoCelebCard{position:relative;width:100%;max-width:420px;border-radius:22px;padding:30px 26px 24px;text-align:center;overflow:hidden;' +
        'background:linear-gradient(160deg,#1a1530 0%,#11131f 60%,#0d1a17 100%);border:1px solid rgba(251,191,36,.35);' +
        'box-shadow:0 24px 70px rgba(0,0,0,.55),0 0 0 1px rgba(255,255,255,.04) inset;color:#f1f5f9;font-family:inherit;animation:alteoCelebPop .45s cubic-bezier(.2,1.4,.4,1)}' +
      '@keyframes alteoCelebPop{from{transform:scale(.8);opacity:0}to{transform:scale(1);opacity:1}}' +
      '#alteoCelebCard .ac-emoji{font-size:54px;line-height:1;margin-bottom:10px}' +
      '#alteoCelebCard .ac-title{font-size:22px;font-weight:800;margin:0 0 6px}' +
      '#alteoCelebCard .ac-lead{font-size:14px;color:#cbd5e1;margin:0 0 18px}' +
      '#alteoCelebCard .ac-sale{border-radius:14px;padding:12px 14px;margin:0 0 18px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.08)}' +
      '#alteoCelebCard .ac-client{font-size:16px;font-weight:700}' +
      '#alteoCelebCard .ac-meta{font-size:12.5px;color:#94a3b8;margin-top:3px}' +
      '#alteoCelebCard .ac-win{font-size:13px;color:#cbd5e1}' +
      '#alteoCelebCard .ac-amount{font-size:42px;font-weight:900;color:#34d399;letter-spacing:-.5px;margin:2px 0 2px;font-variant-numeric:tabular-nums}' +
      '#alteoCelebCard .ac-sub{font-size:13px;color:#cbd5e1;margin-bottom:14px}' +
      '#alteoCelebCard .ac-note{font-size:11px;color:#94a3b8;line-height:1.45;margin:0 0 18px}' +
      '#alteoCelebCard .ac-btn{appearance:none;border:0;cursor:pointer;border-radius:12px;padding:12px 26px;font-size:15px;font-weight:800;font-family:inherit;' +
        'color:#1a1206;background:linear-gradient(135deg,#fbbf24,#f59e0b);box-shadow:0 8px 24px rgba(245,158,11,.35)}' +
      '#alteoCelebCard .ac-btn:hover{filter:brightness(1.06)}' +
      '#alteoCelebCard .ac-count{font-size:11px;color:#94a3b8;margin-top:10px}' +
      '#alteoCelebConfetti{position:absolute;inset:0;pointer-events:none;overflow:hidden}' +
      '#alteoCelebConfetti i{position:absolute;top:-14px;width:8px;height:12px;border-radius:2px;opacity:.95;animation:alteoCelebFall linear forwards}' +
      '@keyframes alteoCelebFall{0%{transform:translateY(0) rotate(0)}100%{transform:translateY(560px) rotate(720deg);opacity:0}}' +
      /* Thème clair liquid glass */
      'body.light-theme #alteoCelebBg{background:rgba(226,232,240,.6)}' +
      'body.light-theme #alteoCelebCard{background:linear-gradient(160deg,#fffaf0 0%,#ffffff 60%,#f0fdf8 100%);border-color:rgba(245,158,11,.4);color:#0f172a;box-shadow:0 24px 70px rgba(15,23,42,.18)}' +
      'body.light-theme #alteoCelebCard .ac-lead,body.light-theme #alteoCelebCard .ac-win,body.light-theme #alteoCelebCard .ac-sub{color:#334155}' +
      'body.light-theme #alteoCelebCard .ac-meta,body.light-theme #alteoCelebCard .ac-note,body.light-theme #alteoCelebCard .ac-count{color:#64748b}' +
      'body.light-theme #alteoCelebCard .ac-sale{background:rgba(15,23,42,.04);border-color:rgba(15,23,42,.08)}' +
      'body.light-theme #alteoCelebCard .ac-amount{color:#059669}' +
      '@media (prefers-reduced-motion:reduce){#alteoCelebCard{animation:none}#alteoCelebConfetti{display:none}}';
    var st = document.createElement('style');
    st.id = 'alteoCelebCss';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function buildDom() {
    if (document.getElementById('alteoCelebBg')) return;
    var bg = document.createElement('div');
    bg.id = 'alteoCelebBg';
    bg.setAttribute('role', 'dialog');
    bg.setAttribute('aria-modal', 'true');
    bg.innerHTML = '<div id="alteoCelebCard"><div id="alteoCelebConfetti"></div><div id="alteoCelebBody"></div></div>';
    document.body.appendChild(bg);
    /* Délégation : un seul gestionnaire, aucun onclick inline. */
    bg.addEventListener('click', function (e) {
      var t = e.target;
      while (t && t !== bg) {
        if (t.getAttribute && t.getAttribute('data-ac-act') === 'ok') { closeCurrent(); return; }
        t = t.parentNode;
      }
    });
  }

  function confetti() {
    var box = document.getElementById('alteoCelebConfetti');
    if (!box) return;
    var h = '';
    for (var i = 0; i < 46; i++) {
      var left = Math.random() * 100;
      var delay = Math.random() * 0.9;
      var dur = 2.2 + Math.random() * 1.8;
      var col = CONFETTI_COLORS[i % CONFETTI_COLORS.length];
      var w = 6 + Math.round(Math.random() * 5);
      h += '<i style="left:' + left.toFixed(1) + '%;background:' + col + ';width:' + w + 'px;animation-delay:' + delay.toFixed(2) + 's;animation-duration:' + dur.toFixed(2) + 's"></i>';
    }
    box.innerHTML = h;
  }

  function render(d) {
    var first = String(d.targetName || '').split(' ')[0] || '';
    var meta = [];
    if (d.offreLabel || d.offre) meta.push(esc(d.offreLabel || d.offre));
    if (d.closerName) meta.push('closée par ' + esc(d.closerName));
    var pay = monthLabel(d.payMonth);
    var rest = S.queue.length - 1;
    var h =
      '<div class="ac-emoji">🎉</div>' +
      '<h2 class="ac-title">Félicitations' + (first ? ' ' + esc(first) : '') + ' !</h2>' +
      '<p class="ac-lead">Une vente vient d’être conclue grâce à toi.</p>' +
      '<div class="ac-sale"><div class="ac-client">' + esc(d.client || 'Client') + '</div>' +
        (meta.length ? '<div class="ac-meta">' + meta.join(' · ') + '</div>' : '') + '</div>' +
      '<div class="ac-win">Tu remportes</div>' +
      '<div class="ac-amount">' + euro(d.comm) + '</div>' +
      '<div class="ac-sub">de commission de setting</div>' +
      '<p class="ac-note">Acquise à l’encaissement du 1er paiement et à la fin du délai de rétractation' +
        (pay ? ' · versée avec la paie de ' + esc(pay) : '') + '.</p>' +
      '<button type="button" class="ac-btn" data-ac-act="ok">Merci ! 🙌</button>' +
      (rest > 0 ? '<div class="ac-count">+ ' + rest + ' autre' + (rest > 1 ? 's' : '') + ' vente' + (rest > 1 ? 's' : '') + ' à découvrir</div>' : '');
    document.getElementById('alteoCelebBody').innerHTML = h;
  }

  function showNext() {
    if (S.showing || !S.queue.length) return;
    S.showing = true;
    injectCss(); buildDom();
    render(S.queue[0]);
    document.getElementById('alteoCelebBg').classList.add('show');
    confetti();
  }

  function closeCurrent() {
    var d = S.queue.shift();
    S.showing = false;
    var bg = document.getElementById('alteoCelebBg');
    if (bg) bg.classList.remove('show');
    if (d) markSeen(d.id);
    if (S.queue.length) setTimeout(showNext, 350);
  }

  function tick() {
    if (S.busy || document.hidden) return;
    S.busy = true;
    loadPending().then(function () { S.busy = false; showNext(); }, function () { S.busy = false; });
  }

  /* ── Démarrage : attend l'auth (compat ou modulaire) ──────────────────── */
  function boot() {
    if (!localStorage.getItem('ambitio_role')) return;   // page publique / non connecté
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
