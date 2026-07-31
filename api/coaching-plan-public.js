// ============================================================================
// api/coaching-plan-public.js — PLAN D'ACTION CÔTÉ CLIENT
// ----------------------------------------------------------------------------
// Sert le plan d'action d'un client à qui présente son lien unique. Le client
// le consulte quand il veut, depuis n'importe quel appareil — plus de PDF à
// renvoyer à chaque mise à jour : le lien montre toujours la version du jour.
//
// URL  : GET https://team.alteore.com/api/coaching-plan-public?t=TOKEN
// Auth : token secret dans l'URL (capacité) — le client n'a aucun compte.
// Front: plan-client.html (page publique autonome, aucun SDK Firebase).
//
// Réponses
//   200 { ok:true, plan, client:{ prenom, entreprise }, updatedAt }
//   403 { ok:false }   ← token inconnu, révoqué, ou plan supprimé
//   405 { ok:false }
//
// SÉCURITÉ
// --------
// - Le token EST le secret (24 octets base64url, généré par la fiche coach).
//   Il vit dans clients/{id}.planShare = { token, active, createdAt }.
// - Recherche par where('planShare.token','==',…) : champ unique, aucun index
//   composite. Un token inconnu → 403 générique, jamais de détail.
// - ⚠ SEUL LE PLAN SORT. La fiche coaching contient les séances, les notes du
//   coach, le questionnaire, les montants — rien de tout ça n'est renvoyé
//   ici. On ne renvoie que planV2 + le prénom et le nom d'entreprise, qui
//   sont les siens.
// - Aucune écriture : cet endpoint est en lecture seule.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const crypto = require('crypto');

/* Comparaison timing-safe des tokens : on hache avant de comparer pour ne
   pas laisser fuiter la longueur du secret. */
function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }

  const token = typeof req.query.t === 'string' ? req.query.t.trim() : '';
  /* Un token trop court ne peut pas être un des nôtres (24 octets base64url
     ≈ 32 caractères) — on coupe court sans interroger Firestore. */
  if (!token || token.length < 20) {
    res.status(403).json({ ok: false });
    return;
  }

  try {
    const snap = await db.collection('clients')
      .where('planShare.token', '==', token)
      .limit(1)
      .get();

    if (snap.empty) {
      res.status(403).json({ ok: false });
      return;
    }

    const doc = snap.docs[0];
    const c = doc.data() || {};
    const share = c.planShare || {};

    /* Lien désactivé, ou plan supprimé depuis : même réponse qu'un token
       inconnu — le client n'a pas à distinguer les deux cas. */
    if (share.active !== true || !tokenMatches(share.token, token) || !c.planV2) {
      res.status(403).json({ ok: false });
      return;
    }

    res.status(200).json({
      ok: true,
      plan: c.planV2,
      client: {
        prenom: c.prenom || c.nom || '',
        entreprise: c.entreprise || c.societe || c.activite || '',
      },
      updatedAt: c.planV2.updatedAt || null,
    });
  } catch (e) {
    console.error('[coaching-plan-public]', e && e.message);
    res.status(403).json({ ok: false });
  }
};
