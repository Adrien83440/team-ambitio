/* ═══════════════════════════════════════════════════════════════════════════
   sandbox-pipeline-data.js — LABO PIPELINE : faux leads + faux hôte
   ─────────────────────────────────────────────────────────────────────────
   Chargé UNIQUEMENT par sandbox-pipeline.html. Fournit à pipeline-v2.js
   l'« hôte » qu'il attend, sur une base en mémoire :
     - aucun Firebase, aucun appel réseau, aucun lien vers le vrai logiciel ;
     - des leads fictifs AU FORMAT RÉEL de la collection `leads` et des
       `bookings` (mêmes noms de champs), datés par rapport à aujourd'hui ;
     - tout ce que le testeur fait (étapes, notes, rappels, messages…) est
       gardé dans ce navigateur (clé « sbxpl:db_v1 ») et effacé par
       « Réinitialiser ».
   ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  var KEY = 'sbxpl:db_v1', PREF = 'sbxpl:pref:';

  /* ── Le testeur : prénom du compte Alteore ouvert sur ce navigateur (lecture seule) ── */
  var TEAM = [
    { slug: 'elodie', name: 'Élodie', color: '#e0567a' },
    { slug: 'steven', name: 'Steven', color: '#3b82f6' },
    { slug: 'valentin', name: 'Valentin', color: '#0d9488' },
    { slug: 'vincent', name: 'Vincent', color: '#7c3aed' }
  ];
  var ME = { slug: 'vincent', name: 'Vincent' };
  try {
    var brut = String(window.localStorage.getItem('ambitio_name') || '').replace(/[._-]+/g, ' ').trim().split(/\s+/)[0] || '';
    if (brut && !/@/.test(brut) && brut.length > 1) {
      var prenom = brut.charAt(0).toUpperCase() + brut.slice(1).toLowerCase(), norm = prenom.normalize ? prenom.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase() : prenom.toLowerCase();
      ME = { slug: norm, name: prenom };
      for (var i = 0; i < TEAM.length; i++) if (TEAM[i].slug === norm) ME = { slug: TEAM[i].slug, name: TEAM[i].name };
    }
  } catch (e) {}

  /* ── Dates relatives à aujourd'hui ── */
  function at(days, h, m) { var d = new Date(); d.setDate(d.getDate() - days); d.setHours(h == null ? 10 : h, m || 0, 0, 0); return d; }
  function iso(days, h, m) { return at(days, h, m).toISOString(); }
  function p2(n) { return (n < 10 ? '0' : '') + n; }
  function fr(days, h, m) { var d = at(days, h, m); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function frNow() { var d = new Date(); return p2(d.getDate()) + '/' + p2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes()); }
  function day(days) { var d = at(days, 12); return d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate()); }
  function localIso(days, h) { var d = at(days, h); return day(days) + 'T' + p2(d.getHours()) + ':00'; }

  /* ── Briques au format réel ── */
  function call(days, h, m, who, dur, extra) {
    var c = { type: 'call', direction: 'outbound', duration: dur || 0, date: iso(days, h, m), ownerName: who, source: 'ringover' };
    if (!dur) c.result = 'pas de réponse';
    for (var k in (extra || {})) c[k] = extra[k];
    return c;
  }
  function msg(type, days, h, m, dir, content, who, auto) { return { type: type, direction: dir, content: content, date: iso(days, h, m), ownerName: dir === 'inbound' ? '' : (who || ''), auto: !!auto }; }
  function note(days, h, who, text) { return { text: text, date: fr(days, h, 5), authorName: who, authorSlug: who.toLowerCase() }; }
  function bk(id, days, time, person, x) {
    var b = { id: id, date: day(days), time: time, personName: person, type: 'call_strat', typeLabel: 'Appel stratégique', status: 'confirmed', duration: 45 };
    for (var k in (x || {})) b[k] = x[k];
    return b;
  }

  /* ── Leads détaillés (cas typiques) ── */
  function seed() {
    var L = [], B = {};
    function add(o, bookings) {
      var l = { communications: [], notesHistory: [], timeline_history: [], followUps: [], tags: [], _v: 0, status: 'nouveau' };
      for (var k in o) l[k] = o[k];
      if (!l.telephone) l.telephone = '+336' + String(10000000 + Math.floor(rnd() * 89999999));
      L.push(l);
      if (bookings) { B[l.id] = bookings.map(function (b) { b.leadId = l.id; return b; }); }
      return l;
    }

    add({ id: 'sbx_morel', nom: 'Sandrine Morel', email: 's.morel@exemple.fr', telephone: '+33612457890', secteur: 'Agence immobilière', ca: '45 k€/mois',
      createdAt: iso(223, 21, 14), type: 'quiz_funnel', source: 'webhook', landingFirst: { page: 'quiz_elite', label: 'Quiz Élite' },
      attributionFirst: { utm_source: 'facebook', utm_medium: 'cpc', utm_campaign: 'Déléguer sans perdre le contrôle' },
      stage: 'closed_lost', status: 'pas_interesse', assignedTo: 'elodie', setterSlug: 'elodie', setterName: 'Élodie', closeur: 'Vincent', setting: 'Élodie',
      defi: 'Je fais tout moi-même, je n\'arrive pas à déléguer à mes deux agents sans que ça parte dans tous les sens.',
      disponibilite: 'Le matin', timeline: 'Dans les 3 mois',
      quiz: { score_global: 58, scores: { systematisation: 62, delegation: 31, pilotage: 55, croissance: 70 }, pilier_prioritaire: 'delegation', ca_mensuel: '40 à 50 k€', objectif: '80 k€/mois sans y passer mes soirées', equipe: '2 agents et 1 assistante', heures: 'Plus de 60 h',
        reponses: [{ question: 'Qu\'avez-vous déjà essayé ?', reponse: 'Un logiciel de gestion de tâches, abandonné au bout de 2 mois' }, { question: 'Qu\'est-ce qui vous bloque le plus aujourd\'hui ?', reponse: 'Je repasse derrière tout le monde' }, { question: 'Êtes-vous prête à investir pour être accompagnée ?', reponse: 'Oui, si le retour est clair' }] },
      quizSubmittedAt: iso(223, 21, 14),
      communications: [
        call(222, 16, 45, 'Élodie', 0, { result: 'messagerie' }),
        msg('whatsapp', 222, 17, 2, 'inbound', 'Bonjour, oui je suis dispo demain matin pour en parler'),
        call(221, 10, 32, 'Élodie', 760, { callLogId: 'cl_morel_1', hasRecording: true, hasTranscript: true }),
        msg('sms', 217, 9, 0, 'outbound', 'Bonjour Sandrine, petit rappel de notre rendez-vous demain à 14 h avec Vincent. À demain !', 'Système', true),
        call(47, 11, 20, 'Élodie', 0)
      ],
      notesHistory: [note(221, 10, 'Élodie', 'Super échange, très ouverte. RDV posé avec Vincent mercredi.'), note(216, 15, 'Vincent', 'Très intéressée par l\'Élite. Associé à convaincre, prévoir un point à trois.')],
      timeline_history: [{ text: 'Étape : RDV confirmés → Closed Lost (Vincent)', date: fr(216, 15, 2) }],
      lastOptinAt: iso(49, 18, 0), lastOptinSource: 'Inscription au webinaire (absente le jour J)',
      tags: ['Associé', 'Budget OK'], files: [{ name: 'Plaquette-agence.pdf', by: 'Sandrine', at: iso(221, 11), size: 430000 }],
      aiLead: { niveau: 'tiède', proba: 62, brief: ['Le budget n\'était pas le frein : c\'est l\'associé qui doit valider.', 'Elle est revenue d\'elle-même par le webinaire il y a 7 semaines : l\'intérêt est toujours là.', 'Jamais rappelée après son RDV, ni par SMS ni par WhatsApp.'],
        raison: 'Intérêt fort, budget validé, décision bloquée par un tiers.', angle: 'Repartir de « je repasse derrière tout le monde » et proposer un point à trois avec l\'associé.', ouverture: 'Sandrine, vous deviez en parler avec Marc : qu\'est-ce qu\'il en a pensé ?', generatedAt: iso(2) }
    }, [bk('bk_morel_1', 216, '14:00', 'Vincent', { createdAt: iso(221, 10, 45), bookedByName: 'Élodie', source: 'setter_booking', presenceConfirmed: { at: iso(217, 9, 30), channel: 'SMS' },
      outcome: 'non_close', outcomeNote: 'Très intéressée par l\'Élite. Budget OK. Veut en parler à son associé (Marc) avant de signer. Rappeler début avril.', outcomeByName: 'Vincent', status: 'completed',
      replay: { durationSec: 2520, summary: 'Découverte solide : 2 agents, une assistante, 60 h par semaine. Douleur claire sur la délégation. Présentation de l\'Élite bien reçue, aucune objection prix. Blocage : la décision se prend avec l\'associé, absent du RDV. Prochaine étape proposée : un point à trois.' },
      aiPrep: { resume: 'Dirigeante d\'agence immobilière débordée, point faible délégation (31/100). Angle : reprendre le contrôle sans tout faire soi-même. Vérifier qui décide (associé ?).' },
      _objections: ['Tiers : l\'associé', 'Besoin de réfléchir'] })]);

    add({ id: 'sbx_blanc', nom: 'Romain Blanc', email: 'r.blanc@exemple.fr', secteur: 'Agence de voyages', ca: '30 k€/mois', createdAt: iso(254, 19), type: 'vsl_elite', source: 'webhook',
      attributionFirst: { utm_source: 'facebook', utm_campaign: 'VSL Élite v3' }, stage: 'closed_lost', assignedTo: 'elodie', setterSlug: 'elodie', setterName: 'Élodie',
      defi: 'Je ne sais pas quels voyages me rapportent vraiment de l\'argent.',
      communications: [call(253, 10, 5, 'Élodie', 0), call(252, 14, 30, 'Élodie', 610), call(247, 15, 50, 'Vincent', 0)],
      notesHistory: [note(252, 14, 'Élodie', 'Gros volume mais aucune visibilité sur les marges. RDV avec Vincent lundi.')]
    }, [bk('bk_blanc_1', 247, '15:00', 'Vincent', { createdAt: iso(252, 14, 45), bookedByName: 'Élodie', source: 'setter_booking', outcome: 'non_close', outcomeNote: 'Trouve l\'Élite trop chère à ce stade. Intéressé par une formule plus légère.', outcomeByName: 'Vincent', status: 'completed', _objections: ['Prix'] })]);

    add({ id: 'sbx_roux', nom: 'Nathalie Roux', email: 'n.roux@exemple.fr', secteur: 'Institut de beauté', ca: '12 k€/mois', createdAt: iso(139, 21), dateWebinaire: iso(140, 20), present: 'oui', type: 'webinaire', source: 'webhook',
      stage: 'no_show_setting', assignedTo: 'elodie', setterSlug: 'elodie', setterName: 'Élodie',
      formTitle: 'Webinaire', formAnswers: [{ label: 'Question posée en direct', value: 'Est-ce que ça marche pour un institut avec une seule salariée ?' }],
      defi: 'Mon agenda est plein mais je plafonne, je ne sais pas comment grandir sans m\'épuiser.',
      communications: [call(138, 14, 20, 'Élodie', 490), call(133, 11, 5, 'Vincent', 0), msg('sms', 132, 10, 0, 'outbound', 'Bonjour Nathalie, on vous a manquée hier ! Voulez-vous qu\'on fixe un autre créneau cette semaine ?', 'Élodie')],
      notesHistory: [note(138, 14, 'Élodie', 'Une seule salariée, veut grandir sans s\'épuiser. Un peu hésitante sur le prix.')], tags: ['Prix ?']
    }, [bk('bk_roux_1', 133, '11:00', 'Vincent', { createdAt: iso(138, 14, 30), bookedByName: 'Élodie', source: 'setter_booking', status: 'no_show', outcome: 'no_show', outcomeByName: 'Vincent', outcomeNote: 'Pas présente, ne répond pas à 11 h 05.' })]);

    add({ id: 'sbx_lambert', nom: 'Sophie Lambert', email: 's.lambert@exemple.fr', secteur: 'Cabinet d\'architecture', ca: '22 k€/mois', createdAt: iso(202, 9), type: 'alteoform', source: 'alteoform', formTitle: 'Diagnostic', formSubmittedAt: iso(202, 9),
      formAnswers: [{ label: 'Votre plus gros défi', value: 'Trouver des clients sans dépendre du bouche-à-oreille' }, { label: 'Chiffre d\'affaires mensuel', value: '20 à 25 k€' }, { label: 'Quand voulez-vous démarrer ?', value: 'Dans les 3 mois' }],
      stage: 'rdv_annules_prospect', assignedTo: 'elodie',
      communications: [call(201, 11, 0, 'Élodie', 330), msg('email', 63, 18, 30, 'inbound', 'Bonjour, je dois annuler, ce n\'est pas le moment pour moi. Je reviens vers vous. Sophie', '', false)]
    }, [bk('bk_lambert_1', 58, '10:00', 'Vincent', { createdAt: iso(64, 22, 10), source: 'self_booking', status: 'cancelled', cancellation: { origin: 'prospect', reason: 'Pas le moment, je reviens vers vous', at: iso(63, 18, 30) } })]);

    add({ id: 'sbx_benali', nom: 'Karim Benali', email: 'karim.b@exemple.fr', secteur: 'Plomberie et chauffage', ca: '28 k€/mois', createdAt: iso(54, 22, 47), type: 'vsl_elite', source: 'webhook',
      attributionFirst: { utm_source: 'facebook', utm_campaign: 'VSL v4-B' }, stage: 'nrp3', assignedTo: 'steven',
      formAnswers: [{ label: 'Votre plus gros défi', value: 'Savoir si je gagne vraiment de l\'argent sur chaque chantier' }, { label: 'Quand voulez-vous démarrer ?', value: 'Dès que possible' }],
      communications: [call(53, 9, 31, 'Valentin', 0), call(52, 15, 20, 'Valentin', 0, { result: 'messagerie' }), call(47, 10, 0, 'Valentin', 0), call(36, 12, 5, 'Steven', 0, { result: 'messagerie' }), call(29, 17, 40, 'Steven', 0, { result: 'messagerie' }), call(21, 9, 12, 'Steven', 0)]
    });

    add({ id: 'sbx_haddad', nom: 'Mehdi Haddad', email: 'm.haddad@exemple.fr', secteur: 'Garage automobile', ca: '55 k€/mois', createdAt: iso(30, 13), type: 'quiz_funnel', landingFirst: { page: 'quiz_elite' }, source: 'webhook', stage: 'nrp1', assignedTo: 'steven',
      quiz: { score_global: 52, scores: { systematisation: 50, delegation: 35, pilotage: 60, croissance: 63 }, pilier_prioritaire: 'delegation', reponses: [{ question: 'Qu\'est-ce qui vous bloque le plus aujourd\'hui ?', reponse: 'Je passe mes journées au téléphone avec les clients au lieu de piloter l\'atelier' }] },
      communications: [call(12, 10, 15, 'Steven', 0)]
    });

    add({ id: 'sbx_lemoine', nom: 'Patrick Lemoine', email: 'p.lemoine@exemple.fr', secteur: 'Maçonnerie', ca: '150 k€/mois', createdAt: iso(20, 8), importedCreatedAt: iso(350, 9), source: 'bigin_import', type: '', stage: 'all_nrp', assignedTo: '',
      communications: [call(300, 9, 0, 'Valentin', 0), call(296, 16, 0, 'Valentin', 0), call(290, 11, 0, 'Valentin', 0, { result: 'messagerie' })]
    });

    add({ id: 'sbx_girard', nom: 'Thomas Girard', email: 't.girard@exemple.fr', secteur: 'Cabinet comptable', ca: '90 k€/mois', createdAt: iso(7, 8, 12), type: 'quiz_funnel', landingFirst: { page: 'quiz_business' }, source: 'webhook',
      attributionFirst: { utm_source: 'google', utm_campaign: 'structurer son cabinet' }, stage: 'lead', assignedTo: 'valentin',
      quiz: { score_global: 44, scores: { systematisation: 22, delegation: 48, pilotage: 51, croissance: 55 }, pilier_prioritaire: 'systematisation', equipe: '11 collaborateurs', objectif: 'Pouvoir partir 3 semaines sans que tout s\'arrête',
        reponses: [{ question: 'Qu\'est-ce qui vous bloque le plus aujourd\'hui ?', reponse: 'Chaque collaborateur a sa propre façon de faire, aucun process écrit' }] }
    });

    add({ id: 'sbx_mercier', nom: 'Antoine Mercier', email: 'a.mercier@exemple.fr', secteur: 'Restauration', ca: '40 k€/mois', createdAt: iso(105, 12), type: 'vsl_elite', source: 'webhook', stage: 'follow_up_pm', assignedTo: 'valentin',
      defi: 'Turnover énorme en cuisine, je forme sans arrêt.', communications: [call(104, 11, 0, 'Valentin', 0), call(16, 15, 0, 'Valentin', 242)],
      notesHistory: [note(16, 15, 'Valentin', 'En pleine saison, rappeler après. Très réceptif sur la partie recrutement.')],
      followUps: [{ id: 'fu_mercier', dateTime: localIso(-1, 10), note: 'Rappeler après la saison', done: false, createdBy: 'Valentin' }]
    });

    add({ id: 'sbx_fabre', nom: 'Julie Fabre', email: 'julie@exemple.fr', instagramUsername: 'juliefabre.studio', secteur: 'E-commerce mode', ca: '60 k€/mois', createdAt: iso(274, 20), source: 'instagram', type: '', stage: 'follow_up_closing', assignedTo: 'steven', setterSlug: 'steven', setterName: 'Steven',
      defi: 'Je veux recruter un bras droit mais je ne sais pas par où commencer.',
      communications: [msg('whatsapp', 9, 10, 0, 'outbound', 'Bonjour Julie, je reviens vers vous comme convenu. Des nouvelles de la levée ?', 'Vincent'), msg('whatsapp', 9, 12, 40, 'inbound', 'Pas encore, je vous tiens au courant d\'ici 15 jours !')],
      followUps: [{ id: 'fu_fabre', dateTime: localIso(-7, 10), note: 'Relance après la levée de fonds', done: false, createdBy: 'Vincent' }]
    }, [bk('bk_fabre_1', 19, '16:00', 'Vincent', { createdAt: iso(26, 11), bookedByName: 'Steven', source: 'setter_booking', outcome: 'offre', outcomeNote: 'Offre Élite envoyée. Attend sa levée de fonds, prévue dans 3 semaines.', outcomeByName: 'Vincent', status: 'completed', _objections: ['Timing : levée de fonds'] })]);

    add({ id: 'sbx_perrin', nom: 'Lucie Perrin', email: 'lucie.p@exemple.fr', secteur: 'Salle de sport', ca: '35 k€/mois', createdAt: iso(6, 19), type: 'quiz_funnel', landingFirst: { page: 'quiz_elite' }, source: 'webhook', stage: 'rdv_confirmes', assignedTo: 'elodie', setterSlug: 'elodie', setterName: 'Élodie',
      quiz: { score_global: 49, scores: { systematisation: 55, delegation: 52, pilotage: 38, croissance: 51 }, pilier_prioritaire: 'pilotage', reponses: [{ question: 'Qu\'est-ce qui vous bloque le plus aujourd\'hui ?', reponse: 'Je n\'arrive pas à fidéliser mes adhérents après 3 mois' }] },
      communications: [call(5, 10, 10, 'Élodie', 520), msg('sms', 1, 18, 0, 'inbound', 'Oui c\'est noté, à jeudi !')]
    }, [bk('bk_perrin_1', -2, '14:00', 'Vincent', { createdAt: iso(5, 10, 25), bookedByName: 'Élodie', source: 'setter_booking', presenceConfirmed: { at: iso(1, 18, 0), channel: 'SMS', byName: 'Élodie' }, aiPrep: { resume: 'Gérante de salle de sport, point faible pilotage. Angle : la fidélisation au-delà de 3 mois.' } })]);

    add({ id: 'sbx_martin', nom: 'Hugo Martin', email: 'hugo.m@exemple.fr', secteur: 'Électricité', ca: '25 k€/mois', createdAt: iso(3, 21), type: 'vsl_elite', source: 'webhook', stage: 'set', assignedTo: 'steven', setterSlug: 'steven', setterName: 'Steven',
      defi: 'Je refuse des chantiers faute de bras.', communications: [call(3, 9, 40, 'Steven', 540)]
    }, [bk('bk_martin_1', -6, '11:00', 'Vincent', { createdAt: iso(3, 9, 55), bookedByName: 'Steven', source: 'setter_booking' })]);

    add({ id: 'sbx_garcia', nom: 'Olivier Garcia', email: 'o.garcia@exemple.fr', secteur: 'Transport', ca: '80 k€/mois', createdAt: iso(12, 9), type: 'self_booking', source: 'booking_direct', stage: 'rdv_confirmes', assignedTo: 'vincent',
      defi: 'Mes chauffeurs ne restent pas.'
    }, [bk('bk_garcia_1', 2, '17:00', 'Vincent', { createdAt: iso(12, 9), source: 'self_booking', presenceConfirmed: { at: iso(3), channel: 'appel' } })]);

    add({ id: 'sbx_chevalier', nom: 'Nadia Chevalier', email: 'nadia.c@exemple.fr', secteur: 'Fleuriste', ca: '18 k€/mois', createdAt: iso(41, 14), type: 'quiz_funnel', landingFirst: { page: 'quiz_elite' }, source: 'webhook', stage: 'follow_up_pm', assignedTo: 'elodie',
      quiz: { score_global: 47, scores: { systematisation: 45, delegation: 58, pilotage: 35, croissance: 50 }, pilier_prioritaire: 'pilotage' },
      communications: [call(30, 11, 0, 'Élodie', 300)], notesHistory: [note(30, 11, 'Élodie', 'Sur un salon toute la semaine, rappeler après.')],
      followUps: [{ id: 'fu_chev', dateTime: localIso(4, 10), note: 'Rappeler après son salon', done: false, createdBy: 'Élodie' }]
    });

    add({ id: 'sbx_dumont', nom: 'Claire Dumont', email: 'claire@exemple.fr', secteur: 'Agence de communication', ca: '35 k€/mois', createdAt: iso(159, 21), type: 'quiz_funnel', landingFirst: { page: 'quiz_elite' }, source: 'webhook',
      stage: 'closed_won_setting', status: 'client', isClient: true, clientSince: iso(152, 11), assignedTo: 'elodie', setterSlug: 'elodie', setterName: 'Élodie',
      closedData: { offre: 'Elite', subtype: 'mensualise', contracte: 6000, collecte: 2000, paiement: 'prelevement' }, contractSigned: true, contractTemplateName: 'Contrat Élite 12 mois', coachAssigne: { nom: 'Flore' },
      formule: 'Élite 12 mois', dateInscription: day(152), defi: 'Je suis le goulot d\'étranglement de mon agence.'
    }, [bk('bk_dumont_1', 152, '10:00', 'Vincent', { createdAt: iso(158, 10), bookedByName: 'Élodie', source: 'setter_booking', outcome: 'close', outcomeByName: 'Vincent', outcomeNote: 'Closée Élite 12 mois, prélèvement.', status: 'completed' })]);

    add({ id: 'sbx_petit', nom: 'Marc Petit', email: 'marc.petit@exemple.fr', secteur: 'Paysagisme', ca: '30 k€/mois', createdAt: iso(54, 10), type: 'self_booking', source: 'booking_direct',
      stage: 'closed_won_self', status: 'client', isClient: true, clientSince: iso(48, 11), assignedTo: 'vincent', closedData: { offre: 'BP 12', subtype: 'mensualise' }, contractSigned: true
    }, [bk('bk_petit_1', 48, '11:00', 'Vincent', { createdAt: iso(54, 10), source: 'self_booking', outcome: 'close', outcomeByName: 'Vincent', status: 'completed' })]);

    add({ id: 'sbx_garnier', nom: 'Isabelle Garnier', email: 'i.garnier@exemple.fr', secteur: 'Formation professionnelle', createdAt: iso(386, 19), type: 'webinaire', source: 'webhook', stage: 'disqualification', assignedTo: 'vincent',
      communications: [call(345, 10, 0, 'Vincent', 400)], notesHistory: [note(345, 10, 'Vincent', 'Cessation d\'activité prévue en début d\'année, disqualifiée.')]
    });

    add({ id: 'sbx_roche', nom: 'Fabien Roche', email: '', secteur: '', createdAt: iso(19, 8), type: 'vsl_elite', source: 'webhook', stage: 'faux_numero', assignedTo: 'valentin', telephone: '+33600000000',
      communications: [call(18, 9, 0, 'Valentin', 0, { result: 'numéro inexistant' })]
    });

    /* ── Leads générés : de la matière pour remplir les colonnes ── */
    var PRE = ['Camille', 'Laurent', 'Émilie', 'Jérôme', 'Aurélie', 'Nicolas', 'Céline', 'Franck', 'Sabrina', 'David', 'Marion', 'Sébastien', 'Audrey', 'Christophe', 'Laetitia', 'Mathieu', 'Virginie', 'Stéphane', 'Caroline', 'Julien', 'Sandra', 'Yannick', 'Karine', 'Rachid', 'Elsa', 'Bruno', 'Inès', 'Pascal', 'Manon', 'Cédric'];
    var NOM = ['Faure', 'Roussel', 'Blanchard', 'Gauthier', 'Perrot', 'Renaud', 'Colin', 'Vidal', 'Caron', 'Picard', 'Arnaud', 'Lemaire', 'Dupuis', 'Brun', 'Barbier', 'Fontaine', 'Meunier', 'Bertrand', 'Marchand', 'Leclerc', 'Robin', 'Moulin', 'Lucas', 'Henry', 'Rivière', 'Noël', 'Royer', 'Benoît', 'Masson', 'Hubert'];
    var SECT = ['Plomberie', 'Agence immobilière', 'Restaurant', 'Coiffure', 'Cabinet comptable', 'Électricité', 'Boulangerie', 'Agence web', 'Transport', 'Pharmacie', 'Garage', 'Paysagisme', 'Menuiserie', 'Ostéopathie', 'Auto-école', 'Nettoyage', 'Opticien', 'Conciergerie'];
    var CA = ['15 k€/mois', '25 k€/mois', '40 k€/mois', '60 k€/mois', '90 k€/mois', '120 k€/mois'];
    var PB = { delegation: ['Mon équipe vient me voir pour tout', 'Je n\'arrive pas à lâcher les tâches'], pilotage: ['Je ne connais pas ma rentabilité réelle', 'Je pilote au feeling, sans chiffres'], systematisation: ['Rien n\'est écrit, tout est dans ma tête', 'Chaque client est traité différemment'], croissance: ['Je plafonne depuis 3 ans', 'Je ne sais pas comment trouver de nouveaux clients'] };
    var PIL = ['delegation', 'pilotage', 'systematisation', 'croissance'];
    var NOTE_NC = ['Intéressé mais veut comparer avec un autre accompagnement.', 'Pas le bon moment, trésorerie tendue ce trimestre.', 'Doit en parler à sa femme, associée dans l\'entreprise.', 'Trouve le programme trop long, veut quelque chose de plus court.'];
    var SALES = ['elodie', 'steven', 'valentin', 'elodie', 'steven'];
    var NAMEOF = { elodie: 'Élodie', steven: 'Steven', valentin: 'Valentin', vincent: 'Vincent' };
    var PLAN = ['lead', 'lead', 'nrp1', 'nrp1', 'nrp2', 'nrp2', 'nrp3', 'all_nrp', 'all_nrp', 'nrp1', 'lead', 'nrp2',
      'follow_up_pm', 'follow_up_pm', 'follow_up_closing', 'follow_up_pm',
      'set', 'rdv_confirmes', 'rdv_self_booking',
      'closed_lost', 'no_show_self', 'closed_lost', 'rdv_annules_equipe', 'no_show_setting', 'closed_lost',
      'closed_won_setting', 'closed_won_self', 'closed_won_setting',
      'poubelle', 'disqualification'];
    var NRPN = { lead: 0, nrp1: 1, nrp2: 2, nrp3: 3, all_nrp: 5 };
    PLAN.forEach(function (stage, i) {
      var pre = PRE[i % PRE.length], nm = NOM[(i * 7) % NOM.length], sl = SALES[i % SALES.length], who = NAMEOF[sl];
      var arr = 3 + Math.floor(rnd() * 330), pil = PIL[Math.floor(rnd() * 4)], pbt = PB[pil][Math.floor(rnd() * 2)];
      var tp = ['quiz_funnel', 'vsl_elite', 'webinaire', 'alteoform', 'quiz_funnel', 'vsl_elite'][i % 6];
      var mail = (pre + '.' + nm).toLowerCase(); if (mail.normalize) mail = mail.normalize('NFD').replace(/[̀-ͯ]/g, '');
      var o = { id: 'sbx_g' + i, nom: pre + ' ' + nm, email: mail + '@exemple.fr', secteur: SECT[i % SECT.length], ca: CA[Math.floor(rnd() * CA.length)],
        createdAt: iso(arr, 8 + Math.floor(rnd() * 13), Math.floor(rnd() * 59)), type: tp, source: tp === 'alteoform' ? 'alteoform' : 'webhook', stage: stage, assignedTo: sl };
      if (tp === 'quiz_funnel') {
        var sc = {}; PIL.forEach(function (p) { sc[p] = p === pil ? 25 + Math.floor(rnd() * 15) : 45 + Math.floor(rnd() * 35); });
        o.landingFirst = { page: rnd() < .7 ? 'quiz_elite' : 'quiz_business' };
        o.quiz = { score_global: 40 + Math.floor(rnd() * 25), scores: sc, pilier_prioritaire: pil, reponses: [{ question: 'Qu\'est-ce qui vous bloque le plus aujourd\'hui ?', reponse: pbt }] };
      } else if (tp === 'alteoform') { o.formTitle = 'Diagnostic'; o.formAnswers = [{ label: 'Votre plus gros défi', value: pbt }]; }
      else if (tp === 'webinaire') { o.dateWebinaire = iso(arr + 1, 20); o.defi = pbt; }
      else o.defi = pbt;
      if (rnd() < .3) o.attributionFirst = { utm_source: 'facebook', utm_campaign: ['Déléguer sans perdre le contrôle', 'VSL v4-A', 'Rentabilité chantier'][Math.floor(rnd() * 3)] };
      var cm = [], last = Math.min(arr - 1, 1 + Math.floor(rnd() * 120)), books = null;
      if (NRPN[stage] != null) { for (var k = 0; k < NRPN[stage]; k++) cm.push(call(Math.max(0, last + (NRPN[stage] - k - 1) * 3), 9 + k, 10, who, 0, k % 2 ? { result: 'messagerie' } : null)); }
      else if (stage !== 'closed_won_self' && stage !== 'rdv_self_booking') cm.push(call(Math.max(0, last), 11, 0, who, 200 + Math.floor(rnd() * 600)));
      o.communications = cm;
      if (stage === 'follow_up_pm' || stage === 'follow_up_closing') o.followUps = [{ id: 'fu_g' + i, dateTime: localIso(-(1 + Math.floor(rnd() * 12)), 10), note: 'Rappel convenu au téléphone', done: false, createdBy: who }];
      if (stage === 'set' || stage === 'rdv_confirmes' || stage === 'rdv_self_booking') books = [bk('bk_g' + i, -(1 + Math.floor(rnd() * 8)), '14:30', 'Vincent', { createdAt: iso(Math.max(0, last), 11, 20), bookedByName: stage === 'rdv_self_booking' ? '' : who, source: stage === 'rdv_self_booking' ? 'self_booking' : 'setter_booking', presenceConfirmed: stage === 'rdv_confirmes' ? { at: iso(0, 9), channel: 'SMS' } : null })];
      if (stage === 'closed_lost' || stage === 'no_show_self' || stage === 'no_show_setting' || stage === 'rdv_annules_equipe') {
        var bd = Math.max(1, last - 2), bx = { createdAt: iso(bd + 5, 11), bookedByName: who, source: 'setter_booking', status: 'completed' };
        if (stage === 'closed_lost') { bx.outcome = 'non_close'; bx.outcomeNote = NOTE_NC[i % NOTE_NC.length]; bx.outcomeByName = 'Vincent'; }
        else if (stage === 'rdv_annules_equipe') { bx.status = 'cancelled'; bx.cancellation = { origin: 'equipe', reason: 'Closer indisponible, à replanifier' }; }
        else { bx.status = 'no_show'; bx.outcome = 'no_show'; bx.outcomeByName = 'Vincent'; }
        books = [bk('bk_g' + i, bd, '15:00', 'Vincent', bx)];
      }
      if (stage === 'closed_won_setting' || stage === 'closed_won_self') {
        o.isClient = true; o.status = 'client'; o.clientSince = iso(Math.max(1, last - 1), 12); o.closedData = { offre: rnd() < .5 ? 'Elite' : 'BP 12', subtype: 'mensualise' }; o.contractSigned = true;
        books = [bk('bk_g' + i, Math.max(1, last - 1), '10:00', 'Vincent', { createdAt: iso(last + 4, 10), source: stage === 'closed_won_self' ? 'self_booking' : 'setter_booking', outcome: 'close', outcomeByName: 'Vincent', status: 'completed' })];
      }
      if (stage === 'poubelle') o.notesHistory = [note(last, 11, who, 'Ne veut plus être contacté.')];
      if (stage === 'disqualification') o.notesHistory = [note(last, 11, who, 'Activité trop petite pour l\'accompagnement (auto-entrepreneur seul).')];
      add(o, books);
    });
    return { leads: L, bookings: B };
  }

  /* Hasard reproductible : les mêmes faux leads à chaque réinitialisation */
  var SEED = 42;
  function rnd() { SEED |= 0; SEED = SEED + 0x6D2B79F5 | 0; var t = Math.imul(SEED ^ SEED >>> 15, 1 | SEED); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }

  /* ── Base ── */
  var DB = null;
  function load() {
    try { var raw = window.localStorage.getItem(KEY); if (raw) { DB = JSON.parse(raw); if (DB && DB.leads && DB.bookings) return; } } catch (e) {}
    SEED = 42; DB = seed(); save();
  }
  function save() { try { window.localStorage.setItem(KEY, JSON.stringify(DB)); } catch (e) {} }
  function bump(l) { l._v = (l._v || 0) + 1; l.updatedAt = new Date().toISOString(); save(); }
  function later(cb, v) { setTimeout(function () { cb(null, v); }, 120); }
  function labo(msg) { if (window.PipelineV2) window.PipelineV2.toast('🧪 ' + msg); }
  var S2S = { lead: 'nouveau', nrp1: 'nrp1', nrp2: 'nrp2', nrp3: 'nrp3', all_nrp: 'all_nrp', faux_numero: 'faux_numero', poubelle: 'poubelle', disqualification: 'disqualifie', follow_up_pm: 'follow_up_pm', set: 'set', rdv_self_booking: 'rdv_self_booking', rdv_confirmes: 'rdv_pose', rdv_annules_prospect: 'pas_interesse', rdv_annules_equipe: 'pas_interesse', no_show_self: 'pas_interesse', no_show_setting: 'pas_interesse', partenariats: 'rdv_pose', closed_lost: 'pas_interesse', follow_up_closing: 'appele', disqualifie_closing: 'disqualifie' };
  var TRANSCRIPTS = {
    cl_morel_1: { summary: 'Premier échange après le quiz. Douleur : la délégation. RDV posé avec Vincent.', speeches: [
      { me: true, text: 'Bonjour Sandrine, c\'est Élodie d\'Alteore, vous avez fait notre quiz hier soir…' },
      { me: false, text: 'Oui ! Franchement le résultat sur la délégation m\'a parlé.' },
      { me: true, text: 'Qu\'est-ce qui se passe aujourd\'hui quand vous confiez un dossier à un agent ?' },
      { me: false, text: 'Je repasse derrière. Toujours. Du coup je ne gagne aucun temps.' },
      { me: true, text: 'Je vous propose d\'en parler 45 minutes avec Vincent, mercredi 14 h, ça vous va ?' },
      { me: false, text: 'Parfait, c\'est noté.' }] }
  };

  load();

  var HOST = {
    me: ME, team: TEAM,
    leads: function () { return DB.leads; },
    bookings: function () { return DB.bookings; },
    pref: function (k, v) { try { if (arguments.length > 1) window.localStorage.setItem(PREF + k, v); else return window.localStorage.getItem(PREF + k); } catch (e) { return null; } },
    setStage: function (l, stage, cb) {
      var old = l.stage || 'lead', lab = window.PipelineV2.STAGE_LABEL;
      l.stage = stage; l.status = S2S[stage] || l.status;
      l.timeline_history = (l.timeline_history || []).concat([{ text: 'Étape : ' + (lab[old] || old) + ' → ' + (lab[stage] || stage) + ' (' + ME.name + ')', date: frNow() }]);
      bump(l); later(cb);
    },
    addNote: function (l, text, cb) { l.notesHistory = (l.notesHistory || []).concat([{ text: text, date: frNow(), authorName: ME.name, authorSlug: ME.slug }]); bump(l); later(cb); },
    logCall: function (l, r, cb) {
      var c = { type: 'call', direction: 'outbound', duration: r.answered ? (r.duration || 120) : 0, answered: !!r.answered, date: new Date().toISOString(), ownerName: ME.name, source: 'labo' };
      if (!r.answered) c.result = r.result || 'pas de réponse';
      l.communications = (l.communications || []).concat([c]); l.lastContactAt = c.date; bump(l); later(cb);
    },
    sendMessage: function (l, ch, text, cb) {
      var c = { type: ch, direction: 'outbound', content: text, date: new Date().toISOString(), ownerName: ME.name };
      if (ch === 'email') c.subject = 'Suite à notre échange';
      l.communications = (l.communications || []).concat([c]); l.lastContactAt = c.date; bump(l); later(cb);
    },
    addFollowUp: function (l, fu, cb) {
      l.followUps = (l.followUps || []).concat([{ id: 'fu_' + Date.now(), dateTime: fu.dateTime, note: fu.note, done: false, createdBy: ME.name, createdAt: new Date().toISOString() }]);
      /* Comme dans Leads Live : un lead joint qu'on doit rappeler passe en Follow Up */
      if (['lead', 'nrp1', 'nrp2', 'nrp3', 'all_nrp'].indexOf(l.stage || 'lead') > -1) { l.stage = 'follow_up_pm'; l.status = 'follow_up_pm'; }
      bump(l); later(cb);
    },
    update: function (l, f, v, cb) { l[f] = v; bump(l); later(cb); },
    setAssigned: function (l, slug, cb) { l.assignedTo = slug; bump(l); later(cb); },
    addTag: function (l, t, cb) { if ((l.tags || []).indexOf(t) < 0) l.tags = (l.tags || []).concat([t]); bump(l); later(cb); },
    bump: function (l, cb) {
      l.lastOptinAt = new Date().toISOString(); l.lastOptinSource = 'Remonté à la main par ' + ME.name;
      l.timeline_history = (l.timeline_history || []).concat([{ text: 'Remonté dans Leads Live (' + ME.name + ')', date: frNow() }]);
      bump(l); later(cb);
    },
    generateAi: function (l, cb) {
      var d = window.PipelineV2._derive(l);
      l.aiLead = { niveau: d.fam === 'sansuite' || d.fam === 'relance' ? 'tiède' : d.fam === 'rdv' ? 'chaud' : 'froid', proba: d.fam === 'rdv' ? 70 : d.fam === 'sansuite' ? 45 : 25,
        brief: [d.situ, d.pb.text ? 'Son problème : ' + d.pb.text : 'Aucun problème exprimé : à découvrir au prochain appel.'],
        angle: d.pb.text ? 'Repartir de son problème : « ' + d.pb.text + ' »' : 'Faire parler le prospect de son quotidien de dirigeant.',
        ouverture: 'Bonjour ' + String(l.nom || '').split(' ')[0] + ', je reviens vers vous suite à notre dernier échange.', generatedAt: new Date().toISOString() };
      bump(l); setTimeout(function () { cb(null); }, 900);
    },
    createLead: function (o, cb) {
      DB.leads.unshift({ id: 'sbx_n' + Date.now(), nom: o.nom, telephone: o.telephone, email: o.email, createdAt: new Date().toISOString(), type: '', source: 'manual', stage: 'lead', status: 'nouveau',
        assignedTo: ME.slug, communications: [], notesHistory: [], timeline_history: [], followUps: [], tags: [], _v: 0 });
      save(); later(cb);
    },
    callDetail: function (l, c, cb) {
      setTimeout(function () {
        cb(null, TRANSCRIPTS[c && c.callLogId] || { summary: 'Appel de ' + Math.round((c && c.duration || 0) / 60) + ' min.', speeches: [{ me: true, text: 'Bonjour, c\'est ' + (c && c.ownerName || 'l\'équipe') + ' d\'Alteore.' }, { me: false, text: 'Oui bonjour.' }] });
      }, 400);
    },
    objectionsOf: function (b) { return b._objections || []; },
    call: function (l) { labo('Le Dialer appellerait ' + (l.telephone || 'ce lead')); },
    listen: function () { labo('Écoute de l\'enregistrement : désactivée dans le labo'); },
    openClose: function (l) { labo('Le parcours de close s\'ouvrirait ici pour ' + l.nom + ' (testable dans le Bac à sable closer)'); },
    openBooking: function (l) { labo('La prise de RDV s\'ouvrirait ici pour ' + l.nom); }
  };

  /* ── Bandeau Labo + démarrage ── */
  function pret() {
    window.PipelineV2.start(document.getElementById('pv2root'), HOST);
    var bd = document.createElement('div');
    bd.className = 'sbxpl-band';
    bd.innerHTML = '<span>🧪 Labo Pipeline · faux leads · rien n\'est envoyé</span><button type="button" data-sbx="reset">Réinitialiser</button><button type="button" data-sbx="close">Fermer</button>';
    bd.addEventListener('click', function (e) {
      var b = e.target.closest('[data-sbx]'); if (!b) return;
      if (b.getAttribute('data-sbx') === 'reset') {
        try { window.localStorage.removeItem(KEY); } catch (x) {}
        SEED = 42; DB = seed(); save(); window.PipelineV2.refresh(); labo('Labo remis à zéro');
      } else { window.close(); setTimeout(function () { location.href = 'sales-crm.html'; }, 150); }
    });
    document.body.appendChild(bd);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', pret); else pret();
})();
