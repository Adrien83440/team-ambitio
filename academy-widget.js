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
    + 'button[data-academy-btn]:hover{background:#f3f1ff}'
    + '.acad-win{border:1px solid #d7ecd0;background:#fbfef9;border-radius:8px;padding:6px 9px;margin-top:5px}'
    + '.acad-win .wt{font-weight:700}'
    + '.acad-win .wq{display:block;font-style:italic;color:#4b6147;margin-top:2px}'
    + '.acad-chip{display:inline-block;margin:2px 4px 0 0;padding:1px 7px;border-radius:999px;background:#eef7ea;color:#3d7a34;font-weight:600;font-size:10.5px}'
    + '.acad-sec{margin-top:8px}'
    + '.acad-sec > b{font-size:12px}'
    + '.acad-ms{display:inline-block;margin:3px 5px 0 0;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:600;background:#efeff4;color:#6b7194}'
    + '.acad-ms.on{background:#e8f5e5;color:#3d7a34}'
    + '.acad-wb{display:flex;align-items:center;gap:7px;flex-wrap:wrap;border:1px solid #e4e1f7;background:#fff;border-radius:8px;padding:5px 9px;margin-top:5px;font-size:11.5px}'
    + '.acad-wb .t{font-weight:700;color:#1f2340}'
    + '.acad-more{border:none;background:none;color:#4338ca;font-weight:700;font-size:11px;cursor:pointer;padding:2px 0;margin-top:4px}'
    + '.acad-mgr{margin-top:10px;padding:9px 11px;border:1px solid #e4e1f7;background:#fff;border-radius:10px}'
    + '.acad-mgr .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:6px}'
    + '.acad-mgr select{border:1px solid #d9d6ee;border-radius:8px;padding:4px 8px;font-size:11.5px;max-width:220px}'
    + '.acad-btn-danger{border:1px solid #f3c9bd;background:#fdeeea;color:#c2410c;border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer;font-weight:700}'
    + '.acad-btn-ok{border:1px solid #cfe8c9;background:#f4faf1;color:#3d7a34;border-radius:8px;padding:4px 10px;font-size:11.5px;cursor:pointer;font-weight:700}'
    + '.acad-status-on{color:#3d7a34;font-weight:700}'
    + '.acad-status-off{color:#c2410c;font-weight:700}';

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
    if (wl) {
      h += '<div class="acad-wins">🏆 <b>Total des victoires :</b> ' + esc(wl) + '</div>';
    }

    // V12c — CSM : TOUTES les victoires (« j'ai gagné X temps / X € » en fin
    // de sujet), chacune avec la citation de l'élève et ses chiffres.
    var allWins = [];
    for (var awi = 0; awi < d.courses.length; awi++) {
      var cwx = d.courses[awi].wins;
      var arr = (cwx && (cwx.items || cwx.last)) || [];
      for (var awj = 0; awj < arr.length; awj++) {
        var w2 = arr[awj];
        if (w2 && (w2.text || (w2.summary && w2.summary.length))) allWins.push(w2);
      }
    }
    allWins.sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
    if (allWins.length) {
      var winsHtml = '';
      for (var vw = 0; vw < allWins.length; vw++) {
        var it2 = allWins[vw];
        var dt = it2.at ? new Date(it2.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
        winsHtml += '<div class="acad-win" ' + (vw >= 4 ? 'data-acad-morewin style="display:none"' : '') + '>'
          + '<span class="wt">🏆 ' + esc(it2.title || 'Victoire') + '</span>'
          + (dt ? ' <span class="acad-muted">· ' + dt + '</span>' : '')
          + (it2.text ? '<span class="wq">« ' + esc(it2.text) + ' »</span>' : '')
          + ((it2.summary && it2.summary.length) ? '<span>' + it2.summary.map(function (sm) { return '<span class="acad-chip">' + esc(sm) + '</span>'; }).join('') + '</span>' : '')
          + '</div>';
      }
      h += '<div class="acad-sec"><b>🏆 Victoires racontées (' + allWins.length + ')</b>' + winsHtml
        + (allWins.length > 4 ? '<button type="button" class="acad-more" data-acad-showwins>Voir les ' + (allWins.length - 4) + ' autres ↓</button>' : '')
        + '</div>';
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
      // V12c — CSM : jalons détaillés (label + atteint) de la formation.
      var msItems = (c.milestones && c.milestones.items) || [];
      if (msItems.length) {
        h += '<div style="margin:2px 0 4px">';
        for (var mi = 0; mi < msItems.length; mi++) {
          var ms = msItems[mi];
          h += '<span class="acad-ms' + (ms.reached ? ' on' : '') + '">' + (ms.reached ? '✓ ' : '') + esc(ms.label)
            + (ms.reached && ms.at ? ' · ' + new Date(ms.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '') + '</span>';
        }
        h += '</div>';
      }
      // V12c — CSM : workbooks IA du client (révision, mise à jour, remplissage).
      var wbs = c.workbooks || [];
      if (wbs.length) {
        for (var wbi = 0; wbi < wbs.length; wbi++) {
          var wb = wbs[wbi];
          h += '<div class="acad-wb"><span>📓</span><span class="t">' + esc(wb.title) + '</span>'
            + '<span class="acad-muted">rév. ' + esc(wb.revision) + (wb.updatedAt ? ' · ' + new Date(wb.updatedAt).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '') + '</span>'
            + (wb.answered ? '<span class="acad-pill">✍️ ' + esc(wb.answered) + ' réponse' + (wb.answered > 1 ? 's' : '') + '</span>' : '<span class="acad-muted">pas encore rempli</span>')
            + '</div>';
        }
      }
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
    var moreBtn = panel.querySelector('[data-acad-showwins]');
    if (moreBtn) moreBtn.addEventListener('click', function () {
      var hiddenWins = panel.querySelectorAll('[data-acad-morewin]');
      for (var hw = 0; hw < hiddenWins.length; hw++) hiddenWins[hw].style.display = 'block';
      moreBtn.style.display = 'none';
    });
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

  // ── LES CLÉS (V12d) : gestion d'accès depuis le canal CSM ──
  // Rendu APRÈS le panneau d'avancement. Rôles admin/csm uniquement : si
  // l'endpoint répond 'forbidden' (coach), la section n'apparaît pas.
  function apiAccess(payload) {
    return getToken().then(function (token) {
      if (!token) return null;
      return fetch('/api/academy-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload),
      }).then(function (r) { return r.json().catch(function () { return null; }); });
    });
  }

  function clientIdFor(panel) {
    var host = panel.closest('[data-client-id]');
    return host ? (host.getAttribute('data-client-id') || '') : '';
  }

  function renderManager(panel, email, st) {
    var box = panel.querySelector('[data-acad-mgr]');
    if (!box) { box = document.createElement('div'); box.className = 'acad-mgr'; box.setAttribute('data-acad-mgr', '1'); panel.appendChild(box); }
    var authTxt = !st.auth.exists
      ? '<span class="acad-muted">pas de compte de connexion créé</span>'
      : st.auth.disabled
        ? '<span class="acad-status-off">🔴 désactivé — le client ne peut plus se connecter</span>'
        : '<span class="acad-status-on">🟢 actif</span>';
    var h = '<b>⚙️ Gérer l\'accès</b><div class="row">Compte : ' + authTxt
      + (st.auth.exists ? (st.auth.disabled
        ? ' <button type="button" class="acad-btn-ok" data-acad-platform="on">Réactiver</button>'
        : ' <button type="button" class="acad-btn-danger" data-acad-platform="off">Désactiver l\'accès</button>') : '')
      + '</div>';
    if (st.access.length) {
      h += '<div class="row">Formations ouvertes :</div>';
      for (var i = 0; i < st.access.length; i++) {
        var a = st.access[i];
        h += '<div class="row">• <b>' + esc(a.name) + '</b> <span class="acad-muted">(' + esc(a.mode === 'all' ? 'accès complet' : a.mode) + ')</span>'
          + ' <button type="button" class="acad-btn-danger" data-acad-revoke="' + esc(a.id) + '" data-nm="' + esc(a.name) + '">Retirer</button></div>';
      }
    } else {
      h += '<div class="row acad-muted">Aucune formation ouverte.</div>';
    }
    var opts = '';
    for (var ci = 0; ci < st.catalog.length; ci++) {
      var has = false;
      for (var ai = 0; ai < st.access.length; ai++) if (st.access[ai].id === st.catalog[ci].id) { has = true; break; }
      if (!has) opts += '<option value="' + esc(st.catalog[ci].id) + '">' + esc(st.catalog[ci].name) + '</option>';
    }
    if (opts) {
      h += '<div class="row"><select data-acad-grant-sel>' + opts + '</select>'
        + '<button type="button" class="acad-btn-ok" data-acad-grant>➕ Donner l\'accès</button></div>';
    }
    h += '<div class="row acad-muted" style="font-size:10.5px">Retirer un accès ou désactiver le compte ne supprime rien : progression, victoires et workbooks restent — tout revient si tu ré-ouvres.</div>';
    box.innerHTML = h;

    function refresh() { loadManager(panel, email, true); }
    var offBtn = box.querySelector('[data-acad-platform="off"]');
    if (offBtn) offBtn.addEventListener('click', function () {
      if (!confirm('Désactiver le compte Academy de ' + email + ' ?\nIl ne pourra plus se connecter (réversible à tout moment).')) return;
      offBtn.disabled = true;
      apiAccess({ action: 'platform', email: email, disabled: true, clientId: clientIdFor(panel) }).then(refresh);
    });
    var onBtn = box.querySelector('[data-acad-platform="on"]');
    if (onBtn) onBtn.addEventListener('click', function () {
      onBtn.disabled = true;
      apiAccess({ action: 'platform', email: email, disabled: false, clientId: clientIdFor(panel) }).then(refresh);
    });
    var revokes = box.querySelectorAll('[data-acad-revoke]');
    for (var rv = 0; rv < revokes.length; rv++) (function (btn) {
      btn.addEventListener('click', function () {
        var nm = btn.getAttribute('data-nm') || 'cette formation';
        if (!confirm('Retirer l\'accès à « ' + nm + ' » pour ' + email + ' ?\nSa progression est conservée.')) return;
        btn.disabled = true;
        apiAccess({ action: 'revoke', email: email, courseId: btn.getAttribute('data-acad-revoke'), clientId: clientIdFor(panel) }).then(refresh);
      });
    })(revokes[rv]);
    var grantBtn = box.querySelector('[data-acad-grant]');
    if (grantBtn) grantBtn.addEventListener('click', function () {
      var sel = box.querySelector('[data-acad-grant-sel]');
      if (!sel || !sel.value) return;
      grantBtn.disabled = true;
      apiAccess({ action: 'grant', email: email, courseId: sel.value, clientId: clientIdFor(panel) }).then(refresh);
    });
  }

  function loadManager(panel, email, force) {
    if (!force && panel.dataset.acadMgrLoaded === '1') return;
    panel.dataset.acadMgrLoaded = '1';
    apiAccess({ action: 'status', email: email }).then(function (j) {
      if (!j || j.ok !== true) return;               // forbidden / indispo → pas de section
      if (!j.found) return;                          // pas de compte Academy
      renderManager(panel, email, j);
    }).catch(function () { /* fail-soft */ });
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
          loadManager(panel, email); // V12d : section ⚙️ Gérer l'accès (admin/csm)
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
