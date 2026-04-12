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
// Les credentials et numéros vivent dans la région Ireland (IE1). Le token
// doit être signé avec region: 'ie1' pour que le SDK browser s'authentifie
// correctement contre le gateway IE1 (sinon AccessTokenInvalid).
// Côté frontend, sales-dialer.js initialise Twilio.Device avec edge:'dublin'
// pour matcher la même région.
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
      { identity, ttl: ttlSeconds, region: 'ie1' }
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
