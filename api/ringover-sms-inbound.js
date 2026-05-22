// api/ringover-sms-inbound.js  (v3 — format webhook correct)
// Webhook Ringover SMS :
// { event: "received"|"sent", resource: "sms", timestamp, data: {
//   id, message_id, conversation_id, time, direction: "inbound"|"outbound",
//   from_number: "33601020304" (sans +), to_number: "33101020304" (sans +),
//   body: "contenu...", is_internal, is_collaborative, user_id } }

const { db, admin } = require('./_firebaseAdmin');

const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

// Ringover SMS webhooks : numéros sans + → normaliser en E.164
function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  // Format Ringover : "33601020304" → "+33601020304"
  if (/^\d{10,}$/.test(c)) return '+' + c;
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

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();
  res.status(200).end(); // Répondre immédiatement

  try {
    const payload = req.body || {};
    const event   = (payload.event || '').toLowerCase();     // "received" | "sent"
    const d       = payload.data || {};                       // objet imbriqué
    const dir     = (d.direction || '').toLowerCase();        // "inbound" | "outbound"

    // Ne traiter que les SMS entrants
    if (event !== 'received' && dir !== 'inbound') {
      console.log('[ringover-sms-inbound] Ignored event:', event, 'direction:', dir);
      return;
    }

    // Numéros : Ringover envoie "33601020304" → normaliser en "+33601020304"
    const fromNumber = normalizeE164(d.from_number || null);
    const toNumber   = normalizeE164(d.to_number   || null);
    const text       = (d.body || '').trim();   // champ "body" dans le spec
    const messageId  = String(d.message_id || d.id || '');

    if (!fromNumber || !text) {
      console.warn('[ringover-sms-inbound] Missing fromNumber or text.',
        'from:', d.from_number, 'body:', d.body,
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

    // Trouver l'ownerUid via phone_numbers
    let ownerUid = null;
    if (toNumber) {
      const numSnap = await db.collection('phone_numbers')
        .where('phoneNumber', '==', toNumber).where('active', '==', true).limit(1).get().catch(() => null);
      if (numSnap && !numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
    }

    const now    = admin.firestore.FieldValue.serverTimestamp();
    // Utiliser l'heure réelle du SMS (d.time = timestamp Unix Ringover)
    // Fallback sur l'heure courante si absent
    const smsDate = (d.time && d.time > 0) ? new Date(d.time * 1000) : new Date();
    const nowIso = smsDate.toISOString();
    const pad    = n => String(n).padStart(2, '0');
    const tlDate = `${pad(smsDate.getDate())}/${pad(smsDate.getMonth()+1)}/${smsDate.getFullYear()} ${pad(smsDate.getHours())}:${pad(smsDate.getMinutes())}`;

    const commEntry = {
      type: 'sms', direction: 'inbound', content: text, source: 'ringover-sms',
      date: nowIso, createdAt: nowIso, fromNumber, toNumber: toNumber || null,
      providerMessageId: messageId,
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
      text, content: text, leadId: lead?.id || null,
      leadName: lead ? (lead.nom || lead.fullName || null) : null,
      ownerUid, source: 'ringover', providerMessageId: messageId,
      read: false, createdAt: now,
    });

    console.log('[ringover-sms-inbound] ✓ from:', fromNumber, '→ lead:', lead?.id || 'unknown');
  } catch (err) {
    console.error('[ringover-sms-inbound] error:', err.message);
  }
};
