// ==========================================================================
// api/twilio-recording-status.js
// --------------------------------------------------------------------------
// Twilio appelle ce endpoint quand un enregistrement d'appel a fini d'être
// traité côté Twilio et est disponible au téléchargement.
//
// URL publique : https://team.alteore.com/api/twilio-recording-status
// Configuré dans : TwiML <Dial recordingStatusCallback="..."> (cf. twilio-voice.js)
//
// Payload typique de Twilio :
//   - AccountSid, CallSid, RecordingSid, RecordingUrl, RecordingDuration,
//     RecordingStatus, RecordingChannels, etc.
//
// Même stratégie que twilio-call-status : on écrit dans webhook_inbox et la
// Cloud Function prend le relais pour :
//   1. Télécharger le .mp3 depuis Twilio (via Twilio API avec auth)
//   2. Uploader dans Firebase Storage (call_recordings/{yyyy-mm}/{callSid}.mp3)
//   3. Mettre à jour call_logs.recordingUrl + recordingStatus = "available"
//   4. Déclencher Whisper (transcription) puis Claude (analyse)
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!requireValidSignature(req, res)) return;

  try {
    const payload = req.body || {};

    if (!payload.RecordingSid || !payload.CallSid) {
      console.warn('[twilio-recording-status] Missing RecordingSid or CallSid');
      res.status(200).send('');
      return;
    }

    // On ne traite que les enregistrements "completed" (pas les "in-progress"
    // ou "failed" qui pourraient arriver avec d'autres événements)
    if (payload.RecordingStatus && payload.RecordingStatus !== 'completed') {
      console.log(
        `[twilio-recording-status] Ignoring status=${payload.RecordingStatus}`
      );
      res.status(200).send('');
      return;
    }

    await db.collection('webhook_inbox').add({
      source: 'twilio_recording_ready',
      payload: payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
    });

    res.status(200).send('');
  } catch (err) {
    console.error('[twilio-recording-status] Error:', err);
    res.status(500).json({ error: 'Failed to queue webhook' });
  }
};
