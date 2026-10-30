/* ═══════════════════════════════════════════════════════════════════════════
   alteore-demarrages.js — ENCART « DÉMARRAGES À VENIR » (30/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Injecté par nav.js. Rappelle aux ADMINS et à la CSM les clients en démarrage
   différé qui partent dans moins de 7 jours, ou dont le démarrage est bloqué
   (contrat ou paiement manquant, Academy injoignable). « Masquer » : 12 h.
   Données : /api/client-demarrage?liste=1. Aucun SDK Firebase (compat et
   modulaire coexistent selon les pages). ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__alteoDemarragesLoaded) return;
  window.__alteoDemarragesLoaded = true;

  var LS_MASQUE = 'alteo_demarrages_masque';
  var MASQUE_MS = 12 * 60 * 60 * 1000;
  var RAPPEL_JOURS = 7;

  function user() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function fr(d) { return String(d || '').split('-').reverse().join('/'); }
  function masque(cle) {
    try { var o = JSON.parse(localStorage.getItem(LS_MASQUE) || 'null'); return !!(o && o.cle === cle && o.jusque > Date.now()); }
    catch (e) { return false; }
  }

  function afficher(items) {
    var cle = items.map(function (x) { return x.leadId + '@' + x.date + (x.jours <= 0 ? 'j' : ''); }).join('|');
    if (masque(cle)) return;
    var h = '<div style="font-size:14px;font-weight:800;margin-bottom:8px">⏳ ' + (items.length > 1 ? items.length + ' démarrages à préparer' : 'Démarrage à préparer') + '</div>';
    items.forEach(function (x) {
      var quand = x.jours > 0 ? 'dans ' + x.jours + ' j' : 'à ouvrir';
      var pb = x.conditions && x.conditions.manque && x.conditions.manque.length ? ' · ⛔ ' + x.conditions.manque.join(', ') : '';
      h += '<div style="font-size:12px;line-height:1.45;padding:7px 9px;border-radius:9px;border:1px solid rgba(128,128,128,.25);margin-bottom:6px"><b>' + esc(x.nom) + '</b> · ' + esc(fr(x.date)) + ' · ' + esc(quand) + esc(pb) + '</div>';
    });
    h += '<div style="display:flex;gap:8px;align-items:center;margin-top:10px"><a href="csm-cockpit.html" style="flex:1;text-align:center;padding:8px 12px;border-radius:9px;background:#d97706;color:#fff;font-size:12px;font-weight:700;text-decoration:none">Ouvrir le cockpit</a>'
      + '<button type="button" data-dm-masquer style="background:none;border:none;color:inherit;opacity:.7;font:inherit;font-size:12px;font-weight:600;cursor:pointer">Masquer 12 h</button></div>';
    var el = document.createElement('div');
    el.id = 'alteoDemarrages';
    el.setAttribute('role', 'status');
    var clair = document.body.classList.contains('light-theme');
    el.style.cssText = 'position:fixed;left:16px;bottom:16px;z-index:99980;width:340px;max-width:calc(100vw - 32px);padding:14px;border-radius:14px;border:1px solid rgba(217,119,6,.45);box-shadow:0 18px 50px rgba(0,0,0,.3);font-family:inherit;'
      + (clair ? 'background:#fffbeb;color:#1f2937' : 'background:#1c1a14;color:#f8fafc');
    el.innerHTML = h;
    el.addEventListener('click', function (e) {
      if (!e.target || !e.target.hasAttribute('data-dm-masquer')) return;
      try { localStorage.setItem(LS_MASQUE, JSON.stringify({ cle: cle, jusque: Date.now() + MASQUE_MS })); } catch (err) {}
      el.parentNode.removeChild(el);
    });
    document.body.appendChild(el);
  }

  function charger() {
    user().getIdToken().then(function (t) {
      return fetch('/api/client-demarrage?liste=1', { headers: { 'Authorization': 'Bearer ' + t } });
    }).then(function (r) { return r.json(); }).then(function (j) {
      var items = ((j && j.items) || []).filter(function (x) { return x.jours <= RAPPEL_JOURS || x.bloque; });
      if (items.length) afficher(items);
    }).catch(function (e) { console.warn('[demarrages]', e && e.message); });
  }

  function boot() {
    var role = localStorage.getItem('ambitio_role');
    if (role !== 'admin' && role !== 'csm') return;
    var t0 = Date.now();
    var iv = setInterval(function () {
      if (user()) { clearInterval(iv); charger(); return; }
      if (Date.now() - t0 > 40000) clearInterval(iv);
    }, 400);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
