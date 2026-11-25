/* ============================================================================
   lqs-tab.js — onglet « ⭐ Qualité leads » du Funnel Sales (06/11/2026)
   ----------------------------------------------------------------------------
   Rendu de LqsCore (lqs-core.js) dans sales-funnel.html — ADMIN uniquement
   (la page est déjà gardée admin ; aucune note LQS n'est montrée ailleurs,
   demande explicite de Vincent : les closers ne la voient pas).

   Six vues, une barre de filtres commune (closer, base du tableau par note) :
     🧭 Vue d'ensemble   closes de la période, tunnel des leads entrés, LQS 1→5
     📋 Quiz & réponses  abandon question par question + chaque réponse → résultats
     📣 Marketing (MQS)  campagne / adset / créa / canal : qualité + rentabilité
     🎯 Closers          RDV mois par mois : % de 4-5, qualité du pipe, closing
     👥 Leads notés      chaque lead, sa note, le détail de ses points
     ⚙️ Barème           points par réponse, seuils, suggestions ; enregistré
                         dans _config/lqs_grid (seule écriture de l'onglet)

   API (appelée par sales-funnel.html) :
     LqsTab.show(mount, ctx)    ctx = { db, P, periodLabel, typeMap,
                                        tunnelFilter, sourceFilter, toast,
                                        user, teamMembers, tunnelsMeta,
                                        funnelCloses (K.closeRows, facultatif),
                                        funnelKpis (K, facultatif : couverture
                                          et total de la dépense pub) }
     LqsTab.invalidate()        période changée → rechargement au prochain show
     LqsTab.refilter(ctx)       filtres tunnel / source → recalcul sans recharger
   ES5 strict, délégation d'événements (data-*), aucun onclick inline.

   Audit de cohérence (25/11/2026, référentiel des chiffres commerciaux) :
     · vocabulaire unique : Contracté / Collecté (jamais Signé / Encaissé),
       Closes, Présents, Pitchés, « Prélevé sur la période » pour l'argent
       rentré pendant la période (autre calcul) ;
     · cartes du haut = closes DE LA PÉRIODE (liste unique FunnelCore.
       buildCloses, la même que le Stats funnel) ; ce qui suit les leads
       entrés porte toujours « des leads entrés » ou « Leads … » (unité :
       un lead compte une fois) ;
     · chaque chiffre porte son « i » (StatsCore.info, glossaire commun ;
       StatsCore.infoLibre pour une note propre à l'onglet) ;
     · lectures en échec et plafonds dits à l'écran (M.erreursLecture).
   ============================================================================ */
(function () {
  'use strict';
  var LC = window.LqsCore, FC = window.FunnelCore;
  if (!LC || !FC) { if (window.console) console.error('[lqs] lqs-core.js / funnel-core.js manquants'); return; }
  var SC = window.StatsCore || null;

  /* ══ LE « i » ═════════════════════════════════════════════════════════
     I(cle, precision) : terme du glossaire commun (stats-core.js).
     IL(cle, precision) : terme propre à l'onglet, pas (encore) dans le
     glossaire — texte local ci-dessous ; s'il entre un jour dans le
     glossaire commun sous la même clé, c'est sa définition qui s'affiche.
     Côté serveur ou sans stats-core.js : chaîne vide. */
  var LOCAL = {
    leads_et_reoptins: ['Leads + ré-optins', 'Nouveaux leads entrés pendant la période, plus les anciens leads qui ont rempli un nouveau formulaire pendant la période. Le Stats funnel affiche ces deux nombres séparément (Leads, puis « + N ré-optins »).'],
    leads_avec_rdv: ['Leads avec RDV', 'Leads entrés pendant la période qui ont au moins un RDV de vente (Self Booking, Setting ou manuel), à n’importe quelle date jusqu’à aujourd’hui. Un lead compte une fois. Ce n’est pas « RDV pris » du Stats funnel, qui compte les RDV créés pendant la période, anciens leads compris.'],
    leads_presents: ['Leads présents', 'Leads entrés pendant la période venus à au moins un de leurs RDV (lu sur le dernier RDV de chaque chaîne de report). Un lead compte une fois : ce chiffre ne se compare pas aux Présents du Stats funnel ou de Close SB, qui sont des RDV comptés à leur date.'],
    taux_close_leads_presents: ['Close / leads présents', 'Closes des leads entrés venus au RDV ÷ leads présents. Calculé par lead : un lead compte une fois, même avec plusieurs RDV. Un close sans RDV enregistré n’y entre pas. Le taux de close par RDV est dans la vue Closers.'],
    taux_close_leads_avec_rdv: ['Close / leads avec RDV', 'Closes des leads entrés qui avaient un RDV ÷ leads avec RDV. Calculé par lead : un lead compte une fois, même avec plusieurs RDV.'],
    taux_close_lead: ['Close / lead', 'Closes des leads entrés ÷ leads (+ ré-optins) de la ligne.'],
    close_sans_rdv_enregistre: ['Sans RDV enregistré', 'Client gagné directement depuis sa fiche ou repéré par le module Paiements, sans RDV de vente à son nom. Il compte dans les closes, ni dans les leads avec RDV ni dans les leads présents.'],
    deja_client: ['Déjà client', 'Lead réinscrit pendant la période qui était déjà client avant son entrée. Ce n’est pas un close des leads entrés.'],
    contracte_cohorte: ['Contracté des leads entrés', 'Valeur hors taxes des contrats des closes des leads entrés (leads entrés pendant la période et devenus clients depuis, à n’importe quelle date). Différent du Contracté des cartes du haut, qui suit les clients gagnés pendant la période.'],
    collecte_cohorte: ['Collecté des leads entrés', 'Ce qui a déjà été prélevé, jusqu’à aujourd’hui, sur les closes des leads entrés (hors taxes).'],
    contracte_par_lead: ['Contracté / lead', 'Contracté des leads entrés ÷ nombre de leads de la ligne : la valeur moyenne d’un lead.'],
    part_contracte: ['Part du contracté', 'Part de la ligne dans le contracté total du tableau.'],
    lqs: ['LQS', 'Lead Quality Score : note de 1 à 5 calculée uniquement à partir des réponses du lead (quiz, formulaires) avec le barème de l’onglet ⚙️. Ce n’est ni la note équipe ★, ni le CA déclaré.'],
    lqs_45: ['LQS 4-5', 'Leads notés LQS 4 ou 5 ÷ leads notés. Les leads sans réponse exploitable n’ont pas de note et ne comptent pas dans ce pourcentage.'],
    note_equipe: ['Note équipe ★', 'Moyenne du curseur ★ posé par le setter ou le closer dans Leads Live après le contact. Ce n’est pas la note LQS.'],
    qualite_pipe: ['Qualité du pipe', 'LQS moyen des leads des RDV de la ligne (RDV dont le lead est noté).'],
    mqs: ['MQS', 'Marketing Quality Score : 60 % qualité (LQS moyen des leads de la source) + 40 % résultats (contracté des leads entrés par lead, comparé à la moyenne ; sans aucun contrat sur la période, taux de leads présents). « n.s. » sous ' + (LC.MQS_MIN || 5) + ' leads notés.'],
    depense_pub_ligne: ['Dépense par pub', 'Dépense Meta reçue pub par pub (hors taxes), rattachée à la ligne qui porte la pub. Elle peut être inférieure à la dépense du compte (onglet Funnel) : jours pas encore reçus, pubs sans aucun lead, montants corrigés à la main.'],
    cpl_source: ['CPL de la source', 'Dépense de la ligne ÷ leads (+ ré-optins) de la ligne. Total : dépense ÷ leads des seules lignes venues de la pub.'],
    cout_lead_45: ['Coût / lead LQS 4-5', 'Dépense ÷ leads notés LQS 4 ou 5 de la ligne.'],
    filtre_closer: ['Filtre closer', 'Avec un closer choisi, seuls les leads rattachés à lui (closer de leur close, sinon de leur RDV) sont comptés : le nombre de leads n’est plus celui de la période, les taux par lead entré et les coûts pub ne sont pas calculés. Enlève le filtre pour voir tous les leads.'],
    mode_periode: ['Closes de la période, par note', 'Dans ce mode, Closes, Contracté et Collecté sont ceux des clients gagnés pendant la période (même liste que le Stats funnel), rangés selon la note du lead, quel que soit son mois d’entrée. Les taux par lead ne sont pas calculés : ces closes ne viennent pas tous des leads entrés pendant la période.'],
    non_calcule_periode: ['Non calculé dans ce mode', 'Les closes de la période ne viennent pas tous des leads entrés pendant la période : un taux par lead mélangerait deux populations.'],
    plage_closers: ['Plage de la vue Closers', 'La plage choisie ici ne change que les tableaux des closers : les cartes de la vue d’ensemble restent sur la période choisie en haut de page.'],
    depense_incomplete: ['Dépense incomplète', 'Jours de dépense reçus = jours de la période, jusqu’à hier, pour lesquels Meta a transmis la dépense pub par pub. S’il en manque, les coûts par lead et le contracté ÷ dépense sont masqués : ils seraient faussement bons.'],
    arrives: ['Arrivés', 'Pages du quiz affichées, une fois par session (visites internes et tests exclus).'],
    formulaire_envoye: ['Formulaire envoyé', 'Envois du formulaire de coordonnées comptés sur la page. Peut dépasser le nombre de fiches (double envoi) ; taux = ÷ ont fini les questions (sinon ÷ ont répondu Q1).'],
    nouveaux_leads: ['Nouveaux leads', 'Nouvelles fiches Leads Live dont la page d’entrée est ce quiz. Taux = ÷ formulaires envoyés.'],
    vus_q1: ['Ont vu la 1re question', 'Visiteurs mesurés par le quiz lui-même sur la période comparable (une fois par session). Diffère légèrement des « Arrivés » des chiffres de référence, comptés par la page.']
  };
  function hasG(cle) { return !!(SC && SC.GLOSSAIRE && SC.GLOSSAIRE[cle]); }
  function I(cle, precision) { return SC && SC.info ? SC.info(cle, precision) : ''; }
  function IL(cle, precision) {
    if (hasG(cle)) return I(cle, precision);
    var t = LOCAL[cle];
    if (!t || !SC || !SC.infoLibre) return '';
    return SC.infoLibre(t[0], t[1] + (precision ? ' ' + precision : ''));
  }
  /* Une note libre (pas un terme). */
  function IN(titre, texte) { return SC && SC.infoLibre ? SC.infoLibre(titre, texte) : ''; }
  /* Libellé + « i » d'un terme local. */
  function ML(cle, precision) { var t = LOCAL[cle]; return esc(hasG(cle) ? SC.mot(cle) : (t ? t[0] : cle)) + IL(cle, precision); }
  /* Libellé + « i » d'un terme du glossaire commun. */
  function MG(cle, precision) { return esc(SC && SC.mot ? SC.mot(cle) : cle) + I(cle, precision); }

  var S = {
    mount: null, ctx: null, D: null, M: null,
    grid: null, draft: null, stamp: 1,
    loadedKey: null, loading: false, err: null, bound: false,
    view: 'overview', closer: '', cashMode: 'cohorte', axis: 'campaign',
    crMode: 'period', leadsNote: 'all', leadsQ: '', leadsLimit: 150,
    openQ: {}, openLead: {}, openDetail: {}, quizVer: '', quizCompare: false, quizLatest: true, formsOpen: false, saving: false,
    exporting: false, exportBusy: ''
  };

  /* ══ FORMATS ══════════════════════════════════════════════════════════ */
  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function ok(v) { return v != null && !isNaN(v) && isFinite(v); }
  function fNum(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') : '—'; }
  function fEur(v) { return ok(v) ? Math.round(v).toLocaleString('fr-FR') + ' €' : '—'; }
  /* Taux : UNE écriture (StatsCore.fmtPct, une décimale, « — » si vide) —
     audit 25/11/2026 (TRA-18, LQS-18) : le même taux s'écrivait 62,5 %,
     63 % ou 62.5 %. Le second argument historique est ignoré. */
  function fPct(v) {
    if (!ok(v)) return '—';
    if (SC && SC.fmtPct) return SC.fmtPct(v, 1);
    return (Math.round(v * 10) / 10).toFixed(1).replace('.', ',') + ' %';
  }
  function fDec(v, d) { if (!ok(v)) return '—'; return v.toLocaleString('fr-FR', { minimumFractionDigits: d == null ? 2 : d, maximumFractionDigits: d == null ? 2 : d }); }
  function fPts(v) { if (!ok(v)) return '—'; return (v > 0 ? '+' : '') + v.toLocaleString('fr-FR', { maximumFractionDigits: 1 }); }
  /* Ratio « × » : deux décimales, comme le Stats funnel. */
  function fRoas(v) { return ok(v) ? v.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '×' : '—'; }
  var MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  function fMonth(mk) { var p = String(mk || '').split('-'); return p.length === 2 ? MONTHS[+p[1] - 1] + ' ' + p[0] : mk; }
  /* Jour à l'heure de Paris (JJ/MM/AA), quel que soit l'appareil. */
  function fDay(ms) {
    if (ms == null) return '—';
    var iso = SC && SC.jourParis ? SC.jourParis(ms) : FC.isoDate(new Date(ms));
    var p = String(iso).split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0].slice(2) : '—';
  }
  function fIso(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : '—'; }
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
  function offerSplit(a, per) {
    var n = per ? a && a.signers : a && a.closes;
    if (!n) return '';
    var e = per ? a.signersE : a.closesE, b = per ? a.signersB : a.closesB, u = per ? a.signersU : a.closesU;
    var p = [];
    if (e) p.push('<span class="lq-oe">' + fNum(e) + ' Élite</span>');
    if (b) p.push('<span class="lq-ob">' + fNum(b) + ' Business</span>');
    if (u) p.push('<span class="lq-muted" title="Close sans offre renseignée">' + fNum(u) + ' sans offre</span>');
    return p.join(' · ');
  }
  function plur(n, one, many) { return (n > 1 ? many : one); }
  function bar(pct, cls) { return '<div class="lq-bar"><span class="' + (cls || '') + '" style="width:' + (ok(pct) ? Math.max(0, Math.min(100, pct)).toFixed(1) : 0) + '%"></span></div>'; }
  function sub(v) { return '<div class="lq-sub">' + v + '</div>'; }
  /* Contracté (gros) + collecté (dessous) — vocabulaire unique (§6). */
  function money(con, paid) { return '<strong>' + fEur(con) + '</strong>' + sub(fEur(paid) + ' collecté'); }
  function kpi(v, l, s) { return '<div class="fn-kpi"><div class="v">' + v + '</div><div class="l">' + l + '</div>' + (s ? '<div class="s">' + s + '</div>' : '') + '</div>'; }
  /* Taux non calculé dans le mode « closes de la période ». */
  function nonCalc() { return '<span class="lq-muted">—</span>' + IL('non_calcule_periode'); }
  function card(title, note, body, extraHead) {
    return '<div class="fn-stage"><div class="fn-stage-head"><div class="fn-stage-title">' + title + '</div>'
      + (extraHead || (note ? '<div class="fn-stage-note">' + note + '</div>' : '')) + '</div>' + body + '</div>';
  }
  function help(title, html) { return '<details class="fn-help"><summary>' + title + '</summary><div class="hb">' + html + '</div></details>'; }

  /* ══ ÉTAT / DONNÉES ════════════════════════════════════════════════════ */
  function activeGrid() { return S.draft || S.grid || LC.normalizeGrid(null); }
  /* Plage de la vue Closers : mois calendaires à l'heure de PARIS (même
     instant pour tous les appareils). */
  function closerRange() {
    var P = S.ctx.P;
    if (S.crMode === 'period') return { start: P.start, end: P.end };
    var n = S.crMode === '6m' ? 5 : 2;
    if (SC && SC.parisParts && SC.dateParis) {
      var pp = SC.parisParts(new Date());
      var y = +pp.year, m0 = +pp.month - 1;
      return { start: SC.dateParis(y, m0 - n, 1, 0, 0, 0, 0), end: SC.dateParis(y, m0 + 1, 0, 23, 59, 59, 999) };
    }
    var now = new Date();
    return { start: new Date(now.getFullYear(), now.getMonth() - n, 1, 0, 0, 0, 0), end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };
  }
  /* Équipe complète, membres partis compris (window.TEAM_MEMBERS les garde,
     marqués departed) : leur activité passée reste comptée, sur la ligne
     « Anciens membres », sans nom (référentiel §3, D10). */
  function teamRoster() {
    var list = S.ctx.teamMembers || window.TEAM_MEMBERS_LIST || [];
    var map = window.TEAM_MEMBERS || {};
    var extra = Object.keys(map).map(function (k) { return map[k]; });
    var all = FC.mergeTeam ? FC.mergeTeam(list, extra) : list;
    /* Un membre parti n'a plus de nom à l'écran (D10) : son nom devient
       « Anciens membres » partout où le modèle l'écrit (closer d'un lead,
       d'un appel, d'un close). Copie : le roster de la page n'est pas touché. */
    return all.map(function (m) {
      var parti = m && (m.departed === true || (FC.isDeparted && FC.isDeparted(m)));
      if (!parti) return m;
      var c = {};
      Object.keys(m).forEach(function (f) { c[f] = m[f]; });
      c.departed = true; c.shortName = 'Anciens membres'; c.displayName = 'Anciens membres';
      return c;
    });
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
      teamMembers: teamRoster(), typeMap: S.ctx.typeMap || {},
      closerRange: closerRange(), tunnelsMeta: S.ctx.tunnelsMeta || null,
      /* Closes de la période : les lignes du Stats funnel (K.closeRows)
         quand la page les fournit — même liste, mêmes filtres ; sinon la
         même règle (FunnelCore.buildCloses) sur les données chargées ici. */
      funnelCloses: Array.isArray(S.ctx.funnelCloses) ? S.ctx.funnelCloses : null
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
  /* Closes de la période (liste unique). Filtre closer : le closer DU CLOSE
     (row.closer, règle du référentiel §4) — comme Global closing. */
  /* Clé de rangement d'un close (D10, StatsCore.rangPersonne posé par
     LqsCore.buildModel) : un close d'avant l'arrivée du closer n'est pas
     dans son onglet, comme Global closing. */
  function rangKeyDe(p) { return p && p.rangKey != null ? p.rangKey : (p ? p.closer : null); }
  function periodSigned() {
    var list = S.M ? (S.M.periodSigned || []) : [];
    if (!S.closer) return list;
    return list.filter(function (p) { return rangKeyDe(p) === S.closer; });
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
    h += '<select class="fn-sel" data-lq-closer title="Avec un closer choisi, seuls les leads rattachés à lui (closer de leur close, sinon de leur RDV) sont comptés. Les taux par lead entré et les coûts pub ne sont pas calculés."><option value="">👥 Toute l\'équipe</option>';
    (S.M ? S.M.closers : []).forEach(function (c) { h += '<option value="' + esc(c.slug) + '"' + (S.closer === c.slug ? ' selected' : '') + '>🎯 ' + esc(c.name) + '</option>'; });
    h += '</select>';
    h += '<div class="fn-seg" title="Base du tableau par note"><button data-lq-cash="cohorte" class="' + (S.cashMode === 'cohorte' ? 'active' : '') + '" title="Tableau par note : ce que sont devenus, jusqu\'à aujourd\'hui, les leads entrés pendant la période (closes, contracté et collecté des leads entrés) — juge la qualité des leads">💶 Résultats des leads entrés</button>'
      + '<button data-lq-cash="periode" class="' + (S.cashMode === 'periode' ? 'active' : '') + '" title="Tableau par note : clients gagnés pendant la période (même liste que le Stats funnel), rangés selon la note du lead, quel que soit son mois d\'entrée">🏦 Closes de la période</button></div>';
    h += '<button class="fn-btn primary" data-lq-export' + (S.M && !S.exportBusy ? '' : ' disabled') + ' title="Tous les onglets + le dossier nominatif de chaque lead de la période (questionnaire, issue, transcription de la visio de closing)">' + (S.exportBusy ? esc(S.exportBusy) : '📄 Export PDF complet') + '</button>';
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
      if (S.M.leadsTruncated) h += '<div class="fn-alert">⚠ Trop de leads sur la période : la liste est tronquée. Réduis la période pour des chiffres exacts.' + I('lecture_incomplete') + '</div>';
      /* Lectures en échec / plafonds atteints (lqs-core M.erreursLecture) :
         jamais un zéro muet (référentiel P7). */
      var errL = S.M.erreursLecture || [];
      if (errL.length) h += '<div class="fn-alert">⚠ <strong>Lecture incomplète</strong>' + I('lecture_incomplete') + '<ul style="margin:6px 0 0 18px;padding:0"><li>' + errL.map(esc).join('</li><li>') + '</li></ul></div>';
      if (S.closer && S.view !== 'grid') h += '<div class="fn-alert">🎯 <strong>Filtre closer : ' + esc(S.M.memberName(S.closer)) + '.</strong> Seuls les leads rattachés à ce closer (closer de leur close, sinon de leur RDV) sont comptés. Les taux par lead entré et les coûts pub ne sont pas calculés.' + IL('filtre_closer') + '</div>';
      if (S.view === 'overview') h += viewOverview();
      else if (S.view === 'quiz') h += viewQuiz();
      else if (S.view === 'mkt') h += viewMarketing();
      else if (S.view === 'closers') h += viewClosers();
      else if (S.view === 'leads') h += viewLeads();
      else if (S.view === 'grid') h += viewGrid();
    }
    S.mount.innerHTML = h;
  }

  /* ══ VUE 1 — VUE D'ENSEMBLE ════════════════════════════════════════════
     Deux lectures, jamais sous le même mot (audit 25/11/2026) :
       · cartes du haut = CLOSES DE LA PÉRIODE (liste unique, mêmes chiffres
         que Closes / Contracté / Collecté du Stats funnel) ;
       · tunnel et tableau par note = LEADS ENTRÉS (« Leads avec RDV »,
         « Leads présents », « Closes des leads entrés ») — un lead compte
         une fois ; en mode « Closes de la période », le tableau range les
         closes de la période selon la note du lead. */
  function cashOf(a) { return S.cashMode === 'periode' ? a.periodCon : a.con; }    // CONTRACTÉ
  function paidOf(a) { return S.cashMode === 'periode' ? a.periodPaid : a.cash; }   // COLLECTÉ (à ce jour)
  function closesOf(a) { return S.cashMode === 'periode' ? a.signers : a.closes; }

  /* Nom affiché d'un membre : un membre parti n'a plus de nom (D10). */
  function nomDe(slug) {
    if (!slug) return null;
    if (S.M && S.M.isDeparted && S.M.isDeparted(slug)) return 'Anciens membres';
    return S.M ? S.M.memberName(slug) : slug;
  }

  /* Chiffre cliquable → dossiers nominatifs (lqs-dossier.js). kind :
     leads | booked | present | closed | signed ; note : 0-5 ou 'all'. */
  function drill(n, note, kind) {
    if (!n || !window.LqsDossier) return fNum(n);
    return '<a href="#" class="lq-drill" data-lq-drill="' + kind + '" data-lq-dn="' + note + '" title="Voir les ' + fNum(n) + ' prospects, leurs réponses et leurs visios">' + fNum(n) + '</a>';
  }
  var DRILL_LBL = { leads: 'Leads + ré-optins', booked: 'Leads avec RDV', present: 'Leads présents au RDV', closed: 'Closes des leads entrés',
    signed: 'Closes de la période — contracté, collecté, reste à encaisser' };
  /* Carte cliquable (23/11/2026, demande Vincent : « cliquer sur le
     collecté pour voir le détail ») : ouvre les closes de la période. */
  function drillV(html, n, note) {
    if (!n || !window.LqsDossier) return html;
    return '<a href="#" class="lq-drill" data-lq-drill="signed" data-lq-dn="' + (note == null ? 'all' : note) + '" title="Voir le détail client par client">' + html + '</a>';
  }
  /* Ligne de dossier d'un close de la période : la fiche du lead quand elle
     existe, avec l'issue de CE close (montants, jour du close, closer et
     setter de la liste unique) ; un close sans fiche lead (RDV closé sans
     fiche, paiement seul) a un dossier réduit, sans questionnaire. */
  function closeRowOf(ps) {
    var base = ps.leadRow || null, r = {};
    if (base) Object.keys(base).forEach(function (k) { r[k] = base[k]; });
    else {
      r = { id: 'close_' + ps.key, lead: { nom: ps.name }, noLead: true, note: null, pts: null, ko: false, detail: [], answers: [], calls: [],
        entry: null, avecRdv: !!ps.bookingId, booked: !!ps.bookingId, leadPresent: false, present: false, axes: {}, team: null,
        sourceLabel: ps.src === 'paiement' ? 'repéré par le module Paiements (aucune fiche lead reliée)' : (ps.src === 'rdv' ? 'RDV closé sans fiche lead' : '') };
    }
    r.closed = true; r.closeCancelled = false; r.dejaClient = false;
    r.con = ps.con || 0; r.cash = ps.paid != null ? ps.paid : (ps.cash || 0); r.pending = ps.pending || 0;
    r.closeDay = ps.day || null; r.sansPaiement = !!ps.sansPaiement;
    r.offer = ps.offer || r.offer || null;
    if (ps.closer) r.closer = ps.closer;
    if (ps.setter) r.setter = ps.setter;
    r.closerName = nomDe(r.closer); r.setterName = nomDe(r.setter);
    if (ps.rdvDate) r.rdvDate = ps.rdvDate;
    r.closeSansRdv = !r.avecRdv;
    r.closeDeLaPeriode = true;
    return r;
  }
  function noteMatch(note, n) { return note === 'all' || String(n == null ? 0 : n) === String(note); }
  function drillRows(note, kind) {
    if (kind === 'signed') return periodSigned().filter(function (ps) { return noteMatch(note, ps.note); }).map(closeRowOf);
    return rows().filter(function (r) {
      if (!noteMatch(note, r.note)) return false;
      if (kind === 'booked') return r.avecRdv;
      if (kind === 'present') return r.leadPresent;
      if (kind === 'closed') return r.closed;
      return true;
    });
  }
  function openDrill(note, kind) {
    var noteTxt = note === 'all' ? (kind === 'signed' ? '' : ' — toutes les notes') : (String(note) === '0' ? ' — non notés' : ' — note LQS ' + note);
    window.LqsDossier.open({
      title: DRILL_LBL[kind] + noteTxt,
      sub: S.closer ? (kind === 'signed' ? 'closes de ' : 'leads de ') + S.M.memberName(S.closer) : 'toute l\'équipe',
      periodLabel: S.ctx.periodLabel || '', rows: drillRows(note, kind)
    });
  }

  /* Contrôle « mêmes closes que le Stats funnel » (21/11/2026, refait le
     25/11/2026). Les closes de la période de cet onglet SONT la liste unique
     du Stats funnel (K.closeRows quand la page la fournit, sinon la même
     règle FunnelCore.buildCloses) : la comparaison, client par client (clé
     de la liste : fiche, sinon e-mail, sinon téléphone), doit toujours être
     ✅. Un écart restant est nommé. Toute l'équipe, jamais le filtre closer. */
  function funnelCheckHtml() {
    if (!S.M) return '';
    var PC = S.M.periodCloses || {};
    var here = S.M.periodSigned || [];
    var fc = S.ctx && Array.isArray(S.ctx.funnelCloses) ? S.ctx.funnelCloses : null;
    var hCon = 0, hPaid = 0, hByKey = {};
    here.forEach(function (ps) { hCon += ps.con || 0; hPaid += ps.paid || 0; hByKey[ps.key] = ps; });
    var lines = [], same = true, fN = null, fCon = 0, fPaid = 0;
    if (fc) {
      var fun = fc.filter(function (r) { return r && !(r.rv && r.rv.cancelled); });
      var fByKey = {};
      fN = fun.length;
      fun.forEach(function (r) { fCon += (r.rv && r.rv.con) || 0; fPaid += (r.rv && r.rv.paid) || 0; fByKey[r.key] = r; });
      fun.forEach(function (r) {
        if (hByKey[r.key]) return;
        lines.push('<strong>' + esc(r.name || '—') + '</strong> (' + fEur((r.rv && r.rv.con) || 0) + ' contractés) : compté par le Stats funnel, absent d\'ici — les deux onglets n\'ont pas été lus au même moment ou avec les mêmes filtres : recharge la page.');
      });
      here.forEach(function (ps) {
        if (fByKey[ps.key]) return;
        lines.push('<strong>' + esc(ps.name || '—') + '</strong> (' + fEur(ps.con || 0) + ' contractés) : compté ici, absent du Stats funnel — les deux onglets n\'ont pas été lus au même moment ou avec les mêmes filtres : recharge la page.');
      });
      if (!lines.length && (Math.abs(fCon - hCon) > 0.5 || Math.abs(fPaid - hPaid) > 0.5)) {
        lines.push('Mêmes clients, montants différents (contracté ' + fEur(hCon) + ' ici, ' + fEur(fCon) + ' au Stats funnel ; collecté ' + fEur(hPaid) + ' ici, ' + fEur(fPaid) + ' au Stats funnel) : le module Paiements a changé entre les deux lectures, recharge la page.');
      }
      same = !lines.length;
    }
    var named = [];
    (PC.annules || []).forEach(function (a) { named.push(esc(a.name || '—') + ' — close annulé (' + esc(a.reason || 'annulé') + '), retiré des closes, du contracté et du collecté'); });
    (PC.ecartsCanal || []).forEach(function (r) { named.push(esc(r.name || '—') + ' — écart de canal : compté ' + (r.sb ? 'Self Booking' : 'Setting (NB)') + ' (canal du RDV), la réponse du closer dit l\'inverse'); });
    (PC.sansSignal || []).forEach(function (x) { named.push(esc(x.name || '—') + ' — fiche marquée cliente sans vente enregistrée : non comptée'); });
    var body = '<div class="fn-stage-note" style="font-size:12.5px;line-height:1.7">'
      + 'Closes de la période ici : <strong>' + fNum(here.length) + '</strong> · ' + fEur(hCon) + ' contractés · ' + fEur(hPaid) + ' collectés.'
      + (fc ? ' Stats funnel : <strong>' + fNum(fN) + '</strong> · ' + fEur(fCon) + ' contractés · ' + fEur(fPaid) + ' collectés.' : '')
      + (fc ? (same ? ' ✅ Même liste de clients, mêmes montants.' : '<ul style="margin:6px 0 0 18px;padding:0"><li>' + lines.join('</li><li>') + '</li></ul>') : '')
      + '<br>' + (PC.source === 'funnel' ? 'Les closes de cet onglet sont les lignes du Stats funnel elles-mêmes.'
        : (fc ? 'Liste recalculée ici par la même règle (FunnelCore.buildCloses) et comparée client par client.'
          : 'Liste calculée ici par la même règle que le Stats funnel (FunnelCore.buildCloses). Ouvre l\'onglet Funnel pour la comparer client par client.'))
      + (S.closer ? ' Contrôle fait sur toute l\'équipe : le filtre closer ne s\'y applique pas.' : '')
      + (named.length ? '<div style="margin-top:6px"><strong>À savoir</strong>' + I('closes_annules') + I('ecart_canal') + I('clientes_sans_vente') + '<ul style="margin:4px 0 0 18px;padding:0"><li>' + named.join('</li><li>') + '</li></ul></div>' : '')
      + '</div>';
    return card((fc && !same ? '🔎' : '✅') + ' Contrôle : mêmes closes que le Stats funnel', 'liste unique des closes, montants HT du module Paiements', body);
  }

  /* Closes de la période (liste unique) : nombre, contracté, collecté à ce
     jour, 1ers prélèvements en attente, closes sans paiement / sans fiche. */
  function monthHead() {
    var o = { n: 0, con: 0, paid: 0, pending: 0, sansPaiement: 0, sansFiche: 0, E: 0, B: 0, U: 0 };
    periodSigned().forEach(function (ps) {
      o.n++; o.con += ps.con || 0; o.paid += ps.paid != null ? ps.paid : (ps.cash || 0); o.pending += ps.pending || 0;
      if (ps.sansPaiement) o.sansPaiement++;
      if (!ps.leadRow) o.sansFiche++;
      if (ps.offer === 'elite') o.E++; else if (ps.offer === 'business') o.B++; else o.U++;
    });
    o.reste = Math.max(0, o.con - o.paid);
    return o;
  }
  function annulesPeriode() {
    var list = (S.M && S.M.periodCloses && S.M.periodCloses.annules) || [];
    return S.closer ? list.filter(function (a) { return rangKeyDe(a) === S.closer; }) : list;
  }

  function viewOverview() {
    var R = rows();
    var per = S.cashMode === 'periode';
    var bn = LC.byNote(R, periodPays(), periodSigned());
    var t = bn.total, m = bn.byNote;
    var totCash = cashOf(t);
    var clName = S.closer ? S.M.memberName(S.closer) : '';
    var h = '';
    h += help('ℹ️ Comment lire cet onglet', '<p><strong>LQS (Lead Quality Score)</strong> : chaque lead reçoit une note de <strong>1 à 5</strong> calculée <strong>uniquement à partir de ses réponses</strong> (quiz, formulaires) avec le barème de l\'onglet ⚙️ — CA, équipe, contraintes… Aucun jugement humain : c\'est la qualité que le marketing nous envoie.</p>'
      + '<p><strong>MQS (Marketing Quality Score)</strong> : la note d\'une campagne, d\'un adset, d\'une créa ou d\'un canal = qualité des leads qu\'elle amène (60 %, LQS moyen) + ce qu\'ils rapportent (40 % : contracté des leads entrés par lead, comparé à la moyenne ; sans aucun contrat sur la période, taux de leads présents).</p>'
      + '<p><strong>Les cartes Closes, Contracté et Collecté</strong> comptent les clients gagnés <strong>pendant la période</strong> : la même liste que le Stats funnel, quel que soit le mois d\'entrée du lead. <strong>Le tunnel et le tableau par note</strong> suivent les <strong>leads entrés</strong> pendant la période jusqu\'à aujourd\'hui : « Leads avec RDV », « Leads présents », « Closes des leads entrés » comptent des leads (un lead compte une fois), pas des RDV.</p>'
      + '<p>Montants HT : <strong>contracté</strong> (valeur du contrat : module Paiements, sinon tarif déclaré au close) et <strong>collecté</strong> (prélèvements réellement passés, à ce jour). Le contracté juge la valeur des leads (parts, « / lead », MQS, contracté ÷ dépense) ; le collecté suit avec le préavis SEPA et les mensualités. Si les 4-5 ne closent pas, c\'est un sujet closing ; si les closers closent bien mais qu\'il n\'y a que des 1-2, c\'est un sujet marketing.</p>'
      + '<p><strong>Réservé aux admins</strong> : la note n\'est affichée nulle part ailleurs, les closers ne la voient pas.</p>');

    /* KPIs — leads entrés */
    h += '<div class="fn-grid lq-kpis">';
    if (S.closer) h += kpi(drill(t.leads, 'all', 'leads'), 'Leads de ' + esc(clName) + IL('filtre_closer'), fNum(t.nouveaux) + ' nouveaux + ' + fNum(t.reopt) + ' ré-optins · ' + fNum(t.noted) + ' notés');
    else h += kpi(drill(t.leads, 'all', 'leads'), ML('leads_et_reoptins'), fNum(t.nouveaux) + ' nouveaux leads (= Leads du Stats funnel)' + I('leads') + ' + ' + fNum(t.reopt) + ' ré-optins' + I('reoptins') + '<br>' + fNum(t.noted) + ' notés (' + fPct(t.leads ? t.noted / t.leads * 100 : null) + ')');
    h += kpi(avgBadge(t.avgNote), 'LQS moyen' + IL('lqs'), 'qualité moyenne envoyée par le marketing');
    h += kpi(fPct(t.pct45), ML('lqs_45'), fNum(t.n45) + ' leads · ' + fPct(t.pct45) + ' des leads notés · ' + fPct(t.leads ? t.n45 / t.leads * 100 : null) + ' de tous les leads<br>LQS 1-2 : ' + fPct(t.pct12) + ' des leads notés');
    if (!S.closer) h += kpi(drill(t.leadsAvecRdv, 'all', 'booked'), ML('leads_avec_rdv'), fPct(t.pctLeadsAvecRdv) + ' des leads');
    h += kpi(drill(t.leadsPresents, 'all', 'present'), ML('leads_presents'), fPct(t.pctLeadsPresents) + ' des leads avec RDV');
    h += '</div>';

    /* KPIs — closes de la période (liste unique : Closes / Contracté /
       Collecté du Stats funnel). Les chiffres des leads entrés passent en
       sous-ligne, sous leur propre nom. */
    var mh = monthHead();
    var an = annulesPeriode();
    var prec = S.closer ? 'Ici : closes dont ' + clName + ' est le closer (comme Global closing).' : 'Même liste que le Stats funnel.';
    var off = [];
    if (mh.E) off.push('<span class="lq-oe">' + fNum(mh.E) + ' Élite</span>');
    if (mh.B) off.push('<span class="lq-ob">' + fNum(mh.B) + ' Business</span>');
    if (mh.U && (mh.E || mh.B)) off.push('<span class="lq-muted">' + fNum(mh.U) + ' sans offre</span>');
    h += '<div class="fn-grid lq-kpis">';
    h += kpi(drillV(fNum(mh.n), mh.n), MG('closes', prec),
      (off.length ? off.join(' · ') + '<br>' : '')
      + (mh.sansFiche ? 'dont ' + fNum(mh.sansFiche) + ' sans fiche lead (non notés)<br>' : '')
      + (an.length ? fNum(an.length) + ' close' + (an.length > 1 ? 's annulés retirés' : ' annulé retiré') + I('closes_annules') + '<br>' : '')
      + MG('closes_cohorte') + ' : ' + drill(t.closes, 'all', 'closed')
      + (t.closesSansRdv ? ' · dont ' + fNum(t.closesSansRdv) + ' sans RDV enregistré' + IL('close_sans_rdv_enregistre') : ''));
    h += kpi(drillV(fEur(mh.con), mh.n), MG('contracte'),
      'HT · ' + MG('panier_moyen') + ' ' + fEur(mh.n ? mh.con / mh.n : null)
      + (mh.sansPaiement ? '<br>dont ' + fNum(mh.sansPaiement) + ' close' + (mh.sansPaiement > 1 ? 's' : '') + ' sans paiement' + I('close_sans_paiement') : '')
      + '<br>' + ML('contracte_cohorte') + ' : ' + fEur(t.con));
    h += kpi(drillV(fEur(mh.paid), mh.n), MG('collecte'),
      'HT, déjà prélevé sur ces closes<br>' + MG('reste_a_encaisser') + ' : ' + fEur(mh.reste)
      + (mh.pending > 0.5 ? '<br>dont ' + MG('premiers_prelevements') + ' : ' + fEur(mh.pending) : '')
      + '<br>' + ML('collecte_cohorte') + ' : ' + fEur(t.cash));
    if (per) {
      var pp = S.M.prelevePeriode || {};
      h += kpi(fEur(t.periodCash), MG('preleve_periode'), 'HT, prélèvements passés pendant la période, anciens clients compris · '
        + fNum(t.payers) + ' client' + (t.payers > 1 ? 's ont' : ' a') + ' payé'
        + (pp.filtre ? '<br>filtre tunnel / source : paiements sans fiche lead écartés' : '')
        + '<br>Ce n\'est pas le Collecté (clients gagnés pendant la période, à ce jour)');
    }
    h += '</div>';

    h += funnelCheckHtml();

    /* Tunnel des leads entrés */
    h += card('🛤️ Le tunnel des leads entrés', 'quiz (mesure anonyme) → leads → leads avec RDV → leads présents → closes des leads entrés → contracté', tunnelStrip(t, mh));

    /* Phrases clés */
    h += card('💡 Ce qu\'il faut retenir', '', insightsHtml(bn));

    /* Tableau LQS */
    var thTaux = '<th>' + ML('taux_close_leads_presents') + '</th><th>' + ML('taux_close_leads_avec_rdv') + '</th>';
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr>'
      + '<th class="l">Note LQS' + IL('lqs') + '</th><th>' + ML('leads_et_reoptins') + '</th><th>Part</th><th>' + ML('leads_avec_rdv') + '</th><th>' + ML('leads_presents') + '</th>'
      + '<th>' + (per ? MG('closes', 'Ici : clients gagnés pendant la période, rangés selon la note du lead.') : MG('closes_cohorte')) + '</th>'
      + '<th>Élite / Business' + IN('Élite / Business', 'Offre vendue (closeData.offre) : Élite / Business Phénix. « sans offre » = close sans offre renseignée.') + '</th>'
      + thTaux
      + '<th>' + (per ? MG('contracte') : ML('contracte_cohorte')) + ' · collecté</th><th class="l" style="min-width:140px">' + ML('part_contracte') + '</th><th>' + (per ? MG('panier_moyen') : MG('panier_moyen', 'Ici : contracté des leads entrés ÷ closes des leads entrés (même base que les deux colonnes voisines), pas les closes de la période.')) + '</th><th>' + ML('contracte_par_lead') + '</th>'
      + (per ? '<th>' + MG('preleve_periode') + '</th>' : '')
      + '<th>' + ML('note_equipe') + '</th></tr></thead><tbody>';
    function rowCells(a, k, isTot) {
      var c = cashOf(a), share = totCash > 0 ? c / totCash * 100 : null;
      var cl = closesOf(a);
      var nk = isTot ? 'all' : k;
      var off2 = per
        ? (a.signers ? fNum(a.signersE) + ' / ' + fNum(a.signersB) + (a.signersU ? sub(fNum(a.signersU) + ' sans offre') : '') : '—')
        : (a.closes ? fNum(a.closesE) + ' / ' + fNum(a.closesB) + (a.closesU ? sub(fNum(a.closesU) + ' sans offre') : '') : '—');
      var closesCell = per ? drillV(fNum(cl), cl, nk) : drill(cl, nk, 'closed') + (a.closesSansRdv ? sub('dont ' + fNum(a.closesSansRdv) + ' sans RDV enregistré') : '');
      return '<td>' + drill(a.leads, nk, 'leads') + '</td><td>' + (isTot ? '100 %' : fPct(t.leads ? a.leads / t.leads * 100 : null)) + '</td>'
        + '<td>' + drill(a.leadsAvecRdv, nk, 'booked') + sub(fPct(a.pctLeadsAvecRdv) + ' des leads') + '</td>'
        + '<td>' + drill(a.leadsPresents, nk, 'present') + sub(fPct(a.pctLeadsPresents) + ' des leads avec RDV') + '</td>'
        + '<td><strong>' + closesCell + '</strong></td>'
        + '<td>' + off2 + '</td>'
        + (per ? '<td>' + nonCalc() + '</td><td>' + nonCalc() + '</td>'
          : '<td>' + fPct(a.tauxCloseLeadsPresents) + '</td><td>' + fPct(a.tauxCloseLeadsAvecRdv) + '</td>')
        + '<td>' + money(c, paidOf(a)) + '</td>'
        + '<td class="l">' + (isTot ? '' : bar(share, 'lq-n' + k) + sub(fPct(share))) + '</td>'
        + '<td>' + fEur(cl ? c / cl : null) + '</td><td>' + (per ? nonCalc() : fEur(a.leads ? c / a.leads : null)) + '</td>'
        + (per ? '<td>' + fEur(a.periodCash) + '</td>' : '')
        + '<td>' + (a.teamAvg != null ? '★ ' + fDec(a.teamAvg, 1) : '—') + '</td>';
    }
    LC.NOTE_KEYS.forEach(function (k) {
      var a = m[k];
      if (!a.leads && !(per && (a.signers || a.periodCash || a.periodCon))) return;
      body += '<tr><td class="l">' + noteBadge(k || null) + ' <span class="lq-nl">' + NOTE_LBL[k] + '</span></td>' + rowCells(a, k, false) + '</tr>';
    });
    body += '<tr class="tot"><td class="l">Total</td>' + rowCells(t, 'all', true) + '</tr>';
    body += '</tbody></table></div>';
    body += '<div class="fn-stage-note" style="margin-top:8px">👆 Clique un chiffre (leads, leads avec RDV, leads présents, closes) pour voir les prospects concernés par leur nom, leur questionnaire, leur issue et la transcription de leur visio de closing — et les exporter en PDF.</div>';
    body += '<div class="fn-stage-note" style="margin-top:8px">' + (per
      ? 'Mode « Closes de la période »' + IL('mode_periode') + ' : leads, leads avec RDV et leads présents = leads entrés pendant la période ; closes, contracté et collecté = clients gagnés pendant la période (même liste que le Stats funnel), rangés selon la note du lead quel que soit son mois d\'entrée ; un close sans fiche lead va en « Non noté ». Les taux de close et le contracté / lead ne se lisent que sur les leads entrés : ils ne sont pas calculés ici. « Prélevé sur la période » = prélèvements passés pendant la période, anciens clients compris (un autre chiffre).'
      : 'Leads entrés pendant la période (ré-optins compris) · leads avec RDV, leads présents et closes des leads entrés suivis jusqu\'à aujourd\'hui (un lead compte une fois) · contracté = contrat HT du close · collecté = prélèvements réellement passés (HT) · closes annulés exclus · un ancien client qui se réinscrit n\'est pas un close des leads entrés.') + '</div>';
    if (!per && (mh.n !== t.closes || Math.abs(mh.con - totCash) > 0.5)) {
      body += '<div class="fn-stage-note" style="margin-top:8px">Ce tableau suit les <strong>leads entrés pendant la période</strong> : ' + fNum(t.closes) + ' close' + (t.closes > 1 ? 's' : '') + ' des leads entrés, ' + fEur(totCash) + ' contractés. '
        + 'Les cartes du haut comptent les <strong>clients gagnés pendant la période</strong> (' + fNum(mh.n) + ', ' + fEur(mh.con) + ') : l\'écart vient de clients entrés à une autre date que celle de leur close. Pour voir ce tableau sur la même base, clique « 🏦 Closes de la période ».</div>';
    }
    h += card('⭐ Qualité des leads → résultats', S.closer ? 'leads de ' + esc(clName) : 'toute l\'équipe', body);

    h += alignmentCard(R);
    return h;
  }

  function quizTotals() {
    var q = { starts: 0, completes: 0, gateShown: 0, gateExit: 0, has: false };
    (S.M.quiz || []).forEach(function (p) { q.starts += p.starts; q.completes += p.completes; q.gateShown += p.gate.shown; q.gateExit += p.gate.exit; q.has = true; });
    return q;
  }
  function tunnelStrip(t, mh) {
    var q = quizTotals();
    var V = LC.quizVersions(rows(), S.M.quiz || [], S.M.tunnels || S.ctx.tunnelsMeta || null, S.M.views);
    var quizLeads = rows().filter(function (r) { return r.answers.some(function (a) { return a.o === 'quiz'; }); }).length;
    var steps = [
      q.has ? { v: fNum(q.starts), l: 'Quiz commencés', s: V.all.views ? fPct(q.starts / V.all.views * 100) + ' des visites' : '' }
        : { v: V.all.views ? fNum(V.all.views) : '—', l: V.all.views ? 'Visites des pages quiz' : 'Quiz commencés', s: V.all.views ? 'commencés : mesure à activer' : 'mesure à activer' },
      q.has ? { v: fNum(q.completes), l: 'Quiz terminés', s: q.starts ? fPct(q.completes / q.starts * 100) + ' des débuts' : '' }
        : { v: V.all.views ? fNum(V.all.optins) : '—', l: V.all.views ? 'Formulaires quiz envoyés' : 'Quiz terminés', s: V.all.views ? fPct(V.all.optins / V.all.views * 100) + ' des visites' : '' },
      { v: fNum(t.leads), l: S.closer ? 'Leads de ' + esc(S.M.memberName(S.closer)) + IL('filtre_closer') : ML('leads_et_reoptins'), s: fNum(quizLeads) + ' via le quiz' }
    ];
    if (!S.closer) steps.push({ v: fNum(t.leadsAvecRdv), l: ML('leads_avec_rdv'), s: fPct(t.pctLeadsAvecRdv) + ' des leads' });
    steps.push({ v: fNum(t.leadsPresents), l: ML('leads_presents'), s: fPct(t.pctLeadsPresents) + ' des leads avec RDV' });
    steps.push({ v: fNum(t.closes), l: MG('closes_cohorte'), s: 'close / leads présents : ' + fPct(t.tauxCloseLeadsPresents) + (t.closesSansRdv ? '<br>dont ' + fNum(t.closesSansRdv) + ' sans RDV enregistré' : '') });
    steps.push({ v: fEur(t.con), l: ML('contracte_cohorte'), s: fEur(t.cash) + ' collecté' });
    var h = '<div class="lq-strip">';
    steps.forEach(function (s, i) {
      if (i) h += '<div class="lq-strip-arrow">›</div>';
      h += '<div class="lq-strip-step"><div class="v">' + s.v + '</div><div class="l">' + s.l + '</div><div class="s">' + (s.s || '&nbsp;') + '</div></div>';
    });
    h += '</div>';
    if (mh && (mh.n !== t.closes || Math.abs(mh.con - t.con) > 0.5)) h += '<div class="fn-stage-note" style="margin-top:8px">Clients gagnés <strong>pendant la période</strong> (cartes du haut, quel que soit leur mois d\'entrée) : ' + fNum(mh.n) + ' close' + (mh.n > 1 ? 's' : '') + ' · ' + fEur(mh.con) + ' contractés. Ce tunnel suit les leads entrés pendant la période, jusqu\'à aujourd\'hui.</div>';
    if (q.has && q.gateShown) h += '<div class="fn-stage-note" style="margin-top:8px">Écran prix : affiché ' + fNum(q.gateShown) + ' fois · ' + fNum(q.gateExit) + ' visiteurs se sont arrêtés là (écartés par l\'écran prix, avant de prendre un créneau).</div>';
    if (!q.has) h += '<div class="fn-stage-note" style="margin-top:8px">« Quiz commencés / terminés » et l\'abandon question par question démarrent à l\'instrumentation de la page quiz (scripts/quiz-tracking-patch.js --apply) : ils ne se reconstituent pas pour le passé. Visites et formulaires envoyés, eux, sont mesurés depuis septembre.</div>';
    return h;
  }

  function insightsHtml(bn) {
    var per = S.cashMode === 'periode';
    var list = LC.insights(bn, S.cashMode);
    var cashWord = per ? 'du contracté des closes de la période' : 'du contracté des leads entrés';
    var totC = per ? bn.total.periodCon : bn.total.con;
    function enc(x) { return ', dont ' + fEur(x.paid) + ' collecté'; }
    if (!(totC > 0)) {
      list = list.filter(function (x) { return x.k === 'hi' || x.k === 'lo' || x.k === 'none'; });
      var h0 = '<ul class="lq-ins">';
      list.forEach(function (x) {
        if (x.k === 'hi') h0 += '<li><span class="lq-note lq-n5">4-5</span> Les leads notés <strong>LQS 4 et 5</strong> sont <strong>' + fNum(x.leads) + '</strong> (' + fPct(x.leadsPct) + ' de tous les leads, notés ou non). Aucun close sur ces leads pour l\'instant.</li>';
        else if (x.k === 'lo') h0 += '<li><span class="lq-note lq-n1">1</span> Les leads notés <strong>LQS 1</strong> : ' + fNum(x.leads) + ' leads, ' + fNum(x.booked) + ' avec RDV.</li>';
        else if (x.k === 'none') h0 += '<li><span class="lq-note lq-n0">–</span> ' + fNum(x.leads) + ' leads (' + fPct(x.pct) + ') sans réponse exploitable : pas de quiz ni de formulaire noté (RDV direct, import, ancien tunnel).</li>';
      });
      return h0 + '</ul>';
    }
    if (!list.length) return '<div class="lq-muted">Aucun lead noté sur la période : les leads n\'ont pas de réponses exploitables (quiz ou formulaire).</div>';
    var h = '<ul class="lq-ins">';
    list.forEach(function (x) {
      if (x.k === 'hi') h += '<li><span class="lq-note lq-n5">4-5</span> Les leads notés <strong>LQS 4 et 5</strong> sont <strong>' + fNum(x.leads) + '</strong> (' + fPct(x.leadsPct) + ' de tous les leads, notés ou non) et pèsent <strong>' + fPct(x.cashPct) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + enc(x) + ').</li>';
      else if (x.k === 'mid') h += '<li><span class="lq-note lq-n3">3-4</span> Les notes <strong>3 et 4</strong> (la note 4 est aussi comptée dans la ligne du dessus) pèsent <strong>' + fPct(x.cashPct) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + enc(x) + ').</li>';
      else if (x.k === 'lo') h += '<li><span class="lq-note lq-n1">1</span> Les leads notés <strong>LQS 1</strong> : ' + fNum(x.leads) + ' leads, ' + fNum(x.booked) + ' avec RDV, <strong>' + fPct(x.cashPct) + '</strong> ' + cashWord + ' (' + fEur(x.cash) + enc(x) + ')' + (x.booked && (x.cashPct == null || x.cashPct < 5) ? ' → des créneaux à libérer pour de meilleurs leads.' : '.') + '</li>';
      else if (x.k === 'none') h += '<li><span class="lq-note lq-n0">–</span> ' + fNum(x.leads) + ' leads (' + fPct(x.pct) + ') sans réponse exploitable : pas de quiz ni de formulaire noté (RDV direct, import, ancien tunnel).</li>';
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
  /* ── Vue d'ensemble par quiz : chiffres de référence (10/11/2026, T2) ──
     Un bloc par quiz, une ligne par variante, jamais deux quiz mélangés.
     Compteurs fiables uniquement (lqs-core quizOverview) : c'est la lecture
     du test A/B (KPI : ont répondu Q1 / arrivés). */
  function ovRate(v) { return '<div class="lq-sub">' + (v == null ? '&nbsp;' : fPct(v, 0)) + '</div>'; }
  function ovCells(o, doneMeasured) {
    return '<td><strong>' + fNum(o.arrives) + '</strong>' + ovRate(null) + '</td>'
      + '<td><strong>' + fNum(o.q1) + '</strong>' + ovRate(o.rQ1) + '</td>'
      + '<td>' + fNum(o.none) + ovRate(o.arrives ? o.none / o.arrives * 100 : null) + '</td>'
      + '<td>' + (doneMeasured ? fNum(o.done) + ovRate(o.rDone) + (o.doneSince && o.days > 1 ? '<div class="lq-sub lq-muted">mesuré depuis le ' + dayShort(o.doneSince) + '</div>' : '') : '<span class="lq-muted">non mesuré</span>') + '</td>'
      + '<td>' + fNum(o.optins) + ovRate(o.rOptin) + '</td>'
      + '<td><strong>' + fNum(o.newLeads) + '</strong>' + ovRate(o.optins ? o.newLeads / o.optins * 100 : null) + '</td>'
      + '<td>' + fNum(o.backLeads) + ovRate(null) + '</td>'
      + '<td>' + fNum(o.booked) + ovRate(o.rBook) + '</td>'
      + '<td>' + fNum(o.present != null ? o.present : o.kept) + ovRate(o.rPresent != null ? o.rPresent : o.rKept) + '</td>';
  }
  function ovHead(first) {
    return '<thead><tr><th class="l">' + first + '</th>'
      + '<th>' + ML('arrives') + '</th>'
      + '<th>Ont répondu Q1' + IN('Ont répondu Q1', 'Ont cliqué une réponse à la question 1 · taux = ÷ arrivés (KPI du test A/B).') + '</th>'
      + '<th>N\'ont rien cliqué' + IN('N\'ont rien cliqué', 'Arrivés − ont répondu Q1.') + '</th>'
      + '<th>Ont fini les questions' + IN('Ont fini les questions', 'Écran de fin des questions atteint · taux = ÷ ont répondu Q1.') + '</th>'
      + '<th>' + ML('formulaire_envoye') + '</th>'
      + '<th>' + ML('nouveaux_leads') + '</th>'
      + '<th>' + MG('reoptins', 'Ici : fiches déjà connues réinscrites par ce quiz pendant la période (mise à jour, pas de nouvelle fiche).') + '</th>'
      + '<th>' + MG('rdv_pris', 'Ici : RDV pris pendant la période par les leads de ce quiz (Self Booking ou Setting, hors reports et doublons) · taux = ÷ nouveaux leads + ré-optins.') + '</th>'
      + '<th>' + MG('presents', 'Ici : RDV pris dont le prospect est venu (lu sur le dernier RDV de la chaîne de report) · taux = ÷ RDV pris.') + '</th></tr></thead>';
  }
  function dayShort(iso) { var p = String(iso || '').split('-'); return p.length === 3 ? p[2] + '/' + p[1] : '—'; }
  function overviewCards(list) {
    if (!list.length) return '';
    var h = '';
    list.forEach(function (q) {
      var det = 'ov_' + q.tunnel;
      var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t">' + ovHead('Variante') + '<tbody>';
      q.pages.forEach(function (r) {
        body += '<tr><td class="l"><strong>' + esc(r.label) + '</strong>' + sub(esc(r.path + (r.variant ? ' · ' + r.variant.toUpperCase() : '')) + (r.first ? ' · du ' + dayShort(r.first) + ' au ' + dayShort(r.last) : '')) + '</td>' + ovCells(r.total, r.total.doneMeasured) + '</tr>';
      });
      if (q.pages.length > 1) body += '<tr class="tot"><td class="l">Total du quiz</td>' + ovCells(q.total, q.doneMeasured) + '</tr>';
      body += '</tbody></table></div>';
      body += '<div class="lq-actions" style="margin-top:8px"><button class="fn-btn' + (S.openDetail[det] ? ' primary' : '') + '" data-lq-det="' + esc(det) + '">' + (S.openDetail[det] ? '▾ Masquer le détail par jour' : '▸ Détail par jour') + '</button></div>';
      if (S.openDetail[det]) {
        body += '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t">' + ovHead('Jour') + '<tbody>';
        q.dayList.forEach(function (d) { body += '<tr><td class="l">' + dayShort(d.day) + '</td>' + ovCells(d, d.doneMeasured) + '</tr>'; });
        q.pages.forEach(function (r) {
          if (q.pages.length < 2) return;
          body += '<tr class="tot"><td class="l" colspan="10">' + esc(r.label) + '</td></tr>';
          r.days.forEach(function (d) { body += '<tr><td class="l">' + dayShort(d.day) + ' · ' + esc((r.variant || '?').toUpperCase()) + '</td>' + ovCells(d, d.doneMeasured) + '</tr>'; });
        });
        body += '</tbody></table></div>';
      }
      if (q.spend) {
        var nl = q.total.newLeads + q.total.backLeads;
        body += '<div class="lq-vline" style="margin-top:10px">💶 <strong>Dépense Meta : ' + fEur(q.spend) + '</strong>'
          + ' · coût par arrivé ' + fEur(q.total.arrives ? q.spend / q.total.arrives : null)
          + ' · par réponse à Q1 ' + fEur(q.total.q1 ? q.spend / q.total.q1 : null)
          + ' · par formulaire ' + fEur(q.total.optins ? q.spend / q.total.optins : null)
          + ' · <strong>par nouveau lead ' + fEur(q.cpl) + '</strong>'
          + (nl !== q.total.newLeads ? ' (' + fEur(nl ? q.spend / nl : null) + ' en comptant les ré-optins)' : '') + '</div>'
          + '<div class="fn-stage-note">Dépense de chaque pub répartie selon la page où arrivent SES visites (utm_content), jour par jour : une même campagne peut mener à deux quiz.'
          + (list.spendUnattributed ? ' ' + fEur(list.spendUnattributed) + ' de dépense sur la période sans visite rattachée (pubs sans utm_content, autres pages).' : '') + '</div>';
      }
      body += '<div class="fn-stage-note" style="margin-top:8px">Période couverte par la mesure : '
        + (q.first ? 'du ' + dayShort(q.first) + ' au ' + dayShort(q.last) : 'aucune visite mesurée')
        + ' · jours de Paris · visites internes (tests, équipe) exclues. Arrivés, réponses à Q1 et formulaires : compteurs de la page, toutes publications réunies. Leads et RDV : fiches Leads Live dont ce quiz est la page d\'entrée. Ce bloc ne suit pas les filtres tunnel / source / closer de la page.</div>';
      h += card('🎯 ' + esc(q.name) + ' — chiffres de référence', 'un quiz, ses variantes · taux sous chaque chiffre', body);
    });
    return h;
  }

  /* ── Contrôle de cohérence quotidien (10/11/2026, T5) ── */
  function checksCard(list) {
    var rows = LC.quizChecks(list);
    if (!rows.length) return '';
    var nAlert = rows.filter(function (r) { return r.alert; }).length;
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Jour</th><th class="l">Quiz</th><th>Arrivés</th>'
      + '<th title="1ers clics sur une réponse (page) ↔ réponses à la question 1 (mesure du quiz)">Ont répondu Q1 · clics ↔ quiz</th>'
      + '<th title="Formulaires envoyés (page) ↔ fiches Leads Live créées ou mises à jour par ce quiz">Formulaires ↔ fiches</th><th>État</th></tr></thead><tbody>';
    rows.slice().sort(function (a, b) { return a.day < b.day ? 1 : (a.day > b.day ? -1 : (a.name < b.name ? -1 : 1)); }).forEach(function (r) {
      function cellOf(k) {
        var it = r.items.filter(function (x) { return x.k === k; })[0];
        if (!it) return '<td><span class="lq-muted">non mesuré</span></td>';
        return '<td' + (it.alert ? ' class="lq-down"' : '') + '>' + fNum(it.a) + ' ↔ ' + fNum(it.b) + (it.gap ? sub(fPct(it.gap * 100, 0) + ' d\'écart') : '') + '</td>';
      }
      body += '<tr><td class="l">' + dayShort(r.day) + '</td><td class="l">' + esc(r.name) + '</td><td>' + fNum(r.arrives) + '</td>' + cellOf('q1') + cellOf('optin')
        + '<td>' + (r.alert ? '<span class="fn-tbadge lq-warn">⚠ écart</span>' : (r.big ? '<span class="fn-tbadge lq-good">✓</span>' : '<span class="lq-muted">trop peu de visites</span>')) + '</td></tr>';
    });
    body += '</tbody></table></div>';
    body += '<div class="fn-stage-note" style="margin-top:8px">Alerte : plus de 20 % d\'écart un jour de plus de 30 arrivés. Un écart « formulaires ↔ fiches » veut dire que des leads sont rangés sous une autre page (provenance mal lue) ; un écart « Q1 » veut dire que la mesure du quiz perd des réponses.</div>';
    body += '<div class="fn-stage-note" style="margin-top:6px">À rapprocher à la main (hors Team) : <strong>arrivés</strong> ↔ landing page views Meta des campagnes qui mènent à la page (une même campagne peut mener à deux quiz : comparer par utm_campaign dans Admin → Tunnels → Stats) · <strong>ont répondu Q1</strong> ↔ <code>Quiz_Demarrage</code> du pixel (événements navigateur seuls, les deux quiz réunis) · <strong>formulaires</strong> ↔ exécutions du scénario Make « Leads QUIZ ÉLITE » (les deux quiz réunis).</div>';
    return card('🩺 Contrôle de cohérence de la mesure', nAlert ? nAlert + ' jour' + (nAlert > 1 ? 's' : '') + ' en écart' : 'tout concorde', body);
  }

  /* ── Qualité des leads par page d'entrée (10/11/2026, T7) ── */
  function qualityCard() {
    var list = LC.qualityByPage(rows(), S.M.tunnels || S.ctx.tunnelsMeta || null);
    if (!list.length) return '';
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Page d\'entrée</th><th>' + ML('nouveaux_leads') + '</th><th>' + MG('reoptins', 'Ici : anciens leads réinscrits par ce quiz pendant la période.') + '</th>'
      + '<th>' + ML('leads_avec_rdv', 'Sous le chiffre : Self Booking (SB) / Setting (NB) / manuel, selon leur premier RDV.') + '</th><th>' + ML('leads_presents') + '</th><th>' + MG('closes_cohorte') + '</th>'
      + '<th>' + ML('taux_close_lead') + '</th><th>' + ML('contracte_cohorte') + ' · collecté</th><th>' + ML('contracte_par_lead') + '</th></tr></thead><tbody>';
    var lastQuiz = '', sansRep = 0;
    list.forEach(function (g) {
      var a = g.agg;
      sansRep += g.sansReponses || 0;
      if (g.quiz !== lastQuiz) { body += '<tr class="tot"><td class="l" colspan="9">' + esc(g.quiz) + '</td></tr>'; lastQuiz = g.quiz; }
      body += '<tr><td class="l"><strong>' + esc(g.label) + '</strong>' + sub(esc(g.path + (g.variant ? ' · ' + g.variant.toUpperCase() : '')) + (g.sansReponses ? ' · ' + fNum(g.sansReponses) + ' fiche' + (g.sansReponses > 1 ? 's' : '') + ' sans réponses (non comptée' + (g.sansReponses > 1 ? 's' : '') + ')' : '')) + '</td>'
        + '<td>' + fNum(a.nouveaux) + '</td><td>' + fNum(a.reopt) + '</td>'
        + '<td>' + fNum(a.leadsAvecRdv) + sub(fPct(a.pctLeadsAvecRdv) + ' des leads · SB ' + fNum(g.self) + ' / NB ' + fNum(g.setter) + (g.manuel ? ' / manuel ' + fNum(g.manuel) : '')) + '</td>'
        + '<td>' + fNum(a.leadsPresents) + sub(fPct(a.pctLeadsPresents) + ' des leads avec RDV') + '</td>'
        + '<td><strong>' + fNum(a.closes) + '</strong>' + (a.closesSansRdv ? sub('dont ' + fNum(a.closesSansRdv) + ' sans RDV enregistré') : '') + '</td><td>' + fPct(a.tauxCloseLeads) + '</td>'
        + '<td>' + money(a.con, a.cash) + '</td><td>' + fEur(a.leads ? a.con / a.leads : null) + '</td></tr>';
    });
    body += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">Leads de la période choisie (nouveaux leads et ré-optins séparés ; pour la lecture du brief : période depuis le 01/10), rangés par la page quiz qui les a fait entrer. Leads avec RDV, leads présents et closes des leads entrés suivis jusqu\'à aujourd\'hui (un lead compte une fois) ; contracté = contrat HT du close, collecté = prélèvements passés. Close / lead et contracté / lead se calculent sur nouveaux leads + ré-optins.'
      + (sansRep ? ' ' + fNum(sansRep) + ' fiche' + (sansRep > 1 ? 's' : '') + ' entrée' + (sansRep > 1 ? 's' : '') + ' par un quiz sans réponses enregistrées n\'' + (sansRep > 1 ? 'y sont' : 'y est') + ' pas comptée' + (sansRep > 1 ? 's' : '') + '.' : '') + '</div>';
    return card('🏁 Qualité des leads par page d\'entrée', 'quel quiz, quelle variante amène les leads qui signent', body);
  }

  function viewQuiz() {
    var meta = S.M.tunnels || S.ctx.tunnelsMeta || null;
    /* 07/11/2026 : par défaut, la mesure visiteurs de chaque version ne
       compte que la DERNIÈRE publication de la page (compteurs séparés par
       version, api/tunnel-event.js) — les leads restent sur toute la période. */
    var pagesAll = S.M.quiz || [];
    var hasLatest = pagesAll.some(function (p) { return p.latest && p.latest.partial; });
    var pages = S.quizLatest ? pagesAll.map(function (p) { return p.latest || p; }) : pagesAll;
    var R = rows();
    var V = LC.quizVersions(R, pages, meta, S.M.views);
    var fams = V.families || [];
    if (S.quizVer && !V.list.some(function (v) { return v.key === S.quizVer; }) && !fams.some(function (f) { return f.key === S.quizVer; })) S.quizVer = '';
    var h = help('ℹ️ Comment lire cette vue', '<p>Deux types de personnes : les <strong>visiteurs</strong> (tous ceux qui font le quiz, comptés anonymement) et les <strong>contacts</strong> (ceux qui ont laissé leurs coordonnées à la fin).</p>'
      + '<p><strong>🚪 À quel moment les gens quittent le quiz</strong> : pour chaque question, combien de visiteurs l\'ont vue, combien y ont répondu, combien sont partis dessus — puis combien ont tout rempli. Une question qui fait partir beaucoup de monde est peut-être mal posée, pas pertinente ou gênante.</p>'
      + '<p><strong>📋 Question par question</strong> : pour chaque réponse, combien de visiteurs l\'ont choisie, et ce que ça a donné chez les contacts (closes des leads entrés Élite / Business, contracté et collecté), avec ses points dans le barème.</p>'
      + '<p>Les <strong>cartes</strong> en haut filtrent par version du quiz (Dark, White, YouTube…). « Comparer » les met côte à côte. Les formulaires hors quiz sont tout en bas.</p>'
      + '<p><strong>Période comparable</strong> (par défaut) : toutes les publications de la page sont réunies tant que les questions mesurées restent les mêmes ; un changement de questions ou une mesure corrigée ouvre une nouvelle période, pour ne jamais mélanger deux parcours qui ne se comparent pas. Les <strong>chiffres de référence</strong> en tête (arrivés, Q1, formulaires, leads, RDV) couvrent toujours toute la période choisie.</p>'
      + '<p>Définitions : dans les <strong>chiffres de référence</strong>, <strong>arrivés</strong> = page du quiz affichée (une fois par session, compteur de la page) ; dans le <strong>parcours</strong>, la première ligne compte ceux qui <strong>ont vu la 1re question</strong> (mesure du quiz lui-même, période comparable) ; <strong>commencé</strong> = a cliqué une réponse à la question 1. Côté contacts : leads avec RDV, leads présents et closes des leads entrés comptent des leads (un lead compte une fois).</p>');
    var ovList = LC.quizOverview(S.D || {}, S.ctx.P, S.M.tunnels || S.ctx.tunnelsMeta || null);
    h += overviewCards(ovList);
    h += checksCard(ovList);
    h += qualityCard();

    if (!V.list.length) {
      h += card('🧭 Parcours du quiz', '', '<div class="lq-muted">Aucun lead issu d\'un quiz et aucune mesure sur la période. La mesure démarre quand la page quiz est instrumentée (<code>node scripts/quiz-tracking-patch.js --apply</code>).</div>');
    } else {
      h += '<div class="lq-vcards">' + versionCard(V.all, !S.quizVer);
      fams.forEach(function (f) { if (f.versions.length > 1) h += versionCard(f, S.quizVer === f.key); });
      V.list.forEach(function (v) { h += versionCard(v, S.quizVer === v.key); });
      h += '</div>';
      var canCompare = !S.quizVer && V.list.length >= 2;
      var sinceTxt = '';
      if (S.quizLatest && hasLatest) {
        var sinces = pages.filter(function (p) { return p.isLatest && (!S.quizVer || S.quizVer.indexOf(LC.FAMILY_PREFIX) === 0 || p.key === S.quizVer); })
          .map(function (p) { return p.since; }).sort();
        if (sinces.length) sinceTxt = ' · mesure visiteurs depuis la publication du ' + fDay(sinces[sinces.length - 1]) + ' ' + new Date(sinces[sinces.length - 1]).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' });
      }
      h += '<div class="lq-actions" style="margin:-4px 0 14px">'
        + (canCompare ? '<button class="fn-btn' + (S.quizCompare ? ' primary' : '') + '" data-lq-compare>' + (S.quizCompare ? '✓ Comparaison des versions' : '⇄ Comparer les versions côte à côte') + '</button> ' : '')
        + '<button class="fn-btn' + (S.quizLatest ? ' primary' : '') + '" data-lq-latest title="Toutes les publications sont réunies tant que les questions mesurées ne changent pas. Un changement de questions (ou une mesure corrigée) ouvre une nouvelle période : on ne mélange jamais deux parcours qui ne se comparent pas.">' + (S.quizLatest ? '✓ Période comparable (mêmes questions, toutes publications)' : 'Toute la période, mesures différentes additionnées') + '</button>'
        + (sinceTxt ? ' <span class="lq-muted">' + esc(sinceTxt.slice(3)) + '</span>' : '') + '</div>';
      /* « Tous les quiz » : jamais deux quiz différents dans un même parcours
         (identifiants de questions communs) → le parcours montré est celui du
         quiz principal, toutes variantes réunies. */
      /* « Tous les quiz » (10/11/2026, T4) : UN bloc par quiz, aucun masqué —
         jamais deux quiz différents dans un même parcours. */
      var viewKeys = S.quizVer ? [S.quizVer] : (fams.length > 1 ? fams.map(function (f) { return f.key; }) : ['']);
      var cmp = null;
      if (canCompare && S.quizCompare && fams.length <= 1) {
        cmp = V.list.slice(0, 4).map(function (v) { return { v: v, view: LC.buildQuizView(R, pages, v.key, activeGrid(), meta) }; });
      }
      viewKeys.forEach(function (viewKey) {
        var view = LC.buildQuizView(R, pages, viewKey, activeGrid(), meta);
        var cur = viewKey ? (V.list.concat(fams).filter(function (v) { return v.key === viewKey; })[0] || V.all) : V.all;
        var famNote = !S.quizVer && fams.length > 1 ? 'toutes variantes de ce quiz' : '';
        h += card('🧭 Parcours — ' + esc(cur.name), esc((cur.sub || '') + (famNote ? (cur.sub ? ' · ' : '') + famNote : '')), parcours(view, viewKeys.length === 1 ? cmp : null, cur));
      });
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
      + '<div class="lq-vline"><span class="lq-muted">Visiteurs :</span> ' + (v.starts ? '<strong>' + fNum(v.starts) + '</strong> ont commencé · ' + fPct(v.completeRate, 0) + ' ont tout rempli'
        : (v.views ? '<strong>' + fNum(v.views) + '</strong> visites · ' + fNum(v.optins) + ' formulaires envoyés' : '<span class="lq-muted">visiteurs : en attente de mesure</span>')) + '</div>'
      + '<div class="lq-vline"><span class="lq-muted">Leads de la période :</span> <strong>' + fNum(a.leads) + '</strong> → <strong>' + fNum(a.closes) + '</strong> close' + (a.closes > 1 ? 's' : '') + ' des leads entrés · <strong>' + fEur(a.con) + '</strong> contractés · ' + fEur(a.cash) + ' collectés</div>'
      + (a.closes ? '<div class="lq-vline">' + offerSplit(a) + '</div>' : '') + '</div>';
  }

  /* ── Parcours (réécrit en langage clair, 06/11/2026) ──────────────────
     Deux populations, toujours nommées pareil à l'écran :
       · « visiteurs » = toutes les personnes qui font le quiz (anonymes,
         mesurées par la page) → arrivés, ont répondu, partis ;
       · « contacts » = ceux qui ont laissé leurs coordonnées (leads de la
         période) → RDV, clients, cash. */
  function stepHead(c) {
    var st = c.step, bits = [];
    if (st) {
      bits.push('<strong>' + fNum(st.reached) + '</strong> ' + plur(st.reached, 'arrivé', 'arrivés'));
      bits.push('<strong>' + fNum(st.answered) + '</strong> ' + plur(st.answered, 'a répondu', 'ont répondu'));
      if (st.conditional && !st.first) bits.push('<span class="lq-muted">question montrée à ' + fPct(st.seenPct, 0) + ' des visiteurs seulement</span>');
      else if (st.left != null) bits.push('<span class="' + (st.left > 0 ? 'lq-down' : 'lq-muted') + '">🚪 <strong>' + fNum(st.left) + '</strong> ' + plur(st.left, 'est parti ici', 'sont partis ici') + ' (' + fPct(st.leftPct, 0) + ')</span>');
    } else if (!c.diag) bits.push('<span class="lq-muted">visiteurs : en attente des premières mesures</span>');
    if (c.lq) bits.push('<strong>' + fNum(c.lq.agg.leads) + '</strong> ' + plur(c.lq.agg.leads, 'lead de la période', 'leads de la période'));
    var badges = '';
    if (c.diag) badges += ' <span class="fn-tbadge lq-tf">résultat calculé par le quiz</span>';
    if (st && st.conditional && !st.first) badges += ' <span class="fn-tbadge lq-tf">question conditionnelle</span>';
    if (c.hot) badges += ' <span class="fn-tbadge lq-warn">question qui fait le plus partir</span>';
    return '<div class="lq-step-head"><span class="lq-step-n">' + (c.diag ? '★' : c.n) + '</span><span class="lq-step-t">' + esc(c.label) + badges + '</span><span class="lq-step-m">' + bits.join(' · ') + '</span></div>';
  }
  function answerHead() {
    return '<div class="lq-arow lq-ahead"><span>Réponse</span><span>Choisie par (visiteurs)</span><span>Leads de la période → résultats</span><span class="lq-ap">Points</span></div>';
  }
  /* « A 3 · D 2 » quand la vue réunit plusieurs variantes de page. */
  function vSplit(byV, vars) {
    if (!vars || vars.length < 2 || !byV) return '';
    return vars.map(function (v) { return v.toUpperCase() + ' ' + fNum(byV[v] || 0); }).join(' · ');
  }
  function answerLine(o, vars) {
    var a = o.agg;
    var tag = o.best ? ' <span class="fn-tbadge lq-good">rapporte le plus</span>' : (o.worst ? ' <span class="fn-tbadge lq-warn">rapporte le moins</span>' : '');
    var res;
    if (o.nr) res = '<span class="lq-muted">ancienne version de la page : la réponse choisie n\'était pas transmise</span>';
    else if (!a) res = '<span class="lq-muted">aucun lead avec cette réponse</span>';
    else {
      res = '<strong>' + fNum(a.leads) + '</strong> lead' + (a.leads > 1 ? 's' : '') + ' → <strong>' + fNum(a.closes) + '</strong> close' + (a.closes > 1 ? 's' : '');
      if (a.closes) res += ' (' + offerSplit(a) + ')';
      res += ' · <strong>' + fEur(a.con) + '</strong> contractés · ' + fEur(a.cash) + ' collectés';
      var lv = vSplit(o.leadsByV, vars);
      if (lv) res += sub('leads : ' + lv);
    }
    var vv = o.visitors != null ? vSplit(o.byV, vars) : '';
    return '<div class="lq-arow"><span class="lq-al">' + (o.nr ? '<em class="lq-muted">' + esc(o.label) + '</em>' : esc(o.label)) + tag + '</span>'
      + '<span class="lq-av" data-l="Choisie par">' + (o.visitors != null ? bar(o.visitorShare, 'lq-blue') + '<span class="lq-mono">' + fNum(o.visitors) + ' · ' + fPct(o.visitorShare, 0) + '</span>' + (vv ? sub(vv) : '') : '<span class="lq-muted">en attente</span>') + '</span>'
      + '<span class="lq-ax" data-l="Devenus leads">' + res + '</span>'
      + '<span class="lq-ap" data-l="Points">' + (o.pts != null || o.ko ? ptsChip(o) : '') + '</span></div>';
  }
  function detailTable(c) {
    var h = '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead>'
      + '<tr><th class="l" rowspan="2">Réponse</th><th colspan="2" class="lq-cmp-g">Visiteurs du quiz</th><th colspan="9" class="lq-cmp-g">Contacts (ont laissé leurs coordonnées)</th><th rowspan="2" class="lq-cmp-g">Points</th></tr>'
      + '<tr><th class="lq-cmp-g">Ont choisi</th><th>Part</th><th class="lq-cmp-g">Contacts</th><th>' + ML('leads_avec_rdv') + '</th><th>' + ML('leads_presents') + '</th><th>' + MG('closes_cohorte') + '</th><th>dont Élite</th><th>dont Business</th><th>' + ML('taux_close_lead') + '</th><th>' + ML('contracte_cohorte') + ' · collecté</th><th>' + ML('contracte_par_lead') + '</th></tr></thead><tbody>';
    c.answers.forEach(function (o) {
      var a = o.agg;
      h += '<tr><td class="l">' + esc(o.label) + '</td><td class="lq-cmp-g">' + fNum(o.visitors) + '</td><td>' + fPct(o.visitorShare, 0) + '</td>'
        + (a ? '<td class="lq-cmp-g">' + fNum(a.leads) + '</td><td>' + fNum(a.leadsAvecRdv) + '</td><td>' + fNum(a.leadsPresents) + '</td><td><strong>' + fNum(a.closes) + '</strong>' + (a.closesU ? sub(fNum(a.closesU) + ' sans offre') : '') + '</td>'
          + '<td>' + fNum(a.closesE) + (a.closesE ? sub(fEur(a.conE)) : '') + '</td><td>' + fNum(a.closesB) + (a.closesB ? sub(fEur(a.conB)) : '') + '</td>'
          + '<td>' + fPct(a.closeLead, 1) + '</td><td>' + money(a.con, a.cash) + '</td><td><strong>' + fEur(a.conPerLead) + '</strong></td>'
          : '<td colspan="9" class="l lq-muted lq-cmp-g">aucun contact avec cette réponse sur la période</td>')
        + '<td class="lq-cmp-g">' + (o.pts != null || o.ko ? ptsChip(o) : '—') + '</td></tr>';
    });
    if (c.lq) {
      var t = c.lq.agg;
      h += '<tr class="tot"><td class="l">Total</td><td class="lq-cmp-g">' + (c.step ? fNum(c.step.answered) : '—') + '</td><td></td><td class="lq-cmp-g">' + fNum(t.leads) + '</td><td>' + fNum(t.leadsAvecRdv) + '</td><td>' + fNum(t.leadsPresents) + '</td><td>' + fNum(t.closes) + '</td><td>' + fNum(t.closesE) + (t.closesE ? sub(fEur(t.conE)) : '') + '</td><td>' + fNum(t.closesB) + (t.closesB ? sub(fEur(t.conB)) : '') + '</td><td>' + fPct(t.closeLead, 1) + '</td><td>' + money(t.con, t.cash) + '</td><td>' + fEur(t.conPerLead) + '</td><td class="lq-cmp-g"></td></tr>';
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
    others.forEach(function () { h += '<th class="lq-cmp-g" title="Part des visiteurs qui ont choisi cette réponse">Choisie par</th><th>Contacts</th><th>Contracté / lead</th>'; });
    h += '</tr></thead><tbody>';
    c.answers.forEach(function (ans) {
      h += '<tr><td class="l">' + esc(ans.label) + '</td>';
      others.forEach(function (o) {
        var m = o.c ? o.c.answers.filter(function (x) { return x.key === ans.key; })[0] : null;
        h += '<td class="lq-cmp-g">' + (m ? fPct(m.visitorShare, 0) : '—') + '</td><td>' + (m && m.agg ? fNum(m.agg.leads) : '—') + '</td><td>' + (m && m.agg ? fEur(m.agg.conPerLead) : '—') + '</td>';
      });
      h += '</tr>';
    });
    h += '<tr class="tot"><td class="l">Ont vu la question</td>';
    others.forEach(function (o) { h += '<td class="lq-cmp-g">' + (o.c && o.c.step ? fNum(o.c.step.reached) + ' visiteurs' : '—') + '</td><td>' + (o.c && o.c.lq ? fNum(o.c.lq.agg.leads) : '—') + '</td><td>' + (o.c && o.c.lq ? fEur(o.c.lq.agg.conPerLead) : '—') + '</td>'; });
    return h + '</tr></tbody></table></div>';
  }
  function parcours(view, cmp, cur) {
    var d = view.drop, t = view.total;
    var h = '';
    /* Résumé en une ligne, lisible sans rien connaître de l'outil. */
    if (d.has) {
      /* Deux lectures, chacune sur SA période (08/11/2026) :
         · parcours visiteurs = période mesurée ; « devenus leads » limité à
           cette même période pour se lire avec lui ;
         · résultats = tous les leads de la période choisie en haut de page. */
      h += '<div class="lq-summary"><div><strong>Parcours des visiteurs</strong>' + (d.from ? ' <span class="lq-muted">depuis le ' + fDay(d.from) + '</span>' : '') + ' : <strong>' + fNum(d.shown) + '</strong> ont vu la 1re question' + IL('vus_q1') + ' → <strong>' + fNum(d.starts) + '</strong> ont répondu à la 1re question → <strong>' + fNum(d.completes) + '</strong> ont rempli le quiz → <strong>' + fNum(view.leadsInMeasure) + '</strong> ' + plur(view.leadsInMeasure, 'est devenu lead', 'sont devenus leads') + '</div>'
        + '<div style="margin-top:6px"><strong>Résultats des leads</strong> <span class="lq-muted">' + esc(S.ctx.periodLabel || 'période choisie') + '</span> : <strong>' + fNum(t.leads) + '</strong> lead' + (t.leads > 1 ? 's' : '') + ' de ce quiz → <strong>' + fNum(t.closes) + '</strong> close' + (t.closes > 1 ? 's' : '') + ' des leads entrés' + (t.closes ? ' (' + offerSplit(t) + ')' : '') + ' · <strong>' + fEur(t.con) + '</strong> contractés · ' + fEur(t.cash) + ' collectés'
        + (view.beforeMeasure ? '<div class="lq-sub">dont ' + fNum(view.beforeMeasure) + ' lead' + (view.beforeMeasure > 1 ? 's entrés' : ' entré') + ' avant le début de la mesure visiteurs : ' + (view.beforeMeasure > 1 ? 'ils comptent' : 'il compte') + ' dans les résultats, pas dans le parcours.</div>' : '') + '</div></div>';
    } else {
      h += '<div class="fn-alert" style="margin:0 0 12px">⏳ <strong>Le suivi question par question est activé, mais aucune visite n\'a encore été mesurée sur cette période.</strong> Dès les prochaines personnes qui font le quiz, tu verras ici combien commencent, combien remplissent tout, et sur quelle question elles partent. Le passé ne peut pas être reconstitué.'
        + (cur && cur.views ? '<br>Déjà connu sur la période : <strong>' + fNum(cur.views) + '</strong> visites de la page quiz → <strong>' + fNum(cur.optins) + '</strong> formulaires envoyés (' + fPct(cur.views ? cur.optins / cur.views * 100 : null, 1) + ').' : '') + '</div>';
      h += '<div class="lq-summary"><strong>' + fNum(t.leads) + '</strong> personnes ont rempli le quiz et laissé leurs coordonnées sur la période → <strong>' + fNum(t.leadsAvecRdv) + '</strong> avec RDV → <strong>' + fNum(t.closes) + '</strong> close' + (t.closes > 1 ? 's' : '') + ' des leads entrés' + (t.closes ? ' (' + offerSplit(t) + ')' : '') + ' · <strong>' + fEur(t.con) + '</strong> contractés · ' + fEur(t.cash) + ' collectés</div>';
    }
    if (!cmp) h += exitMap(view);
    if (!view.cards.length) return h + '<div class="lq-muted">Aucune question à afficher.</div>';
    h += '<div class="lq-exit-t" style="margin-top:6px">📋 Question par question : ce que chaque réponse donne</div>';
    var gateDone = false;
    view.cards.forEach(function (c) {
      var key = view.versionKey + '|' + (c.q || c.label);
      var open = S.exporting || !!S.openDetail[key];
      h += '<div class="lq-step' + (c.hot ? ' hot' : '') + (c.diag ? ' diag' : '') + '">' + stepHead(c);
      if (cmp) h += compareTable(c, cmp);
      else {
        if (!c.answers.length) {
          h += '<div class="lq-alist"><div class="lq-empty">Pas encore de réponse enregistrée à cette question' + (c.step && c.step.reached ? ' : les visiteurs qui l\'ont vue sont partis sans répondre.' : '.') + '</div></div>';
        } else {
          h += '<div class="lq-alist">' + answerHead();
          if (c.multi) h += '<div class="lq-agroup lq-muted">Plusieurs réponses possibles : une personne compte dans chaque option cochée (total au-delà de 100 %).</div>';
          var vars = view.variants || [];
          (c.groups || [{ label: '', answers: c.answers }]).forEach(function (g, gi, all) {
            if (all.length > 1) h += '<div class="lq-agroup"><strong>' + esc(g.label) + '</strong></div>';
            g.answers.forEach(function (o) { h += answerLine(o, vars); });
          });
          h += '</div>';
          h += '<button class="fn-ig-detbtn lq-detbtn" data-lq-det="' + esc(key) + '">' + (open ? '▾ masquer le détail' : '▸ tout le détail (RDV, venus, Élite / Business…)') + '</button>';
          if (open) h += detailTable(c);
        }
      }
      h += '</div>';
      if (!gateDone && d.gate.shown && c.step && /ca[-_ ]?mensuel/i.test(c.step.id)) {
        gateDone = true;
        h += gateBlock(d.gate);
      }
    });
    if (!gateDone && d.gate.shown) h += gateBlock(d.gate);
    if (d.has) h += '<div class="lq-step end"><div class="lq-step-head"><span class="lq-step-n">✓</span><span class="lq-step-t">Quiz rempli en entier</span><span class="lq-step-m"><strong>' + fNum(d.completes) + '</strong> visiteurs · ' + fPct(d.completeRate, 0) + ' de ceux qui ont commencé</span></div></div>';
    return h;
  }

  /* 🚪 Où les gens partent : TOUJOURS affiché (même vide), une ligne par
     question — combien l'ont vue, combien y ont répondu, combien sont
     partis dessus — puis combien ont tout rempli. */
  function exitMap(view) {
    var d = view.drop, t = view.total;
    var first = null;
    view.cards.forEach(function (c) { if (!first && c.step) first = c.step; });
    var top = first ? first.reached : 0;
    var max = 0;
    view.cards.forEach(function (c) { if (c.step && c.step.left > max && !c.step.first) max = c.step.left; });
    /* Lecture unique (08/11/2026) : arrivés → ont répondu → partis ici.
       Partis ici = arrivés ici − arrivés à la question suivante. */
    var h = '<div class="lq-exit"><div class="lq-exit-t">🚪 Le parcours, question par question</div>'
      + '<div class="fn-table-wrap"><table class="fn-igt lq-t lq-stack"><thead><tr><th>#</th><th class="l">Question</th>'
      + '<th title="Personnes arrivées sur cette question">Arrivés</th><th title="Ont cliqué une réponse">Ont répondu</th>'
      + '<th class="l" style="min-width:190px" title="Arrivés ici moins arrivés à la question suivante">Partis ici</th>'
      + '<th title="Part des visiteurs de la page encore là">Encore là</th></tr></thead><tbody>';
    view.cards.forEach(function (c) {
      if (c.diag) return;
      var st = c.step;
      h += '<tr' + (c.hot ? ' class="lq-hot"' : '') + '><td>' + c.n + '</td><td class="l">' + esc(c.label) + (c.hot ? ' <span class="fn-tbadge lq-warn">fait le plus partir</span>' : '') + (c.branches > 1 ? ' <span class="fn-tbadge lq-tq" title="L\'intitulé change selon la réponse à la 1re question : toutes les versions sont réunies">' + c.branches + (st && st.first ? ' intitulés' : ' versions selon Q1') + '</span>' : '') + '</td>';
      if (!st) { h += '<td colspan="4" class="l lq-muted">pas encore mesurée</td></tr>'; return; }
      h += '<td data-l="Arrivés"><strong>' + fNum(st.reached) + '</strong></td><td data-l="Ont répondu">' + fNum(st.answered) + '</td>';
      if (st.left == null) h += '<td class="l lq-muted" data-l="Partis ici">montrée à une partie des visiteurs seulement</td>';
      else h += '<td class="l" data-l="Partis ici">' + bar(st.first ? 0 : (max ? st.left / max * 100 : 0), 'lq-n1') + sub('<strong>' + fNum(st.left) + '</strong> · ' + fPct(st.leftPct, 0) + ' des arrivés' + (st.first ? ' (n\'ont pas cliqué, pour la plupart)' : '')) + '</td>';
      h += '<td data-l="Encore là">' + fPct(top ? st.reached / top * 100 : null, st.reached / (top || 1) < 0.1 ? 1 : 0) + '</td></tr>';
    });
    if (d.has) h += '<tr class="tot"><td>✓</td><td class="l">Ont rempli le quiz en entier</td><td><strong>' + fNum(d.completes) + '</strong></td><td></td><td></td><td>' + fPct(top ? d.completes / top * 100 : null, 1) + '</td></tr>';
    h += '<tr class="tot"><td>👤</td><td class="l">Sont devenus leads (coordonnées envoyées, même période)</td><td><strong>' + fNum(view.leadsInMeasure) + '</strong></td><td></td><td></td><td>' + fPct(top ? view.leadsInMeasure / top * 100 : null, 1) + '</td></tr>';
    return h + '</tbody></table></div></div>';
  }


  function gateBlock(g) {
    return '<div class="lq-step gate"><div class="lq-step-head"><span class="lq-step-n">€</span><span class="lq-step-t">Écran prix (CA mensuel ≤ 20 000 €)</span><span class="lq-step-m">vu par <strong>' + fNum(g.shown) + '</strong> visiteurs · '
      + fNum(g['continue']) + ' continuent (' + fPct(g.shown ? g['continue'] / g.shown * 100 : null, 0) + ') · <span class="lq-down">' + fNum(g.exit) + ' s\'arrêtent</span></span></div></div>';
  }
  function stripStep(v, l, s) { return '<div class="lq-strip-step"><div class="v">' + v + '</div><div class="l">' + l + '</div><div class="s">' + (s || '&nbsp;') + '</div></div>'; }

  function questionCard(q, tot) {
    var open = S.exporting || !!S.openQ[q.q];
    var best = null, worst = null;
    q.answerList.forEach(function (x) {
      if (x.agg.leads < LC.SUGGEST_MIN || x.agg.conPerLead == null) return;
      if (!best || x.agg.conPerLead > best.agg.conPerLead) best = x;
      if (!worst || x.agg.conPerLead < worst.agg.conPerLead) worst = x;
    });
    var h = '<div class="lq-qcard' + (q.off ? ' off' : '') + '"><div class="lq-qhead" data-lq-q="' + esc(q.q) + '">'
      + '<span class="lq-caret">' + (open ? '▾' : '▸') + '</span><span class="lq-qt">' + esc(q.label) + '</span>'
      + '<span class="fn-tbadge ' + (q.origin === 'quiz' ? 'lq-tq' : 'lq-tf') + '">' + (q.origin === 'quiz' ? 'Quiz' : 'Formulaire') + '</span>'
      + (q.off ? '<span class="fn-tbadge lq-toff">ignorée dans la note</span>' : '')
      + '<span class="lq-qmeta">' + fNum(q.agg.leads) + ' leads · ' + q.answerList.length + ' réponse' + (q.answerList.length > 1 ? 's' : '')
      + (best && worst && best !== worst ? ' · meilleure : <strong>' + esc(best.label) + '</strong>' : '') + '</span></div>';
    if (open) {
      var list = q.answerList.slice(0, 30);
      h += '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead><tr><th class="l">Réponse</th><th>Points</th><th>' + ML('leads_et_reoptins') + '</th><th>Part</th><th>' + ML('leads_avec_rdv') + '</th><th>' + ML('leads_presents') + '</th><th>' + MG('closes_cohorte') + '</th><th>' + ML('taux_close_lead') + '</th><th>' + ML('contracte_cohorte') + ' · collecté</th><th>' + ML('contracte_par_lead') + '</th><th>LQS moyen' + IL('lqs') + '</th></tr></thead><tbody>';
      list.forEach(function (x) {
        var a = x.agg;
        var tag = x === best && best !== worst ? ' <span class="fn-tbadge lq-good">la plus rentable</span>' : (x === worst && best !== worst ? ' <span class="fn-tbadge lq-warn">la moins rentable</span>' : '');
        h += '<tr><td class="l">' + esc(x.label) + tag + '</td>'
          + '<td>' + ptsChip(x) + '</td><td>' + fNum(a.leads) + '</td><td>' + fPct(x.share, 0) + '</td>'
          + '<td>' + fNum(a.leadsAvecRdv) + sub(fPct(a.pctLeadsAvecRdv) + ' des leads') + '</td><td>' + fNum(a.leadsPresents) + sub(fPct(a.pctLeadsPresents) + ' des leads avec RDV') + '</td>'
          + '<td>' + fNum(a.closes) + '</td><td>' + fPct(a.closeLead, 1) + '</td>'
          + '<td>' + money(a.con, a.cash) + '</td><td><strong>' + fEur(a.conPerLead) + '</strong></td><td>' + avgBadge(a.avgNote) + '</td></tr>';
      });
      if (q.answerList.length > list.length) h += '<tr><td class="l lq-muted" colspan="11">+ ' + (q.answerList.length - list.length) + ' autres réponses (texte libre), moins fréquentes.</td></tr>';
      h += '<tr class="tot"><td class="l">Toutes les réponses</td><td></td><td>' + fNum(q.agg.leads) + '</td><td>100 %</td><td>' + fNum(q.agg.leadsAvecRdv) + '</td><td>' + fNum(q.agg.leadsPresents) + '</td><td>' + fNum(q.agg.closes) + '</td><td>' + fPct(q.agg.closeLead, 1) + '</td><td>' + money(q.agg.con, q.agg.cash) + '</td><td>' + fEur(q.agg.conPerLead) + '</td><td>' + avgBadge(q.agg.avgNote) + '</td></tr>';
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
  var AXES = [['campaign', 'Campagne'], ['adset', 'Adset / audience'], ['creative', 'Créa'], ['channel', 'Canal'], ['device', 'Appareil'], ['region', 'Région']];
  /* Couverture des axes Appareil / Région (23/11/2026) : le navigateur n'est
     capté que depuis le 12/11/2026, le lieu depuis la mise en ligne du bloc
     visiteur — le dire plutôt que laisser lire « Inconnu » comme un résultat. */
  function visiteurCoverage(ax) {
    if (S.axis !== 'device' && S.axis !== 'region') return '';
    var unknown = 0;
    ax.rows.forEach(function (x) { if (x.key === 'dev:inconnu' || x.key === 'geo:inconnu') unknown += x.agg.leads; });
    var tot = ax.total.leads || 0;
    var known = tot - unknown;
    return '<div class="fn-stage-note" style="margin-bottom:10px">' + (S.axis === 'device' ? '📱 Appareil' : '📍 Lieu') + ' connu pour <strong>' + fNum(known) + '</strong> lead' + (known > 1 ? 's' : '') + ' sur ' + fNum(tot)
      + ' (' + fPct(tot ? known / tot * 100 : null, 0) + ').'
      + (S.axis === 'device'
        ? ' Navigateur capté à l\'inscription depuis le 12/11/2026, ou à la prise de RDV.'
        : ' Lieu approximatif (ville de l\'adresse internet) capté depuis le 23/11/2026 à l\'inscription ou à la prise de RDV ; clients plus anciens : lieu de la signature du contrat.')
      + ' Pas de dépense par appareil ni par région : Meta ne la transmet pas.</div>';
  }
  /* Couverture de la dépense par pub — même règle que le Stats funnel
     (k.adSpendDaysExpected / Covered / Complete, funnel-core.js) : jours de
     la période jusqu'à HIER (Paris) ayant au moins une ligne ads_insights_ad
     qui passe les filtres tunnel / source. Repris tel quel quand la page
     fournit les KPI du funnel (ctx.funnelKpis). */
  function adsCoverage() {
    var K = S.ctx && S.ctx.funnelKpis;
    if (K && K.adSpendDaysExpected != null) return { expected: K.adSpendDaysExpected, covered: K.adSpendDaysCovered || 0, ok: !!K.adSpendComplete };
    var P = S.ctx.P, tf = S.ctx.tunnelFilter, yt = S.ctx.sourceFilter === 'youtube';
    var dates = {}, spend = 0;
    if (!yt) (S.M.adsByAd || []).forEach(function (a) {
      if (!a || !a.date) return;
      if (tf && tf !== 'all' && a.tunnel && (a.tunnel === 'business' ? 'business' : 'elite') !== tf) return;
      dates[a.date] = 1; spend += Number(a.spend) || 0;
    });
    var startIso = FC.isoDate(P.start), endIso = FC.isoDate(P.end);
    var hier = SC && SC.jourParis ? SC.jourParis(Date.now() - 86400000) : FC.isoDate(new Date(Date.now() - 86400000));
    var fin = endIso < hier ? endIso : hier;
    var expected = 0, covered = 0;
    if (startIso <= fin) {
      var pp = startIso.split('-'), d = Date.UTC(+pp[0], +pp[1] - 1, +pp[2]), guard = 0;
      while (guard++ < 1200) {
        var iso = new Date(d).toISOString().slice(0, 10);
        if (iso > fin) break;
        expected++;
        if (dates[iso]) covered++;
        d += 86400000;
      }
    }
    return { expected: expected, covered: covered, ok: expected > 0 ? covered >= expected : spend > 0 };
  }
  function viewMarketing() {
    var R = rows();
    var ax = LC.byAxis(R, S.axis, S.M.adsByAd, S.ctx.tunnelFilter, S.ctx.sourceFilter);
    var cov = adsCoverage();
    var K = S.ctx && S.ctx.funnelKpis;
    var costsOk = !S.closer && !ax.sansDepense && cov.ok;
    var h = help('ℹ️ Comment se calcule le MQS', '<p><strong>MQS = 60 % qualité + 40 % résultats</strong>, sur 5.</p><p><strong>Qualité</strong> = LQS moyen des leads de la source (ce que leurs réponses valent).<br><strong>Résultats</strong> = contracté des leads entrés (HT) par lead de la source, comparé à la moyenne : 2× la moyenne ou plus → 5 ; ≥ 1,25× → 4 ; ≥ 0,75× → 3 ; ≥ 0,35× → 2 ; sinon 1. Sans aucun contrat sur la période, la partie résultats compare le taux de leads présents. Les petits effectifs sont ramenés vers la moyenne pour ne pas s\'emballer sur 2 leads.</p>'
      + '<p>Sous ' + LC.MQS_MIN + ' leads notés : « n.s. » (non significatif). <strong>Une créa de découverte</strong> peut avoir un MQS moyen et nourrir les autres : à lire avec la colonne Dépense et le Journal avant de couper.</p>'
      + '<p><strong>Contracté ÷ dépense</strong> n\'est pas le ROAS pub du Stats funnel : il divise la valeur des contrats des leads entrés, pas l\'argent déjà prélevé.</p>'
      + '<p>Les leads sans UTM tombent dans « Pub · créative non transmise » ou « Hors pub ». Pour que chaque 4-5 remonte à sa créa, toutes les pubs doivent porter le modèle d\'URL Meta (utm_content={{ad.name}} ou {{ad.id}}).</p>');
    h += '<div class="fn-seg" style="margin-bottom:14px;width:fit-content">';
    AXES.forEach(function (a) { h += '<button data-lq-axis="' + a[0] + '" class="' + (S.axis === a[0] ? 'active' : '') + '">' + a[1] + '</button>'; });
    h += '</div>';
    h += visiteurCoverage(ax);
    if (S.closer) h += '<div class="fn-alert">Filtre closer : dépense, CPL, coût / lead LQS 4-5 et contracté ÷ dépense ne sont pas calculés — la dépense pub ne se répartit pas par closer.</div>';
    else if (ax.sansDepense) h += '<div class="fn-alert">Vue YouTube : aucune dépense pub Meta à rapporter à ces leads (même règle que le Stats funnel) — coûts non calculés.</div>';
    else if (!cov.ok && ax.spend > 0) h += '<div class="fn-alert">⚠ Dépense Meta par pub reçue pour ' + fNum(cov.covered) + ' jour' + (cov.covered > 1 ? 's' : '') + ' sur ' + fNum(cov.expected) + ' : coûts masqués, ils seraient faussement bas.' + IL('depense_incomplete') + '</div>';
    var withMqs = ax.rows.filter(function (x) { return x.m; }).sort(function (a, b) { return b.m.mqs - a.m.mqs; });
    if (withMqs.length >= 2) {
      var top = withMqs[0], low = withMqs[withMqs.length - 1];
      h += '<div class="fn-rates"><span class="rt">🏆 Meilleure source : <strong>' + esc(top.label) + '</strong> MQS ' + fDec(top.m.mqs, 1) + ' · ' + fPct(top.agg.pct45) + ' de LQS 4-5 · ' + fEur(top.agg.conPerLead) + ' contractés / lead' + (top.agg.closes ? ' · ' + offerSplit(top.agg) : '') + '</span>'
        + '<span class="rt">⚠️ Plus faible : <strong>' + esc(low.label) + '</strong> MQS ' + fDec(low.m.mqs, 1) + ' · ' + fPct(low.agg.pct45) + ' de LQS 4-5</span></div>';
    }
    var t = ax.total, tp = ax.totalPub || t;
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Source</th><th>' + ML('mqs') + '</th><th>' + ML('depense_pub_ligne') + '</th><th>' + ML('leads_et_reoptins') + '</th><th>' + ML('cpl_source') + '</th><th>LQS moyen' + IL('lqs') + '</th><th>% ' + ML('lqs_45') + '</th><th>' + ML('cout_lead_45') + '</th><th class="l" style="min-width:110px">Répartition</th>'
      + '<th>' + ML('leads_avec_rdv') + '</th><th>' + ML('leads_presents') + '</th><th>' + MG('closes_cohorte') + '</th><th class="lq-oe">Élite' + IN('Élite', 'Closes des leads entrés à l\'offre Élite et leur contracté.') + '</th><th class="lq-ob">Business' + IN('Business', 'Closes des leads entrés à l\'offre Business Phénix et leur contracté.') + '</th><th>' + ML('contracte_cohorte') + ' · collecté</th><th>' + MG('contracte_sur_depense') + '</th></tr></thead><tbody>';
    ax.rows.forEach(function (x) {
      var a = x.agg;
      body += '<tr' + (x.outOfAds ? ' class="lq-dim"' : '') + '><td class="l"><span class="lq-src" title="' + esc(x.label) + '">' + esc(x.label) + '</span>' + (x.legacy ? ' <span class="fn-tbadge lq-toff" title="Attribution reconstruite depuis l\'ancien champ utm">⚠</span>' : '') + '</td>'
        + '<td>' + mqsBadge(x.m) + '</td><td>' + (!S.closer && x.hasSpend ? fEur(x.spend) : '—') + '</td><td>' + fNum(a.leads) + '</td><td>' + (costsOk ? fEur(x.cpl) : '—') + '</td>'
        + '<td>' + avgBadge(a.avgNote) + '</td><td>' + fPct(a.pct45) + '</td><td>' + (costsOk ? fEur(x.cpl45) : '—') + '</td><td class="l">' + distBar(a.dist) + '</td>'
        + '<td>' + fNum(a.leadsAvecRdv) + '</td><td>' + fNum(a.leadsPresents) + '</td><td>' + fNum(a.closes) + (a.closesU ? sub(fNum(a.closesU) + ' sans offre') : '') + '</td>'
        + '<td>' + (a.closesE ? '<span class="lq-oe">' + fNum(a.closesE) + '</span>' + sub(fEur(a.conE)) : '—') + '</td>'
        + '<td>' + (a.closesB ? '<span class="lq-ob">' + fNum(a.closesB) + '</span>' + sub(fEur(a.conB)) : '—') + '</td>'
        + '<td>' + money(a.con, a.cash) + '</td><td>' + (costsOk ? fRoas(x.conPerSpend != null ? x.conPerSpend : x.roas) : '—') + '</td></tr>';
    });
    var horsPub = t.leads - tp.leads;
    var depTot = S.closer ? '—' : (ax.spend ? fEur(ax.spend) + sub('dont ' + fEur(ax.spendRattachee) + ' rattachés à une ligne' + (ax.spendNonRattachee > 0.5 ? ' · ' + fEur(ax.spendNonRattachee) + ' non rattachés (pub sans lead)' : ''))
      + (K && K.spend != null ? sub('dépense du compte (onglet Funnel) : ' + fEur(K.spend)) : '') : '—');
    body += '<tr class="tot"><td class="l">Total</td><td></td><td>' + depTot + '</td><td>' + fNum(t.leads) + '</td>'
      + '<td>' + (costsOk && ax.cplPub != null ? fEur(ax.cplPub) + sub('leads venus de la pub' + (horsPub > 0 ? ' · ' + fEur(t.leads ? ax.spend / t.leads : null) + ' en comptant les ' + fNum(horsPub) + ' leads hors pub' : '')) : '—') + '</td>'
      + '<td>' + avgBadge(t.avgNote) + '</td><td>' + fPct(t.pct45) + '</td><td>' + (costsOk && tp.n45 ? fEur(ax.spend / tp.n45) : '—') + '</td><td class="l">' + distBar(t.dist) + '</td><td>' + fNum(t.leadsAvecRdv) + '</td><td>' + fNum(t.leadsPresents) + '</td><td>' + fNum(t.closes) + (t.closesU ? sub(fNum(t.closesU) + ' sans offre') : '') + '</td><td>' + (t.closesE ? fNum(t.closesE) + sub(fEur(t.conE)) : '—') + '</td><td>' + (t.closesB ? fNum(t.closesB) + sub(fEur(t.conB)) : '—') + '</td><td>' + money(t.con, t.cash) + '</td>'
      + '<td>' + (costsOk ? fRoas(ax.conPerSpend) + sub('lignes pub seulement') : '—') + '</td></tr>';
    body += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">Leads entrés pendant la période (ré-optins compris) · dépense = données Meta par pub (ads_insights_ad) quand Make les envoie, sinon « — » ; le total reprend toute la dépense reçue, rattachée ou non à une ligne · contracté = contrats HT des closes des leads entrés de la ligne, collecté = prélèvements passés à ce jour · Contracté ÷ dépense, CPL et coût / lead LQS 4-5 du total : lignes venues de la pub seulement · les lignes « hors pub » sont en bas.</div>';
    h += card('📣 Qualité par ' + AXES.filter(function (a) { return a[0] === S.axis; })[0][1].toLowerCase(), S.closer ? 'leads de ' + esc(S.M.memberName(S.closer)) : '', body);
    return h;
  }

  /* ══ VUE 4 — CLOSERS ═══════════════════════════════════════════════════
     Par RDV (audit 25/11/2026) : RDV de vente DATÉS dans la plage, comptés
     par StatsCore (RDV = annulés + no-show + présents + à statuer + à
     venir ; Show-up = présents ÷ (Kept − à venir)). Closes / Contracté /
     Collecté = liste unique des closes de la plage, rangés chez le closer
     du close (comme Global closing), un client = un close. Lignes « Non
     attribué » et « Anciens membres » : la somme des lignes = « Toute
     l'équipe ». */
  function closerHead() {
    return '<th>' + MG('rdv', 'Ici : RDV de vente datés dans la plage, Self Booking, Setting et manuels.') + '</th>'
      + '<th>% ' + ML('lqs_45', 'Ici : RDV dont le lead est noté LQS 4 ou 5 ÷ RDV dont le lead est noté.') + '</th><th>' + ML('qualite_pipe') + '</th><th class="l" style="min-width:110px">Répartition</th>'
      + '<th>' + MG('presents') + '</th>'
      + '<th>' + MG('closes', 'Ici : clients gagnés pendant la plage (même liste que le Stats funnel), rangés chez le closer qui a conclu la vente.') + '</th>'
      + '<th>' + MG('taux_close_presents') + '</th><th>' + MG('taux_close_rdv') + '</th>'
      + '<th>' + MG('contracte') + ' · collecté</th>';
  }
  function showUpSub(a) { return sub('show-up ' + fPct(a.showUp != null ? a.showUp : a.showRate)); }
  /* Détail de la ligne « Non attribué » (note sous le tableau) : pourquoi
     chaque RDV / close y est rangé. */
  function naDetail(a) {
    if (!a || !a.precisions || !a.precisions.length) return '';
    return '<div class="fn-stage-note" style="margin-top:8px">« Non attribué », détail : ' + a.precisions.map(function (p) {
      var parts = [];
      if (p.rdv) parts.push(fNum(p.rdv) + ' RDV');
      if (p.closes) parts.push(fNum(p.closes) + ' close' + (p.closes > 1 ? 's' : '') + ' (' + fEur(p.con) + ' contracté)');
      return esc(p.precision) + ' : ' + parts.join(', ');
    }).join(' · ') + '.</div>';
  }
  function viewClosers() {
    var cr = closerRange();
    var h = '<div class="fn-seg" style="margin-bottom:14px;width:fit-content">'
      + '<button data-lq-cr="period" class="' + (S.crMode === 'period' ? 'active' : '') + '">Période sélectionnée</button>'
      + '<button data-lq-cr="3m" class="' + (S.crMode === '3m' ? 'active' : '') + '">3 derniers mois</button>'
      + '<button data-lq-cr="6m" class="' + (S.crMode === '6m' ? 'active' : '') + '">6 derniers mois</button></div>'
      + (S.crMode !== 'period' ? '<span class="lq-muted" style="margin-left:10px">la plage ne change que ce tableau' + IL('plage_closers') + '</span>' : '');
    var board = LC.closerBoard(S.M.rdvRows, S.M.memberName);
    var team = LC.byCloser(S.M.rdvRows, '');
    var body = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Closer' + I('closer') + '</th>' + closerHead() + '</tr></thead><tbody>';
    board.forEach(function (a) {
      /* Ligne nominative seulement pour un closer qui a un onglet (D10) ;
         tout le reste est dans « Non attribué », détaillé dessous. */
      if (a.slug && S.M.aOngletCloser && !S.M.aOngletCloser(a.slug)) return;
      var sel = a.slug && a.slug === S.closer;
      var nm = a.nonAttribue
        ? MG('non_attribue', 'Ici : closer inconnu, « Anciens membres », « Prénom (hors onglets) » (admin ou autre rôle que closer) ou « Prénom (avant son arrivée) » — comme Global closing.')
        : '<strong>' + esc(a.name) + '</strong>';
      body += '<tr class="' + (a.slug ? 'lq-click' : '') + (sel ? ' lq-sel' : '') + '"' + (a.slug ? ' data-lq-pick="' + esc(a.slug) + '"' : '') + '><td class="l">' + nm + '</td><td>' + fNum(a.rdv) + '</td><td>' + fPct(a.pct45) + '</td><td>' + avgBadge(a.avgNote) + '</td><td class="l">' + distBar(a.dist) + '</td>'
        + '<td>' + fNum(a.presents) + showUpSub(a) + '</td><td><strong>' + fNum(a.closes) + '</strong></td><td>' + fPct(a.tauxClosePresents) + '</td><td>' + fPct(a.tauxCloseRdv) + '</td><td>' + money(a.con, a.cash) + '</td></tr>';
    });
    var naRow = board.filter(function (a) { return a.nonAttribue; })[0];
    var tt = team.total;
    body += '<tr class="tot"><td class="l">Toute l\'équipe' + I('equipe') + '</td><td>' + fNum(tt.rdv) + '</td><td>' + fPct(tt.pct45) + '</td><td>' + avgBadge(tt.avgNote) + '</td><td class="l">' + distBar(tt.dist) + '</td><td>' + fNum(tt.presents) + showUpSub(tt) + '</td><td>' + fNum(tt.closes) + '</td><td>' + fPct(tt.tauxClosePresents) + '</td><td>' + fPct(tt.tauxCloseRdv) + '</td><td>' + money(tt.con, tt.cash) + '</td></tr>';
    body += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">RDV de vente datés dans la plage (Self Booking, Setting et RDV créés à la main dans l\'Agenda ; un RDV déplacé compte une fois, à sa nouvelle date ; un doublon supprimé nulle part) · closer d\'un RDV = celui qui a validé le close, sinon l\'hôte du RDV · Closes = clients gagnés pendant la plage, même liste que le Stats funnel, rangés chez le closer du close et comptés une fois · une ligne par closer de l\'équipe sales (comme Global closing) ; un RDV est rangé au jour du RDV, un close au jour du close · « Non attribué » = closer inconnu, membres partis (« Anciens membres », sans nom), personne sans onglet (« Prénom (hors onglets) ») ou élément daté avant son arrivée (« Prénom (avant son arrivée) ») · les lignes s\'additionnent pour donner « Toute l\'équipe » · les corrections manuelles ✎ de Set NB / Close SB ne sont pas reprises · clique un closer pour son détail.</div>' + naDetail(naRow);
    h += card('🎯 Closers — qualité reçue et résultats', fMonth(FC.isoDate(cr.start).slice(0, 7)) + ' → ' + fMonth(FC.isoDate(cr.end).slice(0, 7)), body);

    if (!S.closer) {
      h += card('📅 Toute l\'équipe, mois par mois', '', monthsTable(team, null) + '<div class="fn-stage-note" style="margin-top:8px">Choisis un closer (en haut ou dans le tableau) pour sa lecture détaillée.</div>');
      return h;
    }
    var me = LC.byCloser(S.M.rdvRows, S.closer);
    var name = S.M.memberName(S.closer);
    h += card('📅 ' + esc(name) + ', mois par mois', '', monthsTable(me, team));
    /* Close par note : le closer vs l'équipe */
    var nb = '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Note du lead' + IL('lqs') + '</th><th>' + MG('rdv') + '</th><th>' + MG('presents') + '</th><th>' + MG('closes', 'Ici : closes de ' + name + ' sur la plage, rangés selon la note du lead.') + '</th><th>' + MG('taux_close_presents') + '</th><th>Équipe : close / présents</th><th>' + MG('contracte') + ' · collecté</th></tr></thead><tbody>';
    LC.NOTE_KEYS.forEach(function (k) {
      var a = me.byNote[k], tb = team.byNote[k];
      if (!a.rdv && !a.closes) return;
      var diff = ok(a.tauxClosePresents) && ok(tb.tauxClosePresents) ? a.tauxClosePresents - tb.tauxClosePresents : null;
      nb += '<tr><td class="l">' + noteBadge(k || null) + ' <span class="lq-nl">' + NOTE_LBL[k] + '</span></td><td>' + fNum(a.rdv) + '</td><td>' + fNum(a.presents) + '</td><td><strong>' + fNum(a.closes) + '</strong></td>'
        + '<td>' + fPct(a.tauxClosePresents) + (diff != null ? sub('<span class="' + (diff >= 0 ? 'lq-up' : 'lq-down') + '">' + (diff >= 0 ? '+' : '') + fDec(diff, 1) + ' pts vs équipe</span>') : '') + '</td>'
        + '<td>' + fPct(tb.tauxClosePresents) + '</td><td>' + money(a.con, a.cash) + '</td></tr>';
    });
    nb += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">Un close est daté du jour où le client est gagné, un RDV du jour où il a lieu : sur une note ou un mois peu fournis, le taux peut ne pas avoir de sens (affiché —).</div>';
    h += card('⭐ ' + esc(name) + ' — close selon la qualité du lead', 'à qualité égale, le closer fait-il mieux ou moins bien que l\'équipe ?', nb);
    return h;
  }

  function monthsTable(me, team) {
    if (!me.months.length) return '<div class="lq-muted">Aucun RDV ni close sur la plage.</div>';
    var teamBy = {};
    if (team) team.months.forEach(function (m) { teamBy[m.month] = m; });
    var h = '<ul class="lq-ins" style="margin-bottom:12px">';
    me.months.forEach(function (m) {
      h += '<li><strong>' + cap(fMonth(m.month)) + '</strong> : ' + fNum(m.rdv) + ' RDV, <strong>' + fPct(m.pct45) + '</strong> de LQS 4-5, qualité du pipe <strong>' + fDec(m.avgNote, 2) + '</strong>, '
        + fNum(m.presents) + ' présent' + (m.presents > 1 ? 's' : '') + ' (show-up ' + fPct(m.showUp) + '), '
        + fNum(m.closes) + ' close' + (m.closes > 1 ? 's' : '') + ' → close / présents <strong>' + fPct(m.tauxClosePresents) + '</strong>'
        + (team && teamBy[m.month] ? ' <span class="lq-muted">(équipe : ' + fPct(teamBy[m.month].pct45) + ' de LQS 4-5, close / présents ' + fPct(teamBy[m.month].tauxClosePresents) + ')</span>' : '') + '.</li>';
    });
    h += '</ul>';
    h += '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Mois</th><th>' + MG('rdv') + '</th><th>' + MG('annules') + '</th><th>' + MG('no_show') + '</th><th>' + MG('presents') + '</th><th>' + MG('a_statuer') + '</th><th>' + MG('a_venir') + '</th>'
      + '<th>% ' + ML('lqs_45') + '</th><th>' + ML('qualite_pipe') + '</th><th class="l" style="min-width:110px">Répartition</th><th>' + MG('closes') + '</th><th>' + MG('taux_close_presents') + '</th><th>' + MG('taux_close_rdv') + '</th><th>' + MG('contracte') + ' · collecté</th>' + (team ? '<th>Équipe : LQS 4-5 / close / présents</th>' : '') + '</tr></thead><tbody>';
    me.months.forEach(function (m) {
      var tm = teamBy[m.month];
      h += '<tr><td class="l"><strong>' + cap(fMonth(m.month)) + '</strong></td><td>' + fNum(m.rdv) + '</td><td>' + fNum(m.annules) + '</td><td>' + fNum(m.noshow) + '</td><td>' + fNum(m.presents) + showUpSub(m) + '</td><td>' + fNum(m.aStatuer) + '</td><td>' + fNum(m.aVenir) + '</td>'
        + '<td>' + fPct(m.pct45) + '</td><td>' + avgBadge(m.avgNote) + '</td><td class="l">' + distBar(m.dist) + '</td><td><strong>' + fNum(m.closes) + '</strong></td><td>' + fPct(m.tauxClosePresents) + '</td><td>' + fPct(m.tauxCloseRdv) + '</td><td>' + money(m.con, m.cash) + '</td>'
        + (team ? '<td>' + (tm ? fPct(tm.pct45) + ' / ' + fPct(tm.tauxClosePresents) : '—') + '</td>' : '') + '</tr>';
    });
    h += '</tbody></table></div><div class="fn-stage-note" style="margin-top:8px">RDV = annulés + no-show + présents + à statuer + à venir. Les closes sont rangés au mois où le client est gagné.</div>';
    return h;
  }

  /* ══ VUE 5 — LEADS NOTÉS ═══════════════════════════════════════════════ */
  /* État du RDV retenu d'un lead (r.rdvEtat / r.rdvDetail, StatsCore) :
     mot du référentiel (Présent → son détail : Offre en attente, Non close,
     Disqualifié, Présent (sans détail) ; À statuer ; À venir ; No-show ;
     Annulé). null = pas de RDV. */
  var ETAT_CLS = { present: 'lq-tq', a_venir: 'lq-tf', a_statuer: 'lq-warn', no_show: 'lq-warn', annule: 'lq-toff', replanifie: 'lq-tf', doublon: 'lq-toff' };
  function rdvLibelle(r) {
    if (!r || !r.avecRdv || !r.rdvEtat) return null;
    var mot;
    if (r.rdvEtat === 'present') mot = (SC && SC.DETAILS && SC.DETAILS[r.rdvDetail || 'sans_detail'] ? SC.DETAILS[r.rdvDetail || 'sans_detail'].mot : 'Présent');
    else mot = SC && SC.ETATS && SC.ETATS[r.rdvEtat] ? SC.ETATS[r.rdvEtat].mot : r.rdvEtat;
    if (r.rdvEtat === 'present' && r.rdvDetail === 'close') mot = 'RDV au résultat Close';
    return { mot: mot, cls: ETAT_CLS[r.rdvEtat] || 'lq-tf' };
  }
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
    h += '</div><div class="fn-lt-search"><input type="text" data-lq-search placeholder="Nom, email, source, closer…" value="' + esc(S.leadsQ) + '"></div>'
      + (window.LqsDossier ? '<button class="fn-btn" data-lq-drill="leads" data-lq-dn="' + (S.leadsNote === 'all' ? 'all' : S.leadsNote) + '">📂 Dossiers complets (questionnaires + visios) · PDF</button>' : '') + '</div>';
    var shown = S.exporting ? list : list.slice(0, S.leadsLimit);
    h += '<div class="fn-table-wrap"><table class="fn-igt lq-t"><thead><tr><th class="l">Lead</th><th>Entrée</th><th class="l">Source</th><th>LQS</th><th>Points</th><th>' + ML('note_equipe') + '</th><th class="l">Parcours' + IN('Parcours', 'Issue du lead : close (closes des leads entrés), sinon état de son RDV retenu (le RDV closé, sinon le dernier présent, sinon le premier), lu sur le dernier RDV de la chaîne de report.') + '</th><th class="l">Closer' + I('closer') + '</th><th>' + ML('contracte_cohorte') + ' · collecté</th></tr></thead><tbody>';
    shown.forEach(function (r) {
      var l = r.lead, open = !!S.openLead[r.id];
      var path = [];
      if (r.closed) path.push('<span class="fn-tbadge lq-good">💰 Close</span>' + (r.closeSansRdv ? ' <span class="fn-tbadge lq-tf" title="' + esc(LOCAL.close_sans_rdv_enregistre[1]) + '">sans RDV enregistré</span>' : ''));
      else if (r.closeCancelled) path.push('<span class="fn-tbadge lq-warn">close annulé</span>');
      if (!r.closed) {
        var st = rdvLibelle(r);
        if (st) path.push('<span class="fn-tbadge ' + st.cls + '">' + esc(st.mot) + '</span>');
        else if (!r.closeCancelled) path.push('<span class="lq-muted">pas de RDV</span>');
      }
      if (r.dejaClient) path.push('<span class="fn-tbadge lq-toff" title="' + esc(LOCAL.deja_client[1]) + '">déjà client</span>');
      if (r.reopt) path.push('<span class="fn-reopt" title="Ré-optin dans la période">↻</span>');
      h += '<tr class="lq-click" data-lq-lead="' + esc(r.id) + '"><td class="l"><a class="fn-lead-link" href="sales-contact.html?id=' + encodeURIComponent(r.id) + '" target="_blank" rel="noopener">' + esc(l.nom || l.email || '—') + '</a></td>'
        + '<td>' + fDay(r.entry) + '</td><td class="l"><span class="lq-src" title="' + esc(r.axes.creative ? r.axes.creative.label : '') + '">' + esc(r.axes.creative ? r.axes.creative.label : r.sourceLabel) + '</span></td>'
        + '<td>' + noteBadge(r.note) + '</td><td>' + (r.pts != null ? fPts(r.pts) : '—') + '</td><td>' + (r.team != null ? '★ ' + r.team : '—') + '</td>'
        + '<td class="l">' + path.join(' ') + '</td><td class="l">' + esc(nomDe(r.closer) || '—') + '</td><td>' + (r.closed ? money(r.con, r.cash) : '—') + '</td></tr>';
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
    return card('👥 Leads + ré-optins de la période, notés', fNum(list.length) + ' leads', h);
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
  /* Partie « vivante » du barème (répartition + boutons) : mise à jour seule
     quand on change un point, pour ne pas recharger tout l'onglet — sinon
     chaque clic sur une flèche faisait perdre la position et le champ. */
  function gridLive() {
    var dist = [0, 0, 0, 0, 0, 0];
    S.M.rows.forEach(function (r) { dist[r.note == null ? 0 : r.note]++; });
    var st = '<div class="lq-preview">' + distBar(dist) + '<div class="lq-preview-l">';
    [5, 4, 3, 2, 1, 0].forEach(function (k) { st += '<span>' + noteBadge(k || null) + ' ' + fNum(dist[k]) + '</span>'; });
    st += '</div></div>';
    st += '<div class="lq-actions"><button class="fn-btn" data-lq-sugg-all>✨ Appliquer toutes les suggestions</button>'
      + '<button class="fn-btn" data-lq-reset' + (S.draft ? '' : ' disabled') + '>↺ Annuler les modifications</button>'
      + '<button class="fn-btn primary" data-lq-save' + (S.draft && !S.saving ? '' : ' disabled') + '>' + (S.saving ? 'Enregistrement…' : '💾 Enregistrer le barème') + '</button>'
      + '<span class="lq-muted">' + (S.draft ? '✏️ Modifications non enregistrées' : (S.grid && S.grid.updatedBy ? 'Dernier enregistrement : ' + esc(S.grid.updatedBy) : 'Barème jamais enregistré : points par défaut')) + '</span></div>';
    return st;
  }
  function refreshGridLive() {
    var el = S.mount && S.mount.querySelector('[data-lq-gridlive]');
    if (el) el.innerHTML = gridLive(); else render();
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
      + '<p><strong>Suggestion</strong> : ce que les résultats réels proposent — contracté des leads entrés par lead de la réponse, comparé à la moyenne, seulement si la période compte au moins 8 closes des leads entrés (sinon aucune suggestion calculée : seule la recommandation d\'audit ★ s\'affiche), dès ' + LC.SUGGEST_MIN + ' leads par réponse. C\'est une aide, pas une vérité : sur une période courte, élargis-la (3 à 6 mois) avant d\'appliquer.</p>'
      + '<p>Modifier un point recalcule <strong>immédiatement</strong> tous les onglets (aperçu). Rien n\'est enregistré tant que tu n\'as pas cliqué « Enregistrer ». Le barème s\'applique à tout l\'historique : aucune donnée n\'est réécrite sur les leads.</p>');

    var st = '<div class="lq-th">';
    [['n5', 5], ['n4', 4], ['n3', 3], ['n2', 2]].forEach(function (x) {
      st += '<label>' + noteBadge(x[1]) + ' si total ≥ <input type="number" step="0.5" data-lq-th="' + x[0] + '" value="' + esc(th[x[0]]) + '"> pts</label>';
    });
    st += '<label>' + noteBadge(1) + ' sinon</label>'
      + '<button class="fn-btn" data-lq-calib title="Recalcule les 4 seuils d\'après les points en cours : 15 % de 5, 25 % de 4, 30 % de 3, 20 % de 2, 10 % de 1">🎯 Recalculer les seuils sur ces points</button></div>';
    st += '<div data-lq-gridlive>' + gridLive() + '</div>';
    st += '<div class="fn-stage-note" style="margin-top:8px">Colonne « Suggestion » : <strong>recommandation de l\'audit du 13/11/2026</strong> (tout l\'historique : 362 leads, 54 présents, 7 closes, et les freins entendus en visio) quand elle existe ; sinon le calcul sur la période affichée, seulement s\'il y a au moins 8 closes.</div>';
    h += card('🎚️ Seuils et répartition (aperçu en direct)', 'leads de la période, toute l\'équipe', st);

    var body = '';
    if (!ba.questions.length) body = '<div class="lq-muted">Aucune réponse sur les leads de la période : élargis la période pour voir les questions à noter.</div>';
    ba.questions.forEach(function (q) {
      var open = S.exporting || S.openQ['g_' + q.q] !== false;
      body += '<div class="lq-qcard' + (q.off ? ' off' : '') + '"><div class="lq-qhead" data-lq-q="g_' + esc(q.q) + '"><span class="lq-caret">' + (open ? '▾' : '▸') + '</span><span class="lq-qt">' + esc(q.label) + '</span>'
        + '<span class="fn-tbadge ' + (q.origin === 'quiz' ? 'lq-tq' : 'lq-tf') + '">' + (q.origin === 'quiz' ? 'Quiz' : 'Formulaire') + '</span>'
        + '<label class="lq-off" data-lq-stop><input type="checkbox" data-lq-qoff="' + esc(q.q) + '" data-lq-ql="' + esc(q.label) + '"' + (q.off ? '' : ' checked') + '> compter cette question</label>'
        + '<span class="lq-qmeta">' + fNum(q.agg.leads) + ' leads</span></div>';
      if (open && !q.off) {
        var list = q.answerList.slice(0, 40);
        body += '<div class="fn-table-wrap" style="margin-top:8px"><table class="fn-igt lq-t"><thead><tr><th class="l">Réponse</th><th>' + ML('leads_et_reoptins') + '</th><th>' + ML('taux_close_lead') + '</th><th>' + ML('contracte_par_lead') + '</th><th>Suggestion' + IN('Suggestion', 'Recommandation de l\'audit du 13/11/2026 (★, tout l\'historique) quand elle existe ; sinon calcul sur la période (contracté / lead de la réponse comparé à la moyenne), seulement s\'il y a au moins 8 closes des leads entrés. Cliquer pour appliquer.') + '</th><th>Points</th><th title="Note 1 d\'office">⛔ Éliminatoire</th></tr></thead><tbody>';
        list.forEach(function (x) {
          var id = esc(q.q) + '" data-lq-a="' + esc(x.a) + '" data-lq-ql="' + esc(q.label) + '" data-lq-al="' + esc(x.label);
          body += '<tr><td class="l">' + esc(x.label) + (x.known ? '' : ' <span class="fn-tbadge lq-tf" title="Réponse jamais revue : points par défaut">nouveau</span>') + '</td>'
            + '<td>' + fNum(x.agg.leads) + '</td><td>' + fPct(x.agg.closeLead, 1) + '</td><td>' + fEur(x.agg.conPerLead) + '</td>'
            + '<td>' + (x.suggest == null ? '<span class="lq-muted" title="Pas de recommandation pour cette réponse">—</span>' : '<button class="fn-ig-detbtn" data-lq-sugg="' + id + '" data-lq-v="' + x.suggest + '" title="' + (x.suggestSrc === 'audit' ? 'Recommandation de l\'audit (tout l\'historique) — cliquer pour appliquer' : 'Calcul sur la période — cliquer pour appliquer') + '">' + fPts(x.suggest) + (x.suggestSrc === 'audit' ? ' ★' : '') + '</button>') + '</td>'
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
    /* Lecteur funnel (19/11/2026) : il peut SIMULER un barème, jamais
       l'enregistrer (bouton masqué, règle Firestore admin seule). */
    if (window.FUNNEL_READONLY === true) { toast('Accès en lecture seule : barème non enregistré', true); return; }
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

  /* ══ EXPORT PDF COMPLET (13/11/2026) ═══════════════════════════════════
     Tous les onglets tels qu'affichés (tout déplié, toutes les lignes) pour
     la période et les filtres en cours, puis le dossier nominatif de CHAQUE
     lead de la période : questionnaire, note, issue, transcription de la
     visio de closing. Impression du navigateur → « Enregistrer en PDF ». */
  function section(title, html) { return '<section class="lqp-sec"><h1 class="lqp-h1">' + title + '</h1>' + html + '</section>'; }
  function exportAll() {
    if (!S.M || S.exportBusy || !window.LqsDossier) return;
    var LD = window.LqsDossier;
    var R = LD.sortRows(rows());
    S.exportBusy = 'Préparation…'; render();
    LD.loadTranscripts(R, function (d, n) {
      S.exportBusy = n ? 'Transcriptions ' + d + ' / ' + n + '…' : 'Préparation…';
      var b = S.mount.querySelector('[data-lq-export]');
      if (b) b.textContent = S.exportBusy;
    }).then(function (nTr) {
      var keep = { view: S.view, axis: S.axis, closer: S.closer, compare: S.quizCompare };
      var html = '';
      S.exporting = true;
      try {
        html += LD.coverHtml('Qualité des leads — export complet', [
          'Période : ' + (S.ctx.periodLabel || '—') + (S.closer ? ' · leads de ' + S.M.memberName(S.closer) : ' · toute l\'équipe')
            + (S.ctx.tunnelFilter && S.ctx.tunnelFilter !== 'all' ? ' · tunnel ' + S.ctx.tunnelFilter : ''),
          R.length + ' leads · ' + nTr + ' transcription' + (nTr > 1 ? 's' : '') + ' de visio · exporté le ' + new Date().toLocaleDateString('fr-FR'),
          'Contenu : vue d\'ensemble, quiz & réponses, marketing (campagne, adset, créa, canal), closers, barème, liste des leads notés, puis un dossier par lead (questionnaire, note, issue, transcription).'
        ]);
        html += section('🧭 Vue d\'ensemble', viewOverview());
        S.quizCompare = false;
        html += section('📋 Quiz & réponses', viewQuiz());
        AXES.forEach(function (a) { S.axis = a[0]; html += section('📣 Marketing (MQS) — par ' + a[1].toLowerCase(), viewMarketing()); });
        S.axis = keep.axis;
        html += section('🎯 Closers', viewClosers());
        if (!keep.closer) S.M.closers.forEach(function (c) { S.closer = c.slug; html += section('🎯 Closer — ' + esc(c.name), viewClosers()); });
        S.closer = keep.closer;
        html += section('⚙️ Barème', viewGrid());
        html += section('👥 Leads notés', viewLeads());
        html += '<section class="lqp-sec"><h1 class="lqp-h1">📂 Dossiers par prospect (' + R.length + ')</h1>' + LD.dossiersHtml(R) + '</section>';
      } catch (err) {
        if (window.console) console.error('[lqs] export', err);
        toast('Export impossible : ' + (err && err.message ? err.message : 'erreur'), true);
        html = '';
      }
      S.exporting = false; S.view = keep.view; S.axis = keep.axis; S.closer = keep.closer; S.quizCompare = keep.compare;
      S.exportBusy = ''; render();
      if (html) LD.print('Qualité des leads — ' + (S.ctx.periodLabel || ''), html);
    });
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
      if (closest(t, '[data-lq-latest]')) { S.quizLatest = !S.quizLatest; render(); return; }
      if ((el = closest(t, '[data-lq-drill]'))) { e.preventDefault(); openDrill(el.getAttribute('data-lq-dn'), el.getAttribute('data-lq-drill')); return; }
      if (closest(t, '[data-lq-export]')) { exportAll(); return; }
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
        var tr = closest(el, 'tr'), inp = tr ? tr.querySelector('[data-lq-pts]') : null;
        if (inp) { inp.value = a.pts; inp.classList.remove('def'); }
        S.stamp++; rebuild(); refreshGridLive(); return;
      }
      if (closest(t, '[data-lq-sugg-all]')) { applyAllSuggestions(); return; }
      if (closest(t, '[data-lq-calib]')) {
        var th2 = LC.calibrateThresholds(S.M.rows);
        if (!th2) { toast('Pas assez de leads notés sur la période pour recalculer (10 minimum)', true); return; }
        ensureDraft().thresholds = th2;
        S.stamp++; rebuild(); render();
        toast('Seuils recalculés : 5 dès ' + th2.n5 + ' · 4 dès ' + th2.n4 + ' · 3 dès ' + th2.n3 + ' · 2 dès ' + th2.n2 + ' — vérifie puis enregistre');
        return;
      }
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
        t.classList.remove('def');
        S.stamp++; rebuild(); refreshGridLive(); return;
      }
      if (t.hasAttribute('data-lq-ko')) {
        var a2 = draftAnswer(t.getAttribute('data-lq-ko'), t.getAttribute('data-lq-ql'), t.getAttribute('data-lq-a'), t.getAttribute('data-lq-al'));
        a2.ko = !!t.checked;
        S.stamp++; rebuild(); refreshGridLive(); return;
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
        S.stamp++; rebuild(); refreshGridLive(); return;
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
