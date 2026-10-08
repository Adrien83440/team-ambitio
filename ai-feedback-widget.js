/* ═══════════════════════════════════════════════════════════════════════════
   ai-feedback-widget.js — « Ton feedback du jour » (programme IA, Lot 4)
   ─────────────────────────────────────────────────────────────────────────
   Monté dans <div id="aiFeedbackMount"></div> (page Set NB). Affiche le
   dernier feedback IA du setter connecté (api/ai-setter-feedback.js) : ce qui
   a bien marché, 3 conseils, une phrase à essayer. Basé uniquement sur le
   CONTENU des appels notés. ES5, compat SDK.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function start() {
    var mount = document.getElementById('aiFeedbackMount');
    if (!mount) return;
    var tries = 0;
    (function wait() {
      var u = window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser;
      if (!u) { if (++tries < 60) setTimeout(wait, 500); return; }
      u.getIdToken().then(function (tok) {
        return fetch('/api/ai-setter-feedback', { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'mine' }) });
      }).then(function (r) { return r.json(); }).then(function (j) {
        var f = j && j.feedback;
        if (!f) return;
        var d = String(f.date).split('-').reverse().join('/');
        mount.innerHTML =
          '<div style="margin:0 0 16px;padding:14px 16px;border-radius:14px;border:1px solid rgba(129,140,248,.35);background:linear-gradient(135deg,rgba(99,102,241,.10),rgba(168,85,247,.06))">' +
          '<div style="display:flex;align-items:center;gap:8px;font-size:12px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#a5b4fc">🎯 Ton feedback IA · ' + esc(d) +
          '<span style="flex:1"></span><span style="text-transform:none;letter-spacing:0;font-weight:700">' + f.calls + ' appel' + (f.calls > 1 ? 's' : '') + ' notés · moyenne ' + f.avg + '/100</span></div>' +
          '<div style="font-size:13px;line-height:1.55;margin-top:8px">👏 ' + esc(f.bravo) + '</div>' +
          '<ol style="margin:8px 0 0;padding-left:20px;font-size:13px;line-height:1.55">' + (f.conseils || []).map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ol>' +
          (f.phraseDuJour ? '<div style="margin-top:8px;padding:8px 10px;border-radius:9px;background:rgba(255,255,255,.05);font-size:13px;font-style:italic">💬 « ' + esc(f.phraseDuJour) + ' »</div>' : '') +
          '</div>';
      }).catch(function () {});
    })();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
