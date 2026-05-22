// ============================================================================
// api/payments-send-mandate-sms.js  (v2 — Ringover)
// ----------------------------------------------------------------------------
// Envoie au client un SMS contenant le lien mandat GoCardless (IBAN).
// Même logique que v1 mais via l'API Ringover au lieu de Twilio.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { ok: true, messageId, from, to }
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
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (!pay.gcBillingRequestFlowUrl) {
      res.status(400).json({ error: "Aucun lien mandat généré — crée-le d'abord" });
      return;
    }

    const toNumber = normalizePhone(pay.leadPhone);
    if (!toNumber) {
      res.status(400).json({ error: 'Numéro de téléphone invalide ou manquant sur le paiement' });
      return;
    }

    const creds = await getRingoverCreds();
    const smsFrom = creds.fromNumber || creds.smsFromNumber;
    if (!smsFrom) {
      res.status(500).json({ error: 'ringover.fromNumber non configuré dans _config/telco_credentials' });
      return;
    }

    // ─── Corps du SMS ────────────────────────────────────────────────────────
    const firstName = String(pay.leadName || 'Bonjour').trim().split(/\s+/)[0];
    const message = `Bonjour ${firstName},\n\nPour finaliser la mise en place de votre prélèvement (${pay.description || 'Programme'}), merci de renseigner votre IBAN via ce lien sécurisé :\n\n${pay.gcBillingRequestFlowUrl}\n\nL'équipe Ambitio`;

    // ─── Nom expéditeur ──────────────────────────────────────────────────────
    let ownerName = null;
    try {
      const metaSnap = await db.collection('_meta').doc('team_members').get();
      if (metaSnap.exists) {
        const raw = metaSnap.data().members || {};
        const list = Array.isArray(raw) ? raw : Object.values(raw);
        const me = list.find(m => m.firebaseUid === auth.uid);
        if (me) ownerName = me.shortName || me.displayName || null;
      }
    } catch (_) { /* non-bloquant */ }
    ownerName = ownerName || auth.email || 'Équipe';

    // ─── Envoi via Ringover ──────────────────────────────────────────────────
    let ringoverResp;
    try {
      ringoverResp = await ringoverFetch('/sms', {
        method: 'POST',
        body: { to_number: toNumber, from_number: smsFrom, text: message },
      });
    } catch (ringoverErr) {
      console.error('[payments-send-mandate-sms] Ringover error:', ringoverErr.message);
      res.status(502).json({ error: ringoverErr.message || "Échec de l'envoi Ringover" });
      return;
    }

    // ─── Log sur le lead (best-effort) ───────────────────────────────────────
    if (pay.leadId) {
      try {
        const nowIso = new Date().toISOString();
        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

        await db.collection('leads').doc(pay.leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion({
            type: 'sms', direction: 'outbound', content: message,
            source: 'ringover-sms', date: nowIso, createdAt: nowIso,
            ownerUid: auth.uid, ownerName,
            providerMessageId: (ringoverResp && (ringoverResp.message_id || ringoverResp.id)) || null,
            fromNumber: smsFrom, toNumber,
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '💬 SMS mandat envoyé (ringover) — ' + message.substring(0, 80),
            date: tlDate, color: '#60a5fa',
          }),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
          lastContactType: 'sms',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (logErr) {
        console.warn('[payments-send-mandate-sms] log lead failed (non-bloquant):', logErr.message);
      }
    }

    res.json({
      ok: true,
      messageId: (ringoverResp && (ringoverResp.message_id || ringoverResp.id)) || null,
      from: smsFrom,
      to: toNumber,
    });

  } catch (e) {
    console.error('[payments-send-mandate-sms]', e.message);
    res.status(500).json({ error: e.message });
  }
};
