// ============================================================================
// api/ringover-call-status.js
// ----------------------------------------------------------------------------
// Webhook Ringover pour les événements d'appel (ringing, answered, hangup, missed).
//
// URL publique : https://team.alteore.com/api/ringover-call-status
// À configurer : Ringover Dashboard → Integrations → Webhooks
//
// Pattern : répondre 200 immédiatement → écrire dans webhook_inbox →
// Cloud Function onWebhookInbox met à jour call_logs + dialer_campaigns.
//
// Payload Ringover typique :
// {
//   event: "ANSWERED" | "RINGING" | "HANGUP" | "MISSED",
//   call_id: "xxx",
//   from_number: "+33755546371",
//   to_number: "+33600000000",
//   user_id: 22855712,
//   direction: "OUTBOUND",
//   start_time: 1234567890,       // epoch ms ou s selon version API
//   answered_time: 1234567890,
//   end_time: 1234567890,
//   duration_secs: 65,
//   recording: { available: true, url: "https://..." }
// }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Répondre immédiatement à Ringover (évite les retries sur timeout)
  res.status(200).send('');

  try {
    const payload = req.body || {};

    // Normalisation event (Ringover peut envoyer en majuscules ou minuscules)
    const event = (payload.event || payload.type || '').toUpperCase();
    const callId = payload.call_id || payload.id || null;

    if (!event && !callId) {
      console.warn('[ringover-call-status] Payload vide ou non reconnu:', JSON.stringify(payload).substring(0, 300));
      return;
    }

    // Log complet dans webhook_inbox → Cloud Function gère le reste
    await db.collection('webhook_inbox').add({
      source: 'ringover_call_status',
      payload,
      event,
      callId,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
    });

    console.log('[ringover-call-status] queued', event, callId);
  } catch (err) {
    console.error('[ringover-call-status] Error writing webhook_inbox:', err);
  }
};
