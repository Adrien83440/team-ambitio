// ============================================================================
// api/stats-audit.js — CONTRÔLE DES STATS SUR LES DONNÉES RÉELLES (22/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE. Existe uniquement sur la branche de travail
// `claude/stats-team-clickable-data-sy7j3b` (preview Vercel), jamais sur
// `main`. À retirer, avec sa clé, dès les écarts expliqués.
//
// Pourquoi : Vincent voit 6 closes / 40 000 € au Stats funnel et 5 / 34 000 €
// dans Qualité leads, et des « Sets » différents des « RDV NB » dans Set NB.
// Ce fichier rejoue le calcul du funnel côté serveur (FunnelCore, même code
// que la page) et rend de quoi expliquer chaque écart.
//
// N'ÉCRIT RIEN : uniquement des lectures.
// Aucune donnée de prospect en sortie : ni nom, ni e-mail, ni téléphone, ni
// texte libre — des identifiants internes (fiche, RDV), des dates, des
// statuts, des montants et les identifiants d'équipe (setter / closer).
//
// Accès : variable Vercel STATS_AUDIT_KEY (preview de cette branche
// seulement), passée par l'en-tête `x-audit-key` ou le paramètre `k`.
// Variable absente ou clé fausse → 404.
//   ?part=closes&month=2026-11   closes du funnel, un par ligne
//   ?part=setnb&month=2026-11    RDV du setting posés ou tenus dans le mois
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const Core = require('../funnel-core.js');

function keyOk(req) {
  const want = String(process.env.STATS_AUDIT_KEY || '');
  const q = req.query || {};
  const got = String((req.headers && req.headers['x-audit-key']) || q.k || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function day(v) {
  const t = Core.parseFlexMs(v);
  return t == null ? null : Core.isoDate(new Date(t));
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

function periodOf(q) {
  if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) {
    const p = String(q.month).split('-');
    return Core.periodMonth(+p[0], +p[1] - 1);
  }
  const now = new Date();
  return Core.periodMonth(now.getFullYear(), now.getMonth());
}

async function leadsById(ids) {
  const out = {};
  const list = ids.filter(Boolean).slice(0, 400);
  for (let i = 0; i < list.length; i += 40) {
    const snaps = await Promise.all(list.slice(i, i + 40).map(function (id) {
      return db.collection('leads').doc(id).get().catch(function () { return null; });
    }));
    snaps.forEach(function (s) { if (s && s.exists) out[s.id] = s.data() || {}; });
  }
  return out;
}

/* Closes du Stats funnel, un par ligne, avec ce qui décide de leur présence
   dans Qualité leads : mois d'entrée du lead, date client, RDV « close »,
   paiements (création, statut, montants). */
async function partCloses(P) {
  const loaded = await Core.loadAll(db, { P: P });
  const D = loaded.DATA;
  const k = Core.computeKpis({ DATA: D, P: P, tunnelFilter: 'all', teamMembers: loaded.teamMembers });
  const pS = Core.isoDate(P.start), pE = Core.isoDate(P.end);
  const rows = k.closeRows || [];
  const leads = await leadsById(rows.map(function (r) { return r.leadId; }));
  const payIdx = Core.revIndex(D.payments || []);
  const out = rows.map(function (r) {
    const l = r.leadId ? (leads[r.leadId] || null) : null;
    const bks = (D.bookings || []).filter(function (b) { return r.leadId && b.leadId === r.leadId; });
    const pays = l ? Core.revPaymentsFor(payIdx, r.leadId, String(l.email || '').toLowerCase().trim(), l.telephone || l.phone) : [];
    const entry = l ? Core.realEntryMs(l) : null;
    return {
      leadId: r.leadId || null, src: r.src, sb: !!r.sb,
      cancelled: !!(r.rv && r.rv.cancelled), reason: (r.rv && r.rv.reason) || null,
      con: r2(r.rv && r.rv.con), paid: r2(r.rv && r.rv.paid), pending: r2(r.rv && r.rv.pending), hasPay: !!(r.rv && r.rv.hasPay),
      leadFound: !!l, merged: !!(l && l._merged),
      entryDay: entry == null ? null : Core.isoDate(new Date(entry)),
      entryInPeriod: entry != null && entry >= P.start.getTime() && entry <= P.end.getTime(),
      clientSince: l ? day(l.clientSince) : null,
      stage: l ? (l.stage || null) : null,
      setterSlug: l ? (l.setterSlug || l.assignedTo || null) : null,
      bookingsLoaded: bks.map(function (b) {
        return { id: b._id || b.id || null, date: b.date || null, cls: b._class || null, outcome: b.outcome || null, status: b.status || null,
          inPeriod: !!(b.date && b.date >= pS && b.date <= pE), closer: (b.closeData && b.closeData.closerSlug) || b.expertSlug || null };
      }),
      payments: pays.map(function (p) {
        return { created: day(p.createdAt), status: p.status || null, type: p.type || null, total: r2(p.totalAmount), paidAmount: r2(p.paidAmount),
          nHistory: Array.isArray(p.paymentsHistory) ? p.paymentsHistory.length : 0, leadIdMatch: p.leadId === r.leadId };
      })
    };
  });
  return {
    period: pS + ' → ' + pE,
    funnel: { closes: k.closesWonTotal, sb: k.wonSelf, nb: k.wonSetting, contracte: k.wonContracte, collecte: k.wonCollecte, mandat: k.collecteMandat,
      rdvMois: k.rdvMois, dueSB: k.dueSB, dueNB: k.dueNB, reschedSB: k.reschedSB, reschedNB: k.reschedNB,
      live: k.ocDue && k.ocDue.present, pitched: k.ocDue && k.ocDue.pitched },
    coh: k.coh ? { pagesCloses: k.coh.pagesCloses, pagesSB: k.coh.pagesSB, pagesNB: k.coh.pagesNB,
      onlyFunnel: k.coh.onlyFunnel.length, onlyPages: k.coh.onlyPages.length, split: k.coh.split.length, dup: k.coh.dup.length } : null,
    rows: out
  };
}

/* RDV du setting posés OU tenus dans le mois : de quoi recompter, setter par
   setter, les « Sets » et les « RDV NB » de Set NB et vérifier le pont. */
async function partSetNb(P) {
  const loaded = await Core.loadAll(db, { P: P });
  const D = loaded.DATA;
  const pS = Core.isoDate(P.start), pE = Core.isoDate(P.end);
  const list = (D.bookings || []).filter(function (b) { return b._class === 'setter'; });
  const leads = await leadsById(Object.keys(list.reduce(function (m, b) { if (b.leadId) m[b.leadId] = 1; return m; }, {})));
  const rows = list.map(function (b) {
    const l = b.leadId ? (leads[b.leadId] || null) : null;
    const cDay = day(b.createdAt);
    return {
      id: b._id || b.id || null, leadId: b.leadId || null,
      date: b.date || null, dueInPeriod: !!(b.date && b.date >= pS && b.date <= pE),
      createdDay: cDay, createdInPeriod: !!(cDay && cDay >= pS && cDay <= pE),
      status: b.status || null, outcome: b.outcome || null, rescheduled: b.rescheduled === true,
      rescheduledFromId: b.rescheduledFromId || null, rescheduledToId: b.rescheduledToId || null,
      source: b.source || null, type: b.type || null,
      bookedBySlug: b.bookedBySlug || null,
      closeSetter: (b.closeData && b.closeData.setterSlug) || null,
      closer: (b.closeData && b.closeData.closerSlug) || b.expertSlug || b.personId || null,
      leadSetterSlug: l ? (l.setterSlug || null) : null, leadAssignedTo: l ? (l.assignedTo || null) : null
    };
  });
  return { period: pS + ' → ' + pE, n: rows.length, rows: rows };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  try {
    const P = periodOf(q);
    const part = String(q.part || 'closes');
    const body = part === 'setnb' ? await partSetNb(P) : await partCloses(P);
    res.status(200).json({ ok: true, part: part, at: new Date().toISOString(), data: body });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
};

module.exports.config = { maxDuration: 60 };
