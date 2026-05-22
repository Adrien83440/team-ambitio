// ============================================================================
// api/ringover-sms-inbound.js
// ----------------------------------------------------------------------------
// Webhook Ringover pour les SMS entrants (réponses des leads).
//
// URL publique : https://team.alteore.com/api/ringover-sms-inbound
// À configurer : Ringover Dashboard → Integrations → Webhooks
//
// Reprend la logique directe de twilio-sms-inbound.js v3 :
//   1. Trouver le lead par phoneVariants
//   2. Écrire dans leads.communications[] + timeline_history[]
//   3. Créer inbox_notifications pour le widget temps réel
//   4. Auto opt-out si STOP
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');

const OPT_OUT_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  return cleaned;
}

function phoneVariants(raw) {
  if (!raw) return [];
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  const variants = new Set([cleaned]);
  if (cleaned.startsWith('+33')) {
    variants.add('0' + cleaned.slice(3));
    variants.add('33' + cleaned.slice(3));
    variants.add(cleaned.slice(3));
  }
  if (cleaned.startsWith('33') && !cleaned.startsWith('+') && cleaned.length >= 11) {
    variants.add('0' + cleaned.slice(2));
    variants.add('+' + cleaned);
  }
  if (cleaned.startsWith('0') && cleaned.length === 10) {
    variants.add('+33' + cleaned.slice(1));
    variants.add('33' + cleaned.slice(1));
  }
  return Array.from(variants).filter(Boolean);
}

async function findBestLeadByPhone(fromNumber) {
  const variants = phoneVariants(fromNumber);
  for (const v of variants) {
    try {
      const q = await db.collection('leads')
        .where('telephone', '==', v)
        .limit(3).get();
      if (!q.empty) {
        const docs = q.docs
          .map(d => ({ id: d.id, ...d.data() }))
          .filter(d => !d._merged);
        if (docs.length === 0) continue;
        docs.sort((a, b) => {
          const aT = a.updatedAt ? (a.updatedAt.toMillis ? a.updatedAt.toMillis() : 0) : 0;
          const bT = b.updatedAt ? (b.updatedAt.toMillis ? b.updatedAt.toMillis() : 0) : 0;
          return bT - aT;
        });
        return docs[0];
      }
    } catch (_) { /* continuer avec le variant suivant */ }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Répondre immédiatement à Ringover
  res.status(200).send('');

  try {
    const payload = req.body || {};

    // Normalisation event
    const event = (payload.event || payload.type || '').toUpperCase();

    // Filtrer : ne traiter que les SMS entrants
    // Ringover envoie SMS_RECEIVED, SMS_INBOUND, ou juste un payload avec text
    const isSmsEvent = event.includes('SMS') || event.includes('MESSAGE') || event.includes('RECEIVED');
    const hasTextContent = !!(payload.text || payload.message || payload.body);
    if (!isSmsEvent && !hasTextContent) {
      console.log('[ringover-sms-inbound] Ignored non-SMS event:', event);
      return;
    }

    const fromNumber = normalizePhone(payload.from_number || payload.from || null);
    const toNumber = normalizePhone(payload.to_number || payload.to || null);
    const text = (payload.text || payload.message || payload.body || '').trim();
    const messageId = payload.message_id || payload.id || null;

    if (!fromNumber || !text) {
      console.warn('[ringover-sms-inbound] Missing fromNumber or text, payload:', JSON.stringify(payload).substring(0, 200));
      return;
    }

    // ─── Auto opt-out ────────────────────────────────────────────────────────
    if (OPT_OUT_KEYWORDS.has(text.toLowerCase())) {
      try {
        const lead = await findBestLeadByPhone(fromNumber);
        if (lead) {
          await db.collection('leads').doc(lead.id).update({
            smsOptOut: true,
            smsOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
          console.log('[ringover-sms-inbound] opt-out lead', lead.id);
        }
      } catch (e) { console.warn('[ringover-sms-inbound] opt-out failed:', e.message); }
      return;
    }

    // ─── Lookup lead ─────────────────────────────────────────────────────────
    const lead = await findBestLeadByPhone(fromNumber);

    // ─── Lookup ownerUid (numéro toNumber assigné dans phone_numbers) ────────
    let ownerUid = null;
    if (toNumber) {
      try {
        const numSnap = await db.collection('phone_numbers')
          .where('phoneNumber', '==', toNumber)
          .where('active', '==', true)
          .limit(1).get();
        if (!numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
      } catch (_) {}
    }

    const nowIso = new Date().toISOString();
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

    const commEntry = {
      type: 'sms',
      direction: 'inbound',
      content: text,
      source: 'ringover-sms',
      date: nowIso,
      createdAt: nowIso,
      fromNumber,
      toNumber: toNumber || null,
      providerMessageId: messageId,
    };

    const timelineEntry = {
      text: '💬 SMS entrant (ringover) — ' + text.substring(0, 100),
      date: tlDate,
      color: '#60a5fa',
    };

    // ─── Écriture directe sur le lead ────────────────────────────────────────
    if (lead) {
      await db.collection('leads').doc(lead.id).update({
        communications: admin.firestore.FieldValue.arrayUnion(commEntry),
        timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
        lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
        lastContactType: 'sms',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    // ─── Inbox notification (widget SMS temps réel) ──────────────────────────
    await db.collection('inbox_notifications').add({
      type: 'sms',
      direction: 'inbound',
      fromNumber,
      toNumber: toNumber || null,
      text,
      leadId: lead ? lead.id : null,
      leadName: lead ? (lead.nom || lead.fullName || null) : null,
      ownerUid,
      source: 'ringover',
      providerMessageId: messageId,
      read: false,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    console.log('[ringover-sms-inbound] processed from:', fromNumber, '→ lead:', lead ? lead.id : 'unknown');
  } catch (err) {
    console.error('[ringover-sms-inbound] Error:', err);
  }
};
