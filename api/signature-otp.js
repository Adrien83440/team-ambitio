// ============================================================================
// api/signature-otp.js — CODE SMS DE SIGNATURE (envoi + vérification)
// ----------------------------------------------------------------------------
// POST /api/signature-otp
//   { action: 'send',   reqId, signerIndex? }  → 200 { ok:true, phoneHint }
//   { action: 'verify', reqId, code }          → 200 { ok:true } | 400 { error }
//
// POURQUOI CET ENDPOINT
// ---------------------
// Le parcours passait par un document webhook_inbox { action:'signature_otp_send' }
// traité par la Cloud Function onWebhookInbox. Cette fonction a ete redeployee
// depuis le repo, dont la copie ne contenait plus les handlers signature : le
// code SMS ne partait plus du tout. On remet la mecanique ici, sur Vercel, qui
// deploie depuis git — donc plus de divergence possible entre le code lu et le
// code execute.
//
// SÉCURITÉ
// --------
// - Endpoint PUBLIC : le signataire n'a pas de compte. C'etait deja le cas avant
//   (le navigateur ecrivait directement dans webhook_inbox). Pas de regression.
// - Le numero de destination vient TOUJOURS du document Firestore, JAMAIS du
//   body : sinon n'importe qui pourrait faire envoyer un SMS a n'importe quel
//   numero depuis notre compte Twilio.
// - Le code ne transite ni ne se stocke dans signature_requests, qui est en
//   `allow read: if true` — il vit dans signature_otp/{reqId}, une collection
//   sans bloc `match` : refus par defaut pour les clients, l'Admin SDK passant
//   outre les rules. Aucune modification de rules necessaire.
// - Plafonds : 5 envois et 8 tentatives par demande, code valable 10 minutes.
//   Au-dela, on refuse — 6 chiffres se brute-forcent en 10^6 essais sinon.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const parseBody = require('./_parseBody');

const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_SENDS = 5;
const MAX_ATTEMPTS = 8;

/* Meme normalisation que api/twilio-sms-send.js (E.164, France par defaut). */
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

/* « •• •• •• 09 » — de quoi verifier qu'on vise le bon telephone sans
   reafficher le numero complet dans une page publique. */
function phoneHint(e164) {
  const d = String(e164 || '').replace(/\D/g, '');
  return d.length >= 2 ? '•• •• •• ' + d.slice(-2) : '';
}

/* Le numero du signataire courant, pris dans le document et nulle part ailleurs. */
function signerPhoneOf(reqData, signerIndex) {
  const signers = Array.isArray(reqData.signers) ? reqData.signers : [];
  const i = Number.isInteger(signerIndex) ? signerIndex : 0;
  if (signers[i] && signers[i].phone) return signers[i].phone;
  if (signers.length && signers[0].phone) return signers[0].phone;
  return reqData.clientPhone || null;
}

function compareCode(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '');
  const reqId = typeof body.reqId === 'string' ? body.reqId.trim() : '';
  if (!reqId) { res.status(400).json({ error: 'reqId requis' }); return; }
  if (action !== 'send' && action !== 'verify') {
    res.status(400).json({ error: 'action doit valoir send ou verify' });
    return;
  }

  try {
    const reqRef = db.collection('signature_requests').doc(reqId);
    const reqSnap = await reqRef.get();
    if (!reqSnap.exists) { res.status(404).json({ error: 'Demande introuvable' }); return; }
    const R = reqSnap.data() || {};
    if (R.status === 'cancelled') { res.status(409).json({ error: 'Cette demande a été annulée.' }); return; }

    const otpRef = db.collection('signature_otp').doc(reqId);

    // ─── ENVOI ─────────────────────────────────────────────────────────────
    if (action === 'send') {
      const signerIndex = Number.isInteger(body.signerIndex) ? body.signerIndex : (R.currentSigner || 0);
      const to = normalizePhone(signerPhoneOf(R, signerIndex));
      if (!to) {
        res.status(400).json({ error: "Aucun numéro de téléphone valide sur cette demande." });
        return;
      }

      const prevSnap = await otpRef.get();
      const prev = prevSnap.exists ? (prevSnap.data() || {}) : {};
      const sends = (prev.sends || 0) + 1;
      if (sends > MAX_SENDS) {
        res.status(429).json({ error: "Trop de demandes de code. Contactez votre conseiller." });
        return;
      }

      const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
      const creds = await getTwilioCreds();
      const smsFrom = creds.smsFromNumber || creds.smsFrom || null;
      if (!smsFrom) {
        console.error('[signature-otp] smsFromNumber absent de _config/telco_credentials.twilio');
        res.status(500).json({ error: "Envoi SMS non configuré." });
        return;
      }

      /* On ecrit le code AVANT d'envoyer : si Twilio repond apres un timeout
         Vercel, le client aura quand meme recu son SMS et le code sera valide. */
      await otpRef.set({
        code,
        signerIndex,
        phone: to,
        sends,
        attempts: 0,
        expiresAt: Date.now() + OTP_TTL_MS,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      const client = await getTwilioClient();
      try {
        await client.messages.create({
          from: smsFrom,
          to,
          body: 'Votre code de signature : ' + code + '\nValable 10 minutes. Ne le communiquez à personne.',
        });
      } catch (twilioErr) {
        console.error('[signature-otp] Twilio error:', twilioErr && twilioErr.message, twilioErr && twilioErr.code);
        res.status(502).json({
          error: "L'envoi du SMS a échoué. Réessayez dans un instant.",
          twilioCode: (twilioErr && twilioErr.code) || null,
        });
        return;
      }

      res.status(200).json({ ok: true, phoneHint: phoneHint(to) });
      return;
    }

    // ─── VÉRIFICATION ──────────────────────────────────────────────────────
    const code = String(body.code || '').replace(/\D/g, '');
    if (code.length !== 6) { res.status(400).json({ error: 'Entrez les 6 chiffres du code.' }); return; }

    const otpSnap = await otpRef.get();
    if (!otpSnap.exists) {
      res.status(400).json({ error: "Aucun code en cours. Demandez un nouveau code." });
      return;
    }
    const O = otpSnap.data() || {};

    const attempts = (O.attempts || 0) + 1;
    await otpRef.set({ attempts }, { merge: true });
    if (attempts > MAX_ATTEMPTS) {
      res.status(429).json({ error: "Trop de tentatives. Demandez un nouveau code." });
      return;
    }
    if (!O.expiresAt || Date.now() > O.expiresAt) {
      res.status(400).json({ error: "Ce code a expiré. Demandez-en un nouveau." });
      return;
    }
    if (!compareCode(O.code, code)) {
      res.status(400).json({ error: "Code incorrect." });
      return;
    }

    /* otpVerified alimente le certificat de signature (sign-certificate.html) :
       on le pose sur la demande, comme le faisait l'ancien traitement. */
    await reqRef.set({
      otpVerified: true,
      otpVerifiedAt: admin.firestore.FieldValue.serverTimestamp(),
      otpVerifiedPhone: O.phone || null,
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'otp_verified',
        date: new Date().toISOString(),
        by: 'signataire',
      }),
    }, { merge: true });

    /* Code consomme : il ne doit plus pouvoir servir. */
    await otpRef.delete().catch((e) => console.error('[signature-otp] purge:', e && e.message));

    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[signature-otp]', e && e.stack ? e.stack : e);
    res.status(500).json({ error: "Erreur serveur. Réessayez." });
  }
};
