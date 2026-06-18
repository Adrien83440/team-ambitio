// api/ringover-sms-inbound.js  (v5 — écritures avant res.end + logs granulaires)
const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');

const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
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

// Retire le préfixe « Message: » / « Message : » que Ringover place parfois en
// tête du corps SMS (artefact du payload, absent du SMS réel). On ne touche
// qu'au tout début de la chaîne et on préserve le reste tel quel.
function cleanSmsText(raw) {
  if (!raw) return '';
  return String(raw).replace(/^\s*message\s*:\s*/i, '').trim();
}

// Idempotence : un même SMS peut arriver via plusieurs webhooks Ringover (ou un
// éventuel scénario Make résiduel). On déduplique sur providerMessageId :
//   - si le lead a déjà une communication avec ce providerMessageId → déjà traité
//   - sinon, si une notif inbox récente porte ce providerMessageId → déjà traité
// Retourne true si le SMS a déjà été enregistré (donc à ignorer).
async function alreadyProcessed(msgId, lead) {
  if (!msgId) return false; // sans identifiant fiable, on ne peut pas dédupliquer ici
  const pid = String(msgId);
  try {
    if (lead && Array.isArray(lead.communications)) {
      if (lead.communications.some(c => c && String(c.providerMessageId || '') === pid)) {
        return true;
      }
    }
    const dup = await db.collection('inbox_notifications')
      .where('providerMessageId', '==', pid)
      .limit(1).get();
    if (!dup.empty) return true;
  } catch (e) {
    console.warn('[sms-inbound] alreadyProcessed check error:', e.message);
  }
  return false;
}

async function findLead(fromNumber) {
  for (const variant of phoneVariants(fromNumber)) {
    try {
      const q = await db.collection('leads').where('telephone', '==', variant).limit(3).get();
      if (q.empty) continue;
      const docs = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d._merged);
      if (!docs.length) continue;
      docs.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
      return docs[0];
    } catch (e) {
      console.warn('[sms-inbound] findLead error:', e.code || e.message);
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // NE PAS répondre immédiatement — faire les écritures Firestore d'abord
  // Ringover attend 200 mais tolère quelques secondes de délai

  try {
    const payload = req.body || {};
    console.log('[sms-inbound] payload reçu, event:', payload.event);

    const event = (payload.event || '').toLowerCase();
    const d     = payload.data || {};
    const dir   = (d.direction || '').toLowerCase();

    if (event === 'sent' || dir === 'outbound') {
      res.status(200).end();
      return;
    }

    // Extraire les champs
    let fromRaw = d.from_number || null;
    let toRaw   = d.to_number   || null;
    let text    = (d.body || d.content || d.text || '').trim();
    const convId  = d.conversation_id || null;
    const msgId   = d.message_id || null;
    const msgTime = d.time || null;

    // Fallback API si body manquant
    if (!text && convId) {
      console.log('[sms-inbound] body absent, fetch API conv:', convId);
      try {
        const resp = await ringoverFetch(`/conversations/${convId}/messages?limit_count=5`);
        const arr  = Array.isArray(resp) ? resp : (resp?.message_list || resp?.list || []);
        const msg  = arr[0];
        if (msg) {
          text    = (msg.body || msg.content || '').trim();
          if (!fromRaw) fromRaw = msg.from_number;
          if (!toRaw)   toRaw   = msg.to_number;
        }
      } catch (e) { console.warn('[sms-inbound] fetch conv error:', e.message); }
    }

    const fromNumber = normalizeE164(fromRaw);
    const toNumber   = normalizeE164(toRaw);

    if (!fromNumber || !text) {
      console.warn('[sms-inbound] Manquant — from:', fromRaw, 'text:', text);
      res.status(200).end();
      return;
    }

    // Nettoyage du préfixe « Message: » avant tout stockage/affichage.
    text = cleanSmsText(text);
    if (!text) { res.status(200).end(); return; }

    console.log('[sms-inbound] from:', fromNumber, 'to:', toNumber, 'body:', text.substring(0,40));

    if (OPT_OUT.has(text.toLowerCase())) {
      const lead = await findLead(fromNumber).catch(() => null);
      if (lead) {
        await db.collection('leads').doc(lead.id).update({
          smsOptOut: true, smsOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
      }
      res.status(200).end();
      return;
    }

    // ── Trouver le lead ────────────────────────────────────────────────────
    console.log('[sms-inbound] findLead...');
    const lead = await findLead(fromNumber).catch(() => null);
    console.log('[sms-inbound] lead:', lead?.id || 'null');

    // Idempotence : si ce SMS (providerMessageId) a déjà été enregistré, on sort
    // sans dupliquer ni en base lead ni en notification inbox.
    if (await alreadyProcessed(msgId, lead)) {
      console.log('[sms-inbound] duplicate ignored, msgId:', String(msgId || ''));
      res.status(200).end();
      return;
    }

    // ── Trouver ownerUid ───────────────────────────────────────────────────
    let ownerUid = null;
    if (toNumber) {
      try {
        const numSnap = await db.collection('phone_numbers')
          .where('phoneNumber', '==', toNumber).where('active', '==', true).limit(1).get();
        if (!numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
        console.log('[sms-inbound] ownerUid:', ownerUid);
      } catch (e) { console.warn('[sms-inbound] ownerUid error:', e.message); }
    }

    const now     = admin.firestore.FieldValue.serverTimestamp();
    const smsDate = (msgTime && msgTime > 0) ? new Date(msgTime * 1000) : new Date();
    const nowIso  = smsDate.toISOString();
    const pad     = n => String(n).padStart(2, '0');
    const tlDate  = `${pad(smsDate.getDate())}/${pad(smsDate.getMonth()+1)}/${smsDate.getFullYear()} ${pad(smsDate.getHours())}:${pad(smsDate.getMinutes())}`;

    // ── Écrire dans leads ──────────────────────────────────────────────────
    if (lead) {
      try {
        await db.collection('leads').doc(lead.id).update({
          communications:   admin.firestore.FieldValue.arrayUnion({
            type: 'sms', direction: 'inbound', content: text, source: 'ringover-sms',
            date: nowIso, createdAt: nowIso, fromNumber, toNumber: toNumber || null,
            providerMessageId: String(msgId || ''),
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '💬 SMS entrant (ringover) — ' + text.substring(0,100),
            date: tlDate, color: '#60a5fa',
          }),
          lastContactAt: now, lastContactType: 'sms', updatedAt: now,
        });
        console.log('[sms-inbound] lead updated');
      } catch (e) { console.warn('[sms-inbound] lead update error:', e.message); }
    }

    // ── Créer notification inbox ────────────────────────────────────────────
    console.log('[sms-inbound] creating notification...');
    try {
      const docRef = await db.collection('inbox_notifications').add({
        type: 'sms', direction: 'inbound',
        fromNumber, toNumber: toNumber || null,
        text, content: text,
        leadId:   lead?.id   || null,
        leadName: lead ? (lead.nom || lead.fullName || null) : null,
        ownerUid, source: 'ringover',
        providerMessageId: String(msgId || ''),
        read: false, createdAt: now,
      });
      console.log('[sms-inbound] ✓ notification created:', docRef.id);
    } catch (e) {
      console.error('[sms-inbound] notification ERROR:', e.code, e.message);
    }

    res.status(200).end();

  } catch (err) {
    console.error('[sms-inbound] FATAL:', err.message);
    res.status(200).end(); // toujours 200 pour Ringover
  }
};
