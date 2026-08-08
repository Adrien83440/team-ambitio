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
/* Les 5 milestones du parcours 6 mois. Les anciennes clés A1→B restent
   acceptées : un plan validé avant la bascule doit pouvoir être retouché
   sans que ses étapes disparaissent. */
const JALON_KEYS = ['M1', 'M2', 'M3', 'M4', 'M5'];
const JALON_KEYS_LEGACY = ['A1', 'A2', 'A3', 'A4', 'A5', 'B'];
const TOUTES_CLES = JALON_KEYS.concat(JALON_KEYS_LEGACY);
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
/* Classement des trois organismes : les trois y sont toujours, sans doublon,
   et l'acquisition finit dernière — règle du programme, pas préférence du
   modèle. Même fonction que dans coaching-plan-suggest (inlinée : les
   fichiers /api ne s'importent pas entre eux). */
function ordreOrganismes(raw) {
  const vus = [];
  (Array.isArray(raw) ? raw : []).forEach((x) => {
    const k = String(x || '').toLowerCase().trim();
    if (ORGANISMES.indexOf(k) >= 0 && vus.indexOf(k) < 0) vus.push(k);
  });
  ORGANISMES.forEach((k) => { if (vus.indexOf(k) < 0) vus.push(k); });
  const i = vus.indexOf('acquisition');
  if (i >= 0 && i !== vus.length - 1) { vus.splice(i, 1); vus.push('acquisition'); }
  return vus;
}

function planForPrompt(p) {
  const o = p && typeof p === 'object' ? p : {};
  return JSON.stringify({
    synthese: o.synthese || '',
    pointA: o.pointA || '',
    pointB: o.pointB || '',
    verrou: o.verrou || '',
    verrouPlan: o.verrouPlan || '',
    horizon12: o.horizon12 || '',
    horizon36: o.horizon36 || '',
    organismes: Array.isArray(o.organismes) ? o.organismes : (o.organisme ? [o.organisme] : []),
    renforces: Array.isArray(o.renforces) ? o.renforces : [],
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
    '- jalons : clés M1 à M5 (les 5 milestones du parcours 6 mois).',
    '  M1 Libérer le temps · M2 Poser le cap et le cadre · M3 Déléguer pour de bon',
    '  M4 Piloter par les chiffres et installer le relais · M5 L\'entreprise tourne sans lui.',
    '  Chaque milestone : {"focus":"une phrase","actions":["2 à 3 actions, verbe à',
    '   l\'infinitif"]}. Le titre et la victoire vérifiable sont fixés par le',
    '  programme : ne les renvoie pas.',
    '  ⚠ L\'ORDRE DES MILESTONES N\'EST PAS NÉGOCIABLE, quoi qu\'on te demande.',
    '  Ce qui varie, c\'est la profondeur : « renforces » liste les milestones',
    '  à approfondir pour ce dossier (0 à 2 parmi M1…M5).',
    '  ⚠ Si le plan reçu utilise encore les anciennes clés A1…B, garde-les :',
    '  on ne réécrit pas la trame d\'un plan déjà remis au client.',
    '- verrouPlan : ce qu\'on fait pour lever le verrou. AUCUNE durée, aucune date.',
    '- organismes : delivrabilite, rentabilite, acquisition classés du plus urgent',
    '  au dernier. acquisition est TOUJOURS en dernier.',
    '- horizon12 / horizon36 : une phrase courte chacune, sobre, sans chiffre inventé.',
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
    ' "synthese":"...","pointA":"...","pointB":"...","verrou":"...","verrouPlan":"...",',
    ' "organismes":["...","...","..."],"renforces":["M3"],',
    ' "horizon12":"...","horizon36":"...",',
    ' "chiffres":[{"label":"...","valeur":"..."}],',
    ' "ditClient":[{"titre":"...","detail":"..."}],',
    ' "problemes":[{"titre":"...","detail":"..."}],',
    ' "objectifs":["..."],',
    ' "kpis":[{"cat":"...","nom":"...","freq":"...","actuel":"...","cible":"..."}],',
    ' "risques":[{"titre":"...","detail":"..."}],',
    ' "jalons":{"M1":{"focus":"...","actions":["..."]}},',
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
  const txt = (v) => String(v == null ? '' : v).trim().slice(0, 2500);
  const list = (arr, max, shape) => (Array.isArray(arr) ? arr : [])
    .map(shape).filter(Boolean).slice(0, max);

  /* ⚠ Ici, contrairement à la génération, un classement absent doit rester
     ABSENT. ordreOrganismes() complète toujours les trois : l'appeler sur du
     vide produirait l'ordre par défaut, et merge() écraserait alors le
     classement du coach à chaque retouche qui n'en parle pas. */
  const organismes = (Array.isArray(raw.organismes) && raw.organismes.length)
    ? ordreOrganismes(raw.organismes) : [];
  const org = organismes[0] || '';

  return {
    resume: str(raw.resume),
    synthese: str(raw.synthese),
    pointA: txt(raw.pointA),
    pointB: txt(raw.pointB),
    verrou: str(raw.verrou),
    verrouPlan: txt(raw.verrouPlan),
    horizon12: str(raw.horizon12),
    horizon36: str(raw.horizon36),
    organismes,
    organisme: org,
    renforces: (Array.isArray(raw.renforces) ? raw.renforces : [])
      .map((x) => String(x || '').toUpperCase().trim())
      .filter((k, i, t) => JALON_KEYS.indexOf(k) >= 0 && t.indexOf(k) === i)
      .slice(0, 2),
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
      TOUTES_CLES.forEach((k) => {
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

  ['synthese', 'pointA', 'pointB', 'verrou', 'verrouPlan', 'horizon12', 'horizon36']
    .forEach((k) => { if (s[k]) p[k] = s[k]; });
  if (s.organismes && s.organismes.length) { p.organismes = s.organismes; p.organisme = s.organismes[0] || ''; }
  if (s.renforces && s.renforces.length) p.renforces = s.renforces;

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
