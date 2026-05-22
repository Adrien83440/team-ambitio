// api/admin-cleanup-empty-ringover.js
// TEMPORAIRE — Supprime les call_logs Ringover SANS aucune donnée utile
// (ni recording, ni transcript, ni summary, ni durationSec).
// Ces docs sont des "fantômes" causés par l'arrondi JS du callId au moment de l'initiate.

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const dryRun = !!(req.body && req.body.dryRun);

  const snap = await db.collection('call_logs')
    .where('provider', '==', 'ringover')
    .limit(500).get();

  const toDelete = [];
  const kept     = [];

  snap.forEach(d => {
    const x = d.data();
    const hasData = !!(x.ringoverRecordingUrl || x.transcriptText || x.aiSummary || x.durationSec);
    if (hasData) {
      kept.push(d.id);
    } else {
      toDelete.push(d.id);
    }
  });

  console.log(`[cleanup] À supprimer: ${toDelete.length} | À garder: ${kept.length}`);

  if (!dryRun && toDelete.length > 0) {
    // Suppression par batchs de 400
    while (toDelete.length > 0) {
      const chunk = toDelete.splice(0, 400);
      const batch = db.batch();
      chunk.forEach(id => batch.delete(db.collection('call_logs').doc(id)));
      await batch.commit();
    }
  }

  res.json({
    ok: true,
    dryRun,
    deleted: dryRun ? 0 : (snap.size - kept.length),
    wouldDelete: toDelete.length,
    kept: kept.length,
    deletedIds: dryRun ? toDelete.slice(0, 20) : [],
  });
};
