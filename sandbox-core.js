/* ═══════════════════════════════════════════════════════════════════════
   sandbox-core.js — BAC À SABLE CLOSER : leads, téléphone, base, bilan
   ─────────────────────────────────────────────────────────────────────────
   Demande Adrien 08/10/2026, refondue le 09/10/2026 : un mini-logiciel
   d'entraînement, ouvert dans une fenêtre à part depuis Outils, où le
   closer déroule le parcours complet (Leads Live → Meet → contrat →
   signature → GoCardless → close) sur de faux leads, FIDÈLE au réel.

   Depuis le 09/10/2026, « miroir vivant » :
     · Signatures, Paiements et la page de signature du client sont les
       VRAIES pages (sales-signatures.html, payments.html, sign.html),
       lancées par sandbox-frame.html derrière un pare-feu ;
     · le VRAI code serveur (api/*) tourne dans le navigateur
       (sandbox-server.js, généré par scripts/build-sandbox-server.js) ;
     · Firebase est remplacé par une base locale (sandbox-db.js) ; les
       modèles de contrat réels y sont copiés en LECTURE SEULE à l'ouverture.
   Ce fichier garde ce qui n'existe pas dans le logiciel : les faux leads,
   le Meet, le téléphone du client (SMS / e-mails reçus), l'annuaire des
   entreprises simulé, les « webhooks » GoCardless et le bilan.

   RÈGLE ABSOLUE : rien de réel n'est déclenché. Aucune écriture Firestore,
   aucun SMS, e-mail, mandat ou prélèvement, aucun webhook Make, aucun accès
   AE Academy.

   Choix validés : 3 leads Elite (Self Booking intégral, No Booking 4×, un
   tiré au hasard), paiement conditionné à la signature, bilan, reset.
   Tarifs : miroir de AlteoreFlow.WIZARD_PRICING (alteore-flow.js). TVA
   20 % : le contrat Elite affiche « 12 000 € HT (soit 14 400 € TTC) ».
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var SBX_KEY = 'ambitio_sandbox_closer_v2';
  var TVA = 0.2;

  /* Miroir de WIZARD_PRICING (alteore-flow.js) — Elite + Business, la carte ①
     du close propose les deux comme en production. */
  var PRICING = {
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
  /* Miroir de COMM_RULES / PIF_BONUS (alteore-flow.js) — affichage seulement. */
  var COMM = {
    closing: { 'Elite': 800, 'BP 12': 500 },
    setting: { 'Elite': { nb: 300, sb: 150 }, 'BP 12': { nb: 250, sb: 125 } },
    pifBonus: { 'Elite': 100, 'BP 12': 100 }
  };

  /* L'équipe RÉELLE (_meta/team_members), lue en lecture seule à l'ouverture
     (sandbox-closer.js) puis posée par setTeam() : coachs proposés, setters
     des leads No Booking, annuaire des vraies pages. Valeurs ci-dessous =
     repli si la lecture échoue (09/10/2026). */
  var COACHS = [
    { slug: 'edouard', nom: 'Edouard' }, { slug: 'flore', nom: 'Flore' },
    { slug: 'thomas', nom: 'Thomas' }, { slug: 'jouffroyfarah', nom: 'Farah' }
  ];
  var TEAM = [];
  var SETTERS = [{ slug: 'elodie', name: 'Élodie' }];

  /* ═══ Outils ═══════════════════════════════════════════════════════════ */
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function euro(n) {
    var v = Math.round((Number(n) || 0) * 100) / 100;
    var s = v.toLocaleString('fr-FR', { minimumFractionDigits: v % 1 ? 2 : 0, maximumFractionDigits: 2 });
    return s.replace(/ | /g, ' ') + ' €';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function frDate(d) { d = d ? new Date(d) : new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear(); }
  function frTime(d) { d = d ? new Date(d) : new Date(); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function isoDay(d) { d = d ? new Date(d) : new Date(); return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function uid(p) {
    var s = '', c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    for (var i = 0; i < 10; i++) s += c.charAt(Math.floor(Math.random() * c.length));
    return (p || '') + s;
  }
  function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  /* 06 12 34 56 78 / +33 6 12… / 0033… → 612345678 : on compare les 9
     derniers chiffres, comme le ferait un humain. */
  function normPhone(s) { var d = digits(s); return d.length >= 9 ? d.slice(-9) : d; }
  function samePhone(a, b) { return !!a && !!b && normPhone(a).length === 9 && normPhone(a) === normPhone(b); }
  function normEmail(s) { return String(s || '').trim().toLowerCase(); }
  function sameEmail(a, b) { return !!normEmail(a) && normEmail(a) === normEmail(b); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }
  function sameName(a, b) { return !!fold(a) && fold(a) === fold(b); }
  function fmtPhone(e164) {
    var d = digits(e164);
    if (d.indexOf('33') === 0 && d.length === 11) d = '0' + d.slice(2);
    return d.replace(/(\d{2})(?=\d)/g, '$1 ');
  }
  function maskPhone(e164) { var f = fmtPhone(e164); return f.slice(0, 2) + ' •• •• •• ' + f.slice(-2); }

  /* SIREN/SIRET fictifs mais VALIDES (clé de Luhn) : la saisie manuelle de
     sign.html les contrôle, le bac à sable aussi. Préfixe 9 = jamais un
     vrai SIREN attribué à nos clients de démo. */
  function luhnOk(d) { var s = 0; for (var i = 0; i < d.length; i++) { var n = +d.charAt(d.length - 1 - i); if (i % 2) { n *= 2; if (n > 9) n -= 9; } s += n; } return s % 10 === 0; }
  function luhnComplete(base) { for (var k = 0; k < 10; k++) { if (luhnOk(base + k)) return base + k; } return base + '0'; }
  function fakeSiret() {
    var b = '9' + String(Math.floor(10000000 + Math.random() * 89999999)).slice(0, 7);
    var siren = luhnComplete(b);
    var nic = '0001';
    return luhnComplete(siren + nic);
  }
  function siretOk(s) { s = digits(s); return s.length === 14 && luhnOk(s) && luhnOk(s.slice(0, 9)); }
  function ibanOk(s) {
    var v = String(s || '').replace(/\s+/g, '').toUpperCase();
    if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(v)) return false;
    v = v.slice(4) + v.slice(0, 4);
    var r = 0;
    for (var i = 0; i < v.length; i++) {
      var ch = v.charAt(i), n = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
      for (var j = 0; j < n.length; j++) r = (r * 10 + (+n.charAt(j))) % 97;
    }
    return r === 1;
  }

  /* ═══ Scénarios ════════════════════════════════════════════════════════ */
  var POOL = [
    { prenom: 'Sophie', nom: 'Lefèvre', ent: 'Lefèvre Optique', forme: 'SARL', secteur: 'Optique — 3 magasins', ca: '1,1 M€', ville: 'Toulon', cp: '83000', rue: '14 boulevard de Strasbourg', defi: 'Mes trois magasins tournent sur moi. Dès que je pars une semaine, le CA baisse.' },
    { prenom: 'Karim', nom: 'Benali', ent: 'Benali Transports', forme: 'SAS', secteur: 'Transport & logistique', ca: '2,3 M€', ville: 'Marseille', cp: '13015', rue: '42 chemin de la Madrague-Ville', defi: 'J\'ai 18 chauffeurs, aucun process écrit, et je passe mes soirées sur les plannings.' },
    { prenom: 'Aurélie', nom: 'Fontaine', ent: 'Studio Fontaine', forme: 'SASU', secteur: 'Agence de communication', ca: '420 k€', ville: 'Lyon', cp: '69003', rue: '8 rue Paul Bert', defi: 'Je vends bien mais je n\'arrive pas à faire monter mes prix, la marge fond.' },
    { prenom: 'Nicolas', nom: 'Garnier', ent: 'Garnier Plomberie Chauffage', forme: 'SARL', secteur: 'Plomberie — chauffage', ca: '760 k€', ville: 'Nice', cp: '06200', rue: '3 avenue Sainte-Marguerite', defi: 'Je suis encore sur les chantiers 4 jours sur 5, je veux devenir chef d\'entreprise.' },
    { prenom: 'Élise', nom: 'Moreau', ent: 'Moreau Immobilier', forme: 'SAS', secteur: 'Agence immobilière', ca: '950 k€', ville: 'Aix-en-Provence', cp: '13100', rue: '27 cours Mirabeau', defi: 'Mes négociateurs partent au bout d\'un an, je recrute en permanence.' }
  ];
  var CO_POOL = [
    { prenom: 'Thierry', nom: 'Vasseur', qualite: 'Co-gérant' },
    { prenom: 'Laura', nom: 'Perrin', qualite: 'Directeur général délégué' },
    { prenom: 'Mathieu', nom: 'Roux', qualite: 'Associé' }
  ];

  function slugMail(s) { return fold(s).replace(/ /g, '.'); }
  function slugDom(s) { return fold(s).replace(/ /g, '-'); }

  function makeLead(o) {
    var siret = fakeSiret();
    var id = 'L' + uid();
    var now = Date.now();
    var dom = slugDom(o.ent) + '.example';
    var lead = {
      id: id,
      prenom: o.prenom, nomFamille: o.nom, nom: o.prenom + ' ' + o.nom, entreprise: o.ent,
      email: slugMail(o.prenom) + '@' + dom,
      telephone: o.tel,
      type: o.sb ? 'self_booking' : 'vsl_elite',
      sb: o.sb,
      status: o.sb ? 'rdv_self_booking' : 'rdv_pose',
      stage: o.sb ? 'rdv_self_booking' : 'rdv_confirmes',
      setter: o.sb ? null : (o.setter || SETTERS[0]),
      source: o.sb ? 'VSL Élite — page de réservation' : 'Pub Meta — VSL Élite',
      utm: o.sb ? 'utm_source=youtube · utm_campaign=elite_vsl' : 'utm_source=facebook · utm_campaign=elite_leadform',
      tunnel: o.sb ? 'Tunnel Élite — Self Booking' : 'Tunnel Élite — Lead form',
      secteur: o.secteur, ca: o.ca, defi: o.defi,
      dispo: 'Prêt à démarrer ce mois-ci', timeline: 'Immédiat',
      leadScore: o.score || 4,
      createdAt: now - (o.sb ? 2 : 5) * 86400000,
      company: {
        name: o.ent.toUpperCase(), forme: o.forme, legalFormLabel: o.forme, creation: o.creation || '2015-03-02',
        siret: siret, siren: siret.slice(0, 9),
        address: { line1: o.rue, line2: '', postalCode: o.cp, city: o.ville.toUpperCase() },
        dirigeants: [{ prenoms: o.prenom, nom: o.nom.toUpperCase(), qualite: o.forme === 'SARL' ? 'Gérant' : 'Président' }]
      },
      quiz: [
        { q: 'Votre chiffre d\'affaires annuel ?', a: o.ca },
        { q: 'Combien d\'heures travaillez-vous par semaine ?', a: o.heures || '60 h et plus' },
        { q: 'Votre plus gros blocage aujourd\'hui ?', a: o.defi },
        { q: 'Prêt(e) à investir dans un accompagnement ?', a: 'Oui, si le programme est adapté' }
      ],
      notes: o.sb ? [] : [{ at: now - 4 * 86400000, by: (o.setter || SETTERS[0]).name, txt: 'SET OK — dirigeant motivé, budget validé au téléphone. RDV closing posé.' }],
      rdv: {
        id: 'B' + uid(), date: isoDay(now), time: frTime(now - 3 * 60000),
        typeName: o.sb ? 'Appel découverte Élite' : 'RDV Closing Élite', personName: '',
        past: false, outcome: null, outcomeNote: '',
        meetLink: 'https://meet.google.com/' + uid('').toLowerCase().slice(0, 3) + '-' + uid('').toLowerCase().slice(0, 4) + '-' + uid('').toLowerCase().slice(0, 3)
      },
      scn: {
        offre: 'Elite', paiement: o.paiement, nbMens: o.paiement === 'mensualise' ? o.nbMens : null,
        cosigner: o.cosigner ? {
          prenom: o.cosigner.prenom, nom: o.cosigner.nom, name: o.cosigner.prenom + ' ' + o.cosigner.nom,
          email: slugMail(o.cosigner.prenom) + '@' + dom, telephone: o.cosigner.tel, qualite: o.cosigner.qualite
        } : null,
        heures: o.heures || '60 h et plus'
      },
      call: { done: false, startedAt: null, endedAt: null, lines: [] },
      close: null,
      timeline: [{ at: now - (o.sb ? 2 : 5) * 86400000, txt: o.sb ? '📆 RDV pris en autonomie (Self Booking)' : '🎯 SET par ' + (o.setter || SETTERS[0]).name + ' — RDV posé' }]
    };
    lead.rdv.personName = 'Toi';
    lead.call.lines = callScript(lead);
    return lead;
  }

  function scenarios() {
    var A = makeLead({
      prenom: 'Camille', nom: 'Rousseau', ent: 'Atelier Rousseau Paysage', forme: 'SARL',
      secteur: 'Paysagisme — 12 salariés', ca: '780 k€', ville: 'Fréjus', cp: '83600', rue: '112 avenue de Verdun',
      defi: 'Je travaille 70 h par semaine et je n\'arrive plus à déléguer. Mes chefs d\'équipe m\'appellent pour tout.',
      heures: '70 h', tel: '+33600000101', sb: true, paiement: 'pif', score: 5
    });
    var B = makeLead({
      prenom: 'Julien', nom: 'Marchand', ent: 'Marchand Rénovation', forme: 'SAS',
      secteur: 'Rénovation BTP — 25 salariés', ca: '1,6 M€', ville: 'Draguignan', cp: '83300', rue: '5 boulevard Gabriel Péri',
      defi: 'On fait du chiffre mais la marge est à 4 %. Je ne sais pas où part l\'argent.',
      heures: '60 h', tel: '+33600000202', sb: false, paiement: 'mensualise', nbMens: 4, score: 4
    });
    /* Le troisième : tiré au hasard à chaque réinitialisation — Self ou No
       Booking, intégral ou mensualisé (2× ou 4×, les deux suggestions Elite),
       avec un associé co-signataire une fois sur deux. */
    var p = pick(POOL), co = Math.random() < 0.5 ? pick(CO_POOL) : null;
    var pay = Math.random() < 0.5 ? 'pif' : 'mensualise';
    var C = makeLead({
      prenom: p.prenom, nom: p.nom, ent: p.ent, forme: co ? (p.forme === 'SASU' ? 'SAS' : p.forme) : p.forme,
      secteur: p.secteur, ca: p.ca, ville: p.ville, cp: p.cp, rue: p.rue, defi: p.defi,
      tel: '+33600000303', sb: Math.random() < 0.5, setter: pick(SETTERS), paiement: pay, nbMens: pay === 'mensualise' ? pick([2, 4]) : null,
      cosigner: co ? { prenom: co.prenom, nom: co.nom, qualite: co.qualite, tel: '+33600000304' } : null, score: 3
    });
    C.random = true;
    return [A, B, C];
  }

  /* Ce que dit le prospect pendant le Meet. Les conditions du close (mode de
     paiement, associé à faire signer, coordonnées) ne sont données QUE là :
     le closer doit les retenir et les reporter lui-même, comme en vrai. */
  function callScript(l) {
    var s = l.scn, P = l.prenom, L = [];
    L.push({ who: 'p', t: 'Bonjour ! Oui, je vous entends bien.' });
    L.push({ who: 'p', t: 'Alors pour vous situer : ' + l.entreprise + ', ' + l.secteur.charAt(0).toLowerCase() + l.secteur.slice(1) + ', on fait ' + l.ca + ' de chiffre.' });
    L.push({ who: 'p', t: l.defi });
    L.push({ who: 'p', t: 'Concrètement je suis à ' + s.heures + ' par semaine. Ma famille ne me voit plus.' });
    L.push({ who: 'c', t: '(Tu présentes le programme Elite Phénix : 6 mois, un coach référent, une séance par semaine.)' });
    L.push({ who: 'p', t: 'D\'accord… et ça coûte combien exactement ?' });
    L.push({ who: 'c', t: '(Tu annonces : ' + euro(PRICING.Elite.pif.contracte) + ' HT en une fois, ou ' + euro(PRICING.Elite.mensualise.contracte) + ' HT en paiement échelonné.)' });
    if (s.paiement === 'pif') {
      L.push({ who: 'p', t: 'Je préfère régler en une seule fois, autant profiter du meilleur tarif. Ça me fait donc ' + euro(PRICING.Elite.pif.contracte) + ' HT.' });
    } else {
      L.push({ who: 'p', t: 'En une fois ça fait beaucoup d\'un coup pour ma trésorerie. Je pars sur le paiement échelonné, en ' + s.nbMens + ' mensualités.' });
    }
    if (s.cosigner) {
      L.push({ who: 'p', t: 'Par contre je ne signe jamais rien seul : mon associé, ' + s.cosigner.name + ' (' + s.cosigner.qualite.toLowerCase() + '), doit signer le contrat aussi.' });
      L.push({ who: 'p', t: 'Notez ses coordonnées : ' + s.cosigner.email + ', et son portable, le ' + fmtPhone(s.cosigner.telephone) + '.' });
    }
    L.push({ who: 'p', t: 'C\'est bon pour moi, on y va. Envoyez-moi le contrat, je le signe pendant qu\'on est en ligne.' });
    L.push({ who: 'p', t: 'Mon portable c\'est toujours le ' + fmtPhone(l.telephone) + ', et mon mail ' + l.email + '.' });
    return L;
  }

  /* ═══ État propre au bac à sable (leads, téléphone) ═══════════════════
     Les contrats et paiements, eux, vivent dans la fausse base, écrits par
     les vraies pages et le vrai code serveur. */
  /* L'équipe réelle : coachs actifs, setters actifs. Les leads No Booking
     déjà tirés dont le setter n'est plus dans l'équipe sont réattribués. */
  function setTeam(list) {
    list = (list || []).filter(function (m) { return m && m.slug; });
    if (!list.length) return;
    TEAM = list;
    var alive = list.filter(function (m) { return m.active !== false && !m.archivedAt; });
    var co = alive.filter(function (m) { return m.role === 'coach'; }).map(function (m) { return { slug: m.slug, nom: m.nom || m.shortName || m.displayName || m.slug }; });
    if (co.length) { COACHS = co; window.SBX.COACHS = co; }
    var se = alive.filter(function (m) { return /setter/.test(m.role || ''); }).map(function (m) { return { slug: m.slug, name: m.shortName || m.displayName || m.slug }; });
    se.sort(function (a, b) { return a.slug === 'elodie' ? -1 : (b.slug === 'elodie' ? 1 : 0); });
    if (se.length) SETTERS = se;
    update(function (st) {
      st.leads.forEach(function (l) {
        if (!l.setter || SETTERS.some(function (x) { return x.slug === l.setter.slug; })) return;
        var old = l.setter.name, nw = SETTERS[0];
        l.setter = nw;
        l.notes.forEach(function (n) { if (n.by === old) n.by = nw.name; });
        l.timeline.forEach(function (t) { t.txt = String(t.txt).split(old).join(nw.name); });
      });
    });
  }
  /* Les vrais tarifs et commissions (alteore-flow.js, lu tel quel). */
  function setPricing(p) { if (p && p.Elite && p.Business) { PRICING = p; window.SBX.PRICING = p; } }

  function fresh(prev) {
    return { v: 2, createdAt: Date.now(), welcomed: !!(prev && prev.welcomed), leads: scenarios(), inbox: [], outbox: [], log: [] };
  }
  function load() {
    var st = null;
    try { st = JSON.parse(localStorage.getItem(SBX_KEY) || 'null'); } catch (e) { st = null; }
    if (!st || st.v !== 2 || !st.leads) { st = fresh(st); save(st); }
    return st;
  }
  function save(st) {
    try { localStorage.setItem(SBX_KEY, JSON.stringify(st)); } catch (e) { if (window.console) console.warn('[sandbox] sauvegarde impossible', e && e.message); }
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](st, true); } catch (x) {} }
  }
  var listeners = [];
  function onChange(fn) { listeners.push(fn); }
  window.addEventListener('storage', function (e) {
    if (e.key !== SBX_KEY) return;
    var st = load();
    for (var i = 0; i < listeners.length; i++) { try { listeners[i](st, false); } catch (x) {} }
  });
  function update(fn) { var st = load(); var r = fn(st); save(st); return r; }

  function leadById(st, id) { for (var i = 0; i < st.leads.length; i++) if (st.leads[i].id === id) return st.leads[i]; return null; }
  function log(st, leadId, k, txt) {
    st.log.push({ at: Date.now(), leadId: leadId, k: k, txt: txt || '' });
    var l = leadById(st, leadId);
    if (l && txt) l.timeline.push({ at: Date.now(), txt: txt });
  }

  /* ═══ La fausse base ══════════════════════════════════════════════════ */
  function db() { return window.top.__SBX_STORE; }
  function dbList(col, field, value) {
    return db().query({ col: col, filters: field ? [[field, '==', value]] : [], orders: [], limit: null, limitToLast: false })
      .map(function (r) { r.d.id = r.id; return r.d; });
  }
  function tsMs(v) { return v && v.__ts !== undefined ? v.__ts : (typeof v === 'string' ? Date.parse(v) : (typeof v === 'number' ? v : 0)); }
  function leadSigs(leadId) { return dbList('signature_requests', 'leadId', leadId).filter(function (r) { return r.status !== 'cancelled'; }).sort(function (a, b) { return tsMs(a.createdAt) - tsMs(b.createdAt); }); }
  function leadPays(leadId) { return dbList('payments', 'leadId', leadId).filter(function (p) { return p.status !== 'cancelled'; }).sort(function (a, b) { return tsMs(a.createdAt) - tsMs(b.createdAt); }); }

  /* Ce que la base doit contenir pour que les vraies pages et le vrai code
     serveur fonctionnent : le compte, l'annuaire de l'équipe, la config
     télécom (factice), et les fiches leads. */
  function seed(identity) {
    var st = load(), A = window.SBXDB.encode, w = [];
    var I = identity;
    w.push({ op: 'set', path: 'users/' + I.uid, data: A({ email: I.email, name: I.name, displayName: I.name, role: I.role, signaturesAccess: true, paymentsAccess: true, paymentsTrigger: true, formationsAccess: false }) });
    /* L'annuaire réel si on l'a lu, sinon un annuaire minimal. On s'assure
       que le compte connecté y figure (les vraies pages le cherchent). */
    var members = TEAM.length ? JSON.parse(JSON.stringify(TEAM)) : SETTERS.map(function (x) { return { slug: x.slug, displayName: x.name, shortName: x.name, role: 'setter', active: true }; })
      .concat(COACHS.map(function (c) { return { slug: c.slug, displayName: c.nom, shortName: c.nom, nom: c.nom, role: 'coach', active: true }; }));
    if (!members.some(function (m) { return m.firebaseUid === I.uid; })) members.unshift({ slug: 'moi', firebaseUid: I.uid, displayName: I.name, shortName: String(I.name).split(' ')[0], role: I.role === 'admin' ? 'admin' : 'closer', active: true, color: '#60a5fa' });
    w.push({ op: 'set', path: '_meta/team_members', data: A({ members: members }) });
    w.push({ op: 'set', path: '_config/telco_credentials', data: A({ twilio: { accountSid: 'AC-bac-a-sable', authToken: 'bac-a-sable', smsFromNumber: '+33939240397' }, ringover: { apiKey: 'bac-a-sable', fromNumber: '+33939240397' } }) });
    st.leads.forEach(function (l) {
      w.push({ op: 'set', merge: true, path: 'leads/' + l.id, data: A({ nom: l.nom, prenom: l.prenom, email: l.email, telephone: l.telephone, entreprise: l.entreprise, type: l.type, status: l.status, stage: l.stage, source: l.source, createdAt: new Date(l.createdAt) }) });
    });
    db().commit(w);
  }
  /* Efface de la base tout ce qui concerne un lead (ou tout). */
  function wipeLead(leadId) {
    var reqIds = {}, payIds = {}, gcIds = {};
    dbList('signature_requests', 'leadId', leadId).forEach(function (r) { reqIds[r.id] = 1; });
    dbList('payments', 'leadId', leadId).forEach(function (p) { payIds[p.id] = 1; ['gcBillingRequestId', 'gcMandateId', 'gcCustomerId', 'gcPaymentId', 'gcSubscriptionId'].forEach(function (k) { if (p[k]) gcIds[p[k]] = 1; }); });
    dbList('_sandbox_gc').forEach(function (g) { if (g.metadata && payIds[g.metadata.paymentId]) gcIds[g.id] = 1; if (g.links && gcIds[g.links.billing_request]) gcIds[g.id] = 1; });
    db().wipe(function (p) {
      var s = p.split('/');
      if (s[0] === 'signature_requests' && reqIds[s[1]]) return true;
      if (s[0] === 'signature_otp' && reqIds[s[1]]) return true;
      if (s[0] === 'payments' && payIds[s[1]]) return true;
      if (s[0] === '_sandbox_gc' && gcIds[s[1]]) return true;
      if (s[0] === 'leads' && s[1] === leadId) return true;
      return false;
    });
  }

  function resetAll(identity) {
    var prev = load();
    db().wipe();
    save(fresh(prev));
    seed(identity);
  }
  /* Recommencer UN lead : même profil, tout le reste effacé (contrats,
     paiements, messages reçus). Le lead tiré au hasard garde son tirage —
     c'est « Tout réinitialiser » qui en tire un nouveau. */
  function resetLead(leadId, identity) {
    wipeLead(leadId);
    update(function (st) {
      var o = leadById(st, leadId); if (!o) return;
      o.status = o.sb ? 'rdv_self_booking' : 'rdv_pose';
      o.stage = o.sb ? 'rdv_self_booking' : 'rdv_confirmes';
      o.rdv.past = false; o.rdv.outcome = null; o.rdv.outcomeNote = '';
      o.rdv.time = frTime(Date.now() - 3 * 60000); o.rdv.date = isoDay();
      o.call = { done: false, startedAt: null, endedAt: null, lines: callScript(o) };
      o.close = null; o.isClient = false; o.bilanShown = false;
      o.notes = o.sb ? [] : [o.notes[0]];
      o.timeline = [o.timeline[0]];
      st.inbox = st.inbox.filter(function (m) { return m.leadId !== leadId; });
      st.outbox = st.outbox.filter(function (m) { return m.leadId !== leadId; });
      st.log = st.log.filter(function (x) { return x.leadId !== leadId; });
    });
    seed(identity);
  }

  /* ═══ Le téléphone du client ═════════════════════════════════════════
     Tous les « contacts » joignables : le dirigeant de chaque lead et, s'il
     existe, son associé. Un SMS envoyé à un numéro qui ne correspond à
     personne n'arrive nulle part — exactement comme en vrai. */
  function contacts(st) {
    var out = [];
    st.leads.forEach(function (l) {
      out.push({ key: l.id + ':main', leadId: l.id, name: l.nom, prenom: l.prenom, telephone: l.telephone, email: l.email, role: 'Client' });
      if (l.scn.cosigner) out.push({ key: l.id + ':co', leadId: l.id, name: l.scn.cosigner.name, prenom: l.scn.cosigner.prenom, telephone: l.scn.cosigner.telephone, email: l.scn.cosigner.email, role: 'Associé(e)' });
    });
    return out;
  }
  function findContact(st, phone, email) {
    var cs = contacts(st);
    for (var i = 0; i < cs.length; i++) {
      if (phone && samePhone(phone, cs[i].telephone)) return cs[i];
      if (email && sameEmail(email, cs[i].email)) return cs[i];
    }
    return null;
  }
  /* Point d'arrivée de TOUT ce que le faux serveur « envoie » (Twilio,
     Ringover, Gmail simulés). */
  function deliver(o) {
    var hit = null;
    update(function (st) {
      var c = findContact(st, o.channel === 'sms' ? o.to : null, o.channel === 'email' ? o.to : null);
      st.outbox.push({ at: Date.now(), channel: o.channel, to: String(o.to || ''), subject: o.subject || '', delivered: !!c, leadId: c ? c.leadId : null });
      if (!c) return;
      hit = c;
      st.inbox.push({
        id: uid('M'), contactKey: c.key, leadId: c.leadId, channel: o.channel, to: o.to, from: o.from || '',
        subject: o.subject || '', text: o.text || '', url: o.url || '', attachments: o.attachments || [], at: Date.now(), read: false
      });
    });
    return hit;
  }
  /* Où mène un lien reçu par le client, dans le bac à sable. */
  function routeLink(url) {
    var u;
    try { u = new URL(url); } catch (e) { return null; }
    if (/\/sign\.html$/.test(u.pathname) && u.searchParams.get('t')) return { src: 'sandbox-frame.html?page=sign.html&t=' + encodeURIComponent(u.searchParams.get('t')), label: 'team.alteore.com/sign.html?t=' + u.searchParams.get('t') };
    if (u.hostname === 'pay.gocardless.com' && u.searchParams.get('id')) return { src: 'sandbox-gc.html?flow=' + encodeURIComponent(u.searchParams.get('id')), label: u.hostname + u.pathname + '?id=' + u.searchParams.get('id') };
    return null;
  }

  /* ═══ Annuaire des entreprises simulé (format de l'API DINUM) ═════════ */
  var LEGAL_CODE = { SARL: '5499', SAS: '5710', SASU: '5720' };
  function registry(q) {
    var st = load(), d = digits(q), fq = fold(q), out = [];
    st.leads.forEach(function (l) {
      var c = l.company;
      var hit = (d.length >= 9 && (c.siret.indexOf(d) === 0 || c.siren === d.slice(0, 9))) || (fq.length >= 3 && fold(c.name).indexOf(fq) >= 0);
      if (!hit) return;
      var dir = [{ type_dirigeant: 'personne physique', nom: l.nomFamille.toUpperCase(), prenoms: l.prenom, qualite: c.forme === 'SARL' ? 'Gérant' : 'Président' }];
      if (l.scn.cosigner) dir.push({ type_dirigeant: 'personne physique', nom: l.scn.cosigner.nom.toUpperCase(), prenoms: l.scn.cosigner.prenom, qualite: l.scn.cosigner.qualite });
      out.push({
        siren: c.siren, nom_complet: c.name, nom_raison_sociale: c.name, nature_juridique: LEGAL_CODE[c.forme] || '5499',
        activite_principale: '70.22Z', libelle_activite_principale: l.secteur, date_creation: c.creation || '2015-03-02',
        etat_administratif: 'A', dirigeants: dir,
        siege: { siret: c.siret, adresse: c.address.line1 + ' ' + c.address.postalCode + ' ' + c.address.city, code_postal: c.address.postalCode, libelle_commune: c.address.city, etat_administratif: 'A' }
      });
    });
    return out;
  }

  /* ═══ Attendus d'un lead (ce que le Meet a révélé) ═════════════════════ */
  function expected(l) {
    var s = l.scn, pc = PRICING.Elite[s.paiement];
    var ttc = Math.round(pc.contracte * (1 + TVA));
    return {
      offre: 'Elite', paiement: s.paiement, nbMens: s.nbMens,
      ht: pc.contracte, ttc: ttc,
      mensTTC: s.nbMens ? Math.round(ttc / s.nbMens * 100) / 100 : null,
      encaisseHT: s.paiement === 'pif' ? pc.contracte : Math.round(pc.contracte / s.nbMens),
      booking: l.sb ? 'sb' : 'nb', cosigner: s.cosigner
    };
  }

  /* Ce que le conseiller a rempli à l'envoi, quel que soit le format du
     modèle : contrat de l'atelier (variables) ou modèle PDF (cases de
     l'équipe + textes). → { formule: 'pif'|'mensualise'|null, nbMens, lignes } */
  function readPrefill(sig) {
    var pre = sig.prefill || {}, web = sig.webSnapshot || {}, out = { formule: null, nbMens: null, lignes: [] };
    var tpl = db().read('signature_templates/' + sig.templateId) || {};
    var hints = web.fieldHints || (tpl.web && tpl.web.fieldHints) || {};
    var fields = (sig.fields && sig.fields.length ? sig.fields : tpl.fields) || [];
    var vars = web.variables || (tpl.web && tpl.web.variables) || [];
    function labelOf(id) {
      if (hints[id] && hints[id].label) return hints[id].label;
      for (var i = 0; i < fields.length; i++) if (fields[i].id === id) return fields[i].label || id;
      for (var j = 0; j < vars.length; j++) if (vars[j].key === id) return vars[j].label || id;
      return id;
    }
    function formuleFrom(txt) { txt = fold(txt); if (/integral|une fois|comptant|pif/.test(txt)) return 'pif'; if (/echelonn|mensualis|plusieurs fois/.test(txt)) return 'mensualise'; return null; }
    Object.keys(pre).forEach(function (k) {
      var v = pre[k], lab = labelOf(k), def = null;
      for (var j = 0; j < vars.length; j++) if (vars[j].key === k) def = vars[j];
      if (def && def.type === 'choice') {
        var opt = (def.options || []).filter(function (o) { return o.value === v; })[0];
        var f = formuleFrom((opt && opt.label) || v); if (f) out.formule = f;
        out.lignes.push(lab + ' : ' + ((opt && opt.label) || v));
      } else if (v === true) {
        var f2 = formuleFrom(lab); if (f2) out.formule = f2;
        out.lignes.push('☑ ' + lab);
      } else if (v !== false && v !== '' && v != null) {
        if (/mensualit/i.test(lab) || /mensualit/i.test(k)) { var n = parseInt(digits(v), 10); if (n) out.nbMens = n; }
        out.lignes.push(lab + ' : ' + v);
      }
    });
    return out;
  }

  /* ═══ BILAN ════════════════════════════════════════════════════════════
     Lit ce que les VRAIES pages ont écrit (signature_requests, payments) et
     le compare à ce que le client a demandé pendant le Meet. ok : true /
     false / null (pas encore fait) / 'warn'. */
  function bilan(leadId) {
    var st = load(), l = leadById(st, leadId); if (!l) return null;
    var E = expected(l), items = [];
    function add(ok, label, detail, w) { items.push({ ok: ok, label: label, detail: detail || '', w: w || 1 }); }

    var sigs = leadSigs(leadId), signed = null;
    sigs.forEach(function (s) { if (s.status === 'signed' && !signed) signed = s; });
    var sig = signed || sigs[sigs.length - 1] || null;
    var pays = leadPays(leadId), pay = pays[pays.length - 1] || null;
    var signedAt = signed ? (tsMs(signed.signedAt) || Date.parse(signed.signedAtIso || '') || 0) : 0;

    add(l.call.done ? true : null, 'Meet mené avec le prospect', l.call.done ? '' : 'Rejoins le RDV avec 📹 Meet.');
    if (!l.rdv.outcome) add(null, 'Résultat du RDV saisi', 'Après l\'appel : 🎯 Résultat sur le RDV.');
    else add(l.rdv.outcome === 'close', 'Résultat du RDV saisi', l.rdv.outcome === 'close' ? '' : 'Le RDV est statué « ' + l.rdv.outcome + ' » alors que le client a dit oui : il fallait « 🏆 Close ».');

    if (!sig) add(null, 'Contrat envoyé', 'Depuis la fiche : 📝 Signatures → le modèle Elite → 📨 Envoyer.');
    else {
      var tpl = db().read('signature_templates/' + sig.templateId) || {};
      var tplTxt = [sig.templateName, tpl.name, tpl.web && tpl.web.title, tpl.web && tpl.web.subtitle, sig.webSnapshot && sig.webSnapshot.subtitle].join(' ');
      var elite = /elite|ep\s?12/i.test(tplTxt);
      add(elite, 'Bon modèle de contrat', elite ? '« ' + sig.templateName + ' »' : 'Envoyé : « ' + sig.templateName + ' » — le client a acheté l\'accompagnement Elite.', 2);
      var s1 = (sig.signers || [])[0] || {}, errs = [];
      if (!sameName(s1.name, l.nom)) errs.push('nom « ' + (s1.name || '—') + ' »');
      if (!sameEmail(s1.email, l.email)) errs.push('e-mail « ' + (s1.email || '—') + ' » (attendu ' + l.email + ')');
      if (!samePhone(s1.phone, l.telephone)) errs.push('téléphone « ' + (s1.phone || '—') + ' » (attendu ' + fmtPhone(l.telephone) + ') — le code SMS ne peut pas arriver');
      add(!errs.length, 'Signataire 1 correct', errs.length ? 'Erreur sur : ' + errs.join(' · ') : '', 2);
      var s2 = (sig.signers || [])[1] || null;
      if (E.cosigner) {
        if (!s2) add(false, 'Second signataire (associé)', 'Le client a demandé que ' + E.cosigner.name + ' signe aussi : il fallait cocher « 👥 Ajouter un second signataire ».', 2);
        else {
          var e2 = [];
          if (!sameName(s2.name, E.cosigner.name)) e2.push('nom');
          if (!sameEmail(s2.email, E.cosigner.email)) e2.push('e-mail');
          if (!samePhone(s2.phone, E.cosigner.telephone)) e2.push('téléphone');
          add(!e2.length, 'Second signataire (associé)', e2.length ? 'Coordonnées de ' + E.cosigner.name + ' erronées : ' + e2.join(', ') + '.' : '', 2);
        }
      } else if (s2) add(false, 'Pas de second signataire', 'Un second signataire a été ajouté alors que le client signe seul.');
      if (elite) {
        var P = readPrefill(sig);
        if (!P.formule) add(false, 'Formule de paiement dans le contrat', 'Aucune formule retenue à l\'envoi.' + (P.lignes.length ? ' Saisi : ' + P.lignes.join(' · ') : ''), 2);
        else add(P.formule === E.paiement, 'Formule de paiement dans le contrat', P.formule === E.paiement ? (P.formule === 'pif' ? 'Paiement intégral' : 'Paiement échelonné') : 'Le contrat dit « ' + (P.formule === 'pif' ? 'paiement intégral' : 'paiement échelonné') + ' » — le client a choisi ' + (E.paiement === 'pif' ? 'de payer en une fois.' : 'le paiement échelonné.'), 2);
        if (E.paiement === 'mensualise') add(P.nbMens === E.nbMens, 'Nombre de mensualités dans le contrat', P.nbMens === E.nbMens ? E.nbMens + ' mensualités.' : (P.nbMens ? 'Saisi ' + P.nbMens : 'Non renseigné') + ' — le client a choisi ' + E.nbMens + ' mensualités.');
      }
    }
    add(signed ? true : null, 'Contrat signé par ' + (E.cosigner ? 'les deux signataires' : 'le client'), signed ? (signed.certificateId ? 'Réf. ' + signed.certificateId : '') : (sig ? 'Fais signer le client : 📱 Téléphone du client.' : ''), 2);

    if (!pay) add(null, 'Paiement GoCardless créé', signed ? 'Fiche → 💳 Paiements → + Nouveau paiement.' : 'Possible uniquement après la signature du contrat.');
    else {
      var typeOk = (E.paiement === 'pif' && pay.type === 'full') || (E.paiement === 'mensualise' && pay.type === 'installments');
      add(typeOk, 'Type de paiement', typeOk ? (pay.type === 'full' ? '💳 Paiement intégral' : '📅 Paiement fractionné') : 'Choisi « ' + (pay.type === 'full' ? 'Paiement intégral' : 'Paiement fractionné') + ' » — le client a choisi ' + (E.paiement === 'pif' ? 'de payer en une fois.' : 'le paiement échelonné.'), 2);
      var amtOk = Math.abs(Number(pay.totalAmount) - E.ttc) < 0.01;
      var amtDetail = amtOk ? euro(pay.totalAmount) + ' TTC' : 'Saisi ' + euro(pay.totalAmount) + ' — attendu ' + euro(E.ttc) + ' TTC (' + euro(E.ht) + ' HT + TVA 20 %).';
      if (!amtOk && Math.abs(Number(pay.totalAmount) - E.ht) < 0.01) amtDetail += ' Erreur classique : le montant GoCardless est en TTC, pas en HT.';
      add(amtOk, 'Montant total TTC', amtDetail, 3);
      if (E.paiement === 'mensualise' && pay.type === 'installments') {
        add(Number(pay.installmentsCount) === E.nbMens, 'Nombre de mensualités GoCardless', Number(pay.installmentsCount) === E.nbMens ? E.nbMens + ' × ' + euro(pay.installmentAmount) : 'Saisi ' + pay.installmentsCount + ' — le client a choisi ' + E.nbMens + ' mensualités (' + E.nbMens + ' × ' + euro(E.mensTTC) + ' TTC).', 2);
      }
      if (signedAt && tsMs(pay.createdAt) && tsMs(pay.createdAt) < signedAt) add(false, 'Paiement créé après la signature', 'Le paiement a été créé avant que le contrat soit signé.');
      if (!pay.mandateSentVia) add(pay.gcBillingRequestFlowUrl ? null : null, 'Lien mandat envoyé au client', pay.gcBillingRequestFlowUrl ? 'Envoie le lien par 📱 SMS ou 📧 e-mail.' : 'Génère le lien mandat.');
      else {
        var okDest = pay.mandateSentVia === 'sms' ? samePhone(pay.leadPhone, l.telephone) : sameEmail(pay.leadEmail, l.email);
        add(okDest, 'Lien mandat envoyé au client', okDest ? 'Envoyé par ' + (pay.mandateSentVia === 'sms' ? 'SMS' : 'e-mail') + '.' : 'Envoyé à « ' + (pay.mandateSentVia === 'sms' ? pay.leadPhone : pay.leadEmail) + ' », qui n\'est pas le client : corrige le paiement.');
      }
      add(pay.gcMandateId && /mandate_active|active|completed/.test(pay.status || '') ? true : null, 'Mandat SEPA actif', '');
      add(pay.gcPaymentId || pay.gcSubscriptionId ? true : null, 'Prélèvement déclenché', pay.status === 'mandate_active' ? 'Clique 🚀 Déclencher le prélèvement.' : '');
    }

    var c = l.close;
    if (!c) add(null, 'Close confirmé (cartes du Close)', 'RDV → 🎯 Résultat → 🏆 Close, ou statut 🏆 Closing.');
    else {
      add(c.contrat === 'Elite', 'Carte ① — type de contrat', c.contrat === 'Elite' ? '👑 Elite' : 'Déclaré « ' + c.contrat + ' » au lieu d\'Elite : les commissions seraient fausses.', 2);
      add(c.paiement === E.paiement, 'Carte ② — paiement', c.paiement === E.paiement ? (c.paiement === 'pif' ? '💎 PIF' : '📅 MENS') : 'Déclaré « ' + (c.paiement === 'pif' ? 'PIF' : 'MENS') + ' » — le client a choisi ' + (E.paiement === 'pif' ? 'le paiement intégral.' : 'le paiement mensualisé.'));
      add(c.booking === E.booking, 'Carte ③ — booking', c.booking === E.booking ? (c.booking === 'sb' ? '🔗 Self Booking' : '📞 No Booking') : 'Déclaré « ' + (c.booking === 'sb' ? 'Self Booking' : 'No Booking') + ' » — ce lead ' + (E.booking === 'sb' ? 'a pris son RDV seul (Self Booking).' : 'a été travaillé par Élodie (No Booking) : la commission setting serait fausse.'), 2);
      add(c.coachNom ? true : 'warn', 'Carte ④ — coach référent', c.coachNom ? '🎓 ' + c.coachNom : '« Décider plus tard » : autorisé, mais le coach n\'est pas prévenu et le groupe de suivi attend.');
      var encOk = Math.abs(Number(c.encaisse) - E.encaisseHT) < 0.01;
      add(encOk, 'Carte ⑤ — encaissé à la signature', encOk ? euro(c.encaisse) + ' HT' : 'Déclaré ' + euro(c.encaisse) + ' — attendu ' + euro(E.encaisseHT) + ' HT (' + (E.paiement === 'pif' ? 'la totalité' : '1 mensualité sur ' + E.nbMens) + '). Ce montant est en HT, contrairement à GoCardless.');
      if (!signed || (signedAt && c.at < signedAt)) add(false, 'Ordre du parcours', 'Close confirmé AVANT la signature du contrat. La carte ① dit « contrat signé » : on ne close qu\'une fois le contrat signé.');
    }

    /* Le pilote de closing (close-pilot.js) : RDV 72 h, WhatsApp, checklist. */
    if (window.ClosePilot) {
      var cp = l.closePilot || {}, stp = {};
      try { window.ClosePilot.steps(leadId).forEach(function (x) { stp[x.k] = x.done; }); } catch (e) {}
      var rdvBk = dbList('bookings', 'leadId', leadId).length > 0;
      add(stp.rdv ? (rdvBk ? true : 'warn') : null, (E.offre === 'Elite' ? 'RDV Plan d\'Action' : 'RDV Urgent 72h') + ' calé', stp.rdv ? (rdvBk ? 'Réservé avec le client pendant l\'appel.' : '« Le client choisira lui-même » : à relancer — un client sans date, c\'est un démarrage qui glisse.') : 'Pilote → carte 📅 : on ne raccroche pas sans la date.', 2);
      if (E.offre === 'Elite') add(stp.wa ? true : null, 'Groupe WhatsApp + messages de bienvenue et liens', stp.wa ? '' : 'Pilote → carte 💬.');
      add(cp.doneAt ? true : null, 'Closing validé (checklist du pilote)', cp.doneAt ? '' : 'Pilote → carte ✅ → « Valider le closing ».');
    }

    var max = 0, got = 0, done = true;
    items.forEach(function (it) {
      max += it.w;
      if (it.ok === true) got += it.w; else if (it.ok === 'warn') got += it.w / 2;
      if (it.ok === null) done = false;
    });
    var errors = items.filter(function (it) { return it.ok === false; }).length;
    var t0 = l.call.startedAt, logs = st.log.filter(function (x) { return x.leadId === leadId; });
    var t1 = Math.max(logs.length ? logs[logs.length - 1].at : 0, signedAt || 0);
    return { lead: l, expected: E, items: items, score: max ? Math.round(100 * got / max) : 0, done: done, errors: errors, durationMs: t0 && t1 > t0 ? t1 - t0 : null, sig: sig, pay: pay };
  }

  window.SBX = {
    KEY: SBX_KEY, TVA: TVA, PRICING: PRICING, COMM: COMM, COACHS: COACHS,
    esc: esc, euro: euro, pad2: pad2, frDate: frDate, frTime: frTime, isoDay: isoDay, uid: uid,
    digits: digits, samePhone: samePhone, sameEmail: sameEmail, sameName: sameName, fold: fold,
    fmtPhone: fmtPhone, maskPhone: maskPhone, tsMs: tsMs, siretOk: siretOk, ibanOk: ibanOk, IBAN_TEST: 'FR14 2004 1010 0505 0001 3M02 606',
    load: load, save: save, update: update, onChange: onChange, resetAll: resetAll, resetLead: resetLead, seed: seed, setTeam: setTeam, setPricing: setPricing,
    leadById: leadById, log: log, contacts: contacts, findContact: findContact, deliver: deliver, routeLink: routeLink,
    registry: registry, leadSigs: leadSigs, leadPays: leadPays, dbList: dbList, readPrefill: readPrefill,
    expected: expected, bilan: bilan
  };
})();
