// ============================================================================
// api/coaching-auto-sync.js — SYNCHRO AUTOMATIQUE DES COACHINGS 1:1 (6 h / 19 h)
// ----------------------------------------------------------------------------
// Demande d'Adrien (16/11/2026) : ce que le coach fait avec « 🔍 Chercher les
// résumés » dans la fiche coaching, fait seul deux fois par jour. Toute la
// logique est dans api/_coachingAutoSync.js (lire son en-tête).
//
// URL  : GET/POST /api/coaching-auto-sync
// Auth : • Authorization: Bearer <CRON_SECRET>      (Vercel Cron)
//        • x-api-key: <CRON_SECRET> ou <COACHING_AUTO_SYNC_KEY>  (appel manuel)
// Cron : 04:00, 05:00, 17:00 et 18:00 UTC (vercel.json) — la route ne
//        travaille que s'il est 6 h ou 19 h à Paris : l'heure reste juste
//        en été comme en hiver. Ne fait RIEN tant que
//        _config/coaching_auto_sync.enabled n'est pas true.
//
// ─── PARAMÈTRES ───────────────────────────────────────────────────────────
//   dry=1        lecture seule : liste ce qui serait lié, n'écrit rien,
//                n'envoie rien (aucun email, aucun appel IA).
//   apply=1      exécute même si enabled est faux (premier passage validé).
//   activer=1|0  allume / éteint la tâche (_config/coaching_auto_sync.enabled).
//   days=<n>     fenêtre en jours (défaut 16, max 90 — rattrapage).
//
// ─── TEST MANUEL ──────────────────────────────────────────────────────────
//   curl -H "x-api-key: <COACHING_AUTO_SYNC_KEY>" \
//     "https://team.alteore.com/api/coaching-auto-sync?dry=1&days=60"
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const Sync = require('./_coachingAutoSync');

const HEURES_PARIS = [6, 19];

function authentifier(req) {
  const cron = process.env.CRON_SECRET || '';
  const cle = process.env.COACHING_AUTO_SYNC_KEY || '';
  const header = req.headers['authorization'] || '';
  const bearer = header.indexOf('Bearer ') === 0 ? header.substring(7).trim() : '';
  const apiKey = req.headers['x-api-key'] || '';
  if (cron && bearer === cron) return 'cron';
  if ((cron && apiKey === cron) || (cle && apiKey === cle)) return 'manuel';
  return null;
}

module.exports = async function (req, res) {
  const qui = authentifier(req);
  if (!qui) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }

  const q = req.query || {};
  const dry = String(q.dry || '') === '1';
  const apply = String(q.apply || '') === '1';

  if (qui === 'manuel' && (q.activer === '1' || q.activer === '0')) {
    const on = q.activer === '1';
    await db.doc(Sync.CFG_PATH).set({ enabled: on, enabledMaj: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    res.status(200).json({ ok: true, enabled: on });
    return;
  }

  // Vercel Cron appelle à deux heures UTC par créneau : on ne garde que
  // celle qui tombe à 6 h ou 19 h à Paris.
  if (qui === 'cron') {
    const h = Sync.parisHeure();
    if (HEURES_PARIS.indexOf(h) < 0) { res.status(200).json({ ok: true, skipped: 'hors_creneau', heureParis: h }); return; }
  }

  let cfg;
  try { cfg = await Sync.chargerConfig(); }
  catch (e) { res.status(500).json({ ok: false, error: 'config', message: e.message }); return; }

  if (!dry && !apply && !cfg.enabled) {
    res.status(200).json({ ok: true, skipped: 'desactive', info: 'Mettre _config/coaching_auto_sync.enabled à true (?activer=1), ou appeler avec ?dry=1 / ?apply=1.' });
    return;
  }

  try {
    const rapport = await Sync.executer({ dry: dry, days: q.days, cfg: cfg });
    if (!dry) {
      try {
        await db.doc(Sync.CFG_PATH).set({
          dernierPassage: {
            at: admin.firestore.FieldValue.serverTimestamp(),
            par: qui,
            lies: rapport.lies.length,
            videosAjoutees: rapport.videosAjoutees.length,
            aVerifier: rapport.aVerifier.length,
            nonLies: rapport.nonLies.length,
            erreurs: rapport.erreurs.length,
          },
        }, { merge: true });
      } catch (_) { /* trace best-effort */ }
    }
    res.status(200).json(rapport);
  } catch (e) {
    console.error('[coaching-auto-sync]', e);
    res.status(200).json({ ok: false, error: e.code || 'erreur', message: String(e.message || e) });
  }
};
