// api/admin-sync-ringover-calls.js
// Synchronise les appels Ringover passés dans Firestore call_logs
// (enregistrement, transcription, résumé IA)
//
// URL : POST /api/admin-sync-ringover-calls
// Auth : Bearer Firebase ID token (rôle admin uniquement)
// Body : { days?: number }  — nombre de jours en arrière (défaut 30)

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { ringoverFetch } = require('./_ringoverClient');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const { days = 30 } = (req.body || {});
  const daysN = Math.min(Math.max(1, parseInt(days) || 30), 90); // max 90 jours

  const now = new Date();

  // Ringover : max 15 jours par requête, format "YYYY-MM-DD HH:MM:SS"
  // Pour éviter les erreurs, on découpe en tranches de 7 jours max
  const maxDaysPerChunk = 7;
  const totalMs = daysN * 24 * 60 * 60 * 1000;

  // Format Ringover : "2026-05-22 00:00:00" (espace, pas T, pas Z)
  const fmtRingover = d => {
    const pad = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  };

  console.log(`[sync-ringover] Syncing ${daysN} days`);

  // ── 1. Récupérer la liste des appels ─────────────────────────────────────
  // GET /calls : dates en query params ISO 8601, max 15 jours par tranche
  let callList = [];
  try {
    let chunkEnd = new Date(now);
    const globalStart = new Date(now.getTime() - totalMs);

    while (chunkEnd > globalStart) {
      const chunkStart = new Date(Math.max(
        chunkEnd.getTime() - maxDaysPerChunk * 24 * 60 * 60 * 1000,
        globalStart.getTime()
      ));

      let offset = 0;
      const limit = 200;

      while (true) {
        const qs = new URLSearchParams({
          start_date:   chunkStart.toISOString(),
          end_date:     chunkEnd.toISOString(),
          limit_count:  String(limit),
          limit_offset: String(offset),
        }).toString();

        const resp = await ringoverFetch(`/calls?${qs}`, { method: 'GET' });

        const list = resp?.call_list || [];
        callList = callList.concat(list);
        const total = resp?.total_call_count || 0;

        if (list.length < limit || callList.length >= total || list.length === 0) break;
        offset += limit;
      }

      chunkEnd = new Date(chunkStart.getTime() - 1);
    }
  } catch (e) {
    console.error('[sync-ringover] Fetch calls error:', e.message, e.rawResponse);
    return res.status(502).json({ error: 'Erreur API Ringover calls: ' + (e.rawResponse || e.message) });
  }

  console.log(`[sync-ringover] ${callList.length} appels récupérés`);

  // ── Mapping ringoverUserId → firebaseUid ───────────────────────────────
  const ringoverUserToUid = {};
  try {
    // 1. Lookup phone_numbers Ringover
    const phoneSnap = await db.collection('phone_numbers')
      .where('provider', '==', 'ringover').where('active', '==', true).get();
    console.log('[sync] phone_numbers Ringover trouvés:', phoneSnap.size);

    phoneSnap.forEach(d => {
      const x = d.data();
      if (x.ringoverUserId && x.assignedTo) {
        ringoverUserToUid[String(x.ringoverUserId)] = x.assignedTo;
      }
    });

    // 2. Fallback : utiliser _config/telco_credentials.ringover.userId
    //    pour mapper sur le PREMIER assignedTo trouvé (cas mono-user Ringover)
    if (Object.keys(ringoverUserToUid).length === 0 && phoneSnap.size > 0) {
      const credSnap = await db.collection('_config').doc('telco_credentials').get();
      const cred = credSnap.data()?.ringover;
      const assignedTo = phoneSnap.docs[0].data().assignedTo;
      if (cred?.userId && assignedTo) {
        ringoverUserToUid[String(cred.userId)] = assignedTo;
        console.log('[sync] Fallback mapping:', cred.userId, '→', assignedTo);
      }
    }

    // 3. Ultime fallback : Élodie (seul user Ringover actuellement)
    if (Object.keys(ringoverUserToUid).length === 0) {
      ringoverUserToUid['22855712'] = 'IrL8bfOrUfMH2fEPFzuojPT8bQh1';
      console.log('[sync] Hardcoded fallback Élodie 22855712');
    }

    console.log('[sync] Final mapping:', ringoverUserToUid);
  } catch (e) {
    console.warn('[sync] Mapping error:', e.message);
    // Fallback même en cas d'erreur
    ringoverUserToUid['22855712'] = 'IrL8bfOrUfMH2fEPFzuojPT8bQh1';
  }

  // ── 2. Pour chaque appel : upsert call_logs + tentative transcription ──────
  const results = { synced: 0, transcriptions: 0, errors: 0 };
  const batch   = []; // batches Firestore de 500 max

  for (const call of callList) {
    try {
      const callId = call.call_id ? String(call.call_id) : null;
      if (!callId || callId === '0') continue;

      // Normaliser les numéros Ringover (sans +) → E.164
      const addPlus = n => n ? (String(n).startsWith('+') ? String(n) : '+' + String(n)) : null;
      const fromNum = addPlus(call.from_number);
      const toNum   = addPlus(call.to_number);
      const isOut   = call.direction === 'out';

      // Déduire leadId depuis call_logs existant ou laisser null
      const docRef = db.collection('call_logs').doc(callId);

      const update = {
        providerCallId:    callId,
        provider:          'ringover',
        direction:         isOut ? 'outbound' : 'inbound',
        fromNumber:        fromNum,
        toNumber:          toNum,
        status:            call.is_answered ? 'completed' : (call.last_state === 'MISSED' ? 'no-answer' : 'completed'),
        /* Fix 15/07 (aligné cron) : conversation stricte, jamais la sonnerie. */
        durationSec:       (function () { var n = Number(call.incall_duration); return isFinite(n) && n > 0 ? Math.round(n) : 0; })(),
        totalDurationSec:  (function () { var n = Number(call.total_duration); return isFinite(n) && n > 0 ? Math.round(n) : null; })(),
        startTime:         call.start_time || null,
        endTime:           call.end_time   || null,
        syncedAt:          admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      };

      // Enregistrement audio : champ "record" dans la réponse Ringover
      if (call.record) {
        update.ringoverRecordingUrl = call.record;
        update.recordingStatus      = 'available';
      }

      // initiatedAt pour le tri dans l'historique
      if (call.start_time) {
        try { update.initiatedAt = admin.firestore.Timestamp.fromDate(new Date(call.start_time)); }
        catch (_) {}
      }

      // Utilisateur Ringover → userId Firebase + nom
      if (call.user) {
        const ruid = call.user.user_id ? String(call.user.user_id) : null;
        update.ringoverUserId   = ruid;
        update.ringoverUserName = ((call.user.firstname || '') + ' ' + (call.user.lastname || '')).trim() || null;
        if (ruid && ringoverUserToUid[ruid]) {
          update.userId = ringoverUserToUid[ruid];
        }
        if (call.user.firstname) update.userName = call.user.firstname;
      } else if (Object.keys(ringoverUserToUid).length === 1) {
        // Pas de call.user mais un seul user mappé → utiliser celui-là
        update.userId = Object.values(ringoverUserToUid)[0];
      }

      // Snapshot du contact
      if (call.contact) {
        update.leadNameSnapshot = call.contact.firstname
          ? ((call.contact.firstname || '') + ' ' + (call.contact.lastname || '')).trim()
          : null;
      }

      // ── Transcription Ringover ────────────────────────────────────────────
      try {
        const tr = await ringoverFetch(`/transcriptions/${callId}`);
        const items = Array.isArray(tr) ? tr : (tr ? [tr] : []);
        if (items.length > 0 && items[0]?.transcription_data) {
          const td = items[0].transcription_data;
          update.transcriptText     = td.text    || null;
          update.transcriptSpeeches = td.speeches || null;
          update.transcriptionStatus = 'done';
          results.transcriptions++;
        }
      } catch (_) {
        // Pas de transcription pour cet appel (normal)
      }

      batch.push({ ref: docRef, data: update });
      results.synced++;

      // Écrire par lots de 400 (limite Firestore = 500)
      if (batch.length >= 400) {
        const fb = db.batch();
        batch.forEach(({ ref, data }) => fb.set(ref, data, { merge: true }));
        await fb.commit();
        batch.length = 0;
      }

    } catch (err) {
      console.warn('[sync-ringover] Error for call', call.call_id, err.message);
      results.errors++;
    }
  }

  // Flush le reste
  if (batch.length > 0) {
    const fb = db.batch();
    batch.forEach(({ ref, data }) => fb.set(ref, data, { merge: true }));
    await fb.commit();
  }

  console.log('[sync-ringover] Done:', results);
  res.json({
    ok: true,
    days: daysN,
    totalCalls: callList.length,
    ...results,
  });
};
