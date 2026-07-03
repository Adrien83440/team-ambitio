// ============================================================================
// api/academy-progress.js — AVANCEMENT AE ACADEMY D'UN CLIENT (V11a · Vague B)
// ----------------------------------------------------------------------------
// Appelé par academy-widget.js (fiches coaching + cartes CSM) pour afficher
// l'avancement Academy d'un client : progression, jalons, bâtiment, année 2 —
// et depuis la Vague B, ses VICTOIRES (ses mots, ses chiffres réels).
//
// URL  : POST https://team.alteore.com/api/academy-progress
// Auth : Bearer ID token Firebase — rôles admin / coach / csm uniquement.
// Body : { "email": "client@exemple.com" }
//
// Relais serveur → serveur vers le pont (le secret ACADEMY_BRIDGE_KEY ne
// transite jamais par un navigateur) :
//   POST {ACADEMY_BRIDGE_URL|https://academy.adrienemily.com}/api/bridge/progress
//
// Le dossier du pont est REMODELÉ ici pour le widget : totaux globaux
// (leçons faites/total), date formatée, lockedLeft en objets { name }.
//
// Réponses 200 (fail-soft — le widget affiche un message doux) :
//   { ok:true, found:false }                          → aucun compte Academy
//   { ok:true, found:true, dossier:{…}, text:"…" }    → panneau + texte à copier
//   { ok:false, error:"bridge_not_configured"|"forbidden"|"academy_unreachable" }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];

function fmtD(ms) {
  try { return new Date(ms).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', year: 'numeric' }); }
  catch (e) { return ''; }
}

// Remodelage pont → widget.
function shape(d) {
  var done = 0, total = 0;
  (d.courses || []).forEach(function (c) { done += c.done || 0; total += c.total || 0; });
  return {
    email: d.email || '',
    totals: {
      pct: total ? Math.round((done / total) * 100) : ((d.totals && d.totals.avgPct) || 0),
      done: done,
      total: total,
      winsCount: (d.totals && d.totals.winsCount) || 0,
      winsKpis: (d.totals && d.totals.winsKpis) || [],
    },
    lastActivity: d.lastActivity ? fmtD(d.lastActivity) : '',
    courses: (d.courses || []).map(function (c) {
      return {
        name: c.name || 'Formation',
        pct: c.pct || 0,
        done: c.done || 0,
        total: c.total || 0,
        milestones: c.milestones || { reached: 0, total: 0 },
        building: c.building ? { roomsDone: c.building.roomsDone || 0, roomsTotal: c.building.roomsTotal || 0 } : null,
        lockedLeft: (c.lockedLeft || []).map(function (t) { return { name: t }; }),
        wins: c.wins || null, // { count, totals, kpis, last:[{title,text,at,summary}] }
      };
    }),
  };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // requireAuth a déjà répondu 401

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
  const email = String(body.email || '').trim().toLowerCase();
  if (!email) {
    res.status(200).json({ ok: false, error: 'email_required' });
    return;
  }

  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: email }),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) {
      res.status(200).json({ ok: false, error: 'academy_unreachable' });
      return;
    }
    if (!j.found) {
      res.status(200).json({ ok: true, found: false });
      return;
    }
    res.status(200).json({ ok: true, found: true, dossier: shape(j.dossier || {}), text: j.text || '' });
  } catch (e) {
    console.error('[academy-progress]', e && e.message);
    res.status(200).json({ ok: false, error: 'academy_unreachable' });
  }
};
