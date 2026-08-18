// ============================================================================
// api/_recurrence-core.js — SÉRIE HEBDOMADAIRE DE COACHING (helper partagé)
// ----------------------------------------------------------------------------
// Helper interne (préfixe `_` → exclu du routing Vercel). Utilisé par :
//   · api/booking-recurrence-plan.js   (calcul du plan proposé au client)
//   · api/booking-series-create.js     (création réelle de la série)
//
// À QUOI ÇA SERT
// --------------
// Le nouveau programme « Elite NEW - 6 Mois - 24C » tient 24 séances en
// 6 mois, soit une par semaine. Plutôt que de faire revenir le client sur le
// lien de son coach 24 fois, la page booking.html lui propose de poser toute
// la série d'un coup, tous les mêmes jours à la même heure, en signalant les
// semaines où le coach n'est pas libre.
//
// POURQUOI CE HELPER EXISTE (et pas un calcul dans le navigateur)
// ---------------------------------------------------------------
// 1. `calendar_busy/{personId}` — la seule source de disponibilité Google
//    lisible depuis booking.html — ne contient que 60 jours (voir
//    fetchAndStoreBusy dans Functions/index.js). Une série de 24 semaines
//    court sur ~170 jours : au-delà de la 8e semaine le navigateur croirait
//    le coach libre partout. On interroge donc Google FreeBusy directement,
//    sur tout l'horizon, avec le refresh token de `calendar_tokens`.
// 2. Le nombre de séances restantes se lit sur la fiche `clients`, que les
//    règles Firestore interdisent à un visiteur anonyme (même raison que
//    api/booking-check-coaching-quota.js).
//
// CE QUI N'EST PAS DUPLIQUÉ
// -------------------------
// Les plages d'ouverture (schedule + dateOverrides + availabilityRules), les
// jours fériés et les conversions d'heure viennent de `dispo-core.js`, déjà
// partagé navigateur ↔ serveur. Toute correction de ces règles se fait là-bas,
// jamais ici — sinon booking.html et cette API divergent.
//
// FUSEAU HORAIRE
// --------------
// Vercel tourne en UTC. Toute conversion instant → (jour, minute) passe par
// DispoCore.parisStamp : jamais de getHours() local sur un timestamp Google.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { google } = require('googleapis');
const Dispo = require('../dispo-core.js');

/* Total de séances d'un parcours Elite NEW. Volontairement dérivé du libellé
   du programme (« - 24C ») et pas écrit en dur : un futur « Elite NEW -
   6 Mois - 30C » suivra tout seul. La constante ne sert que de repli. */
const DEFAULT_TOTAL_SESSIONS = 24;

/* Semaines de réserve calculées en plus de la série demandée. Quand le client
   choisit « passer cette semaine » sur un créneau occupé, le front active une
   occurrence de réserve pour arriver quand même au compte — sans nouvel
   aller-retour serveur. 8 couvre largement un mois de vacances du coach. */
const RESERVE_WEEKS = 8;

/* Garde-fou d'horizon. 24 séances + 8 semaines de réserve = 32 semaines ;
   on borne à 45 pour qu'aucune donnée aberrante ne fasse balayer deux ans. */
const MAX_HORIZON_WEEKS = 45;

/* Google FreeBusy n'aime pas les fenêtres très longues. On découpe en
   tranches de 60 jours, comme le fait déjà la Cloud Function. */
const FREEBUSY_CHUNK_DAYS = 60;

/* ══════════════════════════════════════════════════════════════════════════
   PROGRAMME
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Lit « Elite NEW - 6 Mois - 24C » → { mois: 6, seances: 24 }.
 * Même expression que getMonthlyQuota() dans coaching.html — les deux doivent
 * comprendre un libellé de la même façon.
 */
function parseProgramme(programme) {
  const p = String(programme || '').toLowerCase();
  const mMois = p.match(/(\d+)\s*mois/);
  const mSeances = p.match(/(\d+)\s*c\b/);
  const mois = mMois ? parseInt(mMois[1], 10) : 0;
  const seances = mSeances ? parseInt(mSeances[1], 10) : 0;
  return { mois: mois > 0 ? mois : 0, seances: seances > 0 ? seances : 0 };
}

/**
 * Quota MENSUEL d'un programme — règle alignée sur coaching.html (ligne ~1530).
 * Exportée ici pour que api/booking-check-coaching-quota.js cesse d'avoir sa
 * propre version : c'est cette divergence qui bloquait un client Elite NEW dès
 * sa 3e séance du mois (ancienne règle « 24C → 2/mois », alors qu'Elite NEW
 * c'est 24/6 = 4/mois).
 */
function monthlyQuotaFromProgramme(programme) {
  if (!programme) return 1;
  const { mois, seances } = parseProgramme(programme);
  if (mois && seances) return Math.max(1, Math.round(seances / mois));
  const p = String(programme).toLowerCase();
  if (p.includes('24c')) return 2;
  if (p.includes('12c')) return 1;
  if (p.includes('6c')) return 1;
  return 1;
}

/**
 * Le client est-il sur le parcours qui ouvre droit à la récurrence ?
 *
 * Décision d'Adrien (18/08/2026) : l'interrupteur de récurrence n'apparaît
 * QUE pour les nouveaux Elite — 24 séances condensées sur 6 mois, donc une
 * par semaine. Les autres programmes (BP 12C, BP 24C, Elite 12 mois) gardent
 * la réservation à l'unité : leur rythme est mensuel, pas hebdomadaire.
 *
 * Le « commence par Elite NEW » est repris tel quel de estParcoursEtapes()
 * dans coaching.html, pour qu'un seul libellé fasse foi des deux côtés.
 */
function isEliteNewWeekly(programme) {
  if (!/^\s*elite\s+new\b/i.test(String(programme || ''))) return false;
  const { mois, seances } = parseProgramme(programme);
  // Une séance par semaine ⇔ environ 4 par mois. On accepte 3,5 → 5 pour ne
  // pas se river à « exactement 6 mois / 24 séances ».
  if (!mois || !seances) return false;
  const parMois = seances / mois;
  return parMois >= 3.5 && parMois <= 5;
}

/** Nombre total de séances du parcours (24 pour Elite NEW 6 mois). */
function totalSessionsOf(programme) {
  const { seances } = parseProgramme(programme);
  return seances || DEFAULT_TOTAL_SESSIONS;
}

/* ══════════════════════════════════════════════════════════════════════════
   SÉANCES DÉJÀ CONSOMMÉES
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Aplatit les séances d'une fiche client : format historique (sessions[] à la
 * racine) et format actuel (years[].sessions[]). Copie conforme de
 * flattenSessions() dans api/booking-check-coaching-quota.js.
 */
function flattenSessions(c) {
  const all = [];
  if (Array.isArray(c.years) && c.years.length) {
    c.years.forEach((y) => {
      if (Array.isArray(y && y.sessions)) y.sessions.forEach((s) => all.push(s));
    });
  } else if (Array.isArray(c.sessions)) {
    c.sessions.forEach((s) => all.push(s));
  }
  return all;
}

/**
 * Séances déjà FAITES sur tout le parcours (pas seulement le mois courant).
 * La séance d'accueil (numero 0) et le RDV 72h éclair sont exclus : ce sont
 * des séances d'onboarding offertes qui ne consomment pas le forfait — même
 * exclusion que coaching.html, le quota mensuel et academy-client-info.
 */
function countDoneSessions(clientData) {
  return flattenSessions(clientData).filter((s) => {
    if (!s || s.statut !== 'fait') return false;
    if (s.numero === 0 || s.type === 'rdv72h') return false;
    return true;
  }).length;
}

/**
 * RDV coaching confirmés ENCORE À VENIR pour cet email.
 *
 * Même précaution que le quota mensuel : une séance déjà passée existe deux
 * fois (le booking, qui ne bascule jamais en « done », et la séance « fait »
 * saisie dans coaching.html). On ne compte donc que le futur, le passé étant
 * déjà couvert par countDoneSessions().
 *
 * ⚠ CASSE DE L'EMAIL — booking.html enregistre `prospect.email` TEL QUE saisi
 * par le visiteur (submitBooking ne le normalise pas), alors qu'on interroge
 * en minuscules. Un client ayant tapé « Jean.Dupont@X.com » verrait ses RDV
 * ignorés, donc son forfait sous-compté — et la série pourrait dépasser les
 * 24 séances. On interroge donc les DEUX graphies et on dédoublonne par
 * identifiant de document.
 *
 * @returns {Promise<{count:number, docs:Array}>}
 */
async function countUpcomingCoachingBookings(rawEmail) {
  const today = Dispo.todayParis();
  const raw = String(rawEmail || '').trim();
  const lower = raw.toLowerCase();
  const variants = raw && raw !== lower ? [lower, raw] : [lower];

  const seen = {};
  const out = [];
  for (const v of variants) {
    if (!v) continue;
    const snap = await db.collection('bookings').where('prospect.email', '==', v).get();
    snap.forEach((doc) => {
      if (seen[doc.id]) return;
      const b = doc.data();
      if (b.isCoaching !== true) return;
      if (b.status !== 'confirmed') return;
      if (b.excludeFromQuota === true) return;
      if (!b.date || typeof b.date !== 'string') return;
      if (b.date.slice(0, 10) < today) return;
      seen[doc.id] = 1;
      out.push(Object.assign({ id: doc.id }, b));
    });
  }
  return { count: out.length, docs: out };
}

/**
 * Retrouve la fiche coaching d'un email. Reprend la double tentative de
 * api/booking-check-coaching-quota.js (Firestore compare la casse).
 * @returns {Promise<{id:string, data:Object}|null>}
 */
async function findClientByEmail(rawEmail) {
  const email = String(rawEmail || '').trim().toLowerCase();
  if (!email) return null;
  let snap = await db.collection('clients').where('email', '==', email).limit(2).get();
  if (snap.empty && rawEmail !== email) {
    snap = await db.collection('clients').where('email', '==', rawEmail).limit(2).get();
  }
  if (snap.empty) return null;
  if (snap.size > 1) console.warn('[recurrence-core] plusieurs fiches clients pour', email);
  return { id: snap.docs[0].id, data: snap.docs[0].data() || {} };
}

/* ══════════════════════════════════════════════════════════════════════════
   CONFIG BOOKING
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Charge d'un coup ce qu'il faut pour raisonner sur les créneaux :
 * la fiche expert, les réglages globaux et la consultation.
 */
async function loadBookingContext(personId, typeId) {
  const [personSnap, settingsSnap, typesSnap] = await Promise.all([
    db.collection('booking_config').doc(personId).get(),
    db.collection('booking_config').doc('_settings').get(),
    db.collection('booking_config').doc('_types').get(),
  ]);

  if (!personSnap.exists) return { error: 'person_not_found' };
  const person = Object.assign({ id: personSnap.id }, personSnap.data());
  if (person.__type !== 'person') return { error: 'person_not_found' };

  const settings = settingsSnap.exists ? (settingsSnap.data() || {}) : {};
  const types = (typesSnap.exists && (typesSnap.data() || {}).list) || [];
  const type = types.find((t) => t && t.id === typeId) || null;
  if (!type) return { error: 'type_not_found' };

  return { person, settings, type };
}

/**
 * Paramètres de découpe des créneaux, avec la même cascade que booking.html
 * (computeSlotsFor) : la consultation prime sur l'expert, 0 sinon.
 *
 * NOTE — `maxNoticeDays` (« plage de dates dans le futur ») est volontairement
 * ignoré ici. Cette borne existe pour empêcher un prospect de réserver dans
 * huit mois ; une série de 24 semaines la dépasse par construction. Le
 * plafond de la série, c'est le nombre de séances du forfait.
 */
function slotParamsOf(type, person) {
  const rules = (type && type.rules) || {};
  const duration = (type && type.duration) || 30;
  return {
    duration,
    interval: rules.slotInterval || duration,
    bufBefore: rules.bufferBefore || person.bufferBefore || 0,
    bufAfter: rules.bufferAfter || person.bufferAfter || 0,
    minNoticeHours: rules.minNoticeHours || person.minNoticeHours || 0,
    maxPerDay: rules.maxPerDay || person.maxPerDay || 0,
  };
}

/* ══════════════════════════════════════════════════════════════════════════
   GOOGLE FREE/BUSY SUR TOUT L'HORIZON
   ══════════════════════════════════════════════════════════════════════════ */

async function getOAuthConfig() {
  for (const id of ['oauth_calendar', 'oauth']) {
    try {
      const doc = await db.collection('_config').doc(id).get();
      if (doc.exists) {
        const d = doc.data() || {};
        if (d.client_id && d.client_secret) return d;
      }
    } catch (_) { /* on tente le suivant */ }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable');
}

/**
 * Client OAuth Google d'un expert. Même pattern que
 * api/calendar-followup-event.js : on persiste l'access_token rafraîchi pour
 * que le prochain appel reparte d'un jeton valide.
 */
async function getAuthClientForPerson(personId, tokenCollection, docId) {
  const coll = tokenCollection || 'calendar_tokens';
  const id = docId || personId;
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection(coll).doc(id).get();
  if (!tokenDoc.exists) return null;
  const data = tokenDoc.data() || {};
  if (!data.refreshToken && !data.accessToken) return null;

  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials({
    access_token: data.accessToken || null,
    refresh_token: data.refreshToken || null,
  });
  client.on('tokens', async (t) => {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) {
      try { await db.collection(coll).doc(id).update(u); }
      catch (e) { console.warn('[recurrence-core] refresh token non sauvegardé:', e.message); }
    }
  });
  return client;
}

/** Découpe [startDs, endDs] en tranches de FREEBUSY_CHUNK_DAYS jours. */
function chunkRange(startDs, endDs) {
  const out = [];
  let cur = startDs;
  while (cur <= endDs) {
    let next = Dispo.addDays(cur, FREEBUSY_CHUNK_DAYS);
    if (next > endDs) next = endDs;
    out.push({ from: cur, to: next });
    if (next === endDs) break;
    cur = Dispo.addDays(next, 1);
  }
  return out;
}

/**
 * Plages occupées du coach sur [startDs, endDs], tous calendriers confondus :
 * calendrier principal + sous-calendriers marqués checkConflicts + agendas
 * personnels reliés (extraConnections). Exactement le périmètre que la Cloud
 * Function fetchAndStoreBusy applique sur ses 60 jours — on l'étend, on ne le
 * change pas.
 *
 * Renvoie [] si le coach n'a aucun calendrier connecté : la série se calcule
 * alors sur le seul planning Alteore, ce qui reste correct, juste moins fin.
 */
async function fetchBusyRange(personId, startDs, endDs) {
  const items = [];
  const busy = [];

  const personDoc = await db.collection('booking_config').doc(personId).get();
  const calList = (personDoc.exists && (personDoc.data() || {}).calendarList) || [];
  const extraConns = (personDoc.exists && (personDoc.data() || {}).extraConnections) || [];

  const chunks = chunkRange(startDs, endDs);

  // ── Connexion principale ──
  const client = await getAuthClientForPerson(personId);
  if (client) {
    const primaryItems = [{ id: 'primary' }];
    calList.forEach((c) => {
      if (c && c.checkConflicts !== false && c.id && c.id !== 'primary') primaryItems.push({ id: c.id });
    });
    items.push({ client, calendars: primaryItems, label: 'primary' });
  }

  // ── Agendas personnels reliés ──
  for (const ec of extraConns) {
    if (!ec || !ec.id) continue;
    try {
      const eClient = await getAuthClientForPerson(personId, 'calendar_extra_tokens', personId + '__' + ec.id);
      if (!eClient) continue;
      let eItems = (ec.calendars || []).filter((c) => c && c.checkConflicts !== false).map((c) => ({ id: c.id }));
      if (!eItems.length) eItems = [{ id: 'primary' }];
      items.push({ client: eClient, calendars: eItems, label: ec.email || ec.id });
    } catch (e) {
      console.error('[recurrence-core] extra connection ' + ec.id + ':', e.message);
    }
  }

  for (const entry of items) {
    const cal = google.calendar({ version: 'v3', auth: entry.client });
    for (const ch of chunks) {
      try {
        const resp = await cal.freebusy.query({
          requestBody: {
            timeMin: new Date(ch.from + 'T00:00:00+02:00').toISOString(),
            timeMax: new Date(ch.to + 'T23:59:59+02:00').toISOString(),
            timeZone: 'Europe/Paris',
            items: entry.calendars,
          },
        });
        const cals = resp.data.calendars || {};
        Object.keys(cals).forEach((calId) => {
          ((cals[calId] && cals[calId].busy) || []).forEach((b) => busy.push(b));
        });
      } catch (e) {
        // Un calendrier illisible ne doit pas faire échouer toute la série :
        // on log et on continue. Le pire cas est de proposer un créneau que
        // le coach devra décaler — jamais de refuser à tort toute la série.
        console.error('[recurrence-core] freebusy ' + entry.label + ' ' + ch.from + '→' + ch.to + ':', e.message);
      }
    }
  }

  return busy;
}

/**
 * Plages Google (instants absolus) → { 'YYYY-MM-DD': [{start,end} en minutes
 * depuis minuit, heure de Paris] }. Un événement à cheval sur plusieurs jours
 * est éclaté jour par jour.
 */
function busyByDate(busyList) {
  const map = {};
  const push = (ds, range) => {
    if (range.end <= range.start) return;
    (map[ds] = map[ds] || []).push(range);
  };

  (busyList || []).forEach((b) => {
    if (!b || !b.start || !b.end) return;
    const s = Dispo.parisStamp(new Date(b.start));
    const e = Dispo.parisStamp(new Date(b.end));
    if (s.ymd === e.ymd) { push(s.ymd, { start: s.min, end: e.min }); return; }

    push(s.ymd, { start: s.min, end: 1440 });
    let cur = Dispo.addDays(s.ymd, 1);
    // Garde-fou : un événement « toute l'année » ne doit pas faire tourner
    // cette boucle 365 fois par occurrence.
    let guard = 0;
    while (cur < e.ymd && guard < 400) { push(cur, { start: 0, end: 1440 }); cur = Dispo.addDays(cur, 1); guard++; }
    push(e.ymd, { start: 0, end: e.min });
  });

  return map;
}

/* ══════════════════════════════════════════════════════════════════════════
   CRÉNEAUX LIBRES
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Index des RDV Alteore par date, pour le seul expert concerné.
 * Les RDV annulés ne bloquent rien (le créneau est rendu).
 */
function bookingsByDate(bookings, personId) {
  const map = {};
  (bookings || []).forEach((b) => {
    if (!b || b.personId !== personId || !b.date) return;
    if (b.status === 'cancelled') return;
    (map[b.date] = map[b.date] || []).push(b);
  });
  return map;
}

/**
 * Créneaux libres d'une journée, en 'HH:MM'.
 *
 * Port fidèle de computeSlotsFor() de booking.html, à trois différences près,
 * toutes assumées pour une série :
 *   · la borne « maxNoticeDays » n'est pas appliquée (cf. slotParamsOf) ;
 *   · le préavis minimum est appliqué en JOURS entiers — toutes les
 *     occurrences d'une série sont à une semaine ou plus, la précision à
 *     l'heure n'a aucun effet et éviterait mal une conversion de fuseau ;
 *   · les créneaux « ouverts » par un setter (slotOpen) ne sont pas
 *     réutilisables : une séance de coaching ne se double jamais.
 */
function freeSlotsForDate(ctx, ds) {
  if (ds < ctx.minDate) return [];
  if ((ctx.person.blockedDates || []).indexOf(ds) >= 0) return [];
  if (Dispo.isHoliday(ds, ctx.settings)) return [];

  const ranges = Dispo.effectiveRanges(ctx.person, ds);
  if (!ranges.length) return [];

  const dayBookings = ctx.bookings[ds] || [];
  if (ctx.params.maxPerDay > 0 && dayBookings.length >= ctx.params.maxPerDay) return [];

  const dur = ctx.params.duration;
  const step = ctx.params.interval;

  const candidates = [];
  ranges.forEach((r) => {
    const s = Dispo.timeToMin(r.start);
    const e = Dispo.timeToMin(r.end);
    for (let m = s; m + dur <= e; m += step) candidates.push(m);
  });
  if (!candidates.length) return [];

  const blocked = [];
  dayBookings.forEach((b) => {
    const st = Dispo.timeToMin(b.time);
    const bd = parseInt(b.duration, 10) > 0 ? parseInt(b.duration, 10) : 30;
    blocked.push({ start: st - ctx.params.bufBefore, end: st + bd + ctx.params.bufAfter });
  });
  (ctx.busy[ds] || []).forEach((r) => blocked.push(r));

  return candidates
    .filter((m) => !blocked.some((b) => m < b.end && m + dur > b.start))
    .map((m) => Dispo.minToTime(m));
}

/* ══════════════════════════════════════════════════════════════════════════
   CONSTRUCTION DU PLAN
   ══════════════════════════════════════════════════════════════════════════ */

/** Les alternatives les plus proches d'une heure cible, sur la même journée. */
function nearestSlots(slots, targetTime, limit) {
  const target = Dispo.timeToMin(targetTime);
  return slots
    .slice()
    .sort((a, b) => Math.abs(Dispo.timeToMin(a) - target) - Math.abs(Dispo.timeToMin(b) - target))
    .slice(0, limit || 8);
}

/**
 * Plan complet de la série.
 *
 * @param ctx      contexte de créneaux (person, settings, params, bookings, busy, minDate)
 * @param firstDs  date du 1er RDV (celui que le client vient de choisir)
 * @param time     heure du 1er RDV — le rythme de la série
 * @param count    nombre d'occurrences À PROGRAMMER (hors 1er RDV)
 *
 * Renvoie `count + RESERVE_WEEKS` occurrences. Les `count` premières sont
 * actives ; les suivantes portent `reserve:true` et n'existent que pour que le
 * front puisse remplacer une semaine que le client décide de sauter, sans
 * repasser par le serveur.
 *
 * Statut d'une occurrence :
 *   'ok'     — le créneau visé est libre
 *   'busy'   — le coach travaille ce jour-là mais pas à cette heure
 *   'closed' — le coach ne reçoit pas ce jour-là (congé, férié, planning)
 */
function buildOccurrences(ctx, firstDs, time, count) {
  const wanted = Math.min(count + RESERVE_WEEKS, MAX_HORIZON_WEEKS);
  const out = [];

  for (let i = 1; i <= wanted; i++) {
    const ds = Dispo.addDays(firstDs, 7 * i);
    const slots = freeSlotsForDate(ctx, ds);
    const free = slots.indexOf(time) >= 0;

    // Repli sur les jours voisins de la même semaine, à l'heure habituelle :
    // « pas dispo ce lundi, mais libre le mardi à 14 h » est souvent la
    // proposition qui arrange le plus le client.
    const altDays = [];
    if (!free) {
      for (const shift of [1, -1, 2, -2, 3, -3]) {
        const ads = Dispo.addDays(ds, shift);
        if (ads <= firstDs) continue;
        if (freeSlotsForDate(ctx, ads).indexOf(time) >= 0) altDays.push({ date: ads, time });
        if (altDays.length >= 3) break;
      }
    }

    out.push({
      index: i,
      date: ds,
      time,
      status: free ? 'ok' : (slots.length ? 'busy' : 'closed'),
      sameDaySlots: free ? [] : nearestSlots(slots, time, 8),
      altDays,
      reserve: i > count,
    });
  }

  return out;
}

module.exports = {
  DEFAULT_TOTAL_SESSIONS,
  RESERVE_WEEKS,
  MAX_HORIZON_WEEKS,

  parseProgramme,
  monthlyQuotaFromProgramme,
  isEliteNewWeekly,
  totalSessionsOf,

  flattenSessions,
  countDoneSessions,
  countUpcomingCoachingBookings,
  findClientByEmail,

  loadBookingContext,
  slotParamsOf,

  getAuthClientForPerson,
  fetchBusyRange,
  busyByDate,
  bookingsByDate,
  freeSlotsForDate,

  nearestSlots,
  buildOccurrences,
};
