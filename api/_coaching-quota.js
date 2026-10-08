// ============================================================================
// api/_coaching-quota.js — RÈGLE DE QUOTA COACHING (helper partagé)
// ----------------------------------------------------------------------------
// Helper interne (préfixe `_` → exclu du routing Vercel). Zéro dépendance :
// que de la lecture de libellé. Utilisé par :
//   · api/booking-check-coaching-quota.js  (blocage réel à la réservation)
//   · api/academy-client-info.js           (compteur affiché dans l'Academy)
//   · api/_recurrence-core.js              (série hebdomadaire Elite NEW)
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// La règle vivait dans `_recurrence-core.js`, qui charge `googleapis` et
// `dispo-core.js` : les endpoints qui ne veulent que le quota payaient un
// cold start pour rien, et `academy-client-info.js` avait donc gardé sa
// propre version simplifiée (« 24c → 2 »), fausse pour Elite NEW. Une règle,
// un fichier, aucune dépendance : plus de raison de la recopier.
//
// Toute correction de la règle se fait ICI. Les copies frontend
// (coaching.html:1529, coaching-shared.js, csm-clients.html, csm-dashboard.html)
// doivent rester alignées — elles ne peuvent pas `require`, mais elles portent
// toutes le même commentaire de renvoi.
// ============================================================================

/* Total de séances d'un parcours Elite NEW. Volontairement dérivé du libellé
   du programme (« - 24C ») et pas écrit en dur : un futur « Elite NEW -
   6 Mois - 30C » suivra tout seul. La constante ne sert que de repli. */
const DEFAULT_TOTAL_SESSIONS = 24;

/**
 * Lit « Elite NEW - 6 Mois - 24C » → { mois: 6, seances: 24 }.
 * Même expression que getMonthlyQuota() dans coaching.html — les deux doivent
 * comprendre un libellé de la même façon.
 */
function parseProgramme(programme) {
  const p = String(programme || '').toLowerCase();
  const mMois = p.match(/(\d+)\s*mois/);
  const mSeances = p.match(/(\d+)\s*c\b/);
  const mois = mMois ? parseInt(mMois[1], 10) : 0;
  const seances = mSeances ? parseInt(mSeances[1], 10) : 0;
  return { mois: mois > 0 ? mois : 0, seances: seances > 0 ? seances : 0 };
}

/**
 * Quota MENSUEL d'un programme : nombre de séances ÷ durée du parcours.
 *
 *     BP 12 Mois - 12C         → 12/12 = 1
 *     BP 12 Mois - 24C         → 24/12 = 2
 *     BP 6 Mois - 6C           →  6/6  = 1   (programme arrêté le 13/08/2026,
 *                                             règle conservée pour l'archive)
 *     Elite - 12 Mois - 24C    → 24/12 = 2
 *     Elite NEW - 6 Mois - 24C → 24/6  = 4   (une séance par semaine)
 *
 * Libellé non reconnu (ni durée ni nombre de séances lisibles) → repli sur
 * l'ancienne table par suffixe, puis 1 par défaut : on préfère un quota trop
 * strict, rattrapable par un override, à un quota trop permissif silencieux.
 */
function monthlyQuotaFromProgramme(programme) {
  if (!programme) return 1;
  const { mois, seances } = parseProgramme(programme);
  if (mois && seances) return Math.max(1, Math.round(seances / mois));
  const p = String(programme).toLowerCase();
  if (p.includes('24c')) return 2;
  if (p.includes('12c')) return 1;
  if (p.includes('6c')) return 1;
  return 1;
}

/**
 * Quota EFFECTIF d'un mois donné : l'override posé par un coach ou un admin
 * sur la fiche client (clients/{id}.quotaOverrides["YYYY-MM"]) prime toujours
 * sur la règle dérivée du programme. 0 est une valeur valide — « aucun
 * coaching ce mois-ci » est un arbitrage légitime, pas une absence de valeur.
 */
function effectiveMonthlyQuota(clientData, monthYear /* "YYYY-MM" */) {
  const derived = monthlyQuotaFromProgramme(clientData && clientData.programme);
  const ov = clientData && clientData.quotaOverrides && clientData.quotaOverrides[monthYear];
  return (typeof ov === 'number' && ov >= 0) ? ov : derived;
}

/**
 * Le client est-il sur le parcours qui ouvre droit à la récurrence ?
 *
 * Décision d'Adrien (18/08/2026) : l'interrupteur de récurrence n'apparaît
 * QUE pour les nouveaux Elite — 24 séances condensées sur 6 mois, donc une
 * par semaine. Les autres programmes (BP 12C, BP 24C, Elite 12 mois) gardent
 * la réservation à l'unité : leur rythme est mensuel, pas hebdomadaire.
 *
 * Le « commence par Elite NEW » est repris tel quel de estParcoursEtapes()
 * dans coaching.html, pour qu'un seul libellé fasse foi des deux côtés.
 */
function isEliteNewWeekly(programme) {
  if (!/^\s*elite\s+new\b/i.test(String(programme || ''))) return false;
  const { mois, seances } = parseProgramme(programme);
  // Une séance par semaine ⇔ environ 4 par mois. On accepte 3,5 → 5 pour ne
  // pas se river à « exactement 6 mois / 24 séances ».
  if (!mois || !seances) return false;
  const parMois = seances / mois;
  return parMois >= 3.5 && parMois <= 5;
}

/** Nombre total de séances du parcours (24 pour Elite NEW 6 mois). */
function totalSessionsOf(programme) {
  const { seances } = parseProgramme(programme);
  return seances || DEFAULT_TOTAL_SESSIONS;
}

module.exports = {
  DEFAULT_TOTAL_SESSIONS,
  parseProgramme,
  monthlyQuotaFromProgramme,
  effectiveMonthlyQuota,
  isEliteNewWeekly,
  totalSessionsOf
};
