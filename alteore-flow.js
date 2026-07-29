/* ═══════════════════════════════════════════════════════════════════════════
   alteore-flow.js — MOTEUR DE PROPAGATION TEAM ALTEORE (refonte 07/2026)
   ─────────────────────────────────────────────────────────────────────────
   La fiche prospect (leads/{id}) est la RACINE. Ce module centralise toutes
   les écritures qui doivent rayonner entre les modules :

     1. recordLeadAction()  — journal immuable des actions setting
                              (lead_actions/{slug}/items) + premier contact
                              (Total Leads = 1ʳᵉ action par lead, jamais recompté)
     2. applyLeadStatus()   — changement de statut fiche = update lead
                              (status+stage) + action + timeline
     3. setOutcome()        — résultat commercial d'un RDV (bookings.outcome)
                              + sync status legacy + propagation fiche
                              + commissions auto au Close
     4. createCommissionDeals() — deals Closing (closer) + Setting NB/SB
                              (setter) idempotents par dealKey

   Dépendances : firebase compat (app/auth/firestore) initialisé,
   window.TEAM_MEMBERS_LIST (nav.js) pour résoudre le membre courant.
   Aucune dépendance UI — rdv-outcome.js fournit la modale.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* ── Résultats d'appel (RDV) ─────────────────────────────────────────── */
  var OUTCOMES = {
    close:       { key: 'close',       label: 'Close',       icon: '🏆', color: '#34d399', desc: 'Vente conclue — génère les commissions' },
    non_close:   { key: 'non_close',   label: 'Non close',   icon: '❌', color: '#f87171', desc: 'RDV tenu, offre refusée' },
    offre:       { key: 'offre',       label: 'Offre',       icon: '💬', color: '#5b7cfa', desc: 'Offre pitchée — en réflexion / follow-up' },
    disqualifie: { key: 'disqualifie', label: 'Disqua',      icon: '🚫', color: '#94a3b8', desc: 'Présent mais hors cible — pas d’offre' },
    no_show:     { key: 'no_show',     label: 'No-show',     icon: '👻', color: '#fbbf24', desc: 'Prospect absent au RDV' },
    annule:      { key: 'annule',      label: 'Annulé',      icon: '🔴', color: '#ef4444', desc: 'RDV annulé — lead à récupérer côté Setting' },
    replanifie:  { key: 'replanifie',  label: 'Replanifié',  icon: '📅', color: '#a78bfa', desc: 'Déplacé — un nouveau RDV remplace celui-ci' }
  };
  var OUTCOME_ORDER = ['close', 'non_close', 'offre', 'disqualifie', 'no_show', 'annule', 'replanifie'];

  /* Dérivés métier (échelle CPR validée Adrien 07/2026) :
     présent (live) = le prospect était là, même sans offre / disqualifié.
     pitché = une offre a été faite. kept = non annulé (replanifié exclu :
     le RDV de remplacement le compte à sa place). */
  var PRESENT_SET = { disqualifie: 1, offre: 1, close: 1, non_close: 1 };
  var PITCHED_SET = { offre: 1, close: 1, non_close: 1 };

  /* Sync du champ legacy bookings.status — l'existant (funnel « Tenue »,
     sales-rdv, booking-admin) continue de fonctionner sans modification. */
  var OUTCOME_TO_BOOKING_STATUS = {
    annule: 'cancelled', no_show: 'no_show', replanifie: 'cancelled',
    disqualifie: 'completed', offre: 'completed', close: 'completed', non_close: 'completed'
  };

  /* ── Commissions (source : contrat Full Cycle Art.3 + avenant Elite) ──
     Miroir de sales-commissions.html / sync-bridge.js — garder aligné. */
  var COMM_RULES = {
    closing: {
      'BP 6':  { mensualise: 200,  pif: 200 },
      'BP 12': { mensualise: 500,  pif: 500 },
      'Elite': { mensualise: 800,  pif: 800 },
      'Titan': { mensualise: 1200, pif: 1200 }
    },
    setting: {
      'BP 6':  { noBooking: 100, selfBooking: 50 },
      'BP 12': { noBooking: 250, selfBooking: 125 },
      'Elite': { noBooking: 300, selfBooking: 150 },
      'Titan': { noBooking: 500, selfBooking: 250 }
    }
  };
  var PIF_BONUS = { 'BP 6': 0, 'BP 12': 100, 'Elite': 100, 'Titan': 0 };
  var OFFRES = ['BP 6', 'BP 12', 'Elite', 'Titan'];
  var PAIEMENTS = [
    { key: 'carte',       label: '💳 Carte' },
    { key: 'virement',    label: '🏦 Virement' },
    { key: 'prelevement', label: '🔁 Prélèvement (GoCardless)' },
    { key: 'autre',       label: '📎 Autre' }
  ];

  /* ═══ Tarifs officiels (HT) — cartes du Close (validé Adrien 14/07) ═══
     La carte 1 propose Elite / Business. « Business » = BP 12 pour les
     commissions. Le PIF est moins cher que le mensualisé (remise comptant).
     encaisse = suggestions de la carte « Encaissé à la signature » :
     PIF → la totalité · MENS → 1 échéance (nb d'échéances libre ≤ maxX). */
  var WIZARD_PRICING = {
    'Elite': {
      commOffre: 'Elite',
      pif:        { contracte: 12000, encaisse: [12000] },
      mensualise: { contracte: 13000, maxX: 4, encaisse: [3250, 6500] }
    },
    'Business': {
      commOffre: 'BP 12',
      pif:        { contracte: 5000, encaisse: [5000] },
      mensualise: { contracte: 6000, maxX: 10, encaisse: [600, 1000, 1500] }
    }
  };

  /* Statuts fiche comptés comme « SET » dans le rapport Setting.
     set_booking = action posée quand un RDV setter est réellement créé. */
  var SET_ACTIONS = { set: 1, set_booking: 1, rdv_pose: 1 };
  var ANSWERED_MIN_SEC = 5; // même seuil décroché que dashboard + funnel

  /* ═══ Helpers génériques ═══════════════════════════════════════════════ */
  function db() { return firebase.firestore(); }
  function ts() { return firebase.firestore.FieldValue.serverTimestamp(); }
  function arrayUnion(v) { return firebase.firestore.FieldValue.arrayUnion(v); }

  function pad2(n) { return String(n).padStart(2, '0'); }
  function dayKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function monthKey(d) { d = d || new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1); }
  function frDateTime(d) {
    d = d || new Date();
    return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function frDate(d) { d = d || new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }

  /* Membre courant — auth Firebase + roster nav.js (_meta/team_members). */
  function me() {
    var u = firebase.auth().currentUser;
    if (!u) return null;
    var members = window.TEAM_MEMBERS_LIST || [];
    var match = null;
    for (var i = 0; i < members.length; i++) {
      if (members[i] && (members[i].firebaseUid === u.uid || members[i].uid === u.uid)) { match = members[i]; break; }
    }
    return {
      uid: u.uid,
      email: u.email || '',
      slug: match ? match.slug : (u.email ? u.email.split('@')[0] : 'user'),
      name: match ? (match.shortName || match.displayName || match.fullName || match.name || match.slug) : (u.displayName || u.email || 'Utilisateur'),
      role: match ? (match.role || '') : '',
      /* resolved=false : roster _meta/team_members pas (encore) chargé — le
         slug est un fallback email, à NE PAS utiliser comme clé de données. */
      resolved: !!match
    };
  }

  function memberBySlug(slug) {
    var members = window.TEAM_MEMBERS_LIST || [];
    for (var i = 0; i < members.length; i++) { if (members[i] && members[i].slug === slug) return members[i]; }
    return null;
  }

  /* ═══ ÉQUIPE SALES — source de vérité unique (validé Adrien 14/07/2026) ═══
     Les modules SET NB / Close SB / Commissions et les sélecteurs
     closer/setter ne concernent QUE l'équipe sales : rôles setter, closer,
     closer_setter, membres actifs. Les admins, coachs et la CSM n'y
     apparaissent jamais. DEPARTED : membres partis de la société, exclus en
     dur même si le roster _meta/team_members n'est pas encore à jour. */
  var DEPARTED = { guillaume: 1 }; // Guillaume Bilcke — parti (07/2026)
  var SALES_ROLES = { setter: 1, closer: 1, closer_setter: 1 };

  function salesMembers() {
    var list = (window.TEAM_MEMBERS_LIST || []).filter(function (m) {
      return m && m.slug && !DEPARTED[m.slug] && m.active !== false && SALES_ROLES[m.role];
    });
    if (!list.length) {
      /* Repli : Élodie — seule membre sales connue si le roster est vide ou
         si les rôles n'y sont pas renseignés. */
      list = [{ slug: 'elodie', shortName: 'Elodie', displayName: 'Elodie Vidotto Siarri', role: 'closer_setter', color: '#60a5fa', firebaseUid: 'IrL8bfOrUfMH2fEPFzuojPT8bQh1', active: true }];
    }
    return list;
  }
  function isSalesMember(slug) {
    if (!slug || DEPARTED[slug]) return false;
    return salesMembers().some(function (m) { return m.slug === slug; });
  }
  function memberByFirebaseUid(uid) {
    var members = window.TEAM_MEMBERS_LIST || [];
    for (var i = 0; i < members.length; i++) { if (members[i] && members[i].firebaseUid === uid) return members[i]; }
    return null;
  }

  /* Classification d'un booking — MÊME règle que sales-funnel.html.
     Règle « deux liens » (Adrien 15/07) : le TYPE prime sur un vieux
     source 'self_booking' — un RDV pris sur le lien setter
     (type isSetterOnly, ex. call_strat_phenix_elodie) est No Booking,
     même si booking.html n'avait pas encore posé le bon source à l'époque.
     typeMap optionnel : { typeId: {isSetterOnly, isCoaching} } */
  function classifyBooking(b, typeMap) {
    var t = (typeMap || {})[b.type] || {};
    if (b.isCoaching === true || t.isCoaching === true) return 'excluded';
    if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return 'excluded';
    if (b.source === 'admin_manual') return 'admin';
    if (b.source === 'setter_booking') return 'setter';
    if (t.isSetterOnly === true) return 'setter';   // type setter = NB, quel que soit le source
    if (b.source === 'self_booking') return 'self';
    return 'self';
  }
  function isSB(b, typeMap) { return classifyBooking(b, typeMap) === 'self'; }
  function isPresent(outcome) { return !!PRESENT_SET[outcome]; }
  function isPitched(outcome) { return !!PITCHED_SET[outcome]; }
  function isAnswered(call) { return (Number(call && call.durationSec) || 0) >= ANSWERED_MIN_SEC; }

  /* ═══ 1. JOURNAL D'ACTIONS SETTING ═════════════════════════════════════
     Une action = un événement immuable dans lead_actions/{slug}/items.
     Premier contact via transaction sur le lead :
       - firstActionAt / firstActionBy         → 1ʳᵉ action toutes équipes
       - firstActionAtBy.{slug}                → 1ʳᵉ action de CE membre
     Le rapport Setting compte « Total Leads » du jour = actions
     firstTouchMember=true du jour (une 2ᵉ action ne recompte JAMAIS). */
  function recordLeadAction(leadRefOrId, leadData, action, opts) {
    opts = opts || {};
    var m = me();
    if (!m || !m.slug) return Promise.resolve(null);
    if (m.resolved === false) {
      /* Roster pas encore chargé : un slug email polluerait lead_actions et
         firstActionAtBy (clé avec points → map imbriquée). On ignore. */
      console.warn('[AlteoreFlow] action ignorée — roster équipe pas encore chargé');
      return Promise.resolve(null);
    }
    var leadId = typeof leadRefOrId === 'string' ? leadRefOrId : (leadRefOrId && leadRefOrId.id);
    if (!leadId || !action) return Promise.resolve(null);

    var _db = db();
    var leadRef = _db.collection('leads').doc(leadId);
    var actionRef = _db.collection('lead_actions').doc(m.slug).collection('items').doc();
    var now = new Date();

    return _db.runTransaction(function (tx) {
      return tx.get(leadRef).then(function (snap) {
        var l = snap.exists ? (snap.data() || {}) : {};
        var firstTouch = !l.firstActionAt;
        var byMap = l.firstActionAtBy || {};
        var firstTouchMember = !byMap[m.slug];

        tx.set(actionRef, {
          leadId: leadId,
          leadName: (leadData && leadData.nom) || l.nom || '',
          uid: m.uid,
          slug: m.slug,
          day: dayKey(now),
          month: monthKey(now),
          action: action,
          prevStatus: opts.prevStatus || (leadData && leadData.status) || null,
          origin: opts.origin || 'leads_live',
          bookingId: opts.bookingId || null,
          firstTouch: firstTouch,
          firstTouchMember: firstTouchMember,
          createdAt: ts()
        });

        if (snap.exists && (firstTouch || firstTouchMember)) {
          var patch = {};
          if (firstTouch) {
            patch.firstActionAt = ts();
            patch.firstActionBy = m.slug;
            patch.firstActionByUid = m.uid;
          }
          patch['firstActionAtBy.' + m.slug] = ts();
          tx.update(leadRef, patch);
        }
        return { firstTouch: firstTouch, firstTouchMember: firstTouchMember };
      });
    }).catch(function (e) {
      console.warn('[AlteoreFlow] recordLeadAction:', e && e.message);
      return null;
    });
  }

  /* ═══ 2. CHANGEMENT DE STATUT FICHE (Leads Live) ═══════════════════════
     Écrit status + stage synchronisé + updatedAt sur le lead, journalise
     l'action, trace la timeline. Retourne la promesse de l'update lead
     (l'action est fire-and-forget pour ne jamais bloquer l'UI). */
  var STATUS_TO_STAGE = {
    nouveau: 'lead', appele: 'lead', decroche: 'lead', messagerie: 'lead',
    nrp1: 'nrp1', nrp2: 'nrp2', nrp3: 'nrp3', all_nrp: 'all_nrp',
    faux_numero: 'faux_numero',
    follow_up_pm: 'follow_up_pm', set: 'set', rdv_self_booking: 'rdv_self_booking',
    rdv_pose: 'rdv_confirmes',
    pas_interesse: 'disqualification', disqualifie: 'disqualification',
    poubelle: 'poubelle', client: 'closed_won_setting'
  };

  function applyLeadStatus(leadId, leadData, newStatus, opts) {
    opts = opts || {};
    var _db = db();
    var prev = (leadData && leadData.status) || null;
    var updates = { status: newStatus, updatedAt: ts() };
    var syncStage = STATUS_TO_STAGE[newStatus];
    if (syncStage && newStatus !== 'client') updates.stage = syncStage;

    recordLeadAction(leadId, leadData, newStatus, { prevStatus: prev, origin: opts.origin || 'leads_live' });

    return _db.collection('leads').doc(leadId).update(updates).then(function () {
      return { stage: syncStage };
    });
  }

  /* Timeline fiche — même format que sales-contact.html ({text,date,color}).
     arrayUnion → pas de lecture préalable, pas d'écrasement concurrent. */
  function addLeadTimeline(leadId, text, color) {
    if (!leadId) return Promise.resolve();
    return db().collection('leads').doc(leadId).update({
      timeline_history: arrayUnion({ text: text, date: frDateTime(), color: color || 'var(--muted)' })
    }).catch(function (e) { console.warn('[AlteoreFlow] timeline:', e && e.message); });
  }

  /* ═══ 3. RÉSULTAT D'UN RDV (bookings.outcome) ══════════════════════════
     setOutcome(booking, outcome, opts) :
       booking  : {id, ...data} (doc bookings complet)
       outcome  : clé OUTCOMES
       opts     : { note, cancelledBy ('prospect'|'equipe'),
                    closeData {offre, subtype, contracte, collecte, paiement,
                               closerSlug, setterSlug},
                    typeMap, lead (doc lead si déjà chargé),
                    rescheduledToId, skipCommissions }
     Effets :
       1. patch booking (outcome + audit + status legacy + stamps)
       2. propagation fiche lead (stage/status/timeline/isClient)
       3. commissions auto si close
     Retourne Promise<{ok, deals}> */
  /* ⚠ LIAISON ENTRE LES PAGES (fix 26/07) — statuer un RDV doit donner
     EXACTEMENT le même résultat depuis Leads Live, Booking admin, Mes RDV
     ou la fiche CRM. Le maillon faible était le typeMap :
     booking-admin.html n'en a aucun, et une page peut en passer un vide
     ({} pendant le fetch). Sans lui, classifyBooking retombe sur le seul
     champ `source` — un RDV pris sur le lien SETTER dont le source est
     resté 'self_booking' (fiches d'avant le fix du bridge) était alors
     compté Self Booking. Résultat : commission de setting et split SB/NB
     DIFFÉRENTS selon la page depuis laquelle on statuait.
     On le charge donc ici quand il manque — même garde que applyFicheClose. */
  function setOutcome(booking, outcome, opts) {
    opts = opts || {};
    if (!booking || !booking.id || !OUTCOMES[outcome]) return Promise.reject(new Error('Outcome invalide'));
    /* closeData.sb explicite = réponse humaine des cartes du Close : elle
       prime sur toute classification, aucun typeMap n'est nécessaire. */
    var sbExplicit = !!(opts.closeData && typeof opts.closeData.sb === 'boolean');
    var hasMap = !!(opts.typeMap && Object.keys(opts.typeMap).length);
    if (sbExplicit || hasMap) return applyOutcome(booking, outcome, opts, opts.typeMap || {});
    return loadTypeMap().then(function (tm) { return applyOutcome(booking, outcome, opts, tm || {}); });
  }

  function applyOutcome(booking, outcome, opts, typeMap) {
    var o = OUTCOMES[outcome];
    var _db = db();
    var m = me() || { uid: null, name: null, slug: null };
    var now = new Date();
    /* SB/NB : la réponse EXPLICITE des cartes du Close (closeData.sb) prime
       sur la classification du RDV — ex. RDV self_booking mais prospect en
       réalité travaillé par le setting (fix revue 14/07). */
    var sb = (opts.closeData && typeof opts.closeData.sb === 'boolean')
      ? opts.closeData.sb
      : isSB(booking, typeMap);

    /* — 1. patch booking — */
    var legacy = OUTCOME_TO_BOOKING_STATUS[outcome];
    var patch = {
      outcome: outcome,
      outcomeAt: ts(),
      outcomeBy: m.uid,
      outcomeByName: m.name,
      outcomeNote: opts.note || null,
      /* Modifier un résultat SANS le changer (ex. corriger le close) garde
         le JOUR d'origine — les rapports par jour ne bougent pas. */
      outcomeDay: (booking.outcome === outcome && booking.outcomeDay) ? booking.outcomeDay : dayKey(now),
      outcomeHistory: arrayUnion({
        outcome: outcome, note: opts.note || null, at: now.toISOString(),
        by: m.uid, byName: m.name
      }),
      status: legacy,
      statusUpdatedAt: ts(),
      statusUpdatedBy: m.uid,
      statusUpdatedByName: m.name
    };
    if (legacy === 'cancelled') { patch.cancelledAt = ts(); patch.cancelledBy = m.uid; patch.cancelledByName = m.name; }
    if (legacy === 'no_show')   { patch.noShowAt = ts();    patch.noShowBy = m.uid;    patch.noShowByName = m.name; }
    if (legacy === 'completed') { patch.completedAt = ts(); }
    if (outcome === 'replanifie') {
      patch.rescheduled = true;
      if (opts.rescheduledToId) patch.rescheduledToId = opts.rescheduledToId;
    }
    if (outcome === 'annule' && opts.cancelledBy) patch.cancelledOrigin = opts.cancelledBy; // 'prospect' | 'equipe'
    if (outcome === 'close' && opts.closeData) {
      var cd = opts.closeData;
      patch.closeData = {
        offre: cd.offre || 'BP 12',
        subtype: cd.subtype === 'pif' ? 'pif' : 'mensualise',
        contracte: Number(cd.contracte) || 0,
        collecte: Number(cd.collecte) || 0,
        paiement: cd.paiement || null,
        closerSlug: cd.closerSlug || null,
        setterSlug: cd.setterSlug || null,
        sb: sb
      };
    }

    return _db.collection('bookings').doc(booking.id).update(patch).then(function () {
      /* — 2. propagation fiche — */
      var pLead = Promise.resolve();
      if (booking.leadId) pLead = propagateOutcomeToLead(booking, outcome, sb, opts, m, patch.closeData || null);
      /* — 3. commissions — */
      var pDeals = Promise.resolve([]);
      if (outcome === 'close' && patch.closeData && !opts.skipCommissions) {
        pDeals = createCommissionDeals(booking, patch.closeData, opts.lead || null);
      }
      return Promise.all([pLead, pDeals]).then(function (res) {
        return { ok: true, sb: sb, deals: res[1] || [] };
      });
    });
  }

  /* Propagation fiche selon l'outcome — stage (axe closing du pipeline)
     + status (axe setter Leads Live) + timeline + conversion client.
     Annulé / no-show ⇒ retour périmètre Setting (follow_up_pm, à récupérer)
     — règle validée : l'annulation SB alimente le taux de récupération. */
  function propagateOutcomeToLead(booking, outcome, sb, opts, m, cdNorm) {
    var _db = db();
    var leadId = booking.leadId;
    var prospect = booking.prospect || {};
    var name = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim();
    var when = (booking.date || '') + ' ' + (booking.time || '');
    var o = OUTCOMES[outcome];

    var stage = null, status = null, extra = {};
    switch (outcome) {
      case 'close':
        stage = sb ? 'closed_won_self' : 'closed_won_setting';
        status = 'client';
        extra.isClient = true;
        /* clientSince = date du PREMIER close — jamais réécrit quand on
           modifie/re-valide un close (le funnel compte par clientSince) :
           RDV déjà closé (✎ Modifier) ou fiche déjà cliente → on n'y touche pas. */
        if (booking.outcome !== 'close' && !(opts.lead && (opts.lead.isClient === true || opts.lead.clientSince))) extra.clientSince = ts();
        /* Copie du closeData sur la fiche : le funnel retrouve l'encaissé
           déclaré même quand le RDV closé est hors de la période chargée. */
        if (cdNorm) extra.closedData = cdNorm;
        break;
      case 'non_close':   stage = 'closed_lost';                                    status = 'pas_interesse'; break;
      case 'offre':       stage = 'follow_up_closing';                              status = null;            break;
      case 'disqualifie': stage = 'disqualifie_closing';                            status = 'disqualifie';   break;
      case 'no_show':     stage = sb ? 'no_show_self' : 'no_show_setting';          status = 'follow_up_pm';  break;
      case 'annule':      stage = (opts.cancelledBy === 'equipe') ? 'rdv_annules_equipe' : 'rdv_annules_prospect'; status = 'follow_up_pm'; break;
      case 'replanifie':  stage = null;                                             status = sb ? 'rdv_self_booking' : 'rdv_pose'; break;
    }

    var updates = { updatedAt: ts() };
    if (stage) updates.stage = stage;
    if (status) updates.status = status;
    Object.keys(extra).forEach(function (k) { updates[k] = extra[k]; });

    var tlColor = o.color;
    var tlText = o.icon + ' RDV ' + when + ' → ' + o.label + (sb ? ' (Self Booking)' : ' (Setting NB)') + (opts.note ? ' — ' + opts.note : '');
    updates.timeline_history = arrayUnion({ text: tlText, date: frDateTime(), color: tlColor });

    return _db.collection('leads').doc(leadId).update(updates).catch(function (e) {
      console.warn('[AlteoreFlow] propagation lead:', e && e.message, leadId, name);
    });
  }

  /* ═══ 4. COMMISSIONS AUTO ══════════════════════════════════════════════
     Un Close ⇒ jusqu'à 2 deals dans commissions/{slug}/mois/{YYYY-MM} :
       - Closing (closer)  : COMM_RULES.closing[offre][pif|mensualise] + prime PIF
       - Setting (setter)  : noBooking si RDV setter (NB), selfBooking si SB
     Idempotent par dealKey = {bookingId}_{closing|setting} : re-cliquer
     Close ne duplique jamais. ok:false → validé à l'encaissement. */
  function calcClosingComm(offre, subtype) {
    var r = COMM_RULES.closing[offre]; if (!r) return 0;
    return subtype === 'pif' ? r.pif : r.mensualise;
  }
  function calcClosingBonus(offre, subtype) { return subtype === 'pif' ? (PIF_BONUS[offre] || 0) : 0; }
  function calcSettingComm(offre, sb) {
    var r = COMM_RULES.setting[offre]; if (!r) return 0;
    return sb ? r.selfBooking : r.noBooking;
  }

  function appendDealIfAbsent(slug, mk, deal) {
    var _db = db();
    var ref = _db.collection('commissions').doc(slug).collection('mois').doc(mk);
    return _db.runTransaction(function (tx) {
      return tx.get(ref).then(function (snap) {
        var deals = (snap.exists && snap.data().deals) || [];
        var exists = deals.some(function (d) { return d && d.dealKey && d.dealKey === deal.dealKey; });
        if (exists) return { created: false, slug: slug, deal: deal };
        deals.push(deal);
        tx.set(ref, { deals: deals }, { merge: true });
        return { created: true, slug: slug, deal: deal };
      });
    }).catch(function (e) {
      /* Erreur REMONTÉE (rules csm, offline…) — jamais avalée : l'UI doit
         pouvoir prévenir que la commission n'a PAS été créée. */
      console.warn('[AlteoreFlow] commission non créée (' + slug + '):', e && e.message);
      return { created: false, slug: slug, deal: deal, error: (e && e.message) || 'Erreur inconnue' };
    });
  }

  function createCommissionDeals(booking, closeData, lead) {
    var prospect = booking.prospect || {};
    var clientName = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim() || (lead && lead.nom) || 'Client';
    var email = prospect.email || (lead && lead.email) || '';
    var sb = closeData.sb === true;
    /* Mois du deal = mois du PREMIER close : re-valider en août un close de
       juillet ne recrée pas les deals dans un doc d'août vierge (l'anti-
       doublon par dealKey ne regarde qu'un seul doc mensuel). */
    var mk = monthKey();
    var dateFr = frDate();
    if (booking.outcome === 'close' && booking.outcomeDay && /^\d{4}-\d{2}/.test(String(booking.outcomeDay))) {
      mk = String(booking.outcomeDay).slice(0, 7);
      var odp = String(booking.outcomeDay).split('-');
      dateFr = odp[2] + '/' + odp[1] + '/' + odp[0];
    }
    var jobs = [];

    if (closeData.closerSlug) {
      jobs.push(appendDealIfAbsent(closeData.closerSlug, mk, {
        client: clientName, email: email,
        offre: closeData.offre, type: 'Closing',
        subtype: closeData.subtype,
        date: dateFr,
        contracteHT: Number(closeData.contracte) || 0,
        collecteHT: Number(closeData.collecte) || 0,
        comm: calcClosingComm(closeData.offre, closeData.subtype),
        bonus: calcClosingBonus(closeData.offre, closeData.subtype),
        notes: 'AUTO — Close ' + (sb ? 'Self Booking' : 'Setting NB') + (closeData.paiement ? ' · ' + closeData.paiement : ''),
        ok: false,
        auto: true,
        bookingId: booking.id,
        leadId: booking.leadId || null,
        dealKey: booking.id + '_closing'
      }));
    }
    if (closeData.setterSlug) {
      jobs.push(appendDealIfAbsent(closeData.setterSlug, mk, {
        client: clientName, email: email,
        offre: closeData.offre, type: 'Setting',
        subtype: sb ? 'selfBooking' : 'noBooking',
        date: dateFr,
        contracteHT: 0, collecteHT: 0,
        comm: calcSettingComm(closeData.offre, sb),
        bonus: 0,
        notes: 'AUTO — Setting ' + (sb ? 'Self Booking' : 'No-Booking') + ' du close de ' + clientName,
        ok: false,
        auto: true,
        bookingId: booking.id,
        leadId: booking.leadId || null,
        dealKey: booking.id + '_setting'
      }));
    }
    return Promise.all(jobs); // chaque job catch ses erreurs et les remonte ({error})
  }

  /* ═══ 4bis. CLOSE DEPUIS LA FICHE / LEADS LIVE (cartes du Close) ════════
     Résolution automatique closer/setter pour les commissions — plus aucun
     sélecteur à remplir : closer = membre sales connecté (sinon le seul
     closer actif) · setter = poseur du RDV, sinon gestionnaire de la fiche,
     sinon le seul setter actif. Jamais un membre hors équipe sales. */
  function resolveClosingActors(lead, booking) {
    var team = salesMembers();
    var m = me();
    var closer = null;
    if (m && m.resolved && isSalesMember(m.slug) && (m.role === 'closer' || m.role === 'closer_setter')) closer = m.slug;
    if (!closer) {
      var closers = team.filter(function (x) { return x.role === 'closer' || x.role === 'closer_setter'; });
      if (closers.length === 1) closer = closers[0].slug;
      else if (m && m.resolved && isSalesMember(m.slug)) closer = m.slug;
    }
    var setter = null;
    if (booking && booking.bookedBySlug && isSalesMember(booking.bookedBySlug)) setter = booking.bookedBySlug;
    if (!setter && lead && lead.assignedTo && isSalesMember(lead.assignedTo)) setter = lead.assignedTo;
    if (!setter) {
      var setters = team.filter(function (x) { return x.role === 'setter' || x.role === 'closer_setter'; });
      if (setters.length === 1) setter = setters[0].slug;
    }
    return { closerSlug: closer, setterSlug: setter };
  }

  /* Close validé par les cartes SANS passer par un RDV : on cherche d'abord
     un RDV sales du lead encore SANS résultat (le close « appartient » à ce
     RDV → rapports Close SB / Set NB exacts) ; si tous les RDV sont déjà
     statués — ou s'il n'y en a aucun — on ferme la fiche en direct et les
     commissions prennent un dealKey lead_<id> (idempotent : re-valider les
     cartes sur le même lead ne duplique rien). On n'écrase JAMAIS un
     résultat de RDV déjà saisi. */
  function applyFicheClose(leadId, lead, closeData, opts) {
    opts = opts || {};
    var _db = db();
    /* Un typeMap vide ({} posé en attendant le fetch) ne compte pas : on
       recharge — sinon un RDV coaching détectable par son type, ou un type
       setter-only, serait mal classé (fix revue 14/07). */
    var pTypeMap = (opts.typeMap && Object.keys(opts.typeMap).length)
      ? Promise.resolve(opts.typeMap) : loadTypeMap();
    var pBookings = opts.bookings ? Promise.resolve(opts.bookings)
      : _db.collection('bookings').where('leadId', '==', leadId).get()
          .then(function (snap) {
            var out = [];
            snap.forEach(function (doc) { var d = doc.data(); d.id = doc.id; out.push(d); });
            return out;
          }).catch(function () { return []; });

    return Promise.all([pTypeMap, pBookings]).then(function (res) {
      var typeMap = res[0] || {}, bookings = res[1] || [];
      /* Re-close d'une fiche DÉJÀ cliente (pastille restée cliquable, correction
         des cartes…) : on met à jour le close SANS dupliquer les commissions ni
         réécrire clientSince — promesse du récap « aucune commission dupliquée ». */
      var alreadyClient = !!(lead && (lead.isClient === true || lead.clientSince ||
        lead.stage === 'closed_won_self' || lead.stage === 'closed_won_setting'));
      var cands = bookings.filter(function (b) {
        return classifyBooking(b, typeMap) !== 'excluded' && classifyBooking(b, typeMap) !== 'admin'
          && !b.outcome && b.status !== 'cancelled' && b.status !== 'no_show';
      });
      cands.sort(function (a, b2) {
        var ka = (a.date || '') + 'T' + (a.time || ''), kb = (b2.date || '') + 'T' + (b2.time || '');
        return ka < kb ? 1 : (ka > kb ? -1 : 0); // plus récent d'abord
      });
      if (cands.length) {
        /* Le RDV porte le close — pipeline complet (patch RDV + fiche + commissions).
           Si la fiche était déjà cliente, les commissions du close initial existent :
           on ne les recrée pas. */
        return setOutcome(cands[0], 'close', { closeData: closeData, lead: lead, typeMap: typeMap, note: opts.note, skipCommissions: alreadyClient || opts.skipCommissions })
          .then(function (r) { r.viaBookingId = cands[0].id; return r; });
      }
      /* — Close direct sur la fiche — */
      var m = me() || { uid: null, name: null };
      var sb = closeData.sb === true;
      var cd = {
        offre: closeData.offre || 'BP 12',
        subtype: closeData.subtype === 'pif' ? 'pif' : 'mensualise',
        contracte: Number(closeData.contracte) || 0,
        collecte: Number(closeData.collecte) || 0,
        paiement: closeData.paiement || null,
        closerSlug: closeData.closerSlug || null,
        setterSlug: closeData.setterSlug || null,
        sb: sb
      };
      var updates = {
        stage: sb ? 'closed_won_self' : 'closed_won_setting',
        status: 'client',
        isClient: true,
        closedData: cd,           // trace du close fiche (offre/encaissé déclaré)
        closedBy: m.uid, closedByName: m.name,
        updatedAt: ts(),
        timeline_history: arrayUnion({
          text: (alreadyClient ? '✎ Close mis à jour ' : '🏆 Close ') + (sb ? '(Self Booking)' : '(Setting NB)') + ' — ' + cd.offre + ' · '
            + (cd.subtype === 'pif' ? 'PIF' : 'Mensualisé') + ' · encaissé ' + cd.collecte + ' € HT',
          date: frDateTime(), color: '#10b981'
        })
      };
      if (!alreadyClient) updates.clientSince = ts();
      return _db.collection('leads').doc(leadId).update(updates).then(function () {
        var pseudo = { id: 'lead_' + leadId, prospect: {}, leadId: leadId };
        if (opts.skipCommissions || alreadyClient) return { ok: true, sb: sb, deals: [], direct: true, updated: alreadyClient };
        return createCommissionDeals(pseudo, cd, lead || null).then(function (deals) {
          return { ok: true, sb: sb, deals: deals || [], direct: true };
        });
      });
    });
  }

  /* ═══ Overrides rapports journaliers ═══════════════════════════════════
     rapport_overrides/{slug}/jours/{YYYY-MM-DD} :
       { day, setting:{champ:val}, closing:{champ:val}, note, updatedAt/By } */
  function saveDayOverride(slug, day, scope, values, note) {
    var m = me() || {};
    var patch = { day: day, updatedAt: ts(), updatedBy: m.uid || null, updatedByName: m.name || null };
    patch[scope] = values || {};
    var fields = ['day', 'updatedAt', 'updatedBy', 'updatedByName', scope];
    if (note !== undefined) { patch.note = note || null; fields.push('note'); }
    /* mergeFields : remplace le scope (setting|closing) EN ENTIER — vider un
       champ retire réellement sa correction — sans toucher l'autre scope. */
    return db().collection('rapport_overrides').doc(slug).collection('jours').doc(day)
      .set(patch, { mergeFields: fields });
  }
  function loadOverrides(slug, fromDay, toDay) {
    return db().collection('rapport_overrides').doc(slug).collection('jours')
      .where('day', '>=', fromDay).where('day', '<=', toDay).get()
      .then(function (snap) {
        var out = {};
        snap.forEach(function (doc) { out[doc.id] = doc.data(); });
        return out;
      }).catch(function (e) { console.warn('[AlteoreFlow] overrides:', e && e.message); return {}; });
  }

  /* ═══ Loaders communs des rapports ═════════════════════════════════════ */
  function loadTypeMap() {
    return db().collection('booking_config').doc('_types').get().then(function (snap) {
      var map = {};
      ((snap.exists && snap.data().list) || []).forEach(function (t) {
        if (t && t.id) map[t.id] = { isSetterOnly: t.isSetterOnly === true, isCoaching: t.isCoaching === true, label: t.label || t.id };
      });
      return map;
    }).catch(function () { return {}; });
  }

  /* Actions d'un membre sur une plage de jours (bornes incluses). */
  function loadActions(slug, fromDay, toDay) {
    return db().collection('lead_actions').doc(slug).collection('items')
      .where('day', '>=', fromDay).where('day', '<=', toDay).get()
      .then(function (snap) {
        var out = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; out.push(d); });
        return out;
      }).catch(function (e) { console.warn('[AlteoreFlow] actions:', e && e.message); return []; });
  }

  /* Appels d'un membre sur une plage — même stratégie que le dashboard :
     admin = requête par plage (single-field) filtrée par uid côté client,
     sales = requête par userId filtrée par dates côté client. */
  function loadCallsForMember(fUid, from, to, isAdminRole) {
    var _db = db();
    function post(snap) {
      var out = [];
      snap.forEach(function (doc) {
        var d = doc.data();
        var ms = d.initiatedAt && d.initiatedAt.toMillis ? d.initiatedAt.toMillis() : null;
        if (ms == null || ms < from.getTime() || ms > to.getTime()) return;
        if (fUid && d.userId !== fUid) return;
        out.push(d);
      });
      return out;
    }
    if (isAdminRole) {
      return _db.collection('call_logs')
        .where('initiatedAt', '>=', firebase.firestore.Timestamp.fromDate(from))
        .where('initiatedAt', '<=', firebase.firestore.Timestamp.fromDate(to))
        .limit(5000).get().then(post)
        .catch(function (e) { console.warn('[AlteoreFlow] calls:', e && e.message); return []; });
    }
    return _db.collection('call_logs').where('userId', '==', fUid).limit(5000).get().then(post)
      .catch(function (e) { console.warn('[AlteoreFlow] calls:', e && e.message); return []; });
  }

  /* Bookings dont le RDV (date) OU la création tombe dans la plage. */
  function loadBookingsRange(fromDay, toDay, fromDate, toDate) {
    var _db = db();
    var byId = {};
    var qA = _db.collection('bookings').where('date', '>=', fromDay).where('date', '<=', toDay).get();
    var qB = _db.collection('bookings')
      .where('createdAt', '>=', firebase.firestore.Timestamp.fromDate(fromDate))
      .where('createdAt', '<=', firebase.firestore.Timestamp.fromDate(toDate)).get();
    return Promise.all([qA, qB]).then(function (res) {
      res.forEach(function (snap, idx) {
        snap.forEach(function (doc) {
          var d = byId[doc.id];
          if (!d) { d = doc.data(); d.id = doc.id; d._inDue = false; d._inCreated = false; byId[doc.id] = d; }
          if (idx === 0) d._inDue = true; else d._inCreated = true;
        });
      });
      return Object.keys(byId).map(function (k) { return byId[k]; });
    }).catch(function (e) { console.warn('[AlteoreFlow] bookings:', e && e.message); return []; });
  }

  /* Map personId (booking_config) → { firebaseUid, name } pour rattacher
     les RDV aux membres (closer). */
  function loadPersonsMap() {
    return db().collection('booking_config').get().then(function (snap) {
      var map = {};
      snap.forEach(function (doc) {
        var d = doc.data();
        if (d && d.__type === 'person') map[doc.id] = { firebaseUid: d.firebaseUid || null, name: d.name || doc.id };
      });
      return map;
    }).catch(function () { return {}; });
  }

  function fmtDuration(sec) {
    sec = Math.round(Number(sec) || 0);
    if (sec <= 0) return '0min';
    var h = Math.floor(sec / 3600), min = Math.round((sec % 3600) / 60);
    if (h <= 0) return min + 'min';
    return h + 'h' + (min > 0 ? pad2(min) : '');
  }

  /* ═══ Export ═══════════════════════════════════════════════════════════ */
  window.AlteoreFlow = {
    OUTCOMES: OUTCOMES,
    OUTCOME_ORDER: OUTCOME_ORDER,
    OFFRES: OFFRES,
    PAIEMENTS: PAIEMENTS,
    COMM_RULES: COMM_RULES,
    PIF_BONUS: PIF_BONUS,
    SET_ACTIONS: SET_ACTIONS,
    ANSWERED_MIN_SEC: ANSWERED_MIN_SEC,
    STATUS_TO_STAGE: STATUS_TO_STAGE,

    me: me,
    memberBySlug: memberBySlug,
    memberByFirebaseUid: memberByFirebaseUid,
    salesMembers: salesMembers,
    isSalesMember: isSalesMember,
    DEPARTED: DEPARTED,
    dayKey: dayKey,
    monthKey: monthKey,
    frDate: frDate,
    frDateTime: frDateTime,
    fmtDuration: fmtDuration,

    classifyBooking: classifyBooking,
    isSB: isSB,
    isPresent: isPresent,
    isPitched: isPitched,
    isAnswered: isAnswered,

    recordLeadAction: recordLeadAction,
    applyLeadStatus: applyLeadStatus,
    addLeadTimeline: addLeadTimeline,
    setOutcome: setOutcome,
    WIZARD_PRICING: WIZARD_PRICING,
    resolveClosingActors: resolveClosingActors,
    applyFicheClose: applyFicheClose,
    createCommissionDeals: createCommissionDeals,
    calcClosingComm: calcClosingComm,
    calcClosingBonus: calcClosingBonus,
    calcSettingComm: calcSettingComm,

    saveDayOverride: saveDayOverride,
    loadOverrides: loadOverrides,
    loadTypeMap: loadTypeMap,
    loadActions: loadActions,
    loadCallsForMember: loadCallsForMember,
    loadBookingsRange: loadBookingsRange,
    loadPersonsMap: loadPersonsMap
  };
})();
