// ============================================================================
// api/coaching-plan-suggest.js — PROPOSITIONS POUR LE PLAN D'ACTION
// ----------------------------------------------------------------------------
// Lit le questionnaire AlteoForms d'un client coaching et propose le Point A,
// le Point B, le verrou principal, l'organisme bloqué et les chantiers — pour
// que le mentor n'ait plus qu'à valider ou corriger dans l'assistant.
//
// URL  : POST https://team.alteore.com/api/coaching-plan-suggest
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { clientId, force? }
//
// Réponses
//   200 { ok:true, suggestion:{ pointA, pointB, verrou, organisme, chantiers[] },
//         cached:bool, model }
//   200 { ok:false, error:'no_questionnaire' }   ← rien à analyser
//   400/401/403/404/500
//
// ─── RÈGLE ABSOLUE : AUCUN CHIFFRE INVENTÉ ─────────────────────────────
// Le modèle ne reformule QUE ce qui est dans le questionnaire. Un chiffre
// absent reste absent — il n'est ni estimé, ni « ordre de grandeur ». Seul
// le Point B porte des cibles, et elles sont explicitement dérivées des
// chiffres fournis. Tout est éditable par le mentor derrière : ce sont des
// propositions, pas des conclusions.
//
// Cache : clients/{id}.planSuggestion { data, key, generatedAt, model }.
// La clé est une empreinte du questionnaire — tant qu'il ne change pas, on
// ressert le cache (0 coût). force:true régénère.
//
// Variables Vercel requises : ANTHROPIC_API_KEY (déjà en place).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ROLES = ['admin', 'coach', 'csm'];
/* Tâche de raisonnement sur des données d'entreprise, jouée rarement (une
   fois par client, puis mise en cache) → Sonnet plutôt que Haiku. */
const MODEL = 'claude-sonnet-4-6';

const ORGANISMES = ['delivrabilite', 'rentabilite', 'acquisition'];
const CHANTIERS = [
  'Alignement du dirigeant',
  'Structure & modèle économique',
  'Culture d\'entreprise & management',
  'Organisation & pilotage',
  'Délégation stratégique',
  'Marges, trésorerie & rentabilité',
  'Marketing & visibilité premium',
  'Digitalisation & automatisation',
  'Expérience client & fidélisation',
  'Expansion & scalabilité',
];

/* Empreinte du questionnaire — change dès qu'une réponse change. */
function qKey(q) {
  const parts = (q.answers || []).map((a) => String(a.q || '') + '=' + String(a.a || ''));
  return String(q.formTitle || '') + '|' + parts.length + '|' + parts.join('~').slice(0, 4000);
}

function buildPrompt(client, q) {
  const lignes = (q.answers || [])
    .filter((a) => a && String(a.a || '').trim())
    .map((a) => '- ' + String(a.q).trim() + ' : ' + String(a.a).trim())
    .join('\n');

  return [
    'Tu prépares le plan d\'action d\'un client du programme Elite Phénix (accompagnement de dirigeants de TPE/PME).',
    'Voici le questionnaire qu\'il a rempli à son inscription :',
    '',
    lignes,
    '',
    'Produis une proposition pour quatre points. Le mentor la relira et la corrigera.',
    '',
    'RÈGLES ABSOLUES',
    '- N\'invente AUCUN chiffre. Utilise uniquement ceux du questionnaire ci-dessus.',
    '  Si une donnée manque, n\'en parle pas — ne l\'estime pas, ne l\'arrondis pas.',
    '- Phrases courtes, factuelles, au présent. Pas de jargon, pas de conseil théorique.',
    '- Vouvoiement interdit : on parle DU client, pas AU client (3e personne).',
    '',
    'CE QUE TU PRODUIS',
    '1. pointA — UNE phrase : la situation aujourd\'hui, factuelle, sans jugement.',
    '   Reprends les chiffres réels (CA, employés, ancienneté, trésorerie…).',
    '2. pointB — UNE phrase : l\'objectif à 6 mois, concret et mesurable. Les cibles',
    '   chiffrées doivent être dérivées des chiffres du questionnaire (ex. un CA',
    '   mensuel cible calculé depuis le CA actuel), jamais sorties de nulle part.',
    '3. verrou — UNE phrase qui nomme le VRAI problème, pas le symptôme.',
    '4. organisme — un seul mot parmi : delivrabilite, rentabilite, acquisition.',
    '   delivrabilite = le dirigeant est le goulot, rien ne tourne sans lui.',
    '   rentabilite  = ça produit du chiffre mais pas de résultat ni de trésorerie.',
    '   acquisition  = la machine tourne et est rentable, il manque du volume.',
    '5. chantiers — 2 à 4 numéros parmi cette liste, ceux qui débloquent le palier suivant :',
    CHANTIERS.map((c, i) => '   ' + (i + 1) + '. ' + c).join('\n'),
    '',
    'Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :',
    '{"pointA":"...","pointB":"...","verrou":"...","organisme":"...","chantiers":[6,4]}',
  ].join('\n');
}

/* Le modèle peut encadrer le JSON malgré la consigne — on récupère le
   premier objet bien formé plutôt que d'échouer sur un ```json. */
function parseJson(txt) {
  const s = String(txt || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => String(v == null ? '' : v).trim().slice(0, 400);
  const org = ORGANISMES.indexOf(String(raw.organisme || '').toLowerCase()) >= 0
    ? String(raw.organisme).toLowerCase() : '';
  let ch = Array.isArray(raw.chantiers) ? raw.chantiers : [];
  ch = ch.map((n) => parseInt(n, 10)).filter((n) => n >= 1 && n <= 10);
  ch = ch.filter((n, i) => ch.indexOf(n) === i).slice(0, 4);   // dédoublonné, 4 max
  return {
    pointA: str(raw.pointA),
    pointB: str(raw.pointB),
    verrou: str(raw.verrou),
    organisme: org,
    chantiers: ch,
  };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  const clientId = body && typeof body.clientId === 'string' ? body.clientId.trim() : '';
  const force = !!(body && body.force);
  if (!clientId) {
    res.status(400).json({ ok: false, error: 'clientId_required' });
    return;
  }

  try {
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'client_not_found' });
      return;
    }
    const client = snap.data() || {};
    const q = client.questionnaire;
    if (!q || !(q.answers || []).length) {
      res.status(200).json({ ok: false, error: 'no_questionnaire' });
      return;
    }

    const key = qKey(q);
    const cache = client.planSuggestion;
    if (!force && cache && cache.key === key && cache.data) {
      res.status(200).json({ ok: true, suggestion: cache.data, cached: true, model: cache.model || null });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ ok: false, error: 'ai_not_configured' });
      return;
    }

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 900,
        messages: [{ role: 'user', content: buildPrompt(client, q) }],
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[coaching-plan-suggest] anthropic', r.status, t.slice(0, 300));
      res.status(200).json({ ok: false, error: 'ai_unavailable' });
      return;
    }

    const j = await r.json();
    const txt = ((j.content || []).find((c) => c.type === 'text') || {}).text || '';
    const suggestion = sanitize(parseJson(txt));
    if (!suggestion || (!suggestion.pointA && !suggestion.verrou)) {
      console.warn('[coaching-plan-suggest] réponse inexploitable:', txt.slice(0, 200));
      res.status(200).json({ ok: false, error: 'ai_unparsable' });
      return;
    }

    /* Mise en cache — best-effort : un échec d'écriture ne doit pas priver
       le mentor de sa proposition. */
    try {
      await db.collection('clients').doc(clientId).update({
        planSuggestion: {
          data: suggestion,
          key,
          model: MODEL,
          generatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
      });
    } catch (e) {
      console.warn('[coaching-plan-suggest] cache:', e && e.message);
    }

    res.status(200).json({ ok: true, suggestion, cached: false, model: MODEL });
  } catch (e) {
    console.error('[coaching-plan-suggest]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
