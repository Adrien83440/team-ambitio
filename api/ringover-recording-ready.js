// ============================================================================
// api/ringover-recording-ready.js
// ----------------------------------------------------------------------------
// Webhook Ringover quand l'enregistrement d'un appel est disponible.
// Déclenche le pipeline : download → Firebase Storage → Whisper → Claude.
//
// URL publique : https://team.alteore.com/api/ringover-recording-ready
// À configurer : Ringover Dashboard → Integrations → Webhooks
//
// Note : Ringover peut inclure recording.url directement dans le webhook HANGUP.
// Ce endpoint est un fallback pour les plateformes qui envoient un event séparé
// "recording_ready". Si HANGUP contient déjà recording.url, le handler
// onWebhookInbox dans ~/index.js déclenchera aussi le pipeline.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.status(200).send('');

  try {
    const payload = req.body || {};
    const callId = payload.call_id || payload.id || null;
    const recordingUrl = payload.recording_url
      || (payload.recording && payload.recording.url)
      || null;

    if (!callId && !recordingUrl) {
      console.warn('[ringover-recording-ready] Payload sans callId ni recordingUrl');
      return;
    }

    await db.collection('webhook_inbox').add({
      source: 'ringover_recording_ready',
      payload,
      callId,
      recordingUrl,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
    });

    console.log('[ringover-recording-ready] queued', callId);
  } catch (err) {
    console.error('[ringover-recording-ready] Error:', err);
  }
};
