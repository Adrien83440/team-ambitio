// ============================================================================
// api/ringover-call-hangup.js
// ----------------------------------------------------------------------------
// Raccroche un appel Ringover actif depuis l'UI dialer.
//
// URL  : POST /api/ringover-call-hangup
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Body : { campaignId?, callId? }  — au moins l'un des deux requis
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    return res.status(403).json({ error: 'Rôle requis' });
  }

  const { campaignId, callId: bodyCallId } = parseBody(req);
  if (!bodyCallId && !campaignId) {
    return res.status(400).json({ error: 'callId ou campaignId requis' });
  }

  try {
    let resolvedCallId = bodyCallId || null;

    // Résolution depuis le campaign si callId pas fourni directement
    if (!resolvedCallId && campaignId) {
      const campSnap = await db.collection('dialer_campaigns').doc(campaignId).get();
      if (campSnap.exists) {
        const camp = campSnap.data();
        resolvedCallId = camp.connectedCallId
          || (camp.legs && camp.legs[0] && camp.legs[0].callId)
          || null;
      }
    }

    // ─── Raccroche via API Ringover (best-effort, non-bloquant si erreur) ─
    if (resolvedCallId) {
      try {
        await ringoverFetch(`/calls/${resolvedCallId}`, { method: 'DELETE' });
      } catch (e) {
        // L'appel est peut-être déjà terminé — on continue quand même
        console.warn('[ringover-call-hangup] Ringover DELETE failed (may already be ended):', e.message);
      }
    }

    // ─── Update campaign en Firestore ─────────────────────────────────────
    if (campaignId) {
      await db.collection('dialer_campaigns').doc(campaignId).update({
        status: 'cancelled',
        cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    res.status(200).json({ ok: true, callId: resolvedCallId });
  } catch (err) {
    console.error('[ringover-call-hangup] error:', err);
    res.status(500).json({ error: err.message });
  }
};
