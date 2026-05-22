// api/ringover-sms-inbound.js  (v2 — correct payload parsing)
// Ringover SMS format : { event: "received", data: { id, conversation_id, message_id,
//                          from_number, to_number, content, ... } }

const { db, admin } = require('./_firebaseAdmin');

const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

function normalizePhone(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  return null;
}

function phoneVariants(raw) {
  if (!raw) return [];
  const c = String(raw).replace(/[\s\-().]/g, '');
  const v = new Set([c]);
  if (c.startsWith('+33')) { v.add('0' + c.slice(3)); v.add('33' + c.slice(3)); }
  if (c.startsWith('0') && c.length === 10) { v.add('+33' + c.slice(1)); v.add('33' + c.slice(1)); }
  return Array.from(v).filter(Boolean);
}

async function findLead(fromNumber) {
  for (const variant of phoneVariants(fromNumber)) {
    const q = await db.collection('leads').where('telephone', '==', variant).limit(3).get().catch(() => null);
    if (!q || q.empty) continue;
    const docs = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d._merged);
    if (!docs.length) continue;
    docs.sort((a, b) => {
      const at = a.updatedAt?.toMillis?.() || 0;
      const bt = b.updatedAt?.toMillis?.() || 0;
      return bt - at;
    });
    return docs[0];
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).end();

  try {
    const payload = req.body || {};

    // ── Parsing payload Ringover ──────────────────────────────────────────
    // Format : { resource: "sms", event: "received", timestamp, data: { ... } }
    const d          = payload.data || {};
    const event      = (payload.event || d.event || '').toLowerCase();
    const fromNumber = normalizePhone(d.from_number || d.from || payload.from_number || null);
    const toNumber   = normalizePhone(d.to_number   || d.to   || payload.to_number   || null);
    const text       = (d.content || d.text || d.message || d.body || payload.text || '').trim();
    const messageId  = d.id || d.message_id || payload.id || null;

    if (!fromNumber || !text) {
      console.warn('[ringover-sms-inbound] Missing fromNumber or text. data keys:', Object.keys(d));
      return;
    }

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

    const lead   = await findLead(fromNumber);
    let ownerUid = null;
    if (toNumber) {
      const numSnap = await db.collection('phone_numbers')
        .where('phoneNumber', '==', toNumber).where('active', '==', true).limit(1).get().catch(() => null);
      if (numSnap && !numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
    }

    const nowIso = new Date().toISOString();
    const now    = admin.firestore.FieldValue.serverTimestamp();
    const dp     = new Date();
    const pad    = n => String(n).padStart(2, '0');
    const tlDate = `${pad(dp.getDate())}/${pad(dp.getMonth()+1)}/${dp.getFullYear()} ${pad(dp.getHours())}:${pad(dp.getMinutes())}`;

    const commEntry = {
      type: 'sms', direction: 'inbound', content: text, source: 'ringover-sms',
      date: nowIso, createdAt: nowIso, fromNumber, toNumber, providerMessageId: messageId,
    };

    if (lead) {
      await db.collection('leads').doc(lead.id).update({
        communications:   admin.firestore.FieldValue.arrayUnion(commEntry),
        timeline_history: admin.firestore.FieldValue.arrayUnion({ text: '💬 SMS entrant (ringover) — ' + text.substring(0,100), date: tlDate, color: '#60a5fa' }),
        lastContactAt:    now, lastContactType: 'sms',
        updatedAt:        now,
      });
    }

    await db.collection('inbox_notifications').add({
      type: 'sms', direction: 'inbound', fromNumber, toNumber, text,
      leadId: lead?.id || null, leadName: lead ? (lead.nom || lead.fullName || null) : null,
      ownerUid, source: 'ringover', providerMessageId: messageId,
      read: false, createdAt: now,
    });

    console.log('[ringover-sms-inbound] from:', fromNumber, '→ lead:', lead?.id || 'unknown');
  } catch (err) {
    console.error('[ringover-sms-inbound] error:', err.message);
  }
};
