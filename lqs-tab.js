/* ============================================================================
   lqs-tab.js — onglet « ⭐ Qualité leads » du Funnel Sales (06/11/2026)
   ----------------------------------------------------------------------------
   Rendu de LqsCore (lqs-core.js) dans sales-funnel.html — ADMIN uniquement
   (la page est déjà gardée admin ; aucune note LQS n'est montrée ailleurs,
   demande explicite de Vincent : les closers ne la voient pas).

   Six vues, une barre de filtres commune (closer, base du cash) :
     🧭 Vue d'ensemble   tunnel complet, LQS 1→5 × RDV / présents / closes / cash
     📋 Quiz & réponses  abandon question par question + chaque réponse → résultats
     📣 Marketing (MQS)  campagne / adset / créa / canal : qualité + rentabilité
     🎯 Closers          RDV mois par mois : % de 4-5, qualité du pipe, closing
     👥 Leads notés      chaque lead, sa note, le détail de ses points
     ⚙️ Barème           points par réponse, seuils, suggestions ; enregistré
                         dans _config/lqs_grid (seule écriture de l'onglet)

   API (appelée par sales-funnel.html) :
     LqsTab.show(mount, ctx)    ctx = { db, P, periodLabel, typeMap,
                                        tunnelFilter, sourceFilter, toast,
                                        user, teamMembers, tunnelsMeta }
     LqsTab.invalidate()        période changée → rechargement au prochain show
     LqsTab.refilter(ctx)       filtres tunnel / source → recalcul sans recharger
   ES5 strict, délégation d'événements (data-*), aucun onclick inline.
   ============================================================================ */
(function () {
  'use strict';
  var LC = window.LqsCore, FC = window.FunnelCore;
  if (!LC || !FC) { if (window.console) console.error('[lqs] lqs-core.js / funnel-core.js manquants'); return; }

  var S = {
    mount: null, ctx: null, D: null, M: null,
    grid: null, draft: null, stamp: 1,
    loadedKey: null, loading: false, err: null, bound: false,
    view: 'overview', closer: '', cashMode: 'cohorte', axis: 'campaign',
    crMode: 'period', leadsNote: 'all', leadsQ: '', leadsLimit: 150,
    openQ: {}, openLead: {}, openDetail: {}, quizVer: '', quizCompare: false, formsOpen: false, saving: false
  };

  /* ══ FORMATS ══════════════════════════════════════════════════════════ */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ok(v) { return v != null && !isNaN(v) && isFinite(v); }
  function fNum(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') : '—'; }
  function fEur(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') + ' €' : '—'; }
  function fPct(v, d) { if (!ok(v)) return '—'; var p = Math.pow(10, d == null ? 1 : d); return (Math.round(v * p) / p).toLocaleString('fr-FR') + ' %'; }
  function fDec(v, d) { if (!ok(v)) return '—'; return v.toLocaleString('fr-FR', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); }
  function fPts(v) { if (!ok(v)) return '—'; return (v > 0 ? '+' : '') + v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }); }
  function fRoas(v) { return ok(v) ? v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' ×' : '—'; }
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function fMonth(mk) { var p = String(mk || '').split('-'); return p.length === 2 ? MONTHS[+p[1] - 1] + ' ' + p[0] : mk; }
  function fDay(ms) { if (ms == null) return '—'; var d = new Date(ms); return ('0' + d.getDate()).slice(-2) + '/' + ('0' + (d.getMonth() + 1)).slice(-2) + '/' + String(d.getFullYear()).slice(2); }
  function cap(s) { s = String(s || ''); return s.charAt(0).toUpperCase() + s.slice(1); }

  var NOTE_LBL = { 5: 'Élite', 4: 'Très bon', 3: 'Bon', 2: 'Moyen', 1: 'Faible', 0: 'Non noté' };
  function noteBadge(n, big) {
    var k = n == null ? 0 : n;
    return '<span class="lq-note lq-n' + k + (big ? ' big' : '') + '" title="' + esc(NOTE_LBL[k]) + '">' + (k ? k : '–') + '</span>';
  }
  function avgBadge(v) {
    if (!ok(v)) return '<span class="lq-muted">—</span>';
    var k = Math.max(1, Math.min(5, Math.round(v)));
    return '<span class="lq-avg lq-n' + k + '">' + fDec(v, 2) + '</span>';
  }
  function mqsBadge(m) {
    if (!m) return '<span class="lq-muted" title="Moins de ' + LC.MQS_MIN + ' leads notés : échantillon trop faible">n.s.</span>';
    var k = Math.max(1, Math.min(5, Math.round(m.mqs)));
    return '<span class="lq-avg lq-n' + k + '" title="Qualité des leads ' + fDec(m.quality, 2) + ' · résultats ' + m.result + '/5">' + fDec(m.mqs, 1) + '</span>';
  }
  function distBar(dist) {
    var tot = 0, h = '';
    for (var i = 0; i <= 5; i++) tot += dist[i] || 0;
    if (!tot) return '<div class="lq-dist"></div>';
    [5, 4, 3, 2, 1, 0].forEach(function (k) {
      var w = (dist[k] || 0) / tot * 100;
      if (w > 0) h += '<span class="lq-n' + k + '" style="width:' + w.toFixed(2) + '%" title="' + esc(NOTE_LBL[k]) + ' : ' + dist[k] + '"></span>';
    });
    return '<div class="lq-dist">' + h + '</div>';
  }
  /* Closes ventilés par offre vendue (closeData.offre : Élite / Business
     Phénix). « ? » = close sans offre renseignée (anciens closes). */
  function offerSplit(a) {
    if (!a || !a.closes) return '';
    var p = [];
    if (a.closesE) p.push('<span class="lq-oe">' + fNum(a.closesE) + ' Élite</span>');
    if (a.closesB) p.push('<span class="lq-ob">' + fNum(a.closesB) + ' Business</span>');
    if (a.closesU) p.push('<span class="lq-muted" title="Close sans offre renseignée">' + fNum(a.closesU) + ' ?</span>');
    return p.join(' · ');
  }
  function bar(pct, cls) { return '<div class="lq-bar"><span class="' + (cls || '') + '" style="width:' + (ok(pct) ? Math.max(0, Math.min(100, pct)).toFixed(1) : 0) + '%"></span></div>'; }
  function sub(v) { return '<div class="lq-sub">' + v + '</div>'; }
  function kpi(v, l, s) { return '<div class="fn-kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  function card(title, note, body, extraHead) {
    return '<div class="fn-stage"><div class="fn-stage-head"><div class="fn-stage-title">' + title + '</div>'
      + (extraHead || (note ? '<div class="fn-stage-note">' + note + '</div>' : '')) + '</div>' + body + '</div>';
  }
  function help(title, html) { return '<details class="fn-help"><summary>' + title + '</summary><div class="hb">' + html + '</div></details>'; }

  /* ══ ÉTAT / DONNÉES ════════════════════════════════════════════════════ */
  function activeGrid() { return S.draft || S.grid || LC.normalizeGrid(null); }
  function closerRange() {
    var P = S.ctx.P;
    if (S.crMode === 'period') return { start: P.start, end: P.end };
    var n = S.crMode === '6m' ? 5 : 2;
    var now = new Date();
    return { start: new Date(now.getFullYear(), now.getMonth() - n, 1, 0, 0, 0, 0), end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };
  }
  function dataKey() {
    var P = S.ctx.P, cr = closerRange();
    return P.start.getTime() + '|' + P.end.getTime() + '|' + cr.start.getTime() + '|' + cr.end.getTime();
  }
  function rebuild() {
    if (!S.D) return;
    S.M = LC.buildModel(S.D, {
      P: S.ctx.P, grid: activeGrid(), gridStamp: S.stamp,
      tunnelFilter: S.ctx.tunnelFilter, sourceFilter: S.ctx.sourceFilter,
      teamMembers: S.ctx.teamMembers || window.TEAM_MEMBERS_LIST || [],
      closerRange: closerRange(), tunnelsMeta: S.ctx.tunnelsMeta || null
    });
    if (S.closer && !S.M.closers.some(function (c) { return c.slug === S.closer; })) S.closer = '';
  }
  function load() {
    if (S.loading) return;
    S.loading = true; S.err = null;
    var key = dataKey();
    render();
    LC.loadAll(S.ctx.db, { P: S.ctx.P, typeMap: S.ctx.typeMap || {}, closerRange: closerRange() }).then(function (D) {
      S.D = D;
      S.grid = LC.normalizeGrid(D.gridRaw);
      S.stamp++;
      S.loadedKey = key;
      rebuild();
    }).catch(function (e) {
      if (window.console) console.error('[lqs] chargement', e);
      S.err = e && e.message ? e.message : 'erreur inconnue';
    }).then(function () {
      S.loading = false;
      render();
    });
  }
  function rows() {
    var list = S.M ? S.M.rows : [];
    if (!S.closer) return list;
    return list.filter(function (r) { return r.closer === S.closer; });
  }
  function periodPays() {
    var list = S.M ? S.M.periodPays : [];
    if (!S.closer) return list;
    return list.filter(function (p) { return p.closer === S.closer; });
  }
  function toast(msg, bad) { if (S.ctx && typeof S.ctx.toast === 'function') S.ctx.toast(msg, bad); }

  /* ══ RENDU — CADRE ═════════════════════════════════════════════════════ */
  var VIEWS = [
    ['overview', '🧭 Vue d\'ensemble'], ['quiz', '📋 Quiz & réponses'], ['mkt', '📣 Marketing (MQS)'],
    ['closers', '🎯 Closers'], ['leads', '👥 Leads notés'], ['grid', '⚙️ Barème']
  ];
  function header() {
    var h = '<div class="lq-head">';
    h += '<div class="fn-seg lq-views">';
    VIEWS.forEach(function (v) { h += '<button data-lq-view="' + v[0] + '" class="' + (S.view === v[0] ? 'active' : '') + '">' + v[1] + '</button>'; });
    h += '</div><div class="lq-filters">';
    h += '<select class="fn-sel" data-lq-closer title="Filtre toutes les vues sur les leads et RDV de ce closer"><option value="">👥 Toute l\'équipe</option>';
    (S.M ? S.M.closers : []).forEach(function (c) { h += '<option value="' + esc(c.slug) + '"' + (S.closer === c.slug ? ' selected' : '') + '>🎯 ' + esc(c.name) + '</option>'; });
    h += '</select>';
    h += '<div class="fn-seg" title="Base du cash"><button data-lq-cash="cohorte" class="' + (S.cashMode === 'cohorte' ? 'active' : '') + '" title="Cash encaissé à ce jour par les leads entrés dans la période : juge la qualité des leads">💶 Cash des leads de la période</button>'
      + '<button data-lq-cash="periode" class="' + (S.cashMode === 'periode' ? 'active' : '') + '" title="Cash réellement encaissé pendant la période, quel que soit le mois d\'entrée du lead">🏦 Encaissé sur la période</button></div>';
    h += '</div></div>';
    if (S.draft) h += '<div class="fn-alert lq-draft">✏️ Barème modifié, non enregistré : tous les chiffres affichés utilisent déjà le barème en cours d\'édition. <a href="#" data-lq-go="grid">Ouvrir le barème</a></div>';
    return h;
  }
  function render() {
    if (!S.mount) return;
    var h = header();
    if (S.loading) h += '<div class="fn-loading">Chargement de la qualité des leads — ' + esc(S.ctx.periodLabel || '') + '…</div>';
    else if (S.err) h += '<div class="fn-ig-alert"><strong>Erreur de chargement :</strong> ' + esc(S.err) + '</div>';
    else if (!S.M) h += '<div class="fn-loading">—</div>';
    else {
      if (S.M.leadsTruncated) h += '<div class="fn-alert">⚠ Trop de leads sur la période : la liste est tronquée. Réduis la période pour des chiffres exacts.</div>';
      if (S.view === 'overview') h += viewOverview();
      else if (S.view === 'quiz') h += viewQuiz();
      else if (S.view === 'mkt') h += viewMarketing();
      else if (S.view === 'closers') h += viewClosers();
      else if (S.view === 'leads') h += viewLeads();
      else if (S.view === 'grid') h += viewGrid();
    }
    S.mount.innerHTML = h;
  }

  /* ══ VUE 1 — VUE D'ENSEMBLE ════════════════════════════════════════════ */
  function cashOf(a) { return S.cashMode === 'periode' ? a.periodCash : a.cash; }
  function closesOf(a) { return S.cashMode === 'periode' ? a.payers : a.closes; }

  function viewOverview() {
    var R = rows();
    var bn = LC.byNote(R, periodPays());
    var t = bn.total, m = bn.byNote;
    var totCash = cashOf(t);
    var h = '';
    h += help('ℹ️ Comment lire cet onglet', '<p><strong>LQS (Lead Quality Score)</strong> : chaque lead reçoit une note de <strong>1 à 5</strong> calculée <strong>uniquement à partir de ses réponses</strong> (quiz, formulaires) avec le barème de l\'onglet ⚙️ — CA, équipe, contraintes… Aucun jugement humain : c\'est la qualité que le marketing nous envoie.</p>'
      + '<p><strong>MQS (Marketing Quality Score)</strong> : la note d\'une campagne, d\'un adset, d\'une créa ou d\'un canal = qualité des leads qu\'elle amène (60 %) + ce qu\'ils rapportent vraiment (40 %).</p>'
      + '<p>On croise ensuite avec la vérité commerciale : RDV, présents, closes, <strong>cash réellement encaissé (HT)</strong>. Si les 4-5 ne closent pas, c\'est un sujet closing ; si les closers closent bien mais qu\'il n\'y a que des 1-2, c\'est un sujet marketing. Chacun sa responsabilité, chiffres à l\'appui.</p>'
      + '<p><strong>Réservé aux admins</strong> : la note n\'est affichée nulle part ailleurs, les closers ne la voient pas.</p>');

    /* KPIs */
    h += '<div class="fn-grid lq-kpis">';
    h += kpi(fNum(t.leads), 'Leads de la période', fNum(t.noted) + ' notés (' + fPct(t.leads ? t.noted / t.leads * 100 : null, 0) + ')');
    h += kpi(avgBadge(t.avgNote), 'LQS moyen', 'qualité moyenne envoyée par le marketing');
    h += kpi(fPct(t.pct45, 0), 'Leads notés 4-5', fNum(t.n45) + ' leads · 1-2 : ' + fPct(t.pct12, 0));
    h += kpi(fNum(t.booked), 'RDV pris', fPct(t.bookRate) + ' des leads');
    h += kpi(fNum(t.present), 'Présents', fPct(t.showRate) + ' des RDV');
    h += kpi(fNum(closesOf(t)), S.cashMode === 'periode' ? 'Clients ayant payé' : 'Closes', S.cashMode === 'periode' ? 'sur la période' : fPct(t.closePresent) + ' des présents' + (t.closes ? '<br>' + offerSplit(t) : ''));
    h += kpi(fEur(totCash), S.cashMode === 'periode' ? 'Encaissé sur la période' : 'Cash encaissé', S.cashMode === 'periode' ? 'HT, tous leads confondus' : 'HT, à ce jour, par ces leads');
    h += '</div>';

    /* Tunnel complet */
    h += card('🛤️ Le tunnel complet', 'quiz (mesure anonyme) → leads → RDV → présents → closes → cash', tunnelStrip(t));

    /* Phrases clés */
    h += card('💡 Ce qu\'il faut retenir', '', insightsHtml(bn));

    /* Tableau LQS */
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr>'
      + '<th class="l">Note LQS</th><th>Leads</th><th>Part</th><th>RDV pris</th><th>Présents</th>'
      + '<th>' + (S.cashMode === 'periode' ? 'Clients payants' : 'Closes') + '</th><th title="Offre vendue : Élite / Business Phénix (closes des leads de la période)">Élite / Business</th><th title="Closes ÷ présents">Closing / présents</th><th title="Closes ÷ RDV pris">Closing / RDV</th>'
      + '<th>Cash</th><th class="l" style="min-width:140px">Part du cash</th><th>Cash / client</th><th>Cash / lead</th><th title="Moyenne du curseur ★ posé par l\'équipe dans Leads Live">Note équipe</th></tr></thead><tbody>';
    LC.NOTE_KEYS.forEach(function (k) {
      var a = m[k];
      if (!a.leads && !(S.cashMode === 'periode' && a.periodCash)) return;
      var c = cashOf(a), share = totCash > 0 ? c / totCash * 100 : null;
      var cl = closesOf(a);
      body += '<tr><td class="l">' + noteBadge(k || null) + ' <span class="lq-nl">' + NOTE_LBL[k] + '</span></td>'
        + '<td>' + fNum(a.leads) + '</td><td>' + fPct(t.leads ? a.leads / t.leads * 100 : null, 0) + '</td>'
        + '<td>' + fNum(a.booked) + sub(fPct(a.bookRate, 0)) + '</td>'
        + '<td>' + fNum(a.present) + sub(fPct(a.showRate, 0) + ' des RDV') + '</td>'
        + '<td><strong>' + fNum(cl) + '</strong></td>'
        + '<td>' + (a.closes ? fNum(a.closesE) + ' / ' + fNum(a.closesB) + (a.closesU ? sub(fNum(a.closesU) + ' sans offre') : '') : '—') + '</td>'
        + '<td>' + fPct(a.closePresent, 0) + '</td><td>' + fPct(a.closeRdv, 0) + '</td>'
        + '<td><strong>' + fEur(c) + '</strong></td>'
        + '<td class="l">' + bar(share, 'lq-n' + k) + sub(fPct(share)) + '</td>'
        + '<td>' + fEur(cl ? c / cl : null) + '</td><td>' + fEur(a.leads ? c / a.leads : null) + '</td>'
        + '<td>' + (a.teamAvg != null ? '★ ' + fDec(a.teamAvg, 1) : '—') + '</td></tr>';
    });
    body += '<tr class="tot"><td class="l">Total</td><td>' + fNum(t.leads) + '</td><td>100 %</td><td>' + fNum(t.booked) + sub(fPct(t.bookRate, 0)) + '</td><td>' + fNum(t.present) + sub(fPct(t.showRate, 0) + ' des RDV') + '</td>'
      + '<td>' + fNum(closesOf(t)) + '</td><td>' + (t.closes ? fNum(t.closesE) + ' / ' + fNum(t.closesB) + (t.closesU ? sub(fNum(t.closesU) + ' sans offre') : '') : '—') + '</td><td>' + fPct(t.closePresent, 0) + '</td><td>' + fPct(t.closeRdv, 0) + '</td><td>' + fEur(totCash) + '</td><td class="l"></td>'
      + '<td>' + fEur(closesOf(t) ? totCash / closesOf(t) : null) + '</td><td>' + fEur(t.leads ? totCash / t.leads : null) + '</td><td>' + (t.teamAvg != null ? '★ ' + fDec(t.teamAvg, 1) : '—') + '</td></tr>';
    body += '</tbody></table></div>';
    body += '<div class="fn-stage-note" style="margin-top:8px">' + (S.cashMode === 'periode'
      ? 'Mode « encaissé sur la période » : leads / RDV / présents = leads entrés dans la période ; cash et clients payants = prélèvements réellement passés pendant la période, rangés selon la note du lead qui a payé (quel que soit son mois d\'entrée).'
      : 'Leads entrés dans la période (ré-optins compris) · RDV et closes suivis jusqu\'à aujourd\'hui · cash = prélèvements réellement passés (HT), closes annulés exclus.') + '</div>';
    h += card('⭐ Qualité des leads → résultats', S.closer ? 'leads de ' + esc(S.M.memberName(S.closer)) : 'toute l\'équipe', body);

    h += alignmentCard(R);
    return h;
  }

  function quizTotals() {
    var q = { starts: 0, completes: 0, gateShown: 0, gateExit: 0, has: false };
    (S.M.quiz || []).forEach(function (p) { q.starts += p.starts; q.completes += p.completes; q.gateShown += p.gate.shown; q.gateExit += p.gate.exit; q.has = true; });
    return q;
  }
  function tunnelStrip(t) {
    var q = quizTotals();
    var V = LC.quizVersions(rows(), S.M.quiz || [], S.M.tunnels || S.ctx.tunnelsMeta || null, S.M.views);
    var quizLeads = rows().filter(function (r) { return r.answers.some(function (a) { return a.o === 'quiz'; }); }).length;
    var steps = [
      q.has ? { v: fNum(q.starts), l: 'Quiz commencés', s: V.all.views ? fPct(q.starts / V.all.views * 100, 0) + ' des visites' : '' }
        : { v: V.all.views ? fNum(V.all.views) : '—', l: V.all.views ? 'Visites des pages quiz' : 'Quiz commencés', s: V.all.views ? 'commencés : mesure à activer' : 'mesure à activer' },
      q.has ? { v: fNum(q.completes), l: 'Quiz terminés', s: q.starts ? fPct(q.completes / q.starts * 100, 0) + ' des débuts' : '' }
        : { v: V.all.views ? fNum(V.all.optins) : '—', l: V.all.views ? 'Formulaires quiz envoyés' : 'Quiz terminés', s: V.all.views ? fPct(V.all.optins / V.all.views * 100, 1) + ' des visites' : '' },
      { v: fNum(t.leads), l: 'Leads', s: fNum(quizLeads) + ' via le quiz' },
      { v: fNum(t.booked), l: 'RDV pris', s: fPct(t.bookRate, 0) + ' des leads' },
      { v: fNum(t.present), l: 'Présents', s: fPct(t.showRate, 0) + ' des RDV' },
      { v: fNum(t.closes), l: 'Closes', s: fPct(t.closePresent, 0) + ' des présents' },
      { v: fEur(t.cash), l: 'Cash encaissé', s: t.closes ? fEur(t.cash / t.closes) + ' / client' : '' }
    ];
    var h = '<div class="lq-strip">';
    steps.forEach(function (s, i) {
      if (i) h += '<div class="lq-strip-arrow">›</div>';
      h += '<div class="lq-strip-step"><div class="v">' + s.v + '</div><div class="l">' + s.l + '</div><div class="s">' + (s.s || '&nbsp;') + '</div></div>';
    });
    h += '</div>';
    if (q.has && q.gateShown) h += '<div class="fn-stage-note" style="margin-top:8px">Écran prix : affiché ' + fNum(q.gateShown) + ' fois · ' + fNum(q.gateExit) + ' visiteurs se sont arrêtés là (disqualifiés avant de prendre un créneau).</div>';
    if (!q.has) h += '<div class="fn-stage-note" style="margin-top:8px">« Quiz commencés / terminés » et l\'abandon question par question démarrent à l\'instrumentation de la page quiz (scripts/quiz-tracking-patch.js --apply) : ils ne se reconstituent pas pour le passé. Visites et formulaires envoyés, eux, sont mesurés depuis septembre.</div>';
    return h;
  }

  function insightsHtml(bn) {
    var list = LC.insights(bn, S.cashMode);
    var cashWord = S.cashMode === 'periode' ? 'de l\'encaissé de la période' : 'du cash encaissé';
    var totC = S.cashMode === 'periode' ? bn.total.periodCash : bn.total.cash;
    if (!(totC > 0)) {
      list = list.filter(function (x) { return x.k === 'hi' || x.k === 'lo' || x.k === 'none'; });
      var h0 = '<ul class="lq-ins">';
      list.forEach(function (x) {
        if (x.k === 'hi') h0 += '<li><span class="lq-note lq-n5">4-5</span> Les leads notés <strong>4 et 5</strong> sont <strong>' + fNum(x.leads) + '</strong> (' + fPct(x.leadsPct, 0) + ' des leads). Pas encore de cash encaissé sur ces leads : la part du cash par note s\'affichera avec les premiers prélèvements.</li>';
        else if (x.k === 'lo') h0 += '<li><span class="lq-note lq-n1">1</span> Les leads notés <strong>1</strong> : ' + fNum(x.leads) + ' leads, ' + fNum(x.booked) + ' RDV pris.</li>';
        else if (x.k === 'none') h0 += '<li><span class="lq-note lq-n0">–</span> ' + fNum(x.leads) + ' leads (' + fPct(x.pct, 0) + ') sans réponse exploitable : pas de quiz ni de formulaire noté (RDV direct, import, ancien tunnel).</li>';
      });
      return h0 + '</ul>';
    }
    if (!list.length) return '<div class="lq-muted">Aucun lead noté sur la période : les leads n\'ont pas de réponses exploitables (quiz ou formulaire).</div>';
    var h = '<ul class="lq-ins">';
    list.forEach(function (x) {
      if (x.k === 'hi') h += '<li><span class="lq-note lq-n5">4-5</span> Les leads notés <strong>4 et 5</strong> sont <strong>' + fNum(x.leads) + '</strong> (' + fPct(x.leadsPct, 0) + ' des leads) et pèsent <strong>' + fPct(x.cashPct, 0) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + ').</li>';
      else if (x.k === 'mid') h += '<li><span class="lq-note lq-n3">3-4</span> Le cœur de cible <strong>3 et 4</strong> pèse <strong>' + fPct(x.cashPct, 0) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + ').</li>';
      else if (x.k === 'lo') h += '<li><span class="lq-note lq-n1">1</span> Les leads notés <strong>1</strong> : ' + fNum(x.leads) + ' leads, ' + fNum(x.booked) + ' RDV pris, <strong>' + fPct(x.cashPct, 1) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + ')' + (x.booked && (x.cashPct == null || x.cashPct < 5) ? ' → des créneaux à libérer pour de meilleurs leads.' : '.') + '</li>';
      else if (x.k === 'none') h += '<li><span class="lq-note lq-n0">–</span> ' + fNum(x.leads) + ' leads (' + fPct(x.pct, 0) + ') sans réponse exploitable : pas de quiz ni de formulaire noté (RDV direct, import, ancien tunnel).</li>';
    });
    return h + '</ul>';
  }

  /* Alignement note marketing (LQS) ↔ note humaine de l'équipe (curseur ★ Leads Live). */
  function alignmentCard(R) {
    var both = R.filter(function (r) { return r.note != null && r.team != null; });
    if (both.length < 5) return '';
    var same = 0, near = 0, gap = 0, over = 0, under = 0;
    both.forEach(function (r) {
      var d = r.note - r.team;
      gap += Math.abs(d);
      if (d === 0) same++;
      if (Math.abs(d) <= 1) near++;
      if (d >= 2) over++;
      if (d <= -2) under++;
    });
    var body = '<div class="fn-grid">'
      + kpi(fNum(both.length), 'Leads notés des deux côtés', 'LQS (réponses) et ★ équipe (après contact)')
      + kpi(fPct(near / both.length * 100, 0), 'Alignés (±1 point)', fPct(same / both.length * 100, 0) + ' strictement identiques')
      + kpi(fDec(gap / both.length, 2), 'Écart moyen', 'en points de note')
      + kpi(fNum(over), 'Surévalués par les réponses', 'LQS ≥ ★ + 2 : beau sur le papier, déçoit au téléphone')
      + kpi(fNum(under), 'Sous-évalués par les réponses', 'LQS ≤ ★ − 2 : meilleur que ce qu\'il a déclaré')
      + '</div><div class="fn-stage-note" style="margin-top:8px">Quand la note du marketing et celle de l\'équipe sont alignées, le message attire les bons profils. Un gros écart « surévalués » signale un message qui fait bien répondre… les mauvaises personnes.</div>';
    return card('🤝 Alignement marketing ↔ équipe', '', body);
  }

  /* ══ VUE 2 — QUIZ & RÉPONSES (refonte lisibilité 06/11/2026) ═══════════
     1. une carte par version de quiz (Meta Dark / White, YouTube, anciennes
        versions) + « Tous les quiz » : un clic filtre toute la vue ;
     2. UN parcours, dans l'ordre du quiz : chaque question réunit la mesure
        anonyme (arrivés, perdus, réponses de tous les visiteurs) et ce que
        chaque réponse a rapporté (leads, closes, cash, points) ; le détail
        complet reste à un clic ;
     3. « Comparer » : une colonne par version, réponse par réponse ;
     4. formulaires hors quiz (VSL, AlteoForms) à part, repliés. */
  function viewQuiz() {
    var meta = S.M.tunnels || S.ctx.tunnelsMeta || null;
    var pages = S.M.quiz || [];
    var R = rows();
    var V = LC.quizVersions(R, pages, meta, S.M.views);
    if (S.quizVer && !V.list.some(function (v) { return v.key === S.quizVer; })) S.quizVer = '';
    var h = help('ℹ️ Comment lire cette vue', '<p>Chaque <strong>carte</strong> est une version du quiz (page × variante). Clique une carte pour ne voir qu\'elle ; « Tous les quiz » additionne tout.</p>'
      + '<p>Le <strong>parcours</strong> suit l\'ordre réel du quiz. Pour chaque question : combien de visiteurs y arrivent et combien partent ici (mesure anonyme, tous les visiteurs, à partir de l\'instrumentation de la page), puis pour chaque réponse : la part des visiteurs qui la choisissent et <strong>ce qu\'elle a rapporté</strong> chez les leads de la période (leads, closes, cash par lead) et ses points dans le barème.</p>'
      + '<p>Une question <strong>conditionnelle</strong> n\'est montrée qu\'à une partie des visiteurs (selon une réponse précédente) : sa perte n\'est pas calculée, on indique la part de visiteurs qui l\'ont vue.</p>'
      + '<p>« Comparer » met les versions côte à côte, réponse par réponse. Les formulaires hors quiz (VSL, AlteoForms) sont en bas.</p>');

    if (!V.list.length) {
      h += card('🧭 Parcours du quiz', '', '<div class="lq-muted">Aucun lead issu d\'un quiz et aucune mesure sur la période. La mesure démarre quand la page quiz est instrumentée (<code>node scripts/quiz-tracking-patch.js --apply</code>).</div>');
    } else {
      h += '<div class="lq-vcards">' + versionCard(V.all, !S.quizVer);
      V.list.forEach(function (v) { h += versionCard(v, S.quizVer === v.key); });
      h += '</div>';
      var canCompare = !S.quizVer && V.list.length >= 2;
      if (canCompare) h += '<div class="lq-actions" style="margin:-4px 0 14px"><button class="fn-btn' + (S.quizCompare ? ' primary' : '') + '" data-lq-compare>' + (S.quizCompare ? '✓ Comparaison des versions' : '⇄ Comparer les versions côte à côte') + '</button></div>';
      var view = LC.buildQuizView(R, pages, S.quizVer, activeGrid(), meta);
      var cmp = null;
      if (canCompare && S.quizCompare) {
        cmp = V.list.slice(0, 4).map(function (v) { return { v: v, view: LC.buildQuizView(R, pages, v.key, activeGrid(), meta) }; });
      }
      var cur = S.quizVer ? V.list.filter(function (v) { return v.key === S.quizVer; })[0] : V.all;
      h += card('🧭 Parcours — ' + esc(cur.name), cur.sub ? esc(cur.sub) : '', parcours(view, cmp, cur));
      if (V.hiddenLeads) h += '<div class="fn-stage-note" style="margin:-6px 0 14px">Seuls les quiz en ligne sont affichés. ' + fNum(V.hiddenLeads) + ' lead' + (V.hiddenLeads > 1 ? 's' : '') + ' de la période vien' + (V.hiddenLeads > 1 ? 'nent' : 't') + ' de pages hors ligne ou anciennes : ils restent comptés dans la vue d\'ensemble, le marketing et les closers.</div>';
    }

    var ba = LC.byAnswer(R, activeGrid(), 'form');
    if (ba.questions.length) {
      var body = '<div class="fn-stage-note" style="margin-bottom:10px">Leads arrivés par une VSL, un AlteoForm ou un ancien tunnel : leurs réponses ne viennent pas du quiz. Clique une question pour la déplier.</div>';
      ba.questions.sort(function (a, b) { return a.ord - b.ord; }).forEach(function (q) { body += questionCard(q, ba.total); });
      h += '<details class="fn-help lq-forms"' + (S.formsOpen ? ' open' : '') + '><summary data-lq-forms>📝 Formulaires hors quiz — ' + ba.questions.length + ' question' + (ba.questions.length > 1 ? 's' : '') + ' · ' + fNum(ba.total.leads) + ' leads</summary><div class="hb">' + body + '</div></details>';
    }
    return h;
  }

  function platformBadge(p) {
    if (p === 'youtube') return '<span class="fn-tbadge lq-pyt">▶ YouTube</span>';
    if (p === 'meta') return '<span class="fn-tbadge lq-pmeta">Meta</span>';
    if (p === 'old') return '<span class="fn-tbadge lq-toff">Historique</span>';
    return '<span class="fn-tbadge lq-tq">Ensemble</span>';
  }
  function versionCard(v, active) {
    var a = v.agg;
    return '<div class="lq-vcard' + (active ? ' active' : '') + '" data-lq-ver="' + esc(v.key) + '">'
      + '<div class="lq-vtop">' + platformBadge(v.platform) + (a.avgNote != null ? avgBadge(a.avgNote) : '') + '</div>'
      + '<div class="lq-vname">' + esc(v.name) + '</div><div class="lq-vsub">' + esc(v.sub || '') + '</div>'
      + '<div class="lq-vline">' + (v.starts ? '<strong>' + fNum(v.starts) + '</strong> débuts · ' + fPct(v.completeRate, 0) + ' terminés'
        : (v.views ? '<strong>' + fNum(v.views) + '</strong> visites · ' + fNum(v.optins) + ' formulaires (' + fPct(v.views ? v.optins / v.views * 100 : null, 1) + ')' : '<span class="lq-muted">mesure des visiteurs à venir</span>')) + '</div>'
      + '<div class="lq-vline"><strong>' + fNum(a.leads) + '</strong> leads · ' + fNum(a.closes) + ' close' + (a.closes > 1 ? 's' : '') + ' · <strong>' + fEur(a.cash) + '</strong></div>'
      + (a.closes ? '<div class="lq-vline">' + offerSplit(a) + '</div>' : '') + '</div>';
  }

  /* ── Parcours ── */
  function stepHead(c) {
    var st = c.step, bits = [];
    if (st) {
      bits.push('<strong>' + fNum(st.reached) + '</strong> arrivés' + (st.pctStart != null ? ' · ' + fPct(st.pctStart, 0) + ' des débuts' : ''));
      if (st.conditional) bits.push('<span class="lq-muted">vue par ' + fPct(st.seenPct, 0) + ' des visiteurs</span>');
      else if (st.lost != null) bits.push('<span class="' + (st.lost > 0 ? 'lq-down' : 'lq-muted') + '">−' + fNum(st.lost) + ' perdus ici (' + fPct(st.lostPct, 0) + ')</span>');
    } else if (!c.diag) bits.push('<span class="lq-muted">pas de mesure visiteurs</span>');
    if (c.lq) bits.push(fNum(c.lq.agg.leads) + ' leads');
    var badges = '';
    if (c.diag) badges += ' <span class="fn-tbadge lq-tf">calculé par le quiz</span>';
    if (st && st.conditional) badges += ' <span class="fn-tbadge lq-tf">question conditionnelle</span>';
    if (c.hot) badges += ' <span class="fn-tbadge lq-warn">plus grosse perte</span>';
    return '<div class="lq-step-head"><span class="lq-step-n">' + (c.diag ? '★' : c.n) + '</span><span class="lq-step-t">' + esc(c.label) + badges + '</span><span class="lq-step-m">' + bits.join(' · ') + '</span></div>';
  }
  function answerLine(o) {
    var a = o.agg;
    var tag = o.best ? ' <span class="fn-tbadge lq-good">la plus rentable</span>' : (o.worst ? ' <span class="fn-tbadge lq-warn">la moins rentable</span>' : '');
    var res = a ? '<strong>' + fNum(a.leads) + '</strong> lead' + (a.leads > 1 ? 's' : '') + ' · ' + fNum(a.closes) + ' close' + (a.closes > 1 ? 's' : '') + (a.closes ? ' (' + offerSplit(a) + ')' : '') + ' · <strong>' + fEur(a.cashPerLead) + '</strong> / lead' : '<span class="lq-muted">aucun lead</span>';
    return '<div class="lq-arow"><span class="lq-al">' + esc(o.label) + tag + '</span>'
      + '<span class="lq-av">' + (o.visitorShare != null ? bar(o.visitorShare, 'lq-blue') + '<span class="lq-mono">' + fPct(o.visitorShare, 0) + ' des visiteurs</span>' : '<span class="lq-muted">—</span>') + '</span>'
      + '<span class="lq-ax">' + res + '</span>'
      + '<span class="lq-ap">' + (o.pts != null || o.ko ? ptsChip(o) : '') + '</span></div>';
  }
  function detailTable(c) {
    var h = '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead><tr><th class="l">Réponse</th><th>Visiteurs</th><th>% visiteurs</th><th>Leads</th><th>% leads</th><th>RDV pris</th><th>Présents</th><th>Closes</th><th title="Closes offre Élite (et leur cash)">dont Élite</th><th title="Closes offre Business Phénix (et leur cash)">dont Business</th><th>Closing / lead</th><th>Cash</th><th>Cash / lead</th><th>LQS moyen</th><th>Points</th></tr></thead><tbody>';
    c.answers.forEach(function (o) {
      var a = o.agg;
      h += '<tr><td class="l">' + esc(o.label) + '</td><td>' + fNum(o.visitors) + '</td><td>' + fPct(o.visitorShare, 0) + '</td>'
        + (a ? '<td>' + fNum(a.leads) + '</td><td>' + fPct(o.leadShare, 0) + '</td><td>' + fNum(a.booked) + sub(fPct(a.bookRate, 0)) + '</td><td>' + fNum(a.present) + sub(fPct(a.showRate, 0)) + '</td><td>' + fNum(a.closes) + (a.closesU ? sub(fNum(a.closesU) + ' sans offre') : '') + '</td>'
          + '<td>' + fNum(a.closesE) + (a.closesE ? sub(fEur(a.cashE)) : '') + '</td><td>' + fNum(a.closesB) + (a.closesB ? sub(fEur(a.cashB)) : '') + '</td>'
          + '<td>' + fPct(a.closeLead, 1) + '</td><td>' + fEur(a.cash) + '</td><td><strong>' + fEur(a.cashPerLead) + '</strong></td><td>' + avgBadge(a.avgNote) + '</td>'
          : '<td colspan="11" class="l lq-muted">aucun lead avec cette réponse sur la période</td>')
        + '<td>' + (o.pts != null || o.ko ? ptsChip(o) : '—') + '</td></tr>';
    });
    if (c.lq) {
      var t = c.lq.agg;
      h += '<tr class="tot"><td class="l">Total</td><td>' + (c.step ? fNum(c.step.answered) : '—') + '</td><td></td><td>' + fNum(t.leads) + '</td><td>100 %</td><td>' + fNum(t.booked) + '</td><td>' + fNum(t.present) + '</td><td>' + fNum(t.closes) + '</td><td>' + fNum(t.closesE) + (t.closesE ? sub(fEur(t.cashE)) : '') + '</td><td>' + fNum(t.closesB) + (t.closesB ? sub(fEur(t.cashB)) : '') + '</td><td>' + fPct(t.closeLead, 1) + '</td><td>' + fEur(t.cash) + '</td><td>' + fEur(t.cashPerLead) + '</td><td>' + avgBadge(t.avgNote) + '</td><td></td></tr>';
    }
    return h + '</tbody></table></div>';
  }
  function compareTable(c, cmp) {
    var others = cmp.map(function (x) {
      var k = LC.keyOf(c.label);
      var cc = x.view.cards.filter(function (y) { return LC.keyOf(y.label) === k || (c.q && y.q === c.q); })[0] || null;
      return { v: x.v, c: cc };
    });
    var h = '<div class="fn-table-wrap"><table class="fn-igt lq-t lq-cmp"><thead><tr><th class="l" rowspan="2">Réponse</th>';
    others.forEach(function (o) { h += '<th colspan="3" class="lq-cmp-g">' + platformBadge(o.v.platform) + ' ' + esc(o.v.name) + '</th>'; });
    h += '</tr><tr>';
    others.forEach(function () { h += '<th class="lq-cmp-g">% visit.</th><th>Leads</th><th>€ / lead</th>'; });
    h += '</tr></thead><tbody>';
    c.answers.forEach(function (ans) {
      h += '<tr><td class="l">' + esc(ans.label) + '</td>';
      others.forEach(function (o) {
        var m = o.c ? o.c.answers.filter(function (x) { return x.key === ans.key; })[0] : null;
        h += '<td class="lq-cmp-g">' + (m ? fPct(m.visitorShare, 0) : '—') + '</td><td>' + (m && m.agg ? fNum(m.agg.leads) : '—') + '</td><td>' + (m && m.agg ? fEur(m.agg.cashPerLead) : '—') + '</td>';
      });
      h += '</tr>';
    });
    h += '<tr class="tot"><td class="l">Arrivés à la question</td>';
    others.forEach(function (o) { h += '<td class="lq-cmp-g">' + (o.c && o.c.step ? fNum(o.c.step.reached) : '—') + '</td><td>' + (o.c && o.c.lq ? fNum(o.c.lq.agg.leads) : '—') + '</td><td>' + (o.c && o.c.lq ? fEur(o.c.lq.agg.cashPerLead) : '—') + '</td>'; });
    return h + '</tr></tbody></table></div>';
  }
  function parcours(view, cmp, cur) {
    var d = view.drop, t = view.total;
    var h = '';
    if (!d.has) {
      h += '<div class="fn-alert" style="margin:0 0 12px">Mesure question par question pas encore active pour cette version : « quiz commencés / terminés », pertes et « % des visiteurs » apparaîtront dès l\'instrumentation de la page (elle ne se reconstitue pas pour le passé). En attendant : visites de la page et formulaires envoyés, déjà mesurés.</div>';
      if (cur && cur.views) h += '<div class="lq-strip" style="margin-bottom:14px">'
        + stripStep(fNum(cur.views), 'Visites de la page', 'une session = une visite')
        + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(cur.optins), 'Formulaires envoyés', fPct(cur.views ? cur.optins / cur.views * 100 : null, 1) + ' des visites')
        + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.leads), 'Leads de la période', 'avec réponses au quiz')
        + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.booked), 'RDV pris', fPct(t.bookRate, 0) + ' des leads')
        + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.closes), 'Closes', (t.closes ? offerSplit(t) : fPct(t.closeLead, 1) + ' des leads'))
        + '<div class="lq-strip-arrow">›</div>' + stripStep(fEur(t.cash), 'Cash encaissé', t.leads ? fEur(t.cash / t.leads) + ' / lead' : '')
        + '</div>';
    }
    else h += '<div class="lq-strip" style="margin-bottom:14px">'
      + (cur && cur.views ? stripStep(fNum(cur.views), 'Visites de la page', '') + '<div class="lq-strip-arrow">›</div>' : '')
      + stripStep(fNum(d.starts), 'Quiz commencés', cur && cur.views ? fPct(d.starts / cur.views * 100, 0) + ' des visites' : '')
      + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(d.completes), 'Quiz terminés', fPct(d.completeRate, 0) + ' des débuts')
      + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.leads), 'Formulaires envoyés', 'leads de la période')
      + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.booked), 'RDV pris', fPct(t.bookRate, 0) + ' des leads')
      + '<div class="lq-strip-arrow">›</div>' + stripStep(fNum(t.closes), 'Closes', (t.closes ? offerSplit(t) : fPct(t.closeLead, 1) + ' des leads'))
      + '<div class="lq-strip-arrow">›</div>' + stripStep(fEur(t.cash), 'Cash encaissé', t.leads ? fEur(t.cash / t.leads) + ' / lead' : '')
      + '</div>';
    if (!view.cards.length) return h + '<div class="lq-muted">Aucune question à afficher.</div>';
    var gateDone = false;
    view.cards.forEach(function (c) {
      var key = view.versionKey + '|' + (c.q || c.label);
      var open = !!S.openDetail[key];
      h += '<div class="lq-step' + (c.hot ? ' hot' : '') + (c.diag ? ' diag' : '') + '">' + stepHead(c);
      if (cmp) h += compareTable(c, cmp);
      else {
        h += '<div class="lq-alist">';
        c.answers.forEach(function (o) { h += answerLine(o); });
        h += '</div>';
        h += '<button class="fn-ig-detbtn lq-detbtn" data-lq-det="' + esc(key) + '">' + (open ? '▾ masquer le détail' : '▸ détail complet (RDV, présents, closing, LQS…)') + '</button>';
        if (open) h += detailTable(c);
      }
      h += '</div>';
      if (!gateDone && d.gate.shown && c.step && /ca[-_ ]?mensuel/i.test(c.step.id)) {
        gateDone = true;
        h += gateBlock(d.gate);
      }
    });
    if (!gateDone && d.gate.shown) h += gateBlock(d.gate);
    if (d.has) h += '<div class="lq-step end"><div class="lq-step-head"><span class="lq-step-n">✓</span><span class="lq-step-t">Quiz terminé (résultats affichés)</span><span class="lq-step-m"><strong>' + fNum(d.completes) + '</strong> visiteurs · ' + fPct(d.completeRate, 0) + ' des débuts'
      + (d.lastReached ? ' · <span class="lq-down">−' + fNum(Math.max(0, d.lastReached - d.completes)) + ' perdus après la dernière question</span>' : '') + '</span></div></div>';
    return h;
  }
  function gateBlock(g) {
    return '<div class="lq-step gate"><div class="lq-step-head"><span class="lq-step-n">€</span><span class="lq-step-t">Écran prix (CA mensuel ≤ 20 000 €)</span><span class="lq-step-m">vu <strong>' + fNum(g.shown) + '</strong> fois · '
      + fNum(g['continue']) + ' continuent (' + fPct(g.shown ? g['continue'] / g.shown * 100 : null, 0) + ') · <span class="lq-down">' + fNum(g.exit) + ' s\'arrêtent</span></span></div></div>';
  }
  function stripStep(v, l, s) { return '<div class="lq-strip-step"><div class="v">' + v + '</div><div class="l">' + l + '</div><div class="s">' + (s || '&nbsp;') + '</div></div>'; }

  function questionCard(q, tot) {
    var open = !!S.openQ[q.q];
    var best = null, worst = null;
    q.answerList.forEach(function (x) {
      if (x.agg.leads < LC.SUGGEST_MIN || x.agg.cashPerLead == null) return;
      if (!best || x.agg.cashPerLead > best.agg.cashPerLead) best = x;
      if (!worst || x.agg.cashPerLead < worst.agg.cashPerLead) worst = x;
    });
    var h = '<div class="lq-qcard' + (q.off ? ' off' : '') + '"><div class="lq-qhead" data-lq-q="' + esc(q.q) + '">'
      + '<span class="lq-caret">' + (open ? '▾' : '▸') + '</span><span class="lq-qt">' + esc(q.label) + '</span>'
      + '<span class="fn-tbadge ' + (q.origin === 'quiz' ? 'lq-tq' : 'lq-tf') + '">' + (q.origin === 'quiz' ? 'Quiz' : 'Formulaire') + '</span>'
      + (q.off ? '<span class="fn-tbadge lq-toff">ignorée dans la note</span>' : '')
      + '<span class="lq-qmeta">' + fNum(q.agg.leads) + ' leads · ' + q.answerList.length + ' réponse' + (q.answerList.length > 1 ? 's' : '')
      + (best && worst && best !== worst ? ' · meilleure : <strong>' + esc(best.label) + '</strong>' : '') + '</span></div>';
    if (open) {
      var list = q.answerList.slice(0, 30);
      h += '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead><tr><th class="l">Réponse</th><th>Points</th><th>Leads</th><th>Part</th><th>RDV pris</th><th>Présents</th><th>Closes</th><th>Closing / lead</th><th>Cash</th><th>Cash / lead</th><th>LQS moyen</th></tr></thead><tbody>';
      list.forEach(function (x) {
        var a = x.agg;
        var tag = x === best && best !== worst ? ' <span class="fn-tbadge lq-good">la plus rentable</span>' : (x === worst && best !== worst ? ' <span class="fn-tbadge lq-warn">la moins rentable</span>' : '');
        h += '<tr><td class="l">' + esc(x.label) + tag + '</td>'
          + '<td>' + ptsChip(x) + '</td><td>' + fNum(a.leads) + '</td><td>' + fPct(x.share, 0) + '</td>'
          + '<td>' + fNum(a.booked) + sub(fPct(a.bookRate, 0)) + '</td><td>' + fNum(a.present) + sub(fPct(a.showRate, 0)) + '</td>'
          + '<td>' + fNum(a.closes) + '</td><td>' + fPct(a.closeLead, 1) + '</td>'
          + '<td>' + fEur(a.cash) + '</td><td><strong>' + fEur(a.cashPerLead) + '</strong></td><td>' + avgBadge(a.avgNote) + '</td></tr>';
      });
      if (q.answerList.length > list.length) h += '<tr><td class="l lq-muted" colspan="11">+ ' + (q.answerList.length - list.length) + ' autres réponses (texte libre), moins fréquentes.</td></tr>';
      h += '<tr class="tot"><td class="l">Toutes les réponses</td><td></td><td>' + fNum(q.agg.leads) + '</td><td>100 %</td><td>' + fNum(q.agg.booked) + '</td><td>' + fNum(q.agg.present) + '</td><td>' + fNum(q.agg.closes) + '</td><td>' + fPct(q.agg.closeLead, 1) + '</td><td>' + fEur(q.agg.cash) + '</td><td>' + fEur(q.agg.cashPerLead) + '</td><td>' + avgBadge(q.agg.avgNote) + '</td></tr>';
      h += '</tbody></table></div>';
    }
    return h + '</div>';
  }
  function ptsChip(x) {
    if (x.ko) return '<span class="lq-pts ko" title="Réponse éliminatoire : note 1">⛔</span>';
    var cls = x.pts > 0 ? 'pos' : (x.pts < 0 ? 'neg' : '');
    return '<span class="lq-pts ' + cls + '"' + (x.known ? '' : ' title="Points par défaut (réponse pas encore revue dans le barème)"') + '>' + fPts(x.pts) + (x.known ? '' : '*') + '</span>';
  }

  /* ══ VUE 3 — MARKETING (MQS) ═══════════════════════════════════════════ */
  var AXES = [['campaign', 'Campagne'], ['adset', 'Adset / audience'], ['creative', 'Créa'], ['channel', 'Canal']];
  function viewMarketing() {
    var R = rows();
    var ax = LC.byAxis(R, S.axis, S.M.adsByAd, S.ctx.tunnelFilter);
    var h = help('ℹ️ Comment se calcule le MQS', '<p><strong>MQS = 60 % qualité + 40 % résultats</strong>, sur 5.</p><p><strong>Qualité</strong> = LQS moyen des leads de la source (ce que leurs réponses valent).<br><strong>Résultats</strong> = cash encaissé par lead de la source, comparé à la moyenne : 2× la moyenne ou plus → 5 ; ≥ 1,25× → 4 ; ≥ 0,75× → 3 ; ≥ 0,35× → 2 ; sinon 1. Les petits effectifs sont ramenés vers la moyenne pour ne pas s\'emballer sur 2 leads.</p>'
      + '<p>Sous ' + LC.MQS_MIN + ' leads notés : « n.s. » (non significatif). <strong>Une créa de découverte</strong> peut avoir un MQS moyen et nourrir les autres : à lire avec la colonne Dépense et le Journal avant de couper.</p>'
      + '<p>Les leads sans UTM tombent dans « Pub · créative non transmise » ou « Hors pub ». Pour que chaque 4-5 remonte à sa créa, toutes les pubs doivent porter le modèle d\'URL Meta (utm_content={{ad.name}} ou {{ad.id}}).</p>');
    h += '<div class="fn-seg" style="margin-bottom:14px;width:fit-content">';
    AXES.forEach(function (a) { h += '<button data-lq-axis="' + a[0] + '" class="' + (S.axis === a[0] ? 'active' : '') + '">' + a[1] + '</button>'; });
    h += '</div>';
    var withMqs = ax.rows.filter(function (x) { return x.m; }).sort(function (a, b) { return b.m.mqs - a.m.mqs; });
    if (withMqs.length >= 2) {
      var top = withMqs[0], low = withMqs[withMqs.length - 1];
      h += '<div class="fn-rates"><span class="rt">🏆 Meilleure source : <strong>' + esc(top.label) + '</strong> MQS ' + fDec(top.m.mqs, 1) + ' · ' + fPct(top.agg.pct45, 0) + ' de 4-5 · ' + fEur(top.agg.cashPerLead) + ' / lead</span>'
        + '<span class="rt">⚠️ Plus faible : <strong>' + esc(low.label) + '</strong> MQS ' + fDec(low.m.mqs, 1) + ' · ' + fPct(low.agg.pct45, 0) + ' de 4-5</span></div>';
    }
    var t = ax.total;
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Source</th><th title="Marketing Quality Score">MQS</th><th>Dépense</th><th>Leads</th><th>CPL</th><th>LQS moyen</th><th>% 4-5</th><th title="Dépense ÷ leads notés 4-5">Coût / lead 4-5</th><th class="l" style="min-width:110px">Répartition</th><th>RDV</th><th>Présents</th><th>Closes</th><th>Cash</th><th>ROAS</th></tr></thead><tbody>';
    ax.rows.forEach(function (x) {
      var a = x.agg;
      body += '<tr' + (x.outOfAds ? ' class="lq-dim"' : '') + '><td class="l"><span class="lq-src" title="' + esc(x.label) + '">' + esc(x.label) + '</span>' + (x.legacy ? ' <span class="fn-tbadge lq-toff" title="Attribution reconstruite depuis l\'ancien champ utm">⚠</span>' : '') + '</td>'
        + '<td>' + mqsBadge(x.m) + '</td><td>' + (x.hasSpend ? fEur(x.spend) : '—') + '</td><td>' + fNum(a.leads) + '</td><td>' + fEur(x.cpl) + '</td>'
        + '<td>' + avgBadge(a.avgNote) + '</td><td>' + fPct(a.pct45, 0) + '</td><td>' + fEur(x.cpl45) + '</td><td class="l">' + distBar(a.dist) + '</td>'
        + '<td>' + fNum(a.booked) + '</td><td>' + fNum(a.present) + '</td><td>' + fNum(a.closes) + '</td><td><strong>' + fEur(a.cash) + '</strong></td><td>' + fRoas(x.roas) + '</td></tr>';
    });
    body += '<tr class="tot"><td class="l">Total</td><td></td><td>' + (ax.spend ? fEur(ax.spend) : '—') + '</td><td>' + fNum(t.leads) + '</td><td>' + fEur(ax.spend && t.leads ? ax.spend / t.leads : null) + '</td><td>' + avgBadge(t.avgNote) + '</td><td>' + fPct(t.pct45, 0) + '</td><td>' + fEur(ax.spend && t.n45 ? ax.spend / t.n45 : null) + '</td><td class="l">' + distBar(t.dist) + '</td><td>' + fNum(t.booked) + '</td><td>' + fNum(t.present) + '</td><td>' + fNum(t.closes) + '</td><td>' + fEur(t.cash) + '</td><td>' + fRoas(ax.spend > 0 && t.cash > 0 ? t.cash / ax.spend : null) + '</td></tr>';
    body += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">Leads entrés dans la période · dépense = données Meta par pub (ads_insights_ad) quand Make les envoie, sinon « — » · cash = encaissé à ce jour (HT) par les leads de la ligne · les lignes « hors pub » sont en bas.</div>';
    h += card('📣 Qualité par ' + AXES.filter(function (a) { return a[0] === S.axis; })[0][1].toLowerCase(), S.closer ? 'leads de ' + esc(S.M.memberName(S.closer)) : '', body);
    return h;
  }

  /* ══ VUE 4 — CLOSERS ═══════════════════════════════════════════════════ */
  function viewClosers() {
    var h = '<div class="fn-seg" style="margin-bottom:14px;width:fit-content">'
      + '<button data-lq-cr="period" class="' + (S.crMode === 'period' ? 'active' : '') + '">Période sélectionnée</button>'
      + '<button data-lq-cr="3m" class="' + (S.crMode === '3m' ? 'active' : '') + '">3 derniers mois</button>'
      + '<button data-lq-cr="6m" class="' + (S.crMode === '6m' ? 'active' : '') + '">6 derniers mois</button></div>';
    var board = LC.closerBoard(S.M.rdvRows, S.M.memberName);
    var team = LC.byCloser(S.M.rdvRows, '');
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Closer</th><th>RDV</th><th>% de 4-5</th><th title="LQS moyen des RDV">Qualité du pipe</th><th class="l" style="min-width:110px">Répartition</th><th>Présents</th><th>Closes</th><th>Closing / présents</th><th>Closing / RDV</th><th>Cash</th></tr></thead><tbody>';
    board.forEach(function (a) {
      var departed = a.slug && !S.M.closers.some(function (c) { return c.slug === a.slug; });
      if (departed) return;
      var sel = a.slug && a.slug === S.closer;
      body += '<tr class="' + (a.slug ? 'lq-click' : '') + (sel ? ' lq-sel' : '') + '"' + (a.slug ? ' data-lq-pick="' + esc(a.slug) + '"' : '') + '><td class="l"><strong>' + esc(a.name) + '</strong></td><td>' + fNum(a.rdv) + '</td><td>' + fPct(a.pct45, 0) + '</td><td>' + avgBadge(a.avgNote) + '</td><td class="l">' + distBar(a.dist) + '</td>'
        + '<td>' + fNum(a.present) + sub(fPct(a.showRate, 0)) + '</td><td><strong>' + fNum(a.closes) + '</strong></td><td>' + fPct(a.closePresent, 0) + '</td><td>' + fPct(a.closeRdv, 0) + '</td><td>' + fEur(a.cash) + '</td></tr>';
    });
    var tt = team.total;
    body += '<tr class="tot"><td class="l">Toute l\'équipe</td><td>' + fNum(tt.rdv) + '</td><td>' + fPct(tt.pct45, 0) + '</td><td>' + avgBadge(tt.avgNote) + '</td><td class="l">' + distBar(tt.dist) + '</td><td>' + fNum(tt.present) + sub(fPct(tt.showRate, 0)) + '</td><td>' + fNum(tt.closes) + '</td><td>' + fPct(tt.closePresent, 0) + '</td><td>' + fPct(tt.closeRdv, 0) + '</td><td>' + fEur(tt.cash) + '</td></tr>';
    body += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">RDV de vente datés dans la plage (replanifiés comptés une fois, sur leur dernier RDV) · closer = celui qui a statué le close, sinon l\'expert du RDV · clique un closer pour son détail. Les membres partis sont comptés dans « Toute l\'équipe » sans être listés.</div>';
    h += card('🎯 Closers — qualité reçue et résultats', fMonth(FC.isoDate(closerRange().start).slice(0, 7)) + ' → ' + fMonth(FC.isoDate(closerRange().end).slice(0, 7)), body);

    if (!S.closer) {
      h += card('📅 Toute l\'équipe, mois par mois', '', monthsTable(team, null) + '<div class="fn-stage-note" style="margin-top:8px">Choisis un closer (en haut ou dans le tableau) pour sa lecture détaillée.</div>');
      return h;
    }
    var me = LC.byCloser(S.M.rdvRows, S.closer);
    var name = S.M.memberName(S.closer);
    h += card('📅 ' + esc(name) + ', mois par mois', '', monthsTable(me, team));
    /* Closing par note : le closer vs l'équipe */
    var nb = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Note du lead</th><th>RDV</th><th>Présents</th><th>Closes</th><th>Closing / présents</th><th>Équipe : closing / présents</th><th>Cash</th></tr></thead><tbody>';
    LC.NOTE_KEYS.forEach(function (k) {
      var a = me.byNote[k], tb = team.byNote[k];
      if (!a.rdv) return;
      var diff = ok(a.closePresent) && ok(tb.closePresent) ? a.closePresent - tb.closePresent : null;
      nb += '<tr><td class="l">' + noteBadge(k || null) + ' <span class="lq-nl">' + NOTE_LBL[k] + '</span></td><td>' + fNum(a.rdv) + '</td><td>' + fNum(a.present) + '</td><td><strong>' + fNum(a.closes) + '</strong></td>'
        + '<td>' + fPct(a.closePresent, 0) + (diff != null ? sub('<span class="' + (diff >= 0 ? 'lq-up' : 'lq-down') + '">' + (diff >= 0 ? '+' : '') + fDec(diff, 0) + ' pts vs équipe</span>') : '') + '</td>'
        + '<td>' + fPct(tb.closePresent, 0) + '</td><td>' + fEur(a.cash) + '</td></tr>';
    });
    nb += '</tbody></table></div>';
    h += card('⭐ ' + esc(name) + ' — closing selon la qualité du lead', 'à qualité égale, le closer fait-il mieux ou moins bien que l\'équipe ?', nb);
    return h;
  }

  function monthsTable(me, team) {
    if (!me.months.length) return '<div class="lq-muted">Aucun RDV sur la plage.</div>';
    var teamBy = {};
    if (team) team.months.forEach(function (m) { teamBy[m.month] = m; });
    var h = '<ul class="lq-ins" style="margin-bottom:12px">';
    me.months.forEach(function (m) {
      h += '<li><strong>' + cap(fMonth(m.month)) + '</strong> : ' + fNum(m.rdv) + ' RDV, <strong>' + fPct(m.pct45, 1) + '</strong> de 4-5, qualité du pipe <strong>' + fDec(m.avgNote, 2) + '</strong>, '
        + fNum(m.closes) + ' close' + (m.closes > 1 ? 's' : '') + ' → closing <strong>' + fPct(m.closePresent, 1) + '</strong> des présents'
        + (team && teamBy[m.month] ? ' <span class="lq-muted">(équipe : ' + fPct(teamBy[m.month].pct45, 0) + ' de 4-5, closing ' + fPct(teamBy[m.month].closePresent, 0) + ')</span>' : '') + '.</li>';
    });
    h += '</ul>';
    h += '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Mois</th><th>RDV</th><th>Annulés</th><th>No-show</th><th>Présents</th><th>% de 4-5</th><th>Qualité du pipe</th><th class="l" style="min-width:110px">Répartition</th><th>Closes</th><th>Closing / présents</th><th>Closing / RDV</th><th>Cash</th>' + (team ? '<th>Équipe : 4-5 / closing</th>' : '') + '</tr></thead><tbody>';
    me.months.forEach(function (m) {
      var tm = teamBy[m.month];
      h += '<tr><td class="l"><strong>' + cap(fMonth(m.month)) + '</strong>' + (m.upcoming ? sub(fNum(m.upcoming) + ' à venir') : '') + '</td><td>' + fNum(m.rdv) + '</td><td>' + fNum(m.cancelled) + '</td><td>' + fNum(m.noshow) + '</td><td>' + fNum(m.present) + sub(fPct(m.showRate, 0)) + '</td>'
        + '<td>' + fPct(m.pct45, 1) + '</td><td>' + avgBadge(m.avgNote) + '</td><td class="l">' + distBar(m.dist) + '</td><td><strong>' + fNum(m.closes) + '</strong></td><td>' + fPct(m.closePresent, 1) + '</td><td>' + fPct(m.closeRdv, 1) + '</td><td>' + fEur(m.cash) + '</td>'
        + (team ? '<td>' + (tm ? fPct(tm.pct45, 0) + ' / ' + fPct(tm.closePresent, 0) : '—') + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table></div>';
    return h;
  }

  /* ══ VUE 5 — LEADS NOTÉS ═══════════════════════════════════════════════ */
  function viewLeads() {
    var all = rows();
    var counts = { all: all.length, 5: 0, 4: 0, 3: 0, 2: 0, 1: 0, 0: 0 };
    all.forEach(function (r) { counts[r.note == null ? 0 : r.note]++; });
    var q = LC.norm(S.leadsQ);
    var list = all.filter(function (r) {
      if (S.leadsNote !== 'all' && String(r.note == null ? 0 : r.note) !== S.leadsNote) return false;
      if (q) {
        var l = r.lead;
        var hay = LC.norm([l.nom, l.email, l.telephone, r.sourceLabel, r.axes.creative && r.axes.creative.label, r.closerName].join(' '));
        if (hay.indexOf(q) < 0) return false;
      }
      return true;
    }).sort(function (a, b) {
      var na = a.note == null ? -1 : a.note, nb2 = b.note == null ? -1 : b.note;
      return (nb2 - na) || ((b.pts || 0) - (a.pts || 0)) || ((b.entry || 0) - (a.entry || 0));
    });
    var h = '<div class="fn-lt-toolbar"><div class="fn-seg">';
    [['all', 'Toutes'], ['5', '5'], ['4', '4'], ['3', '3'], ['2', '2'], ['1', '1'], ['0', 'Non notés']].forEach(function (x) {
      h += '<button data-lq-ln="' + x[0] + '" class="' + (S.leadsNote === x[0] ? 'active' : '') + '">' + x[1] + ' <span class="lq-muted">' + counts[x[0]] + '</span></button>';
    });
    h += '</div><div class="fn-lt-search"><input type="text" data-lq-search placeholder="Nom, email, source, closer…" value="' + esc(S.leadsQ) + '"></div></div>';
    var shown = list.slice(0, S.leadsLimit);
    h += '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Lead</th><th>Entrée</th><th class="l">Source</th><th>LQS</th><th>Points</th><th title="Curseur ★ de l\'équipe (Leads Live)">★ équipe</th><th class="l">Parcours</th><th class="l">Closer</th><th>Cash</th></tr></thead><tbody>';
    shown.forEach(function (r) {
      var l = r.lead, open = !!S.openLead[r.id];
      var path = [];
      if (r.closed) path.push('<span class="fn-tbadge lq-good">💰 Client</span>');
      else if (r.closeCancelled) path.push('<span class="fn-tbadge lq-warn">close annulé</span>');
      else if (r.present) path.push('<span class="fn-tbadge lq-tq">présent</span>');
      else if (r.upcoming) path.push('<span class="fn-tbadge lq-tf">RDV à venir</span>');
      else if (r.noshow) path.push('<span class="fn-tbadge lq-warn">no-show</span>');
      else if (r.booked && r.allCancelled) path.push('<span class="fn-tbadge lq-toff">annulé</span>');
      else if (r.booked) path.push('<span class="fn-tbadge lq-tf">RDV</span>');
      else path.push('<span class="lq-muted">pas de RDV</span>');
      if (r.reopt) path.push('<span class="fn-reopt" title="Ré-optin dans la période">↻</span>');
      h += '<tr class="lq-click" data-lq-lead="' + esc(r.id) + '"><td class="l"><a class="fn-lead-link" href="sales-contact.html?id=' + encodeURIComponent(r.id) + '" target="_blank" rel="noopener">' + esc(l.nom || l.email || '—') + '</a></td>'
        + '<td>' + fDay(r.entry) + '</td><td class="l"><span class="lq-src" title="' + esc(r.axes.creative ? r.axes.creative.label : '') + '">' + esc(r.axes.creative ? r.axes.creative.label : r.sourceLabel) + '</span></td>'
        + '<td>' + noteBadge(r.note) + '</td><td>' + (r.pts != null ? fPts(r.pts) : '—') + '</td><td>' + (r.team != null ? '★ ' + r.team : '—') + '</td>'
        + '<td class="l">' + path.join(' ') + '</td><td class="l">' + esc(r.closerName || '—') + '</td><td>' + (r.closed ? fEur(r.cash) : '—') + '</td></tr>';
      if (open) {
        h += '<tr class="fn-ig-det"><td colspan="9" class="l">';
        if (!r.detail.length) h += '<span class="lq-muted">Aucune réponse exploitable sur cette fiche.</span>';
        r.detail.forEach(function (d) {
          h += '<div class="lq-ansline"><span><span class="lq-muted">' + esc(d.ql) + '</span> — ' + esc(d.al) + '</span><span class="lq-pts ' + (d.ko ? 'ko' : (d.pts > 0 ? 'pos' : (d.pts < 0 ? 'neg' : ''))) + '">' + (d.ko ? '⛔ éliminatoire' : fPts(d.pts) + (d.known ? '' : '*')) + '</span></div>';
        });
        if (r.detail.length) h += '<div class="lq-ansline lq-anstot"><span>Total</span><span>' + fPts(r.pts) + ' → note ' + (r.note || '—') + '</span></div>';
        h += '</td></tr>';
      }
    });
    if (!shown.length) h += '<tr><td colspan="9" class="l lq-muted">Aucun lead.</td></tr>';
    h += '</tbody></table></div>';
    if (list.length > shown.length) h += '<div style="margin-top:10px"><button class="fn-btn" data-lq-more>Afficher plus (' + (list.length - shown.length) + ' restants)</button></div>';
    h += '<div class="fn-stage-note" style="margin-top:8px">Clique une ligne pour le détail des points. * = points par défaut (réponse pas encore revue dans le barème).</div>';
    return card('👥 Leads de la période, notés', fNum(list.length) + ' leads', h);
  }

  /* ══ VUE 6 — BARÈME ════════════════════════════════════════════════════ */
  function ensureDraft() {
    if (!S.draft) S.draft = JSON.parse(JSON.stringify(S.grid || LC.normalizeGrid(null)));
    return S.draft;
  }
  function draftAnswer(qk, qLabel, ak, aLabel) {
    var d = ensureDraft();
    var q = d.questions[qk] || (d.questions[qk] = { label: qLabel, off: false, answers: {} });
    if (!q.answers[ak]) q.answers[ak] = { label: aLabel, pts: LC.defaultPoints(qk, qLabel, aLabel), ko: false };
    return q.answers[ak];
  }
  function viewGrid() {
    var g = activeGrid();
    var allRows = S.M.rows;   // barème : toute l'équipe, sans filtre closer
    var ba = LC.byAnswer(allRows, g);
    var dist = [0, 0, 0, 0, 0, 0];
    allRows.forEach(function (r) { dist[r.note == null ? 0 : r.note]++; });
    var th = g.thresholds;
    var h = help('ℹ️ Comment fonctionne le barème', '<p>Chaque réponse rapporte des <strong>points</strong> (négatifs permis). On additionne les points de toutes les réponses du lead, puis on convertit en note grâce aux <strong>seuils</strong>. Une réponse <strong>⛔ éliminatoire</strong> donne 1 quel que soit le total.</p>'
      + '<p><strong>Points par défaut</strong> (*) : posés automatiquement sur ce qui se lit sans ambiguïté — CA mensuel (−2 sous 5 k€ … +3 au-delà de 100 k€), taille d\'équipe, heures, objectif. Tout le reste démarre à 0.</p>'
      + '<p><strong>Suggestion</strong> : ce que les résultats réels proposent — cash encaissé par lead de la réponse comparé à la moyenne (dès 8 closes sur la période), à défaut taux de RDV honorés (dès 10 présents), dès ' + LC.SUGGEST_MIN + ' leads par réponse. C\'est une aide, pas une vérité : sur une période courte, élargis-la (3 à 6 mois) avant d\'appliquer.</p>'
      + '<p>Modifier un point recalcule <strong>immédiatement</strong> tous les onglets (aperçu). Rien n\'est enregistré tant que tu n\'as pas cliqué « Enregistrer ». Le barème s\'applique à tout l\'historique : aucune donnée n\'est réécrite sur les leads.</p>');

    var st = '<div class="lq-th">';
    [['n5', 5], ['n4', 4], ['n3', 3], ['n2', 2]].forEach(function (x) {
      st += '<label>' + noteBadge(x[1]) + ' si total ≥ <input type="number" step="0.5" data-lq-th="' + x[0] + '" value="' + esc(th[x[0]]) + '"> pts</label>';
    });
    st += '<label>' + noteBadge(1) + ' sinon</label></div>';
    st += '<div class="lq-preview">' + distBar(dist) + '<div class="lq-preview-l">';
    [5, 4, 3, 2, 1, 0].forEach(function (k) { st += '<span>' + noteBadge(k || null) + ' ' + fNum(dist[k]) + '</span>'; });
    st += '</div></div>';
    st += '<div class="lq-actions"><button class="fn-btn" data-lq-sugg-all>✨ Appliquer toutes les suggestions</button>'
      + '<button class="fn-btn" data-lq-reset' + (S.draft ? '' : ' disabled') + '>↺ Annuler les modifications</button>'
      + '<button class="fn-btn primary" data-lq-save' + (S.draft && !S.saving ? '' : ' disabled') + '>' + (S.saving ? 'Enregistrement…' : '💾 Enregistrer le barème') + '</button>'
      + '<span class="lq-muted">' + (S.grid && S.grid.updatedBy ? 'Dernier enregistrement : ' + esc(S.grid.updatedBy) : 'Barème jamais enregistré : points par défaut') + '</span></div>';
    var basis = LC.suggestBasis(ba.total);
    st += '<div class="fn-stage-note" style="margin-top:8px">Suggestions calculées sur : <strong>' + (basis === 'cash' ? 'le cash encaissé par lead' : (basis === 'present' ? 'les RDV honorés par lead (pas assez de closes sur la période)' : 'rien — trop peu de données sur la période, élargis-la')) + '</strong>.</div>';
    h += card('🎚️ Seuils et répartition (aperçu en direct)', 'leads de la période, toute l\'équipe', st);

    var body = '';
    if (!ba.questions.length) body = '<div class="lq-muted">Aucune réponse sur les leads de la période : élargis la période pour voir les questions à noter.</div>';
    ba.questions.forEach(function (q) {
      var open = S.openQ['g_' + q.q] !== false;
      body += '<div class="lq-qcard' + (q.off ? ' off' : '') + '"><div class="lq-qhead" data-lq-q="g_' + esc(q.q) + '"><span class="lq-caret">' + (open ? '▾' : '▸') + '</span><span class="lq-qt">' + esc(q.label) + '</span>'
        + '<span class="fn-tbadge ' + (q.origin === 'quiz' ? 'lq-tq' : 'lq-tf') + '">' + (q.origin === 'quiz' ? 'Quiz' : 'Formulaire') + '</span>'
        + '<label class="lq-off" data-lq-stop><input type="checkbox" data-lq-qoff="' + esc(q.q) + '" data-lq-ql="' + esc(q.label) + '"' + (q.off ? '' : ' checked') + '> compter cette question</label>'
        + '<span class="lq-qmeta">' + fNum(q.agg.leads) + ' leads</span></div>';
      if (open && !q.off) {
        var list = q.answerList.slice(0, 40);
        body += '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead><tr><th class="l">Réponse</th><th>Leads</th><th>Closing / lead</th><th>Cash / lead</th><th title="Proposé par les résultats réels">Suggestion</th><th>Points</th><th title="Note 1 d\'office">⛔ Éliminatoire</th></tr></thead><tbody>';
        list.forEach(function (x) {
          var id = esc(q.q) + '" data-lq-a="' + esc(x.a) + '" data-lq-ql="' + esc(q.label) + '" data-lq-al="' + esc(x.label);
          body += '<tr><td class="l">' + esc(x.label) + (x.known ? '' : ' <span class="fn-tbadge lq-tf" title="Réponse jamais revue : points par défaut">nouveau</span>') + '</td>'
            + '<td>' + fNum(x.agg.leads) + '</td><td>' + fPct(x.agg.closeLead, 1) + '</td><td>' + fEur(x.agg.cashPerLead) + '</td>'
            + '<td>' + (x.suggest == null ? '<span class="lq-muted" title="Moins de ' + LC.SUGGEST_MIN + ' leads">—</span>' : '<button class="fn-ig-detbtn" data-lq-sugg="' + id + '" data-lq-v="' + x.suggest + '" title="Appliquer">' + fPts(x.suggest) + '</button>') + '</td>'
            + '<td><input class="lq-in' + (x.known ? '' : ' def') + '" type="number" step="0.5" data-lq-pts="' + id + '" value="' + esc(x.pts) + '"></td>'
            + '<td><input type="checkbox" data-lq-ko="' + id + '"' + (x.ko ? ' checked' : '') + '></td></tr>';
        });
        if (q.answerList.length > list.length) body += '<tr><td class="l lq-muted" colspan="7">+ ' + (q.answerList.length - list.length) + ' réponses rares (texte libre) : 0 point par défaut.</td></tr>';
        body += '</tbody></table></div>';
      }
      body += '</div>';
    });
    h += card('🧮 Points par réponse', 'les réponses les plus fréquentes d\'abord', body);
    return h;
  }

  function saveGrid() {
    if (!S.draft || S.saving) return;
    S.saving = true; render();
    var d = S.draft;
    var out = { thresholds: d.thresholds, questions: {} };
    Object.keys(d.questions).forEach(function (qk) {
      var q = d.questions[qk];
      var o = { label: String(q.label || qk).slice(0, 200), off: !!q.off, answers: {} };
      Object.keys(q.answers || {}).forEach(function (ak) {
        var a = q.answers[ak];
        o.answers[ak] = { label: String(a.label || ak).slice(0, 140), pts: Number(a.pts) || 0, ko: !!a.ko };
      });
      out.questions[qk] = o;
    });
    var u = S.ctx.user || (window.firebase && firebase.auth && firebase.auth().currentUser);
    out.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    out.updatedBy = (u && (u.email || u.uid)) || 'admin';
    S.ctx.db.collection('_config').doc('lqs_grid').set(out).then(function () {
      S.grid = LC.normalizeGrid({ thresholds: out.thresholds, questions: out.questions, updatedBy: out.updatedBy });
      S.draft = null; S.stamp++;
      rebuild();
      toast('Barème enregistré — toutes les notes sont recalculées');
    }).catch(function (e) {
      toast('Enregistrement impossible : ' + (e && e.message ? e.message : 'erreur'), true);
    }).then(function () { S.saving = false; render(); });
  }

  function applyAllSuggestions() {
    var ba = LC.byAnswer(S.M.rows, activeGrid());
    var n = 0;
    ba.questions.forEach(function (q) {
      if (q.off) return;
      q.answerList.forEach(function (x) {
        if (x.suggest == null) return;
        var a = draftAnswer(q.q, q.label, x.a, x.label);
        if (a.pts !== x.suggest) { a.pts = x.suggest; n++; }
      });
    });
    S.stamp++; rebuild(); render();
    toast(n ? n + ' réponse(s) ajustée(s) selon les résultats — vérifie puis enregistre' : 'Aucune suggestion à appliquer');
  }

  /* ══ ÉVÉNEMENTS (délégation sur le conteneur de l'onglet) ══════════════ */
  function closest(el, sel) { return el && el.closest ? el.closest(sel) : null; }
  function bind() {
    if (S.bound || !S.mount) return;
    S.bound = true;
    S.mount.addEventListener('click', function (e) {
      var t = e.target, el;
      if (closest(t, '[data-lq-stop]')) return;
      if ((el = closest(t, '[data-lq-view]'))) { S.view = el.getAttribute('data-lq-view'); render(); return; }
      if ((el = closest(t, '[data-lq-go]'))) { e.preventDefault(); S.view = el.getAttribute('data-lq-go'); render(); return; }
      if ((el = closest(t, '[data-lq-cash]'))) { S.cashMode = el.getAttribute('data-lq-cash'); render(); return; }
      if ((el = closest(t, '[data-lq-axis]'))) { S.axis = el.getAttribute('data-lq-axis'); render(); return; }
      if ((el = closest(t, '[data-lq-ver]'))) { S.quizVer = el.getAttribute('data-lq-ver'); if (S.quizVer) S.quizCompare = false; render(); return; }
      if (closest(t, '[data-lq-compare]')) { S.quizCompare = !S.quizCompare; render(); return; }
      if ((el = closest(t, '[data-lq-det]'))) { var k1 = el.getAttribute('data-lq-det'); S.openDetail[k1] = !S.openDetail[k1]; render(); return; }
      if (closest(t, '[data-lq-forms]')) { e.preventDefault(); S.formsOpen = !S.formsOpen; render(); return; }
      if ((el = closest(t, '[data-lq-q]'))) {
        var k2 = el.getAttribute('data-lq-q');
        if (k2.indexOf('g_') === 0) S.openQ[k2] = S.openQ[k2] === false;   // barème : ouvert par défaut
        else S.openQ[k2] = !S.openQ[k2];
        render(); return;
      }
      if ((el = closest(t, '[data-lq-cr]'))) {
        var mode = el.getAttribute('data-lq-cr');
        if (mode !== S.crMode) { S.crMode = mode; if (dataKey() !== S.loadedKey) load(); else { rebuild(); render(); } }
        return;
      }
      if ((el = closest(t, '[data-lq-pick]'))) { var sl = el.getAttribute('data-lq-pick'); S.closer = S.closer === sl ? '' : sl; render(); return; }
      if ((el = closest(t, '[data-lq-ln]'))) { S.leadsNote = el.getAttribute('data-lq-ln'); S.leadsLimit = 150; render(); return; }
      if ((el = closest(t, '[data-lq-more]'))) { S.leadsLimit += 300; render(); return; }
      if (closest(t, 'a')) return;
      if ((el = closest(t, '[data-lq-lead]'))) { var id = el.getAttribute('data-lq-lead'); S.openLead[id] = !S.openLead[id]; render(); return; }
      if ((el = closest(t, '[data-lq-sugg]'))) {
        var a = draftAnswer(el.getAttribute('data-lq-sugg'), el.getAttribute('data-lq-ql'), el.getAttribute('data-lq-a'), el.getAttribute('data-lq-al'));
        a.pts = Number(el.getAttribute('data-lq-v')) || 0;
        S.stamp++; rebuild(); render(); return;
      }
      if (closest(t, '[data-lq-sugg-all]')) { applyAllSuggestions(); return; }
      if (closest(t, '[data-lq-reset]')) { S.draft = null; S.stamp++; rebuild(); render(); toast('Modifications annulées'); return; }
      if (closest(t, '[data-lq-save]')) { saveGrid(); return; }
    });
    S.mount.addEventListener('change', function (e) {
      var t = e.target;
      if (t.hasAttribute('data-lq-closer')) { S.closer = t.value; render(); return; }
      if (t.hasAttribute('data-lq-pts')) {
        var a = draftAnswer(t.getAttribute('data-lq-pts'), t.getAttribute('data-lq-ql'), t.getAttribute('data-lq-a'), t.getAttribute('data-lq-al'));
        var v = parseFloat(String(t.value).replace(',', '.'));
        a.pts = isFinite(v) ? Math.max(-10, Math.min(10, v)) : 0;
        S.stamp++; rebuild(); render(); return;
      }
      if (t.hasAttribute('data-lq-ko')) {
        var a2 = draftAnswer(t.getAttribute('data-lq-ko'), t.getAttribute('data-lq-ql'), t.getAttribute('data-lq-a'), t.getAttribute('data-lq-al'));
        a2.ko = !!t.checked;
        S.stamp++; rebuild(); render(); return;
      }
      if (t.hasAttribute('data-lq-qoff')) {
        var d = ensureDraft(), qk = t.getAttribute('data-lq-qoff');
        var q = d.questions[qk] || (d.questions[qk] = { label: t.getAttribute('data-lq-ql'), off: false, answers: {} });
        q.off = !t.checked;
        S.stamp++; rebuild(); render(); return;
      }
      if (t.hasAttribute('data-lq-th')) {
        var d2 = ensureDraft(), v2 = parseFloat(String(t.value).replace(',', '.'));
        if (isFinite(v2)) d2.thresholds[t.getAttribute('data-lq-th')] = v2;
        S.stamp++; rebuild(); render(); return;
      }
    });
    var searchTimer = null;
    S.mount.addEventListener('input', function (e) {
      var t = e.target;
      if (!t.hasAttribute('data-lq-search')) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        S.leadsQ = t.value; S.leadsLimit = 150; render();
        var inp = S.mount.querySelector('[data-lq-search]');
        if (inp) { inp.focus(); try { inp.setSelectionRange(inp.value.length, inp.value.length); } catch (er) {} }
      }, 250);
    });
  }

  /* ══ API ═══════════════════════════════════════════════════════════════ */
  window.LqsTab = {
    show: function (mount, ctx) {
      S.mount = mount; S.ctx = ctx;
      bind();
      if (S.loadedKey !== dataKey() || !S.D) load(); else render();
    },
    invalidate: function () { S.loadedKey = null; },
    refilter: function (ctx) {
      S.ctx = ctx;
      if (S.D && !S.loading) { rebuild(); render(); }
    }
  };
})();
