// ============================================================================
// api/booking-transfer.js
// ----------------------------------------------------------------------------
// Transfert des RDV à venir d'un expert vers un autre + désactivation
// complète d'un expert (départ d'un coach : Mickael → Thomas, 07/2026).
//
// URL  : POST /api/booking-transfer
// Auth : Bearer Firebase ID token — rôle ADMIN uniquement (requireAdmin).
//
// ─── ACTION 'transfer' ────────────────────────────────────────────────
// Body : { action:'transfer', bookingIds:[...], targetPersonId }
// Pour chaque RDV (dans l'ordre) :
//   1. Validations : existe, status confirmed|pending, personId ≠ cible,
//      créneau non passé (marge 30 min).
//   2. CRÉE un nouveau doc bookings chez la cible (whitelist de champs
//      métier). L'écriture Admin SDK déclenche la Cloud Function prod
//      onBookingCreated → événement Google Calendar + Meet + invitation
//      client sur l'agenda du NOUVEAU coach, automatiquement.
//   3. ANNULE l'ancien : status 'cancelled' + cancelledReason
//      'coach_transfer' + transferredTo/At/By (jamais compté comme vraie
//      annulation ; les RDV coaching sont de toute façon hors funnel).
//   4. SUPPRIME l'ancien événement Google sur l'agenda de l'ancien coach
//      (calendar_tokens/{oldPersonId}) avec sendUpdates:'all' → le client
//      reçoit l'annulation Google de l'ancien créneau + l'invitation du
//      nouveau (décision Adrien 2a). 404/410 = déjà disparu = succès.
//
// ─── ACTION 'deactivate' ──────────────────────────────────────────────
// Body : { action:'deactivate', personId }
//   0. REFUSE (409) s'il reste des RDV confirmed à venir pour cet expert
//      → transférer d'abord.
//   1. Archive le membre dans _meta/team_members (active:false — pattern
//      Guillaume), matché par firebaseUid puis slug. Warning si absent.
//   2. Supprime booking_config/{pid}, calendar_tokens/{pid},
//      calendar_busy/{pid}, calendar_sync_requests/{pid}.
//   Les RDV passés conservent leur personId (historique intact).
//   Reste à faire à la main : désactiver le compte dans Firebase Auth
//   (console → Authentication → ⋮ sur l'utilisateur → Désactiver).
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

// Champs métier copiés sur le nouveau booking. Tout le reste (event Google,
// Meet, flags de rappels, stamps de statut…) est volontairement laissé de
// côté pour que le nouveau RDV se comporte comme une résa neuve.
const COPY_FIELDS = [
  'type', 'typeLabel', 'date', 'time', 'duration', 'timezone',
  'prospect', 'formData', 'formAnswers', 'leadId', 'formId', 'source',
  'clientId', 'clientNom', 'skipLeadCreation', 'isCoaching', 'notes',
  'ownerSlug', 'assignedToUid',
];

// ─── OAuth Google (même pattern que calendar-followup-event.js) ─────────
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

// Supprime l'événement Google de l'ancien RDV. Non bloquant :
// retourne { deleted, warning? }.
async function deleteOldEvent(oldBooking) {
  const eventId = oldBooking.calendarEventId;
  if (!eventId) return { deleted: false, warning: 'pas de calendarEventId' };
  try {
    const client = await getAuthClientForPerson(oldBooking.personId);
    if (!client) return { deleted: false, warning: 'tokens Google absents pour ' + oldBooking.personId };
    const calendar = google.calendar({ version: 'v3', auth: client });
    await calendar.events.delete({
      calendarId: oldBooking.calendarIdUsed || 'primary',
      eventId,
      sendUpdates: 'all', // le client reçoit l'annulation Google de l'ancien créneau
    });
    return { deleted: true };
  } catch (e) {
    const code = e && (e.code || (e.response && e.response.status));
    if (code === 404 || code === 410) return { deleted: true }; // déjà disparu
    console.warn('[booking-transfer] delete event', oldBooking.personId, eventId, e.message);
    return { deleted: false, warning: 'suppression event Google : ' + e.message };
  }
}

function futureEnough(b) {
  // Créneau non passé, marge 30 min (transferts de dernière minute tolérés).
  try {
    const ts = new Date(b.date + 'T' + (b.time || '00:00') + ':00').getTime();
    return ts > Date.now() - 30 * 60000;
  } catch (_) { return false; }
}

// ─── Transfert ────────────────────────────────────────────────────────
async function doTransfer(auth, body, res) {
  const bookingIds = Array.isArray(body.bookingIds) ? body.bookingIds.filter(Boolean).slice(0, 200) : [];
  const targetPersonId = String(body.targetPersonId || '').trim();
  if (!bookingIds.length || !targetPersonId) {
    res.status(400).json({ error: 'bookingIds et targetPersonId requis' });
    return;
  }

  // Cible : doit exister et avoir son Google connecté (sinon onBookingCreated
  // ne créera ni event ni Meet → RDV fantômes).
  const targetDoc = await db.collection('booking_config').doc(targetPersonId).get();
  if (!targetDoc.exists || targetDoc.data().__type !== 'person') {
    res.status(400).json({ error: 'Expert cible introuvable' });
    return;
  }
  const target = targetDoc.data();
  const targetTokens = await db.collection('calendar_tokens').doc(targetPersonId).get();
  if (!targetTokens.exists) {
    res.status(400).json({ error: 'L\'expert cible n\'a pas connecté son Google Calendar — connexion requise avant transfert' });
    return;
  }

  const byName = (auth.userData && (auth.userData.displayName || auth.userData.name)) || (auth.email || '').split('@')[0] || null;
  const now = admin.firestore.FieldValue.serverTimestamp();
  const results = [];

  for (const oldId of bookingIds) {
    const item = { oldId, ok: false };
    try {
      const oldSnap = await db.collection('bookings').doc(oldId).get();
      if (!oldSnap.exists) { item.error = 'introuvable'; results.push(item); continue; }
      const old = oldSnap.data();

      if (old.status !== 'confirmed' && old.status !== 'pending') { item.error = 'statut ' + old.status; results.push(item); continue; }
      if (old.personId === targetPersonId) { item.error = 'déjà chez la cible'; results.push(item); continue; }
      if (old.transferredTo) { item.error = 'déjà transféré'; results.push(item); continue; }
      if (!futureEnough(old)) { item.error = 'créneau passé'; results.push(item); continue; }

      // 1. Nouveau booking chez la cible → déclenche onBookingCreated (prod)
      const fresh = {};
      COPY_FIELDS.forEach((f) => { if (old[f] !== undefined) fresh[f] = old[f]; });
      fresh.personId = targetPersonId;
      fresh.personName = target.name || targetPersonId;
      fresh.status = 'confirmed';
      fresh.slotOpen = false;
      fresh.createdAt = now;
      fresh.transferredFrom = oldId;
      fresh.transferredFromPersonId = old.personId || null;
      fresh.transferredAt = now;
      fresh.transferredBy = auth.uid;
      const newRef = await db.collection('bookings').add(fresh);
      item.newId = newRef.id;

      // 2. Annulation traçée de l'ancien
      await oldSnap.ref.update({
        status: 'cancelled',
        cancelledReason: 'coach_transfer',
        cancelledAt: now,
        cancelledBy: auth.uid,
        cancelledByName: byName,
        statusUpdatedAt: now,
        statusUpdatedBy: auth.uid,
        statusUpdatedByName: byName,
        transferredTo: newRef.id,
        transferredToPersonId: targetPersonId,
        transferredAt: now,
        transferredBy: auth.uid,
      });

      // 3. Nettoyage de l'événement Google chez l'ancien coach
      const ev = await deleteOldEvent(old);
      item.eventDeleted = ev.deleted;
      if (ev.warning) item.warning = ev.warning;

      item.ok = true;
    } catch (e) {
      console.error('[booking-transfer] transfer', oldId, e.message);
      item.error = e.message;
    }
    results.push(item);
  }

  const okCount = results.filter((r) => r.ok).length;
  console.log('[booking-transfer] transfer →', targetPersonId, ':', okCount, '/', results.length);
  res.status(200).json({ ok: true, targetPersonId, transferred: okCount, total: results.length, results });
}

// ─── Désactivation complète ──────────────────────────────────────────
async function doDeactivate(auth, body, res) {
  const personId = String(body.personId || '').trim();
  if (!personId || personId.charAt(0) === '_') {
    res.status(400).json({ error: 'personId invalide' });
    return;
  }

  const personDoc = await db.collection('booking_config').doc(personId).get();
  if (!personDoc.exists || personDoc.data().__type !== 'person') {
    res.status(400).json({ error: 'Expert introuvable' });
    return;
  }
  const person = personDoc.data();

  // 0. Garde-fou : refus s'il reste des RDV confirmés à venir.
  //    (equality-only → aucun index composite requis, filtre date côté code)
  const confirmedSnap = await db.collection('bookings')
    .where('personId', '==', personId)
    .where('status', '==', 'confirmed')
    .get();
  const remaining = [];
  confirmedSnap.forEach((d) => { const b = d.data(); if (futureEnough(b)) remaining.push({ id: d.id, date: b.date, time: b.time }); });
  if (remaining.length) {
    res.status(409).json({ error: 'remaining_bookings', remaining: remaining.length, sample: remaining.slice(0, 5) });
    return;
  }

  const report = { archivedTeamMember: false, deleted: [], warnings: [] };

  // 1. Archivage _meta/team_members (active:false — pattern Guillaume).
  //    Le champ members peut être un OBJET (slug→membre) ou un ARRAY.
  try {
    const tmRef = db.collection('_meta').doc('team_members');
    const tmSnap = await tmRef.get();
    if (tmSnap.exists) {
      const data = tmSnap.data() || {};
      const members = data.members;
      let touched = false;
      const match = (m) => m && typeof m === 'object' &&
        ((person.firebaseUid && m.firebaseUid === person.firebaseUid) || m.slug === personId);
      if (Array.isArray(members)) {
        members.forEach((m) => { if (match(m)) { m.active = false; m.archivedAt = new Date().toISOString(); touched = true; } });
      } else if (members && typeof members === 'object') {
        Object.keys(members).forEach((k) => { const m = members[k]; if (match(m)) { m.active = false; m.archivedAt = new Date().toISOString(); touched = true; } });
      }
      if (touched) {
        await tmRef.update({ members });
        report.archivedTeamMember = true;
      } else {
        report.warnings.push('membre équipe introuvable (à archiver à la main dans _meta/team_members)');
      }
    }
  } catch (e) {
    report.warnings.push('archivage équipe : ' + e.message);
  }

  // 2. Suppression fiche expert + artefacts calendrier (delete inexistant = no-op)
  const toDelete = [
    ['booking_config', personId],
    ['calendar_tokens', personId],
    ['calendar_busy', personId],
    ['calendar_sync_requests', personId],
  ];
  for (const [col, id] of toDelete) {
    try {
      await db.collection(col).doc(id).delete();
      report.deleted.push(col + '/' + id);
    } catch (e) {
      report.warnings.push(col + '/' + id + ' : ' + e.message);
    }
  }

  console.log('[booking-transfer] deactivate', personId, 'by', auth.uid, report);
  res.status(200).json({ ok: true, personId, name: person.name || personId, ...report });
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }
  const auth = await requireAdmin(req, res);
  if (!auth) return; // 401/403 déjà répondu

  const body = parseBody(req) || {};
  const action = String(body.action || '').trim();

  try {
    if (action === 'transfer') { await doTransfer(auth, body, res); return; }
    if (action === 'deactivate') { await doDeactivate(auth, body, res); return; }
    res.status(400).json({ error: 'action invalide (transfer | deactivate)' });
  } catch (e) {
    console.error('[booking-transfer]', action, e.message);
    res.status(500).json({ error: e.message });
  }
};
