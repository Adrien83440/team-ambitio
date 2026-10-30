// ============================================================================
// api/client-demarrage.js — DÉMARRAGE DIFFÉRÉ D'UN CLIENT (30/10/2026)
// ----------------------------------------------------------------------------
// GET  Bearer <CRON_SECRET>                        → passage du cron (horaire)
// GET  ?liste=1                                    → clients en attente
// GET  ?leadId= | ?clientId= | ?personId=          → état d'un client
// POST { action:'poser', leadId…, date:'AAAA-MM-JJ' }
// POST { action:'retirer', leadId… }
// POST { action:'demarrer', leadId…, force? }
//
// DROITS (décision Adrien 30/10/2026) : le closer pose la date pendant le
// closing ; ensuite seuls admin et CSM la changent ou démarrent le client.
// Seul un admin passe outre les conditions (`force`). Coachs : lecture seule.
//
// Règles : ../demarrage-core.js · écritures : ./_demarrage.js
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const Core = require('../demarrage-core.js');
const D = require('./_demarrage');

const ROLES_LECTURE = ['admin', 'csm', 'coach', 'sales'];

function droits(auth, L) {
  const equipe = auth.role === 'admin' || auth.role === 'csm';
  const closerAuClosing = auth.role === 'sales' && !(L.closePilot && L.closePilot.doneAt);
  return { poser: equipe || closerAuClosing, demarrer: equipe, forcer: auth.role === 'admin' };
}

function cible(o) {
  return { leadId: String(o.leadId || '').trim(), clientId: String(o.clientId || '').trim(), personId: String(o.personId || '').trim() };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const h = req.headers['authorization'] || '';
    if (secret && (h === 'Bearer ' + secret || req.headers['x-api-key'] === secret)) {
      try { res.status(200).json(Object.assign({ ok: true }, await D.passage())); }
      catch (e) { console.error('[client-demarrage] cron', e && e.stack ? e.stack : e); res.status(200).json({ ok: false, error: e.message }); }
      return;
    }
  } else if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES_LECTURE.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.liste) { res.status(200).json({ ok: true, items: await D.liste() }); return; }
      const lead = await D.trouverLead(cible(q));
      if (!lead) { res.status(200).json({ ok: true, leadId: null }); return; }
      const c = await D.conditionsDu(lead.id, lead.data);
      const dd = lead.data.demarrageDiffere || null;
      res.status(200).json({
        ok: true, leadId: lead.id, nom: D.nomDe(lead.data), estClient: lead.data.isClient === true,
        demarrage: dd, conditions: c.conditions, droits: droits(auth, lead.data), today: Core.aujourdhui(),
      });
      return;
    }

    const body = parseBody(req) || {};
    const action = String(body.action || '');
    const lead = await D.trouverLead(cible(body));
    if (!lead) { res.status(404).json({ ok: false, error: 'lead_not_found' }); return; }
    const dr = droits(auth, lead.data);
    const par = auth.email || auth.uid;
    let r;
    if (action === 'poser') {
      if (!dr.poser) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      r = await D.poser(lead, String(body.date || '').trim(), par);
    } else if (action === 'retirer') {
      if (!dr.poser) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      r = await D.retirer(lead, par);
    } else if (action === 'demarrer') {
      if (!dr.demarrer) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      r = await D.demarrer(lead, { par: par, force: body.force === true && dr.forcer });
    } else {
      res.status(400).json({ ok: false, error: 'action_inconnue' });
      return;
    }
    console.log('[client-demarrage]', action, lead.id, r.ok ? 'ok' : r.error, 'par=' + par);
    res.status(r.ok ? 200 : (r.status || 400)).json(r);
  } catch (e) {
    console.error('[client-demarrage]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
