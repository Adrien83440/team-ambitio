// ============================================================================
// api/ringover-recording-ready.js  (v3 — webhooks Ringover 2.0)
// ----------------------------------------------------------------------------
// Webhook Ringover quand l'enregistrement d'un appel est disponible.
// Déclenche le pipeline : download → Firebase Storage → Whisper → Claude.
//
// Ce endpoint ne fait qu'UNE chose : déposer le message dans webhook_inbox.
// C'est la Cloud Function onWebhookInbox qui orchestre le pipeline.
//
// Note : Ringover peut inclure l'URL d'enregistrement directement dans le
// webhook HANGUP. Ce endpoint est un fallback pour les plateformes qui
// envoient un event séparé "recording_ready". Si HANGUP contient déjà l'URL,
// api/ringover-call-status.js dépose le même document et le pipeline part de
// là — la déduplication se fait en aval, sur callId.
//
// ─── v3 (correctif 14/09/2026) — webhooks 2.0 ──────────────────────────────
// - Corps lu en BRUT (readRingoverPayload) : les call_id uint64 sont arrondis
//   par le parse JSON standard et ne matchent plus aucun doc call_logs.
// - Id résolu par pickCallId : data.call_id prioritaire (data.id est devenu
//   un UUID de ressource), formats ancien et 2.0 acceptés.
// - Champs 2.0 acceptés pour l'URL : data.record / data.record_link, en plus
//   des anciens recording_url / recording.url / url / link.
//
// ─── v2 (rappel) ────────────────────────────────────────────────────────────
// Réponse APRÈS l'écriture webhook_inbox : Vercel gèle la fonction dès la
// réponse, l'écriture qui déclenche tout le pipeline se perdait sinon.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { readRingoverPayload, pickCallId } = require('./_ringoverWebhook');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const payload = await readRingoverPayload(req);
    const d = (payload && payload.data) || {};
    const callId = pickCallId(payload);
    const pick = v => (typeof v === 'string' && v) ? v : null;
    const recordingUrl = pick(d.record) || pick(d.record_link)
      || pick(d.recording_url) || pick(payload.recording_url)
      || (d.recording && typeof d.recording === 'object' ? pick(d.recording.url) : pick(d.recording))
      || (payload.recording && typeof payload.recording === 'object' ? pick(payload.recording.url) : pick(payload.recording))
      || pick(payload.url) || pick(payload.link) || null;

    if (!callId && !recordingUrl) {
      console.warn('[ringover-recording-ready] Payload sans callId ni recordingUrl');
      res.status(200).send('');
      return;
    }

    await db.collection('webhook_inbox').add({
      source: 'ringover_recording_ready',
      payload,
      callId: callId || null,
      recordingUrl: recordingUrl || null,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
    });

    console.log('[ringover-recording-ready] queued', callId);
    res.status(200).send('');
  } catch (err) {
    console.error('[ringover-recording-ready] Error:', err && err.message, err && err.stack);
    // 200 malgré l'erreur : Ringover rejouerait indéfiniment sinon.
    res.status(200).send('');
  }
};
