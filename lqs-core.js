/* ============================================================================
   lqs-core.js — QUALITÉ DES LEADS (LQS) ET DU MARKETING (MQS) — 06/11/2026
   ----------------------------------------------------------------------------
   Demande Vincent (Head of Sales) × Adrien, point stratégie du 06/11/2026 :
   piloter le business sur des données pures, sans procès d'intention.
     · LQS — Lead Quality Score : note de 1 à 5 de CHAQUE lead, calculée
       UNIQUEMENT à partir de ses réponses (quiz, formulaires) via un barème
       de points (_config/lqs_grid, édité dans l'onglet). Jamais montrée aux
       closers : c'est un outil de pilotage admin.
     · MQS — Marketing Quality Score : note de 1 à 5 d'une SOURCE (campagne,
       adset, créa, canal) = qualité des leads qu'elle amène (LQS moyen,
       60 %) + ce qu'ils rapportent vraiment (cash par lead rapporté à la
       moyenne, 40 %).
   Croisés avec la vérité commerciale déjà calculée ailleurs : RDV et leur
   résultat (bookings + chaînes de replanification), closes et cash ENCAISSÉ
   (payments, règles FunnelCore.revClient — HT, closes annulés exclus),
   closer du RDV (closeData.closerSlug → expertSlug → personId).

   AUCUNE écriture sur les leads : la note est calculée à l'affichage. Changer
   le barème recalcule tout l'historique d'un coup, sans migration.

   Dépend de funnel-core.js (window.FunnelCore) : attribution, cash, dates,
   et de stats-core.js (window.StatsCore) : état d'un RDV, closer, setter,
   taux. Utilisé par lqs-tab.js (onglet « ⭐ Qualité leads » de
   sales-funnel.html) ; la NOTE LQS (extractAnswers, scoreAnswers,
   normalizeGrid) et le contrôle des quiz (quizOverview, quizChecks) sont
   aussi lus côté serveur (api/_metaCapi.js, api/_parcoursSuite.js,
   api/ai-morning-brief.js, api/parcours-audit.js) : leur API ne change pas.

   RÉFÉRENTIEL DES CHIFFRES (audit de cohérence du 25/11/2026) — ce fichier
   ne recode plus aucune règle commerciale :
     · Closes / Contracté / Collecté « sur la période » = la LISTE UNIQUE
       FunnelCore.buildCloses (mêmes lignes que le Stats funnel ; un client =
       un close, daté du jour où il est gagné, closes annulés retirés) ;
     · « Closes des leads entrés » (glossaire closes_cohorte) = suivi de
       cohorte, à part, jamais additionné aux closes de la période ; un ancien
       client qui se réinscrit n'en est pas un ;
     · état d'un RDV, présents, pitchés, show-up, closer et setter d'un RDV,
       taux de close : StatsCore ;
     · « Leads avec RDV » / « Leads présents » comptent des LEADS (un lead une
       fois), jamais des RDV ; la vue Closers compte des RDV ;
     · « Prélevé sur la période » = FunnelCore.cashInPeriod ;
     · plafonds atteints et lectures en échec remontés (M.erreursLecture).
   ES5 strict — pas d'arrow functions, pas de template literals.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./funnel-core.js'), require('./stats-core.js'));
  else root.LqsCore = factory(root.FunnelCore, root.StatsCore);
}(typeof self !== 'undefined' ? self : this, function (FC, SC) {
  'use strict';

  var DAY = 86400000;

  /* ══ OUTILS ═══════════════════════════════════════════════════════════ */
  /* Roster reçu en tableau ou en objet { slug: membre } → tableau. */
  function teamListe(t) {
    if (!t) return [];
    if (Array.isArray(t)) return t;
    return Object.keys(t).map(function (k) {
      var m = t[k];
      if (!m || typeof m !== 'object') return null;
      if (m.slug) return m;
      var c = { slug: k };
      Object.keys(m).forEach(function (f) { c[f] = m[f]; });
      return c;
    }).filter(Boolean);
  }
  function norm(s) {
    var t = String(s == null ? '' : s);
    if (typeof t.normalize === 'function') t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t.toLowerCase().replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
  }
  function keyOf(s) { return norm(s).replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60); }
  function num(v, def) { var n = Number(v); return isFinite(n) ? n : (def == null ? 0 : def); }
  function r1(n) { return Math.round(n * 10) / 10; }
  function r2(n) { return Math.round(n * 100) / 100; }
  function clamp(n, a, b) { return n < a ? a : (n > b ? b : n); }
  function roundHalf(n) { return Math.round(n * 2) / 2; }
  function ratio(a, b) { return b > 0 ? a / b : null; }
  function isoDay(ms) { return FC.isoDate(new Date(ms)); }
  function monthKey(iso) { return String(iso || '').slice(0, 7); }

  /* ══ 1. RÉPONSES D'UN LEAD ════════════════════════════════════════════
     Une réponse = { q: clé question, ql: libellé, a: clé réponse, al: libellé,
     o: 'quiz' | 'form' }. Sources, dans l'ordre :
       · quiz « Diagnostic 4 piliers » (leads.quiz, api/lead-optin.js) :
         champs nommés, score global (tranches), puis reponses[] ;
       · formulaires (leads.formAnswers : AlteoForms, tunnels hébergés, VSL).
     Les champs de contact et les textes libres longs (> 140 car.) ne sont
     pas des réponses notables. Une question n'est comptée qu'une fois. */
  var QUIZ_NAMED = [
    { f: 'ca_mensuel', label: 'CA mensuel' },
    { f: 'objectif', label: 'Objectif' },
    { f: 'equipe', label: 'Taille de l\'équipe' },
    { f: 'heures', label: 'Heures travaillées / semaine' },
    { f: 'pilier_prioritaire', label: 'Pilier prioritaire (diagnostic)' }
  ];
  var CONTACT_RE = /e-?mail|telephone|portable|mobile|prenom|^nom$|nom complet|website|site web|linkedin|instagram/;

  function scoreBucket(g) {
    if (g < 25) return '0 – 24 %';
    if (g < 50) return '25 – 49 %';
    if (g < 75) return '50 – 74 %';
    return '75 – 100 %';
  }

  function extractAnswers(l) {
    var out = [], seenQ = {}, namedVals = {};
    /* ord = position dans le quiz (index dans reponses[]), pour afficher les
       questions dans l'ordre du parcours : champs nommés rattachés à leur
       question, formulaires après, score du diagnostic en dernier. */
    function add(qKey, qLabel, val, origin, ord) {
      if (val == null || seenQ[qKey]) return;
      if (Array.isArray(val)) val = val.filter(function (x) { return x != null && x !== ''; }).join(', ');
      if (typeof val === 'object') return;
      var v = String(val).replace(/\s+/g, ' ').trim();
      /* 140 car. max pour écarter le texte libre — sauf choix MULTIPLE
         (« A | B | C »), qui dépasse vite : 4 options cochées ≈ 200 car.
         (08/11/2026 : la réponse de Valérie Gachet à Q2 était ignorée). */
      if (!v || v.length > (/ \| /.test(v) ? 1000 : 140)) return;
      var ak = keyOf(v);
      if (!ak) return;
      seenQ[qKey] = 1;
      out.push({ q: qKey, ql: String(qLabel).slice(0, 200), a: ak, al: v, o: origin, ord: ord == null ? 999 : ord });
    }
    var qz = l && l.quiz;
    if (qz && typeof qz === 'object') {
      var reps = Array.isArray(qz.reponses) ? qz.reponses : [];
      var posOfVal = {};
      reps.forEach(function (r, i) {
        if (!r) return;
        var v0 = Array.isArray(r.reponse) ? r.reponse.join(', ') : r.reponse;
        var k0 = keyOf(v0);
        if (k0 && posOfVal[k0] == null) posOfVal[k0] = i;
      });
      QUIZ_NAMED.forEach(function (n, ni) {
        var v = qz[n.f];
        if (v == null || v === '') return;
        var pos = posOfVal[keyOf(v)];
        add('quiz_' + n.f, n.label, v, 'quiz', pos != null ? pos : 500 + ni);
        namedVals[keyOf(v)] = 1;
      });
      if (qz.score_global != null && qz.score_global !== '' && isFinite(Number(qz.score_global))) {
        add('quiz_score_global', 'Score du diagnostic', scoreBucket(Number(qz.score_global)), 'quiz', 3000);
      }
      reps.forEach(function (r, i) {
        if (!r || !r.question) return;
        var v = Array.isArray(r.reponse) ? r.reponse.join(', ') : r.reponse;
        if (v != null && namedVals[keyOf(v)]) return;       // doublon d'un champ nommé
        add('qq_' + keyOf(r.question), r.question, v, 'quiz', i);
      });
    }
    (Array.isArray(l && l.formAnswers) ? l.formAnswers : []).forEach(function (fa, i) {
      if (!fa) return;
      var lbl = fa.label || fa.fieldId;
      if (!lbl || CONTACT_RE.test(norm(lbl))) return;
      add('fa_' + keyOf(lbl), lbl, fa.value, 'form', 2000 + i);
    });
    return out;
  }

  /* Questionnaire COMPLET d'une fiche, tel que rempli (dossiers + export
     PDF) : toutes les questions du quiz dans l'ordre, puis ses résultats
     (score, piliers), puis les réponses de formulaire. Rien n'est filtré
     par longueur ; seuls les champs de contact sont écartés. */
  function questionnaireOf(l) {
    var out = [], seen = {};
    function push(q, a, kind) {
      if (a == null) return;
      if (Array.isArray(a)) a = a.filter(function (x) { return x != null && x !== ''; }).join(' · ');
      if (typeof a === 'object') return;
      var v = String(a).replace(/\s+/g, ' ').trim();
      var qq = String(q == null ? '' : q).replace(/\s+/g, ' ').trim();
      if (!v || !qq) return;
      var k = keyOf(qq) + '|' + keyOf(v);
      if (seen[k]) return;
      seen[k] = 1;
      out.push({ q: qq, a: v, kind: kind });
    }
    var qz = l && l.quiz;
    if (qz && typeof qz === 'object') {
      var vals = {};
      (Array.isArray(qz.reponses) ? qz.reponses : []).forEach(function (r) {
        if (!r || !r.question) return;
        push(r.question, r.reponse, 'quiz');
        vals[keyOf(Array.isArray(r.reponse) ? r.reponse.join(', ') : r.reponse)] = 1;
      });
      QUIZ_NAMED.forEach(function (n) {
        var v = qz[n.f];
        if (v == null || v === '' || vals[keyOf(v)]) return;
        push(n.label, v, n.f === 'pilier_prioritaire' ? 'resultat' : 'quiz');
      });
      if (qz.score_global != null && qz.score_global !== '') push('Score du diagnostic', qz.score_global + ' %', 'resultat');
      if (qz.scores && typeof qz.scores === 'object') Object.keys(qz.scores).forEach(function (k) {
        if (qz.scores[k] != null && qz.scores[k] !== '') push('Score « ' + k + ' »', qz.scores[k] + ' %', 'resultat');
      });
      if (qz.pilier_prioritaire) push('Pilier prioritaire (diagnostic)', qz.pilier_prioritaire, 'resultat');
    }
    (Array.isArray(l && l.formAnswers) ? l.formAnswers : []).forEach(function (fa) {
      if (!fa) return;
      var lbl = fa.label || fa.fieldId;
      if (!lbl || CONTACT_RE.test(norm(lbl))) return;
      push(lbl, fa.value, 'form');
    });
    return out;
  }

  /* ══ 2. BARÈME PAR DÉFAUT ══════════════════════════════════════════════
     Points proposés tant qu'un admin n'a pas noté une réponse. Seules les
     questions dont la réponse se LIT sans ambiguïté sont notées d'office :
     CA, taille d'équipe, heures, objectif. Le reste démarre à 0 : c'est
     la colonne « suggestion » (résultats réels) qui guide la notation. */
  function amounts(text) {
    var t = String(text || '').toLowerCase().replace(/[\s  .]/g, '');
    var re = /(\d+(?:,\d+)?)(k|m(?!ois))?/g, m, out = [], anyK = false;
    while ((m = re.exec(t))) {
      var n = parseFloat(m[1].replace(',', '.'));
      if (m[2] === 'k') { n *= 1000; anyK = true; }
      else if (m[2] === 'm') n *= 1000000;
      out.push({ n: n, raw: !m[2] });
    }
    /* « 40 à 50 k€ » : le k vaut pour les deux bornes. */
    if (anyK) out.forEach(function (x) { if (x.raw && x.n < 1000) x.n *= 1000; });
    return out.map(function (x) { return x.n; });
  }
  function monthlyCa(answer, qNorm) {
    var a = norm(answer);
    if (/pas encore|aucun|^0 ?€?$/.test(a)) return 0;
    var ns = amounts(a);
    if (!ns.length) return null;
    var max = Math.max.apply(null, ns), min = Math.min.apply(null, ns), v;
    if (/moins de|inferieur|jusqu|</.test(a)) v = max * 0.6;
    else if (/plus de|superieur|au-dela|>|\+/.test(a)) v = max * 1.4;
    else v = ns.length > 1 ? (min + max) / 2 : max;
    var annual = /annuel|par an|\/ ?an\b|l.annee/.test(qNorm + ' ' + a) && !/mensuel|par mois|\/ ?mois/.test(qNorm + ' ' + a);
    return annual ? v / 12 : v;
  }
  function maxCount(a) { var ns = amounts(a); return ns.length ? Math.max.apply(null, ns) : null; }

  function defaultPoints(qKey, qLabel, aLabel) {
    var qn = norm(qLabel) + ' ' + qKey, an = norm(aLabel);
    /* Réponse sur une échelle (« 3/5 ») : jamais de points par défaut. Les
       règles ci-dessous lisent des montants et des effectifs ; appliquées à
       une échelle, elles donnaient le même bonus ou malus à TOUTES les
       réponses de la question (audit du 13/11/2026 : +1 partout sur « mes
       salariés viennent me voir », −2 partout sur « mon CA dépend de moi »
       et « depuis combien de temps votre CA plafonne »). */
    if (/^\d+ ?\/ ?\d+$/.test(an)) return 0;
    if (/depuis combien de temps|depuis quand/.test(qn)) return 0;
    if (/pas (le|les) moyens|pas d.?argent|aucun budget|cherche du gratuit/.test(an)) return -2;
    if (/\bca\b|chiffre d.?affaires|ca_mensuel|fa_ca\b|fa_ca_/.test(qn)) {
      var m = monthlyCa(aLabel, qn);
      if (m != null) {
        if (m < 5000) return -2;
        if (m < 10000) return -1.5;
        if (m < 20000) return -1;
        if (m < 50000) return 1;
        if (m < 100000) return 2;
        return 3;
      }
    }
    if (/equipe|salari|collaborat|effectif/.test(qn)) {
      if (/seul|solo|aucun|juste moi|que moi/.test(an)) return -1;
      var n = maxCount(an);
      if (n != null && /plus de|\+/.test(an) && n >= 10) return 1.5;
      if (n != null) return n <= 1 ? -1 : (n <= 3 ? 0 : (n <= 10 ? 1 : 1.5));
    }
    if (/heure/.test(qn)) {
      /* Fourchette lue en son milieu : « Entre 40 et 60 h » = 50 h. */
      var hs = amounts(an);
      if (hs.length) {
        var hMax = Math.max.apply(null, hs), hMin = Math.min.apply(null, hs);
        var h = /plus de|au-dela|>|\+/.test(an) ? hMax + 5 : (/moins de|</.test(an) ? hMax * 0.8 : (hMin + hMax) / 2);
        return h >= 55 ? 0.5 : 0;
      }
    }
    if (/objectif/.test(qn)) {
      if (/doubl/.test(an)) return 0.5;
      if (/stabil|mainten|surviv/.test(an)) return -0.5;
    }
    return 0;
  }

  /* ══ 3. BARÈME (_config/lqs_grid) ══════════════════════════════════════
     { questions: { <q>: { label, off, answers: { <a>: { label, pts, ko } } } },
       thresholds: { n5, n4, n3, n2 }, updatedAt, updatedBy }
     · pts : points de la réponse (négatifs permis) ;
     · ko  : réponse éliminatoire → note 1 quel que soit le total ;
     · off : question ignorée dans le calcul.
     Note = 5 si total ≥ n5, 4 si ≥ n4, 3 si ≥ n3, 2 si ≥ n2, sinon 1.
     Une réponse jamais notée prend les points par défaut (§2). */
  var DEFAULT_THRESHOLDS = { n5: 4, n4: 2.5, n3: 1, n2: -0.5 };

  function normalizeGrid(raw) {
    var g = { questions: {}, thresholds: {} };
    var th = (raw && raw.thresholds) || {};
    ['n5', 'n4', 'n3', 'n2'].forEach(function (k) { g.thresholds[k] = num(th[k], DEFAULT_THRESHOLDS[k]); });
    var qs = (raw && raw.questions) || {};
    Object.keys(qs).forEach(function (qk) {
      var q = qs[qk] || {};
      var o = { label: q.label || qk, off: q.off === true, answers: {} };
      var as = q.answers || {};
      Object.keys(as).forEach(function (ak) {
        var a = as[ak] || {};
        o.answers[ak] = { label: a.label || ak, pts: num(a.pts, 0), ko: a.ko === true };
      });
      g.questions[qk] = o;
    });
    if (raw && raw.updatedAt) g.updatedAt = raw.updatedAt;
    if (raw && raw.updatedBy) g.updatedBy = raw.updatedBy;
    return g;
  }

  function ruleFor(grid, a) {
    var q = grid.questions[a.q];
    if (q && q.off) return { off: true };
    var r = q && q.answers[a.a];
    if (r) return { pts: r.pts, ko: r.ko, known: true };
    return { pts: defaultPoints(a.q, a.ql, a.al), ko: false, known: false };
  }

  function noteFromPoints(p, th) {
    if (p >= th.n5) return 5;
    if (p >= th.n4) return 4;
    if (p >= th.n3) return 3;
    if (p >= th.n2) return 2;
    return 1;
  }

  /* → { note: 1..5 | null, pts, ko, detail: [{ q, ql, al, pts, ko, known }] } */
  function scoreAnswers(answers, grid) {
    var pts = 0, ko = false, n = 0, detail = [];
    answers.forEach(function (a) {
      var r = ruleFor(grid, a);
      if (r.off) return;
      n++; pts += r.pts;
      if (r.ko) ko = true;
      detail.push({ q: a.q, ql: a.ql, al: a.al, pts: r.pts, ko: r.ko, known: r.known });
    });
    if (!n) return { note: null, pts: null, ko: false, detail: detail };
    pts = r1(pts);
    return { note: ko ? 1 : noteFromPoints(pts, grid.thresholds), pts: pts, ko: ko, detail: detail };
  }

  /* ══ 4. CHARGEMENT (navigateur, SDK compat, règles admin) ══════════════
     opts : { P, typeMap, closerRange: { start: Date, end: Date } }
       · cohorte = leads entrés dans la période (FunnelCore.loadLeads :
         date réelle d'entrée, + ré-optins de la période) ;
       · RDV « stables » (ne dépendent QUE de la période) : créés depuis la
         veille du début de la période (les RDV des leads de la cohorte, même
         s'ils ont lieu plus tard) + RDV DATÉS dans la période ;
       · RDV de la plage Closers (vue « par closer », mois par mois) : lus à
         part et marqués. Ils ne servent qu'à la vue Closers : changer la
         plage (3 / 6 mois) ne change JAMAIS la vue d'ensemble (audit
         25/11/2026, TRA-14 : avant, le jour d'un close suivait le RDV chargé) ;
       · closes de la période : chargeurs du Stats funnel (fiches gagnées,
         paiements rattachés, RDV porteurs) — la liste unique est construite
         par buildModel avec FunnelCore.buildCloses. Même chose pour la plage
         Closers quand elle diffère de la période ;
       · fiches manquantes (RDV de leads plus anciens, paiements, clients
         gagnés) : lues une par une ;
       · ads_creatives, ads_insights_ad, quiz_funnel_daily, booking_config
         (experts → membres), _config/lqs_grid.
     Une lecture en échec ou un plafond atteint n'est jamais muet :
     D.lectures (phrases), D.closedLeadsTruncated, D.closedLeadsError,
     D.paymentsError, D.closeBookingsError, D.plage.*. */
  function classify(b, typeMap) {
    b._class = FC.classifyBooking(b, typeMap || {});
    b._p9 = FC.phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
    b._createdMs = FC.parseFlexMs(b.createdAt);
    return b;
  }
  function errMsg(e) { return (e && e.message) || 'lecture impossible'; }
  /* Un RDV est « stable » s'il ne dépend que de la période : lu par la
     requête des RDV créés (_lqCree), par celle des RDV datés dans la période
     (_lqDateP), ou maillon d'une chaîne de report lu à part (aucune marque).
     Un RDV lu SEULEMENT pour la plage Closers (_lqPlage) ne sert qu'à elle. */
  function isStableBooking(b) { return !!(b && (b._lqCree || b._lqDateP || !b._lqPlage)); }

  function loadAll(db, opts) {
    var P = opts.P, typeMap = opts.typeMap || {};
    var CR = opts.closerRange || { start: P.start, end: P.end };
    var D = FC.emptyData();
    D.bookingsById = {}; D.bookings = []; D.extraLeads = []; D.persons = {}; D.quizDocs = []; D.gridRaw = null;
    D.lectures = [];
    D.plage = null;
    var sIso = FC.isoDate(P.start), eIso = FC.isoDate(P.end);
    var cS = FC.isoDate(CR.start), cE = FC.isoDate(CR.end);
    var plageDistincte = cS !== sIso || cE !== eIso;
    D.plageDistincte = plageDistincte;
    D.plageStart = CR.start; D.plageEnd = CR.end;

    function addBookings(tag) {
      return function (snap) {
        snap.forEach(function (doc) {
          var b = D.bookingsById[doc.id];
          if (!b) { b = doc.data() || {}; b._id = doc.id; D.bookingsById[doc.id] = classify(b, typeMap); }
          b[tag] = true;
        });
      };
    }
    function lectureKo(quoi) { return function (e) { D.lectures.push(quoi + ' : ' + errMsg(e) + '.'); }; }
    /* La veille du début : un RDV posé la veille de l'entrée d'un lead est
       encore « son » RDV (même marge que rowOfLead). */
    var debutCree = new Date(P.start.getTime() - DAY);
    var jobs = [
      FC.loadLeads(db, P, D),
      db.collection('bookings').where('createdAt', '>=', debutCree).get().then(addBookings('_lqCree'))
        .catch(lectureKo('RDV pris depuis le début de la période illisibles (RDV des leads, présents et vue Closers incomplets)')),
      db.collection('bookings').where('date', '>=', sIso).where('date', '<=', eIso).get().then(addBookings('_lqDateP'))
        .catch(lectureKo('RDV datés dans la période illisibles')),
      plageDistincte
        ? db.collection('bookings').where('date', '>=', cS).where('date', '<=', cE).get().then(addBookings('_lqPlage'))
          .catch(lectureKo('RDV de la plage Closers illisibles (vue Closers incomplète)'))
        : Promise.resolve(),
      FC.loadPayments(db, D),
      FC.loadClosedLeads(db, P, D),
      FC.loadCreatives(db, D),
      FC.loadAdsByAd(db, P, D),
      FC.loadViews(db, P, D),   // visites et formulaires par page (historique avant la mesure fine)
      /* Visites par source utm de chaque tunnel (10/11/2026, T6) : répartit la
         dépense de chaque pub sur la page où ses visites arrivent vraiment. */
      db.collection('tunnel_stats_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
        D.tunnelStats = []; snap.forEach(function (doc) { D.tunnelStats.push(doc.data() || {}); });
      }).catch(function (e) { D.tunnelStats = []; D.lectures.push('Visites par source des tunnels illisibles (dépense par quiz incomplète) : ' + errMsg(e) + '.'); }),
      db.collection('quiz_funnel_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
        snap.forEach(function (doc) { var d = doc.data() || {}; d._id = doc.id; D.quizDocs.push(d); });
      }).catch(function (e) { D.quizErr = errMsg(e); }),
      db.collection('booking_config').get().then(function (snap) {
        snap.forEach(function (doc) { var d = doc.data() || {}; if (d.__type === 'person') { d.id = doc.id; D.persons[doc.id] = d; } });
      }).catch(function (e) { D.lectures.push('Fiches d’agenda illisibles (le closer d’un RDV sans closer validé peut manquer) : ' + errMsg(e) + '.'); }),
      db.collection('_config').doc('lqs_grid').get().then(function (s) { D.gridRaw = s.exists ? s.data() : null; }),
      loadTunnelsLive(db, D)
    ];
    return Promise.all(jobs).then(function () {
      return FC.resolveChains(db, D, typeMap);
    }).then(function () {
      /* Paiements sans fiche gagnée : la règle du Stats funnel (chemin ③ de
         la liste unique). */
      return FC.resolvePaymentLeads(db, P, D);
    }).then(function () {
      return FC.loadCloseBookings(db, D, typeMap);
    }).then(function () {
      return plageDistincte ? loadPlage(db, D, CR, typeMap) : null;
    }).then(function () {
      D.bookings = Object.keys(D.bookingsById).map(function (k) { return D.bookingsById[k]; });
      return loadMissingLeads(db, D, P);
    }).then(function () { return D; });
  }

  /* Closes de la plage Closers (quand elle diffère de la période) : mêmes
     chargeurs que la période, sur des COPIES des paiements (le rattachement
     d'un paiement dépend de la période : resolvePaymentLeads l'écrit sur le
     paiement). */
  function loadPlage(db, D, CR, typeMap) {
    var R = { start: CR.start, end: CR.end, closedLeads: [], closeBookings: {}, payments: [] };
    R.payments = (D.payments || []).map(function (p) {
      var c = {};
      Object.keys(p).forEach(function (k) { c[k] = p[k]; });
      c._payClose = null; c._matched = false;
      return c;
    });
    D.plage = R;
    return FC.loadClosedLeads(db, { start: CR.start, end: CR.end }, R).then(function () {
      return FC.resolvePaymentLeads(db, { start: CR.start, end: CR.end }, R);
    }).then(function () {
      return FC.loadCloseBookings(db, R, typeMap);
    }).catch(function (e) { R.erreur = errMsg(e); });
  }

  /* Tunnels avec leurs STATUTS (tunnels/{id}, lecture admin) : la vue Quiz
     ne montre que les versions réellement servies aujourd'hui — tunnel,
     étape et variante « live », rien d'archivé (même règle que
     api/_tunnelRegistry.js). Même forme que FunnelCore tunnelsMeta
     (name, source, steps[slug].variants[id].label) + statuts. */
  function loadTunnelsLive(db, D) {
    D.tunnels = {};
    return db.collection('tunnels').get().then(function (snap) {
      snap.forEach(function (doc) {
        var t = doc.data() || {};
        if (!t.slug) return;
        var steps = {};
        (t.steps || []).forEach(function (st) {
          if (!st || !st.slug) return;
          var vars = {};
          (st.variants || []).forEach(function (v) {
            if (!v || !v.id) return;
            vars[String(v.id)] = { label: v.label || '', live: v.status === 'live' && v.archived !== true, weight: Number(v.weight) || 0 };
          });
          steps[String(st.slug)] = { name: st.name || st.slug, source: st.trackingSource || '', variants: vars,
            live: st.status === 'live' && st.archived !== true };
        });
        D.tunnels[String(t.slug)] = { name: t.name || t.slug, source: (t.settings && t.settings.trackingSource) || '', steps: steps,
          live: t.status === 'live' && t.archived !== true && t.kind !== 'test' };
      });
    }).catch(function (e) { D.tunnelsErr = e && e.message ? e.message : 'erreur'; });
  }

  /* Fiches référencées par un RDV, un paiement ou un close, absentes de la
     cohorte. Les fiches gagnées (D.closedLeads) et celles repérées par un
     paiement (_payClose.lead) sont déjà lues : reprises telles quelles. Une
     fiche lue SEULEMENT pour un RDV de la plage Closers est marquée
     _lqPlageSeule : elle ne sert qu'à la vue Closers. */
  function loadMissingLeads(db, D, P) {
    var known = {};
    (D.leads || []).concat(D.reoptins || []).forEach(function (l) { known[l._id] = 1; });
    var out = [];
    D.extraLeadsEchecs = 0;
    function keepLead(id, d, plageSeule) {
      if (!id || known[id] || !d || d._merged === true) return;
      known[id] = 1;
      d._id = id;
      d._entry = FC.realEntryMs(d);
      d._p9 = FC.phone9(d.telephone || d.phone);
      d._extra = true;
      if (plageSeule) d._lqPlageSeule = true;
      out.push(d);
    }
    (D.closedLeads || []).forEach(function (l) { keepLead(l._id, l, false); });
    (D.payments || []).forEach(function (p) { var l = p && p._payClose && p._payClose.lead; if (l) keepLead(l._id, l, false); });
    var want = {}, wantStable = {};
    D.bookings.forEach(function (b) {
      if (!SC.estRdvVente(b._class) || !b.leadId || known[b.leadId]) return;
      want[b.leadId] = 1;
      if (isStableBooking(b)) wantStable[b.leadId] = 1;
    });
    var pS = P.start.getTime(), pE = P.end.getTime();
    (D.payments || []).forEach(function (p) {
      if (!p || !p.leadId || known[p.leadId]) return;
      var inPeriod = FC.revPaidEntries(p).some(function (e) { return e.ms != null && e.ms >= pS && e.ms <= pE; });
      var cMs = FC.parseFlexMs(p.createdAt);
      if (!inPeriod && p.status !== 'draft' && p.status !== 'cancelled' && cMs != null && cMs >= pS && cMs <= pE) inPeriod = true;
      if (inPeriod) { want[p.leadId] = 1; wantStable[p.leadId] = 1; }
    });
    var ids = Object.keys(want).filter(function (id) { return !known[id]; });
    function batch(i) {
      if (i >= ids.length) {
        D.extraLeads = out;
        if (D.extraLeadsEchecs) D.lectures.push(D.extraLeadsEchecs + ' fiche' + (D.extraLeadsEchecs > 1 ? 's' : '') + ' de lead illisible' + (D.extraLeadsEchecs > 1 ? 's' : '') + ' (RDV ou paiements de leads plus anciens) : leur note manque.');
        return Promise.resolve();
      }
      var chunk = ids.slice(i, i + 40);
      return Promise.all(chunk.map(function (id) {
        return db.collection('leads').doc(id).get().then(function (s) {
          if (!s.exists) return;
          keepLead(s.id, s.data() || {}, !wantStable[id]);
        }).catch(function () { D.extraLeadsEchecs++; });
      })).then(function () { return batch(i + 40); });
    }
    return batch(0);
  }

  /* ══ 5. MODÈLE ═════════════════════════════════════════════════════════
     État d'un RDV (annulé, no-show, présent, pitché, à statuer, à venir,
     replanifié, doublon) : StatsCore.etat / StatsCore.detail — plus aucune
     copie locale (audit 25/11/2026, LQS-13 : un RDV replanifié sans
     remplaçant chargé n'était dans aucune colonne). */
  function ocOf(b) { return (b && b.outcome) || null; }
  var CLASSE_COURTE = { self: 'self', setter: 'setter', admin: 'manuel' };

  /* Offre vendue d'un close (06/11/2026) : closeData.offre ('Elite' |
     'BP 12' = Business Phénix) ou offreLabel ('Elite' | 'Business'), posés
     par CloseWizard.persist ; copie sur la fiche (leads.closedData). Rien
     d'écrit → null (« offre non renseignée »), jamais déduit du montant. */
  function offerOf(cd) {
    if (!cd) return null;
    var t = norm((cd.offreLabel || '') + ' ' + (cd.offre || ''));
    if (/elite/.test(t)) return 'elite';
    if (/business|\bbp\b|phenix/.test(t)) return 'business';
    return null;
  }

  /* Agrégat PAR LEAD (un lead compte une fois). Noms sans ambiguïté
     (25/11/2026) ; les anciens noms restent écrits à l'identique tant que
     lqs-tab.js les lit :
       leadsAvecRdv  (ancien booked)   leads qui ont au moins un RDV de vente
       leadsPresents (ancien present)  leads venus à au moins un RDV
       leadsNoShow   (ancien noshow), leadsAnnules (ancien cancelled : tous
       leurs RDV annulés), leadsPitches (ancien pitched)
       closes / con / cash = CLOSES DES LEADS ENTRÉS (glossaire
       closes_cohorte) : alias closesCohorte / contracteCohorte /
       collecteCohorte. Jamais additionnés aux closes de la période.
       closesSansRdv   closes de leads sans aucun RDV de vente enregistré
       closesLeadsAvecRdv / closesLeadsPresents : numérateurs des taux de
       close par lead (un close sans RDV n'y entre pas : ≤ 100 %).
       nouveaux + reopt = leads (nouveaux leads + ré-optins). */
  function newAgg() {
    return { leads: 0, nouveaux: 0, reopt: 0, noted: 0, noteSum: 0, n45: 0, n12: 0, dist: [0, 0, 0, 0, 0, 0],
      leadsAvecRdv: 0, leadsPresents: 0, leadsNoShow: 0, leadsAnnules: 0, leadsPitches: 0, dejaClients: 0,
      booked: 0, present: 0, noshow: 0, cancelled: 0, pitched: 0,
      closes: 0, cash: 0, con: 0, pending: 0, closesSansRdv: 0, closesLeadsAvecRdv: 0, closesLeadsPresents: 0,
      closesE: 0, closesB: 0, closesU: 0, cashE: 0, cashB: 0, cashU: 0, conE: 0, conB: 0, conU: 0,
      teamN: 0, teamSum: 0, rdv: 0 };
  }
  function addNote(a, note) {
    if (note == null) { a.dist[0]++; return; }
    a.noted++; a.noteSum += note; a.dist[note]++;
    if (note >= 4) a.n45++;
    if (note <= 2) a.n12++;
  }
  function addLeadRow(a, r) {
    a.leads++;
    if (r.reopt) a.reopt++; else a.nouveaux++;
    addNote(a, r.note);
    if (r.avecRdv) { a.leadsAvecRdv++; a.booked++; }
    if (r.leadPresent) { a.leadsPresents++; a.present++; }
    if (r.noshow) { a.leadsNoShow++; a.noshow++; }
    if (r.allCancelled) { a.leadsAnnules++; a.cancelled++; }
    if (r.pitched) { a.leadsPitches++; a.pitched++; }
    if (r.dejaClient) a.dejaClients++;
    if (r.closed) {
      a.closes++; a.cash += r.cash; a.con += r.con; a.pending += r.pending || 0;
      if (!r.avecRdv) a.closesSansRdv++;
      else a.closesLeadsAvecRdv++;
      if (r.leadPresent) a.closesLeadsPresents++;
      if (r.offer === 'elite') { a.closesE++; a.cashE += r.cash; a.conE += r.con; }
      else if (r.offer === 'business') { a.closesB++; a.cashB += r.cash; a.conB += r.con; }
      else { a.closesU++; a.cashU += r.cash; a.conU += r.con; }
    }
    if (r.team != null) { a.teamN++; a.teamSum += r.team; }
  }
  /* Taux : chacun dit son unité (par lead) et se refait avec deux nombres
     exposés à côté de lui. Taux de close : StatsCore.tauxClose. */
  function fin(a) {
    a.cash = r2(a.cash); a.con = r2(a.con); a.pending = r2(a.pending || 0);
    a.cashE = r2(a.cashE); a.cashB = r2(a.cashB); a.cashU = r2(a.cashU);
    a.conE = r2(a.conE); a.conB = r2(a.conB); a.conU = r2(a.conU);
    a.avgNote = a.noted ? r2(a.noteSum / a.noted) : null;
    a.pct45 = a.noted ? a.n45 / a.noted * 100 : null;
    a.pct12 = a.noted ? a.n12 / a.noted * 100 : null;
    /* Leads avec RDV ÷ leads ; leads présents ÷ leads avec RDV. */
    a.pctLeadsAvecRdv = SC.pct(a.leadsAvecRdv, a.leads);
    a.pctLeadsPresents = SC.pct(a.leadsPresents, a.leadsAvecRdv);
    /* Taux de close PAR LEAD : closes parmi les leads présents ÷ leads
       présents ; closes parmi les leads avec RDV ÷ leads avec RDV ; closes ÷
       leads. */
    a.tauxCloseLeadsPresents = SC.tauxClose(a.closesLeadsPresents, a.leadsPresents);
    a.tauxCloseLeadsAvecRdv = SC.tauxClose(a.closesLeadsAvecRdv, a.leadsAvecRdv);
    a.tauxCloseLeads = SC.tauxClose(a.closes, a.leads);
    /* Alias (anciens noms lus par lqs-tab.js) — mêmes valeurs. */
    a.bookRate = a.pctLeadsAvecRdv;
    a.showRate = a.pctLeadsPresents;
    a.closePresent = a.tauxCloseLeadsPresents;
    a.closeRdv = a.tauxCloseLeadsAvecRdv;
    a.closeLead = a.tauxCloseLeads;
    a.closesCohorte = a.closes; a.contracteCohorte = a.con; a.collecteCohorte = a.cash;
    a.cashPerLead = a.leads ? a.cash / a.leads : null;
    a.cashPerClient = a.closes ? a.cash / a.closes : null;
    /* SIGNÉ (08/11/2026, validé Adrien) = CONTRACTÉ : montant HT du contrat
       (paiements non annulés, sinon carte du close). C'est lui qui juge la
       valeur d'un lead (MQS, suggestions, « / lead ») : le collecté arrive
       avec le préavis SEPA et s'étale sur 12 mensualités. */
    a.conPerLead = a.leads ? a.con / a.leads : null;
    a.conPerClient = a.closes ? a.con / a.closes : null;
    a.teamAvg = a.teamN ? r2(a.teamSum / a.teamN) : null;
    return a;
  }

  /* RDV d'UN lead (un lead compte une fois) — règle unique de « Leads avec
     RDV » / « Leads présents », exportée pour les autres écrans (onglet
     👥 Leads du Stats funnel : LqsCore.leadRdv).
       · RDV de vente (StatsCore.estRdvVente : Self Booking, Setting,
         Manuel), têtes de chaîne seulement (un report ou un transfert n'est
         pas un nouveau RDV : StatsCore.estRemplacant ; un doublon supprimé
         ne compte pas), posés depuis l'entrée du lead, veille comprise
         (floorMs), sans borne de fin (suivis jusqu'à aujourd'hui) ;
       · issue lue sur le RDV TERMINAL de la chaîne (FunnelCore.rdvTerminal :
         reports et transferts), état et détail par StatsCore ;
       · un client closé sans aucun RDV n'est ni « avec RDV » ni « présent ».
     bookingsOfLead : RDV rattachés à la fiche (n'importe quel ordre) ;
     bookingsById : pour suivre les chaînes ; now : millisecondes.
     → { heads, avecRdv, present, noshow, pitched, closeOc, allCancelled,
         upcoming, aStatuer, rdvManuel, pick (RDV retenu : un close d'abord,
         sinon le dernier présent, sinon le premier), bookedBy ('self' |
         'setter' | 'manuel' | null) } */
  function rdvDuLead(bookingsOfLead, floorMs, bookingsById, now) {
    now = now || Date.now();
    var floor = floorMs == null ? -Infinity : floorMs;
    var heads = (bookingsOfLead || []).filter(function (b) {
      if (!b || !SC.estRdvVente(b._class || SC.classifyBooking(b, {}))) return false;
      if (SC.estRemplacant(b) || SC.estDoublon(b)) return false;
      var c = b._createdMs != null ? b._createdMs : FC.parseFlexMs(b.createdAt);
      return c == null || c >= floor;
    }).sort(function (a, b) { return (a._createdMs || 0) - (b._createdMs || 0); });
    var o = { heads: heads, avecRdv: heads.length > 0, present: false, noshow: false, pitched: false, closeOc: false,
      allCancelled: heads.length > 0, upcoming: false, aStatuer: false, rdvManuel: false, pick: null,
      bookedBy: heads.length ? (CLASSE_COURTE[heads[0]._class || SC.classifyBooking(heads[0], {})] || null) : null };
    var pickRank = 0;
    heads.forEach(function (h) {
      var t = FC.rdvTerminal(h, bookingsById || {}) || h;
      var e = SC.etat(t, now), d = SC.detail(t);
      if ((h._class || SC.classifyBooking(h, {})) === 'admin') o.rdvManuel = true;
      if (e !== 'annule') o.allCancelled = false;
      if (e === 'no_show') o.noshow = true;
      if (e === 'present') o.present = true;
      if (d === 'offre' || d === 'close' || d === 'non_close') o.pitched = true;
      if (d === 'close') o.closeOc = true;
      if (e === 'a_venir') o.upcoming = true;
      if (e === 'a_statuer') o.aStatuer = true;
      var rank = d === 'close' ? 3 : (e === 'present' ? 2 : 1);
      if (!o.pick || rank > pickRank || (rank === pickRank && rank >= 2)) { o.pick = t; pickRank = rank; }
    });
    return o;
  }
  /* Raccourci : RDV d'une fiche, plancher = date réelle d'entrée − 1 jour. */
  function leadRdv(lead, bookingsOfLead, bookingsById, now) {
    var e = lead ? (lead._cohortEntry != null ? lead._cohortEntry : (lead._entry != null ? lead._entry : FC.realEntryMs(lead))) : null;
    return rdvDuLead(bookingsOfLead, e != null ? e - DAY : null, bookingsById, now);
  }

  var MODEL_SEQ = 0;

  /* Une ligne de la liste unique des closes → entrée de l'onglet. */
  function closeEntry(row, extra) {
    var rv = row.rv || {};
    var o = { key: row.key, leadId: row.leadId || null, name: row.name || '—', day: row.day, ms: row.ms,
      src: row.src, signal: row.signal || null, sb: !!row.sb, canal: row.canal, canalSrc: row.canalSrc, canalEcart: !!row.canalEcart,
      closer: row.closer || null, setter: row.setter || null, bookingId: row.bookingId || null, rdvDate: row.rdvDate || '',
      cancelled: !!rv.cancelled, reason: rv.reason || null,
      con: Number(rv.con) || 0, cash: Number(rv.paid) || 0, paid: Number(rv.paid) || 0, pending: Number(rv.pending) || 0,
      sansPaiement: !rv.hasPay, row: row };
    if (extra) Object.keys(extra).forEach(function (k) { o[k] = extra[k]; });
    return o;
  }

  /* ctx : { P, grid (normalisé), gridStamp, tunnelFilter, sourceFilter,
             teamMembers, closerRange, tunnelsMeta,
             funnelCloses (facultatif : K.closeRows du Stats funnel — mêmes
               lignes, déjà filtrées tunnel / source ; sinon la liste est
               construite ici par FunnelCore.buildCloses),
             teamFull (facultatif : roster COMPLET, anciens membres compris,
               tableau ou objet — pour l'hôte d'un RDV),
             resoudrePersonne (facultatif : personId d'une fiche d'agenda →
               slug du membre ; sinon StatsCore.resoudreHote sur les fiches
               d'agenda lues et le roster complet),
             now (facultatif : millisecondes, tests) } */
  function buildModel(D, ctx) {
    var grid = ctx.grid;
    var P = ctx.P;
    var now = ctx.now || Date.now();
    var TEAM = ctx.teamMembers || [];
    var typeMap = ctx.typeMap || {};
    var stamp = (ctx.gridStamp || 0) + '#' + (++MODEL_SEQ);
    var bySlug = {};
    TEAM.forEach(function (m) {
      if (!m || !m.slug) return;
      bySlug[m.slug] = m;
    });
    function memberName(slug) { var m = bySlug[slug]; return m ? (m.shortName || m.displayName || slug) : slug; }
    function isDeparted(slug) {
      /* Membres partis (nav.js, DEPARTED) : exclus de tout affichage nominatif,
         leurs RDV et leurs closes restent comptés (ligne « Anciens membres »). */
      var m = bySlug[slug];
      if (typeof window !== 'undefined' && typeof window.isDepartedMember === 'function') {
        try { if (window.isDepartedMember(m || slug)) return true; } catch (e) {}
      }
      if (m && m.departed === true) return true;
      /* Même règle que AlteoreFlow.isDeparted : drapeau de la fiche, fiche
         archivée avec une date de fin, ou liste historique (StatsCore). */
      return !!(SC.estParti && SC.estParti(m || null, slug));
    }
    /* VUE CLOSERS — rangement d'une personne (revue D10, 25/11/2026) : LA
       règle commune StatsCore.rangPersonne, comme Global closing
       (sales-closing.html, bucketOf). Onglet = closer de l'équipe sales
       (rôle closer / closer_setter, actif, pas parti) ; sinon « Non
       attribué » avec la précision : « Anciens membres », « Prénom (hors
       onglets) » (admin, setter, autre rôle), « Prénom (avant son arrivée) »
       (élément daté avant sa startDate). jour = date du RDV pour un RDV,
       jour du close pour un close. ctx.rangCloser(slug, jour) peut fournir
       la règle de la page (même retour { key, precision, cas }). */
    var CLOSER_ROLES = { closer: 1, closer_setter: 1 };
    function aOngletCloser(slug) {
      var m = slug ? bySlug[slug] : null;
      return !!(m && m.active !== false && CLOSER_ROLES[m.role] && !isDeparted(slug));
    }
    function debutDe(slug) {
      var m = bySlug[slug], v = m && m.startDate;
      return (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) ? v : null;
    }
    function rangLocal(slug, jour) {
      return SC.rangPersonne(slug || null, jour || null, { parti: isDeparted, aOnglet: aOngletCloser, prenom: memberName, debut: debutDe });
    }
    var rangCloser = typeof ctx.rangCloser === 'function' ? ctx.rangCloser : rangLocal;
    /* Pose rangKey / rangPrecision sur une entrée (RDV ou close). */
    function ranger(o, jour) {
      var r = rangCloser(o.closer || null, jour || null) || {};
      o.rangKey = r.key || SC.NON_ATTRIBUE;
      o.rangPrecision = r.precision || '';
      o.rangCas = r.cas || (o.closer ? 'onglet' : 'inconnu');
      return o;
    }
    /* Hôte d'un RDV : LA règle commune StatsCore.resoudreHote (compte relié
       à la fiche d'agenda AVANT l'égalité personId == slug — fiche reprise,
       27/11/2026), sur le roster COMPLET : liste de la page + ctx.teamFull
       (anciens membres compris : window.TEAM_MEMBERS, tableau ou objet). */
    var resoudreLocal = SC.resoudreHote(D.persons || {}, TEAM.concat(teamListe(ctx.teamFull)));
    var resoudre = typeof ctx.resoudrePersonne === 'function' ? ctx.resoudrePersonne : resoudreLocal;
    function closerOfRdv(b) { return b ? SC.closerDuRdv(b, resoudre) : null; }

    /* Index des fiches. allLeads : cohorte + fiches « stables » (ne
       dépendent que de la période). Les fiches lues pour la seule plage
       Closers sont indexées à part (plageLeads). */
    var cohort = [];
    var allLeads = {}, plageLeads = {};
    var byEmail = {}, byP9 = {};
    function indexLead(l) {
      if (!l || allLeads[l._id]) return;
      allLeads[l._id] = l;
      var em = String(l.email || '').toLowerCase().trim();
      if (em && !byEmail[em]) byEmail[em] = l;
      if (l._p9 && !byP9[l._p9]) byP9[l._p9] = l;
    }
    (D.leads || []).forEach(function (l) { l._reopt = false; l._cohorte = true; indexLead(l); cohort.push(l); });
    (D.reoptins || []).forEach(function (l) {
      l._reopt = true; l._cohorte = true;
      var lo = FC.parseFlexMs(l.lastOptinAt);
      if (lo != null) l._cohortEntry = lo;
      indexLead(l); cohort.push(l);
    });
    (D.extraLeads || []).forEach(function (l) { if (l._lqPlageSeule) plageLeads[l._id] = l; else indexLead(l); });

    function leadOfBooking(b, avecPlage) {
      if (b.leadId && allLeads[b.leadId]) return allLeads[b.leadId];
      if (avecPlage && b.leadId && plageLeads[b.leadId]) return plageLeads[b.leadId];
      if (b._p9 && byP9[b._p9]) return byP9[b._p9];
      var em = String(b.prospect && b.prospect.email || '').toLowerCase().trim();
      if (em && byEmail[em]) return byEmail[em];
      return null;
    }

    /* Note de chaque fiche (mise en cache sur la fiche, par version de barème) */
    var gridStamp = ctx.gridStamp || 0;
    function scoreLead(l) {
      if (l._lqsStamp === gridStamp && l._lqs) return l._lqs;
      if (!l._answers) l._answers = extractAnswers(l);
      l._lqs = scoreAnswers(l._answers, grid);
      l._lqsStamp = gridStamp;
      return l._lqs;
    }

    /* RDV de vente par fiche (Self Booking, Setting, Manuels :
       StatsCore.estRdvVente). Seuls les RDV « stables » servent aux leads :
       la plage Closers ne change rien ici. Les RDV porteurs des closes
       (D.closeBookings) complètent la liste des appels de la fiche. */
    var bkByLead = {};
    var stableBookings = [], venteBookings = [];
    var bookingById = {};
    D.bookings.forEach(function (b) {
      bookingById[b._id] = b;
      if (!SC.estRdvVente(b._class)) return;
      venteBookings.push(b);
      b._lead = leadOfBooking(b, true);
      if (!isStableBooking(b)) return;
      stableBookings.push(b);
      var l = leadOfBooking(b, false);
      if (!l) return;
      (bkByLead[l._id] = bkByLead[l._id] || []).push(b);
    });
    function addCloseBookings(map) {
      Object.keys(map || {}).forEach(function (id) {
        (map[id] || []).forEach(function (b) {
          if (!b || !b._id || bookingById[b._id]) return;
          bookingById[b._id] = b;
          if (!b._class) b._class = SC.classifyBooking(b, typeMap);
          if (!SC.estRdvVente(b._class)) return;
          var l = allLeads[id];
          if (!l) return;
          (bkByLead[l._id] = bkByLead[l._id] || []).push(b);
        });
      });
    }
    addCloseBookings(D.closeBookings);

    /* Filtres de la page (tunnel / source) — mêmes règles que le Stats
       funnel (filtres de buildCloses). */
    var tf = ctx.tunnelFilter && ctx.tunnelFilter !== 'all' ? ctx.tunnelFilter : null;
    var sf = (ctx.sourceFilter === 'youtube' || ctx.sourceFilter === 'other') ? ctx.sourceFilter : null;
    var META = ctx.tunnelsMeta || null;
    function srcMatch(s) { return !sf || (sf === 'youtube' ? s === 'youtube' : s !== 'youtube'); }
    function leadPasses(l) {
      if (tf && FC.leadTunnel(l) !== tf) return false;
      if (sf && !srcMatch(FC.leadSource(l, META))) return false;
      return true;
    }
    function rdvPasses(b, l) {
      if (!tf && !sf) return true;
      if (l) return leadPasses(l);
      if (tf) return false;
      return srcMatch(FC.bookingSource ? FC.bookingSource(b, META) : 'other');
    }
    function payCloseOk(pc) {
      if (pc.tunnel && tf && pc.tunnel !== tf) return false;
      if (!pc.tunnel && tf) return false;
      return srcMatch(pc.lead ? FC.leadSource(pc.lead, META) : 'other');
    }
    var filtresActifs = !!(tf || sf);

    /* ══ CLOSES DE LA PÉRIODE — la liste unique (référentiel §4) ══
       Mêmes lignes que le Stats funnel : K.closeRows quand la page le
       fournit, sinon FunnelCore.buildCloses sur les données déjà chargées. */
    var CLp, closesSource;
    if (Array.isArray(ctx.funnelCloses)) {
      closesSource = 'funnel';
      CLp = { rows: [], annules: [], sansSignal: [], ecartsCanal: [], autres: [] };
      ctx.funnelCloses.forEach(function (r) {
        if (!r) return;
        if (r.rv && r.rv.cancelled) CLp.annules.push(r);
        else { CLp.rows.push(r); if (r.canalEcart) CLp.ecartsCanal.push(r); }
      });
    } else {
      closesSource = 'local';
      CLp = FC.buildCloses({
        closedLeads: D.closedLeads || [], bookings: stableBookings, closeBookings: D.closeBookings || {},
        payments: D.payments || [], typeMap: typeMap, start: P.start, end: P.end,
        leadOk: leadPasses, rdvOk: function (b) { return rdvPasses(b, leadOfBooking(b, false)); }, payCloseOk: payCloseOk,
        resoudrePersonne: resoudre
      });
    }

    /* ══ CLOSES DES LEADS ENTRÉS (cohorte, glossaire closes_cohorte) ══
       Même règle qu'un close de la liste unique (signal de vente exigé,
       date = jour où le client est gagné, closes annulés à part), sans
       borne de fin : un lead entré en novembre et gagné en décembre est un
       close de la cohorte de novembre. Ne compte que si le close est
       POSTÉRIEUR à l'entrée du lead (veille comprise) : un ancien client qui
       se réinscrit n'est pas un close de la cohorte (« déjà client »). Un
       lead sans clientSince ne devient close de la cohorte que par un
       paiement non annulé créé après son entrée (règle ③ de la liste). */
    function floorOf(l) {
      var e = l._cohortEntry != null ? l._cohortEntry : (l._entry != null ? l._entry : FC.realEntryMs(l));
      return e != null ? e - DAY : -Infinity;
    }
    var cohortById = {};
    cohort.forEach(function (l) { cohortById[l._id] = l; });
    /* Sans borne de fin : jusqu'à aujourd'hui (une date client posée plus
       tard, même dans le futur, reste un close de la cohorte). */
    var cohEnd = new Date(Math.max(now, P.end.getTime()) + 3650 * DAY);
    var cohStart = new Date(P.start.getTime() - DAY);
    var cohWon = [], cohSeen = {};
    cohort.forEach(function (l) {
      var cs = FC.parseFlexMs(l.clientSince);
      if (cs != null && cs >= cohStart.getTime()) { cohSeen[l._id] = 1; cohWon.push(l); }
    });
    (D.closedLeads || []).forEach(function (l) { if (l && !cohSeen[l._id]) { cohSeen[l._id] = 1; cohWon.push(l); } });
    var cohPayments = (D.payments || []).map(function (p) {
      var c = {};
      Object.keys(p).forEach(function (k) { c[k] = p[k]; });
      c._payClose = null; c._matched = false;
      if (p.status === 'draft' || p.status === 'cancelled') return c;
      var l = (p.leadId && cohortById[p.leadId]) || null;
      if (!l && p.leadId && allLeads[p.leadId]) return c;          /* paiement d'une autre fiche connue */
      if (!l) {
        var em = String(p.leadEmail || '').toLowerCase().trim(), p9 = FC.phone9(p.leadPhone);
        var cand = (em && byEmail[em]) || (p9 && byP9[p9]) || null;
        if (cand && cohortById[cand._id]) l = cand;
      }
      if (!l || l._merged === true) return c;
      if (FC.parseFlexMs(l.clientSince) != null) return c;          /* fiche gagnée : règle ① */
      var cMs = FC.parseFlexMs(p.createdAt);
      if (cMs == null || cMs < floorOf(l) || cMs > cohEnd.getTime()) return c;
      c._payClose = { kind: 'count', name: l.nom || p.leadName || p.leadEmail || '—', sb: l.stage === 'closed_won_self',
        tunnel: FC.leadTunnel(l), noLead: false, lead: l };
      return c;
    });
    var cohCloseBk = {};
    Object.keys(bkByLead).forEach(function (id) {
      bkByLead[id].forEach(function (b) { if (b.outcome === 'close') (cohCloseBk[id] = cohCloseBk[id] || []).push(b); });
    });
    var CLc = FC.buildCloses({
      closedLeads: cohWon, bookings: [], closeBookings: cohCloseBk, payments: cohPayments, typeMap: typeMap,
      start: cohStart, end: cohEnd, resoudrePersonne: resoudre
    });
    var cohRowByLead = {};
    CLc.toutes.forEach(function (row) {
      var l = row.leadId && cohortById[row.leadId];
      if (!l || row.ms < floorOf(l)) return;
      if (!cohRowByLead[row.leadId]) cohRowByLead[row.leadId] = row;
    });
    var cohSansSignal = {};
    CLc.sansSignal.forEach(function (x) { if (x.leadId && cohortById[x.leadId]) cohSansSignal[x.leadId] = 1; });
    /* Lignes de la période, par fiche (fiches hors cohorte : leur issue
       dans les dossiers vient de la liste de la période). */
    var perRowByLead = {};
    (CLp.rows.concat(CLp.annules)).forEach(function (row) { if (row.leadId && !perRowByLead[row.leadId]) perRowByLead[row.leadId] = row; });

    function carrierOf(row) {
      var b = row && row.bookingId ? bookingById[row.bookingId] : null;
      if (b) return b;
      var lst = row && row.leadId ? ((D.closeBookings || {})[row.leadId] || []) : [];
      for (var i = 0; i < lst.length; i++) if (lst[i] && lst[i]._id === row.bookingId) return lst[i];
      return null;
    }
    function offerOfRow(row, l) {
      var c = carrierOf(row);
      return offerOf(c && c.closeData) || offerOf(l && l.closedData) || offerOf(row && row.lead && row.lead.closedData);
    }

    var CRE_IDX = FC.buildCreativeIndex(D.creatives || []);

    function rowOfLead(l) {
      if (l._row && l._rowStamp === stamp) return l._row;
      var sc = scoreLead(l);
      var entry = l._cohortEntry != null ? l._cohortEntry : (l._entry != null ? l._entry : FC.realEntryMs(l));
      var floor = entry != null ? entry - DAY : -Infinity;
      /* RDV de la fiche : règle unique leadRdv (exportée, LqsCore.leadRdv). */
      var lr0 = rdvDuLead(bkByLead[l._id] || [], floor, D.bookingsById, now);
      var heads = lr0.heads, pick = lr0.pick;
      var r = { id: l._id, lead: l, note: sc.note, pts: sc.pts, ko: sc.ko, detail: sc.detail,
        answers: l._answers || [], entry: entry, reopt: !!l._reopt, cohorte: !!l._cohorte,
        avecRdv: lr0.avecRdv, booked: lr0.avecRdv,
        leadPresent: lr0.present, present: lr0.present, noshow: lr0.noshow, pitched: lr0.pitched, closeOc: lr0.closeOc,
        allCancelled: lr0.allCancelled, upcoming: lr0.upcoming, aStatuer: lr0.aStatuer, rdvManuel: lr0.rdvManuel,
        closed: false, closeCancelled: false, closeSansRdv: false, dejaClient: false, sansVenteEnregistree: false,
        cash: 0, con: 0, pending: 0, closeDay: null, closeSrc: null, closeKey: null, closePeriode: null,
        offer: null, closer: null, rdvDate: null, rdvId: null, rdvEtat: null, rdvDetail: null, rdvOutcome: null,
        team: (l.leadScore >= 1 && l.leadScore <= 5) ? Number(l.leadScore) : null,
        bookedBy: lr0.bookedBy };
      if (pick) {
        r.rdvId = pick._id || null; r.rdvDate = pick.date || null; r.rdvOutcome = ocOf(pick);
        r.rdvEtat = SC.etat(pick, now); r.rdvDetail = SC.detail(pick);
        r.closer = closerOfRdv(pick);
      }
      /* Appels de vente de la fiche (dossiers + export PDF, 13/11/2026) :
         tous ses RDV de vente, du plus ancien au plus récent, avec l'état du
         replay Meet (transcription lue à la demande par api/replay-closing). */
      r.calls = (bkByLead[l._id] || []).slice().sort(function (a, b) {
        return String(a.date || '').localeCompare(String(b.date || '')) || String(a.time || '').localeCompare(String(b.time || ''));
      }).map(function (b) {
        var rp = b.replay || {}, cs = closerOfRdv(b), e = SC.etat(b, now);
        return { id: b._id, date: b.date || null, time: b.time || null, outcome: ocOf(b), status: b.status || null,
          etat: e, detail: SC.detail(b),
          present: e === 'present', noshow: e === 'no_show', cancelled: e === 'annule',
          closerName: cs ? memberName(cs) : null,
          replay: rp.status || null, replayReason: rp.reason || null,
          summary: rp.summary || '', analysis: rp.analysis || null, durationSec: rp.durationSec || null };
      });
      /* Close : pour un lead de la cohorte, « close des leads entrés »
         (gagné après son entrée) ; pour une fiche hors cohorte (client de la
         période entré plus tôt), sa ligne de la période. */
      var csMs = FC.parseFlexMs(l.clientSince);
      var row = null;
      if (l._cohorte) {
        row = cohRowByLead[l._id] || null;
        if (csMs != null && csMs < floor) r.dejaClient = true;
        if (cohSansSignal[l._id]) r.sansVenteEnregistree = true;
      } else {
        row = perRowByLead[l._id] || null;
      }
      if (row) {
        r.closeKey = row.key; r.closeSrc = row.src;
        if (row.rv && row.rv.cancelled) r.closeCancelled = true;
        else {
          r.closed = true; r.cash = row.rv.paid; r.con = row.rv.con; r.pending = row.rv.pending || 0;
          r.closeDay = row.day;
          r.offer = offerOfRow(row, l);
          r.closeSansRdv = !r.avecRdv;
        }
        if (row.closer) r.closer = row.closer;
      }
      var pr = perRowByLead[l._id];
      if (pr && !(pr.rv && pr.rv.cancelled)) r.closePeriode = { day: pr.day, con: pr.rv.con, paid: pr.rv.paid, closer: pr.closer || null };
      if (pr && pr.closer && !r.closer) r.closer = pr.closer;
      r.closerName = r.closer ? memberName(r.closer) : null;
      /* Setter du lead : celui du close quand il y en a un (liste unique),
         sinon StatsCore.setterDuRdv sur son premier RDV du setting, sinon le
         setter de la fiche. */
      var firstSet = null;
      heads.forEach(function (h0) { if (!firstSet && h0._class === 'setter') firstSet = h0; });
      var st0 = (row && row.setter) || (pr && pr.setter) || (firstSet ? SC.setterDuRdv(firstSet, l) : (l.setterSlug || null));
      r.setter = st0 || null;
      r.setterName = st0 ? memberName(st0) : null;
      /* Lieu et appareil (23/11/2026) : repli sur le premier RDV pris par le
         prospect lui-même. FC.visiteurOf fait le reste (bloc lead, puis
         navigateur de l'opt-in). */
      if (!l._bkVis) (bkByLead[l._id] || []).forEach(function (b) {
        if (!l._bkVis && b.visiteur && (b.visiteur.country || b.visiteur.device)) l._bkVis = b.visiteur;
      });
      r.visiteur = FC.visiteurOf ? FC.visiteurOf(l) : null;
      r.axes = {
        device: FC.leadAxisKey(l, 'device', CRE_IDX),
        region: FC.leadAxisKey(l, 'region', CRE_IDX),
        campaign: FC.leadAxisKey(l, 'campaign', CRE_IDX),
        adset: FC.leadAxisKey(l, 'adset', CRE_IDX),
        creative: FC.leadAxisKey(l, 'creative', CRE_IDX),
        channel: FC.leadAxisKey(l, 'channel', CRE_IDX)
      };
      r.sourceLabel = (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || '—';
      r.isAds = FC.isAdvertisingLead(l);
      l._row = r; l._rowStamp = stamp;
      return r;
    }

    var rows = cohort.filter(leadPasses).map(rowOfLead);

    /* Closers présents dans les données (sélecteur) */
    var closerSet = {};
    /* Sélecteur 🎯 : seulement les closers qui ont un onglet (D10) — un
       admin, un setter ou un ancien membre n'y apparaissent pas. */
    function noteCloser(slug) { if (slug && aOngletCloser(slug)) closerSet[slug] = 1; }
    rows.forEach(function (r) { noteCloser(r.closer); });

    /* ── Closes de la période (cartes Closes / Contracté / Collecté) ── */
    function leadObjOf(row) { return row.leadId ? (allLeads[row.leadId] || row.lead || null) : (row.lead || null); }
    var periodSigned = CLp.rows.map(function (row) {
      var l = leadObjOf(row);
      var lr = l ? rowOfLead(l) : null;
      return ranger(closeEntry(row, { lead: l, leadRow: lr, note: lr ? lr.note : null, offer: offerOfRow(row, l) }), row.day);
    });
    var periodAnnules = CLp.annules.map(function (row) { var l = leadObjOf(row); return ranger(closeEntry(row, { lead: l, note: l ? scoreLead(l).note : null }), row.day); });
    periodSigned.forEach(function (ps) { noteCloser(ps.closer); });

    /* ── RDV de vente DATÉS entre deux jours (StatsCore) — UNE fabrique pour
       la plage de la vue Closers (rdvRows) et la période affichée
       (rdvPeriode, 27/11/2026). Replanifiés et doublons hors liste, filtres
       tunnel / source de la page, rangement D10 (ranger). ── */
    /* Close relié à un RDV (dossier d'une ligne de RDV, 27/11/2026) : la
       liste unique de la période d'abord (même RDV, même fiche, même e-mail),
       close annulé compris ; sinon la date client de la fiche (close d'une
       autre période). null = aucun close connu : l'écran ne conclut rien. */
    var closeIdx = { b: {}, l: {}, e: {} };
    function indexer(row, annule) {
      var v = { row: row, annule: annule };
      if (row.bookingId && !closeIdx.b[row.bookingId]) closeIdx.b[row.bookingId] = v;
      if (row.leadId && !closeIdx.l[row.leadId]) closeIdx.l[row.leadId] = v;
      var em = String((row.lead && row.lead.email) || (String(row.key || '').indexOf('e:') === 0 ? row.key.slice(2) : '')).toLowerCase().trim();
      if (em && !closeIdx.e[em]) closeIdx.e[em] = v;
    }
    CLp.rows.forEach(function (row) { indexer(row, !!(row.rv && row.rv.cancelled)); });
    CLp.annules.forEach(function (row) { indexer(row, true); });
    function closeLieAuRdv(b, l) {
      var em = String((l && l.email) || (b.prospect && b.prospect.email) || '').toLowerCase().trim();
      var v = (b._id && closeIdx.b[b._id]) || (l && closeIdx.l[l._id]) || (em && closeIdx.e[em]) || null;
      if (v) return v.annule ? { etat: 'annule', day: v.row.day || null }
        : { etat: 'gagne', day: v.row.day || null, con: Number(v.row.rv && v.row.rv.con) || 0, paid: Number(v.row.rv && v.row.rv.paid) || 0 };
      var cs = l ? FC.parseFlexMs(l.clientSince) : null;
      if (cs != null) return { etat: 'client', day: SC.jourParis(cs) };
      return null;
    }
    function rdvDatesEntre(dS, dE) {
      var out = [];
      venteBookings.forEach(function (b) {
        if (!b.date || b.date < dS || b.date > dE) return;
        var e = SC.etat(b, now);
        if (e === 'replanifie' || e === 'doublon') return;   // le remplaçant compte à sa date ; un doublon nulle part
        var l = b._lead;
        if (!rdvPasses(b, l)) return;
        var lr = l ? rowOfLead(l) : null;
        var slug = closerOfRdv(b);
        noteCloser(slug);
        var d = SC.detail(b);
        out.push(ranger({
          b: b, now: now, date: b.date, month: monthKey(b.date), closer: slug, closerName: slug ? memberName(slug) : 'Non attribué',
          classe: b._class, etat: e, detailRdv: d,
          note: lr ? lr.note : null, team: lr ? lr.team : null, leadRow: lr,
          cancelled: e === 'annule', noshow: e === 'no_show', present: e === 'present',
          pitched: d === 'offre' || d === 'close' || d === 'non_close',
          upcoming: e === 'a_venir', aStatuer: e === 'a_statuer',
          /* RDV au résultat Close (glossaire rdv_closes) : ce n'est PAS un close
             — les closes de la vue viennent de la liste unique (closesPlage). */
          rdvClose: d === 'close', close: d === 'close', cash: 0, con: 0,
          closeLie: d === 'close' ? closeLieAuRdv(b, l) : null,
          name: (l && (l.nom || l.email)) || (b.prospect && (b.prospect.nom || b.prospect.email)) || '—',
          leadId: l ? l._id : null
        }, b.date));
      });
      return out;
    }
    /* Lignes de la liste unique des closes → entrées rangées chez le closer
       du close (row.closer), au mois du close. */
    function entreesCloses(CL) {
      return CL.rows.map(function (row) {
        var l = leadObjOf(row) || (row.leadId ? plageLeads[row.leadId] : null);
        var note = l ? scoreLead(l).note : null;
        noteCloser(row.closer);
        return ranger(closeEntry(row, { lead: l, note: note, month: String(row.day || '').slice(0, 7), offer: offerOfRow(row, l),
          closerName: row.closer ? memberName(row.closer) : 'Non attribué' }), row.day);
      });
    }
    /* Une liste de RDV porte ses closes et ses règles (byCloser /
       closerBoard les lisent). */
    function equiper(list, closes) {
      list.closesPlage = closes;
      list.estParti = isDeparted;
      list.rangCloser = rangCloser;
      return list;
    }

    /* ── Vue Closers : RDV DATÉS dans la plage ── */
    var CR = ctx.closerRange || { start: P.start, end: P.end };
    var cS = FC.isoDate(CR.start), cE = FC.isoDate(CR.end);
    var rdvRows = rdvDatesEntre(cS, cE);

    /* ── Closes de la plage Closers : la même liste unique, bornée à la
       plage, rangée chez le closer du close (row.closer), montants une fois
       par client. ── */
    var CLr;
    if (!D.plage || !D.plageDistincte) CLr = CLp;
    else {
      var R = D.plage;
      var plageBk = venteBookings.filter(function (b) { return b.date && b.date >= cS && b.date <= cE; });
      CLr = FC.buildCloses({
        closedLeads: R.closedLeads || [], bookings: plageBk, closeBookings: R.closeBookings || {},
        payments: R.payments || [], typeMap: typeMap, start: CR.start, end: CR.end,
        leadOk: leadPasses, rdvOk: function (b) { return rdvPasses(b, b._lead); }, payCloseOk: payCloseOk,
        resoudrePersonne: resoudre
      });
    }
    var closesPlage = entreesCloses(CLr);
    equiper(rdvRows, closesPlage);

    /* ── Vue d'ensemble : RDV DATÉS dans la PÉRIODE affichée (27/11/2026,
       choix 2a d'Adrien) — cartes RDV / Présents / Pitchés, mêmes chiffres
       que Global closing et le Stats funnel. Ne dépend JAMAIS de la plage
       Closers (les RDV datés dans la période sont toujours lus : requête
       _lqDateP de loadAll). Closes attachés : ceux de la période. ── */
    var pIso0 = FC.isoDate(P.start), pIso1 = FC.isoDate(P.end);
    var rdvPeriode = equiper(rdvDatesEntre(pIso0, pIso1), CLr === CLp ? closesPlage : entreesCloses(CLp));

    /* ── « Prélevé sur la période » (glossaire preleve_periode) :
       FunnelCore.cashInPeriod — prélèvements DATÉS dans la période, tous
       clients, HT. Ce n'est pas le Collecté. Sous un filtre tunnel / source,
       un paiement sans fiche est écarté (on ne sait pas d'où il vient). ── */
    var pS = P.start.getTime(), pE = P.end.getTime();
    var cip = FC.cashInPeriod(D.payments || [], pS, pE);
    var periodPays = [];
    cip.lignes.forEach(function (ln) {
      var p = ln.p;
      var l = (p.leadId && allLeads[p.leadId]) || byEmail[String(p.leadEmail || '').toLowerCase().trim()] || byP9[FC.phone9(p.leadPhone)] || null;
      if (l && !leadPasses(l)) return;
      if (!l && filtresActifs) return;
      var lr = l ? rowOfLead(l) : null;
      periodPays.push({ p: p, cash: ln.ht, ht: ln.ht, lead: l, note: lr ? lr.note : null, leadRow: lr,
        closer: p.closerSlug || (lr && lr.closer) || null,
        name: (l && (l.nom || l.email)) || p.leadName || p.leadEmail || '—' });
    });
    var preleve = 0;
    periodPays.forEach(function (x) { preleve += x.ht; });

    var closers = Object.keys(closerSet).sort(function (a, b) { return memberName(a).localeCompare(memberName(b)); })
      .map(function (s) { return { slug: s, name: memberName(s) }; });

    /* ── Lectures en échec / plafonds : phrases prêtes à afficher ── */
    var erreurs = [];
    (D.lectures || []).forEach(function (t) { erreurs.push(t); });
    if (D.closedLeadsError) erreurs.push('Fiches gagnées illisibles : closes, contracté et collecté de la période incomplets (' + D.closedLeadsError + ').');
    if (D.closedLeadsTruncated) erreurs.push('Liste des clients gagnés tronquée : la période contient plus de ' + FC.CLOSED_LEADS_LIMIT + ' fiches gagnées. Réduis la période pour un total exact.');
    if (D.paymentsError) erreurs.push('Module Paiements illisible : montants (contracté, collecté, prélevé) non fiables, recharge la page (' + D.paymentsError + ').');
    if (D.closeBookingsError) erreurs.push('RDV porteurs des closes illisibles : canal, closer et setter de certains closes peuvent manquer (' + D.closeBookingsError + ').');
    if (D.plage) {
      if (D.plage.erreur) erreurs.push('Closes de la plage Closers illisibles : ' + D.plage.erreur + '.');
      if (D.plage.closedLeadsError) erreurs.push('Fiches gagnées de la plage Closers illisibles : closes de la vue Closers incomplets (' + D.plage.closedLeadsError + ').');
      if (D.plage.closedLeadsTruncated) erreurs.push('Clients gagnés de la plage Closers tronqués (plus de ' + FC.CLOSED_LEADS_LIMIT + ' fiches) : réduis la plage.');
      if (D.plage.closeBookingsError) erreurs.push('RDV porteurs des closes de la plage Closers illisibles (' + D.plage.closeBookingsError + ').');
    }
    if (D.reoptinsError) erreurs.push('Ré-optins illisibles : les leads de la période ne comptent que les nouveaux leads (' + D.reoptinsError + ').');
    if (D.reoptinsTruncated) erreurs.push('Liste des ré-optins tronquée (plafond de lecture atteint) : réduis la période.');
    if (D.adsByAdError) erreurs.push('Dépense par pub illisible : coûts de la vue Marketing absents (' + D.adsByAdError + ').');
    if (D.creativesError) erreurs.push('Référentiel des pubs illisible : certaines pubs restent affichées par leur identifiant (' + D.creativesError + ').');
    if (D.viewsError) erreurs.push('Visites des pages illisibles : visites et formulaires du quiz à zéro (' + D.viewsError + ').');
    if (D.quizErr) erreurs.push('Mesure des quiz illisible : ' + D.quizErr + '.');
    if (D.tunnelsErr) erreurs.push('Tunnels illisibles : la vue Quiz montre toutes les versions, archivées comprises (' + D.tunnelsErr + ').');

    var totPeriode = FC.sumCloses(CLp.rows);
    return {
      /* rdvRows = RDV DATÉS dans la plage de la vue Closers ; rdvPeriode =
         RDV DATÉS dans la période affichée (cartes RDV / Présents / Pitchés
         de la vue d'ensemble, LqsCore.byCloser(rdvPeriode, slug)). Même
         format ; chacune porte ses closes (closesPlage), estParti et
         rangCloser. Plage = période → mêmes agrégats. */
      rows: rows, rdvRows: rdvRows, rdvPeriode: rdvPeriode, periodPays: periodPays, periodSigned: periodSigned, closers: closers,
      /* Liste unique des closes de la PÉRIODE : comptés (periodSigned),
         annulés, fiches clientes sans vente, écarts de canal, totaux
         FunnelCore.sumCloses (closes, con, paid, pending, reste, panier,
         collecteParClose, sansPaiement). */
      periodCloses: { rows: periodSigned, annules: periodAnnules, sansSignal: CLp.sansSignal || [], ecartsCanal: CLp.ecartsCanal || [],
        autres: CLp.autres || [], totaux: totPeriode, source: closesSource },
      closesPlage: closesPlage,
      prelevePeriode: { total: r2(preleve), totalTousClients: cip.total, filtre: filtresActifs },
      erreursLecture: erreurs,
      plageDistincte: !!D.plageDistincte,
      quiz: buildQuizFunnel(D.quizDocs || []), quizErr: D.quizErr || null,
      adsByAd: D.adsByAd || [], creIdx: CRE_IDX, views: D.views || [],
      tunnels: D.tunnelsErr ? null : (D.tunnels || null),
      leadsTruncated: !!D.leadsTruncated, memberName: memberName, isDeparted: isDeparted,
      /* Vue Closers (D10) : règle de rangement et test « a un onglet ». */
      rangCloser: rangCloser, aOngletCloser: aOngletCloser
    };
  }

  /* ══ 6. AGRÉGATS ═══════════════════════════════════════════════════════ */
  var NOTE_KEYS = [5, 4, 3, 2, 1, 0];   // 0 = non noté

  /* Tableau par note. rows = leads entrés (cohorte) ; periodSigned =
     closes de la PÉRIODE (liste unique, rangés selon la note du lead, quel
     que soit son mois d'entrée ; un close sans fiche va en « non noté ») ;
     periodPays = prélèvements datés dans la période (cashInPeriod).
     Champs « période » par note et au total :
       signers (= closesPeriode) · signersE / signersB / signersU (offre)
       periodCon (= contractePeriode) · periodPaid (= collectePeriode :
       collecté À CE JOUR sur ces closes) · periodPending
       periodCash (= prelevePeriode : prélevé PENDANT la période, tous
       clients — autre calcul, glossaire preleve_periode) · payers.
     Les champs par lead (leadsAvecRdv, closes des leads entrés, taux par
     lead) ne se mélangent jamais avec eux. */
  function periodZero(a) {
    a.payers = 0; a.periodCash = 0; a.periodCon = 0; a.periodPaid = 0; a.periodPending = 0;
    a.signers = 0; a.signersE = 0; a.signersB = 0; a.signersU = 0;
    return a;
  }
  function periodFin(a) {
    a.periodCash = r2(a.periodCash); a.periodCon = r2(a.periodCon); a.periodPaid = r2(a.periodPaid); a.periodPending = r2(a.periodPending);
    a.closesPeriode = a.signers; a.contractePeriode = a.periodCon; a.collectePeriode = a.periodPaid; a.prelevePeriode = a.periodCash;
    a.resteAEncaisserPeriode = Math.max(0, r2(a.periodCon - a.periodPaid));
    return a;
  }
  function byNote(rows, periodPays, periodSigned) {
    var m = {};
    NOTE_KEYS.forEach(function (k) { m[k] = periodZero(newAgg()); m[k].note = k; });
    var tot = periodZero(newAgg());
    (periodSigned || []).forEach(function (ps) {
      if (ps.cancelled) return;
      var k = ps.note == null ? 0 : ps.note;
      [m[k], tot].forEach(function (a) {
        a.periodCon += ps.con || 0; a.periodPaid += ps.paid != null ? ps.paid : (ps.cash || 0); a.periodPending += ps.pending || 0;
        a.signers++;
        if (ps.offer === 'elite') a.signersE++;
        else if (ps.offer === 'business') a.signersB++;
        else a.signersU++;
      });
    });
    rows.forEach(function (r) { addLeadRow(m[r.note == null ? 0 : r.note], r); addLeadRow(tot, r); });
    if (periodPays) {
      var seen = {};
      periodPays.forEach(function (pp, i) {
        var k = pp.note == null ? 0 : pp.note;
        var v = pp.ht != null ? pp.ht : pp.cash;
        m[k].periodCash += v; tot.periodCash += v;
        var id = pp.lead ? pp.lead._id : ('p_' + ((pp.p && pp.p._id) || i));
        if (!seen[id]) { seen[id] = 1; m[k].payers++; tot.payers++; }
      });
    }
    NOTE_KEYS.forEach(function (k) { fin(m[k]); periodFin(m[k]); });
    fin(tot); periodFin(tot);
    return { byNote: m, total: tot };
  }

  /* Réponses : par question, par réponse — résultats + points + suggestion. */
  function byAnswer(rows, grid, origin) {
    var tot = newAgg();
    rows.forEach(function (r) { addLeadRow(tot, r); });
    fin(tot);
    var qs = {};
    rows.forEach(function (r) {
      r.answers.forEach(function (a) {
        if (origin && a.o !== origin) return;
        var q = qs[a.q];
        if (!q) q = qs[a.q] = { q: a.q, label: a.ql, origin: a.o, ord: a.ord, answers: {}, agg: newAgg() };
        if (a.ord < q.ord) q.ord = a.ord;
        var x = q.answers[a.a];
        if (!x) x = q.answers[a.a] = { a: a.a, label: a.al, agg: newAgg() };
        addLeadRow(x.agg, r);
        addLeadRow(q.agg, r);
      });
    });
    var list = Object.keys(qs).map(function (k) {
      var q = qs[k];
      fin(q.agg);
      var gq = grid.questions[k];
      q.off = !!(gq && gq.off);
      q.answerList = Object.keys(q.answers).map(function (ak) {
        var x = q.answers[ak];
        fin(x.agg);
        var rule = ruleFor(grid, { q: k, a: ak, ql: q.label, al: x.label });
        x.pts = rule.off ? 0 : rule.pts;
        x.ko = !!rule.ko;
        x.known = !!rule.known;
        x.def = defaultPoints(k, q.label, x.label);
        /* Suggestion : la recommandation d'audit d'abord ; à défaut, le
           calcul sur la période, seulement s'il y a assez de closes. */
        x.reco = recoPoints(k, q.label, x.label);
        x.suggest = x.reco != null ? x.reco : suggestPoints(x.agg, tot);
        x.suggestSrc = x.reco != null ? 'audit' : (x.suggest != null ? 'periode' : null);
        x.share = q.agg.leads ? x.agg.leads / q.agg.leads * 100 : null;
        return x;
      }).sort(function (a, b) { return b.agg.leads - a.agg.leads; });
      return q;
    }).sort(function (a, b) { return b.agg.leads - a.agg.leads; });
    return { questions: list, total: tot };
  }

  /* Suggestion de points à partir des résultats réels d'une réponse :
     valeur par lead rapportée à la moyenne — montant CONTRACTÉ des closes des
     leads entrés si la période en compte au moins 8, sinon AUCUNE suggestion
     (seule la recommandation d'audit s'affiche) —, ramenée vers 1 sur les
     petits effectifs (10 leads « fictifs » à la moyenne), puis log2 × 1,5,
     arrondie au demi-point, bornée à ±3. Rien sous 5 leads : trois closes ne
     font pas une tendance. */
  var SUGGEST_MIN = 5;
  var SUGGEST_MIN_CLOSES = 8, SUGGEST_MIN_PRESENT = 10, SUGGEST_PRIOR = 10;
  /* Le repli « RDV honorés » est retiré (13/11/2026) : sur un mois, il
     proposait l'inverse de ce que montre l'historique. Sans assez de closes
     sur la période, seule la recommandation d'audit (recoPoints) s'affiche. */
  function suggestBasis(tot) {
    if (tot.closes >= SUGGEST_MIN_CLOSES && tot.con > 0) return 'cash';
    return null;
  }

  /* ── Recommandation d'audit (13/11/2026) ──────────────────────────────
     Points recommandés d'après TOUT l'historique du 25/09 au 13/11/2026 :
     362 leads, 105 RDV, 54 présents, 7 closes, 54 000 € signés, et les
     freins entendus dans 27 visios de closing. Ce qui ressort : le profil
     qui close est à 20-100 k€ / mois, travaille 50 h et plus, et son
     entreprise ne tourne pas sans lui (mauvais score au diagnostic) ; les
     CA au-delà de 100 k€ prennent des RDV mais viennent peu et n'ont rien
     signé. 7 closes : une tendance, à revoir quand il y en aura 20.
     null = pas de recommandation pour cette réponse. */
  function recoPoints(qKey, qLabel, aLabel) {
    var qn = norm(qLabel), an = norm(aLabel), k = String(qKey || '');
    var scale = an.match(/^(\d) ?\/ ?5$/);
    if (k === 'quiz_ca_mensuel' || /chiffre d.?affaires mensuel actuel/.test(qn)) {
      var m = monthlyCa(aLabel, qn + ' ' + k);
      if (m == null) return null;
      return m < 20000 ? -0.5 : (m < 50000 ? 2 : (m < 100000 ? 1.5 : (m < 200000 ? 0.5 : 0)));
    }
    if (k === 'quiz_heures') {
      var hs = amounts(an);
      if (!hs.length) return null;
      var hMax = Math.max.apply(null, hs), hMin = Math.min.apply(null, hs);
      var h = /plus de/.test(an) ? hMax + 5 : (/moins de/.test(an) ? hMax - 5 : (hMin + hMax) / 2);
      return h >= 50 ? 1 : (h >= 40 ? -0.5 : -1);
    }
    if (k === 'quiz_score_global') {
      var g = parseInt(an, 10);
      if (isNaN(g)) return null;
      return g < 25 ? 1.5 : (g < 50 ? 0.5 : (g < 75 ? -1 : -1.5));
    }
    if (k === 'quiz_equipe') {
      if (/seul|aucune/.test(an)) return -0.5;
      var n = maxCount(an);
      if (n == null) return null;
      return n <= 3 ? 0 : (n <= 10 ? 1 : 0);
    }
    var yes = /^oui\b/.test(an), no = /^non\b/.test(an);
    if (/nouveau salarie.*autonome/.test(qn)) return no ? 1 : (yes ? -1 : null);
    if (/quelle marge/.test(qn)) return no ? 0.5 : (yes ? -0.5 : null);
    if (/quel levier actionner/.test(qn) && /augmenter votre chiffre/.test(qn)) return no ? 0.5 : (yes ? 0 : null);
    if (/absorbe la charge/.test(qn) && scale) return +scale[1] >= 4 ? 0.5 : -0.5;
    if (/mal dormir/.test(qn) && scale) return +scale[1] === 5 ? 0.5 : (+scale[1] <= 2 ? -0.5 : 0);
    if (/pese le plus/.test(qn)) {
      if (/noye dans l.?operationnel/.test(an)) return 1;
      if (/avale ma vie/.test(an)) return -0.5;
      return 0;
    }
    return null;
  }

  /* Seuils recalculés sur les points EN COURS : on vise une répartition
     lisible des leads notés — 15 % de 5, 25 % de 4, 30 % de 3, 20 % de 2,
     10 % de 1 — en prenant les quantiles du total de points (arrondis au
     demi-point, strictement décroissants). Les leads éliminés (⛔) et non
     notés ne comptent pas. */
  function calibrateThresholds(rows) {
    var pts = [];
    (rows || []).forEach(function (r) { if (r.pts != null && !r.ko) pts.push(r.pts); });
    if (pts.length < 10) return null;
    pts.sort(function (a, b) { return a - b; });
    function qt(p) { return pts[Math.min(pts.length - 1, Math.max(0, Math.ceil(p * pts.length) - 1))]; }
    function up(v) { return Math.ceil(v * 2) / 2; }
    var t = { n5: up(qt(0.85) + 0.01), n4: up(qt(0.60) + 0.01), n3: up(qt(0.30) + 0.01), n2: up(qt(0.10) + 0.01) };
    if (t.n4 >= t.n5) t.n4 = t.n5 - 0.5;
    if (t.n3 >= t.n4) t.n3 = t.n4 - 0.5;
    if (t.n2 >= t.n3) t.n2 = t.n3 - 0.5;
    return t;
  }
  function suggestPoints(a, tot) {
    if (!a || a.leads < SUGGEST_MIN) return null;
    var basis = suggestBasis(tot), v, g;
    if (basis === 'cash') { v = a.con / a.leads; g = tot.con / tot.leads; }
    else if (basis === 'present') { v = a.present / a.leads; g = tot.present / tot.leads; }
    else return null;
    if (!(g > 0)) return null;
    var rr = v / g;
    var shrunk = (a.leads * rr + SUGGEST_PRIOR) / (a.leads + SUGGEST_PRIOR);
    return clamp(roundHalf(1.5 * Math.log(Math.max(shrunk, 0.05)) / Math.LN2), -3, 3);
  }

  /* MQS par source publicitaire / canal. */
  var MQS_MIN = 5;
  function mqsOf(a, tot) {
    if (!a || a.noted < MQS_MIN || a.avgNote == null) return null;
    var rr = null;
    if (tot.con > 0 && tot.leads > 0) rr = (a.con / a.leads) / (tot.con / tot.leads);
    else if (tot.present > 0 && tot.leads > 0) rr = (a.present / a.leads) / (tot.present / tot.leads);
    var c;
    if (rr == null) c = a.avgNote;
    else {
      var s = (a.leads * rr + 5) / (a.leads + 5);
      c = s >= 2 ? 5 : (s >= 1.25 ? 4 : (s >= 0.75 ? 3 : (s >= 0.35 ? 2 : 1)));
    }
    return { mqs: r1(0.6 * a.avgNote + 0.4 * c), quality: a.avgNote, result: c };
  }

  /* sourceFilter (facultatif) : 'youtube' → aucune dépense (la dépense est
     de la pub Meta, même règle que le Stats funnel). Ratio par ligne :
     conPerSpend = contracté des leads entrés ÷ dépense (glossaire
     contracte_sur_depense) — ce n'est PAS le ROAS pub du funnel (collecté ÷
     dépense) ; `roas` reste son alias tant que lqs-tab.js le lit. Total :
     `totalPub` = lignes venues de la pub seulement (outOfAds faux),
     `conPerSpend` / `cplPub` calculés sur elles. */
  function byAxis(rows, axis, adsByAd, tunnelFilter, sourceFilter) {
    var tot = newAgg();
    rows.forEach(function (r) { addLeadRow(tot, r); });
    fin(tot);
    var sansDepense = sourceFilter === 'youtube';
    var m = {};
    rows.forEach(function (r) {
      var k = r.axes[axis] || { label: '—', group: '—' };
      var x = m[k.group];
      if (!x) x = m[k.group] = { key: k.group, label: k.label, outOfAds: !!k.outOfAds, legacy: !!k.legacy, adIds: {}, agg: newAgg(), spend: 0, hasSpend: false };
      if (!k.legacy) x.legacy = false;
      if (k.adId) x.adIds[String(k.adId)] = 1;
      addLeadRow(x.agg, r);
    });
    /* Dépense : par ad_id, attribuée à UNE ligne (la plus grosse) — même
       garde-fou que FunnelCore (une pub renommée ne compte pas deux fois). */
    var spendByAd = {};
    (sansDepense ? [] : (adsByAd || [])).forEach(function (a) {
      if (!a || !a.ad_id) return;
      if (tunnelFilter && tunnelFilter !== 'all' && a.tunnel && (a.tunnel === 'business' ? 'business' : 'elite') !== tunnelFilter) return;
      spendByAd[String(a.ad_id)] = (spendByAd[String(a.ad_id)] || 0) + num(a.spend);
    });
    var list = Object.keys(m).map(function (k) { return m[k]; }).sort(function (a, b) { return b.agg.leads - a.agg.leads; });
    var claimed = {};
    list.forEach(function (x) {
      Object.keys(x.adIds).forEach(function (id) {
        if (claimed[id] || spendByAd[id] == null) return;
        claimed[id] = 1; x.spend += spendByAd[id]; x.hasSpend = true;
      });
      x.spend = r2(x.spend);
      fin(x.agg);
      x.cpl = x.hasSpend && x.agg.leads ? x.spend / x.agg.leads : null;
      x.cpl45 = x.hasSpend && x.agg.n45 ? x.spend / x.agg.n45 : null;
      x.conPerSpend = x.hasSpend && x.spend > 0 && x.agg.con > 0 ? x.agg.con / x.spend : null;   // contracté ÷ dépense
      x.roas = x.conPerSpend;   // alias (ancien nom), à ne plus afficher sous le mot « ROAS »
      x.m = mqsOf(x.agg, tot);
      delete x.adIds;
    });
    list.sort(function (a, b) {
      if (a.outOfAds !== b.outOfAds) return a.outOfAds ? 1 : -1;
      return b.agg.leads - a.agg.leads;
    });
    var spendTot = 0, spendClaimed = 0;
    Object.keys(spendByAd).forEach(function (id) { spendTot += spendByAd[id]; if (claimed[id]) spendClaimed += spendByAd[id]; });
    var totPub = newAgg();
    rows.forEach(function (r) { var k = r.axes[axis]; if (k && !k.outOfAds) addLeadRow(totPub, r); });
    fin(totPub);
    spendTot = r2(spendTot);
    return { rows: list, total: tot, spend: spendTot, totalPub: totPub,
      spendRattachee: r2(spendClaimed), spendNonRattachee: r2(spendTot - spendClaimed), sansDepense: sansDepense,
      conPerSpend: spendTot > 0 && totPub.con > 0 ? totPub.con / spendTot : null,
      cplPub: spendTot > 0 && totPub.leads ? spendTot / totPub.leads : null };
  }

  /* Closers (audit 25/11/2026, LQS-03 / LQS-04) :
       · RDV DATÉS dans la plage, comptés par StatsCore (SC.ajouter) :
         rdv = annulés + no-show + présents + à statuer + à venir (replanifiés
         et doublons hors compte, RDV manuels compris) ; kept = rdv −
         annulés ; show-up = présents ÷ (kept − à venir) ;
       · Closes / Contracté / Collecté = lignes de la LISTE UNIQUE des closes
         de la plage (rdvRows.closesPlage), rangées chez le closer du close,
         au mois du close (jour où le client est gagné), selon la note du
         lead ; montants une fois par client. Ils ne sont plus comptés sur
         les RDV : un client à deux RDV closés = un close ; un close validé
         depuis la fiche compte chez son closer ;
       · rdvCloses = RDV au résultat Close (glossaire rdv_closes), à part ;
       · taux de close : StatsCore.tauxClose(closes, présents | RDV |
         pitchés) — null (« — ») si la base est nulle ou dépassée.
     Anciens noms gardés (lqs-tab.js) : cancelled, present, pitched,
     upcoming, showRate, closePresent, closeRdv. */
  function newRdvAgg() {
    var a = SC.vide();
    a.noted = 0; a.noteSum = 0; a.n45 = 0; a.n12 = 0; a.dist = [0, 0, 0, 0, 0, 0];
    a.closes = 0; a.cash = 0; a.con = 0; a.pending = 0; a.sansPaiement = 0;
    return a;
  }
  function addRdv(a, x) {
    SC.ajouter(a, x.b, x.now);
    addNote(a, x.note);
  }
  function addClose(a, c) {
    a.closes++; a.con += c.con || 0; a.cash += c.paid != null ? c.paid : (c.cash || 0); a.pending += c.pending || 0;
    if (c.sansPaiement) a.sansPaiement++;
  }
  function finRdv(a) {
    SC.finir(a);
    a.cash = r2(a.cash); a.con = r2(a.con); a.pending = r2(a.pending);
    a.avgNote = a.noted ? r2(a.noteSum / a.noted) : null;
    a.pct45 = a.noted ? a.n45 / a.noted * 100 : null;
    a.tauxClosePresents = SC.tauxClose(a.closes, a.presents);
    a.tauxCloseRdv = SC.tauxClose(a.closes, a.rdv);
    a.tauxClosePitches = SC.tauxClose(a.closes, a.pitches);
    a.resteAEncaisser = Math.max(0, r2(a.con - a.cash));
    /* Alias (anciens noms) — mêmes valeurs. */
    a.cancelled = a.annules; a.present = a.presents; a.pitched = a.pitches; a.upcoming = a.aVenir;
    a.showRate = a.showUp;
    a.closePresent = a.tauxClosePresents;
    a.closeRdv = a.tauxCloseRdv;
    return a;
  }
  function closesOfRows(rdvRows, closes) { return closes || (rdvRows && rdvRows.closesPlage) || []; }
  /* Clé de rangement d'une entrée de la vue Closers : rangKey posé par
     buildModel (StatsCore.rangPersonne, D10) ; à défaut (entrées fabriquées
     ailleurs) le slug du closer. */
  function rangKeyOf(x) { return x.rangKey != null ? x.rangKey : (x.closer || null); }
  /* byCloser(rdvRows, slug[, closes]) — slug '' = toute l'équipe (Non
     attribué et anciens membres compris) ; '_na' = la ligne « Non
     attribué ». Un closer = les RDV et closes RANGÉS dans son onglet
     (rangKey, D10 : rien d'avant son arrivée). closes : lignes de closes de
     la plage (par défaut rdvRows.closesPlage). */
  function byCloser(rdvRows, slug, closes) {
    var list = rdvRows.filter(function (x) { return !slug || rangKeyOf(x) === slug; });
    var cl = closesOfRows(rdvRows, closes).filter(function (c) { return !c.cancelled && (!slug || rangKeyOf(c) === slug); });
    var months = {}, notes = {}, tot = newRdvAgg();
    NOTE_KEYS.forEach(function (k) { notes[k] = newRdvAgg(); });
    list.forEach(function (x) {
      (months[x.month] = months[x.month] || newRdvAgg());
      addRdv(months[x.month], x);
      addRdv(notes[x.note == null ? 0 : x.note], x);
      addRdv(tot, x);
    });
    cl.forEach(function (c) {
      var mk = c.month || String(c.day || '').slice(0, 7);
      (months[mk] = months[mk] || newRdvAgg());
      addClose(months[mk], c);
      addClose(notes[c.note == null ? 0 : c.note], c);
      addClose(tot, c);
    });
    var mList = Object.keys(months).sort().map(function (k) { var a = finRdv(months[k]); a.month = k; return a; });
    NOTE_KEYS.forEach(function (k) { finRdv(notes[k]); });
    return { months: mList, byNote: notes, total: finRdv(tot), list: list, closes: cl };
  }
  /* closerBoard(rdvRows, memberName[, closes, estParti]) — une ligne par
     closer qui a un onglet, plus UNE ligne « Non attribué » (slug null,
     nonAttribue: true), comme Global closing (D10) : closer inconnu, ancien
     membre (« Anciens membres », sans nom), personne sans onglet
     (« Prénom (hors onglets) ») ou élément d'avant son arrivée
     (« Prénom (avant son arrivée) »). a.precisions = [{ precision, rdv,
     closes, con }] détaille cette ligne. La somme des lignes = « Toute
     l'équipe » (byCloser(rdvRows, '')).
     Entrées sans rangKey (fabriquées hors buildModel) : ancienne règle —
     slug, membre parti → « Non attribué » / « Anciens membres ». */
  function closerBoard(rdvRows, memberName, closes, estParti) {
    var parti = typeof estParti === 'function' ? estParti : (rdvRows && rdvRows.estParti) || function () { return false; };
    var NA = SC.NON_ATTRIBUE || '_na';
    var m = {}, prec = {}, precOrder = [];
    function rangOf(x) {
      if (x.rangKey != null) return { key: x.rangKey, precision: x.rangPrecision || '' };
      if (!x.closer) return { key: NA, precision: '' };
      if (parti(x.closer)) return { key: NA, precision: 'Anciens membres' };
      return { key: x.closer, precision: '' };
    }
    function precOf(r) {
      if (r.key !== NA) return null;
      var p = r.precision || 'Closer inconnu';
      if (!prec[p]) { prec[p] = { precision: p, rdv: 0, closes: 0, con: 0 }; precOrder.push(p); }
      return prec[p];
    }
    rdvRows.forEach(function (x) {
      var r = rangOf(x);
      (m[r.key] = m[r.key] || newRdvAgg());
      addRdv(m[r.key], x);
      var pp = precOf(r); if (pp) pp.rdv++;
    });
    closesOfRows(rdvRows, closes).forEach(function (c) {
      if (c.cancelled) return;
      var r = rangOf(c);
      (m[r.key] = m[r.key] || newRdvAgg());
      addClose(m[r.key], c);
      var pp = precOf(r); if (pp) { pp.closes++; pp.con = r2(pp.con + (Number(c.con) || 0)); }
    });
    return Object.keys(m).map(function (k) {
      var a = finRdv(m[k]);
      var na = k === NA;
      a.slug = na ? null : k;
      a.nonAttribue = na;
      a.anciens = false;
      a.precisions = na ? precOrder.map(function (p) { return prec[p]; }) : [];
      a.name = na ? 'Non attribué' : memberName(k);
      return a;
    }).sort(function (a, b) {
      if (a.nonAttribue !== b.nonAttribue) return a.nonAttribue ? 1 : -1;   // « Non attribué » en dernier, comme Global closing
      return (b.rdv - a.rdv) || (b.closes - a.closes);
    });
  }

  /* ══ 7. QUIZ — abandon question par question (quiz_funnel_daily) ═══════
     07/11/2026 : un document par jour × page × variante × VERSION publiée
     de la page (pageVersion, api/tunnel-event.js). Chaque page agrégée porte
     `latest` = la même mesure limitée à la dernière version publiée : une
     republication (suivi corrigé, question modifiée) ne mélange plus les
     compteurs d'avant et d'après. Libellé : le dernier VRAI intitulé reçu
     (un libellé égal à l'identifiant, envoyé par une ancienne version,
     ne l'emporte jamais). */
  function realLabel(label, id) { return !!label && keyOf(label) !== keyOf(id); }
  function docKeyOf(d) { return (d.page || '?') + (d.variant ? '--' + d.variant : ''); }
  /* Version EFFECTIVE d'un document : version publiée de la page + génération
     de la mesure (champ measure, posé par api/tunnel-event.js quand la page
     envoie mv — mesure injectée corrigée du 10/11/2026). */
  function effVersion(d) { return num(d.pageVersion) + num(d.measure); }
  /* Mesure COMPARABLE (10/11/2026, brief « chiffres justes », T4) : toutes les
     publications réunies tant que les questions mesurées (identifiants) ne
     changent pas. `latest` = le dernier segment de versions au même jeu de
     questions ; une version sans question mesurée ce jour-là (que des
     « start ») ne coupe pas le segment. Une nouvelle génération de mesure
     (measure) ouvre toujours un nouveau segment. */
  function buildQuizFunnel(docs) {
    docs = docs.slice().sort(function (a, b) {
      return String(a.date || '').localeCompare(String(b.date || '')) || (effVersion(a) - effVersion(b));
    });
    var all = aggQuizDocs(docs);
    var sig = {};   // page → version effective → { qid: 1 }
    docs.forEach(function (d) {
      var k = docKeyOf(d), v = effVersion(d);
      var pk = sig[k] || (sig[k] = {});
      var o = pk[v] || (pk[v] = { q: {}, measure: num(d.measure) });
      Object.keys(d.questions || {}).forEach(function (qk) { o.q[qk] = 1; });
    });
    /* Deux versions se comparent si l'une ne mesure que des questions de
       l'autre (une version peu visitée n'atteint que les premières questions). */
    function within(a, b) { return Object.keys(a).every(function (q) { return b[q]; }); }
    var seg = {}, segSince = {};
    Object.keys(sig).forEach(function (k) {
      var vs = Object.keys(sig[k]).map(Number).sort(function (a, b) { return b - a; });
      var top = sig[k][vs[0]], ref = {}, keep = {};
      for (var i = 0; i < vs.length; i++) {
        var o = sig[k][vs[i]];
        if (o.measure !== top.measure) break;
        if (!within(o.q, ref) && !within(ref, o.q)) break;
        Object.keys(o.q).forEach(function (q) { ref[q] = 1; });
        keep[vs[i]] = 1;
      }
      seg[k] = keep;
    });
    var lat = {};
    var latDocs = docs.filter(function (d) { var kp = seg[docKeyOf(d)]; return kp && kp[effVersion(d)]; });
    latDocs.forEach(function (d) {
      var k = docKeyOf(d);
      var pv = num(d.pageVersion), day = Date.parse(String(d.date || '') + 'T00:00:00+01:00');
      var from = Math.max(pv || 0, isFinite(day) ? day : 0);
      if (!segSince[k] || from < segSince[k]) segSince[k] = from;
    });
    aggQuizDocs(latDocs).forEach(function (p) { lat[p.key] = p; });
    all.forEach(function (p) {
      var l = lat[p.key];
      if (!l) return;
      l.since = segSince[p.key] || null; l.isLatest = true;
      l.partial = l.starts !== p.starts || l.days !== p.days;
      p.latest = l;
    });
    return all;
  }
  function aggQuizDocs(docs) {
    var pages = {};
    docs.forEach(function (d) {
      var k = (d.page || '?') + (d.variant ? '--' + d.variant : '');
      var p = pages[k];
      if (!p) p = pages[k] = { key: k, page: d.page, variant: d.variant || null,
        pageLabel: d.pageLabel || '', variantLabel: d.variantLabel || '',
        label: (d.pageLabel || d.page || '?') + (d.variantLabel ? ' · ' + d.variantLabel : (d.variant ? ' · ' + d.variant : '')),
        starts: 0, completes: 0, gate: { shown: 0, 'continue': 0, exit: 0, repris: 0, stop: 0 }, questions: {}, days: 0, n: 0 };
      p.days++;
      if (d.date && (!p.firstDate || d.date < p.firstDate)) p.firstDate = d.date;
      p.starts += num(d.starts); p.completes += num(d.completes);
      if (d.nQuestions) p.n = Math.max(p.n, num(d.nQuestions));
      var g = d.gate || {};
      p.gate.shown += num(g.shown); p.gate['continue'] += num(g['continue']); p.gate.exit += num(g.exit);
      p.gate.repris += num(g.repris); p.gate.stop += num(g.stop);
      var qs = d.questions || {};
      /* « Ont répondu » déduit de la question suivante (08/11/2026) : arriver
         à la question i+1 suppose d'avoir répondu à la i. Les anciennes
         versions de la page ne comptaient pas les réponses (Q1 surtout) :
         16 réponses à Q1 pour 24 arrivés à Q2 en « toutes publications ». */
      var byI = {};
      Object.keys(qs).forEach(function (qk) { var q = qs[qk] || {}; byI[num(q.i, -1)] = q; });
      function answeredOf(q) {
        var a = num(q.answered), nx = byI[num(q.i, -1) + 1];
        if (nx) a = Math.max(a, Math.min(num(q.reached), num(nx.reached)));
        return a;
      }
      Object.keys(qs).forEach(function (qk) {
        var q = qs[qk] || {};
        var x = p.questions[qk];
        if (!x) x = p.questions[qk] = { id: qk, i: num(q.i, 99), label: realLabel(q.label, qk) ? q.label : qk, reached: 0, answered: 0, answers: {} };
        else if (q.i != null) x.i = num(q.i, x.i);   // documents triés par date : le rang le plus récent l'emporte
        if (realLabel(q.label, qk)) x.label = q.label;
        x.reached += num(q.reached); x.answered += answeredOf(q);
        var as = q.answers || {};
        Object.keys(as).forEach(function (ak) {
          var a = as[ak] || {};
          var y = x.answers[ak] || (x.answers[ak] = { label: a.label || ak, n: 0 });
          y.n += num(a.n);
        });
      });
    });
    return Object.keys(pages).map(function (k) {
      var p = pages[k];
      var prev = null;
      var sorted = Object.keys(p.questions).map(function (qk) { return p.questions[qk]; })
        .sort(function (a, b) { return a.i - b.i; });
      /* COMMENCÉ = a cliqué une réponse à la 1re question (08/11/2026,
         demande Adrien). Le quiz est sur la page d'arrivée : « a vu Q1 » =
         a vu la page, ce n'est pas un début de quiz. p.shown garde ce chiffre. */
      p.shown = p.starts;
      if (sorted.length && sorted[0].answered > 0) p.starts = sorted[0].answered;
      var base = p.starts || (sorted[0] ? sorted[0].reached : 0);
      p.steps = sorted.map(function (q) {
          q.pctStart = base ? q.reached / base * 100 : null;
          q.lossPrev = prev != null ? prev - q.reached : null;
          q.lossPrevPct = prev ? (prev - q.reached) / prev * 100 : null;
          q.answerList = Object.keys(q.answers).map(function (ak) {
            var y = q.answers[ak];
            return { label: y.label, n: y.n, share: q.answered ? y.n / q.answered * 100 : null };
          }).sort(function (a, b) { return b.n - a.n; });
          prev = q.reached;
          return q;
        });
      if (!p.starts && p.steps.length) p.starts = p.steps[0].reached;
      p.completeRate = p.starts ? p.completes / p.starts * 100 : null;
      return p;
    }).sort(function (a, b) { return b.starts - a.starts; });
  }


  /* ══ 7 bis. VUE QUIZ PAR VERSION (refonte lisibilité, 06/11/2026) ══════
     Une « version » = une page de quiz × une variante (ex. /optin-a A
     « Funnel Quizz Dark », /optin-youtube A). Un lead est rattaché à la
     version qui l'a amené (landingLast / landingFirst : page lp + variante v,
     posées par api/lead-optin.js). Les leads de quiz sans page connue (avant
     le 28/09) vont dans « Anciennes versions ».
     buildQuizView fusionne, question par question et DANS L'ORDRE DU QUIZ,
     la mesure anonyme (arrivés, perdus, réponses de tous les visiteurs) et
     les résultats des leads (RDV, closes, cash, points). */
  var OLD_KEY = '_old';
  var DIAG_Q = { quiz_score_global: 1, quiz_pilier_prioritaire: 1 };

  function splitPage(page) { var m = String(page || '').split('__'); return { tunnel: m[0] || '', step: m[1] || '' }; }
  /* Famille = le quiz (tunnel) d'une version : « fam:funnel-quizz-elite »
     réunit toutes ses variantes. Deux quiz différents (Élite, Présidentielles)
     ont des identifiants de questions communs (ca_mensuel, equipe…) : leurs
     parcours ne se fusionnent JAMAIS (07/11/2026). */
  var FAM = 'fam:';
  function familyOfKey(k) { return k && k !== OLD_KEY ? splitPage(String(k).split('--')[0]).tunnel : ''; }
  function inVersion(versionKey, k) {
    if (!versionKey) return true;
    if (versionKey.indexOf(FAM) === 0) return familyOfKey(k) === versionKey.slice(FAM.length);
    return k === versionKey;
  }

  function versionMeta(key, pageObj, meta) {
    if (key === OLD_KEY) return { key: key, name: 'Anciennes versions', sub: 'leads du quiz avant le suivi par page (System.io, quiz_elite…)', platform: 'old' };
    var parts = String(key).split('--');
    var page = parts[0], v = parts[1] || '';
    var sp = splitPage(page);
    var tm = meta && meta[sp.tunnel];
    var st = tm && tm.steps ? tm.steps[sp.step] : null;
    var vm = st && st.variants && v ? st.variants[v] : null;
    var name = (pageObj && pageObj.variantLabel) || (vm && vm.label) || (st && st.name) || ('/' + sp.step);
    var youtube = /youtube/i.test(page) || (st && st.source === 'youtube') || (tm && tm.source === 'youtube');
    return { key: key, name: name, sub: '/' + sp.step + (v ? ' · variante ' + v.toUpperCase() : ' · variante non transmise'),
      platform: youtube ? 'youtube' : 'meta', page: page, variant: v || null };
  }

  /* Version de quiz d'un lead. pagesByPage : { page: [clés de versions] }. */
  function quizVersionOf(l, pagesByPage) {
    var cands = [l && l.landingLast, l && l.landingFirst];
    for (var i = 0; i < cands.length; i++) {
      var L = cands[i];
      if (!L || !L.page) continue;
      var page = String(L.page);
      if (!/__/.test(page)) continue;
      if (!pagesByPage[page] && !/quiz/i.test(page)) continue;
      var v = L.variant ? String(L.variant) : '';
      if (!v && pagesByPage[page] && pagesByPage[page].length === 1) return pagesByPage[page][0];
      return page + (v ? '--' + v : '');
    }
    return OLD_KEY;
  }
  function hasQuizAnswers(r) { return r.answers.some(function (a) { return a.o === 'quiz'; }); }

  /* Fusion de la mesure anonyme de plusieurs pages (mêmes identifiants de
     question) + détection des questions conditionnelles. */
  /* Titre lisible d'une question : les premières mesures ont pu enregistrer
     l'identifiant technique de l'étape (« pain », « r_charge ») quand la page
     n'avait pas de texte dans STEPS. On le rend lisible, sans rien inventer. */
  var KNOWN_Q = { pain: 'Principale difficulté (choix de la douleur)' };
  function prettyQuestion(label, id) {
    var t = String(label || '').trim();
    if (t && !/^[a-z0-9_-]+$/i.test(t)) return t;
    var k = String(id || t).toLowerCase().replace(/-/g, '_');
    if (KNOWN_Q[k]) return KNOWN_Q[k];
    var h = (t || String(id || '')).replace(/^(r|yn|q)_/i, '').replace(/[_-]+/g, ' ').trim();
    return h ? h.charAt(0).toUpperCase() + h.slice(1) : '—';
  }

  function mergeDropoff(pages) {
    var m = { starts: 0, shown: 0, completes: 0, from: null, gate: { shown: 0, 'continue': 0, exit: 0, repris: 0, stop: 0 }, steps: [], has: pages.length > 0 };
    var qs = {};
    pages.forEach(function (p) {
      m.starts += p.starts; m.shown += p.shown != null ? p.shown : p.starts; m.completes += p.completes;
      var f0 = measureFrom(p);
      if (f0 != null && (m.from == null || f0 < m.from)) m.from = f0;
      m.gate.shown += p.gate.shown; m.gate['continue'] += p.gate['continue']; m.gate.exit += p.gate.exit;
      m.gate.repris += p.gate.repris || 0; m.gate.stop += p.gate.stop || 0;
      Object.keys(p.questions || {}).forEach(function (qk) {
        var q = p.questions[qk];
        var x = qs[qk] || (qs[qk] = { id: qk, i: q.i, label: q.label, reached: 0, answered: 0, answers: {}, answeredByV: {} });
        if (q.i < x.i) x.i = q.i;
        if (realLabel(q.label, qk) && !realLabel(x.label, qk)) x.label = q.label;
        x.reached += q.reached; x.answered += q.answered;
        var pv = p.variant || '—';
        x.answeredByV[pv] = (x.answeredByV[pv] || 0) + q.answered;
        Object.keys(q.answers || {}).forEach(function (ak) {
          var y = x.answers[ak] || (x.answers[ak] = { label: q.answers[ak].label, n: 0, byV: {} });
          y.n += q.answers[ak].n;
          y.byV[pv] = (y.byV[pv] || 0) + q.answers[ak].n;
        });
      });
    });
    var list = Object.keys(qs).map(function (k) { return qs[k]; }).sort(function (a, b) { return a.i - b.i; });
    /* Conditionnelle : des visiteurs l'ont SAUTÉE (une question plus loin a
       plus d'arrivés). Sa perte ne se calcule pas ; les suivantes se
       comparent à la dernière question non conditionnelle. */
    list.forEach(function (q, k) {
      var later = 0;
      for (var j = k + 1; j < list.length; j++) if (list[j].reached > later) later = list[j].reached;
      q.conditional = later > q.reached * 1.05 + 1;
    });
    /* Départs : sur chaque question, ceux qui l'ont VUE mais ne sont pas
       arrivés à la suivante (question non conditionnelle suivante, ou fin du
       quiz pour la dernière). Ventilés : partis sans répondre (vue, pas de
       réponse) / partis après avoir répondu. Une question conditionnelle
       (sautée par une partie des visiteurs) n'a pas de départ calculable. */
    /* Base = ceux qui ont CLIQUÉ une réponse à la 1re question. Sur la 1re
       question, ceux qui l'ont vue sans cliquer « n'ont pas commencé »
       (notStarted) : ce n'est pas un départ du quiz. */
    var base = m.starts || (list[0] ? list[0].answered : 0), prev = null;
    list.forEach(function (q, k) {
      q.first = k === 0;
      q.pctStart = base ? q.reached / base * 100 : null;
      q.left = null; q.leftPct = null; q.leftNoAnswer = null; q.leftAfterAnswer = null; q.notStarted = null;
      if (q.conditional && !q.first) { q.seenPct = prev ? q.reached / prev * 100 : null; return; }
      var next = null;
      for (var j = k + 1; j < list.length; j++) if (!list[j].conditional) { next = list[j].reached; break; }
      if (next == null) next = m.completes;
      if (q.first) q.notStarted = Math.max(0, q.reached - q.answered);
      /* PARTIS ICI = arrivés ici − arrivés à la question suivante (08/11/2026,
         lecture unique demandée par Adrien) ; sur la 1re question ce sont
         surtout ceux qui n'ont pas cliqué. */
      q.left = Math.max(0, q.reached - next);
      q.leftPct = q.reached ? q.left / q.reached * 100 : null;
      q.leftNoAnswer = Math.min(q.left, Math.max(0, q.reached - q.answered));
      q.leftAfterAnswer = Math.max(0, q.left - q.leftNoAnswer);
      prev = q.reached;
    });
    if (!m.starts && list.length) m.starts = list[0].answered;
    m.lastReached = prev;
    m.completeRate = m.starts ? m.completes / m.starts * 100 : null;
    m.steps = list;
    return m;
  }

  /* Ordre naturel des réponses : montants / nombres croissants quand la
     question est chiffrée (tranches de CA, équipe, notes), Oui avant Non,
     sinon les plus fréquentes d'abord. */
  function answerRank(label) {
    var a = norm(label);
    if (/^oui\b/.test(a)) return { n: 0 };
    if (/^non\b/.test(a)) return { n: 1 };
    if (/pas encore|aucun|^seul|juste moi/.test(a)) return { n: -1 };
    var ns = amounts(a);
    if (!ns.length) return null;
    var max = Math.max.apply(null, ns), min = Math.min.apply(null, ns);
    if (/moins de|inferieur|</.test(a)) return { n: max - 0.5 };
    if (/plus de|superieur|au-dela|>|\+/.test(a)) return { n: max + 0.5 };
    return { n: (min + max) / 2 };
  }
  function naturalSort(list, labelOf, countOf) {
    var ranked = 0;
    list.forEach(function (x) { x._rk = answerRank(labelOf(x)); if (x._rk) ranked++; });
    var numeric = list.length > 1 && ranked >= Math.ceil(list.length * 0.6);
    list.sort(function (a, b) {
      if (numeric) {
        var ra = a._rk ? a._rk.n : Infinity, rb = b._rk ? b._rk.n : Infinity;
        if (ra !== rb) return ra - rb;
      }
      return countOf(b) - countOf(a);
    });
    list.forEach(function (x) { delete x._rk; });
    return list;
  }

  /* Version en ligne ET de type quiz :
       · tunnel, étape et variante « live », non archivés ;
       · si plusieurs variantes servies portent un poids, poids > 0 ;
       · quiz = la page est mesurée comme quiz (quiz_funnel_daily), sinon le
         libellé de la variante dit « quiz » (une variante « VSL Direct » du
         même tunnel n'en est pas un), à défaut le nom de l'étape / du tunnel.
       Sans référentiel lisible (meta null), on ne filtre pas : mieux vaut
       tout montrer que masquer à tort. */
  function onlineQuiz(key, meta, measured) {
    if (!meta) return key !== OLD_KEY;
    if (key === OLD_KEY) return false;
    var parts = String(key).split('--');
    var sp = splitPage(parts[0]), v = parts[1] || '';
    var t = meta[sp.tunnel];
    var st = t && t.steps ? t.steps[sp.step] : null;
    if (!t || !st || t.live === false || st.live === false) return false;
    var vars = st.variants || {};
    var vm = v ? vars[v] : null;
    if (!vm || vm.live === false) return false;
    var weighted = Object.keys(vars).some(function (id) { return vars[id].live !== false && vars[id].weight > 0; });
    if (weighted && !(vm.weight > 0)) return false;
    if (measured[key]) return true;
    if (vm.label) return /quiz/i.test(vm.label);
    return /quiz/i.test((st.name || '') + ' ' + (t.name || ''));
  }

  /* Début de la mesure affichée pour une page (08/11/2026) : la dernière
     publication si la bascule est active, sinon le 1er jour mesuré. Les
     leads entrés AVANT ne sont pas comptés dans les vues quiz : visiteurs et
     leads d'une même ligne couvrent toujours la même période, et le parcours
     se lit d'un bout à l'autre (arrivés → ont répondu → … → leads). */
  function measureFrom(p) {
    if (!p) return null;
    if (p.isLatest && p.since) return num(p.since);
    if (p.firstDate) { var ms = Date.parse(p.firstDate + 'T00:00:00+01:00'); return isFinite(ms) ? ms : null; }
    return null;
  }
  function quizContext(rows, pages, meta) {
    var measured = {};
    pages.forEach(function (p) { measured[p.key] = 1; });
    pages = pages.filter(function (p) { return onlineQuiz(p.key, meta, measured); });
    var pagesByPage = {}, pageByKey = {};
    pages.forEach(function (p) {
      pageByKey[p.key] = p;
      (pagesByPage[p.page] = pagesByPage[p.page] || []).push(p.key);
    });
    var allQuiz = rows.filter(hasQuizAnswers);
    allQuiz.forEach(function (r) { r._qv = quizVersionOf(r.lead, pagesByPage); });
    var quizRows = allQuiz.filter(function (r) { return onlineQuiz(r._qv, meta, measured); });
    /* 08/11/2026 (2e version) : les leads ne sont PLUS retirés. Les
       résultats commerciaux (leads, closes, signé) couvrent toute la période
       choisie ; seul le décompte « devenus leads » du parcours visiteurs est
       limité à la période mesurée (r._inMeasure), pour se lire avec lui. */
    var before = 0;
    quizRows.forEach(function (r) {
      var from = measureFrom(pageByKey[r._qv]);
      r._inMeasure = from == null || r.entry == null || r.entry >= from;
      if (!r._inMeasure) before++;
    });
    return { pagesByPage: pagesByPage, pageByKey: pageByKey, quizRows: quizRows, pages: pages, meta: meta,
      hiddenLeads: allQuiz.length - quizRows.length, beforeMeasure: before };
  }

  /* Cartes : une par version (mesure anonyme et/ou leads), triées par volume. */
  /* Visites de la page et formulaires envoyés (page_views_daily, beacon des
     tunnels depuis 09/2026) : disponibles AVANT la mesure question par
     question, et sur tout l'historique. */
  function viewsFor(views, key) {
    var o = { views: 0, optins: 0 };
    (views || []).forEach(function (d) {
      if (!d || !d.page) return;
      var k = String(d.page) + (d.variant ? '--' + d.variant : '');
      if (k !== key) return;
      o.views += num(d.views); o.optins += num(d.optins);
    });
    return o;
  }
  function quizVersions(rows, pages, meta, views) {
    var C = quizContext(rows, pages, meta);
    pages = C.pages;
    var keys = {};
    pages.forEach(function (p) { keys[p.key] = 1; });
    C.quizRows.forEach(function (r) { keys[r._qv] = 1; });
    var list = Object.keys(keys).map(function (k) {
      var m = versionMeta(k, C.pageByKey[k], meta);
      var p = C.pageByKey[k];
      var agg = newAgg();
      C.quizRows.forEach(function (r) { if (r._qv === k) addLeadRow(agg, r); });
      m.starts = p ? p.starts : 0; m.completes = p ? p.completes : 0;
      var pv = k === OLD_KEY ? { views: 0, optins: 0 } : viewsFor(views, k);
      m.views = pv.views; m.optins = pv.optins;
      m.completeRate = p && p.starts ? p.completes / p.starts * 100 : null;
      m.agg = fin(agg);
      return m;
    });
    list.sort(function (a, b) {
      if ((a.key === OLD_KEY) !== (b.key === OLD_KEY)) return a.key === OLD_KEY ? 1 : -1;
      return (b.starts + b.agg.leads * 10) - (a.starts + a.agg.leads * 10);
    });
    var tot = newAgg();
    C.quizRows.forEach(function (r) { addLeadRow(tot, r); });
    var all = { key: '', name: 'Tous les quiz', sub: list.length + ' version' + (list.length > 1 ? 's' : ''), platform: 'all',
      starts: 0, completes: 0, agg: fin(tot) };
    pages.forEach(function (p) { all.starts += p.starts; all.completes += p.completes; });
    all.views = 0; all.optins = 0;
    list.forEach(function (v) { all.views += v.views; all.optins += v.optins; });
    all.completeRate = all.starts ? all.completes / all.starts * 100 : null;
    /* Familles : un quiz (tunnel) toutes variantes confondues. */
    var fams = {};
    list.forEach(function (v) {
      var f = familyOfKey(v.key);
      if (!f) return;
      var F = fams[f] || (fams[f] = { key: FAM + f, family: f, name: '', sub: '', platform: v.platform, starts: 0, completes: 0, views: 0, optins: 0, versions: [], leads: 0 });
      F.versions.push(v.key); F.starts += v.starts; F.completes += v.completes; F.views += v.views; F.optins += v.optins; F.leads += v.agg.leads;
    });
    var famList = Object.keys(fams).map(function (f) {
      var F = fams[f], tm = meta && meta[f];
      var pg = C.pageByKey[F.versions[0]];
      F.name = (tm && tm.name) || (pg && pg.pageLabel ? String(pg.pageLabel).split(' · ')[0] : f);
      F.sub = F.versions.length + ' variante' + (F.versions.length > 1 ? 's' : '') + ' réunie' + (F.versions.length > 1 ? 's' : '');
      F.completeRate = F.starts ? F.completes / F.starts * 100 : null;
      var agg = newAgg();
      C.quizRows.forEach(function (r) { if (familyOfKey(r._qv) === f) addLeadRow(agg, r); });
      F.agg = fin(agg);
      return F;
    }).sort(function (a, b) { return (b.starts + b.leads * 10) - (a.starts + a.leads * 10); });
    return { all: all, list: list, hiddenLeads: C.hiddenLeads, families: famList };
  }

  /* Regroupe les questions de leads qui sont le même écran sous deux
     intitulés. Retourne { clé: clé retenue, _label: { clé retenue: libellé } }. */
  function canonLeadQuestions(vRows, steps) {
    var info = {}, order = [];
    vRows.forEach(function (r, ri) {
      r.answers.forEach(function (a) {
        if (a.o !== 'quiz' || DIAG_Q[a.q]) return;
        var x = info[a.q];
        if (!x) { x = info[a.q] = { q: a.q, label: a.ql, ans: {}, rows: {}, n: 0 }; order.push(a.q); }
        x.ans[a.a] = 1; if (!x.rows[ri]) { x.rows[ri] = 1; x.n++; }
      });
    });
    var stepLabels = {};
    (steps || []).forEach(function (st) { stepLabels[keyOf(st.label)] = 1; stepLabels['quiz_' + String(st.id).replace(/-/g, '_')] = 1; });
    function matchesStep(k) { return !!(stepLabels[keyOf(info[k].label)] || stepLabels[k]); }
    function overlap(a, b) {
      var ka = Object.keys(info[a].ans), kb = info[b].ans, c = 0;
      ka.forEach(function (x) { if (kb[x]) c++; });
      var m = Math.min(ka.length, Object.keys(kb).length);
      return m >= 2 ? c / m : 0;
    }
    function crosses(a, b) { for (var ri in info[a].rows) if (info[b].rows[ri]) return true; return false; }
    order.sort(function (a, b) { return info[b].n - info[a].n; });
    var group = {}, groups = [];
    order.forEach(function (k) {
      if (group[k]) return;
      var g = [k]; group[k] = g; groups.push(g);
      order.forEach(function (j) {
        if (group[j] || j === k) return;
        if (overlap(k, j) >= 0.6 && !g.some(function (m) { return crosses(m, j); })) { g.push(j); group[j] = g; }
      });
    });
    var out = { _label: {} };
    groups.forEach(function (g) {
      if (g.length < 2) return;
      var keep = g.filter(matchesStep)[0] || g[0];
      g.forEach(function (k) { out[k] = keep; });
      out._label[keep] = info[keep].label;
    });
    return out;
  }

  /* Parcours d'une version ('' = toutes, 'fam:<tunnel>' = un quiz toutes
     variantes) : questions dans l'ordre, chacune avec la mesure anonyme ET
     les résultats des leads, réponse par réponse. */
  function buildQuizView(rows, pages, versionKey, grid, meta) {
    var C = quizContext(rows, pages, meta);
    pages = C.pages;
    var vPages = pages.filter(function (p) { return inVersion(versionKey, p.key); });
    var drop = mergeDropoff(vPages);
    var vRows = C.quizRows.filter(function (r) { return inVersion(versionKey, r._qv); });
    var tot = newAgg();
    vRows.forEach(function (r) { addLeadRow(tot, r); });
    fin(tot);

    /* Questions des leads (origine quiz). Les leads n'ont que le TEXTE de la
       question (reponses_json) : un intitulé qui change (ex. Q1 courte de la
       variante d avant le 07/11 13 h 20) créait une 2e ligne. Deux questions
       de leads sont la même si elles ne se croisent jamais chez un même lead
       ET partagent l'essentiel de leurs réponses ; la question retenue est
       celle dont l'intitulé correspond à la mesure visiteurs. */
    var canon = canonLeadQuestions(vRows, drop.steps);
    var lq = {};
    vRows.forEach(function (r) {
      r.answers.forEach(function (a) {
        if (a.o !== 'quiz') return;
        var ck = canon[a.q] || a.q;
        if (ck !== a.q) a = { q: ck, ql: canon._label[ck], a: a.a, al: a.al, o: a.o, ord: a.ord };
        var q = lq[a.q] || (lq[a.q] = { q: a.q, label: a.ql, ord: a.ord, answers: {}, agg: newAgg(), ids: {}, rows: [] });
        if (a.ord < q.ord) q.ord = a.ord;
        /* Choix multiple : clé = texte COMPLET (keyOf coupe à 60 car. et
           fusionnait deux combinaisons qui commencent pareil). */
        var axk = / \| /.test(a.al || '') ? 'm§' + a.al : a.a;
        var x = q.answers[axk] || (q.answers[axk] = { a: a.a, q: a.q, ql: a.ql, label: a.al, agg: newAgg(), rows: [] });
        addLeadRow(x.agg, r); x.rows.push(r);
        if (!q.ids[r.id]) { q.ids[r.id] = 1; q.rows.push(r); addLeadRow(q.agg, r); }
      });
    });

    /* Rapprochement mesure ↔ contacts : même libellé de question, champ
       nommé (quiz_ca_mensuel ↔ question « ca_mensuel »), sinon libellé
       proche (mots en commun ≥ 60 %, ou l'un contient l'autre) — le titre
       lu à l'écran peut différer d'une virgule de celui du quiz. */
    function words(t) { return keyOf(t).split('_').filter(function (w) { return w.length > 2; }); }
    function wordSim(a, b) {
      var A = words(a), B = words(b);
      if (!A.length || !B.length) return 0;
      var setB = {}, inter = 0, uni = {};
      B.forEach(function (w) { setB[w] = 1; uni[w] = 1; });
      A.forEach(function (w) { if (setB[w]) inter++; uni[w] = 1; });
      return inter / Object.keys(uni).length;
    }
    var byLabel = {};
    Object.keys(lq).forEach(function (k) { byLabel[keyOf(lq[k].label)] = k; });
    var used = {};
    function leadQFor(step) {
      var sk = keyOf(step.label);
      var k1 = byLabel[sk];
      if (k1 && !used[k1]) return k1;
      var k2 = 'quiz_' + String(step.id).replace(/-/g, '_');
      if (lq[k2] && !used[k2]) return k2;
      var best = null, bestS = 0;
      Object.keys(lq).forEach(function (k) {
        if (used[k] || DIAG_Q[k]) return;
        var lk = keyOf(lq[k].label);
        var sc = wordSim(step.label, lq[k].label);
        if (sk.length > 8 && lk.length > 8 && (sk.indexOf(lk) >= 0 || lk.indexOf(sk) >= 0)) sc = Math.max(sc, 0.9);
        if (sc > bestS) { bestS = sc; best = k; }
      });
      if (bestS >= 0.6) return best;
      /* Intitulés différents (07/11/2026) : mêmes réponses = même question
         (au moins 2 réponses communes, 60 % des réponses de la plus petite). */
      var sa = {};
      Object.keys(step.answers || {}).forEach(function (ak) { sa[keyOf(step.answers[ak].label)] = 1; });
      var ns = Object.keys(sa).length, bestR = 0;
      best = null;
      if (ns >= 2) Object.keys(lq).forEach(function (k) {
        if (used[k] || DIAG_Q[k]) return;
        var la = Object.keys(lq[k].answers).map(function (a) { return keyOf(lq[k].answers[a].label); });
        var c = la.filter(function (x) { return sa[x]; }).length, m = Math.min(ns, la.length);
        var r = m >= 2 && c >= 2 ? c / m : 0;
        if (r >= 0.6 && r > bestR) { best = k; bestR = r; }
      });
      return best;
    }
    /* Ordre = ordre d'apparition au prospect : celui de la page (rang de la
       question dans le quiz). Une question connue seulement par les contacts
       (pas encore mesurée) est remise juste après la question mesurée qui la
       précède dans les réponses des contacts — jamais reléguée en fin. */
    var cards = [];
    drop.steps.forEach(function (st) {
      var k = leadQFor(st);
      if (k) used[k] = 1;
      cards.push({ step: st, lq: k ? lq[k] : null, q: k, label: prettyQuestion(st.label, st.id), diag: false, pos: st.i });
    });
    var anchors = cards.filter(function (c) { return c.lq; }).map(function (c) { return { ord: c.lq.ord, pos: c.pos }; })
      .sort(function (a, b) { return a.ord - b.ord; });
    Object.keys(lq).filter(function (k) { return !used[k]; }).forEach(function (k) {
      var o = lq[k].ord, pos;
      if (!drop.steps.length) pos = o;
      else {
        pos = -1;
        anchors.forEach(function (a) { if (a.ord <= o) pos = a.pos; });
        pos += 0.5 + Math.min(o, 999) / 10000;
      }
      cards.push({ step: null, lq: lq[k], q: k, label: lq[k].label, diag: !!DIAG_Q[k], pos: pos });
    });
    /* Questions à BRANCHES (08/11/2026) : la 2e question change d'intitulé
       selon la réponse à Q1 (« déjà tenté pour sortir de l'opérationnel /
       relancer votre CA / … ») mais la page la mesure sous UN identifiant.
       Une question de contacts sans mesure rejoint la question mesurée dont
       l'intitulé commence par les mêmes mots (4 au moins) si aucun contact
       n'a répondu aux deux : une seule ligne, réponses de toutes les branches. */
    function lead(t) { return keyOf(t).split('_').filter(Boolean); }
    function sameStart(a, b) {
      var A = lead(a), B = lead(b), n = 0;
      while (n < A.length && n < B.length && A[n] === B[n]) n++;
      return n >= 4;
    }
    function disjoint(q1, q2) { return !q2.rows.some(function (r) { return q1.ids[r.id]; }); }
    function mergeInto(dst, src) {
      src.rows.forEach(function (r) { if (!dst.ids[r.id]) { dst.ids[r.id] = 1; dst.rows.push(r); addLeadRow(dst.agg, r); } });
      /* réponses gardées par version de la question (sous-titres) */
      Object.keys(src.answers).forEach(function (ak) { dst.answers[src.q + '§' + ak] = src.answers[ak]; });
    }
    var measured = cards.filter(function (c) { return c.step && !c.diag; });
    cards = cards.filter(function (c) {
      if (c.step || c.diag || !c.lq) return true;
      var host = null;
      measured.forEach(function (m) {
        if (host) return;
        if (!sameStart(m.label, c.lq.label) && !(m.lq && sameStart(m.lq.label, c.lq.label))) return;
        if (m.lq && !disjoint(m.lq, c.lq)) return;
        host = m;
      });
      if (!host) return true;
      if (!host.lq) { host.lq = c.lq; host.q = c.q; }
      else mergeInto(host.lq, c.lq);
      host.branches = (host.branches || 1) + 1;
      return false;
    });
    cards.sort(function (a, b) { return a.pos - b.pos; });
    /* Résultat du diagnostic toujours à la fin */
    cards.sort(function (a, b) { return (a.diag ? 1 : 0) - (b.diag ? 1 : 0); });

    cards.forEach(function (c, idx) {
      c.n = idx + 1;
      if (c.lq) fin(c.lq.agg);
      /* Réponses (08/11/2026, demande Adrien) :
         · choix MULTIPLE (« A | B | C ») découpé : une ligne par option, une
           personne qui en coche 3 compte dans les 3 (total > 100 %) ;
         · groupées par VERSION de la question (intitulé qui change selon Q1) ;
         · détail par variante de page (byV) quand la vue en réunit plusieurs. */
      var defBranch = c.lq ? c.lq.label : c.label;
      var multi = false;
      if (c.step) Object.keys(c.step.answers).forEach(function (ak) { if (/ \| /.test(c.step.answers[ak].label || '')) multi = true; });
      if (c.lq) Object.keys(c.lq.answers).forEach(function (ak) { if (/ \| /.test(c.lq.answers[ak].label || '')) multi = true; });
      function partsOf(label) {
        var t = String(label == null ? '' : label);
        return multi ? t.split(' | ').map(function (x) { return x.trim(); }).filter(Boolean) : [t];
      }
      /* Grouper par version seulement si les versions ont des options
         différentes ; mêmes options partout (« Depuis combien de temps… ») →
         une seule liste, sinon « Plus de 3 ans » serait éclaté en 3 lignes. */
      var brOf = {}, shared = {}, nBr = {};
      if (c.lq) Object.keys(c.lq.answers).forEach(function (ak) {
        var x = c.lq.answers[ak], br = x.ql || defBranch;
        nBr[br] = 1;
        partsOf(x.label).forEach(function (pt) {
          var k = keyOf(pt);
          if (brOf[k] && brOf[k] !== br) shared[k] = 1;
          brOf[k] = br;
        });
      });
      /* une option commune à deux versions (« Rien de concret… ») ne suffit
         pas à tout fusionner : liste unique seulement si la MAJORITÉ des
         options est commune */
      /* Versions aux options VRAIMENT différentes (Q2 : ~16 options, 4-5 par
         version) → sous-titres ; mêmes options partout (Q3 « Depuis combien
         de temps » : 4 durées) → une seule liste. Critère : au moins 6
         options en tout, et au moins 1,8 fois la version la plus fournie. */
      var perBr = {};
      if (c.lq) Object.keys(c.lq.answers).forEach(function (ak) {
        var x = c.lq.answers[ak], br = x.ql || defBranch;
        perBr[br] = perBr[br] || {};
        partsOf(x.label).forEach(function (pt) { perBr[br][keyOf(pt)] = 1; });
      });
      var union = {};
      Object.keys(brOf).forEach(function (k) { union[k] = 1; });
      if (c.step) Object.keys(c.step.answers).forEach(function (ak) { partsOf(c.step.answers[ak].label).forEach(function (pt) { union[keyOf(pt)] = 1; }); });
      var nUnion = Object.keys(union).length, maxBr = 0;
      Object.keys(perBr).forEach(function (b) { maxBr = Math.max(maxBr, Object.keys(perBr[b]).length); });
      var grouped = Object.keys(nBr).length > 1 && nUnion >= 6 && nUnion >= 1.8 * maxBr;
      var OTHER = 'Autres versions de la question (réponses vues seulement chez les visiteurs)';
      var m = {}, order = [];
      function opt(label, branch) {
        if (!grouped) branch = defBranch;
        var key = keyOf(branch) + '§' + keyOf(label);
        if (!m[key]) { m[key] = { key: keyOf(label), label: label, branch: branch, visitors: null, byV: {}, agg: null, rows: [], ids: {}, leadsByV: {} }; order.push(key); }
        return m[key];
      }
      if (c.lq) Object.keys(c.lq.answers).forEach(function (ak) {
        var x = c.lq.answers[ak], br = x.ql || defBranch;
        partsOf(x.label).forEach(function (pt) {
          var o = opt(pt, br);
          o.a = multi ? keyOf(pt) : (x.a || ak); o.qk = x.q; o.ql = x.ql;
          x.rows.forEach(function (r) {
            if (o.ids[r.id]) return;
            o.ids[r.id] = 1; o.rows.push(r);
            var v = String(r._qv || '').split('--')[1] || '—';
            o.leadsByV[v] = (o.leadsByV[v] || 0) + 1;
          });
        });
      });
      /* Libellé coupé par la mesure (60 car.) : rattaché à l'option connue
         qui commence pareil, dans n'importe quelle version de la question. */
      function findOpt(pt) {
        var k = keyOf(pt), hit = null;
        order.forEach(function (key) { var o = m[key]; if (!hit && o.key === k) hit = o; });
        if (!hit && pt.length >= 8) order.forEach(function (key) { var o = m[key]; if (!hit && keyOf(o.label).indexOf(k) === 0) hit = o; });
        return hit;
      }
      if (c.step) Object.keys(c.step.answers).forEach(function (ak) {
        var y = c.step.answers[ak];
        partsOf(y.label).forEach(function (pt) {
          var cut = pt === partsOf(y.label).slice(-1)[0] && String(y.label).length >= 118 && !findOpt(pt);   // libellé coupé à 120 car. (api/tunnel-event.js)
          var o = findOpt(pt) || opt(cut ? pt + '…' : pt, grouped ? OTHER : defBranch);
          o.visitors = (o.visitors || 0) + y.n;
          Object.keys(y.byV || {}).forEach(function (v) { o.byV[v] = (o.byV[v] || 0) + y.byV[v]; });
        });
      });
      var answered = c.step ? c.step.answered : 0;
      c.multi = multi;
      var list = order.map(function (k2) {
        var o = m[k2];
        if (o.rows.length) { o.agg = newAgg(); o.rows.forEach(function (r) { addLeadRow(o.agg, r); }); fin(o.agg); }
        delete o.ids;
        o.visitorShare = answered && o.visitors != null ? o.visitors / answered * 100 : null;
        o.leadShare = c.lq && o.agg ? o.agg.leads / c.lq.agg.leads * 100 : null;
        if (c.q && o.a) {
          var rule = ruleFor(grid, { q: o.qk || c.q, a: o.a, ql: o.ql || c.lq.label, al: o.label });
          o.pts = rule.off ? 0 : rule.pts; o.ko = !!rule.ko; o.known = !!rule.known;
        }
        return o;
      });
      c.answers = naturalSort(list, function (o) { return o.label; }, function (o) { return (o.visitors || 0) + (o.agg ? o.agg.leads * 10 : 0); });
      /* Réponse NON ENREGISTRÉE (08/11/2026, revue) : une ancienne version
         de la page (et la page Présidentielles) comptait qu'on avait répondu
         sans dire quoi. Ligne à part pour que les réponses fassent le total
         de « ont répondu » (question à choix unique). */
      if (c.step && !multi) {
        var known = 0, knownV = {};
        c.answers.forEach(function (o) { known += o.visitors || 0; Object.keys(o.byV || {}).forEach(function (v) { knownV[v] = (knownV[v] || 0) + o.byV[v]; }); });
        if (answered - known > 0) {
          var nrV = {};
          Object.keys(c.step.answeredByV || {}).forEach(function (v) { var d = c.step.answeredByV[v] - (knownV[v] || 0); if (d > 0) nrV[v] = d; });
          c.answers.push({ key: '__nr', label: 'Réponse non enregistrée par la page', branch: defBranch, visitors: answered - known,
            byV: nrV, agg: null, leadsByV: {}, nr: true, visitorShare: (answered - known) / answered * 100 });
        }
      }
      var best = null, worst = null;
      c.answers.forEach(function (o) {
        if (!o.agg || o.agg.leads < SUGGEST_MIN || o.agg.conPerLead == null) return;
        if (!best || o.agg.conPerLead > best.agg.conPerLead) best = o;
        if (!worst || o.agg.conPerLead < worst.agg.conPerLead) worst = o;
      });
      if (best && worst && best !== worst && best.agg.conPerLead > worst.agg.conPerLead) { best.best = true; worst.worst = true; }
      /* Sous-titres : une version de la question = un groupe (ordre : celle
         de la mesure d'abord, puis par nombre de leads). */
      var gm = {}, gl = [];
      c.answers.forEach(function (o) {
        var g = gm[o.branch];
        if (!g) { g = gm[o.branch] = { label: o.branch, answers: [], n: 0 }; gl.push(g); }
        g.answers.push(o); g.n += (o.visitors || 0) + (o.agg ? o.agg.leads : 0);
      });
      gl.sort(function (a, b) { return (a.label === OTHER ? 1 : 0) - (b.label === OTHER ? 1 : 0) || b.n - a.n; });
      c.groups = gl;
    });
    /* Variantes de page présentes dans la vue (détail A / D) */
    var vset = {};
    vPages.forEach(function (p) { if (p.variant) vset[p.variant] = 1; });
    vRows.forEach(function (r) { var v = String(r._qv || '').split('--')[1]; if (v) vset[v] = 1; });
    var variants = Object.keys(vset).sort();
    var worstLoss = null;
    cards.forEach(function (c) { if (c.step && !c.step.first && c.step.left != null && (!worstLoss || c.step.left > worstLoss.step.left)) worstLoss = c; });   // la 1re question = ceux qui n'ont pas cliqué, pas un abandon
    if (worstLoss && worstLoss.step.left > 0) worstLoss.hot = true;

    var inM = vRows.filter(function (r) { return r._inMeasure !== false; }).length;
    return { versionKey: versionKey || '', drop: drop, total: tot, cards: cards, leads: vRows.length, leadsInMeasure: inM,
      beforeMeasure: vRows.length - inM, variants: variants };
  }

  /* ══ 7 ter. VUE D'ENSEMBLE PAR QUIZ — CHIFFRES DE RÉFÉRENCE (10/11/2026) ══
     Brief « Mesure des quiz : des chiffres justes » (T2). Un tableau par
     QUIZ (tunnel) et par variante, jamais deux quiz mélangés, construit
     uniquement sur les compteurs déjà fiables, sans découpage par version :
       · arrivés         = page affichée            page_views_daily.views
       · ont répondu Q1  = 1er clic sur une réponse page_views_daily.ctas
                           (ALTEO.track('cta') dans trkStart, deux pages)
       · rien cliqué     = arrivés − ont répondu Q1
       · fini les questions = écran final atteint   quiz_funnel_daily.completes
                           (toutes publications réunies ; null = pas mesuré)
       · formulaire envoyé = page_views_daily.optins
       · nouveaux leads  = fiches dont la page d'entrée (landingFirst, via
                           optin) est ce quiz, entrées ce jour-là
       · déjà connus revenus = ré-inscrits (lastOptinAt) par ce quiz
                           (landingLast), entrés avant la période
       · RDV pris / présents = RDV créés sur la période (Self Booking +
                           Setting, hors reports, transferts et doublons),
                           provenance bookings.landing ou page d'entrée de la
                           fiche ; présent = RDV terminal de la chaîne où le
                           prospect est venu (StatsCore).
     Jours de Paris. « Période couverte » = premier et dernier jour où la page
     a des visites mesurées, dans la période choisie. */
  function parisIso(ms) {
    if (ms == null || !isFinite(ms)) return null;
    return SC.jourParis(ms);
  }
  /* mQ1 / mOptins : ont répondu Q1 et formulaires des seuls jours où l'écran
     de fin est mesuré — le taux « ont fini » ne compare que ce qui est comparable. */
  /* present = RDV pris dont le RDV terminal (après reports / transferts) est
     « présent » (StatsCore). Ancien nom `kept` (et rKept) gardé en alias :
     au Stats funnel « Kept » veut dire autre chose (RDV − annulés). */
  var OV_FIELDS = ['arrives', 'q1', 'done', 'optins', 'newLeads', 'backLeads', 'booked', 'present', 'kept', 'mQ1', 'mOptins', 'q1Quiz'];
  function ovZero() { var o = { doneMeasured: false, doneSince: null }; OV_FIELDS.forEach(function (f) { o[f] = 0; }); return o; }
  function ovAdd(a, b) {
    OV_FIELDS.forEach(function (f) { a[f] += b[f] || 0; });
    if (b.doneMeasured) { a.doneMeasured = true; if (b.doneSince && (!a.doneSince || b.doneSince < a.doneSince)) a.doneSince = b.doneSince; }
  }
  function ovFinish(o) {
    o.none = Math.max(0, o.arrives - o.q1);
    o.rQ1 = o.arrives ? o.q1 / o.arrives * 100 : null;
    o.rDone = o.doneMeasured && o.mQ1 ? o.done / o.mQ1 * 100 : null;
    o.rOptin = o.doneMeasured ? (o.done ? o.mOptins / o.done * 100 : null) : (o.q1 ? o.optins / o.q1 * 100 : null);
    o.rLead = o.optins ? (o.newLeads + o.backLeads) / o.optins * 100 : null;
    o.rBook = (o.newLeads + o.backLeads) ? o.booked / (o.newLeads + o.backLeads) * 100 : null;
    o.rPresent = o.booked ? o.present / o.booked * 100 : null;
    o.rKept = o.rPresent;
    return o;
  }
  function quizOverview(D, P, meta) {
    D = D || {};
    var sIso = parisIso(P.start.getTime()), eIso = parisIso(P.end.getTime());
    var isTunnelKey = function (pg) { return /^[a-z0-9-]+__[a-z0-9-]+$/.test(String(pg || '')); };
    /* 1. Pages quiz : mesurées comme quiz (quiz_funnel_daily) ou ayant amené
       un lead avec des réponses de quiz. */
    var quizPages = {};
    (D.quizDocs || []).forEach(function (d) { if (isTunnelKey(d.page)) quizPages[d.page] = 1; });
    function leadPage(L) { return L && L.page && L.via === 'optin' && isTunnelKey(L.page) ? L.page : null; }
    (D.leads || []).concat(D.reoptins || []).forEach(function (l) {
      if (!l || !l.quiz) return;
      [l.landingFirst, l.landingLast].forEach(function (L) { var pg = leadPage(L); if (pg) quizPages[pg] = 1; });
    });
    var cells = {};   // page → variante → jour → compteurs
    function cell(page, variant, day) {
      if (!quizPages[page] || !day || day < sIso || day > eIso) return null;
      var v = variant || '_';
      var pc = cells[page] || (cells[page] = {});
      var vc = pc[v] || (pc[v] = {});
      return vc[day] || (vc[day] = ovZero());
    }
    (D.views || []).forEach(function (r) {
      var c = cell(r.page, r.variant, r.date);
      if (!c) return;
      c.arrives += num(r.views); c.q1 += num(r.ctas); c.optins += num(r.optins);
    });
    (D.quizDocs || []).forEach(function (d) {
      var c = cell(d.page, d.variant, d.date);
      if (!c) return;
      c.done += num(d.completes);
      if (!c.doneMeasured) { c.doneMeasured = true; c.doneSince = d.date; }
      /* Réponses à la 1re question vues par la mesure du quiz (contrôle T5) :
         seulement la génération de mesure la plus récente du jour. */
      var g = num(d.measure);
      if (c._gen == null || g > c._gen) { c._gen = g; c.q1Quiz = 0; }
      if (g === c._gen) {
        var qs = d.questions || {};
        Object.keys(qs).forEach(function (qk) { var q = qs[qk] || {}; if (num(q.i, -1) === 0) c.q1Quiz += num(q.answered); });
      }
    });
    /* 2. Leads (nouveaux / revenus) */
    var leadsById = {}, byP9 = {}, byEmail = {};
    function idx(l) {
      if (!l || !l._id || leadsById[l._id]) return;
      leadsById[l._id] = l;
      if (l._p9 && !byP9[l._p9]) byP9[l._p9] = l;
      var em = String(l.email || '').toLowerCase().trim();
      if (em && !byEmail[em]) byEmail[em] = l;
    }
    (D.leads || []).forEach(function (l) {
      idx(l);
      var L = l.landingFirst, pg = leadPage(L);
      if (!pg) return;
      var c = cell(pg, L.variant, parisIso(l._entry));
      if (c) c.newLeads++;
    });
    (D.reoptins || []).forEach(function (l) {
      idx(l);
      var L = l.landingLast, pg = leadPage(L);
      if (!pg) return;
      var c = cell(pg, L.variant, parisIso(FC.parseFlexMs(l.lastOptinAt)));
      if (c) c.backLeads++;
    });
    (D.extraLeads || []).forEach(idx);
    /* 3. RDV */
    var byId = D.bookingsById || {};
    function leadOf(b) {
      if (b.leadId && leadsById[b.leadId]) return leadsById[b.leadId];
      if (b._p9 && byP9[b._p9]) return byP9[b._p9];
      var em = String(b.prospect && b.prospect.email || '').toLowerCase().trim();
      return em && byEmail[em] ? byEmail[em] : null;
    }
    /* RDV pris = têtes de chaîne Self Booking / Setting (StatsCore.estRdvPris),
       hors reports / transferts et doublons supprimés ; présent = RDV
       terminal de la chaîne présent (StatsCore). */
    (D.bookings || []).forEach(function (b) {
      if (SC.estRemplacant(b) || SC.estDoublon(b)) return;
      if (!SC.estRdvPris(b._class)) return;
      var cm = b._createdMs;
      if (cm == null || cm < P.start.getTime() || cm > P.end.getTime()) return;
      var L = b.landing && b.landing.page ? b.landing : null;
      if (!L) { var l = leadOf(b); var LF = l && l.landingFirst; if (LF && leadPage(LF)) L = LF; }
      if (!L) return;
      var c = cell(L.page, L.variant, parisIso(cm));
      if (!c) return;
      c.booked++;
      if (SC.estPresent(FC.rdvTerminal(b, byId) || b)) { c.present++; c.kept++; }
    });
    /* 4. Mise en forme : quiz → variantes → jours */
    var byQuiz = {};
    Object.keys(cells).forEach(function (page) {
      var sp = splitPage(page), tm = meta && meta[sp.tunnel], st = tm && tm.steps ? tm.steps[sp.step] : null;
      var q = byQuiz[sp.tunnel] || (byQuiz[sp.tunnel] = { tunnel: sp.tunnel, name: (tm && tm.name) || sp.tunnel, pages: [], total: ovZero(), days: {} });
      Object.keys(cells[page]).sort().forEach(function (v) {
        var vm = st && st.variants && v !== '_' ? st.variants[v] : null;
        var row = { page: page, path: '/' + sp.step, variant: v === '_' ? null : v, label: (vm && vm.label) || (v === '_' ? 'variante non transmise' : 'Variante ' + v.toUpperCase()),
          total: ovZero(), days: [], first: null, last: null };
        Object.keys(cells[page][v]).sort().forEach(function (day) {
          var c = cells[page][v][day];
          if (c.doneMeasured) { c.mQ1 = c.q1; c.mOptins = c.optins; }
          ovAdd(row.total, c);
          if (c.arrives > 0) { if (!row.first) row.first = day; row.last = day; }
          var qd = q.days[day] || (q.days[day] = ovZero());
          ovAdd(qd, c);
          row.days.push(Object.assign({ day: day }, ovFinish(c)));
        });
        ovFinish(row.total);
        row.total.days = row.days.length;
        ovAdd(q.total, row.total);
        q.pages.push(row);
      });
    });
    /* 5. Dépense Meta par quiz (T6) — UNE campagne peut mener à deux quiz
       (« TOFU | Funnel élections 2027 » contient d'anciennes pubs Élite qui
       mènent à /optin-a) : la dépense de chaque pub (ads_insights_ad) est
       répartie entre tunnels au prorata des visites de CETTE pub
       (tunnel_stats_daily.sources, utm_content = nom ou id de la pub), le même
       jour, sinon sur la période. Sans visite rattachée : « non rattachée ». */
    var spend = ovSpend(D, sIso, eIso);
    Object.keys(byQuiz).forEach(function (k) {
      byQuiz[k].spend = r2(spend.byTunnel[k] || 0);
      Object.keys(byQuiz[k].days).forEach(function (d) { byQuiz[k].days[d].spend = r2((spend.byTunnelDay[k] || {})[d] || 0); });
    });
    var out = Object.keys(byQuiz).map(function (k) {
      var q = byQuiz[k];
      ovFinish(q.total);
      q.dayList = Object.keys(q.days).sort().map(function (d) { return Object.assign({ day: d }, ovFinish(q.days[d])); });
      q.total.days = q.dayList.length;
      var firsts = q.pages.map(function (r) { return r.first; }).filter(Boolean).sort();
      var lasts = q.pages.map(function (r) { return r.last; }).filter(Boolean).sort();
      q.first = firsts[0] || null; q.last = lasts[lasts.length - 1] || null;
      q.doneMeasured = q.total.doneMeasured;
      q.cpl = q.total.newLeads ? r2(q.spend / q.total.newLeads) : null;
      return q;
    }).sort(function (a, b) { return b.total.arrives - a.total.arrives; });
    out.spendUnattributed = r2(spend.unattributed);
    out.spendTotal = r2(spend.total);
    return out;
  }
  function adKeyOf(v) {
    var x = String(v == null ? '' : v);
    try { x = decodeURIComponent(x.replace(/\+/g, ' ')); } catch (e) { /* tel quel */ }
    return norm(x).replace(/\s+/g, ' ').trim();
  }
  function ovSpend(D, sIso, eIso) {
    var names = {};
    (D.creatives || []).forEach(function (c) { if (c && c.ad_id) names[String(c.ad_id)] = c.ad_name || ''; });
    var vDay = {}, vAll = {};   // clé pub → tunnel → visites (par jour / période)
    (D.tunnelStats || []).forEach(function (t) {
      if (!t || !t.date || t.date < sIso || t.date > eIso || !t.tunnelSlug) return;
      var src = t.sources || {};
      Object.keys(src).forEach(function (sk) {
        var x = src[sk] || {}, k = adKeyOf(x.utm_content);
        if (!k) return;
        var n = num(x.visits);
        if (!n) return;
        var dk = t.date + '|' + k;
        (vDay[dk] = vDay[dk] || {})[t.tunnelSlug] = ((vDay[dk] || {})[t.tunnelSlug] || 0) + n;
        (vAll[k] = vAll[k] || {})[t.tunnelSlug] = ((vAll[k] || {})[t.tunnelSlug] || 0) + n;
      });
    });
    var res = { byTunnel: {}, byTunnelDay: {}, unattributed: 0, total: 0 };
    (D.adsByAd || []).forEach(function (a) {
      if (!a || !a.date || a.date < sIso || a.date > eIso) return;
      var sp = num(a.spend);
      if (!sp) return;
      res.total += sp;
      var keys = [adKeyOf(a.ad_id), adKeyOf(a.ad_name || names[String(a.ad_id)])].filter(Boolean);
      var share = null;
      keys.forEach(function (k) { if (!share && vDay[a.date + '|' + k]) share = vDay[a.date + '|' + k]; });
      keys.forEach(function (k) { if (!share && vAll[k]) share = vAll[k]; });
      if (!share) { res.unattributed += sp; return; }
      var tot = 0; Object.keys(share).forEach(function (t) { tot += share[t]; });
      Object.keys(share).forEach(function (t) {
        var part = sp * share[t] / tot;
        res.byTunnel[t] = (res.byTunnel[t] || 0) + part;
        (res.byTunnelDay[t] = res.byTunnelDay[t] || {})[a.date] = ((res.byTunnelDay[t] || {})[a.date] || 0) + part;
      });
    });
    return res;
  }

  /* ══ 7 quater. CONTRÔLE DE COHÉRENCE QUOTIDIEN (10/11/2026, T5) ═════════
     Chaque jour et pour chaque quiz, deux chemins indépendants doivent dire
     la même chose :
       · ont répondu Q1 : 1er clic (page_views_daily.ctas, ALTEO.track('cta'))
         ↔ réponse à la question 1 vue par la mesure du quiz (quiz_funnel_daily) ;
       · formulaires envoyés (page_views_daily.optins, ALTEO.track('optin'))
         ↔ fiches créées ou mises à jour par api/lead-optin.js avec ce quiz
         pour page (nouveaux + déjà connus revenus).
     Alerte si l'écart dépasse 20 % un jour de plus de 30 arrivés (règle du
     brief). Les références hors Team (visites Meta, pixel, exécutions Make)
     se rapprochent à la main : l'encart dit quoi comparer. */
  var CHECK_TOL = 0.20, CHECK_MIN_VISITS = 30;
  function gap(a, b) { var m = Math.max(a, b); return m ? Math.abs(a - b) / m : 0; }
  function quizChecks(list) {
    var out = [];
    (list || []).forEach(function (q) {
      q.dayList.forEach(function (d) {
        var big = d.arrives > CHECK_MIN_VISITS;
        var leads = d.newLeads + d.backLeads;
        var items = [];
        if (d.doneMeasured) items.push({ k: 'q1', label: 'Ont répondu Q1', a: d.q1, aLbl: '1ers clics', b: d.q1Quiz, bLbl: 'mesure du quiz', gap: gap(d.q1, d.q1Quiz) });
        items.push({ k: 'optin', label: 'Formulaires', a: d.optins, aLbl: 'formulaires envoyés', b: leads, bLbl: 'fiches Leads Live', gap: gap(d.optins, leads) });
        items.forEach(function (it) { it.alert = big && it.gap > CHECK_TOL && Math.abs(it.a - it.b) >= 2; });
        out.push({ tunnel: q.tunnel, name: q.name, day: d.day, arrives: d.arrives, big: big, items: items, alert: items.some(function (it) { return it.alert; }) });
      });
    });
    return out;
  }

  /* ══ 7 quinquies. QUALITÉ DES LEADS PAR PAGE D'ENTRÉE (10/11/2026, T7) ══
     Leads de la période (lignes du modèle), rangés par la page quiz qui les a
     fait entrer (landingFirst, via optin) × variante : leads avec RDV (Self
     Booking / Setting / manuel), leads présents, closes des leads entrés,
     contracté, collecté ; nouveaux leads et ré-optins séparés dans l'agrégat
     (agg.nouveaux / agg.reopt) ; fiches entrées par la page sans réponses de
     quiz comptées à part (sansReponses). Sert à vérifier avec des chiffres
     quel quiz / quelle variante amène les leads qui signent. */
  function qualityByPage(rows, meta) {
    var by = {};
    (rows || []).forEach(function (r) {
      var L = r.lead && r.lead.landingFirst;
      if (!L || L.via !== 'optin' || !/^[a-z0-9-]+__[a-z0-9-]+$/.test(String(L.page || ''))) return;
      var k = L.page + '--' + (L.variant || '_');
      var g = by[k];
      /* Fiche entrée par ce quiz sans réponses de quiz enregistrées : gardée
         à part (sansReponses), jamais mêlée aux leads notés de la page. */
      if (!r.lead.quiz) { if (g) g.sansReponses++; else (by['_sr_' + k] = by['_sr_' + k] || { n: 0 }).n++; return; }
      if (!g) {
        var sp = splitPage(L.page), tm = meta && meta[sp.tunnel], st = tm && tm.steps ? tm.steps[sp.step] : null;
        var vm = st && st.variants && L.variant ? st.variants[L.variant] : null;
        g = by[k] = { key: k, tunnel: sp.tunnel, quiz: (tm && tm.name) || sp.tunnel, path: '/' + sp.step, variant: L.variant || null,
          label: (vm && vm.label) || (L.variant ? 'Variante ' + String(L.variant).toUpperCase() : 'variante non transmise'),
          agg: newAgg(), self: 0, setter: 0, manuel: 0, sansReponses: 0 };
        if (by['_sr_' + k]) { g.sansReponses += by['_sr_' + k].n; delete by['_sr_' + k]; }
      }
      addLeadRow(g.agg, r);
      if (r.bookedBy === 'self') g.self++;
      else if (r.bookedBy === 'setter') g.setter++;
      else if (r.bookedBy === 'manuel') g.manuel++;
    });
    /* nouveaux / ré-optins : g.agg.nouveaux + g.agg.reopt = g.agg.leads. */
    return Object.keys(by).filter(function (k) { return k.indexOf('_sr_') !== 0; }).map(function (k) { fin(by[k].agg); return by[k]; })
      .sort(function (a, b) { return a.quiz < b.quiz ? -1 : (a.quiz > b.quiz ? 1 : (b.agg.leads - a.agg.leads)); });
  }

  /* ══ 8. PHRASES CLÉS (lecture en 10 secondes) ══════════════════════════ */
  /* Parts calculées sur le SIGNÉ (cash), encaissé à côté (paid). */
  function insights(bn, cashMode) {
    var out = [];
    var m = bn.byNote, t = bn.total;
    var per = cashMode === 'periode';
    var sigOf = function (a) { return per ? a.periodCon : a.con; };
    /* Mode période : contracté et COLLECTÉ des closes de la période (liste
       unique), jamais le prélevé de la période (autre calcul). */
    var paidOf = function (a) { return per ? a.periodPaid : a.cash; };
    var totSig = sigOf(t);
    function grp(keys) {
      var g = { leads: 0, cash: 0, paid: 0 };
      keys.forEach(function (k) { g.leads += m[k].leads; g.cash += sigOf(m[k]); g.paid += paidOf(m[k]); });
      g.cashPct = totSig > 0 ? g.cash / totSig * 100 : null;
      return g;
    }
    if (t.noted) {
      var hi = grp([5, 4]), mid = grp([3, 4]), lo = grp([1]);
      out.push({ k: 'hi', leads: hi.leads, leadsPct: hi.leads / t.leads * 100, cash: hi.cash, paid: hi.paid, cashPct: hi.cashPct });
      out.push({ k: 'mid', leads: mid.leads, cash: mid.cash, paid: mid.paid, cashPct: mid.cashPct });
      out.push({ k: 'lo', leads: lo.leads, booked: m[1].booked, cash: lo.cash, paid: lo.paid, cashPct: lo.cashPct });
    }
    if (m[0].leads) out.push({ k: 'none', leads: m[0].leads, pct: m[0].leads / t.leads * 100 });
    return out;
  }

  return {
    DEFAULT_THRESHOLDS: DEFAULT_THRESHOLDS, NOTE_KEYS: NOTE_KEYS,
    SUGGEST_MIN: SUGGEST_MIN, MQS_MIN: MQS_MIN,
    norm: norm, keyOf: keyOf, amounts: amounts, monthlyCa: monthlyCa,
    extractAnswers: extractAnswers, questionnaireOf: questionnaireOf, defaultPoints: defaultPoints,
    normalizeGrid: normalizeGrid, ruleFor: ruleFor, noteFromPoints: noteFromPoints, scoreAnswers: scoreAnswers,
    loadAll: loadAll, buildModel: buildModel,
    byNote: byNote, byAnswer: byAnswer, byAxis: byAxis, byCloser: byCloser, closerBoard: closerBoard,
    suggestPoints: suggestPoints, suggestBasis: suggestBasis, recoPoints: recoPoints, calibrateThresholds: calibrateThresholds,
    quizVersions: quizVersions, buildQuizView: buildQuizView, versionMeta: versionMeta, OLD_QUIZ_KEY: OLD_KEY, FAMILY_PREFIX: FAM, familyOfKey: familyOfKey, mqsOf: mqsOf, buildQuizFunnel: buildQuizFunnel, insights: insights,
    newAgg: newAgg, offerOf: offerOf, addLeadRow: addLeadRow, fin: fin, isoDay: isoDay,
    rdvDuLead: rdvDuLead, leadRdv: leadRdv, periodZero: periodZero, periodFin: periodFin,
    quizOverview: quizOverview, parisIso: parisIso, quizChecks: quizChecks, qualityByPage: qualityByPage
  };
}));
