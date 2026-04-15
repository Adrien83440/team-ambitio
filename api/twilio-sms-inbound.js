// ============================================================================
// api/twilio-sms-inbound.js  (v3 — direct write + inbox_notifications)
// ----------------------------------------------------------------------------
// Webhook Twilio pour les SMS entrants (réponses des prospects).
//
// URL  : POST https://team.alteore.com/api/twilio-sms-inbound
//        (configurée dans Twilio Console → numéro → Messaging → Webhook POST)
// Auth : Signature Twilio (X-Twilio-Signature)
//
// v3 ajoute :
//   - lookup phone_numbers par toNumber → récupère assignedTo (ownerUid)
//     pour le filtrage de visibilité dans inbox_notifications
//   - création d'un doc inbox_notifications/{auto} alimentant le widget
//     temps réel des sales (inbox-widget.js)
//
// v2 (rappel) :
// - écrit DIRECTEMENT dans leads.communications[] depuis Vercel
// - court-circuite onWebhookInbox (qui ne matchait pas en prod)
// - cohérent avec twilio-sms-send.js
//
// Flow :
// 1. Vérifier signature Twilio (sinon 403)
// 2. Auto opt-out si Body == STOP/STOPALL/UNSUBSCRIBE/etc
// 3. findBestLeadByPhone : variants exhaustifs + dédoublonnage par activité
// 4. Lookup phone_numbers par toNumber → ownerUid (sales/admin assigné au num)
// 5. Si lead trouvé → écrit dans leads/{id}.communications[] + timeline
// 6. Crée inbox_notifications/{auto} (toujours, même si lead pas trouvé,
//    pour que le sales/admin assigné au numéro soit notifié)
// 7. Retour TwiML vide (200 OK) pour ack Twilio
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

// Normalise un numéro pour matcher dans Firestore (E.164 strict)
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  return cleaned;
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

// ─── Helper : lookup phone_numbers par numéro → assignedTo (uid) ────────────
async function findOwnerByToNumber(toNumber) {
  if (!toNumber) return { ownerUid: null, ownerSlug: null };
  const normalized = normalizePhone(toNumber);
  try {
    const snap = await db.collection('phone_numbers')
      .where('phoneNumber', '==', normalized)
      .where('active', '==', true)
      .limit(1)
      .get();
    if (snap.empty) return { ownerUid: null, ownerSlug: null };
    const data = snap.docs[0].data();
    return {
      ownerUid: data.assignedTo || null,
      ownerSlug: data.assignedToSlug || null,
    };
  } catch (e) {
    console.warn('[twilio-sms-inbound] findOwnerByToNumber error:', e.message);
    return { ownerUid: null, ownerSlug: null };
  }
}

// ─── Helper : crée la notification inbox ────────────────────────────────────
async function createInboxNotification({ type, leadId, leadName, fromNumber, toNumber, preview, ownerUid, ownerSlug, source, providerMessageSid }) {
  try {
    await db.collection('inbox_notifications').add({
      type: type,                                  // 'sms' | 'call' | 'call_missed'
      direction: 'inbound',
      leadId: leadId || null,
      leadName: leadName || null,
      fromNumber: fromNumber || null,
      toNumber: toNumber || null,
      preview: preview ? String(preview).substring(0, 200) : null,
      ownerUid: ownerUid || null,                  // null = visible admins seulement
      ownerSlug: ownerSlug || null,
      source: source || 'unknown',
      providerMessageSid: providerMessageSid || null,
      readBy: {},                                  // map per-user lu/non-lu
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.error('[twilio-sms-inbound] createInboxNotification error:', e);
  }
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
    // 1. Lookup owner du numéro destinataire (qui est assigné à ce numéro Twilio ?)
    const { ownerUid, ownerSlug } = await findOwnerByToNumber(toNumber);

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
        '[twilio-sms-inbound] No lead found for ' + fromNumber + ' — SMS stored as orphan notif:',
        { messageSid: messageSid, preview: smsContent.substring(0, 80) }
      );
      // On crée quand même la notif pour ne pas perdre le SMS côté UI sales
      await createInboxNotification({
        type: 'sms',
        leadId: null,
        leadName: null,
        fromNumber: fromNumber,
        toNumber: toNumber,
        preview: smsContent,
        ownerUid: ownerUid,
        ownerSlug: ownerSlug,
        source: 'twilio-sms',
        providerMessageSid: messageSid,
      });
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

    // 6. Notif inbox (post-écriture lead, pour avoir le leadName à jour)
    await createInboxNotification({
      type: 'sms',
      leadId: found.id,
      leadName: found.data.nom || found.data.name || found.data.fullName || null,
      fromNumber: fromNumber,
      toNumber: toNumber,
      preview: smsContent,
      ownerUid: ownerUid,
      ownerSlug: ownerSlug,
      source: 'twilio-sms',
      providerMessageSid: messageSid,
    });

    console.log('[twilio-sms-inbound] ✅ Stored on lead ' + found.id + ' (' + (found.data.nom || 'sans nom') + ') + inbox notif');
    return respondEmpty(res);
  } catch (err) {
    console.error('[twilio-sms-inbound] Error:', err);
    return respondEmpty(res);
  }
};
