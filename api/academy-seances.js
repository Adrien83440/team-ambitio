// ============================================================================
// api/academy-seances.js — LES SÉANCES ET LES DEVOIRS, DEPUIS LA FICHE
// ----------------------------------------------------------------------------
// POURQUOI. Les séances sont tenues ici, dans la fiche coaching, et poussées
// vers l'Academy (api/academy-seance.js). Mais ce que l'élève en fait — il
// coche un devoir, laisse un mot — et ce que le coach en pense — une note
// 0-3, un commentaire — vivent dans l'Academy. Cette route les ramène dans
// la pop-up « Gérer le parcours » de la fiche : lire, et noter un devoir.
//
// URL  : POST https://team.alteore.com/api/academy-seances
// Auth : Bearer ID token Firebase.
//        « lire »          → admin / coach / csm. La CSM observe : les notes
//                            du coach, ses commentaires, ses notes internes et
//                            le verdict lui sont RETIRÉS ici, avant l'envoi.
//        « noter-devoir »  → admin / coach UNIQUEMENT.
// Body : { "email": "client@exemple.com", "action": "lire" }
//        { "email": "…", "action": "noter-devoir", "seanceId": "…",
//          "devoirId": "…", "note": "0".."3" | "", "commentaire": "…" }
//
// Relais serveur → serveur (le secret ne transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/seances
//
// LES RÈGLES SONT CELLES DE L'ACADEMY, appliquées là-bas : les statuts des
// devoirs y sont calculés, l'écriture est ciblée sur le devoir (ce que
// l'élève a coché n'est jamais écrasé). La réponse est TRANSMISE TELLE
// QUELLE aux acteurs, refus compris — le message vient de l'Academy.
//
// CE QUE CETTE ROUTE NE FAIT PAS : créer une séance, changer le texte d'un
// devoir. Cela s'écrit dans la fiche, puis part par api/academy-seance.js.
//
// Réponses 200 (fail-soft, la pop-up affiche le message) :
//   { ok:true, found:false }                       → aucun compte Academy
//   { ok:true, found:true, peutAgir, aujourdhui, seances[], verdict?, … }
//   { ok:false, error:"forbidden"|"bridge_not_configured"|"donnees_invalides"
//              |"academy_unreachable"|<erreur Academy>, message? }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];
// Ceux qui notent — la même frontière que la matrice de droits de l'Academy.
const ROLES_ACTEURS = ['admin', 'coach'];
const ACTIONS = ['lire', 'noter-devoir'];
const NOTES = ['', '0', '1', '2', '3'];

function txt(v, max) {
  var s = String(v == null ? '' : v).trim();
  return s.length > max ? s.slice(0, max) : s;
}

// Ce que la CSM reçoit. Ce n'est pas un masquage d'affichage : les champs
// ne partent pas de ce serveur.
function pourObservateur(j) {
  var copie = Object.assign({}, j);
  delete copie.verdict;
  copie.seances = (j.seances || []).map(function (s) {
    var t = Object.assign({}, s);
    delete t.notesInternes;
    t.devoirs = (s.devoirs || []).map(function (d) {
      var e = Object.assign({}, d);
      delete e.note;
      delete e.commentaire;
      return e;
    });
    return t;
  });
  copie.peutAgir = false;
  return copie;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden', message: 'Réservé à l\'équipe coaching.' });
    return;
  }
  const acteur = ROLES_ACTEURS.indexOf(auth.role) >= 0;

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) {
    res.status(200).json({ ok: false, error: 'bridge_not_configured' });
    return;
  }

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { body = {}; }
  const email = txt(body.email, 200).toLowerCase();
  const action = txt(body.action || 'lire', 20);
  const par = txt(auth.email, 200).toLowerCase();

  if (!email || ACTIONS.indexOf(action) < 0) {
    res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Données invalides.' });
    return;
  }
  if (!par) {
    res.status(200).json({ ok: false, error: 'auteur_inconnu', message: 'Compte sans adresse e-mail : l\'acte ne peut pas être signé.' });
    return;
  }

  const charge = { email: email, action: action, par: par };
  if (action === 'noter-devoir') {
    if (!acteur) {
      res.status(200).json({ ok: false, error: 'forbidden', message: 'Réservé aux coachs et administrateurs.' });
      return;
    }
    charge.seanceId = txt(body.seanceId, 60);
    charge.devoirId = txt(body.devoirId, 40);
    if (!charge.seanceId || !charge.devoirId) {
      res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Séance ou devoir absent.' });
      return;
    }
    // Un champ absent n'est pas envoyé : l'Academy ne le modifie pas.
    if (body.note !== undefined) {
      const note = txt(body.note, 1);
      if (NOTES.indexOf(note) < 0) {
        res.status(200).json({ ok: false, error: 'donnees_invalides', message: 'Note hors barème (0 à 3).' });
        return;
      }
      charge.note = note;
    }
    if (body.commentaire !== undefined) charge.commentaire = txt(body.commentaire, 1500);
  }

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/seances', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify(charge),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || typeof j !== 'object') { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    if (j.ok === true && j.found === true) {
      if (!acteur) j = pourObservateur(j);
      else j.peutAgir = true;
    }
    // Transmis tel quel, refus compris — le message vient de l'Academy.
    res.status(200).json(j);
  } catch (e) {
    console.error('[academy-seances]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
