// ============================================================================
// api/twilio-sms-inbound.js  (v2 — direct write, no Cloud Function dependency)
// ----------------------------------------------------------------------------
// Webhook Twilio pour les SMS entrants (réponses des prospects).
//
// URL  : POST https://team.alteore.com/api/twilio-sms-inbound
//        (configurée dans Twilio Console → numéro → Messaging → Webhook POST)
// Auth : Signature Twilio (X-Twilio-Signature)
//
// Différence avec la v1 :
// - v1 poussait dans webhook_inbox et déléguait à onWebhookInbox (Cloud Function)
// - v2 écrit DIRECTEMENT dans leads.communications[] depuis Vercel
//
// Pourquoi v2 :
// - onWebhookInbox déployée en prod ne correspond pas au code source repo
//   (versions multiples dans /home/contact/Functions/, fonction "fantôme"
//   sans source identifiée). Résultat : "Lead not found" même quand la query
//   marche en local.
// - Cohérence avec twilio-sms-send.js qui écrit aussi en direct.
// - Un seul code path SMS = un seul endroit à debugger.
//
// Flow :
// 1. Vérifier signature Twilio (sinon 403)
// 2. Auto opt-out si Body == STOP/STOPALL/UNSUBSCRIBE/etc
// 3. findBestLeadByPhone : variants exhaustifs + dédoublonnage par activité
// 4. Si trouvé → écrit dans leads/{id}.communications[] + timeline_history[]
// 5. Si non trouvé → log côté Vercel, ack Twilio
// 6. Retour TwiML vide (200 OK) pour ack Twilio
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');
const twilio = require('twilio');
const MessagingResponse = twilio.twiml.MessagingResponse;

const OPT_OUT_KEYWORDS = new Set([
  'stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit',
]);

function respondEmpty(res) {
  const twiml = new MessagingResponse();
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

function respondWithMessage(res, message) {
  const twiml = new MessagingResponse();
  twiml.message(message);
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

// ─── Helper : variantes d'un numéro FR pour lookup Firestore ────────────────
function phoneVariants(raw) {
  if (!raw) return [];
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  const variants = new Set();
  variants.add(cleaned);
  if (cleaned.startsWith('+33')) {
    variants.add('0' + cleaned.slice(3));
    variants.add('33' + cleaned.slice(3));
  }
  if (cleaned.startsWith('33') && !cleaned.startsWith('+') && cleaned.length >= 11) {
    variants.add('0' + cleaned.slice(2));
    variants.add('+' + cleaned);
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    variants.add('+33' + cleaned.slice(1));
    variants.add('33' + cleaned.slice(1));
  }
  return Array.from(variants);
}

// ─── Helper : trouve le meilleur lead pour un téléphone ─────────────────────
// Si plusieurs leads matchent (doublons), priorise celui avec le plus de
// communications, à défaut celui avec lastContactAt le plus récent.
async function findBestLeadByPhone(phone) {
  const variants = phoneVariants(phone);
  const allMatches = [];
  for (const v of variants) {
    const snap = await db.collection('leads').where('telephone', '==', v).get();
    snap.forEach(d => allMatches.push({ id: d.id, data: d.data() }));
  }
  const uniq = {};
  allMatches.forEach(m => { uniq[m.id] = m; });
  const candidates = Object.values(uniq);
  if (candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];
  candidates.sort((a, b) => {
    const aComms = (a.data.communications || []).length;
    const bComms = (b.data.communications || []).length;
    if (bComms !== aComms) return bComms - aComms;
    const aTs = a.data.lastContactAt && a.data.lastContactAt.toMillis ? a.data.lastContactAt.toMillis() : 0;
    const bTs = b.data.lastContactAt && b.data.lastContactAt.toMillis ? b.data.lastContactAt.toMillis() : 0;
    return bTs - aTs;
  });
  console.log('[twilio-sms-inbound] ' + candidates.length + ' leads match phone ' + phone + ', picking ' + candidates[0].id + ' (' + (candidates[0].data.communications || []).length + ' comms)');
  return candidates[0];
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!requireValidSignature(req, res)) return;

  const body = req.body || {};
  const messageSid = body.MessageSid || null;
  const fromNumber = body.From || null;
  const toNumber = body.To || null;
  const smsContent = body.Body || '';

  if (!fromNumber || !smsContent) {
    console.warn('[twilio-sms-inbound] Missing From or Body:', body);
    return respondEmpty(res);
  }

  try {
    const trimmed = smsContent.trim().toLowerCase();
    if (OPT_OUT_KEYWORDS.has(trimmed)) {
      console.log('[twilio-sms-inbound] Opt-out from ' + fromNumber);
      const found = await findBestLeadByPhone(fromNumber);
      if (found) {
        await db.collection('leads').doc(found.id).update({
          smsOptedOut: true,
          smsOptedOutAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return respondWithMessage(
        res,
        'Vous avez été désabonné. Vous ne recevrez plus de SMS de notre part.'
      );
    }

    const found = await findBestLeadByPhone(fromNumber);
    if (!found) {
      console.warn(
        '[twilio-sms-inbound] No lead found for ' + fromNumber + ' — SMS not stored:',
        { messageSid: messageSid, preview: smsContent.substring(0, 80) }
      );
      return respondEmpty(res);
    }

    const nowIso = new Date().toISOString();
    const commEntry = {
      type: 'sms',
      direction: 'inbound',
      content: smsContent,
      source: 'twilio-sms',
      date: nowIso,
      createdAt: nowIso,
      providerMessageSid: messageSid,
      fromNumber: fromNumber,
      toNumber: toNumber,
    };

    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const tlDate = pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
    const preview = smsContent.substring(0, 100);
    const timelineEntry = {
      text: '💬 SMS entrant (twilio-sms) — ' + preview,
      date: tlDate,
      color: '#60a5fa',
    };

    await db.collection('leads').doc(found.id).update({
      communications: admin.firestore.FieldValue.arrayUnion(commEntry),
      timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
      lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
      lastContactType: 'sms',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('[twilio-sms-inbound] ✅ Stored on lead ' + found.id + ' (' + (found.data.nom || 'sans nom') + ')');
    return respondEmpty(res);
  } catch (err) {
    console.error('[twilio-sms-inbound] Error:', err);
    return respondEmpty(res);
  }
};
