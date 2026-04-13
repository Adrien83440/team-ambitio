// ==========================================================================
// api/twilio-voice.js
// --------------------------------------------------------------------------
// Endpoint principal TwiML appelé par Twilio quand un softphone
// (Twilio.Device côté frontend) initie un appel sortant.
//
// URL publique : https://team.alteore.com/api/twilio-voice
// Configuré dans : Twilio Console > Voice > TwiML App > Voice Request URL
//
// Flow attendu :
// 1. Le softphone appelle device.connect({ To, fromNumberId, leadId, ... })
// 2. Twilio POST ici avec ces paramètres + CallSid + From (identité client)
// 3. On vérifie la signature
// 4. On lit le numéro sortant depuis Firestore (phone_numbers/{fromNumberId})
// 5. On pre-crée un doc call_logs/{callSid} pour que les webhooks status
//    puissent le mettre à jour par la suite
// 6. On retourne un TwiML <Dial> qui bridge vers le prospect avec enregistrement
//
// NOTE IMPORTANTE : On utilise record="record-from-ringing-dual" qui enregistre
// en deux pistes séparées (prospect / closer) ET démarre dès la sonnerie (pas
// à partir du décroché). Ça garantit qu'on ne rate jamais les premières
// secondes de conversation à cause du délai d'établissement audio côté carrier.
// Le .mp3 final contient donc 3-15 sec de sonnerie en début de piste.
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireValidSignature } = require('./_twilioSignature');
const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

// Helper : retourne une réponse TwiML d'erreur en français (Twilio reçoit 200
// avec l'erreur pour éviter qu'il retry en boucle)
function respondWithError(res, message) {
  const twiml = new VoiceResponse();
  twiml.say({ language: 'fr-FR', voice: 'Polly.Lea' }, message);
  twiml.hangup();
  res.setHeader('Content-Type', 'text/xml');
  res.status(200).send(twiml.toString());
}

module.exports = async (req, res) => {
  // Only POST from Twilio
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Security : reject if signature invalid
  if (!requireValidSignature(req, res)) return;

  try {
    const params = req.body || {};

    // Twilio standard params
    const callSid = params.CallSid;
    const fromIdentity = params.From || '';   // ex: "client:user_abc123"

    // Custom params passed by our frontend via device.connect({...})
    const toNumber = params.To;
    const fromNumberId = params.fromNumberId || null;
    const leadId = params.leadId || null;
    const sessionId = params.sessionId || null;

    if (!toNumber) {
      return respondWithError(res, 'Numéro de destination manquant.');
    }

    // Extract the user UID from the Twilio client identity.
    // Our frontend sets identity as "user_<uid>" when generating the access token.
    const clientPrefix = 'client:';
    const rawIdentity = fromIdentity.startsWith(clientPrefix)
      ? fromIdentity.slice(clientPrefix.length)
      : fromIdentity;
    const uid = rawIdentity.replace(/^user_/, '') || null;

    // ------------------------------------------------------------------
    // Résolution du numéro sortant
    // ------------------------------------------------------------------
    let outboundE164 = null;
    let outboundNumberDocId = null;

    if (fromNumberId) {
      const snap = await db.collection('phone_numbers').doc(fromNumberId).get();
      if (snap.exists && snap.data().active !== false) {
        outboundE164 = snap.data().phoneNumber;
        outboundNumberDocId = snap.id;
      }
    }

    // Fallback : prendre le premier numéro actif assigné à ce user
    if (!outboundE164 && uid) {
      const query = await db.collection('phone_numbers')
        .where('assignedTo', '==', uid)
        .where('active', '==', true)
        .limit(1)
        .get();
      if (!query.empty) {
        outboundE164 = query.docs[0].data().phoneNumber;
        outboundNumberDocId = query.docs[0].id;
      }
    }

    if (!outboundE164) {
      return respondWithError(
        res,
        'Aucun numéro sortant configuré pour cet utilisateur. Contactez votre administrateur.'
      );
    }

    // ------------------------------------------------------------------
    // Pre-create the call_logs doc (using CallSid as doc ID for idempotence)
    // ------------------------------------------------------------------
    if (callSid) {
      const callLogRef = db.collection('call_logs').doc(callSid);

      // Try to fetch the lead name snapshot (best effort, non-blocking on failure)
      let leadNameSnapshot = null;
      if (leadId) {
        try {
          const leadSnap = await db.collection('leads').doc(leadId).get();
          if (leadSnap.exists) {
            const ld = leadSnap.data();
            leadNameSnapshot = ld.name || ld.fullName || ld.firstName || null;
          }
        } catch (e) {
          // non-blocking
        }
      }

      await callLogRef.set(
        {
          providerCallSid: callSid,
          provider: 'twilio',
          userId: uid,
          userName: null, // will be filled by webhook handler from users collection
          leadId: leadId,
          leadNameSnapshot: leadNameSnapshot,
          fromNumber: outboundE164,
          fromNumberId: outboundNumberDocId,
          toNumber: toNumber,
          sessionId: sessionId,
          campaignId: null,
          direction: 'outbound',
          status: 'initiated',
          initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
          recordingStatus: 'pending',
          transcriptionStatus: 'pending',
          aiAnalysisStatus: 'pending',
          disposition: null,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // ------------------------------------------------------------------
    // Build TwiML response
    // ------------------------------------------------------------------
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const twiml = new VoiceResponse();
    const dial = twiml.dial({
      callerId: outboundE164,
      record: 'record-from-ringing-dual',
      recordingStatusCallback: `${baseUrl}/api/twilio-recording-status`,
      recordingStatusCallbackEvent: 'completed',
      recordingStatusCallbackMethod: 'POST',
      answerOnBridge: true,
      timeout: 30,
    });

    dial.number(
      {
        statusCallback: `${baseUrl}/api/twilio-call-status`,
        statusCallbackEvent: 'initiated ringing answered completed',
        statusCallbackMethod: 'POST',
      },
      toNumber
    );

    res.setHeader('Content-Type', 'text/xml');
    res.status(200).send(twiml.toString());
  } catch (err) {
    console.error('[twilio-voice] Unhandled error:', err);
    // Return a TwiML error rather than a 500, so Twilio doesn't retry in loop
    respondWithError(res, 'Une erreur technique est survenue. Veuillez réessayer.');
  }
};
