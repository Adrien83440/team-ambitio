// ============================================================================
// api/booking-delete.js
// ----------------------------------------------------------------------------
// Suppression définitive d'un RDV depuis booking-admin.html, avec nettoyage
// de l'événement Google Calendar et trace d'audit.
//
// URL  : POST /api/booking-delete
// Auth : Bearer Firebase ID token — rôle ADMIN uniquement (requireAdmin),
//        miroir exact de la condition `window._currentRole==='admin'` qui
//        affiche le bouton 🗑 dans booking-admin.html.
//
// Body : { bookingId: string, reason?: string }
//
// ─────────────────────────────────────────────────────────────────────────────
// POURQUOI CET ENDPOINT EXISTE
// ─────────────────────────────────────────────────────────────────────────────
// Le bouton « 🗑 Supprimer » faisait un `.delete()` direct sur le document
// depuis le navigateur. Deux conséquences :
//
//   1. L'ÉVÉNEMENT GOOGLE SURVIVAIT. onBookingUpdated ne retire l'événement
//      que sur la transition `status → 'cancelled'`. Or le bouton s'affiche
//      aussi sur les RDV `completed`, qui n'ont JAMAIS été annulés : leur
//      événement est encore vivant au moment de la suppression. Il n'existe
//      aucun trigger onDelete dans le projet, donc plus rien ne le retirait.
//      Résultat : événement fantôme dans l'agenda du coach, créneau bloqué
//      dans calendar_busy, invitation toujours valide côté client.
//
//      Le cas `cancelled` n'était pas sûr non plus : onBookingUpdated avale
//      l'erreur de suppression Google (catch + console.error) et rend la main
//      si les tokens du coach sont absents. Un RDV peut donc être `cancelled`
//      ET avoir gardé son événement.
//
//   2. AUCUNE TRACE. Contraire à la règle « rien n'est jamais supprimé sans
//      trace d'audit ». Le RDV disparaissait sans copie.
//
// Ce que fait cet endpoint, dans l'ordre :
//   1. Vérifie que le RDV existe et que son statut autorise la suppression
//      (cancelled | completed) — même règle que l'UI, appliquée côté serveur.
//   2. Retire l'événement Google (404/410 = déjà disparu = succès).
//   3. Demande un rafraîchissement de calendar_busy via le document
//      calendar_sync_requests/{personId}, sur lequel la Cloud Function
//      onCalendarSyncRequest se déclenche déjà (mécanisme existant, inchangé).
//   4. Archive le document COMPLET dans audit_log AVANT de le supprimer.
//   5. Supprime le document bookings.
//
// La suppression du document n'est JAMAIS bloquée par un échec Google : si
// l'événement résiste, on le signale dans la réponse et dans l'audit, et on
// supprime quand même. L'admin voit alors exactement ce qui reste à nettoyer
// à la main, au lieu de ne rien savoir comme aujourd'hui.
//
// Réponse 200 :
//   { ok:true, bookingId, calendar:{ deleted, warning? }, auditLogId,
//     seriesId?, warnings:[...] }
// Erreurs : 400 (bookingId absent) · 401/403 (auth) · 404 (RDV introuvable)
//           409 (statut non supprimable) · 405 · 500
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

// Statuts pour lesquels la suppression est autorisée. Miroir de la condition
// d'affichage du bouton dans booking-admin.html (renderRdvDetail) : un RDV
// confirmed ou pending doit être annulé d'abord — l'annulation déclenche
// onBookingUpdated qui prévient le client par email. Court-circuiter cette
// étape enverrait le client à un rendez-vous qui n'existe plus.
const DELETABLE_STATUS = ['cancelled', 'completed'];

// ─── OAuth Google — repris à l'identique de api/booking-transfer.js ────────
async function getOAuthConfig() {
  const tries = ['oauth_calendar', 'oauth'];
  for (const id of tries) {
    try {
      const doc = await db.collection('_config').doc(id).get();
      if (doc.exists) {
        const data = doc.data() || {};
        if (data.client_id && data.client_secret) return data;
      }
    } catch (_) { /* continue */ }
  }
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable');
}

async function getAuthClientForPerson(personId) {
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) return null;
  const tokens = tokenDoc.data() || {};
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials(tokens);
  return client;
}

// Retire l'événement Google du RDV supprimé. Non bloquant : renvoie toujours
// un objet, jamais d'exception. Même contrat que deleteOldEvent() dans
// api/booking-transfer.js, y compris le traitement 404/410.
//
// sendUpdates:'all' — cohérent avec onBookingUpdated et booking-transfer :
// le client reçoit l'annulation Google du créneau. Sur un RDV `cancelled` il
// a déjà reçu l'email d'annulation ; sur un RDV `completed` l'événement est
// passé, Google n'envoie rien pour un événement révolu.
async function deleteCalendarEvent(booking) {
  const eventId = booking.calendarEventId;
  if (!eventId) return { deleted: false, skipped: true, reason: 'aucun calendarEventId sur le RDV' };
  if (!booking.personId) return { deleted: false, warning: 'calendarEventId présent mais personId absent — événement non retiré' };

  try {
    const client = await getAuthClientForPerson(booking.personId);
    if (!client) {
      return { deleted: false, warning: 'tokens Google absents pour ' + booking.personId + ' — événement ' + eventId + ' à retirer à la main' };
    }
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({
      calendarId: booking.calendarIdUsed || 'primary',
      eventId,
      sendUpdates: 'all',
    });
    return { deleted: true };
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 404 || code === 410) return { deleted: true, alreadyGone: true };
    console.warn('[booking-delete] delete event', booking.personId, eventId, e.message);
    return { deleted: false, warning: 'suppression event Google : ' + e.message + ' (event ' + eventId + ')' };
  }
}

// Rafraîchit les créneaux occupés du coach. On écrit dans
// calendar_sync_requests/{personId}, seul mécanisme prévu pour ça :
// onCalendarSyncRequest (Cloud Function) est déclenchée sur onWrite et
// appelle fetchAndStoreBusy. Sans cet appel, le créneau resterait affiché
// occupé dans booking.html jusqu'au passage de scheduledCalendarSync
// (toutes les 30 minutes).
async function requestBusyRefresh(personId) {
  if (!personId) return { requested: false };
  try {
    await db.collection('calendar_sync_requests').doc(personId).set({
      requestedAt: admin.firestore.FieldValue.serverTimestamp(),
      requestedBy: 'booking-delete',
    }, { merge: true });
    return { requested: true };
  } catch (e) {
    console.warn('[booking-delete] busy refresh', personId, e.message);
    return { requested: false, warning: 'rafraîchissement des créneaux : ' + e.message };
  }
}

module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  try {
    const auth = await requireAdmin(req, res);
    if (!auth) return; // requireAdmin a déjà répondu 401/403

    const body = parseBody(req);
    const bookingId = String((body && body.bookingId) || '').trim();
    const reason = String((body && body.reason) || '').trim() || null;

    if (!bookingId) { res.status(400).json({ error: 'bookingId requis' }); return; }

    const ref = db.collection('bookings').doc(bookingId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'RDV introuvable', bookingId }); return; }

    const booking = snap.data() || {};
    const status = booking.status || '';

    if (DELETABLE_STATUS.indexOf(status) === -1) {
      res.status(409).json({
        error: 'statut_non_supprimable',
        message: 'Seuls les RDV annulés ou terminés peuvent être supprimés. '
               + 'Annulez le RDV d\'abord — le client sera prévenu et son événement Google retiré.',
        status,
      });
      return;
    }

    const warnings = [];

    /* ── 1. Événement Google ── */
    const calendar = await deleteCalendarEvent(booking);
    if (calendar.warning) warnings.push(calendar.warning);

    /* ── 2. Créneaux occupés du coach ── */
    let busy = { requested: false };
    if (calendar.deleted && booking.personId) {
      busy = await requestBusyRefresh(booking.personId);
      if (busy.warning) warnings.push(busy.warning);
    }

    /* ── 3. Trace d'audit AVANT suppression ──
       On archive le document entier : c'est la seule copie qui restera.
       Le champ `booking` est un snapshot brut, sans transformation, pour
       qu'une restauration manuelle soit possible telle quelle. */
    let auditLogId = null;
    try {
      const auditRef = await db.collection('audit_log').add({
        action: 'booking_delete',
        bookingId,
        booking,                       // snapshot complet du document supprimé
        status,
        seriesId: booking.seriesId || null,
        personId: booking.personId || null,
        personName: booking.personName || null,
        date: booking.date || null,
        time: booking.time || null,
        prospectEmail: (booking.prospect && booking.prospect.email) || null,
        calendarEventId: booking.calendarEventId || null,
        calendarEventDeleted: calendar.deleted === true,
        calendarWarning: calendar.warning || null,
        reason,
        deletedBy: auth.uid,
        deletedByEmail: auth.email || null,
        timestamp: admin.firestore.FieldValue.serverTimestamp(),
      });
      auditLogId = auditRef.id;
    } catch (e) {
      // Sans trace d'audit, on ne supprime pas : perdre le RDV ET la copie
      // serait pire que laisser le document en place.
      console.error('[booking-delete] audit_log échoué:', e.message);
      res.status(500).json({
        error: 'audit_log_failed',
        message: 'La trace d\'audit n\'a pas pu être écrite — suppression annulée. ' + e.message,
      });
      return;
    }

    /* ── 4. Suppression du document ── */
    await ref.delete();

    console.log('[booking-delete] ' + bookingId + ' supprimé par ' + auth.uid
      + ' — event Google: ' + (calendar.deleted ? 'retiré' : (calendar.skipped ? 'aucun' : 'ÉCHEC'))
      + ' — audit: ' + auditLogId);

    res.status(200).json({
      ok: true,
      bookingId,
      calendar,
      busyRefresh: busy.requested === true,
      auditLogId,
      seriesId: booking.seriesId || null,
      warnings,
    });
  } catch (e) {
    console.error('[booking-delete] error:', e && e.message, e && e.stack);
    res.status(500).json({ error: (e && e.message) || 'internal_error' });
  }
};
