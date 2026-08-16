// ============================================================================
// api/admin-booking-dedupe.js
// ----------------------------------------------------------------------------
// Nettoie les réservations en doublon : plusieurs documents `bookings` créés
// pour le MÊME prospect, sur le MÊME créneau, chez le MÊME expert.
//
// Contexte (incident 08/2026)
// ---------------------------
// booking.html ne désactivait son bouton de confirmation qu'APRÈS l'appel à
// /api/booking-check-coaching-quota. Sur un RDV coaching, ce fetch pouvait
// prendre plusieurs secondes (cold start Vercel) pendant lesquelles le bouton
// restait cliquable : chaque clic repartait de zéro et écrivait un document de
// plus. Un client s'est retrouvé avec 10 RDV sur le créneau de 15:00, chacun
// ayant déclenché onBookingCreated → un événement Google Calendar et un lien
// Meet distincts, plus un email de confirmation.
//
// La cause est corrigée dans booking.html (verrou de soumission + ID de
// document déterministe). Cet endpoint répare l'existant.
//
// Ce qu'il fait, pour chaque groupe de doublons
// ---------------------------------------------
//   1. Choisit le document à CONSERVER : le plus ancien qui possède un
//      calendarEventId (l'invitation que le client a effectivement dans son
//      agenda). Si aucun n'en a, le plus ancien tout court.
//   2. Pour chacun des autres :
//      a. supprime son événement Google Calendar, avec sendUpdates:'none' —
//         c'est le point critique : sans ça Google envoie au client autant
//         d'emails d'annulation que d'événements supprimés ;
//      b. passe le document en status:'cancelled' AVEC cancelHandledAt dans
//         la MÊME écriture. onBookingUpdated teste `if (after.cancelHandledAt)
//         return null;` (Functions/index.js:2752) : le trigger sort donc
//         immédiatement et n'envoie aucun email d'annulation, et ne retente
//         pas la suppression Calendar qu'on vient de faire nous-mêmes.
//      c. pose excludeFromQuota:true et duplicateOf:<id conservé>.
//
// Rien n'est supprimé : les documents restent en base, annulés et tracés.
//
// Quota coaching
// --------------
// booking-check-coaching-quota.js ne compte que les bookings status ===
// 'confirmed' et à venir : annuler les doublons libère donc le quota
// mécaniquement. excludeFromQuota:true est posé en ceinture et bretelles.
//
// SÉCURITÉ
// --------
//   - POST + admin uniquement.
//   - dryRun = true PAR DÉFAUT : aucune écriture Firestore, aucune suppression
//     Calendar tant que le body ne contient pas explicitement
//     { "dryRun": false }. Le rapport est identique dans les deux modes.
//
// Usage (console navigateur, connecté en admin sur team.alteore.com)
// ------------------------------------------------------------------
//   const token = await firebase.auth().currentUser.getIdToken();
//   const run = (body) => fetch('/api/admin-booking-dedupe', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
//     body: JSON.stringify(body)
//   }).then(r => r.json());
//
//   await run({ dryRun: true });                    // 1. inspection
//   await run({ dryRun: false });                   // 2. exécution
//
// Body (tout est optionnel)
//   dryRun   : false pour écrire réellement (défaut true)
//   since    : "YYYY-MM-DD" — borne basse sur booking.date (défaut : aujourd'hui
//              à Paris, donc les RDV à venir). Mettre une date passée pour
//              rattraper de l'historique.
//   until    : "YYYY-MM-DD" — borne haute optionnelle.
//   personId : ne traiter qu'un expert.
//   email    : ne traiter qu'un prospect.
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

// ─── Date du jour au fuseau métier ──────────────────────────────────────────
// Vercel tourne en UTC : on ancre sur Paris pour ne pas exclure à tort un RDV
// daté d'aujourd'hui aux abords de minuit (même logique que
// booking-check-coaching-quota.js).
function parisToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
}

function normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

// Millisecondes d'un createdAt Firestore (Timestamp, Date ou string ISO).
// Retourne null si illisible — le tri retombera alors sur l'id du document,
// ce qui reste déterministe.
function createdAtMs(v) {
  if (!v) return null;
  if (typeof v === 'object' && typeof v.toMillis === 'function') {
    try { return v.toMillis(); } catch (e) { return null; }
  }
  if (typeof v === 'object' && typeof v._seconds === 'number') return v._seconds * 1000;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return isNaN(t) ? null : t;
  }
  return null;
}

/* ─── Clé d'identité du prospect ───────────────────────────────────────────
   L'email d'abord. À défaut prénom + nom. Un booking sans aucune identité
   exploitable n'est jamais dédoublonné : sur un créneau ouvert (slotOpen),
   deux inconnus sont deux vraies réservations distinctes.               */
function prospectKey(b) {
  const p = b.prospect || {};
  const email = normEmail(p.email);
  if (email) return 'e:' + email;
  const name = ((p.prenom || '') + ' ' + (p.nom || '')).trim().toLowerCase();
  if (name) return 'n:' + name;
  return null;
}

// ─── OAuth Google Calendar ──────────────────────────────────────────────────
// Même résolution que api/calendar-followup-event.js : _config/oauth_calendar
// puis repli sur _config/oauth.
async function getOAuthConfig() {
  for (const id of ['oauth_calendar', 'oauth']) {
    try {
      const doc = await db.collection('_config').doc(id).get();
      if (doc.exists) {
        const data = doc.data() || {};
        if (data.client_id && data.client_secret) return data;
      }
    } catch (_) { /* continue */ }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable (client_id + client_secret requis)');
}

// Cache par invocation : un même expert porte souvent tous les doublons,
// inutile de reconstruire le client OAuth à chaque document.
const _authCache = {};

async function getAuthClientForPerson(personId, conf) {
  if (Object.prototype.hasOwnProperty.call(_authCache, personId)) return _authCache[personId];

  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) { _authCache[personId] = null; return null; }

  const data = tokenDoc.data() || {};
  if (!data.refreshToken && !data.accessToken) { _authCache[personId] = null; return null; }

  const client = new google.auth.OAuth2(
    conf.client_id,
    conf.client_secret,
    conf.redirect_uri || undefined
  );
  client.setCredentials({
    access_token: data.accessToken || null,
    refresh_token: data.refreshToken || null,
  });

  client.on('tokens', async function (t) {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) {
      try {
        await db.collection('calendar_tokens').doc(personId).update(u);
      } catch (e) {
        console.warn('[booking-dedupe] token refresh save failed:', e.message);
      }
    }
  });

  _authCache[personId] = client;
  return client;
}

/* Supprime un événement Calendar. sendUpdates:'none' est NON NÉGOCIABLE ici :
   avec 'all', Google notifierait le client d'autant d'annulations que de
   doublons supprimés — exactement le spam qu'on cherche à éviter.
   404 / 410 = l'événement n'existe déjà plus, c'est un succès.            */
async function deleteCalendarEvent(client, calendarId, eventId) {
  try {
    const cal = google.calendar({ version: 'v3', auth: client });
    await cal.events.delete({
      calendarId: calendarId,
      eventId: eventId,
      sendUpdates: 'none',
    });
    return { ok: true, deleted: true };
  } catch (e) {
    const code = (e && e.code) || (e && e.response && e.response.status) || null;
    if (code === 404 || code === 410) return { ok: true, deleted: false, note: 'event_already_gone' };
    return { ok: false, error: (e && e.message) || String(e) };
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return; // requireAdmin a déjà répondu 401/403

  const body = parseBody(req) || {};

  // dryRun par défaut TRUE : il faut explicitement { dryRun: false } pour écrire.
  const dryRun = !(body.dryRun === false);
  const since = /^\d{4}-\d{2}-\d{2}$/.test(body.since || '') ? body.since : parisToday();
  const until = /^\d{4}-\d{2}-\d{2}$/.test(body.until || '') ? body.until : null;
  const onlyPerson = (body.personId || '').toString().trim() || null;
  const onlyEmail = normEmail(body.email) || null;

  const report = {
    dryRun,
    filters: { since, until, personId: onlyPerson, email: onlyEmail },
    scanned: 0,
    considered: 0,
    groupsWithDuplicates: 0,
    duplicatesCancelled: 0,
    calendarEventsDeleted: 0,
    errors: [],
    groups: [],
  };

  try {
    /* ── 1. Chargement ────────────────────────────────────────────────────
       Requête sur le seul champ `date` (index automatique — pas de composite
       à créer). Le filtre sur `status` se fait en mémoire : le volume de
       bookings sur une fenêtre de dates est faible.                      */
    let q = db.collection('bookings').where('date', '>=', since);
    if (until) q = q.where('date', '<=', until);
    const snap = await q.get();
    report.scanned = snap.size;

    const groups = {};
    snap.forEach((doc) => {
      const b = doc.data() || {};
      if (b.status !== 'confirmed') return;      // annulés / terminés : hors sujet
      if (!b.personId || !b.date || !b.time) return;
      if (onlyPerson && b.personId !== onlyPerson) return;

      const pk = prospectKey(b);
      if (!pk) return;                            // prospect non identifiable
      if (onlyEmail && pk !== 'e:' + onlyEmail) return;

      const key = b.personId + '|' + b.date + '|' + b.time + '|' + pk;
      if (!groups[key]) groups[key] = [];
      groups[key].push({ id: doc.id, ref: doc.ref, data: b });
      report.considered++;
    });

    /* ── 2. Choix du document conservé ────────────────────────────────────
       Priorité au plus ancien QUI A un calendarEventId : c'est l'invitation
       réellement présente dans l'agenda du client et de l'expert. Garder un
       document sans event laisserait le RDV sans invitation. Si aucun n'a
       d'event, on garde le plus ancien tout court.
       Tri déterministe : createdAt, puis id (un createdAt illisible ou
       manquant part en fin de liste plutôt que de casser le tri).       */
    function sortForKeep(list) {
      return list.slice().sort((a, b) => {
        const ta = createdAtMs(a.data.createdAt);
        const tb = createdAtMs(b.data.createdAt);
        if (ta !== null && tb !== null && ta !== tb) return ta - tb;
        if (ta === null && tb !== null) return 1;
        if (tb === null && ta !== null) return -1;
        return a.id.localeCompare(b.id);
      });
    }

    let conf = null; // config OAuth chargée à la demande

    const keys = Object.keys(groups);
    for (const key of keys) {
      const list = groups[key];
      if (list.length < 2) continue;

      report.groupsWithDuplicates++;

      const sorted = sortForKeep(list);
      const withEvent = sorted.filter((x) => !!x.data.calendarEventId);
      const keeper = withEvent.length ? withEvent[0] : sorted[0];
      const dupes = sorted.filter((x) => x.id !== keeper.id);

      const parts = key.split('|');
      const g = {
        personId: parts[0],
        personName: keeper.data.personName || null,
        date: parts[1],
        time: parts[2],
        prospect: parts[3],
        typeLabel: keeper.data.typeLabel || null,
        total: list.length,
        keptId: keeper.id,
        keptHasCalendarEvent: !!keeper.data.calendarEventId,
        cancelled: [],
      };

      for (const d of dupes) {
        const entry = {
          id: d.id,
          createdAt: d.data.createdAt ? new Date(createdAtMs(d.data.createdAt) || 0).toISOString() : null,
          calendarEventId: d.data.calendarEventId || null,
          calendarId: d.data.calendarIdUsed || (d.data.calendarEventId ? 'primary' : null),
          meetLink: d.data.meetLink || null,
          calendarDeleted: null,
          firestoreUpdated: false,
        };

        if (dryRun) {
          entry.calendarDeleted = 'dry-run';
          g.cancelled.push(entry);
          report.duplicatesCancelled++;
          continue;
        }

        // ── 2a. Événement Google Calendar ──────────────────────────────────
        // Avant Firestore : une fois cancelHandledAt posé, plus personne ne
        // repassera supprimer l'événement.
        if (d.data.calendarEventId && d.data.personId) {
          try {
            if (!conf) conf = await getOAuthConfig();
            const client = await getAuthClientForPerson(d.data.personId, conf);
            if (!client) {
              entry.calendarDeleted = 'no_calendar_token';
              report.errors.push({ bookingId: d.id, step: 'calendar', error: 'no_calendar_token' });
            } else {
              const r = await deleteCalendarEvent(
                client,
                d.data.calendarIdUsed || 'primary',
                d.data.calendarEventId
              );
              if (r.ok) {
                entry.calendarDeleted = r.deleted ? true : (r.note || true);
                if (r.deleted) report.calendarEventsDeleted++;
              } else {
                entry.calendarDeleted = false;
                report.errors.push({ bookingId: d.id, step: 'calendar', error: r.error });
              }
            }
          } catch (e) {
            entry.calendarDeleted = false;
            report.errors.push({ bookingId: d.id, step: 'calendar', error: e.message });
          }
        } else {
          entry.calendarDeleted = 'no_event';
        }

        /* ── 2b. Firestore ────────────────────────────────────────────────
           cancelHandledAt DOIT partir dans la même écriture que
           status:'cancelled'. onBookingUpdated lit `after` : il verra le
           marqueur en même temps que le passage en annulé et sortira sans
           envoyer d'email d'annulation au client ni retoucher au Calendar.  */
        try {
          const now = admin.firestore.FieldValue.serverTimestamp();
          await d.ref.update({
            status: 'cancelled',
            cancelHandledAt: now,
            cancelHandledBy: 'admin-booking-dedupe',
            cancelledAt: now,
            cancelledBy: auth.uid,
            cancelledByName: auth.email || null,
            statusUpdatedAt: now,
            statusUpdatedBy: auth.uid,
            statusUpdatedByName: auth.email || null,
            excludeFromQuota: true,
            duplicateOf: keeper.id,
            dedupedAt: now,
            dedupedBy: auth.uid,
          });
          entry.firestoreUpdated = true;
          report.duplicatesCancelled++;
        } catch (e) {
          report.errors.push({ bookingId: d.id, step: 'firestore', error: e.message });
        }

        g.cancelled.push(entry);
      }

      report.groups.push(g);
    }

    // Écriture terminée avant res.end() — Vercel tue la fonction dès la
    // réponse envoyée, aucune écriture asynchrone ne doit rester en vol.
    res.status(200).json({ ok: true, report });
  } catch (e) {
    console.error('[admin-booking-dedupe] unexpected error:', e);
    res.status(500).json({ ok: false, error: e.message, report });
  }
};
