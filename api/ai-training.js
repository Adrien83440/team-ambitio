// ============================================================================
// api/ai-training.js — ENTRAÎNEMENT CLOSER (programme IA, Lot 5)
// ----------------------------------------------------------------------------
// Un prospect SIMULÉ joue un closing par écrit avec le closer. Sa persona
// s'appuie sur de VRAIES objections de nos prospects (ai_objections) et sur
// le cerveau Alteore (offres, prix, client idéal).
//
// POST Bearer <ID token> (admin / sales)
//   { action:'turn', scenario, history:[{role:'closer'|'prospect', text}], message }
//     → { ok, reply }                       (Opus, effort bas : rapide)
//   { action:'debrief', scenario, history } → { ok, debrief }  (Opus, medium)
//     débrief enregistré dans ai_training/{auto} (suivi de progression).
// scenario = { profil, difficulte:'facile'|'moyen'|'difficile', objection }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, cap } = require('./_ai');
const { CATEGORIES } = require('./_aiObjections');

const PROFILS = {
  btp: 'Gérant d\'une entreprise du BTP (8 salariés, 70 k€/mois de CA), débordé, sceptique envers les « coachs », pragmatique.',
  coach: 'Coach indépendante qui a lancé son activité il y a 18 mois, 4 k€/mois, manque de confiance, peur de dépenser.',
  ecom: 'E-commerçant (30 k€/mois), pressé, compare avec des formations en ligne moins chères, veut des chiffres.',
  restau: 'Restauratrice avec 2 établissements, associée à son mari, décisions toujours prises à deux.',
  libre: 'Profil au choix parmi nos prospects typiques (entrepreneur francophone, TPE/PME), crédible et cohérent.',
};
const LEVELS = {
  facile: 'Tu es plutôt ouvert : 1 objection principale, que tu lâches si elle est bien traitée.',
  moyen: 'Tu as 2 à 3 objections réelles ; tu ne cèdes que si on a creusé ta douleur et que la réponse est précise.',
  difficile: 'Tu es méfiant, tu testes le closer, tu reviens sur le prix, tu esquives les questions de découverte ; tu ne signes que face à un closing excellent.',
};

async function realObjections(cat) {
  try {
    let q = db.collection('ai_objections');
    if (cat && CATEGORIES[cat]) q = q.where('category', '==', cat);
    const s = await q.limit(40).get();
    const out = [];
    s.forEach(function (d) { const o = d.data() || {}; if (o.quote) out.push('« ' + cap(o.quote, 200) + ' »'); });
    return out.slice(0, 12);
  } catch (e) { return []; }
}

function transcript(history) {
  return (history || []).slice(-40).map(function (m) { return (m.role === 'prospect' ? 'PROSPECT' : 'CLOSER') + ' : ' + cap(m.text, 1500); }).join('\n');
}

const DEBRIEF_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['score', 'verdict', 'etapes', 'pointsForts', 'axesProgres', 'phrases'],
  properties: {
    score: { type: 'integer', description: '/100' },
    verdict: { type: 'string', description: 'Le prospect aurait-il signé ? Pourquoi, en 2 phrases' },
    etapes: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['etape', 'note', 'commentaire'], properties: { etape: { type: 'string' }, note: { type: 'integer' }, commentaire: { type: 'string' } } } },
    pointsForts: { type: 'array', items: { type: 'string' } },
    axesProgres: { type: 'array', items: { type: 'string' } },
    phrases: { type: 'array', items: { type: 'string' }, description: '2-3 formulations à réutiliser, réécrites au mieux' },
  },
};

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (['admin', 'sales', 'coach', 'csm'].indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; } // ouvert à toute l'équipe (08/10/2026)
  const body = parseBody(req);
  const sc = body.scenario || {};
  const profil = PROFILS[sc.profil] || PROFILS.libre;
  const level = LEVELS[sc.difficulte] || LEVELS.moyen;
  const history = Array.isArray(body.history) ? body.history : [];

  try {
    if (body.action === 'turn') {
      const msg = String(body.message || '').trim().slice(0, 2000);
      if (!msg) { res.status(400).json({ ok: false, error: 'empty' }); return; }
      const objs = await realObjections(sc.objection);
      const sys = [
        'Tu JOUES un prospect d\'Alteore dans un appel de closing (simulation d\'entraînement). Ne sors JAMAIS du personnage, ne donne jamais de conseil au closer, ne dis jamais que tu es une IA.',
        'PERSONA : ' + profil,
        'DIFFICULTÉ : ' + level,
        sc.objection && CATEGORIES[sc.objection] ? 'OBJECTION À TRAVAILLER EN PRIORITÉ : ' + CATEGORIES[sc.objection] + '.' : '',
        objs.length ? 'Voici de VRAIES formulations de nos prospects, inspire-t\'en (ne les recopie pas toutes) :\n' + objs.join('\n') : '',
        'Réponds comme à l\'oral : 1 à 4 phrases, naturel, avec tes hésitations. Si le closer pose une bonne question de découverte, donne des détails concrets et cohérents sur ta situation.',
      ].filter(Boolean).join('\n');
      const r = await callClaude({ task: 'training', system: sys, prompt: (history.length ? 'ÉCHANGE JUSQU\'ICI :\n' + transcript(history) + '\n\n' : '') + 'CLOSER : ' + msg + '\n\nRéponds en tant que PROSPECT (texte seul).', uid: auth.uid, ref: 'training' });
      if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
      res.status(200).json({ ok: true, reply: r.text.replace(/^PROSPECT\s*:\s*/i, '') });
      return;
    }

    if (body.action === 'debrief') {
      if (history.length < 4) { res.status(400).json({ ok: false, error: 'too_short', message: 'Échange trop court pour un débrief.' }); return; }
      const r = await callClaude({
        task: 'training_debrief',
        system: 'Tu es le directeur commercial d\'Alteore. Débriefe cette simulation de closing (persona : ' + profil + ' ; difficulté : ' + (sc.difficulte || 'moyen') + '). Note chaque étape de la TRAME DE CLOSING du contexte Alteore (à défaut : cadre, découverte, douleur, projection, offre, prix, objections, engagement), sois exigeant et concret, cite les répliques.',
        prompt: transcript(history),
        schema: DEBRIEF_SCHEMA,
        uid: auth.uid,
        ref: 'training',
      });
      if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
      const d = Object.assign({}, r.json, { score: Math.max(0, Math.min(100, Math.round(Number(r.json.score) || 0))) });
      try { await db.collection('ai_training').add({ uid: auth.uid, scenario: { profil: sc.profil || 'libre', difficulte: sc.difficulte || 'moyen', objection: sc.objection || null }, score: d.score, turns: history.length, at: Date.now() }); } catch (e) { /* suivi best-effort */ }
      res.status(200).json({ ok: true, debrief: d });
      return;
    }
    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[ai-training]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
