// ============================================================================
// api/academy-activite-audit.js — ACTIVITÉ ACADEMY D'UN ÉLÈVE, LECTURE SEULE
// ----------------------------------------------------------------------------
// Répond à « cet élève s'est-il connecté récemment, et qu'a-t-il fait ? » sans
// clé de service dans la session de l'agent (CLAUDE.md, règle 8).
//
// N'ÉCRIT RIEN. Relais serveur → serveur vers le pont de l'Academy
// (POST /api/bridge/progress, secret ACADEMY_BRIDGE_KEY) ; ne renvoie que des
// dates et des intitulés de formation : dernière connexion, dernière activité,
// avancement par formation, et la chronologie de ce qui est daté côté Academy
// (jalons atteints, victoires, workbooks, paliers réclamés).
//
// Accès : clé égale à la variable Vercel ACADEMY_AUDIT_KEY (au moins 24
// caractères), en en-tête `x-audit-key` ou en paramètre `k`. Variable absente
// ou clé fausse → 404. La clé est posée dans Vercel, limitée à la preview de la
// branche, jamais dans le dépôt ; la retirer coupe l'accès.
//
//   GET /api/academy-activite-audit?email=eleve@exemple.com
// ============================================================================
'use strict';

const crypto = require('crypto');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

function keyOk(req) {
  const want = String(process.env.ACADEMY_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function iso(ms) {
  if (!ms || typeof ms !== 'number') return null;
  try { return new Date(ms).toISOString(); } catch (e) { return null; }
}
function paris(ms) {
  if (!ms || typeof ms !== 'number') return null;
  try {
    return new Date(ms).toLocaleString('fr-FR', {
      timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit'
    });
  } catch (e) { return null; }
}
function joursDepuis(ms) {
  if (!ms || typeof ms !== 'number') return null;
  return Math.floor((Date.now() - ms) / 86400000);
}

module.exports = async function (req, res) {
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const email = String((req.query && req.query.email) || '').trim().toLowerCase();
  if (!email) { res.status(400).json({ ok: false, error: 'email_required' }); return; }

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) { res.status(200).json({ ok: false, error: 'bridge_not_configured' }); return; }

  let j = null;
  let status = 0;
  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/progress', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: email })
    });
    status = r.status;
    try { j = await r.json(); } catch (e) { j = null; }
  } catch (e) {
    res.status(200).json({ ok: false, error: 'academy_unreachable', detail: String((e && e.message) || e).slice(0, 120) });
    return;
  }
  if (!j || j.ok !== true) {
    res.status(200).json({ ok: false, error: 'academy_error', httpStatus: status, bridgeError: (j && j.error) || null });
    return;
  }
  if (!j.found) { res.status(200).json({ ok: true, found: false }); return; }

  const d = j.dossier || {};
  const events = [];
  function push(at, type, formation, label) {
    if (!at || typeof at !== 'number') return;
    events.push({ at: at, date: paris(at), type: type, formation: formation, label: String(label || '').slice(0, 120) });
  }

  const courses = (d.courses || []).map(function (c) {
    const name = c.name || 'Formation';
    ((c.milestones && c.milestones.items) || []).forEach(function (m) {
      if (m.reached) push(m.at, 'jalon_atteint', name, m.label);
    });
    ((c.wins && c.wins.items) || []).forEach(function (w) { push(w.at, 'victoire', name, w.title); });
    (c.workbooks || []).forEach(function (w) { push(w.updatedAt, 'workbook_modifie', name, w.title); });
    const steps = [];
    ((c.path && c.path.steps) || []).forEach(function (s) {
      const o = { title: String(s.title || '').slice(0, 100), status: s.status || null };
      Object.keys(s).forEach(function (k) {
        if (/At$/.test(k) && typeof s[k] === 'number' && s[k] > 0) { o[k] = paris(s[k]); push(s[k], 'etape_' + k, name, s.title); }
      });
      steps.push(o);
    });
    return {
      formation: name,
      pct: c.pct || 0,
      leconsFaites: c.done || 0,
      leconsTotal: c.total || 0,
      jalons: c.milestones ? (c.milestones.reached || 0) + '/' + (c.milestones.total || 0) : null,
      derniereActivite: paris(c.lastAt),
      derniereActiviteIso: iso(c.lastAt),
      etapes: steps
    };
  });

  (((d.points || {}).claims) || []).forEach(function (cl) { push(cl.at, 'palier_reclame', '', cl.name); });

  events.sort(function (a, b) { return b.at - a.at; });
  events.forEach(function (e) { delete e.at; });

  res.status(200).json({
    ok: true,
    found: true,
    maintenant: paris(Date.now()),
    derniereConnexion: paris(d.lastLoginAt),
    derniereConnexionIso: iso(d.lastLoginAt),
    joursDepuisConnexion: joursDepuis(d.lastLoginAt),
    derniereActivite: paris(d.lastActivity),
    derniereActiviteIso: iso(d.lastActivity),
    joursDepuisActivite: joursDepuis(d.lastActivity),
    contrat: d.contract || null,
    compteARebours: d.countdown || null,
    points: d.points ? { total: d.points.total, niveau: (d.points.level && d.points.level.name) || null } : null,
    formations: courses,
    chronologie: events.slice(0, 80)
  });
};
