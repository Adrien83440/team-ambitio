// ============================================================================
// api/_coachLookup.js — RETROUVER UN COACH ET SON NUMÉRO
// ----------------------------------------------------------------------------
// Helper partagé, exclu du routing Vercel par son préfixe `_`.
//
// LA CHAÎNE DE LIAISON
// --------------------
// Le sélecteur de coach du plan d'action écrit deux choses : `plan.coachId`,
// qui est l'identifiant d'une fiche expert de `booking_config`, et `plan.coach`,
// le nom affiché. Aucun des deux ne porte de numéro de téléphone.
//
// Les numéros vivent dans la collection `users`, champ `ringoverPhones`
// (Admin → Utilisateurs). Le pont existe et il est EXACT : quand
// admin-users.html crée une fiche expert, il y inscrit `firebaseUid`.
//
//   plan.coachId → booking_config/{coachId}.firebaseUid → users/{uid}
//
// C'est le seul chemin fiable. Les replis par email puis par nom ne servent
// qu'aux fiches expert créées à la main avant cette propagation ; ils sont
// volontairement stricts, et refusent en cas d'homonyme plutôt que de tirer au
// sort le destinataire d'un message.
//
// POURQUOI ON N'EXIGE PAS LE RÔLE `coach`
// ---------------------------------------
// Le sélecteur du plan liste TOUTES les fiches `__type === 'person'`, closeurs
// et admins compris — c'est voulu : Adrien ou Emily peuvent être le référent
// d'un client. Exiger `role === 'coach'` bloquerait ces cas réels sans rien
// sécuriser, puisque la liaison par `firebaseUid` est déjà sans ambiguïté. On
// ne vérifie donc que l'ACTIVITÉ du compte.
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

/* Un compte sans `status` est un compte ancien, antérieur au champ : on le
   considère actif. Seuls les états explicitement fermés excluent — l'inverse
   ferait disparaître des coachs en poste sans que personne comprenne pourquoi. */
function estActif(u) {
  const s = String((u && u.status) || '').trim();
  return s !== 'disabled' && s !== 'archived';
}

/** Premier numéro exploitable d'un utilisateur. */
function numeroDe(u, normaliserNumero) {
  const nums = (u && Array.isArray(u.ringoverPhones)) ? u.ringoverPhones : [];
  for (let i = 0; i < nums.length; i++) {
    const n = normaliserNumero(nums[i]);
    if (n) return n;
  }
  return null;
}

/** Tous les comptes, identifiant compris. */
async function chargerUtilisateurs() {
  const snap = await db.collection('users').get();
  const l = [];
  snap.forEach((d) => l.push(Object.assign({ uid: d.id }, d.data() || {})));
  return l;
}

/** La fiche expert du booking, si l'identifiant en désigne une. */
async function chargerFicheExpert(coachId) {
  if (!coachId) return null;
  try {
    const snap = await db.collection('booking_config').doc(String(coachId)).get();
    if (!snap.exists) return null;
    const v = snap.data() || {};
    return v.__type === 'person' ? v : null;
  } catch (e) {
    console.warn('[coach-lookup] fiche expert', coachId, e && e.message);
    return null;
  }
}

/** Toutes les fiches expert — exactement la liste qu'affiche le sélecteur. */
async function chargerFichesExperts() {
  const snap = await db.collection('booking_config').get();
  const l = [];
  snap.forEach((d) => {
    const v = d.data() || {};
    if (v.__type === 'person') l.push(Object.assign({ id: d.id }, v));
  });
  return l;
}

/**
 * Retrouve le compte du coach et son numéro.
 *
 * @param {Array} utilisateurs   collection `users`
 * @param {Object|null} fiche    doc booking_config, si trouvé
 * @param {string} coachNom      `plan.coach`
 * @param {Function} normaliserNumero
 * @returns {{utilisateur:Object, numero:string, via:string}|{erreur:string}}
 */
function resoudreCoach(utilisateurs, fiche, coachNom, normaliserNumero) {
  const actifs = (utilisateurs || []).filter(estActif);
  if (!actifs.length) return { erreur: 'aucun_utilisateur_actif' };

  let trouve = null;
  let via = null;

  /* 1. Le lien exact posé par admin-users.html. */
  if (fiche && fiche.firebaseUid) {
    trouve = actifs.find((u) => u.uid === fiche.firebaseUid) || null;
    if (trouve) via = 'firebaseUid';
  }

  /* 2. L'email de la fiche expert — fiches créées avant la propagation. */
  if (!trouve && fiche && fiche.personalEmail) {
    const em = String(fiche.personalEmail).trim().toLowerCase();
    trouve = actifs.find((u) => String(u.email || '').trim().toLowerCase() === em) || null;
    if (trouve) via = 'personalEmail';
  }

  /* 3. Le nom complet — de la fiche expert, sinon celui noté dans le plan. */
  const nom = (fiche && fiche.name) || coachNom || '';
  const kNom = cle(nom);
  if (!trouve && kNom) {
    trouve = actifs.find((u) => cle(u.displayName) === kNom) || null;
    if (trouve) via = 'nom';
  }

  /* 4. Le prénom seul, et UNIQUEMENT si un seul compte correspond. Deux
        Thomas, et on préfère ne rien envoyer qu'écrire au mauvais. */
  if (!trouve && kNom) {
    const kPrenom = cle(prenomDe(kNom));
    const candidats = actifs.filter((u) => cle(prenomDe(u.displayName)) === kPrenom);
    if (candidats.length === 1) { trouve = candidats[0]; via = 'prenom'; }
    else if (candidats.length > 1) return { erreur: 'coach_ambigu' };
  }

  if (!trouve) return { erreur: 'coach_introuvable' };

  const numero = numeroDe(trouve, normaliserNumero);
  if (!numero) return { erreur: 'numero_absent' };
  return { utilisateur: trouve, numero: numero, via: via };
}

module.exports = {
  cle,
  prenomDe,
  estActif,
  numeroDe,
  chargerUtilisateurs,
  chargerFicheExpert,
  chargerFichesExperts,
  resoudreCoach,
};
