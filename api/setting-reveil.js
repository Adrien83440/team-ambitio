// ============================================================================
// api/setting-reveil.js — RÉVEIL DU SETTING ÉCRIT SUR MESSAGE REÇU (27/11/2026)
// ----------------------------------------------------------------------------
// Règles et garde-fous : api/_settingReveil.js.
//
//   GET  (cron Vercel, Bearer CRON_SECRET, toutes les 5 minutes)
//        → prend un message privé resté « en attente » (arrivé pendant
//          l'intervalle entre deux réveils), s'il y en a un. Ne fait RIEN
//          sinon : aucun réveil ne part sans message reçu.
//   GET  (admin)                    → { reglages, etat, jetonPresent }
//   POST (admin) { actif: true|false } → allume / éteint
//
// Le bouton est sur admin-setting-social.html (Marketing → Setting Insta / FB).
// ============================================================================
'use strict';

const crypto = require('crypto');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const Reveil = require('./_settingReveil');

function egal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cron(req) {
  const s = process.env.CRON_SECRET || '';
  const a = String((req.headers && req.headers.authorization) || '');
  return !!s && a.indexOf('Bearer ') === 0 && egal(a.slice(7).trim(), s);
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET' && cron(req)) {
      const r = await Reveil.rattraper();        // écrit AVANT de répondre
      res.status(200).json(Object.assign({ ok: true }, r));
      return;
    }

    const auth = await requireAdmin(req, res);
    if (!auth) return;

    if (req.method === 'GET') {
      res.status(200).json(Object.assign({ ok: true }, await Reveil.lireEtat()));
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'GET ou POST' }); return; }
    const body = parseBody(req) || {};
    if (typeof body.actif !== 'boolean') { res.status(400).json({ ok: false, error: 'actif (true ou false) attendu' }); return; }
    const r = await Reveil.regler(body.actif, auth.email || auth.uid);
    res.status(200).json(Object.assign({ ok: true }, r));
  } catch (e) {
    console.error('[setting-reveil]', e);
    res.status(500).json({ ok: false, error: 'server_error', detail: String((e && e.message) || e).slice(0, 300) });
  }
};
