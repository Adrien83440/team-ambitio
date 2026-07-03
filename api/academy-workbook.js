// ============================================================================
// api/academy-workbook.js — LE SCRIBE (V12a) : workbooks IA personnalisés
// ----------------------------------------------------------------------------
// Deux actions, appelées depuis la fiche coaching (coaching.html) :
//
//   action:"context"  → renvoie, via le pont Academy, la matière première du
//     panneau 📓 : sujets de la formation (avec titres de leçons), route de
//     l'élève (statuts) et état de ses workbooks (révision, gel). Rien n'est
//     écrit, aucune IA n'est appelée.
//
//   action:"generate" → l'IA (Claude) lit la fiche coaching (plan d'action,
//     6 dernières séances, synthèses Google longues, questionnaire) + les
//     victoires + le sujet visé (titre + leçons), puis GÉNÈRE un workbook
//     d'exercices personnalisé, calqué sur les workbooks papier Elite Phénix.
//     Le workbook est écrit dans l'Academy via le pont /api/bridge/workbook
//     (action:"set") et tracé dans la fiche client (academyWorkbooks +
//     academyWorkbookHistory). UN sujet par appel : le panneau enchaîne les
//     appels (sujet en cours puis suivant) pour rester sous les timeouts.
//
// URL  : POST https://team.alteore.com/api/academy-workbook
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body context  : { action:"context", email, courseId }
// Body generate : { action:"generate", email, courseId, clientId, subId,
//                   force?:true, trigger?:"manuel"|"sync" }
//
// Garde-fous « rester dans le cadre de l'accompagnement » :
// - le prompt est CONTRAINT au périmètre du sujet (titre + leçons) et aux
//   données réelles du coaching — consignes explicites de ne rien promettre
//   et de ne pas inventer de méthode hors programme ;
// - GEL : un workbook où l'élève a répondu n'est jamais écrasé par l'auto
//   (le pont refuse) — seul force:true (régénération manuelle) passe outre ;
// - normalisation stricte côté Academy (types de blocs whitelistés, tailles
//   bornées) : l'IA ne peut pas écrire n'importe quoi dans Firestore.
//
// Variables Vercel requises : ACADEMY_BRIDGE_KEY et ANTHROPIC_API_KEY
// (déjà en place depuis la Vague C).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];
const MODEL = 'claude-sonnet-4-6';

// ---------------------------------------------------------------------------
//  Fiche coaching → contexte pour l'IA (même lecture que le copilote)
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
  L.push('- Prénom du client : ' + ((c.prenom || (c.nom || '').split(' ')[0]) || '(inconnu)'));
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
//  Pont & Anthropic
// ---------------------------------------------------------------------------

async function bridgeWorkbook(key, payload) {
  const r = await fetch(ACADEMY_URL + '/api/bridge/workbook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
    body: JSON.stringify(payload),
  });
  let j = null;
  try { j = await r.json(); } catch (e) { j = null; }
  return j;
}

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
      max_tokens: 4500,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const j = await r.json().catch(function () { return null; });
  if (!j || !Array.isArray(j.content)) return '';
  return j.content.filter(function (b) { return b.type === 'text'; }).map(function (b) { return b.text; }).join('\n');
}

function parseJson(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const a = t.indexOf('{'); const b = t.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
//  Le prompt du Scribe — style calqué sur les workbooks papier Elite Phénix
// ---------------------------------------------------------------------------

function buildPrompt(courseName, subject, ctx, winsTxt) {
  const lessons = (subject.lessons || []).filter(Boolean);
  return [
    'Tu es le Scribe d\'AE Academy : tu rédiges les WORKBOOKS personnalisés du programme d\'accompagnement business francophone « ' + courseName + ' » (marque Phénix).',
    'Le workbook accompagne UN sujet de la formation. L\'élève le remplit après avoir regardé les leçons du sujet.',
    '',
    'SUJET VISÉ : « ' + subject.title + ' »' + (subject.moduleTitle ? ' (acte : ' + subject.moduleTitle + ')' : ''),
    lessons.length ? 'LEÇONS DU SUJET (dans l\'ordre) :\n' + lessons.map(function (t, i) { return (i + 1) + '. ' + t; }).join('\n') : 'LEÇONS DU SUJET : (non listées)',
    '',
    'FICHE COACHING DU CLIENT (Team Alteor — données réelles) :',
    ctx,
    'Victoires déjà racontées par l\'élève : ' + winsTxt,
    '',
    'STYLE (calqué sur les workbooks papier Elite Phénix — respecte-le à la lettre) :',
    '- Tutoiement direct, ton exigeant et bienveillant, phrases courtes. Esprit « Écris, ne pense pas », « Sois brutalement honnête ».',
    '- Une section par leçon du sujet, DANS L\'ORDRE des leçons (regroupe si plus de 6 leçons ; jamais plus de 7 sections).',
    '- Chaque section : un objectif d\'une phrase + 3 à 5 blocs : un court bloc pédagogique, puis des questions de réflexion précises, parfois une formulation à compléter, un tableau à remplir ou un engagement concret daté.',
    '- PERSONNALISE avec les données du coaching : reformule les questions avec la situation réelle du client (son activité, ses blocages, ses chiffres, ses victoires). Les hints des questions peuvent citer sa situation.',
    '',
    'CADRE STRICT (tu es DANS un accompagnement — n\'en sors jamais) :',
    '- Reste STRICTEMENT dans le périmètre du sujet et de ses leçons : n\'introduis aucune méthode, aucun concept, aucun outil qui n\'en fait pas partie.',
    '- Ne promets aucun résultat chiffré, ne donne aucun conseil juridique, fiscal ou financier.',
    '- Ne contredis jamais le coach : appuie-toi sur le plan d\'action et les séances.',
    '- Si les données coaching sont pauvres, reste générique et sobre plutôt que d\'inventer.',
    '',
    'FORMAT DE RÉPONSE — UNIQUEMENT un objet JSON valide, sans texte autour, sans balises markdown :',
    '{',
    '  "title": "titre du workbook (court, sans le mot Module)",',
    '  "subtitle": "les thèmes du sujet en une ligne, séparés par — ",',
    '  "intro": "3 à 5 consignes d\'utilisation, une par ligne, style → Regarde la leçon d\'abord / → Écris, ne pense pas …",',
    '  "perso": "2 à 3 phrases directement adressées au client, ancrées sur SON coaching (sa situation, sa dernière séance, sa prochaine étape)",',
    '  "sections": [',
    '    { "title": "…", "objectif": "…", "blocks": [',
    '      { "kind": "texte", "text": "…" },',
    '      { "kind": "question", "label": "…", "hint": "…" },',
    '      { "kind": "formulation", "template": "phrase à compléter avec des [crochets]" },',
    '      { "kind": "tableau", "intro": "…", "cols": ["…"], "rows": [ { "label": "…" } ] },',
    '      { "kind": "citation", "text": "…" },',
    '      { "kind": "engagement", "label": "…", "hint": "…" }',
    '    ] }',
    '  ],',
    '  "synthese": { "title": "Synthèse", "rows": [ { "label": "…" } ] }',
    '}',
    'Contraintes de taille : max 7 sections, max 5 blocs par section, textes courts (blocs pédagogiques ≤ 3 phrases), tableaux ≤ 4 colonnes et ≤ 8 lignes, synthèse 5 à 8 lignes.',
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
    // ───────────────────────── CONTEXT ─────────────────────────
    if (action === 'context') {
      const j = await bridgeWorkbook(key, { action: 'context', courseId: courseId, email: email });
      if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
      res.status(200).json({ ok: true, courseName: j.courseName || '', subjects: j.subjects || [], learner: j.learner || null });
      return;
    }

    // ───────────────────────── GET (aperçu coach) ─────────────────────────
    if (action === 'get') {
      const subId = String(body.subId || '').trim();
      if (!subId) { res.status(200).json({ ok: false, error: 'subId_required' }); return; }
      const j = await bridgeWorkbook(key, { action: 'get', courseId: courseId, email: email, subId: subId });
      if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
      res.status(200).json({ ok: true, found: j.found !== false, workbook: j.workbook || null, frozen: !!j.frozen, answers: j.answers || {} });
      return;
    }

    // ───────────────────────── GENERATE ─────────────────────────
    if (action === 'generate') {
      if (!process.env.ANTHROPIC_API_KEY) {
        res.status(200).json({ ok: false, error: 'anthropic_not_configured' });
        return;
      }
      if (!clientId) {
        res.status(200).json({ ok: false, error: 'clientId_required' });
        return;
      }
      const subId = String(body.subId || '').trim();
      if (!subId) {
        res.status(200).json({ ok: false, error: 'subId_required' });
        return;
      }

      // 1) La fiche coaching.
      const cSnap = await db.collection('clients').doc(clientId).get();
      if (!cSnap.exists) {
        res.status(200).json({ ok: false, error: 'client_not_found' });
        return;
      }
      const client = cSnap.data() || {};

      // 2) Le sujet (titre + leçons) via le pont.
      const ctxJ = await bridgeWorkbook(key, { action: 'context', courseId: courseId, email: email });
      if (!ctxJ || ctxJ.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
      const subject = (ctxJ.subjects || []).find(function (s) { return s.key === subId; });
      if (!subject) { res.status(200).json({ ok: false, error: 'subject_not_found' }); return; }
      if (ctxJ.learner && ctxJ.learner.found === false) { res.status(200).json({ ok: true, found: false }); return; }

      // Gel connu d'avance (sauf force) : on évite un appel IA pour rien.
      const wbState = ctxJ.learner && ctxJ.learner.workbooks ? ctxJ.learner.workbooks[subId] : null;
      if (wbState && wbState.frozen && body.force !== true) {
        res.status(200).json({ ok: true, found: true, frozen: true, subjectTitle: subject.title });
        return;
      }

      // 3) Les victoires (pour personnaliser), via le dossier du pont.
      let winsTxt = '(aucune pour le moment)';
      try {
        const dj = await fetchDossier(email, key);
        if (dj && dj.ok === true && dj.found) {
          const course = (dj.dossier.courses || []).find(function (c) { return c.id === courseId; });
          if (course && course.wins && course.wins.last && course.wins.last.length) {
            winsTxt = course.wins.last.map(function (w) { return '« ' + cap(w.text, 200) + ' » (' + w.title + ')'; }).join(' · ');
          }
        }
      } catch (e) { /* fail-soft : les victoires sont un bonus */ }

      // 4) L'IA rédige.
      const prompt = buildPrompt(ctxJ.courseName || '', subject, coachingContext(client), winsTxt);
      const raw = await askClaude(prompt);
      const parsed = parseJson(raw);
      if (!parsed || !Array.isArray(parsed.sections) || parsed.sections.length === 0) {
        res.status(200).json({ ok: false, error: 'ia_invalid_response' });
        return;
      }

      // 5) Écriture via le pont (normalisation stricte + gel côté Academy).
      const setJ = await bridgeWorkbook(key, {
        action: 'set',
        email: email,
        courseId: courseId,
        subId: subId,
        workbook: parsed,
        source: body.force === true ? 'manuel' : 'auto',
        force: body.force === true,
      });
      if (!setJ || setJ.ok !== true) { res.status(200).json({ ok: false, error: setJ && setJ.error === 'invalid_workbook' ? 'ia_invalid_response' : 'academy_unreachable' }); return; }
      if (!setJ.found) { res.status(200).json({ ok: true, found: false }); return; }
      if (setJ.frozen) { res.status(200).json({ ok: true, found: true, frozen: true, subjectTitle: subject.title }); return; }

      // 6) Trace dans la fiche client (fail-soft : le workbook est déjà écrit).
      const revision = (setJ.applied && setJ.applied.revision) || 0;
      try {
        const entry = {
          at: Date.now(),
          by: auth.email || auth.uid,
          trigger: body.trigger === 'sync' ? 'sync' : 'manuel',
          courseId: courseId,
          courseName: cap(ctxJ.courseName || '', 160),
          subId: subId,
          subjectTitle: cap(subject.title || '', 160),
          revision: revision,
        };
        const upd = {};
        upd['academyWorkbooks.' + courseId + '__' + subId] = entry;
        upd.academyWorkbookHistory = admin.firestore.FieldValue.arrayUnion(entry);
        await db.collection('clients').doc(clientId).update(upd);
      } catch (e) { console.warn('[academy-workbook] trace fiche impossible:', e && e.message); }

      res.status(200).json({ ok: true, found: true, applied: { revision: revision }, subjectTitle: subject.title });
      return;
    }

    res.status(200).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[academy-workbook]', e && e.message);
    res.status(200).json({ ok: false, error: 'internal' });
  }
};
