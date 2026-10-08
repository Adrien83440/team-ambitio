// ============================================================================
// api/ai-session-report.js — COMPTE-RENDU DE SÉANCE COACHING (Lot 3)
// ----------------------------------------------------------------------------
// Le coach colle ses notes brutes (ou les notes Gemini de la visio) dans le
// champ Résumé ; Opus les transforme en compte-rendu structuré + devoirs.
// N'ÉCRIT RIEN sur la fiche clients/{id} : coaching.html réécrit la fiche
// entière à chaque sauvegarde (setDoc sans merge) — c'est donc le coach qui
// enregistre le résultat avec son bouton habituel, après relecture.
//
// POST Bearer <ID token> (admin / coach / csm)
//   { clientId, yi, sn, raw, devoirsRaw? }
//   → { ok, resume, devoirs[], vigilance }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, cap } = require('./_ai');

const ROLES = ['admin', 'coach', 'csm'];

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['resume', 'devoirs', 'vigilance'],
  properties: {
    resume: { type: 'string', description: 'Compte-rendu 100-220 mots, texte brut, 3 blocs titrés « Ce qu\'on a travaillé », « Décisions », « Prochaine étape », puces avec tiret simple' },
    devoirs: { type: 'array', items: { type: 'string' }, description: 'Devoirs concrets, une action vérifiable par ligne, verbe à l\'infinitif' },
    vigilance: { type: 'string', description: 'Pour le coach uniquement : un signal de désengagement / blocage repéré, ou chaîne vide' },
  },
};

function allSessions(c) {
  const out = [];
  if (c.years && c.years.length) c.years.forEach(function (y, yi) { (y.sessions || []).forEach(function (s) { if (s) out.push(Object.assign({ _yi: yi }, s)); }); });
  else (c.sessions || []).forEach(function (s) { if (s) out.push(Object.assign({ _yi: -1 }, s)); });
  return out;
}

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);
  const clientId = String(body.clientId || '').trim();
  const raw = String(body.raw || '').trim();
  if (!clientId || raw.length < 40) { res.status(400).json({ ok: false, error: 'bad_request', message: 'Notes trop courtes.' }); return; }

  try {
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'client_not_found' }); return; }
    const c = snap.data() || {};
    const done = allSessions(c).filter(function (s) { return s.statut === 'fait' && s.numero !== 0 && s.type !== 'rdv72h'; })
      .sort(function (a, b) { return String(a.date || '') < String(b.date || '') ? -1 : 1; });

    const P = [];
    P.push('CLIENT : ' + (c.nom || '?') + ' · ' + (c.programme || '') + (c.activite ? ' · ' + cap(c.activite, 150) : ''));
    if (c.planAction) P.push('PLAN D\'ACTION : ' + cap(c.planAction, 1500));
    const prev = done.slice(-2);
    if (prev.length) {
      P.push('SÉANCES PRÉCÉDENTES (continuité) :');
      prev.forEach(function (s) { P.push('- ' + (s.date || '') + ' : ' + cap(s.resume, 500) + (s.devoirs ? ' | devoirs : ' + cap(s.devoirs, 300) : '')); });
    }
    P.push('');
    P.push('SÉANCE N° ' + (Number(body.sn) || '?') + ' — NOTES BRUTES DU COACH :');
    P.push(cap(raw, 40000));
    if (body.devoirsRaw && String(body.devoirsRaw).trim()) P.push('DEVOIRS DÉJÀ NOTÉS PAR LE COACH : ' + cap(body.devoirsRaw, 1500));

    const r = await callClaude({
      task: 'session_report',
      system: 'Tu mets au propre le compte-rendu d\'une séance de coaching business d\'Alteore à partir des notes brutes du coach (parfois des notes automatiques Gemini). ' +
        'Le compte-rendu est lu par le coach suivant et envoyé au client avec le replay : clair, concret, bienveillant, au vouvoiement. ' +
        'Garde les devoirs déjà notés par le coach et complète-les seulement avec ceux explicitement décidés en séance. N\'invente rien.',
      prompt: P.join('\n'),
      schema: SCHEMA,
      uid: auth.uid,
      ref: 'client:' + clientId,
    });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    res.status(200).json({ ok: true, resume: String(r.json.resume || ''), devoirs: (r.json.devoirs || []).slice(0, 12), vigilance: String(r.json.vigilance || '') });
  } catch (e) {
    console.error('[ai-session-report]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
