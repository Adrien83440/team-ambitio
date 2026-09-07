// ============================================================================
// api/academy-validation.js — LE COACH NOTE ET TRANCHE UNE ÉTAPE, DEPUIS LA FICHE
// ----------------------------------------------------------------------------
// POURQUOI. La fiche de validation d'une étape (l'outil 07 : notation des
// livrables 0-3, décision calculée, complétude des outils) vivait dans le
// seul écran coach de l'Academy. Le coach, lui, travaille ici. Cette route lui
// apporte la fiche là où il est : la lire, la noter, trancher.
//
// URL  : POST https://team.alteore.com/api/academy-validation
// Auth : Bearer ID token Firebase — rôles admin / coach UNIQUEMENT.
//        La CSM observe, elle ne note pas : même matrice que dans l'Academy.
// Body : { "email": "client@exemple.com", "etape": "m2",
//          "action": "lire" | "noter" | "decider",
//          "evaluation": { date, livrables:[{libelle, renduAvantSeance,
//                          score, commentaire}], … } }   // « noter » seulement
//
// Relais serveur → serveur (le secret ne transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/validation-etape
//
// CE QUI REVIENT ICI ET NE VA PAS PLUS LOIN. La fiche contient les notes du
// coach et ses commentaires. Elles ne sont servies qu'aux rôles admin et
// coach — jamais à la CSM, jamais à un dirigeant. Le contenu des outils du
// client, lui, ne revient pas : seulement le verdict de complétude.
//
// LES RÈGLES SONT CELLES DE L'ACADEMY, appliquées là-bas : la décision est
// calculée depuis les notes, jamais choisie ; une étape ne passe à « validée »
// que si ses outils sont complets. La réponse est TRANSMISE TELLE QUELLE,
// refus compris (« completude_insuffisante » et ses manques, par exemple).
//
// Réponses 200 (fail-soft, la fiche affiche le message) :
//   { ok:true, found:false }                       → aucun compte Academy
//   { ok:true, found:true, bareme, actions, reglages, etape, evaluation,
//     decision, completude, verdict, etats, appliquee?, instantanePris? }
//   { ok:false, error:"forbidden"|"bridge_not_configured"|"donnees_invalides"
//              |"academy_unreachable"|<erreur Academy>, message?, manques? }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach'];
const ACTIONS = ['lire', 'noter', 'decider'];

function txt(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden', message: 'Réservé aux coachs et administrateurs.' });
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
  const email = txt(body.email, 200).toLowerCase();
  const etape = txt(body.etape, 16);
  const action = txt(body.action || 'lire', 16);
  const par = txt(auth.email, 200).toLowerCase();

  if (!email || !etape || ACTIONS.indexOf(action) < 0) {
    res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Données invalides.' });
    return;
  }
  if (action === 'noter' && (!body.evaluation || typeof body.evaluation !== 'object')) {
    res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Notation absente.' });
    return;
  }
  if (!par) {
    res.status(200).json({ ok: false, error: 'auteur_inconnu', message: 'Compte sans adresse e-mail : la fiche ne peut pas être signée.' });
    return;
  }

  const charge = { email: email, etape: etape, action: action, par: par };
  if (action === 'noter') charge.evaluation = body.evaluation;

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/validation-etape', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify(charge),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    // Transmis tel quel, refus compris — le message vient de l'Academy.
    res.status(200).json(j);
  } catch (e) {
    console.error('[academy-validation]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
