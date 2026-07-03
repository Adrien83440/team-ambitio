// ============================================================================
// academy-widget.js — WIDGET « AVANCEMENT AE ACADEMY » (V11a)
// ----------------------------------------------------------------------------
// Petit module frontend réutilisable pour afficher, dans les pages Team
// Alteor, l'avancement d'un client sur la plateforme de formation
// (academy.adrienemily.com) : % par formation, jalons, Bâtiment, modules
// restants (l'argument « Année 2 »), dernière activité, bouton copie.
//
// UTILISATION (pages en Firebase COMPAT — ex : csm-clients.html) :
//   1. <script src="academy-widget.js"></script>  avant </body>
//   2. Dans le HTML d'une carte/fiche :
//        <button data-academy-btn data-em="client@exemple.com">🎓 Academy</button>
//        <div data-academy-panel data-em="client@exemple.com" style="display:none"></div>
//      → le clic ouvre le panneau et charge les données (une seule fois).
//   3. Ou par code : AcademyWidget.load(panelElement, "client@exemple.com")
//
// Auth : ID token Firebase du user connecté (compat : firebase.auth()),
// envoyé à NOTRE endpoint /api/academy-progress (rôles admin/coach/csm).
// Le widget ne parle jamais directement à l'Academy et ne voit aucun secret.
//
// Fail-soft : pas de compte Academy / pont non configuré / indisponible →
// une ligne de texte grise, jamais d'erreur bloquante pour la page hôte.
// ============================================================================

(function () {
  'use strict';

  var CSS = ''
    + '.acad-panel{margin-top:8px;padding:10px 12px;background:#f8f7ff;border:1px solid #e4e1f7;border-radius:10px;font-size:12px;line-height:1.55;color:#1f2340}'
    + '.acad-head{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px}'
    + '.acad-head b{font-size:12.5px}'
    + '.acad-pill{display:inline-block;padding:2px 8px;border-radius:999px;background:#ecebfa;color:#4338ca;font-weight:600;font-size:11px}'
    + '.acad-pill.warn{background:#fdeeea;color:#c2410c}'
    + '.acad-bar{height:6px;border-radius:999px;background:#e7e5f4;overflow:hidden;margin:4px 0 8px}'
    + '.acad-bar i{display:block;height:100%;border-radius:999px;background:linear-gradient(90deg,#6d5ae0,#8b7cf0)}'
    + '.acad-course{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap;margin:3px 0}'
    + '.acad-course .nm{font-weight:600}'
    + '.acad-muted{color:#6b7194}'
    + '.acad-y2{margin-top:7px;padding:7px 9px;background:#fffaf0;border:1px solid #f3e3c3;border-radius:8px}'
    + '.acad-wins{margin:2px 0 7px;padding:7px 9px;background:#f4faf1;border:1px solid #d7ecd0;border-radius:8px}'
    + '.acad-wins .q{display:block;margin-top:3px;font-style:italic;color:#4b6147}'
    + '.acad-actions{display:flex;gap:8px;margin-top:8px;align-items:center;flex-wrap:wrap}'
    + '.acad-btn2{border:1px solid #d9d6ee;background:#fff;border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer;font-weight:600;color:#3f3a75}'
    + '.acad-btn2:hover{background:#f3f1ff}'
    + 'button[data-academy-btn]{border:1px solid #d9d6ee;background:#fff;border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;font-weight:600;color:#4338ca}'
    + 'button[data-academy-btn]:hover{background:#f3f1ff}';

  function injectCss() {
    if (document.getElementById('acad-widget-css')) return;
    var st = document.createElement('style');
    st.id = 'acad-widget-css';
    st.textContent = CSS;
    document.head.appendChild(st);
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
  }

  // "+12 h/sem · +8 clients · +45 000 € CA" — KPIs non nuls uniquement.
  function winsLine(kpis) {
    var out = [];
    (kpis || []).forEach(function (k) {
      if (!k || !k.total) return;
      var n = (k.total > 0 ? '+' : '') + Number(k.total).toLocaleString('fr-FR');
      var unit = k.unit && String(k.short || '').toLowerCase().indexOf(String(k.unit).toLowerCase()) < 0 ? ' ' + k.unit : '';
      out.push(n + unit + ' ' + (k.short || k.label || ''));
    });
    return out.join(' · ');
  }

  function getToken() {
    return new Promise(function (resolve) {
      try {
        if (window.firebase && firebase.auth && firebase.auth().currentUser) {
          firebase.auth().currentUser.getIdToken().then(resolve, function () { resolve(''); });
        } else { resolve(''); }
      } catch (e) { resolve(''); }
    });
  }

  function render(panel, data) {
    var d = data.dossier;
    var h = '';
    h += '<div class="acad-head"><b>🎓 AE Academy</b>'
      + '<span class="acad-pill">' + esc(d.totals.pct) + ' %</span>'
      + '<span class="acad-muted">' + esc(d.totals.done) + '/' + esc(d.totals.total) + ' leçons</span>'
      + (d.lastActivity ? '<span class="acad-muted">· dernier signe : ' + esc(d.lastActivity) + '</span>' : '')
      + (d.totals.winsCount ? '<span class="acad-pill">🏆 ' + esc(d.totals.winsCount) + ' victoire' + (d.totals.winsCount > 1 ? 's' : '') + '</span>' : '')
      + '</div>';
    h += '<div class="acad-bar"><i style="width:' + Math.max(0, Math.min(100, d.totals.pct)) + '%"></i></div>';

    // Victoires (Vague B) : les chiffres réels de l'élève + sa dernière citation.
    var wl = winsLine(d.totals.winsKpis);
    var lastWin = null;
    for (var wi = 0; wi < d.courses.length; wi++) {
      var cw = d.courses[wi].wins;
      if (!cw || !cw.last) continue;
      for (var wj = 0; wj < cw.last.length; wj++) {
        var it = cw.last[wj];
        if (it && it.text && (!lastWin || (it.at || 0) > (lastWin.at || 0))) lastWin = it;
      }
    }
    if (wl || lastWin) {
      var q = '';
      if (lastWin && lastWin.text) {
        var t = String(lastWin.text);
        if (t.length > 110) t = t.slice(0, 108) + '…';
        q = '<span class="q">« ' + esc(t) + ' »' + (lastWin.title ? ' <span class="acad-muted">— ' + esc(lastWin.title) + '</span>' : '') + '</span>';
      }
      h += '<div class="acad-wins">🏆 <b>Victoires :</b> ' + (wl ? esc(wl) : '') + q + '</div>';
    }

    var y2total = 0, y2names = [];
    for (var i = 0; i < d.courses.length; i++) {
      var c = d.courses[i];
      h += '<div class="acad-course"><span class="nm">' + esc(c.name) + '</span>'
        + '<span class="acad-pill">' + esc(c.pct) + ' %</span>'
        + '<span class="acad-muted">' + esc(c.done) + '/' + esc(c.total) + '</span>'
        + (c.milestones.total ? '<span class="acad-muted">★ ' + esc(c.milestones.reached) + '/' + esc(c.milestones.total) + '</span>' : '')
        + (c.building ? '<span class="acad-muted">🏗️ ' + esc(c.building.roomsDone) + '/' + esc(c.building.roomsTotal) + ' pièces</span>' : '')
        + (c.wins && c.wins.count ? '<span class="acad-muted">🏆 ' + esc(c.wins.count) + '</span>' : '')
        + '</div>';
      var lockedN = (c.lockedLeft && c.lockedLeft.length) || 0;
      y2total += lockedN;
      for (var k = 0; k < Math.min(lockedN, 3 - y2names.length); k++) y2names.push(c.lockedLeft[k].name);
    }

    if (y2total > 0) {
      h += '<div class="acad-y2">🔒 <b>Année 2 :</b> ' + y2total + ' module' + (y2total > 1 ? 's' : '') + ' encore verrouillé' + (y2total > 1 ? 's' : '')
        + (y2names.length ? ' <span class="acad-muted">(' + esc(y2names.join(' · ')) + (y2total > y2names.length ? '…' : '') + ')</span>' : '')
        + '</div>';
    }

    h += '<div class="acad-actions">'
      + '<button type="button" class="acad-btn2" data-acad-copy>📋 Copier le dossier</button>'
      + '<a class="acad-btn2" style="text-decoration:none" href="https://academy.adrienemily.com/suivi/' + encodeURIComponent(d.email) + '" target="_blank" rel="noreferrer">Fiche Academy ↗</a>'
      + '</div>';

    panel.innerHTML = h;
    var btn = panel.querySelector('[data-acad-copy]');
    if (btn) btn.addEventListener('click', function () {
      try {
        navigator.clipboard.writeText(data.text || '').then(function () {
          btn.textContent = '✅ Copié';
          setTimeout(function () { btn.textContent = '📋 Copier le dossier'; }, 1600);
        });
      } catch (e) { /* clipboard indisponible — sans gravité */ }
    });
  }

  function load(panel, email) {
    if (!panel || panel.dataset.acadLoaded === '1') return;
    panel.dataset.acadLoaded = '1';
    injectCss();
    panel.classList.add('acad-panel');
    panel.innerHTML = '<span class="acad-muted">🎓 Academy — chargement…</span>';

    getToken().then(function (token) {
      if (!token) {
        panel.innerHTML = '<span class="acad-muted">🎓 Academy — session expirée, recharge la page.</span>';
        panel.dataset.acadLoaded = '';
        return;
      }
      fetch('/api/academy-progress', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ email: email }),
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          if (!j) { panel.innerHTML = '<span class="acad-muted">🎓 Academy indisponible pour le moment.</span>'; panel.dataset.acadLoaded = ''; return; }
          if (j.ok === false) {
            panel.innerHTML = '<span class="acad-muted">🎓 ' + (j.error === 'bridge_not_configured' ? 'Pont Academy non configuré (variables Vercel).' : 'Academy indisponible pour le moment.') + '</span>';
            panel.dataset.acadLoaded = '';
            return;
          }
          if (!j.found) { panel.innerHTML = '<span class="acad-muted">🎓 Aucun compte Academy pour cet e-mail.</span>'; return; }
          render(panel, j);
        })
        .catch(function () {
          panel.innerHTML = '<span class="acad-muted">🎓 Academy indisponible pour le moment.</span>';
          panel.dataset.acadLoaded = '';
        });
    });
  }

  // Délégation : un bouton [data-academy-btn] ouvre/ferme le panneau
  // [data-academy-panel] du même e-mail (dans la même carte) et le charge.
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-academy-btn]') : null;
    if (!btn) return;
    ev.preventDefault();
    ev.stopPropagation(); // la carte hôte peut avoir son propre clic (ouverture fiche)
    var em = btn.getAttribute('data-em') || '';
    if (!em) return;
    var scope = btn.closest('[data-academy-scope]') || document;
    var panel = null;
    var candidates = scope.querySelectorAll('[data-academy-panel]');
    for (var i = 0; i < candidates.length; i++) {
      if ((candidates[i].getAttribute('data-em') || '') === em) { panel = candidates[i]; break; }
    }
    if (!panel) return;
    var hidden = panel.style.display === 'none' || !panel.style.display;
    panel.style.display = hidden ? 'block' : 'none';
    if (hidden) load(panel, em);
  });

  window.AcademyWidget = { load: load };
})();
