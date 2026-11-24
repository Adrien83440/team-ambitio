// ============================================================================
// api/calendar-followup-event.js
// ----------------------------------------------------------------------------
// Crée ou supprime un événement Google Calendar "Stratégie" dans l'agenda de
// la personne QUI PROGRAMME le follow-up depuis Leads Live.
//
// Fix 24/11/2026 (retour de Claire, closeuse) : avant, l'événement partait
// dans l'agenda du membre ASSIGNÉ au lead (lead.assignedTo), et dans le
// calendrier "primary" de son compte Google. Résultat : les rappels de
// Claire tombaient dans l'agenda d'Anthony (lead attribué à Anthony, et
// fiche de Claire branchée sur une boîte partagée) et y bloquaient des
// créneaux réservables. Désormais :
//   - la cible est l'auteur du rappel (auth.uid → booking_config.firebaseUid),
//     jamais le membre assigné ;
//   - le calendrier est celui que Booking utilise pour créer SES RDV
//     (calendarList[].createEvents, même règle que getEventCalendarId de
//     Functions/index.js), "primary" seulement à défaut.
//
// Actions :
//   POST { action: 'create', leadId, fuId, fuDateTime,
//          duration, note, leadName, leadPhone, leadEmail }
//     → crée l'event, écrit calendarEventId + calendarEventLink
//       + calendarPersonId + calendarId dans le FU
//     → retourne { ok, eventId, eventLink, memberName, personId, calendarId }
//
//   POST { action: 'delete', eventId, personId?, calendarId?, assignedToSlug? }
//     → supprime l'event Google. 404/410 sont traités comme succès (event
//       déjà disparu). Le frontend a déjà retiré le FU du lead avant
//       d'appeler ça, donc on ne touche pas Firestore ici.
//       calendarId absent (FU créé avant le 24/11/2026) → "primary".
//     → retourne { ok: true }
//
// Résolution du personId cible (create) :
//   1. Query booking_config where firebaseUid == auth.uid
//   2. Préfère la fiche dont l'agenda Google est connecté (calendar_tokens)
//   3. Lit calendar_tokens/{personId} pour l'OAuth client
//
// Côté frontend :
//   const token = await firebase.auth().currentUser.getIdToken();
//   await fetch('/api/calendar-followup-event', {
//     method: 'POST',
//     headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
//     body: JSON.stringify({ action: 'create', ... })
//   });
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

// ─── OAuth config ────────────────────────────────────────────────────────────
// Récupère client_id + client_secret depuis _config. Essaie les 2 docs que
// le projet utilise (oauth pour Gmail, oauth_calendar pour Calendar).
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
  throw new Error('_config/oauth_calendar ou _config/oauth introuvable (client_id + client_secret requis)');
}

async function getAuthClientForPerson(personId) {
  const conf = await getOAuthConfig();
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) return null;
  const data = tokenDoc.data() || {};
  if (!data.refreshToken && !data.accessToken) return null;

  const client = new google.auth.OAuth2(
    conf.client_id,
    conf.client_secret,
    conf.redirect_uri || undefined
  );
  client.setCredentials({
    access_token: data.accessToken || null,
    refresh_token: data.refreshToken || null,
  });

  // Persiste le token refresh quand googleapis le renouvelle
  client.on('tokens', async function (t) {
    const u = {};
    if (t.access_token) u.accessToken = t.access_token;
    if (t.expiry_date) u.expiresAt = new Date(t.expiry_date);
    if (t.refresh_token) u.refreshToken = t.refresh_token;
    if (Object.keys(u).length) {
      try {
        await db.collection('calendar_tokens').doc(personId).update(u);
      } catch (e) {
        console.warn('[calendar-followup-event] token refresh save failed:', e.message);
      }
    }
  });

  return client;
}

// ─── Résolution slug team_members → personId booking_config ─────────────────
async function resolvePersonIdFromSlug(assignedToSlug) {
  if (!assignedToSlug) {
    return { error: 'no_assignedTo', message: 'Lead sans closer assigné.' };
  }

  const tmDoc = await db.collection('_meta').doc('team_members').get();
  if (!tmDoc.exists) {
    return { error: 'team_members_missing', message: '_meta/team_members absent.' };
  }

  const raw = (tmDoc.data() || {}).members;
  let member = null;
  if (Array.isArray(raw)) {
    member = raw.find(function (m) { return m && m.slug === assignedToSlug; }) || null;
  } else if (raw && typeof raw === 'object') {
    member = raw[assignedToSlug] || null;
    if (!member) {
      member = Object.values(raw).find(function (m) { return m && m.slug === assignedToSlug; }) || null;
    }
  }

  if (!member) {
    return { error: 'member_not_found', message: 'Closer inconnu dans team_members.' };
  }

  const memberName = member.displayName || member.shortName || assignedToSlug;
  const uid = member.firebaseUid;
  if (!uid) {
    return {
      error: 'no_firebase_uid',
      memberName: memberName,
      message: 'Closer sans compte Firebase lié (firebaseUid absent de team_members).'
    };
  }

  const bcSnap = await db.collection('booking_config')
    .where('firebaseUid', '==', uid)
    .limit(1)
    .get();

  if (bcSnap.empty) {
    return {
      error: 'no_booking_config',
      memberName: memberName,
      message: "Closer sans fiche booking_config — le calendrier Google n'est pas configuré."
    };
  }

  return {
    personId: bcSnap.docs[0].id,
    memberName: memberName
  };
}

// ─── Fiche Booking de l'auteur du rappel (auth.uid) ─────────────────────────
// Un compte peut avoir plusieurs fiches booking_config (ex. fiche « 🎯 Coach »
// d'une double casquette) : on prend la première dont l'agenda Google est
// connecté, sinon la première tout court (l'erreur "calendar_not_connected"
// sera alors explicite).
async function resolvePersonIdFromUid(uid) {
  if (!uid) {
    return { error: 'no_booking_config', message: 'Utilisateur non identifié.' };
  }
  const bcSnap = await db.collection('booking_config')
    .where('firebaseUid', '==', uid)
    .limit(5)
    .get();
  if (bcSnap.empty) {
    return {
      error: 'no_booking_config',
      message: "Pas de fiche Booking reliée à ton compte — ton agenda Google n'est pas configuré."
    };
  }
  let chosen = bcSnap.docs[0];
  for (let i = 0; i < bcSnap.docs.length; i++) {
    const tok = await db.collection('calendar_tokens').doc(bcSnap.docs[i].id).get();
    if (tok.exists && ((tok.data() || {}).refreshToken || (tok.data() || {}).accessToken)) {
      chosen = bcSnap.docs[i];
      break;
    }
  }
  const data = chosen.data() || {};
  return {
    personId: chosen.id,
    memberName: data.name || data.displayName || 'toi',
    calendarId: eventCalendarIdOf(data)
  };
}

// Calendrier cible des événements de cet expert : même règle que
// getEventCalendarId() de Functions/index.js (picker Booking « Calendrier
// pour créer les événements »), "primary" à défaut.
function eventCalendarIdOf(bookingConfigData) {
  const list = (bookingConfigData && bookingConfigData.calendarList) || [];
  const target = list.find(function (c) { return c && c.createEvents === true && c.id; });
  return target ? target.id : 'primary';
}

// ─── Helpers date ────────────────────────────────────────────────────────────
function pad2(n) { return String(n).padStart(2, '0'); }

// Ajoute X minutes à une date au format "YYYY-MM-DDTHH:mm:ss" (heure locale,
// sans TZ suffix). On travaille en Date locale pour éviter les pièges UTC,
// puis on reconstruit le même format.
function addMinutesToLocalIso(dateTimeStr, minutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(dateTimeStr || '');
  if (!m) return null;
  const d = new Date(
    parseInt(m[1], 10),
    parseInt(m[2], 10) - 1,
    parseInt(m[3], 10),
    parseInt(m[4], 10),
    parseInt(m[5], 10),
    parseInt(m[6] || '0', 10)
  );
  d.setMinutes(d.getMinutes() + minutes);
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
       + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

// Normalise "YYYY-MM-DDTHH:mm" → "YYYY-MM-DDTHH:mm:00" (certains frontends
// n'envoient pas les secondes).
function normalizeStartIso(s) {
  if (!s) return null;
  const re = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::(\d{2}))?$/;
  const m = re.exec(s);
  if (!m) return null;
  return m[1] + ':' + (m[2] || '00');
}

// ─── Handler ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // CORS (cohérent avec les autres endpoints du projet)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'forbidden', message: 'Rôle sales ou admin requis.' });
    return;
  }

  const body = parseBody(req);
  const action = body.action;

  try {
    // ─── CREATE ────────────────────────────────────────────────────────────
    if (action === 'create') {
      const leadId = body.leadId;
      const fuId = body.fuId;
      const fuDateTime = normalizeStartIso(body.fuDateTime);
      const durationMin = Math.max(5, Math.min(240, parseInt(body.duration, 10) || 30));
      const note = (body.note || '').toString();
      const leadName = (body.leadName || 'Lead sans nom').toString();
      const leadPhone = (body.leadPhone || '').toString();
      const leadEmail = (body.leadEmail || '').toString();

      if (!leadId || !fuId || !fuDateTime) {
        res.status(400).json({
          error: 'missing_fields',
          message: 'leadId, fuId et fuDateTime sont requis.'
        });
        return;
      }

      // Agenda de l'AUTEUR du rappel, jamais du membre assigné au lead.
      const resolved = await resolvePersonIdFromUid(auth.uid);
      if (resolved.error) {
        res.status(404).json({
          error: resolved.error,
          message: resolved.message
        });
        return;
      }

      const client = await getAuthClientForPerson(resolved.personId);
      if (!client) {
        res.status(404).json({
          error: 'calendar_not_connected',
          message: 'Calendrier Google non connecté pour ' + resolved.memberName + '.',
          memberName: resolved.memberName
        });
        return;
      }

      const endDateTime = addMinutesToLocalIso(fuDateTime, durationMin);
      if (!endDateTime) {
        res.status(400).json({
          error: 'invalid_datetime',
          message: 'Format fuDateTime attendu : YYYY-MM-DDTHH:mm:ss'
        });
        return;
      }

      const summary = 'Stratégie — ' + leadName;
      const descLines = [];
      if (leadPhone) descLines.push('📞 ' + leadPhone);
      if (leadEmail) descLines.push('✉️ ' + leadEmail);
      if (note) descLines.push('', '📝 ' + note);
      descLines.push('', '🔗 https://team.alteore.com/sales-leads.html?lead=' + encodeURIComponent(leadId));
      descLines.push('', '— Follow-up créé depuis Ambitio Leads Live');
      const description = descLines.join('\n');

      const calendar = google.calendar({ version: 'v3', auth: client });
      const resp = await calendar.events.insert({
        calendarId: resolved.calendarId,
        sendUpdates: 'none',
        requestBody: {
          summary: summary,
          description: description,
          start: { dateTime: fuDateTime, timeZone: 'Europe/Paris' },
          end: { dateTime: endDateTime, timeZone: 'Europe/Paris' },
          reminders: { useDefault: true }
        }
      });

      const eventId = resp.data.id;
      const eventLink = resp.data.htmlLink || '';

      // Update le FU dans le lead avec calendarEventId + calendarEventLink
      // + calendarPersonId (utile pour la suppression future).
      try {
        const leadRef = db.collection('leads').doc(leadId);
        await db.runTransaction(async function (tx) {
          const snap = await tx.get(leadRef);
          if (!snap.exists) return;
          const fus = (snap.data().followUps || []).slice();
          let changed = false;
          for (let i = 0; i < fus.length; i++) {
            if (fus[i] && fus[i].id === fuId) {
              fus[i].calendarEventId = eventId;
              fus[i].calendarEventLink = eventLink;
              fus[i].calendarPersonId = resolved.personId;
              fus[i].calendarId = resolved.calendarId;
              changed = true;
              break;
            }
          }
          if (changed) {
            tx.update(leadRef, {
              followUps: fus,
              updatedAt: admin.firestore.FieldValue.serverTimestamp()
            });
          }
        });
      } catch (e) {
        // Non-bloquant — l'event a été créé, on log juste l'erreur de sync
        console.warn('[calendar-followup-event] lead update non-blocking error:', e.message);
      }

      res.status(200).json({
        ok: true,
        eventId: eventId,
        eventLink: eventLink,
        memberName: resolved.memberName,
        personId: resolved.personId,
        calendarId: resolved.calendarId
      });
      return;
    }

    // ─── DELETE ────────────────────────────────────────────────────────────
    if (action === 'delete') {
      const eventId = body.eventId;
      if (!eventId) {
        res.status(400).json({ error: 'missing_fields', message: 'eventId requis.' });
        return;
      }

      // Le frontend nous passe de préférence le personId (et, depuis le
      // 24/11/2026, le calendarId) stockés dans le FU au moment de la
      // création. Fallback sur la résolution via slug si cette info manque
      // (cas d'un FU ancien créé avant cette feature).
      let targetPersonId = (body.personId || '').toString();
      if (!targetPersonId && body.assignedToSlug) {
        const resolved = await resolvePersonIdFromSlug(body.assignedToSlug);
        if (!resolved.error) targetPersonId = resolved.personId;
      }
      if (!targetPersonId) {
        res.status(404).json({
          error: 'person_not_resolved',
          message: 'Impossible de déterminer le calendrier cible.'
        });
        return;
      }

      const client = await getAuthClientForPerson(targetPersonId);
      if (!client) {
        res.status(404).json({
          error: 'calendar_not_connected',
          message: 'Calendrier Google non connecté.'
        });
        return;
      }

      const calendar = google.calendar({ version: 'v3', auth: client });
      try {
        await calendar.events.delete({
          calendarId: (body.calendarId || '').toString() || 'primary',
          eventId: eventId,
          sendUpdates: 'none'
        });
      } catch (e) {
        // 404/410 = event déjà supprimé côté Google → succès silencieux
        const status =
          (e && e.code) ||
          (e && e.response && e.response.status) ||
          0;
        if (status !== 404 && status !== 410) {
          throw e;
        }
      }

      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({
      error: 'invalid_action',
      message: 'action doit être "create" ou "delete".'
    });
  } catch (err) {
    console.error('[calendar-followup-event] error:', err && err.stack ? err.stack : err);
    const status = (err && err.code && typeof err.code === 'number') ? err.code : 500;
    res.status(status >= 400 && status < 600 ? status : 500).json({
      error: 'internal_error',
      message: (err && err.message) || 'Erreur serveur.'
    });
  }
};
