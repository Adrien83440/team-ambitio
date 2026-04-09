// ==========================================================================
// api/twilio-inbound.js
// --------------------------------------------------------------------------
// Stub V1 pour les appels entrants sur nos numéros Twilio.
//
// URL publique : https://team.alteore.com/api/twilio-inbound
// À configurer dans : Twilio Console > Phone Numbers > [numéro] > Voice
//                     > "A call comes in" → Webhook → cette URL
//
// Pourquoi ce stub existe :
// Si on ne configure rien pour les appels entrants, Twilio retourne une
// erreur au prospect qui rappelle un de nos numéros. Avec ce stub, on
// retourne au minimum un message poli en français. L'implémentation complète
// (routing vers le closer ayant appelé en dernier, SVI, etc.) est prévue en
// Vague 2.
// ==========================================================================

const twilio = require('twilio');
const { requireValidSignature } = require('./_twilioSignature');
const VoiceResponse = twilio.twiml.VoiceResponse;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  if (!requireValidSignature(req, res)) return;

  const twiml = new VoiceResponse();
  twiml.say(
    { language: 'fr-FR', voice: 'Polly.Lea' },
    "Bonjour, vous êtes bien en contact avec Ambitio. " +
      "Nos conseillers ne sont pas disponibles pour le moment. " +
      "Merci de nous rappeler ultérieurement."
  );
  twiml.pause({ length: 1 });
  twiml.say(
    { language: 'fr-FR', voice: 'Polly.Lea' },
    "À très bientôt."
  );
  twiml.hangup();

  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
};
