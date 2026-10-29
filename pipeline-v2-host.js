/* ═══════════════════════════════════════════════════════════════════════════
   pipeline-v2-host.js — Hôte Firebase du nouveau Pipeline (29/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Branche pipeline-v2.js sur l'API Firebase compat (v9) : mêmes collections,
   mêmes champs que Leads Live. Le MÊME code sert :
     - au Labo Pipeline, sur la fausse base partagée avec le Labo Leads Live
       (sandbox-leads-live-db.js) : une carte déplacée ici apparaît au bon
       endroit dans Leads Live, et inversement ;
     - plus tard au vrai Pipeline, sur Firestore.

   Interconnexion : le Pipeline écrit l'étape `stage` (source de vérité,
   lue par la liste déroulante de Leads Live) ET le statut Leads Live
   correspondant (PipelineEtapes.STATUS_OF) pour le Funnel et les rapports.
   Les résultats de RDV passent par AlteoreFlow.setOutcome quand il est
   chargé (même chemin que la modale de résultat), sinon par une écriture
   équivalente.

   PipelineV2Host.create(o) → hôte attendu par PipelineV2.start
     o.db            firebase.firestore()
     o.FV            firebase.firestore.FieldValue
     o.me            { slug, name, role, uid }
     o.team          [{ slug, name, color, pipeline }]
     o.leadsQuery    requête des leads (ex. orderBy createdAt desc, limit)
     o.bookingsQuery requête des RDV
     o.leadsLiveUrl  page Leads Live ('sales-leads.html' ou le Labo)
     o.logCalls      true : un appel noté à la main crée une communication
                     (Labo). false : les appels réels viennent de Ringover.
     o.ui            { call, listen, openClose, openBooking, callDetail,
                       generateAi, sendMessage, toast } (facultatifs)
     o.onReady(host) appelé au premier chargement complet
   ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  function p2(n) { return (n < 10 ? '0' : '') + n; }
  /* Heure de Paris, quel que soit le fuseau de l'appareil (règle du 20/10/2026) */
  function frNowParis() {
    try {
      var parts = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
      var g = function (t) { for (var i = 0; i < parts.length; i++) if (parts[i].type === t) return parts[i].value; return ''; };
      return g('day') + '/' + g('month') + '/' + g('year') + ' ' + g('hour') + ':' + g('minute');
    } catch (e) {
      var d = new Date();
      return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
    }
  }
  function e164(t) {
    var s = String(t || '').replace(/[^\d+]/g, '');
    if (!s) return '';
    if (s.charAt(0) === '+') return s;
    if (s.indexOf('33') === 0 && s.length === 11) return '+' + s;
    if (s.charAt(0) === '0' && s.length === 10) return '+33' + s.slice(1);
    return s;
  }

  function create(o) {
    var E = window.PipelineEtapes, db = o.db, FV = o.FV, ui = o.ui || {};
    var LEADS = [], BOOK = {}, gotL = false, gotB = false, ready = false;
    var me = o.me;

    function ok(cb) { return function () { if (cb) cb(null); }; }
    function ko(cb) { return function (e) { if (cb) cb(e || new Error('Écriture impossible')); }; }
    function ref(l) { return db.collection('leads').doc(l.id); }
    function tl(text, color) { return FV.arrayUnion({ text: text, date: frNowParis(), color: color || '#5b7cfa' }); }
    function lab(st) { return E.STAGE_LABEL[st] || st; }
    function nomDe(slug) {
      for (var i = 0; i < o.team.length; i++) if (o.team[i].slug === slug) return o.team[i].name;
      return slug === me.slug ? me.name : (slug || 'personne');
    }
    /* Journal d'actions setting : même compteur que les clics de statut de Leads Live */
    function journal(l, action) {
      var AF = window.AlteoreFlow;
      if (!AF || !AF.recordLeadAction || !action) return;
      try { AF.recordLeadAction(l.id, l, action, { prevStatus: l.status || null, origin: 'pipeline' }); } catch (e) {}
    }
    function changed() { if (ready && window.PipelineV2) window.PipelineV2.refresh(); }
    function maybeReady() {
      if (ready || !gotL || !gotB) return;
      ready = true;
      if (o.onReady) o.onReady(host);
    }

    o.leadsQuery.onSnapshot(function (snap) {
      var a = [];
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        if (d._merged === true || d.source === 'migration_suivi_client') return;
        d.id = doc.id; d._v = 0;
        a.push(d);
      });
      LEADS = a; gotL = true; maybeReady(); changed();
    }, function (e) { if (window.console) console.warn('[pipeline] leads', e && e.message); gotL = true; maybeReady(); });

    o.bookingsQuery.onSnapshot(function (snap) {
      var m = {}, AF = window.AlteoreFlow;
      snap.forEach(function (doc) {
        var b = doc.data() || {};
        b.id = doc.id;
        if (!b.leadId) return;
        if (AF && AF.classifyBooking && AF.classifyBooking(b, {}) === 'excluded') return; /* coaching / CSM */
        (m[b.leadId] = m[b.leadId] || []).push(b);
      });
      BOOK = m; gotB = true; maybeReady(); changed();
    }, function (e) { if (window.console) console.warn('[pipeline] bookings', e && e.message); gotB = true; maybeReady(); });

    var host = {
      me: me, team: o.team,
      leads: function () { return LEADS; },
      bookings: function () { return BOOK; },
      pref: function (k, v) {
        try { if (arguments.length > 1) window.localStorage.setItem('pv2:' + k, v); else return window.localStorage.getItem('pv2:' + k); } catch (e) { return null; }
      },

      setStage: function (l, stage, cb) {
        var old = l.stage || 'lead', st = E.STATUS_OF[stage], up = { stage: stage, updatedAt: FV.serverTimestamp(), timeline_history: tl('Étape : ' + lab(old) + ' → ' + lab(stage) + ' (' + me.name + ', Pipeline)') };
        if (st) up.status = st;
        if (st) journal(l, st);
        ref(l).update(up).then(ok(cb), ko(cb));
      },
      addNote: function (l, text, cb) {
        ref(l).update({ notesHistory: FV.arrayUnion({ text: text, date: frNowParis(), authorName: me.name, authorSlug: me.slug, authorUid: me.uid || null }), updatedAt: FV.serverTimestamp() }).then(ok(cb), ko(cb));
      },
      logCall: function (l, r, cb) {
        var up = { lastContactAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() };
        if (o.logCalls) {
          var c = { type: 'call', direction: 'outbound', duration: r.answered ? (r.duration || 120) : 0, answered: !!r.answered, date: new Date().toISOString(), ownerName: me.name, source: 'pipeline' };
          if (!r.answered) c.result = r.result || 'pas de réponse';
          up.communications = FV.arrayUnion(c);
        }
        if (r.answered) journal(l, 'decroche');
        ref(l).update(up).then(ok(cb), ko(cb));
      },
      sendMessage: function (l, ch, text, cb) {
        if (ui.sendMessage) { ui.sendMessage(l, ch, text, cb); return; }
        var c = { type: ch, direction: 'outbound', content: text, date: new Date().toISOString(), ownerName: me.name, source: 'pipeline' };
        if (ch === 'email') c.subject = 'Suite à notre échange';
        ref(l).update({ communications: FV.arrayUnion(c), lastContactAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp() }).then(ok(cb), ko(cb));
      },
      /* Même règle que Leads Live (mode étapes) : un Lead / NRP qu'on doit rappeler passe en FU */
      addFollowUp: function (l, fu, cb) {
        var obj = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), dateTime: fu.dateTime, note: fu.note || '', duration: 30, done: false, createdBy: me.name, createdAt: new Date().toISOString() };
        var up = { followUps: (l.followUps || []).concat([obj]), updatedAt: FV.serverTimestamp() };
        var cur = l.stage || 'lead';
        if (cur === 'lead' || cur === 'nrp1' || cur === 'nrp2' || cur === 'nrp3' || cur === 'all_nrp') {
          up.stage = 'follow_up_pm'; up.status = 'follow_up_pm';
          up.timeline_history = tl('Étape : ' + lab(cur) + ' → FU (rappel programmé, ' + me.name + ')');
          journal(l, 'follow_up_pm');
        }
        ref(l).update(up).then(ok(cb), ko(cb));
      },
      update: function (l, f, v, cb) { var up = { updatedAt: FV.serverTimestamp() }; up[f] = v; ref(l).update(up).then(ok(cb), ko(cb)); },
      setAssigned: function (l, slug, cb) {
        var avant = l.assignedTo || '';
        ref(l).update({
          assignedTo: slug || '', assignedAt: FV.serverTimestamp(), assignedVia: 'pipeline', updatedAt: FV.serverTimestamp(),
          timeline_history: tl((slug === me.slug ? 'Repris par ' + me.name : 'Attribué à ' + nomDe(slug) + ' par ' + me.name) + ' (suivi avant par ' + nomDe(avant) + ')', '#a78bfa')
        }).then(ok(cb), ko(cb));
      },
      addTag: function (l, t, cb) { ref(l).update({ tags: FV.arrayUnion(t), updatedAt: FV.serverTimestamp() }).then(ok(cb), ko(cb)); },
      bump: function (l, cb) {
        ref(l).update({ lastOptinAt: FV.serverTimestamp(), lastOptinSource: 'Remonté à la main par ' + me.name, updatedAt: FV.serverTimestamp(), timeline_history: tl('Remonté dans Leads Live (' + me.name + ')') }).then(ok(cb), ko(cb));
      },
      generateAi: function (l, cb) { if (ui.generateAi) ui.generateAi(l, cb); else if (cb) cb(new Error('Résumé IA indisponible ici')); },
      createLead: function (x, cb) {
        var tel = e164(x.telephone);
        db.collection('leads').add({
          nom: x.nom, telephone: tel, phoneNormalized: tel.replace(/\D/g, '').slice(-9), email: x.email || '', type: '', source: 'manual',
          stage: 'lead', status: 'nouveau', assignedTo: me.slug, notesHistory: [], communications: [], followUps: [], tags: [],
          timeline_history: [{ text: 'Fiche créée depuis le Pipeline par ' + me.name, date: frNowParis(), color: '#34d399' }],
          createdAt: FV.serverTimestamp(), updatedAt: FV.serverTimestamp()
        }).then(ok(cb), ko(cb));
      },
      callDetail: function (l, c, cb) { if (ui.callDetail) ui.callDetail(l, c, cb); else cb(new Error('Conversation indisponible')); },
      objectionsOf: function (b) { return b._objections || b.objections || []; },

      /* Résultat d'un RDV (dernière colonne). AlteoreFlow pose le bloc
         cancellation, le statut du RDV, l'étape et la timeline du lead. */
      setOutcome: function (l, b, outcome, x, cb) {
        x = x || {};
        var AF = window.AlteoreFlow;
        if (AF && AF.setOutcome) {
          AF.setOutcome(b, outcome, { note: x.note || '', cancelledBy: x.origin || null, cancelKind: x.kind || null, via: 'pipeline', lead: l }).then(ok(cb), ko(cb));
          return;
        }
        var sb = E.sbOf(b), stage = { annule: x.origin === 'equipe' ? 'rdv_annules_equipe' : 'rdv_annules_prospect', no_show: sb ? 'no_show_self' : 'no_show_setting', offre: 'follow_up_closing', non_close: 'closed_lost' }[outcome];
        var bp = { outcome: outcome, outcomeAt: FV.serverTimestamp(), outcomeBy: me.uid || null, outcomeByName: me.name, outcomeNote: x.note || null, updatedAt: FV.serverTimestamp() };
        if (outcome === 'annule') {
          bp.status = 'cancelled'; bp.cancelledOrigin = x.origin || null;
          bp.cancellation = { origin: x.origin || null, by: me.uid || null, byName: me.name, byRole: me.role || null, via: 'pipeline', reason: x.note || null, at: new Date().toISOString() };
          if (x.kind === 'non_honore' && x.origin === 'equipe') bp.cancellation.kind = 'non_honore';
        } else if (outcome === 'no_show') bp.status = 'no_show';
        else bp.status = 'completed';
        db.collection('bookings').doc(b.id).update(bp).then(function () {
          host.setStage(l, stage, cb);
        }, ko(cb));
      },

      openLeadsLive: function (l) {
        var url = (o.leadsLiveUrl || 'sales-leads.html') + '?leadId=' + encodeURIComponent(l.id);
        var w = null;
        try { w = window.open(url, '_blank'); } catch (e) { w = null; }
        if (!w) window.location.href = url;
      },
      call: function (l) { if (ui.call) ui.call(l); },
      listen: function (l, c) { if (ui.listen) ui.listen(l, c); },
      openClose: function (l) { if (ui.openClose) ui.openClose(l); },
      openBooking: function (l) { if (ui.openBooking) ui.openBooking(l); }
    };
    return host;
  }

  window.PipelineV2Host = { create: create, frNowParis: frNowParis };
})();
