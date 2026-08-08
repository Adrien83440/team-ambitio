// ============================================================================
// api/coaching-plan-suggest.js — PROPOSITIONS POUR LE PLAN D'ACTION
// ----------------------------------------------------------------------------
// Lit le questionnaire AlteoForms d'un client coaching et propose le Point A,
// le Point B, le verrou principal et l'organisme bloqué — pour que le mentor
// n'ait plus qu'à valider ou corriger dans l'assistant.
//
// Pas de « chantiers » : l'accompagnement n'est plus adossé à des modules ni
// à des vidéos (décision Adrien 31/07). Le plan tient dans les jalons.
//
// URL  : POST https://team.alteore.com/api/coaching-plan-suggest
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { clientId, force?, notes? }
//
// « notes » = ce que le mentor a collecté lui-même (cases « Infos collectées »
// de l'assistant + dictée du mode vocal). C'est de la matière de PREMIÈRE main :
// elle prime sur le questionnaire en cas de contradiction, et elle entre dans la
// clé de cache pour qu'une nouvelle info regénère la proposition.
//
// Réponses
//   200 { ok:true, suggestion:{ pointA, pointB, verrou, organisme, synthese,
//         chiffres[], problemes[], objectifs[], kpis[], risques[] },
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
/* Le plan engage 6 mois d'accompagnement d'un dirigeant : c'est le document le
   plus structurant qu'on produise, joué une fois par client puis mis en cache.
   On prend donc le modèle le plus capable — Opus 5 — et pas un modèle rapide.
   La réflexion est active par défaut sur ce modèle ; « effort » règle sa
   profondeur (voir output_config plus bas). */
const MODEL = 'claude-opus-5';

const ORGANISMES = ['delivrabilite', 'rentabilite', 'acquisition'];
/* Les 5 milestones du parcours 6 mois (document v2.0 du 31/07/2026). */
const JALON_KEYS = ['M1', 'M2', 'M3', 'M4', 'M5'];

/* Empreinte du questionnaire + des notes du mentor — change dès qu'une réponse
   ou une info collectée change, ce qui invalide le cache au bon moment. */
function qKey(q, notes) {
  const parts = (q.answers || []).map((a) => String(a.q || '') + '=' + String(a.a || ''));
  return String(q.formTitle || '') + '|' + parts.length + '|' + parts.join('~').slice(0, 4000)
    + '|N:' + String(notes || '').slice(0, 4000);
}

function buildPrompt(client, q, notes) {
  const lignes = (q.answers || [])
    .filter((a) => a && String(a.a || '').trim())
    .map((a) => '- ' + String(a.q).trim() + ' : ' + String(a.a).trim())
    .join('\n');

  const bloc = [];
  bloc.push('Tu prépares le plan d\'action d\'un client du programme Elite Phénix.');
  bloc.push('');
  bloc.push('LE PROGRAMME — six mois, 24 séances individuelles, aucun module vidéo.');
  bloc.push('Cinq milestones, dans un ordre NON NÉGOCIABLE :');
  bloc.push('  M1 (mois 1)     Libérer le temps du dirigeant.');
  bloc.push('                  Sans marge de manœuvre, aucun chantier de fond n\'est tenable.');
  bloc.push('  M2 (mois 2)     Poser le cap et le cadre : vision, valeurs, organisation.');
  bloc.push('  M3 (mois 3-4)   Déléguer pour de bon, et faire en sorte que cela rapporte.');
  bloc.push('  M4 (mois 5)     Piloter par les chiffres et installer le relais.');
  bloc.push('  M5 (mois 6)     L\'entreprise tourne sans lui, la croissance peut repartir.');
  bloc.push('');
  bloc.push('Ce qui varie d\'un dirigeant à l\'autre n\'est PAS l\'ordre, c\'est la PROFONDEUR :');
  bloc.push('  urgence rentabilité → M3 renforcé (audit de marge amorcé dès le mois 1) ;');
  bloc.push('  urgence équipe → M2 et M3 renforcés ;');
  bloc.push('  recrutement déjà lancé → M4 renforcé.');
  bloc.push('L\'acquisition ne s\'ouvre qu\'au M5, jamais avant : sur une organisation qui');
  bloc.push('dépend encore du dirigeant, chaque nouveau client ajoute de la pression.');
  bloc.push('');
  bloc.push('Voici le questionnaire rempli à l\'inscription :');
  bloc.push('');
  bloc.push(lignes || '(aucun questionnaire)');
  bloc.push('');
  if (String(client && client.resume72h || '').trim()) {
    bloc.push('COMPTE RENDU DU CALL DES 72 H — la matière la plus fraîche et la plus fiable.');
    bloc.push('C\'est de LÀ que doivent sortir le point A, le point B et le verrou.');
    bloc.push('"""');
    bloc.push(String(client.resume72h).trim().slice(0, 14000));
    bloc.push('"""');
    bloc.push('');
  }
  if (String(notes || '').trim()) {
    bloc.push('NOTES DU MENTOR — collectées de vive voix pendant les échanges.');
    bloc.push('Ce sont des informations de première main : elles PRIMENT sur le questionnaire');
    bloc.push('en cas de contradiction, et tu dois t\'en servir en priorité.');
    bloc.push('"""');
    bloc.push(String(notes).trim().slice(0, 12000));
    bloc.push('"""');
    bloc.push('');
  }

  return bloc.concat([
    'Produis une proposition complète de plan d\'action. Le mentor la relira et la corrigera.',
    '',
    'RÈGLES ABSOLUES',
    '- N\'invente AUCUN chiffre. Utilise uniquement ceux du questionnaire et des notes ci-dessus.',
    '  Si une donnée manque, n\'en parle pas — ne l\'estime pas, ne l\'arrondis pas.',
    '- Phrases courtes, factuelles, au présent. Pas de jargon, pas de conseil théorique.',
    '- Vouvoiement interdit : on parle DU client, pas AU client (3e personne).',
    '- Tout doit être RÉALISABLE par ce dirigeant-là, avec les moyens qu\'il a décrits.',
    '  Une action qu\'il ne peut pas faire cette semaine n\'a rien à faire dans le plan.',
    '',
    'CE QUE TU PRODUIS',
    '1. pointA — LA SITUATION DE DÉPART, précise et détaillée : 4 à 8 phrases,',
    '   au présent, factuelles, sans jugement. Ce que ce dirigeant vit vraiment',
    '   aujourd\'hui, avec SES chiffres et SES mots. Couvre ce qui est documenté :',
    '   à quoi ressemble son agenda, ce qui remonte à lui, ce que fait (ou ne fait',
    '   pas) son équipe, ce qui est écrit ou non, son chiffre et sa trésorerie.',
    '   N\'écris que ce que le compte rendu ou le questionnaire établissent.',
    '2. pointB — OÙ IL VEUT ÊTRE DANS SIX MOIS, précis et détaillé : 4 à 8 phrases.',
    '   Ce sont SES objectifs, pas ceux du programme. Les cibles chiffrées sont',
    '   dérivées de ses chiffres à lui (un CA cible se calcule depuis le CA actuel),',
    '   jamais sorties de nulle part. Ce qui n\'est pas mesurable ne se pilote pas.',
    '3. verrou — UNE phrase : le plus gros blocage, celui qu\'on lève en PREMIER.',
    '   Le vrai problème, pas le symptôme.',
    '4. verrouPlan — 3 à 6 phrases : ce qu\'on va faire pour le lever.',
    '   ⚠ AUCUNE DURÉE, AUCUNE DATE, AUCUN DÉLAI. Ni « en 2 semaines », ni « d\'ici',
    '   la fin du mois », ni « rapidement ». Le rythme dépend de l\'avancement réel',
    '   et de la validation du coach — pas d\'une promesse écrite d\'avance.',
    '5. organismes — les trois mots delivrabilite, rentabilite, acquisition CLASSÉS',
    '   dans l\'ordre où on les traite pour CE dirigeant, du plus urgent au dernier.',
    '   delivrabilite = le dirigeant est le goulot, rien ne tourne sans lui.',
    '   rentabilite  = ça produit du chiffre mais pas de résultat ni de trésorerie.',
    '   acquisition  = la machine tourne et est rentable, il manque du volume.',
    '   ⚠ acquisition est TOUJOURS en dernier : c\'est une règle du programme.',
    '6. renforces — les milestones à renforcer pour ce dossier, parmi M1 à M5.',
    '   Zéro, un ou deux au maximum. Vide si rien ne le justifie.',
    '7. horizon12 / horizon36 — UNE phrase courte chacune : où cette entreprise',
    '   peut être dans 12 mois, puis dans 3 ans, si les six mois tiennent leurs',
    '   promesses. Ambitieux mais crédible au vu de sa taille et de son secteur.',
    '   Ce sont des repères de direction, pas des engagements : reste sobre, sans',
    '   chiffre inventé. Deux phrases discrètes, qui donnent envie de continuer.',
    '8. synthese — UNE phrase forte : de quoi vers quoi on emmène ce dirigeant en 6 mois.',
    '9. chiffres — 4 à 8 repères du dossier, tels quels : [{"label":"CA annuel","valeur":"2 400 000 €"}].',
    '   Uniquement des valeurs présentes dans le questionnaire.',
    '10. problemes — 3 à 5 problématiques, la plus grave d\'abord :',
    '   [{"titre":"Micro-gestion chronique","detail":"une phrase factuelle"}]',
    '11. objectifs — 3 à 5 objectifs des 6 mois, concrets : ["...", "..."]',
    '12. kpis — 4 à 8 indicateurs à suivre :',
    '   [{"cat":"Financier|Commercial|Opérationnel|Humain","nom":"Marge nette",',
    '     "freq":"Mensuel","actuel":"8 %","cible":"12 %"}]',
    '   « actuel » vient du questionnaire ; s\'il est inconnu, mets "—" (jamais une invention).',
    '13. risques — 2 à 4 risques ou freins : [{"titre":"...","detail":"..."}]',
    '14. ditClient — 4 à 7 informations MARQUANTES que le dirigeant a dites dans',
    '    le questionnaire, reformulées en une ligne, hors chiffres purs :',
    '    [{"titre":"Présent sur tous les chantiers","detail":"soirs et samedis compris"}]',
    '    C\'est ce qui montre au client qu\'on l\'a écouté — reste fidèle à ses mots.',
    '15. jalons — comment CHAQUE milestone se traduit pour CE dirigeant.',
    '    Objet dont les clés sont exactement M1, M2, M3, M4, M5 :',
    '    {"M1":{"focus":"une phrase : ce qu\'on traite chez LUI à ce milestone",',
    '      "actions":["2 à 3 actions concrètes, verbe à l\'infinitif"]}, …}',
    '    ⚠ Ne renvoie NI "titre" NI "preuve" : ils sont fixés par le programme',
    '    et identiques pour tous. Tu personnalises le focus et les actions,',
    '    jamais l\'intitulé ni le critère de validation.',
    '    ⚠ Aucune durée, aucune date, aucun délai dans les actions.',
    '',
    'Réponds UNIQUEMENT par un objet JSON, sans texte autour, sans bloc de code :',
    '{"pointA":"...","pointB":"...","verrou":"...","verrouPlan":"...",',
    ' "organismes":["...","...","..."],"renforces":["M3"],',
    ' "horizon12":"...","horizon36":"...","synthese":"...",',
    ' "chiffres":[{"label":"...","valeur":"..."}],',
    ' "ditClient":[{"titre":"...","detail":"..."}],',
    ' "jalons":{"M1":{"focus":"...","actions":["..."]}},',
    ' "problemes":[{"titre":"...","detail":"..."}],',
    ' "objectifs":["..."],',
    ' "kpis":[{"cat":"...","nom":"...","freq":"...","actuel":"...","cible":"..."}],',
    ' "risques":[{"titre":"...","detail":"..."}]}',
  ]).join('\n');
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

/* Le classement des trois organismes. Deux garanties tenues ICI, pas dans le
   prompt : les trois y sont toujours, sans doublon, et l'acquisition finit
   dernière — c'est une règle du programme, pas une préférence du modèle. */
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

function sanitize(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const str = (v) => String(v == null ? '' : v).trim().slice(0, 400);
  /* Texte long : le point A et le point B sont désormais détaillés. */
  const txt = (v) => String(v == null ? '' : v).trim().slice(0, 2500);
  const organismes = ordreOrganismes(raw.organismes);
  const org = organismes[0] || '';
  /* Listes bornées et normalisées — le modèle peut être bavard ou hors
     format ; rien ne sort d'ici sans être passé au filtre. */
  const list = (arr, max, shape) => (Array.isArray(arr) ? arr : [])
    .map(shape).filter(Boolean).slice(0, max);
  const CATS = ['Financier', 'Commercial', 'Opérationnel', 'Humain'];

  return {
    pointA: txt(raw.pointA),
    pointB: txt(raw.pointB),
    verrou: str(raw.verrou),
    verrouPlan: txt(raw.verrouPlan),
    organismes,
    organisme: org,
    renforces: (Array.isArray(raw.renforces) ? raw.renforces : [])
      .map((x) => String(x || '').toUpperCase().trim())
      .filter((k, i, t) => JALON_KEYS.indexOf(k) >= 0 && t.indexOf(k) === i)
      .slice(0, 2),
    horizon12: str(raw.horizon12),
    horizon36: str(raw.horizon36),
    synthese: str(raw.synthese),
    chiffres: list(raw.chiffres, 8, (x) => {
      const l = str(x && x.label), v = str(x && x.valeur);
      return (l && v) ? { label: l.slice(0, 40), valeur: v.slice(0, 40) } : null;
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
    ditClient: list(raw.ditClient, 7, (x) => {
      const t = str(x && x.titre);
      return t ? { titre: t.slice(0, 90), detail: str(x && x.detail).slice(0, 160) } : null;
    }),
    /* Contenu par milestone — clés strictement limitées aux 5 du programme.
       Ni titre ni preuve : ils appartiennent au référentiel et sont les mêmes
       pour tous. Le modèle personnalise le focus et les actions, rien d'autre. */
    jalons: (() => {
      const src = raw.jalons && typeof raw.jalons === 'object' ? raw.jalons : {};
      const out = {};
      JALON_KEYS.forEach((k) => {
        const j = src[k];
        if (!j || typeof j !== 'object') return;
        const actions = (Array.isArray(j.actions) ? j.actions : [])
          .map((a) => str(a).slice(0, 160)).filter(Boolean).slice(0, 3);
        const focus = str(j.focus).slice(0, 260);
        if (focus || actions.length) out[k] = { focus, actions };
      });
      return out;
    })(),
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
  /* Notes du mentor : bornées ici, jamais renvoyées au client, jamais écrites
     ailleurs que dans la clé de cache. */
  const notes = body && typeof body.notes === 'string' ? body.notes.trim().slice(0, 12000) : '';
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
    /* Sans questionnaire on peut quand même travailler si le mentor a dicté
       ses notes : c'est tout l'intérêt du mode vocal pour les dossiers entrés
       sans formulaire. Sans NI l'un NI l'autre, il n'y a rien à analyser. */
    const qOk = !!(q && (q.answers || []).length);
    if (!qOk && !notes) {
      res.status(200).json({ ok: false, error: 'no_questionnaire' });
      return;
    }
    const qSafe = qOk ? q : { formTitle: '', answers: [] };
    /* Le compte rendu des 72 h est saisi dans l'assistant : il vit dans
       clients/{id}.planV2.resume72h. On le remonte à la racine pour que
       buildPrompt() le trouve, sans changer la forme du document. */
    if (!client.resume72h && client.planV2 && client.planV2.resume72h) {
      client.resume72h = client.planV2.resume72h;
    }

    /* Le compte rendu des 72 h entre dans la clé : sans lui, le coach colle
       son résumé et l'IA lui resservirait la proposition d'avant, en silence. */
    const key = qKey(qSafe, notes + '|R:' + String(client.resume72h || '').slice(0, 6000));
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
        /* Opus 5 réfléchit par défaut : max_tokens couvre réflexion + réponse,
           d'où la marge très au-dessus de la taille du JSON attendu. */
        max_tokens: 24000,
        output_config: { effort: 'high' },
        messages: [{ role: 'user', content: buildPrompt(client, qSafe, notes) }],
      }),
    });

    if (!r.ok) {
      const t = await r.text().catch(() => '');
      console.error('[coaching-plan-suggest] anthropic', r.status, t.slice(0, 300));
      res.status(200).json({ ok: false, error: 'ai_unavailable' });
      return;
    }

    const j = await r.json();
    /* Un refus des garde-fous revient en HTTP 200 avec un contenu vide :
       sans ce test, on lirait du vide et on croirait à une panne. */
    if (j.stop_reason === 'refusal') {
      console.warn('[coaching-plan-suggest] refus', JSON.stringify(j.stop_details || {}).slice(0, 200));
      res.status(200).json({ ok: false, error: 'ai_refused' });
      return;
    }
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
