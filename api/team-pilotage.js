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
  const uniq = phones.filter(function (p, i) { return p && phones.indexOf(p) === i; }).slice(0, 30);
  if (!uniq.length) return out;
  const snap = await db.collection('leads').where('phoneNormalized', 'in', uniq).select('nom', 'phoneNormalized', '_merged').get();
  snap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true) return;
    if (!out[l.phoneNormalized]) out[l.phoneNormalized] = { id: d.id, nom: l.nom || '' };
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
  callSnap.forEach(function (d) {
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
  'activeMs', 'sessions',
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
    waQ.select('contexte', 'statut', 'at').get(),
    Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items')
        .where('day', '>=', from).where('day', '<=', to).get()
        .then(function (snap) { return { slug: s, snap: snap }; });
    })),
    dmQ.select('direction', 'date').get(),
    uaQ.get(),
  ]);
  const warnings = [];
  const SOURCES = ['fiches experts', 'types de RDV', 'appels', 'RDV tenus', 'RDV posés', 'messages et notes', 'WhatsApp', 'actions sur les fiches', 'DM Instagram', 'temps de connexion'];
  function val(i) {
    if (settled[i].status === 'fulfilled') return settled[i].value;
    console.error('[team-pilotage] activité —', SOURCES[i], settled[i].reason && settled[i].reason.message);
    warnings.push(SOURCES[i] + ' : ' + String((settled[i].reason && settled[i].reason.message) || 'erreur').slice(0, 160));
    return null;
  }
  const persons = val(0) || {};
  const typeMap = val(1) || {};
  const callSnap = val(2), heldSnap = val(3), setSnap = val(4), leadSnap = val(5), waSnap = val(6), actRes = val(7);
  const dmSnap = val(8), uaSnap = val(9);

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

  if (callSnap) callSnap.forEach(function (d) {
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
  });

  if (actRes) actRes.forEach(function (x) {
    const m = R.bySlug[x.slug];
    x.snap.forEach(function (d) {
      const a = d.data() || {};
      const key = a.action === 'set_booking' ? 'actBooking' : (a.action === 'assign' ? 'actAssign' : 'actStatus');
      add(m, a.day, key);
    });
  });

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
  const waNum = tel.replace(/[^0-9]/g, '');

  function nameOf(m, fallback) { return m ? m.name : (fallback || null); }

  const calls = {};
  const callQs = [db.collection('call_logs').where('leadId', '==', leadId).limit(200)];
  if (/^\+\d{8,15}$/.test(tel)) {
    callQs.push(db.collection('call_logs').where('toNumber', '==', tel).limit(200));
    callQs.push(db.collection('call_logs').where('fromNumber', '==', tel).limit(200));
  }
  const [callSnaps, bookSnap, actSnaps, waSnap] = await Promise.all([
    Promise.all(callQs.map(function (q) { return q.select.apply(q, CALL_FIELDS.concat(['aiSummary'])).get().catch(function () { return null; }); })),
    db.collection('bookings').where('leadId', '==', leadId).limit(100).get().catch(function () { return null; }),
    Promise.all(slugs.map(function (s) {
      return db.collection('lead_actions').doc(s).collection('items').where('leadId', '==', leadId).limit(200).get().catch(function () { return null; });
    })),
    waNum.length >= 10
      ? db.collection('whatsapp_conversations').doc(waNum).collection('messages').orderBy('at', 'desc').limit(200).get().catch(function () { return null; })
      : Promise.resolve(null),
  ]);

  const ev = [];
  function push(ms, kind, who, text, extra) {
    if (!ms) return;
    ev.push(Object.assign({ at: isoOf(ms), kind: kind, who: who || null, text: text || '' }, extra || {}));
  }

  push(toMs(l.createdAt), 'creation', null, 'Fiche créée' + (l.source ? ' — source ' + l.source : ''));

  callSnaps.forEach(function (s) {
    if (s) s.forEach(function (d) { calls[d.id] = d.data() || {}; });
  });
  Object.keys(calls).forEach(function (id) {
    const c = calls[id];
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

  (Array.isArray(l.communications) ? l.communications : []).forEach(function (c) {
    if (!c || c.type === 'call' || c.type === 'appel') return;
    const m = commMember(c, R);
    const label = c.type === 'sms' ? 'SMS' : (c.type === 'email' ? 'E-mail' : (c.type || 'Message'));
    push(toMs(c.date || c.createdAt), 'message', nameOf(m, c.ownerName),
      label + (c.direction === 'inbound' ? ' reçu' : ' envoyé') + ' — ' + clip(c.content, 220), { channel: c.type || null, direction: c.direction || null });
  });
  (Array.isArray(l.notesHistory) ? l.notesHistory : []).forEach(function (n) {
    if (!n) return;
    push(toMs(n.date || n.createdAt), 'note', nameOf(noteMember(n, R), n.authorName), clip(n.text, 400));
  });
  if (waSnap) waSnap.forEach(function (d) {
    const w = d.data() || {};
    push(toMs(w.at), 'whatsapp', null, 'WhatsApp ' + (w.sens === 'in' ? 'reçu' : 'envoyé') + ' — ' + clip(w.texte, 220), { direction: w.sens === 'in' ? 'inbound' : 'outbound' });
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
    return res.status(400).json({ error: 'Action inconnue : ' + (action || '(vide)') });
  } catch (e) {
    console.error('[team-pilotage] ' + action, e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Erreur interne' });
  }
};
