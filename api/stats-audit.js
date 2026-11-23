// ============================================================================
// api/stats-audit.js — CONTRÔLE DES STATS SUR LES DONNÉES RÉELLES (23/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE. Existe uniquement sur la branche de travail
// `claude/stats-team-clickable-data-sy7j3b` (preview Vercel, protégée par
// Vercel Authentication), jamais sur `main`. À retirer dès l'écart expliqué.
//
// Pourquoi : Vincent voit encore un « signé » différent entre le Stats funnel
// (40 000 €) et Qualité leads (36 000 €). Ce fichier rejoue côté serveur les
// DEUX calculs (FunnelCore et LqsCore, même code que la page) et rend, fiche
// par fiche, ce que chacun compte.
//
// N'ÉCRIT RIEN : uniquement des lectures.
// Aucune donnée de prospect en sortie : ni nom, ni e-mail, ni téléphone —
// des identifiants internes, des dates, des statuts et des montants.
//
// Accès : variable Vercel STATS_AUDIT_KEY (preview de cette branche seulement),
// en-tête `x-audit-key` ou paramètre `k`. Absente ou fausse → 404.
//   ?month=2026-11
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const Core = require('../funnel-core.js');
const Lqs = require('../lqs-core.js');

function keyOk(req) {
  const want = String(process.env.STATS_AUDIT_KEY || '');
  const q = req.query || {};
  const got = String((req.headers && req.headers['x-audit-key']) || q.k || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function day(v) { const t = Core.parseFlexMs(v); return t == null ? null : Core.isoDate(new Date(t)); }

function periodOf(q) {
  if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) {
    const p = String(q.month).split('-');
    return Core.periodMonth(+p[0], +p[1] - 1);
  }
  const now = new Date();
  return Core.periodMonth(now.getFullYear(), now.getMonth());
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  try {
    const P = periodOf(req.query || {});
    /* — Funnel — */
    const loaded = await Core.loadAll(db, { P: P });
    const k = Core.computeKpis({ DATA: loaded.DATA, P: P, tunnelFilter: 'all', teamMembers: loaded.teamMembers });
    const fun = (k.closeRows || []).map(function (r) {
      return { leadId: r.leadId || null, src: r.src, sb: !!r.sb, cancelled: !!(r.rv && r.rv.cancelled),
        con: r2(r.rv && r.rv.con), paid: r2(r.rv && r.rv.paid), pending: r2(r.rv && r.rv.pending) };
    });
    /* — Qualité leads : mêmes appels que lqs-tab.js (plage closers par défaut = 3 mois) — */
    const typeMap = await Core.loadTypeMap(db);
    const now = new Date();
    const CR = { start: new Date(now.getFullYear(), now.getMonth() - 2, 1, 0, 0, 0, 0), end: new Date(now.getFullYear(), now.getMonth() + 1, 0, 23, 59, 59, 999) };
    const D = await Lqs.loadAll(db, { P: P, typeMap: typeMap, closerRange: CR });
    const M = Lqs.buildModel(D, { P: P, grid: Lqs.normalizeGrid(D.gridRaw), gridStamp: 1, tunnelFilter: 'all', sourceFilter: 'all',
      teamMembers: loaded.teamMembers || [], closerRange: CR, tunnelsMeta: null });
    const bn = Lqs.byNote(M.rows, M.periodPays, M.periodSigned);
    function rowOut(r) {
      const l = r.lead || {};
      const pays = (D.payments || []).filter(function (p) { return p && p.leadId === r.id; });
      return { leadId: r.id, note: r.note, closed: !!r.closed, closeCancelled: !!r.closeCancelled, con: r2(r.con), cash: r2(r.cash),
        closeDay: r.closeDay || null, entryDay: r.entry == null ? null : Core.isoDate(new Date(r.entry)), reopt: !!r.reopt, extra: !!l._extra,
        clientSince: day(l.clientSince), closeOc: !!r.closeOc, offer: r.offer || null,
        declared: l.closedData ? { contracte: r2(l.closedData.contracte), collecte: r2(l.closedData.collecte) } : null,
        payments: pays.map(function (p) { return { created: day(p.createdAt), status: p.status || null, type: p.type || null, vat: p.vatType || null,
          total: r2(p.totalAmount), paidAmount: r2(p.paidAmount) }; }) };
    }
    const cohortClosed = M.rows.filter(function (r) { return r.closed || r.closeCancelled; }).map(rowOut);
    const signed = (M.periodSigned || []).map(function (ps) {
      const o = rowOut(ps.leadRow); o.psCon = r2(ps.con); o.psDay = ps.day; return o;
    });
    res.status(200).json({ ok: true, at: new Date().toISOString(), period: Core.isoDate(P.start) + ' → ' + Core.isoDate(P.end),
      funnel: { closes: k.closesWonTotal, contracte: k.wonContracte, collecte: k.wonCollecte, mandat: k.collecteMandat, rows: fun },
      lqs: { cohortLeads: M.rows.length, total: { closes: bn.total.closes, con: bn.total.con, cash: bn.total.cash, signers: bn.total.signers,
          periodCon: bn.total.periodCon, periodCash: bn.total.periodCash, payers: bn.total.payers },
        cohortClosed: cohortClosed, periodSigned: signed, leadsTruncated: !!M.leadsTruncated } });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300), stack: String(e && e.stack || '').split('\n').slice(0, 6) });
  }
};

module.exports.config = { maxDuration: 60 };
