// ============================================================================
// api/call-detail.js
// ----------------------------------------------------------------------------
// Retourne le détail complet d'un appel (call_logs/{callSid}) avec :
//   - URL signée du .mp3 Firebase Storage (TTL 1h)
//   - transcription Whisper
//   - analyse Claude (interestLevel, objections, nextSteps, summary...)
//
// URL : POST https://team.alteore.com/api/call-detail
// Auth: Bearer Firebase ID token (sales ou admin)
// Body: { "callLogId": "CAxxx..." }
//
// Réponse 200 :
//   {
//     callLogId, direction, status, leadId, leadNameSnapshot,
//     fromNumber, toNumber, initiatedAt, durationSec, userId, userName,
//     recordingStatus, recordingSignedUrl, recordingDurationSec,
//     transcriptionStatus, transcriptionText, transcriptionLanguage,
//     aiAnalysisStatus, aiAnalysis: { interestLevel, objections, nextSteps,
//                                     summary, suggestedFollowUps }
//   }
//
// Stratégie : on ne renvoie que ce qu'on a. Si le pipeline n'est pas terminé,
// recordingSignedUrl / transcriptionText / aiAnalysis peuvent être null et
// le frontend affiche l'état (processing, pending, failed).
// ============================================================================

const { db, storage } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

// TTL de l'URL signée : 1 heure. Suffisant pour écouter l'appel, trop court
// pour être partagé publiquement.
const SIGNED_URL_TTL_MS = 60 * 60 * 1000;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  // Pas de guard role ici — on fait le contrôle fin plus bas pour matcher
  // exactement la règle Firestore call_logs (admin || canListenCalls || owner).

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

    // ────────────────────────────────────────────────────────────────────
    // Permissions — doit répliquer les Firestore rules côté serveur
    // (Admin SDK bypass les rules, donc on re-vérifie manuellement).
    //
    // Rules call_logs : allow read if
    //   canListenCalls()  (admin OR users/{uid}.canListenCalls == true)
    //   OR  resource.data.userId == request.auth.uid  (ses propres appels)
    // ────────────────────────────────────────────────────────────────────
    const isAdmin = auth.role === 'admin';
    const isOwnCall = log.userId && log.userId === auth.uid;
    let canListenAll = isAdmin;

    if (!canListenAll && !isOwnCall) {
      // Lookup du flag canListenCalls sur users/{uid}
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

    // Génère une URL signée V4 pour le .mp3 (si disponible)
    // On force le bucket Firebase Storage au bon format (.firebasestorage.app)
    // — cf commentaire dans callAnalysisPipeline.js sur le mismatch
    // .appspot.com / .firebasestorage.app.
    let recordingSignedUrl = null;
    if (log.recordingStoragePath) {
      try {
        const BUCKET_NAME =
          process.env.STORAGE_BUCKET || 'ambitio-team.firebasestorage.app';
        const bucket = storage.bucket(BUCKET_NAME);
        const file = bucket.file(log.recordingStoragePath);
        const [url] = await file.getSignedUrl({
          version: 'v4',
          action: 'read',
          expires: Date.now() + SIGNED_URL_TTL_MS,
        });
        recordingSignedUrl = url;
      } catch (err) {
        console.error(
          `[call-detail] getSignedUrl failed for ${log.recordingStoragePath}:`,
          err.message
        );
        // Non-bloquant : on renvoie quand même les autres champs
      }
    }

    // Résolution optionnelle du userName depuis _meta/team_members
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

    // Sérialisation des Timestamps en ISO (JSON-safe)
    const toIso = t => (t && t.toDate ? t.toDate().toISOString() : null);

    res.status(200).json({
      callLogId,
      direction: log.direction || null,
      status: log.status || null,
      leadId: log.leadId || null,
      leadNameSnapshot: log.leadNameSnapshot || log.leadName || null,
      fromNumber: log.fromNumber || null,
      toNumber: log.toNumber || null,
      initiatedAt: toIso(log.initiatedAt),
      answeredAt: toIso(log.answeredAt),
      endedAt: toIso(log.endedAt),
      durationSec: log.durationSec || null,
      userId: log.userId || null,
      userName,
      recordingStatus: log.recordingStatus || 'pending',
      recordingSignedUrl,
      recordingDurationSec: log.recordingDurationSec || null,
      transcriptionStatus: log.transcriptionStatus || 'pending',
      transcriptionText: log.transcriptionText || null,
      transcriptionLanguage: log.transcriptionLanguage || null,
      aiAnalysisStatus: log.aiAnalysisStatus || 'pending',
      aiAnalysis: log.aiAnalysis || null,
    });
  } catch (err) {
    console.error('[call-detail] Error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
};
