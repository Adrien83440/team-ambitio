// ============================================================================
// api/coaching-client-brief.js — BRIEF DE CONTINUITÉ COACH
// ----------------------------------------------------------------------------
// Génère (et met en cache) une synthèse IA courte de la fiche coaching d'un
// client, pensée pour un coach qui s'apprête à faire une séance — surtout
// s'il voit le client pour la première fois : où en est le client, la
// chronologie express des séances, et quoi travailler au prochain coaching
// (déduit en priorité des DERNIÈRES séances et des devoirs donnés).
//
// URL  : POST https://team.alteore.com/api/coaching-client-brief
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { clientId, force? }
//
// Cache : le brief est stocké sur clients/{id}.aiBrief :
//   { text, key, generatedAt, model, sessionsCount }
// La clé `key` est une empreinte des séances faites (nombre + identité de la
// dernière). Si la clé n'a pas changé et force !== true → on renvoie le
// cache sans appeler l'IA (0 coût). Une nouvelle séance marquée « fait »
// change la clé → régénération auto au prochain affichage de la fiche.
//
// Variables Vercel requises : ANTHROPIC_API_KEY (déjà en place, cf.
// academy-path.js).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ROLES = ['admin', 'coach', 'csm'];
const MODEL = 'claude-haiku-4-5-20251001';

// ---------------------------------------------------------------------------
//  Helpers fiche coaching
// ---------------------------------------------------------------------------

function allSessions(c) {
  const out = [];
  ((c.years) || []).forEach(function (y) { ((y.sessions) || []).forEach(function (s) { if (s) out.push(s); }); });
  if (!(c.years && c.years.length)) {
    ((c.sessions) || []).forEach(function (s) { if (s) out.push(s); });
  }
  return out;
}

// Séances faites, triées chronologiquement (date puis numéro).
function doneSessions(c) {
  return allSessions(c)
    .filter(function (s) { return s.statut === 'fait'; })
    .sort(function (a, b) {
      const da = String(a.date || ''), dbb = String(b.date || '');
      if (da !== dbb) return da < dbb ? -1 : 1;
      return (a.numero || 0) - (b.numero || 0);
    });
}

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// Empreinte de fraîcheur du brief. Doit rester STRICTEMENT identique à
// computeBriefKey() côté coaching.html (le front s'en sert pour décider
// d'appeler ou non cette fonction à l'ouverture de la fiche).
function briefKey(c) {
  const done = doneSessions(c);
  if (!done.length) return 'none';
  const last = done[done.length - 1];
  return done.length + ':' + (last.numero || 0) + ':' + String(last.date || '') + ':' + String(last.resume || '').length;
}

// ---------------------------------------------------------------------------
//  Prompt
// ---------------------------------------------------------------------------

function buildPrompt(c) {
  const done = doneSessions(c);
  const L = [];

  L.push('Tu es l\'assistant des coachs business d\'Alteor (accompagnement francophone d\'entrepreneurs).');
  L.push('Rédige un BRIEF DE CONTINUITÉ ultra-concis pour un coach qui s\'apprête à faire une séance avec ce client — peut-être pour la première fois. Il doit comprendre en 30 secondes où en est le client et quoi travailler.');
  L.push('');
  L.push('FICHE CLIENT :');
  L.push('- Nom : ' + (c.nom || '(inconnu)'));
  L.push('- Programme : ' + (c.programme || '(non renseigné)'));
  if (c.activite) L.push('- Activité : ' + cap(c.activite, 200));
  if (c.dateEntree) L.push('- Client depuis : ' + c.dateEntree);
  if (c.planAction) L.push('- Plan d\'action : ' + cap(c.planAction, 2500));
  if (c.clientNotes) L.push('- Notes internes : ' + cap(c.clientNotes, 1200));
  L.push('');
  L.push('SÉANCES FAITES (ordre chronologique — les 3 DERNIÈRES sont les plus importantes, appuie surtout ta section « À TRAVAILLER » dessus) :');

  const n = done.length;
  done.forEach(function (s, i) {
    const isRecent = i >= n - 3;
    const parts = [];
    parts.push('#' + (s.numero || (i + 1)) + (s.date ? ' — ' + s.date : '') + (s.coach ? ' — coach : ' + s.coach : ''));
    if (s.resume) parts.push('  Résumé : ' + cap(s.resume, isRecent ? 1500 : 280));
    if (s.devoirs) parts.push('  Devoirs donnés : ' + cap(s.devoirs, isRecent ? 600 : 150));
    if (!s.resume && !s.devoirs) parts.push('  (pas de résumé saisi)');
    L.push(parts.join('\n'));
  });

  L.push('');
  L.push('FORMAT DE SORTIE — texte brut en français, exactement ces 3 sections, max 180 mots au total :');
  L.push('📍 SITUATION');
  L.push('2-3 phrases : où en est le client aujourd\'hui.');
  L.push('🧭 PARCOURS');
  L.push('3 à 5 puces (tiret simple) : chronologie express des grandes étapes du coaching.');
  L.push('🎯 À TRAVAILLER');
  L.push('2 à 4 puces (tiret simple) : sur quoi le prochain coaching doit porter — déduit en priorité des dernières séances et des devoirs donnés.');
  L.push('');
  L.push('Règles : aucune invention — si une info manque, ne la mentionne pas. Pas de markdown lourd (pas de **, pas de #). Pas de préambule ni de conclusion : commence directement par « 📍 SITUATION ».');

  return L.join('\n');
}

async function askClaude(prompt) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 700,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(function () { return null; });
  if (!j || !Array.isArray(j.content)) return '';
  return j.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n').trim();
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(200).json({ ok: false, error: 'forbidden' });
    return;
  }

  let body = {};
  try { body = typeof req.body === 'object' && req.body ? req.body : JSON.parse(req.body || '{}'); }
  catch (e) { body = {}; }
  const clientId = String(body.clientId || '').trim();
  const force = body.force === true;
  if (!clientId) {
    res.status(200).json({ ok: false, error: 'clientId_required' });
    return;
  }

  try {
    const cSnap = await db.collection('clients').doc(clientId).get();
    if (!cSnap.exists) {
      res.status(200).json({ ok: false, error: 'client_not_found' });
      return;
    }
    const c = cSnap.data() || {};

    const done = doneSessions(c);
    if (!done.length) {
      // Pas encore de séance faite : rien à synthétiser, pas d'appel IA.
      res.status(200).json({ ok: true, empty: true });
      return;
    }

    const key = briefKey(c);

    // Cache hit : brief à jour et pas de régénération forcée → 0 coût.
    if (!force && c.aiBrief && c.aiBrief.key === key && c.aiBrief.text) {
      res.status(200).json({ ok: true, cached: true, brief: c.aiBrief });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ ok: false, error: 'anthropic_not_configured' });
      return;
    }

    const text = await askClaude(buildPrompt(c));
    if (!text) {
      res.status(200).json({ ok: false, error: 'ia_empty_response' });
      return;
    }

    const brief = {
      text: cap(text, 4000),
      key: key,
      generatedAt: Date.now(),
      model: MODEL,
      sessionsCount: done.length,
    };

    await db.collection('clients').doc(clientId).update({
      aiBrief: brief,
      _updatedAt: Date.now(),
    });

    res.status(200).json({ ok: true, cached: false, brief: brief });
  } catch (e) {
    console.error('[coaching-client-brief] erreur', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
