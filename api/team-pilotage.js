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
//   → Par personne et par jour : appels passés / reçus / décrochés, temps de
//     parole, RDV posés, RDV tenus et leurs résultats, SMS / e-mails / WhatsApp
//     envoyés, actions sur les fiches (lead_actions) et notes.
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
const CONVO_SEC = 60;                     // « vraie conversation » : 1 min et plus

// « Décroché » = règle du Funnel (funnel-core.js isAnsweredCall) : Ringover
// pose answeredAt même sur une messagerie, donc au moins 5 s de conversation,
// et une longue sonnerie suivie de moins de 15 s de parole = répondeur.
const ANSWERED_MIN_SEC = 5;
const VOICEMAIL_MIN_RING_SEC = 15;
const VOICEMAIL_MAX_TALK_SEC = 15;
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
      return;
    }
    last[key] = { t: t, i: keep.length, x: x };
    keep.push(x);
  });
  return keep.map(function (x) { return { id: x.id, data: function () { return x.c; } }; });
}

function talkSecOf(c) {
  return Number(c.talkDurationSec || c.durationSec) || 0;
}
function isAnsweredCall(c) {
  const talk = Number(c.durationSec) || 0;
  if (talk < ANSWERED_MIN_SEC) return false;
  let ring = Number(c.ringingDurationSec);
  if (!isFinite(ring) || ring < 0 || c.ringingDurationSec == null) {
    const a = toMs(c.answeredAt), i = toMs(c.initiatedAt);
    ring = a && i && a >= i ? Math.round((a - i) / 1000) : null;
  }
  if (ring == null) return true;
  return !(ring >= VOICEMAIL_MIN_RING_SEC && talk < VOICEMAIL_MAX_TALK_SEC);
}

const OUTCOME_KEYS = ['close', 'non_close', 'offre', 'disqualifie', 'no_show', 'annule', 'replanifie'];

const CALL_FIELDS = [
  'direction', 'status', 'leadId', 'leadNameSnapshot', 'leadName',
  'fromNumber', 'toNumber', 'initiatedAt', 'answeredAt', 'endedAt',
  'durationSec', 'talkDurationSec', 'ringingDurationSec', 'userId', 'userName', 'ringoverUserName', 'provider',
];
const BOOKING_FIELDS = [
  'date', 'time', 'duration', 'personId', 'personName', 'expertSlug', 'closeData.closerSlug',
  'bookedBySlug', 'outcome', 'status', 'source', 'type', 'typeLabel', 'isCoaching', 'clientId',
  'skipLeadCreation', 'prospect.nom', 'prospect.prenom', 'leadId', 'meetLink', 'createdAt',
];

// ─── Dates ──────────────────────────────────────────────────────────────────
function todayIsoParis(d) {
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}
function parisDayOfMs(ms) {
  return ms ? todayIsoParis(new Date(ms)) : null;
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
  const t = Date.parse(s);
  return isNaN(t) ? 0 : t;
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
  const R = { list: [], bySlug: {}, byUid: {}, byFirst: {} };
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
      departed: m.departed === true || m.active === false,
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

function callMember(c, R) {
  if (c.userId && R.byUid[c.userId]) return R.byUid[c.userId];
  const n = normName(c.userName || c.ringoverUserName).split(' ')[0];
  return (n && R.byFirst[n]) || null;
}

// Closeur d'un RDV — même ordre que memberMatchesBooking (sales-closing.html),
// la fiche expert (booking_config) passant avant l'égalité personId == slug :
// la fiche « elodie » est reprise par Anthony depuis le 10/10/2026.
function bookingCloser(b, R, persons) {
  const cd = b.closeData || {};
  if (cd.closerSlug && R.bySlug[cd.closerSlug]) return R.bySlug[cd.closerSlug];
  if (b.expertSlug && R.bySlug[b.expertSlug]) return R.bySlug[b.expertSlug];
  const p = persons[b.personId];
  if (p && p.firebaseUid && R.byUid[p.firebaseUid]) return R.byUid[p.firebaseUid];
  if (b.personId && R.bySlug[b.personId]) return R.bySlug[b.personId];
  return null;
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
  const dayStart = MT.parisToUtcMs(today, '00:00');
  const fromMs = Math.min(dayStart, now - 4 * 3600 * 1000);

  const callQ = db.collection('call_logs')
    .where('initiatedAt', '>=', admin.firestore.Timestamp.fromMillis(fromMs))
    .orderBy('initiatedAt', 'desc').limit(1500);
  const [R, persons, typeMap, callSnap, bookSnap, actSnap] = await Promise.all([
    loadRoster(),
    loadPersons(),
    MT.loadTypeMap(),
    callQ.select.apply(callQ, CALL_FIELDS).get(),
    db.collection('bookings').where('date', '==', today).get(),
    db.collection('user_activity').where('kind', '==', 'summary').get(),
  ]);
  const [dayActSnap, dmSnap] = await Promise.all([
    db.collection('user_activity').where('date', '==', today).get().catch(function () { return null; }),
    db.collection('ig_dm_events').where('date', '==', today).select('direction', 'timestampMs').get().catch(function () { return null; }),
  ]);

  // Ligne par membre sales (+ tout membre non coach / CSM qui apparaît).
  const rows = {};
  function row(m) {
    if (!m || m.departed || m.hidden) return null;
    if (!rows[m.slug]) {
      rows[m.slug] = Object.assign(publicMember(m), {
        status: 'offline', call: null, meet: null, online: null,
        today: { calls: 0, answered: 0, talkSec: 0, lastCallAt: null, activeMs: 0, sessions: 0, firstSeenAt: null, dmOut: 0, dmIn: 0, lastDmAt: null },
      });
    }
    return rows[m.slug];
  }
  R.list.forEach(function (m) { if (m.sales) row(m); });

  // Appels
  const liveCalls = [];
  const phonesToResolve = [];
  dedupeSnap(callSnap, R).forEach(function (d) {
    const c = d.data() || {};
    const m = callMember(c, R);
    const ini = toMs(c.initiatedAt);
    const ans = toMs(c.answeredAt);
    const r = row(m);
    if (r && ini >= dayStart) {
      r.today.calls += 1;
      if (isAnsweredCall(c)) r.today.answered += 1;
      r.today.talkSec += talkSecOf(c);
      if (!r.today.lastCallAt || ini > Date.parse(r.today.lastCallAt)) r.today.lastCallAt = isoOf(ini);
    }
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

  // RDV de closing du jour
  const bookings = [];
  bookSnap.forEach(function (d) {
    const b = Object.assign({ id: d.id }, d.data() || {});
    if (!MT.isClosingBooking(b, typeMap)) return;
    if (b.status === 'cancelled' && !b.outcome) return;
    bookings.push(b);
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
    const o = {
      id: b.id, time: b.time || '', duration: Number(b.duration) || 30, start: isoOf(start), end: isoOf(end),
      phase: phase, prospect: prospectName(b), leadId: b.leadId || null, typeLabel: b.typeLabel || '',
      closerSlug: closer ? closer.slug : null, closerName: closer ? closer.name : (b.personName || null),
      setterSlug: setter ? setter.slug : null, setterName: setter ? setter.name : null,
      outcome: b.outcome || null, status: b.status || null, hasMeet: !!b.meetLink, tracked: !!(b.meetLink && b.meetTrackedLink),
      clicks: Number(bm.clicks) || 0, firstClickAt: isoOf(toMs(bm.firstClickAt)), lastClickAt: isoOf(toMs(bm.lastClickAt)),
      presence: bm.presence || null, presenceCheckedAt: isoOf(toMs(bm.presenceCheckedAt)),
      reminders: b.remindersSent || {}, waReminders: [],
    };
    if (phase === 'live' && b.meetLink && !b.outcome) {
      const age = now - toMs(bm.presenceCheckedAt);
      if (!bm.presence || age > PRESENCE_TTL_MS) liveOnes.push({ b: b, o: o, prio: 0 });
    } else if (phase === 'past' && b.meetLink && (!bm.presence || toMs(bm.presenceCheckedAt) < MT.bookingEndMs(b) + MEET_AFTER_MS)) {
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

  const meetConn = await MT.connectionStatus().catch(function () { return null; });

  res.status(200).json({
    ok: true, now: isoOf(now), today: today,
    members: Object.keys(rows).map(function (k) { return rows[k]; }),
    calls: liveCalls, bookings: outB,
    meet: { connected: !!(meetConn && meetConn.connected), email: meetConn ? meetConn.email : '', error: meetStatus },
  });
}

// ─── ACTIVITÉ PAR PERSONNE ET PAR JOUR ──────────────────────────────────────
const STAT_KEYS = [
  'callsOut', 'callsIn', 'answered', 'convos', 'talkSec',
  'rdvSet', 'rdvHeld', 'pending'].concat(OUTCOME_KEYS).concat([
  'sms', 'email', 'whatsapp', 'dmOut', 'dmIn', 'actStatus', 'actBooking', 'actAssign', 'notes',
  'activeMs', 'sessions', 'clicks', 'pages', 'rapDue', 'rapDone', 'rapLate', 'rapChecked',
]);

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
  const fromMs = MT.parisToUtcMs(from, '00:00');
  const toMs_ = MT.parisToUtcMs(addDays(to, 1), '00:00');
  const fromTs = admin.firestore.Timestamp.fromMillis(fromMs);
  const toTs = admin.firestore.Timestamp.fromMillis(toMs_);
  const now = Date.now();

  const R = await loadRoster();
  const slugs = R.list.filter(function (m) { return !m.hidden; }).map(function (m) { return m.slug; });

  const callQ = db.collection('call_logs').where('initiatedAt', '>=', fromTs).where('initiatedAt', '<', toTs).limit(8000);
  const heldQ = db.collection('bookings').where('date', '>=', from).where('date', '<=', to).limit(3000);
  const setQ = db.collection('bookings').where('createdAt', '>=', fromTs).where('createdAt', '<', toTs).limit(3000);
  // Messages et notes vivent dans les tableaux des fiches : on relit les
  // fiches touchées sur la période (updatedAt posé par les notes et les envois,
  // lastContactAt par les SMS / e-mails — deux requêtes, fusionnées par id).
  const leadQ = db.collection('leads').where('updatedAt', '>=', fromTs).limit(5000);
  const leadQ2 = db.collection('leads').where('lastContactAt', '>=', fromTs).limit(5000);
  const waQ = db.collection('whatsapp_messages').where('at', '>=', fromMs).where('at', '<', toMs_).limit(5000);
  const dmQ = db.collection('ig_dm_events').where('date', '>=', from).where('date', '<=', to).limit(8000);
  const uaQ = db.collection('user_activity').where('date', '>=', from).where('date', '<=', to).limit(5000);

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
      return { size: snaps[0].size, forEach: function (fn) { Object.keys(docs).forEach(function (k) { fn(docs[k]); }); } };
    }),
    waQ.select('contexte', 'statut', 'at', 'to').get(),
    Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items')
        .where('day', '>=', from).where('day', '<=', to).get()
        .then(function (snap) { return { slug: s, snap: snap }; });
    })),
    dmQ.select('direction', 'date').get(),
    uaQ.get(),
    loadRappelLeads(),
  ]);
  const warnings = [];
  const SOURCES = ['fiches experts', 'types de RDV', 'appels', 'RDV tenus', 'RDV posés', 'messages et notes', 'WhatsApp', 'actions sur les fiches', 'DM Instagram', 'temps de connexion', 'rappels'];
  function val(i) {
    if (settled[i].status === 'fulfilled') return settled[i].value;
    console.error('[team-pilotage] activité —', SOURCES[i], settled[i].reason && settled[i].reason.message);
    warnings.push(SOURCES[i] + ' : ' + String((settled[i].reason && settled[i].reason.message) || 'erreur').slice(0, 160));
    return null;
  }
  const persons = val(0) || {};
  const typeMap = val(1) || {};
  const callSnap = val(2), heldSnap = val(3), setSnap = val(4), leadSnap = val(5), waSnap = val(6), actRes = val(7);
  const dmSnap = val(8), uaSnap = val(9), rappelLeads = val(10);

  const totals = {};     // slug → stats
  const byDay = {};      // slug → day → stats
  const unassigned = emptyStats();
  function add(m, day, key, n) {
    n = n || 1;
    if (!m || m.departed || m.hidden) { unassigned[key] += n; return; }
    if (!totals[m.slug]) { totals[m.slug] = emptyStats(); byDay[m.slug] = {}; }
    totals[m.slug][key] += n;
    if (day) {
      if (!byDay[m.slug][day]) byDay[m.slug][day] = emptyStats();
      byDay[m.slug][day][key] += n;
    }
  }
  function inRange(ms) { return ms >= fromMs && ms < toMs_; }

  const callDocs = dedupeSnap(callSnap, R);
  callDocs.forEach(function (d) {
    const c = d.data() || {};
    const m = callMember(c, R);
    const day = parisDayOfMs(toMs(c.initiatedAt));
    add(m, day, c.direction === 'inbound' ? 'callsIn' : 'callsOut');
    if (isAnsweredCall(c)) add(m, day, 'answered');
    const talk = talkSecOf(c);
    if (talk) add(m, day, 'talkSec', talk);
    if (talk >= CONVO_SEC) add(m, day, 'convos');
  });

  if (heldSnap) heldSnap.forEach(function (d) {
    const b = d.data() || {};
    if (!MT.isClosingBooking(b, typeMap)) return;
    const m = bookingCloser(b, R, persons);
    let out = b.outcome || null;
    if (!out && b.status === 'cancelled') out = 'annule';
    if (out && OUTCOME_KEYS.indexOf(out) >= 0) add(m, b.date, out);
    if (out === 'annule' || out === 'replanifie') return;
    add(m, b.date, 'rdvHeld');
    if (!out && MT.bookingStartMs(b) < now) add(m, b.date, 'pending');
  });

  if (setSnap) setSnap.forEach(function (d) {
    const b = d.data() || {};
    if (!b.bookedBySlug || !MT.isClosingBooking(b, typeMap)) return;
    add(R.bySlug[b.bookedBySlug] || null, parisDayOfMs(toMs(b.createdAt)), 'rdvSet');
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
    // Les rappels automatiques (contexte sans uid) ne sont à personne.
    const m = ctx.uid ? (R.byUid[ctx.uid] || null) : null;
    if (!m) { unassigned.whatsapp += 1; return; }
    add(m, parisDayOfMs(toMs(w.at)), 'whatsapp');
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

  if (actRes) actRes.forEach(function (x) {
    const m = R.bySlug[x.slug];
    x.snap.forEach(function (d) {
      const a = d.data() || {};
      const key = a.action === 'set_booking' ? 'actBooking' : (a.action === 'assign' ? 'actAssign' : 'actStatus');
      add(m, a.day, key);
    });
  });

  // Rappels : contacts relevés dans les appels, WhatsApp et actions déjà lus,
  // plus les communications de la fiche elle-même.
  if (rappelLeads) {
    const ci = contactIndex();
    callDocs.forEach(function (d) { ci.call(d.data() || {}, R); });
    if (waSnap) waSnap.forEach(function (d) { ci.wa(d.data() || {}, R); });
    if (actRes) actRes.forEach(function (x) {
      const am = R.bySlug[x.slug];
      x.snap.forEach(function (d) { const a = d.data() || {}; if (a.leadId) ci.action(a.leadId, toMs(a.createdAt), am ? am.name : x.slug); });
    });
    computeRappels(rappelLeads, R, ci, fromMs, toMs_, now).forEach(function (x) {
      add(x.owner, x.day, 'rapDue');
      if (x.status === 'fait') add(x.owner, x.day, 'rapDone');
      else if (x.status === 'en_retard') add(x.owner, x.day, 'rapLate');
      else if (x.status === 'coche_sans_contact') add(x.owner, x.day, 'rapChecked');
    });
  }

  const members = R.list.filter(function (m) {
    return !m.departed && !m.hidden && (m.sales || totals[m.slug]);
  }).map(function (m) {
    return Object.assign(publicMember(m), { totals: totals[m.slug] || emptyStats(), days: byDay[m.slug] || {} });
  });

  res.status(200).json({
    ok: true, from: from, to: to, generatedAt: isoOf(now),
    truncated: {
      calls: !!(callSnap && callSnap.size >= 8000),
      leads: !!(leadSnap && leadSnap.size >= 5000),
    },
    warnings: warnings,
    members: members, unassigned: unassigned,
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

async function loadRappelLeads() {
  const q = db.collection('leads').where('followUps', '>', []).limit(3000);
  const snap = await q.select.apply(q, RAPPEL_LEAD_FIELDS).get();
  const out = [];
  snap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true) return;
    out.push(Object.assign({ id: d.id }, l));
  });
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
      const m = w.contexte && w.contexte.uid ? R.byUid[w.contexte.uid] : null;
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
        if (!c || c.direction !== 'outbound') return;
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
// e-mails, WhatsApp, DM Instagram), notes, actions sur les fiches, RDV posés
// et tenus, rappels prévus et leur sort.
async function handleJournal(req, res, body) {
  const date = validIso(body.date) ? body.date : todayIsoParis();
  const R = await loadRoster();
  const m = R.bySlug[String(body.slug || '')];
  const membersList = R.list.filter(function (x) { return !x.departed && !x.hidden; }).map(publicMember);
  if (!m) { res.status(200).json({ ok: true, date: date, member: null, members: membersList, events: [], rappels: [], summary: null }); return; }
  const dayStart = MT.parisToUtcMs(date, '00:00');
  const dayEnd = MT.parisToUtcMs(addDays(date, 1), '00:00');
  const now = Date.now();
  const startTs = admin.firestore.Timestamp.fromMillis(dayStart);
  const endTs = admin.firestore.Timestamp.fromMillis(dayEnd);
  const isDm = (dmOwner(R) || {}).slug === m.slug;

  const callQ = db.collection('call_logs').where('initiatedAt', '>=', startTs).where('initiatedAt', '<', endTs).limit(4000);
  const setQ = db.collection('bookings').where('createdAt', '>=', startTs).where('createdAt', '<', endTs).limit(500);
  const heldQ = db.collection('bookings').where('date', '==', date).limit(500);
  const leadQ = db.collection('leads').where('updatedAt', '>=', startTs).limit(3000);
  const leadQ2 = db.collection('leads').where('lastContactAt', '>=', startTs).limit(3000);
  const LF = ['nom', 'telephone', 'phoneNormalized', 'communications', 'notesHistory', '_merged'];
  const empty = { forEach: function () {}, size: 0 };
  function safe(p) { return p.catch(function (e) { console.warn('[team-pilotage] journal', e.message); return null; }); }

  const r = await Promise.all([
    m.uid ? safe(db.collection('user_events').where('uid', '==', m.uid).where('date', '==', date).limit(3000).get()) : null,
    m.uid ? safe(db.collection('user_activity').doc(m.uid + '_' + date).get()) : null,
    safe(callQ.select.apply(callQ, CALL_FIELDS.concat(['aiSummary'])).get()),
    safe(setQ.select.apply(setQ, BOOKING_FIELDS.concat(['outcomeNote', 'remindersSent'])).get()),
    safe(heldQ.select.apply(heldQ, BOOKING_FIELDS.concat(['outcomeNote', 'remindersSent'])).get()),
    safe(Promise.all([leadQ.select.apply(leadQ, LF).get(), leadQ2.select.apply(leadQ2, LF).get()])),
    safe(db.collection('whatsapp_messages').where('at', '>=', dayStart).where('at', '<', dayEnd).limit(3000).get()),
    isDm ? safe(db.collection('ig_dm_events').where('date', '==', date).limit(3000).get()) : null,
    safe(db.collection('lead_actions').doc(m.slug).collection('items').where('day', '==', date).get()),
    safe(loadRappelLeads()),
    loadPersons(),
    MT.loadTypeMap(),
  ]);
  const evSnap = r[0], uaDoc = r[1], callSnap = r[2] || empty, setSnap = r[3] || empty, heldSnap = r[4] || empty;
  const leadSnaps = r[5] || [], waSnap = r[6] || empty, dmSnap = r[7] || empty, actSnap = r[8] || empty;
  const rappelLeads = r[9] || [], persons = r[10], typeMap = r[11];

  const ev = [];
  const leadIds = {};
  function push(ms, cat, kind, title, extra) {
    if (!ms) return;
    const o = Object.assign({ at: isoOf(ms), cat: cat, kind: kind, title: title }, extra || {});
    if (o.leadId) leadIds[o.leadId] = 1;
    ev.push(o);
  }
  const sum = { activeMs: 0, sessions: 0, firstSeenAt: null, lastSeenAt: null, clicks: 0, pages: 0,
    calls: 0, answered: 0, talkSec: 0, sms: 0, email: 0, whatsapp: 0, dm: 0, notes: 0, actions: 0, rdvSet: 0, rdvHeld: 0 };
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
  const ci = contactIndex();
  const phonesToResolve = [];
  const myCalls = [];
  dedupeSnap(callSnap, R).forEach(function (d) {
    const c = d.data() || {};
    ci.call(c, R);
    if (callMember(c, R) !== m) return;
    myCalls.push(Object.assign({ id: d.id }, c));
  });
  myCalls.forEach(function (c) {
    sum.calls++;
    const ok = isAnsweredCall(c);
    if (ok) sum.answered++;
    const talk = talkSecOf(c);
    sum.talkSec += talk;
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
        if (!c || c.direction !== 'outbound' || c.type === 'call') return;
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

  // Actions sur les fiches
  actSnap.forEach(function (d) {
    const a = d.data() || {};
    sum.actions++;
    ci.action(a.leadId, toMs(a.createdAt), m.name);
    const title = a.action === 'set_booking' ? 'RDV posé (Leads Live)' : (a.action === 'assign' ? 'Attribution ' + (a.assignFrom || '—') + ' → ' + (a.assignTo || '—') : 'Statut ' + (a.prevStatus ? a.prevStatus + ' → ' : '→ ') + a.action);
    push(toMs(a.createdAt) || MT.parisToUtcMs(date, '12:00'), 'fiche', 'action', title, { leadId: a.leadId || null, leadName: a.leadName || null });
  });

  // RDV posés et tenus
  function remindersTxt(b) {
    const rs = b.remindersSent || {};
    const parts = [];
    if (rs.j1_email) parts.push('J-1 e-mail'); if (rs.j1_sms) parts.push('J-1 SMS');
    if (rs.h1_email) parts.push('H-1 e-mail'); if (rs.h1_sms) parts.push('H-1 SMS');
    return parts.length ? 'Rappels auto envoyés : ' + parts.join(', ') : 'Aucun rappel auto envoyé';
  }
  setSnap.forEach(function (d) {
    const b = d.data() || {};
    if (b.bookedBySlug !== m.slug) return;
    sum.rdvSet++;
    push(toMs(b.createdAt), 'rdv', 'booking_set', 'RDV posé pour le ' + String(b.date || '').split('-').reverse().join('/') + ' à ' + (b.time || '?') + (b.typeLabel ? ' — ' + b.typeLabel : ''),
      { leadId: b.leadId || null, leadName: prospectName(b), bookingId: d.id });
  });
  const heldIds = [];
  const helds = [];
  heldSnap.forEach(function (d) {
    const b = d.data() || {};
    if (!MT.isClosingBooking(b, typeMap) || bookingCloser(b, R, persons) !== m) return;
    heldIds.push(d.id);
    helds.push(Object.assign({ id: d.id }, b));
  });
  const meets = {};
  if (heldIds.length) {
    const ms = await db.getAll.apply(db, heldIds.map(function (id) { return db.collection('booking_meet').doc(id); })).catch(function () { return []; });
    ms.forEach(function (s) { if (s.exists) meets[s.id] = s.data() || {}; });
  }
  helds.forEach(function (b) {
    sum.rdvHeld++;
    const bm = meets[b.id] || {};
    const pr = bm.presence && bm.presence.ok ? bm.presence : null;
    const s2 = pr && pr.summary ? pr.summary : null;
    const lines = [remindersTxt(b)];
    if (Number(bm.clicks)) lines.push('Lien Meet cliqué ' + bm.clicks + ' fois (1er clic ' + new Date(toMs(bm.firstClickAt)).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) + ')');
    if (pr) lines.push('Visio : ' + (pr.participants || []).filter(function (p) { return p.kind !== 'bot'; }).map(function (p) {
      return p.name + ' ' + (p.joinedAt ? new Date(p.joinedAt).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : '') + (p.leftAt ? ' → ' + new Date(p.leftAt).toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }) : (p.inRoom ? ' → présent' : ''));
    }).join(' · '));
    if (b.outcomeNote) lines.push('Note de résultat : ' + b.outcomeNote);
    push(MT.bookingStartMs(b), 'rdv', 'booking', 'RDV ' + (b.typeLabel || '') + ' — ' + (b.outcome ? 'résultat : ' + b.outcome : (b.status === 'cancelled' ? 'annulé' : 'à statuer')) +
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
  res.status(200).json({ ok: true, date: date, member: publicMember(m), members: membersList, summary: sum, rappels: rappels, events: ev.slice(0, 5000), total: ev.length });
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
  dedupeSnap({ forEach: function (fn) { Object.keys(calls).forEach(function (id) { fn({ id: id, data: function () { return calls[id]; } }); }); } }, R).forEach(function (cd) {
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
    const out = b.outcome || (b.status === 'cancelled' ? 'annule' : null);
    push(MT.bookingStartMs(b), 'booking', closer ? closer.name : (b.personName || null),
      'RDV ' + (b.typeLabel || '') + (out ? ' — résultat : ' + out : ' — à statuer'),
      { bookingId: d.id, outcome: out, note: b.outcomeNote ? clip(b.outcomeNote, 200) : null });
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
