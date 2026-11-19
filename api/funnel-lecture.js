// ============================================================================
// api/funnel-lecture.js — DONNÉES AGRÉGÉES DU LECTEUR FUNNEL (19/11/2026)
// ----------------------------------------------------------------------------
// Le rôle `funnel_viewer` (compte de la média buyeuse) voit le module Stats
// funnel en lecture seule. Presque tout est lu directement dans Firestore
// (règles « LECTEUR FUNNEL » de firestore.rules). UNE exception : le coût de
// setting, calculé depuis commissions/{setter}/mois/{AAAA-MM}, qui détaille
// la paie de chaque membre. Le lecteur n'a AUCUN accès à ces documents : il
// reçoit ici les seuls montants des deals Setting de la période, sans le
// setter ni le client — exactement ce que la page additionne
// (FunnelCore.loadSettingDeals, même code que l'admin et que l'API agence).
//
//   GET ?part=setting&start=<ms>&end=<ms>   Bearer <ID token admin | lecteur>
//     → { ok, deals: [{ comm, ok }] }
//
// Lecture seule, aucune écriture.
// ============================================================================
'use strict';

const { db } = require('./_firebaseAdmin');
const { requireFunnelReader } = require('./_verifyFirebaseAuth');
const Core = require('../funnel-core.js');

const MAX_SPAN_MS = 400 * 86400000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ ok: false }); return; }
  const auth = await requireFunnelReader(req, res);
  if (!auth) return;
  const q = req.query || {};
  try {
    if (q.part !== 'setting') { res.status(400).json({ ok: false, error: 'part inconnu' }); return; }
    const start = Number(q.start), end = Number(q.end);
    if (!isFinite(start) || !isFinite(end) || end < start || end - start > MAX_SPAN_MS) {
      res.status(400).json({ ok: false, error: 'période invalide' });
      return;
    }
    const P = { start: new Date(start), end: new Date(end) };
    const TEAM = await Core.loadTeamMembers(db);
    const DATA = {};
    await Core.loadSettingDeals(db, P, DATA, TEAM);
    const deals = (DATA.settingDeals || []).map(function (d) { return { comm: Number(d.comm) || 0, ok: d.ok === true }; });
    res.status(200).json({ ok: true, deals: deals });
  } catch (e) {
    console.error('[funnel-lecture]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
};
