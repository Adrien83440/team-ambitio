// ============================================================================
// api/lqs-audit.js — CONTRÔLE « Qualité leads ↔ Global closing » (27/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE, À RETIRER. N'existe que sur la branche de travail (preview
// Vercel), jamais sur `main`. LECTURE SEULE : aucune écriture.
//
// Accès : variable Vercel HOTE_AUDIT_KEY (24 caractères au moins, preview de
// la branche seulement), en-tête `x-audit-key` ou paramètre `k`. Absente ou
// fausse → 404 sans corps, sans aucune lecture. GET seulement.
//
// AUCUNE DONNÉE DE CLIENT OU DE PROSPECT EN SORTIE : des nombres par closer
// (prénom du membre de l'équipe, « Anciens membres », « Non attribué »).
//
// ?mois=AAAA-MM → pour ce mois, le modèle de Qualité leads (lqs-core.js, le
// vrai) et ses DEUX lectures par closer :
//   · cohorte : leads ENTRÉS pendant le mois (leads, avec RDV, présents) —
//     les cartes de la Vue d'ensemble filtrée sur un closer ;
//   · RDV du mois : RDV DATÉS dans le mois (rdv, présents, pitchés) — la vue
//     Closers, même règle que Global closing.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const FC = require('../funnel-core.js');
const LC = require('../lqs-core.js');

function keyOk(req) {
  const want = String(process.env.HOTE_AUDIT_KEY || '');
  const q = req.query || {};
  const h = req.headers && req.headers['x-audit-key'];
  const got = typeof h === 'string' ? h : (typeof q.k === 'string' ? q.k : '');
  try {
    const a = Buffer.from(got, 'utf8'), b = Buffer.from(want, 'utf8');
    if (b.length < 24 || a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch (e) {
    return false;
  }
}
function msgSur(e) {
  const code = e && (e.code != null) ? String(e.code).slice(0, 40) : '';
  const nom = e && e.name ? String(e.name).slice(0, 40) : 'Erreur';
  return code ? nom + ' (code ' + code + ')' : nom + ' : (détail masqué)';
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  if (typeof q.mois !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(q.mois)) {
    res.status(400).json({ ok: false, erreur: 'mois=AAAA-MM' });
    return;
  }
  try {
    const p = q.mois.split('-');
    const P = FC.periodMonth(+p[0], +p[1] - 1);
    const typeMap = await FC.loadTypeMap(db);
    const team = await FC.loadTeamMembers(db);
    const D = await LC.loadAll(db, { P: P, typeMap: typeMap, closerRange: { start: P.start, end: P.end } });
    const M = LC.buildModel(D, {
      P: P, grid: LC.normalizeGrid(D.gridRaw), gridStamp: 1, tunnelFilter: '', sourceFilter: '',
      teamMembers: team, typeMap: typeMap, closerRange: { start: P.start, end: P.end }, tunnelsMeta: D.tunnelsMeta || null
    });
    function libelle(slug) {
      if (!slug) return 'Non attribué';
      if (M.isDeparted && M.isDeparted(slug)) return 'Anciens membres';
      const n = M.memberName ? M.memberName(slug) : slug;
      return String(n || slug).split(/\s+/)[0].slice(0, 40);
    }
    /* Lecture COHORTE : les lignes de leads entrés, rangées par closer du lead
       (row.closer — le filtre « closer » de la Vue d'ensemble). */
    const parCloser = {};
    (M.rows || []).forEach(function (r) {
      const k = r.closer || '';
      (parCloser[k] = parCloser[k] || []).push(r);
    });
    const cohorte = {};
    Object.keys(parCloser).forEach(function (k) {
      const t = LC.byNote(parCloser[k], [], []).total;
      const lib = libelle(k || null);
      const c = cohorte[lib] = cohorte[lib] || { leads: 0, leadsAvecRdv: 0, leadsPresents: 0, leadsPitches: 0 };
      c.leads += t.leads || 0; c.leadsAvecRdv += t.leadsAvecRdv || 0; c.leadsPresents += t.leadsPresents || 0; c.leadsPitches += t.leadsPitches || 0;
    });
    const tc = LC.byNote(M.rows || [], [], []).total;
    /* Lecture RDV DU MOIS : la vue Closers (StatsCore, comme Global closing). */
    const board = LC.closerBoard(M.rdvRows || [], M.memberName);
    const rdvMois = {};
    board.forEach(function (a) {
      const lib = a.nonAttribue ? 'Non attribué' : libelle(a.slug);
      rdvMois[lib] = {
        rdv: a.rdv, annules: a.annules, noshow: a.noshow, presents: a.presents, pitches: a.pitches, aStatuer: a.aStatuer, aVenir: a.aVenir, closes: a.closes,
        detail: (a.precisions || []).map(function (x) { return { precision: String(x.precision).slice(0, 60), rdv: x.rdv, closes: x.closes }; })
      };
    });
    const tr = LC.byCloser(M.rdvRows || [], '').total;
    res.status(200).json({
      ok: true, mode: 'lecture', mois: q.mois, periode: { du: SC.jourParis(P.start), au: SC.jourParis(P.end) },
      regleHote: typeof SC.resoudreHote === 'function' ? 'StatsCore.resoudreHote' : 'ancienne',
      cohorte: { total: { leads: tc.leads, leadsAvecRdv: tc.leadsAvecRdv, leadsPresents: tc.leadsPresents, leadsPitches: tc.leadsPitches || 0 }, parCloser: cohorte },
      rdvDuMois: { total: { rdv: tr.rdv, presents: tr.presents, pitches: tr.pitches, closes: tr.closes }, parCloser: rdvMois },
      erreursLecture: (M.erreursLecture || []).map(function (s) { return String(s).slice(0, 160); })
    });
  } catch (e) {
    res.status(500).json({ ok: false, erreur: msgSur(e) });
  }
};
module.exports.config = { maxDuration: 60 };
