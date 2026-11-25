// ============================================================================
// api/team-pilotage.js — PILOTAGE ÉQUIPE SALES (admin, 16/10/2026)
// ----------------------------------------------------------------------------
// Alimente admin-pilotage.html. Admin uniquement (requireAdmin).
//
// POST { action: 'live' }
//   → Ce qui se passe MAINTENANT :
//     - appels en cours (call_logs : 'ringing' / 'initiated' de moins de
//       150 s, 'in-progress' sans endedAt de moins de 2 h — des appels Ringover
//       restent coincés en 'ringing' quand l'événement de fin se perd, d'où
//       ces bornes) ;
//     - RDV de closing du jour (bookings, périmètre isClosingBooking) avec le
//       clic sur le lien Meet suivi (booking_meet, voir api/meet-link.js) et
//       la présence dans la salle Meet (API Google Meet v2, relue au plus
//       toutes les 45 s pour un RDV dont le créneau est en cours, de 10 min
//       avant à 15 min après) ;
//     - qui est connecté à Team (user_activity, alimenté par nav.js).
//
// POST { action: 'activity', from: 'YYYY-MM-DD', to: 'YYYY-MM-DD' }  (31 j max)
//   → Par personne et par jour : appels (sortants), décrochés, temps d'appel,
//     appels reçus, Sets et RDV posés par clic, RDV de la période (closer) et
//     leur état, SMS / e-mails / WhatsApp envoyés (envois automatiques à
//     part), actions sur les fiches (lead_actions) et notes.
//
//   + Lead to speech (23/10/2026) : par personne et par jour, délai entre
//     l'arrivée d'un lead et son 1er appel sortant, compté pour l'auteur de
//     ce 1er appel (voir computeLeadSpeech). Aussi dans 'live' pour le jour.
//
// POST { action: 'search', q }   → fiches prospect (téléphone, e-mail, nom)
// POST { action: 'lead', leadId } → toute l'histoire d'un prospect, toutes
//     personnes confondues : appels, RDV (+ clic / présence Meet), actions,
//     messages, notes, WhatsApp, journal de la fiche.
//
// LECTURE SEULE sur toutes les collections métier. Seule écriture :
// booking_meet/{bookingId}.presence (cache de la présence Meet), collection
// lue et écrite uniquement par l'Admin SDK (aucune règle Firestore).
//
// TOUTE l'équipe sales est suivie, setters compris (décision Adrien
// 16/10/2026) : présence, temps de connexion (user_activity, docs journaliers),
// appels, RDV, messages, DM Instagram (ig_dm_events, attribués au setter écrit
// comme dans Set NB), actions et notes.
//
// CHIFFRES — audit de cohérence du 25/11/2026 (référentiel des chiffres
// commerciaux). Plus aucune règle locale : tout vient de stats-core.js.
//   · RDV d'une journée : UN compte, le même dans En direct, Activité et
//     Journal (rdvDelta → StatsCore.ajouter) : RDV (hors replanifiés et
//     doublons), annulés, no-show, présents, à statuer (fin du créneau passée,
//     heure de Paris), à venir, Kept (RDV − annulés), pitchés, RDV closés.
//     Population : StatsCore.estRdvVente (Self Booking, Setting, Manuel).
//     Le mot « tenus » n'existe plus. Closer : StatsCore.closerDuRdv.
//   · « RDV closés » = RDV au résultat close, à la date du RDV. Ce n'est PAS
//     le « Closes » des écrans de résultat (clients gagnés, closes annulés
//     retirés) : Pilotage ne lit pas les paiements.
//   · « Sets » = RDV du setting créés ce jour, un par RDV, hors remplaçants et
//     doublons, rangés chez StatsCore.setterDuRdv (setter de la fiche) : même
//     nombre que Set NB. « Posés par lui (clic) » = RDV que la personne a
//     créés elle-même (bookedBySlug), compte d'activité distinct.
//   · Appels = sortants (direction === 'outbound', règle du funnel) ;
//     Décrochés = StatsCore.estDecroche (sortants) ; appels reçus à part ;
//     appels SANS sens comptés nulle part, signalés (warnings). Tous les
//     call_logs comptent, sans fusion ; la fusion des lancements « sans
//     suite » ne sert qu'aux listes (nombre dit dans `notes`). Temps d'appel
//     = conversation des sortants décrochés.
//   · Actions de fiche : jour de Paris de createdAt (repli : champ day).
//   · Membres partis : StatsCore.estParti ; rangement d'une personne dans
//     l'Activité : StatsCore.rangPersonne (« Non attribué » + unassignedDetail).
//   · Jours : heure de Paris (StatsCore.jourParis) ; dates en texte lues à
//     l'heure de Paris (FunnelCore.parseFlexMs).
//   · Plafond de lecture atteint : nommé dans la réponse (`plafonds`), affiché.
//
// Présence Meet — compte utilisé : les RDV de closing sont dans l'agenda
// strategie@adrienemily.com, organisateur de la réunion ; c'est le compte
// « Meet Closing » (email_tokens/meet_closing, scope meetings.space.readonly)
// déjà connecté pour le Replay closing. Si l'agenda de l'expert est un autre
// compte, repli sur calendar_tokens/{personId} — qui n'a pas le scope Meet
// tant que l'expert n'a pas reconnecté son agenda (présence « indisponible »).
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const MT = require('./_meetTranscript');
const Core = require('../funnel-core.js');
const SC = require('../stats-core.js');

const SALES_ROLES = { setter: 1, setter_ecrit: 1, closer: 1, closer_setter: 1, sales: 1 };
const HIDDEN_ROLES = { coach: 1, csm: 1 };

const RINGING_MAX_MS = 150 * 1000;
const TALKING_MAX_MS = 2 * 3600 * 1000;
const ONLINE_MS = 7 * 60 * 1000;          // nav.js émet toutes les 5 min
const MEET_BEFORE_MS = 10 * 60 * 1000;
const MEET_AFTER_MS = 15 * 60 * 1000;
const PRESENCE_TTL_MS = 45 * 1000;
const MAX_LIVE_MEETS = 6;
const MAX_DAYS = 31;
const CONVO_SEC = 60;                     // décroché d'1 min et plus

const CALL_STATUS_FR = {
  initiated: 'sans suite', ringing: 'sans suite', 'in-progress': 'en cours', completed: 'non décroché',
  busy: 'occupé', failed: 'échec', canceled: 'annulé',
};
// Doublons d'appels : le dialer crée un doc au lancement, Ringover un autre à
// la fin — l'un des deux reste coincé en 'ringing' / 'initiated' sans endedAt
// (constaté le 16/10/2026 : « sans suite » + « décroché » à la même minute,
// même numéro). On fusionne deux appels de la même personne vers le même
// numéro à moins de 90 s d'écart quand l'un des deux n'est jamais terminé ;
// on garde le plus renseigné, en lui reportant leadId / nom si besoin.
// AFFICHAGE SEULEMENT (audit 25/11/2026, constat D06) : cette fusion sert aux
// listes (appels en cours, frise du Journal, histoire d'un prospect). Les
// COMPTEURS (Appels, Décrochés, temps, reçus) lisent tous les call_logs, sans
// fusion, comme Set NB et le Stats funnel : le même mot = le même nombre. Le
// nombre de lancements fusionnés dans une liste est dit (`fusionsAppels`).
function callScore(c) {
  return (c.endedAt ? 4 : 0) + (c.answeredAt ? 2 : 0) + (Number(c.durationSec) ? 1 : 0) +
    (c.status === 'completed' ? 1 : 0) + (c.aiSummary ? 1 : 0);
}
function isStuckCall(c) {
  return !c.endedAt && (c.status === 'ringing' || c.status === 'initiated');
}
function dedupeSnap(snap, R) {
  const items = [];
  if (snap) snap.forEach(function (d) { items.push({ id: d.id, c: Object.assign({}, d.data() || {}) }); });
  items.sort(function (a, b) { return toMs(a.c.initiatedAt) - toMs(b.c.initiatedAt); });
  const keep = [];
  const last = {};
  let fusions = 0;
  items.forEach(function (x) {
    const c = x.c;
    const m = callMember(c, R);
    const other = last9(c.direction === 'inbound' ? c.fromNumber : c.toNumber);
    const key = (m ? m.slug : (c.userId || c.userName || '?')) + '|' + (other || x.id);
    const t = toMs(c.initiatedAt);
    const prev = last[key];
    if (prev && Math.abs(t - prev.t) < 90000 && (isStuckCall(c) || isStuckCall(prev.x.c))) {
      const win = callScore(c) > callScore(prev.x.c) ? x : prev.x;
      const lose = win === x ? prev.x : x;
      ['leadId', 'leadNameSnapshot', 'leadName', 'userId', 'campaignId'].forEach(function (k) { if (!win.c[k] && lose.c[k]) win.c[k] = lose.c[k]; });
      keep[prev.i] = win;
      prev.x = win;
      fusions += 1;
      return;
    }
    last[key] = { t: t, i: keep.length, x: x };
    keep.push(x);
  });
  const out = keep.map(function (x) { return { id: x.id, data: function () { return x.c; } }; });
  out.fusions = fusions;
  return out;
}
// Tous les call_logs d'une lecture, SANS fusion : la base des compteurs.
function rawCalls(snap) {
  const out = [];
  if (snap) snap.forEach(function (d) { out.push({ id: d.id, data: function () { return d.data() || {}; } }); });
  return out;
}
// Phrase de la réponse pour les appels sans sens (affichée par la page).
function phraseSansSens(n) {
  return n + ' appel' + (n > 1 ? 's' : '') + ' sans sens (entrant / sortant) enregistré' + (n > 1 ? 's' : '') +
    ' : compté' + (n > 1 ? 's' : '') + ' ni dans les Appels ni dans les reçus, comme sur Set NB et le Stats funnel';
}
function phraseFusions(n) {
  return n + ' lancement' + (n > 1 ? 's' : '') + ' d\'appel resté' + (n > 1 ? 's' : '') + ' « sans suite » fusionné' + (n > 1 ? 's' : '') +
    ' dans la liste avec l\'appel réel au même numéro (moins de 90 s d\'écart) ; les compteurs les gardent, comme Set NB et le Stats funnel';
}

// Durée de conversation d'un appel : celle que lit la règle du décroché
// (StatsCore.estDecroche), pour que « Temps d'appel » et « Décrochés »
// parlent des mêmes secondes.
function talkSecOf(c) {
  return Number(c.durationSec) || 0;
}
// Décroché = StatsCore.estDecroche (au moins 5 s de conversation, répondeurs
// écartés) — la même règle que Set NB et le Stats funnel.
function isAnsweredCall(c) {
  return SC.estDecroche(c);
}
// Sens d'un appel — la règle du Stats funnel (FunnelCore.callStats) et de
// Set NB : « Appels » = direction === 'outbound' ; « reçus » = 'inbound'.
// Un appel SANS sens enregistré n'est ni l'un ni l'autre : compté à part
// (callsSansSens), signalé dans la réponse, jamais rangé dans les Appels.
function isInbound(c) { return c.direction === 'inbound'; }
function isOutbound(c) { return c.direction === 'outbound'; }
// Appels « hors équipe sales » (CSM, coachs…) : rôles hors de ceux du
// téléphone commercial — LA liste du Stats funnel (FunnelCore.SALES_CALL_ROLES),
// et la même règle que FunnelCore.perimetreAppel : le RÔLE seul décide, qu'un
// membre soit parti ou non. Ils ne comptent ni dans Appels, ni dans Décrochés,
// ni dans le Lead to speech ; un ancien setter / closer reste dans le total
// (« Non attribué »), un appel sans auteur aussi. (Relecture du 25/11/2026 :
// un ancien coach / CSM était compté ici et pas sur Set NB ni au Dashboard.)
const CALL_ROLES_EQUIPE = Core.SALES_CALL_ROLES;
function estHorsEquipe(m) { return !!m && !CALL_ROLES_EQUIPE[m.role]; }

const CALL_FIELDS = [
  'direction', 'status', 'leadId', 'leadNameSnapshot', 'leadName',
  'fromNumber', 'toNumber', 'initiatedAt', 'answeredAt', 'endedAt',
  'durationSec', 'talkDurationSec', 'ringingDurationSec', 'totalDurationSec', 'userId', 'userName', 'ringoverUserName', 'provider',
];
// Champs lus par StatsCore (état, classe, remplaçant, setter / closer).
const BOOKING_FIELDS = [
  'date', 'time', 'duration', 'personId', 'personName', 'expertSlug', 'closeData',
  'bookedBySlug', 'outcome', 'status', 'source', 'type', 'typeLabel', 'isCoaching', 'clientId',
  'skipLeadCreation', 'prospect.nom', 'prospect.prenom', 'leadId', 'meetLink', 'createdAt',
  'rescheduled', 'rescheduledFromId', 'rescheduledToId', 'transferredFrom', 'transferredTo',
  'duplicateOf', 'cancellation', 'cancelledReason',
];

// ─── RDV : un seul compte (StatsCore) ──────────────────────────────────────
// Clés d'un agrégat de RDV (StatsCore.vide / ajouter / finir). Un RDV n'a
// qu'un état : RDV = annulés + no-show + présents + à statuer + à venir ;
// Kept = RDV − annulés ; Présents = disqua. + pitchés + sans détail ;
// Pitchés = offres en attente + non closes + RDV closés. Toutes ces clés
// s'additionnent d'un RDV à l'autre et d'un jour à l'autre.
const RDV_KEYS = ['rdv', 'annules', 'noshow', 'presents', 'aStatuer', 'aVenir', 'kept',
  'pitches', 'disqua', 'sansDetail', 'offres', 'nonCloses', 'rdvCloses', 'replan', 'doublons'];
function rdvClasse(b, typeMap) { return SC.classifyBooking(b, typeMap || {}); }
function estRdvVente(b, typeMap) { return SC.estRdvVente(rdvClasse(b, typeMap)); }
// Contribution d'UN RDV à l'agrégat : StatsCore.ajouter sur un agrégat vide.
function rdvDelta(b, now) {
  const a = SC.vide();
  SC.ajouter(a, b, now);
  SC.finir(a);
  return a;
}
// Agrégat d'une liste de RDV, réduit aux clés additives (renvoyé à la page).
function rdvAgg(list, now) {
  const a = SC.compter(list || [], now);
  const o = {};
  RDV_KEYS.forEach(function (k) { o[k] = a[k] || 0; });
  return o;
}
// Résolution d'une fiche d'agenda → membre (StatsCore.closerDuRdv).
function resoudrePersonneFn(R, persons) {
  return function (personId) {
    const p = persons[personId];
    if (p && p.firebaseUid && R.byUid[p.firebaseUid]) return R.byUid[p.firebaseUid].slug;
    if (personId && R.bySlug[personId]) return personId;
    return null;
  };
}
// « Sets » : RDV du setting réellement créé (un par RDV), hors remplaçant
// (report, transfert) et doublon supprimé — règle de Set NB.
function estSet(b, typeMap) {
  return rdvClasse(b, typeMap) === 'setter' && !SC.estRemplacant(b) && !SC.estDoublon(b);
}
// « Posés par lui (clic) » : RDV de vente créé par un membre (bookedBySlug),
// hors remplaçant (booking.html recopie bookedBySlug sur un RDV reporté).
function estPoseClic(b, typeMap) {
  return !!b.bookedBySlug && estRdvVente(b, typeMap) && !SC.estRemplacant(b) && !SC.estDoublon(b);
}
function memberOfSlug(R, s) {
  if (!s) return null;
  return R.bySlug[s] || R.byUid[s] || null;
}
// Fiches des RDV du setting (setterSlug / assignedTo) pour StatsCore.setterDuRdv.
// Lecture par lots ; une fiche fusionnée renvoie à la fiche gardée.
const SETTER_FICHE_FIELDS = ['setterSlug', 'assignedTo', '_merged', '_mergedInto'];
async function fichesSetter(ids) {
  const out = {};
  const uniq = ids.filter(function (id, i) { return id && /^[A-Za-z0-9_-]{1,80}$/.test(id) && ids.indexOf(id) === i; });
  async function lire(list) {
    const got = {};
    for (let i = 0; i < list.length; i += 200) {
      const refs = list.slice(i, i + 200).map(function (id) { return db.collection('leads').doc(id); });
      const snaps = await db.getAll.apply(db, refs.concat([{ fieldMask: SETTER_FICHE_FIELDS }]));
      snaps.forEach(function (s) { if (s.exists) got[s.id] = s.data() || {}; });
    }
    return got;
  }
  const first = await lire(uniq);
  const survivants = {};
  Object.keys(first).forEach(function (id) {
    const f = first[id];
    if (f._merged === true && f._mergedInto) survivants[id] = String(f._mergedInto);
    else out[id] = f;
  });
  const ids2 = Object.keys(survivants).map(function (k) { return survivants[k]; });
  if (ids2.length) {
    const second = await lire(ids2);
    Object.keys(survivants).forEach(function (id) { if (second[survivants[id]]) out[id] = second[survivants[id]]; });
  }
  return out;
}
function setterOf(b, fiches, R) {
  return memberOfSlug(R, SC.setterDuRdv(b, b.leadId ? (fiches[b.leadId] || null) : null));
}

// ─── Dates ──────────────────────────────────────────────────────────────────
function todayIsoParis(d) {
  return SC.jourParis(d || new Date());
}
function parisDayOfMs(ms) {
  return ms ? SC.jourParis(ms) : null;
}
// Début d'un jour 'AAAA-MM-JJ' à Paris, en ms (bornes de période).
function dayStartMs(iso) { return SC.debutJourParis(iso).getTime(); }
// Jour d'une action de fiche (lead_actions) : jour de PARIS de son createdAt,
// repli sur le champ `day` stocké (jour de l'appareil qui l'a écrite) — la
// règle de Set NB (actionDay). Les actions sont donc lues sur la période
// élargie d'un jour de chaque côté, puis rangées par ce jour (constat D08).
function jourAction(a) {
  const ms = toMs(a && a.createdAt);
  return ms ? SC.jourParis(ms) : String((a && a.day) || '');
}
function addDays(iso, n) {
  const d = new Date(iso + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function validIso(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
}
// Toute forme de date rencontrée dans les docs → ms epoch (0 si illisible).
// Les chaînes « jj/mm/aaaa hh:mm » (toLocaleString fr-FR) sont en heure de Paris.
function toMs(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  const s = String(v).trim();
  const fr = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:[ ,à]+(\d{1,2})[:h](\d{2}))?/.exec(s);
  if (fr) {
    const iso = fr[3] + '-' + ('0' + fr[2]).slice(-2) + '-' + ('0' + fr[1]).slice(-2);
    return MT.parisToUtcMs(iso, fr[4] ? (('0' + fr[4]).slice(-2) + ':' + fr[5]) : '12:00');
  }
  // Texte ISO sans fuseau = heure de PARIS (FunnelCore.parseFlexMs), quel
  // que soit le fuseau du serveur (les Vercel Functions tournent en UTC).
  const t = Core.parseFlexMs(s);
  return t == null || isNaN(t) ? 0 : t;
}
function isoOf(ms) {
  return ms ? new Date(ms).toISOString() : null;
}

// ─── Équipe ─────────────────────────────────────────────────────────────────
function normName(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim();
}

async function loadRoster() {
  const snap = await db.collection('_meta').doc('team_members').get();
  const raw = snap.exists ? (snap.data() || {}).members : null;
  const list = Array.isArray(raw) ? raw : Object.values(raw || {});
  const R = { list: [], bySlug: {}, byUid: {}, byFirst: {}, callIdx: null };
  // Auteur d'un appel : L'index du Stats funnel (FunnelCore.callerIndex), sur
  // les mêmes fiches — compte relié, sinon prénom Ringover, anciens membres
  // compris, membre en place prioritaire à prénom égal.
  R.callIdx = Core.callerIndex(list.filter(function (m) { return m && m.slug; }));
  list.forEach(function (m) {
    if (!m || !m.slug) return;
    const role = String(m.role || '');
    const member = {
      slug: m.slug,
      uid: m.firebaseUid || null,
      name: m.shortName || m.fullName || m.slug,
      fullName: m.fullName || m.shortName || m.slug,
      role: role,
      color: m.color || null,
      initials: m.initials || null,
      // Membre parti : LA règle commune (StatsCore.estParti : drapeau de la
      // fiche, fiche archivée avec une date de fin, liste historique).
      departed: SC.estParti(m, m.slug),
      // Date d'arrivée (startDate 'AAAA-MM-JJ') : une activité datée d'avant
      // va sur « Non attribué » (StatsCore.rangPersonne).
      startDate: /^\d{4}-\d{2}-\d{2}$/.test(String(m.startDate || '')) ? String(m.startDate) : null,
      hidden: !!HIDDEN_ROLES[role],
      sales: !!SALES_ROLES[role],
    };
    R.list.push(member);
    R.bySlug[member.slug] = member;
    if (member.uid) R.byUid[member.uid] = member;
    const first = normName(member.name).split(' ')[0];
    if (first && !member.departed) R.byFirst[first] = R.byFirst[first] || member;
  });
  return R;
}

// Où ranger un membre dans la vue par personne (Activité) : LA règle commune
// StatsCore.rangPersonne — inconnu, ancien membre (« Anciens membres », sans
// nom), coach / CSM (« Prénom (hors onglets) »), activité datée d'avant son
// arrivée (« Prénom (avant son arrivée) ») → « Non attribué » ; sinon sa ligne.
function rangDe(m, day) {
  if (!m) return SC.rangPersonne(null, day, {});
  return SC.rangPersonne(m.slug, day || null, {
    parti: function () { return !!m.departed; },
    aOnglet: function () { return !m.hidden; },
    prenom: function () { return m.name; },
    debut: function () { return m.startDate || null; },
  });
}

function publicMember(m) {
  return { slug: m.slug, name: m.name, fullName: m.fullName, role: m.role, color: m.color, initials: m.initials };
}

// DM Instagram : le journal du webhook Meta n'a pas d'auteur. Comme Set NB,
// on les attribue au setter écrit — seulement s'il n'y en a qu'un actif.
function dmOwner(R) {
  const w = R.list.filter(function (m) { return m.role === 'setter_ecrit' && !m.departed; });
  return w.length === 1 ? w[0] : null;
}

async function loadPersons() {
  const out = {};
  const snap = await db.collection('booking_config').select('firebaseUid', 'name', 'calendarEmail').get();
  snap.forEach(function (d) { out[d.id] = d.data() || {}; });
  return out;
}

// Auteur d'un appel : FunnelCore.callerOf, LA règle de Set NB, du Dashboard,
// du Stats funnel et de l'assistant (compte relié, sinon prénom Ringover).
function callMember(c, R) {
  const who = Core.callerOf(c, R.callIdx);
  return (who && who.slug && R.bySlug[who.slug]) || null;
}

// Closeur d'un RDV — StatsCore.closerDuRdv, la règle de Close SB / Global
// closing : closer qui a validé le close → hôte figé sur le RDV (expertSlug)
// → hôte de la fiche d'agenda (firebaseUid de booking_config, AVANT l'égalité
// personId == slug : la fiche « elodie » est reprise par Anthony depuis le
// 10/10/2026). Personne d'identifiable (ou slug hors roster) : null → ligne
// « Non attribué », jamais « le seul closer ».
function bookingCloser(b, R, persons) {
  return memberOfSlug(R, SC.closerDuRdv(b, resoudrePersonneFn(R, persons)));
}

function prospectName(b) {
  const p = b.prospect || {};
  return [p.prenom, p.nom].filter(Boolean).join(' ').trim() || 'Prospect';
}

// ─── Lecture des fiches pour les appels sans nom ────────────────────────────
function last9(num) {
  const d = String(num || '').replace(/[^0-9]/g, '');
  return d.length >= 9 ? d.slice(-9) : null;
}
async function leadNamesByPhone(phones) {
  const out = {};
  const uniq = phones.filter(function (p, i) { return p && phones.indexOf(p) === i; }).slice(0, 150);
  if (!uniq.length) return out;
  const parts = [];
  for (let i = 0; i < uniq.length; i += 30) parts.push(uniq.slice(i, i + 30));
  const snaps = await Promise.all(parts.map(function (part) {
    return db.collection('leads').where('phoneNormalized', 'in', part).select('nom', 'phoneNormalized', '_merged').get();
  }));
  snaps.forEach(function (snap) {
    snap.forEach(function (d) {
      const l = d.data() || {};
      if (l._merged === true) return;
      if (!out[l.phoneNormalized]) out[l.phoneNormalized] = { id: d.id, nom: l.nom || '' };
    });
  });
  return out;
}

// ─── Présence Google Meet ───────────────────────────────────────────────────
const MEET_API = 'https://meet.googleapis.com/v2/';

async function calendarAuthFor(personId) {
  if (!personId) return null;
  const tok = await db.collection('calendar_tokens').doc(personId).get();
  if (!tok.exists) return null;
  const t = tok.data() || {};
  if (!t.refreshToken) return null;
  let conf = null;
  for (const id of ['oauth_calendar', 'oauth']) {
    const c = await db.collection('_config').doc(id).get();
    if (c.exists && c.data().client_id && c.data().client_secret) { conf = c.data(); break; }
  }
  if (!conf) return null;
  const { google } = require('googleapis');
  const auth = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  auth.setCredentials({ refresh_token: t.refreshToken, access_token: t.accessToken || undefined });
  return auth;
}

async function meetAuthFor(b, persons, cache) {
  const p = persons[b.personId] || {};
  const calEmail = String(p.calendarEmail || '').toLowerCase();
  if (!cache.meetClosing) {
    cache.meetClosing = MT.getGoogle().catch(function (e) { return { error: e }; });
  }
  const g = await cache.meetClosing;
  if (g && g.auth && (!calEmail || String(g.email || '').toLowerCase() === calEmail)) {
    return { auth: g.auth, via: 'meet_closing' };
  }
  const key = 'cal_' + b.personId;
  if (!(key in cache)) cache[key] = calendarAuthFor(b.personId).catch(function () { return null; });
  const a = await cache[key];
  if (a) return { auth: a, via: 'calendar' };
  return null;
}

async function meetGet(auth, path, params) {
  const r = await auth.request({ url: MEET_API + path, params: params || {} });
  return r.data || {};
}

// Assistants de prise de notes (read.ai, Fathom, Otter…) : ils rejoignent la
// visio sous leur propre nom — jamais à confondre avec le prospect.
const NOTE_BOTS = /read ?ai|notetaker|note taker|meeting notes|fathom|otter|fireflies|tl ?dv|tactiq|bluedot|krisp|\bbot\b|assistant/;
function classifyParticipant(name, b, R) {
  const n = normName(name);
  if (!n) return 'invite';
  if (NOTE_BOTS.test(n)) return 'bot';
  const p = b.prospect || {};
  const ptoks = (normName(p.prenom) + ' ' + normName(p.nom)).split(' ').filter(function (x) { return x.length >= 3; });
  for (let i = 0; i < ptoks.length; i++) if (n.indexOf(ptoks[i]) >= 0) return 'prospect';
  if (/strategie|coaching|adrien|emily|alteore|ambitio/.test(n)) return 'equipe';
  for (let i = 0; i < R.list.length; i++) {
    const first = normName(R.list[i].name).split(' ')[0];
    if (first.length >= 3 && n.split(' ').indexOf(first) >= 0) return 'equipe';
  }
  return 'invite';
}

async function fetchPresence(b, R, persons, cache) {
  const code = MT.meetCodeFromLink(b.meetLink);
  if (!code) return { ok: false, error: 'no_meet', message: 'Pas de lien Meet sur ce RDV' };
  const a = await meetAuthFor(b, persons, cache);
  if (!a) {
    const g = cache.meetClosing ? await cache.meetClosing : null;
    return { ok: false, error: 'no_token', message: (g && g.error && g.error.message) || 'Aucun compte Google autorisé à lire cette réunion' };
  }
  const startMs = MT.bookingStartMs(b);
  const endMs = MT.bookingEndMs(b);
  try {
    // Une même salle est souvent ouverte plusieurs fois pour un seul RDV
    // (l'hôte entre, ressort, revient — constaté le 16/10/2026 : jusqu'à 4
    // sessions) : on fusionne toutes celles qui démarrent dans le créneau
    // élargi (30 min avant → 90 min après la fin prévue).
    const recs = await meetGet(a.auth, 'conferenceRecords', { filter: 'space.meeting_code = "' + code + '"', pageSize: 50 });
    const mine = (recs.conferenceRecords || []).filter(function (r) {
      const t = Date.parse(r.startTime || '');
      return !isNaN(t) && t >= startMs - 30 * 60000 && t <= endMs + 90 * 60000;
    }).sort(function (x, y) { return Date.parse(x.startTime) - Date.parse(y.startTime); }).slice(-6);
    if (!mine.length) {
      return { ok: true, via: a.via, started: false, participants: [] };
    }
    const ongoing = mine.some(function (r) { return !r.endTime; });
    const lists = await Promise.all(mine.map(function (r) {
      return meetGet(a.auth, r.name + '/participants', { pageSize: 100 }).then(function (d) {
        return { rec: r, parts: d.participants || [] };
      });
    }));
    const byName = {};
    lists.forEach(function (x) {
      const recOngoing = !x.rec.endTime;
      x.parts.forEach(function (p) {
        const who = p.signedinUser || p.anonymousUser || p.phoneUser || {};
        const name = who.displayName || (p.phoneUser ? 'Téléphone' : 'Participant');
        const key = normName(name) || name;
        const cur = byName[key] || { name: name, joinedAt: null, leftAt: null, inRoom: false };
        if (p.earliestStartTime && (!cur.joinedAt || p.earliestStartTime < cur.joinedAt)) cur.joinedAt = p.earliestStartTime;
        if (recOngoing && !p.latestEndTime) cur.inRoom = true;
        if (p.latestEndTime && (!cur.leftAt || p.latestEndTime > cur.leftAt)) cur.leftAt = p.latestEndTime;
        byName[key] = cur;
      });
    });
    const participants = Object.keys(byName).map(function (k) {
      const x = byName[k];
      return { name: x.name, kind: classifyParticipant(x.name, b, R), joinedAt: x.joinedAt, leftAt: x.inRoom ? null : x.leftAt, inRoom: x.inRoom };
    }).sort(function (x, y) { return String(x.joinedAt).localeCompare(String(y.joinedAt)); });
    // Personne d'identifiable côté prospect : un invité extérieur à l'équipe
    // est très probablement lui (prénom saisi différemment, pseudo…).
    if (!participants.some(function (x) { return x.kind === 'prospect'; })) {
      participants.forEach(function (x) { if (x.kind === 'invite') x.kind = 'prospect_probable'; });
    }
    return {
      ok: true, via: a.via, started: true, ongoing: ongoing, sessions: mine.length,
      conferenceStart: mine[0].startTime || null, conferenceEnd: ongoing ? null : (mine[mine.length - 1].endTime || null),
      participants: participants,
    };
  } catch (e) {
    const status = Number(e && (e.code || (e.response && e.response.status)));
    const msg = String((e && e.message) || e);
    if (status === 403 && /has not been used|is disabled|SERVICE_DISABLED/i.test(msg)) {
      return { ok: false, error: 'api_disabled', message: 'API Google Meet non activée sur le projet Google Cloud du client OAuth' };
    }
    if (status === 403 || status === 401 || /insufficient|scope|invalid_grant/i.test(msg)) {
      return { ok: false, error: 'scope', via: a.via, message: 'Compte Google sans autorisation Meet (' + (a.via === 'meet_closing' ? 'reconnecter « Meet Closing »' : 'reconnecter l\'agenda de l\'expert') + ')' };
    }
    return { ok: false, error: 'meet_error', message: msg.slice(0, 200) };
  }
}

function presenceSummary(pr) {
  if (!pr || !pr.ok) return null;
  const ps = pr.participants || [];
  function any(kinds, inRoom) {
    return ps.some(function (x) { return kinds.indexOf(x.kind) >= 0 && (!inRoom || x.inRoom); });
  }
  return {
    prospectJoined: any(['prospect', 'prospect_probable'], false),
    prospectInRoom: any(['prospect', 'prospect_probable'], true),
    teamInRoom: any(['equipe'], true),
  };
}

// ─── LIVE ───────────────────────────────────────────────────────────────────
async function handleLive(req, res) {
  const now = Date.now();
  const today = todayIsoParis();
  const dayStart = dayStartMs(today);
  const fromMs = Math.min(dayStart, now - 4 * 3600 * 1000);
  const LIVE_CALLS_LIMIT = 1500;

  const callQ = db.collection('call_logs')
    .where('initiatedAt', '>=', admin.firestore.Timestamp.fromMillis(fromMs))
    .orderBy('initiatedAt', 'desc').limit(LIVE_CALLS_LIMIT);
  const [R, persons, typeMap, callSnap, bookSnap, actSnap] = await Promise.all([
    loadRoster(),
    loadPersons(),
    MT.loadTypeMap(),
    callQ.select.apply(callQ, CALL_FIELDS).get(),
    db.collection('bookings').where('date', '==', today).get(),
    db.collection('user_activity').where('kind', '==', 'summary').get(),
  ]);
  const [dayActSnap, dmSnap, ltsRes] = await Promise.all([
    db.collection('user_activity').where('date', '==', today).get().catch(function () { return null; }),
    db.collection('ig_dm_events').where('date', '==', today).select('direction', 'timestampMs').get().catch(function () { return null; }),
    leadSpeechToday(R, dayStart, now).catch(function (e) { console.error('[team-pilotage] lead to speech (live)', e.message); return null; }),
  ]);

  // Ligne par membre sales (+ tout membre non coach / CSM qui apparaît).
  const rows = {};
  function row(m) {
    if (!m || m.departed || m.hidden) return null;
    if (!rows[m.slug]) {
      rows[m.slug] = Object.assign(publicMember(m), {
        status: 'offline', call: null, meet: null, online: null,
        // calls = appels SORTANTS ; answered = sortants décrochés ; talkSec =
        // temps d'appel (conversation des sortants décrochés) ; callsIn = reçus.
        today: { calls: 0, answered: 0, talkSec: 0, callsIn: 0, lastCallAt: null, activeMs: 0, sessions: 0, firstSeenAt: null, dmOut: 0, dmIn: 0, lastDmAt: null,
          rdv: rdvAgg([], now) },
      });
    }
    return rows[m.slug];
  }
  R.list.forEach(function (m) { if (m.sales) row(m); });

  // Appels — le total d'équipe compte TOUS les appels du jour (appels sans
  // auteur et membres sans carte compris) : c'est le même total que l'onglet
  // Activité réglé sur aujourd'hui (ligne « Non attribué » comprise).
  // Compteurs : TOUS les call_logs du jour, sans fusion (règle du funnel) ;
  // sens : 'outbound' = Appels, 'inbound' = reçus, sans sens = à part.
  const team = { calls: 0, answered: 0, talkSec: 0, callsIn: 0, sansCarte: 0, horsEquipe: 0, sansSens: 0 };
  rawCalls(callSnap).forEach(function (d) {
    const c = d.data() || {};
    const ini = toMs(c.initiatedAt);
    if (ini < dayStart) return;
    const m = callMember(c, R);
    const r = row(m);
    if (estHorsEquipe(m)) { if (isOutbound(c)) team.horsEquipe += 1; return; }
    if (r && (!r.today.lastCallAt || ini > Date.parse(r.today.lastCallAt))) r.today.lastCallAt = isoOf(ini);
    if (isInbound(c)) {
      team.callsIn += 1;
      if (r) r.today.callsIn += 1;
      return;
    }
    if (!isOutbound(c)) { team.sansSens += 1; return; }
    const ok = isAnsweredCall(c);
    team.calls += 1;
    if (ok) { team.answered += 1; team.talkSec += talkSecOf(c); }
    if (!r) { team.sansCarte += 1; return; }
    r.today.calls += 1;
    if (ok) { r.today.answered += 1; r.today.talkSec += talkSecOf(c); }
  });
  // Appels EN COURS (liste) : fusion des lancements restés « sans suite ».
  const liveCalls = [];
  const phonesToResolve = [];
  dedupeSnap(callSnap, R).forEach(function (d) {
    const c = d.data() || {};
    const m = callMember(c, R);
    const ini = toMs(c.initiatedAt);
    const ans = toMs(c.answeredAt);
    const r = row(m);
    let state = null;
    if (!c.endedAt) {
      if (c.status === 'in-progress' && now - (ans || ini) < TALKING_MAX_MS) state = 'talking';
      else if ((c.status === 'ringing' || c.status === 'initiated') && now - ini < RINGING_MAX_MS) state = 'ringing';
    }
    if (!state) return;
    const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    const call = {
      id: d.id, state: state, direction: c.direction || 'outbound',
      memberSlug: m ? m.slug : null, memberName: m ? m.name : (c.userName || c.ringoverUserName || null),
      leadId: c.leadId || null, leadName: c.leadNameSnapshot || c.leadName || null,
      number: other || null, since: isoOf(state === 'talking' ? (ans || ini) : ini),
    };
    if (!call.leadName && last9(other)) phonesToResolve.push(last9(other));
    liveCalls.push(call);
    if (r && (!r.call || state === 'talking')) { r.call = call; r.status = 'call'; }
  });
  if (phonesToResolve.length) {
    try {
      const names = await leadNamesByPhone(phonesToResolve);
      liveCalls.forEach(function (c) {
        const k = last9(c.number);
        if (!c.leadName && k && names[k]) { c.leadName = names[k].nom; c.leadId = c.leadId || names[k].id; }
      });
    } catch (e) { console.warn('[team-pilotage] noms des appels', e.message); }
  }

  // RDV de vente du jour (StatsCore.estRdvVente). Le compte du jour vient de
  // StatsCore.compter sur TOUS les RDV de vente du jour (doublons et
  // replanifiés comptés à part, hors RDV) ; la liste affichée montre les RDV
  // comptés dans « RDV » (annulés compris, avec leur état).
  const bookings = [];
  const venteDuJour = [];
  bookSnap.forEach(function (d) {
    const b = Object.assign({ id: d.id }, d.data() || {});
    if (!estRdvVente(b, typeMap)) return;
    venteDuJour.push(b);
    const e = SC.etat(b, now);
    if (e === 'doublon' || e === 'replanifie') return;
    bookings.push(b);
  });
  const rdvTeam = rdvAgg(venteDuJour, now);
  venteDuJour.forEach(function (b) {
    const cm = bookingCloser(b, R, persons);
    const r = row(cm);
    if (!r) return;
    const dl = rdvDelta(b, now);
    RDV_KEYS.forEach(function (k) { r.today.rdv[k] += dl[k] || 0; });
  });
  const meetDocs = bookings.length
    ? await db.getAll.apply(db, bookings.map(function (b) { return db.collection('booking_meet').doc(b.id); }))
    : [];
  const meetById = {};
  meetDocs.forEach(function (s) { if (s.exists) meetById[s.id] = s.data() || {}; });

  const cache = {};
  let meetStatus = null;
  const liveOnes = [];
  const outB = bookings.map(function (b) {
    const start = MT.bookingStartMs(b);
    const end = MT.bookingEndMs(b);
    const phase = now < start - MEET_BEFORE_MS ? 'upcoming' : (now <= end + MEET_AFTER_MS ? 'live' : 'past');
    const closer = bookingCloser(b, R, persons);
    const setter = b.bookedBySlug ? R.bySlug[b.bookedBySlug] : null;
    const bm = meetById[b.id] || {};
    const lib = SC.libelle(b, now);
    const o = {
      id: b.id, time: b.time || '', duration: Number(b.duration) || 30, start: isoOf(start), end: isoOf(end),
      phase: phase, prospect: prospectName(b), leadId: b.leadId || null, typeLabel: b.typeLabel || '',
      classe: rdvClasse(b, typeMap),
      closerSlug: closer ? closer.slug : null, closerName: closer ? closer.name : (b.personName || null),
      // Personne qui a créé le RDV (clic) — pas forcément le setter de la fiche.
      setterSlug: setter ? setter.slug : null, setterName: setter ? setter.name : null,
      outcome: b.outcome || null, status: b.status || null,
      // État unique du RDV (StatsCore.etat / detail) : la pastille de la page.
      etat: lib.etat, detail: SC.detail(b), etatMot: lib.mot,
      hasMeet: !!b.meetLink, tracked: !!(b.meetLink && b.meetTrackedLink),
      clicks: Number(bm.clicks) || 0, firstClickAt: isoOf(toMs(bm.firstClickAt)), lastClickAt: isoOf(toMs(bm.lastClickAt)),
      presence: bm.presence || null, presenceCheckedAt: isoOf(toMs(bm.presenceCheckedAt)),
      reminders: b.remindersSent || {}, waReminders: [],
    };
    const ouvert = lib.etat === 'a_venir' || lib.etat === 'a_statuer';
    if (phase === 'live' && b.meetLink && !b.outcome && ouvert) {
      const age = now - toMs(bm.presenceCheckedAt);
      if (!bm.presence || age > PRESENCE_TTL_MS) liveOnes.push({ b: b, o: o, prio: 0 });
    } else if (phase === 'past' && b.meetLink && lib.etat !== 'annule' && (!bm.presence || toMs(bm.presenceCheckedAt) < MT.bookingEndMs(b) + MEET_AFTER_MS)) {
      // RDV terminé jamais relu après son créneau : une lecture définitive.
      liveOnes.push({ b: b, o: o, prio: 1 });
    }
    return o;
  });

  // Rappels WhatsApp automatiques des RDV (api/whatsapp-rappels-rdv.js).
  try {
    const ids = outB.map(function (o) { return o.id; });
    const byId = {};
    outB.forEach(function (o) { byId[o.id] = o; });
    for (let i = 0; i < ids.length; i += 30) {
      const ws = await db.collection('whatsapp_messages').where('contexte.bookingId', 'in', ids.slice(i, i + 30)).select('contexte', 'statut', 'at').get();
      ws.forEach(function (d) {
        const w = d.data() || {};
        const o = byId[w.contexte && w.contexte.bookingId];
        if (o) o.waReminders.push({ at: isoOf(toMs(w.at)), type: (w.contexte && w.contexte.type) || 'rappel', ok: w.statut !== 'refuse' && w.statut !== 'echec' });
      });
    }
  } catch (e) { console.warn('[team-pilotage] rappels WhatsApp', e.message); }

  liveOnes.sort(function (x, y) { return x.prio - y.prio; });
  await Promise.all(liveOnes.slice(0, MAX_LIVE_MEETS).map(async function (x) {
    const pr = await fetchPresence(x.b, R, persons, cache);
    if (!pr.ok) meetStatus = meetStatus || { error: pr.error, message: pr.message };
    const presence = Object.assign({}, pr, { summary: presenceSummary(pr) });
    x.o.presence = presence;
    x.o.presenceCheckedAt = isoOf(now);
    try {
      await db.collection('booking_meet').doc(x.b.id).set({
        bookingId: x.b.id, presence: presence,
        presenceCheckedAt: admin.firestore.Timestamp.fromMillis(now),
        updatedAt: admin.firestore.Timestamp.fromMillis(now),
      }, { merge: true });
    } catch (e) { console.warn('[team-pilotage] cache présence', x.b.id, e.message); }
  }));

  outB.forEach(function (o) {
    const r = o.closerSlug ? rows[o.closerSlug] : null;
    const pr = o.presence;
    // « En visio » = le prospect ET l'équipe sont dans la salle, sur un RDV
    // pas encore statué. Le compte partagé « Stratégie A&E » reste souvent
    // seul dans une salle ouverte (constaté le 16/10/2026 sur un no-show
    // statué) : ça ne fait pas du closeur quelqu'un « en visio ».
    const inMeet = o.phase === 'live' && !o.outcome && pr && pr.ok && pr.summary &&
      pr.summary.teamInRoom && pr.summary.prospectInRoom;
    if (r && inMeet && r.status !== 'call') {
      // Depuis : l'arrivée du dernier des deux (le face-à-face réel).
      let since = null;
      (pr.participants || []).forEach(function (x) {
        if (!x.inRoom || !x.joinedAt) return;
        if (!since || x.joinedAt > since) since = x.joinedAt;
      });
      r.meet = { bookingId: o.id, prospect: o.prospect, since: since || pr.conferenceStart || o.start };
      r.status = 'meet';
    }
  });
  outB.sort(function (a, b) { return String(a.time).localeCompare(String(b.time)); });

  // Connexions
  actSnap.forEach(function (d) {
    const s = d.data() || {};
    const m = R.byUid[s.uid || d.id];
    if (!m) return;
    // Un admin connecté n'a sa ligne que s'il est aussi sur le terrain (appel…).
    const r = rows[m.slug] || (m.sales ? row(m) : null);
    if (!r) return;
    const seen = toMs(s.lastSeenAt);
    r.online = { lastSeenAt: isoOf(seen), lastPage: s.lastPage || null, lastLoginAt: isoOf(toMs(s.lastLoginAt)) };
    if (r.status === 'offline' && seen && now - seen < ONLINE_MS) r.status = 'online';
  });
  if (dayActSnap) dayActSnap.forEach(function (d) {
    const s = d.data() || {};
    const m = R.byUid[s.uid];
    const r = m ? rows[m.slug] : null;
    if (!r) return;
    r.today.activeMs += Number(s.activeMs) || 0;
    r.today.sessions += Number(s.sessions) || 0;
    r.today.clicks = (r.today.clicks || 0) + (Number(s.clicks) || 0);
    const f = toMs(s.firstSeenAt);
    if (f && (!r.today.firstSeenAt || f < Date.parse(r.today.firstSeenAt))) r.today.firstSeenAt = isoOf(f);
  });
  const dmM = dmOwner(R);
  const dmRow = dmM ? row(dmM) : null;
  if (dmRow && dmSnap) dmSnap.forEach(function (d) {
    const e = d.data() || {};
    if (e.direction === 'out') {
      dmRow.today.dmOut += 1;
      const t = Number(e.timestampMs) || 0;
      if (t && (!dmRow.today.lastDmAt || t > Date.parse(dmRow.today.lastDmAt))) dmRow.today.lastDmAt = isoOf(t);
    } else {
      dmRow.today.dmIn += 1;
    }
  });

  // Lead to speech du jour : 1ers appels passés aujourd'hui, par personne.
  let ltsTeam = null;
  if (ltsRes) {
    const all = [], per = {};
    ltsRes.items.forEach(function (it) {
      all.push(it.delayMs);
      const r = it.member ? row(it.member) : null;
      if (r) (per[r.slug] = per[r.slug] || []).push(it.delayMs);
    });
    Object.keys(per).forEach(function (slug) { rows[slug].today.lts = ltsAgg(per[slug]); });
    ltsTeam = ltsAgg(all);
  }

  const meetConn = await MT.connectionStatus().catch(function () { return null; });

  // Plafonds de lecture atteints : nommés, jamais tus.
  const plafonds = [];
  if (callSnap && callSnap.size >= LIVE_CALLS_LIMIT) plafonds.push('appels du jour (' + LIVE_CALLS_LIMIT + ' lus)');
  if (ltsRes && ltsRes.truncated) plafonds.push('lead to speech (fiches ou appels)');
  // Appels sans sens : comptés nulle part, mais dits (jamais un zéro muet).
  const warnings = [];
  if (team.sansSens) warnings.push(phraseSansSens(team.sansSens));

  res.status(200).json({
    ok: true, now: isoOf(now), today: today,
    members: Object.keys(rows).map(function (k) { return rows[k]; }),
    // Totaux d'équipe du jour : appels (tous auteurs) et RDV (StatsCore).
    team: team, rdv: rdvTeam, plafonds: plafonds, warnings: warnings,
    calls: liveCalls, bookings: outB, lts: ltsTeam,
    meet: { connected: !!(meetConn && meetConn.connected), email: meetConn ? meetConn.email : '', error: meetStatus },
  });
}

// ─── LEAD TO SPEECH (23/10/2026) ────────────────────────────────────────────
// Délai entre l'arrivée d'un lead et son 1er appel sortant, compté pour la
// personne qui a passé ce 1er appel — un lead = une personne. Un seul nom :
// « Lead to speech » (le Stats funnel l'appelle aussi ainsi). Mêmes règles
// que le funnel (funnel-core.js) :
//   - arrivée = date effective (realEntryMs : la plus ancienne de
//     dateWebinaire / importedCreatedAt / createdAt), nouveaux leads
//     seulement (un ré-optin garde sa date d'origine, donc sort de la fenêtre) ;
//   - 1er appel = 1er call_log sortant vers le numéro du lead (9 derniers
//     chiffres) après l'arrivée, décroché ou non ;
//   - temps brut, nuits et week-ends compris (ce que vit le prospect).
// Un 1er appel compte dans la période où il a été passé, et seulement si le
// lead est arrivé au plus 14 jours avant : au-delà, c'est de la relance de
// base froide. Les appels sont lus depuis (début − 14 j) pour être sûr
// qu'aucun appel antérieur n'existe.
const LTS_LOOKBACK_MS = 14 * 86400000;
const LTS_LEAD_FIELDS = ['nom', 'prenom', 'telephone', 'phone', 'dateWebinaire', 'importedCreatedAt', 'createdAt', '_merged', 'interne'];
const LTS_CALL_FIELDS = ['direction', 'toNumber', 'initiatedAt', 'userId', 'userName', 'ringoverUserName'];
const LTS_LIVE_TTL_MS = 2 * 60 * 1000;
let ltsLiveCache = null;

async function computeLeadSpeech(R, fromMs, toMs_) {
  const baseTs = admin.firestore.Timestamp.fromMillis(fromMs - LTS_LOOKBACK_MS);
  // realEntry ≤ createdAt : tout lead arrivé après la base a un createdAt après elle.
  const leadQ = db.collection('leads').where('createdAt', '>=', baseTs).limit(8000);
  const callQ = db.collection('call_logs').where('initiatedAt', '>=', baseTs)
    .where('initiatedAt', '<', admin.firestore.Timestamp.fromMillis(toMs_)).limit(20000);
  const snaps = await Promise.all([
    leadQ.select.apply(leadQ, LTS_LEAD_FIELDS).get(),
    callQ.select.apply(callQ, LTS_CALL_FIELDS).get(),
  ]);
  const byP9 = {};
  snaps[1].forEach(function (d) {
    const c = d.data() || {};
    if (c.direction !== 'outbound') return;
    // Appels hors équipe sales (CSM, coachs) : pas un 1er appel du setting.
    if (estHorsEquipe(callMember(c, R))) return;
    const p9 = Core.phone9(c.toNumber);
    const ms = toMs(c.initiatedAt);
    if (!p9 || !ms) return;
    (byP9[p9] = byP9[p9] || []).push({ ms: ms, c: c });
  });
  Object.keys(byP9).forEach(function (k) { byP9[k].sort(function (a, b) { return a.ms - b.ms; }); });
  const items = [];
  snaps[0].forEach(function (d) {
    const l = d.data() || {};
    // Fiche comptée comme lead : ni fusionnée, ni fiche de test (règle commune).
    if (!Core.isCountedLead(l)) return;
    // Date d'entrée réelle ; une date en texte est lue à l'heure de Paris.
    const entry = Core.realEntryMs(l);
    if (entry == null || entry < fromMs - LTS_LOOKBACK_MS || entry >= toMs_) return;
    const list = byP9[Core.phone9(l.telephone || l.phone)];
    if (!list) return;
    let first = null;
    for (let i = 0; i < list.length; i++) { if (list[i].ms >= entry) { first = list[i]; break; } }
    if (!first || first.ms < fromMs || first.ms - entry > LTS_LOOKBACK_MS) return;
    items.push({
      leadId: d.id,
      leadName: [l.prenom, l.nom].filter(Boolean).join(' ') || '',
      member: callMember(first.c, R),
      entryMs: entry, callMs: first.ms, delayMs: first.ms - entry,
      day: parisDayOfMs(first.ms),
    });
  });
  return { items: items, truncated: snaps[0].size >= 8000 || snaps[1].size >= 20000 };
}

function ltsAgg(delays) {
  const n = delays.length;
  if (!n) return { n: 0, median: null, under5: 0, under60: 0 };
  let u5 = 0, u60 = 0;
  delays.forEach(function (ms) { if (ms <= 5 * 60000) u5++; if (ms <= 3600000) u60++; });
  return { n: n, median: Core.median(delays), under5: u5, under60: u60 };
}

// Le direct se rafraîchit toutes les 20 s : le calcul (45 j d'appels + fiches)
// n'est refait qu'au plus toutes les 2 min par instance.
async function leadSpeechToday(R, dayStart, now) {
  const today = parisDayOfMs(now);
  if (ltsLiveCache && ltsLiveCache.day === today && now - ltsLiveCache.at < LTS_LIVE_TTL_MS) return ltsLiveCache.res;
  const res = await computeLeadSpeech(R, dayStart, now + 60000);
  ltsLiveCache = { day: today, at: now, res: res };
  return res;
}

// ─── ACTIVITÉ PAR PERSONNE ET PAR JOUR ──────────────────────────────────────
// Téléphone : callsOut = appels SORTANTS ; answered = sortants décrochés
// (StatsCore.estDecroche) ; convos = sortants décrochés d'1 min et plus ;
// talkSec = temps d'appel (conversation des sortants décrochés) ; callsIn /
// answeredIn / talkInSec = appels reçus, décrochés, temps — toujours à part.
// callsSansSens = appels sans sens enregistré (ni Appels ni reçus). Tous les
// call_logs sont comptés, sans fusion (règle du funnel, constat D06).
// RDV (closer, date du RDV) : RDV_KEYS (StatsCore). sets = Sets (setter de la
// fiche, jour de création) ; posesClic = RDV créés par la personne (clic).
// msgAuto = envois automatiques (relances, parcours RDV, rappels WhatsApp).
const STAT_KEYS = [
  'callsOut', 'answered', 'convos', 'talkSec', 'callsIn', 'answeredIn', 'talkInSec', 'callsHors', 'callsSansSens',
].concat(RDV_KEYS).concat([
  'sets', 'posesClic',
  'sms', 'email', 'whatsapp', 'dmOut', 'dmIn', 'msgAuto', 'actStatus', 'actBooking', 'actAssign', 'notes',
  'activeMs', 'sessions', 'clicks', 'pages', 'rapDue', 'rapDone', 'rapLate', 'rapChecked',
  // Lead to speech : ltsN s'additionne, ltsMed (médiane en ms) est posé à part.
  'ltsN', 'ltsMed',
]);

// Envoi automatique (relance, parcours RDV, robot) : jamais un message d'une
// personne, jamais un « vrai contact » pour un rappel (règle contactReel de
// relances-core.js).
function estEnvoiAuto(c) {
  return !!c && (c.auto === true || c.source === 'relance' || c.source === 'parcours_rdv');
}
// Contribution d'un appel aux compteurs téléphone : [clé, valeur]…
function callKeys(c) {
  const out = [];
  const talk = talkSecOf(c);
  if (isInbound(c)) {
    out.push(['callsIn', 1]);
    if (isAnsweredCall(c)) { out.push(['answeredIn', 1]); if (talk) out.push(['talkInSec', talk]); }
    return out;
  }
  // Sans sens enregistré : ni Appels ni reçus (règle du funnel), compté à part.
  if (!isOutbound(c)) { out.push(['callsSansSens', 1]); return out; }
  out.push(['callsOut', 1]);
  if (isAnsweredCall(c)) {
    out.push(['answered', 1]);
    if (talk) out.push(['talkSec', talk]);
    if (talk >= CONVO_SEC) out.push(['convos', 1]);
  }
  return out;
}

function emptyStats() {
  const o = {};
  STAT_KEYS.forEach(function (k) { o[k] = 0; });
  return o;
}

function commMember(c, R) {
  if (c.ownerSlug && R.bySlug[c.ownerSlug]) return R.bySlug[c.ownerSlug];
  if (c.ownerUid && R.byUid[c.ownerUid]) return R.byUid[c.ownerUid];
  const n = normName(c.ownerName).split(' ')[0];
  return (n && R.byFirst[n]) || null;
}
function noteMember(n, R) {
  if (n.authorSlug && R.bySlug[n.authorSlug]) return R.bySlug[n.authorSlug];
  if (n.authorUid && R.byUid[n.authorUid]) return R.byUid[n.authorUid];
  const f = normName(n.authorName).split(' ')[0];
  return (f && R.byFirst[f]) || null;
}

async function handleActivity(req, res, body) {
  const today = todayIsoParis();
  let to = validIso(body.to) ? body.to : today;
  let from = validIso(body.from) ? body.from : to;
  if (from > to) { const t = from; from = to; to = t; }
  if (addDays(from, MAX_DAYS - 1) < to) from = addDays(to, -(MAX_DAYS - 1));
  const fromMs = dayStartMs(from);
  const toMs_ = dayStartMs(addDays(to, 1));
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);
  const toTs = admin.firestore.Timestamp.fromMillis(toMs_);
  const now = Date.now();

  const R = await loadRoster();
  const slugs = R.list.filter(function (m) { return !m.hidden; }).map(function (m) { return m.slug; });

  const LIM = { calls: 8000, rdv: 3000, rdvCrees: 3000, leads: 5000, wa: 5000, dm: 8000, ua: 5000 };
  const callQ = db.collection('call_logs').where('initiatedAt', '>=', fromTs).where('initiatedAt', '<', toTs).limit(LIM.calls);
  const heldQ = db.collection('bookings').where('date', '>=', from).where('date', '<=', to).limit(LIM.rdv);
  const setQ = db.collection('bookings').where('createdAt', '>=', fromTs).where('createdAt', '<', toTs).limit(LIM.rdvCrees);
  // Messages et notes vivent dans les tableaux des fiches : on relit les
  // fiches touchées sur la période (updatedAt posé par les notes et les envois,
  // lastContactAt par les SMS / e-mails — deux requêtes, fusionnées par id).
  const leadQ = db.collection('leads').where('updatedAt', '>=', fromTs).limit(LIM.leads);
  const leadQ2 = db.collection('leads').where('lastContactAt', '>=', fromTs).limit(LIM.leads);
  const waQ = db.collection('whatsapp_messages').where('at', '>=', fromMs).where('at', '<', toMs_).limit(LIM.wa);
  const dmQ = db.collection('ig_dm_events').where('date', '>=', from).where('date', '<=', to).limit(LIM.dm);
  const uaQ = db.collection('user_activity').where('date', '>=', from).where('date', '<=', to).limit(LIM.ua);

  const settled = await Promise.allSettled([
    loadPersons(),
    MT.loadTypeMap(),
    callQ.select.apply(callQ, CALL_FIELDS).get(),
    heldQ.select.apply(heldQ, BOOKING_FIELDS).get(),
    setQ.select.apply(setQ, BOOKING_FIELDS).get(),
    Promise.all([
      leadQ.select('communications', 'notesHistory', '_merged').get(),
      leadQ2.select('communications', 'notesHistory', '_merged').get().catch(function () { return null; }),
    ]).then(function (snaps) {
      const docs = {};
      snaps.forEach(function (sn) { if (sn) sn.forEach(function (d) { docs[d.id] = d; }); });
      return { size: Math.max(snaps[0].size, snaps[1] ? snaps[1].size : 0), forEach: function (fn) { Object.keys(docs).forEach(function (k) { fn(docs[k]); }); } };
    }),
    waQ.select('contexte', 'statut', 'at', 'to').get(),
    Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items')
        .where('day', '>=', addDays(from, -1)).where('day', '<=', addDays(to, 1)).get()
        .then(function (snap) { return { slug: s, snap: snap }; });
    })),
    dmQ.select('direction', 'date').get(),
    uaQ.get(),
    loadRappelLeads(),
    computeLeadSpeech(R, fromMs, toMs_),
  ]);
  const warnings = [];
  const SOURCES = ['fiches experts', 'types de RDV', 'appels', 'RDV de la période', 'RDV créés (sets)', 'messages et notes', 'WhatsApp', 'actions sur les fiches', 'DM Instagram', 'temps de connexion', 'rappels', 'lead to speech'];
  function val(i) {
    if (settled[i].status === 'fulfilled') return settled[i].value;
    console.error('[team-pilotage] activité —', SOURCES[i], settled[i].reason && settled[i].reason.message);
    warnings.push(SOURCES[i] + ' : ' + String((settled[i].reason && settled[i].reason.message) || 'erreur').slice(0, 160));
    return null;
  }
  const persons = val(0) || {};
  const typeMap = val(1) || {};
  const callSnap = val(2), heldSnap = val(3), setSnap = val(4), leadSnap = val(5), waSnap = val(6), actRes = val(7);
  const dmSnap = val(8), uaSnap = val(9), rappelLeads = val(10), ltsRes = val(11);

  const totals = {};     // slug → stats
  const byDay = {};      // slug → day → stats
  const unassigned = emptyStats();
  // Détail de « Non attribué » (StatsCore.rangPersonne) : une ligne par
  // précision — « Anciens membres » sans nom, « Prénom (hors onglets) »,
  // « Prénom (avant son arrivée) », '' = personne inconnue.
  const unassignedDetail = {};
  function add(m, day, key, n) {
    n = n || 1;
    const rg = rangDe(m, day);
    if (rg.key === SC.NON_ATTRIBUE) {
      unassigned[key] += n;
      const dk = rg.cas + '|' + rg.precision;
      const det = unassignedDetail[dk] = unassignedDetail[dk] || { cas: rg.cas, precision: rg.precision, stats: emptyStats() };
      det.stats[key] += n;
      return;
    }
    if (!totals[m.slug]) { totals[m.slug] = emptyStats(); byDay[m.slug] = {}; }
    totals[m.slug][key] += n;
    if (day) {
      if (!byDay[m.slug][day]) byDay[m.slug][day] = emptyStats();
      byDay[m.slug][day][key] += n;
    }
  }
  function inRange(ms) { return ms >= fromMs && ms < toMs_; }

  // Tous les call_logs, sans fusion : le même nombre que Set NB et le funnel.
  const callDocs = rawCalls(callSnap);
  let sansSens = 0;
  callDocs.forEach(function (d) {
    const c = d.data() || {};
    const m = callMember(c, R);
    const day = parisDayOfMs(toMs(c.initiatedAt));
    if (estHorsEquipe(m)) { if (isOutbound(c)) add(null, day, 'callsHors'); return; }
    if (!isInbound(c) && !isOutbound(c)) sansSens += 1;
    callKeys(c).forEach(function (kv) { add(m, day, kv[0], kv[1]); });
  });
  if (sansSens) warnings.push(phraseSansSens(sansSens));

  // RDV de la période, à leur DATE, chez leur closer : StatsCore (un état par
  // RDV), population StatsCore.estRdvVente — le même compte que l'onglet En
  // direct et le Journal.
  if (heldSnap) heldSnap.forEach(function (d) {
    const b = d.data() || {};
    if (!estRdvVente(b, typeMap)) return;
    const m = bookingCloser(b, R, persons);
    const dl = rdvDelta(b, now);
    RDV_KEYS.forEach(function (k) { if (dl[k]) add(m, b.date, k, dl[k]); });
  });

  // Sets (setter de la fiche) et RDV posés par la personne elle-même (clic),
  // au jour de création à Paris.
  const setBookings = [];
  if (setSnap) setSnap.forEach(function (d) {
    const b = Object.assign({ id: d.id }, d.data() || {});
    const ms = toMs(b.createdAt);
    if (!inRange(ms)) return;
    b._day = parisDayOfMs(ms);
    setBookings.push(b);
  });
  let fiches = {};
  const setIds = setBookings.filter(function (b) { return estSet(b, typeMap) && b.leadId; }).map(function (b) { return String(b.leadId); });
  if (setIds.length) {
    try { fiches = await fichesSetter(setIds); } catch (e) {
      console.error('[team-pilotage] fiches des sets', e.message);
      warnings.push('fiches des sets : ' + String(e.message || 'erreur').slice(0, 160) + ' — attribution partielle : ces sets sont rangés d\'après la personne qui a posé le RDV');
    }
  }
  setBookings.forEach(function (b) {
    if (estSet(b, typeMap)) add(setterOf(b, fiches, R), b._day, 'sets');
    if (estPoseClic(b, typeMap)) add(R.bySlug[b.bookedBySlug] || null, b._day, 'posesClic');
  });

  if (leadSnap) leadSnap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true) return;
    (Array.isArray(l.communications) ? l.communications : []).forEach(function (c) {
      if (!c || c.direction !== 'outbound') return;
      const type = c.type === 'sms' ? 'sms' : (c.type === 'email' ? 'email' : (c.type === 'whatsapp' ? 'whatsapp' : null));
      if (!type) return;
      const ms = toMs(c.date || c.createdAt);
      if (!inRange(ms)) return;
      if (estEnvoiAuto(c)) {
        // Un WhatsApp automatique est déjà compté par whatsapp_messages
        // (même envoi, deux traces) : il n'est compté qu'une fois, là-bas.
        if (type !== 'whatsapp') add(null, parisDayOfMs(ms), 'msgAuto');
        return;
      }
      add(commMember(c, R), parisDayOfMs(ms), type);
    });
    (Array.isArray(l.notesHistory) ? l.notesHistory : []).forEach(function (n) {
      if (!n) return;
      const ms = toMs(n.date || n.createdAt);
      if (!inRange(ms)) return;
      add(noteMember(n, R), parisDayOfMs(ms), 'notes');
    });
  });

  if (waSnap) waSnap.forEach(function (d) {
    const w = d.data() || {};
    if (w.statut === 'refuse') return;
    const ctx = w.contexte || {};
    // Les envois automatiques (rappels de RDV, relances, parcours : contexte
    // sans uid) ne sont à personne : comptés à part, en « Envois auto ».
    if (!ctx.uid) { add(null, parisDayOfMs(toMs(w.at)), 'msgAuto'); return; }
    add(R.byUid[ctx.uid] || null, parisDayOfMs(toMs(w.at)), 'whatsapp');
  });

  const dmM = dmOwner(R);
  if (dmSnap) dmSnap.forEach(function (d) {
    const e = d.data() || {};
    add(dmM, e.date, e.direction === 'out' ? 'dmOut' : 'dmIn');
  });

  if (uaSnap) uaSnap.forEach(function (d) {
    const s = d.data() || {};
    if (!s.uid || (s.kind && s.kind !== 'daily')) return;
    const m = R.byUid[s.uid];
    // Connexion d'un admin / coach sans activité terrain : pas de ligne pour ça.
    if (!m || m.hidden || m.departed || (!m.sales && !totals[m.slug])) return;
    if (Number(s.activeMs)) add(m, s.date, 'activeMs', Number(s.activeMs));
    if (Number(s.sessions)) add(m, s.date, 'sessions', Number(s.sessions));
    if (Number(s.clicks)) add(m, s.date, 'clicks', Number(s.clicks));
    if (Number(s.pages)) add(m, s.date, 'pages', Number(s.pages));
  });

  // Actions de fiche : rangées au jour de Paris de leur createdAt (repli :
  // champ day), seulement celles de la période — la règle de Set NB.
  const actsIn = [];       // { slug, a } de la période
  if (actRes) actRes.forEach(function (x) {
    x.snap.forEach(function (d) {
      const a = d.data() || {};
      const jour = jourAction(a);
      if (!jour || jour < from || jour > to) return;
      actsIn.push({ slug: x.slug, a: a, jour: jour });
    });
  });
  actsIn.forEach(function (y) {
    const a = y.a;
    const key = a.action === 'set_booking' ? 'actBooking' : (a.action === 'assign' ? 'actAssign' : 'actStatus');
    add(R.bySlug[y.slug] || null, y.jour, key);
  });

  // Rappels : contacts relevés dans les appels, WhatsApp et actions déjà lus
  // (toute l'équipe — le Journal d'une personne lit le même index), plus les
  // communications de la fiche elle-même. Envois automatiques exclus.
  if (rappelLeads) {
    const ci = contactIndex();
    callDocs.forEach(function (d) { ci.call(d.data() || {}, R); });
    if (waSnap) waSnap.forEach(function (d) { ci.wa(d.data() || {}, R); });
    actsIn.forEach(function (y) {
      const am = R.bySlug[y.slug];
      if (y.a.leadId) ci.action(y.a.leadId, toMs(y.a.createdAt), am ? am.name : y.slug);
    });
    computeRappels(rappelLeads, R, ci, fromMs, toMs_, now).forEach(function (x) {
      add(x.owner, x.day, 'rapDue');
      if (x.status === 'fait') add(x.owner, x.day, 'rapDone');
      else if (x.status === 'en_retard') add(x.owner, x.day, 'rapLate');
      else if (x.status === 'coche_sans_contact') add(x.owner, x.day, 'rapChecked');
    });
  }

  // Lead to speech : un lead = l'auteur de son 1er appel, rangé au jour de
  // cet appel. Détail renvoyé pour la liste cliquable de la page.
  const ltsItems = [];
  let ltsTeam = null;
  if (ltsRes) {
    const all = [], groups = {};   // slug | '_un' → { all: [], days: { day: [] } }
    ltsRes.items.forEach(function (it) {
      const m = it.member;
      add(m, it.day, 'ltsN');
      // Même rangement que add() (StatsCore.rangPersonne).
      const key = rangDe(m, it.day).key === SC.NON_ATTRIBUE ? '_un' : m.slug;
      const g = groups[key] = groups[key] || { all: [], days: {} };
      g.all.push(it.delayMs);
      (g.days[it.day] = g.days[it.day] || []).push(it.delayMs);
      all.push(it.delayMs);
      ltsItems.push({
        slug: key, leadId: it.leadId, leadName: it.leadName, day: it.day,
        entryAt: isoOf(it.entryMs), callAt: isoOf(it.callMs), delayMs: it.delayMs,
      });
    });
    Object.keys(groups).forEach(function (key) {
      const g = groups[key];
      if (key === '_un') { unassigned.ltsMed = Core.median(g.all); return; }
      totals[key].ltsMed = Core.median(g.all);
      Object.keys(g.days).forEach(function (day) { byDay[key][day].ltsMed = Core.median(g.days[day]); });
    });
    ltsTeam = ltsAgg(all);
    ltsItems.sort(function (a, b) { return a.callAt < b.callAt ? 1 : -1; });
  }

  // Plafonds de lecture atteints : nommés dans la réponse, affichés par la
  // page (bandeau « lecture incomplète »), jamais un chiffre tronqué en silence.
  const plafonds = [];
  function plafond(snap, lim, nom) { if (snap && snap.size >= lim) plafonds.push(nom + ' (' + lim + ' lus)'); }
  plafond(callSnap, LIM.calls, 'appels');
  plafond(heldSnap, LIM.rdv, 'RDV de la période');
  plafond(setSnap, LIM.rdvCrees, 'RDV créés (sets, posés par clic)');
  plafond(leadSnap, LIM.leads, 'fiches (messages et notes)');
  plafond(waSnap, LIM.wa, 'WhatsApp');
  plafond(dmSnap, LIM.dm, 'DM Instagram');
  plafond(uaSnap, LIM.ua, 'temps de connexion');
  if (rappelLeads && rappelLeads._tronque) plafonds.push('fiches à rappels (' + RAPPEL_LEADS_LIMIT + ' lues)');
  if (ltsRes && ltsRes.truncated) plafonds.push('lead to speech (fiches ou appels)');

  const members = R.list.filter(function (m) {
    return !m.departed && !m.hidden && (m.sales || totals[m.slug]);
  }).map(function (m) {
    return Object.assign(publicMember(m), { totals: totals[m.slug] || emptyStats(), days: byDay[m.slug] || {} });
  });

  res.status(200).json({
    ok: true, from: from, to: to, generatedAt: isoOf(now),
    // Ancien format conservé (lu par d'anciennes versions de la page).
    truncated: {
      calls: !!(callSnap && callSnap.size >= LIM.calls),
      leads: !!(leadSnap && leadSnap.size >= LIM.leads),
    },
    plafonds: plafonds,
    warnings: warnings,
    members: members, unassigned: unassigned,
    // Décomposition de « Non attribué » (somme = unassigned) : [{ cas,
    // precision, stats }] — cas 'inconnu' | 'ancien' | 'hors_onglets' |
    // 'avant_arrivee' (StatsCore.rangPersonne). Jamais le nom d'un ancien membre.
    unassignedDetail: Object.keys(unassignedDetail).map(function (k) { return unassignedDetail[k]; }),
    lts: { team: ltsTeam, items: ltsItems },
  });
}

// ─── RAPPELS (follow-ups programmés sur les fiches) ─────────────────────────
// leads/{id}.followUps[] = { id, dateTime 'AAAA-MM-JJTHH:MM:SS' (heure de
// Paris), note, done, createdBy (slug, nom complet ou début d'e-mail selon
// l'écran), createdAt, doneAt / doneBy depuis le 16/10/2026 }.
// Un rappel est « fait » s'il y a eu un VRAI contact avec le prospect (appel,
// SMS, e-mail, WhatsApp, action sur la fiche) entre 30 min avant l'heure
// prévue et la fin de ce jour-là ; coché sans aucun contact = « coché sans
// contact » ; échu sans contact ni case = « en retard » (décision 16/10/2026).
// Un envoi AUTOMATIQUE (relance, parcours RDV, rappel WhatsApp sans auteur)
// n'est pas un vrai contact (audit 25/11/2026, règle contactReel de
// relances-core.js). Activité et Journal lisent le même index (actions de
// toute l'équipe) : un rappel a le même sort sur les deux onglets.
const RAPPEL_BEFORE_MS = 30 * 60000;
const RAPPEL_LEAD_FIELDS = ['nom', 'telephone', 'phoneNormalized', 'followUps', 'communications', 'assignedTo', 'setterSlug', '_merged'];

function looseMember(name, R) {
  const n = normName(name);
  if (!n) return null;
  const toks = n.split(' ');
  if (R.bySlug[toks[0]]) return R.bySlug[toks[0]];
  if (R.bySlug[toks.join('')]) return R.bySlug[toks.join('')];
  return R.byFirst[toks[0]] || null;
}

const RAPPEL_LEADS_LIMIT = 3000;
async function loadRappelLeads() {
  const q = db.collection('leads').where('followUps', '>', []).limit(RAPPEL_LEADS_LIMIT);
  const snap = await q.select.apply(q, RAPPEL_LEAD_FIELDS).get();
  const out = [];
  snap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true) return;
    out.push(Object.assign({ id: d.id }, l));
  });
  // Plafond atteint : dit par la réponse (plafonds), jamais tu.
  Object.defineProperty(out, '_tronque', { value: snap.size >= RAPPEL_LEADS_LIMIT, enumerable: false });
  return out;
}

function fuDueMs(f) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(String((f && f.dateTime) || ''));
  return m ? MT.parisToUtcMs(m[1], m[2]) : 0;
}

// Index des contacts par prospect, construit à partir de ce qui est déjà lu.
function contactIndex() {
  const idx = {};
  function addK(k, c) { if (k) (idx[k] = idx[k] || []).push(c); }
  return {
    call: function (c, R) {
      const ms = toMs(c.initiatedAt);
      const m = callMember(c, R);
      const item = { ms: ms, kind: 'appel', who: m ? m.name : (c.userName || null), ok: isAnsweredCall(c) };
      addK(c.leadId ? 'id:' + c.leadId : null, item);
      addK(last9(c.direction === 'inbound' ? c.fromNumber : c.toNumber) ? 'tel:' + last9(c.direction === 'inbound' ? c.fromNumber : c.toNumber) : null, item);
    },
    wa: function (w, R) {
      if (w.statut === 'refuse' || w.statut === 'echec') return;
      // Sans auteur = envoi automatique : pas un vrai contact.
      if (!w.contexte || !w.contexte.uid) return;
      const m = R.byUid[w.contexte.uid] || null;
      addK(last9(w.to) ? 'tel:' + last9(w.to) : null, { ms: toMs(w.at), kind: 'WhatsApp', who: m ? m.name : null });
    },
    action: function (leadId, ms, who) { addK('id:' + leadId, { ms: ms, kind: 'action fiche', who: who }); },
    find: function (lead, from, to, R) {
      let best = null;
      function take(c) { if (c.ms >= from && c.ms <= to && (!best || c.ms < best.ms)) best = c; }
      (idx['id:' + lead.id] || []).forEach(take);
      const k = last9(lead.phoneNormalized || lead.telephone);
      if (k) (idx['tel:' + k] || []).forEach(take);
      (Array.isArray(lead.communications) ? lead.communications : []).forEach(function (c) {
        if (!c || c.direction !== 'outbound' || estEnvoiAuto(c)) return;
        const m = commMember(c, R);
        take({ ms: toMs(c.date || c.createdAt), kind: c.type === 'sms' ? 'SMS' : (c.type === 'email' ? 'e-mail' : (c.type === 'call' ? 'appel' : (c.type || 'message'))), who: m ? m.name : (c.ownerName || null) });
      });
      return best;
    },
  };
}

function computeRappels(leads, R, ci, fromMs, toMsX, now) {
  const out = [];
  leads.forEach(function (l) {
    (Array.isArray(l.followUps) ? l.followUps : []).forEach(function (f) {
      const due = fuDueMs(f);
      if (!due || due < fromMs || due >= toMsX) return;
      let owner = looseMember(f.createdBy, R);
      if (!owner && l.assignedTo) owner = R.bySlug[l.assignedTo] || R.byUid[l.assignedTo] || null;
      if (!owner && l.setterSlug) owner = R.bySlug[l.setterSlug] || null;
      const dayEnd = MT.parisToUtcMs(addDays(parisDayOfMs(due), 1), '00:00');
      const contact = ci.find(l, due - RAPPEL_BEFORE_MS, Math.min(dayEnd, now), R);
      let status;
      if (contact) status = 'fait';
      else if (due > now) status = 'a_venir';
      else if (f.done) status = 'coche_sans_contact';
      else status = 'en_retard';
      out.push({
        leadId: l.id, leadName: l.nom || '', dueAt: isoOf(due), day: parisDayOfMs(due), note: f.note ? clip(f.note, 300) : '',
        ownerSlug: owner ? owner.slug : null, ownerName: owner ? owner.name : (f.createdBy || null), owner: owner,
        done: !!f.done, doneAt: f.doneAt || null, doneBy: f.doneBy || null, status: status,
        contact: contact ? { at: isoOf(contact.ms), kind: contact.kind, who: contact.who || null } : null,
      });
    });
  });
  return out.sort(function (a, b) { return a.dueAt < b.dueAt ? -1 : 1; });
}

// ─── JOURNAL D'UNE PERSONNE SUR UNE JOURNÉE ─────────────────────────────────
// POST { action: 'journal', slug, date } → tout ce que la personne a fait ce
// jour-là, minute par minute : pages et clics (user_events, nav.js), appels
// (durée, décroché, résumé IA), messages envoyés AVEC leur texte (SMS,
// e-mails, WhatsApp, DM Instagram), notes, actions sur les fiches, Sets et
// RDV posés par clic, RDV du jour dont elle est le closer (même compte que
// l'Activité), rappels prévus et leur sort.
async function handleJournal(req, res, body) {
  const date = validIso(body.date) ? body.date : todayIsoParis();
  const R = await loadRoster();
  const m = R.bySlug[String(body.slug || '')];
  const membersList = R.list.filter(function (x) { return !x.departed && !x.hidden; }).map(publicMember);
  if (!m) { res.status(200).json({ ok: true, date: date, member: null, members: membersList, events: [], rappels: [], summary: null }); return; }
  const dayStart = dayStartMs(date);
  const dayEnd = dayStartMs(addDays(date, 1));
  const now = Date.now();
  const startTs = admin.firestore.Timestamp.fromMillis(dayStart);
  const endTs = admin.firestore.Timestamp.fromMillis(dayEnd);
  const isDm = (dmOwner(R) || {}).slug === m.slug;
  const slugs = R.list.filter(function (x) { return !x.hidden; }).map(function (x) { return x.slug; });

  const LIM = { calls: 4000, rdvCrees: 500, rdv: 500, leads: 3000, wa: 3000, dm: 3000, ev: 3000 };
  const callQ = db.collection('call_logs').where('initiatedAt', '>=', startTs).where('initiatedAt', '<', endTs).limit(LIM.calls);
  const setQ = db.collection('bookings').where('createdAt', '>=', startTs).where('createdAt', '<', endTs).limit(LIM.rdvCrees);
  const heldQ = db.collection('bookings').where('date', '==', date).limit(LIM.rdv);
  const leadQ = db.collection('leads').where('updatedAt', '>=', startTs).limit(LIM.leads);
  const leadQ2 = db.collection('leads').where('lastContactAt', '>=', startTs).limit(LIM.leads);
  const LF = ['nom', 'telephone', 'phoneNormalized', 'communications', 'notesHistory', '_merged'];
  const empty = { forEach: function () {}, size: 0 };
  function safe(p) { return p.catch(function (e) { console.warn('[team-pilotage] journal', e.message); return null; }); }

  const r = await Promise.all([
    m.uid ? safe(db.collection('user_events').where('uid', '==', m.uid).where('date', '==', date).limit(LIM.ev).get()) : null,
    m.uid ? safe(db.collection('user_activity').doc(m.uid + '_' + date).get()) : null,
    safe(callQ.select.apply(callQ, CALL_FIELDS.concat(['aiSummary'])).get()),
    safe(setQ.select.apply(setQ, BOOKING_FIELDS.concat(['outcomeNote', 'remindersSent'])).get()),
    safe(heldQ.select.apply(heldQ, BOOKING_FIELDS.concat(['outcomeNote', 'remindersSent'])).get()),
    safe(Promise.all([leadQ.select.apply(leadQ, LF).get(), leadQ2.select.apply(leadQ2, LF).get()])),
    safe(db.collection('whatsapp_messages').where('at', '>=', dayStart).where('at', '<', dayEnd).limit(LIM.wa).get()),
    isDm ? safe(db.collection('ig_dm_events').where('date', '==', date).limit(LIM.dm).get()) : null,
    // Actions de TOUTE l'équipe ce jour-là : l'index des contacts des rappels
    // est le même que celui de l'onglet Activité (un rappel fait par un
    // collègue est « fait » sur les deux onglets).
    // Lues de la veille au lendemain (champ day = jour de l'appareil), puis
    // gardées si leur jour de Paris (jourAction) est la date : règle de Set NB.
    safe(Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items')
        .where('day', '>=', addDays(date, -1)).where('day', '<=', addDays(date, 1)).get()
        .then(function (snap) {
          const docs = [];
          snap.forEach(function (d) { if (jourAction(d.data() || {}) === date) docs.push(d); });
          return { slug: s, snap: { size: docs.length, forEach: function (fn) { docs.forEach(fn); } } };
        });
    }))),
    safe(loadRappelLeads()),
    loadPersons(),
    MT.loadTypeMap(),
  ]);
  const evSnap = r[0], uaDoc = r[1], callSnap = r[2] || empty, setSnap = r[3] || empty, heldSnap = r[4] || empty;
  const leadSnaps = r[5] || [], waSnap = r[6] || empty, dmSnap = r[7] || empty, actAll = r[8] || [];
  const rappelLeads = r[9] || [], persons = r[10], typeMap = r[11];
  let actSnap = empty;
  actAll.forEach(function (x) { if (x.slug === m.slug) actSnap = x.snap; });
  const lectures = [];      // sources en échec (null = lecture impossible)
  [['pages et clics', r[0], !!m.uid], ['appels', r[2], true], ['RDV créés', r[3], true], ['RDV du jour', r[4], true],
    ['messages et notes', r[5], true], ['WhatsApp', r[6], true], ['DM Instagram', r[7], isDm], ['actions sur les fiches', r[8], true], ['rappels', r[9], true]]
    .forEach(function (x) { if (x[2] && x[1] == null) lectures.push(x[0]); });

  const ev = [];
  const leadIds = {};
  function push(ms, cat, kind, title, extra) {
    if (!ms) return;
    const o = Object.assign({ at: isoOf(ms), cat: cat, kind: kind, title: title }, extra || {});
    if (o.leadId) leadIds[o.leadId] = 1;
    ev.push(o);
  }
  // Mêmes clés que l'onglet Activité : callsOut = sortants, answered =
  // sortants décrochés, talkSec = temps d'appel ; reçus à part. rdv = agrégat
  // StatsCore des RDV du jour dont la personne est le closer.
  const sum = { activeMs: 0, sessions: 0, firstSeenAt: null, lastSeenAt: null, clicks: 0, pages: 0,
    callsOut: 0, answered: 0, convos: 0, talkSec: 0, callsIn: 0, answeredIn: 0, talkInSec: 0, callsSansSens: 0,
    sms: 0, email: 0, whatsapp: 0, dm: 0, notes: 0, actions: 0, sets: 0, posesClic: 0, rdv: null };
  if (uaDoc && uaDoc.exists) {
    const u = uaDoc.data() || {};
    sum.activeMs = Number(u.activeMs) || 0; sum.sessions = Number(u.sessions) || 0;
    sum.firstSeenAt = isoOf(toMs(u.firstSeenAt)); sum.lastSeenAt = isoOf(toMs(u.lastSeenAt));
  }

  // Navigation et clics
  if (evSnap) evSnap.forEach(function (d) {
    (d.data().events || []).forEach(function (e) {
      const page = e.p || '';
      if (e.k === 'page') { sum.pages++; push(e.t, 'nav', 'page', 'Ouvre ' + page, { page: page, leadId: e.lead || null }); }
      else if (e.k === 'leave') push(e.t, 'nav', 'leave', 'Quitte ' + page, { page: page, ms: e.ms || 0 });
      else {
        sum.clicks++;
        push(e.t, 'click', e.k, (e.k === 'change' ? 'Choisit « ' + (e.v || '') + ' »' + (e.l ? ' dans ' + e.l : '') : 'Clic « ' + (e.l || e.a || e.h || '?') + ' »' + (e.v ? ' (' + e.v + ')' : '')),
          { page: page, action: e.a || null, href: e.h || null, leadId: e.lead || null });
      }
    });
  });

  // Appels (+ index des contacts pour les rappels)
  // Compteurs : tous les call_logs de la personne, sans fusion (mêmes
  // nombres que l'Activité, Set NB et le funnel). Frise : lancements restés
  // « sans suite » fusionnés avec l'appel réel (dit dans `notes`).
  const ci = contactIndex();
  const phonesToResolve = [];
  rawCalls(callSnap).forEach(function (d) {
    const c = d.data() || {};
    ci.call(c, R);
    if (callMember(c, R) !== m) return;
    callKeys(c).forEach(function (kv) { sum[kv[0]] += kv[1]; });
  });
  const myCalls = [];
  const callsVus = dedupeSnap(callSnap, R);
  let fusionsMiennes = 0;
  const brutsMiens = {};
  rawCalls(callSnap).forEach(function (d) { if (callMember(d.data() || {}, R) === m) brutsMiens[d.id] = 1; });
  callsVus.forEach(function (d) {
    const c = d.data() || {};
    if (callMember(c, R) !== m) return;
    myCalls.push(Object.assign({ id: d.id }, c));
  });
  fusionsMiennes = Math.max(0, Object.keys(brutsMiens).length - myCalls.length);
  myCalls.forEach(function (c) {
    const ok = isAnsweredCall(c);
    const talk = talkSecOf(c);
    const other = c.direction === 'inbound' ? c.fromNumber : c.toNumber;
    if (!c.leadId && !(c.leadNameSnapshot || c.leadName) && last9(other)) phonesToResolve.push(last9(other));
    push(toMs(c.initiatedAt), 'call', 'call',
      (c.direction === 'inbound' ? 'Appel reçu' : 'Appel passé') + ' — ' +
      (ok ? 'décroché · ' + Math.floor(talk / 60) + ' min ' + ('0' + (talk % 60)).slice(-2) + ' s' : (c.status === 'no-answer' ? 'pas de réponse' : (c.answeredAt ? 'répondeur / très court' : (CALL_STATUS_FR[c.status] || c.status || '')))),
      { leadId: c.leadId || null, leadName: c.leadNameSnapshot || c.leadName || null, number: other || null, callId: c.id, detail: c.aiSummary ? String(c.aiSummary).slice(0, 1500) : null });
  });

  // Messages et notes (texte complet)
  const seenLead = {};
  leadSnaps.forEach(function (sn) {
    sn.forEach(function (d) {
      if (seenLead[d.id]) return;
      seenLead[d.id] = 1;
      const l = d.data() || {};
      if (l._merged === true) return;
      (Array.isArray(l.communications) ? l.communications : []).forEach(function (c) {
        if (!c || c.direction !== 'outbound' || c.type === 'call' || estEnvoiAuto(c)) return;
        const ms = toMs(c.date || c.createdAt);
        if (ms < dayStart || ms >= dayEnd) return;
        if (commMember(c, R) !== m) return;
        const type = c.type === 'sms' ? 'sms' : (c.type === 'email' ? 'email' : (c.type || 'message'));
        if (sum[type] != null) sum[type]++;
        push(ms, 'msg', type, (type === 'sms' ? 'SMS envoyé' : (type === 'email' ? 'E-mail envoyé' : 'Message envoyé')) + (c.subject ? ' — ' + clip(c.subject, 120) : ''),
          { leadId: d.id, leadName: l.nom || null, detail: String(c.content || '').slice(0, 6000) });
      });
      (Array.isArray(l.notesHistory) ? l.notesHistory : []).forEach(function (n) {
        if (!n) return;
        const ms = toMs(n.date || n.createdAt);
        if (ms < dayStart || ms >= dayEnd || noteMember(n, R) !== m) return;
        sum.notes++;
        push(ms, 'fiche', 'note', 'Note ajoutée', { leadId: d.id, leadName: l.nom || null, detail: String(n.text || '').slice(0, 4000) });
      });
    });
  });

  // WhatsApp (texte relu dans la conversation)
  const myWa = [];
  waSnap.forEach(function (d) {
    const w = d.data() || {};
    ci.wa(w, R);
    if (!w.contexte || w.contexte.uid !== m.uid) return;
    myWa.push(Object.assign({ id: d.id }, w));
  });
  const waTexts = {};
  const waRefs = myWa.filter(function (w) { return w.wamid && w.to && /^[0-9]{8,15}$/.test(String(w.to)); }).slice(0, 150)
    .map(function (w) { return db.collection('whatsapp_conversations').doc(String(w.to)).collection('messages').doc(String(w.wamid)); });
  if (waRefs.length) {
    const snaps = await db.getAll.apply(db, waRefs).catch(function () { return []; });
    snaps.forEach(function (s) { if (s.exists) waTexts[s.id] = (s.data() || {}).texte || ''; });
  }
  myWa.forEach(function (w) {
    if (last9(w.to)) phonesToResolve.push(last9(w.to));
    if (w.statut !== 'refuse') sum.whatsapp++;
    const txt = waTexts[w.wamid] || (w.modele ? 'Modèle « ' + w.modele + ' »' : (w.media ? 'Fichier ' + (w.nomFichier || '') : ''));
    push(toMs(w.at), 'msg', 'whatsapp', 'WhatsApp ' + (w.statut === 'refuse' || w.statut === 'echec' ? 'NON parti (' + (w.erreur || w.statut) + ')' : 'envoyé'),
      { number: w.to ? '+' + w.to : null, detail: txt ? String(txt).slice(0, 4000) : null });
  });

  // DM Instagram (setter écrit)
  const dms = [];
  dmSnap.forEach(function (d) { dms.push(d.data() || {}); });
  const threadIds = dms.map(function (x) { return x.igsid; }).filter(function (v, i, a) { return v && a.indexOf(v) === i; }).slice(0, 200);
  const threads = {};
  if (threadIds.length) {
    const ts = await db.getAll.apply(db, threadIds.map(function (id) { return db.collection('ig_dm_threads').doc(String(id)); })).catch(function () { return []; });
    ts.forEach(function (s) { if (s.exists) threads[s.id] = s.data() || {}; });
  }
  dms.forEach(function (x) {
    const t = threads[x.igsid] || {};
    const who = t.username ? '@' + t.username : (t.name || 'compte Instagram');
    if (x.direction === 'out') sum.dm++;
    push(Number(x.timestampMs) || 0, 'msg', x.direction === 'out' ? 'dm_out' : 'dm_in',
      (x.direction === 'out' ? 'DM Instagram envoyé à ' : 'DM Instagram reçu de ') + who,
      { leadId: t.leadId || null, leadName: t.leadNom || null, detail: (x.text || '') + (x.hasAttachment ? ' [pièce jointe]' : '') });
  });

  // Actions sur les fiches : index des contacts = toute l'équipe (comme
  // l'Activité) ; frise et compteur = celles de la personne.
  actAll.forEach(function (x) {
    if (x.slug === m.slug) return;
    const am = R.bySlug[x.slug];
    x.snap.forEach(function (d) { const a = d.data() || {}; if (a.leadId) ci.action(a.leadId, toMs(a.createdAt), am ? am.name : x.slug); });
  });
  actSnap.forEach(function (d) {
    const a = d.data() || {};
    sum.actions++;
    if (a.leadId) ci.action(a.leadId, toMs(a.createdAt), m.name);
    const title = a.action === 'set_booking' ? 'RDV posé (Leads Live)' : (a.action === 'assign' ? 'Attribution ' + (a.assignFrom || '—') + ' → ' + (a.assignTo || '—') : 'Statut ' + (a.prevStatus ? a.prevStatus + ' → ' : '→ ') + a.action);
    push(toMs(a.createdAt) || MT.parisToUtcMs(date, '12:00'), 'fiche', 'action', title, { leadId: a.leadId || null, leadName: a.leadName || null });
  });

  // RDV créés ce jour (Sets, posés par clic) et RDV du jour dont la personne
  // est le closer (StatsCore : même compte que l'Activité et l'En direct).
  function remindersTxt(b) {
    const rs = b.remindersSent || {};
    const parts = [];
    if (rs.j1_email) parts.push('J-1 e-mail'); if (rs.j1_sms) parts.push('J-1 SMS');
    if (rs.h1_email) parts.push('H-1 e-mail'); if (rs.h1_sms) parts.push('H-1 SMS');
    return parts.length ? 'Rappels auto envoyés : ' + parts.join(', ') : 'Aucun rappel auto envoyé';
  }
  const crees = [];
  setSnap.forEach(function (d) {
    const b = Object.assign({ id: d.id }, d.data() || {});
    const ms = toMs(b.createdAt);
    if (ms < dayStart || ms >= dayEnd) return;
    crees.push(b);
  });
  let fiches = {};
  let attributionPartielle = false;
  const setIds = crees.filter(function (b) { return estSet(b, typeMap) && b.leadId; }).map(function (b) { return String(b.leadId); });
  if (setIds.length) {
    try { fiches = await fichesSetter(setIds); } catch (e) { attributionPartielle = true; console.warn('[team-pilotage] journal fiches des sets', e.message); }
  }
  crees.forEach(function (b) {
    const set = estSet(b, typeMap);
    const setter = set ? setterOf(b, fiches, R) : null;
    const isSet = set && setter === m;
    const isClic = estPoseClic(b, typeMap) && b.bookedBySlug === m.slug;
    if (!isSet && !isClic) return;
    if (isSet) sum.sets++;
    if (isClic) sum.posesClic++;
    const poseur = b.bookedBySlug ? (R.bySlug[b.bookedBySlug] || null) : null;
    let quoi;
    if (isSet && isClic) quoi = 'Set — RDV posé';
    else if (isSet) quoi = 'Set (setter de la fiche) — RDV posé par ' + (poseur ? poseur.name : 'quelqu\'un d\'autre');
    else if (set) quoi = 'RDV posé (clic) — set compté chez ' + (setter ? setter.name : 'Non attribué');
    else quoi = 'RDV posé (clic) — ' + (SC.CLASSES[rdvClasse(b, typeMap)] || 'hors setting') + ', pas un set';
    push(toMs(b.createdAt), 'rdv', 'booking_set', quoi + ' pour le ' + String(b.date || '').split('-').reverse().join('/') + ' à ' + (b.time || '?') + (b.typeLabel ? ' — ' + b.typeLabel : ''),
      { leadId: b.leadId || null, leadName: prospectName(b), bookingId: b.id });
  });
  const heldIds = [];
  const helds = [];
  heldSnap.forEach(function (d) {
    const b = d.data() || {};
    if (!estRdvVente(b, typeMap) || bookingCloser(b, R, persons) !== m) return;
    heldIds.push(d.id);
    helds.push(Object.assign({ id: d.id }, b));
  });
  // Compteurs : StatsCore.compter (doublons et replanifiés hors RDV). La
  // frise, elle, garde tous les RDV avec leur état.
  sum.rdv = rdvAgg(helds, now);
  const meets = {};
  if (heldIds.length) {
    const ms = await db.getAll.apply(db, heldIds.map(function (id) { return db.collection('booking_meet').doc(id); })).catch(function () { return []; });
    ms.forEach(function (s) { if (s.exists) meets[s.id] = s.data() || {}; });
  }
  helds.forEach(function (b) {
    const bm = meets[b.id] || {};
    const pr = bm.presence && bm.presence.ok ? bm.presence : null;
    const s2 = pr && pr.summary ? pr.summary : null;
    const lines = [remindersTxt(b)];
    if (Number(bm.clicks)) lines.push('Lien Meet cliqué ' + bm.clicks + ' fois (1er clic ' + new Date(toMs(bm.firstClickAt)).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) + ')');
    if (pr) lines.push('Visio : ' + (pr.participants || []).filter(function (p) { return p.kind !== 'bot'; }).map(function (p) {
      return p.name + ' ' + (p.joinedAt ? new Date(p.joinedAt).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : '') + (p.leftAt ? ' → ' + new Date(p.leftAt).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : (p.inRoom ? ' → présent' : ''));
    }).join(' · '));
    if (b.outcomeNote) lines.push('Note de résultat : ' + b.outcomeNote);
    const lib = SC.libelle(b, now);
    push(MT.bookingStartMs(b), 'rdv', 'booking', 'RDV ' + (b.typeLabel || '') + ' — ' + lib.mot +
      (s2 ? (s2.prospectJoined ? ' · prospect venu' : ' · prospect jamais entré') : ''),
      { leadId: b.leadId || null, leadName: prospectName(b), bookingId: b.id, detail: lines.join('\n') });
  });

  // Rappels du jour de cette personne
  const rappels = computeRappels(rappelLeads, R, ci, dayStart, dayEnd, now).filter(function (x) { return x.owner === m; });
  const RAP_TXT = { fait: 'fait', a_venir: 'à venir', coche_sans_contact: 'coché sans contact', en_retard: 'EN RETARD' };
  rappels.forEach(function (x) {
    delete x.owner;
    push(Date.parse(x.dueAt), 'rappel', 'rappel', 'Rappel prévu — ' + RAP_TXT[x.status] + (x.contact ? ' (' + x.contact.kind + ' à ' + new Date(x.contact.at).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) + (x.contact.who ? ' par ' + x.contact.who : '') + ')' : ''),
      { leadId: x.leadId, leadName: x.leadName, detail: x.note || null, status: x.status });
  });

  // Noms des prospects (fiches citées par les clics, appels, actions…)
  try {
    const names = {};
    const ids = Object.keys(leadIds).filter(function (id) { return /^[A-Za-z0-9_-]{3,80}$/.test(id); }).slice(0, 300);
    if (ids.length) {
      const refs = ids.map(function (id) { return db.collection('leads').doc(id); });
      const snaps = await db.getAll.apply(db, refs.concat([{ fieldMask: ['nom'] }]));
      snaps.forEach(function (s) { if (s.exists) names[s.id] = (s.data() || {}).nom || ''; });
    }
    const byPhone = phonesToResolve.length ? await leadNamesByPhone(phonesToResolve) : {};
    ev.forEach(function (e) {
      if (!e.leadName && e.leadId && names[e.leadId]) e.leadName = names[e.leadId];
      if (!e.leadName && !e.leadId && e.number && byPhone[last9(e.number)]) { e.leadName = byPhone[last9(e.number)].nom; e.leadId = byPhone[last9(e.number)].id; }
    });
  } catch (e) { console.warn('[team-pilotage] journal noms', e.message); }

  ev.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
  const rs = { due: rappels.length, done: 0, late: 0, checked: 0, upcoming: 0 };
  rappels.forEach(function (x) {
    if (x.status === 'fait') rs.done++; else if (x.status === 'en_retard') rs.late++;
    else if (x.status === 'coche_sans_contact') rs.checked++; else rs.upcoming++;
  });
  sum.rappels = rs;
  // Plafonds de lecture et lectures en échec : nommés, jamais tus.
  const plafonds = [];
  function plafond(snap, lim, nom) { if (snap && snap.size >= lim) plafonds.push(nom + ' (' + lim + ' lus)'); }
  plafond(evSnap, LIM.ev, 'pages et clics');
  plafond(callSnap, LIM.calls, 'appels');
  plafond(setSnap, LIM.rdvCrees, 'RDV créés');
  plafond(heldSnap, LIM.rdv, 'RDV du jour');
  (leadSnaps || []).forEach(function (sn) { plafond(sn, LIM.leads, 'fiches (messages et notes)'); });
  plafond(waSnap, LIM.wa, 'WhatsApp');
  plafond(dmSnap, LIM.dm, 'DM Instagram');
  if (rappelLeads && rappelLeads._tronque) plafonds.push('fiches à rappels (' + RAPPEL_LEADS_LIMIT + ' lues)');
  const warnings = lectures.map(function (x) { return x + ' : lecture impossible'; });
  if (attributionPartielle) warnings.push('fiches des sets : lecture impossible — attribution partielle, sets rangés d\'après la personne qui a posé le RDV');
  if (sum.callsSansSens) warnings.push(phraseSansSens(sum.callsSansSens));
  // Notes d'explication (pas des données partielles) : écarts légitimes
  // entre la frise et les compteurs.
  const notes = [];
  if (fusionsMiennes) notes.push(phraseFusions(fusionsMiennes));
  res.status(200).json({ ok: true, date: date, member: publicMember(m), members: membersList, summary: sum, rappels: rappels,
    events: ev.slice(0, 5000), total: ev.length, plafonds: plafonds.filter(function (x, i, a) { return a.indexOf(x) === i; }), warnings: warnings,
    notes: notes, fusionsAppels: fusionsMiennes });
}

// ─── RECHERCHE ET HISTORIQUE D'UN PROSPECT ──────────────────────────────────
async function handleSearch(req, res, body) {
  const q = String(body.q || '').trim().slice(0, 80);
  if (q.length < 2) { res.status(200).json({ ok: true, results: [] }); return; }
  const found = {};
  const LF = ['nom', 'telephone', 'email', 'status', 'stage', '_merged', 'createdAt'];
  function collect(snap) {
    snap.forEach(function (d) {
      const l = d.data() || {};
      if (l._merged === true || found[d.id]) return;
      found[d.id] = { id: d.id, nom: l.nom || '', telephone: l.telephone || '', email: l.email || '', status: l.status || l.stage || '' };
    });
  }
  const digits = q.replace(/[^0-9]/g, '');
  const tasks = [];
  if (digits.length >= 9 && digits.length >= q.replace(/[\s+().-]/g, '').length - 1) {
    const k = digits.slice(-9);
    const qq = db.collection('leads').where('phoneNormalized', '==', k).limit(10);
    tasks.push(qq.select.apply(qq, LF).get().then(collect));
  } else if (q.indexOf('@') > 0) {
    [q, q.toLowerCase()].filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (v) {
      const qq = db.collection('leads').where('email', '==', v).limit(10);
      tasks.push(qq.select.apply(qq, LF).get().then(collect));
    });
  } else {
    const variants = [q, q.charAt(0).toUpperCase() + q.slice(1).toLowerCase(), q.toUpperCase(), q.toLowerCase()];
    variants.filter(function (v, i, a) { return a.indexOf(v) === i; }).forEach(function (v) {
      const qq = db.collection('leads').where('nom', '>=', v).where('nom', '<=', v + '').limit(12);
      tasks.push(qq.select.apply(qq, LF).get().then(collect));
    });
  }
  await Promise.all(tasks.map(function (t) { return t.catch(function (e) { console.warn('[team-pilotage] search', e.message); }); }));
  res.status(200).json({ ok: true, results: Object.keys(found).map(function (k) { return found[k]; }).slice(0, 25) });
}

function clip(s, n) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// Téléphone de fiche → E.164 (France par défaut). Les fiches gardent souvent
// la saisie brute « 06 70 08 66 83 » : sans ça, la conversation WhatsApp
// (clé 33XXXXXXXXX) et les SMS Twilio du prospect sont introuvables.
function toE164(raw, normalized9) {
  const s = String(raw || '').trim();
  const d = s.replace(/[^0-9]/g, '');
  if (s.charAt(0) === '+' && d.length >= 8 && d.length <= 15) return '+' + d;
  if (d.indexOf('00') === 0 && d.length >= 10 && d.length <= 17) return '+' + d.slice(2);
  if (d.length === 10 && d.charAt(0) === '0') return '+33' + d.slice(1);
  if (d.length === 11 && d.indexOf('33') === 0) return '+' + d;
  if (d.length === 9 && /^[67]/.test(d)) return '+33' + d;
  const n9 = String(normalized9 || '');
  return /^\d{9}$/.test(n9) ? '+33' + n9 : null;
}

// SMS Twilio envoyés au prospect ou reçus de lui. Seule trace des SMS
// automatiques (rappels J-1 / H-1 et confirmation des Cloud Functions,
// automatisations) : ils ne sont pas écrits sur la fiche.
const TWILIO_TIMEOUT_MS = 8000;
async function loadTwilioSms(e164) {
  const { getTwilioClient } = require('./_twilioClient');
  const client = await getTwilioClient();
  let timer = null;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('Twilio ne répond pas')); }, TWILIO_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([Promise.all([
      client.messages.list({ to: e164, limit: 200, pageSize: 100 }),
      client.messages.list({ from: e164, limit: 200, pageSize: 100 }),
    ]), timeout]);
    return r[0].concat(r[1]);
  } finally {
    clearTimeout(timer);
  }
}

function smsBodyKey(s) {
  return String(s || '').replace(/^\s*message\s*:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 60);
}

const WA_STATUT_FR = { read: ' · lu', delivered: ' · distribué', failed: ' · NON délivré', refuse: ' · NON parti', echec: ' · NON parti' };
function waText(w) {
  const t = String(w.texte || '').trim();
  if (w.modele && (!t || t === '[' + w.modele + ']')) {
    const p = Array.isArray(w.params) ? w.params.filter(Boolean) : [];
    return 'modèle « ' + w.modele + ' »' + (p.length ? ' (' + p.join(' · ') + ')' : '');
  }
  if (!t && (w.media || w.nomFichier)) return 'fichier ' + (w.nomFichier || '');
  return t || '(sans texte)';
}

async function handleLead(req, res, body) {
  let leadId = String(body.leadId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(leadId)) { res.status(400).json({ error: 'leadId invalide' }); return; }
  let snap = await db.collection('leads').doc(leadId).get();
  // Fiche fusionnée : on suit le survivant (motif pickAlive).
  for (let i = 0; i < 3 && snap.exists && (snap.data() || {})._merged === true && (snap.data() || {})._mergedInto; i++) {
    leadId = String(snap.data()._mergedInto);
    snap = await db.collection('leads').doc(leadId).get();
  }
  if (!snap.exists) { res.status(404).json({ error: 'Fiche introuvable' }); return; }
  const l = snap.data() || {};

  const R = await loadRoster();
  const persons = await loadPersons();
  const slugs = R.list.map(function (m) { return m.slug; });
  const tel = String(l.telephone || '').trim();
  const e164 = toE164(tel, l.phoneNormalized);
  const waNum = e164 ? e164.slice(1) : '';

  function nameOf(m, fallback) { return m ? m.name : (fallback || null); }

  const calls = {};
  const callQs = [db.collection('call_logs').where('leadId', '==', leadId).limit(200)];
  [e164, tel].filter(function (p, i, a) { return /^\+\d{8,15}$/.test(p || '') && a.indexOf(p) === i; }).forEach(function (p) {
    callQs.push(db.collection('call_logs').where('toNumber', '==', p).limit(200));
    callQs.push(db.collection('call_logs').where('fromNumber', '==', p).limit(200));
  });
  let smsError = null;
  const [callSnaps, bookSnap, actSnaps, waSnap, waOutSnap, twSms] = await Promise.all([
    Promise.all(callQs.map(function (q) { return q.select.apply(q, CALL_FIELDS.concat(['aiSummary'])).get().catch(function () { return null; }); })),
    db.collection('bookings').where('leadId', '==', leadId).limit(100).get().catch(function () { return null; }),
    Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items').where('leadId', '==', leadId).limit(200).get().catch(function () { return null; });
    })),
    waNum.length >= 10
      ? db.collection('whatsapp_conversations').doc(waNum).collection('messages').orderBy('at', 'desc').limit(200).get().catch(function () { return null; })
      : Promise.resolve(null),
    // Journal d'envoi : seul endroit où restent les WhatsApp refusés ou en échec.
    waNum.length >= 10
      ? db.collection('whatsapp_messages').where('to', '==', waNum).limit(200).get().catch(function () { return null; })
      : Promise.resolve(null),
    e164
      ? loadTwilioSms(e164).catch(function (e) { console.warn('[team-pilotage] twilio', e.message); smsError = e.message || 'erreur'; return null; })
      : Promise.resolve(null),
  ]);

  const ev = [];
  function push(ms, kind, who, text, extra) {
    if (!ms) return null;
    const o = Object.assign({ at: isoOf(ms), kind: kind, who: who || null, text: text || '' }, extra || {});
    ev.push(o);
    return o;
  }

  push(toMs(l.createdAt), 'creation', null, 'Fiche créée' + (l.source ? ' — source ' + l.source : ''));

  callSnaps.forEach(function (s) {
    if (s) s.forEach(function (d) { calls[d.id] = d.data() || {}; });
  });
  // Histoire d'un prospect = une liste, pas un compteur : lancements restés
  // « sans suite » fusionnés avec l'appel réel (nombre dit dans `notes`).
  const callsVus = dedupeSnap({ forEach: function (fn) { Object.keys(calls).forEach(function (id) { fn({ id: id, data: function () { return calls[id]; } }); }); } }, R);
  const fusionsAppels = callsVus.fusions || 0;
  callsVus.forEach(function (cd) {
    const id = cd.id;
    const c = cd.data();
    const m = callMember(c, R);
    const talk = talkSecOf(c);
    const res2 = isAnsweredCall(c) ? 'décroché' + (talk ? ' · ' + Math.floor(talk / 60) + ' min ' + ('0' + (talk % 60)).slice(-2) + ' s' : '') : (c.status === 'no-answer' ? 'pas de réponse' : (c.answeredAt ? 'répondeur / très court' : (CALL_STATUS_FR[c.status] || c.status || '')));
    push(toMs(c.initiatedAt), 'call', nameOf(m, c.userName), (c.direction === 'inbound' ? 'Appel reçu' : 'Appel passé') + ' — ' + res2,
      { callId: id, summary: c.aiSummary ? clip(c.aiSummary, 280) : null });
  });

  const bookingIds = [];
  if (bookSnap) bookSnap.forEach(function (d) {
    const b = d.data() || {};
    bookingIds.push(d.id);
    const closer = bookingCloser(b, R, persons);
    const setter = b.bookedBySlug ? R.bySlug[b.bookedBySlug] : null;
    push(toMs(b.createdAt), 'booking_set', setter ? setter.name : null,
      'RDV posé pour le ' + (b.date || '?').split('-').reverse().join('/') + ' à ' + (b.time || '?') + (b.typeLabel ? ' — ' + b.typeLabel : '') + (setter ? '' : ' (réservé par le prospect)'),
      { bookingId: d.id });
    // État unique du RDV (StatsCore) : même mot que les autres écrans.
    const lib = SC.libelle(b, Date.now());
    push(MT.bookingStartMs(b), 'booking', closer ? closer.name : (b.personName || null),
      'RDV ' + (b.typeLabel || '') + ' — ' + lib.mot,
      { bookingId: d.id, outcome: b.outcome || null, etat: lib.etat, note: b.outcomeNote ? clip(b.outcomeNote, 200) : null });
  });
  if (bookingIds.length) {
    const ms = await db.getAll.apply(db, bookingIds.map(function (id) { return db.collection('booking_meet').doc(id); })).catch(function () { return []; });
    ms.forEach(function (s) {
      if (!s.exists) return;
      const x = s.data() || {};
      if (x.firstClickAt) push(toMs(x.firstClickAt), 'meet_click', null, 'Le prospect a cliqué sur le lien Meet' + (Number(x.clicks) > 1 ? ' (' + x.clicks + ' clics)' : ''), { bookingId: s.id });
      const pr = x.presence;
      if (pr && pr.ok && pr.participants) {
        pr.participants.forEach(function (p) {
          if (p.kind === 'equipe' || p.kind === 'bot') return;
          push(toMs(p.joinedAt), 'meet_join', null, p.name + ' est entré(e) dans la visio', { bookingId: s.id });
        });
      }
    });
  }

  actSnaps.forEach(function (s, i) {
    if (!s) return;
    const m = R.bySlug[slugs[i]];
    s.forEach(function (d) {
      const a = d.data() || {};
      let text = a.action === 'set_booking' ? 'Action : RDV posé' : (a.action === 'assign' ? 'Attribution ' + (a.assignFrom || '—') + ' → ' + (a.assignTo || '—') : 'Statut : ' + (a.prevStatus ? a.prevStatus + ' → ' : '') + a.action);
      push(toMs(a.createdAt) || MT.parisToUtcMs(a.day, '12:00'), 'action', nameOf(m, slugs[i]), text);
    });
  });

  // SMS et e-mails tracés sur la fiche. Les SMS sont gardés de côté pour
  // dédoublonner ceux que Twilio renvoie ci-dessous.
  const smsOnFile = [];
  (Array.isArray(l.communications) ? l.communications : []).forEach(function (c) {
    if (!c || c.type === 'call' || c.type === 'appel') return;
    const m = commMember(c, R);
    const inbound = /^(in|entr)/.test(String(c.direction || '').toLowerCase());
    // Make n'écrit que le jour dans `date` ; l'heure (Paris) est dans `createdAt`.
    const ms = /^\d{4}-\d{2}-\d{2}$/.test(String(c.date || '')) ? (toMs(c.createdAt) || toMs(c.date)) : toMs(c.date || c.createdAt);
    if (c.type === 'sms') {
      const txt = String(c.content || '').replace(/^\s*message\s*:\s*/i, '');
      // Ringover et Make écrivent chacun le même SMS sur la fiche.
      // On garde la première, complétée de l'auteur et de l'identifiant de l'autre.
      const who = inbound ? null : nameOf(m, c.ownerName);
      const sid = c.providerMessageSid || c.providerMessageId || null;
      const dup = smsOnFile.find(function (s) { return s.inbound === inbound && s.key === smsBodyKey(txt) && Math.abs(s.ms - ms) < 10 * 60000; });
      if (dup) {
        if (who && dup.ev && !dup.ev.who) dup.ev.who = who;
        if (sid && !dup.sid) dup.sid = sid;
        return;
      }
      const o = push(ms, 'sms', who, 'SMS ' + (inbound ? 'reçu' : 'envoyé') + ' — ' + clip(txt, 600),
        { channel: 'sms', direction: inbound ? 'inbound' : 'outbound' });
      smsOnFile.push({ ms: ms, inbound: inbound, sid: sid, key: smsBodyKey(txt), ev: o });
      return;
    }
    const label = c.type === 'email' ? 'E-mail' : (c.type || 'Message');
    push(ms, c.type === 'email' ? 'email' : 'message', nameOf(m, c.ownerName),
      label + (inbound ? ' reçu' : ' envoyé') + ' — ' + clip(c.content, 220), { channel: c.type || null, direction: inbound ? 'inbound' : 'outbound' });
  });
  (Array.isArray(l.notesHistory) ? l.notesHistory : []).forEach(function (n) {
    if (!n) return;
    push(toMs(n.date || n.createdAt), 'note', nameOf(noteMember(n, R), n.authorName), clip(n.text, 400));
  });

  // SMS Twilio : ceux déjà sur la fiche sont complétés (non délivré), les
  // autres — rappels automatiques surtout — sont ajoutés.
  if (Array.isArray(twSms)) {
    const seenSid = {};
    twSms.forEach(function (t) {
      if (!t || !t.sid || seenSid[t.sid]) return;
      seenSid[t.sid] = 1;
      const ms = toMs(t.dateSent || t.dateCreated);
      const inbound = String(t.direction || '') === 'inbound';
      const failed = /^(failed|undelivered|canceled)$/.test(String(t.status || ''));
      const key = smsBodyKey(t.body);
      const match = smsOnFile.find(function (s) {
        if (s.used) return false;
        if (s.sid) return s.sid === t.sid;
        return s.inbound === inbound && Math.abs(s.ms - ms) < 5 * 60000 && s.key === key;
      });
      if (match) {
        match.used = true;
        if (failed && match.ev) match.ev.text = match.ev.text.replace(/^SMS envoyé/, 'SMS NON délivré (' + t.status + ')');
        return;
      }
      push(ms, 'sms', inbound ? null : 'Automatique',
        (inbound ? 'SMS reçu' : (failed ? 'SMS NON délivré (' + t.status + ')' : 'SMS envoyé')) + ' — ' + clip(t.body, 600),
        { channel: 'sms', direction: inbound ? 'inbound' : 'outbound' });
    });
  }

  // WhatsApp : la conversation (reçus et envoyés) puis le journal d'envoi pour
  // les messages refusés ou en échec, absents de la conversation.
  const waSeen = {};
  function pushWa(w) {
    const inbound = w.sens === 'in';
    const ctx = w.contexte || {};
    const m = ctx.uid ? R.byUid[ctx.uid] : null;
    const who = inbound ? null : (m ? m.name : (ctx.par ? String(ctx.par).split('@')[0] : 'Automatique'));
    const st = String(w.statut || '');
    const bad = st === 'refuse' || st === 'echec' || st === 'failed';
    push(toMs(w.at), 'whatsapp', who,
      'WhatsApp ' + (inbound ? 'reçu' : (bad ? 'NON parti' + (w.erreur ? ' (' + clip(w.erreur, 120) + ')' : '') : 'envoyé' + (WA_STATUT_FR[st] || ''))) + ' — ' + clip(waText(w), 600),
      { channel: 'whatsapp', direction: inbound ? 'inbound' : 'outbound' });
  }
  if (waSnap) waSnap.forEach(function (d) {
    const w = d.data() || {};
    waSeen[d.id] = 1;
    if (w.wamid) waSeen[w.wamid] = 1;
    pushWa(w);
  });
  if (waOutSnap) waOutSnap.forEach(function (d) {
    const w = d.data() || {};
    if ((w.wamid && waSeen[w.wamid]) || waSeen[d.id]) return;
    if (w.wamid) waSeen[w.wamid] = 1;
    pushWa(w);
  });
  (Array.isArray(l.timeline_history) ? l.timeline_history : []).forEach(function (t) {
    if (!t) return;
    push(toMs(t.date), 'journal', null, clip(t.text, 260));
  });

  ev.sort(function (a, b) { return a.at < b.at ? 1 : (a.at > b.at ? -1 : 0); });
  const setter = l.setterSlug ? R.bySlug[l.setterSlug] : null;
  const owner = l.assignedTo ? (R.bySlug[l.assignedTo] || R.byUid[l.assignedTo] || null) : null;
  res.status(200).json({
    ok: true,
    lead: {
      id: leadId, nom: l.nom || '', telephone: tel, email: l.email || '', status: l.status || '', stage: l.stage || '',
      setterName: setter ? setter.name : (l.setterName || null), ownerName: owner ? owner.name : (l.assignedTo || null),
      createdAt: isoOf(toMs(l.createdAt)),
    },
    events: ev.slice(0, 800), total: ev.length,
    smsError: smsError,
    notes: fusionsAppels ? [phraseFusions(fusionsAppels)] : [], fusionsAppels: fusionsAppels,
  });
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  const action = String(body.action || '').trim();
  try {
    if (action === 'live') return await handleLive(req, res);
    if (action === 'activity') return await handleActivity(req, res, body);
    if (action === 'search') return await handleSearch(req, res, body);
    if (action === 'lead') return await handleLead(req, res, body);
    if (action === 'journal') return await handleJournal(req, res, body);
    return res.status(400).json({ error: 'Action inconnue : ' + (action || '(vide)') });
  } catch (e) {
    console.error('[team-pilotage] ' + action, e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Erreur interne' });
  }
};

/* Lecture de la présence Meet, réutilisée par le rattrapage du parcours RDV
   (api/_parcoursRdv.js, 24/11/2026). Ajout pur : la route ne change pas. */
module.exports.fetchPresence = fetchPresence;
module.exports.presenceSummary = presenceSummary;
module.exports.loadRoster = loadRoster;
module.exports.loadPersons = loadPersons;
