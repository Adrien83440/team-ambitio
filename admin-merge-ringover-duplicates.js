// api/admin-merge-ringover-duplicates.js
// TEMPORAIRE — Fusionne les call_logs Ringover dupliqués causés par la précision JS
// Pour chaque doc Ringover, cherche un "voisin proche" (callId similaire à ±500)
// et fusionne les données vers le doc le plus ancien (celui que le dialer référence)

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin') return res.status(403).json({ error: 'admin only' });

  const dryRun = !!(req.body && req.body.dryRun);

  // Récupérer les call_logs Ringover (sans orderBy pour éviter l'exigence d'index)
  const snap = await db.collection('call_logs')
    .where('provider', '==', 'ringover')
    .limit(500)
    .get();

  const docs = snap.docs.map(d => ({ id: d.id, ref: d.ref, data: d.data() }));
  // Tri en mémoire (plus récent en premier)
  docs.sort((a, b) => (b.data.updatedAt?.toMillis?.() || 0) - (a.data.updatedAt?.toMillis?.() || 0));
  console.log(`[merge] ${docs.length} docs Ringover trouvés`);

  // Trier par taille de callId (les 19 chiffres au début)
  const longDocs = docs.filter(d => d.id.length >= 18);

  // Grouper par "voisinage" — IDs qui diffèrent de moins de 1000
  const groups = [];
  for (const d of longDocs) {
    const idNum = BigInt(d.id);
    let placed = false;
    for (const g of groups) {
      const refNum = BigInt(g.refId);
      const diff = idNum > refNum ? idNum - refNum : refNum - idNum;
      if (diff < 1000n) {
        g.docs.push(d);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ refId: d.id, docs: [d] });
  }

  const duplicateGroups = groups.filter(g => g.docs.length > 1);
  console.log(`[merge] ${duplicateGroups.length} groupes de doublons`);

  const actions = [];
  for (const group of duplicateGroups) {
    // Identifier le doc "source de vérité" (celui qui a le plus de données)
    const sorted = group.docs.slice().sort((a, b) => {
      const score = x => {
        let s = 0;
        if (x.data.ringoverRecordingUrl) s += 10;
        if (x.data.transcriptText) s += 10;
        if (x.data.aiSummary) s += 10;
        if (x.data.recordingStatus) s += 1;
        if (x.data.transcriptionStatus) s += 1;
        if (x.data.aiAnalysisStatus) s += 1;
        return s;
      };
      return score(b) - score(a); // tri descendant
    });

    const richest = sorted[0]; // celui avec le plus de data
    const targets = sorted.slice(1).filter(d => d.id !== richest.id);

    // Le target = le plus ancien doc (celui que le dialer/campaign référence)
    // = en général celui finissant par des zéros (arrondi JS au moment du callback)
    // On fusionne RICHEST → ANCIEN (le dialer pointe sur l'ancien)
    const oldestTarget = targets.sort((a, b) => {
      const at = a.data.createdAt?.toMillis?.() || 0;
      const bt = b.data.createdAt?.toMillis?.() || 0;
      return at - bt;
    })[0];

    if (!oldestTarget) continue;

    const updates = {
      ringoverRecordingUrl: richest.data.ringoverRecordingUrl || oldestTarget.data.ringoverRecordingUrl || null,
      transcriptText:       richest.data.transcriptText       || oldestTarget.data.transcriptText       || null,
      transcriptSpeeches:   richest.data.transcriptSpeeches   || oldestTarget.data.transcriptSpeeches   || null,
      aiSummary:            richest.data.aiSummary            || oldestTarget.data.aiSummary            || null,
      recordingStatus:      richest.data.recordingStatus      || oldestTarget.data.recordingStatus      || null,
      transcriptionStatus:  richest.data.transcriptionStatus  || oldestTarget.data.transcriptionStatus  || null,
      aiAnalysisStatus:     richest.data.aiAnalysisStatus     || oldestTarget.data.aiAnalysisStatus     || null,
      durationSec:          richest.data.durationSec          || oldestTarget.data.durationSec          || null,
      mergedFromIds:        admin.firestore.FieldValue.arrayUnion(richest.id),
      mergedAt:             admin.firestore.FieldValue.serverTimestamp(),
      updatedAt:            admin.firestore.FieldValue.serverTimestamp(),
    };

    actions.push({
      target: oldestTarget.id,
      richest: richest.id,
      others: targets.map(t => t.id),
      preview: {
        recording: !!updates.ringoverRecordingUrl,
        transcript: !!updates.transcriptText,
        ai: !!updates.aiSummary,
      },
    });

    if (!dryRun) {
      await oldestTarget.ref.set(updates, { merge: true });
      // Supprimer les autres doublons (sauf le target principal)
      for (const t of sorted) {
        if (t.id !== oldestTarget.id) {
          await t.ref.delete().catch(() => {});
        }
      }
    }
  }

  res.json({ ok: true, dryRun, totalGroups: groups.length, duplicateGroups: duplicateGroups.length, actions });
};
