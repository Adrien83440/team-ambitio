/* ═══════════════════════════════════════════════════════════════════════════
   pipeline-etapes.js — UNE seule règle de classement (29/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Partagé par le Pipeline (pipeline-v2.js) et Leads Live (leads-live-
   etapes.js) : un lead est TOUJOURS dans la même colonne / le même filtre
   des deux côtés, parce que c'est la même fonction qui décide.

   Source de vérité : l'étape `stage` du lead + ses RDV (`bookings`).
   Le champ `status` de Leads Live n'est plus lu pour classer ; il reste écrit
   en parallèle (STATUS_OF) pour le Funnel et les rapports historiques.

   Colonnes, dans l'ordre (demande d'Adrien du 29/10/2026) :
     Lead · NRP 1 · NRP 2 · NRP 3 · All NRP · Faux numéro / Poubelle ·
     Disqualification · FU · SET NB · Self booking ·
     No show / Annulé / Closed Lost · Closing
   Une colonne peut avoir des sous-filtres (« Annulé prospect · SB »…).
   Lead = AUCUNE action (30/10/2026) : une fiche restée à l'étape « lead »
   en base mais déjà travaillée est rangée d'après ses traces (rappel
   programmé ou décroché → FU ; appels sans réponse → NRP n ; voir traces()).
   Clé de filtre : 'colonne' ou 'colonne:sous-filtre'.

   NB / SB des annulations et Closed Lost : déduit du RDV concerné (qui l'a
   pris), jamais d'un nouveau statut. « Non honoré équipe » : RDV annulé côté
   équipe avec le marqueur `cancellation.kind === 'non_honore'`.

   API : window.PipelineEtapes
     COLS · STAGE_LABEL · STATUS_OF · NEXT_NRP
     classify(lead, bookings[, opts]) → { col, sub, key, stage, booking, sb, upcoming, lastPast }
     match(lead, bookings, cle[, opts]) · count(leads, bookingsOf[, opts]) → { cle: n }
     label(cle) · colOf(id) · options() · sbOf(booking[, opts])
     bookingStart(b) · isCancelled(b)
   opts.typeMap : carte des types de RDV (AlteoreFlow.classifyBooking).
   ES5 strict, aucune dépendance (AlteoreFlow utilisé s'il est chargé).
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var STAGE_LABEL = {
    lead: 'Lead', nrp1: 'NRP 1', nrp2: 'NRP 2', nrp3: 'NRP 3', all_nrp: 'All NRP',
    faux_numero: 'Faux numéro', poubelle: 'Poubelle',
    disqualification: 'Disqualifié (setting)', disqualifie_closing: 'Disqualifié (closing)',
    follow_up_pm: 'FU', follow_up_closing: 'FU closing',
    set: 'SET', rdv_confirmes: 'RDV confirmé', partenariats: 'Partenariats', rdv_self_booking: 'Self booking',
    rdv_annules_prospect: 'RDV annulé (prospect)', rdv_annules_equipe: 'RDV annulé (équipe)',
    no_show_self: 'No show SB', no_show_setting: 'No show NB', closed_lost: 'Closed Lost',
    closed_won_setting: 'Closing NB', closed_won_self: 'Closing SB'
  };

  /* Statut Leads Live écrit EN PLUS de l'étape (compatibilité Funnel /
     rapports). null = on ne touche pas au statut. Mêmes valeurs que
     AlteoreFlow.propagateOutcomeToLead pour les résultats de RDV. */
  var STATUS_OF = {
    lead: 'nouveau', nrp1: 'nrp1', nrp2: 'nrp2', nrp3: 'nrp3', all_nrp: 'all_nrp',
    faux_numero: 'faux_numero', poubelle: 'poubelle',
    disqualification: 'disqualifie', disqualifie_closing: 'disqualifie',
    follow_up_pm: 'follow_up_pm', follow_up_closing: null,
    set: 'set', rdv_confirmes: 'rdv_pose', partenariats: 'rdv_pose', rdv_self_booking: 'rdv_self_booking',
    rdv_annules_prospect: 'follow_up_pm', rdv_annules_equipe: 'follow_up_pm',
    no_show_self: 'follow_up_pm', no_show_setting: 'follow_up_pm', closed_lost: 'pas_interesse',
    closed_won_setting: 'client', closed_won_self: 'client'
  };

  /* Un appel sans réponse (ou une messagerie) fait passer au NRP suivant */
  var NEXT_NRP = { lead: 'nrp1', nrp1: 'nrp2', nrp2: 'nrp3', nrp3: 'all_nrp', all_nrp: 'all_nrp' };

  var COLS = [
    { id: 'lead',     t: 'Lead',                  s: 'Arrivés depuis moins de 6 mois, aucune action', st: ['lead'] },
    /* Anciens leads (30/10/2026) : étape « lead », AUCUNE action, arrivés il y a
       plus de 6 mois (imports webinaires / Bigin…). Colonne déduite, aucune
       étape propre en base : on les traite quand on veut, on n'y range rien. */
    { id: 'ancien',   t: 'Anciens leads',         s: 'Plus de 6 mois, jamais traités', st: [], fold: true,
      subs: [{ id: 'webinaire', t: 'Webinaire' }, { id: 'vsl', t: 'VSL Élite' }, { id: 'rdv', t: 'Prise de RDV' }, { id: 'autre', t: 'Autre origine' }] },
    { id: 'nrp1',     t: 'NRP 1',                 s: '', st: ['nrp1'] },
    { id: 'nrp2',     t: 'NRP 2',                 s: '', st: ['nrp2'] },
    { id: 'nrp3',     t: 'NRP 3',                 s: '', st: ['nrp3'] },
    { id: 'all_nrp',  t: 'All NRP',               s: '', st: ['all_nrp'] },
    { id: 'poubelle', t: 'Faux numéro / Poubelle', s: '', st: ['faux_numero', 'poubelle'], fold: true,
      subs: [{ id: 'faux_numero', t: 'Faux numéro' }, { id: 'poubelle', t: 'Poubelle' }] },
    { id: 'disqua',   t: 'Disqualification',      s: '', st: ['disqualification', 'disqualifie_closing'], fold: true,
      subs: [{ id: 'setting', t: 'Au setting' }, { id: 'closing', t: 'Au closing' }] },
    { id: 'fu',       t: 'FU',                    s: 'Follow up : rappel convenu', st: ['follow_up_pm'] },
    { id: 'set',      t: 'SET NB',                s: 'RDV posé par l\'équipe', st: ['set', 'rdv_confirmes', 'partenariats'],
      subs: [{ id: 'a_confirmer', t: 'Présence à confirmer' }, { id: 'confirme', t: 'Présence confirmée' }, { id: 'nonsaisi', t: 'Résultat à saisir' }, { id: 'sans_rdv', t: 'Sans RDV retrouvé' }] },
    { id: 'sb',       t: 'Self booking',          s: 'RDV pris par le prospect', st: ['rdv_self_booking'],
      subs: [{ id: 'a_confirmer', t: 'Présence à confirmer' }, { id: 'confirme', t: 'Présence confirmée' }, { id: 'nonsaisi', t: 'Résultat à saisir' }, { id: 'sans_rdv', t: 'Sans RDV retrouvé' }] },
    { id: 'perdu',    t: 'No show / Annulé / Closed Lost', s: 'RDV passé sans signature', st: ['rdv_annules_prospect', 'rdv_annules_equipe', 'no_show_setting', 'no_show_self', 'follow_up_closing', 'closed_lost'],
      subs: [
        { id: 'annule_prospect_nb', t: 'Annulé prospect · NB' }, { id: 'annule_prospect_sb', t: 'Annulé prospect · SB' },
        { id: 'annule_equipe_nb', t: 'Annulé équipe · NB' }, { id: 'annule_equipe_sb', t: 'Annulé équipe · SB' },
        { id: 'non_honore', t: 'Non honoré équipe' },
        { id: 'no_show_nb', t: 'No show · NB' }, { id: 'no_show_sb', t: 'No show · SB' },
        { id: 'fu_closing', t: 'FU closing' },
        { id: 'closed_lost_nb', t: 'Closed Lost · NB' }, { id: 'closed_lost_sb', t: 'Closed Lost · SB' }
      ] },
    { id: 'closing',  t: 'Closing',               s: 'Signés', st: ['closed_won_setting', 'closed_won_self'], fold: true,
      subs: [{ id: 'nb', t: 'Closing NB' }, { id: 'sb', t: 'Closing SB' }] }
  ];
  var COL = {};
  COLS.forEach(function (c) { COL[c.id] = c; });

  /* ── RDV ── */
  function bookingStart(b) {
    if (!b || !b.date) return null;
    var p = String(b.date).split('-'), h = String(b.time || '12:00').split(':');
    var t = new Date(+p[0], +p[1] - 1, +p[2], +h[0] || 0, +h[1] || 0).getTime();
    return isNaN(t) ? null : t;
  }
  function isCancelled(b) { return !!b && (b.status === 'cancelled' || b.outcome === 'annule'); }
  function isNoShow(b) { return !!b && (b.outcome === 'no_show' || b.status === 'no_show'); }
  /* SB = pris par le prospect ; NB = posé par l'équipe. Même règle
     qu'AlteoreFlow.classifyBooking, la réponse explicite du close prime. */
  function sbOf(b, opts) {
    if (!b) return null;
    if (b.closeData && typeof b.closeData.sb === 'boolean') return b.closeData.sb;
    var AF = window.AlteoreFlow;
    if (AF && typeof AF.classifyBooking === 'function') return AF.classifyBooking(b, (opts && opts.typeMap) || {}) === 'self';
    var t = ((opts && opts.typeMap) || {})[b.type] || {};
    if (b.source === 'admin_manual' || b.source === 'setter_booking' || b.source === 'setter' || t.isSetterOnly === true) return false;
    return true;
  }
  function sorted(bookings) {
    return (bookings || []).filter(function (b) { return b && bookingStart(b); })
      .sort(function (a, b) { return bookingStart(a) - bookingStart(b); });
  }
  function lastWhere(bs, fn) { for (var i = bs.length - 1; i >= 0; i--) if (fn(bs[i])) return bs[i]; return null; }

  /* ── Ce qui s'est passé sur une fiche encore à l'étape « Lead » ──
     fu       : un rappel programmé, pas encore fait
     decroche : un appel décroché (≥ 30 s ou marqué répondu), ou statut Décroché
     essais   : appels sortants sans réponse (statut Appelé / Messagerie = 1 au moins)
     message  : SMS, WhatsApp ou e-mail envoyé à la main */
  function traces(l) {
    var t = { fu: false, decroche: false, essais: 0, message: false };
    (l.followUps || []).forEach(function (f) { if (f && !f.done) t.fu = true; });
    (l.communications || []).forEach(function (c) {
      if (!c || c.direction === 'inbound' || c.direction === 'in') return;
      if (c.type === 'call') {
        if (c.answered === true || (+c.duration || 0) >= 30) t.decroche = true; else t.essais++;
      } else if ((c.type === 'sms' || c.type === 'whatsapp' || c.type === 'email') && !c.auto) t.message = true;
    });
    if (l.status === 'decroche') t.decroche = true;
    if ((l.status === 'appele' || l.status === 'messagerie') && !t.essais) t.essais = 1;
    return t;
  }

  /* Date réelle d'arrivée = la plus ancienne de dateWebinaire / importedCreatedAt / createdAt */
  var AGE_ANCIEN = 183 * 864e5;
  function msOf(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v < 1e11 ? v * 1000 : v;
    if (v instanceof Date) return v.getTime();
    if (typeof v.toDate === 'function') { try { return v.toDate().getTime(); } catch (e) { return null; } }
    if (typeof v.seconds === 'number') return v.seconds * 1000;
    var t = Date.parse(v); return isNaN(t) ? null : t;
  }
  function realMs(l) {
    var c = [msOf(l.dateWebinaire), msOf(l.importedCreatedAt), msOf(l.createdAt)].filter(function (x) { return x; });
    return c.length ? Math.min.apply(null, c) : null;
  }
  /* Ancien = arrivé il y a plus de 6 mois ET pas revenu depuis (nouvel opt-in ou
     RDV pris dans les 6 mois → c'est une nouvelle arrivée, il reste en Lead). */
  function estAncien(l) {
    var r = realMs(l), now = Date.now();
    if (!r || now - r <= AGE_ANCIEN) return false;
    var retour = Math.max(msOf(l.lastOptinAt) || 0, msOf(l.lastBookingAt) || 0);
    return !(retour && now - retour <= AGE_ANCIEN);
  }
  function origineAncienne(l) {
    var ty = String(l.type || '').toLowerCase();
    if (ty === 'self_booking') return 'rdv';
    if (/webin/.test(ty) || l.source === 'webinar_import') return 'webinaire';
    if (/vsl/.test(ty)) return 'vsl';
    return 'autre';
  }

  /* NRP après un appel sans réponse. Étape NRP explicite → la suivante. Fiche
     encore « lead » → d'après le nombre d'essais, en comptant l'appel qu'on
     vient de passer UNE fois : s'il est déjà enregistré (Ringover, < 5 min),
     il est dans le compte ; sinon on l'ajoute. */
  function nrpApresAppel(l) {
    var st = (l && l.stage) || 'lead';
    if (st !== 'lead') return NEXT_NRP[st] || 'nrp1';
    var t = traces(l), recent = false, now = Date.now();
    (l.communications || []).forEach(function (c) {
      if (!c || c.type !== 'call' || c.direction === 'inbound' || c.direction === 'in') return;
      var ms = Date.parse(c.date || c.createdAt || '');
      if (ms && now - ms < 5 * 60000 && !(c.answered === true || (+c.duration || 0) >= 30)) recent = true;
    });
    var n = t.essais + (recent ? 0 : 1);
    return n >= 4 ? 'all_nrp' : 'nrp' + Math.max(1, n);
  }

  /* ── Où va ce lead ? ── */
  function classify(l, bookings, opts) {
    var stage = (l && l.stage) || 'lead', now = Date.now();
    if (!STAGE_LABEL[stage]) stage = (l && l.isClient) ? 'closed_won_setting' : 'lead';
    var bs = sorted(bookings), upcoming = null, lastPast = null;
    bs.forEach(function (b) {
      var st = bookingStart(b);
      if (b.outcome === 'replanifie') return;
      if (st > now && !isCancelled(b) && !b.outcome) { if (!upcoming) upcoming = b; }
      else if (st <= now || isCancelled(b)) lastPast = b;
    });
    var r = { stage: stage, col: 'lead', sub: '', booking: null, sb: null, upcoming: upcoming, lastPast: lastPast };
    function sbFallback(b) {
      var v = sbOf(b, opts);
      if (v === null) v = (l && l.type === 'self_booking') || /_self$/.test(stage) || stage === 'rdv_self_booking';
      return v;
    }
    function rdvSub(b) {
      if (!b) return 'a_confirmer';
      if (bookingStart(b) > now) return b.presenceConfirmed ? 'confirme' : 'a_confirmer';
      return 'nonsaisi';
    }

    if (stage === 'closed_won_setting' || stage === 'closed_won_self' || (l && l.isClient && !COL_OF_STAGE[stage])) {
      r.col = 'closing'; r.booking = lastWhere(bs, function (b) { return b.outcome === 'close'; }) || lastPast;
      r.sb = stage === 'closed_won_self'; r.sub = r.sb ? 'sb' : 'nb';
    } else if (stage === 'faux_numero' || stage === 'poubelle') {
      r.col = 'poubelle'; r.sub = stage;
    } else if (stage === 'disqualification' || stage === 'disqualifie_closing') {
      r.col = 'disqua'; r.sub = stage === 'disqualifie_closing' ? 'closing' : 'setting';
    } else if (stage === 'follow_up_closing') {
      /* RDV de closing tenu, pas signé : reste ici même avec un 2ᵉ RDV prévu */
      r.col = 'perdu'; r.sub = 'fu_closing'; r.booking = upcoming || lastWhere(bs, function (b) { return b.outcome === 'offre'; }) || lastPast;
      r.sb = sbOf(r.booking, opts);
    } else if (upcoming) {
      /* Un RDV à venir prime : nouveau lead auto-réservé, ou lead repris après no show / annulation */
      r.booking = upcoming; r.sb = sbFallback(upcoming);
      r.col = r.sb ? 'sb' : 'set'; r.sub = rdvSub(upcoming);
    } else if (stage === 'set' || stage === 'rdv_confirmes' || stage === 'partenariats' || stage === 'rdv_self_booking') {
      r.booking = lastPast;
      r.sb = lastPast ? sbFallback(lastPast) : stage === 'rdv_self_booking';
      /* Pas de RDV du tout : étape posée à la main, ou RDV hors des données chargées */
      r.col = r.sb ? 'sb' : 'set'; r.sub = lastPast ? 'nonsaisi' : 'sans_rdv';
    } else if (stage === 'rdv_annules_prospect' || stage === 'rdv_annules_equipe') {
      var bc = lastWhere(bs, isCancelled) || lastPast;
      r.col = 'perdu'; r.booking = bc; r.sb = sbFallback(bc);
      if (stage === 'rdv_annules_equipe' && bc && bc.cancellation && bc.cancellation.kind === 'non_honore') r.sub = 'non_honore';
      else r.sub = (stage === 'rdv_annules_equipe' ? 'annule_equipe_' : 'annule_prospect_') + (r.sb ? 'sb' : 'nb');
    } else if (stage === 'no_show_self' || stage === 'no_show_setting') {
      r.col = 'perdu'; r.booking = lastWhere(bs, isNoShow) || lastPast; r.sb = stage === 'no_show_self';
      r.sub = r.sb ? 'no_show_sb' : 'no_show_nb';
    } else if (stage === 'closed_lost') {
      var bl = lastWhere(bs, function (b) { return b.outcome === 'non_close'; }) || lastPast;
      r.col = 'perdu'; r.booking = bl; r.sb = sbFallback(bl); r.sub = r.sb ? 'closed_lost_sb' : 'closed_lost_nb';
    } else if (stage === 'follow_up_pm') {
      r.col = 'fu';
    } else if (stage === 'lead') {
      /* « Lead » = arrivé, AUCUNE action (Adrien, 30/10/2026). Les appels du
         Dialer et les rappels ne changent pas l'étape en base : on lit donc ce
         qui s'est vraiment passé sur la fiche. */
      var t = traces(l);
      if (t.fu || t.decroche) r.col = 'fu';
      else if (t.essais) r.col = t.essais >= 4 ? 'all_nrp' : 'nrp' + t.essais;
      else if (t.message) r.col = 'nrp1';
      else if (estAncien(l)) { r.col = 'ancien'; r.sub = origineAncienne(l); }
      else r.col = 'lead';
      r.deduit = r.col !== 'lead';
    } else {
      r.col = stage; /* nrp1, nrp2, nrp3, all_nrp */
    }
    r.key = r.sub ? r.col + ':' + r.sub : r.col;
    return r;
  }
  var COL_OF_STAGE = {};
  COLS.forEach(function (c) { c.st.forEach(function (s) { COL_OF_STAGE[s] = c.id; }); });

  function match(l, bookings, cle, opts) {
    if (!cle) return true;
    var r = classify(l, bookings, opts);
    return cle.indexOf(':') > -1 ? r.key === cle : r.col === cle;
  }
  function count(leads, bookingsOf, opts) {
    var n = {};
    (leads || []).forEach(function (l) {
      var r = classify(l, bookingsOf ? bookingsOf(l) : [], opts);
      n[r.col] = (n[r.col] || 0) + 1;
      if (r.sub) n[r.key] = (n[r.key] || 0) + 1;
    });
    return n;
  }
  function colOf(id) { return COL[id] || null; }
  /* Sous-filtres qui se lisent seuls (« No show · NB », pas « No show / Annulé… · No show · NB ») */
  var SEUL = { perdu: 1, poubelle: 1, closing: 1 };
  function label(cle) {
    if (!cle) return 'Toutes les étapes';
    var p = String(cle).split(':'), c = COL[p[0]];
    if (!c) return cle;
    if (!p[1]) return c.t;
    for (var i = 0; i < (c.subs || []).length; i++) if (c.subs[i].id === p[1]) return SEUL[c.id] ? c.subs[i].t : c.t + ' · ' + c.subs[i].t;
    return c.t;
  }
  /* Liste à plat pour une liste déroulante : colonne puis ses sous-filtres */
  function options() {
    var o = [];
    COLS.forEach(function (c) {
      o.push({ key: c.id, label: c.t, col: c.id, sub: false });
      (c.subs || []).forEach(function (s) { o.push({ key: c.id + ':' + s.id, label: s.t, col: c.id, sub: true }); });
    });
    return o;
  }

  window.PipelineEtapes = {
    COLS: COLS, STAGE_LABEL: STAGE_LABEL, STATUS_OF: STATUS_OF, NEXT_NRP: NEXT_NRP, COL_OF_STAGE: COL_OF_STAGE,
    classify: classify, match: match, count: count, label: label, colOf: colOf, options: options,
    sbOf: sbOf, bookingStart: bookingStart, isCancelled: isCancelled, traces: traces, nrpApresAppel: nrpApresAppel, realMs: realMs, AGE_ANCIEN: AGE_ANCIEN
  };
})();
