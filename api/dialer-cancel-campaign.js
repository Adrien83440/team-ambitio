// ============================================================================
// api/dialer-cancel-campaign.js  (v2 — Ringover)
// ----------------------------------------------------------------------------
// Annule manuellement une campagne Ringover en cours.
// Le createdBy ou un admin peut annuler. Raccroche les legs actifs via
// l'API Ringover puis update le doc dialer_campaigns en status='cancelled'.
//
// URL  : POST /api/dialer-cancel-campaign
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// Body : { campaignId: string }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const auth = await requireAuth(req, res);
  if (!auth) return;

  const { campaignId } = parseBody(req);
  if (!campaignId) return res.status(400).json({ error: 'campaignId requis' });

  try {
    const campRef = db.collection('dialer_campaigns').doc(campaignId);
    const campSnap = await campRef.get();
    if (!campSnap.exists) return res.status(404).json({ error: 'Campagne introuvable' });

    const camp = campSnap.data();

    if (camp.createdBy !== auth.uid && auth.role !== 'admin') {
      return res.status(403).json({ error: 'Accès refusé' });
    }
    if (['cancelled', 'ended'].includes(camp.status)) {
      return res.status(200).json({ ok: true, already: true });
    }

    // ─── Raccrocher les legs qui SONNENT — jamais une conversation ──────────
    // (14/09/2026) Ce endpoint est aussi appelé par le sendBeacon de
    // sales-dialer.js quand la page se ferme ou navigue (retour sur la fiche
    // du lead en plein appel, typiquement). Son rôle est d'arrêter les
    // sonneries en cours, PAS de couper un appel décroché : Élodie continue
    // sa conversation sur son app Ringover même une fois la page quittée.
    // Un leg 'in-progress' (ou une campagne 'connected') est donc préservé —
    // le raccrochage volontaire passe par api/ringover-call-hangup.
    const terminalStatuses = new Set(['completed', 'ended', 'no-answer', 'busy', 'failed', 'cancelled', 'missed', 'canceled']);
    const legs = camp.legs || [];
    const hasLiveLeg = camp.status === 'connected' || legs.some(l => l.status === 'in-progress');
    const legsToCancel = legs.filter(l =>
      (l.callId || l.callSid) && !terminalStatuses.has(l.status) && l.status !== 'in-progress'
    );

    let cancelledLegs = 0;
    for (const leg of legsToCancel) {
      const cid = leg.callId || leg.callSid;
      try {
        await ringoverFetch(`/calls/${cid}`, { method: 'DELETE' });
        cancelledLegs++;
      } catch (e) {
        console.warn('[cancel-campaign] Ringover DELETE failed for', cid, e.message);
      }
    }

    if (hasLiveLeg) {
      // L'appel vivant garde sa campagne : le webhook HANGUP la clôturera
      // (status 'ended' + incrément dialer_attempts). La marquer 'cancelled'
      // ici la sortirait du radar de ringover-call-status.
      await campRef.update({
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ ok: true, cancelledLegs, liveCallPreserved: true });
      return;
    }

    await campRef.update({
      status: 'cancelled',
      cancelledAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({ ok: true, cancelledLegs });
  } catch (err) {
    console.error('[cancel-campaign] error:', err);
    res.status(500).json({ error: err.message });
  }
};
