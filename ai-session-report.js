/* ═══════════════════════════════════════════════════════════════════════════
   ai-session-report.js — bouton « ✨ CR IA » des séances coaching (Lot 3)
   ─────────────────────────────────────────────────────────────────────────
   Le coach colle ses notes brutes (ou les notes Gemini de la visio) dans le
   champ Résumé d'une séance, clique ✨ CR IA : l'IA (api/ai-session-report.js)
   renvoie un résumé structuré et la liste des devoirs, qui REMPLISSENT les
   champs du formulaire. Rien n'est enregistré : le coach relit, corrige,
   puis clique son bouton habituel (✅ Valider / 💾 Sauvegarder) — c'est
   coaching.html qui sauvegarde la fiche, comme d'habitude.
   Bouton : [data-ai-cr="<idResumé>|<idDevoirs>"] + data-client/yi/sn.
   ES5, aucun SDK (jeton window._auth).
   ═══════════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.__aiSessionReport) return;
  window.__aiSessionReport = true;

  var s = document.createElement('style');
  s.textContent = '.ai-cr-btn{margin-left:8px;padding:2px 9px;border-radius:999px;border:1px solid rgba(129,140,248,.45);background:rgba(129,140,248,.1);color:#6366f1;font-size:10.5px;font-weight:700;cursor:pointer;vertical-align:middle}' +
    '.ai-cr-btn:hover{background:rgba(129,140,248,.2)}.ai-cr-btn[disabled]{opacity:.5;cursor:wait}' +
    '.ai-cr-vig{margin:6px 0 0;padding:7px 10px;border-radius:8px;background:rgba(251,191,36,.12);border:1px solid rgba(251,191,36,.3);font-size:12px;line-height:1.45;color:inherit}';
  document.head.appendChild(s);

  function user() {
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    try { if (window.firebase && firebase.apps && firebase.apps.length && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    return null;
  }
  function toast(msg, kind) {
    if (typeof window.showToast === 'function') window.showToast(msg, kind || 'success');
    else alert(msg);
  }

  document.addEventListener('click', function (e) {
    var b = e.target.closest ? e.target.closest('[data-ai-cr]') : null;
    if (!b) return;
    e.preventDefault();
    e.stopPropagation();
    var ids = String(b.getAttribute('data-ai-cr')).split('|');
    var taR = document.getElementById(ids[0]);
    var taD = document.getElementById(ids[1]);
    if (!taR) return;
    var raw = String(taR.value || '').trim();
    if (raw.length < 40) { toast('Colle d\'abord tes notes de séance (ou les notes Gemini) dans « Résumé »', 'error'); taR.focus(); return; }
    var u = user();
    if (!u) { toast('Session expirée', 'error'); return; }
    var label = b.textContent;
    b.disabled = true;
    b.textContent = '⏳ IA…';
    u.getIdToken().then(function (tok) {
      return fetch('/api/ai-session-report', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + tok, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clientId: b.getAttribute('data-client'),
          yi: Number(b.getAttribute('data-yi')),
          sn: Number(b.getAttribute('data-sn')),
          raw: raw,
          devoirsRaw: taD ? taD.value : ''
        })
      });
    }).then(function (r) { return r.json().catch(function () { return {}; }); })
      .then(function (j) {
        b.disabled = false; b.textContent = label;
        if (!j || j.ok === false) { toast((j && (j.message || j.error)) || 'Erreur IA', 'error'); return; }
        taR.value = j.resume || taR.value;
        if (taD && j.devoirs && j.devoirs.length) taD.value = j.devoirs.join('\n');
        var old = taR.parentNode.querySelector('.ai-cr-vig');
        if (old) old.parentNode.removeChild(old);
        if (j.vigilance) {
          var v = document.createElement('div');
          v.className = 'ai-cr-vig';
          v.textContent = '👀 Pour toi (non enregistré) : ' + j.vigilance;
          taR.parentNode.appendChild(v);
        }
        toast('✨ Compte-rendu proposé — relis puis enregistre', 'success');
      })
      .catch(function (er) { b.disabled = false; b.textContent = label; toast(er.message || 'Erreur réseau', 'error'); });
  }, true);
})();
