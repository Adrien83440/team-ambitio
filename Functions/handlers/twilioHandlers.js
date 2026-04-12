// ============================================================================
// Functions/handlers/twilioHandlers.js
// ----------------------------------------------------------------------------
// Handlers des events Twilio qui arrivent via webhook_inbox.
// Deux handlers principaux :
//   1. handleVoiceStatus  — events de progression d'appel (ringing, answered,
//                            completed, etc.) → update call_logs + session stats
//   2. handleRecordingReady — enregistrement prêt → déclenche le pipeline IA
//                             complet (download → Storage → Whisper → Claude)
// ============================================================================

const admin = require('firebase-admin');
const pipeline = require('../pipelines/callAnalysisPipeline');

// ============================================================================
// handleVoiceStatus
// ============================================================================

/**
 * Twilio envoie des CallStatus qu'on mappe vers notre schéma call_logs.
 * Valeurs Twilio possibles :
 *   initiated, ringing, in-progress, answered, completed, busy,
 *   no-answer, failed, canceled
 */
const TWILIO_STATUS_MAP = {
  initiated: 'initiated',
  ringing: 'ringing',
  'in-progress': 'in-progress',
  answered: 'in-progress',
  completed: 'completed',
  busy: 'busy',
  'no-answer': 'no-answer',
  failed: 'failed',
  canceled: 'canceled',
};

const TERMINAL_STATUSES = new Set([
  'completed',
  'busy',
  'no-answer',
  'failed',
  'canceled',
]);

async function handleVoiceStatus(db, payload) {
  const callSid = payload.CallSid || payload.ParentCallSid;
  if (!callSid) {
    console.warn('[handleVoiceStatus] Missing CallSid in payload');
    return;
  }

  const rawStatus = String(payload.CallStatus || '').toLowerCase();
  const mappedStatus = TWILIO_STATUS_MAP[rawStatus] || rawStatus;
  const now = admin.firestore.FieldValue.serverTimestamp();

  // Build the update payload — only include fields we actually have
  const update = {
    status: mappedStatus,
    updatedAt: now,
  };

  if (rawStatus === 'ringing') {
    update.ringingAt = now;
  }
  if (rawStatus === 'answered' || rawStatus === 'in-progress') {
    update.answeredAt = now;
  }
  if (TERMINAL_STATUSES.has(mappedStatus)) {
    update.endedAt = now;
  }

  // Duration (Twilio sends it on "completed")
  if (payload.CallDuration) {
    const dur = parseInt(payload.CallDuration, 10);
    if (!Number.isNaN(dur)) {
      update.durationSec = dur;
      // talkDurationSec = durée effective de conversation (identique à
      // CallDuration sauf si on a une logique de soustraction de sonnerie
      // plus fine, ce qu'on fera en Vague 2)
      update.talkDurationSec = dur;
    }
  }

  // Twilio Price (coût de l'appel, négatif dans leur format)
  if (payload.Price) {
    const price = Math.abs(parseFloat(payload.Price));
    if (!Number.isNaN(price)) {
      update.twilioCost = price;
      update.twilioCostCurrency = payload.PriceUnit || 'USD';
    }
  }

  // Apply update with merge (creates doc if missing — defensive)
  try {
    await db.collection('call_logs').doc(callSid).set(update, { merge: true });
  } catch (err) {
    console.error(`[handleVoiceStatus] Failed to update call_logs/${callSid}:`, err);
    throw err;
  }

  // Update session stats on terminal statuses
  if (TERMINAL_STATUSES.has(mappedStatus)) {
    try {
      await updateSessionStats(db, callSid, mappedStatus);
    } catch (err) {
      console.error(`[handleVoiceStatus] Failed to update session stats:`, err);
      // Non-blocking : on ne propage pas l'erreur, le call_log est déjà à jour
    }
  }
}

/**
 * Met à jour les stats de session live associée à un call_log terminé.
 */
async function updateSessionStats(db, callSid, status) {
  const callLogSnap = await db.collection('call_logs').doc(callSid).get();
  if (!callLogSnap.exists) return;

  const callLog = callLogSnap.data();
  if (!callLog.sessionId) return;

  const sessionRef = db.collection('dialer_sessions').doc(callLog.sessionId);

  const statsUpdate = {
    'stats.attempted': admin.firestore.FieldValue.increment(1),
    lastHeartbeat: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };

  const duration = callLog.durationSec || 0;

  // connected : appel décroché (> 5 secondes pour exclure les répondeurs rapides)
  if (status === 'completed' && duration >= 5) {
    statsUpdate['stats.connected'] = admin.firestore.FieldValue.increment(1);
  }

  // conversations : conversation effective (> 30 secondes)
  if (status === 'completed' && duration >= 30) {
    statsUpdate['stats.conversations'] = admin.firestore.FieldValue.increment(1);
  }

  await sessionRef.set(statsUpdate, { merge: true });
}

// ============================================================================
// handleRecordingReady
// ============================================================================

/**
 * Twilio informe que l'enregistrement d'un appel est prêt au téléchargement.
 * On déclenche le pipeline complet (download → Storage → Whisper → Claude).
 *
 * Le pipeline est async et peut prendre 30-180 secondes selon la durée de
 * l'appel. On attend sa complétion dans ce handler pour que la Cloud Function
 * ne soit pas killed avant la fin.
 */
async function handleRecordingReady(db, storage, payload) {
  const callSid = payload.CallSid;
  const recordingSid = payload.RecordingSid;
  const recordingDuration = payload.RecordingDuration
    ? parseInt(payload.RecordingDuration, 10)
    : null;
  const recordingChannels = payload.RecordingChannels
    ? parseInt(payload.RecordingChannels, 10)
    : null;

  if (!callSid || !recordingSid) {
    console.warn(
      '[handleRecordingReady] Missing CallSid or RecordingSid in payload'
    );
    return;
  }

  // Marquer le call_log comme "pipeline en cours"
  await db.collection('call_logs').doc(callSid).set(
    {
      recordingSid,
      recordingDurationSec: recordingDuration,
      recordingChannels,
      recordingStatus: 'processing',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    },
    { merge: true }
  );

  // Lancer le pipeline (peut throw → sera catché en amont par le trigger)
  await pipeline.runFullPipeline(db, storage, callSid, recordingSid);
}

// ============================================================================
// Exports
// ============================================================================

module.exports = {
  handleVoiceStatus,
  handleRecordingReady,
};
