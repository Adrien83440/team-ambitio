// ============================================================================
// api/offer-relances-auto.js — ENVOI AUTOMATIQUE DES RELANCES D'OFFRES (27/11/2026)
// ----------------------------------------------------------------------------
// Moteur et règles : api/_offerRelancesAuto.js. Cette route :
//
//   GET  (cron Vercel, Bearer CRON_SECRET)   → un passage
//   GET  ?dry=1                              → simulation : des comptes seulement,
//                                              aucune rédaction, aucune écriture
//   GET  ?action=reglage&json={…}            → clé du chantier seulement
//   POST { action:'etat' }                   → réglages + simulation
//   POST { action:'reglage', actif?, modeTest?, plafondJour?, confirmation? }
//
// Accès : cron (CRON_SECRET), admin connecté (POST), ou clé temporaire
// PARCOURS_AUDIT_KEY (en-tête x-audit-key ou ?k=). Aucune donnée personnelle
// en sortie : des comptes. Rien ne part tant que
// _config/offer_relances.auto.actif n'est pas vrai, et tant que modeTest n'est
// pas explicitement faux l'automate tourne à blanc.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const Auto = require('./_offerRelancesAuto');

function egal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cleChantier(req) {
  const want = String(process.env.PARCOURS_AUDIT_KEY || '');
  if (want.length < 24) return false;
  return egal((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '', want);
}
function cron(req) {
  const s = process.env.CRON_SECRET || '';
  const a = String((req.headers && req.headers.authorization) || '');
  return !!s && a.indexOf('Bearer ') === 0 && egal(a.slice(7).trim(), s);
}

async function actionner(body, par, res) {
  const action = String(body.action || '');
  if (action === 'etat') { res.status(200).json(await Auto.passage({ simulation: true })); return; }
  if (action === 'reglage') {
    const r = await Auto.regler(body, par);
    res.status(r.ok ? 200 : 400).json(r);
    return;
  }
  res.status(400).json({ ok: false, error: 'action inconnue' });
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};
    if (req.method === 'GET') {
      const estCron = cron(req), cle = cleChantier(req);
      if (!estCron && !cle) { res.status(401).json({ ok: false, error: 'Non autorisé' }); return; }
      if (q.action && cle) {
        let corps = {};
        try { corps = q.json ? JSON.parse(String(q.json)) : {}; } catch (e) { res.status(400).json({ ok: false, error: 'json illisible' }); return; }
        corps.action = String(q.action);
        await actionner(corps, 'cle_chantier', res);
        return;
      }
      res.status(200).json(await Auto.passage({ simulation: !estCron || q.dry === '1' }));
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'GET ou POST' }); return; }
    const body = (await parseBody(req)) || {};
    let par = 'cle_chantier';
    if (!cleChantier(req)) {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      par = auth.email || auth.uid;
    }
    await actionner(body, par, res);
  } catch (e) {
    console.error('[offer-relances-auto]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
