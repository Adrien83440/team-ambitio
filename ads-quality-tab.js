/* ============================================================================
   ads-quality-tab.js — « 🎯 QUALITÉ PAR PUB » (12/11/2026, brief « Outil 2 »)
   ----------------------------------------------------------------------------
   Rendu PARTAGÉ, aucune dépendance Firebase dans la partie tableau :
     · sales-funnel.html (admin) — données = K.utmRowsByAxis de funnel-core.js,
       plus deux encarts admin : lien de partage média buyeuse et
       « 📡 Événements renvoyés à Meta » (API Conversions) ;
     · ads-quality.html (média buyeuse, lecture seule) — données =
       api/ads-quality-share.js (mêmes lignes, liste blanche de champs).
   Les chiffres viennent TOUS de funnel-core.js (source unique) : ce fichier
   ne calcule que des sommes de colonnes et des pourcentages d'affichage.

   Colonnes (une ligne par pub, bascule ensemble / campagne) — vocabulaire
   unique du référentiel (25/11/2026, décision D16 : « Honorés » → « Pitchés »,
   « Ventes » → « Closes », « RDV posés » → « RDV pris » ; aucun chiffre ne
   bouge) :
     ★ € / lead CA ≥ 20 k€ · ★ € / RDV pitché · ★ € / close (en tête, juste
     après le nom) · dépense par pub · leads · CPL · CA ≥ 20 k€ (CA déclaré au
     quiz, % sur les leads qui ont déclaré un CA) · faux numéros · fiches
     disqualifiées (des FICHES, pas des RDV) · jamais joints (% sur les leads
     entrés depuis > 48 h) · RDV pris · pitchés · annulés · no-show · closes ·
     contracté · collecté. Chaque en-tête porte son « i » (StatsCore.info :
     glossaire commun ; infoLibre pour les termes propres à cet écran).
   Champs : `pitched` (repli `honored`, ancien nom gardé par funnel-core.js et
   par la route tant que d'anciens onglets ouverts le lisent). L'événement
   Meta garde son nom technique « RdvHonore » (D17 : on n'y touche pas).
   Tri par défaut : coût par RDV pitché, croissant (les « — » en bas). Pubs
   à moins de 10 leads : repère ⚠ (échantillon trop faible pour conclure).
   Les coûts sont masqués dès qu'un jour de dépense par pub manque (jours
   attendus jusqu'à HIER : même règle que le Stats funnel, k.adSpendOk) — un
   coût trop beau fait monter un budget. La ligne Total porte la dépense pub
   du COMPTE (k.spend, même chiffre que le funnel) et son CPL pub (k.cplAds).

   API :
     AdsQualityTab.render(el, data, opts)
       data = { rowsByAxis: { creative, adset, campaign, device, region },
                coverage: {…}, unattrByAxis: {…},
                lecture: { erreurs: [phrases], partiel: {…} }, periodLabel }
       opts = { admin: bool, readonly: bool, adminCtx: { db, user, toast } }
     AdsQualityTab.fromKpis(K, periodLabel) → data   (onglet du funnel)
     AdsQualityTab.fromShare(j, periodLabel) → data  (réponse de la route)
   ES5 strict (Safari ancien). Délégation d'événements, aucun onclick inline.
   ============================================================================ */
(function (root) {
  'use strict';

  var AXES = [
    { id: 'creative', label: 'Pub', name: 'Pub' },
    { id: 'adset', label: 'Ensemble', name: 'Ensemble de pubs' },
    { id: 'campaign', label: 'Campagne', name: 'Campagne' },
    /* Lieu et appareil du prospect (23/11/2026) : mêmes colonnes, sans les
       coûts — Meta ne transmet pas la dépense par appareil ni par région. */
    { id: 'device', label: 'Appareil', name: 'Appareil' },
    { id: 'region', label: 'Région', name: 'Région' }
  ];
  function isVis() { return state.axis === 'device' || state.axis === 'region'; }
  var SMALL = 10;

  var state = { axis: 'creative', sort: 'cph', dir: 1, showOut: false };

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  /* Formats communs (stats-core.js) : euros entiers, taux à une décimale.
     Repli local si le module n'est pas chargé. */
  function SC() { return root.StatsCore || null; }
  function eur(v, dec) {
    if (v == null || !isFinite(v)) return '—';
    var d = dec == null ? 0 : dec;
    if (!d && SC() && SC().fmtEuro) return SC().fmtEuro(v);
    try { return Number(v).toLocaleString('fr-FR', { minimumFractionDigits: d, maximumFractionDigits: d }).replace(/ /g, ' ') + ' €'; }
    catch (e) { return Math.round(v) + ' €'; }
  }
  function pct(n, base) {
    if (!(base > 0)) return '—';
    var v = n / base * 100;
    if (SC() && SC().fmtPct) return SC().fmtPct(v);
    return v.toFixed(1).replace('.', ',') + ' %';
  }
  function nPct(n, base) {
    if (!n) return '<span class="aq-z">0</span>';
    return '<b>' + n + '</b> <span class="aq-p">' + pct(n, base) + '</span>';
  }
  /* Le « i » : terme du glossaire commun (info), sinon note propre à cet
     écran (infoLibre). Chaîne vide si stats-core.js manque. */
  function I(cle, precision) { return SC() && SC().info ? SC().info(cle, precision) : ''; }
  function IL(titre, texte) { return SC() && SC().infoLibre ? SC().infoLibre(titre, texte) : ''; }
  /* RDV pitchés de la ligne : `pitched`, repli sur l'ancien nom `honored`
     (réponse d'une route pas encore redéployée, onglet resté ouvert). */
  function pit(r) {
    if (!r) return 0;
    if (r.pitched != null) return Number(r.pitched) || 0;
    return Number(r.honored) || 0;
  }
  function zero(n) { return n ? n : '<span class="aq-z">0</span>'; }

  /* ── Colonnes ─────────────────────────────────────────────────────────── */
  /* i : le « i » de l'en-tête (rendu à l'affichage : StatsCore peut se charger
     après ce fichier). Les en-têtes du CSV reprennent les mêmes mots. */
  var TXT_CPQ = 'Dépense de la pub ÷ ses leads qui ont déclaré au quiz un chiffre d’affaires mensuel d’au moins 20 000 €. Ligne Total : dépense pub du compte ÷ total de la colonne CA ≥ 20 k€.';
  var TXT_CPH = 'Dépense de la pub ÷ ses RDV pitchés de la période (offre présentée : résultat Offre, Close ou Non close). C’est le tri par défaut. Ligne Total : dépense pub du compte ÷ total de la colonne Pitchés.';
  var TXT_CPV = 'Dépense de la pub ÷ ses closes de la période (clients gagnés pendant la période, même si leur lead est entré avant) : le CAC pub, pub par pub. Ligne Total : dépense pub du compte ÷ total de la colonne Closes.';
  var TXT_CA = 'Leads de la ligne qui ont déclaré au quiz un chiffre d’affaires mensuel d’au moins 20 000 €. La part se calcule sur les leads qui ont déclaré un CA (n/a : aucun CA déclaré, VSL ou formulaire). Ce n’est ni la note LQS, ni la note équipe ★.';
  var TXT_FAUX = 'Leads de la ligne dont la fiche est aujourd’hui à l’étape Faux numéro ou Poubelle du Pipeline. Part sur les leads de la ligne.';
  var TXT_DISQ = 'Leads de la ligne dont la fiche est aujourd’hui à l’étape Disqualification ou Disqualifié en closing (faux numéros à part). Ce sont des fiches, pas des RDV : ce n’est pas la colonne « Disqua. » des pages équipe, qui compte des RDV. Part sur les leads de la ligne.';
  var TXT_NEVER = 'Leads entrés depuis plus de 48 h sans aucun appel décroché (au moins 5 secondes de conversation, répondeurs écartés) ni aucun RDV. Faux numéros, fiches disqualifiées et clients n’y entrent pas. Part sur ces leads de plus de 48 h.';
  var COLS = [
    { k: 'cpq', l: '€ / lead CA ≥ 20 k€', i: function () { return IL('€ / lead CA ≥ 20 k€', TXT_CPQ); }, cost: true, star: true, v: function (r) { return r.cpq; }, f: function (r) { return eur(r.cpq); } },
    { k: 'cph', l: '€ / RDV pitché', i: function () { return IL('€ / RDV pitché', TXT_CPH); }, cost: true, star: true, v: function (r) { return r.cph; }, f: function (r) { return eur(r.cph); } },
    { k: 'cpv', l: '€ / close', i: function () { return IL('€ / close', TXT_CPV); }, cost: true, star: true, v: function (r) { return r.cpv; }, f: function (r) { return eur(r.cpv); } },
    { k: 'spend', l: 'Dépense par pub', i: function () { return I('depense_pub_ligne', 'Ligne Total : dépense pub du COMPTE (même chiffre que le Stats funnel), avec en dessous la part rattachée aux lignes listées.'); }, v: function (r) { return r.hasSpend ? r.spend : null; }, f: function (r) { return r.hasSpend ? eur(r.spend) : '—'; } },
    { k: 'leads', l: 'Leads', i: function () { return I('leads', 'Ici : leads de la ligne, rattachés à la pub qui les a amenés (premier passage).'); }, v: function (r) { return r.leads; }, f: function (r) { return '<b>' + r.leads + '</b>'; } },
    { k: 'cpl', l: 'CPL', i: function () { return I('cpl_source', 'Ligne Total : CPL pub du Stats funnel = dépense pub du compte ÷ leads venus de la pub (nombre donné par le « i » de la cellule).'); }, cost: true, v: function (r) { return r.cpl; }, f: function (r) { return eur(r.cpl); } },
    { k: 'qualCa', l: 'CA ≥ 20 k€', i: function () { return IL('CA ≥ 20 k€', TXT_CA); }, v: function (r) { return r.caKnown ? r.qualCa / r.caKnown : null; }, f: function (r) { return r.caKnown ? nPct(r.qualCa, r.caKnown) : '<span class="aq-z">n/a</span>'; } },
    { k: 'faux', l: 'Faux n°', i: function () { return IL('Faux numéros', TXT_FAUX); }, v: function (r) { return r.leads ? r.faux / r.leads : null; }, f: function (r) { return nPct(r.faux, r.leads); } },
    { k: 'disq', l: 'Fiches disqualifiées', i: function () { return IL('Fiches disqualifiées', TXT_DISQ); }, v: function (r) { return r.leads ? r.disq / r.leads : null; }, f: function (r) { return nPct(r.disq, r.leads); } },
    { k: 'never', l: 'Jamais joints', i: function () { return IL('Jamais joints', TXT_NEVER); }, v: function (r) { return r.neverEligible ? r.neverReached / r.neverEligible : null; }, f: function (r) { return r.neverEligible ? nPct(r.neverReached, r.neverEligible) : '—'; } },
    { k: 'booked', l: 'RDV pris', i: function () { return I('rdv_pris', 'Ici : RDV pris pendant la période par les leads de la ligne.'); }, v: function (r) { return r.booked; }, f: function (r) { return zero(r.booked); } },
    { k: 'pitched', l: 'Pitchés', i: function () { return I('pitches', 'Ici : RDV de la période des leads de la ligne. C’est l’ensemble envoyé à Meta sous le nom technique « RdvHonore ».'); }, v: function (r) { return pit(r); }, f: function (r) { var n = pit(r); return n ? '<b>' + n + '</b>' : zero(0); } },
    { k: 'cancelled', l: 'Annulés', i: function () { return I('annules'); }, v: function (r) { return r.cancelled; }, f: function (r) { return zero(r.cancelled); } },
    { k: 'noshow', l: 'No-show', i: function () { return I('no_show'); }, v: function (r) { return r.noshow; }, f: function (r) { return zero(r.noshow); } },
    { k: 'closes', l: 'Closes', i: function () { return I('closes', 'Ici : closes dont la fiche est rattachée à la ligne ; un lead entré avant la période compte s’il est gagné pendant la période. Les closes sans fiche rattachable sont sous le tableau (« Non ventilables »).'); }, v: function (r) { return r.closes; }, f: function (r) { return r.closes ? '<b>' + r.closes + '</b>' : zero(0); } },
    { k: 'con', l: 'Contracté', i: function () { return I('contracte'); }, v: function (r) { return r.con; }, f: function (r) { return r.con ? eur(r.con) : '—'; } },
    { k: 'col', l: 'Collecté', i: function () { return I('collecte'); }, v: function (r) { return r.col; }, f: function (r) { return r.col ? eur(r.col) : '—'; } }
  ];
  function colByKey(k) { for (var i = 0; i < COLS.length; i++) if (COLS[i].k === k) return COLS[i]; return null; }
  function cols() { return isVis() ? COLS.filter(function (c) { return !c.cost && c.k !== 'spend'; }) : COLS; }

  /* ── Données ──────────────────────────────────────────────────────────── */
  /* Phrases de lecture incomplète utiles à CET onglet (k.erreursLecture de
     funnel-core.js) : les coûts internes, commissions, journal d'actions,
     visites, ré-optins et équipe ne le concernent pas. Même liste que
     api/ads-quality-share.js (LECTURE_HORS_LIEN). */
  var LECTURE_HORS_ONGLET = [/^Lecture des coûts/, /^Lecture des commissions/, /^Lecture du journal/, /^Lecture de l.équipe/, /^Lecture des visites/,
    /^Lecture des ré-optins/, /^Liste des ré-optins/];
  function lectureUtile(phrases) {
    return (phrases || []).filter(function (s) {
      if (typeof s !== 'string' || !s) return false;
      for (var i = 0; i < LECTURE_HORS_ONGLET.length; i++) if (LECTURE_HORS_ONGLET[i].test(s)) return false;
      return true;
    });
  }
  function axesOf(by) {
    by = by || {};
    return { creative: by.creative || [], adset: by.adset || [], campaign: by.campaign || [], device: by.device || [], region: by.region || [] };
  }
  function fromKpis(K, periodLabel) {
    var by = (K && K.utmRowsByAxis) || {};
    return {
      rowsByAxis: axesOf(by),
      coverage: {
        leads: K ? K.leads : 0, attributedLeads: K ? K.attributedLeads : 0, attributedPct: K ? K.attributedPct : null,
        hasAdLevelSpend: !!(K && K.hasAdLevelSpend), adLevelSpend: K ? K.adLevelSpend : 0,
        adSpendComplete: !!(K && K.adSpendComplete),
        adSpendOk: K && K.adSpendOk != null ? !!K.adSpendOk : undefined,
        adSpendDaysCovered: K ? K.adSpendDaysCovered : 0, adSpendDaysExpected: K ? K.adSpendDaysExpected : 0,
        /* Dépense pub du COMPTE (ads_insights, même chiffre que le funnel) */
        spend: K && K.spend != null ? K.spend : null, adsSpendOk: K && K.adsSpendOk != null ? !!K.adsSpendOk : undefined,
        adsDaysCovered: K ? K.adsDaysCovered : null, adsDaysExpected: K ? K.adsDaysExpected : null,
        leadsAds: K ? K.leadsAds : null, cplAds: K ? K.cplAds : null
      },
      unattrByAxis: (K && K.utmUnattrByAxis) || {},
      lecture: { erreurs: lectureUtile(K && K.erreursLecture), partiel: (K && K.partiel) || {} },
      periodLabel: periodLabel || ''
    };
  }
  /* Réponse de api/ads-quality-share.js (lien média buyeuse). */
  function fromShare(j, periodLabel) {
    j = j || {};
    return {
      rowsByAxis: axesOf(j.rowsByAxis),
      coverage: j.coverage || {},
      unattrByAxis: j.unattrByAxis || {},
      lecture: { erreurs: lectureUtile(j.lecture && j.lecture.erreurs), partiel: (j.lecture && j.lecture.partiel) || {} },
      periodLabel: periodLabel || ''
    };
  }
  /* Coûts affichables — MÊME règle que le Stats funnel (k.adSpendOk) : la
     dépense par pub doit couvrir tous les jours de la période jusqu'à HIER
     (la dépense d'un jour n'arrive que le lendemain). Plus de tolérance d'un
     jour : un jour manquant fait un coût faussement bas. Repli sur l'ancien
     drapeau adSpendComplete (réponse d'une route pas encore redéployée). */
  function costsOk(cov) {
    if (!cov || !cov.hasAdLevelSpend) return false;
    if (typeof cov.adSpendOk === 'boolean') return cov.adSpendOk;
    if (typeof cov.adSpendComplete === 'boolean') return cov.adSpendComplete;
    return (cov.adSpendDaysExpected || 0) - (cov.adSpendDaysCovered || 0) <= 0;
  }
  /* Ligne Total : coûts calculés sur la dépense pub du COMPTE ; affichables
     si la dépense par pub ET celle du compte sont complètes. */
  function totalCostsOk(cov) {
    if (!costsOk(cov)) return false;
    return cov.adsSpendOk !== false;
  }
  function sortRows(rows) {
    var c = colByKey(state.sort) || colByKey('cph');
    var dir = state.dir;
    /* Axe Appareil / Région : un tri sur un coût masqué → tri par leads. */
    if (isVis() && (c.cost || c.k === 'spend')) { c = colByKey('leads'); dir = -1; }
    return rows.slice().sort(function (a, b) {
      if (!!a.outOfAds !== !!b.outOfAds) return a.outOfAds ? 1 : -1;
      var va = c.v(a), vb = c.v(b);
      var na = va == null || !isFinite(va), nb = vb == null || !isFinite(vb);
      if (na !== nb) return na ? 1 : -1;                 // « — » toujours en bas
      if (!na && va !== vb) return (va - vb) * dir;
      return (b.leads - a.leads) || (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
    });
  }
  /* Total des lignes de pub listées. Dépense : celle du COMPTE quand elle
     est connue (même chiffre que le Stats funnel), la part rattachée aux
     lignes est gardée à côté (spendLignes) ; CPL : CPL pub du funnel
     (dépense ÷ leads venus de la pub) ; autres coûts : dépense ÷ total de
     la colonne (deux chiffres affichés). */
  function totals(rows, cov) {
    var t = { key: 'Total', leads: 0, caKnown: 0, qualCa: 0, faux: 0, disq: 0, neverReached: 0, neverEligible: 0,
      booked: 0, pitched: 0, cancelled: 0, noshow: 0, closes: 0, con: 0, col: 0, spend: 0, hasSpend: false,
      spendLignes: 0, spendCompte: false };
    rows.forEach(function (r) {
      ['leads', 'caKnown', 'qualCa', 'faux', 'disq', 'neverReached', 'neverEligible', 'booked', 'cancelled', 'noshow', 'closes', 'con', 'col'].forEach(function (f) { t[f] += Number(r[f]) || 0; });
      t.pitched += pit(r);
      if (r.hasSpend) { t.spendLignes += Number(r.spend) || 0; t.hasSpend = true; }
    });
    t.spend = t.spendLignes;
    if (cov && cov.spend != null && isFinite(cov.spend) && Number(cov.spend) > 0) {
      t.spend = Number(cov.spend); t.hasSpend = true; t.spendCompte = true;
    }
    if (t.spendCompte) t.cpl = cov.cplAds != null && isFinite(cov.cplAds) ? Number(cov.cplAds) : null;
    else t.cpl = t.hasSpend && t.leads ? t.spend / t.leads : null;
    t.cpq = t.hasSpend && t.qualCa ? t.spend / t.qualCa : null;
    t.cph = t.hasSpend && t.pitched ? t.spend / t.pitched : null;
    t.cpv = t.hasSpend && t.closes ? t.spend / t.closes : null;
    return t;
  }

  /* ── Styles (variables de thème des pages internes, repli sombre) ─────── */
  function injectCss() {
    if (document.getElementById('aqCss')) return;
    var st = document.createElement('style');
    st.id = 'aqCss';
    st.textContent = ''
      + '.aq-wrap{font-size:12.5px;color:var(--text,#e8eaf2)}'
      + '.aq-head{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:10px}'
      + '.aq-title{font-size:15px;font-weight:800;letter-spacing:-.2px}'
      + '.aq-sub{color:var(--muted,#8f97b2);font-size:11.5px}'
      + '.aq-seg{display:flex;gap:3px;padding:3px;background:var(--bg3,#1a1d2b);border:1px solid var(--border,#2a2e40);border-radius:10px}'
      + '.aq-seg button{padding:5px 11px;border-radius:8px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;color:var(--muted,#8f97b2);background:none;border:none}'
      + '.aq-seg button.on{background:var(--bg4,#23273a);color:var(--text,#e8eaf2)}'
      + '.aq-btn{padding:6px 11px;border-radius:9px;font:inherit;font-size:12px;font-weight:600;cursor:pointer;border:1px solid var(--border,#2a2e40);background:var(--bg3,#1a1d2b);color:var(--text,#e8eaf2)}'
      + '.aq-btn:hover{background:var(--bg4,#23273a)}'
      + '.aq-btn.primary{color:var(--blue,#60a5fa);border-color:rgba(96,165,250,.35)}'
      + '.aq-btn.danger{color:var(--red3,#f87171)}'
      + '.aq-note{border:1px solid var(--border,#2a2e40);background:var(--bg2,#141724);border-radius:11px;padding:9px 13px;margin:0 0 10px;color:var(--muted,#8f97b2);line-height:1.55}'
      + '.aq-note.warn{border-color:rgba(245,158,11,.35);color:var(--gold,#f5b544)}'
      + '.aq-note b{color:var(--text,#e8eaf2)}'
      + '.aq-tw{overflow-x:auto;border:1px solid var(--border,#2a2e40);border-radius:14px;background:var(--bg2,#141724)}'
      + '.aq-t{width:100%;border-collapse:collapse;min-width:1500px}'
      + '.aq-t th{text-align:right;padding:9px 10px;font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:var(--muted,#8f97b2);border-bottom:1px solid var(--border2,#353a52);white-space:nowrap;cursor:pointer;user-select:none;position:sticky;top:0;background:var(--bg2,#141724)}'
      + '.aq-t th:first-child,.aq-t td:first-child{text-align:left;position:sticky;left:0;background:var(--bg2,#141724);z-index:1;min-width:230px;max-width:320px}'
      + '.aq-t th.star{color:var(--blue,#60a5fa)}'
      + '.aq-t th.sorted{color:var(--text,#e8eaf2)}'
      + '.aq-t td{padding:8px 10px;border-bottom:1px solid var(--border,#2a2e40);text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums}'
      + '.aq-t td.star{background:rgba(96,165,250,.07);font-weight:700}'
      + '.aq-t tr.small td{opacity:.62}'
      + '.aq-t tr.out td{opacity:.5}'
      + '.aq-t tr.tot td{font-weight:800;border-top:1px solid var(--border2,#353a52);border-bottom:none}'
      + '.aq-name{display:block;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
      + '.aq-tag{display:inline-block;font-size:10px;font-weight:700;padding:1px 6px;border-radius:6px;margin-left:6px;vertical-align:1px}'
      + '.aq-tag.small{color:var(--gold,#f5b544);background:rgba(245,158,11,.12)}'
      + '.aq-tag.leg{color:var(--muted,#8f97b2);background:rgba(143,151,178,.12)}'
      + '.aq-z{color:var(--muted2,#5d647e)}'
      + '.aq-p{color:var(--muted,#8f97b2);font-size:11px}'
      + '.aq-panel{margin-top:18px;border:1px solid var(--border,#2a2e40);border-radius:14px;background:var(--bg2,#141724);padding:14px 16px}'
      + '.aq-panel h4{margin:0 0 6px;font-size:13.5px}'
      + '.aq-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:8px 0}'
      + '.aq-in{background:var(--bg3,#1a1d2b);border:1px solid var(--border,#2a2e40);border-radius:8px;color:var(--text,#e8eaf2);padding:6px 9px;font:inherit;font-size:12px;min-width:160px}'
      + '.aq-pill{display:inline-block;font-size:11px;font-weight:700;padding:2px 8px;border-radius:999px}'
      + '.aq-pill.ok{color:var(--green,#34d399);background:rgba(52,211,153,.12)}'
      + '.aq-pill.ko{color:var(--red3,#f87171);background:rgba(239,68,68,.12)}'
      + '.aq-pill.wait{color:var(--gold,#f5b544);background:rgba(245,158,11,.12)}'
      + '.aq-pill.off{color:var(--muted,#8f97b2);background:rgba(143,151,178,.12)}'
      + '.aq-jt{width:100%;border-collapse:collapse;min-width:900px;font-size:11.5px}'
      + '.aq-jt th{text-align:left;padding:6px 8px;color:var(--muted,#8f97b2);font-size:10px;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid var(--border2,#353a52)}'
      + '.aq-jt td{padding:6px 8px;border-bottom:1px solid var(--border,#2a2e40);vertical-align:top}'
      + '.aq-link{word-break:break-all;font-family:var(--font-m,monospace);font-size:11px}'
      + '.aq-sl{display:block;font-size:10.5px;font-weight:500;color:var(--muted,#8f97b2);white-space:nowrap}'
      + '.aq-note.err{border-color:rgba(239,68,68,.35);color:var(--red3,#f87171)}'
      + '.aq-note ul{margin:4px 0 0 18px;padding:0}'
      + '.aq-t th .sc-i{vertical-align:-1px}';
    (document.head || document.documentElement).appendChild(st);
  }

  /* ── Tableau ──────────────────────────────────────────────────────────── */
  var TXT_TOTAL = 'Somme des lignes de pub listées (lignes hors pub / pub inconnue et non ventilables à part : voir sous le tableau). Dépense : dépense pub du compte, même chiffre que le Stats funnel. CPL : CPL pub du Stats funnel. Autres coûts : cette dépense ÷ le total de leur colonne.';
  var TXT_TOTAL_VIS = 'Somme des lignes dont l’appareil ou le lieu est connu. Les lignes « inconnu » et les non ventilables sont à part (voir sous le tableau).';
  function tableHtml(data) {
    var rowsAll = (data.rowsByAxis && data.rowsByAxis[state.axis]) || [];
    var ads = rowsAll.filter(function (r) { return !r.outOfAds; });
    var out = rowsAll.filter(function (r) { return r.outOfAds; });
    var rows = sortRows(state.showOut ? rowsAll : ads);
    var cov = data.coverage || {};
    var ok = costsOk(cov);
    var okTot = totalCostsOk(cov);
    var axisName = AXES.filter(function (a) { return a.id === state.axis; })[0].name;

    var h = '<div class="aq-tw"><table class="aq-t"><thead><tr><th data-aq-sort="key">' + esc(axisName) + '</th>';
    cols().forEach(function (c) {
      var cls = (c.star ? 'star ' : '') + (state.sort === c.k ? 'sorted' : '');
      var arrow = state.sort === c.k ? (state.dir > 0 ? ' ▲' : ' ▼') : '';
      h += '<th class="' + cls + '" data-aq-sort="' + c.k + '">' + (c.star ? '★ ' : '') + esc(c.l) + arrow + (c.i ? c.i() : '') + '</th>';
    });
    h += '</tr></thead><tbody>';
    if (!rows.length) h += '<tr><td colspan="' + (cols().length + 1) + '" style="text-align:center;color:var(--muted,#8f97b2);padding:22px">' + (isVis() ? 'Aucun lead dont ' + (state.axis === 'device' ? 'l\'appareil' : 'le lieu') + ' est connu sur la période.' : 'Aucun lead attribué à une pub sur la période.') + '</td></tr>';
    rows.forEach(function (r) {
      var cls = r.outOfAds ? 'out' : (r.leads < SMALL ? 'small' : '');
      h += '<tr class="' + cls + '"><td><span class="aq-name" title="' + esc(r.key) + (r.adIdList && r.adIdList.length ? ' · ' + esc(r.adIdList.join(', ')) : '') + '">' + esc(r.key)
        + (!r.outOfAds && r.leads < SMALL ? '<span class="aq-tag small" title="Moins de 10 leads : échantillon trop faible pour conclure">⚠ &lt; 10 leads</span>' : '')
        + (r.legacy && !r.outOfAds ? '<span class="aq-tag leg" title="Rattaché par le nom (ancien paramétrage d\'URL), pas par l\'identifiant de la pub">nom</span>' : '')
        + '</span></td>';
      cols().forEach(function (c) {
        var txt = (c.cost && !ok) ? '—' : c.f(r);
        h += '<td class="' + (c.star ? 'star' : '') + '">' + txt + '</td>';
      });
      h += '</tr>';
    });
    if (rows.length) {
      var t = totals(ads, isVis() ? null : cov);
      h += '<tr class="tot"><td>' + (isVis() ? 'Total connus (' : 'Total pubs (') + ads.length + ')' + IL('Ligne Total', isVis() ? TXT_TOTAL_VIS : TXT_TOTAL) + '</td>';
      cols().forEach(function (c) {
        var txt;
        if (c.cost && !okTot) txt = '—';
        else if (c.k === 'spend' && t.spendCompte) {
          txt = eur(t.spend) + IL('Dépense pub du compte', 'Dépense Meta du compte sur la période, jour par jour, hors taxes (corrigeable dans l’onglet Données Ads du Stats funnel). '
              + eur(t.spendLignes) + ' sont rattachés aux pubs listées ; ' + eur(Math.max(0, t.spend - t.spendLignes)) + ' ne le sont pas : pubs sans lead, jours pas encore reçus pub par pub, corrections à la main.')
            + '<span class="aq-sl">dont ' + eur(t.spendLignes) + ' rattachés aux lignes</span>';
        } else if (c.k === 'cpl' && t.spendCompte) {
          txt = eur(t.cpl) + I('cpl_pub', 'Ici : ' + eur(t.spend) + ' ÷ ' + (cov.leadsAds != null ? cov.leadsAds : '?') + ' leads venus de la pub (pubs listées, pubs sans créative transmise comprises).');
        } else txt = c.f(t);
        h += '<td class="' + (c.star ? 'star' : '') + '">' + txt + '</td>';
      });
      h += '</tr>';
    }
    h += '</tbody></table></div>';
    if (out.length) {
      h += '<div class="aq-row"><button type="button" class="aq-btn" data-aq-out="1">' + (state.showOut ? 'Masquer' : 'Afficher') + ' les ' + out.length + ' ligne(s) ' + (isVis() ? (state.axis === 'device' ? 'appareil inconnu' : 'lieu inconnu') : 'hors pub / pub inconnue') + '</button></div>';
    }
    h += identityHtml(data, ads, out);
    return h;
  }
  /* Sous le tableau : ce qui n'est sur aucune ligne, et l'identité
     pubs + hors pub + non ventilables = Closes de la période (P4). */
  function identityHtml(data, ads, out) {
    var ua = (data.unattrByAxis && data.unattrByAxis[state.axis]) || null;
    function sum(list, f) { var s = 0; list.forEach(function (r) { s += (f === 'pitched' ? pit(r) : (Number(r[f]) || 0)); }); return s; }
    var h = '<div class="aq-note">';
    if (ua) {
      var uaPit = ua.pitched != null ? ua.pitched : 0;
      var cA = sum(ads, 'closes'), cO = sum(out, 'closes'), cU = Number(ua.closes) || 0;
      h += '<b>Non ventilables</b>' + IL('Non ventilables', 'RDV et closes dont aucune fiche n’a pu être retrouvée (RDV sans fiche, client repéré par le seul paiement) : ils ne peuvent être rangés sur aucune ligne.')
        + ' : ' + (Number(ua.booked) || 0) + ' RDV pris · ' + uaPit + ' pitchés · ' + (Number(ua.cancelled) || 0) + ' annulés · ' + (Number(ua.noshow) || 0) + ' no-show · ' + cU + ' closes.<br>'
        + 'Closes : ' + (isVis() ? 'lignes connues ' : 'pubs listées ') + cA + ' + ' + (isVis() ? 'inconnu ' : 'hors pub / pub inconnue ') + cO + ' + non ventilables ' + cU
        + ' = <b>' + (cA + cO + cU) + ' closes</b> de la période' + I('closes', 'Même liste que le chiffre Closes du Stats funnel, sur la même période et avec les mêmes filtres (tunnel, source).') + '<br>';
    }
    h += 'Montants hors taxes' + I('ht') + '.</div>';
    return h;
  }

  function headHtml(data, opts) {
    var cov = data.coverage || {};
    var h = '<div class="aq-head"><span class="aq-title">🎯 Qualité par pub</span>'
      + (data.periodLabel ? '<span class="aq-sub">' + esc(data.periodLabel) + '</span>' : '')
      + '<div style="flex:1"></div><div class="aq-seg">';
    AXES.forEach(function (a) { h += '<button type="button" data-aq-axis="' + a.id + '" class="' + (state.axis === a.id ? 'on' : '') + '">' + esc(a.label) + '</button>'; });
    h += '</div><button type="button" class="aq-btn" data-aq-csv="1">⬇ Export CSV</button>';
    if (opts.admin && !opts.readonly) h += '<button type="button" class="aq-btn primary" data-aq-share="1">🔗 Lien média buyeuse</button>';
    h += '</div>';
    /* Lectures en échec ou tronquées : dites, jamais un zéro muet (P7). */
    var errs = (data.lecture && data.lecture.erreurs) || [];
    if (errs.length) {
      h += '<div class="aq-note err"><b>Chiffres incomplets</b>' + I('lecture_incomplete') + '<ul>';
      errs.forEach(function (s) { h += '<li>' + esc(s) + '</li>'; });
      h += '</ul></div>';
    }
    var att = cov.attributedPct != null ? Math.round(cov.attributedPct) + ' %' : '—';
    h += '<div class="aq-note">Lecture : leads = entrés sur la période, chacun rattaché à la pub qui l\'a amené (premier passage) ; RDV pris = créés sur la période ; '
      + 'pitchés, annulés, no-show = RDV datés sur la période ; closes, contracté et collecté = clients gagnés sur la période, même si leur lead est entré avant (collecté = prélevé à ce jour).'
      + IL('Deux périodes dans un tableau', 'Les closes de la période ne viennent pas tous des leads entrés pendant la période : un lead entré en octobre et gagné en novembre compte en novembre, sur sa pub. Pour suivre les leads d’un mois jusqu’à la vente, voir Qualité leads (closes des leads entrés).')
      + ' <b>' + att + '</b> des ' + (cov.leads || 0) + ' leads de la période portent une attribution publicitaire. '
      + 'Les leads d\'avant le nouveau paramétrage d\'URL restent rattachés par le nom de la pub (repère « nom ») ou « pub inconnue ». '
      + '<b>★</b> = les trois coûts à piloter. Colonnes triables (clic sur l\'en-tête).</div>';
    if (isVis()) h += '<div class="aq-note">' + (state.axis === 'device'
      ? 'Appareil du prospect à l\'inscription (navigateur capté depuis le 12/11/2026) ou à la prise de RDV. Le navigateur intégré de Facebook / Instagram forme sa propre ligne.'
      : 'Lieu approximatif du prospect (déduit de son adresse internet, aucune adresse conservée) à l\'inscription ou à la prise de RDV ; clients plus anciens : lieu de la signature.')
      + ' Pas de coûts sur cet axe : Meta ne transmet pas la dépense par appareil ni par région.</div>';
    else h += coverageHtml(cov);
    return h;
  }
  /* Couverture de la dépense : dite à l'écran, même règle que le funnel
     (jours attendus jusqu'à hier, aucun jour manquant). */
  function coverageHtml(cov) {
    if (!cov.hasAdLevelSpend) {
      return '<div class="aq-note warn">Aucune dépense par pub reçue sur la période (scénario Make « FB insight ÉLITE — Créatives ») : les coûts sont masqués.' + I('depense_incomplete') + '</div>';
    }
    if (!costsOk(cov)) {
      return '<div class="aq-note warn">Dépense par pub reçue pour <b>' + (cov.adSpendDaysCovered || 0) + ' jour(s) sur ' + (cov.adSpendDaysExpected || 0) + '</b> (jours attendus jusqu\'à hier, même règle que le Stats funnel) : '
        + 'les coûts sont masqués, ils seraient faussement bas.' + I('couverture_depense') + '</div>';
    }
    if (cov.adsSpendOk === false) {
      return '<div class="aq-note warn">Dépense du compte reçue pour <b>' + (cov.adsDaysCovered || 0) + ' jour(s) sur ' + (cov.adsDaysExpected || 0) + '</b> : '
        + 'les coûts de la ligne Total sont masqués (ils seraient faussement bas) ; les coûts pub par pub restent affichés.' + I('couverture_depense') + '</div>';
    }
    return '';
  }

  /* ── Export CSV (séparateur « ; », décimales à la virgule : Excel FR) ── */
  /* En-têtes : mêmes mots que le tableau (25/11/2026 : « RDV posés » → « RDV
     pris », « RDV honorés » → « Pitchés », « Ventes » → « Closes »,
     « Encaissé » → « Collecté », « Qualifiés » → « CA ≥ 20 k€ »,
     « Disqualifiés » → « Fiches disqualifiées ») ; aucun chiffre ne change. */
  var CSV_HEAD = ['Ligne', 'Hors pub', 'Identifiants pub', 'Dépense par pub', 'Leads', 'CPL', 'Leads avec CA déclaré', 'Leads CA ≥ 20 k€', 'Part CA ≥ 20 k€',
    'Faux numéros', 'Part faux numéros', 'Fiches disqualifiées', 'Part fiches disqualifiées', 'Jamais joints', 'Leads > 48 h', 'Part jamais joints',
    'RDV pris', 'Pitchés', 'Annulés', 'No-show', 'Closes', 'Contracté HT', 'Collecté HT',
    'Coût par lead CA ≥ 20 k€', 'Coût par RDV pitché', 'Coût par close', 'Moins de 10 leads'];
  function csvLines(data) {
    var rows = sortRows((data.rowsByAxis && data.rowsByAxis[state.axis]) || []);
    var cov = data.coverage || {};
    var ok = costsOk(cov) && !isVis();
    function num(v, dec) { if (v == null || !isFinite(v)) return ''; return Number(v).toFixed(dec == null ? 2 : dec).replace('.', ','); }
    function cell(s) { s = String(s == null ? '' : s); return /[;"\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
    var lines = [CSV_HEAD.join(';')];
    rows.forEach(function (r) {
      lines.push([cell(r.key), r.outOfAds ? 'oui' : '', cell((r.adIdList || []).join(' ')), r.hasSpend && !isVis() ? num(r.spend) : '', r.leads, ok ? num(r.cpl) : '',
        r.caKnown, r.qualCa, r.caKnown ? num(r.qualCa / r.caKnown * 100, 1) : '',
        r.faux, r.leads ? num(r.faux / r.leads * 100, 1) : '', r.disq, r.leads ? num(r.disq / r.leads * 100, 1) : '',
        r.neverReached, r.neverEligible, r.neverEligible ? num(r.neverReached / r.neverEligible * 100, 1) : '',
        r.booked, pit(r), r.cancelled, r.noshow, r.closes, num(r.con), num(r.col),
        ok ? num(r.cpq) : '', ok ? num(r.cph) : '', ok ? num(r.cpv) : '', r.leads < SMALL ? 'oui' : ''].join(';'));
    });
    /* Coûts non exportés : dit dans le fichier, pas seulement à l'écran. */
    if (!isVis() && !costsOk(cov)) {
      lines.push(cell(cov.hasAdLevelSpend
        ? 'Coûts non exportés : dépense par pub reçue pour ' + (cov.adSpendDaysCovered || 0) + ' jour(s) sur ' + (cov.adSpendDaysExpected || 0) + ' (jusqu\'à hier) — ils seraient faussement bas.'
        : 'Coûts non exportés : aucune dépense par pub reçue sur la période.'));
    }
    var errs = (data.lecture && data.lecture.erreurs) || [];
    errs.forEach(function (s) { lines.push(cell('Chiffres incomplets : ' + s)); });
    return lines;
  }
  function csv(data) {
    var lines = csvLines(data);
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'qualite-par-pub-' + state.axis + '-' + String(data.periodLabel || '').replace(/[^0-9A-Za-zÀ-ÿ_-]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase() + '.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); document.body.removeChild(a); }, 500);
  }

  /* ══ ADMIN — lien de partage + API Conversions (sales-funnel.html) ══════ */
  function rndToken() {
    var b = new Uint8Array(24);
    (window.crypto || window.msCrypto).getRandomValues(b);
    var s = '';
    for (var i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function shareUrl(tok) { return location.origin + '/ads-quality.html?t=' + encodeURIComponent(tok); }
  function copy(txt, toast) {
    function done() { if (toast) toast('📋 Lien copié'); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { if (toast) toast('Copie impossible — sélectionne le lien', true); });
    else if (toast) toast('Sélectionne le lien à la main', true);
  }
  function apiCall(ctx, method, url, body) {
    return ctx.user.getIdToken().then(function (tok) {
      var o = { method: method, headers: { Authorization: 'Bearer ' + tok } };
      if (body) { o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(body); }
      return fetch(url, o).then(function (r) { return r.json().then(function (j) { if (!r.ok && j && !j.error) j.error = 'HTTP ' + r.status; return j; }); });
    });
  }

  var admin = { share: null, capi: null, journal: null, open: false, busy: false, filter: '' };

  function sharePanelHtml() {
    var s = admin.share;
    var h = '<div class="aq-panel" id="aqSharePanel"><h4>🔗 Accès média buyeuse — lecture seule</h4>'
      + '<div class="aq-sub">Un lien secret : ce tableau seulement (pub, ensemble, campagne, coûts), sur la période de son choix, sans compte. Jamais un nom de lead, un contact, une commission. Chaque ouverture est journalisée. Distinct du lien Agence. Stocké dans <code>_config/ads_quality_access</code>.</div>';
    if (!s) h += '<div class="aq-row aq-sub">Chargement…</div>';
    else if (s.active && s.token) {
      h += '<div class="aq-row"><span class="aq-pill ok">actif</span><span class="aq-link">' + esc(shareUrl(s.token)) + '</span></div>'
        + '<div class="aq-row"><button type="button" class="aq-btn primary" data-aq-act="share-copy">📋 Copier</button>'
        + '<button type="button" class="aq-btn" data-aq-act="share-rotate">🔄 Nouveau lien (l\'ancien cesse de marcher)</button>'
        + '<button type="button" class="aq-btn danger" data-aq-act="share-off">⛔ Couper l\'accès</button></div>';
    } else {
      h += '<div class="aq-row"><span class="aq-pill off">aucun lien actif</span><button type="button" class="aq-btn primary" data-aq-act="share-new">Créer le lien</button></div>';
    }
    return h + '</div>';
  }

  var STATUS_PILL = { sent: ['ok', 'envoyé'], error: ['ko', 'erreur'], skipped: ['off', 'non envoyé'] };
  var REASONS = { faux_numero: 'faux numéro', youtube: 'visiteur YouTube', pixel_non_autorise: 'pixel non autorisé', hors_pub: 'hors pub (organique)',
    sans_contact: 'sans e-mail ni téléphone', contact_bloque: 'contact bloqué', telephone_invalide: 'téléphone invalide',
    trop_ancien: 'plus de 7 jours', fiche_introuvable: 'fiche introuvable' };

  /* D17 (25/11/2026) : les événements envoyés à Meta ne changent pas. Le
     « i » dit pourquoi « Vente » et la colonne Closes peuvent différer. */
  var TXT_VENTE_META = 'L’événement « Vente » part au moment où un RDV est statué Close : un par RDV closé, au tarif hors taxes déclaré aux cartes du close. La colonne Closes du tableau suit la liste unique des clients gagnés (un par client, le jour où il devient client, closes annulés retirés) et le Contracté lit le module Paiements : les deux peuvent différer (close validé sur la fiche sans RDV, client à deux RDV closés, remise, paiement annulé). « RdvHonore » est l’ensemble des RDV pitchés.';
  var TXT_VENTE_MONTANT = 'Montant envoyé à Meta : tarif hors taxes choisi aux cartes du close, au moment du close. La colonne Contracté lit le contrat du module Paiements : elle peut différer (remise, paiement annulé).';
  function capiPanelHtml() {
    var c = admin.capi;
    var h = '<div class="aq-panel" id="aqCapiPanel"><h4>📡 Événements renvoyés à Meta (API Conversions)</h4>'
      + '<div class="aq-sub">LeadQualifie (CA ≥ 20 k€/mois) · LeadLQS3plus / LeadLQS4plus / LeadLQS5 (note LQS ≥ 3, ≥ 4, = 5 à l\'opt-in, cumulatifs : un lead noté 5 envoie les trois) · LeadDisqualifie (réponse éliminatoire ⛔ du barème, audiences d\'exclusion) · RdvPose (RDV commercial créé, report exclu) · RdvHonore (résultat close, non close ou offre : un RDV pitché — nom technique gardé chez Meta) · Vente (un par RDV au résultat close, au tarif HT déclaré au close) — plus les jumeaux serveur de Lead et Schedule, avec le même identifiant que le pixel navigateur (Meta n\'en garde qu\'un). Jamais pour un faux numéro, un visiteur YouTube ou un pixel non autorisé. Envoi toutes les 10 min ; rien d\'antérieur à l\'activation.'
      + IL('Vente (Meta) et colonne Closes', TXT_VENTE_META) + '</div>';
    if (!c) return h + '<div class="aq-row aq-sub">Chargement…</div></div>';
    if (c.error) return h + '<div class="aq-row aq-note warn">' + esc(c.error) + '</div></div>';
    var mode = !c.enabled ? '<span class="aq-pill off">désactivé</span>'
      : (c.testMode ? '<span class="aq-pill wait">mode TEST</span>' : '<span class="aq-pill ok">RÉEL</span>');
    h += '<div class="aq-row">' + mode
      + ' <span class="aq-pill ' + (c.tokenSet ? 'ok' : 'ko') + '">jeton Meta ' + (c.tokenSet ? 'posé' : 'absent (variable Vercel META_CAPI_TOKEN)') + '</span>'
      + ' <span class="aq-sub">pixel ' + esc(c.pixelId) + ' · API ' + esc(c.apiVersion) + (c.lastRunAt ? ' · dernier passage ' + esc(new Date(c.lastRunAt).toLocaleString('fr-FR')) : '') + '</span></div>';
    if (_opts.readonly) {
      /* Lecteur funnel (19/11/2026) : statut, « Ce qui partirait » et journal
         seulement — aucun réglage, aucun envoi. */
      h += '<div class="aq-row"><button type="button" class="aq-btn" data-aq-act="capi-dry">👁 Ce qui partirait (sans envoyer)</button></div>';
    } else {
    h += '<div class="aq-row"><label class="aq-sub" for="aqTestCode">Code de test Meta</label><input class="aq-in" id="aqTestCode" placeholder="TEST12345" value="' + esc(c.testEventCode || '') + '">'
      + '<button type="button" class="aq-btn" data-aq-act="capi-save-code">Enregistrer</button>'
      + '<button type="button" class="aq-btn" data-aq-act="capi-probe" title="Envoie un exemplaire de chaque événement pour un contact fictif, avec le code de test">🧪 Envoyer les 10 événements de test</button></div>';
    h += '<div class="aq-row">';
    if (!c.enabled) h += '<button type="button" class="aq-btn primary" data-aq-act="capi-enable-test">Activer en mode test</button>';
    else {
      if (c.testMode) h += '<button type="button" class="aq-btn primary" data-aq-act="capi-prod">Passer en réel…</button>';
      else h += '<button type="button" class="aq-btn" data-aq-act="capi-back-test">Revenir en mode test</button>';
      h += '<button type="button" class="aq-btn danger" data-aq-act="capi-disable">Désactiver</button>';
    }
    h += '<button type="button" class="aq-btn" data-aq-act="capi-run">⟳ Lancer un passage maintenant</button>'
      + '<button type="button" class="aq-btn" data-aq-act="capi-dry">👁 Ce qui partirait (sans envoyer)</button></div>';
    }
    if (admin.dry) {
      h += '<div class="aq-note">' + esc(admin.dry) + '</div>';
    }
    h += '<div class="aq-row"><b style="font-size:12px">Journal</b><select class="aq-in" id="aqJFilter" style="min-width:120px">'
      + ['', 'sent', 'error', 'skipped'].map(function (v) { return '<option value="' + v + '"' + (admin.filter === v ? ' selected' : '') + '>' + (v ? STATUS_PILL[v][1] : 'tous') + '</option>'; }).join('')
      + '</select><button type="button" class="aq-btn" data-aq-act="capi-journal">⟳</button></div>';
    var rows = admin.journal || [];
    if (!rows.length) h += '<div class="aq-sub">Aucune ligne.</div>';
    else {
      h += '<div class="aq-tw" style="max-height:420px;overflow:auto"><table class="aq-jt"><thead><tr><th>Date</th><th>Événement</th><th>Lead</th><th>Statut</th><th>Réponse de Meta</th><th>Correspondance</th></tr></thead><tbody>';
      rows.forEach(function (r) {
        var p = STATUS_PILL[r.status] || ['off', r.status];
        var resp = r.status === 'skipped' ? esc(REASONS[r.reason] || r.reason || '')
          : (r.response && r.response.ok ? 'reçu (' + (r.response.events_received != null ? r.response.events_received : '?') + ')' + (r.response.fbtrace_id ? ' · ' + esc(r.response.fbtrace_id) : '')
            : esc((r.response && r.response.error) || '') + (r.attempts ? ' · essai ' + r.attempts : ''));
        h += '<tr><td>' + esc(r.sentAt ? new Date(r.sentAt).toLocaleString('fr-FR') : '') + '</td>'
          + '<td><b>' + esc(r.event) + '</b>' + (r.value != null ? ' · ' + eur(r.value) + (r.event === 'Vente' ? ' <span class="aq-z">(tarif déclaré au close)</span>' + IL('Montant de la Vente envoyée à Meta', TXT_VENTE_MONTANT) : '') : '') + (r.lqs != null ? ' · LQS ' + esc(r.lqs) : '') + (r.test ? ' <span class="aq-pill wait">test</span>' : '') + '</td>'
          + '<td>' + (r.leadId ? '<a href="sales-leads.html?lead=' + encodeURIComponent(r.leadId) + '" target="_blank" rel="noopener">' + esc(r.leadName || r.leadId) + '</a>' : '<span class="aq-z">' + esc(r.reason || '—') + '</span>') + '</td>'
          + '<td><span class="aq-pill ' + p[0] + '">' + esc(p[1]) + '</span></td>'
          + '<td>' + resp + '</td>'
          + '<td class="aq-sub">' + esc((r.matchKeys || []).join(', ')) + '</td></tr>';
      });
      h += '</tbody></table></div>';
    }
    return h + '</div>';
  }

  function adminLoad(ctx, repaint) {
    var db = ctx.db;
    if (_opts.readonly) { capiReload(ctx, repaint); return; }   // pas de lien média buyeuse pour le lecteur
    db.collection('_config').doc('ads_quality_access').get().then(function (s) {
      admin.share = s.exists ? (s.data() || {}) : {};
      repaint();
    }).catch(function (e) { admin.share = {}; if (ctx.toast) ctx.toast('Lien média buyeuse : ' + e.message, true); repaint(); });
    capiReload(ctx, repaint);
  }
  function capiReload(ctx, repaint) {
    apiCall(ctx, 'GET', '/api/meta-capi?part=status').then(function (j) {
      admin.capi = j && j.ok ? j : { error: (j && j.error) || 'Statut indisponible' };
      repaint();
    }).catch(function (e) { admin.capi = { error: e.message }; repaint(); });
    apiCall(ctx, 'GET', '/api/meta-capi?part=journal&limit=200' + (admin.filter ? '&status=' + admin.filter : '')).then(function (j) {
      admin.journal = j && j.ok ? j.rows : [];
      repaint();
    }).catch(function () { admin.journal = []; repaint(); });
  }
  function saveCapi(ctx, patch, msg, repaint) {
    patch.updatedAt = firebase.firestore.FieldValue.serverTimestamp();
    patch.updatedBy = ctx.user.uid;
    return ctx.db.collection('_config').doc('meta_capi').set(patch, { merge: true }).then(function () {
      if (ctx.toast) ctx.toast(msg);
      capiReload(ctx, repaint);
    }).catch(function (e) { if (ctx.toast) ctx.toast('Erreur : ' + e.message, true); });
  }
  function adminAction(act, el, ctx, repaint) {
    var FV = firebase.firestore.FieldValue;
    var toast = ctx.toast || function () {};
    var ref = ctx.db.collection('_config').doc('ads_quality_access');
    if (act === 'share-copy') { copy(shareUrl(admin.share.token), toast); return; }
    if (act === 'share-new' || act === 'share-rotate') {
      if (act === 'share-rotate' && !confirm('Générer un nouveau lien ? L\'ancien cessera immédiatement de fonctionner.')) return;
      var tok = rndToken();
      ref.set({ active: true, token: tok, createdAt: FV.serverTimestamp(), createdBy: ctx.user.uid }, { merge: true }).then(function () {
        admin.share = { active: true, token: tok };
        copy(shareUrl(tok), toast);
        repaint();
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'share-off') {
      if (!confirm('Couper l\'accès de la média buyeuse ? Le lien cessera de fonctionner.')) return;
      ref.set({ active: false, token: FV.delete(), revokedAt: FV.serverTimestamp(), revokedBy: ctx.user.uid }, { merge: true }).then(function () {
        admin.share = { active: false }; toast('Accès coupé'); repaint();
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-save-code') {
      var code = String((document.getElementById('aqTestCode') || {}).value || '').trim().replace(/[^A-Za-z0-9]/g, '').slice(0, 40);
      saveCapi(ctx, { testEventCode: code }, code ? 'Code de test enregistré' : 'Code de test effacé', repaint);
      return;
    }
    if (act === 'capi-enable-test') {
      saveCapi(ctx, { enabled: true, testMode: true, testSince: FV.serverTimestamp() }, 'API Conversions activée en mode test', repaint);
      return;
    }
    if (act === 'capi-back-test') { saveCapi(ctx, { testMode: true, testSince: FV.serverTimestamp() }, 'Retour en mode test', repaint); return; }
    if (act === 'capi-disable') { saveCapi(ctx, { enabled: false }, 'API Conversions désactivée', repaint); return; }
    if (act === 'capi-prod') {
      var typed = prompt('Passage en RÉEL : les événements partiront vers Meta et nourriront l\'optimisation des pubs, à partir de maintenant (rien du passé).\n\nTape PRODUCTION pour confirmer.');
      if (typed !== 'PRODUCTION') { if (typed != null) toast('Non confirmé — toujours en mode test', true); return; }
      saveCapi(ctx, { enabled: true, testMode: false, productionSince: FV.serverTimestamp() }, 'API Conversions en RÉEL', repaint);
      return;
    }
    if (act === 'capi-run' || act === 'capi-dry') {
      if (admin.busy) return;
      admin.busy = true;
      toast(act === 'capi-dry' ? 'Calcul de ce qui partirait…' : 'Passage en cours…');
      apiCall(ctx, 'GET', '/api/meta-capi-cron' + (act === 'capi-dry' ? '?dry=1' : '')).then(function (j) {
        admin.busy = false;
        if (!j || !j.ok) { toast('Erreur : ' + ((j && j.error) || 'inconnue'), true); return; }
        if (j.skipped) admin.dry = 'Rien envoyé : ' + j.skipped + '.';
        else if (j.dry) {
          var by = {};
          (j.events || []).forEach(function (e) { by[e.event] = (by[e.event] || 0) + 1; });
          admin.dry = j.candidates + ' événement(s) candidat(s) depuis ' + new Date(j.from).toLocaleString('fr-FR') + ' : '
            + (Object.keys(by).map(function (k) { return k + ' ' + by[k]; }).join(' · ') || 'aucun') + '. Les exclusions (faux numéro, YouTube…) sont appliquées à l\'envoi.';
        } else admin.dry = 'Passage fait : ' + (j.sent || 0) + ' envoyé(s), ' + (j.errors || 0) + ' erreur(s), ' + (j.skippedOrDone || 0) + ' déjà traité(s) ou exclu(s).';
        capiReload(ctx, repaint);
      }).catch(function (e) { admin.busy = false; toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-probe') {
      if (!confirm('Envoyer à Meta un exemplaire de chacun des 10 événements, pour un contact fictif, avec le code de test (rien ne compte dans les pubs) ?')) return;
      apiCall(ctx, 'POST', '/api/meta-capi', { action: 'probe' }).then(function (j) {
        if (j && j.ok) { toast('Envoyé — regarde « Tester les événements » dans Meta'); admin.dry = 'Test envoyé : ' + (j.events || []).join(', ') + ' — Meta a reçu ' + (j.response && j.response.events_received) + ' événement(s).'; }
        else { toast('Erreur : ' + ((j && (j.error || (j.response && j.response.error))) || 'inconnue'), true); admin.dry = 'Test refusé : ' + ((j && (j.error || (j.response && j.response.error))) || 'inconnue'); }
        capiReload(ctx, repaint);
      }).catch(function (e) { toast('Erreur : ' + e.message, true); });
      return;
    }
    if (act === 'capi-journal') { capiReload(ctx, repaint); }
  }

  /* ── Montage ──────────────────────────────────────────────────────────── */
  /* Actions permises au lecteur funnel : lecture seule (dry-run, journal). */
  var RO_ACTS = { 'capi-dry': 1, 'capi-journal': 1 };
  var _el = null, _data = null, _opts = {}, _loaded = false;
  function repaint() {
    if (!_el || !_data) return;
    var sx = _el.querySelector('.aq-tw') ? _el.querySelector('.aq-tw').scrollLeft : 0;
    var h = '<div class="aq-wrap">' + headHtml(_data, _opts) + tableHtml(_data);
    if (_opts.admin) h += (admin.open && !_opts.readonly ? sharePanelHtml() : '') + capiPanelHtml();
    h += '</div>';
    _el.innerHTML = h;
    var tw = _el.querySelector('.aq-tw');
    if (tw && sx) tw.scrollLeft = sx;
  }
  function bind(el) {
    if (el.__aqBound) return;
    el.__aqBound = true;
    el.addEventListener('click', function (e) {
      var t = e.target;
      var ax = t.closest ? t.closest('[data-aq-axis]') : null;
      if (ax) { state.axis = ax.getAttribute('data-aq-axis'); repaint(); return; }
      var so = t.closest ? t.closest('[data-aq-sort]') : null;
      if (so) {
        var k = so.getAttribute('data-aq-sort');
        if (k === 'key') return;
        if (state.sort === k) state.dir = -state.dir;
        else { state.sort = k; var c = colByKey(k); state.dir = c && c.cost ? 1 : -1; }
        repaint(); return;
      }
      if (t.closest && t.closest('[data-aq-out]')) { state.showOut = !state.showOut; repaint(); return; }
      if (t.closest && t.closest('[data-aq-csv]')) { csv(_data); return; }
      if (t.closest && t.closest('[data-aq-share]')) { if (!_opts.readonly) { admin.open = !admin.open; repaint(); } return; }
      var a = t.closest ? t.closest('[data-aq-act]') : null;
      if (a && _opts.readonly && !RO_ACTS[a.getAttribute('data-aq-act')]) return;
      if (a && _opts.admin && _opts.adminCtx) adminAction(a.getAttribute('data-aq-act'), a, _opts.adminCtx, repaint);
    });
    el.addEventListener('change', function (e) {
      if (e.target && e.target.id === 'aqJFilter' && _opts.adminCtx) { admin.filter = e.target.value; capiReload(_opts.adminCtx, repaint); }
    });
  }
  function render(el, data, opts) {
    injectCss();
    _el = el; _data = data; _opts = opts || {};
    bind(el);
    if (_opts.admin && _opts.adminCtx && !_loaded) { _loaded = true; adminLoad(_opts.adminCtx, repaint); }
    repaint();
  }

  /* La page remplace l'onglet (« Chargement… » pendant un changement de
     période) : plus aucun repaint tardif (réponse des encarts admin) ne doit
     y réécrire le tableau de l'ancienne période. */
  function detach() { _el = null; _data = null; }

  root.AdsQualityTab = { render: render, detach: detach, fromKpis: fromKpis, fromShare: fromShare, costsOk: costsOk, totalCostsOk: totalCostsOk,
    totals: totals, lectureUtile: lectureUtile, csvLines: csvLines, CSV_HEAD: CSV_HEAD, COLS: COLS };
})(typeof window !== 'undefined' ? window : this);
