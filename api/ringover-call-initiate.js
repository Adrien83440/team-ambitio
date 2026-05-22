// ============================================================================
// api/ringover-call-initiate.js
// ----------------------------------------------------------------------------
// Initie un appel via l'API Ringover (API-initiated click-to-call).
// Ringover sonne l'app d'Élodie → elle décroche → Ringover compose le lead.
//
// URL  : POST /api/ringover-call-initiate
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Body : {
//   leadId?       : string   — résout phone + nom depuis Firestore si phone absent
//   phone?        : string   — numéro E.164 (override leadId si fourni)
//   leadName?     : string
//   autoCampaignId? : string
//   waveIndex?    : number
//   queueSize?    : number
// }
// Réponse : { campaignId, callId, status: 'initiated' }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

function normalizePhone(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (c.startsWith('33') && c.length >= 11) return '+' + c;
  return c;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    return res.status(403).json({ error: 'Rôle sales ou admin requis' });
  }

  try {
    const body = parseBody(req);
    const { leadId, autoCampaignId, waveIndex, queueSize } = body;
    let phone = body.phone ? normalizePhone(body.phone) : null;
    let leadName = body.leadName || null;

    // Résolution depuis le lead Firestore si phone pas fourni directement
    if (leadId && !phone) {
      const leadSnap = await db.collection('leads').doc(leadId).get();
      if (!leadSnap.exists) return res.status(404).json({ error: 'Lead introuvable' });
      const ld = leadSnap.data();
      phone = normalizePhone(ld.telephone || ld.phone);
      if (!leadName) leadName = ld.nom || ld.fullName || null;
    }

    if (!phone) return res.status(400).json({ error: 'Numéro de téléphone manquant ou invalide' });

    const creds = await getRingoverCreds();
    if (!creds.fromNumber) {
      return res.status(500).json({ error: 'ringover.fromNumber non configuré dans _config/telco_credentials' });
    }
    if (!creds.userId) {
      return res.status(500).json({ error: 'ringover.userId non configuré dans _config/telco_credentials' });
    }

    // ─── Créer le doc campaign AVANT l'appel (les webhooks en ont besoin) ─
    const campaignRef = db.collection('dialer_campaigns').doc();
    const campaignId = campaignRef.id;

    const campaignDoc = {
      createdBy: auth.uid,
      assignedUserIds: [auth.uid],
      userId: auth.uid,
      fromNumber: creds.fromNumber,
      provider: 'ringover',
      status: 'dialing',
      leadCount: 1,
      legs: [{
        leadId: leadId || null,
        leadName: leadName || null,
        phone,
        callId: null,
        callSid: null, // compat champ legacy
        status: 'queuing',
      }],
      connectedCallId: null,
      connectedCallSid: null, // compat legacy
      connectedLeadId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (typeof autoCampaignId === 'string' && autoCampaignId.length <= 64) {
      campaignDoc.autoCampaignId = autoCampaignId;
    }
    if (Number.isInteger(waveIndex) && waveIndex >= 0) campaignDoc.waveIndex = waveIndex;
    if (Number.isInteger(queueSize) && queueSize > 0) campaignDoc.queueSize = queueSize;

    await campaignRef.set(campaignDoc);

    // ─── Initier l'appel Ringover ──────────────────────────────────────────
    let ringoverResp;
    try {
      ringoverResp = await ringoverFetch('/calls', {
        method: 'POST',
        body: {
          to_number: phone,
          from_number: creds.fromNumber,
          user_id: Number(creds.userId),
        },
      });
    } catch (ringoverErr) {
      console.error('[ringover-call-initiate] Ringover API error:', ringoverErr.message, ringoverErr.ringoverData);
      await campaignRef.update({
        status: 'cancelled',
        error: ringoverErr.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({
        error: ringoverErr.message || 'Échec appel Ringover',
        ringoverStatus: ringoverErr.status || null,
      });
    }

    // Ringover retourne call_id ou id selon la version de l'API
    const callId = (ringoverResp && (ringoverResp.call_id || ringoverResp.id)) || null;

    // ─── Update leg avec callId ────────────────────────────────────────────
    const updatedLegs = [{
      ...campaignDoc.legs[0],
      callId,
      callSid: callId, // compat legacy (call_logs utilise callSid)
      status: 'initiated',
    }];
    await campaignRef.update({
      legs: updatedLegs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ─── Pré-créer call_logs/{callId} ─────────────────────────────────────
    if (callId) {
      await db.collection('call_logs').doc(callId).set({
        providerCallSid: callId,
        providerCallId: callId,
        provider: 'ringover',
        userId: auth.uid,
        campaignId,
        leadId: leadId || null,
        leadNameSnapshot: leadName || null,
        fromNumber: creds.fromNumber,
        toNumber: phone,
        direction: 'outbound',
        status: 'initiated',
        initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
        recordingStatus: 'pending',
        transcriptionStatus: 'pending',
        aiAnalysisStatus: 'pending',
        disposition: null,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    res.status(200).json({
      campaignId,
      callId,
      calls: [{ leadId: leadId || null, callId, status: 'initiated' }], // compat legacy
      status: 'initiated',
    });
  } catch (err) {
    console.error('[ringover-call-initiate] error:', err);
    res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
