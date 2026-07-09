// ============================================================================
// api/meet-recordings-sync.js — v2 (coaching : email client + fiche)
// ----------------------------------------------------------------------------
// Import AUTOMATIQUE des enregistrements Google Meet dans les RDV (bookings),
// les fiches prospects (leads) ET, pour les RDV COACHING : envoi d'un email
// au client avec son replay + le résumé de séance, et liaison du replay à la
// séance correspondante de sa fiche coaching (clients/{id}).
//
// URL  : GET/POST /api/meet-recordings-sync
// Auth : • Authorization: Bearer <CRON_SECRET>  (envoyé par Vercel Cron)
//        • x-api-key: <CRON_SECRET>             (test manuel via curl)
// Cron : tous les jours à 04:00 UTC (06:00 Paris été) — voir vercel.json.
//
// ─── RAPPEL DU MÉCANISME (v1) ─────────────────────────────────────────────
// Quand un expert enregistre un Meet (Workspace), Google dépose le fichier
// dans son Drive ET l'attache à l'ÉVÉNEMENT Calendar (event.attachments[]) —
// idem pour le doc "Notes de réunion" Gemini. Chaque RDV créé par
// onBookingCreated porte calendarEventId + calendarIdUsed, et on a les tokens
// OAuth calendar de chaque expert (calendar_tokens/{personId}) → le scope
// calendar suffit pour lire les LIENS des attachments.
//
// ─── NOUVEAU EN v2 : LIVRAISON CLIENT (RDV coaching uniquement) ───────────
// Pour chaque RDV coaching (isCoaching sur le doc OU sur son type
// booking_config) dont l'enregistrement est trouvé :
//   1. Email au client (boîte 'coaching' via _gmailSend / email_tokens) :
//      lien replay vidéo + lien résumé Gemini si présent. JAMAIS pour les
//      RDV prospects setting/closing (décision Adrien 07/2026).
//      ⚠️ Prérequis d'accès : le dossier Drive "Meet Recordings" de chaque
//      coach doit être partagé "Tous les utilisateurs disposant du lien —
//      Lecteur" (réglage une fois par coach), sinon liens inaccessibles.
//   2. Fiche coaching clients/{clientId} :
//      • session correspondante (même date) → pose visioUrl si vide.
//        On ne touche NI driveUrl NI resume : le scan Drive manuel du coach
//        (coaching.html) reste responsable de lier le doc + extraire le
//        résumé + déclencher le pipeline IA (parcours/workbooks) — poser
//        driveUrl ici ferait sauter ce pipeline (le scan skip les sessions
//        déjà liées).
//      • trace d'archive meetRecordings[] (arrayUnion) : bookingId, date,
//        liens — audit + affichages futurs.
//   3. Idempotence at-most-once : meetClientEmailSentAt posé AVANT l'envoi
//      (convention repo — jamais de doublon client). Si la boîte 'coaching'
//      n'est pas connectée, AUCUN flag n'est posé : le run suivant rattrape
//      automatiquement dès la connexion (fenêtre ?days).
//   Rattrapage : les RDV coaching déjà découverts (meetRecordingUrl posé par
//   la v1) mais jamais livrés au client sont traités aussi.
//
// ─── PARAMÈTRES (query string) ────────────────────────────────────────────
//   days=<n>   fenêtre de scan en jours (défaut 7, cap 30)
//   dry=1      dry-run : liste ce qui serait fait, n'écrit RIEN, n'envoie RIEN
//
// ─── TEST MANUEL ──────────────────────────────────────────────────────────
//   curl -H "x-api-key: <CRON_SECRET>" \
//     "https://team.alteore.com/api/meet-recordings-sync?days=14&dry=1"
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');

const GRACE_DAYS  = 5;   // jours après le RDV avant d'abandonner la recherche
const MAX_CHECKS  = 8;   // tentatives max par RDV
const QUERY_LIMIT = 800; // garde-fou sur le scan
const PAST_MARGIN_MS = 60 * 60000; // le RDV doit être fini depuis ≥ 1 h
const EMAIL_ACCOUNT = 'coaching';  // email_tokens/coaching (admin-email-auth.html)

// ─── Dates ──────────────────────────────────────────────────────────────
function parisTodayIso() {
  return new Intl.DateTimeFormat('fr-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}
function isoAddDays(iso, delta) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}
function frLongDate(isoDate) {
  try {
    return new Date(isoDate + 'T12:00:00').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch (_) { return isoDate; }
}
// Fin du créneau en ms (interprété UTC côté Vercel → ~2 h de marge vs Paris,
// exactement ce qu'on veut : jamais pendant le meet).
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

// ─── Types de consultation (booking_config/_types) ───────────────────────
// Pour classer "coaching" les anciens bookings sans flag isCoaching sur le
// doc — même logique que sales-rdv.html.
async function loadTypeMap() {
  const map = {};
  try {
    const snap = await db.collection('booking_config').doc('_types').get();
    if (snap.exists) {
      const list = (snap.data() || {}).list || [];
      list.forEach((t) => { if (t && t.id) map[t.id] = t; });
    }
  } catch (e) { console.warn('[meet-sync] typeMap', e.message); }
  return map;
}
function isCoachingBooking(b, typeMap) {
  if (b.isCoaching === true) return true;
  const t = b.type && typeMap[b.type];
  return !!(t && t.isCoaching === true);
}

// ─── Attachments : vidéo + doc "Notes" Gemini ────────────────────────────
function pickVideo(atts) {
  return atts.find((a) => /video/i.test(a.mimeType || '') || /\.(mp4|webm|mkv)$/i.test(a.title || '')) || null;
}
function pickNotesDoc(atts) {
  const docs = atts.filter((a) => (a.mimeType || '') === 'application/vnd.google-apps.document');
  if (!docs.length) return null;
  // Le doc "Notes de réunion / Notes by Gemini" est LE résumé ; le doc
  // "Chat" (transcript du chat Meet) ne l'est pas — même filtre que le scan
  // Drive manuel de coaching.html.
  const notes = docs.find((a) => /notes/i.test(a.title || '') && !/chat/i.test(a.title || ''));
  if (notes) return notes;
  const nonChat = docs.find((a) => !/chat/i.test(a.title || ''));
  return nonChat || null;
}

// ─── Push dans la fiche PROSPECT (leads) — inchangé v1 ───────────────────
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
    duration: Number(booking.duration) ? Number(booking.duration) * 60 : null,
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

  await leadRef.update({
    communications: (lead.communications || []).concat([commEntry]),
    timeline_history: (lead.timeline_history || []).concat([timelineEntry]),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { pushed: true };
}

// ─── Email client coaching ────────────────────────────────────────────────
function buildClientEmail(opts) {
  const prenom = opts.prenom || '';
  const dateFr = opts.dateFr;
  const coach = opts.coachName || 'ton coach';
  const hasNotes = !!opts.notesUrl;

  const subject = '🎥 Ton replay de séance du ' + dateFr;

  const btn = (url, label, bg) =>
    '<a href="' + url + '" target="_blank" style="display:inline-block;padding:12px 22px;margin:6px 8px 6px 0;' +
    'background:' + bg + ';color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">' +
    label + '</a>';

  const bodyHtml =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2340;font-size:14px;line-height:1.7">' +
    '<p>Bonjour' + (prenom ? ' ' + prenom : '') + ' 👋</p>' +
    '<p>Ta séance du <strong>' + dateFr + '</strong> avec ' + coach + ' est disponible :</p>' +
    '<div style="margin:18px 0">' +
    btn(opts.videoUrl, '▶️ Regarder le replay', '#4f46e5') +
    (hasNotes ? btn(opts.notesUrl, '📝 Lire le résumé de la séance', '#059669') : '') +
    '</div>' +
    '<p style="font-size:12.5px;color:#6b7194">Garde ces liens précieusement : replay et résumé restent accessibles à tout moment pour revoir les points clés et avancer entre deux séances.</p>' +
    '<p>À très vite,<br><strong>L\'équipe Alteore</strong></p>' +
    '</div>';

  const bodyText =
    'Bonjour' + (prenom ? ' ' + prenom : '') + ',\n\n' +
    'Ta séance du ' + dateFr + ' avec ' + coach + ' est disponible :\n\n' +
    '▶️ Replay : ' + opts.videoUrl + '\n' +
    (hasNotes ? '📝 Résumé : ' + opts.notesUrl + '\n' : '') +
    '\nÀ très vite,\nL\'équipe Alteore';

  return { subject, bodyHtml, bodyText };
}

// Résout l'email + le prénom du client d'un booking coaching.
async function resolveClient(b) {
  let email = (b.prospect && b.prospect.email) ? String(b.prospect.email).trim() : '';
  let prenom = (b.prospect && b.prospect.prenom) ? String(b.prospect.prenom).trim() : '';
  let clientDoc = null;
  if (b.clientId) {
    try {
      const snap = await db.collection('clients').doc(b.clientId).get();
      if (snap.exists) {
        clientDoc = { id: snap.id, data: snap.data() || {} };
        if (!email && clientDoc.data.email) email = String(clientDoc.data.email).trim();
        if (!prenom) {
          const nom = clientDoc.data.nom || b.clientNom || '';
          prenom = String(nom).trim().split(/\s+/)[0] || '';
        }
      }
    } catch (e) { console.warn('[meet-sync] client', b.clientId, e.message); }
  }
  if (!prenom && b.clientNom) prenom = String(b.clientNom).trim().split(/\s+/)[0] || '';
  return { email: email || null, prenom, clientDoc };
}

// Lie le replay à la séance correspondante de la fiche coaching + trace
// d'archive meetRecordings[]. N'écrase JAMAIS un visioUrl existant (saisie
// coach prioritaire) et ne touche pas driveUrl/resume (réservés au scan
// Drive manuel + pipeline IA de coaching.html).
async function linkToClientSession(clientDoc, b, videoUrl, notesUrl) {
  if (!clientDoc) return { linked: false, reason: 'no_client_doc' };
  const c = clientDoc.data;
  const patch = {};
  let linked = false;

  const matchInList = (list) => {
    if (!Array.isArray(list)) return false;
    for (const s of list) {
      if (!s || s.date !== b.date) continue;
      if (s.visioUrl) continue; // déjà renseigné (main du coach) → on ne touche pas
      s.visioUrl = videoUrl;
      return true;
    }
    return false;
  };

  if (Array.isArray(c.years) && c.years.length) {
    for (const y of c.years) {
      if (matchInList(y && y.sessions)) { linked = true; break; }
    }
    if (linked) patch.years = c.years;
  } else if (Array.isArray(c.sessions)) {
    if (matchInList(c.sessions)) { linked = true; patch.sessions = c.sessions; }
  }

  patch.meetRecordings = admin.firestore.FieldValue.arrayUnion({
    bookingId: b._id || null,
    date: b.date || null,
    time: b.time || null,
    typeLabel: b.typeLabel || b.type || null,
    coachName: b.personName || null,
    videoUrl: videoUrl || null,
    notesUrl: notesUrl || null,
    addedAt: admin.firestore.Timestamp.now(),
  });

  await db.collection('clients').doc(clientDoc.id).update(patch);
  return { linked };
}

// Livraison complète côté client coaching : flag (at-most-once) → email →
// liaison fiche. `atts` = meetAttachments (depuis l'event ou déjà stockés).
async function deliverToCoachingClient(ctx, bookingId, b, atts) {
  const video = pickVideo(atts);
  if (!video || !video.fileUrl) return { status: 'no_video' };
  const notes = pickNotesDoc(atts);

  const { email, prenom, clientDoc } = await resolveClient(b);
  const ref = db.collection('bookings').doc(bookingId);

  if (!email) {
    if (!ctx.dry) await ref.set({ meetClientEmailSkipped: 'no_email', meetClientEmailCheckedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { status: 'no_email' };
  }
  if (ctx.dry) return { status: 'would_email', to: email };

  // At-most-once : flag AVANT l'envoi (convention repo pour tout ce qui part
  // vers un client — un doublon est pire qu'un manque relançable).
  await ref.set({
    meetClientEmailSentAt: admin.firestore.FieldValue.serverTimestamp(),
    meetClientEmailTo: email,
  }, { merge: true });

  const mail = buildClientEmail({
    prenom,
    dateFr: frLongDate(b.date),
    coachName: b.personName || null,
    videoUrl: video.fileUrl,
    notesUrl: notes ? notes.fileUrl : null,
  });

  try {
    await sendEmailFromAccount({
      accountKey: EMAIL_ACCOUNT,
      to: email,
      subject: mail.subject,
      bodyHtml: mail.bodyHtml,
      bodyText: mail.bodyText,
    });
  } catch (e) {
    console.error('[meet-sync] email', bookingId, e.message);
    await ref.set({ meetClientEmailError: e.message }, { merge: true });
    return { status: 'email_error', error: e.message };
  }

  // Fiche coaching (non bloquant)
  let linked = false;
  try {
    if (b.clientId) {
      const r = await linkToClientSession(clientDoc, Object.assign({ _id: bookingId }, b), video.fileUrl, notes ? notes.fileUrl : null);
      linked = r.linked;
    }
  } catch (e) {
    console.warn('[meet-sync] link client', bookingId, e.message);
  }
  return { status: 'emailed', to: email, linked };
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
    clientEmails: 0, clientEmailsPending: 0, clientLinked: 0,
    retries: 0, gaveUp: 0, noTokens: 0, errors: [],
    items: [],
  };

  try {
    // 2. Boîte 'coaching' connectée ? Si non : on découvre quand même les
    // recordings mais on ne pose AUCUN flag d'envoi → rattrapage auto au
    // prochain run une fois la boîte connectée (admin-email-auth.html).
    let emailReady = false;
    try {
      const tok = await db.collection('email_tokens').doc(EMAIL_ACCOUNT).get();
      emailReady = tok.exists && !!(tok.data() || {}).refreshToken;
    } catch (_) { /* emailReady reste false */ }
    if (!emailReady) out.coachingAccountConnected = false;

    // 3. Bookings de la fenêtre (range sur un seul champ → pas d'index composite)
    const snap = await db.collection('bookings')
      .where('date', '>=', startIso)
      .where('date', '<=', todayIso)
      .limit(QUERY_LIMIT)
      .get();
    out.scanned = snap.size;

    const typeMap = await loadTypeMap();

    // 4. Filtres métier côté code
    const discover = [];      // recordings à chercher (v1)
    const deliverLate = [];   // coaching déjà découverts, email jamais parti (rattrapage)
    snap.forEach((doc) => {
      const b = doc.data() || {};
      const st = b.status || 'confirmed';
      if (st !== 'confirmed' && st !== 'completed') return;
      if (!b.calendarEventId) return;
      if (bookingEndMs(b) + PAST_MARGIN_MS > nowMs) return;

      const coaching = isCoachingBooking(b, typeMap);
      if (b.meetRecordingUrl) {
        if (coaching && !b.meetClientEmailSentAt && !b.meetClientEmailSkipped) {
          deliverLate.push({ id: doc.id, b });
        }
        return;
      }
      if (b.meetRecordingNone) return;
      if ((b.meetRecordingChecks || 0) >= MAX_CHECKS) return;
      discover.push({ id: doc.id, b, coaching });
    });
    out.eligible = discover.length;
    out.lateDeliveries = deliverLate.length;

    const ctx = { dry };

    // 5. Rattrapage : coaching déjà découverts par la v1 mais jamais livrés
    for (const item of deliverLate) {
      if (!emailReady) { out.clientEmailsPending++; continue; }
      try {
        const atts = Array.isArray(item.b.meetAttachments) && item.b.meetAttachments.length
          ? item.b.meetAttachments
          : [{ title: item.b.meetRecordingTitle || null, fileUrl: item.b.meetRecordingUrl, mimeType: item.b.meetRecordingMime || 'video/mp4' }];
        const r = await deliverToCoachingClient(ctx, item.id, item.b, atts);
        out.items.push({ id: item.id, action: 'late_' + r.status, to: r.to || null });
        if (r.status === 'emailed' || r.status === 'would_email') out.clientEmails++;
        if (r.linked) out.clientLinked++;
        if (r.status === 'email_error') out.errors.push({ id: item.id, error: r.error });
      } catch (e) {
        out.errors.push({ id: item.id, error: e.message });
      }
    }

    if (!discover.length) { res.status(200).json(out); return; }

    // 6. Clients OAuth par expert (cache)
    const conf = await getOAuthConfig();
    const clientCache = {};
    async function clientFor(pid) {
      if (!(pid in clientCache)) {
        try { clientCache[pid] = await getAuthClientForPerson(conf, pid); }
        catch (e) { clientCache[pid] = null; console.warn('[meet-sync] tokens', pid, e.message); }
      }
      return clientCache[pid];
    }

    // 7. Découverte (séquentiel : volumes faibles, pas de rate-limit Google)
    for (const item of discover) {
      const b = item.b;
      const ref = db.collection('bookings').doc(item.id);
      try {
        const pid = b.personId;
        if (!pid) { out.errors.push({ id: item.id, error: 'no_personId' }); continue; }
        const client = await clientFor(pid);
        if (!client) { out.noTokens++; continue; }

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
            out.gaveUp++;
            out.items.push({ id: item.id, action: 'gave_up_event_deleted' });
            if (!dry) await ref.set({ meetRecordingNone: true, meetRecordingCheckedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
            continue;
          }
          throw e;
        }

        const atts = (ev.data && ev.data.attachments) || [];
        if (atts.length) {
          const video = pickVideo(atts) || atts[0];
          out.found++;
          out.items.push({ id: item.id, action: 'found', title: video.title || null, lead: b.leadId || null, coaching: item.coaching });
          if (!dry) {
            const patch = {
              meetRecordingUrl: video.fileUrl || null,
              meetRecordingTitle: video.title || null,
              meetRecordingMime: video.mimeType || null,
              meetAttachments: atts.map((a) => ({ title: a.title || null, fileUrl: a.fileUrl || null, mimeType: a.mimeType || null })),
              meetRecordingFoundAt: admin.firestore.FieldValue.serverTimestamp(),
            };
            // Fiche PROSPECT (leads) — RDV setting/closing avec leadId
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
          // Livraison CLIENT coaching (email + fiche)
          if (item.coaching) {
            if (!emailReady) { out.clientEmailsPending++; }
            else {
              try {
                const r = await deliverToCoachingClient(ctx, item.id, b, atts);
                out.items.push({ id: item.id, action: 'client_' + r.status, to: r.to || null });
                if (r.status === 'emailed' || r.status === 'would_email') out.clientEmails++;
                if (r.linked) out.clientLinked++;
                if (r.status === 'email_error') out.errors.push({ id: item.id, error: r.error });
              } catch (ce) {
                out.errors.push({ id: item.id, error: 'client_delivery: ' + ce.message });
              }
            }
          }
        } else {
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
