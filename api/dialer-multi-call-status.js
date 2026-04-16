// ==========================================================================
// api/dialer-multi-call-status.js
// --------------------------------------------------------------------------
// Status callback dédié aux appels d'une campagne multi-call.
// Logique critique : dès qu'un appel passe en 'in-progress' (= bridgé avec
// le browser), on annule SYNCHRONEMENT les autres legs via Twilio REST.
// On pousse aussi le payload dans webhook_inbox pour que la Cloud Function
// existante mette à jour call_logs comme pour un appel normal.
//
// Pour les statuts terminaux 'no-answer', 'busy', 'failed' : on incrémente
// dialer_attempts sur le doc lead correspondant.
// Pour le leg 'connecté' qui passe 'completed' : on incrémente AUSSI
// dialer_attempts (un pitch téléphonique est bien une tentative, même
// réussie). Cela permet au CRM de refléter correctement le fait que ce
// lead a été contacté.
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { getTwilioClient } = require('./_twilioClient');
const { requireValidSignature } = require('./_twilioSignature');

// Helper : incrémente dialer_attempts + pose last_attempt/last_status
async function bumpLeadAttempts(leadId, callStatus) {
  if (!leadId) return;
  try {
    await db.collection('leads').doc(leadId).update({
      dialer_attempts: admin.firestore.FieldValue.increment(1),
      dialer_last_attempt: admin.firestore.FieldValue.serverTimestamp(),
      dialer_last_status: callStatus,
    });
  } catch (e) {
    console.warn('[mc-status] bumpLeadAttempts failed:', leadId, e.message);
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  if (!requireValidSignature(req, res)) return;

  // Toujours répondre vite à Twilio (200 immédiat puis traitement async ne marche pas
  // ici car on doit cancel les autres calls AVANT de répondre — sinon ils ringent
  // pour rien plusieurs secondes de plus). On accepte donc une latence de 200-400ms.

  const payload = req.body || {};
  const callSid = payload.CallSid;
  const callStatus = payload.CallStatus;
  const campaignId = req.query.campaignId;
  const leadId = req.query.leadId;

  if (!callSid || !campaignId) {
    res.status(200).send('');
    return;
  }

  try {
    // Push dans webhook_inbox pour traitement call_logs (fire and forget)
    db.collection('webhook_inbox').add({
      source: 'twilio_voice_status',
      payload,
      receivedAt: admin.firestore.FieldValue.serverTimestamp(),
      processed: false,
      campaignContext: { campaignId, leadId },
    }).catch(e => console.warn('[mc-status] webhook_inbox push failed:', e.message));

    const campRef = db.collection('dialer_campaigns').doc(campaignId);
    const campSnap = await campRef.get();
    if (!campSnap.exists) {
      res.status(200).send('');
      return;
    }
    const camp = campSnap.data();

    // Update du leg correspondant
    const legs = camp.legs || [];
    const legIdx = legs.findIndex(l => l.callSid === callSid || l.leadId === leadId);
    if (legIdx === -1) {
      res.status(200).send('');
      return;
    }
    legs[legIdx].status = callStatus;
    legs[legIdx].lastUpdate = new Date().toISOString();

    // Cas 1 : un leg passe in-progress (bridgé) → on cancel les autres
    if (callStatus === 'in-progress' && camp.status === 'dialing') {
      const client = await getTwilioClient();
      const otherLegs = legs.filter((l, i) => i !== legIdx && l.callSid && !['completed','canceled','no-answer','busy','failed'].includes(l.status));

      // Cancel en parallèle, on n'attend pas le résultat individuellement
      await Promise.allSettled(otherLegs.map(l =>
        client.calls(l.callSid).update({ status: 'canceled' }).catch(e => {
          console.warn('[mc-status] cancel failed for', l.callSid, e.message);
        })
      ));
      otherLegs.forEach(l => { l.status = 'canceled'; });

      // Les legs cancel par la logique "autre a gagné" comptent comme tentés :
      // on bump dialer_attempts pour chacun d'eux (fire and forget).
      otherLegs.forEach(l => { bumpLeadAttempts(l.leadId, 'canceled'); });

      await campRef.update({
        legs,
        status: 'connected',
        connectedCallSid: callSid,
        connectedLeadId: legs[legIdx].leadId,
        connectedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    // Cas 2 : statut terminal non répondu → incrémenter dialer_attempts du lead
    else if (['no-answer', 'busy', 'failed'].includes(callStatus)) {
      const lead = legs[legIdx];
      await bumpLeadAttempts(lead.leadId, callStatus);
      await campRef.update({
        legs,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Si tous les legs sont terminés et aucun connecté → status='ended'
      const allDone = legs.every(l => ['completed','canceled','no-answer','busy','failed'].includes(l.status));
      if (allDone && camp.status === 'dialing') {
        await campRef.update({ status: 'ended', endedAt: admin.firestore.FieldValue.serverTimestamp() });
      }
    }
    // Cas 3 : completed sur le leg connecté → fin de campagne propre
    //         + incrément dialer_attempts (conversation = tentative réussie)
    else if (callStatus === 'completed' && camp.connectedCallSid === callSid) {
      const connectedLead = legs[legIdx];
      await bumpLeadAttempts(connectedLead.leadId, 'answered');
      await campRef.update({
        legs,
        status: 'ended',
        endedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }
    else {
      // Update simple du leg (ringing, initiated, etc.)
      await campRef.update({ legs, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
    }

    res.status(200).send('');
  } catch (err) {
    console.error('[mc-status] error:', err);
    res.status(200).send(''); // toujours 200 pour éviter retry Twilio
  }
};
