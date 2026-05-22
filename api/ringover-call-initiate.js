// api/ringover-call-initiate.js  (v2 — endpoint /v2/callbacks)
// Ringover click-to-call : sonne l'app de l'agent → elle décroche → Ringover compose le lead

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth }  = require('./_verifyFirebaseAuth');
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
    let phone    = body.phone ? normalizePhone(body.phone) : null;
    let leadName = body.leadName || null;

    if (leadId && !phone) {
      const snap = await db.collection('leads').doc(leadId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Lead introuvable' });
      const ld = snap.data();
      phone    = normalizePhone(ld.telephone || ld.phone);
      if (!leadName) leadName = ld.nom || ld.fullName || null;
    }
    if (!phone) return res.status(400).json({ error: 'Numéro manquant ou invalide' });

    const creds = await getRingoverCreds();
    if (!creds.fromNumber) return res.status(500).json({ error: 'ringover.fromNumber manquant' });
    if (!creds.userId)     return res.status(500).json({ error: 'ringover.userId manquant' });

    // ── Créer le doc campaign AVANT l'appel ────────────────────────────────
    const campRef = db.collection('dialer_campaigns').doc();
    const campDoc = {
      createdBy:       auth.uid,
      assignedUserIds: [auth.uid],
      userId:          auth.uid,
      fromNumber:      creds.fromNumber,
      provider:        'ringover',
      status:          'dialing',
      leadCount:       1,
      legs: [{
        leadId:   leadId || null,
        leadName: leadName || null,
        phone,
        callId:   null,
        callSid:  null,
        status:   'queuing',
      }],
      connectedCallId:  null,
      connectedCallSid: null,
      connectedLeadId:  null,
      createdAt:        admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:        admin.firestore.FieldValue.serverTimestamp(),
    };
    if (autoCampaignId) campDoc.autoCampaignId = autoCampaignId;
    if (Number.isInteger(waveIndex)) campDoc.waveIndex = waveIndex;
    if (Number.isInteger(queueSize)) campDoc.queueSize = queueSize;
    await campRef.set(campDoc);

    // ── Appel Ringover via /v2/callbacks (click-to-call) ──────────────────
    // Fonctionnement : Ringover sonne l'app de l'agent (user_id)
    // → agent décroche → Ringover compose to_number
    let ringoverResp;
    try {
      ringoverResp = await ringoverFetch('/callbacks', {
        method: 'POST',
        body: {
          to_number:   phone,
          from_number: creds.fromNumber,
          user_id:     Number(creds.userId),
        },
      });
      console.log('[ringover-call-initiate] Ringover response:', JSON.stringify(ringoverResp));
    } catch (ringoverErr) {
      console.error('[ringover-call-initiate] Ringover error:', ringoverErr.message, '| raw:', ringoverErr.rawResponse);
      await campRef.update({
        status: 'cancelled',
        error:  ringoverErr.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({ error: ringoverErr.message || 'Échec Ringover' });
    }

    // Extraire le callId depuis la réponse Ringover
    // Ringover peut retourner : { call_id, id, callback_id, ... }
    const callId = ringoverResp
      ? (ringoverResp.call_id || ringoverResp.id || ringoverResp.callback_id || ringoverResp.callId || null)
      : null;

    console.log('[ringover-call-initiate] callId extrait:', callId, '| keys:', ringoverResp ? Object.keys(ringoverResp) : 'null');

    // ── Update leg avec callId ─────────────────────────────────────────────
    const updatedLegs = [{
      ...campDoc.legs[0],
      callId,
      callSid:  callId,
      status:   'initiated',
    }];
    await campRef.update({
      legs:      updatedLegs,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ── Pré-créer call_logs si on a un callId ────────────────────────────
    if (callId) {
      await db.collection('call_logs').doc(callId).set({
        providerCallId:    callId,
        providerCallSid:   callId,
        provider:          'ringover',
        userId:            auth.uid,
        campaignId:        campRef.id,
        leadId:            leadId || null,
        leadNameSnapshot:  leadName || null,
        fromNumber:        creds.fromNumber,
        toNumber:          phone,
        direction:         'outbound',
        status:            'initiated',
        initiatedAt:       admin.firestore.FieldValue.serverTimestamp(),
        recordingStatus:   'pending',
        createdAt:         admin.firestore.FieldValue.serverTimestamp(),
        updatedAt:         admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    res.status(200).json({
      campaignId: campRef.id,
      callId,
      calls:  [{ leadId: leadId || null, callId, status: 'initiated' }],
      status: 'initiated',
    });

  } catch (err) {
    console.error('[ringover-call-initiate] error:', err.message);
    res.status(500).json({ error: err.message || 'Erreur interne' });
  }
};
