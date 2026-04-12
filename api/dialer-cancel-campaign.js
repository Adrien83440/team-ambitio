// ==========================================================================
// api/dialer-cancel-campaign.js
// --------------------------------------------------------------------------
// Annule manuellement une campagne multi-call en cours.
// Le createdBy ou un admin peut annuler. Cancel tous les legs Twilio actifs
// puis update le doc dialer_campaigns en status='cancelled'.
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { getTwilioClient } = require('./_twilioClient');
const { requireAuth } = require('./_verifyFirebaseAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  try {
    const { campaignId } = req.body || {};
    if (!campaignId) {
      res.status(400).json({ error: 'campaignId requis' });
      return;
    }

    const ref = db.collection('dialer_campaigns').doc(campaignId);
    const snap = await ref.get();
    if (!snap.exists) {
      res.status(404).json({ error: 'Campagne introuvable' });
      return;
    }

    const camp = snap.data();
    if (camp.createdBy !== auth.uid && auth.role !== 'admin') {
      res.status(403).json({ error: 'Vous ne pouvez annuler que vos propres campagnes' });
      return;
    }
    if (['ended', 'cancelled', 'connected'].includes(camp.status)) {
      res.status(200).json({ ok: true, alreadyDone: true });
      return;
    }

    const client = await getTwilioClient();
    const activeLegs = (camp.legs || []).filter(l =>
      l.callSid && !['completed', 'canceled', 'no-answer', 'busy', 'failed'].includes(l.status)
    );

    await Promise.allSettled(activeLegs.map(l =>
      client.calls(l.callSid).update({ status: 'canceled' }).catch(e => {
        console.warn('[cancel-campaign]', l.callSid, e.message);
      })
    ));

    const updatedLegs = (camp.legs || []).map(l =>
      activeLegs.find(a => a.callSid === l.callSid) ? { ...l, status: 'canceled' } : l
    );

    await ref.update({
      legs: updatedLegs,
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      cancelledBy: auth.uid,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ ok: true, cancelledLegs: activeLegs.length });
  } catch (err) {
    console.error('[cancel-campaign] error:', err);
    res.status(500).json({ error: err.message });
  }
};
