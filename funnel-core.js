// ============================================================================
// funnel-core.js — CŒUR DU FUNNEL SALES, PARTAGÉ NAVIGATEUR ↔ SERVEUR
// ----------------------------------------------------------------------------
// Une seule implémentation des KPIs du tunnel, utilisée par :
//   · sales-funnel.html      (SDK Firebase compat, rôle admin)
//   · api/agency-funnel.js   (Admin SDK, accès agence en lecture seule)
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// L'agence doit pouvoir choisir sa période (jour, 7 j, 30 j, plage libre) et
// son tunnel comme le fait l'équipe en interne. Un instantané pré-publié ne
// peut pas couvrir des fenêtres glissantes ni des plages arbitraires : il faut
// calculer à la demande côté serveur. Dupliquer compute() aurait garanti une
// dérive entre les deux vues — d'où l'extraction telle quelle, ici.
//
// ⚠ RÈGLE ABSOLUE : ce fichier est la SOURCE UNIQUE des chiffres du funnel.
// Toute correction de KPI se fait ICI, jamais dans une page. Les deux vues
// affichent alors mécaniquement la même chose.
//
// COMPATIBILITÉ DES DEUX SDK
// --------------------------
// Les API utilisées ici sont communes au SDK compat (navigateur) et à l'Admin
// SDK (Node) : collection() / doc() / where() / orderBy() / limit() / get(),
// snap.forEach / snap.size / snap.exists / doc.id / doc.data(). Les bornes de
// dates sont passées en Date natif — les deux SDK les convertissent en
// Timestamp (d'où tsOf, identité documentée plutôt que Timestamp.fromDate qui,
// lui, n'existe pas au même endroit dans les deux SDK).
//
// AUCUNE dépendance : ni Firebase, ni DOM, ni window. Le SDK est toujours
// reçu en paramètre (`db`).
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FunnelCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Constantes métier (déplacées depuis sales-funnel.html) ── */
  var LEADS_QUERY_LIMIT = 6000;
  var CALLS_QUERY_LIMIT = 5000;
  var ANSWERED_MIN_SEC  = 5;                  // même seuil que le Dashboard Sales
  var JOURNAL_GOLIVE    = '2026-07-14';       // mise en ligne du journal d'actions
  var TTX_LOOKAHEAD_MS  = 14 * 86400000;      // TTC/TTB cherchés jusqu'à 14 j après la fenêtre

  /* Les deux SDK acceptent un Date natif comme borne de requête et le
     convertissent en Timestamp. tsOf documente ce choix et garde le code des
     loaders identique à celui d'origine. */
  function tsOf(d) { return d; }

  /* Fin de recherche du 1er contact / 1er RDV : fenêtre + lookahead, jamais
     dans le futur. Un lead entré le 30 et appelé le 2 a un time-to-contact —
     sans ça il disparaît de la médiane (censure de fenêtre) et la médiane ne
     peut mécaniquement pas dépasser la taille de la fenêtre. */
  function lookaheadEndMsFor(P) {
    return Math.min(P.end.getTime() + TTX_LOOKAHEAD_MS, Date.now());
  }


  /* ── Décodage UTM défensif (identique sales-leads.html) ── */
  function decodeUtm(v) {
    if (v == null) return v;
    var s = String(v);
    if (s.indexOf('%') === -1) return s;
    try { return decodeURIComponent(s); }
    catch (e) {
      return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (m) {
        try { return decodeURIComponent(m); } catch (_) { return m; }
      });
    }
  }

  /* ── Clé « créative » d'un lead (section UTM — validé Adrien 22/07) ──
     Le lead porte UN champ utm (string posée par l'opt-in / Make, parfois
     %-encodée, parfois querystring complète). Règle : utm décodé tel quel ;
     si la valeur contient utm_content= (= la créative chez Meta), on extrait
     ce paramètre. Vide → « — » (bucket « sans UTM »). */
  function utmKeyOf(l) {
    var raw = decodeUtm(l && l.utm);
    var str = raw == null ? '' : String(raw).trim();
    if (!str) return '—';
    var m = str.match(/(?:^|[?&\s])utm_content=([^&\s]+)/i);
    if (m && m[1]) {
      try { return decodeURIComponent(m[1]); } catch (e) { return m[1]; }
    }
    return str;
  }

  /* ── Dates "réelles" lead — portage ES5 de api/_leadDates.js ── */
  function parseFlexMs(v) {
    if (v == null) return null;
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
      if (typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds ? Math.floor(v.nanoseconds / 1e6) : 0);
      if (typeof v._seconds === 'number') return v._seconds * 1000 + (v._nanoseconds ? Math.floor(v._nanoseconds / 1e6) : 0);
      return null;
    }
    if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s) return null;
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      var d = new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    var fr = s.match(/(\d{1,2})\s+([A-Za-zàâäéèêëïîôöûüç]+)\.?\s+(\d{4})/);
    if (fr) {
      var table = [['janv',0],['févr',1],['fevr',1],['mars',2],['avri',3],['mai',4],['juin',5],['juil',6],['aout',7],['août',7],['sept',8],['octo',9],['nove',10],['déce',11],['dece',11]];
      var mn = fr[2].toLowerCase(); var idx = -1;
      for (var i = 0; i < table.length; i++) { if (mn.indexOf(table[i][0]) === 0) { idx = table[i][1]; break; } }
      if (idx >= 0) { var d2 = new Date(+fr[3], idx, +fr[1]); return isNaN(d2.getTime()) ? null : d2.getTime(); }
    }
    var p = Date.parse(s);
    return isNaN(p) ? null : p;
  }

  function minDef() {
    var best = null;
    for (var i = 0; i < arguments.length; i++) { var m = arguments[i]; if (m != null && (best == null || m < best)) best = m; }
    return best;
  }

  function realEntryMs(d) {
    if (!d) return null;
    return minDef(parseFlexMs(d.dateWebinaire), parseFlexMs(d.importedCreatedAt), parseFlexMs(d.createdAt));
  }

  /* ── Formats ── */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function phone9(raw) {
    if (!raw) return null;
    var d = String(raw).replace(/[^\d]/g, '');
    if (d.length < 6) return null;
    return d.length >= 9 ? d.slice(-9) : d;
  }

  /* Tunnel binaire (règle Adrien 07/2026) : il n'existe que DEUX tunnels.
     Un lead est Business si « business » apparaît dans son type, son utm ou
     son sourceDetail — sinon il est Élite. Aucune catégorie « Autres ». */
  function leadTunnel(l) {
    var t = (String(l.type || '') + ' ' + String(l.utm || '') + ' ' + String(l.sourceDetail || '')).toLowerCase();
    if (t.indexOf('business') >= 0) return 'business';
    return 'elite';
  }

  /* Date FR 'DD/MM/YYYY' → ms (deals Commissions). */
  function frDateMs(v) {
    var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return parseFlexMs(v);
    var d = new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d.getTime();
  }


  function effectiveCosts(costs, mKey) {
    var months = costs || {};
    var best = null, bestKey = null;
    Object.keys(months).forEach(function (mk) {
      if (mk <= mKey && (bestKey == null || mk > bestKey)) { bestKey = mk; best = months[mk]; }
    });
    return best ? { fixe: Number(best.fixe) || 0, outils: Number(best.outils) || 0, src: bestKey } : null;
  }


  /* ── Classification d'un booking — règle « deux liens » (Adrien 15/07) :
     Self Booking = le lead prend RDV seul via le lien PUBLIC
       (booking.html?type=call_strat_phenix_all)
     No Booking   = RDV posé par le setting via le lien SETTER
       (booking.html?type=call_strat_phenix_elodie — type marqué
        « RDV setter » / isSetterOnly dans Booking admin)
     → le TYPE prime sur un vieux source 'self_booking' : un RDV historique
       pris sur le lien setter avant que booking.html ne pose le bon source
       est quand même NB. Même règle dans alteore-flow.js (toute la plateforme).
     'excluded' → coaching / csm_manual / clientId / skipLeadCreation
     'admin'    → admin_manual (compté à part, hors LTB)               */
  function classifyBooking(b, TYPE_MAP) {
    var t = TYPE_MAP[b.type] || {};
    if (b.isCoaching === true || t.isCoaching === true) return 'excluded';
    if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return 'excluded';
    if (b.source === 'admin_manual') return 'admin';
    if (b.source === 'setter_booking') return 'setter';
    if (t.isSetterOnly === true) return 'setter';   // type setter = NB, quel que soit le source
    if (b.source === 'self_booking') return 'self';
    return 'self';
  }


  function loadAds(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('ads_insights').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.ads = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.ads.push(d); });
    }).catch(function (e) { console.warn('[funnel] ads', e.message); DATA.ads = []; });
  }

  function loadViews(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('page_views_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.views = [];
      snap.forEach(function (doc) { DATA.views.push(doc.data()); });
    }).catch(function (e) { console.warn('[funnel] views', e.message); DATA.views = []; });
  }

  /* Leads "entrés" dans la période = realEntry ∈ [start,end].
     realEntry ≤ createdAt toujours → on requête createdAt ≥ start.
     Borne haute createdAt = end + 45 j (attrape les imports tardifs)
     puis filtrage client-side sur realEntry. _merged exclus. */
  function loadLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var capMs = Math.min(P.end.getTime() + 45 * 86400000, Date.now() + 60000);
    var capTs = tsOf(new Date(capMs));
    var q = db.collection('leads')
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', capTs)
      .limit(LEADS_QUERY_LIMIT);
    var pLeads = q.get().then(function (snap) {
      DATA.leadsTruncated = snap.size >= LEADS_QUERY_LIMIT;
      var out = [];
      snap.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        if (d._merged === true) return;
        var re = realEntryMs(d);
        if (re == null || re < P.start.getTime() || re > P.end.getTime()) return;
        d._entry = re;
        d._tunnel = leadTunnel(d);
        d._p9 = phone9(d.telephone || d.phone);
        out.push(d);
      });
      DATA.leads = out;
    });
    var startTs2 = tsOf(P.start);
    var endTs2 = tsOf(P.end);
    var pReopt = db.collection('leads')
      .where('lastOptinAt', '>=', startTs2)
      .where('lastOptinAt', '<=', endTs2)
      .limit(2000)
      .get().then(function (snap) {
        var out = [];
        snap.forEach(function (doc) {
          var d = doc.data(); d._id = doc.id;
          if (d._merged === true) return;
          var re = realEntryMs(d);
          if (re != null && re >= P.start.getTime()) return; // déjà dans la cohorte "nouveaux"
          d._entry = re;
          d._tunnel = leadTunnel(d);
          d._p9 = phone9(d.telephone || d.phone);
          out.push(d);
        });
        DATA.reoptins = out;
      }).catch(function (e) { console.warn('[funnel] reoptins', e.message); DATA.reoptins = []; });
    return Promise.all([pLeads, pReopt]);
  }

  /* Bookings : 3 requêtes —
     A) créés dans la période (createdAt)  → prise de RDV / LTB / CPR
     B) dont le RDV tombe dans la période (date string) → tenue (kept/annulé/no-show)
     C) créés APRÈS la fenêtre, jusqu'au lookahead → UNIQUEMENT le
        time-to-book des leads de la cohorte (fix censure 15/07). Gardés HORS
        de DATA.bookings/bookingsById : zéro contamination des compteurs
        (LTB, CPR, tenue) ni des chaînes de replanification de la période. */
  function loadBookings(db, P, DATA, TYPE_MAP) {
    var startTs = tsOf(P.start);
    var endTs = tsOf(P.end);
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    var byId = {};
    var qA = db.collection('bookings').where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get();
    var qB = db.collection('bookings').where('date', '>=', sIso).where('date', '<=', eIso).get();
    var laMs = lookaheadEndMsFor(P);
    var qC = laMs > P.end.getTime()
      ? db.collection('bookings').where('createdAt', '>', endTs).where('createdAt', '<=', tsOf(new Date(laMs))).get()
      : Promise.resolve(null);
    return Promise.all([qA, qB, qC]).then(function (res) {
      [res[0], res[1]].forEach(function (snap, idx) {
        snap.forEach(function (doc) {
          var d = byId[doc.id];
          if (!d) { d = doc.data(); d._id = doc.id; d._inCreated = false; d._inDue = false; byId[doc.id] = d; }
          if (idx === 0) d._inCreated = true; else d._inDue = true;
        });
      });
      DATA.bookingsById = {};
      DATA.bookings = Object.keys(byId).map(function (k) {
        var b = byId[k];
        b._class = classifyBooking(b, TYPE_MAP);
        b._p9 = phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
        b._createdMs = parseFlexMs(b.createdAt);
        DATA.bookingsById[b._id] = b;
        return b;
      });
      /* C — RDV post-fenêtre pour le TTB seul. Un RDV déjà chargé par B
         (date dans la période) reste dans DATA.bookings : le passage TTB
         de compute() le rattrape via son _createdMs post-fenêtre. */
      DATA.bookingsTtb = [];
      if (res[2]) res[2].forEach(function (doc) {
        if (byId[doc.id]) return;
        var d = doc.data(); d._id = doc.id;
        d._class = classifyBooking(d, TYPE_MAP);
        d._p9 = phone9(d.prospect && (d.prospect.telephone || d.prospect.phone));
        d._createdMs = parseFlexMs(d.createdAt);
        DATA.bookingsTtb.push(d);
      });
    }).catch(function (e) { console.warn('[funnel] bookings', e.message); DATA.bookings = []; DATA.bookingsTtb = []; });
  }

  /* Leads devenus CLIENTS dans la période (clientSince) — source de vérité
     des closes QUEL QUE SOIT le chemin : résultat RDV, fiche CRM (stage Won),
     pipeline. Un close fait depuis la fiche, même sans outcome sur le RDV,
     apparaît ici. SB/NB via closed_won_self / closed_won_setting. */
  function loadClosedLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endTs = tsOf(P.end);
    return db.collection('leads')
      .where('clientSince', '>=', startTs)
      .where('clientSince', '<=', endTs)
      .limit(500)
      .get().then(function (snap) {
        DATA.closedLeads = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.closedLeads.push(d); });
      }).catch(function (e) { console.warn('[funnel] closedLeads', e.message); DATA.closedLeads = []; });
  }

  /* MODULE PAIEMENTS (collection payments — GoCardless) : LA vérité du cash
     (validé Adrien 14/07). Chaque doc : totalAmount (contrat TTC),
     paidAmount (encaissé réel à date), paymentsHistory[] (chaque
     prélèvement daté), leadId / leadEmail, closerSlug, status.
     Croisement par client gagné : collecté = paidAmount du client (→ HT),
     repli sur l'encaissé déclaré aux cartes du Close. La collection est
     petite (dizaines de docs) → chargée en entier, croisée côté client. */
  function loadPayments(db, DATA) {
    DATA.payments = [];
    return db.collection('payments').get().then(function (snap) {
      snap.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        DATA.payments.push(d);
      });
    }).catch(function (e) { console.warn('[funnel] payments', e.message); DATA.payments = []; });
  }

  /* Appels : requête étendue jusqu'au lookahead (fin de fenêtre + 14 j,
     plafonné à maintenant) pour que le 1er contact d'un lead entré dans la
     période soit trouvé même s'il a lieu après (fix censure 15/07).
     _inPeriod sépare l'activité de la période (cartes appels / décrochés /
     par closer) du parcours par lead (TTC, joignabilité, tentatives). */
  function loadCalls(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endMs = P.end.getTime();
    var endTs = tsOf(new Date(lookaheadEndMsFor(P)));
    return db.collection('call_logs')
      .where('initiatedAt', '>=', startTs)
      .where('initiatedAt', '<=', endTs)
      .orderBy('initiatedAt', 'asc')
      .limit(CALLS_QUERY_LIMIT)
      .get().then(function (snap) {
        DATA.callsTruncated = snap.size >= CALLS_QUERY_LIMIT;
        var out = [];
        snap.forEach(function (doc) {
          var d = doc.data();
          d._ms = parseFlexMs(d.initiatedAt) || parseFlexMs(d.startTime);
          d._inPeriod = d._ms == null || d._ms <= endMs;
          d._p9 = phone9(d.direction === 'inbound' ? d.fromNumber : d.toNumber);
          out.push(d);
        });
        DATA.calls = out;
      }).catch(function (e) { console.warn('[funnel] calls', e.message); DATA.calls = []; });
  }

  /* Coûts setting RÉELS — _config/funnel_costs : { months: { 'YYYY-MM':
     { fixe, outils } } }. Une valeur vaut pour son mois ET les suivants
     (report automatique) tant qu'aucune valeur plus récente n'existe.
     Zéro invention : sans entrée couvrant la période → « — » à l'écran. */
  function loadFunnelCosts(db, DATA) {
    return db.collection('_config').doc('funnel_costs').get().then(function (snap) {
      DATA.costs = (snap.exists && snap.data().months) || {};
    }).catch(function (e) { console.warn('[funnel] costs', e.message); DATA.costs = null; });
  }

  /* Commissions Setting RÉELLES — deals du module Commissions
     (commissions/{slug}/mois/{YYYY-MM} → deals[] de type 'Setting') datés
     dans la fenêtre. Comm + bonus ; deals validés (ok) comme en attente
     d'encaissement — la commission est due dès le close. Membres partis
     inclus (l'historique reste un coût réel). */
  function loadSettingDeals(db, P, DATA, TEAM) {
    DATA.settingDeals = [];
    return Promise.resolve().then(function () {
      var slugs = { elodie: 1, guillaume: 1 };
      TEAM.forEach(function (m) {
        if (m && m.slug && (m.role === 'setter' || m.role === 'closer' || m.role === 'closer_setter')) slugs[m.slug] = 1;
      });
      /* ⚠ Fenêtre ÉLARGIE d'un mois de chaque côté (26/07/2026) — depuis le
         décalage des commissions Setting, le deal d'un close de juillet est
         stocké dans le document d'AOÛT (versement M+1), et peut avoir été
         déplacé à la main vers juin. Le filtre qui compte reste `dl.date`
         ∈ période : élargir le balayage ne fait qu'aller CHERCHER le deal là
         où il dort, sans jamais en compter un hors période.
         Sans ça, commSetting — donc le coût setting et le coût / RDV NB —
         serait silencieusement sous-évalué. */
      var mks = {};
      var d = new Date(P.start.getFullYear(), P.start.getMonth() - 1, 1);
      var lastMk = new Date(P.end.getFullYear(), P.end.getMonth() + 1, 1);
      while (d.getTime() <= lastMk.getTime()) {
        mks[d.getFullYear() + '-' + pad2(d.getMonth() + 1)] = 1;
        d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      }
      var proms = [];
      Object.keys(slugs).forEach(function (slug) {
        Object.keys(mks).forEach(function (mk) {
          proms.push(db.collection('commissions').doc(slug).collection('mois').doc(mk).get().then(function (snap) {
            if (!snap.exists) return;
            (snap.data().deals || []).forEach(function (dl) {
              if (!dl || dl.type !== 'Setting') return;
              var ms = frDateMs(dl.date);
              if (ms == null || ms < P.start.getTime() || ms > P.end.getTime()) return;
              DATA.settingDeals.push({ slug: slug, comm: (Number(dl.comm) || 0) + (Number(dl.bonus) || 0), ok: dl.ok === true, client: dl.client || '' });
            });
          }).catch(function () {}));
        });
      });
      return Promise.all(proms);
    });
  }

  /* Chaînes de replanification — un RDV replanifié pointe vers son
     remplaçant (rescheduledToId). Pour statuer une chaîne créée dans la
     période il faut son RDV TERMINAL, qui peut avoir été créé après la fin
     de la période (absent des 2 requêtes bookings) → on va chercher les
     chaînons manquants un par un (rarissime : quelques docs max). Ils vont
     dans bookingsById UNIQUEMENT (jamais dans les compteurs pris/tenue). */
  function resolveChains(db, DATA, TYPE_MAP) {
    function missingTargets() {
      var ids = [];
      Object.keys(DATA.bookingsById).forEach(function (bid) {
        var cur = DATA.bookingsById[bid], guard = 0;
        while (cur && cur.rescheduledToId && guard++ < 10) {
          var nxt = DATA.bookingsById[cur.rescheduledToId];
          if (!nxt) { if (ids.indexOf(cur.rescheduledToId) < 0) ids.push(cur.rescheduledToId); break; }
          cur = nxt;
        }
      });
      return ids;
    }
    function fetchRound(depth) {
      var ids = missingTargets();
      if (!ids.length || depth > 4) return Promise.resolve();
      var proms = ids.slice(0, 20).map(function (id) {
        return db.collection('bookings').doc(id).get().then(function (snap) {
          if (!snap.exists) return;
          var d = snap.data(); d._id = snap.id; d._inCreated = false; d._inDue = false;
          d._class = classifyBooking(d, TYPE_MAP);
          d._p9 = phone9(d.prospect && (d.prospect.telephone || d.prospect.phone));
          d._createdMs = parseFlexMs(d.createdAt);
          DATA.bookingsById[d._id] = d;
        }).catch(function () {});
      });
      return Promise.all(proms).then(function () { return fetchRound(depth + 1); });
    }
    return fetchRound(0);
  }

  /* Paiements de la période SANS client gagné correspondant — règle Adrien
     14/07 : un paiement créé dans la période EST un close commercial, sauf
     s'il rattrape un client déjà gagné dans une autre période. On résout la
     fiche (leadId → email → téléphone) AVANT le calcul :
       · fiche gagnée dans la période      → matchée normalement (rien à faire)
       · fiche gagnée dans une AUTRE période → paiement tardif (diagnostic)
       · fiche jamais gagnée, ou introuvable → close compté via Paiements. */
  function resolvePaymentLeads(db, P, DATA) {
    var ps = P.start.getTime(), pe = P.end.getTime();
    var wonById = {}, wonByEmail = {}, wonByP9 = {};
    (DATA.closedLeads || []).forEach(function (l) {
      wonById[l._id] = 1;
      var em = (l.email || '').toLowerCase().trim();
      if (em) wonByEmail[em] = 1;
      var p9 = phone9(l.telephone || l.phone);
      if (p9) wonByP9[p9] = 1;
    });
    var todo = [];
    (DATA.payments || []).forEach(function (p) {
      p._payClose = null;
      if (!p || p.status === 'cancelled' || p.status === 'draft') return;
      var cms = parseFlexMs(p.createdAt);
      if (cms == null || cms < ps || cms > pe) return;
      var em = (p.leadEmail || '').toLowerCase().trim();
      var p9 = phone9(p.leadPhone);
      if ((p.leadId && wonById[p.leadId]) || (em && wonByEmail[em]) || (p9 && wonByP9[p9])) return;
      todo.push(p);
    });
    if (!todo.length) return Promise.resolve();
    function leadFromSnap(snap) {
      var out = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; if (d._merged !== true) out.push(d); });
      return out;
    }
    function resolveOne(p) {
      var em = (p.leadEmail || '').toLowerCase().trim();
      var p9 = phone9(p.leadPhone);
      var pr;
      if (p.leadId) {
        pr = db.collection('leads').doc(p.leadId).get().then(function (snap) {
          if (!snap.exists) return [];
          var d = snap.data(); d._id = snap.id; return [d];
        }).catch(function () { return []; });
      } else pr = Promise.resolve([]);
      return pr.then(function (list) {
        if (list.length || !em) return list;
        return db.collection('leads').where('email', '==', em).limit(3).get().then(leadFromSnap).catch(function () { return []; });
      }).then(function (list) {
        if (list.length || !p9) return list;
        return db.collection('leads').where('phoneNormalized', '==', p9).limit(3).get().then(leadFromSnap).catch(function () { return []; });
      }).then(function (list) {
        var name = p.leadName || em || '—';
        if (!list.length) { p._payClose = { kind: 'count', name: name, sb: false, tunnel: null, noLead: true }; return; }
        var l = list[0];
        var since = parseFlexMs(l.clientSince);
        var isWon = l.isClient === true || since != null || String(l.stage || '').indexOf('closed_won') === 0;
        if (isWon && (since == null || since < ps || since > pe)) {
          p._payClose = { kind: 'other', name: l.nom || name };
        } else {
          p._payClose = { kind: 'count', name: l.nom || name, sb: l.stage === 'closed_won_self', tunnel: leadTunnel(l), noLead: false };
        }
      }).catch(function () { p._payClose = null; });
    }
    return Promise.all(todo.map(resolveOne));
  }

  function loadJournalPeriod(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('marketing_journal').where('date', '>=', sIso).where('date', '<=', eIso).orderBy('date', 'desc').limit(120).get().then(function (snap) {
      DATA.journalPeriod = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.journalPeriod.push(d); });
    }).catch(function (e) { console.warn('[funnel] journal periode', e.message); DATA.journalPeriod = []; });
  }

  /* Journal d'actions setting (lead_actions/{slug}/items — refonte 07/2026).
     Une requête par membre — ÉQUIPE SALES uniquement (setter/closer/
     closer_setter actifs, membres partis exclus — validé Adrien 14/07). */
  function loadActionsAll(db, P, DATA, TEAM) {
    DATA.actions = [];
    return Promise.resolve().then(function () {
      var members = TEAM.filter(function (m) {
        return m && m.slug && m.slug !== 'guillaume' && m.active !== false
          && (m.role === 'setter' || m.role === 'closer' || m.role === 'closer_setter');
      });
      if (!members.length) members = [{ slug: 'elodie' }];
      var sIso = isoDate(P.start), eIso = isoDate(P.end);
      var proms = members.map(function (m) {
        return db.collection('lead_actions').doc(m.slug).collection('items')
          .where('day', '>=', sIso).where('day', '<=', eIso).get()
          .then(function (snap) {
            snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.actions.push(d); });
          }).catch(function () {});
      });
      return Promise.all(proms);
    });
  }


  /* ════════════════════════════════════════════════════════════════
     COMPUTE — agrège tout selon le filtre tunnel
     ════════════════════════════════════════════════════════════════ */
  function computeKpis(ctx) {
    var DATA = ctx.DATA, P = ctx.P, tunnelFilter = ctx.tunnelFilter;
    var TEAM = ctx.teamMembers || [];
    function tunnelMatch(t) { return tunnelFilter === 'all' || t === tunnelFilter; }
    function lookaheadEndMs() { return lookaheadEndMsFor(P); }

    var k = {};
    var todayIso = isoDate(new Date());
    var laEnd = lookaheadEndMsFor(P); // borne des parcours par lead (TTC/TTB/SMS/joignabilité)

    /* ── Index leads (cohorte + ré-optins) ── */
    var leadsById = {}, leadsByP9 = {}, leadsByEmail = {};
    function idxLead(l, inCohort) {
      l._inCohort = inCohort;
      leadsById[l._id] = l;
      if (l._p9 && !leadsByP9[l._p9]) leadsByP9[l._p9] = l;
      var em = (l.email || '').toLowerCase().trim();
      if (em && !leadsByEmail[em]) leadsByEmail[em] = l;
    }
    DATA.leads.forEach(function (l) { idxLead(l, true); });
    DATA.reoptins.forEach(function (l) { idxLead(l, false); });

    var cohort = DATA.leads.filter(function (l) { return tunnelMatch(l._tunnel); });
    var reopt  = DATA.reoptins.filter(function (l) { return tunnelMatch(l._tunnel); });

    k.leads = cohort.length;
    k.reoptins = reopt.length;
    k.leadsByTunnel = { elite: 0, business: 0 };
    DATA.leads.forEach(function (l) { k.leadsByTunnel[l._tunnel]++; });

    /* ── Ads ── */
    var ads = DATA.ads.filter(function (a) { return tunnelMatch(a.tunnel === 'business' ? 'business' : 'elite'); });
    k.spend = 0; k.impressions = 0; k.clicks = 0; k.leadsFb = 0; k.adsDays = 0;
    ads.forEach(function (a) {
      k.spend += Number(a.spend) || 0;
      k.impressions += Number(a.impressions) || 0;
      k.clicks += Number(a.clicks) || 0;
      k.leadsFb += Number(a.leads) || 0;
      if ((Number(a.spend) || 0) > 0 || (Number(a.impressions) || 0) > 0) k.adsDays++;
    });
    k.hasAds = k.spend > 0 || k.impressions > 0 || k.clicks > 0;
    k.cpm = k.impressions > 0 ? k.spend / k.impressions * 1000 : null;
    k.ctr = k.impressions > 0 ? k.clicks / k.impressions * 100 : null;
    k.cpc = k.clicks > 0 ? k.spend / k.clicks : null;
    k.cpl = k.leads > 0 && k.spend > 0 ? k.spend / k.leads : null;

    /* ── Vues opt-in (beacon) ── */
    var views = DATA.views.filter(function (v) {
      var t = v.page === 'business' ? 'business' : 'elite';
      return tunnelMatch(t);
    });
    k.views = 0;
    views.forEach(function (v) { k.views += Number(v.views) || 0; });
    k.optinReal = k.views > 0 ? k.leads / k.views * 100 : null;
    k.optinClicks = k.clicks > 0 ? k.leads / k.clicks * 100 : null;

    /* A/B tests opt-in — agrégation par page × variante (docs beacon
       page_views_daily avec champ variant). Affiché si ≥ 2 variantes. */
    var abByPage = {};
    DATA.views.forEach(function (v) {
      if (!v.variant) return;
      var t = v.page === 'business' ? 'business' : 'elite';
      if (!tunnelMatch(t)) return;
      var pg = v.page || 'other';
      if (!abByPage[pg]) abByPage[pg] = {};
      if (!abByPage[pg][v.variant]) abByPage[pg][v.variant] = { variant: v.variant, views: 0, optins: 0 };
      abByPage[pg][v.variant].views += Number(v.views) || 0;
      abByPage[pg][v.variant].optins += Number(v.optins) || 0;
    });
    k.abTests = [];
    Object.keys(abByPage).forEach(function (pg) {
      var vars = Object.keys(abByPage[pg]).map(function (kk) { return abByPage[pg][kk]; });
      if (vars.length < 2) return;
      vars.sort(function (a, b) { return a.variant < b.variant ? -1 : 1; });
      k.abTests.push({ page: pg, variants: vars });
    });

    /* ── Bookings — tunnel via lead (leadId → phone → email) ── */
    function bookingLead(b) {
      if (b.leadId && leadsById[b.leadId]) return leadsById[b.leadId];
      if (b._p9 && leadsByP9[b._p9]) return leadsByP9[b._p9];
      var em = (b.prospect && b.prospect.email || '').toLowerCase().trim();
      if (em && leadsByEmail[em]) return leadsByEmail[em];
      return null;
    }
    function bookingMatches(b) {
      if (tunnelFilter === 'all') return true;
      var l = bookingLead(b);
      return !!(l && l._tunnel === tunnelFilter);
    }

    var created = DATA.bookings.filter(function (b) { return b._inCreated && b._class !== 'excluded' && bookingMatches(b); });
    var createdFunnelAll = created.filter(function (b) { return b._class === 'self' || b._class === 'setter'; });
    /* Replanifications exclues des « pris » : le RDV de remplacement porte
       rescheduledFromId — le compter regonflerait LTB/CPR à chaque report
       (refonte 07/2026). Il reste compté dans la tenue (date due). */
    var createdFunnel = createdFunnelAll.filter(function (b) { return !b.rescheduledFromId; });
    k.booked = createdFunnel.length;
    k.bookedSelf = createdFunnel.filter(function (b) { return b._class === 'self'; }).length;
    k.bookedSetter = k.booked - k.bookedSelf;
    k.bookedAdmin = created.filter(function (b) { return b._class === 'admin'; }).length;
    k.rescheduledCreated = createdFunnelAll.length - createdFunnel.length;
    /* RDV pris par tunnel Élite / Business (demande head of sales 14/07) —
       calculé sur TOUS les tunnels comme leadsByTunnel, via le lead du RDV. */
    k.bookedByTunnel = { elite: 0, business: 0 };
    DATA.bookings.forEach(function (b) {
      if (!b._inCreated || b.rescheduledFromId) return;
      if (b._class !== 'self' && b._class !== 'setter') return;
      var lbt = bookingLead(b);
      if (lbt && k.bookedByTunnel[lbt._tunnel] != null) k.bookedByTunnel[lbt._tunnel]++;
    });
    k.selfShare = k.booked > 0 ? k.bookedSelf / k.booked * 100 : null;
    k.setterShare = k.booked > 0 ? k.bookedSetter / k.booked * 100 : null;
    k.ltb = k.leads > 0 ? k.booked / k.leads * 100 : null;
    k.cpr = k.spend > 0 && k.booked > 0 ? k.spend / k.booked : null;

    /* Récupération setting — cohorte : leads période avec RDV setter /
       (leads période − leads période avec self-booking). */
    var selfLeadIds = {}, setterLeadIds = {};
    var setterOld = 0, unknownLeadBookings = 0;
    /* TTB — 1er RDV de chaque lead cohorte depuis son entrée (min par lead).
       TTB séparés self / setting (audit 14/07 : la médiane globale était
       écrasée par les self-bookings pris en quelques minutes). */
    function applyTtb(b) {
      var l = bookingLead(b);
      if (!l || !l._inCohort) return;
      var ms = b._createdMs;
      if (ms != null && l._entry != null && ms >= l._entry) {
        if (l._ttb == null || ms - l._entry < l._ttb) l._ttb = ms - l._entry;
        if (b._class === 'self') { if (l._ttbSelf == null || ms - l._entry < l._ttbSelf) l._ttbSelf = ms - l._entry; }
        else if (l._ttbSet == null || ms - l._entry < l._ttbSet) l._ttbSet = ms - l._entry;
      }
      l._bk = l._bk || [];
      l._bk.push(b);
    }
    /* Récupération / TTB : dédupliqué par lead → on garde TOUS les RDV créés
       (replanifications incluses) pour ne pas perdre le marquage SB/NB du lead. */
    createdFunnelAll.forEach(function (b) {
      var l = bookingLead(b);
      if (!l) { unknownLeadBookings++; return; }
      if (!l._inCohort) { if (b._class === 'setter') setterOld++; return; }
      if (b._class === 'self') selfLeadIds[l._id] = 1;
      else setterLeadIds[l._id] = 1;
      applyTtb(b);
    });
    /* RDV créés APRÈS la fenêtre (≤ lookahead) — fix censure 15/07 : un lead
       entré en fin de fenêtre qui booke le lendemain a un time-to-book.
       Ne touche QUE _ttb/_ttbSelf/_ttbSet et la colonne RDV du détail leads —
       récupération, LTB, CPR et tenue restent strictement sur la période. */
    (DATA.bookingsTtb || [])
      .concat(DATA.bookings.filter(function (b) {
        return !b._inCreated && b._createdMs != null && b._createdMs > P.end.getTime() && b._createdMs <= laEnd;
      }))
      .forEach(function (b) {
        if (b._class !== 'self' && b._class !== 'setter') return;
        if (!bookingMatches(b)) return;
        applyTtb(b);
      });
    var cohortSelf = 0, cohortSetter = 0;
    cohort.forEach(function (l) {
      if (selfLeadIds[l._id]) cohortSelf++;
      else if (setterLeadIds[l._id]) cohortSetter++;
    });
    k.cohortSelf = cohortSelf;
    k.cohortSetter = cohortSetter;
    k.recovery = (k.leads - cohortSelf) > 0 ? cohortSetter / (k.leads - cohortSelf) * 100 : null;
    k.setterOldLeads = setterOld;
    k.unknownLeadBookings = unknownLeadBookings;

    /* ── Tenue — RDV dont la date tombe dans la période ──
       Cohérence 14/07/2026 : les REPLANIFIÉS sont sortis des annulés (le RDV
       de remplacement les remplace), et la ventilation se fait par nature
       SB / NB — plus jamais « par personne » (le nom de l'opérateur qui
       clique Annuler, ex. la CSM, n'est pas une donnée métier setting). */
    var due = DATA.bookings.filter(function (b) { return b._inDue && (b._class === 'self' || b._class === 'setter') && bookingMatches(b); });
    function dueRescheduledF(b) { return b.outcome === 'replanifie' || (b.status === 'cancelled' && b.rescheduled === true); }
    function dueCancelledF(b) { return !dueRescheduledF(b) && (b.outcome === 'annule' || b.status === 'cancelled'); }
    k.due = due.length;
    k.dueRescheduled = due.filter(dueRescheduledF).length;
    k.dueCancelled = due.filter(dueCancelledF).length;
    k.dueNoShow = due.filter(function (b) { return b.status === 'no_show'; }).length;
    k.dueCompleted = due.filter(function (b) { return b.status === 'completed'; }).length;
    k.dueToStatus = due.filter(function (b) { return (b.status === 'confirmed' || b.status === 'pending') && b.date < todayIso; }).length;
    k.dueUpcoming = due.filter(function (b) { return (b.status === 'confirmed' || b.status === 'pending') && b.date >= todayIso; }).length;
    k.kept = k.due - k.dueCancelled - k.dueNoShow - k.dueRescheduled;
    k.keptPct = k.due > 0 ? k.kept / k.due * 100 : null;
    k.cancelRate = k.due > 0 ? (k.dueCancelled + k.dueNoShow) / k.due * 100 : null;
    /* Ventilation SB / NB (demande Adrien : « combien annulation SB et
       combien annulé du NB ») — mêmes prédicats, sous-ensembles du même due. */
    var dueSelf = due.filter(function (b) { return b._class === 'self'; });
    var dueSetter = due.filter(function (b) { return b._class === 'setter'; });
    k.dueSB = dueSelf.length;
    k.dueNB = dueSetter.length;
    k.cancSB = dueSelf.filter(dueCancelledF).length;
    k.cancNB = dueSetter.filter(dueCancelledF).length;
    k.noshowSB = dueSelf.filter(function (b) { return b.status === 'no_show'; }).length;
    k.noshowNB = dueSetter.filter(function (b) { return b.status === 'no_show'; }).length;
    k.reschedSB = dueSelf.filter(dueRescheduledF).length;
    k.reschedNB = dueSetter.filter(dueRescheduledF).length;

    /* ══ RÉSULTATS D'APPEL — helpers outcome (refonte 07/2026) ══
       présent (live) = offre|close|non_close|disqualifie (repli : status
       completed pour les RDV d'avant la refonte) · pitché = offre|close|
       non_close · replanifié = remplacé par un autre RDV (chaîne). */
    function ocOf(b) { return b.outcome || null; }
    function ocCancelled(b) { var o = ocOf(b); return o === 'annule' || (!o && b.status === 'cancelled' && b.rescheduled !== true); }
    function ocNoShow(b) { var o = ocOf(b); return o === 'no_show' || (!o && b.status === 'no_show'); }
    function ocPresent(b) { var o = ocOf(b); return o ? (o === 'offre' || o === 'close' || o === 'non_close' || o === 'disqualifie') : b.status === 'completed'; }
    function ocPitched(b) { var o = ocOf(b); return o === 'offre' || o === 'close' || o === 'non_close'; }

    /* Fin de chaîne : un RDV replanifié est représenté par son remplaçant —
       le résultat d'une chaîne créée dans la période compte dans la période,
       même si le RDV final se tient plus tard (axe « RDV créés »). */
    function chainTerminal(b) {
      var cur = b, guard = 0;
      while (cur && cur.rescheduledToId && guard++ < 10) {
        var nxt = DATA.bookingsById[cur.rescheduledToId];
        if (!nxt) break;
        cur = nxt;
      }
      return cur;
    }

    /* Agrégat sur l'axe « RDV créés » : une entrée = une chaîne (RDV initial
       créé dans la période), statuée par son RDV terminal.
       KEPT (lignes) = pris − annulés — règle Vincent 14/07 : le no-show
       reste DANS le kept (le RDV était maintenu), affiché à part. */
    function chainAgg(list) {
      var a = { n: 0, cancelled: 0, noshow: 0, resched: 0, present: 0, disqua: 0, pitched: 0, closesOc: 0, nonCloses: 0, aStatuer: 0, aVenir: 0, sansDetail: 0 };
      list.forEach(function (b0) {
        var b = chainTerminal(b0);
        a.n++;
        if (b !== b0) a.resched++;
        if (ocCancelled(b)) { a.cancelled++; return; }
        if (ocNoShow(b)) a.noshow++;
        if (ocPresent(b)) a.present++;
        if (ocOf(b) === 'disqualifie') a.disqua++;
        if (ocPitched(b)) a.pitched++;
        if (ocOf(b) === 'close') a.closesOc++;
        if (ocOf(b) === 'non_close') a.nonCloses++;
        if (!ocOf(b)) {
          if ((b.status === 'confirmed' || b.status === 'pending') && b.date >= todayIso) a.aVenir++;
          else if (b.status === 'completed') a.sansDetail++;          // tenu, mais offre/close inconnus (avant refonte)
          else if (b.status === 'confirmed' || b.status === 'pending') a.aStatuer++;
        }
      });
      a.kept = a.n - a.cancelled;
      return a;
    }
    k.chSB  = chainAgg(createdFunnel.filter(function (b) { return b._class === 'self'; }));
    k.chNB  = chainAgg(createdFunnel.filter(function (b) { return b._class === 'setter'; }));
    k.chAll = chainAgg(createdFunnel);

    /* Origine du lead de chaque RDV créé (têtes de chaîne) — pont de
       cohérence : « 9 RDV pris SB » vs « 7 self-bookés » s'explique par les
       ré-optins et les leads plus anciens qui prennent AUSSI rendez-vous. */
    function rdvOrigin(list) {
      var o = { cohort: 0, reopt: 0, old: 0 };
      list.forEach(function (b) {
        var l = bookingLead(b);
        if (l && l._inCohort) o.cohort++;
        else if (l) o.reopt++;
        else o.old++;
      });
      return o;
    }
    k.orgSB = rdvOrigin(createdFunnel.filter(function (b) { return b._class === 'self'; }));
    k.orgNB = rdvOrigin(createdFunnel.filter(function (b) { return b._class === 'setter'; }));

    /* Réconciliation des DEUX axes (« créés sur la période » vs « date dans
       la période ») — chiffres exacts, affichés, plus jamais implicites :
       · dueCreatedBefore = RDV du mois posés AVANT le début de période
       · createdDueLater  = chaînes créées ce mois dont le RDV terminal se
         tient APRÈS la fin de période. */
    var endIsoStr = isoDate(P.end);
    k.dueCreatedBefore = due.filter(function (b) { return b._createdMs != null && b._createdMs < P.start.getTime(); }).length;
    k.createdDueLater = 0;
    createdFunnel.forEach(function (b) {
      var t = chainTerminal(b);
      if ((t.date || '') > endIsoStr) k.createdDueLater++;
    });

    /* Résultats sur l'axe « date de RDV » — le mois en totalité (héro L2,
       Tenue, show-up, taux de close). */
    function dueAgg(list) {
      var a = { n: 0, present: 0, disqua: 0, pitched: 0, closesOc: 0, nonCloses: 0, aStatuer: 0, sansDetail: 0 };
      list.forEach(function (b) {
        a.n++;
        if (ocPresent(b)) a.present++;
        if (ocOf(b) === 'disqualifie') a.disqua++;
        if (ocPitched(b)) a.pitched++;
        if (ocOf(b) === 'close') a.closesOc++;
        if (ocOf(b) === 'non_close') a.nonCloses++;
        if (!ocOf(b)) {
          if ((b.status === 'confirmed' || b.status === 'pending') && b.date < todayIso) a.aStatuer++;
          else if (b.status === 'completed') a.sansDetail++;
        }
      });
      return a;
    }
    k.ocDue = dueAgg(due);
    k.ocHasData = due.length > 0 && (k.ocDue.present + k.ocDue.pitched + k.ocDue.closesOc + k.dueCancelled + k.dueNoShow) > 0;

    /* Échelle CPR — MÊME AXE que la carte « RDV pris SB » (RDV SB créés
       dans la période, chaînes dédupliquées, résultat de fin de chaîne) :
       plus jamais deux dénominateurs différents entre la carte et l'échelle. */
    k.ltbSB = k.leads > 0 ? k.bookedSelf / k.leads * 100 : null;
    k.cprSB    = k.spend > 0 && k.chSB.n > 0 ? k.spend / k.chSB.n : null;
    k.cprKept  = k.spend > 0 && k.chSB.kept > 0 ? k.spend / k.chSB.kept : null;
    k.cprLive  = k.spend > 0 && k.chSB.present > 0 ? k.spend / k.chSB.present : null;
    k.cprOffre = k.spend > 0 && k.chSB.pitched > 0 ? k.spend / k.chSB.pitched : null;

    /* Journal d'actions setting (lead_actions) — décomposition honnête :
       le journal compte le 1er contact de la période sur TOUS les leads
       (anciens, ré-optins et self-bookés inclus) → ventilation affichée pour
       que « travaillés > cohorte » soit lisible, jamais suspect.
       Avant la mise en ligne du journal (14/07/2026) : « — », le passé
       n'existe pas et ne sera pas inventé. */
    var acts = DATA.actions || [];
    k.actLeadsWorked = 0; k.actWorkedReopt = 0; k.actWorkedOld = 0; k.actWorkedSelf = 0;
    var setKeys = {};
    acts.forEach(function (a) {
      if (a.firstTouch) {
        k.actLeadsWorked++;
        var la = a.leadId ? leadsById[a.leadId] : null;
        if (la && la._inCohort) { if (selfLeadIds[la._id]) k.actWorkedSelf++; }
        else if (la) k.actWorkedReopt++;
        else k.actWorkedOld++;
      }
      if (a.action === 'set' || a.action === 'set_booking' || a.action === 'rdv_pose') {
        setKeys[(a.leadId || a._id) + '_' + a.day] = 1;
      }
    });
    k.actSets = Object.keys(setKeys).length;
    k.journalLive = isoDate(P.end) >= JOURNAL_GOLIVE;

    /* ── Téléphonie (call_logs) ── */
    function callMatches(c) {
      if (tunnelFilter === 'all') return true;
      var l = c._p9 ? leadsByP9[c._p9] : null;
      return !!(l && l._tunnel === tunnelFilter);
    }
    /* Activité de la PÉRIODE (cartes appels sortants / décrochés / durée /
       par closer) : strictement bornée à [start, end] — les appels chargés
       en lookahead pour le TTC ne comptent jamais ici. */
    var callsOut = DATA.calls.filter(function (c) { return c.direction === 'outbound' && c._inPeriod && callMatches(c); });
    k.callsOut = callsOut.length;
    k.callsAnswered = callsOut.filter(function (c) { return (Number(c.durationSec) || 0) >= ANSWERED_MIN_SEC; }).length;
    k.answerRate = k.callsOut > 0 ? k.callsAnswered / k.callsOut * 100 : null;

    /* time-to-first-contact — premier appel sortant vers chaque lead de la
       cohorte, cherché jusqu'au lookahead (fix censure 15/07 : avant, un
       lead appelé après la fin de fenêtre sortait de la médiane → chiffre
       structurellement flatteur, plafonné à la taille de la fenêtre). */
    var callsByP9 = {};
    DATA.calls.forEach(function (c) {
      if (c.direction !== 'outbound' || !c._p9 || c._ms == null) return;
      if (!callsByP9[c._p9]) callsByP9[c._p9] = [];
      callsByP9[c._p9].push({ ms: c._ms, ans: (Number(c.durationSec) || 0) >= ANSWERED_MIN_SEC });
    });
    var ttcArr = [], ttbArr = [], ttbSelfArr = [], ttbSetArr = [];
    cohort.forEach(function (l) {
      l._nbCalls = 0; l._ttc = null;
      l._nbAnswered = 0;
      if (l._p9 && callsByP9[l._p9]) {
        var arr = callsByP9[l._p9];
        l._nbCalls = arr.length;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].ans) l._nbAnswered++;
          if (l._entry != null && arr[i].ms >= l._entry) {
            if (l._ttc == null || arr[i].ms - l._entry < l._ttc) l._ttc = arr[i].ms - l._entry;
          }
        }
      }
      /* SMS sortants depuis l'entrée du lead (communications[]) */
      l._nbSms = 0;
      var comms = l.communications || [];
      for (var j = 0; j < comms.length; j++) {
        var cm = comms[j];
        if (!cm || cm.type !== 'sms' || cm.direction !== 'outbound') continue;
        var ms = parseFlexMs(cm.date || cm.createdAt);
        if (ms != null && l._entry != null && ms >= l._entry && ms <= laEnd) l._nbSms++;
      }
      if (l._ttc != null) ttcArr.push(l._ttc);
      if (l._ttb != null) ttbArr.push(l._ttb);
      if (l._ttbSelf != null) ttbSelfArr.push(l._ttbSelf);
      if (l._ttbSet != null) ttbSetArr.push(l._ttbSet);
    });
    k.ttcMedian = median(ttcArr);
    k.ttcCount = ttcArr.length;
    k.ttbMedian = median(ttbArr);
    k.ttbCount = ttbArr.length;
    k.ttbSelfMedian = median(ttbSelfArr); k.ttbSelfCount = ttbSelfArr.length;
    k.ttbSetMedian  = median(ttbSetArr);  k.ttbSetCount  = ttbSetArr.length;
    /* Zéros honnêtes : les médianes ne portent que sur les leads DÉJÀ
       appelés / bookés. Provisoire tant que le lookahead est tronqué par
       « maintenant » — des 1ers contacts peuvent encore arriver et
       ALLONGER les médianes (jamais les raccourcir). */
    k.ttxProvisional = P.end.getTime() + TTX_LOOKAHEAD_MS > Date.now();

    /* Joignabilité & tentatives — parcours par lead de la cohorte : appels
       comptés jusqu'au lookahead (un lead appelé le lendemain de la fenêtre
       compte « appelé »), cohérent avec le TTC. */
    var leadsCalled = 0, leadsReached = 0, attemptsSum = 0;
    cohort.forEach(function (l) {
      if ((l._nbCalls || 0) > 0) {
        leadsCalled++;
        attemptsSum += l._nbCalls;
        if ((l._nbAnswered || 0) > 0) leadsReached++;
      }
    });
    k.leadsCalled = leadsCalled;
    k.leadsReached = leadsReached;
    k.leadsNeverCalled = k.leads - leadsCalled; // jamais appelés à ce jour (téléphone absent inclus)
    k.reachRate = leadsCalled > 0 ? leadsReached / leadsCalled * 100 : null;
    k.attemptsAvg = leadsCalled > 0 ? attemptsSum / leadsCalled : null;

    /* Durée moyenne des appels décrochés (tous appels sortants période) */
    var ansDurSum = 0, ansDurN = 0;
    callsOut.forEach(function (c) {
      var dSec = Number(c.durationSec) || 0;
      if (dSec >= ANSWERED_MIN_SEC) { ansDurSum += dSec; ansDurN++; }
    });
    k.avgAnsweredDurSec = ansDurN > 0 ? ansDurSum / ansDurN : null;

    /* Répartition par closer (userId du call_log → nom d'équipe) */
    var byUser = {};
    callsOut.forEach(function (c) {
      var uid = c.userId || c.ringoverUserId || 'unknown';
      if (!byUser[uid]) byUser[uid] = { name: null, out: 0, ans: 0, rawName: c.userName || c.ringoverUserName || null };
      byUser[uid].out++;
      if ((Number(c.durationSec) || 0) >= ANSWERED_MIN_SEC) byUser[uid].ans++;
      if (!byUser[uid].rawName && (c.userName || c.ringoverUserName)) byUser[uid].rawName = c.userName || c.ringoverUserName;
    });
    var tmList = TEAM;
    Object.keys(byUser).forEach(function (uid) {
      var nm = null;
      for (var i2 = 0; i2 < tmList.length; i2++) {
        if (tmList[i2].firebaseUid === uid) { nm = tmList[i2].shortName || tmList[i2].displayName; break; }
      }
      byUser[uid].name = nm || byUser[uid].rawName || (uid === 'unknown' ? 'Non attribué' : uid.slice(0, 8) + '…');
    });
    k.callsByUser = Object.keys(byUser).map(function (uid) { return byUser[uid]; }).sort(function (a, b) { return b.out - a.out; });

    /* ── Show-up RÉEL : présents du mois (résultats RDV) / kept — plus
       aucune saisie manuelle nulle part (décision Adrien 14/07). ── */
    k.showup = (k.kept > 0 && k.ocHasData) ? k.ocDue.present / k.kept * 100 : null;

    /* ── Closes « clients gagnés » — 100 % logiciel, trois chemins :
       ① fiches passées clientes dans la période (clientSince — posé par le
          résultat RDV, les cartes du Close, la fiche CRM) ;
       ② closes RDV sans fiche liée ;
       ③ paiements créés dans la période sans client gagné correspondant
          (règle Adrien 14/07 : un paiement = un close commercial, sauf
          rattrapage d'un client gagné dans une autre période — résolu au
          chargement par resolvePaymentLeads). ── */
    var closedLeads = (DATA.closedLeads || []).filter(function (l) { return tunnelMatch(leadTunnel(l)); });
    var closesNoLeadSB = 0, closesNoLeadNB = 0;
    due.forEach(function (b) {
      if (b.outcome !== 'close' || b.leadId) return;
      if (b._class === 'self') closesNoLeadSB++; else closesNoLeadNB++;
    });
    var wonSelfLeads = closedLeads.filter(function (l) { return l.stage === 'closed_won_self'; }).length;

    /* ── Montants — MODULE PAIEMENTS d'abord (règle Adrien 14/07) :
       collecté  = ① prélèvements passés (paidAmount) s'il y en a
                   ② sinon, dès que le paiement existe (hors annulé /
                     brouillon) : 1 mensualité pour un fractionné (« la
                     mensualité correspond à l'encaissé »), la totalité pour
                     un intégral — suivi « à prélever (mandat) »
                   ③ sinon l'encaissé DÉCLARÉ aux cartes du Close
                   ④ sinon « close sans montant » — alerte nominative, jamais
                     un zéro muet
       contracté = totalAmount (hors annulés/brouillons), sinon tarif des
                   cartes. TTC → HT ÷ 1,2 (sauf vatType 'ht').
       Rattachement paiement → client : leadId → email → téléphone.
       Un paiement déjà rattaché ne compte JAMAIS deux fois (_matched). ── */
    function payHT(p, amount) {
      var a = Number(amount) || 0;
      return p && p.vatType === 'ht' ? a : a / 1.2; // module Paiements = TTC par défaut
    }
    var declByLead = {};   // encaissé/contracté déclarés aux cartes (closeData des RDV)
    (DATA.bookings || []).forEach(function (b) {
      if (b.outcome !== 'close' || !b.closeData || !b.leadId) return;
      declByLead[b.leadId] = { col: Number(b.closeData.collecte) || 0, con: Number(b.closeData.contracte) || 0 };
    });
    var paysByLead = {}, paysByEmail = {}, paysByP9 = {};
    (DATA.payments || []).forEach(function (p) {
      if (!p) return;
      p._matched = false;
      if (p.leadId) { (paysByLead[p.leadId] = paysByLead[p.leadId] || []).push(p); }
      var pem = (p.leadEmail || '').toLowerCase().trim();
      if (pem) { (paysByEmail[pem] = paysByEmail[pem] || []).push(p); }
      var pp9 = phone9(p.leadPhone);
      if (pp9) { (paysByP9[pp9] = paysByP9[pp9] || []).push(p); }
    });
    /* Contribution d'UN paiement : {col, con, mandat}. */
    function payMoney(p) {
      var out = { col: 0, con: 0, mandat: 0 };
      var active = p.status !== 'cancelled' && p.status !== 'draft';
      var paid = payHT(p, p.paidAmount);
      if (paid > 0) out.col = paid;
      else if (active) {
        var due1 = p.type === 'installments' ? (Number(p.installmentAmount) || 0) : (Number(p.totalAmount) || 0);
        out.col = payHT(p, due1);
        out.mandat = out.col;
      }
      if (active) out.con = payHT(p, p.totalAmount);
      return out;
    }
    function payForClient(leadId, email, p9) {
      var seen = {}, list = [];
      function add(arr) { (arr || []).forEach(function (p) { if (!seen[p._id] && !p._matched) { seen[p._id] = 1; list.push(p); } }); }
      add(paysByLead[leadId]);
      if (email) add(paysByEmail[email]);
      if (p9) add(paysByP9[p9]);
      var col = 0, con = 0, mandat = 0;
      list.forEach(function (p) {
        p._matched = true;
        var m = payMoney(p);
        col += m.col; con += m.con; mandat += m.mandat;
      });
      return { n: list.length, col: Math.round(col * 100) / 100, con: Math.round(con * 100) / 100, mandat: Math.round(mandat * 100) / 100 };
    }
    var wonColSB = 0, wonConSB = 0, wonColNB = 0, wonConNB = 0;
    var colMissing = 0, noPayCount = 0, mandatSum = 0, colMissingNames = [];
    closedLeads.forEach(function (l) {
      var sb2 = l.stage === 'closed_won_self';
      var lem = (l.email || '').toLowerCase().trim();
      var pay = payForClient(l._id, lem, phone9(l.telephone || l.phone));
      var decl = declByLead[l._id] || (l.closedData ? { col: Number(l.closedData.collecte) || 0, con: Number(l.closedData.contracte) || 0 } : null);
      if (!pay.n) noPayCount++;
      var col = null, con = 0;
      if (pay.n && pay.col > 0) { col = pay.col; mandatSum += pay.mandat; }
      else if (decl && decl.col > 0) col = decl.col;
      if (pay.con > 0) con = pay.con;
      else if (decl) con = decl.con;
      if (col == null) { colMissing++; colMissingNames.push(l.nom || lem || l._id); }
      l._wonCol = (col || 0);   /* collecté consolidé par fiche — réutilisé par la section « par créative » */
      if (sb2) { wonColSB += (col || 0); wonConSB += con; } else { wonColNB += (col || 0); wonConNB += con; }
    });
    /* Closes RDV sans fiche liée : Paiements par email/téléphone, repli cartes. */
    due.forEach(function (b) {
      if (b.outcome !== 'close' || b.leadId) return;
      var bem = (b.prospect && b.prospect.email || '').toLowerCase().trim();
      var pay3 = payForClient('__none__', bem, phone9(b.prospect && (b.prospect.telephone || b.prospect.phone)));
      var col3 = null, con3 = 0;
      if (pay3.n && pay3.col > 0) { col3 = pay3.col; mandatSum += pay3.mandat; }
      else if (b.closeData && Number(b.closeData.collecte) > 0) col3 = Number(b.closeData.collecte);
      if (pay3.con > 0) con3 = pay3.con;
      else if (b.closeData) con3 = Number(b.closeData.contracte) || 0;
      if (col3 == null) { colMissing++; colMissingNames.push((b.prospect && b.prospect.nom) || bem || b._id); }
      if (b._class === 'self') { wonColSB += (col3 || 0); wonConSB += con3; } else { wonColNB += (col3 || 0); wonConNB += con3; }
    });
    /* ③ Closes détectés via Paiements (fiche jamais gagnée / introuvable). */
    k.payCloseNames = []; k.payCloseOther = [];
    var payClosesSB = 0, payClosesNB = 0;
    (DATA.payments || []).forEach(function (p) {
      if (!p || !p._payClose || p._matched) return;
      var pc = p._payClose;
      if (pc.kind === 'other') { if (tunnelFilter === 'all') k.payCloseOther.push(pc.name); return; }
      if (pc.tunnel && !tunnelMatch(pc.tunnel)) return;
      if (!pc.tunnel && tunnelFilter !== 'all') return;
      p._matched = true;
      var m3 = payMoney(p);
      mandatSum += m3.mandat;
      if (pc.sb) { payClosesSB++; wonColSB += m3.col; wonConSB += m3.con; }
      else { payClosesNB++; wonColNB += m3.col; wonConNB += m3.con; }
      k.payCloseNames.push(pc.name + (pc.noLead ? ' (aucune fiche trouvée)' : ''));
    });

    k.wonSelf = wonSelfLeads + closesNoLeadSB + payClosesSB;
    k.wonSetting = (closedLeads.length - wonSelfLeads) + closesNoLeadNB + payClosesNB;
    k.closesWonTotal = k.wonSelf + k.wonSetting;
    k.wonCollecteSB = Math.round(wonColSB * 100) / 100; k.wonCollecteNB = Math.round(wonColNB * 100) / 100;
    k.wonContracteSB = Math.round(wonConSB * 100) / 100; k.wonContracteNB = Math.round(wonConNB * 100) / 100;
    k.wonCollecte = Math.round((wonColSB + wonColNB) * 100) / 100;
    k.wonContracte = Math.round((wonConSB + wonConNB) * 100) / 100;
    k.collecteMandat = Math.round(mandatSum * 100) / 100;
    k.collecteMissing = colMissing;
    k.collecteMissingNames = colMissingNames;
    k.closesNoPayment = noPayCount;

    /* ── 🎨 Performance par créative (UTM) — validé Adrien 22/07 ──
       Axe = utmKeyOf(lead). Chaque métrique garde l'axe temporel de SA
       section (décision 3a) : leads = entrés période (cohorte) · RDV pris =
       créés période (replanifs dédupliquées, comme Prise de RDV) · annulés /
       no-show = RDV ayant lieu dans la période (prédicats de la Tenue,
       replanifiés exclus) · closes = fiches gagnées clientSince période +
       collecté consolidé (_wonCol — Paiements, repli cartes). Qualifiés =
       leadScore 4-5 (curseur Leads Live) ; non notés hors moyenne.
       Les événements dont le lead n'est pas rattachable (hors fenêtre de
       chargement, close sans fiche, close détecté via Paiements) partent
       dans k.utmUnattr — affichés en note, jamais un zéro muet. */
    var utmMap = {};
    function utmRowOf(key) {
      if (!utmMap[key]) utmMap[key] = { key: key, leads: 0, scoreSum: 0, scoreN: 0, qual: 0, booked: 0, cancelled: 0, noshow: 0, closes: 0, col: 0 };
      return utmMap[key];
    }
    cohort.forEach(function (l) {
      var ur = utmRowOf(utmKeyOf(l));
      ur.leads++;
      if (l.leadScore >= 1 && l.leadScore <= 5) {
        ur.scoreSum += l.leadScore; ur.scoreN++;
        if (l.leadScore >= 4) ur.qual++;
      }
    });
    var utmUnattr = { booked: 0, cancelled: 0, noshow: 0, closes: 0 };
    createdFunnel.forEach(function (b) {
      var ul = bookingLead(b);
      if (ul) utmRowOf(utmKeyOf(ul)).booked++; else utmUnattr.booked++;
    });
    due.forEach(function (b) {
      var isCancel = dueCancelledF(b);
      var isNoShow = b.status === 'no_show';
      if (!isCancel && !isNoShow) return;
      var ul2 = bookingLead(b);
      if (!ul2) { if (isCancel) utmUnattr.cancelled++; else utmUnattr.noshow++; return; }
      var ur2 = utmRowOf(utmKeyOf(ul2));
      if (isCancel) ur2.cancelled++; else ur2.noshow++;
    });
    closedLeads.forEach(function (l) {
      var ur3 = utmRowOf(utmKeyOf(l));
      ur3.closes++;
      ur3.col += (l._wonCol || 0);
    });
    utmUnattr.closes = closesNoLeadSB + closesNoLeadNB + payClosesSB + payClosesNB;
    k.utmRows = Object.keys(utmMap).map(function (uk) { return utmMap[uk]; })
      .sort(function (a, b) { return (b.leads - a.leads) || (b.closes - a.closes) || (a.key < b.key ? -1 : 1); });
    k.utmUnattr = utmUnattr;

    /* ROAS résultats = collecté réel (HT) / dépense — rien d'autre. */
    k.roasOutcome = (k.spend > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.spend : null;

    /* ── Taux de close du mois (bandeau héro — demande Vincent 14/07) :
       dénominateurs = le mois en totalité (axe date de RDV, replanifiés
       remplacés déduits), numérateur = clients gagnés de la période. ── */
    k.rdvMois = Math.max(0, k.due - k.dueRescheduled);
    k.closeRateRdv   = k.rdvMois > 0 ? k.closesWonTotal / k.rdvMois * 100 : null;
    k.closeRateLive  = k.ocDue.present > 0 ? k.closesWonTotal / k.ocDue.present * 100 : null;
    k.closeRateOffre = k.ocDue.pitched > 0 ? k.closesWonTotal / k.ocDue.pitched * 100 : null;

    /* ── Rentabilité — 100 % réel ── */
    k.cacMarketOnly = (k.spend > 0 && k.closesWonTotal > 0) ? k.spend / k.closesWonTotal : null;
    k.aovAll = (k.closesWonTotal > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.closesWonTotal : null;

    /* ── Coût setting RÉEL (remplace « dépense pub / RDV NB » — décision
       Vincent + Adrien 14/07) : (fixe + commissions Setting + outils)
       ÷ RDV NB créés.
       · fixe & outils : _config/funnel_costs, proratisés au nombre de jours
         de la fenêtre (report auto du dernier mois saisi)
       · commissions : deals Setting RÉELS du module Commissions datés dans
         la fenêtre (comm + bonus, validés ou en attente)
       Coûts non renseignés → « — », jamais un chiffre inventé. ── */
    k.commSetting = 0; k.commSettingN = 0;
    (DATA.settingDeals || []).forEach(function (dl) { k.commSetting += dl.comm; k.commSettingN++; });
    k.commSetting = Math.round(k.commSetting * 100) / 100;
    var fixeSum = 0, outilsSum = 0, daysMissing = 0, costSrc = null;
    if (DATA.costs) {
      var dIt = new Date(P.start.getFullYear(), P.start.getMonth(), P.start.getDate());
      while (dIt.getTime() <= P.end.getTime()) {
        var mk2 = dIt.getFullYear() + '-' + pad2(dIt.getMonth() + 1);
        var eff = effectiveCosts(DATA.costs, mk2);
        if (!eff) daysMissing++;
        else {
          var dim = new Date(dIt.getFullYear(), dIt.getMonth() + 1, 0).getDate();
          fixeSum += eff.fixe / dim;
          outilsSum += eff.outils / dim;
          costSrc = eff.src;
        }
        dIt = new Date(dIt.getFullYear(), dIt.getMonth(), dIt.getDate() + 1);
      }
    } else daysMissing = 1;
    k.costFixe = Math.round(fixeSum * 100) / 100;
    k.costOutils = Math.round(outilsSum * 100) / 100;
    k.costConfigured = daysMissing === 0 && DATA.costs && Object.keys(DATA.costs).length > 0;
    k.costSrcMonth = costSrc;
    /* Le mois affiché a-t-il sa PROPRE entrée ? (les outils sont variables :
       une valeur reportée d'un mois précédent doit être signalée, pas subie) */
    var mkStart = P.start.getFullYear() + '-' + pad2(P.start.getMonth() + 1);
    k.costOwnEntry = !!(DATA.costs && DATA.costs[mkStart]);
    k.costSetting = k.costConfigured ? Math.round((k.costFixe + k.costOutils + k.commSetting) * 100) / 100 : null;
    k.costPerRdvNB = (k.costSetting != null && k.chNB.n > 0) ? k.costSetting / k.chNB.n : null;

    /* Leads restants côté setting = cohorte − leads ayant self-booké. */
    k.leadsNoSB = Math.max(0, k.leads - k.cohortSelf);

    return k;
  }

  /* ══════════════════════════════════════════════════════════════════
     PÉRIODES — un P = { mode, start, end } (end inclusif, 23:59:59.999)
     ══════════════════════════════════════════════════════════════════ */
  function periodMonth(y, m) {
    return { mode: 'month', y: y, m: m,
      start: new Date(y, m, 1, 0, 0, 0, 0),
      end:   new Date(y, m + 1, 0, 23, 59, 59, 999) };
  }
  function periodDay(iso) {
    var p = String(iso).split('-');
    return { mode: 'day', day: iso,
      start: new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0),
      end:   new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59, 999) };
  }
  function periodPreset(days) {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    var s = new Date(end.getTime() - (days - 1) * 86400000);
    return { mode: days + 'd',
      start: new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0), end: end };
  }
  function periodCustom(aIso, bIso) {
    var a = String(aIso).split('-'), b = String(bIso).split('-');
    return { mode: 'custom',
      start: new Date(+a[0], +a[1] - 1, +a[2], 0, 0, 0, 0),
      end:   new Date(+b[0], +b[1] - 1, +b[2], 23, 59, 59, 999) };
  }
  function periodLabelParts(P) {
    return { startIso: isoDate(P.start), endIso: isoDate(P.end), mode: P.mode };
  }

  /* ══════════════════════════════════════════════════════════════════
     RÉFÉRENTIELS — types de RDV et équipe (nécessaires aux loaders)
     ══════════════════════════════════════════════════════════════════ */
  function buildTypeMap(list) {
    var TYPE_MAP = {};
    (list || []).forEach(function (t) {
      if (t && t.id) TYPE_MAP[t.id] = {
        isSetterOnly: t.isSetterOnly === true,
        isCoaching: t.isCoaching === true,
        label: t.label || t.id
      };
    });
    return TYPE_MAP;
  }
  function loadTypeMap(db) {
    return db.collection('booking_config').doc('_types').get().then(function (snap) {
      return buildTypeMap((snap.exists && snap.data().list) || []);
    }).catch(function (e) { console.warn('[funnel-core] types', e.message); return {}; });
  }
  /* Équipe — même source de vérité que nav.js (_meta/team_members), qui
     accepte `members` en objet OU en tableau (Firestore array-ifie parfois). */
  function loadTeamMembers(db) {
    return db.collection('_meta').doc('team_members').get().then(function (snap) {
      if (!snap.exists) return [];
      var raw = (snap.data() || {}).members;
      var list = [];
      if (Array.isArray(raw)) {
        raw.forEach(function (e, i) {
          if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || ('m' + i) }, e));
        });
      } else if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (slug) {
          var e = raw[slug];
          if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || slug }, e));
        });
      }
      list.sort(function (a, b) { return (a.order || 999) - (b.order || 999); });
      return list;
    }).catch(function (e) { console.warn('[funnel-core] team', e.message); return []; });
  }

  /* ══════════════════════════════════════════════════════════════════
     CHARGEMENT COMPLET — même pipeline que refresh() dans sales-funnel.html
     ══════════════════════════════════════════════════════════════════ */
  function emptyData() {
    return { ads: [], views: [], leads: [], reoptins: [], bookings: [], bookingsById: {},
      bookingsTtb: [], calls: [], costs: null, settingDeals: [], journalPeriod: [],
      actions: [], closedLeads: [], payments: [],
      leadsTruncated: false, callsTruncated: false };
  }

  /* opts = { P, typeMap, teamMembers } — typeMap/teamMembers sont chargés
     ici s'ils ne sont pas fournis (cas serveur). */
  function loadAll(db, opts) {
    var P = opts.P;
    var DATA = emptyData();
    var pre = [];
    var TYPE_MAP = opts.typeMap;
    var TEAM = opts.teamMembers;
    if (!TYPE_MAP) pre.push(loadTypeMap(db).then(function (m) { TYPE_MAP = m; }));
    if (!TEAM)     pre.push(loadTeamMembers(db).then(function (l) { TEAM = l; }));

    return Promise.all(pre).then(function () {
      return Promise.all([
        loadAds(db, P, DATA), loadViews(db, P, DATA), loadLeads(db, P, DATA),
        loadBookings(db, P, DATA, TYPE_MAP), loadCalls(db, P, DATA),
        loadFunnelCosts(db, DATA), loadSettingDeals(db, P, DATA, TEAM),
        loadJournalPeriod(db, P, DATA), loadActionsAll(db, P, DATA, TEAM),
        loadClosedLeads(db, P, DATA), loadPayments(db, DATA)
      ]);
    })
    .then(function () { return resolveChains(db, DATA, TYPE_MAP); })
    .then(function () { return resolvePaymentLeads(db, P, DATA); })
    .then(function () { return { DATA: DATA, typeMap: TYPE_MAP, teamMembers: TEAM }; });
  }

  return {
    /* Constantes */
    ANSWERED_MIN_SEC: ANSWERED_MIN_SEC,
    JOURNAL_GOLIVE: JOURNAL_GOLIVE,
    TTX_LOOKAHEAD_MS: TTX_LOOKAHEAD_MS,
    LEADS_QUERY_LIMIT: LEADS_QUERY_LIMIT,
    CALLS_QUERY_LIMIT: CALLS_QUERY_LIMIT,
    /* Helpers réutilisés par les pages (rendu, tri, export) */
    decodeUtm: decodeUtm, utmKeyOf: utmKeyOf, parseFlexMs: parseFlexMs,
    realEntryMs: realEntryMs, pad2: pad2, isoDate: isoDate, median: median,
    phone9: phone9, leadTunnel: leadTunnel, frDateMs: frDateMs,
    effectiveCosts: effectiveCosts, classifyBooking: classifyBooking,
    /* Périodes */
    periodMonth: periodMonth, periodDay: periodDay, periodPreset: periodPreset,
    periodCustom: periodCustom, periodLabelParts: periodLabelParts,
    /* Référentiels + chargement + calcul */
    buildTypeMap: buildTypeMap, loadTypeMap: loadTypeMap, loadTeamMembers: loadTeamMembers,
    emptyData: emptyData, loadAll: loadAll, computeKpis: computeKpis,
    /* Loaders unitaires — sales-funnel.html en rappelle certains seuls après
       une sauvegarde (grille Ads, coûts, journal) sans tout recharger. */
    loadAds: loadAds, loadViews: loadViews, loadLeads: loadLeads,
    loadBookings: loadBookings, loadClosedLeads: loadClosedLeads,
    loadPayments: loadPayments, loadCalls: loadCalls,
    loadFunnelCosts: loadFunnelCosts, loadSettingDeals: loadSettingDeals,
    loadJournalPeriod: loadJournalPeriod, loadActionsAll: loadActionsAll,
    resolveChains: resolveChains, resolvePaymentLeads: resolvePaymentLeads
  };
}));
