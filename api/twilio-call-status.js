// ==========================================================================
// api/twilio-call-status.js
// --------------------------------------------------------------------------
// Reçoit les events de progression d'appel envoyés par Twilio :
//   - initiated, ringing, answered, completed, busy, no-answer, failed, canceled
//
// URL publique : https://team.alteore.com/api/twilio-call-status
//
// Stratégie : on ne traite PAS l'event ici directement. À la place, on écrit
// un doc dans webhook_inbox, et la Cloud Function onWebhookInbox (déjà en
// place dans le projet) prend le relais pour mettre à jour call_logs et
// dialer_sessions.
//
// Cette indirection existe parce que l'organisation Google Workspace
// adrienemily.com bloque allUsers sur les Cloud Functions HTTP. Le pattern
// webhook_inbox (écriture depuis Vercel → trigger Firestore onCreate) est le
// contournement standard déjà utilisé dans le projet pour Ringover, etc.
//
// Avantages du pattern :
//   - Traçabilité complète (chaque webhook est archivé)
//   - Idempotence (retry possible en cas d'erreur de traitement)
//   - Découplage (Vercel répond 200 en <50ms, le traitement async suit)
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

    // Sanity check : on veut au minimum un CallSid
    if (!payload.CallSid) {
      console.warn('[twilio-call-status] Missing CallSid in payload');
      res.status(200).send(''); // Répondre 200 quand même pour que Twilio n'insiste pas
      return;
    }

    await db.collection('webhook_inbox').add({
      source: 'twilio_voice_status',
      payload: payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
    });

    // Twilio n'attend pas de TwiML en retour sur les status callbacks,
    // juste un 200 OK avec body vide.
    res.status(200).send('');
  } catch (err) {
    console.error('[twilio-call-status] Error writing to webhook_inbox:', err);
    // On retourne 500 pour que Twilio retry (comportement souhaité ici, car
    // une erreur Firestore est probablement transitoire)
    res.status(500).json({ error: 'Failed to queue webhook' });
  }
};
