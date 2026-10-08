/* ═══════════════════════════════════════════════════════════════════════════
   ai-risk-alerts.js — bandeau « Clients à risque » (programme IA, Lot 3)
   ─────────────────────────────────────────────────────────────────────────
   Monté dans <div id="aiRiskMount"></div>. Affiche les alertes ouvertes
   (client passé à l'orange ou au rouge) — un coach ne voit que SES clients,
   admin / CSM voient tout (filtrage serveur : api/ai-client-risk.js).
   « Vu » masque l'alerte pour soi. Clic sur le nom : ouvre la fiche si la page
   expose openDetail(clientId) (coaching.html), sinon le cockpit CSM.
   ES5, sans SDK (jeton compat ou window._auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__aiRiskAlerts) return;
  window.__aiRiskAlerts = true;
  var API = '/api/ai-client-risk';
  var mount = null, items = [], open = false;

  function role() { try { return localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function user() {
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    return null;
  }
  function call(body) {
    var u = user();
    if (!u) return Promise.reject(new Error('Session non prête'));
    return u.getIdToken().then(function (tok) {
      return fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) { if (!j || j.ok === false) throw new Error((j && j.error) || 'Erreur'); return j; });
  }

  function css() {
    if (document.getElementById('ara-css')) return;
    var s = document.createElement('style');
    s.id = 'ara-css';
    s.textContent =
      '.ara{border-radius:14px;border:1px solid rgba(239,68,68,.3);background:linear-gradient(135deg,rgba(239,68,68,.08),rgba(251,191,36,.05));padding:10px 14px;font-family:inherit;color:inherit}' +
      '.ara-hd{display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none;font-size:13px}' +
      '.ara-hd b{flex:1}.ara-n{font-size:11px;font-weight:800;padding:2px 8px;border-radius:999px}' +
      '.ara-n.r{background:#ef4444;color:#fff}.ara-n.o{background:#f59e0b;color:#111}' +
      '.ara-list{margin-top:8px;display:flex;flex-direction:column;gap:6px}' +
      '.ara-it{display:flex;align-items:flex-start;gap:10px;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,.55);font-size:12.5px;line-height:1.45}' +
      '.ara-dot{width:10px;height:10px;border-radius:50%;flex:none;margin-top:4px}.ara-dot.rouge{background:#ef4444}.ara-dot.orange{background:#f59e0b}' +
      '.ara-it .m{flex:1;min-width:0}.ara-it a{font-weight:800;color:inherit;cursor:pointer;text-decoration:underline;text-decoration-color:rgba(0,0,0,.2)}' +
      '.ara-it small{display:block;opacity:.7}' +
      '.ara-ok{background:none;border:1px solid rgba(0,0,0,.15);border-radius:7px;padding:2px 8px;font-size:11px;cursor:pointer;color:inherit;flex:none}';
    document.head.appendChild(s);
  }

  function render() {
    if (!items.length) { mount.innerHTML = ''; return; }
    var r = items.filter(function (a) { return a.level === 'rouge'; }).length, o = items.length - r;
    var h = '<div class="ara"><div class="ara-hd" data-ara="toggle">🚨 <b>Clients à risque — nouvelles alertes</b>' +
      (r ? '<span class="ara-n r">' + r + ' rouge' + (r > 1 ? 's' : '') + '</span>' : '') +
      (o ? '<span class="ara-n o">' + o + ' orange' + (o > 1 ? 's' : '') + '</span>' : '') + '<span>' + (open ? '▾' : '▸') + '</span></div>';
    if (open) {
      h += '<div class="ara-list">';
      items.forEach(function (a) {
        h += '<div class="ara-it"><span class="ara-dot ' + a.level + '"></span><div class="m"><a data-ara="open" data-client="' + esc(a.clientId) + '">' + esc(a.clientName || 'Client') + '</a>' +
          (a.coach ? ' <span style="opacity:.6">· ' + esc(a.coach) + '</span>' : '') +
          '<small>' + (a.reasons || []).map(esc).join(' · ') + '</small></div>' +
          '<button type="button" class="ara-ok" data-ara="ack" data-id="' + esc(a.id) + '">Vu</button></div>';
      });
      h += '</div>';
    }
    h += '</div>';
    mount.innerHTML = h;
  }

  function start() {
    mount = document.getElementById('aiRiskMount');
    var r = role();
    if (!mount || (r !== 'admin' && r !== 'csm' && r !== 'coach')) return;
    css();
    mount.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-ara]') : null;
      if (!t) return;
      var a = t.getAttribute('data-ara');
      if (a === 'toggle') { open = !open; render(); return; }
      if (a === 'open') {
        var id = t.getAttribute('data-client');
        if (typeof window.openDetail === 'function') window.openDetail(id);
        else window.location.href = 'csm-cockpit.html?client=' + encodeURIComponent(id);
        return;
      }
      if (a === 'ack') {
        var aid = t.getAttribute('data-id');
        items = items.filter(function (x) { return x.id !== aid; });
        render();
        call({ action: 'ack', alertId: aid }).catch(function () {});
      }
    });
    var tries = 0;
    (function wait() {
      if (user()) { call({ action: 'alerts' }).then(function (j) { items = j.items || []; open = items.length <= 3; render(); }).catch(function () {}); return; }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
