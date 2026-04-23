// ==========================================================================
// api/gocardless-webhook.js
// --------------------------------------------------------------------------
// Reçoit les événements GoCardless (mandate_created, payment_paid_out, etc.)
// Valide la signature HMAC-SHA256, écrit dans webhook_inbox pour traitement
// par la Cloud Function onWebhookInbox.
//
// URL à configurer dans GoCardless Dashboard → Developers → Webhooks :
//   https://team.alteore.com/api/gocardless-webhook
//
// ──── SÉCURITÉ (v2 — 2026-04-22) ─────────────────────────────────────────
// La signature HMAC est calculée par GoCardless sur le RAW BODY original
// (bytes tels qu'envoyés sur le wire). Si on laisse Vercel parser le body en
// JSON avant, `JSON.stringify(req.body)` ne produira JAMAIS le même string
// (ordre des clés, espacement, échappements diffèrent) → la HMAC ne match
// jamais, donc la validation échoue toujours (ou était silencieusement
// bypassée si le secret n'était pas configuré).
//
// Solution v2 :
//   1. `bodyParser: false` (config ci-dessous) → Vercel n'interprète plus
//      le body, on reçoit un stream brut qu'on lit nous-mêmes.
//   2. GOCARDLESS_WEBHOOK_SECRET est OBLIGATOIRE : on refuse la requête
//      si l'env var n'est pas définie (fail-closed). Plus de bypass.
//   3. Comparaison timing-safe avec crypto.timingSafeEqual() pour éviter
//      les attaques par mesure du temps de réponse.
// ==========================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

// ─── Vercel config : bodyParser DÉSACTIVÉ ────────────────────────────────
// Nécessaire pour la validation HMAC : on lit nous-mêmes le stream brut.
const config = {
  api: {
    bodyParser: false,
  },
};

// ─── Helpers ─────────────────────────────────────────────────────────────

/**
 * Lit le raw body d'une requête HTTP Vercel (stream Node.js).
 * Retourne une string UTF-8 (GoCardless envoie du JSON encodé UTF-8).
 */
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        resolve(Buffer.concat(chunks).toString('utf8'));
      } catch (e) {
        reject(e);
      }
    });
    req.on('error', reject);
  });
}

/**
 * Compare deux strings de longueur égale en temps constant.
 * Renvoie false si les longueurs diffèrent (sans crash).
 */
function timingSafeEqualStr(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  // crypto.timingSafeEqual exige des buffers de même longueur
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
  } catch (_) {
    return false;
  }
}

// ─── Handler principal ───────────────────────────────────────────────────
const handler = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).end();
    return;
  }

  // ─── 1. Lire le raw body ───────────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await readRawBody(req);
  } catch (e) {
    console.error('[gocardless-webhook] Failed to read body:', e.message);
    res.status(400).json({ error: 'Could not read body' });
    return;
  }
  if (!rawBody) {
    res.status(400).json({ error: 'Empty body' });
    return;
  }

  // ─── 2. Validation HMAC OBLIGATOIRE ────────────────────────────────────
  // Plus de bypass silencieux : si le secret n'est pas configuré, on refuse.
  const webhookSecret = process.env.GOCARDLESS_WEBHOOK_SECRET;
  if (!webhookSecret) {
    console.error('[gocardless-webhook] FATAL: GOCARDLESS_WEBHOOK_SECRET env var not set');
    res.status(503).json({ error: 'Webhook not configured' });
    return;
  }

  const signature = req.headers['webhook-signature'];
  if (!signature || typeof signature !== 'string') {
    console.warn('[gocardless-webhook] Missing Webhook-Signature header');
    res.status(498).json({ error: 'Missing signature' });
    return;
  }

  const expected = crypto
    .createHmac('sha256', webhookSecret)
    .update(rawBody, 'utf8')
    .digest('hex');

  if (!timingSafeEqualStr(signature, expected)) {
    console.warn('[gocardless-webhook] Invalid signature');
    res.status(498).json({ error: 'Invalid signature' });
    return;
  }

  // ─── 3. Parser le JSON une fois la signature validée ───────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error('[gocardless-webhook] Invalid JSON after signature OK:', e.message);
    res.status(400).json({ error: 'Invalid JSON' });
    return;
  }

  const events = Array.isArray(payload && payload.events) ? payload.events : [];
  if (!events.length) {
    res.status(200).json({ received: 0 });
    return;
  }

  // ─── 4. Récupérer la clé API pour webhook_inbox ───────────────────────
  let apiKey = null;
  try {
    const keyDoc = await db.collection('_config').doc('webhook_keys').get();
    if (keyDoc.exists) apiKey = (keyDoc.data().keys || [])[0] || null;
  } catch (e) {
    console.warn('[gocardless-webhook] Could not load api key:', e.message);
  }

  // ─── 5. Écrire chaque event dans webhook_inbox ─────────────────────────
  const batch = db.batch();
  let count = 0;
  for (const event of events) {
    if (!event || typeof event !== 'object') continue;
    const ref = db.collection('webhook_inbox').doc();
    batch.set(ref, {
      action: 'gocardless_event',
      apiKey,
      gcEventId: event.id || null,
      gcEventType: event.event_type || event.resource_type || null,
      gcAction: event.action || null,
      gcResourceId: event.links ? (
        event.links.mandate || event.links.payment || event.links.subscription || null
      ) : null,
      gcLinks: event.links || {},
      gcDetails: event.details || {},
      gcCreatedAt: event.created_at || null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    count++;
  }

  if (count === 0) {
    res.status(200).json({ received: 0 });
    return;
  }

  try {
    await batch.commit();
    console.log('[gocardless-webhook] ' + count + ' event(s) written to webhook_inbox');
    res.status(200).json({ received: count });
  } catch (e) {
    console.error('[gocardless-webhook] batch error:', e.message);
    res.status(500).json({ error: e.message });
  }
};

// ─── Exports (CommonJS + config Vercel) ─────────────────────────────────
module.exports = handler;
module.exports.config = config;
