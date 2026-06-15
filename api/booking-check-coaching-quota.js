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
//   { ok:true, allowed:true,  clientFound:true,  used:1, quota:2, programme:"...", sessionsCount:1, bookingsCount:0 }
// Réponse 200 — client trouvé, quota épuisé :
//   { ok:true, allowed:false, clientFound:true,  used:2, quota:2, programme:"...", sessionsCount:1, bookingsCount:1 }
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
// Logique de comptage du mois courant
// -----------------------------------
//   used = sessions "fait" du mois (depuis c.sessions OU c.years[].sessions)
//        + bookings confirmed isCoaching=true du mois, MAIS uniquement ceux
//          dont la date est >= aujourd'hui (RDV à venir), en excluant ceux
//          flaggés excludeFromQuota === true
//   quota = clientData.quotaOverrides[monthYear] si présent (override admin)
//         | sinon 2 si c.programme contient "24c" (case-insensitive), sinon 1
//   → la partie "sessions fait" est strictement alignée sur coaching-shared.js
//     (getMonthlyQuota / getSessionsInMonth)
//
// Pourquoi "RDV à venir uniquement"
// ---------------------------------
//   Une séance déjà réalisée existe simultanément (1) en booking confirmed
//   (le statut ne bascule jamais en "done") et (2) en session "fait" saisie
//   dans coaching.html. Sommer les deux la comptait deux fois (quota 2/2 alors
//   que la fiche coaching affiche 1/2). En ne comptant que les bookings futurs,
//   un RDV passé n'est compté qu'une fois (via sessionsCount) et un RDV futur
//   réservé reste décompté pour empêcher le surbooking.
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

function normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

function getMonthlyQuota(programme) {
  if (!programme) return 1;
  return String(programme).toLowerCase().includes('24c') ? 2 : 1;
}

// Aplatit les sessions d'un client : supporte le format legacy (sessions[]
// flat à la racine) et le nouveau format (years[].sessions[]). Cohérent
// avec la fonction getAllSessions() dans coaching.html (ligne ~1380).
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

function countSessionsInMonth(c, monthYear /* "YYYY-MM" */) {
  const sessions = flattenSessions(c);
  return sessions.filter((s) => {
    if (!s || s.statut !== 'fait') return false;
    if (!s.date || typeof s.date !== 'string') return false;
    return s.date.slice(0, 7) === monthYear;
  }).length;
}

// Date du jour au format "YYYY-MM-DD" dans le fuseau métier (Europe/Paris).
// Le serveur Vercel tourne en UTC : on ancre explicitement sur Paris pour ne
// pas exclure à tort un RDV daté d'aujourd'hui aux abords de minuit.
function parisToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date());
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
    // ── 1. Cherche la fiche client coaching par email (case-insensitive) ───
    // On normalise côté code car Firestore est case-sensitive sur les ==.
    // On part du principe que les emails sont stockés en clair (potentielle-
    // ment avec une casse mixte). On fait deux tentatives : exact, puis
    // lowercase. Si rien, on déclare le client introuvable.
    let clientData = null;
    try {
      let snap = await db.collection('clients')
        .where('email', '==', email)
        .limit(2)
        .get();

      if (snap.empty) {
        // Fallback : tentative sur l'email tel quel (cas où la donnée a une
        // casse différente en base — rare mais on couvre).
        snap = await db.collection('clients')
          .where('email', '==', body.email)
          .limit(2)
          .get();
      }

      if (!snap.empty) {
        if (snap.size > 1) {
          console.warn('[check-coaching-quota] multiple clients for email', email);
        }
        clientData = snap.docs[0].data();
      }
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

    // ── 2. Compte les sessions "fait" du mois ──────────────────────────────
    const sessionsCount = countSessionsInMonth(clientData, monthYear);

    // ── 3. Compte les bookings confirmed isCoaching=true du mois ───────────
    // On filtre par prospect.email puis on raffine en mémoire sur isCoaching,
    // status, excludeFromQuota et date du mois. Volume très faible (1-2
    // bookings max par mois par email), pas d'enjeu de pagination.
    let bookingsCount = 0;
    try {
      const today = parisToday(); // "YYYY-MM-DD" — borne basse des RDV à venir
      const bSnap = await db.collection('bookings')
        .where('prospect.email', '==', email)
        .get();
      bSnap.forEach((doc) => {
        const b = doc.data();
        if (b.isCoaching !== true) return;
        if (b.status !== 'confirmed') return;
        if (b.excludeFromQuota === true) return; // exclu manuellement
        if (!b.date || typeof b.date !== 'string') return;
        if (b.date.slice(0, 7) !== monthYear) return;
        // Ne compter QUE les RDV à venir (date >= aujourd'hui). Un RDV déjà
        // passé correspond à une séance qui est (ou sera) enregistrée en
        // "fait" et donc déjà comptée dans sessionsCount : l'inclure ici la
        // compterait deux fois (bug du quota 2/2 alors que coaching affiche
        // 1/2). Le décompte vaut donc : séances faites + RDV à venir réservés.
        if (b.date.slice(0, 10) < today) return;
        bookingsCount++;
      });
    } catch (e) {
      console.error('[check-coaching-quota] bookings query error:', e);
      // Fail-open partiel : on retourne ce qu'on a déjà (sessionsCount)
    }

    const used = sessionsCount + bookingsCount;
    // Quota effectif : override mensuel sur la fiche client si présent,
    // sinon dérivé du programme. Permet à l'admin/coach d'accorder une
    // exception ponctuelle depuis coaching.html (fiche client → section
    // "Gestion du quota").
    const quotaDerived = getMonthlyQuota(clientData.programme);
    const overrideRaw = (clientData.quotaOverrides && clientData.quotaOverrides[monthYear]);
    const quotaOverride = (typeof overrideRaw === 'number' && overrideRaw >= 0) ? overrideRaw : null;
    const quota = quotaOverride !== null ? quotaOverride : quotaDerived;
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
