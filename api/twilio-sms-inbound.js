// ============================================================================
// api/twilio-sms-inbound.js
// ----------------------------------------------------------------------------
// Webhook Twilio pour les SMS entrants (réponses des prospects).
//
// URL  : POST https://team.alteore.com/api/twilio-sms-inbound
//        (à configurer dans Twilio Console → Phone Numbers → ton numéro →
//         Messaging → A message comes in → Webhook POST)
// Auth : Signature Twilio (X-Twilio-Signature) — pas d'auth Firebase
//
// Twilio POST ce webhook avec un body application/x-www-form-urlencoded
// contenant notamment :
//   - MessageSid      → ID unique du SMS entrant (SMxxx)
//   - From            → numéro E.164 de l'expéditeur (le prospect)
//   - To              → notre numéro Twilio (celui configuré dans Console)
//   - Body            → contenu texte du SMS
//   - NumMedia        → "0" en général (on ignore les MMS pour l'instant)
//
// Flow :
// 1. Vérifier signature Twilio (sinon 403)
// 2. Auto opt-out : si Body == "STOP" / "STOPALL" / "UNSUBSCRIBE", marquer
//    le lead smsOptedOut:true et répondre avec un ack Twilio (pas de redispatch
//    parce qu'on veut arrêter toute comm SMS, pas seulement filtrer)
// 3. Pousser un doc dans webhook_inbox avec action='lead_activity' + type='sms'
//    + direction='inbound'. Le handler existant onWebhookInbox (Functions/index.js
//    ligne ~400) sait déjà gérer ce pattern et écrit dans
//    leads.communications[] automatiquement.
// 4. Retourner un TwiML vide (200 OK) pour que Twilio marque le webhook
//    comme consommé (pas de retry).
//
// Pourquoi passer par webhook_inbox plutôt qu'écrire direct dans leads[] ?
// → Cohérence avec Ringover (même chemin = même résultat = un seul bug à
//   debugger si ça casse). Et on bénéficie de la logique findLead() qui
//   gère toutes les variantes de numéros FR.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');
const twilio = require('twilio');
const MessagingResponse = twilio.twiml.MessagingResponse;

// Mots-clés opt-out standard (case-insensitive).
// Twilio gère déjà l'opt-out côté carrier pour certains mots-clés US,
// mais en FR/EU on gère côté app pour être sûr.
const OPT_OUT_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
]);

// Réponse TwiML vide (ack Twilio sans répondre au prospect)
function respondEmpty(res) {
  const twiml = new MessagingResponse();
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

// Réponse TwiML avec un message automatique (pour l'opt-out confirmation)
function respondWithMessage(res, message) {
  const twiml = new MessagingResponse();
  twiml.message(message);
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // ─── Vérification signature Twilio ───────────────────────────────────────
  if (!requireValidSignature(req, res)) return;

  const body = req.body || {};
  const messageSid = body.MessageSid || null;
  const fromNumber = body.From || null;
  const toNumber = body.To || null;
  const smsContent = body.Body || '';

  if (!fromNumber || !smsContent) {
    // Twilio devrait toujours fournir ces champs — si absent, ack quand même
    // pour éviter les retries, mais log pour investigation.
    console.warn('[twilio-sms-inbound] Missing From or Body:', body);
    return respondEmpty(res);
  }

  try {
    // ─── Auto opt-out ───────────────────────────────────────────────────────
    const trimmed = smsContent.trim().toLowerCase();
    if (OPT_OUT_KEYWORDS.has(trimmed)) {
      console.log(`[twilio-sms-inbound] Opt-out from ${fromNumber}`);

      // Lookup le lead par téléphone pour marquer smsOptedOut
      const optoutVariants = phoneVariants(fromNumber);
      for (const v of optoutVariants) {
        const snap = await db.collection('leads')
          .where('telephone', '==', v).limit(1).get();
        if (!snap.empty) {
          await snap.docs[0].ref.update({
            smsOptedOut: true,
            smsOptedOutAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          break;
        }
      }

      // Confirmation automatique (obligatoire en FR/UE)
      return respondWithMessage(
        res,
        'Vous avez été désabonné. Vous ne recevrez plus de SMS de notre part.'
      );
    }

    // ─── Dispatch normal via webhook_inbox ─────────────────────────────────
    // On utilise le pattern existant "lead_activity" que onWebhookInbox
    // (Functions/index.js) sait déjà traiter. Il fait findLead() sur
    // variants + écrit dans leads.communications[] + timeline_history[].
    //
    // Pour que onWebhookInbox reconnaisse et traite, il faut :
    //   - apiKey valide
    //   - action === 'lead_activity'
    //   - data.phone (le numéro du prospect → utilisé pour findLead)
    //   - data.type === 'sms'
    //   - data.direction === 'inbound'
    //   - data.content (le texte du SMS)
    //
    // Structure réelle de _config/webhook_keys observée :
    //   {
    //     default: "wh_xxx",      ← clé racine, utilisée par Make/Ringover
    //     keys: { default: "...", make: "..." }   ← sous-map (legacy?)
    //   }
    // On lit data.default en priorité (celle qui marche en prod), avec
    // fallback sur data.keys.default ou data.keys.make si jamais la clé
    // racine est absente.
    let apiKey = null;
    try {
      const wkSnap = await db.collection('_config').doc('webhook_keys').get();
      if (wkSnap.exists) {
        const data = wkSnap.data() || {};
        const keysMap = (data.keys && typeof data.keys === 'object') ? data.keys : {};
        apiKey = data.default
          || keysMap.default
          || keysMap.make
          || keysMap['twilio-sms']
          || null;
      }
    } catch (e) {
      console.warn('[twilio-sms-inbound] Cannot read webhook_keys:', e.message);
    }

    if (!apiKey) {
      // Si aucune clé n'est définie, on log et on ack pour ne pas perturber
      // Twilio (sinon il va retry). Le SMS est "perdu" côté CRM mais on a
      // au moins le log côté Vercel pour investigation manuelle.
      console.error(
        '[twilio-sms-inbound] No usable apiKey in _config/webhook_keys — SMS dropped:',
        { messageSid, fromNumber, toNumber, preview: smsContent.substring(0, 60) }
      );
      return respondEmpty(res);
    }

    await db.collection('webhook_inbox').add({
      apiKey,
      action: 'lead_activity',
      data: {
        type: 'sms',
        direction: 'inbound',
        content: smsContent,
        phone: fromNumber, // findLead() sait normaliser +33 / 0 / 33
        source: 'twilio-sms',
        date: new Date().toISOString(),
        providerMessageSid: messageSid,
        fromNumber,
        toNumber,
      },
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log(`[twilio-sms-inbound] Queued: ${messageSid} from ${fromNumber}`);

    // Ack Twilio. Pas de réponse automatique — les closers répondront
    // manuellement depuis sales-contact.html.
    return respondEmpty(res);
  } catch (err) {
    console.error('[twilio-sms-inbound] Error:', err);
    // On ack quand même pour éviter les retries infinis Twilio
    return respondEmpty(res);
  }
};

// ─── Helper : variantes d'un numéro FR pour lookup Firestore ────────────────
// Duplique la logique de findLead() dans Functions/index.js. À utiliser ici
// uniquement pour le lookup opt-out (lookup normal passe par webhook_inbox).
function phoneVariants(raw) {
  if (!raw) return [];
  const cleaned = String(raw).replace(/\s+/g, '');
  const variants = new Set();
  variants.add(cleaned);
  if (cleaned.startsWith('+33')) variants.add('0' + cleaned.slice(3));
  if (cleaned.startsWith('33') && cleaned.length >= 11) variants.add('0' + cleaned.slice(2));
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    variants.add('+33' + cleaned.slice(1));
    variants.add('33' + cleaned.slice(1));
  }
  return Array.from(variants);
}
