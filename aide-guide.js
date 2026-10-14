/* ═══════════════════════════════════════════════════════════════════════════
   aide-guide.js — AIDE TEAM : guidage « Montre-moi » (14/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Entoure en direct, dans la VRAIE page, l'élément sur lequel cliquer, étape
   par étape, avec une bulle d'explication. Les étapes viennent des fiches
   pratiques (champ guide : [{ page, sel, text }]).
   • page : nom de la page sans .html (« booking-admin ») — si on n'y est pas,
     on y emmène l'utilisateur ; le guidage reprend tout seul au chargement
     (état en sessionStorage).
   • sel : sélecteur CSS de l'élément (on attend qu'il apparaisse : les pages
     se construisent après le chargement Firebase). Vide = bulle seule.
   • Un clic sur l'élément entouré (bouton, lien) passe à l'étape suivante.
   • Élément introuvable → la bulle l'explique et le signale à l'équipe
     (api/aide-ask action guide_fail) pour que la fiche soit réparée.
   Injecté par nav.js. ES5, aucun SDK requis (jeton compat ou window._auth).
   API : window.AideGuide.start(steps, { ficheId, title }) / .stop()
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.AideGuide) return;
  // Jamais dans une iframe (widget Dialer, panneaux Leads Live, bac à sable).
  try { if (window.self !== window.top) return; } catch (eTop) { return; }

  var KEY = 'aide_guide_v1';
  var WAIT_MS = 12000;
  var S = null;            // { ficheId, title, steps, i }
  var el = {};
  var raf = 0, target = null, pollT = 0, reported = {};

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function fmt(s) { return esc(s).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/«\s?([^»]+?)\s?»/g, '« <b>$1</b> »'); }
  function load() { try { return JSON.parse(sessionStorage.getItem(KEY) || 'null'); } catch (e) { return null; } }
  function save() { try { if (S) sessionStorage.setItem(KEY, JSON.stringify(S)); else sessionStorage.removeItem(KEY); } catch (e) {} }
  function pageName() {
    var p = (location.pathname.split('/').pop() || 'index.html').replace(/\.html$/, '');
    return p || 'index';
  }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function report(step, sel) {
    var k = (S && S.ficheId) + '_' + step;
    if (reported[k] || !S || !S.ficheId) return;
    reported[k] = true;
    var u = user();
    if (!u) return;
    u.getIdToken().then(function (tok) {
      return fetch('/api/aide-ask', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'guide_fail', ficheId: S.ficheId, step: step, page: pageName(), sel: sel }) });
    }).catch(function () {});
  }

  function css() {
    if (document.getElementById('aideGuideCss')) return;
    var s = document.createElement('style');
    s.id = 'aideGuideCss';
    s.textContent =
      '.agd-ring{position:fixed;z-index:99990;pointer-events:none;border-radius:12px;border:3px solid #34d399;box-shadow:0 0 0 9999px rgba(5,8,20,.55),0 0 0 6px rgba(52,211,153,.35),0 0 28px rgba(52,211,153,.6);transition:top .18s,left .18s,width .18s,height .18s;animation:agdPulse 1.6s ease-in-out infinite}' +
      '.agd-ring.nodim{box-shadow:0 0 0 6px rgba(52,211,153,.35),0 0 28px rgba(52,211,153,.6)}' +
      '@keyframes agdPulse{50%{border-color:#a7f3d0}}' +
      '.agd-veil{position:fixed;inset:0;z-index:99989;background:rgba(5,8,20,.45);pointer-events:none}' +
      '.agd-tip{position:fixed;z-index:99992;width:330px;max-width:calc(100vw - 24px);background:#0f172a;color:#e8eefc;border:1px solid rgba(52,211,153,.45);border-radius:14px;padding:13px 14px 12px;box-shadow:0 18px 50px rgba(0,0,0,.5);font:14px/1.5 Figtree,system-ui,-apple-system,sans-serif}' +
      '.agd-tip .h{display:flex;align-items:center;gap:8px;font-size:10.5px;font-weight:800;letter-spacing:.6px;text-transform:uppercase;color:#6ee7b7;margin-bottom:6px}' +
      '.agd-tip .h span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.agd-tip .x{background:0;border:0;color:#94a3b8;font-size:16px;cursor:pointer;padding:0 2px;line-height:1}' +
      '.agd-tip .t{font-size:14px}.agd-tip .t b{color:#fff}' +
      '.agd-tip .w{margin-top:8px;font-size:12px;color:#fcd34d;background:rgba(251,191,36,.1);border:1px solid rgba(251,191,36,.3);border-radius:8px;padding:6px 8px}' +
      '.agd-tip .b{display:flex;gap:6px;margin-top:11px;justify-content:flex-end}' +
      '.agd-tip button.bt{border:1px solid rgba(255,255,255,.16);background:transparent;color:#cbd5e1;border-radius:9px;padding:6px 11px;font:700 12.5px Figtree,system-ui,sans-serif;cursor:pointer}' +
      '.agd-tip button.bt.p{background:linear-gradient(135deg,#10b981,#0ea5e9);border-color:transparent;color:#fff}' +
      '.agd-tip button.bt:disabled{opacity:.4;cursor:default}' +
      '.agd-tip .dots{display:flex;gap:4px;margin-right:auto;align-items:center}.agd-tip .dots i{width:6px;height:6px;border-radius:50%;background:rgba(255,255,255,.2)}.agd-tip .dots i.on{background:#34d399}';
    document.head.appendChild(s);
  }

  function build() {
    css();
    if (!el.ring) {
      el.veil = document.createElement('div'); el.veil.className = 'agd-veil';
      el.ring = document.createElement('div'); el.ring.className = 'agd-ring';
      el.tip = document.createElement('div'); el.tip.className = 'agd-tip';
      el.tip.addEventListener('click', onTipClick);
    }
    if (!el.tip.parentNode) { document.body.appendChild(el.veil); document.body.appendChild(el.ring); document.body.appendChild(el.tip); }
  }
  function teardown() {
    if (raf) cancelAnimationFrame(raf); raf = 0;
    if (pollT) clearTimeout(pollT); pollT = 0;
    target = null;
    ['veil', 'ring', 'tip'].forEach(function (k) { if (el[k] && el[k].parentNode) el[k].parentNode.removeChild(el[k]); });
  }

  function visible(n) {
    if (!n || !n.getClientRects || !n.getClientRects().length) return false;
    var r = n.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    var cs = window.getComputedStyle(n);
    return cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0.05;
  }
  function find(sel) {
    var list;
    try { list = document.querySelectorAll(sel); } catch (e) { return null; }
    for (var i = 0; i < list.length; i++) if (visible(list[i])) return list[i];
    return null;
  }

  function renderTip(warn) {
    var st = S.steps[S.i] || {};
    var n = S.steps.length, last = S.i >= n - 1;
    var dots = '';
    for (var k = 0; k < n && n <= 12; k++) dots += '<i' + (k <= S.i ? ' class="on"' : '') + '></i>';
    el.tip.innerHTML =
      '<div class="h">👉 <span>Étape ' + (S.i + 1) + ' / ' + n + (S.title ? ' · ' + esc(S.title) : '') + '</span><button class="x" data-agd="stop" title="Quitter le guidage (Échap)">✕</button></div>' +
      '<div class="t">' + fmt(st.text || '') + '</div>' +
      (warn ? '<div class="w">' + warn + '</div>' : '') +
      '<div class="b"><span class="dots">' + dots + '</span>' +
      '<button class="bt" data-agd="prev"' + (S.i === 0 ? ' disabled' : '') + '>← Préc.</button>' +
      '<button class="bt p" data-agd="next">' + (last ? 'Terminé ✓' : 'Suivant →') + '</button></div>';
  }

  function placeTip(r) {
    var tw = el.tip.offsetWidth || 330, th = el.tip.offsetHeight || 140;
    var vw = window.innerWidth, vh = window.innerHeight, x, y;
    if (!r) { x = (vw - tw) / 2; y = Math.max(16, vh * 0.28); }
    else {
      x = Math.min(Math.max(12, r.left + r.width / 2 - tw / 2), vw - tw - 12);
      if (r.bottom + 14 + th < vh) y = r.bottom + 14;
      else if (r.top - 14 - th > 0) y = r.top - 14 - th;
      else { y = Math.max(12, vh - th - 12); x = r.right + 14 + tw < vw ? r.right + 14 : Math.max(12, r.left - tw - 14); }
    }
    el.tip.style.left = Math.round(x) + 'px';
    el.tip.style.top = Math.round(y) + 'px';
  }

  function loop() {
    if (!S) return;
    if (target && document.contains(target) && visible(target)) {
      var r = target.getBoundingClientRect();
      var pad = 6;
      el.ring.style.display = '';
      el.veil.style.display = 'none';
      el.ring.style.top = (r.top - pad) + 'px'; el.ring.style.left = (r.left - pad) + 'px';
      el.ring.style.width = (r.width + pad * 2) + 'px'; el.ring.style.height = (r.height + pad * 2) + 'px';
      placeTip(r);
    } else if (target) {
      // L'élément a disparu (re-rendu de la page) : on le recherche.
      var st = S.steps[S.i] || {};
      var again = st.sel ? find(st.sel) : null;
      if (again) target = again;
      else { el.ring.style.display = 'none'; el.veil.style.display = ''; placeTip(null); }
    }
    raf = requestAnimationFrame(loop);
  }

  function isAction(n) {
    if (!n) return false;
    var tag = (n.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'select' || tag === 'textarea') return n.type === 'checkbox' || n.type === 'radio' || n.type === 'submit' || n.type === 'button';
    return true;
  }

  function onDocClick(ev) {
    if (!S || !target) return;
    if (el.tip && el.tip.contains(ev.target)) return;
    if (target === ev.target || target.contains(ev.target)) {
      if (!isAction(target)) return;
      // Sauvegarde AVANT une éventuelle navigation déclenchée par ce clic.
      if (S.i < S.steps.length - 1) {
        S.i += 1; save();
        var at = S.i;
        setTimeout(function () { if (S && S.i === at) run(); }, 650);
      } else { setTimeout(stop, 400); }
    }
  }

  function onTipClick(ev) {
    var b = ev.target.closest ? ev.target.closest('[data-agd]') : null;
    if (!b) return;
    var a = b.getAttribute('data-agd');
    if (a === 'stop') stop();
    else if (a === 'prev' && S.i > 0) { S.i -= 1; save(); run(); }
    else if (a === 'next') {
      if (S.i >= S.steps.length - 1) stop();
      else { S.i += 1; save(); run(); }
    }
  }

  function run() {
    if (!S) return;
    if (pollT) clearTimeout(pollT); pollT = 0;
    target = null;
    build();
    var st = S.steps[S.i];
    if (!st) { stop(); return; }
    var here = pageName();
    if (st.page && st.page !== here) {
      renderTip('');
      el.tip.querySelector('.t').innerHTML = 'Je t\'emmène sur la bonne page…';
      el.ring.style.display = 'none'; el.veil.style.display = '';
      placeTip(null);
      save();
      setTimeout(function () { location.href = st.page + '.html'; }, 700);
      return;
    }
    renderTip('');
    el.ring.style.display = 'none'; el.veil.style.display = st.sel ? 'none' : '';
    placeTip(null);
    if (!st.sel) { if (!raf) loop(); return; }
    var t0 = Date.now(), idx = S.i;
    (function poll() {
      if (!S || S.i !== idx) return;
      var n = find(st.sel);
      if (n) {
        target = n;
        try { n.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'smooth' }); } catch (e) { n.scrollIntoView(); }
        if (!raf) loop();
        return;
      }
      if (Date.now() - t0 > WAIT_MS) {
        renderTip('Je ne trouve pas cet élément sur la page. Il est peut-être dans un menu fermé, un autre onglet de la page, ou réservé à un autre rôle. Suis l\'explication ci-dessus — j\'ai prévenu l\'équipe pour corriger le guidage.');
        el.veil.style.display = '';
        placeTip(null);
        report(idx, st.sel);
        if (!raf) loop();
        return;
      }
      pollT = setTimeout(poll, 300);
    })();
  }

  function start(steps, meta) {
    if (!steps || !steps.length) return;
    meta = meta || {};
    S = { ficheId: meta.ficheId || '', title: meta.title || '', steps: steps, i: 0, at: Date.now() };
    save();
    run();
  }
  function stop() {
    S = null; save();
    teardown();
  }

  document.addEventListener('click', onDocClick, true);
  document.addEventListener('keydown', function (e) { if (S && e.key === 'Escape') stop(); });
  window.addEventListener('resize', function () { if (S && !target) placeTip(null); });

  window.AideGuide = { start: start, stop: stop, active: function () { return !!S; } };

  // Reprise après changement de page (guidage de moins de 30 min).
  function resume() {
    var st = load();
    if (!st || !st.steps || !st.steps.length) return;
    if (Date.now() - (st.at || 0) > 30 * 60 * 1000) { try { sessionStorage.removeItem(KEY); } catch (e) {} return; }
    S = st;
    run();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', resume);
  else resume();
})();
