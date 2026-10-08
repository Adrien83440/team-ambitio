// ============================================================================
// api/booking-check-coaching-quota.js
// ----------------------------------------------------------------------------
// Endpoint public appelé par booking.html avant la création d'un booking sur
// un type de consultation marqué isCoaching=true. Vérifie que le client n'a
// pas dépassé son quota mensuel de coachings et, si client introuvable en
// base, signale le cas pour qu'un flag soit posé sur le booking.
//
// URL  : POST https://team.alteore.com/api/booking-check-coaching-quota
// Auth : aucune — endpoint public (visiteur anonyme du booking)
// CORS : ouvert
//
// Body (JSON) :
//   {
//     email     : "client@exemple.com",   // requis, case-insensitive
//     monthYear : "2026-05"               // requis, format YYYY-MM
//   }
//
// Réponse 200 — client trouvé, quota OK :
//   { ok:true, allowed:true,  clientFound:true,  used:1, quota:2, programme:"...", sessionsCount:1, bookingsCount:1, pairedCount:1 }
// Réponse 200 — client trouvé, quota épuisé :
//   { ok:true, allowed:false, clientFound:true,  used:2, quota:2, programme:"...", sessionsCount:1, bookingsCount:1, pairedCount:0 }
// Réponse 200 — client introuvable (laisse passer, flag posé côté client) :
//   { ok:true, allowed:true,  clientFound:false, used:0, quota:0 }
//
// POURQUOI cet endpoint existe (au lieu du SDK Firestore côté frontend)
// --------------------------------------------------------------------
// La page booking.html est publique (non authentifiée). Les rules Firestore
// /clients/{id} exigent isCoachOrAdminOrCsm() pour lire — le SDK Web depuis
// un visiteur anonyme est rejeté. On délègue donc à cette Vercel Function
// qui utilise l'Admin SDK et bypass les rules. On n'expose au client que le
// strict nécessaire : { allowed, used, quota, clientFound, programme }.
//
// ────────────────────────────────────────────────────────────────────────────
// COMPTAGE DU MOIS — APPARIEMENT PAR JOUR (corrigé le 28/08/2026)
// ────────────────────────────────────────────────────────────────────────────
// Une même séance de coaching laisse DEUX traces indépendantes en base :
//   (1) un `bookings/{id}` confirmed isCoaching:true — posé à la réservation,
//       qui ne bascule JAMAIS en "done" ;
//   (2) une séance `statut:'fait'` dans clients/{id}.years[].sessions[] —
//       saisie À LA MAIN par le coach dans coaching.html, parfois plusieurs
//       jours après le RDV, parfois jamais (RDV pris hors plateforme → seule
//       la trace (2) existe ; RDV honoré mais non saisi → seule (1) existe).
//
// L'ancienne règle sommait « séances faites + RDV À VENIR », en ignorant
// délibérément les RDV passés pour ne pas compter deux fois une séance ayant
// ses deux traces. Elle ouvrait un trou béant : entre le RDV honoré et sa
// saisie par le coach, le client comptait 0 séance sur le mois et pouvait en
// réserver une seconde. C'est ainsi qu'un BP 12 Mois - 12C (quota 1) a pris
// deux coachings en août 2026.
//
// Nouvelle règle : on regroupe les deux sources PAR JOUR et on retient, pour
// chaque jour du mois, le maximum des deux — jamais leur somme.
//
//   used = Σ_(jours du mois) max( séances "fait" ce jour, bookings ce jour )
//
//   RDV le 05 honoré et saisi   → max(1,1) = 1  (plus de double comptage)
//   RDV le 05 honoré, non saisi → max(0,1) = 1  ← le trou est fermé
//   Séance le 12 saisie sans booking (RDV hors plateforme) → max(1,0) = 1
//   RDV le 20 à venir           → max(0,1) = 1  (anti-surbooking conservé)
//   RDV le 05 annulé puis reposé le 20 → le doc cancelled est ignoré, 1 seul
//
// Un RDV replanifié bascule en status 'cancelled' (+ rescheduled) : il sort
// donc du décompte de lui-même, et seul le nouveau créneau compte.
//
// ────────────────────────────────────────────────────────────────────────────
// CASSE DE L'EMAIL
// ────────────────────────────────────────────────────────────────────────────
// booking.html normalise `prospect.email` en minuscules depuis le 28/08/2026,
// mais l'historique contient des graphies mixtes (« Jean.Dupont@x.com ») :
// Firestore compare la casse, donc ces bookings étaient invisibles au quota et
// le client n'était JAMAIS bloqué. On interroge donc les deux graphies et on
// dédoublonne par identifiant de document — même précaution que
// countUpcomingCoachingBookings() dans api/_recurrence-core.js.
//
// Même problème sur la fiche `clients` : si aucune des deux graphies exactes
// ne matche, on tombait en clientFound:false → fail-open → réservation
// autorisée en silence. On ajoute un balayage de secours insensible à la casse
// (cf. findClientByEmail), déclenché uniquement quand les requêtes indexées
// ont échoué.
//
// ────────────────────────────────────────────────────────────────────────────
// QUOTA MENSUEL
// ────────────────────────────────────────────────────────────────────────────
//   quota = clientData.quotaOverrides[monthYear] si présent (override admin)
//         | sinon séances ÷ durée du programme, lues sur le libellé
//           (« Elite NEW - 6 Mois - 24C » → 24/6 = 4).
// La règle vit dans api/_coaching-quota.js (monthlyQuotaFromProgramme),
// partagée avec la récurrence hebdomadaire et l'Academy — un seul endroit à
// corriger si elle bouge :
//     BP 12 Mois - 12C         → 12/12 = 1
//     BP 12 Mois - 24C         → 24/12 = 2
//     Elite - 12 Mois - 24C    → 24/12 = 2
//     Elite NEW - 6 Mois - 24C → 24/6  = 4
//
// La séance d'accueil (numero 0) et le RDV 72h éclair (type 'rdv72h') sont
// exclus du décompte : séances d'onboarding offertes, hors quota mensuel.
// Alignement strict avec coaching.html (getSessionsInMonth), coaching-shared.js,
// academy-client-info.js, csm-dashboard.html et csm-clients.html.
//
// Overrides manuels (gérés depuis coaching.html, fiche client)
// ------------------------------------------------------------
//   c.quotaOverrides : { "2026-05": 2, "2026-06": 1, ... }
//     Map mois → quota effectif pour ce mois précis. Permet à l'admin/coach
//     d'accorder une exception (ex: passer un client 12C à 2 séances pour
//     un mois donné, suite à paiement supplémentaire ou rattrapage).
//   b.excludeFromQuota : true sur un booking pour le sortir du décompte
//     (typiquement booking erroné/doublon/test qui ne doit pas compter).
//     Réversible — le doc reste en base.
//
// Cas particulier : si plusieurs fiches clients ont le même email (anomalie
// de données), on prend la première trouvée et on logge un warning.
//
// Fail-open : en cas d'erreur Firestore inattendue, on retourne allowed:true
// pour ne pas bloquer un RDV légitime sur un problème transitoire. Le coach
// pourra toujours vérifier manuellement après coup.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { effectiveMonthlyQuota, monthlyQuotaFromProgramme } = require('./_coaching-quota');

function normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

/* Quota mensuel — règle unique, partagée avec la récurrence hebdomadaire. */
const getMonthlyQuota = monthlyQuotaFromProgramme;

// Aplatit les sessions d'un client : supporte le format legacy (sessions[]
// flat à la racine) et le nouveau format (years[].sessions[]). Cohérent
// avec la fonction getAllSessions() dans coaching.html (ligne ~1546).
function flattenSessions(c) {
  const all = [];
  if (Array.isArray(c.years) && c.years.length) {
    c.years.forEach((y) => {
      if (Array.isArray(y && y.sessions)) {
        y.sessions.forEach((s) => all.push(s));
      }
    });
  } else if (Array.isArray(c.sessions)) {
    c.sessions.forEach((s) => all.push(s));
  }
  return all;
}

/**
 * Séances "fait" du mois, regroupées PAR JOUR : { "2026-08-05": 1, ... }
 * Exclut la séance d'accueil (numero 0) et le RDV 72h éclair.
 */
function sessionDayCounts(c, monthYear /* "YYYY-MM" */) {
  const byDay = {};
  flattenSessions(c).forEach((s) => {
    if (!s || s.statut !== 'fait') return;
    if (s.numero === 0 || s.type === 'rdv72h') return;
    if (!s.date || typeof s.date !== 'string') return;
    const day = s.date.slice(0, 10);
    if (day.slice(0, 7) !== monthYear) return;
    byDay[day] = (byDay[day] || 0) + 1;
  });
  return byDay;
}

/**
 * Bookings coaching confirmés du mois, regroupés PAR JOUR.
 * Passés ET à venir : le passé est apparié aux séances "fait" par
 * countUsed(), il n'est donc jamais compté deux fois (cf. en-tête).
 *
 * Interroge les deux graphies de l'email (brute et minuscule) et dédoublonne
 * par identifiant de document — l'historique contient des `prospect.email`
 * en casse mixte, invisibles à une requête en minuscules.
 *
 * @returns {Promise<{byDay:Object, total:number}>}
 */
async function bookingDayCounts(rawEmail, monthYear) {
  const raw = String(rawEmail || '').trim();
  const lower = raw.toLowerCase();
  const variants = raw && raw !== lower ? [lower, raw] : [lower];

  const seen = {};
  const byDay = {};
  let total = 0;

  for (const v of variants) {
    if (!v) continue;
    const snap = await db.collection('bookings').where('prospect.email', '==', v).get();
    snap.forEach((doc) => {
      if (seen[doc.id]) return;
      const b = doc.data();
      if (b.isCoaching !== true) return;
      if (b.status !== 'confirmed') return;      // annulé / replanifié → hors quota
      if (b.excludeFromQuota === true) return;   // exclu manuellement par un coach
      if (!b.date || typeof b.date !== 'string') return;
      const day = b.date.slice(0, 10);
      if (day.slice(0, 7) !== monthYear) return;
      seen[doc.id] = 1;
      byDay[day] = (byDay[day] || 0) + 1;
      total++;
    });
  }
  return { byDay: byDay, total: total };
}

/**
 * Consommation du mois : pour chaque jour, le MAX des deux sources — jamais
 * leur somme. Voir l'en-tête du fichier pour le pourquoi détaillé.
 *
 * @returns {{used:number, paired:number}} paired = nb de séances ayant leurs
 *          deux traces le même jour (utile au diagnostic côté admin).
 */
function countUsed(sessionsByDay, bookingsByDay) {
  const days = {};
  Object.keys(sessionsByDay).forEach((d) => { days[d] = 1; });
  Object.keys(bookingsByDay).forEach((d) => { days[d] = 1; });

  let used = 0;
  let paired = 0;
  Object.keys(days).forEach((d) => {
    const s = sessionsByDay[d] || 0;
    const b = bookingsByDay[d] || 0;
    used += Math.max(s, b);
    paired += Math.min(s, b);
  });
  return { used: used, paired: paired };
}

/**
 * Retrouve la fiche coaching d'un email, quelle que soit la casse en base.
 *
 * 1. requête indexée sur l'email normalisé (cas nominal) ;
 * 2. requête indexée sur la graphie brute saisie par le visiteur ;
 * 3. balayage de secours insensible à la casse — uniquement si 1 et 2 ont
 *    échoué. Sans lui, une fiche client enregistrée « Jean.Dupont@x.com »
 *    renvoyait clientFound:false, donc un fail-open silencieux : le client
 *    n'était jamais bloqué. Le balayage ne lit que le champ `email`
 *    (projection `select`) puis recharge le seul document retenu.
 *
 * @returns {Promise<{data:Object|null, matchedBy:string}>}
 */
async function findClientByEmail(rawEmail) {
  const raw = String(rawEmail || '').trim();
  const lower = raw.toLowerCase();
  const variants = raw && raw !== lower ? [lower, raw] : [lower];

  for (const v of variants) {
    if (!v) continue;
    const snap = await db.collection('clients').where('email', '==', v).limit(2).get();
    if (!snap.empty) {
      if (snap.size > 1) console.warn('[check-coaching-quota] multiple clients for email', lower);
      return { data: snap.docs[0].data(), matchedBy: 'exact' };
    }
  }

  // Balayage de secours insensible à la casse. Ne se déclenche que si les
  // deux requêtes indexées ont échoué (email inconnu, ou casse divergente en
  // base) : projection sur le seul champ `email`, et garde-fou de volume pour
  // qu'une collection anormalement grosse ne fasse jamais exploser le temps
  // de réponse d'une réservation.
  const all = await db.collection('clients').select('email').limit(5000).get();
  let hitId = null;
  all.forEach((doc) => {
    if (hitId) return;
    const e = ((doc.get('email') || '') + '').trim().toLowerCase();
    if (e && e === lower) hitId = doc.id;
  });
  if (!hitId) return { data: null, matchedBy: 'none' };

  console.warn('[check-coaching-quota] client trouvé par balayage insensible à la casse — '
    + 'email à normaliser sur clients/' + hitId);
  const full = await db.collection('clients').doc(hitId).get();
  return { data: full.exists ? full.data() : null, matchedBy: 'scan' };
}

module.exports = async (req, res) => {
  // ── CORS ouvert (visiteur anonyme depuis booking.html) ────────────────────
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req);
  const email = normEmail(body.email);
  const monthYear = (body.monthYear || '').toString().slice(0, 7);

  if (!email) {
    res.status(400).json({ error: 'email_required' });
    return;
  }
  if (!/^\d{4}-\d{2}$/.test(monthYear)) {
    res.status(400).json({ error: 'monthYear_invalid', hint: 'expected YYYY-MM' });
    return;
  }

  try {
    // ── 1. Cherche la fiche client coaching par email ──────────────────────
    let clientData = null;
    let matchedBy = 'none';
    try {
      const found = await findClientByEmail(body.email || email);
      clientData = found.data;
      matchedBy = found.matchedBy;
    } catch (e) {
      console.error('[check-coaching-quota] clients query error:', e);
      // Fail-open : on laisse passer (cf doc en haut)
      res.status(200).json({
        ok: true, allowed: true, clientFound: false, used: 0, quota: 0,
        warning: 'clients_query_failed'
      });
      return;
    }

    if (!clientData) {
      // Client introuvable → on laisse passer, le frontend posera un flag
      // coachingClientNotFound:true sur le booking pour avertir le coach.
      res.status(200).json({
        ok: true,
        allowed: true,
        clientFound: false,
        used: 0,
        quota: 0
      });
      return;
    }

    // ── 1bis. Fin d'accompagnement : un ancien client (ou une fiche passée
    // inactive côté coach) ne peut plus réserver de coaching, quel que soit
    // son quota. Le frontend affiche un message dédié (reason
    // 'client_inactive') — y compris en mode agent CSM : il faut réactiver
    // la fiche (CSM / Admin Personnes) avant de pouvoir reprendre un RDV.
    if (clientData.ancienClient === true || clientData.statut === 'inactif') {
      res.status(200).json({
        ok: true,
        allowed: false,
        clientFound: true,
        reason: 'client_inactive',
        used: 0,
        quota: 0,
        programme: clientData.programme || null
      });
      return;
    }

    // ── 2. Séances "fait" du mois, par jour ────────────────────────────────
    const sessionsByDay = sessionDayCounts(clientData, monthYear);
    let sessionsCount = 0;
    Object.keys(sessionsByDay).forEach((d) => { sessionsCount += sessionsByDay[d]; });

    // ── 3. Bookings coaching confirmés du mois, par jour ───────────────────
    // Volume très faible (quelques bookings par email), pas d'enjeu de
    // pagination. En cas d'échec on continue avec les seules séances "fait"
    // (fail-open partiel) plutôt que de bloquer un RDV légitime.
    let bookingsByDay = {};
    let bookingsCount = 0;
    try {
      const bk = await bookingDayCounts(body.email || email, monthYear);
      bookingsByDay = bk.byDay;
      bookingsCount = bk.total;
    } catch (e) {
      console.error('[check-coaching-quota] bookings query error:', e);
    }

    // ── 4. Consommation : max par jour, jamais la somme ────────────────────
    const tally = countUsed(sessionsByDay, bookingsByDay);
    const used = tally.used;

    // Quota effectif : override mensuel sur la fiche client si présent,
    // sinon dérivé du programme. Permet à l'admin/coach d'accorder une
    // exception ponctuelle depuis coaching.html (fiche client → section
    // "Gestion du quota").
    const quotaDerived = getMonthlyQuota(clientData.programme);
    const overrideRaw = (clientData.quotaOverrides && clientData.quotaOverrides[monthYear]);
    const quotaOverride = (typeof overrideRaw === 'number' && overrideRaw >= 0) ? overrideRaw : null;
    const quota = effectiveMonthlyQuota(clientData, monthYear);
    const allowed = used < quota;

    res.status(200).json({
      ok: true,
      allowed: allowed,
      clientFound: true,
      used: used,
      quota: quota,
      quotaDerived: quotaDerived,
      quotaOverride: quotaOverride,
      sessionsCount: sessionsCount,
      bookingsCount: bookingsCount,
      pairedCount: tally.paired,
      clientMatchedBy: matchedBy,
      programme: clientData.programme || null
    });
  } catch (e) {
    console.error('[check-coaching-quota] unexpected error:', e);
    // Fail-open final
    res.status(200).json({
      ok: true,
      allowed: true,
      clientFound: false,
      used: 0,
      quota: 0,
      warning: 'internal_error'
    });
  }
};

// Exporté pour les tests unitaires — la logique d'appariement mérite d'être
// vérifiée sans Firestore.
module.exports.__test = { normEmail, flattenSessions, sessionDayCounts, countUsed, getMonthlyQuota };
