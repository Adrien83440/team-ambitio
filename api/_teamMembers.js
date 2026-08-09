// ============================================================================
// api/_teamMembers.js — LECTURE DE L'ÉQUIPE ET RÉSOLUTION D'UN COACH
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// POURQUOI IL EXISTE
// ------------------
// Deux référentiels décrivent les coachs et ne partagent aucune clé :
//   · `booking_config`      — docs `__type === 'person'` : { id, name }.
//     C'est ce que lit le sélecteur de coach du plan d'action. AUCUN téléphone.
//   · `_meta/team_members`  — { slug, displayName, role, status,
//     ringoverPhones[] }. C'est là que vivent les numéros (Admin → Utilisateurs).
//
// Les rapprocher demande plusieurs passes, du plus sûr au plus permissif. La
// logique tient en trente lignes mais c'est le point de panne le plus probable
// du canal WhatsApp — d'où sa sortie ici : testable isolément, et partagée
// entre l'envoi et le diagnostic plutôt que recopiée dans les deux.
// ============================================================================

const { db } = require('./_firebaseAdmin');

/** Comparaison de noms tolérante : casse, accents, espaces multiples. */
function cle(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Premier mot d'un nom affiché — « Thomas » dans « Thomas MARTIN ». */
function prenomDe(nomComplet) {
  const t = String(nomComplet || '').trim().split(/\s+/);
  return t[0] || '';
}

/**
 * Normalise le champ `members` de _meta/team_members en tableau.
 * Firestore le rend tantôt objet (slug → membre), tantôt tableau, selon la
 * façon dont il a été écrit. nav.js gère déjà les deux côté navigateur ; on
 * fait pareil ici plutôt que de parier sur une forme.
 */
function normaliserMembres(brut) {
  const liste = [];
  if (Array.isArray(brut)) {
    brut.forEach((m) => { if (m && typeof m === 'object') liste.push(m); });
  } else if (brut && typeof brut === 'object') {
    Object.keys(brut).forEach((k) => {
      const m = brut[k];
      if (m && typeof m === 'object') liste.push(Object.assign({ slug: k }, m));
    });
  }
  return liste;
}

/** Charge l'équipe depuis Firestore. Lance si le document est absent. */
async function chargerMembres() {
  const snap = await db.collection('_meta').doc('team_members').get();
  if (!snap.exists) throw new Error('_meta/team_members introuvable');
  return normaliserMembres((snap.data() || {}).members);
}

/** Les coachs en poste — les seuls à qui on écrira jamais. */
function coachsActifs(membres) {
  return (membres || []).filter((m) => m && m.role === 'coach' && m.status === 'active');
}

/**
 * Premier numéro exploitable d'un membre.
 * @param {Object} membre
 * @param {Function} normaliserNumero  injecté pour éviter que ce helper
 *   dépende du client WhatsApp — la règle de format appartient au canal.
 * @returns {string|null}
 */
function numeroDe(membre, normaliserNumero) {
  const nums = (membre && Array.isArray(membre.ringoverPhones)) ? membre.ringoverPhones : [];
  for (let i = 0; i < nums.length; i++) {
    const n = normaliserNumero(nums[i]);
    if (n) return n;
  }
  return null;
}

/**
 * Retrouve un coach à partir de ce que porte le plan d'action.
 *
 * @param {Array} membres            l'équipe complète
 * @param {string} coachId           `plan.coachId` — identifiant booking_config
 * @param {string} coachNom          `plan.coach` — nom affiché
 * @param {Function} normaliserNumero
 * @returns {{membre:Object, numero:string}|{erreur:string}}
 *
 * Aucune passe approximative : à la moindre ambiguïté on renvoie une erreur.
 * Écrire au mauvais coach coûte plus cher que ne pas écrire du tout.
 */
function resoudreCoach(membres, coachId, coachNom, normaliserNumero) {
  const coachs = coachsActifs(membres);
  if (!coachs.length) return { erreur: 'aucun_coach_actif' };

  const kId = cle(coachId);
  const kNom = cle(coachNom);
  let trouve = null;

  /* 1. Le slug, quand l'identifiant du booking coïncide avec celui de l'équipe. */
  if (kId) trouve = coachs.find((m) => cle(m.slug) === kId) || null;

  /* 2. Le nom affiché complet. */
  if (!trouve && kNom) trouve = coachs.find((m) => cle(m.displayName) === kNom) || null;

  /* 3. Le prénom seul — le booking affiche souvent « Thomas » là où l'équipe
        stocke « Thomas MARTIN ». On n'accepte QUE si un seul coach correspond :
        deux Thomas, et on préfère ne rien envoyer. */
  if (!trouve && kNom) {
    const kPrenom = cle(prenomDe(kNom));
    const parPrenom = coachs.filter((m) => cle(prenomDe(m.displayName)) === kPrenom);
    if (parPrenom.length === 1) trouve = parPrenom[0];
    else if (parPrenom.length > 1) return { erreur: 'coach_ambigu' };
  }

  if (!trouve) return { erreur: 'coach_introuvable' };

  const numero = numeroDe(trouve, normaliserNumero);
  if (!numero) return { erreur: 'numero_absent' };
  return { membre: trouve, numero: numero };
}

module.exports = {
  cle,
  prenomDe,
  normaliserMembres,
  chargerMembres,
  coachsActifs,
  numeroDe,
  resoudreCoach,
};
