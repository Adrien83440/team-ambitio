/* ═══════════════════════════════════════════════════════════════════════
   stats-drill.js — listes nominatives derrière les chiffres (21/11/2026)
   ───────────────────────────────────────────────────────────────────────
   Demande Vincent : « je clique sur les 7 et je vois de qui c'était ».
   Partagé par Set NB (sales-setting.html), Close SB et Global closing
   (sales-closing.html), le Stats funnel (sales-funnel.html) et le Dashboard.
   LECTURE SEULE : rien n'est écrit, aucune requête, AUCUN CALCUL — la page
   appelante fournit les lignes déjà chargées.

   Audit de cohérence du 25/11/2026 : toutes les listes parlent le même
   vocabulaire et montrent la même chose pour le même enregistrement.
     · L'état d'un RDV (mot + couleur) vient de StatsCore.libelle : aucune
       table locale. stats-core.js DOIT être chargé avant ce fichier ; s'il
       manque, une erreur claire est levée (pas de table de secours).
     · Montants : « Contracté HT », « Collecté HT », « 1er prélèvement en
       attente », et en pied de liste « Reste à encaisser » = contracté −
       collecté. Les définitions (« i ») viennent du glossaire de StatsCore.
     · Une ligne de close se fabrique avec closeItem, à partir d'UNE ligne de
       FunnelCore.buildCloses : mêmes colonnes, mêmes mots sur tous les écrans.

   Une ligne (« item ») :
     { kind ('rdv' | 'close' | 'fiche'), name, leadId, date ('AAAA-MM-JJ'),
       time, status (texte), statusColor, statusPlus (précision du statut),
       canal, setter, closer, info, con, paid, pending, conDeclare,
       flag (texte), flags (tableau de textes) }
   Les montants (con / paid / pending) sont en HT, déjà calculés par la règle
   REVENUE de funnel-core.js (FunnelCore.revClient) — jamais recalculés ici.

   API :
     StatsDrill.cell(html, ref)        → enveloppe un chiffre cliquable
     StatsDrill.bind(root, resolver)   → délégation : resolver(ref) → options
     StatsDrill.open(options)          → ouvre la liste
     StatsDrill.render(options)        → le HTML de la liste, sans l'ouvrir
     StatsDrill.bookingItem(b, ctx)    → ligne normalisée depuis un RDV
     StatsDrill.bookingStatus(b, now)  → [mot, couleur, état] d'un RDV
     StatsDrill.closeItem(ligne, ctx)  → ligne normalisée depuis un close
   ES5 strict. Dépendance : stats-core.js (window.StatsCore).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var W = (typeof window !== 'undefined') ? window : {};
  var STYLE_ID = 'sdStyle';
  var MODAL_ID = 'sdModal';
  /* Identifiant de la bulle du « i » dans stats-core.js : sert seulement à ne
     pas fermer la liste quand Échap ferme d'abord une bulle ouverte. */
  var POP_INFO_ID = 'scPop';

  var MSG_SANS_REGLES = 'stats-drill.js : stats-core.js (window.StatsCore) n\'est pas chargé sur cette page. ' +
    'Il doit être chargé AVANT stats-drill.js : les libellés et les définitions des listes viennent de lui (aucune table de secours).';

  /* Les règles communes. Lues au moment de l'appel : une page qui oublie
     stats-core.js obtient une erreur claire, jamais un libellé inventé. */
  function regles() {
    var SC = W.StatsCore;
    if (!SC || typeof SC.libelle !== 'function' || typeof SC.texte !== 'function') throw new Error(MSG_SANS_REGLES);
    return SC;
  }

  function esc(t) {
    return String(t == null ? '' : t).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtEuro(n) { return (Math.round(Number(n) || 0)).toLocaleString('fr-FR') + ' €'; }
  function frDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    return iso.slice(8, 10) + '/' + iso.slice(5, 7);
  }
  /* JJ/MM, avec l'année quand elle n'est pas celle de la date de référence. */
  function frDateRef(iso, refIso) {
    var s = frDate(iso);
    if (iso && refIso && /^\d{4}-\d{2}-\d{2}/.test(iso) && /^\d{4}-\d{2}-\d{2}/.test(refIso) && iso.slice(0, 4) !== refIso.slice(0, 4)) s += '/' + iso.slice(0, 4);
    return s;
  }
  /* « Maintenant » en millisecondes. L'ancien argument todayIso (un jour
     'AAAA-MM-JJ') n'est plus lu : un RDV est « passé » à la FIN de son créneau,
     heure de Paris (StatsCore.estPasse), plus « la veille ». */
  function nowOf(v) { return (typeof v === 'number' && isFinite(v)) ? v : Date.now(); }

  /* Peinture uniquement, par variables de thème (sombre et clair) : aucune
     couleur de surface codée en dur, donc rien à régénérer côté thème clair. */
  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.sd-click{cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:3px;text-decoration-color:var(--muted2,#596180)}' +
      '.sd-click:hover{text-decoration-style:solid;text-decoration-color:currentColor}' +
      '.sd-bg{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(3,5,14,.72);z-index:9995;display:none;align-items:center;justify-content:center;padding:20px}' +
      '.sd-bg.show{display:flex}' +
      '.sd-box{background:var(--bg2,#0e111c);color:var(--text,#eef0f8);border:1px solid var(--border2,rgba(148,163,214,.22));border-radius:18px;width:100%;max-width:1080px;max-height:88vh;display:flex;flex-direction:column;box-shadow:0 12px 36px rgba(3,5,14,.55)}' +
      /* Thème clair : les surfaces « verre » du thème sont translucides — une
         fenêtre de lecture doit être OPAQUE, sinon le tableau de la page se lit
         à travers (capture d'Adrien, 23/11/2026). */
      'body.light-theme .sd-bg{background:rgba(20,24,48,.45);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px)}' +
      'body.light-theme .sd-box{background:#ffffff;color:#14182f;border-color:rgba(20,24,48,.14);box-shadow:0 24px 60px rgba(20,24,48,.28)}' +
      'body.light-theme .sd-table th{background:#ffffff;color:#5b6180;border-bottom-color:rgba(20,24,48,.18)}' +
      'body.light-theme .sd-table td{border-bottom-color:rgba(20,24,48,.09)}' +
      'body.light-theme .sd-table tfoot td{border-top-color:rgba(20,24,48,.18)}' +
      'body.light-theme .sd-sub,body.light-theme .sd-mut,body.light-theme .sd-defx{color:#5b6180}' +
      'body.light-theme .sd-x{border-color:rgba(20,24,48,.2)}' +
      'body.light-theme .sd-table a{color:#2f55e0}' +
      'body.light-theme .sd-note,body.light-theme .sd-flag{color:#a05a00;border-color:#d08a1c}' +
      'body.light-theme .sd-def{border-color:rgba(20,24,48,.14);border-left-color:#2f55e0}' +
      '.sd-head{padding:18px 22px 10px;display:flex;gap:12px;align-items:flex-start}' +
      '.sd-head h3{margin:0;font-size:16px;font-weight:700;flex:1;line-height:1.35}' +
      '.sd-x{background:none;border:1px solid var(--border2,rgba(148,163,214,.22));color:inherit;border-radius:9px;padding:4px 10px;font-size:13px;cursor:pointer}' +
      /* Définition du chiffre cliqué (glossaire commun + précision de l'écran). */
      '.sd-def{margin:0 22px 10px;padding:9px 12px;border:1px solid var(--border2,rgba(148,163,214,.22));border-left:3px solid var(--blue,#5b7cfa);border-radius:10px;font-size:12.5px;line-height:1.5}' +
      '.sd-def b{font-weight:700}' +
      '.sd-defx{display:block;margin-top:4px;color:var(--muted,#8f97b2)}' +
      '.sd-sub{padding:0 22px 8px;font-size:12px;color:var(--muted,#8f97b2);line-height:1.5}' +
      '.sd-note{margin:0 22px 10px;padding:9px 12px;border:1px solid var(--gold,#fbbf24);border-radius:10px;font-size:12px;line-height:1.5;color:var(--gold,#fbbf24)}' +
      '.sd-body{overflow:auto;padding:0 22px 18px}' +
      '.sd-table{width:100%;border-collapse:collapse;font-size:12.5px}' +
      '.sd-table th{text-align:left;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.5px;color:var(--muted,#8f97b2);padding:8px 10px 8px 0;border-bottom:1px solid var(--border2,rgba(148,163,214,.22));white-space:nowrap;position:sticky;top:0;background:var(--bg2,#0e111c)}' +
      '.sd-table td{padding:8px 10px 8px 0;border-bottom:1px solid var(--border,rgba(148,163,214,.11));vertical-align:top}' +
      '.sd-table td.num,.sd-table th.num{text-align:right;white-space:nowrap}' +
      '.sd-table th.sd-w{white-space:normal;min-width:104px;line-height:1.3}' +
      '.sd-nw{white-space:nowrap}' +
      /* Drapeaux d'une ligne : sur toute la largeur, juste sous elle. */
      '.sd-table tr.sd-hf td{border-bottom:none;padding-bottom:2px}' +
      '.sd-table tr.sd-fl td{padding-top:0}' +
      /* Tableau plus large que l'écran (téléphone) : les drapeaux restent
         dans la partie visible au lieu de filer hors champ. */
      '.sd-fw{position:sticky;left:0;max-width:calc(100vw - 84px)}' +
      '.sd-table tfoot td{font-weight:700;border-bottom:none;border-top:1px solid var(--border2,rgba(148,163,214,.22))}' +
      '.sd-table tfoot tr.sd-reste td{border-top:none;padding-top:0}' +
      '.sd-table a{color:var(--blue,#5b7cfa);text-decoration:none;font-weight:600}' +
      '.sd-table a:hover{text-decoration:underline}' +
      '.sd-dot{display:inline-block;width:7px;height:7px;border-radius:50%;margin-right:6px;vertical-align:middle}' +
      '.sd-mut{color:var(--muted,#8f97b2)}' +
      '.sd-sm{display:block;font-size:11px;font-weight:500}' +
      '.sd-flag{display:block;font-size:11px;line-height:1.45;color:var(--gold,#fbbf24);margin-top:2px}' +
      '.sd-empty{padding:26px 0;text-align:center;color:var(--muted,#8f97b2);font-size:13px}' +
      '@media (max-width:640px){.sd-bg{padding:8px}.sd-head{padding:14px 14px 8px}.sd-def{margin:0 14px 10px}.sd-sub{padding:0 14px 8px}.sd-note{margin:0 14px 10px}.sd-body{padding:0 14px 14px}.sd-fw{max-width:calc(100vw - 44px)}}';
    var st = document.createElement('style');
    st.id = STYLE_ID;
    st.appendChild(document.createTextNode(css));
    document.head.appendChild(st);
  }

  function ensureModal() {
    var bg = document.getElementById(MODAL_ID);
    if (bg) return bg;
    bg = document.createElement('div');
    bg.id = MODAL_ID;
    bg.className = 'sd-bg';
    bg.innerHTML = '<div class="sd-box" role="dialog" aria-modal="true" aria-labelledby="sdTitle"><div class="sd-head"><h3 id="sdTitle"></h3><button type="button" class="sd-x" data-sd-close="1">Fermer ✕</button></div><div id="sdDef"></div><div class="sd-sub" id="sdSub"></div><div id="sdNote"></div><div class="sd-body" id="sdBody"></div></div>';
    document.body.appendChild(bg);
    bg.addEventListener('click', function (e) {
      var t = e.target;
      if (t === bg || (t && t.getAttribute && t.getAttribute('data-sd-close'))) close();
    });
    return bg;
  }
  function close() {
    var bg = document.getElementById(MODAL_ID);
    if (bg) bg.className = 'sd-bg';
    /* Une bulle « i » restée ouverte dans la liste se ferme avec elle. */
    if (W.StatsCore && typeof W.StatsCore.fermerInfo === 'function') W.StatsCore.fermerInfo();
  }
  /* Échap ferme la liste. Posé au chargement, en phase de capture, donc AVANT
     l'écouteur du « i » de stats-core.js : si une bulle d'explication a été
     ouverte au clic ou au clavier (le « i » a le focus), Échap ne ferme
     qu'elle (stats-core.js s'en charge) et la liste reste ; un second Échap
     ferme la liste. Une bulle ouverte au simple survol part avec la liste. */
  function onEchap(e) {
    if (!(e.key === 'Escape' || e.keyCode === 27)) return;
    var bg = document.getElementById(MODAL_ID);
    if (!bg || bg.className.indexOf('show') < 0) return;
    var p = document.getElementById(POP_INFO_ID);
    var a = document.activeElement;
    if (p && String(p.className || '').indexOf('show') >= 0 && a && a.getAttribute && a.getAttribute('data-sc-i') != null) return;
    close();
  }
  if (typeof document !== 'undefined' && document.addEventListener) document.addEventListener('keydown', onEchap, true);

  function sortItems(items) {
    return (items || []).filter(function (it) { return !!it; }).sort(function (a, b) {
      var ka = (a.date || '') + ' ' + (a.time || ''), kb = (b.date || '') + ' ' + (b.time || '');
      if (ka !== kb) return ka < kb ? -1 : 1;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });
  }

  /* Drapeaux d'une ligne : ceux posés par bookingItem / closeItem (flags),
     plus un éventuel drapeau écrit à la main par la page (flag). */
  function flagsOf(it) {
    var out = (it.flags && it.flags.length) ? it.flags.slice() : [];
    if (it.flag && out.join(' · ') !== it.flag) out.push(it.flag);
    return out;
  }
  function poser(it, texte) {
    if (!texte) return;
    it.flags.push(texte);
    it.flag = it.flags.join(' · ');
  }

  /* Le « i » de la colonne Canal : pas (encore) un terme du glossaire commun. */
  var CANAL_TXT = 'Self Booking : le prospect a réservé seul. Setting (NB) : le RDV a été posé par un setter. Manuel : RDV créé à la main dans l’Agenda. ' +
    'Pour un close, c’est le canal de son RDV closé ; sans RDV closé, la réponse du closer au moment du close, puis l’étape de la fiche.';

  /* Définition affichée sous le titre : o.info = clé du glossaire commun,
     o.infoPlus = précision propre à l'écran (texte brut). */
  function defHtml(o, SC) {
    var cle = o.info || '', plus = o.infoPlus || '';
    var t = cle ? SC.texte(cle) : '';
    if (cle && !t && typeof console !== 'undefined' && console.warn) console.warn('[StatsDrill] terme absent du glossaire : ' + cle);
    if (!t && !plus) return '';
    var m = t ? SC.mot(cle) : '';
    return '<div class="sd-def">' + (t ? (m ? '<b>' + esc(m) + '</b> — ' : '') + esc(t) : '') +
      (plus ? '<span class="sd-defx">' + esc(plus) + '</span>' : '') + '</div>';
  }

  /* Le HTML d'une liste, sans toucher au DOM.
     options : { title, sub, note, items, money, noLink, dateLabel, empty,
                 info (clé du glossaire), infoPlus (précision de l'écran) }
     → { title, def, sub, note, body, count, money } */
  function render(o) {
    o = o || {};
    var SC = regles();
    var items = sortItems(o.items);
    var n = items.length;
    /* Liste faite uniquement de closes (closeItem) : la date est le jour du
       close par construction, et les montants s'affichent d'office. */
    var tousCloses = n > 0 && items.every(function (it) { return it.kind === 'close'; });
    var money = o.money === true || (o.money == null && tousCloses);
    var showSetter = items.some(function (it) { return !!it.setter; });
    var showCloser = items.some(function (it) { return !!it.closer; });
    var showStatus = items.some(function (it) { return !!it.status; });
    var showCanal = items.some(function (it) { return !!it.canal; });
    var showInfo = items.some(function (it) { return !!it.info; });
    var showDate = items.some(function (it) { return !!it.date; });

    var out = {
      title: esc(o.title || 'Détail') + ' <span class="sd-mut" style="font-weight:500">· ' + n + ' ligne' + (n > 1 ? 's' : '') + '</span>',
      def: defHtml(o, SC),
      sub: o.sub ? esc(o.sub) : '',
      note: o.note ? '<div class="sd-note">' + esc(o.note) + '</div>' : '',
      body: '', count: n, money: money
    };

    var h = '';
    if (!n) {
      out.body = '<div class="sd-empty">' + esc(o.empty || 'Aucune ligne derrière ce chiffre.') + '</div>';
      return out;
    }
    h = '<table class="sd-table"><thead><tr><th>Nom</th>';
    if (showDate) h += '<th>' + (tousCloses ? 'Jour du close' + SC.info('closes') : esc(o.dateLabel || 'Date')) + '</th>';
    if (showStatus) h += '<th>Résultat</th>';
    if (showCanal) h += '<th>Canal' + SC.infoLibre('Canal', CANAL_TXT) + '</th>';
    if (showSetter) h += '<th>' + SC.motInfo('setter') + '</th>';
    if (showCloser) h += '<th>' + SC.motInfo('closer') + '</th>';
    if (showInfo) h += '<th>Précision</th>';
    if (money) {
      h += '<th class="num">' + esc(SC.mot('contracte')) + ' HT' + SC.info('contracte') + '</th>' +
        '<th class="num">' + esc(SC.mot('collecte')) + ' HT' + SC.info('collecte') + '</th>' +
        '<th class="num sd-w">1er prélèvement en attente' + SC.info('premiers_prelevements') + '</th>';
    }
    h += '</tr></thead><tbody>';
    /* Colonnes avant les montants, et nombre total de colonnes. */
    var span = 1 + (showDate ? 1 : 0) + (showStatus ? 1 : 0) + (showCanal ? 1 : 0) + (showSetter ? 1 : 0) + (showCloser ? 1 : 0) + (showInfo ? 1 : 0);
    var nCols = span + (money ? 3 : 0);
    var tCon = 0, tPaid = 0, tPend = 0, tDecl = 0;
    items.forEach(function (it) {
      var nm = esc(it.name || '(sans nom)');
      if (it.leadId && !o.noLink) {
        nm = '<a href="sales-leads.html?leadId=' + encodeURIComponent(it.leadId) + '" target="_blank" rel="noopener" title="Ouvrir la fiche">' + nm + '</a>';
      }
      var fh = '';
      flagsOf(it).forEach(function (t) { fh += '<span class="sd-flag">' + esc(t) + '</span>'; });
      h += '<tr' + (fh ? ' class="sd-hf"' : '') + '><td>' + nm + '</td>';
      if (showDate) h += '<td class="sd-nw">' + esc(frDate(it.date)) + (it.time ? ' <span class="sd-mut">' + esc(it.time) + '</span>' : '') + '</td>';
      if (showStatus) {
        h += '<td>' + (it.status ? '<span class="sd-nw"><span class="sd-dot" style="background:' + esc(it.statusColor || '#8f97b2') + '"></span>' + esc(it.status) + '</span>' +
          (it.statusPlus ? ' <span class="sd-mut">(' + esc(it.statusPlus) + ')</span>' : '') : '') + '</td>';
      }
      if (showCanal) h += '<td class="sd-nw">' + (it.canal ? esc(it.canal) : '<span class="sd-mut">—</span>') + '</td>';
      if (showSetter) h += '<td>' + (it.setter ? esc(it.setter) : '<span class="sd-mut">—</span>') + '</td>';
      if (showCloser) h += '<td>' + (it.closer ? esc(it.closer) : '<span class="sd-mut">—</span>') + '</td>';
      if (showInfo) h += '<td class="sd-mut">' + esc(it.info || '') + '</td>';
      if (money) {
        var con = Number(it.con) || 0, paid = Number(it.paid) || 0, pend = Number(it.pending) || 0;
        tCon += con; tPaid += paid; tPend += pend;
        if (it.conDeclare && con > 0) tDecl += con;
        h += '<td class="num">' + (con > 0 ? fmtEuro(con) + (it.conDeclare ? ' <span class="sd-mut">déclaré</span>' : '') : '<span class="sd-mut">—</span>') + '</td>' +
          '<td class="num">' + (paid > 0 ? fmtEuro(paid) : '<span class="sd-mut">0 €</span>') + '</td>' +
          '<td class="num">' + (pend > 0 ? '⏳ ' + fmtEuro(pend) : '<span class="sd-mut">—</span>') + '</td>';
      }
      h += '</tr>';
      if (fh) h += '<tr class="sd-fl"><td colspan="' + nCols + '"><div class="sd-fw">' + fh + '</div></td></tr>';
    });
    h += '</tbody>';
    if (money) {
      /* Reste à encaisser = contracté − collecté, sur les totaux AFFICHÉS
         (arrondis à l'euro) : la soustraction se refait à la main. */
      var rCon = Math.round(tCon), rPaid = Math.round(tPaid);
      h += '<tfoot><tr><td colspan="' + span + '">Total' + SC.info('ht') +
        (tDecl > 0 ? '<span class="sd-mut sd-sm">dont ' + fmtEuro(tDecl) + ' de contracté déclaré au close (clients sans paiement)</span>' : '') + '</td>' +
        '<td class="num">' + fmtEuro(rCon) + '</td>' +
        '<td class="num">' + fmtEuro(rPaid) + '</td>' +
        '<td class="num">' + (tPend > 0 ? '⏳ ' + fmtEuro(tPend) : '—') + '</td></tr>' +
        '<tr class="sd-reste"><td colspan="' + span + '">' + esc(SC.mot('reste_a_encaisser')) + SC.info('reste_a_encaisser') + '</td>' +
        '<td class="num" colspan="3">' + (rPaid > rCon
          ? fmtEuro(0) + ' <span class="sd-mut">(le collecté dépasse le contracté)</span>'
          : fmtEuro(rCon) + ' − ' + fmtEuro(rPaid) + ' = ' + fmtEuro(rCon - rPaid)) + '</td></tr></tfoot>';
    }
    out.body = h + '</table>';
    return out;
  }

  /* options : { title, sub, note, items, money, noLink, dateLabel, empty,
                 info, infoPlus } — voir render(). */
  function open(o) {
    o = o || {};
    ensureStyle();
    var bg = ensureModal();
    function set(id, html) { var el = document.getElementById(id); if (el) el.innerHTML = html; }
    var r;
    try {
      r = render(o);
    } catch (e) {
      /* Rien de muet : la fenêtre dit que la liste n'a pas pu être construite
         (stats-core.js absent, par exemple), puis l'erreur remonte. */
      set('sdTitle', esc(o.title || 'Détail'));
      set('sdDef', ''); set('sdSub', '');
      set('sdNote', '<div class="sd-note">' + esc('Liste indisponible : ' + ((e && e.message) || 'erreur inconnue') + ' Recharge la page ; si le message revient, préviens Adrien.') + '</div>');
      set('sdBody', '');
      bg.className = 'sd-bg show';
      throw e;
    }
    set('sdTitle', r.title);
    set('sdDef', r.def);
    set('sdSub', r.sub);
    set('sdNote', r.note);
    var body = document.getElementById('sdBody');
    body.innerHTML = r.body;
    body.scrollTop = 0;
    bg.className = 'sd-bg show';
  }

  /* Chiffre cliquable : <span class="sd-click" data-sd="ref">…</span>. */
  function cell(html, ref) {
    ensureStyle();
    return '<span class="sd-click" data-sd="' + esc(ref) + '" role="button" tabindex="0" title="Voir la liste">' + html + '</span>';
  }

  /* Délégation sur un conteneur stable. resolver(ref, element) → options de
     open(), ou null. Posée UNE fois par conteneur. */
  function bind(root, resolver) {
    if (!root || root._sdBound) return;
    root._sdBound = true;
    ensureStyle();
    function fire(e) {
      var t = e.target;
      while (t && t !== root) {
        if (t.getAttribute) {
          /* Le « i » posé dans un chiffre cliquable n'ouvre pas la liste. */
          if (t.getAttribute('data-sc-i') != null) return;
          if (t.getAttribute('data-sd') != null) {
            var o = resolver(t.getAttribute('data-sd'), t);
            if (o) { e.preventDefault(); open(o); }
            return;
          }
        }
        t = t.parentNode;
      }
    }
    root.addEventListener('click', fire);
    root.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) fire(e);
    });
  }

  /* État lisible d'un RDV : [mot, couleur, état]. LA règle est celle de
     StatsCore.libelle (le résultat saisi fait foi, sinon le statut ; « à
     statuer » dès la fin du créneau, heure de Paris). Second argument :
     « maintenant » en millisecondes (facultatif) ; l'ancien todayIso
     ('AAAA-MM-JJ') est accepté et ignoré. */
  function bookingStatus(b, now) {
    var l = regles().libelle(b || {}, nowOf(now));
    return [l.mot, l.couleur, l.etat];
  }

  /* Origine d'une annulation, telle qu'elle est écrite sur le RDV (bloc
     cancellation, sinon champs historiques) — même lecture que
     AlteoreFlow.cancellationInfo, que le Stats funnel ne charge pas. */
  var ORIGINES = { prospect: 'prospect', equipe: 'équipe', systeme: 'système' };
  function origineAnnulation(b) {
    var c = (b && b.cancellation) || null;
    if (c && c.kind === 'non_honore') return 'RDV non honoré par l’équipe';
    var o = (c && c.origin) || (b && b.cancelledOrigin) || ((b && b.cancelledReason) ? 'systeme' : null);
    return ORIGINES[o] || '';
  }

  /* Nom affiché d'une personne : la PAGE fournit ctx.nomDe(slug) (elle seule
     sait qui a un onglet, qui est parti — « Anciens membres » —, etc.). */
  function nomDe(slug, ctx) {
    if (!slug) return '';
    var n = (ctx && typeof ctx.nomDe === 'function') ? ctx.nomDe(slug) : slug;
    return n ? String(n) : '';
  }

  function sansPaiement(rv) {
    return ((Number(rv.con) || 0) > 0
      ? 'Sans paiement — contracté = tarif déclaré au close'
      : 'Sans paiement et sans tarif déclaré au close — contracté à 0') +
      ((Number(rv.declCol) || 0) > 0 ? ' · collecté déclaré ' + fmtEuro(rv.declCol) + ', non compté' : '');
  }

  /* 2e RDV closé d'un client déjà compté : rv.dup, et si la page le fournit
     rv.dupOf = { date, classe ('self' | 'setter'), closer (slug) | closerName }. */
  function dejaCompte(rv, ctx, SC) {
    var d = rv.dupOf || null;
    if (!d) return 'Client déjà compté par un autre RDV closé — montants à 0 ici';
    var parts = [];
    var cls = d.classe || d.canal || '';
    if ((cls === 'self' || cls === 'setter') && SC.CLASSES[cls]) parts.push(SC.CLASSES[cls]);
    var cl = d.closerName || ((d.closer && ctx && typeof ctx.nomDe === 'function') ? nomDe(d.closer, ctx) : '');
    if (cl) parts.push('closer ' + cl);
    return 'Client déjà compté' + (d.date ? ' : close du ' + frDate(d.date) : '') + (parts.length ? ' (' + parts.join(', ') + ')' : '') + ' — montants à 0 ici';
  }

  /* Ligne de liste depuis un RDV.
     ctx : { now (ms, facultatif), setter, closer, info, classe, canal, rv }
       · classe ('self' | 'setter' | 'admin') → colonne Canal, au mot de
         StatsCore.CLASSES ; canal = texte déjà prêt (prime sur classe).
       · rv = verdict FunnelCore.revClient du close porté par ce RDV (ou null).
       · todayIso : accepté pour les anciens appels, plus lu (voir nowOf).
       · decl : plus JAMAIS utilisé comme montant (le déclaré n'entre ni dans
         le contracté ni dans le collecté) ; sa présence sans rv signale
         seulement que le module Paiements était illisible. */
  function bookingItem(b, ctx) {
    ctx = ctx || {};
    b = b || {};
    var SC = regles();
    var l = SC.libelle(b, nowOf(ctx.now));
    var pr = b.prospect || {};
    var it = {
      kind: 'rdv',
      name: pr.nom || b.leadName || pr.email || b.id || b._id || '',
      leadId: b.leadId || null,
      date: b.date || '',
      time: b.time || '',
      status: l.mot, statusColor: l.couleur, statusPlus: '', etat: l.etat,
      canal: ctx.canal || (ctx.classe && SC.CLASSES[ctx.classe]) || '',
      setter: ctx.setter || '',
      closer: ctx.closer || '',
      info: ctx.info || '',
      con: 0, paid: 0, pending: 0, conDeclare: false, flag: '', flags: []
    };
    if (l.etat === 'annule') it.statusPlus = origineAnnulation(b);
    var rv = ctx.rv || null;
    if (rv) {
      if (rv.cancelled) poser(it, 'Close annulé (' + (rv.reason || 'raison non renseignée') + ') — retiré des closes et des montants');
      else if (rv.dup) poser(it, dejaCompte(rv, ctx, SC));
      else {
        it.con = rv.con || 0; it.paid = rv.paid || 0; it.pending = rv.pending || 0;
        if (!rv.hasPay) { it.conDeclare = it.con > 0; poser(it, sansPaiement(rv)); }
      }
    } else if (ctx.decl) {
      poser(it, 'Module Paiements illisible : montants non affichés (un montant déclaré au close n’est jamais compté)');
    }
    return it;
  }

  /* Ligne de liste depuis UNE ligne de FunnelCore.buildCloses :
       { key, leadId, name, ms, day, src ('fiche' | 'rdv' | 'paiement'), sb,
         canal ('self' | 'setter'), canalSrc, canalEcart, closer, setter,
         bookingId, rdvDate, rv, lead }
     ctx : { nomDe(slug) → nom affiché (fourni par la page), info }
     Toutes les pages passent par ici pour leurs listes de closes : mêmes
     colonnes, mêmes mots. La date est le JOUR DU CLOSE (ligne.day). */
  function closeItem(r, ctx) {
    ctx = ctx || {};
    r = r || {};
    var SC = regles();
    var NA = SC.mot('non_attribue') || 'Non attribué';
    var it = {
      kind: 'close', key: r.key || null,
      name: r.name || '',
      leadId: r.leadId || null,
      date: r.day || '',
      time: '',
      status: '', statusColor: '', statusPlus: '', annule: false,
      canal: '', setter: '', closer: '',
      info: ctx.info || '',
      con: 0, paid: 0, pending: 0, conDeclare: false, flag: '', flags: []
    };
    var rv = r.rv || null;
    /* Une ligne sans verdict n'est PAS un close : c'est une fiche marquée
       cliente sans vente enregistrée (buildCloses → sansSignal). */
    if (!rv) {
      it.kind = 'fiche';
      it.status = 'Sans vente enregistrée'; it.statusColor = SC.ETATS.a_venir.couleur;
      poser(it, 'Fiche marquée cliente sans vente enregistrée — non comptée dans les closes' + (r.stage ? ' (étape : ' + r.stage + ')' : ''));
      return it;
    }
    var canal = (r.canal === 'self' || r.canal === 'setter') ? r.canal : (r.sb === true ? 'self' : 'setter');
    it.canal = SC.CLASSES[canal];
    it.closer = nomDe(r.closer, ctx) || NA;
    /* Setter : « Non attribué » pour un close du setting sans setter connu ;
       rien pour un close Self Booking (aucun setter n'y est attendu). */
    it.setter = nomDe(r.setter, ctx) || (canal === 'setter' ? NA : '');

    if (rv.cancelled) {
      it.annule = true;
      it.status = 'Close annulé'; it.statusColor = SC.ETATS.annule.couleur;
      it.statusPlus = rv.reason || '';
      poser(it, 'Retiré des closes et des montants');
    } else {
      it.status = SC.DETAILS.close.mot; it.statusColor = SC.DETAILS.close.couleur;
      it.con = rv.con || 0; it.paid = rv.paid || 0; it.pending = rv.pending || 0;
      if (!rv.hasPay) { it.conDeclare = it.con > 0; poser(it, sansPaiement(rv)); }
    }
    if (r.src === 'paiement') poser(it, 'Repéré par le paiement seul' + (r.bookingId ? '' : ' — aucun RDV closé') + ((r.noLead || !r.leadId) ? ' — aucune fiche liée' : ''));
    else if (r.src === 'rdv') poser(it, 'RDV closé sans fiche liée');
    else if (!r.bookingId) poser(it, 'Vente validée sans RDV closé');
    if (r.rdvDate && r.rdvDate !== r.day) poser(it, 'RDV du ' + frDateRef(r.rdvDate, r.day));
    if (r.canalEcart) {
      poser(it, (canal === 'self'
        ? 'RDV Self Booking, close déclaré Setting par le closer'
        : 'RDV Setting (NB), close déclaré Self Booking par le closer') + ' — la commission de setting suit la réponse du closer');
    }
    if (r.canalSrc === 'inconnu') poser(it, 'Canal inconnu — classé Setting (NB) par défaut');
    return it;
  }

  var api = {
    esc: esc, fmtEuro: fmtEuro, frDate: frDate,
    open: open, close: close, cell: cell, bind: bind, render: render,
    bookingItem: bookingItem, bookingStatus: bookingStatus, closeItem: closeItem
  };
  W.StatsDrill = api;
  if (typeof module === 'object' && module.exports) module.exports = api;
})();
