// api/call-detail.js  — v3 : + transcriptSpeeches, durées détaillées, amd
// ----------------------------------------------------------------------------
// Retourne le détail complet d'un appel (call_logs/{callSid}) avec :
//   - URL signée du .mp3 Firebase Storage (TTL 1h)  [Twilio]
//   - URL directe de l'enregistrement Ringover       [Ringover]
//   - transcription Whisper / Ringover
//   - analyse Claude / Ringover aiSummary
// ============================================================================

const { db, storage } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

/* Segments de transcription Ringover allégés : { channelId, start, end, text }.
   Les segments vides sont ignorés ; un tableau vide devient null. */
function compactSpeeches(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const out = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const text = typeof s.text === 'string' ? s.text.trim() : '';
    if (!text) continue;
    const start = Number(s.start);
    const end = Number(s.end);
    out.push({
      channelId: (s.channelId === 0 || s.channelId === 1 || typeof s.channelId === 'number') ? s.channelId : 0,
      start: isFinite(start) ? start : 0,
      end: isFinite(end) ? end : (isFinite(start) ? start : 0),
      text,
    });
  }
  return out.length ? out : null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { callLogId } = parseBody(req);
  if (!callLogId || typeof callLogId !== 'string') {
    res.status(400).json({ error: 'callLogId requis (string)' });
    return;
  }

  try {
    const snap = await db.collection('call_logs').doc(callLogId).get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Appel introuvable' });
      return;
    }

    const log = snap.data();

    // ────────────────────────────────────────────────────────────────────────
    // Permissions — réplique les Firestore rules côté serveur
    // (Admin SDK bypass les rules, donc on re-vérifie manuellement).
    //
    // Rules call_logs : allow read if
    //   canListenCalls()  (admin OR users/{uid}.canListenCalls == true)
    //   OR  resource.data.userId == request.auth.uid  (ses propres appels)
    // ────────────────────────────────────────────────────────────────────────
    const isAdmin   = auth.role === 'admin';
    const isOwnCall = log.userId && log.userId === auth.uid;
    let canListenAll = isAdmin;

    if (!canListenAll && !isOwnCall) {
      try {
        const userSnap = await db.collection('users').doc(auth.uid).get();
        if (userSnap.exists && userSnap.data().canListenCalls === true) {
          canListenAll = true;
        }
      } catch (_) { /* fallthrough → 403 */ }
    }

    if (!isAdmin && !canListenAll && !isOwnCall) {
      res.status(403).json({ error: 'Accès refusé à cet appel' });
      return;
    }

    // ── URL signée Firebase Storage (pipeline Twilio uniquement) ────────────
    // Pour Ringover, l'URL est déjà publique dans ringoverRecordingUrl.
    let recordingSignedUrl = null;
    if (log.recordingStoragePath) {
      try {
        const BUCKET_NAME = process.env.STORAGE_BUCKET || 'ambitio-team.firebasestorage.app';
        const bucket = storage.bucket(BUCKET_NAME);
        const file   = bucket.file(log.recordingStoragePath);
        const [url]  = await file.getSignedUrl({
          version: 'v4',
          action:  'read',
          expires: Date.now() + SIGNED_URL_TTL_MS,
        });
        recordingSignedUrl = url;
      } catch (err) {
        console.error(`[call-detail] getSignedUrl failed for ${log.recordingStoragePath}:`, err.message);
        // Non-bloquant : on renvoie quand même les autres champs
      }
    }

    // ── Résolution du userName depuis _meta/team_members ────────────────────
    let userName = log.userName || null;
    if (!userName && log.userId) {
      try {
        const metaSnap = await db.collection('_meta').doc('team_members').get();
        if (metaSnap.exists) {
          const members = metaSnap.data().members || [];
          const m = members.find(x => x.firebaseUid === log.userId);
          if (m) userName = m.shortName || m.displayName || null;
        }
      } catch (_) { /* non-bloquant */ }
    }

    // Sérialisation des Timestamps Firestore en ISO
    const toIso = t => (t && t.toDate ? t.toDate().toISOString() : null);

    res.status(200).json({
      callLogId,
      direction:        log.direction  || null,
      status:           log.status     || null,
      leadId:           log.leadId     || null,
      leadNameSnapshot: log.leadNameSnapshot || log.leadName || null,
      fromNumber:       log.fromNumber || null,
      toNumber:         log.toNumber   || null,
      initiatedAt:      toIso(log.initiatedAt),
      answeredAt:       toIso(log.answeredAt),
      endedAt:          toIso(log.endedAt),
      durationSec:      log.durationSec || null,
      totalDurationSec:   typeof log.totalDurationSec   === 'number' ? log.totalDurationSec   : null,
      ringingDurationSec: typeof log.ringingDurationSec === 'number' ? log.ringingDurationSec : null,
      amd:              log.amd === true ? true : (log.amd === false ? false : null),
      hangupBy:         log.hangupBy   || null,
      campaignId:       log.campaignId || null,
      provider:         log.provider   || null,
      userId:           log.userId     || null,
      userName,
      ringoverUserName: log.ringoverUserName || null,

      // ── Enregistrement ──────────────────────────────────────────────────
      // Twilio  : recordingSignedUrl  (URL signée Firebase Storage, TTL 1h)
      // Ringover: ringoverRecordingUrl (URL directe Ringover)
      // Le modal lit : detail.recordingSignedUrl || detail.ringoverRecordingUrl
      recordingStatus:      log.recordingStatus      || 'pending',
      recordingSignedUrl,
      ringoverRecordingUrl: log.ringoverRecordingUrl  || null,
      recordingDurationSec: log.recordingDurationSec  || null,

      // ── Transcription ────────────────────────────────────────────────────
      // Twilio  : transcriptionText  (Whisper via api/transcribe-voice.js)
      // Ringover: transcriptText     (GET /transcriptions/{callId} dans aftercall)
      // Le modal lit : detail.transcriptionText || detail.transcriptText
      transcriptionStatus:   log.transcriptionStatus  || 'pending',
      transcriptionText:     log.transcriptionText    || null,
      transcriptText:        log.transcriptText       || null,
      transcriptionLanguage: log.transcriptionLanguage || null,
      // Ringover ne pose PAS transcriptText : la transcription vit dans
      // transcriptSpeeches (segments par canal, avec le mot à mot). On renvoie
      // les segments sans le découpage mot à mot (words), inutile à l'écran et
      // 10× plus lourd que le texte. channelId distingue les deux locuteurs.
      transcriptSpeeches:    compactSpeeches(log.transcriptSpeeches),

      // ── Analyse IA ───────────────────────────────────────────────────────
      // Twilio  : aiAnalysis  (objet structuré : interestLevel, objections…)
      // Ringover: aiSummary   (string, issu de summary_available webhook)
      // Le modal lit : detail.aiAnalysis || (detail.aiSummary ? {summary:…} : null)
      aiAnalysisStatus: log.aiAnalysisStatus || 'pending',
      aiAnalysis:       log.aiAnalysis       || null,
      aiSummary:        log.aiSummary        || null,
      // Programme IA 10/2026 : fin d'appel + notation (api/ai-call.js)
      aiCall:           (log.aiCall && log.aiCall.resume) ? log.aiCall : null,
    });

  } catch (err) {
    console.error('[call-detail] Error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
};
