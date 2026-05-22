// api/ringover-sms-send.js  (v2 — endpoint /push/sms correct)
const { db, admin } = require('./_firebaseAdmin');
const { requireAuth }  = require('./_verifyFirebaseAuth');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (c.startsWith('33') && c.length >= 11) return '+' + c;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') return res.status(403).json({ error: 'Rôle requis' });

  const { leadId, message } = parseBody(req);
  if (!leadId)  return res.status(400).json({ error: 'leadId requis' });
  if (!message || !message.trim()) return res.status(400).json({ error: 'Message vide' });
  const trimmed = message.trim();

  try {
    const leadSnap = await db.collection('leads').doc(leadId).get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead introuvable' });
    const lead = leadSnap.data();

    const toNumber = normalizeE164(lead.telephone);
    if (!toNumber) return res.status(400).json({ error: 'Lead sans téléphone E.164' });

    const creds = await getRingoverCreds();
    const fromNumber = creds.fromNumber; // E.164 string : "+33755546371"
    if (!fromNumber) return res.status(500).json({ error: 'ringover.fromNumber manquant' });

    // Nom expéditeur (non-bloquant)
    let ownerName = null;
    try {
      const metaSnap = await db.collection('_meta').doc('team_members').get();
      if (metaSnap.exists) {
        const list = Object.values(metaSnap.data().members || {});
        const me = list.find(m => m.firebaseUid === auth.uid);
        if (me) ownerName = me.shortName || me.displayName || null;
      }
    } catch (_) {}

    // POST /push/sms — champs E.164 strings, body.content (pas text)
    let resp;
    try {
      resp = await ringoverFetch('/push/sms', {
        method: 'POST',
        body: {
          from_number: fromNumber,  // E.164 string "+33..."
          to_number:   toNumber,    // E.164 string "+33..."
          content:     trimmed,     // champ "content" (pas "text")
        },
      });
      console.log('[ringover-sms-send] sent:', JSON.stringify(resp));
    } catch (e) {
      console.error('[ringover-sms-send] Ringover error:', e.message, e.rawResponse);
      return res.status(502).json({ error: e.message });
    }

    const now    = admin.firestore.FieldValue.serverTimestamp();
    const smsDate = new Date();
    const nowIso  = smsDate.toISOString();
    const pad     = n => String(n).padStart(2, '0');
    const tlDate  = `${pad(smsDate.getDate())}/${pad(smsDate.getMonth()+1)}/${smsDate.getFullYear()} ${pad(smsDate.getHours())}:${pad(smsDate.getMinutes())}`;

    await db.collection('leads').doc(leadId).update({
      communications: admin.firestore.FieldValue.arrayUnion({
        type: 'sms', direction: 'outbound', content: trimmed,
        source: 'ringover-sms', date: nowIso, createdAt: nowIso,
        ownerUid: auth.uid, ownerName: ownerName || auth.email,
        providerMessageId: String(resp?.message_id || ''),
        fromNumber, toNumber,
      }),
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: '💬 SMS sortant (ringover) — ' + trimmed.substring(0,100),
        date: tlDate, color: '#60a5fa',
      }),
      lastContactAt: now, lastContactType: 'sms', updatedAt: now,
    });

    res.status(200).json({ ok: true, messageId: resp?.message_id || null, from: fromNumber, to: toNumber });
  } catch (err) {
    console.error('[ringover-sms-send] error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
