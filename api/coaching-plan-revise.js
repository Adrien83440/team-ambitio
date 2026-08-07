// ============================================================================
// api/coaching-plan-revise.js — RETOUCHE DU PLAN D'ACTION EN LANGAGE NATUREL
// ----------------------------------------------------------------------------
// Le mentor écrit (ou dicte) ce qu'il veut changer — « le point B est trop
// ambitieux, mets 28K », « décale A3 à J+60 », « ajoute une semaine 3 sur le
// recrutement » — et l'IA renvoie le plan corrigé. Il n'a plus à ouvrir dix
// champs pour une correction de deux lignes.
//
// URL  : POST https://team.alteore.com/api/coaching-plan-revise
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { clientId, plan, instructions }
//
// Réponses
//   200 { ok:true, plan:{…}, resume:'ce qui a changé, en une ou deux phrases' }
//   200 { ok:false, error:'ai_unavailable' | 'ai_unparsable' | 'ai_refused'
//                        | 'ai_not_configured' }
//   400/401/403/404/500
//
// ─── CE QUE L'IA N'A PAS LE DROIT DE TOUCHER ───────────────────────────────
// Le plan renvoyé est FUSIONNÉ sur celui reçu, pas substitué. Restent intacts,
// quoi que réponde le modèle :
//   startDate · jalonStatus · semaines[].actions[].st · collecte · vocal
//   historique · createdAt
// Ce sont soit des repères de calcul, soit l'avancement réel constaté par le
// coach : une reformulation de texte n'a aucune raison de les effacer.
//
// ─── RÈGLE ABSOLUE : AUCUN CHIFFRE INVENTÉ ─────────────────────────────────
// Le modèle réécrit ce qu'on lui donne. Un chiffre qui n'est ni dans le plan
// actuel ni dans la consigne du mentor n'a pas à apparaître.
//
// Variables Vercel requises : ANTHROPIC_API_KEY (déjà en place).
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { db } = require('./_firebaseAdmin');

const ROLES = ['admin', 'coach', 'csm'];
/* Même modèle que la génération initiale : une retouche doit être au moins
   aussi fine que le plan qu'elle corrige. */
const MODEL = 'claude-opus-5';

const ORGANISMES = ['delivrabilite', 'rentabilite', 'acquisition'];
const JALON_KEYS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B'];
const STATUTS = ['todo', 'wip', 'ok', 'ko'];
const CATS = ['Financier', 'Commercial', 'Opérationnel', 'Humain'];

/* Date au format YYYY-MM-DD uniquement. Tout le reste est rejeté : une date
   mal formée casserait l'affichage et les calculs d'échéance. */
function ymd(v) {
  const s = String(v == null ? '' : v).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
}

function num(v, min, max) {
  const n = parseInt(String(v == null ? '' : v).replace(/[^\d-]/g, ''), 10);
  if (!isFinite(n) || n < min || n > max) return null;
  return n;
}

/* Le plan envoyé par le navigateur : on ne le rejoue au modèle qu'après
   l'avoir borné, sinon un plan corrompu ferait exploser le prompt. */
function planForPrompt(p) {
  const o = p && typeof p === 'object' ? p : {};
  return JSON.stringify({
    synthese: o.synthese || '',
    pointA: o.pointA || '',
    pointB: o.pointB || '',
    verrou: o.verrou || '',
    organisme: o.organisme || '',
    chiffres: Array.isArray(o.chiffres) ? o.chiffres.slice(0, 8) : [],
    ditClient: Array.isArray(o.ditClient) ? o.ditClient.slice(0, 7) : [],
    problemes: Array.isArray(o.problemes) ? o.problemes.slice(0, 5) : [],
    objectifs: Array.isArray(o.objectifs) ? o.objectifs.slice(0, 5) : [],
    kpis: Array.isArray(o.kpis) ? o.kpis.slice(0, 8) : [],
    risques: Array.isArray(o.risques) ? o.risques.slice(0, 4) : [],
    jalons: o.jalons && typeof o.jalons === 'object' ? o.jalons : {},
    semaines: Array.isArray(o.semaines) ? o.semaines.slice(0, 12) : [],
    startDate: o.startDate || '',
  }).slice(0, 30000);
}

function buildPrompt(plan, instructions, contexte) {
  const bloc = [
    'Tu corriges le plan d\'action d\'un client du programme Elite Phénix',
    '(accompagnement de dirigeants de TPE/PME sur 6 mois).',
    '',
    'PLAN ACTUEL (JSON) :',
    planForPrompt(plan),
    '',
  ];

  if (String(contexte || '').trim()) {
    bloc.push('CONTEXTE DU DOSSIER — notes prises par le mentor :');
    bloc.push('"""');
    bloc.push(String(contexte).trim().slice(0, 8000));
    bloc.push('"""');
    bloc.push('');
  }

  bloc.push('CE QUE LE MENTOR DEMANDE DE CHANGER :');
  bloc.push('"""');
  bloc.push(String(instructions).trim().slice(0, 4000));
  bloc.push('"""');
  bloc.push('');

  return bloc.concat([
    'RÈGLES ABSOLUES',
    '- Applique EXACTEMENT ce qui est demandé, rien de plus.',
    '  Ce que le mentor n\'a pas mentionné revient à l\'identique, mot pour mot.',
    '- N\'invente AUCUN chiffre : uniquement ceux du plan actuel, du contexte,',
    '  ou de la demande ci-dessus.',
    '- Phrases courtes, factuelles, au présent. On parle DU client (3e personne).',
    '- Reste réaliste : une action doit être faisable par ce dirigeant-là, avec',
    '  les moyens décrits. Une étape irréalisable ne sert à rien.',
    '- Si la demande est ambiguë, prends l\'interprétation la plus prudente et',
    '  dis-le dans « resume ».',
    '',
    'STRUCTURE À RESPECTER',
    '- jalons : clés A1, A2, A3, A4, A5, B uniquement. Chaque jalon :',
    '  {"titre":"...","focus":"une phrase","actions":["2 à 3 actions, verbe à',
    '   l\'infinitif"],"preuve":"résultat observable","j":nombre de jours depuis J0}',
    '  Repères par défaut : A1=J+10, A2=J+20, A3=J+45, A4=J+90, A5=J+135, B=J+180.',
    '  Ne mets « j » que si le mentor demande de déplacer une étape.',
    '- semaines : [{"n":1,"from":"AAAA-MM-JJ","to":"AAAA-MM-JJ","coach":"...",',
    '   "focus":"le point de focus de la séance",',
    '   "actions":[{"txt":"verbe + quoi + comment","who":"Client ou nom du coach",',
    '    "due":"AAAA-MM-JJ"}]}]',
    '  3 actions maximum par semaine. Chaque action a un responsable ET une date.',
    '- organisme : un seul mot parmi delivrabilite, rentabilite, acquisition.',
    '- kpis : {"cat":"Financier|Commercial|Opérationnel|Humain","nom":"...",',
    '   "freq":"...","actuel":"...","cible":"..."} — « actuel » inconnu = "—".',
    '',
    'Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code.',
    'Il contient le plan COMPLET après correction, plus un champ « resume » :',
    '{"resume":"ce qui a changé, une ou deux phrases pour le mentor",',
    ' "synthese":"...","pointA":"...","pointB":"...","verrou":"...","organisme":"...",',
    ' "chiffres":[{"label":"...","valeur":"..."}],',
    ' "ditClient":[{"titre":"...","detail":"..."}],',
    ' "problemes":[{"titre":"...","detail":"..."}],',
    ' "objectifs":["..."],',
    ' "kpis":[{"cat":"...","nom":"...","freq":"...","actuel":"...","cible":"..."}],',
    ' "risques":[{"titre":"...","detail":"..."}],',
    ' "jalons":{"A1":{"titre":"...","focus":"...","actions":["..."],"preuve":"..."}},',
    ' "semaines":[{"n":1,"from":"...","to":"...","coach":"...","focus":"...",',
    '   "actions":[{"txt":"...","who":"...","due":"..."}]}]}',
  ]).join('\n');
}

/* Le modèle peut encadrer le JSON malgré la consigne — on récupère le premier
   objet bien formé plutôt que d'échouer sur un ```json. */
function parseJson(txt) {
  const s = String(txt || '').trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try { return JSON.parse(s.slice(start, end + 1)); } catch (e) { return null; }
}

/* Normalise la réponse du modèle. Rien ne sort d'ici sans être passé au
   filtre : listes bornées, énumérations vérifiées, dates au bon format. */
function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => String(v == null ? '' : v).trim().slice(0, 400);
  const list = (arr, max, shape) => (Array.isArray(arr) ? arr : [])
    .map(shape).filter(Boolean).slice(0, max);

  const org = ORGANISMES.indexOf(String(raw.organisme || '').toLowerCase()) >= 0
    ? String(raw.organisme).toLowerCase() : '';

  return {
    resume: str(raw.resume),
    synthese: str(raw.synthese),
    pointA: str(raw.pointA),
    pointB: str(raw.pointB),
    verrou: str(raw.verrou),
    organisme: org,
    chiffres: list(raw.chiffres, 8, (x) => {
      const l = str(x && x.label), v = str(x && x.valeur);
      return (l && v) ? { label: l.slice(0, 40), valeur: v.slice(0, 40) } : null;
    }),
    ditClient: list(raw.ditClient, 7, (x) => {
      const t = str(x && x.titre);
      return t ? { titre: t.slice(0, 90), detail: str(x && x.detail).slice(0, 160) } : null;
    }),
    problemes: list(raw.problemes, 5, (x) => {
      const t = str(x && x.titre);
      return t ? { titre: t.slice(0, 80), detail: str(x && x.detail) } : null;
    }),
    objectifs: list(raw.objectifs, 5, (x) => { const v = str(x); return v || null; }),
    kpis: list(raw.kpis, 8, (x) => {
      const n = str(x && x.nom);
      if (!n) return null;
      const c = str(x && x.cat);
      return {
        cat: CATS.indexOf(c) >= 0 ? c : 'Opérationnel',
        nom: n.slice(0, 60),
        freq: str(x && x.freq).slice(0, 20) || 'Mensuel',
        actuel: str(x && x.actuel).slice(0, 30) || '—',
        cible: str(x && x.cible).slice(0, 30) || '—',
      };
    }),
    risques: list(raw.risques, 4, (x) => {
      const t = str(x && x.titre);
      return t ? { titre: t.slice(0, 80), detail: str(x && x.detail) } : null;
    }),
    jalons: (() => {
      const src = raw.jalons && typeof raw.jalons === 'object' ? raw.jalons : {};
      const out = {};
      JALON_KEYS.forEach((k) => {
        const j = src[k];
        if (!j || typeof j !== 'object') return;
        const actions = (Array.isArray(j.actions) ? j.actions : [])
          .map((a) => str(a).slice(0, 160)).filter(Boolean).slice(0, 3);
        const titre = str(j.titre).slice(0, 70);
        const focus = str(j.focus).slice(0, 200);
        const preuve = str(j.preuve).slice(0, 200);
        const jour = num(j.j, 0, 400);
        if (!titre && !focus && !preuve && !actions.length && jour === null) return;
        out[k] = { titre, focus, actions, preuve };
        /* 0 est un décalage légitime (« dès le premier jour ») → test explicite
           sur null, jamais sur la valeur elle-même. */
        if (jour !== null) out[k].j = jour;
      });
      return out;
    })(),
    semaines: list(raw.semaines, 12, (s, i) => {
      if (!s || typeof s !== 'object') return null;
      const actions = list(s.actions, 3, (a) => {
        const t = str(a && a.txt).slice(0, 220);
        if (!t) return null;
        return { txt: t, who: str(a && a.who).slice(0, 40), due: ymd(a && a.due), st: 'todo' };
      });
      const focus = str(s.focus).slice(0, 220);
      if (!focus && !actions.length) return null;
      return {
        n: num(s.n, 1, 60) || (i + 1),
        from: ymd(s.from),
        to: ymd(s.to),
        coach: str(s.coach).slice(0, 60),
        focus,
        actions,
      };
    }),
  };
}

/* Fusion : le plan reçu reste la base, la réponse du modèle ne remplace que
   ce qu'elle porte réellement. Une liste vide côté modèle = « il n'a rien
   proposé là-dessus », pas « vide cette section ».
   L'avancement (statuts) est réattaché par position : le coach a cliqué, une
   reformulation de texte n'a pas à effacer son travail. */
function merge(base, s) {
  const p = JSON.parse(JSON.stringify(base && typeof base === 'object' ? base : {}));

  ['synthese', 'pointA', 'pointB', 'verrou'].forEach((k) => { if (s[k]) p[k] = s[k]; });
  if (s.organisme) p.organisme = s.organisme;

  ['chiffres', 'ditClient', 'problemes', 'objectifs', 'kpis', 'risques'].forEach((k) => {
    if (s[k] && s[k].length) p[k] = s[k];
  });

  if (s.jalons && Object.keys(s.jalons).length) {
    p.jalons = p.jalons && typeof p.jalons === 'object' ? p.jalons : {};
    Object.keys(s.jalons).forEach((k) => {
      const cur = p.jalons[k] || {};
      const nx = s.jalons[k];
      p.jalons[k] = {
        titre: nx.titre || cur.titre || '',
        focus: nx.focus || cur.focus || '',
        actions: nx.actions.length ? nx.actions : (cur.actions || []),
        preuve: nx.preuve || cur.preuve || '',
      };
      if (typeof nx.j === 'number') p.jalons[k].j = nx.j;
      else if (typeof cur.j === 'number') p.jalons[k].j = cur.j;
    });
  }

  if (s.semaines && s.semaines.length) {
    const anciennes = Array.isArray(p.semaines) ? p.semaines : [];
    p.semaines = s.semaines.map((sem, i) => {
      const old = anciennes[i] || {};
      const oldActs = Array.isArray(old.actions) ? old.actions : [];
      return {
        n: sem.n,
        from: sem.from || old.from || '',
        to: sem.to || old.to || '',
        coach: sem.coach || old.coach || '',
        focus: sem.focus,
        actions: sem.actions.map((a, k) => {
          const oa = oldActs[k] || {};
          /* Statut conservé seulement si l'action n'a pas changé de texte —
             sinon on afficherait « fait » sur une action qui n'existait pas. */
          const st = (oa.txt === a.txt && STATUTS.indexOf(oa.st) >= 0) ? oa.st : 'todo';
          return { txt: a.txt, who: a.who, due: a.due, st };
        }),
      };
    });
  }

  return p;
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
  const instructions = body && typeof body.instructions === 'string' ? body.instructions.trim() : '';
  const plan = body && body.plan && typeof body.plan === 'object' ? body.plan : null;

  if (!clientId || !instructions || !plan) {
    res.status(400).json({ ok: false, error: 'clientId_plan_instructions_required' });
    return;
  }

  try {
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'client_not_found' });
      return;
    }

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ ok: false, error: 'ai_not_configured' });
      return;
    }

    /* Contexte : ce que le mentor a collecté (cases « Infos collectées » +
       dictée). Il vit dans le plan lui-même, pas besoin d'un aller-retour. */
    const contexte = [
      String(plan.vocal || ''),
      Object.keys(plan.collecte || {}).map((k) => String(plan.collecte[k] || '')).join('\n'),
    ].filter((x) => x.trim()).join('\n\n');

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        /* Opus 5 réfléchit par défaut : max_tokens couvre réflexion + réponse. */
        max_tokens: 24000,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: buildPrompt(plan, instructions, contexte) }],
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[coaching-plan-revise] anthropic', r.status, t.slice(0, 300));
      res.status(200).json({ ok: false, error: 'ai_unavailable' });
      return;
    }

    const j = await r.json();
    if (j.stop_reason === 'refusal') {
      console.warn('[coaching-plan-revise] refus', JSON.stringify(j.stop_details || {}).slice(0, 200));
      res.status(200).json({ ok: false, error: 'ai_refused' });
      return;
    }

    const txt = ((j.content || []).find((c) => c.type === 'text') || {}).text || '';
    const s = sanitize(parseJson(txt));
    if (!s) {
      console.warn('[coaching-plan-revise] réponse inexploitable:', txt.slice(0, 200));
      res.status(200).json({ ok: false, error: 'ai_unparsable' });
      return;
    }

    res.status(200).json({
      ok: true,
      plan: merge(plan, s),
      resume: s.resume || 'Plan mis à jour.',
      model: MODEL,
    });
  } catch (e) {
    console.error('[coaching-plan-revise]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
