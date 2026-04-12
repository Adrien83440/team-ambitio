// ==========================================================================
// api/dialer-multi-call.js
// --------------------------------------------------------------------------
// Power dialer : crée N appels Twilio sortants en parallèle (max 5).
// Le premier qui décroche bridge le browser de l'utilisateur, les autres
// sont annulés par dialer-multi-call-status.js.
//
// Body attendu : { leads: [{id, phone, name?}], fromNumberId? }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Réponse : { campaignId, calls: [{leadId, callSid, status}] }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { getTwilioClient } = require('./_twilioClient');
const { requireAuth } = require('./_verifyFirebaseAuth');

function normalizePhone(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  return c;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' });
    return;
  }

  try {
    const { leads, fromNumberId } = req.body || {};
    if (!Array.isArray(leads) || leads.length === 0) {
      res.status(400).json({ error: 'leads requis (array non vide)' });
      return;
    }
    if (leads.length > 5) {
      res.status(400).json({ error: 'Maximum 5 leads par campagne' });
      return;
    }

    // Résolution du numéro sortant (assigné à l'utilisateur)
    let outboundE164 = null;
    let outboundDocId = null;

    if (fromNumberId) {
      const snap = await db.collection('phone_numbers').doc(fromNumberId).get();
      if (snap.exists && snap.data().assignedTo === auth.uid && snap.data().active !== false) {
        outboundE164 = snap.data().phoneNumber;
        outboundDocId = snap.id;
      }
    }
    if (!outboundE164) {
      const q = await db.collection('phone_numbers')
        .where('assignedTo', '==', auth.uid)
        .where('active', '==', true)
        .limit(1).get();
      if (!q.empty) {
        outboundE164 = q.docs[0].data().phoneNumber;
        outboundDocId = q.docs[0].id;
      }
    }
    if (!outboundE164) {
      res.status(400).json({ error: 'Aucun numéro sortant assigné à votre compte' });
      return;
    }

    // Création du doc campaign AVANT les calls (pour que les status callbacks le trouvent)
    const campaignRef = db.collection('dialer_campaigns').doc();
    const campaignId = campaignRef.id;

    await campaignRef.set({
      userId: auth.uid,
      fromNumber: outboundE164,
      fromNumberId: outboundDocId,
      status: 'dialing',
      leadCount: leads.length,
      legs: leads.map(l => ({
        leadId: l.id,
        leadName: l.name || null,
        phone: normalizePhone(l.phone),
        callSid: null,
        status: 'queuing',
      })),
      connectedCallSid: null,
      connectedLeadId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // Création des appels Twilio en parallèle
    const client = await getTwilioClient();
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const callPromises = leads.map(async (lead) => {
      const phone = normalizePhone(lead.phone);
      if (!phone) {
        return { leadId: lead.id, error: 'phone invalide' };
      }
      try {
        const call = await client.calls.create({
          to: phone,
          from: outboundE164,
          url: `${baseUrl}/api/dialer-multi-call-twiml?campaignId=${campaignId}&leadId=${encodeURIComponent(lead.id)}&uid=${auth.uid}`,
          method: 'POST',
          statusCallback: `${baseUrl}/api/dialer-multi-call-status?campaignId=${campaignId}&leadId=${encodeURIComponent(lead.id)}`,
          statusCallbackEvent: ['initiated', 'ringing', 'answered', 'completed'],
          statusCallbackMethod: 'POST',
          timeout: 25,
          record: false, // recording sera activé par le TwiML une fois bridgé
        });
        return { leadId: lead.id, callSid: call.sid, status: 'initiated' };
      } catch (err) {
        console.error('[multi-call] create failed for lead', lead.id, err.message);
        return { leadId: lead.id, error: err.message };
      }
    });

    const results = await Promise.all(callPromises);

    // Update campaign avec les callSids
    const updatedLegs = await campaignRef.get().then(s => s.data().legs);
    results.forEach(r => {
      const leg = updatedLegs.find(l => l.leadId === r.leadId);
      if (leg) {
        if (r.callSid) { leg.callSid = r.callSid; leg.status = 'initiated'; }
        else { leg.status = 'failed'; leg.error = r.error; }
      }
    });
    await campaignRef.update({
      legs: updatedLegs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ campaignId, calls: results });
  } catch (err) {
    console.error('[dialer-multi-call] error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
