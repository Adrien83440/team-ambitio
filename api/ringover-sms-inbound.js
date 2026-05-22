// api/ringover-sms-inbound.js  (v4 — fetch message API si body absent)
// Format webhook Ringover SMS :
// { event: "received", resource: "sms", timestamp, data: {
//   id, conversation_id, message_id, time, direction,
//   from_number? (string sans +), to_number? (string sans +), body? } }
//
// Si body/from_number absents → fetch via GET /conversations/{convId}/messages

const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');

const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (/^\d{10,}$/.test(c)) return '+' + c; // "33601020304" → "+33601020304"
  return null;
}

function phoneVariants(e164) {
  if (!e164) return [];
  const v = new Set([e164]);
  if (e164.startsWith('+33')) {
    v.add('0' + e164.slice(3));
    v.add('33' + e164.slice(3));
    v.add(e164.slice(3));
  }
  return Array.from(v).filter(Boolean);
}

async function findLead(fromNumber) {
  for (const variant of phoneVariants(fromNumber)) {
    const q = await db.collection('leads').where('telephone', '==', variant).limit(3).get().catch(() => null);
    if (!q || q.empty) continue;
    const docs = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d._merged);
    if (!docs.length) continue;
    docs.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
    return docs[0];
  }
  return null;
}

// Fetch le message depuis l'API Ringover si le webhook ne contient pas le contenu
async function fetchMessageContent(convId, messageId) {
  try {
    const resp = await ringoverFetch(`/conversations/${convId}/messages?limit_count=20`);
    const messages = resp?.message_list || resp?.list || resp?.messages || resp || [];
    const arr = Array.isArray(messages) ? messages : [];
    // Chercher le message par ID
    const msgIdStr = String(messageId);
    const msg = arr.find(m =>
      String(m.message_id) === msgIdStr ||
      String(m.id) === msgIdStr ||
      String(m.msg_id) === msgIdStr
    ) || arr[0]; // fallback : prendre le plus récent

    if (msg) {
      return {
        body:        msg.body || msg.content || msg.text || null,
        from_number: msg.from_number || msg.from || null,
        to_number:   msg.to_number   || msg.to   || null,
        direction:   msg.direction   || null,
        time:        msg.time        || msg.created_at || null,
      };
    }
  } catch (e) {
    console.warn('[ringover-sms-inbound] fetchMessageContent error:', e.message);
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).end();

  try {
    const payload = req.body || {};

    // ── Log complet pour diagnostic ────────────────────────────────────────
    console.log('[ringover-sms-inbound] payload:', JSON.stringify(payload));

    const event = (payload.event || '').toLowerCase();
    const d     = payload.data || {};
    const dir   = (d.direction || '').toLowerCase();

    // Ignorer les SMS sortants
    if (event === 'sent' || dir === 'outbound') {
      console.log('[ringover-sms-inbound] Ignored outbound/sent');
      return;
    }

    // ── Extraire les champs du webhook ─────────────────────────────────────
    let fromRaw   = d.from_number || null;
    let toRaw     = d.to_number   || null;
    let text      = (d.body || d.content || d.text || d.message || '').trim();
    const convId  = d.conversation_id || null;
    const msgId   = d.message_id || null;
    const msgTime = d.time || null;

    // ── Fallback API si body/from_number manquants ─────────────────────────
    if ((!text || !fromRaw) && convId) {
      console.log('[ringover-sms-inbound] body/from_number manquants → fetch API', convId, msgId);
      const fetched = await fetchMessageContent(convId, msgId);
      if (fetched) {
        if (!text)    text    = (fetched.body || '').trim();
        if (!fromRaw) fromRaw = fetched.from_number;
        if (!toRaw)   toRaw   = fetched.to_number;
      }
    }

    const fromNumber = normalizeE164(fromRaw);
    const toNumber   = normalizeE164(toRaw);

    if (!fromNumber || !text) {
      console.warn('[ringover-sms-inbound] Toujours manquant après fallback.',
        'from:', fromRaw, 'body:', text,
        'data keys:', Object.keys(d));
      return;
    }

    console.log('[ringover-sms-inbound] from:', fromNumber, 'to:', toNumber, 'body:', text.substring(0,50));

    // Auto opt-out
    if (OPT_OUT.has(text.toLowerCase())) {
      const lead = await findLead(fromNumber);
      if (lead) {
        await db.collection('leads').doc(lead.id).update({
          smsOptOut: true, smsOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      }
      return;
    }

    const lead = await findLead(fromNumber);

    let ownerUid = null;
    if (toNumber) {
      const numSnap = await db.collection('phone_numbers')
        .where('phoneNumber', '==', toNumber).where('active', '==', true).limit(1).get().catch(() => null);
      if (numSnap && !numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
    }

    const now    = admin.firestore.FieldValue.serverTimestamp();
    // Heure réelle du SMS (timestamp Unix Ringover)
    const smsDate = (msgTime && msgTime > 0) ? new Date(msgTime * 1000) : new Date();
    const nowIso  = smsDate.toISOString();
    const pad     = n => String(n).padStart(2, '0');
    const tlDate  = `${pad(smsDate.getDate())}/${pad(smsDate.getMonth()+1)}/${smsDate.getFullYear()} ${pad(smsDate.getHours())}:${pad(smsDate.getMinutes())}`;

    const commEntry = {
      type: 'sms', direction: 'inbound', content: text, source: 'ringover-sms',
      date: nowIso, createdAt: nowIso, fromNumber, toNumber: toNumber || null,
      providerMessageId: String(msgId || ''),
    };

    if (lead) {
      await db.collection('leads').doc(lead.id).update({
        communications:   admin.firestore.FieldValue.arrayUnion(commEntry),
        timeline_history: admin.firestore.FieldValue.arrayUnion({
          text: '💬 SMS entrant (ringover) — ' + text.substring(0,100),
          date: tlDate, color: '#60a5fa',
        }),
        lastContactAt: now, lastContactType: 'sms', updatedAt: now,
      });
    }

    await db.collection('inbox_notifications').add({
      type: 'sms', direction: 'inbound', fromNumber, toNumber: toNumber || null,
      text,            // champ legacy
      content: text,   // champ lu par inbox-widget.js
      leadId:   lead?.id   || null,
      leadName: lead ? (lead.nom || lead.fullName || null) : null,
      ownerUid, source: 'ringover', providerMessageId: String(msgId || ''),
      read: false, createdAt: now,
    });

    console.log('[ringover-sms-inbound] ✓ notification created, lead:', lead?.id || 'unknown');
  } catch (err) {
    console.error('[ringover-sms-inbound] error:', err.message);
  }
};
