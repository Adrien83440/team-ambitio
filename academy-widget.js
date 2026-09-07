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
// envoyé à NOS endpoints /api/academy-* (rôles admin/coach/csm). Le widget ne
// parle jamais directement à l'Academy et ne voit aucun secret.
//
// Depuis le 07/09/2026, la section « Parcours Elite » n'est plus seulement
// une lecture : admin et coach y CONSTATENT les jalons et y VALIDENT les
// étapes (fiche 07), via /api/academy-jalon et /api/academy-validation. La
// CSM garde la lecture seule — le serveur décide (champ « peutAgir »).
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
    + '.acad-status-off{color:#c2410c;font-weight:700}'
    /* Les actes du coach dans le parcours : constat de jalon, fiche d'étape. */
    + '.acad-mini{padding:2px 8px;font-size:11px;margin-left:auto}'
    + '.acad-form{flex:1 1 100%;width:100%;box-sizing:border-box;margin-top:7px;padding:8px 10px;border:1px solid #e4e1f7;background:#fbfaff;border-radius:8px;font-size:11.5px;font-weight:400}'
    + '.acad-inp{width:100%;box-sizing:border-box;border:1px solid #d9d6ee;border-radius:8px;padding:4px 8px;font-size:11.5px;background:#fff;font-family:inherit}'
    + '.acad-scroll{overflow-x:auto;margin-top:6px}'
    + '.acad-tbl{width:100%;min-width:520px;border-collapse:collapse;font-size:11.5px}'
    + '.acad-tbl th{text-align:left;font-weight:700;color:#6b7194;padding:3px 4px;border-bottom:1px solid #e4e1f7;white-space:nowrap}'
    + '.acad-tbl td{padding:3px 4px;vertical-align:top}'
    + '.acad-tbl input,.acad-tbl select{width:100%;box-sizing:border-box;border:1px solid #d9d6ee;border-radius:6px;padding:3px 6px;font-size:11.5px;background:#fff;font-family:inherit}'
    + '.acad-msg{margin-top:5px;font-weight:600;min-height:1em}'
    + '.acad-manques{margin:3px 0 0 16px;padding:0;color:#c2410c}'
    + '.acad-form button:disabled{opacity:.55;cursor:default}';

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

  /* LE JETON, QUEL QUE SOIT LE SDK DE LA PAGE. Deux SDK Firebase coexistent
     dans Team Alteor : compat (pages sales et CSM, objet global `firebase`)
     et modulaire v10 (pages coaching, qui exposent `window._auth`). Le
     widget ne regardait que le premier : dans la fiche coaching, il ne
     trouvait jamais de jeton et affichait « session expirée » à chaque
     ouverture, alors que la session était parfaitement valide. */
  function getToken() {
    return new Promise(function (resolve) {
      try {
        var user = null;
        if (window.firebase && firebase.auth && firebase.auth().currentUser) {
          user = firebase.auth().currentUser;
        } else if (window._auth && window._auth.currentUser) {
          user = window._auth.currentUser;
        }
        if (user && user.getIdToken) user.getIdToken().then(resolve, function () { resolve(''); });
        else resolve('');
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

    // V13 « Les Braises » : points + niveau, et les récompenses réclamées.
    if (d.points) {
      h += '<div class="acad-wins" style="background:#fff7ed;border-color:#f3dcc3">🔥 <b>' + Number(d.points.total || 0).toLocaleString('fr-FR') + ' pts</b>'
        + (d.points.level && d.points.level.name ? ' · <b>' + esc(d.points.level.name) + '</b>' : '') + '</div>';
      var claims = d.points.claims || [];
      for (var pc = 0; pc < claims.length; pc++) {
        var cl = claims[pc];
        var when = cl.at ? new Date(cl.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) : '';
        h += '<div class="acad-win" style="border-color:#f3dcc3;background:#fffaf3">'
          + '<span class="wt">🎁 ' + esc(cl.name) + (cl.reward ? ' — ' + esc(cl.reward) : '') + '</span>'
          + (when ? ' <span class="acad-muted">· réclamée le ' + when + '</span>' : '')
          + (cl.status === 'done'
            ? ' <span style="color:#3d7a34;font-weight:700">✓ honorée</span>'
            : ' <span style="color:#c2410c;font-weight:700">à honorer</span>'
              + '<button type="button" class="acad-btn-ok" style="display:none;margin-left:8px" data-acad-honor="' + esc(cl.palierId) + '" data-nm="' + esc(cl.name) + '">Marquer honorée</button>')
          + '</div>';
      }
    }

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
    // V13 : révèle et branche les boutons « Marquer honorée » (réservés
    // admin/csm — l'endpoint refuse de toute façon les autres rôles).
    var honors = panel.querySelectorAll('[data-acad-honor]');
    for (var hb = 0; hb < honors.length; hb++) (function (btn) {
      if (btn.dataset.wired === '1') return;
      btn.dataset.wired = '1';
      btn.style.display = 'inline-block';
      btn.addEventListener('click', function () {
        if (!confirm('Marquer la récompense « ' + (btn.getAttribute('data-nm') || '') + ' » comme honorée pour ' + email + ' ?')) return;
        btn.disabled = true;
        apiAccess({ action: 'reward-done', email: email, palierId: btn.getAttribute('data-acad-honor'), palierName: btn.getAttribute('data-nm') || '', clientId: clientIdFor(panel) }).then(function () {
          btn.outerHTML = ' <span style="color:#3d7a34;font-weight:700">✓ honorée</span>';
        });
      });
    })(honors[hb]);

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

  /* ══════════════════════════════════════════════════════════════════════
     LE PARCOURS ELITE, DANS LA FICHE — milestones, étapes, outils.

     Section à part, chargée après le reste : ces données viennent d'un AUTRE
     pont (/api/bridge/etat-parcours), et un client qui n'est pas sur le nouveau
     parcours n'en a aucune. Elle s'AJOUTE donc au panneau et ne conditionne
     rien : si elle ne répond pas, tout le reste s'affiche quand même. Même
     principe que la section « Gérer l'accès ».

     Le coach n'a plus à changer d'onglet pour savoir si l'outil 03 est rempli.

     ET DEPUIS LE 07/09/2026, IL N'A PLUS À EN CHANGER POUR AGIR. Quand la
     réponse porte « peutAgir » (admin et coach — jamais la CSM), chaque jalon
     offre « Constater » et chaque étape ouverte offre « Valider » :
       · le constat : atteint / partiellement / manqué, avec sa cause —
         obligatoire pour « manqué », l'Academy refuse sans elle ;
       · la fiche d'étape : notation 0-3 de chaque livrable, rendu avant la
         séance, commentaire, date — la décision est CALCULÉE depuis les notes,
         et « Trancher » l'applique. Une étape dont les outils ne sont pas
         complets ne sera pas validée : l'Academy le refuse, on affiche pourquoi.
     Les règles vivent dans l'Academy (lib/ep/actes.js) ; ici on ne fait que
     saisir, envoyer et relire. Le barème et les conséquences d'une décision
     arrivent avec la fiche — rien n'est recopié.
     ══════════════════════════════════════════════════════════════════════ */

  /* Les états d'étape arrivent BRUTS (destinés à l'équipe). On les rend
     lisibles sans les adoucir : « bloquante » doit se voir. */
  var ETAT_ETAPE = {
    validee: { t: 'validée', c: '#3d7a34' },
    en_cours: { t: 'en cours', c: '#4338ca' },
    a_completer: { t: 'à compléter', c: '#c2410c' },
    bloquante: { t: 'bloquante', c: '#b91c1c' },
    soumise: { t: 'soumise', c: '#7c3aed' },
    verrouillee: { t: 'verrouillée', c: '#6b7280' },
  };
  var STATUT_JALON = {
    atteint: { t: '✓ atteint', c: '#3d7a34' },
    partiel: { t: '~ en partie', c: '#c2410c' },
    manque: { t: '✗ manqué', c: '#b91c1c' },
    a_venir: { t: 'à venir', c: '#6b7280' },
  };
  /* La décision calculée par l'Academy (calculs.js) — mêmes clés. */
  var LIBELLE_DECISION = { validee: 'Validée', a_completer: 'À compléter', bloquant: 'Bloquante' };
  var COULEUR_DECISION = { validee: '#3d7a34', a_completer: '#c2410c', bloquant: '#b91c1c' };

  /* Jamais new Date() sur une date nue « AAAA-MM-JJ » : selon le navigateur
     elle est lue en UTC, et le 1er mars s'affiche « 28 février ». */
  function jourFr(iso) {
    var m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    return m ? Number(m[3]) + '/' + m[2] : '';
  }

  /* Un POST authentifié vers nos relais. Toujours un objet en retour, jamais
     une exception : la fiche affiche le message, elle ne casse pas. */
  function apiParcours(path, payload) {
    return getToken().then(function (token) {
      if (!token) return { ok: false, error: 'session_expiree' };
      return fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify(payload),
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) { return (j && typeof j === 'object') ? j : { ok: false, error: 'academy_unreachable' }; });
    }).catch(function () { return { ok: false, error: 'academy_unreachable' }; });
  }

  /* Le message vient de l'Academy quand elle en donne un (« Un jalon manqué
     demande une cause… ») ; sinon on traduit le code. */
  var MESSAGES = {
    forbidden: 'Réservé aux coachs et administrateurs.',
    bridge_not_configured: 'Pont Academy non configuré (variables Vercel).',
    academy_unreachable: 'Academy indisponible pour le moment.',
    session_expiree: 'Session expirée, recharge la page.',
    v2_required: 'Ce client n\'est pas sur le parcours à étapes.',
    donnees_invalides: 'Données invalides.',
    unauthorized: 'Pont Academy refusé : clé invalide.',
  };
  function messageErreur(j) {
    if (!j) return MESSAGES.academy_unreachable;
    if (j.ok === true && j.found === false) return 'Aucun compte Academy pour cet e-mail.';
    if (j.message) return String(j.message);
    return MESSAGES[j.error] || ('Erreur : ' + (j.error || 'inconnue'));
  }

  function panelDe(el) {
    return (el && el.closest) ? el.closest('[data-academy-panel]') : null;
  }
  function setMsg(zone, texte, ok) {
    var m = zone.querySelector('[data-acad-msg]');
    if (!m) return;
    m.textContent = texte || '';
    m.style.color = ok ? '#3d7a34' : '#b91c1c';
  }
  function verrouiller(zone, oui) {
    var b = zone.querySelectorAll('button');
    for (var i = 0; i < b.length; i++) b[i].disabled = !!oui;
  }
  function options(liste, valeur) {
    var h = '';
    for (var i = 0; i < liste.length; i++) {
      var v = liste[i];
      h += '<option value="' + esc(v) + '"' + (String(valeur) === v ? ' selected' : '') + '>' + (v === '' ? '—' : esc(v)) + '</option>';
    }
    return h;
  }

  /* ── Le constat d'un jalon ─────────────────────────────────────────── */
  function formJalon(cause) {
    return '<div class="acad-form" data-acad-jalon-form>'
      + '<div class="acad-muted" style="margin-bottom:4px">Le constat se pose <b>en séance</b>. Un jalon manqué exige une cause — sans elle, personne ne saura quoi corriger.</div>'
      + '<input class="acad-inp" data-acad-cause placeholder="Cause — obligatoire pour « manqué », utile partout ailleurs" value="' + esc(cause) + '">'
      + '<div class="acad-actions" style="margin-top:6px">'
      + '<button type="button" class="acad-btn-ok" data-acad-constat="atteint">Atteint</button>'
      + '<button type="button" class="acad-btn2" data-acad-constat="partiel">Partiellement</button>'
      + '<button type="button" class="acad-btn-danger" data-acad-constat="manque">Manqué</button>'
      + '<button type="button" class="acad-btn2" data-acad-fermer>Annuler</button>'
      + '</div><div class="acad-msg" data-acad-msg></div></div>';
  }

  /* ── La fiche de validation d'une étape (outil 07) ─────────────────── */
  function formFiche(f) {
    var ev = f.evaluation || {};
    var liv = ev.livrables || [];
    var bareme = f.bareme || {};
    var c = f.completude || {};
    var h = '<div class="acad-form" data-acad-fiche>';
    h += '<div class="acad-muted"><b>Livrables attendus :</b> ' + esc(f.etape.livrable) + '</div>';
    if (f.etape.victoire) h += '<div class="acad-muted" style="margin-top:2px"><b>Critère de validation :</b> ' + esc(f.etape.victoire) + '</div>';

    /* La complétude des outils : le verrou qui ne se contourne pas. */
    h += '<div style="margin-top:6px;color:' + (c.ok ? '#3d7a34' : '#c2410c') + '"><b>Complétude des outils ' + esc(c.nbOk) + '/' + esc(c.nbTotal) + '</b> — '
      + (c.ok ? 'tous les livrables requis sont complets.' : 'ne se contourne pas :') + '</div>';
    var manques = c.manques || [];
    if (!c.ok && manques.length) {
      h += '<ul class="acad-manques">';
      for (var mi = 0; mi < manques.length; mi++) h += '<li>' + esc(manques[mi]) + '</li>';
      h += '</ul>';
    }

    /* Le barème, tel que l'Academy le définit. */
    var cles = Object.keys(bareme);
    if (cles.length) {
      var bl = [];
      for (var bi = 0; bi < cles.length; bi++) bl.push(cles[bi] + ' ' + String(bareme[cles[bi]]).split('—')[0].trim());
      h += '<div class="acad-muted" style="margin-top:6px">Barème : ' + esc(bl.join(' · ')) + '. Un livrable non noté ne tire pas la moyenne vers le bas.</div>';
    }

    h += '<div class="acad-scroll"><table class="acad-tbl"><thead><tr><th>Livrable</th><th>Rendu avant la séance</th><th>Score</th><th>Commentaire</th></tr></thead><tbody>';
    for (var i = 0; i < liv.length; i++) {
      var l = liv[i] || {};
      var sc = (l.score == null) ? '' : String(l.score);
      h += '<tr data-acad-liv="' + i + '">'
        + '<td style="min-width:200px"><input data-acad-f="libelle" value="' + esc(l.libelle) + '"></td>'
        + '<td style="width:90px"><select data-acad-f="renduAvantSeance">' + options(['', 'Oui', 'Non'], l.renduAvantSeance || '') + '</select></td>'
        + '<td style="width:60px"><select data-acad-f="score" title="' + esc(bareme[sc] || '') + '">' + options(['', '0', '1', '2', '3'], sc) + '</select></td>'
        + '<td style="min-width:160px"><input data-acad-f="commentaire" value="' + esc(l.commentaire) + '"></td>'
        + '</tr>';
    }
    h += '</tbody></table></div>';

    h += '<div class="acad-actions">'
      + '<label class="acad-muted">Date de la séance <input type="date" class="acad-inp" style="width:auto;display:inline-block" data-acad-date value="' + esc(ev.date || '') + '"></label>'
      + '<span>Décision calculée : <b data-acad-decision>—</b> <span class="acad-muted" data-acad-moyenne></span></span>'
      + '</div>'
      + '<div class="acad-muted" data-acad-suite></div>'
      + '<div class="acad-actions">'
      + '<button type="button" class="acad-btn2" data-acad-noter>Enregistrer la notation</button>'
      + '<button type="button" class="acad-btn-ok" data-acad-trancher>Trancher et appliquer</button>'
      + '<button type="button" class="acad-btn2" data-acad-fermer>Fermer</button>'
      + '</div><div class="acad-msg" data-acad-msg></div>';

    var hist = (f.etape && f.etape.historique) || [];
    if (hist.length) {
      h += '<div class="acad-muted" style="margin-top:6px"><b>Historique :</b> ';
      var parts = [];
      for (var hi = hist.length - 1; hi >= 0; hi--) {
        var x = hist[hi];
        parts.push((x.at ? new Date(x.at).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' }) + ' ' : '')
          + (LIBELLE_DECISION[x.decision] || x.decision)
          + (x.moyenne == null ? '' : ' (' + Number(x.moyenne).toFixed(2) + ')')
          + (x.coach ? ' · ' + x.coach : ''));
      }
      h += esc(parts.join(' — ')) + '</div>';
    }
    h += '</div>';
    return h;
  }

  /* La décision, recalculée à chaque note — mêmes seuils que l'Academy
     (reçus avec la fiche). Le serveur recalcule de son côté : ceci n'est
     qu'un aperçu, pas une décision. */
  function decisionLocale(form) {
    var f = form._acadFiche || {};
    var r = f.reglages || {};
    var sv = typeof r.seuilValide === 'number' ? r.seuilValide : 2.5;
    var sa = typeof r.seuilACompleter === 'number' ? r.seuilACompleter : 1.5;
    var sels = form.querySelectorAll('select[data-acad-f="score"]');
    var notes = [];
    for (var i = 0; i < sels.length; i++) if (sels[i].value !== '') notes.push(Number(sels[i].value));
    if (!notes.length) return { decision: '', moyenne: null };
    var somme = 0;
    for (var k = 0; k < notes.length; k++) somme += notes[k];
    var m = somme / notes.length;
    return { decision: m >= sv ? 'validee' : (m >= sa ? 'a_completer' : 'bloquant'), moyenne: m };
  }

  function afficherDecision(form) {
    var d = decisionLocale(form);
    var f = form._acadFiche || {};
    var el = form.querySelector('[data-acad-decision]');
    var moy = form.querySelector('[data-acad-moyenne]');
    var suite = form.querySelector('[data-acad-suite]');
    if (el) {
      el.textContent = d.decision ? LIBELLE_DECISION[d.decision] : 'en attente de notation';
      el.style.color = d.decision ? COULEUR_DECISION[d.decision] : '#6b7194';
    }
    if (moy) moy.textContent = d.moyenne == null ? '' : '· score moyen ' + d.moyenne.toFixed(2) + ' / 3';
    if (suite) {
      var txt = d.decision ? ((f.actions || {})[d.decision] || '') : '';
      if (d.decision === 'validee' && f.completude && !f.completude.ok) {
        txt += (txt ? ' ' : '') + '⚠ Les outils ne sont pas complets : la validation sera refusée.';
        suite.style.color = '#c2410c';
      } else {
        suite.style.color = '';
      }
      suite.textContent = txt;
    }
  }

  /* Ce qu'on renvoie à l'Academy : les livrables tels que saisis, la date, et
     les champs de preuve chiffrée REPRIS de la fiche reçue — ils ne sont pas
     édités ici, ils ne doivent pas être effacés pour autant. */
  function lireEvaluation(form) {
    var f = form._acadFiche || {};
    var ev = f.evaluation || {};
    var rows = form.querySelectorAll('tr[data-acad-liv]');
    var liv = [];
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      var q = function (n) { var e = r.querySelector('[data-acad-f="' + n + '"]'); return e ? e.value : ''; };
      liv.push({ libelle: q('libelle'), renduAvantSeance: q('renduAvantSeance'), score: q('score'), commentaire: q('commentaire') });
    }
    var date = form.querySelector('[data-acad-date]');
    return {
      date: date ? date.value : (ev.date || ''),
      preuveIndicateur: ev.preuveIndicateur || '',
      preuveDepart: ev.preuveDepart == null ? '' : ev.preuveDepart,
      preuveArrivee: ev.preuveArrivee == null ? '' : ev.preuveArrivee,
      livrables: liv,
    };
  }

  /* Enregistrer la notation, puis — si demandé — trancher. Deux appels, dans
     cet ordre : trancher sans avoir enregistré appliquerait les notes d'avant. */
  function noterEtape(form, panel, email, puisTrancher) {
    var row = form.closest('[data-acad-etape-row]');
    var cle = row ? row.getAttribute('data-acad-etape-row') : '';
    verrouiller(form, true);
    setMsg(form, puisTrancher ? 'Enregistrement, puis décision…' : 'Enregistrement…', true);
    apiParcours('/api/academy-validation', { email: email, etape: cle, action: 'noter', evaluation: lireEvaluation(form) })
      .then(function (j) {
        if (!j || j.ok !== true) { verrouiller(form, false); setMsg(form, messageErreur(j), false); return null; }
        form._acadFiche = j;
        if (!puisTrancher) {
          verrouiller(form, false);
          setMsg(form, 'Notation enregistrée.', true);
          afficherDecision(form);
          return null;
        }
        return apiParcours('/api/academy-validation', { email: email, etape: cle, action: 'decider' })
          .then(function (k) {
            if (!k || k.ok !== true) {
              verrouiller(form, false);
              var t = messageErreur(k);
              if (k && k.manques && k.manques.length) t += ' — ' + k.manques.join(' · ');
              setMsg(form, t, false);
              return;
            }
            setMsg(form, 'Décision appliquée : ' + (LIBELLE_DECISION[k.appliquee] || k.appliquee) + (k.instantanePris ? ' · instantané pris.' : '.'), true);
            /* On relit tout : l'état de l'étape, et l'étape suivante qui vient
               peut-être de s'ouvrir. Un court délai pour lire le message. */
            setTimeout(function () { reloadParcours(panel, email); }, 900);
          });
      });
  }

  function renderParcours(panel, d) {
    var agit = d.peutAgir === true;
    var h = '<div class="acad-head" style="margin-top:10px;border-top:1px solid #ece9f7;padding-top:9px">'
      + '<b>🎯 Parcours Elite</b>'
      + '<span class="acad-pill">' + esc(d.outils.remplis) + '/' + esc(d.outils.total) + ' outils</span>'
      + (d.credits ? '<span class="acad-muted">· ' + esc(d.credits.consommees) + '/' + esc(d.credits.total) + ' séances</span>' : '')
      + (d.plan && d.plan.recu
        ? '<span class="acad-pill" style="background:#ecfdf5;color:#065f46">plan reçu</span>'
        : '<span class="acad-pill" style="background:#fef3c7;color:#92400e">plan non poussé</span>')
      + '</div>';

    /* LE CAP. S'il s'affiche, c'est la preuve que le plan est bien arrivé
       jusqu'à l'écran du client. */
    if (d.plan && (d.plan.pointA || d.plan.pointB)) {
      h += '<div class="acad-wins" style="background:#f5f3ff;border-color:#ddd6fe">'
        + (d.plan.pointA ? '<div><b>A :</b> ' + esc(d.plan.pointA) + '</div>' : '')
        + (d.plan.pointB ? '<div style="margin-top:3px"><b>B :</b> ' + esc(d.plan.pointB) + '</div>' : '')
        + '</div>';
    }

    /* LES MILESTONES, avec la date que le client voit VRAIMENT. Le repère
       « perso » signale ceux que le plan a déplacés : sans lui, impossible de
       distinguer « le plan dit J+140 » de « personne n'a rien décidé ».
       Avec « peutAgir », chaque ligne porte son bouton de constat. */
    var js = d.jalons || [];
    for (var i = 0; i < js.length; i++) {
      var j = js[i];
      var st = STATUT_JALON[j.statut] || STATUT_JALON.a_venir;
      var retard = j.enRetard && j.statut === 'a_venir';
      h += '<div class="acad-win" data-acad-jalon-row="' + esc(j.code) + '" data-cause="' + esc(j.cause || '') + '" style="border-color:' + (retard ? '#f3dcc3' : '#ece9f7') + ';background:' + (retard ? '#fffaf3' : '#fff') + '">'
        + '<div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">'
        + '<span class="wt">' + esc(j.code) + ' · ' + esc(j.objectif) + '</span>'
        + ' <span class="acad-muted">' + esc(jourFr(j.dateCible)) + '</span>'
        + (j.personnalise ? ' <span class="acad-pill" style="background:#eef2ff;color:#4338ca">perso</span>' : '')
        + ' <span style="color:' + st.c + ';font-weight:700">' + st.t + '</span>'
        + (retard ? ' <span style="color:#c2410c;font-weight:700">· à rattraper</span>' : '')
        + (j.nbOutils ? ' <span class="acad-muted">· ' + esc(j.nbOutilsFaits) + '/' + esc(j.nbOutils) + ' outils</span>' : '')
        + (agit ? '<button type="button" class="acad-btn2 acad-mini" data-acad-jalon="' + esc(j.code) + '">' + (j.statut === 'a_venir' ? 'Constater' : 'Revoir') + '</button>' : '')
        + '</div>'
        + (j.cause ? '<div class="acad-muted" style="margin-top:2px">cause : ' + esc(j.cause) + '</div>' : '')
        + '</div>';
    }

    /* LES ÉTAPES : ce qui s'installe, et ce qui bloque. Avec « peutAgir »,
       une étape ouverte et non validée porte « Valider » — la fiche 07 se
       déplie dessous. Une étape verrouillée n'a rien à valider : sa
       précédente ne l'est pas encore. */
    var es = d.etapes || [];
    if (es.length) {
      h += '<div class="acad-muted" style="margin-top:7px;font-weight:700">Étapes · '
        + esc(d.validees) + '/' + esc(d.total) + ' validées</div>';
      for (var k = 0; k < es.length; k++) {
        var e = es[k];
        var ee = ETAT_ETAPE[e.etat] || { t: e.etat || '—', c: '#6b7280' };
        var validable = agit && e.ouverte && e.etat !== 'validee';
        h += '<div class="acad-wb" data-acad-etape-row="' + esc(e.cle) + '"><span>' + (e.cle === d.etapeCourante ? '▸' : '·') + '</span>'
          + '<span class="t">' + esc(e.titre) + '</span>'
          + '<span style="color:' + ee.c + ';font-weight:700">' + esc(ee.t) + '</span>'
          + (validable ? '<button type="button" class="acad-btn2 acad-mini" data-acad-etape="' + esc(e.cle) + '">Valider</button>' : '')
          + '</div>';
      }
    }

    /* LES SIX OUTILS : complet, ou son avancement. C'est ce qui prouve un
       milestone — le coach doit le lire sans quitter sa fiche. */
    var os = (d.outils && d.outils.detail) || [];
    for (var o = 0; o < os.length; o++) {
      var ou = os[o];
      h += '<div class="acad-wb"><span>' + (ou.complet ? '✅' : '⬜') + '</span>'
        + '<span class="t">' + esc(ou.numero) + ' · ' + esc(ou.nom) + '</span>'
        + (ou.complet
          ? '<span style="color:#3d7a34;font-weight:700">complet</span>'
          : '<span class="acad-muted">' + esc(ou.nbOk) + '/' + esc(ou.nbTotal) + '</span>')
        + '</div>';
    }

    var hote = document.createElement('div');
    hote.setAttribute('data-acad-parcours', '1');
    hote.innerHTML = h;
    panel.appendChild(hote);
  }

  function loadParcours(panel, email) {
    if (panel.dataset.acadEpLoaded === '1') return;
    panel.dataset.acadEpLoaded = '1';
    getToken().then(function (token) {
      if (!token) return;
      fetch('/api/academy-etat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ email: email }),
      })
        .then(function (r) { return r.json().catch(function () { return null; }); })
        .then(function (j) {
          /* Silencieux dans tous les cas négatifs : un client hors du nouveau
             parcours n'a rien à montrer ici, et ce n'est pas une anomalie. */
          if (!j || j.ok !== true || !j.found) return;
          if (j.version !== 'v2_6mois') return;
          try { renderParcours(panel, j); } catch (e) { console.error('[academy-etat] rendu', e); }
        })
        .catch(function (e) { console.error('[academy-etat]', e); });
    });
  }

  /* Après un acte, on relit l'état : l'Academy a peut-être ouvert l'étape
     suivante, ou changé un statut. On retire la section et on la recharge. */
  function reloadParcours(panel, email) {
    var old = panel.querySelector('[data-acad-parcours]');
    if (old && old.parentNode) old.parentNode.removeChild(old);
    panel.dataset.acadEpLoaded = '';
    loadParcours(panel, email);
  }

  /* Délégation unique pour tous les actes du parcours. Les boutons sont
     rendus par innerHTML et re-rendus après chaque acte : un écouteur par
     bouton serait perdu à chaque rechargement. */
  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var panel = panelDe(t);
    if (!panel) return;
    var email = panel.getAttribute('data-em') || '';
    var b, row, existant, div;

    /* Ouvrir / refermer le constat d'un jalon. */
    b = t.closest('[data-acad-jalon]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      row = b.closest('[data-acad-jalon-row]');
      if (!row) return;
      existant = row.querySelector('[data-acad-jalon-form]');
      if (existant) { existant.parentNode.removeChild(existant); return; }
      div = document.createElement('div');
      div.innerHTML = formJalon(row.getAttribute('data-cause') || '');
      row.appendChild(div.firstChild);
      var inp = row.querySelector('[data-acad-cause]');
      if (inp) inp.focus();
      return;
    }

    /* Poser le constat. */
    b = t.closest('[data-acad-constat]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var form = b.closest('[data-acad-jalon-form]');
      row = b.closest('[data-acad-jalon-row]');
      if (!form || !row || !email) return;
      var causeEl = form.querySelector('[data-acad-cause]');
      var charge = {
        email: email,
        code: row.getAttribute('data-acad-jalon-row'),
        statut: b.getAttribute('data-acad-constat'),
        cause: causeEl ? causeEl.value : '',
      };
      verrouiller(form, true);
      setMsg(form, 'Enregistrement…', true);
      apiParcours('/api/academy-jalon', charge).then(function (j) {
        if (!j || j.ok !== true || j.found === false) { verrouiller(form, false); setMsg(form, messageErreur(j), false); return; }
        setMsg(form, 'Constat enregistré.', true);
        setTimeout(function () { reloadParcours(panel, email); }, 500);
      });
      return;
    }

    /* Fermer un formulaire (constat ou fiche). */
    b = t.closest('[data-acad-fermer]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var fm = b.closest('.acad-form');
      if (fm && fm.parentNode) fm.parentNode.removeChild(fm);
      return;
    }

    /* Ouvrir la fiche de validation d'une étape. */
    b = t.closest('[data-acad-etape]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      row = b.closest('[data-acad-etape-row]');
      if (!row || !email) return;
      existant = row.querySelector('[data-acad-fiche]');
      if (existant) { existant.parentNode.removeChild(existant); return; }
      var ancien = row.querySelector('[data-acad-msg-etape]');
      if (ancien) ancien.parentNode.removeChild(ancien);
      b.disabled = true; b.textContent = 'Chargement…';
      apiParcours('/api/academy-validation', { email: email, etape: b.getAttribute('data-acad-etape'), action: 'lire' })
        .then(function (j) {
          b.disabled = false; b.textContent = 'Valider';
          if (!j || j.ok !== true || j.found === false || !j.etape) {
            var m = document.createElement('div');
            m.className = 'acad-msg';
            m.setAttribute('data-acad-msg-etape', '1');
            m.style.cssText = 'flex:1 1 100%;color:#b91c1c';
            m.textContent = messageErreur(j);
            row.appendChild(m);
            return;
          }
          var d2 = document.createElement('div');
          d2.innerHTML = formFiche(j);
          var fiche = d2.firstChild;
          fiche._acadFiche = j;
          row.appendChild(fiche);
          afficherDecision(fiche);
        });
      return;
    }

    /* Enregistrer la notation, ou trancher. */
    b = t.closest('[data-acad-noter]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var f1 = b.closest('[data-acad-fiche]');
      if (f1 && email) noterEtape(f1, panel, email, false);
      return;
    }
    b = t.closest('[data-acad-trancher]');
    if (b) {
      ev.preventDefault(); ev.stopPropagation();
      var f2 = b.closest('[data-acad-fiche]');
      if (f2 && email) noterEtape(f2, panel, email, true);
      return;
    }
  });

  /* La décision calculée suit chaque note, sans attendre l'enregistrement. */
  document.addEventListener('change', function (ev) {
    var t = ev.target;
    var form = (t && t.closest) ? t.closest('[data-acad-fiche]') : null;
    if (form) afficherDecision(form);
  });

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
          loadParcours(panel, email); // 🎯 Parcours Elite : milestones, étapes, outils
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
