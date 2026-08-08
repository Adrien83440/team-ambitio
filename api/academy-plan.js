// ============================================================================
// api/academy-plan.js — LE PLAN D'ACTION DESCEND VERS L'ACADEMY
// ----------------------------------------------------------------------------
// POURQUOI CE PONT EXISTE. Le plan d'action vit ici : c'est dans la fiche
// coaching que le coach écrit les milestones AVEC son client, et qu'il décale
// une échéance en séance. L'Academy, elle, recalculait les jalons du dirigeant
// depuis sa seule date de signature, avec des libellés génériques.
//
// Résultat : le coach déplaçait M3 à J+140, et son client continuait de lire
// l'ancienne date sur son espace. Deux vérités sur le même parcours, et c'est
// le client qui arbitrait.
//
// Cette route pousse le plan tel qu'il est ENREGISTRÉ ICI. L'Academy s'en sert
// pour afficher au dirigeant SES milestones — les vrais.
//
// URL  : POST https://team.alteore.com/api/academy-plan
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { "clientId": "…" }
//
// LE PLAN N'EST PAS LU DANS LA REQUÊTE, il est relu en base côté serveur. Un
// navigateur ne peut donc pas pousser dans l'Academy un plan que la fiche
// n'a jamais enregistré.
//
// Relais serveur → serveur (le secret ne transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/plan
//   header x-bridge-key = ACADEMY_BRIDGE_KEY
//
// LES DEUX TRAMES PASSENT. On envoie les clés telles qu'elles sont : M1→M5 pour
// un plan courant, A1→B pour un plan validé avant le 08/08/2026. L'Academy
// applique la même détection que `estLegacy()` d'ici et n'en réécrit aucun.
//
// Réponses 200 (fail-soft : l'enregistrement du plan a déjà réussi, un pont
// indisponible ne doit jamais ressembler à un échec d'enregistrement) :
//   { ok:true, found:false }                    → pas de compte Academy
//   { ok:true, found:true, applied:{…} }
//   { ok:false, error:"bridge_not_configured"|"forbidden"|"client_not_found"
//              |"email_client_absent"|"plan_absent"|"academy_unreachable" }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];

/* Les trois organismes, mêmes identifiants que l'Academy — vérifié dans
   src/lib/ep/referentiels.js. Un verrou inconnu part vide plutôt que faux :
   un verrou faux enverrait le coach sur le mauvais chantier six mois durant. */
const ORGANISMES = ['delivrabilite', 'rentabilite', 'acquisition'];

/* Les deux trames. On n'en privilégie aucune ici : on transmet ce que le plan
   porte, et l'Academy décide laquelle s'applique — avec la même règle qu'ici. */
const CODES = ['M1', 'M2', 'M3', 'M4', 'M5', 'A1', 'A2', 'A3', 'A4', 'A5', 'B'];

function txt(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

/* Ce qu'on envoie pour chaque étape du plan : son intitulé, sa preuve, et
   SURTOUT son décalage en jours — c'est lui qui bougeait sans que le client
   le voie. Un décalage hors bornes n'est pas transmis : l'Academy le
   refuserait, autant ne pas le lui envoyer. */
function jalonsAEnvoyer(plan) {
  var src = (plan && plan.jalons && typeof plan.jalons === 'object') ? plan.jalons : {};
  var out = {};
  CODES.forEach(function (code) {
    var j = src[code];
    if (!j || typeof j !== 'object') return;
    var propre = {};
    var brut = Number(j.j);
    if (isFinite(brut) && brut >= 1 && brut <= 365) propre.j = Math.round(brut);
    var titre = txt(j.titre || j.obj, 300);
    if (titre) propre.titre = titre;
    var preuve = txt(j.preuve, 1200);
    if (preuve) propre.preuve = preuve;
    if (Object.keys(propre).length) out[code] = propre;
  });
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden' });
    return;
  }

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) {
    res.status(200).json({ ok: false, error: 'bridge_not_configured' });
    return;
  }

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { body = {}; }
  const clientId = String(body.clientId || '').trim();
  if (!clientId) {
    res.status(200).json({ ok: false, error: 'clientId_required' });
    return;
  }

  try {
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) { res.status(200).json({ ok: false, error: 'client_not_found' }); return; }
    const c = snap.data() || {};

    const email = String(c.email || '').trim().toLowerCase();
    if (!email) { res.status(200).json({ ok: false, error: 'email_client_absent' }); return; }

    const plan = c.planV2;
    if (!plan || typeof plan !== 'object') { res.status(200).json({ ok: false, error: 'plan_absent' }); return; }

    /* Le verrou : premier du classement, ou l'ancien champ unique pour un plan
       d'avant le classement. */
    const ordre = Array.isArray(plan.organismes) ? plan.organismes : [];
    const verrouBrut = String(ordre[0] || plan.organisme || '').toLowerCase().trim();
    const verrou = ORGANISMES.indexOf(verrouBrut) >= 0 ? verrouBrut : '';

    const charge = {
      email: email,
      /* Point A et point B tels que le mentor les a formalisés : c'est ce qui
         donne un sens aux milestones côté client. Généreusement bornés — depuis
         la vague du 08/08 ils font quatre à huit phrases. */
      pointA: txt(plan.pointA, 4000),
      pointB: txt(plan.pointB, 4000),
      verrou: verrou,
      jalons: jalonsAEnvoyer(plan),
      majLe: txt(plan.updatedAt, 40),
      revision: Number(plan.version) || 0,
    };

    const r = await fetch(ACADEMY_URL + '/api/bridge/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify(charge),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    if (!j.found) { res.status(200).json({ ok: true, found: false }); return; }

    res.status(200).json({ ok: true, found: true, applied: j.applied || null });
  } catch (e) {
    console.error('[academy-plan]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
