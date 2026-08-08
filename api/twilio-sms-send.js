// ============================================================================
// api/twilio-sms-send.js
// ----------------------------------------------------------------------------
// Envoi d'un SMS depuis le CRM vers un lead.
//
// URL  : POST https://team.alteore.com/api/twilio-sms-send
// Auth : Bearer Firebase ID token (sales ou admin)
// Body : { "leadId": "abc", "message": "Hello Marc..." }
//
// Réponse 200 :
//   {
//     ok: true,
//     messageSid: "SMxxx",
//     leadId: "abc",
//     from: "+33939240397",
//     to: "+33688121402",
//     communicationsIndex: 12
//   }
//
// Flow :
// 1. Vérifie auth (sales/admin)
// 2. Lit le body (parseBody helper tolérant)
// 3. Charge le lead depuis Firestore (vérifie qu'il existe + récupère telephone)
// 4. Lit le numéro d'envoi depuis _config/telco_credentials.twilio.smsFromNumber
//    (peut être un E.164 "+33…" pour un vrai numéro, ou "AdrienEmily" pour un
//    Alphanumeric Sender ID — les deux marchent côté Twilio)
// 5. Envoie via Twilio messages.create()
// 6. Écrit l'entrée dans leads/{id}.communications[] + timeline_history[]
//    (même schéma que Ringover pour que le rendu frontend soit compatible
//    zéro modif)
// 7. Retourne OK au frontend (sync, pas de polling)
//
// Notes :
// - ⚠ CORRECTION (08/08/2026) : ce fichier affirmait que « Twilio garantit que
//   si messages.create() renvoie sans erreur, le SMS est bien envoyé ». C'EST
//   FAUX. Un retour sans erreur signifie seulement que Twilio a ACCEPTÉ le
//   message. La livraison peut échouer ensuite — en France, un envoi depuis un
//   numéro non déclaré est régulièrement filtré par l'opérateur (code 30007),
//   et Twilio ne le signale QUE de façon asynchrone, via statusCallback.
//   Cette croyance a rendu invisible pendant des semaines le problème des
//   codes de signature qui n'arrivaient pas. Voir api/twilio-sms-status.js.
// - On délègue la normalisation E.164 à normalizePhone() avant l'envoi.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const parseBody = require('./_parseBody');

// Normalise un numéro en E.164 FR strict
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  // Si ça commence par 33 sans le +
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // ─── Auth ────────────────────────────────────────────────────────────────
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  // ─── Body validation ─────────────────────────────────────────────────────
  const { leadId, message } = parseBody(req);
  if (!leadId || typeof leadId !== 'string') {
    res.status(400).json({ error: 'leadId requis (string)' });
    return;
  }
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'message requis (string)' });
    return;
  }
  const trimmed = message.trim();
  if (!trimmed) {
    res.status(400).json({ error: 'Le message ne peut pas être vide' });
    return;
  }
  if (trimmed.length > 1530) {
    // Twilio segmente au-delà de 160 chars (GSM-7) ou 70 chars (UCS-2 unicode).
    // 1530 chars = 10 segments max pour éviter de coûter une fortune par erreur.
    res.status(400).json({ error: 'Message trop long (max 1530 caractères, ~10 segments)' });
    return;
  }

  try {
    // ─── Load lead ─────────────────────────────────────────────────────────
    const leadRef = db.collection('leads').doc(leadId);
    const leadSnap = await leadRef.get();
    if (!leadSnap.exists) {
      res.status(404).json({ error: 'Lead introuvable' });
      return;
    }
    const lead = leadSnap.data();

    const toNumber = normalizePhone(lead.telephone);
    if (!toNumber) {
      res.status(400).json({
        error: 'Le lead n\'a pas de téléphone valide (E.164)',
      });
      return;
    }

    // ─── Load SMS "from" identifier ────────────────────────────────────────
    // Peut être soit un vrai numéro E.164 ("+33939240397") soit un
    // Alphanumeric Sender ID ("AdrienEmily"). Les deux sont acceptés par
    // Twilio comme valeur de `from` dans messages.create().
    const creds = await getTwilioCreds();
    const smsFrom = creds.smsFromNumber || creds.smsFrom || null;
    if (!smsFrom) {
      res.status(500).json({
        error:
          'Numéro SMS non configuré. Ajoutez smsFromNumber dans _config/telco_credentials.twilio.',
      });
      return;
    }

    // ─── Resolve sender name (ownerName) from team_members ─────────────────
    // Utilisé pour afficher l'auteur dans la conversation et le timeline.
    let ownerName = auth.userData && (auth.userData.displayName || auth.userData.name)
      ? (auth.userData.displayName || auth.userData.name)
      : null;
    if (!ownerName) {
      try {
        const metaSnap = await db.collection('_meta').doc('team_members').get();
        if (metaSnap.exists) {
          const members = metaSnap.data().members || [];
          const me = members.find(m => m.firebaseUid === auth.uid);
          if (me) ownerName = me.shortName || me.displayName || null;
        }
      } catch (_) { /* non-bloquant */ }
    }
    ownerName = ownerName || auth.email || 'Équipe';

    // ─── Send via Twilio ───────────────────────────────────────────────────
    const client = await getTwilioClient();
    let twilioMsg;
    try {
      twilioMsg = await client.messages.create({
        from: smsFrom,
        to: toNumber,
        body: trimmed,
      });
    } catch (twilioErr) {
      console.error('[twilio-sms-send] Twilio error:', twilioErr);
      // Twilio renvoie des messages d'erreur assez clairs (code + message).
      // On les propage au frontend pour que le closer voit ce qui cloche.
      res.status(502).json({
        error: twilioErr.message || 'Échec de l\'envoi Twilio',
        twilioCode: twilioErr.code || null,
      });
      return;
    }

    // ─── Persist in leads.communications[] + timeline_history[] ────────────
    // Schéma identique à Ringover / onWebhookInbox lead_activity pour que
    // le rendu de sales-contact.html et sales-leads.html marche tel quel.
    const nowIso = new Date().toISOString();
    const commEntry = {
      type: 'sms',
      direction: 'outbound',
      content: trimmed,
      source: 'twilio-sms',
      date: nowIso,
      createdAt: nowIso,
      ownerUid: auth.uid,
      ownerName,
      providerMessageSid: twilioMsg.sid,
      fromNumber: smsFrom,
      toNumber,
    };

    // Format timeline_history : reprend le pattern de Functions/index.js
    // (pad + slash + plain text format avec icône et début du contenu)
    const d = new Date();
    const pad = n => String(n).padStart(2, '0');
    const tlDate = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    const preview = trimmed.substring(0, 100);
    const timelineEntry = {
      text: '💬 SMS sortant (twilio-sms) — ' + preview,
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

    // ─── Success response ──────────────────────────────────────────────────
    res.status(200).json({
      ok: true,
      messageSid: twilioMsg.sid,
      leadId,
      from: smsFrom,
      to: toNumber,
    });
  } catch (err) {
    console.error('[twilio-sms-send] Error:', err);
    res.status(500).json({ error: err.message || 'Internal error' });
  }
};
