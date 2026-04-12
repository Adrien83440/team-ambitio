// ============================================================================
// api/dialer-voice-token.js
// ----------------------------------------------------------------------------
// Remplace la Cloud Function callable `getTwilioVoiceToken` qui était bloquée
// par l'org policy iam.allowedPolicyMemberDomains sur la Workspace
// adrienemily.com.
//
// URL publique : https://team.alteore.com/api/dialer-voice-token
// Méthode : POST
// Headers requis : Authorization: Bearer <firebase_id_token>
// Body : (vide)
//
// Réponse succès (200) :
//   { token: "eyJ...", identity: "user_<uid>", expiresAt: 1744... }
//
// Réponses erreur :
//   401 — token manquant ou invalide
//   403 — user inconnu dans Firestore
//   500 — erreur serveur (Twilio creds, etc.)
//
// IMPORTANT — Région Twilio :
// Les credentials et numéros vivent dans la région Ireland (IE1) côté REST API,
// MAIS le routing Voice se fait via le realm global Twilio (les TwiML Apps
// vivent en US1 par défaut). Donc on NE met PAS region:'ie1' dans le token
// (paramètre réservé à Chat/Sync/Conversations, pas Voice) et on NE met PAS
// edge sur le Device côté frontend — on laisse le SDK utiliser 'roaming'
// (auto-select) qui est la config qui fonctionnait historiquement.
// ============================================================================
const twilio = require('twilio');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { getTwilioCreds } = require('./_twilioClient');

module.exports = async (req, res) => {
  // Only POST
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Auth requise (tout user authentifié peut demander son propre token)
  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const creds = await getTwilioCreds();
    if (!creds.apiKeySid || !creds.apiKeySecret || !creds.voiceAppSid) {
      throw new Error(
        'telco_credentials incomplete: apiKeySid, apiKeySecret and voiceAppSid are required'
      );
    }

    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;

    const identity = `user_${auth.uid}`;
    const ttlSeconds = 3600; // 1 heure

    const token = new AccessToken(
      creds.accountSid,
      creds.apiKeySid,
      creds.apiKeySecret,
      { identity, ttl: ttlSeconds }
    );

    const voiceGrant = new VoiceGrant({
      outgoingApplicationSid: creds.voiceAppSid,
      incomingAllow: true,
    });
    token.addGrant(voiceGrant);

    res.status(200).json({
      token: token.toJwt(),
      identity,
      expiresAt: Date.now() + ttlSeconds * 1000,
    });
  } catch (err) {
    console.error('[dialer-voice-token] Error:', err);
    res.status(500).json({ error: err.message || 'Token generation failed' });
  }
};
