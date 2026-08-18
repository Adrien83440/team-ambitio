// ============================================================================
// api/booking-series-create.js
// ----------------------------------------------------------------------------
// Pose les séances hebdomadaires RESTANTES d'un parcours Elite NEW, en une
// seule fois, après que le client a confirmé son premier rendez-vous sur le
// lien de son coach.
//
// URL  : POST https://team.alteore.com/api/booking-series-create
// Auth : aucune — visiteur public du lien coach. La légitimité vient de la
//        fiche client : seul un client Elite NEW actif, retrouvé par son
//        email, ouvre droit à une série. Voir « SÉCURITÉ » plus bas.
// CORS : ouvert
//
// Body (JSON) :
//   {
//     firstBookingId : "sl-2026-09-07-1400-xyz",   // le RDV déjà créé
//     personId       : "thomaspinet_dxstrq",
//     typeId         : "coaching_business_elite",
//     timezone       : "Europe/Paris",
//     occurrences    : [ { date:"2026-09-14", time:"14:00" }, … ]  // SANS le 1er
//   }
//
// Réponse 200 :
//   { ok:true, seriesId, created:[{id,date,time,meetLink}], skipped:[{date,time,reason}],
//     total, alreadyExisted:false }
//
// ─────────────────────────────────────────────────────────────────────────────
// POURQUOI CET ENDPOINT EXISTE PLUTÔT QU'UNE BOUCLE DANS booking.html
// ─────────────────────────────────────────────────────────────────────────────
// Écrire 23 documents dans `bookings` depuis le navigateur déclencherait 23
// fois `onBookingCreated` : 23 événements Google, 23 invitations au client,
// 23 emails de confirmation et 23 notifications à l'équipe. Décision d'Adrien
// (18/08/2026) : pour ce cas précis — et seulement pour lui — la série est
// gérée ici, et les documents portent `seriesManaged:true`, drapeau sur lequel
// `onBookingCreated` rend la main immédiatement.
//
//   → Le client reçoit DEUX emails : la confirmation habituelle de son premier
//     RDV (envoyée par la Cloud Function, chemin inchangé) puis un
//     récapitulatif unique listant toute la série, avec un .ics de toutes les
//     séances.
//   → L'équipe reçoit sa notification habituelle pour le 1er RDV, puis un
//     récapitulatif unique.
//   → Chaque séance garde SON PROPRE événement Google (jamais une récurrence
//     RRULE) : `onBookingUpdated` supprime `calendarEventId` à l'annulation,
//     un événement récurrent partagé ferait donc disparaître toute la série
//     dès qu'une seule séance serait annulée.
//   → Les invitations Google partent en `sendUpdates:'none'` : aucun email
//     Google. Le client reste attendee, donc les séances apparaissent quand
//     même dans son agenda Google s'il en a un ; le .ics couvre les autres.
//
// ─────────────────────────────────────────────────────────────────────────────
// SÉCURITÉ
// ─────────────────────────────────────────────────────────────────────────────
//   · L'email doit correspondre à une fiche `clients` ACTIVE dont le programme
//     est un Elite NEW hebdomadaire — quelques dossiers, pas le tout-venant.
//   · Le nombre d'occurrences est replafonné serveur : jamais plus que ce qui
//     reste du forfait, quoi qu'envoie le navigateur.
//   · Chaque créneau est REVÉRIFIÉ ici (planning, fériés, RDV Alteore, agenda
//     Google). Un créneau pris entre l'affichage du plan et la confirmation
//     est écarté, pas écrasé.
//   · Idempotence par identifiant déterministe : seriesId = 'ser-' +
//     firstBookingId, et chaque séance a l'id `{seriesId}-w{n}`. Un double
//     clic, un retry réseau ou un rechargement retombent sur les mêmes
//     documents — aucun doublon possible.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { google } = require('googleapis');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');
const Dispo = require('../dispo-core.js');
const R = require('./_recurrence-core');

const ADMIN_EMAIL = 'contact@adrienemily.com';

const JOURS_FR = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MOIS_FR = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

function json(res, code, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).send(JSON.stringify(body));
}

function fmtDateFr(ds) {
  const d = Dispo.ymdToDate(ds);
  return JOURS_FR[d.getDay()] + ' ' + d.getDate() + ' ' + MOIS_FR[d.getMonth()] + ' ' + d.getFullYear();
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function addMinutes(time, mins) {
  return Dispo.minToTime(Dispo.timeToMin(time) + mins);
}

/* ══════════════════════════════════════════════════════════════════════════
   GOOGLE CALENDAR
   ══════════════════════════════════════════════════════════════════════════ */

/**
 * Calendrier cible des événements de cet expert. Copie conforme de
 * getEventCalendarId() dans Functions/index.js : les coachs partagent le
 * compte coaching@adrienemily.com, chacun sur son sous-calendrier.
 */
async function getEventCalendarId(personId) {
  try {
    const doc = await db.collection('booking_config').doc(personId).get();
    if (!doc.exists) return 'primary';
    const list = (doc.data() || {}).calendarList || [];
    const target = list.find((c) => c && c.createEvents === true && c.id);
    return target ? target.id : 'primary';
  } catch (e) {
    console.error('[booking-series-create] getEventCalendarId:', e.message);
    return 'primary';
  }
}

/* ══════════════════════════════════════════════════════════════════════════
   .ICS DE TOUTE LA SÉRIE
   ══════════════════════════════════════════════════════════════════════════ */

/* Les heures sont écrites en heure locale de Paris avec un TZID, jamais
   converties en UTC : c'est la seule façon d'être juste des deux côtés du
   changement d'heure — une série de six mois traverse forcément octobre. */
const VTIMEZONE_PARIS = [
  'BEGIN:VTIMEZONE',
  'TZID:Europe/Paris',
  'BEGIN:DAYLIGHT',
  'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST',
  'DTSTART:19700329T020000',
  'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU',
  'END:DAYLIGHT',
  'BEGIN:STANDARD',
  'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET',
  'DTSTART:19701025T030000',
  'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU',
  'END:STANDARD',
  'END:VTIMEZONE',
];

function icsEscape(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

function icsStamp(ds, time) {
  return ds.replace(/-/g, '') + 'T' + time.replace(':', '') + '00';
}

function buildSeriesIcs(sessions, opts) {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const dtstamp = now.getUTCFullYear() + pad(now.getUTCMonth() + 1) + pad(now.getUTCDate())
    + 'T' + pad(now.getUTCHours()) + pad(now.getUTCMinutes()) + pad(now.getUTCSeconds()) + 'Z';

  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Alteore//Booking//FR', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  VTIMEZONE_PARIS.forEach((l) => lines.push(l));

  sessions.forEach((s, i) => {
    const end = addMinutes(s.time, opts.duration);
    const desc = [
      'Séance ' + (i + 1) + ' / ' + sessions.length,
      'Coach : ' + opts.personName,
      'Durée : ' + opts.duration + ' min',
    ];
    if (s.meetLink) { desc.push(''); desc.push('Visioconférence : ' + s.meetLink); }

    lines.push('BEGIN:VEVENT');
    lines.push('UID:' + (s.id || (opts.seriesId + '-' + i)) + '@team.alteore.com');
    lines.push('DTSTAMP:' + dtstamp);
    lines.push('DTSTART;TZID=Europe/Paris:' + icsStamp(s.date, s.time));
    lines.push('DTEND;TZID=Europe/Paris:' + icsStamp(s.date, end));
    lines.push('SUMMARY:' + icsEscape(opts.typeLabel + ' — séance ' + (i + 1) + '/' + sessions.length));
    lines.push('DESCRIPTION:' + icsEscape(desc.join('\n')));
    if (s.meetLink) lines.push('LOCATION:' + icsEscape(s.meetLink));
    lines.push('STATUS:CONFIRMED');
    lines.push('END:VEVENT');
  });

  lines.push('END:VCALENDAR');

  // Repli RFC 5545 : 75 octets par ligne, continuation par un espace.
  const folded = [];
  lines.forEach((line) => {
    if (line.length <= 73) { folded.push(line); return; }
    folded.push(line.substring(0, 73));
    let rest = line.substring(73);
    while (rest.length) { folded.push(' ' + rest.substring(0, 72)); rest = rest.substring(72); }
  });
  return folded.join('\r\n') + '\r\n';
}

/* ══════════════════════════════════════════════════════════════════════════
   EMAILS
   ══════════════════════════════════════════════════════════════════════════ */

function styledEmail(subject, contentHtml) {
  const subjEsc = esc(subject);
  return '<!DOCTYPE html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/></head><body style="margin:0;padding:0;background:#f4f4f8;font-family:Helvetica,Arial,sans-serif">'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f8;padding:30px 0"><tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%">'
    + '<tr><td style="background:linear-gradient(135deg,#1e3a8a,#3b82f6);border-radius:16px 16px 0 0;padding:40px 40px 30px;text-align:center">'
    + '<div style="font-size:14px;font-weight:800;color:rgba(255,255,255,0.7);letter-spacing:2px;text-transform:uppercase;margin-bottom:16px">ADRIEN &amp; EMILY</div>'
    + '<div style="font-size:24px;font-weight:800;color:#ffffff;line-height:1.3">' + subjEsc + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#ffffff;padding:36px 40px;border-left:1px solid #e5e7eb;border-right:1px solid #e5e7eb">'
    + '<div style="font-size:15px;line-height:1.7;color:#374151">' + (contentHtml || '') + '</div>'
    + '</td></tr>'
    + '<tr><td style="background:#f9fafb;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 16px 16px;padding:24px 40px;text-align:center">'
    + '<div style="font-size:12px;color:#9ca3af;line-height:1.6">'
    + '👩‍🎓 <strong style="color:#6b7280">Adrien &amp; Emily</strong> · 🏢 <strong style="color:#6b7280">Alteore</strong><br/>'
    + 'Accompagnement des dirigeants en Francophonie<br/>'
    + '<a href="https://www.adrienemily.com" style="color:#3b82f6;text-decoration:none">adrienemily.com</a> · '
    + '<a href="https://www.alteore.com" style="color:#3b82f6;text-decoration:none">alteore.com</a>'
    + '</div></td></tr>'
    + '</table></td></tr></table></body></html>';
}

function sessionsTable(sessions, startIndex, total) {
  let h = '<table cellpadding="0" cellspacing="0" style="width:100%;border-collapse:collapse;margin:0 0 18px">';
  sessions.forEach((s, i) => {
    const n = startIndex + i;
    h += '<tr>'
      + '<td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:13px;color:#6b7280;width:70px;white-space:nowrap"><strong>' + n + '/' + total + '</strong></td>'
      + '<td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827">' + esc(fmtDateFr(s.date)) + '</td>'
      + '<td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:14px;color:#111827;white-space:nowrap"><strong>' + esc(s.time) + '</strong></td>'
      + (s.meetLink
        ? '<td style="padding:9px 12px;border-bottom:1px solid #e5e7eb;font-size:12px"><a href="' + esc(s.meetLink) + '" style="color:#16a34a;text-decoration:none;font-weight:600">Meet ↗</a></td>'
        : '<td style="padding:9px 12px;border-bottom:1px solid #e5e7eb"></td>')
      + '</tr>';
  });
  h += '</table>';
  return h;
}

function htmlToText(html) {
  return html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|tr|table)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
    .replace(/[ \t]+/g, ' ').replace(/\n[ \t]+/g, '\n').trim();
}

/* ══════════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════════ */

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { json(res, 405, { error: 'method_not_allowed' }); return; }

  const body = parseBody(req);
  const firstBookingId = String(body.firstBookingId || '').trim();
  const personId = String(body.personId || '').trim();
  const typeId = String(body.typeId || '').trim();
  const wanted = Array.isArray(body.occurrences) ? body.occurrences : [];

  if (!firstBookingId || !personId || !typeId) { json(res, 400, { error: 'missing_params' }); return; }
  if (!wanted.length) { json(res, 400, { error: 'no_occurrences' }); return; }

  const seriesId = 'ser-' + firstBookingId;

  try {
    // ── 1. Le RDV d'ancrage doit exister et être cohérent ─────────────────
    const firstSnap = await db.collection('bookings').doc(firstBookingId).get();
    if (!firstSnap.exists) { json(res, 404, { error: 'first_booking_not_found' }); return; }
    const first = firstSnap.data() || {};
    if (first.personId !== personId || first.type !== typeId) {
      json(res, 400, { error: 'first_booking_mismatch' });
      return;
    }
    if (first.status !== 'confirmed') { json(res, 409, { error: 'first_booking_not_confirmed' }); return; }

    const prospect = first.prospect || {};
    // Graphie d'origine conservée : `prospect.email` est stocké tel que saisi,
    // et c'est sur ce champ que se compte le forfait déjà consommé.
    const emailRaw = String(prospect.email || '').trim();
    const email = emailRaw.toLowerCase();
    if (!email) { json(res, 400, { error: 'no_email_on_first_booking' }); return; }

    // ── 2. Idempotence : la série a-t-elle déjà été posée ? ────────────────
    const existing = await db.collection('bookings').where('seriesId', '==', seriesId).get();
    if (!existing.empty) {
      const created = [];
      existing.forEach((d) => {
        const b = d.data();
        created.push({ id: d.id, date: b.date, time: b.time, meetLink: b.meetLink || null });
      });
      created.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
      console.log('[booking-series-create] série déjà posée, rien à écrire: ' + seriesId);
      json(res, 200, { ok: true, seriesId, alreadyExisted: true, created, skipped: [], total: created.length + 1 });
      return;
    }

    // ── 3. Éligibilité — la fiche client fait foi, jamais le navigateur ───
    const ctxConf = await R.loadBookingContext(personId, typeId);
    if (ctxConf.error) { json(res, 400, { error: ctxConf.error }); return; }
    if (ctxConf.type.isCoaching !== true) { json(res, 403, { error: 'type_not_coaching' }); return; }

    /* Flag d'activation — dernier rempart. Tant que le garde-fou
       `seriesManaged` n'est pas déployé dans onBookingCreated, poser une série
       enverrait près de 70 emails. On refuse donc côté serveur aussi, pas
       seulement dans la page. Bascule : booking_config/_settings
       → coachingRecurrenceEnabled = true, APRÈS le déploiement de la Function. */
    if (ctxConf.settings.coachingRecurrenceEnabled !== true) {
      json(res, 403, { error: 'feature_disabled', hint: 'booking_config/_settings.coachingRecurrenceEnabled' });
      return;
    }

    const client = await R.findClientByEmail(emailRaw);
    if (!client) { json(res, 403, { error: 'client_not_found' }); return; }
    const c = client.data;
    if (c.ancienClient === true || c.statut === 'inactif') { json(res, 403, { error: 'client_inactive' }); return; }

    const programme = c.programme || '';
    if (!R.isEliteNewWeekly(programme)) { json(res, 403, { error: 'programme_not_eligible' }); return; }

    // Plafond serveur. `done` inclut déjà le premier RDV (créé juste avant,
    // donc compté comme RDV coaching à venir) : ce qui reste à poser est
    // exactement total - done.
    const total = R.totalSessionsOf(programme);
    const upcoming = await R.countUpcomingCoachingBookings(emailRaw);
    const done = R.countDoneSessions(c) + upcoming.count;
    const allowed = Math.max(0, total - done);
    if (allowed <= 0) { json(res, 409, { error: 'series_complete', total, done }); return; }

    const occurrences = wanted
      .filter((o) => o && /^\d{4}-\d{2}-\d{2}$/.test(o.date) && /^\d{2}:\d{2}$/.test(o.time))
      .slice(0, allowed);
    if (!occurrences.length) { json(res, 400, { error: 'no_valid_occurrences' }); return; }

    // ── 4. Revérification des créneaux ────────────────────────────────────
    const params = R.slotParamsOf(ctxConf.type, ctxConf.person);
    const dates = occurrences.map((o) => o.date).sort();
    const firstDs = dates[0];
    const lastDs = dates[dates.length - 1];

    const bookSnap = await db.collection('bookings')
      .where('date', '>=', firstDs)
      .where('date', '<=', lastDs)
      .get();
    const allBookings = [];
    bookSnap.forEach((d) => allBookings.push(d.data()));

    const busyRaw = await R.fetchBusyRange(personId, firstDs, lastDs);
    const minNoticeDays = Math.ceil((params.minNoticeHours || 0) / 24);
    const slotCtx = {
      person: ctxConf.person,
      settings: ctxConf.settings,
      params,
      bookings: R.bookingsByDate(allBookings, personId),
      busy: R.busyByDate(busyRaw),
      minDate: Dispo.addDays(Dispo.todayParis(), minNoticeDays),
    };

    const retained = [];
    const skipped = [];
    const seenKeys = {};
    occurrences.forEach((o) => {
      const key = o.date + ' ' + o.time;
      if (seenKeys[key]) { return; }               // doublon envoyé par le front
      seenKeys[key] = 1;
      if (o.date <= first.date) { skipped.push({ date: o.date, time: o.time, reason: 'avant_le_premier_rdv' }); return; }
      const free = R.freeSlotsForDate(slotCtx, o.date);
      if (free.indexOf(o.time) < 0) { skipped.push({ date: o.date, time: o.time, reason: 'creneau_pris' }); return; }
      retained.push({ date: o.date, time: o.time });
      // Une séance retenue occupe le créneau pour les suivantes de la série.
      (slotCtx.bookings[o.date] = slotCtx.bookings[o.date] || []).push({
        personId, date: o.date, time: o.time, duration: params.duration, status: 'confirmed',
      });
    });

    if (!retained.length) {
      json(res, 409, { ok: false, error: 'all_slots_taken', seriesId, skipped });
      return;
    }
    retained.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));

    // ── 5. Écriture des RDV ───────────────────────────────────────────────
    // `seriesManaged:true` = « onBookingCreated ne touche à rien » : pas
    // d'événement Google, pas d'email. Tout est fait ici, en une fois.
    const seriesTotal = retained.length + 1;      // + le RDV d'ancrage
    const batch = db.batch();
    const docs = [];
    retained.forEach((o, i) => {
      const id = seriesId + '-w' + String(i + 1).padStart(2, '0');
      const ref = db.collection('bookings').doc(id);
      const doc = {
        type: typeId,
        typeLabel: ctxConf.type.label || first.typeLabel || '',
        personId,
        personName: ctxConf.person.name || first.personName || '',
        date: o.date,
        time: o.time,
        duration: params.duration,
        status: 'confirmed',
        slotOpen: false,
        timezone: body.timezone || first.timezone || 'Europe/Paris',
        prospect: first.prospect || {},
        formData: first.formData || {},
        isCoaching: true,
        source: first.source || 'self_booking',
        clientId: client.id,
        clientName: c.nom || '',
        // Un client coaching n'est pas un prospect : aucun lead ne doit
        // naître d'une séance de suivi (même règle que le mode agent CSM).
        skipLeadCreation: true,
        seriesManaged: true,
        seriesId,
        seriesIndex: i + 2,                        // le 1er RDV est l'index 1
        seriesTotal,
        seriesFirstBookingId: firstBookingId,
        seriesProgramme: programme,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (first.leadId) doc.leadId = first.leadId;
      if (first.formId) doc.formId = first.formId;
      batch.set(ref, doc);
      docs.push({ id, ref, date: o.date, time: o.time });
    });

    // Marque aussi le RDV d'ancrage comme tête de série, pour qu'un coup d'œil
    // dans booking-admin suffise à comprendre qu'il fait partie d'un parcours.
    batch.update(firstSnap.ref, {
      seriesId,
      seriesIndex: 1,
      seriesTotal,
      seriesProgramme: programme,
    });

    await batch.commit();
    console.log('[booking-series-create] ' + retained.length + ' séances écrites (' + seriesId + ')');

    // ── 6. Événements Google, sans une seule invitation par email ──────────
    const calendarId = await getEventCalendarId(personId);
    const clientName = ((prospect.prenom || '') + ' ' + (prospect.nom || '')).trim() || email;
    const typeLabel = ctxConf.type.label || 'Coaching';

    let cal = null;
    try {
      const authClient = await R.getAuthClientForPerson(personId);
      if (authClient) cal = google.calendar({ version: 'v3', auth: authClient });
    } catch (e) {
      console.error('[booking-series-create] auth Google:', e.message);
    }

    if (cal) {
      for (const d of docs) {
        try {
          const endTime = addMinutes(d.time, params.duration);
          const description = 'Séance ' + (docs.indexOf(d) + 2) + '/' + seriesTotal + ' du parcours ' + programme
            + '\n\n— Client —\n' + clientName
            + (prospect.email ? '\nEmail : ' + prospect.email : '')
            + (prospect.telephone ? '\nTéléphone : ' + prospect.telephone : '')
            + '\n\n— RDV —\nType : ' + typeLabel
            + '\nExpert : ' + (ctxConf.person.name || '')
            + '\nDurée : ' + params.duration + ' min'
            + '\n\nProgrammé via la récurrence Ambitio Booking.';

          const resp = await cal.events.insert({
            calendarId,
            conferenceDataVersion: 1,
            // Aucune notification Google : le client reçoit UN récapitulatif
            // de notre part, pas 23 invitations.
            sendUpdates: 'none',
            requestBody: {
              summary: typeLabel + ' — ' + clientName + ' (' + (docs.indexOf(d) + 2) + '/' + seriesTotal + ')',
              description,
              start: { dateTime: d.date + 'T' + d.time + ':00', timeZone: 'Europe/Paris' },
              end: { dateTime: d.date + 'T' + endTime + ':00', timeZone: 'Europe/Paris' },
              attendees: prospect.email ? [{ email: prospect.email, displayName: clientName }] : undefined,
              conferenceData: {
                createRequest: {
                  requestId: d.id,
                  conferenceSolutionKey: { type: 'hangoutsMeet' },
                },
              },
            },
          });
          d.calendarEventId = resp.data.id;
          d.calendarEventLink = resp.data.htmlLink || '';
          d.meetLink = resp.data.hangoutLink || null;
        } catch (e) {
          console.error('[booking-series-create] event ' + d.date + ' ' + d.time + ':', e.message);
          d.calendarError = e.message;
        }
      }

      /* Le code Meet d'un événement créé par l'API est d'abord provisoire :
         Google le régénère quelques secondes plus tard. On relit donc les
         événements avant de composer l'email, sinon le lien envoyé au client
         ne serait pas celui de son agenda (c'est le bug « deux liens Meet »
         corrigé côté Cloud Function en 06/2026). Aucune invitation n'étant
         partie, cette relecture unique suffit — pas besoin d'attendre. */
      for (const d of docs) {
        if (!d.calendarEventId) continue;
        try {
          const got = await cal.events.get({ calendarId, eventId: d.calendarEventId });
          const link = got.data.hangoutLink
            || ((got.data.conferenceData && got.data.conferenceData.entryPoints || [])
              .find((e) => e.entryPointType === 'video') || {}).uri
            || null;
          if (link) d.meetLink = link;
        } catch (e) { /* on garde le lien provisoire */ }
      }
    } else {
      console.warn('[booking-series-create] aucun calendrier Google pour ' + personId + ' — séances écrites sans événement');
    }

    // Écriture des identifiants d'événement sur les RDV.
    const wb = db.batch();
    docs.forEach((d) => {
      const patch = {};
      if (d.calendarEventId) {
        patch.calendarEventId = d.calendarEventId;
        patch.calendarEventLink = d.calendarEventLink || '';
        patch.calendarIdUsed = calendarId;        // requis par onBookingUpdated
      }
      if (d.meetLink) patch.meetLink = d.meetLink;
      if (d.calendarError) patch.calendarError = d.calendarError;
      if (Object.keys(patch).length) wb.update(d.ref, patch);
    });
    await wb.commit();

    // Rafraîchit calendar_busy pour que les créneaux disparaissent tout de
    // suite du booking public (la Cloud Function onCalendarSyncRequest fait
    // le travail — on ne duplique pas sa logique ici).
    try {
      await db.collection('calendar_sync_requests').doc(personId).set({
        requestedAt: admin.firestore.FieldValue.serverTimestamp(),
        requestedBy: 'booking-series-create',
      }, { merge: true });
    } catch (e) { console.warn('[booking-series-create] sync request:', e.message); }

    try {
      await db.collection('clients').doc(client.id).update({
        lastCoachingBookingAt: admin.firestore.FieldValue.serverTimestamp(),
        lastCoachingBookingId: docs[docs.length - 1].id,
      });
    } catch (e) { console.warn('[booking-series-create] maj fiche client:', e.message); }

    // ── 7. UN récapitulatif au client, UN à l'équipe ──────────────────────
    const allSessions = [{ date: first.date, time: first.time, id: firstBookingId, meetLink: first.meetLink || null }]
      .concat(docs.map((d) => ({ date: d.date, time: d.time, id: d.id, meetLink: d.meetLink || null })));

    const notifs = (ctxConf.type.notifications) || {};
    const accountKey = notifs.emailAccount || 'coaching';
    const icsContent = buildSeriesIcs(allSessions, {
      duration: params.duration,
      personName: ctxConf.person.name || '',
      typeLabel,
      seriesId,
    });

    const greet = (prospect.prenom || '').trim() || (prospect.nom || '').trim() || '';
    const skipHtml = skipped.length
      ? '<div style="margin:18px 0;padding:14px 16px;background:#fff7ed;border-left:4px solid #fb923c;border-radius:8px;font-size:13px;color:#7c2d12">'
        + '<strong>' + skipped.length + ' séance' + (skipped.length > 1 ? 's n\'ont' : ' n\'a') + ' pas pu être programmée' + (skipped.length > 1 ? 's' : '') + '</strong> — le créneau venait d\'être pris. '
        + 'Reprenez simplement rendez-vous sur le lien de votre coach pour ' + (skipped.length > 1 ? 'ces dates' : 'cette date') + '.</div>'
      : '';

    const clientSubject = 'Vos ' + allSessions.length + ' séances de coaching sont programmées';
    const clientContent = '<p style="margin:0 0 18px">Bonjour' + (greet ? ' <strong>' + esc(greet) + '</strong>' : '') + ',</p>'
      + '<p style="margin:0 0 18px">Votre accompagnement <strong>' + esc(programme) + '</strong> avec <strong>' + esc(ctxConf.person.name || '') + '</strong> est calé. '
      + 'Voici l\'ensemble de vos séances — une par semaine, ' + esc(JOURS_FR[Dispo.ymdToDate(first.date).getDay()]) + ' à ' + esc(first.time) + '.</p>'
      + sessionsTable(allSessions, 1, allSessions.length)
      + skipHtml
      + '<p style="margin:18px 0;font-size:13px;color:#6b7280">Le fichier joint <strong>seances-coaching.ics</strong> ajoute toutes ces séances à votre agenda en un clic. '
      + 'Si vous utilisez Google Agenda avec l\'adresse ' + esc(email) + ', elles y sont déjà.</p>'
      + '<p style="margin:18px 0;font-size:13px;color:#6b7280">Un empêchement sur une date ? Écrivez-nous, on la décale — les autres séances ne bougent pas.</p>'
      + '<p style="margin:0">À très vite !<br><strong>L\'équipe Adrien &amp; Emily</strong></p>';

    try {
      const r = await sendEmailFromAccount({
        accountKey,
        to: emailRaw || email,
        subject: clientSubject,
        bodyHtml: styledEmail(clientSubject, clientContent),
        bodyText: htmlToText(clientContent),
        attachments: [{ filename: 'seances-coaching.ics', mimeType: 'text/calendar; charset=UTF-8; method=PUBLISH', content: icsContent }],
      });
      console.log('[booking-series-create] récap client ' + (r.ok ? '✓' : '✗ ' + r.error));
    } catch (e) {
      console.error('[booking-series-create] récap client:', e.message);
    }

    try {
      let coachEmail = ctxConf.person.personalEmail || ctxConf.person.email || null;
      if (!coachEmail && ctxConf.person.firebaseUid) {
        const u = await db.collection('users').doc(ctxConf.person.firebaseUid).get();
        if (u.exists) coachEmail = (u.data() || {}).email || null;
      }
      const teamSubject = '🔁 Série coaching programmée — ' + clientName + ' (' + retained.length + ' séances)';
      const teamContent = '<p><strong>' + esc(clientName) + '</strong> vient de programmer sa série hebdomadaire.</p>'
        + '<table style="border-collapse:collapse;font-size:14px"><tbody>'
        + '<tr><td style="padding:4px 12px 4px 0"><strong>Programme</strong></td><td>' + esc(programme) + '</td></tr>'
        + '<tr><td style="padding:4px 12px 4px 0"><strong>Coach</strong></td><td>' + esc(ctxConf.person.name || '') + '</td></tr>'
        + '<tr><td style="padding:4px 12px 4px 0"><strong>Email</strong></td><td>' + esc(email) + '</td></tr>'
        + '<tr><td style="padding:4px 12px 4px 0"><strong>Rythme</strong></td><td>' + esc(JOURS_FR[Dispo.ymdToDate(first.date).getDay()]) + ' à ' + esc(first.time) + '</td></tr>'
        + '<tr><td style="padding:4px 12px 4px 0"><strong>Séances posées</strong></td><td>' + allSessions.length + ' (dont le RDV initial)</td></tr>'
        + '</tbody></table>'
        + sessionsTable(allSessions, 1, allSessions.length)
        + (skipped.length ? '<p style="color:#b45309"><strong>' + skipped.length + ' créneau(x) écarté(s)</strong> (déjà pris entre l\'affichage et la confirmation) : '
            + esc(skipped.map((s) => s.date + ' ' + s.time).join(', ')) + '</p>' : '')
        + '<p style="margin-top:16px;font-size:12px;color:#666">Les événements Google sont créés sans invitation par email — le client a reçu un récapitulatif unique. Notification automatique — Ambitio Booking.</p>';

      const r = await sendEmailFromAccount({
        accountKey,
        to: ADMIN_EMAIL,
        cc: (coachEmail && coachEmail !== ADMIN_EMAIL) ? coachEmail : undefined,
        subject: teamSubject,
        bodyHtml: styledEmail(teamSubject, teamContent),
        bodyText: htmlToText(teamContent),
      });
      console.log('[booking-series-create] récap équipe ' + (r.ok ? '✓' : '✗ ' + r.error));
    } catch (e) {
      console.error('[booking-series-create] récap équipe:', e.message);
    }

    json(res, 200, {
      ok: true,
      seriesId,
      alreadyExisted: false,
      total: allSessions.length,
      created: docs.map((d) => ({ id: d.id, date: d.date, time: d.time, meetLink: d.meetLink || null })),
      skipped,
    });
  } catch (e) {
    console.error('[booking-series-create] erreur:', e);
    // Le premier RDV, lui, est déjà confirmé : une panne ici ne coûte jamais
    // le rendez-vous, seulement la série. Le front le dit au client.
    json(res, 500, { ok: false, error: 'internal_error', message: e.message, seriesId });
  }
};
