// ============================================================================
// api/lqs-audit.js — AUDIT DU BARÈME LQS, LECTURE SEULE (13/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien (autorisée le 13/11/2026) : revoir le barème de notation
// des leads à partir de ce que les réponses ont RÉELLEMENT donné (présents,
// closés, signé) et de ce que les prospects ont dit en visio de closing.
// Sort, pour une plage de dates, une ligne ANONYME par lead : ses réponses
// (options du quiz et des formulaires), sa note, son parcours (RDV, présent,
// closé, offre, signé, encaissé) et l'analyse IA de ses appels de closing
// (score, douleurs, motivations, freins, objections levées ou non).
//
// Le calcul est celui de l'onglet « Qualité leads » : lqs-core.js exécuté tel
// quel côté serveur (même cohorte, mêmes règles de close et de montant).
//
// N'ÉCRIT RIEN. Aucune donnée personnelle en sortie : pas de nom, d'e-mail,
// de téléphone ni de transcription ; identifiant réduit à une empreinte ;
// les textes d'analyse sont expurgés du nom du prospect, des e-mails et des
// numéros ; les citations d'objections ne sortent pas.
//
// Accès : en-tête `x-audit-key` (ou paramètre `k`) égal à la variable Vercel
// LQS_AUDIT_KEY. Variable absente ou clé fausse → 404. La clé est posée dans
// Vercel pour la seule preview de la branche de travail, jamais dans le
// dépôt ; la retirer coupe l'accès.
//
//   GET /api/lqs-audit?from=2026-09-25&to=2026-11-13
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const FC = require('../funnel-core.js');
const LC = require('../lqs-core.js');

function keyOk(req) {
  const want = String(process.env.LQS_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function isoOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function ref(id) { return id ? crypto.createHash('sha256').update('lqs:' + id).digest('hex').slice(0, 10) : null; }

/* Expurge un texte : nom / prénom du prospect, e-mails, numéros. */
function scrubber(lead) {
  const tokens = [];
  [lead.nom, lead.prenom, lead.name, lead.entreprise, lead.societe, lead.company].forEach(function (v) {
    String(v || '').split(/[\s,'’-]+/).forEach(function (t) { if (t.length >= 3) tokens.push(t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); });
  });
  const re = tokens.length ? new RegExp('(^|[^\\p{L}])(' + tokens.join('|') + ')(?![\\p{L}])', 'giu') : null;
  return function (s) {
    let t = String(s == null ? '' : s).slice(0, 600);
    t = t.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[e-mail]').replace(/(?:\+?\d[\s.-]?){9,}/g, '[numéro]');
    if (re) t = t.replace(re, '$1[…]');
    return t;
  };
}
function arr(a, scrub) { return (Array.isArray(a) ? a : []).slice(0, 8).map(scrub); }

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  try {
    const q = req.query || {};
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
    const from = isoOk(q.from) ? q.from : '2026-09-25';
    const to = isoOk(q.to) ? q.to : today;
    const P = FC.periodCustom(from, to);
    const typeMap = await FC.loadTypeMap(db);
    const team = await FC.loadTeamMembers(db);
    const D = await LC.loadAll(db, { P: P, typeMap: typeMap });
    /* grid=<JSON base64url> : simule un barème candidat (rien n'est enregistré). */
    let gridRaw = D.gridRaw, simulated = false;
    if (q.grid) { gridRaw = JSON.parse(Buffer.from(String(q.grid), 'base64url').toString('utf8')); simulated = true; }
    const grid = LC.normalizeGrid(gridRaw);
    const M = LC.buildModel(D, { P: P, grid: grid, gridStamp: 1, teamMembers: team, tunnelFilter: 'all', sourceFilter: 'all' });
    const compact = q.compact === '1';

    const rows = M.rows.map(function (r) {
      const scrub = scrubber(r.lead || {});
      return {
        ref: ref(r.id),
        day: r.entry != null ? new Date(r.entry).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) : null,
        note: r.note, pts: r.pts, team: r.team,
        answers: (r.answers || []).map(function (a) { return compact ? [a.q, a.a] : { q: a.q, ql: a.ql, a: a.a, al: String(a.al || '').slice(0, 160), o: a.o }; }),
        booked: !!r.booked, present: !!r.present, noshow: !!r.noshow, upcoming: !!r.upcoming,
        closed: !!r.closed, closeCancelled: !!r.closeCancelled, offer: r.offer || null, con: Math.round(r.con || 0), cash: Math.round(r.cash || 0),
        page: (r.lead && r.lead.landingLast && r.lead.landingLast.page) || (r.lead && r.lead.landingFirst && r.lead.landingFirst.page) || null,
        calls: (r.calls || []).filter(function (c) { return c.present || c.replay === 'ready'; }).map(function (c) {
          const a = c.analysis || null, p = (a && a.prospect) || {};
          return {
            date: c.date, outcome: c.outcome || null, replay: c.replay || null, durationMin: c.durationSec ? Math.round(c.durationSec / 60) : null,
            analysis: a ? {
              score: a.score == null ? null : a.score, verdict: scrub(a.verdict),
              douleurs: arr(p.douleurs, scrub), motivations: arr(p.motivations, scrub), freins: arr(p.freins, scrub),
              objections: (Array.isArray(a.objections) ? a.objections : []).slice(0, 12).map(function (o) { return { category: o.category || null, label: scrub(o.label), worked: o.worked === true }; }),
              conseilRelance: a.conseilRelance ? scrub(a.conseilRelance) : null
            } : null
          };
        })
      };
    });
    /* part=pts : total de points de chaque lead (calibrage des seuils) —
       [points, rdv, présent, closé], et les points en vigueur par réponse. */
    if (q.part === 'pts') {
      const qs = {};
      Object.keys(grid.questions || {}).forEach(function (k) {
        const g = grid.questions[k], a = {};
        Object.keys(g.answers || {}).forEach(function (ak) { const x = g.answers[ak]; if (x.pts || x.ko) a[String(x.label).slice(0, 60)] = x.ko ? 'KO' : x.pts; });
        if (g.off || Object.keys(a).length) qs[String(g.label).slice(0, 80)] = g.off ? 'ignorée' : a;
      });
      res.status(200).json({
        ok: true, from: from, to: to, leads: rows.length, gridSaved: !!D.gridRaw, updatedBy: (D.gridRaw && D.gridRaw.updatedBy) ? 'oui' : null,
        thresholds: grid.thresholds, points: qs,
        rows: M.rows.map(function (r) { return [r.pts, r.booked ? 1 : 0, r.present ? 1 : 0, r.closed ? 1 : 0, r.ko ? 1 : 0]; })
      });
      return;
    }
    /* part=summary : synthèse calculée ici (une ligne par réponse, puis
       les seuls leads présents avec l'analyse de leur visio). */
    if (q.part === 'summary') {
      const ba = LC.byAnswer(M.rows, grid);
      const A = function (a) { return [a.leads, a.booked, a.present, a.closes, Math.round(a.con || 0)]; };
      const noteAgg = {};
      M.rows.forEach(function (r) {
        const k = r.note == null ? 0 : r.note;
        const x = noteAgg[k] || (noteAgg[k] = { leads: 0, booked: 0, present: 0, closes: 0, con: 0 });
        x.leads++; if (r.booked) x.booked++; if (r.present) x.present++; if (r.closed) { x.closes++; x.con += Math.round(r.con || 0); }
      });
      res.status(200).json({
        ok: true, from: from, to: to, leads: rows.length, truncated: !!M.leadsTruncated,
        cols: 'leads, rdv, presents, closes, signe',
        total: A(ba.total), byNote: noteAgg,
        thresholds: grid.thresholds, gridSaved: !!D.gridRaw, simulated: simulated,
        questions: q.lite === '1' ? undefined : ba.questions.filter(function (qq) { return qq.agg.leads >= 8; }).map(function (qq) {
          return { q: qq.q, label: String(qq.label).slice(0, 110), o: qq.origin, off: !!qq.off, t: A(qq.agg),
            a: qq.answerList.filter(function (x) { return x.agg.leads >= 3; }).slice(0, 14).map(function (x) {
              return [String(x.label).slice(0, 70), x.pts, x.known ? 1 : 0].concat(A(x.agg));
            }) };
        }),
        presents: q.lite === '1' ? rows.filter(function (r) { return r.present; }).map(function (r) { return [r.note, r.pts, r.closed ? 1 : 0, r.con]; }) : rows.filter(function (r) { return r.present; }).map(function (r) {
          const c = r.calls.filter(function (x) { return x.analysis; }).pop();
          return { n: r.note, p: r.pts, cl: r.closed ? 1 : 0, of: r.offer, con: r.con,
            oc: r.calls.map(function (x) { return x.outcome; }).join(','),
            an: c ? { sc: c.analysis.score, fr: c.analysis.freins.slice(0, 3).map(function (t) { return t.slice(0, 110); }),
              ob: c.analysis.objections.map(function (o) { return o.category + (o.worked ? '+' : '-'); }).join(' ') } : null };
        })
      });
      return;
    }
    /* part=calls : seulement les leads présents (analyse des visios) ;
       part=answers : tous les leads, sans les appels (réponses ↔ résultats). */
    let out = rows;
    if (q.part === 'calls') out = rows.filter(function (r) { return r.calls.length; });
    if (q.part === 'answers') out = rows.map(function (r) { const c = Object.assign({}, r); c.calls = r.calls.length; return c; });
    res.status(200).json({
      ok: true, from: from, to: to, generatedAt: new Date().toISOString(),
      leads: rows.length, truncated: !!M.leadsTruncated,
      grid: { thresholds: grid.thresholds, saved: !!D.gridRaw, questions: q.part === 'calls' ? undefined : grid.questions },
      rows: out
    });
  } catch (e) {
    console.error('[lqs-audit]', e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'internal', message: String(e && e.message ? e.message : e).slice(0, 200) });
  }
};
