// ==========================================================================
// api/gocardless-webhook.js
// --------------------------------------------------------------------------
// Reçoit les événements GoCardless (mandate_created, payment_paid_out, etc.)
// Valide la signature HMAC-SHA256, écrit dans webhook_inbox pour traitement
// par la Cloud Function onWebhookInbox.
//
// URL à configurer dans GoCardless Dashboard → Developers → Webhooks :
//   https://team.alteore.com/api/gocardless-webhook
// ==========================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).end(); return; }

  // Lire le body brut (Vercel le parse pas automatiquement pour les webhooks)
  let rawBody = '';
  try {
    rawBody = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  } catch (e) {
    res.status(400).json({ error: 'Invalid body' }); return;
  }

  // Valider la signature GoCardless
  const webhookSecret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = req.headers['webhook-signature'];
    if (!signature) {
      console.warn('[gocardless-webhook] Missing Webhook-Signature header');
      res.status(498).json({ error: 'Missing signature' }); return;
    }
    const expected = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');
    if (signature !== expected) {
      console.warn('[gocardless-webhook] Invalid signature');
      res.status(498).json({ error: 'Invalid signature' }); return;
    }
  }

  let payload;
  try {
    payload = typeof req.body === 'object' ? req.body : JSON.parse(rawBody);
  } catch (e) {
    res.status(400).json({ error: 'Invalid JSON' }); return;
  }

  const events = payload.events || [];
  if (!events.length) { res.status(200).json({ received: 0 }); return; }

  // Récupérer la clé API pour webhook_inbox
  let apiKey = null;
  try {
    const keyDoc = await db.collection('_config').doc('webhook_keys').get();
    if (keyDoc.exists) apiKey = (keyDoc.data().keys || [])[0] || null;
  } catch (e) { console.warn('[gocardless-webhook] Could not load api key:', e.message); }

  // Écrire chaque event dans webhook_inbox
  const batch = db.batch();
  let count = 0;
  for (const event of events) {
    const ref = db.collection('webhook_inbox').doc();
    batch.set(ref, {
      action: 'gocardless_event',
      apiKey,
      gcEventId: event.id,
      gcEventType: event.event_type || event.resource_type,
      gcAction: event.action,
      gcResourceId: event.links ? (
        event.links.mandate || event.links.payment || event.links.subscription || null
      ) : null,
      gcLinks: event.links || {},
      gcDetails: event.details || {},
      gcCreatedAt: event.created_at || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    count++;
  }

  try {
    await batch.commit();
    console.log(`[gocardless-webhook] ${count} event(s) written to webhook_inbox`);
    res.status(200).json({ received: count });
  } catch (e) {
    console.error('[gocardless-webhook] batch error:', e.message);
    res.status(500).json({ error: e.message });
  }
};
