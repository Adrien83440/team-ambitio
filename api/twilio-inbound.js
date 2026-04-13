// ==========================================================================
// api/twilio-inbound.js
// --------------------------------------------------------------------------
// Appels entrants sur nos numéros Twilio. Step 7 — Vague 1 du Dialer.
//
// Flow :
// 1. Twilio POST ici quand quelqu'un appelle un de nos numéros (To = notre num)
// 2. On lookup phone_numbers par phoneNumber == To pour trouver assignedTo (UID)
// 3. On lookup leads par phone == From pour pré-attacher le contexte CRM
// 4. On pré-crée call_logs/{callSid} direction='inbound'
// 5. On retourne TwiML <Dial><Client>user_<uid></Client></Dial> qui ring le browser
// 6. Si pas de réponse en 25s, message court et hangup (la VM viendra plus tard)
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

function respondHangup(res, message) {
  const twiml = new VoiceResponse();
  twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' }, message);
  twiml.hangup();
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

// Normalise un numéro pour matcher dans Firestore (E.164 strict)
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  return cleaned;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!requireValidSignature(req, res)) return;

  try {
    const params = req.body || {};
    const callSid = params.CallSid;
    const toNumber = normalizePhone(params.To);
    const fromNumber = normalizePhone(params.From);

    if (!toNumber) {
      return respondHangup(res, "Numéro de destination invalide.");
    }

    // 1. Lookup notre numéro pour trouver le team member assigné
    const numQuery = await db.collection('phone_numbers')
      .where('phoneNumber', '==', toNumber)
      .where('active', '==', true)
      .limit(1)
      .get();

    if (numQuery.empty) {
      return respondHangup(
        res,
        "Bonjour, ce numéro n'est pas attribué actuellement. Merci de nous contacter par un autre moyen."
      );
    }

    const numDoc = numQuery.docs[0];
    const assignedToUid = numDoc.data().assignedTo || null;
    const assignedToSlug = numDoc.data().assignedToSlug || null;

    if (!assignedToUid) {
      return respondHangup(
        res,
        "Bonjour, nos conseillers ne sont pas disponibles pour le moment. Merci de rappeler ultérieurement."
      );
    }

    // 2. Lookup lead par téléphone (best-effort, non-bloquant)
    // Champ canonical : `telephone` (E.164 strict après migration)
    let leadId = null;
    let leadNameSnapshot = null;
    if (fromNumber) {
      try {
        const leadQuery = await db.collection('leads')
          .where('telephone', '==', fromNumber)
          .limit(1)
          .get();
        if (!leadQuery.empty) {
          const ld = leadQuery.docs[0];
          leadId = ld.id;
          const d = ld.data();
          leadNameSnapshot = d.nom || d.name || d.fullName || d.firstName || null;
        }
      } catch (e) { /* non-bloquant */ }
    }

    // 3. Pré-créer call_logs/{callSid}
    if (callSid) {
      await db.collection('call_logs').doc(callSid).set({
        providerCallSid: callSid,
        provider: 'twilio',
        userId: assignedToUid,
        userSlug: assignedToSlug,
        userName: null,
        leadId,
        leadNameSnapshot,
        fromNumber,
        toNumber,
        toNumberId: numDoc.id,
        direction: 'inbound',
        status: 'ringing',
        initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
        recordingStatus: 'pending',
        transcriptionStatus: 'pending',
        aiAnalysisStatus: 'pending',
        disposition: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    // 4. TwiML : ring le browser d'Élodie
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const twiml = new VoiceResponse();
    const dial = twiml.dial({
      callerId: fromNumber || toNumber,
      record: 'record-from-ringing-dual',
      recordingStatusCallback: `${baseUrl}/api/twilio-recording-status`,
      recordingStatusCallbackEvent: 'completed',
      recordingStatusCallbackMethod: 'POST',
      answerOnBridge: true,
      timeout: 25,
      action: `${baseUrl}/api/twilio-inbound-fallback`, // appelé si pas répondu (à créer Vague 2)
    });

    dial.client(
      {
        statusCallback: `${baseUrl}/api/twilio-call-status`,
        statusCallbackEvent: 'initiated ringing answered completed',
        statusCallbackMethod: 'POST',
      },
      `user_${assignedToUid}`
    );

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twiml.toString());
  } catch (err) {
    console.error('[twilio-inbound] Unhandled error:', err);
    respondHangup(res, "Une erreur technique est survenue. Merci de rappeler dans un instant.");
  }
};
