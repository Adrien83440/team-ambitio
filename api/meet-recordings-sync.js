// ============================================================================
// api/meet-recordings-sync.js
// ----------------------------------------------------------------------------
// Import AUTOMATIQUE des enregistrements Google Meet dans les RDV (bookings)
// et dans les fiches prospects (leads) — demande Vincent, meeting 01/07.
//
// URL  : GET/POST /api/meet-recordings-sync
// Auth : • Authorization: Bearer <CRON_SECRET>  (envoyé par Vercel Cron)
//        • x-api-key: <CRON_SECRET>             (test manuel via curl)
// Cron : tous les jours à 04:00 UTC (06:00 Paris été) — voir vercel.json.
//
// ─── COMMENT ÇA MARCHE ────────────────────────────────────────────────────
// Quand un expert enregistre un Google Meet (Workspace), Google dépose le
// fichier dans son Drive ET l'attache automatiquement à l'ÉVÉNEMENT Calendar
// (event.attachments[]). Or chaque RDV créé par onBookingCreated stocke
// calendarEventId + calendarIdUsed, et on a les tokens OAuth de chaque
// expert dans calendar_tokens/{personId}. Le scope calendar suffit pour lire
// les attachments (métadonnées de l'event) → on récupère le LIEN Drive de
// l'enregistrement sans scope Drive supplémentaire. V1 = lien cliquable ;
// (transcription Whisper = V2, nécessiterait drive.readonly pour télécharger).
//
// ─── CE QUE FAIT CHAQUE RUN ───────────────────────────────────────────────
// 1. Scanne les bookings des ?days derniers jours (défaut 7, cap 30) dont le
//    créneau est PASSÉ (fin + 60 min de marge), avec un calendarEventId,
//    sans meetRecordingUrl ni meetRecordingNone, status confirmed/completed.
// 2. Pour chacun : calendar.events.get (tokens de SON expert, calendarIdUsed)
//    → attachments[].
//    • Trouvé  → pose sur le booking : meetRecordingUrl (la vidéo),
//      meetRecordingTitle/Mime, meetAttachments[] (tout : vidéo + notes
//      Gemini + chat éventuels), meetRecordingFoundAt.
//      Si le RDV a un leadId → pousse dans la fiche prospect une entrée
//      communications[] (bulle "appel" source meet avec lien 🎧) + une
//      entrée timeline_history — même pipeline d'affichage que Ringover,
//      zéro modif front nécessaire. Marqueur meetPushedToLead (une seule fois).
//    • Rien encore → meetRecordingChecks++ (le recording apparaît quelques
//      minutes à quelques heures après le call). Au-delà de GRACE_DAYS jours
//      ou MAX_CHECKS tentatives → meetRecordingNone:true (on arrête, RDV non
//      enregistré). Event supprimé (404/410) → meetRecordingNone aussi.
//
// ─── PARAMÈTRES (query string) ────────────────────────────────────────────
//   days=<n>   fenêtre de scan en jours (défaut 7, cap 30)
//   dry=1      dry-run : liste ce qui serait fait, n'écrit RIEN
//
// ─── TEST MANUEL (terminal) ───────────────────────────────────────────────
//   curl -H "x-api-key: <CRON_SECRET>" \
//     "https://team.alteore.com/api/meet-recordings-sync?days=14&dry=1"
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');

const GRACE_DAYS  = 5;   // jours après le RDV avant d'abandonner la recherche
const MAX_CHECKS  = 8;   // tentatives max par RDV
const QUERY_LIMIT = 800; // garde-fou sur le scan
const PAST_MARGIN_MS = 60 * 60000; // le RDV doit être fini depuis ≥ 1 h

// ─── Dates ──────────────────────────────────────────────────────────────
function parisTodayIso() {
  // fr-CA → format YYYY-MM-DD directement
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoAddDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
// Fin du créneau en ms. Interprété en UTC côté Vercel → ~2 h de marge
// supplémentaire vs Paris, ce qui est exactement ce qu'on veut (jamais
// pendant le meet).
function bookingEndMs(b) {
  try {
    const t = b.time || '23:59';
    const d = new Date(b.date + 'T' + t + ':00Z');
    if (isNaN(d.getTime())) return 0;
    return d.getTime() + (Number(b.duration) || 30) * 60000;
  } catch (_) { return 0; }
}

// ─── OAuth Google (même pattern que booking-transfer / calendar-followup) ─
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

async function getAuthClientForPerson(conf, personId) {
  const tokenDoc = await db.collection('calendar_tokens').doc(personId).get();
  if (!tokenDoc.exists) return null;
  const tokens = tokenDoc.data() || {};
  const client = new google.auth.OAuth2(conf.client_id, conf.client_secret, conf.redirect_uri || undefined);
  client.setCredentials(tokens);
  return client;
}

// ─── Push dans la fiche prospect ─────────────────────────────────────────
// Réutilise le pipeline d'affichage existant de sales-contact.html :
// communications[] type 'call' avec recordingUrl → bulle appel + lien
// "🎧 Écouter l'enregistrement", et timeline_history[] pour l'onglet
// Chronologie. `date` = ISO naïf local du créneau (YYYY-MM-DDTHH:MM:00) :
// la fiche le parse en heure locale → l'heure affichée = l'heure du RDV.
async function pushMeetToLead(booking, video) {
  const leadRef = db.collection('leads').doc(booking.leadId);
  const snap = await leadRef.get();
  if (!snap.exists) return { pushed: false, reason: 'lead_not_found' };
  const lead = snap.data() || {};
  if (lead._merged) return { pushed: false, reason: 'lead_merged' };

  const label = booking.typeLabel || booking.type || 'RDV';
  const whenIso = booking.date + 'T' + (booking.time || '09:00') + ':00';

  const commEntry = {
    type: 'call',
    direction: 'outbound',
    source: 'meet',
    content: '🎥 Enregistrement du RDV Google Meet — ' + label,
    date: whenIso,
    createdAt: admin.firestore.Timestamp.now(),
    recordingUrl: video.fileUrl || null,
    duration: Number(booking.duration) ? Number(booking.duration) * 60 : null, // secondes (durée du créneau)
    ownerName: booking.personName || null,
    note: null,
    transcription: null,
    callTags: null,
  };
  const timelineEntry = {
    text: '🎥 Enregistrement Meet disponible — ' + label + (booking.personName ? ' (' + booking.personName + ')' : ''),
    date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
    color: '#a78bfa',
  };

  // Pas de lastContactAt : l'enregistrement n'est pas un nouveau contact,
  // c'est un enrichissement a posteriori d'un RDV déjà tenu.
  await leadRef.update({
    communications: (lead.communications || []).concat([commEntry]),
    timeline_history: (lead.timeline_history || []).concat([timelineEntry]),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { pushed: true };
}

// ─── Handler ─────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  // 1. Auth : Bearer CRON_SECRET (Vercel Cron) ou x-api-key (test manuel)
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[meet-sync] CRON_SECRET env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerOk = authHeader === 'Bearer ' + secret;
  const apiKeyOk = (req.headers['x-api-key'] || req.headers['X-API-Key']) === secret;
  if (!bearerOk && !apiKeyOk) {
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  const q = req.query || {};
  const days = Math.min(Math.max(parseInt(q.days, 10) || 7, 1), 30);
  const dry = q.dry === '1' || q.dry === 'true';

  const todayIso = parisTodayIso();
  const startIso = isoAddDays(todayIso, -days);
  const nowMs = Date.now();

  const out = {
    ok: true, dry, window: { from: startIso, to: todayIso },
    scanned: 0, eligible: 0, found: 0, pushedToLead: 0,
    retries: 0, gaveUp: 0, noTokens: 0, errors: [],
    items: [],
  };

  try {
    // 2. Bookings de la fenêtre (range sur un seul champ → pas d'index composite)
    const snap = await db.collection('bookings')
      .where('date', '>=', startIso)
      .where('date', '<=', todayIso)
      .limit(QUERY_LIMIT)
      .get();
    out.scanned = snap.size;

    // 3. Filtres métier côté code
    const eligible = [];
    snap.forEach((doc) => {
      const b = doc.data() || {};
      const st = b.status || 'confirmed';
      if (st !== 'confirmed' && st !== 'completed') return; // annulé / no-show : rien à chercher
      if (!b.calendarEventId) return;                        // pas d'event Google
      if (b.meetRecordingUrl) return;                        // déjà importé
      if (b.meetRecordingNone) return;                       // recherche abandonnée
      if ((b.meetRecordingChecks || 0) >= MAX_CHECKS) return;
      if (bookingEndMs(b) + PAST_MARGIN_MS > nowMs) return;  // pas encore fini
      eligible.push({ id: doc.id, b });
    });
    out.eligible = eligible.length;

    if (!eligible.length) { res.status(200).json(out); return; }

    // 4. Clients OAuth par expert (cache)
    const conf = await getOAuthConfig();
    const clientCache = {}; // personId → OAuth2 client | null
    async function clientFor(pid) {
      if (!(pid in clientCache)) {
        try { clientCache[pid] = await getAuthClientForPerson(conf, pid); }
        catch (e) { clientCache[pid] = null; console.warn('[meet-sync] tokens', pid, e.message); }
      }
      return clientCache[pid];
    }

    // 5. Traitement séquentiel (volumes faibles ; évite le rate-limit Google)
    for (const item of eligible) {
      const b = item.b;
      const ref = db.collection('bookings').doc(item.id);
      try {
        const pid = b.personId;
        if (!pid) { out.errors.push({ id: item.id, error: 'no_personId' }); continue; }
        const client = await clientFor(pid);
        if (!client) { out.noTokens++; continue; } // pas de check consommé : le pb n'est pas le recording

        const calendar = google.calendar({ version: 'v3', auth: client });
        let ev;
        try {
          ev = await calendar.events.get({
            calendarId: b.calendarIdUsed || 'primary',
            eventId: b.calendarEventId,
          });
        } catch (e) {
          const code = e && (e.code || (e.response && e.response.status));
          if (code === 404 || code === 410) {
            // Event supprimé → il n'y aura jamais d'attachment
            out.gaveUp++;
            out.items.push({ id: item.id, action: 'gave_up_event_deleted' });
            if (!dry) await ref.set({ meetRecordingNone: true, meetRecordingCheckedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            continue;
          }
          throw e;
        }

        const atts = (ev.data && ev.data.attachments) || [];
        if (atts.length) {
          // La vidéo d'abord ; à défaut le premier attachment (lien Drive quand même)
          const video = atts.find((a) => /video/i.test(a.mimeType || '') || /\.(mp4|webm|mkv)$/i.test(a.title || '')) || atts[0];
          out.found++;
          out.items.push({ id: item.id, action: 'found', title: video.title || null, lead: b.leadId || null });
          if (!dry) {
            const patch = {
              meetRecordingUrl: video.fileUrl || null,
              meetRecordingTitle: video.title || null,
              meetRecordingMime: video.mimeType || null,
              meetAttachments: atts.map((a) => ({ title: a.title || null, fileUrl: a.fileUrl || null, mimeType: a.mimeType || null })),
              meetRecordingFoundAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            if (b.leadId && !b.meetPushedToLead) {
              try {
                const pr = await pushMeetToLead(b, video);
                if (pr.pushed) { patch.meetPushedToLead = true; out.pushedToLead++; }
                else patch.meetPushSkipped = pr.reason || 'unknown';
              } catch (pe) {
                console.warn('[meet-sync] push lead', b.leadId, pe.message);
                out.errors.push({ id: item.id, error: 'push_lead: ' + pe.message });
              }
            }
            await ref.set(patch, { merge: true });
          }
        } else {
          // Rien encore : on retente demain, ou on abandonne si trop vieux
          const ageDays = (nowMs - bookingEndMs(b)) / 86400000;
          const checks = (b.meetRecordingChecks || 0) + 1;
          if (ageDays > GRACE_DAYS || checks >= MAX_CHECKS) {
            out.gaveUp++;
            out.items.push({ id: item.id, action: 'gave_up_no_recording' });
            if (!dry) await ref.set({ meetRecordingNone: true, meetRecordingChecks: checks, meetRecordingCheckedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          } else {
            out.retries++;
            if (!dry) await ref.set({ meetRecordingChecks: checks, meetRecordingCheckedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
          }
        }
      } catch (e) {
        console.error('[meet-sync]', item.id, e.message);
        out.errors.push({ id: item.id, error: e.message });
      }
    }

    res.status(200).json(out);
  } catch (e) {
    console.error('[meet-sync] fatal', e);
    res.status(500).json({ error: e.message });
  }
};
