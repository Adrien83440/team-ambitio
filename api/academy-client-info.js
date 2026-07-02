// ============================================================================
// api/academy-client-info.js — PONT AE ACADEMY → TEAM ALTEOR (V11a)
// ----------------------------------------------------------------------------
// La plateforme de formation (academy.adrienemily.com) appelle cet endpoint
// pour afficher, dans sa fiche « Dossier de renouvellement », le coaching du
// client : séances réalisées, quota du mois en cours, dernière séance et
// dernier compte-rendu.
//
// URL  : POST https://team.alteore.com/api/academy-client-info
// Auth : header  x-bridge-key  = ACADEMY_BRIDGE_KEY (secret partagé, la même
//        valeur dans les variables Vercel des DEUX projets). Appels serveur →
//        serveur uniquement : le secret ne transite JAMAIS par un navigateur.
// CORS : aucun besoin (pas d'appel navigateur) — pas d'en-têtes CORS ouverts.
//
// Body (JSON) :
//   { "email": "client@exemple.com" }     // requis, case-insensitive
//
// Réponse 200 — client trouvé :
//   { ok:true, found:true,
//     client   : { id, nom, statut },
//     programme: "PHENIX 24C…",
//     quota    : { monthYear:"2026-07", used:1, quota:2 },
//     sessions : { total:9, lastAt:"2026-06-24", lastCoach:"…", lastResume:"…" },
//     links    : { coaching:"…/coaching.html", csm:"…/csm-clients.html" } }
// Réponse 200 — client introuvable : { ok:true, found:false }
// Erreurs : 401 (clé absente/invalide) · 405 · 500
//
// LECTURE SEULE — cet endpoint n'écrit rien, nulle part.
//
// Logique de comptage : strictement alignée sur coaching.html —
//   • flattenSessions()      : years[].sessions[] sinon sessions[] (legacy),
//     identique à getAllSessions() (coaching.html ~1380) et à
//     booking-check-coaching-quota.js ;
//   • total « séances réalisées » : statut==='fait' && numero!==0 &&
//     type!=='rdv72h' (le compteur global de coaching.html, ligne ~1658) ;
//   • dernière séance : dernière 'fait' avec un coach (ligne ~1795) ;
//   • quota du mois : quotaOverrides[monthYear] sinon 2 si programme
//     contient « 24c », sinon 1 ; used = sessions 'fait' du mois.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const ALTEOR_BASE = 'https://team.alteore.com';

function normEmail(e) {
  return (e || '').toString().trim().toLowerCase();
}

function getMonthlyQuota(programme) {
  if (!programme) return 1;
  return String(programme).toLowerCase().includes('24c') ? 2 : 1;
}

// Aplatit les sessions d'un client (years[].sessions[] sinon sessions[]).
function flattenSessions(c) {
  const all = [];
  if (Array.isArray(c.years) && c.years.length) {
    c.years.forEach((y) => {
      if (Array.isArray(y && y.sessions)) y.sessions.forEach((s) => all.push(s));
    });
  } else if (Array.isArray(c.sessions)) {
    c.sessions.forEach((s) => all.push(s));
  }
  return all;
}

function countSessionsInMonth(c, monthYear /* "YYYY-MM" */) {
  return flattenSessions(c).filter((s) => {
    if (!s || s.statut !== 'fait') return false;
    if (!s.date || typeof s.date !== 'string') return false;
    return s.date.slice(0, 7) === monthYear;
  }).length;
}

// Mois courant "YYYY-MM" dans le fuseau métier (Europe/Paris) — le serveur
// Vercel tourne en UTC, on ancre sur Paris comme booking-check.
function parisMonthYear() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date()).slice(0, 7);
}

// Construit le résumé coaching d'une fiche client (PURE — testable).
function coachingSummary(clientData, monthYear) {
  const all = flattenSessions(clientData);

  // Total « séances réalisées » — mêmes exclusions que le compteur global
  // de coaching.html (numero 0 = séance d'accueil, rdv72h = suivi éclair).
  const total = all.filter((s) => s && s.statut === 'fait' && s.numero !== 0 && s.type !== 'rdv72h').length;

  // Dernière séance faite AVEC un coach (comme la carte kanban).
  const done = all
    .filter((s) => s && s.coach && s.statut === 'fait' && s.date)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const last = done.length ? done[done.length - 1] : null;

  // Dernier compte-rendu non vide parmi les séances faites (la plus récente d'abord).
  let lastResume = '';
  for (let i = done.length - 1; i >= 0; i--) {
    const r = (done[i].resume || '').toString().trim();
    if (r) { lastResume = r; break; }
  }
  if (lastResume.length > 800) lastResume = lastResume.slice(0, 800).trim() + ' […]';

  const overrides = (clientData.quotaOverrides && typeof clientData.quotaOverrides === 'object') ? clientData.quotaOverrides : {};
  const quota = (typeof overrides[monthYear] === 'number') ? overrides[monthYear] : getMonthlyQuota(clientData.programme);
  const used = countSessionsInMonth(clientData, monthYear);

  return {
    programme: clientData.programme || '',
    quota: { monthYear, used, quota },
    sessions: {
      total,
      lastAt: last ? String(last.date).slice(0, 10) : '',
      lastCoach: last ? (last.coach || '') : '',
      lastResume,
    },
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ── Secret partagé serveur → serveur ───────────────────────────────────────
  const expected = process.env.ACADEMY_BRIDGE_KEY || '';
  const got = (req.headers['x-bridge-key'] || '').toString();
  if (!expected || got !== expected) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const body = parseBody(req);
  const email = normEmail(body.email);
  if (!email) {
    res.status(400).json({ ok: false, error: 'email_required' });
    return;
  }

  try {
    // ── Fiche client par email — même stratégie que booking-check ───────────
    // (exact normalisé, fallback casse d'origine, warning si doublons).
    let clientDoc = null;
    let snap = await db.collection('clients').where('email', '==', email).limit(2).get();
    if (snap.empty && body.email && body.email !== email) {
      snap = await db.collection('clients').where('email', '==', body.email).limit(2).get();
    }
    if (!snap.empty) {
      if (snap.size > 1) console.warn('[academy-client-info] multiple clients for email', email);
      clientDoc = snap.docs[0];
    }

    if (!clientDoc) {
      res.status(200).json({ ok: true, found: false });
      return;
    }

    const c = clientDoc.data();
    const summary = coachingSummary(c, parisMonthYear());

    res.status(200).json({
      ok: true,
      found: true,
      client: { id: clientDoc.id, nom: c.nom || c.name || '', statut: c.statut || '' },
      programme: summary.programme,
      quota: summary.quota,
      sessions: summary.sessions,
      links: { coaching: ALTEOR_BASE + '/coaching.html', csm: ALTEOR_BASE + '/csm-clients.html' },
    });
  } catch (e) {
    console.error('[academy-client-info]', e);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};

// Helpers exposés pour les tests (aucun effet en production).
module.exports.__test = { normEmail, getMonthlyQuota, flattenSessions, countSessionsInMonth, coachingSummary };
