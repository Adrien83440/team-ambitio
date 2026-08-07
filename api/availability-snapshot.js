// ============================================================================
// api/availability-snapshot.js — ARCHIVE QUOTIDIENNE DE LA CAPACITÉ SALES
// ----------------------------------------------------------------------------
// POURQUOI
// --------
// booking_config ne stocke que les horaires ACTUELS d'un expert. Quand Élodie
// retire trois heures le mardi, l'ancienne capacité disparaît définitivement :
// plus aucun moyen de dire « en juillet elle avait ouvert 168 créneaux ».
// Ce cron fige donc, chaque nuit, ce qui était réellement ouvert / pris /
// libre — c'est la mémoire que lit la section « Capacité & dispos » du funnel.
//
// CE QU'IL ÉCRIT
// --------------
//   availability_daily/{personId}__{YYYY-MM}
//     { personId, personName, month, days: { 'YYYY-MM-DD': {open,booked,perso,free,work} },
//       updatedAt, lastRunAt }
//
// QUELS JOURS
// -----------
//   • hier + aujourd'hui  → TOUJOURS réécrits (hier est définitif, aujourd'hui
//     bougera encore mais sert de valeur de repli si une nuit saute)
//   • les BACKFILL_DAYS jours précédents → écrits UNIQUEMENT s'ils manquent
//     (rattrapage auto-cicatrisant après une nuit ratée, sans jamais réécrire
//     un jour déjà figé avec des horaires qui ont changé depuis)
//
// AUTH
// ----
//   Authorization: Bearer <CRON_SECRET>   (envoyé par Vercel Cron)
//   x-api-key: <CRON_SECRET>              (test manuel via curl)
//   Fail-closed : CRON_SECRET absent = 500, jamais de bypass.
//
//   Test manuel :
//     curl -H "x-api-key: <CRON_SECRET>" \
//          "https://<domaine>/api/availability-snapshot?days=14"
//
// Le comptage lui-même vit dans dispo-core.js, partagé avec sales-funnel.html :
// l'archive et l'écran doivent compter à l'identique, sinon les chiffres
// sautent le jour où un jour bascule de « calculé » à « archivé ».
// ============================================================================
const { db, admin } = require('./_firebaseAdmin');
const Dispo = require('../dispo-core.js');

/* Profondeur de rattrapage par défaut. 7 jours couvre une semaine de pannes
   consécutives sans faire exploser le nombre de lectures RDV. */
const BACKFILL_DAYS = 7;
const MAX_BACKFILL_DAYS = 120;

function json(res, code, body) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.status(code).send(JSON.stringify(body));
}

/* ── Auth : Bearer (Vercel Cron) ou x-api-key (curl manuel) ── */
function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, code: 500, error: 'CRON_SECRET non configuré' };
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const apiKey = req.headers['x-api-key'] || null;
  if (bearer === secret || apiKey === secret) return { ok: true };
  return { ok: false, code: 401, error: 'Non autorisé' };
}

/* ── booking_config : experts + réglages globaux ── */
async function loadBookingConfig() {
  const snap = await db.collection('booking_config').get();
  const persons = [];
  let settings = {};
  snap.forEach((doc) => {
    const d = doc.data() || {};
    if (doc.id === '_settings') { settings = d; return; }
    if (d.__type === 'person') { d.id = doc.id; persons.push(d); }
  });
  return { persons, settings };
}

/* ── _meta/team_members : `members` peut être un objet OU un tableau
   (Firestore array-ifie parfois) — mêmes deux cas que nav.js. ── */
async function loadTeamMembers() {
  const snap = await db.collection('_meta').doc('team_members').get();
  if (!snap.exists) return [];
  const raw = (snap.data() || {}).members;
  const list = [];
  if (Array.isArray(raw)) {
    raw.forEach((e, i) => { if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || ('m' + i) }, e)); });
  } else if (raw && typeof raw === 'object') {
    Object.keys(raw).forEach((slug) => {
      const e = raw[slug];
      if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || slug }, e));
    });
  }
  return list;
}

/* ── RDV de la fenêtre traitée, tous statuts (dispo-core tranche ensuite) ── */
async function loadBookings(startDs, endDs) {
  const snap = await db.collection('bookings')
    .where('date', '>=', startDs).where('date', '<=', endDs).get();
  const out = [];
  snap.forEach((doc) => { const d = doc.data() || {}; d._id = doc.id; out.push(d); });
  return out;
}

/* ── calendar_busy d'un expert connecté à Google Calendar ── */
async function loadBusy(personId) {
  try {
    const snap = await db.collection('calendar_busy').doc(personId).get();
    return (snap.exists && (snap.data() || {}).busy) || [];
  } catch (e) {
    console.warn('[availability-snapshot] busy', personId, e.message);
    return [];
  }
}

/* ── Archive déjà écrite pour les mois couverts ── */
async function loadArchive(personId, monthKeys) {
  const out = {};
  await Promise.all(monthKeys.map(async (mk) => {
    try {
      const snap = await db.collection('availability_daily').doc(Dispo.archiveDocId(personId, mk)).get();
      if (!snap.exists) return;
      const days = (snap.data() || {}).days || {};
      Object.keys(days).forEach((ds) => { out[ds] = days[ds]; });
    } catch (e) {
      console.warn('[availability-snapshot] archive', personId, mk, e.message);
    }
  }));
  return out;
}

module.exports = async function handler(req, res) {
  /* Vercel Cron appelle en GET ; POST accepté pour un déclenchement manuel. */
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, error: 'Méthode non autorisée' });
  }

  const auth = checkAuth(req);
  if (!auth.ok) {
    if (auth.code === 500) console.error('[availability-snapshot] CRON_SECRET absent');
    return json(res, auth.code, { ok: false, error: auth.error });
  }

  const t0 = Date.now();
  try {
    /* Fenêtre : aujourd'hui À PARIS, pas en UTC — sinon le cron de 4 h du
       matin traiterait « hier » à contretemps deux fois par an. */
    const today = Dispo.todayParis();
    let depth = parseInt((req.query && req.query.days) || BACKFILL_DAYS, 10);
    if (!isFinite(depth) || depth < 1) depth = BACKFILL_DAYS;
    if (depth > MAX_BACKFILL_DAYS) depth = MAX_BACKFILL_DAYS;

    const startDs = Dispo.addDays(today, -depth);
    const days = Dispo.eachDay(startDs, today);
    const monthKeys = Dispo.monthKeysFor(days);

    const [{ persons, settings }, members, bookings] = await Promise.all([
      loadBookingConfig(), loadTeamMembers(), loadBookings(startDs, today)
    ]);

    const targets = Dispo.salesPersons(persons, members);
    if (!targets.length) {
      return json(res, 200, {
        ok: true, today, written: 0, persons: 0,
        warning: 'Aucun expert booking rattaché à un membre sales (rôle setter / closer / closer_setter).'
      });
    }

    const bookingIdx = Dispo.indexBookings(bookings);
    const report = [];
    let written = 0;

    for (const t of targets) {
      const p = t.person;
      const busy = p.calendarConnected ? await loadBusy(p.id) : [];
      const existing = await loadArchive(p.id, monthKeys);
      const byDate = bookingIdx[p.id] || {};

      /* Un lot d'écritures par mois : merge sur le champ `days` uniquement,
         jamais de réécriture complète du document (une nuit ne doit pas
         pouvoir effacer les mois précédents). */
      const perMonth = {};
      let daysWritten = 0;

      for (const ds of days) {
        /* Un jour déjà CLÔTURÉ ne se réécrit jamais : c'est ce qui empêche un
           changement d'horaires d'aujourd'hui de réécrire le mois dernier.
           Tout le reste (aujourd'hui, et les jours qu'une nuit ratée a laissés
           non clôturés) est recalculé — le rattrapage est auto-cicatrisant. */
        if (!Dispo.shouldRewriteArchiveDay(existing[ds])) continue;
        const cap = Dispo.dayCapacity(p, ds, { settings, bookings: byDate[ds], busy });
        const meta = Dispo.archiveDayMeta(ds, today);
        const mk = Dispo.monthKeyOf(ds);
        (perMonth[mk] = perMonth[mk] || {})[ds] = {
          open: cap.open, booked: cap.booked, perso: cap.perso, free: cap.free, work: cap.work,
          final: meta.final, approx: meta.approx
        };
        daysWritten++;
      }

      for (const mk of Object.keys(perMonth)) {
        const payload = { personId: p.id, personName: p.name || '', month: mk, days: {} };
        Object.keys(perMonth[mk]).forEach((ds) => { payload.days[ds] = perMonth[mk][ds]; });
        payload.updatedAt = admin.firestore.FieldValue.serverTimestamp();
        await db.collection('availability_daily')
          .doc(Dispo.archiveDocId(p.id, mk))
          .set(payload, { merge: true });
        written++;
      }

      report.push({
        personId: p.id, name: p.name || '', slug: t.member.slug,
        matchedBy: t.matchedBy, daysWritten
      });
    }

    console.log('[availability-snapshot] ' + today + ' — ' + targets.length + ' experts, '
      + written + ' docs, ' + ((Date.now() - t0) / 1000).toFixed(1) + ' s');

    return json(res, 200, {
      ok: true, today, from: startDs, days: days.length,
      persons: targets.length, docsWritten: written,
      elapsedMs: Date.now() - t0, report
    });
  } catch (e) {
    console.error('[availability-snapshot] erreur', e);
    return json(res, 500, { ok: false, error: e.message });
  }
};
