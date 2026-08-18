// ============================================================================
// api/booking-recurrence-plan.js
// ----------------------------------------------------------------------------
// Endpoint PUBLIC appelé par booking.html à l'étape « Vos informations », dès
// que le visiteur a saisi un email valide sur une consultation de coaching.
//
// Il répond à une seule question : « ce client peut-il programmer sa série
// hebdomadaire, et à quoi ressemblerait-elle ? » Rien n'est écrit ici.
//
// URL  : POST https://team.alteore.com/api/booking-recurrence-plan
// Auth : aucune — le visiteur du lien coach n'est pas authentifié
// CORS : ouvert
//
// Body (JSON) :
//   {
//     email    : "client@exemple.com",   // requis
//     personId : "thomaspinet_dxstrq",   // requis — l'expert du lien
//     typeId   : "coaching_business_elite",
//     date     : "2026-09-07",           // 1er RDV choisi à l'étape 3
//     time     : "14:00"
//   }
//
// Réponse 200 — non éligible (cas le plus fréquent, ce n'est PAS une erreur) :
//   { ok:true, eligible:false, reason:"programme_not_eligible" }
//   reason ∈ client_not_found | client_inactive | programme_not_eligible
//          | series_complete | type_not_coaching
//
// Réponse 200 — éligible :
//   {
//     ok:true, eligible:true,
//     total:24, done:2, remaining:22, recurrenceCount:21,
//     weekdayLabel:"lundi",
//     occurrences:[ { index, date, time, status, sameDaySlots, altDays, reserve } ]
//   }
//
// LE COMPTE DES SÉANCES (décision Adrien du 18/08/2026)
// -----------------------------------------------------
//   total     = 24 pour Elite NEW - 6 Mois - 24C (lu sur le libellé)
//   done      = séances « fait » du parcours (hors séance 0 et RDV 72h)
//               + RDV coaching confirmés encore à venir
//   remaining = total - done, LE RDV EN COURS COMPRIS
//   recurrenceCount = remaining - 1  → les occurrences à poser en plus
//   Autrement dit : 0 séance prise → ce RDV + 23 = 24. 2 séances prises →
//   ce RDV + 21 = 24.
//
// POURQUOI CE N'EST PAS FAIT DANS LE NAVIGATEUR
// ---------------------------------------------
//   · la fiche `clients` est interdite en lecture à un visiteur anonyme ;
//   · `calendar_busy` ne porte que 60 jours, une série en couvre ~170.
//   Voir l'en-tête de api/_recurrence-core.js.
//
// CE QUI EST EXPOSÉ
// -----------------
// Uniquement des compteurs et des créneaux — jamais le nom du client, jamais
// l'objet des événements du coach. Même niveau d'exposition que l'endpoint de
// quota déjà en place.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const Dispo = require('../dispo-core.js');
const R = require('./_recurrence-core');

const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

function json(res, code, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).send(JSON.stringify(body));
}

function notEligible(res, reason, extra) {
  return json(res, 200, Object.assign({ ok: true, eligible: false, reason }, extra || {}));
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }

  const body = parseBody(req);
  // On garde la graphie d'origine : `prospect.email` est stocké tel que saisi
  // sur les RDV, et c'est sur ce champ qu'on compte les séances à venir.
  const emailRaw = String(body.email || '').trim();
  const email = emailRaw.toLowerCase();
  const personId = String(body.personId || '').trim();
  const typeId = String(body.typeId || '').trim();
  const date = String(body.date || '').trim();
  const time = String(body.time || '').trim();

  if (!email || !personId || !typeId) { json(res, 400, { error: 'missing_params' }); return; }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) { json(res, 400, { error: 'date_invalid' }); return; }
  if (!/^\d{2}:\d{2}$/.test(time)) { json(res, 400, { error: 'time_invalid' }); return; }

  try {
    // ── 1. La consultation doit bien être une consultation de coaching ─────
    const ctxConf = await R.loadBookingContext(personId, typeId);
    if (ctxConf.error) return notEligible(res, ctxConf.error);
    if (ctxConf.type.isCoaching !== true) return notEligible(res, 'type_not_coaching');

    // Flag d'activation (booking_config/_settings). Doublonne volontairement
    // le contrôle du frontend : un navigateur resté ouvert avant la bascule ne
    // doit pas pouvoir ouvrir une série. Cf. l'en-tête de booking-series-create.
    if (ctxConf.settings.coachingRecurrenceEnabled !== true) return notEligible(res, 'feature_disabled');

    // ── 2. Le client, son programme, son reste à faire ─────────────────────
    const client = await R.findClientByEmail(emailRaw);
    if (!client) return notEligible(res, 'client_not_found');

    const c = client.data;
    if (c.ancienClient === true || c.statut === 'inactif') return notEligible(res, 'client_inactive');

    const programme = c.programme || '';
    if (!R.isEliteNewWeekly(programme)) return notEligible(res, 'programme_not_eligible');

    const total = R.totalSessionsOf(programme);
    const done = R.countDoneSessions(c) + (await R.countUpcomingCoachingBookings(emailRaw)).count;
    const remaining = total - done;

    // remaining <= 1 : il ne reste que le RDV en cours, il n'y a rien à
    // programmer derrière. On laisse la réservation simple se faire.
    if (remaining <= 1) return notEligible(res, 'series_complete', { total, done, remaining: Math.max(0, remaining) });

    const recurrenceCount = remaining - 1;

    // ── 3. Disponibilité du coach sur tout l'horizon ───────────────────────
    const params = R.slotParamsOf(ctxConf.type, ctxConf.person);
    const horizonWeeks = Math.min(recurrenceCount + R.RESERVE_WEEKS, R.MAX_HORIZON_WEEKS);
    const lastDs = Dispo.addDays(date, 7 * horizonWeeks + 3); // +3 : les jours de repli

    // RDV Alteore de la période. Requête sur le seul champ `date` (plage
    // simple, aucun index composite requis) puis filtrage sur l'expert en
    // mémoire — même approche que booking.html.
    const bookSnap = await db.collection('bookings')
      .where('date', '>=', date)
      .where('date', '<=', lastDs)
      .get();
    const allBookings = [];
    bookSnap.forEach((d) => allBookings.push(d.data()));

    const busyRaw = await R.fetchBusyRange(personId, date, lastDs);

    const minNoticeDays = Math.ceil((params.minNoticeHours || 0) / 24);
    const ctx = {
      person: ctxConf.person,
      settings: ctxConf.settings,
      params,
      bookings: R.bookingsByDate(allBookings, personId),
      busy: R.busyByDate(busyRaw),
      minDate: Dispo.addDays(Dispo.todayParis(), minNoticeDays),
    };

    const occurrences = R.buildOccurrences(ctx, date, time, recurrenceCount);

    return json(res, 200, {
      ok: true,
      eligible: true,
      programme,
      total,
      done,
      remaining,
      recurrenceCount,
      weekdayLabel: JOURS_FR[Dispo.ymdToDate(date).getDay()],
      calendarConnected: ctxConf.person.calendarConnected === true,
      occurrences,
    });
  } catch (e) {
    console.error('[booking-recurrence-plan] erreur:', e);
    // Fail-closed sur la récurrence — mais JAMAIS sur le RDV lui-même : le
    // front n'affiche simplement pas la proposition et la réservation simple
    // suit son cours normal. Un incident ici ne coûte pas un rendez-vous.
    return notEligible(res, 'internal_error');
  }
};
