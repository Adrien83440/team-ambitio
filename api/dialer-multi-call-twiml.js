// ==========================================================================
// api/dialer-multi-call-twiml.js
// --------------------------------------------------------------------------
// TwiML retourné quand un lead du multi-call décroche : on tente de bridger
// vers le browser de l'utilisateur via <Dial><Client>. Si le user a déjà
// été connecté à un autre lead de la même campagne, on raccroche.
// ==========================================================================

const { db } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

function hangup(res, msg) {
  const t = new VoiceResponse();
  if (msg) t.say({ language: 'fr-FR', voice: 'Polly.Lea' }, msg);
  t.hangup();
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(t.toString());
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!requireValidSignature(req, res)) return;

  try {
    const campaignId = req.query.campaignId;
    const leadId = req.query.leadId;
    const uid = req.query.uid;
    if (!campaignId || !uid) return hangup(res, null);

    // Check campaign : si déjà connectée à un autre leg, on raccroche celui-ci
    const campSnap = await db.collection('dialer_campaigns').doc(campaignId).get();
    if (!campSnap.exists) return hangup(res, null);
    const camp = campSnap.data();

    if (camp.status === 'connected' && camp.connectedLeadId !== leadId) {
      return hangup(res, null); // un autre leg a déjà gagné
    }
    if (camp.status === 'cancelled' || camp.status === 'ended') {
      return hangup(res, null);
    }

    // Bridge vers le browser de l'utilisateur
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const twiml = new VoiceResponse();
    const dial = twiml.dial({
      record: 'record-from-answer-dual',
      recordingStatusCallback: `${baseUrl}/api/twilio-recording-status`,
      recordingStatusCallbackEvent: 'completed',
      recordingStatusCallbackMethod: 'POST',
      answerOnBridge: true,
      timeout: 15,
    });
    dial.client(`user_${uid}`);

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twiml.toString());
  } catch (err) {
    console.error('[multi-call-twiml] error:', err);
    hangup(res, null);
  }
};
