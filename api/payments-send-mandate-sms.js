// ==========================================================================
// api/payments-send-mandate-sms.js
// --------------------------------------------------------------------------
// Envoie au client un SMS contenant le lien mandat GoCardless (IBAN).
//
// Symétrique à payments-send-mandate-email. Contrairement à twilio-sms-send
// qui exige un leadId (source de vérité = fiche lead), ici on travaille au
// niveau du doc payment : le téléphone vient directement de pay.leadPhone
// et le leadId n'est pas requis (le paiement peut avoir été créé en saisie
// manuelle sans lien avec un lead). Si leadId existe, on logge quand même
// la communication sur la fiche pour le tracking.
//
// Body : { paymentId }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { ok: true, messageSid, from, to }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
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

    // ─── Load payment ───
    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) {
      res.status(403).json({ error: 'Accès non autorisé à ce paiement' });
      return;
    }
    if (!pay.gcBillingRequestFlowUrl) {
      res.status(400).json({ error: 'Aucun lien mandat généré — crée-le d\'abord' });
      return;
    }

    const toNumber = normalizePhone(pay.leadPhone);
    if (!toNumber) {
      res.status(400).json({ error: 'Numéro de téléphone invalide ou manquant sur le paiement' });
      return;
    }

    // ─── Load SMS "from" ───
    // Pour les SMS mandat on préfère un Sender ID alphanumérique
    // ("AdrienEmily") plutôt que le numéro 2-way : meilleure reconnaissance
    // côté destinataire, moins de risque spam. Ordre de résolution :
    //   1. smsMandateFrom   → override spécifique mandat (si un jour on
    //                         veut dissocier du Sender ID signature OTP)
    //   2. smsSignatureFrom → Sender ID partagé ("adrienemily") déjà en
    //                         place pour les OTP → réutilisé par défaut
    //   3. smsFromNumber    → numéro 2-way fallback (+33939240397)
    const creds = await getTwilioCreds();
    const smsFrom = creds.smsMandateFrom || creds.smsSignatureFrom || creds.smsFromNumber || creds.smsFrom || null;
    if (!smsFrom) {
      res.status(500).json({
        error: 'Aucun expéditeur SMS configuré (smsMandateFrom / smsSignatureFrom / smsFromNumber manquants dans _config/telco_credentials.twilio).'
      });
      return;
    }

    // ─── Build SMS body ───
    const firstName = String(pay.leadName || 'Bonjour').trim().split(/\s+/)[0];
    const message = `Bonjour ${firstName},\n\nPour finaliser la mise en place de votre prélèvement (${pay.description || 'Programme'}), merci de renseigner votre IBAN via ce lien sécurisé :\n\n${pay.gcBillingRequestFlowUrl}\n\nL'équipe Ambitio`;

    // ─── Resolve ownerName ───
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

    // ─── Send via Twilio ───
    const client = await getTwilioClient();
    let twilioMsg;
    try {
      twilioMsg = await client.messages.create({
        from: smsFrom,
        to: toNumber,
        body: message
      });
    } catch (twilioErr) {
      console.error('[payments-send-mandate-sms] Twilio error:', twilioErr);
      res.status(502).json({
        error: twilioErr.message || 'Échec de l\'envoi Twilio',
        twilioCode: twilioErr.code || null
      });
      return;
    }

    // ─── Log sur le lead SI leadId présent (best-effort, non bloquant) ───
    if (pay.leadId) {
      try {
        const nowIso = new Date().toISOString();
        const commEntry = {
          type: 'sms',
          direction: 'outbound',
          content: message,
          source: 'twilio-sms',
          date: nowIso,
          createdAt: nowIso,
          ownerUid: auth.uid,
          ownerName,
          providerMessageSid: twilioMsg.sid,
          fromNumber: smsFrom,
          toNumber
        };

        const d = new Date();
        const pad = n => String(n).padStart(2, '0');
        const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const timelineEntry = {
          text: '💬 SMS mandat envoyé — ' + message.substring(0, 100),
          date: tlDate,
          color: '#60a5fa'
        };

        await db.collection('leads').doc(pay.leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion(commEntry),
          timeline_history: admin.firestore.FieldValue.arrayUnion(timelineEntry),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(),
          lastContactType: 'sms',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      } catch (logErr) {
        console.warn('[payments-send-mandate-sms] log lead failed (non-bloquant):', logErr.message);
      }
    }

    console.log('[payments-send-mandate-sms] ✅ sent', {
      paymentId,
      to: toNumber,
      from: smsFrom,
      messageSid: twilioMsg.sid
    });

    res.json({
      ok: true,
      messageSid: twilioMsg.sid,
      from: smsFrom,
      to: toNumber
    });

  } catch (e) {
    console.error('[payments-send-mandate-sms]', e.message);
    res.status(500).json({ error: e.message });
  }
};
