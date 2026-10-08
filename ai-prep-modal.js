/* ═══════════════════════════════════════════════════════════════════════════
   ai-prep-modal.js — fenêtre « Dossier de préparation au closing » (IA, Lot 2)
   ─────────────────────────────────────────────────────────────────────────
   window.AiPrep.open(bookingId)  → affiche bookings/{id}.aiPrep, le génère
   s'il n'existe pas encore (api/ai-closing-prep.js, Opus, ≈ 30-60 s).
   Délégation automatique : tout élément [data-ai-prep="<bookingId>"] ouvre
   la fenêtre au clic. SDK-agnostique (compat ou window._auth). ES5 strict.
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.AiPrep) return;
  var API = '/api/ai-closing-prep';
  var cur = null;

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function user() {
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }

  function css() {
    if (document.getElementById('aip-css')) return;
    var s = document.createElement('style');
    s.id = 'aip-css';
    s.textContent =
      '.aip-bg{position:fixed;inset:0;z-index:3000;background:rgba(5,5,12,.72);backdrop-filter:blur(6px);display:none;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto}' +
      '.aip-bg.on{display:flex}' +
      '.aip{width:100%;max-width:760px;background:#11111c;border:1px solid rgba(129,140,248,.3);border-radius:18px;color:#eef0ff;box-shadow:0 30px 80px rgba(0,0,0,.5);font-family:inherit}' +
      '.aip-hd{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.07);background:linear-gradient(135deg,rgba(99,102,241,.16),rgba(168,85,247,.08));border-radius:18px 18px 0 0}' +
      '.aip-ic{width:38px;height:38px;border-radius:11px;background:linear-gradient(135deg,#818cf8,#a855f7);display:flex;align-items:center;justify-content:center;font-size:18px;flex:none}' +
      '.aip-t{flex:1;min-width:0}.aip-t b{display:block;font-size:16px}.aip-t small{font-size:11.5px;opacity:.6}' +
      '.aip-x,.aip-rf{background:rgba(255,255,255,.07);border:1px solid rgba(255,255,255,.1);color:inherit;border-radius:9px;padding:6px 10px;font-size:12px;cursor:pointer;font-weight:700}' +
      '.aip-bd{padding:16px 18px 20px}' +
      '.aip-sum{font-size:14px;line-height:1.6;font-weight:600;margin-bottom:12px}' +
      '.aip-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:10px}' +
      '.aip-c{background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.07);border-radius:12px;padding:10px 12px;margin-bottom:10px}' +
      '.aip-c h4{margin:0 0 6px;font-size:11px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;color:#a5b4fc}' +
      '.aip-c ul,.aip-c ol{margin:0;padding-left:18px;font-size:12.5px;line-height:1.55}' +
      '.aip-o{padding:8px 0;border-bottom:1px solid rgba(255,255,255,.06);font-size:12.5px;line-height:1.5}.aip-o:last-child{border-bottom:0}' +
      '.aip-o b{display:block}.aip-o small{display:block;opacity:.55;margin:2px 0}.aip-o i{display:block;color:#c7d2fe}' +
      '.aip-offre{font-size:13px;line-height:1.5}.aip-offre b{color:#fbbf24}' +
      '.aip-wait{padding:40px 10px;text-align:center;font-size:13px;opacity:.75;line-height:1.7}' +
      '.aip-ft{font-size:11px;opacity:.5;margin-top:6px}' +
      'body.light-theme .aip{background:#fbfbff;color:#1f2140;border-color:rgba(99,102,241,.25)}' +
      'body.light-theme .aip-c{background:rgba(99,102,241,.04);border-color:rgba(99,102,241,.12)}' +
      'body.light-theme .aip-c h4{color:#5b5fc7}body.light-theme .aip-o i{color:#4338ca}' +
      '@media (max-width:640px){.aip-bg{padding:12px}.aip-grid{grid-template-columns:minmax(0,1fr)}}';
    document.head.appendChild(s);
  }

  function ensureDom() {
    var bg = document.getElementById('aipBg');
    if (bg) return bg;
    css();
    bg = document.createElement('div');
    bg.id = 'aipBg';
    bg.className = 'aip-bg';
    bg.innerHTML = '<div class="aip" role="dialog" aria-modal="true"><div class="aip-hd"><div class="aip-ic">📋</div>' +
      '<div class="aip-t"><b id="aipTitle">Dossier de closing</b><small id="aipSub">Préparé par l\'IA</small></div>' +
      '<button type="button" class="aip-rf" data-aip="refresh" title="Régénérer avec les dernières infos">↻</button>' +
      '<button type="button" class="aip-x" data-aip="close">✕</button></div><div class="aip-bd" id="aipBody"></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      if (e.target === bg) { close(); return; }
      var t = e.target.closest ? e.target.closest('[data-aip]') : null;
      if (!t) return;
      if (t.getAttribute('data-aip') === 'close') close();
      else if (t.getAttribute('data-aip') === 'refresh' && cur) load(cur, true);
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && bg.classList.contains('on')) close(); });
    return bg;
  }

  function list(title, arr, ordered) {
    if (!(arr || []).length) return '';
    var tag = ordered ? 'ol' : 'ul';
    return '<div class="aip-c"><h4>' + title + '</h4><' + tag + '>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</' + tag + '></div>';
  }

  function render(p, prospect) {
    $t('aipTitle', '📋 Dossier — ' + (prospect || 'prospect'));
    $t('aipSub', 'Préparé par l\'IA le ' + new Date(p.generatedAt).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' — à recouper avec la fiche');
    var h = '<div class="aip-sum">' + esc(p.resume) + '</div>';
    h += '<div class="aip-grid"><div>' + list('🔥 Douleurs', p.douleurs) + list('🚀 Motivations', p.motivations) + '</div>';
    h += '<div>' + list('❓ Questions à poser', p.questions) + list('⚠️ Vigilance', p.vigilance) + '</div></div>';
    if (p.offreConseillee && p.offreConseillee.offre) {
      h += '<div class="aip-c"><h4>🎯 Offre conseillée</h4><div class="aip-offre"><b>' + esc(p.offreConseillee.offre) + '</b> — ' + esc(p.offreConseillee.pourquoi) + '</div></div>';
    }
    h += list('🗺️ Plan d\'attaque', p.planAttaque, true);
    if ((p.objectionsProbables || []).length) {
      h += '<div class="aip-c"><h4>🛡️ Objections probables</h4>';
      p.objectionsProbables.forEach(function (o) {
        h += '<div class="aip-o"><b>' + esc(o.objection) + '</b><small>Signal : ' + esc(o.pourquoi) + '</small><i>→ ' + esc(o.reponse) + '</i></div>';
      });
      h += '</div>';
    }
    h += '<div class="aip-ft">Voir aussi la <a href="sales-objections.html" style="color:inherit">bibliothèque d\'objections</a>.</div>';
    document.getElementById('aipBody').innerHTML = h;
  }

  function $t(id, txt) { var el = document.getElementById(id); if (el) el.textContent = txt; }

  function load(bookingId, force) {
    var u = user();
    if (!u) return;
    document.getElementById('aipBody').innerHTML = '<div class="aip-wait">⏳ ' + (force ? 'L\'IA relit tout le dossier…' : 'Chargement du dossier…') + '<br/><small>La première génération prend 30 à 60 secondes.</small></div>';
    u.getIdToken().then(function (tok) {
      return fetch(API, { method: 'POST', headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: JSON.stringify({ bookingId: bookingId, force: !!force }) });
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        if (cur !== bookingId) return;
        if (!j || j.ok === false) { document.getElementById('aipBody').innerHTML = '<div class="aip-wait">⚠️ ' + esc((j && (j.message || j.error)) || 'Erreur') + '</div>'; return; }
        render(j.prep, j.prospect);
      })
      .catch(function (e) { document.getElementById('aipBody').innerHTML = '<div class="aip-wait">⚠️ ' + esc(e.message) + '</div>'; });
  }

  function open(bookingId) {
    if (!bookingId) return;
    var bg = ensureDom();
    cur = bookingId;
    $t('aipTitle', '📋 Dossier de closing');
    $t('aipSub', 'Préparé par l\'IA');
    bg.classList.add('on');
    load(bookingId, false);
  }
  function close() { var bg = document.getElementById('aipBg'); if (bg) bg.classList.remove('on'); cur = null; }

  document.addEventListener('click', function (e) {
    var t = e.target.closest ? e.target.closest('[data-ai-prep]') : null;
    if (!t) return;
    e.preventDefault();
    e.stopPropagation();
    open(t.getAttribute('data-ai-prep'));
  }, true);

  window.AiPrep = { open: open, close: close };
})();
