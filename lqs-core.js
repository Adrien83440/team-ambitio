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

   Dépend de funnel-core.js (window.FunnelCore) : attribution, cash, dates.
   Utilisé par lqs-tab.js (onglet « ⭐ Qualité leads » de sales-funnel.html).
   ES5 strict — pas d'arrow functions, pas de template literals.
   ============================================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./funnel-core.js'));
  else root.LqsCore = factory(root.FunnelCore);
}(typeof self !== 'undefined' ? self : this, function (FC) {
  'use strict';

  var DAY = 86400000;

  /* ══ OUTILS ═══════════════════════════════════════════════════════════ */
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
       · RDV : créés depuis le début de la période (résultat des leads de la
         cohorte, même si le RDV est plus tard) + RDV DATÉS dans la plage
         closers (vue « par closer », mois par mois) ;
       · fiches manquantes (RDV de leads plus anciens, paiements) : lues
         une par une ;
       · payments, ads_creatives, ads_insights_ad, quiz_funnel_daily,
         booking_config (experts → membres), _config/lqs_grid. */
  function classify(b, typeMap) {
    b._class = FC.classifyBooking(b, typeMap || {});
    b._p9 = FC.phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
    b._createdMs = FC.parseFlexMs(b.createdAt);
    return b;
  }

  function loadAll(db, opts) {
    var P = opts.P, typeMap = opts.typeMap || {};
    var CR = opts.closerRange || { start: P.start, end: P.end };
    var D = FC.emptyData();
    D.bookingsById = {}; D.bookings = []; D.extraLeads = []; D.persons = {}; D.quizDocs = []; D.gridRaw = null;
    var sIso = FC.isoDate(P.start), eIso = FC.isoDate(P.end);
    var cS = FC.isoDate(CR.start), cE = FC.isoDate(CR.end);

    function addBookings(snap) {
      snap.forEach(function (doc) {
        if (D.bookingsById[doc.id]) return;
        var d = doc.data() || {}; d._id = doc.id;
        D.bookingsById[doc.id] = classify(d, typeMap);
      });
    }
    var jobs = [
      FC.loadLeads(db, P, D),
      db.collection('bookings').where('createdAt', '>=', P.start).get().then(addBookings),
      db.collection('bookings').where('date', '>=', cS).where('date', '<=', cE).get().then(addBookings),
      FC.loadPayments(db, D),
      FC.loadCreatives(db, D),
      FC.loadAdsByAd(db, P, D),
      FC.loadViews(db, P, D),   // visites et formulaires par page (historique avant la mesure fine)
      db.collection('quiz_funnel_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
        snap.forEach(function (doc) { var d = doc.data() || {}; d._id = doc.id; D.quizDocs.push(d); });
      }).catch(function (e) { D.quizErr = e && e.message ? e.message : 'erreur'; }),
      db.collection('booking_config').get().then(function (snap) {
        snap.forEach(function (doc) { var d = doc.data() || {}; if (d.__type === 'person') { d.id = doc.id; D.persons[doc.id] = d; } });
      }).catch(function () {}),
      db.collection('_config').doc('lqs_grid').get().then(function (s) { D.gridRaw = s.exists ? s.data() : null; }),
      loadTunnelsLive(db, D)
    ];
    return Promise.all(jobs).then(function () {
      return FC.resolveChains(db, D, typeMap);
    }).then(function () {
      D.bookings = Object.keys(D.bookingsById).map(function (k) { return D.bookingsById[k]; });
      return loadMissingLeads(db, D, P);
    }).then(function () { return D; });
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

  /* Fiches référencées par un RDV ou un paiement, absentes de la cohorte. */
  function loadMissingLeads(db, D, P) {
    var known = {};
    (D.leads || []).concat(D.reoptins || []).forEach(function (l) { known[l._id] = 1; });
    var want = {};
    D.bookings.forEach(function (b) {
      if ((b._class === 'self' || b._class === 'setter') && b.leadId && !known[b.leadId]) want[b.leadId] = 1;
    });
    var pS = P.start.getTime(), pE = P.end.getTime();
    (D.payments || []).forEach(function (p) {
      if (!p || !p.leadId || known[p.leadId]) return;
      var inPeriod = FC.revPaidEntries(p).some(function (e) { return e.ms != null && e.ms >= pS && e.ms <= pE; });
      if (inPeriod) want[p.leadId] = 1;
    });
    var ids = Object.keys(want);
    var out = [];
    function batch(i) {
      if (i >= ids.length) { D.extraLeads = out; return Promise.resolve(); }
      var chunk = ids.slice(i, i + 40);
      return Promise.all(chunk.map(function (id) {
        return db.collection('leads').doc(id).get().then(function (s) {
          if (!s.exists) return;
          var d = s.data() || {}; d._id = s.id;
          if (d._merged === true) return;
          d._entry = FC.realEntryMs(d);
          d._p9 = FC.phone9(d.telephone || d.phone);
          d._extra = true;
          out.push(d);
        }).catch(function () {});
      })).then(function () { return batch(i + 40); });
    }
    return batch(0);
  }

  /* ══ 5. MODÈLE ═════════════════════════════════════════════════════════ */
  function ocOf(b) { return b.outcome || null; }
  function ocCancelled(b) { var o = ocOf(b); return o === 'annule' || (!o && b.status === 'cancelled' && b.rescheduled !== true); }
  function ocNoShow(b) { var o = ocOf(b); return o === 'no_show' || (!o && b.status === 'no_show'); }
  function ocPresent(b) { var o = ocOf(b); return o ? (o === 'offre' || o === 'close' || o === 'non_close' || o === 'disqualifie') : b.status === 'completed'; }
  function ocPitched(b) { var o = ocOf(b); return o === 'offre' || o === 'close' || o === 'non_close'; }

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

  function newAgg() {
    return { leads: 0, noted: 0, noteSum: 0, n45: 0, n12: 0, dist: [0, 0, 0, 0, 0, 0],
      booked: 0, present: 0, noshow: 0, cancelled: 0, pitched: 0, closes: 0, cash: 0, con: 0,
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
    addNote(a, r.note);
    if (r.booked) a.booked++;
    if (r.present) a.present++;
    if (r.noshow) a.noshow++;
    if (r.allCancelled) a.cancelled++;
    if (r.pitched) a.pitched++;
    if (r.closed) {
      a.closes++; a.cash += r.cash; a.con += r.con;
      if (r.offer === 'elite') { a.closesE++; a.cashE += r.cash; a.conE += r.con; }
      else if (r.offer === 'business') { a.closesB++; a.cashB += r.cash; a.conB += r.con; }
      else { a.closesU++; a.cashU += r.cash; a.conU += r.con; }
    }
    if (r.team != null) { a.teamN++; a.teamSum += r.team; }
  }
  function fin(a) {
    a.cash = r2(a.cash); a.con = r2(a.con);
    a.cashE = r2(a.cashE); a.cashB = r2(a.cashB); a.cashU = r2(a.cashU);
    a.conE = r2(a.conE); a.conB = r2(a.conB); a.conU = r2(a.conU);
    a.avgNote = a.noted ? r2(a.noteSum / a.noted) : null;
    a.pct45 = a.noted ? a.n45 / a.noted * 100 : null;
    a.pct12 = a.noted ? a.n12 / a.noted * 100 : null;
    a.bookRate = ratio(a.booked, a.leads); if (a.bookRate != null) a.bookRate *= 100;
    a.showRate = ratio(a.present, a.booked); if (a.showRate != null) a.showRate *= 100;
    a.closeRdv = ratio(a.closes, a.booked); if (a.closeRdv != null) a.closeRdv *= 100;
    a.closePresent = ratio(a.closes, a.present); if (a.closePresent != null) a.closePresent *= 100;
    a.closeLead = ratio(a.closes, a.leads); if (a.closeLead != null) a.closeLead *= 100;
    a.cashPerLead = a.leads ? a.cash / a.leads : null;
    a.cashPerClient = a.closes ? a.cash / a.closes : null;
    /* SIGNÉ (08/11/2026, validé Adrien) : montant HT du contrat (paiements
       non annulés, sinon carte du close). C'est lui qui juge la valeur d'un
       lead (MQS, suggestions, « / lead ») : l'encaissé arrive avec le préavis
       SEPA et s'étale sur 12 mensualités. L'encaissé reste affiché à côté. */
    a.conPerLead = a.leads ? a.con / a.leads : null;
    a.conPerClient = a.closes ? a.con / a.closes : null;
    a.teamAvg = a.teamN ? r2(a.teamSum / a.teamN) : null;
    return a;
  }

  /* ctx : { P, grid (normalisé), tunnelFilter, sourceFilter, teamMembers,
             closerRange, tunnelsMeta } */
  function buildModel(D, ctx) {
    var grid = ctx.grid;
    var P = ctx.P;
    var TEAM = ctx.teamMembers || [];
    var bySlug = {}, byUid = {}, byName = {};
    TEAM.forEach(function (m) {
      if (!m || !m.slug) return;
      bySlug[m.slug] = m;
      if (m.firebaseUid) byUid[m.firebaseUid] = m;
      [m.shortName, m.displayName, m.slug].forEach(function (n) { if (n) byName[norm(String(n).split(/\s+/)[0])] = m; });
    });
    function memberName(slug) { var m = bySlug[slug]; return m ? (m.shortName || m.displayName || slug) : slug; }
    function isDeparted(slug) {
      /* Membres partis (nav.js, DEPARTED) : exclus de tout affichage nominatif,
         leurs RDV restent comptés dans « Toute l'équipe ». */
      var m = bySlug[slug];
      if (typeof window !== 'undefined' && typeof window.isDepartedMember === 'function') {
        try { if (window.isDepartedMember(m || slug)) return true; } catch (e) {}
      }
      return !!(m && m.departed === true);
    }
    function closerOf(b) {
      if (!b) return null;
      var slug = (b.closeData && b.closeData.closerSlug) || b.expertSlug || (bySlug[b.personId] ? b.personId : null);
      if (!slug && b.personId && D.persons[b.personId]) {
        var p = D.persons[b.personId];
        var m = (p.firebaseUid && byUid[p.firebaseUid]) || (p.name ? byName[norm(String(p.name).split(/\s+/)[0])] : null);
        if (m) slug = m.slug;
      }
      return slug || null;
    }

    /* Index des fiches */
    var cohort = [];
    var allLeads = {};
    var byEmail = {}, byP9 = {};
    function indexLead(l) {
      if (!l || allLeads[l._id]) return;
      allLeads[l._id] = l;
      var em = String(l.email || '').toLowerCase().trim();
      if (em && !byEmail[em]) byEmail[em] = l;
      if (l._p9 && !byP9[l._p9]) byP9[l._p9] = l;
    }
    (D.leads || []).forEach(function (l) { l._reopt = false; indexLead(l); cohort.push(l); });
    (D.reoptins || []).forEach(function (l) {
      l._reopt = true;
      var lo = FC.parseFlexMs(l.lastOptinAt);
      if (lo != null) l._cohortEntry = lo;
      indexLead(l); cohort.push(l);
    });
    (D.extraLeads || []).forEach(indexLead);

    function leadOfBooking(b) {
      if (b.leadId && allLeads[b.leadId]) return allLeads[b.leadId];
      if (b._p9 && byP9[b._p9]) return byP9[b._p9];
      var em = String(b.prospect && b.prospect.email || '').toLowerCase().trim();
      if (em && byEmail[em]) return byEmail[em];
      return null;
    }
    function terminal(b) {
      var cur = b, guard = 0;
      while (cur && cur.rescheduledToId && guard++ < 10) {
        var nxt = D.bookingsById[cur.rescheduledToId];
        if (!nxt) break;
        cur = nxt;
      }
      return cur;
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

    /* RDV par fiche */
    var bkByLead = {};
    var funnelBookings = D.bookings.filter(function (b) { return b._class === 'self' || b._class === 'setter'; });
    funnelBookings.forEach(function (b) {
      var l = leadOfBooking(b);
      b._lead = l;
      if (!l) return;
      (bkByLead[l._id] = bkByLead[l._id] || []).push(b);
    });

    /* Cash par fiche (règles REVENUE de FunnelCore) */
    var payIdx = FC.revIndex(D.payments || []);
    function declFor(l) {
      var d = null;
      (bkByLead[l._id] || []).forEach(function (b) {
        if (b.outcome === 'close' && b.closeData) d = { contracte: num(b.closeData.contracte), collecte: num(b.closeData.collecte) };
      });
      if (!d && l.closedData) d = { contracte: num(l.closedData.contracte), collecte: num(l.closedData.collecte) };
      return d;
    }

    var CRE_IDX = FC.buildCreativeIndex(D.creatives || []);
    var todayIso = FC.isoDate(new Date());

    function rowOfLead(l) {
      if (l._row && l._rowStamp === gridStamp) return l._row;
      var sc = scoreLead(l);
      var entry = l._cohortEntry != null ? l._cohortEntry : (l._entry != null ? l._entry : FC.realEntryMs(l));
      var floor = entry != null ? entry - DAY : -Infinity;
      var heads = (bkByLead[l._id] || []).filter(function (b) {
        if (b.rescheduledFromId && D.bookingsById[b.rescheduledFromId]) return false;
        return b._createdMs == null || b._createdMs >= floor;
      }).sort(function (a, b) { return (a._createdMs || 0) - (b._createdMs || 0); });
      var r = { id: l._id, lead: l, note: sc.note, pts: sc.pts, ko: sc.ko, detail: sc.detail,
        answers: l._answers || [], entry: entry, reopt: !!l._reopt,
        booked: heads.length > 0, present: false, noshow: false, pitched: false, closeOc: false,
        allCancelled: heads.length > 0, upcoming: false, closed: false, closeCancelled: false,
        cash: 0, con: 0, closeDay: null, offer: null, closer: null, rdvDate: null,
        team: (l.leadScore >= 1 && l.leadScore <= 5) ? Number(l.leadScore) : null };
      var pick = null;
      heads.forEach(function (h) {
        var t = terminal(h);
        if (!ocCancelled(t)) r.allCancelled = false;
        if (ocNoShow(t)) r.noshow = true;
        if (ocPresent(t)) { r.present = true; if (!pick || ocOf(pick) !== 'close') pick = t; }
        if (ocPitched(t)) r.pitched = true;
        if (ocOf(t) === 'close') { r.closeOc = true; pick = t; }
        if (!ocOf(t) && (t.status === 'confirmed' || t.status === 'pending') && t.date >= todayIso) r.upcoming = true;
        if (!pick) pick = t;
      });
      if (!pick && heads.length) pick = terminal(heads[heads.length - 1]);
      if (pick) { r.closer = closerOf(pick); r.rdvDate = pick.date || null; }
      var csMs = FC.parseFlexMs(l.clientSince);
      var pays = FC.revPaymentsFor(payIdx, l._id, String(l.email || '').toLowerCase().trim(), l.telephone || l.phone);
      /* 08/11/2026 : un paiement rattaché à UNE fiche (leadId) n'est plus
         compté aussi sur les doublons qui partagent son email / téléphone
         (Valérie Gachet : close compté deux fois, la 2e fiche « sans offre »).
         Repli par email / téléphone seulement si la fiche du paiement n'est
         pas chargée ou est fusionnée. */
      pays = pays.filter(function (p) {
        if (!p.leadId || p.leadId === l._id) return true;
        var owner = allLeads[p.leadId];
        return !owner || !!owner._merged;
      });
      var won = r.closeOc || (csMs != null && csMs >= floor) || pays.length > 0;
      if (won) {
        var rv = FC.revClient(pays, l, declFor(l));
        if (rv.cancelled) { r.closeCancelled = true; }
        else {
          r.closed = true; r.cash = rv.paid; r.con = rv.con;
          (bkByLead[l._id] || []).forEach(function (b) { if (b.outcome === 'close' && b.date && (!r.closeDay || b.date > r.closeDay)) r.closeDay = b.date; });
          if (!r.closeDay && csMs != null) r.closeDay = FC.isoDate(new Date(csMs));
          var cdo = null;
          (bkByLead[l._id] || []).forEach(function (b) { if (b.outcome === 'close' && b.closeData && offerOf(b.closeData)) cdo = b.closeData; });
          r.offer = offerOf(cdo) || offerOf(l.closedData);
        }
        if (!r.closer) {
          var pc = null;
          pays.forEach(function (p) { if (p.closerSlug) pc = p.closerSlug; });
          r.closer = pc;
        }
      }
      if (r.closed && !r.booked) { r.booked = true; r.present = true; r.allCancelled = false; }
      if (!r.booked) r.allCancelled = false;
      r.closerName = r.closer ? memberName(r.closer) : null;
      r.axes = {
        campaign: FC.leadAxisKey(l, 'campaign', CRE_IDX),
        adset: FC.leadAxisKey(l, 'adset', CRE_IDX),
        creative: FC.leadAxisKey(l, 'creative', CRE_IDX),
        channel: FC.leadAxisKey(l, 'channel', CRE_IDX)
      };
      r.sourceLabel = (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || '—';
      r.isAds = FC.isAdvertisingLead(l);
      l._row = r; l._rowStamp = gridStamp;
      return r;
    }

    /* Filtres page (tunnel / source) */
    function leadPasses(l) {
      if (ctx.tunnelFilter && ctx.tunnelFilter !== 'all' && FC.leadTunnel(l) !== ctx.tunnelFilter) return false;
      if (ctx.sourceFilter && ctx.sourceFilter !== 'all' && FC.leadSource(l, ctx.tunnelsMeta || null) !== ctx.sourceFilter) return false;
      return true;
    }
    var rows = cohort.filter(leadPasses).map(rowOfLead);

    /* Closers présents dans les données (sélecteur) */
    var closerSet = {};
    function noteCloser(slug) { if (slug && !isDeparted(slug)) closerSet[slug] = 1; }
    rows.forEach(function (r) { noteCloser(r.closer); });

    /* ── RDV datés dans la plage closers ── */
    var CR = ctx.closerRange || { start: P.start, end: P.end };
    var cS = FC.isoDate(CR.start), cE = FC.isoDate(CR.end);
    var rdvRows = [];
    funnelBookings.forEach(function (b) {
      if (!b.date || b.date < cS || b.date > cE) return;
      if (b.rescheduledToId && D.bookingsById[b.rescheduledToId]) return;   // remplacé : le remplaçant compte
      if (b.outcome === 'replanifie') return;
      var l = b._lead;
      if (l && !leadPasses(l)) return;
      if (!l && ctx.tunnelFilter && ctx.tunnelFilter !== 'all') return;
      var lr = l ? rowOfLead(l) : null;
      var slug = closerOf(b);
      noteCloser(slug);
      var isClose = ocOf(b) === 'close';
      rdvRows.push({
        b: b, date: b.date, month: monthKey(b.date), closer: slug, closerName: slug ? memberName(slug) : 'Non attribué',
        note: lr ? lr.note : null, team: lr ? lr.team : null, leadRow: lr,
        cancelled: ocCancelled(b), noshow: ocNoShow(b), present: ocPresent(b), pitched: ocPitched(b),
        close: isClose && !(lr && lr.closeCancelled),
        cash: isClose && lr && lr.closed ? lr.cash : 0,
        con: isClose && lr && lr.closed ? lr.con : 0,
        upcoming: !ocOf(b) && (b.status === 'confirmed' || b.status === 'pending') && b.date >= todayIso,
        name: (l && (l.nom || l.email)) || (b.prospect && (b.prospect.nom || b.prospect.email)) || '—',
        leadId: l ? l._id : null
      });
    });

    /* ── Cash ENCAISSÉ dans la période (mode « encaissé sur la période ») ── */
    var pS = P.start.getTime(), pE = P.end.getTime();
    var periodPays = [];
    (D.payments || []).forEach(function (p) {
      if (!p || p.status === 'draft') return;
      var amt = 0;
      FC.revPaidEntries(p).forEach(function (e) { if (e.ms != null && e.ms >= pS && e.ms <= pE) amt += e.ht; });
      if (amt <= 0.005) return;
      var l = (p.leadId && allLeads[p.leadId]) || byEmail[String(p.leadEmail || '').toLowerCase().trim()] || byP9[FC.phone9(p.leadPhone)] || null;
      if (l && !leadPasses(l)) return;
      var lr = l ? rowOfLead(l) : null;
      periodPays.push({ p: p, cash: r2(amt), lead: l, note: lr ? lr.note : null, leadRow: lr,
        closer: p.closerSlug || (lr && lr.closer) || null,
        name: (l && (l.nom || l.email)) || p.leadName || p.leadEmail || '—' });
    });

    /* ── SIGNÉ dans la période : closes datés dans la période (RDV de close,
       sinon date client), quel que soit le mois d'entrée du lead ── */
    var pSd = FC.isoDate(P.start), pEd = FC.isoDate(P.end);
    var periodSigned = [], signedSeen = {};
    function notePeriodClose(l) {
      if (!l || signedSeen[l._id] || !leadPasses(l)) return;
      var lr = rowOfLead(l);
      if (!lr.closed || !lr.closeDay || lr.closeDay < pSd || lr.closeDay > pEd) return;
      signedSeen[l._id] = 1;
      periodSigned.push({ lead: l, leadRow: lr, con: lr.con, cash: lr.cash, note: lr.note, offer: lr.offer, day: lr.closeDay });
    }
    funnelBookings.forEach(function (b) { if (b.outcome === 'close' && b.date >= pSd && b.date <= pEd) notePeriodClose(b._lead); });
    Object.keys(allLeads).forEach(function (id) {
      var l = allLeads[id], cs = FC.parseFlexMs(l.clientSince);
      if (cs != null && cs >= pS && cs <= pE) notePeriodClose(l);
    });

    var closers = Object.keys(closerSet).sort(function (a, b) { return memberName(a).localeCompare(memberName(b)); })
      .map(function (s) { return { slug: s, name: memberName(s) }; });

    return {
      rows: rows, rdvRows: rdvRows, periodPays: periodPays, periodSigned: periodSigned, closers: closers,
      quiz: buildQuizFunnel(D.quizDocs || []), quizErr: D.quizErr || null,
      adsByAd: D.adsByAd || [], creIdx: CRE_IDX, views: D.views || [],
      tunnels: D.tunnelsErr ? null : (D.tunnels || null),
      leadsTruncated: !!D.leadsTruncated, memberName: memberName
    };
  }

  /* ══ 6. AGRÉGATS ═══════════════════════════════════════════════════════ */
  var NOTE_KEYS = [5, 4, 3, 2, 1, 0];   // 0 = non noté

  function byNote(rows, periodPays, periodSigned) {
    var m = {};
    NOTE_KEYS.forEach(function (k) { m[k] = newAgg(); m[k].note = k; m[k].payers = 0; m[k].periodCash = 0; m[k].periodCon = 0; m[k].signers = 0; });
    var tot = newAgg(); tot.payers = 0; tot.periodCash = 0; tot.periodCon = 0; tot.signers = 0;
    (periodSigned || []).forEach(function (ps) {
      var k = ps.note == null ? 0 : ps.note;
      m[k].periodCon += ps.con; tot.periodCon += ps.con; m[k].signers++; tot.signers++;
    });
    rows.forEach(function (r) { addLeadRow(m[r.note == null ? 0 : r.note], r); addLeadRow(tot, r); });
    if (periodPays) {
      var seen = {};
      periodPays.forEach(function (pp) {
        var k = pp.note == null ? 0 : pp.note;
        m[k].periodCash += pp.cash; tot.periodCash += pp.cash;
        var id = pp.lead ? pp.lead._id : ('p_' + (pp.p._id || Math.random()));
        if (!seen[id]) { seen[id] = 1; m[k].payers++; tot.payers++; }
      });
    }
    NOTE_KEYS.forEach(function (k) { fin(m[k]); m[k].periodCash = r2(m[k].periodCash); m[k].periodCon = r2(m[k].periodCon); });
    fin(tot); tot.periodCash = r2(tot.periodCash); tot.periodCon = r2(tot.periodCon);
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
        x.suggest = suggestPoints(x.agg, tot);
        x.share = q.agg.leads ? x.agg.leads / q.agg.leads * 100 : null;
        return x;
      }).sort(function (a, b) { return b.agg.leads - a.agg.leads; });
      return q;
    }).sort(function (a, b) { return b.agg.leads - a.agg.leads; });
    return { questions: list, total: tot };
  }

  /* Suggestion de points à partir des résultats réels d'une réponse :
     valeur par lead rapportée à la moyenne — montant SIGNÉ si la période
     compte au moins 8 closes, sinon RDV honorés (au moins 10 présents), sinon
     rien —, ramenée vers 1 sur les petits effectifs (10 leads « fictifs » à
     la moyenne), puis log2 × 1,5, arrondie au demi-point, bornée à ±3.
     Rien sous 5 leads : trois closes ne font pas une tendance. */
  var SUGGEST_MIN = 5;
  var SUGGEST_MIN_CLOSES = 8, SUGGEST_MIN_PRESENT = 10, SUGGEST_PRIOR = 10;
  function suggestBasis(tot) {
    if (tot.closes >= SUGGEST_MIN_CLOSES && tot.con > 0) return 'cash';
    if (tot.present >= SUGGEST_MIN_PRESENT) return 'present';
    return null;
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

  function byAxis(rows, axis, adsByAd, tunnelFilter) {
    var tot = newAgg();
    rows.forEach(function (r) { addLeadRow(tot, r); });
    fin(tot);
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
    (adsByAd || []).forEach(function (a) {
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
      x.roas = x.hasSpend && x.spend > 0 && x.agg.con > 0 ? x.agg.con / x.spend : null;   // ROAS sur le signé
      x.m = mqsOf(x.agg, tot);
      delete x.adIds;
    });
    list.sort(function (a, b) {
      if (a.outOfAds !== b.outOfAds) return a.outOfAds ? 1 : -1;
      return b.agg.leads - a.agg.leads;
    });
    var spendTot = 0;
    Object.keys(spendByAd).forEach(function (id) { spendTot += spendByAd[id]; });
    return { rows: list, total: tot, spend: r2(spendTot) };
  }

  /* Closers : RDV datés, mois par mois + par note. */
  function newRdvAgg() {
    return { rdv: 0, cancelled: 0, noshow: 0, present: 0, pitched: 0, closes: 0, cash: 0, con: 0, upcoming: 0,
      noted: 0, noteSum: 0, n45: 0, n12: 0, dist: [0, 0, 0, 0, 0, 0] };
  }
  function addRdv(a, x) {
    a.rdv++;
    addNote(a, x.note);
    if (x.cancelled) a.cancelled++;
    if (x.noshow) a.noshow++;
    if (x.present) a.present++;
    if (x.pitched) a.pitched++;
    if (x.close) { a.closes++; a.cash += x.cash; a.con += x.con || 0; }
    if (x.upcoming) a.upcoming++;
  }
  function finRdv(a) {
    a.cash = r2(a.cash); a.con = r2(a.con);
    a.avgNote = a.noted ? r2(a.noteSum / a.noted) : null;
    a.pct45 = a.noted ? a.n45 / a.noted * 100 : null;
    a.kept = a.rdv - a.cancelled;
    a.showRate = a.kept - a.upcoming > 0 ? a.present / (a.kept - a.upcoming) * 100 : null;
    a.closePresent = a.present ? a.closes / a.present * 100 : null;
    a.closeRdv = a.rdv - a.upcoming > 0 ? a.closes / (a.rdv - a.upcoming) * 100 : null;
    return a;
  }
  function byCloser(rdvRows, slug) {
    var list = rdvRows.filter(function (x) { return !slug || x.closer === slug; });
    var months = {}, notes = {}, tot = newRdvAgg();
    NOTE_KEYS.forEach(function (k) { notes[k] = newRdvAgg(); });
    list.forEach(function (x) {
      (months[x.month] = months[x.month] || newRdvAgg());
      addRdv(months[x.month], x);
      addRdv(notes[x.note == null ? 0 : x.note], x);
      addRdv(tot, x);
    });
    var mList = Object.keys(months).sort().map(function (k) { var a = finRdv(months[k]); a.month = k; return a; });
    NOTE_KEYS.forEach(function (k) { finRdv(notes[k]); });
    return { months: mList, byNote: notes, total: finRdv(tot), list: list };
  }
  function closerBoard(rdvRows, memberName) {
    var m = {};
    rdvRows.forEach(function (x) {
      var k = x.closer || '_none';
      (m[k] = m[k] || newRdvAgg());
      addRdv(m[k], x);
    });
    return Object.keys(m).map(function (k) {
      var a = finRdv(m[k]);
      a.slug = k === '_none' ? null : k;
      a.name = k === '_none' ? 'Non attribué' : memberName(k);
      return a;
    }).sort(function (a, b) { return b.rdv - a.rdv; });
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
       · RDV pris / honorés = RDV créés sur la période (self + setter, hors
                           replanifications), provenance bookings.landing ou
                           page d'entrée de la fiche ; honoré = RDV terminal
                           de la chaîne tenu.
     Jours de Paris. « Période couverte » = premier et dernier jour où la page
     a des visites mesurées, dans la période choisie. */
  function parisIso(ms) {
    if (ms == null || !isFinite(ms)) return null;
    try { return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return isoDay(ms); }
  }
  /* mQ1 / mOptins : ont répondu Q1 et formulaires des seuls jours où l'écran
     de fin est mesuré — le taux « ont fini » ne compare que ce qui est comparable. */
  var OV_FIELDS = ['arrives', 'q1', 'done', 'optins', 'newLeads', 'backLeads', 'booked', 'kept', 'mQ1', 'mOptins', 'q1Quiz'];
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
    o.rKept = o.booked ? o.kept / o.booked * 100 : null;
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
    function terminal(b) { var c = b, g = 0; while (c && c.rescheduledToId && g++ < 10) { var n = byId[c.rescheduledToId]; if (!n) break; c = n; } return c; }
    function present(b) { var o = b && b.outcome; return o ? (o === 'offre' || o === 'close' || o === 'non_close' || o === 'disqualifie') : !!(b && b.status === 'completed'); }
    (D.bookings || []).forEach(function (b) {
      if (b.rescheduledFromId) return;
      if (b._class !== 'self' && b._class !== 'setter') return;
      var cm = b._createdMs;
      if (cm == null || cm < P.start.getTime() || cm > P.end.getTime()) return;
      var L = b.landing && b.landing.page ? b.landing : null;
      if (!L) { var l = leadOf(b); var LF = l && l.landingFirst; if (LF && leadPage(LF)) L = LF; }
      if (!L) return;
      var c = cell(L.page, L.variant, parisIso(cm));
      if (!c) return;
      c.booked++;
      if (present(terminal(b))) c.kept++;
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
    return Object.keys(byQuiz).map(function (k) {
      var q = byQuiz[k];
      ovFinish(q.total);
      q.dayList = Object.keys(q.days).sort().map(function (d) { return Object.assign({ day: d }, ovFinish(q.days[d])); });
      q.total.days = q.dayList.length;
      var firsts = q.pages.map(function (r) { return r.first; }).filter(Boolean).sort();
      var lasts = q.pages.map(function (r) { return r.last; }).filter(Boolean).sort();
      q.first = firsts[0] || null; q.last = lasts[lasts.length - 1] || null;
      q.doneMeasured = q.total.doneMeasured;
      return q;
    }).sort(function (a, b) { return b.total.arrives - a.total.arrives; });
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

  /* ══ 8. PHRASES CLÉS (lecture en 10 secondes) ══════════════════════════ */
  /* Parts calculées sur le SIGNÉ (cash), encaissé à côté (paid). */
  function insights(bn, cashMode) {
    var out = [];
    var m = bn.byNote, t = bn.total;
    var per = cashMode === 'periode';
    var sigOf = function (a) { return per ? a.periodCon : a.con; };
    var paidOf = function (a) { return per ? a.periodCash : a.cash; };
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
    extractAnswers: extractAnswers, defaultPoints: defaultPoints,
    normalizeGrid: normalizeGrid, ruleFor: ruleFor, noteFromPoints: noteFromPoints, scoreAnswers: scoreAnswers,
    loadAll: loadAll, buildModel: buildModel,
    byNote: byNote, byAnswer: byAnswer, byAxis: byAxis, byCloser: byCloser, closerBoard: closerBoard,
    suggestPoints: suggestPoints, suggestBasis: suggestBasis,
    quizVersions: quizVersions, buildQuizView: buildQuizView, versionMeta: versionMeta, OLD_QUIZ_KEY: OLD_KEY, FAMILY_PREFIX: FAM, familyOfKey: familyOfKey, mqsOf: mqsOf, buildQuizFunnel: buildQuizFunnel, insights: insights,
    newAgg: newAgg, offerOf: offerOf, addLeadRow: addLeadRow, fin: fin, isoDay: isoDay,
    quizOverview: quizOverview, parisIso: parisIso, quizChecks: quizChecks
  };
}));
