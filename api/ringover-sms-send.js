// ============================================================================
// api/ringover-sms-send.js
// ----------------------------------------------------------------------------
// Envoi d'un SMS à un lead via l'API Ringover.
// Remplace twilio-sms-send.js — même schéma de réponse et de persistance
// dans leads.communications[] pour compatibilité frontend zéro-modif.
//
// URL  : POST /api/ringover-sms-send
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Body : { leadId: string, message: string }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    return res.status(403).json({ error: 'Rôle sales ou admin requis' });
  }

  const { leadId, message } = parseBody(req);
  if (!leadId || typeof leadId !== 'string') return res.status(400).json({ error: 'leadId requis' });
  if (!message || typeof message !== 'string') return res.status(400).json({ error: 'message requis' });
  const trimmed = message.trim();
  if (!trimmed) return res.status(400).json({ error: 'Message vide' });
  if (trimmed.length > 1530) return res.status(400).json({ error: 'Message trop long (max 1530 chars)' });

  try {
    // ─── Charger le lead ────────────────────────────────────────────────────
    const leadRef = db.collection('leads').doc(leadId);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) return res.status(404).json({ error: 'Lead introuvable' });
    const lead = leadSnap.data();

    const toNumber = normalizePhone(lead.telephone);
    if (!toNumber) return res.status(400).json({ error: 'Lead sans téléphone E.164 valide' });

    // ─── Credentials Ringover ───────────────────────────────────────────────
    const creds = await getRingoverCreds();
    const smsFrom = creds.fromNumber || creds.smsFromNumber;
    if (!smsFrom) return res.status(500).json({ error: 'ringover.fromNumber non configuré' });

    // ─── Nom expéditeur ─────────────────────────────────────────────────────
    let ownerName = null;
    try {
      const metaSnap = await db.collection('_meta').doc('team_members').get();
      if (metaSnap.exists) {
        const members = metaSnap.data().members || [];
        const list = Array.isArray(members) ? members : Object.values(members);
        const me = list.find(m => m.firebaseUid === auth.uid);
        if (me) ownerName = me.shortName || me.displayName || null;
      }
    } catch (_) { /* non-bloquant */ }
    ownerName = ownerName || auth.email || 'Équipe';

    // ─── Envoi via Ringover ─────────────────────────────────────────────────
    let ringoverResp;
    try {
      ringoverResp = await ringoverFetch('/sms', {
        method: 'POST',
        body: {
          to_number: toNumber,
          from_number: smsFrom,
          text: trimmed,
        },
      });
    } catch (ringoverErr) {
      console.error('[ringover-sms-send] Ringover error:', ringoverErr.message);
      return res.status(502).json({
        error: ringoverErr.message || 'Échec envoi SMS Ringover',
        ringoverStatus: ringoverErr.status || null,
      });
    }

    const nowIso = new Date().toISOString();
    const commEntry = {
      type: 'sms',
      direction: 'outbound',
      content: trimmed,
      source: 'ringover-sms',
      date: nowIso,
      createdAt: nowIso,
      ownerUid: auth.uid,
      ownerName,
      providerMessageId: (ringoverResp && (ringoverResp.message_id || ringoverResp.id)) || null,
      fromNumber: smsFrom,
      toNumber,
    };

    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const timelineEntry = {
      text: '💬 SMS sortant (ringover) — ' + trimmed.substring(0, 100),
      date: tlDate,
      color: '#60a5fa',
    };

    await leadRef.update({
      communications: admin.firestore.FieldValue.arrayUnion(commEntry),
      timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
      lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
      lastContactType: 'sms',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      ok: true,
      messageId: (ringoverResp && (ringoverResp.message_id || ringoverResp.id)) || null,
      leadId,
      from: smsFrom,
      to: toNumber,
    });
  } catch (err) {
    console.error('[ringover-sms-send] Error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
