/* ═══════════════════════════════════════════════════════════════════════════
   ai-brief-widget.js — carte « Brief du matin » (programme IA, Lot 1)
   ─────────────────────────────────────────────────────────────────────────
   Se monte dans <div id="aiBriefMount"></div> en haut d'un dashboard.
   Admins uniquement (localStorage.ambitio_role === 'admin').
   Fonctionne avec les deux SDK Firebase de la plateforme : compat (global
   `firebase`, pages sales) et modulaire (window._auth, pages coaching) —
   il ne fait AUCUNE lecture Firestore : tout passe par /api/ai-morning-brief.
   Repli / dépli mémorisé par jour (localStorage.aib_collapsed).
   ES5 strict, CSS autonome (sombre + thème clair body.light-theme).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var API = '/api/ai-morning-brief';
  var mount = null;
  var busy = false;
  var lastDoc = null;

  function role() { try { return localStorage.getItem('ambitio_role') || ''; } catch (e) { return ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function todayKey() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
  function isCollapsed() { try { return localStorage.getItem('aib_collapsed') === todayKey(); } catch (e) { return false; } }
  function setCollapsed(v) { try { if (v) localStorage.setItem('aib_collapsed', todayKey()); else localStorage.removeItem('aib_collapsed'); } catch (e) {} }

  function currentUser() {
    try { if (window.firebase && firebase.auth && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }

  function call(body) {
    var u = currentUser();
    if (!u) return Promise.reject(new Error('Session non prête'));
    return u.getIdToken().then(function (tok) {
      return fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (!r.ok || j.ok === false) throw new Error(j.message || j.error || ('Erreur ' + r.status));
        return j;
      });
    });
  }

  function css() {
    if (document.getElementById('aib-css')) return;
    var s = document.createElement('style');
    s.id = 'aib-css';
    s.textContent =
      '.aib{position:relative;margin:0 0 18px;border-radius:16px;padding:16px 18px;overflow:hidden;font-family:inherit;' +
        'background:linear-gradient(135deg,rgba(99,102,241,.14),rgba(168,85,247,.10) 55%,rgba(236,72,153,.08));border:1px solid rgba(129,140,248,.28);color:#eef0ff}' +
      '.aib::before{content:"";position:absolute;inset:-40% -10% auto auto;width:260px;height:260px;border-radius:50%;background:radial-gradient(circle,rgba(168,85,247,.25),transparent 70%);pointer-events:none}' +
      '.aib-hd{position:relative;display:flex;align-items:center;gap:10px;cursor:pointer;user-select:none}' +
      '.aib-ic{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:17px;background:linear-gradient(135deg,#818cf8,#a855f7);box-shadow:0 3px 14px rgba(129,140,248,.4);flex:none}' +
      '.aib-tt{flex:1;min-width:0}' +
      '.aib-k{font-size:10.5px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:rgba(199,210,254,.75)}' +
      '.aib-t{font-size:16px;font-weight:800;line-height:1.25;margin-top:1px}' +
      '.aib-btn{background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.12);color:inherit;border-radius:8px;padding:5px 10px;font-size:11.5px;font-weight:700;cursor:pointer;flex:none}' +
      '.aib-btn:hover{background:rgba(255,255,255,.14)}' +
      '.aib-btn[disabled]{opacity:.5;cursor:wait}' +
      '.aib-chev{font-size:12px;opacity:.6;transition:transform .2s;flex:none}' +
      '.aib.collapsed .aib-chev{transform:rotate(-90deg)}' +
      '.aib.collapsed .aib-bd{display:none}' +
      '.aib-bd{position:relative;margin-top:12px}' +
      '.aib-sum{font-size:14px;line-height:1.55;font-weight:600}' +
      '.aib-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-top:12px}' +
      '.aib-sec{background:rgba(10,10,25,.35);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px 12px}' +
      '.aib-sec h4{margin:0 0 6px;font-size:12px;font-weight:800;letter-spacing:.3px}' +
      '.aib-sec ul{margin:0;padding-left:16px;font-size:12.5px;line-height:1.5}' +
      '.aib-sec li{margin:2px 0}' +
      '.aib-act{margin-top:12px;display:flex;flex-direction:column;gap:5px}' +
      '.aib-a{display:flex;gap:8px;align-items:flex-start;font-size:12.5px;line-height:1.45;padding:7px 10px;border-radius:9px;background:rgba(255,255,255,.05)}' +
      '.aib-a.hi{background:rgba(248,113,113,.12);border:1px solid rgba(248,113,113,.25)}' +
      '.aib-a b{white-space:nowrap}' +
      '.aib-ft{margin-top:10px;font-size:11px;opacity:.55}' +
      '.aib-empty{font-size:13px;opacity:.8;line-height:1.5}' +
      /* .aib-l : posée quand le fond de la page est clair (coaching.html est
         crème sans être en « light-theme ») — même rendu que le thème clair. */
      '.aib.aib-l{color:#1f2140;background:linear-gradient(135deg,rgba(99,102,241,.10),rgba(168,85,247,.07) 55%,rgba(236,72,153,.05));border-color:rgba(99,102,241,.25)}' +
      '.aib.aib-l .aib-k{color:#5b5fc7}.aib.aib-l .aib-sec{background:rgba(255,255,255,.75);border-color:rgba(99,102,241,.14)}' +
      '.aib.aib-l .aib-a{background:rgba(99,102,241,.07)}.aib.aib-l .aib-a.hi{background:rgba(220,38,38,.08);border-color:rgba(220,38,38,.25)}' +
      '.aib.aib-l .aib-btn{background:rgba(255,255,255,.8);border-color:rgba(99,102,241,.25);color:#1f2140}.aib.aib-l .aib-ft{opacity:.7}' +
      'body.light-theme .aib{color:#1f2140;background:linear-gradient(135deg,rgba(99,102,241,.10),rgba(168,85,247,.07) 55%,rgba(236,72,153,.05));border-color:rgba(99,102,241,.25)}' +
      'body.light-theme .aib-k{color:#5b5fc7}' +
      'body.light-theme .aib-sec{background:rgba(255,255,255,.6);border-color:rgba(99,102,241,.14)}' +
      'body.light-theme .aib-a{background:rgba(99,102,241,.06)}' +
      'body.light-theme .aib-btn{background:rgba(255,255,255,.7);border-color:rgba(99,102,241,.2)}' +
      '@media (max-width:640px){.aib{padding:14px}.aib-t{font-size:15px}}';
    document.head.appendChild(s);
  }

  // Fond de page clair ? (luminance de la première couleur de fond non
  // transparente en remontant depuis le point de montage)
  function pageIsLight() {
    var n = mount;
    while (n && n !== document.documentElement) {
      var c = window.getComputedStyle(n).backgroundColor || '';
      var m = c.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
      if (m && (m[4] === undefined || Number(m[4]) > 0.5)) {
        return (0.299 * m[1] + 0.587 * m[2] + 0.114 * m[3]) > 150;
      }
      n = n.parentElement;
    }
    return document.body.classList.contains('light-theme');
  }

  function frDate() {
    return new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  }

  function render(doc, err) {
    var collapsed = isCollapsed();
    var b = doc && doc.brief;
    var h = '<div class="aib' + (collapsed ? ' collapsed' : '') + (pageIsLight() ? ' aib-l' : '') + '">';
    h += '<div class="aib-hd" data-aib="toggle"><div class="aib-ic">☀️</div><div class="aib-tt"><div class="aib-k">Brief du matin · ' + esc(frDate()) + '</div>';
    h += '<div class="aib-t">' + esc(b ? b.titre : (err ? 'Brief indisponible' : 'Brief pas encore généré')) + '</div></div>';
    h += '<button type="button" class="aib-btn" data-aib="regen"' + (busy ? ' disabled' : '') + ' title="Régénérer avec les données actuelles">' + (busy ? '⏳' : '↻') + '</button>';
    h += '<span class="aib-chev">▾</span></div>';
    h += '<div class="aib-bd">';
    if (!b) {
      h += '<div class="aib-empty">' + (err ? esc(err) : 'Le brief est généré chaque matin à 8 h. Clique ↻ pour le générer maintenant (≈ 30 s).') + '</div>';
    } else {
      h += '<div class="aib-sum">' + esc(b.resume) + '</div><div class="aib-grid">';
      (b.sections || []).forEach(function (s) {
        h += '<div class="aib-sec"><h4>' + esc(s.icone) + ' ' + esc(s.titre) + '</h4><ul>';
        (s.puces || []).forEach(function (p) { h += '<li>' + esc(p) + '</li>'; });
        h += '</ul></div>';
      });
      h += '</div>';
      if ((b.actions || []).length) {
        h += '<div class="aib-act">';
        b.actions.forEach(function (a) {
          h += '<div class="aib-a' + (a.priorite === 'haute' ? ' hi' : '') + '"><span>' + (a.priorite === 'haute' ? '🔴' : '✅') + '</span><span><b>' + esc(a.qui) + '</b> — ' + esc(a.quoi) + '</span></div>';
        });
        h += '</div>';
      }
      var at = doc.generatedAt ? new Date(doc.generatedAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' }) : '';
      h += '<div class="aib-ft">Généré par l\'IA à ' + at + ' à partir des données Alteore — à vérifier avant toute décision.</div>';
    }
    h += '</div></div>';
    mount.innerHTML = h;
  }

  function load(regen) {
    busy = !!regen;
    if (regen) render(lastDoc, null);
    call(regen ? { regenerate: true } : {}).then(function (j) { busy = false; lastDoc = j.doc; render(j.doc, null); })
      .catch(function (e) { busy = false; render(lastDoc, lastDoc ? null : e.message); });
  }

  function start() {
    mount = document.getElementById('aiBriefMount');
    if (!mount || role() !== 'admin') return;
    css();
    mount.addEventListener('click', function (e) {
      var t = e.target.closest ? e.target.closest('[data-aib]') : null;
      if (!t) return;
      if (t.getAttribute('data-aib') === 'regen') { e.stopPropagation(); if (!busy) load(true); return; }
      var card = mount.querySelector('.aib');
      if (!card) return;
      var c = !card.classList.contains('collapsed');
      card.classList.toggle('collapsed', c);
      setCollapsed(c);
    });
    // Attente de la session Firebase (compat ou modulaire), 30 s max.
    var tries = 0;
    (function wait() {
      if (currentUser()) { load(false); return; }
      if (++tries > 60) return;
      setTimeout(wait, 500);
    })();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
