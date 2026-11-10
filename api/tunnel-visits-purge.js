// ============================================================================
// api/tunnel-visits-purge.js — PURGE DU JOURNAL PAR VISITE (10/11/2026)
// ----------------------------------------------------------------------------
// tunnel_visits/{date}_{vid} (api/tunnel-event.js) : journal ANONYME d'une
// visite de page de tunnel, conservé 90 jours (champ expireAt). Exception
// validée par Adrien le 10/11/2026 à la règle « rien n'est jamais supprimé » :
// ce sont des données de mesure sans personne derrière, pas des données
// métier. Les compteurs journaliers (page_views_daily, quiz_funnel_daily,
// tunnel_stats_daily) ne sont jamais touchés.
//
// Cron quotidien (vercel.json). Auth : Authorization: Bearer <CRON_SECRET>
// (Vercel Cron) — fail-closed sans CRON_SECRET. ?dry=1 : compte sans supprimer.
// Au plus 2 000 documents par passage (le reste part le lendemain).
// ============================================================================
'use strict';

const { db, admin } = require('./_firebaseAdmin');

function authorized(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  const auth = String(req.headers.authorization || '');
  return auth === 'Bearer ' + secret || req.headers['x-api-key'] === secret;
}

module.exports = async (req, res) => {
  if (!authorized(req)) { res.status(401).json({ error: 'Non autorisé' }); return; }
  const dry = req.query && (req.query.dry === '1' || req.query.dry === 'true');
  const now = admin.firestore.Timestamp.now();
  let total = 0;
  try {
    for (let round = 0; round < 5; round++) {
      const snap = await db.collection('tunnel_visits').where('expireAt', '<', now).limit(400).get();
      if (snap.empty) break;
      if (dry) { total += snap.size; break; }
      const batch = db.batch();
      snap.forEach(function (d) { batch.delete(d.ref); });
      await batch.commit();
      total += snap.size;
      if (snap.size < 400) break;
    }
    res.status(200).json({ ok: true, dry: !!dry, count: total });
  } catch (e) {
    console.error('[tunnel-visits-purge]', e && e.message);
    res.status(500).json({ error: 'purge', message: String(e && e.message || e).slice(0, 200) });
  }
};
