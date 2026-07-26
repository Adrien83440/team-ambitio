// ============================================================================
// api/agency-funnel.js
// ----------------------------------------------------------------------------
// Accès AGENCE au tunnel marketing — lecture seule, sans compte, sans accès
// Firestore. Sert l'instantané publié par sales-funnel.html dans
// funnel_snapshots/{YYYY-MM} à qui présente le token de _config/agency_access.
//
// URL  : GET https://team.alteore.com/api/agency-funnel
//            ?t=TOKEN [&month=YYYY-MM] [&tunnel=all|elite|business]
// Auth : token secret dans l'URL (capacité) — PAS de Firebase Auth.
// Front: agency-funnel.html (page publique autonome, aucun SDK Firebase).
//
// Réponses
//   200 { ok:true, month, tunnel, months:[…], updatedAt:<ms>, build, k, journal }
//   200 { ok:true, month, tunnel, months:[…], empty:true }  ← pas de snapshot
//   403 { ok:false }                                  ← token absent/faux/révoqué
//   405 { ok:false }                                  ← autre verbe que GET
//   500 { ok:false }
//
// SÉCURITÉ
// --------
// - Le token EST le secret (24 octets base64url, généré côté admin depuis la
//   modale « 🔗 Agence » du funnel). Même modèle de capacité que les
//   brouillons AlteoForm : la collection n'est PAS lisible côté client, tout
//   passe par cet endpoint (Admin SDK, bypass des rules).
// - Comparaison timing-safe (sha256 des deux valeurs puis timingSafeEqual :
//   les digests font toujours 32 octets, aucune fuite de longueur).
// - Réponse d'erreur volontairement pauvre : { ok:false } — impossible de
//   savoir si c'est le token ou le mois qui est en cause.
// - Le snapshot lui-même ne contient AUCUNE donnée nominative ni coût interne
//   (blacklist AGENCY_EXCLUDE côté sales-funnel.html) : même en cas de fuite
//   du lien, il n'y a rien de personnel à exfiltrer.
// - Chaque accès (accepté comme refusé) est journalisé dans audit_log.
//
// Aucune variable d'environnement ni dépendance nouvelle. Aucun index
// (composite ou non) : lecture par ID de document + un listing sans orderBy.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

const MONTH_RE = /^\d{4}-\d{2}$/;
const TUNNEL_RE = /^(all|elite|business)$/;
const MONTHS_LIMIT = 24;

/* Un document par mois ET par tunnel : funnel_snapshots/2026-07 (tous),
   /2026-07_elite, /2026-07_business. Le suffixe garde les IDs « mois nu »
   pour le tunnel « tous », ce qui laisse le listing des mois filtrable par
   MONTH_RE (les variantes tunnel n'y apparaissent donc jamais). */
function snapshotDocId(month, tunnel) {
  return tunnel === 'all' ? month : month + '_' + tunnel;
}

/* Comparaison timing-safe. On hache les deux valeurs avant de comparer :
   timingSafeEqual exige des buffers de même longueur (il jette sinon, ce qui
   révélerait la longueur du vrai token) — les digests SHA-256 normalisent. */
function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (!fwd) return null;
  return String(fwd).split(',')[0].trim() || null;
}

/* Journalisation best-effort : une trace d'audit ne doit JAMAIS faire échouer
   la réponse (ni la retarder au point de casser la page agence). */
async function logAccess(req, ok, month, tunnel) {
  try {
    await db.collection('audit_log').add({
      type: 'agency_funnel_read',
      ok: !!ok,
      month: month || null,
      tunnel: tunnel || null,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 300) || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[agency-funnel] audit_log:', e && e.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }

  const token = typeof req.query.t === 'string' ? req.query.t : '';
  /* Mois demandé : validé par regex. Une valeur malformée est simplement
     IGNORÉE (repli sur le mois le plus récent) — jamais concaténée dans un
     chemin de document, jamais renvoyée en écho. */
  const rawMonth = typeof req.query.month === 'string' ? req.query.month : '';
  const askedMonth = MONTH_RE.test(rawMonth) ? rawMonth : null;
  /* Tunnel demandé, même traitement : valeur inconnue → repli sur « all ». */
  const rawTunnel = typeof req.query.tunnel === 'string' ? req.query.tunnel : '';
  const tunnel = TUNNEL_RE.test(rawTunnel) ? rawTunnel : 'all';

  try {
    const cfgSnap = await db.collection('_config').doc('agency_access').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;

    if (!cfg || cfg.active !== true || !tokenMatches(cfg.token, token)) {
      await logAccess(req, false, askedMonth, tunnel);
      res.status(403).json({ ok: false });
      return;
    }

    /* Mois disponibles — projection VIDE (aucun payload transféré : on ne
       veut que les identifiants) et AUCUN orderBy.
       ⚠ Ne pas « optimiser » en orderBy(documentId(),'desc') : Firestore
       n'indexe automatiquement __name__ qu'en ASCENDANT, un tri descendant
       exige un index composite (incident du 26/07/2026 → 500 en prod). La
       collection compte un document par mois — quelques dizaines à vie :
       on lit tout et on trie en mémoire, sans index d'aucune sorte. */
    const monthsSnap = await db.collection('funnel_snapshots').select().get();
    const months = monthsSnap.docs
      .map((d) => d.id)
      .filter((id) => MONTH_RE.test(id))
      .sort()
      .reverse()
      .slice(0, MONTHS_LIMIT);

    const month = askedMonth || months[0] || null;
    if (!month) {
      await logAccess(req, true, null, tunnel);
      res.status(200).json({ ok: true, month: null, tunnel, months: [], empty: true });
      return;
    }

    const snap = await db.collection('funnel_snapshots').doc(snapshotDocId(month, tunnel)).get();
    await logAccess(req, true, month, tunnel);

    /* Mois antérieur à la mise en place des variantes par tunnel → le
       document Élite / Business n'existe pas : état vide explicite, jamais
       un repli silencieux sur « tous » (qui afficherait de faux chiffres). */
    if (!snap.exists) {
      res.status(200).json({ ok: true, month, tunnel, months, empty: true });
      return;
    }

    const d = snap.data() || {};
    const updatedAt = d.updatedAt && typeof d.updatedAt.toMillis === 'function'
      ? d.updatedAt.toMillis()
      : null;

    res.status(200).json({
      ok: true,
      month,
      tunnel,
      months,
      updatedAt,
      build: d.build || null,
      k: d.k || null,
      journal: Array.isArray(d.journal) ? d.journal : [],
    });
  } catch (e) {
    console.error('[agency-funnel]', e && e.message);
    res.status(500).json({ ok: false });
  }
};
