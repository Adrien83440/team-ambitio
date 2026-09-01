// api/ringover-call-initiate.js  (v4 — un poste Ringover par commercial)
// POST /v2/callback : sonne le poste de L'APPELANT → il décroche → Ringover
// compose le numéro du lead.
//
// ⚠️ La clé API Ringover identifie le poste qui sonne. Avec une clé unique
// partagée, TOUT clic sur « Appeler », par qui que ce soit, faisait sonner le
// téléphone du titulaire de cette clé. Depuis l'arrivée de plusieurs setters,
// chaque commercial doit avoir sa propre clé, déclarée dans
// _config/telco_credentials.ringover.users.{firebaseUid}. Faute de quoi on
// REFUSE l'appel avec un message explicite plutôt que de faire sonner
// quelqu'un d'autre.

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth }  = require('./_verifyFirebaseAuth');
const { getRingoverCredsForUser, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

/* Ligne Ringover attribuée à l'utilisateur (admin-numbers.html → « Déclarer un
   numéro Ringover »). Sert à connaître SON ringoverUserId et son numéro. */
async function ligneRingoverDe(uid) {
  try {
    const q = await db.collection('phone_numbers')
      .where('assignedTo', '==', uid)
      .where('provider', '==', 'ringover')
      .where('active', '==', true)
      .limit(1).get();
    if (q.empty) return null;
    const d = q.docs[0].data();
    return { phoneNumber: d.phoneNumber || null, ringoverUserId: d.ringoverUserId ? String(d.ringoverUserId) : null };
  } catch (e) {
    console.warn('[ringover-call-initiate] lookup ligne:', e.message);
    return null;
  }
}

// Ringover exige des entiers sans + (ex: 33688121402)
function toRingoverNumber(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  const digits = c.startsWith('+') ? c.slice(1)
    : c.startsWith('00') ? c.slice(2)
    : c.startsWith('0') && c.length === 10 ? '33' + c.slice(1)
    : c;
  const n = parseInt(digits, 10);
  return isNaN(n) ? null : n;
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
    let phoneE164 = body.phone || null;
    let leadName  = body.leadName || null;

    if (leadId && !phoneE164) {
      const snap = await db.collection('leads').doc(leadId).get();
      if (!snap.exists) return res.status(404).json({ error: 'Lead introuvable' });
      const ld = snap.data();
      phoneE164 = ld.telephone || ld.phone || null;
      if (!leadName) leadName = ld.nom || ld.fullName || null;
    }
    if (!phoneE164) return res.status(400).json({ error: 'Numéro manquant' });

    const toNumber = toRingoverNumber(phoneE164);
    if (!toNumber) return res.status(400).json({ error: `Numéro invalide : ${phoneE164}` });

    const creds = await getRingoverCredsForUser(auth.uid);
    const ligne = await ligneRingoverDe(auth.uid);

    /* ── Garde anti « appel chez le voisin » ───────────────────────────────
       On n'a pas de clé dédiée pour cet utilisateur : l'appel partirait donc
       du poste partagé. Si sa ligne déclarée appartient à un AUTRE poste
       Ringover, composer ici ferait sonner le téléphone de quelqu'un d'autre.
       On refuse, et on lui dit quoi faire. */
    if (!creds.dedicated && ligne && ligne.ringoverUserId
        && creds.userId && String(ligne.ringoverUserId) !== String(creds.userId)) {
      return res.status(409).json({
        error: "Votre poste Ringover n'est pas relié au dialer : lancer l'appel ici "
             + "ferait sonner le téléphone d'un autre commercial. Appelez depuis votre "
             + "application Ringover — l'appel sera rattaché à votre fiche automatiquement. "
             + "(Pour activer le dialer : ajouter la clé API de ce poste dans "
             + "_config/telco_credentials.ringover.users.)",
        code: 'ringover_poste_non_relie',
      });
    }

    // device : APP = app mobile Ringover (le commercial reçoit l'appel sur son mobile)
    const device = creds.device || 'APP';
    // Numéro présenté : celui de l'appelant s'il en a un, sinon la ligne partagée.
    const fromNumber = (ligne && ligne.phoneNumber) || creds.fromNumber;

    // ── Créer le doc campaign AVANT l'appel ──────────────────────────────
    const campRef = db.collection('dialer_campaigns').doc();
    const campDoc = {
      createdBy: auth.uid, assignedUserIds: [auth.uid], userId: auth.uid,
      fromNumber, provider: 'ringover',
      status: 'dialing', leadCount: 1,
      legs: [{ leadId: leadId || null, leadName: leadName || null, phone: phoneE164,
               callId: null, callSid: null, status: 'queuing' }],
      connectedCallId: null, connectedCallSid: null, connectedLeadId: null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    if (autoCampaignId) campDoc.autoCampaignId = autoCampaignId;
    if (Number.isInteger(waveIndex)) campDoc.waveIndex = waveIndex;
    if (Number.isInteger(queueSize)) campDoc.queueSize = queueSize;
    await campRef.set(campDoc);

    // ── Appel Ringover POST /callback ────────────────────────────────────
    // Workflow : Ringover sonne l'app d'Élodie (device:APP)
    //            → elle décroche → Ringover compose to_number
    const ringoverBody = {
      to_number: toNumber,  // entier : 33688121402
      device,               // "APP" | "WEB" | "ALL" | ...
      timeout: 30,
    };
    // from_number optionnel — si Monitoring est activé sur la clé API
    // permet de spécifier depuis quel numéro appeler (sinon Ringover utilise
    // le numéro par défaut du compte Élodie automatiquement)
    if (fromNumber) {
      const fn = toRingoverNumber(fromNumber);
      if (fn) ringoverBody.from_number = fn;
    }

    let ringoverResp;
    try {
      ringoverResp = await ringoverFetch('/callback', { method: 'POST', body: ringoverBody, apiKey: creds.apiKey });
      console.log('[ringover-call-initiate] Response:', JSON.stringify(ringoverResp));
    } catch (ringoverErr) {
      console.error('[ringover-call-initiate] Error:', ringoverErr.message, '| raw:', ringoverErr.rawResponse);
      await campRef.update({
        status: 'cancelled', error: ringoverErr.message,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      return res.status(502).json({ error: ringoverErr.message });
    }

    // call_id est un entier uint64 dans la réponse Ringover
    const callId = ringoverResp
      ? String(ringoverResp.call_id || ringoverResp.channel_id || '')
      : null;
    const callIdClean = callId && callId !== '0' && callId !== '' ? callId : null;

    console.log('[ringover-call-initiate] callId:', callIdClean);

    const updatedLegs = [{ ...campDoc.legs[0], callId: callIdClean, callSid: callIdClean, status: 'initiated' }];
    await campRef.update({ legs: updatedLegs, updatedAt: admin.firestore.FieldValue.serverTimestamp() });

    if (callIdClean) {
      await db.collection('call_logs').doc(callIdClean).set({
        providerCallId: callIdClean, provider: 'ringover',
        userId: auth.uid, campaignId: campRef.id,
        leadId: leadId || null, leadNameSnapshot: leadName || null,
        fromNumber, toNumber: phoneE164,
        direction: 'outbound', status: 'initiated',
        initiatedAt: admin.firestore.FieldValue.serverTimestamp(),
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });
    }

    res.status(200).json({
      campaignId: campRef.id, callId: callIdClean,
      calls: [{ leadId: leadId || null, callId: callIdClean, status: 'initiated' }],
      status: 'initiated',
    });

  } catch (err) {
    console.error('[ringover-call-initiate] error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
