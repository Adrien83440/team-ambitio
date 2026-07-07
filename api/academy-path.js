// ============================================================================
// api/academy-path.js — COPILOTE DE PARCOURS (Vague C)
// ----------------------------------------------------------------------------
// Deux actions, appelées depuis la fiche coaching (coaching.html) :
//
//   action:"propose" → l'IA lit la fiche coaching (plan d'action, dernières
//     séances, synthèse Google du dernier coaching, questionnaire s'il existe)
//     ET la route actuelle de l'élève (via le pont), puis PROPOSE le meilleur
//     ordre des sujets + un objectif affiché à l'élève. Rien n'est écrit.
//
//   action:"apply"   → après validation humaine (un clic), écrit le parcours
//     dans l'Academy via le pont /api/bridge/set-path, et trace l'opération
//     dans la fiche client (academyPathHistory).
//
// URL  : POST https://team.alteore.com/api/academy-path
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body propose : { action:"propose", email, courseId, clientId }
// Body apply   : { action:"apply", email, courseId, clientId,
//                  objectif, steps:[{subId,force}], resume? }
//
// Variables Vercel requises : ACADEMY_BRIDGE_KEY (déjà en place),
// ANTHROPIC_API_KEY (nouvelle — clé API Anthropic du projet Alteor).
//
// Garde-fous : la proposition de l'IA est RÉPARÉE ici (sujets inconnus
// retirés, manquants réinsérés, jamais de verrou sur un sujet terminé), puis
// le pont set-path ré-aligne encore côté Academy. Double filet.
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];
const MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
//  Fiche coaching → contexte pour l'IA
// ---------------------------------------------------------------------------

function allSessions(c) {
  const out = [];
  ((c.years) || []).forEach(function (y) { ((y.sessions) || []).forEach(function (s) { out.push(s); }); });
  ((c.sessions) || []).forEach(function (s) { out.push(s); });
  return out.sort(function (a, b) { return (a.numero || 0) - (b.numero || 0); });
}

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

function coachingContext(c) {
  const L = [];
  L.push('- Programme : ' + (c.programme || '(non renseigné)'));
  L.push('- Plan d\'action : ' + (c.planAction ? cap(c.planAction, 4000) : '(non renseigné)'));
  if (c.questionnaire) {
    let q;
    if (Array.isArray(c.questionnaire.answers)) {
      q = c.questionnaire.answers.map(function (x) { return 'Q: ' + x.q + ' — R: ' + x.a; }).join('\n    ');
    } else {
      q = typeof c.questionnaire === 'string' ? c.questionnaire : JSON.stringify(c.questionnaire);
    }
    L.push('- Questionnaire' + (c.questionnaire.formTitle ? ' (' + c.questionnaire.formTitle + ')' : '') + ' :\n    ' + cap(q, 4000));
  } else {
    L.push('- Questionnaire : (pas encore rempli)');
  }
  const sess = allSessions(c).filter(function (s) { return s && s.statut === 'fait'; }).slice(-6);
  if (sess.length === 0) {
    L.push('- Séances : aucune séance réalisée pour le moment.');
  } else {
    L.push('- Dernières séances (de la plus ancienne à la plus récente) :');
    sess.forEach(function (s) {
      let line = '  — Séance ' + (s.numero != null ? s.numero : '?') + (s.date ? ' (' + s.date + ')' : '') + (s.titre ? ' « ' + cap(s.titre, 120) + ' »' : '');
      if (s.resume) line += '\n    Résumé coach : ' + cap(s.resume, 1500);
      if (s.devoirs) line += '\n    Devoirs : ' + cap(s.devoirs, 600);
      if (s.driveSummary) line += '\n    Synthèse détaillée (Google) : ' + cap(s.driveSummary, 6000);
      L.push(line);
    });
  }
  return L.join('\n');
}

// ---------------------------------------------------------------------------
//  Route actuelle → texte pour l'IA + réparation de la proposition
// ---------------------------------------------------------------------------

function routeText(path) {
  const st = { done: 'terminé', open: 'ouvert', locked: 'verrouillé' };
  return (path.steps || []).map(function (s, i) {
    let line = (i + 1) + '. [' + s.key + '] « ' + s.title + ' » — ' + (st[s.status] || s.status) + ' (' + (s.done || 0) + '/' + (s.total || 0) + ' leçons)';
    if (s.force === 'open') line += ' [forcé ouvert]';
    if (s.force === 'lock') line += ' [repoussé]';
    if (s.aiPinned) line += ' [ÉPINGLÉ — ne jamais déplacer]';
    return line;
  }).join('\n');
}

// Répare la proposition de l'IA : uniquement les subIds connus, chacun une
// fois, les manquants réinsérés dans l'ordre actuel, jamais de verrou sur un
// sujet terminé.
function repairSteps(proposedSteps, currentSteps) {
  const known = {}; const doneKeys = {};
  currentSteps.forEach(function (s) { known[s.key] = true; if (s.status === 'done') doneKeys[s.key] = true; });
  const seen = {};
  const out = [];
  (Array.isArray(proposedSteps) ? proposedSteps : []).forEach(function (st) {
    const id = st && typeof st.subId === 'string' ? st.subId : '';
    if (!id || !known[id] || seen[id]) return;
    seen[id] = true;
    let force = st.force === 'open' || st.force === 'lock' ? st.force : null;
    if (force === 'lock' && doneKeys[id]) force = null;
    out.push({ subId: id, force: force });
  });
  currentSteps.forEach(function (s) {
    if (!seen[s.key]) { seen[s.key] = true; out.push({ subId: s.key, force: s.force === 'open' || s.force === 'lock' ? s.force : null }); }
  });
  // Ré-ancrage des sujets ÉPINGLÉS (Réglages Academy > Copilote IA) : quoi que
  // propose l'IA, chacun reste à SA position actuelle, forçage actuel conservé —
  // miroir exact du garde-fou serveur d'Academy (bridge set-path). L'aperçu
  // affiché est donc identique au parcours réellement appliqué.
  const pinnedIds = {};
  currentSteps.forEach(function (s) { if (s.aiPinned) pinnedIds[s.key] = true; });
  if (Object.keys(pinnedIds).length > 0) {
    const movable = out.filter(function (st) { return !pinnedIds[st.subId]; });
    let mi = 0;
    return currentSteps.map(function (cur) {
      if (pinnedIds[cur.key]) return { subId: cur.key, force: cur.force === 'open' || cur.force === 'lock' ? cur.force : null };
      const st = movable[mi]; mi++;
      return st || { subId: cur.key, force: null };
    });
  }
  return out;
}

function parseProposal(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
//  Pont & Anthropic
// ---------------------------------------------------------------------------

async function fetchDossier(email, key) {
  const r = await fetch(ACADEMY_URL + '/api/bridge/progress', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
    body: JSON.stringify({ email: email }),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return j;
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
      max_tokens: 2500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(function () { return null; });
  if (!j || !Array.isArray(j.content)) return '';
  return j.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
}

function buildPrompt(courseName, ctx, path, wins) {
  let winsTxt = '(aucune pour le moment)';
  if (wins && wins.last && wins.last.length) {
    winsTxt = wins.last.map(function (w) { return '« ' + cap(w.text, 200) + ' » (' + w.title + ')'; }).join(' · ');
  }
  return [
    'Tu es le copilote pédagogique d\'AE Academy (accompagnement business francophone).',
    'Un coach vient de suivre un client ; propose le meilleur ordre des sujets de sa formation « ' + courseName + ' » pour les semaines à venir.',
    '',
    'FICHE COACHING DU CLIENT (Team Alteor) :',
    ctx,
    '',
    'ROUTE ACTUELLE DE L\'ÉLÈVE (ordre des sujets, statut calculé) :',
    routeText(path),
    'Objectif actuellement affiché : ' + (path.objectif || '(aucun)'),
    'Victoires déjà racontées par l\'élève : ' + winsTxt,
    '',
    'TA MISSION :',
    '1. Réordonner les sujets NON terminés pour coller aux besoins réels et urgents du client (ce qui débloque son business d\'abord).',
    '2. "force":"open" UNIQUEMENT pour un sujet à ouvrir immédiatement hors séquence (urgence forte) ; "force":"lock" pour repousser un sujet devenu secondaire ; sinon "force":null (la séquence automatique fait le reste : chaque étape terminée ouvre la suivante).',
    '3. Écrire un objectif court (1 phrase, tutoiement, concret, motivant) affiché en haut de la route de l\'élève.',
    '',
    'RÈGLES STRICTES :',
    '- Réponds UNIQUEMENT avec un objet JSON valide, sans texte autour, sans balises markdown.',
    '- "steps" contient EXACTEMENT les subId listés ci-dessus (ceux entre crochets), chacun UNE seule fois. Les sujets terminés restent listés, en général en tête.',
    '- Ne mets jamais "force":"lock" sur un sujet terminé.',
    '- Les sujets marqués [ÉPINGLÉ] ne doivent JAMAIS changer de position ni recevoir de "force" : recopie-les exactement à leur place actuelle et ne les mentionne pas dans "changes".',
    '- Si la route actuelle est déjà la bonne, renvoie-la telle quelle avec "changes": [].',
    '',
    'FORMAT DE RÉPONSE :',
    '{"objectif":"…","steps":[{"subId":"…","force":null}],"changes":[{"subId":"…","titre":"…","action":"avancé|repoussé|débloqué|verrouillé","pourquoi":"…"}],"resume":"1 à 2 phrases pour le coach"}',
  ].join('\n');
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
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
  const action = String(body.action || '');
  const email = String(body.email || '').trim().toLowerCase();
  const courseId = String(body.courseId || '').trim();
  const clientId = String(body.clientId || '').trim();
  if (!email || !courseId) {
    res.status(200).json({ ok: false, error: 'email_courseId_required' });
    return;
  }

  try {
    // ───────────────────────── PROPOSE ─────────────────────────
    if (action === 'propose') {
      if (!process.env.ANTHROPIC_API_KEY) {
        res.status(200).json({ ok: false, error: 'anthropic_not_configured' });
        return;
      }
      if (!clientId) {
        res.status(200).json({ ok: false, error: 'clientId_required' });
        return;
      }

      // 1) La fiche coaching.
      const cSnap = await db.collection('clients').doc(clientId).get();
      if (!cSnap.exists) {
        res.status(200).json({ ok: false, error: 'client_not_found' });
        return;
      }
      const client = cSnap.data() || {};

      // 2) La route actuelle via le pont.
      const j = await fetchDossier(email, key);
      if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
      if (!j.found) { res.status(200).json({ ok: true, found: false }); return; }
      const course = (j.dossier.courses || []).find(function (c) { return c.id === courseId; });
      if (!course || !course.path || !(course.path.steps || []).length) {
        res.status(200).json({ ok: false, error: 'course_path_not_found' });
        return;
      }

      // 3) L'IA.
      const prompt = buildPrompt(course.name, coachingContext(client), course.path, course.wins);
      const raw = await askClaude(prompt);
      const parsed = parseProposal(raw);
      if (!parsed || !Array.isArray(parsed.steps)) {
        res.status(200).json({ ok: false, error: 'ia_invalid_response' });
        return;
      }

      // 4) Réparation + réponse (rien n'est écrit à ce stade).
      const steps = repairSteps(parsed.steps, course.path.steps);
      res.status(200).json({
        ok: true,
        found: true,
        proposal: {
          objectif: cap(parsed.objectif || course.path.objectif || '', 300),
          steps: steps,
          changes: Array.isArray(parsed.changes) ? parsed.changes.slice(0, 12) : [],
          resume: cap(parsed.resume || '', 500),
          // Sujets épinglés (badge 📌 côté UI) — jamais déplacés ni forcés.
          pinned: (course.path.steps || []).filter(function (s) { return s.aiPinned; }).map(function (s) { return s.key; }),
        },
        current: course.path,
        courseName: course.name,
      });
      return;
    }

    // ───────────────────────── APPLY ─────────────────────────
    if (action === 'apply') {
      const steps = Array.isArray(body.steps) ? body.steps : null;
      if (!steps || steps.length === 0) {
        res.status(200).json({ ok: false, error: 'steps_required' });
        return;
      }
      const r = await fetch(ACADEMY_URL + '/api/bridge/set-path', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
        body: JSON.stringify({
          email: email,
          courseId: courseId,
          objectif: typeof body.objectif === 'string' ? body.objectif : '',
          steps: steps,
          source: 'ia',
        }),
      });
      let j = null;
      try { j = await r.json(); } catch (e) { j = null; }
      if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
      if (!j.found) { res.status(200).json({ ok: true, found: false }); return; }

      // Trace dans la fiche client (fail-soft : la validation a déjà réussi).
      if (clientId) {
        try {
          await db.collection('clients').doc(clientId).update({
            academyPathHistory: admin.firestore.FieldValue.arrayUnion({
              at: Date.now(),
              by: auth.email || auth.uid,
              courseId: courseId,
              revision: (j.applied && j.applied.revision) || 0,
              resume: cap(body.resume || '', 500),
            }),
          });
        } catch (e) { console.warn('[academy-path] trace fiche impossible:', e && e.message); }
      }

      res.status(200).json({ ok: true, found: true, applied: j.applied || {} });
      return;
    }

    res.status(200).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[academy-path]', e && e.message);
    res.status(200).json({ ok: false, error: 'internal' });
  }
};
