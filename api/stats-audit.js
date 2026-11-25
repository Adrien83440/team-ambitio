// ============================================================================
// api/stats-audit.js — CONTRÔLE DES CHIFFRES SUR LES DONNÉES RÉELLES (25/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE. N'existe que sur la branche de travail
// `claude/stats-team-clickable-data-sy7j3b` (preview Vercel, protégée par
// Vercel Authentication), jamais sur `main`. À retirer avant la mise en
// production.
//
// Pourquoi : l'audit de cohérence du 25/11/2026 change des règles (un close est
// daté du jour où le client est gagné, Kept = RDV − annulés, « RDV » hors
// replanifiés…). Avant la mise en production, cette route rejoue côté serveur
// les NOUVEAUX calculs sur un mois réel (mêmes modules que les pages :
// stats-core.js, funnel-core.js, api/_aiTools.js) et donne, à côté, les
// chiffres des ANCIENNES règles — pour montrer ce qui bouge.
//
// N'ÉCRIT RIEN : uniquement des lectures.
// Aucune donnée personnelle en sortie : ni nom, ni e-mail, ni téléphone, ni
// prénom de membre — des comptes, des montants, des identifiants de fiches.
//
// Accès : variable Vercel STATS_AUDIT_KEY (preview de cette branche seulement),
// en-tête `x-audit-key` ou paramètre `k`. Absente ou fausse → 404.
//   ?month=2026-11            un mois (défaut : mois en cours, heure de Paris)
//   ?job=corrections          compte les corrections manuelles ✎ existantes
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const Core = require('../funnel-core.js');

function keyOk(req) {
  const want = String(process.env.STATS_AUDIT_KEY || '');
  const q = req.query || {};
  const got = String((req.headers && req.headers['x-audit-key']) || q.k || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function r2(n) { return Math.round((Number(n) || 0) * 100) / 100; }
function pick(a) {
  if (!a) return null;
  return {
    rdv: a.rdv, replanifies: a.replan, doublons: a.doublons, annules: a.annules, noshow: a.noshow, presents: a.presents,
    disqua: a.disqua, pitches: a.pitches, offresEnAttente: a.offres, nonCloses: a.nonCloses, rdvCloses: a.rdvCloses,
    sansDetail: a.sansDetail, aStatuer: a.aStatuer, aVenir: a.aVenir, kept: a.kept,
    showUp: a.showUp == null ? null : r2(a.showUp),
    identite: a.rdv === a.annules + a.noshow + a.presents + a.aStatuer + a.aVenir
  };
}
function sums(t) {
  if (!t) return null;
  return { closes: t.closes, contracte: r2(t.con), collecte: r2(t.paid), reste: r2(t.reste), premiersPrelevements: r2(t.pending), sansPaiement: t.sansPaiement };
}

function periodOf(q) {
  if (/^\d{4}-\d{2}$/.test(String(q.month || ''))) {
    const p = String(q.month).split('-');
    return Core.periodMonth(+p[0], +p[1] - 1);
  }
  const o = SC.parisParts(new Date());
  return Core.periodMonth(+o.year, +o.month - 1);
}

/* Corrections manuelles ✎ existantes (rapport_overrides/{slug}/jours/{jour}) :
   combien de jours corrigés, sur quelles colonnes. Aucun nom en sortie. */
async function corrections() {
  const parents = await db.collection('rapport_overrides').listDocuments();
  const out = { personnes: 0, jours: 0, parVue: {}, parColonne: {}, parMois: {}, equipe: 0 };
  for (const ref of parents) {
    const snap = await ref.collection('jours').get();
    if (!snap.size) continue;
    if (ref.id === '_all') out.equipe += snap.size; else out.personnes++;
    snap.forEach(function (doc) {
      out.jours++;
      const d = doc.data() || {};
      const mois = String(doc.id).slice(0, 7);
      out.parMois[mois] = (out.parMois[mois] || 0) + 1;
      ['setting', 'closing'].forEach(function (vue) {
        const v = d[vue];
        if (!v || typeof v !== 'object') return;
        const keys = Object.keys(v).filter(function (k) { return v[k] != null && v[k] !== ''; });
        if (!keys.length) return;
        out.parVue[vue] = (out.parVue[vue] || 0) + 1;
        keys.forEach(function (k) { out.parColonne[vue + '.' + k] = (out.parColonne[vue + '.' + k] || 0) + 1; });
      });
    });
  }
  return out;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' || !keyOk(req)) { res.status(404).end(); return; }
  const q = req.query || {};
  try {
    if (q.job === 'corrections') { res.status(200).json({ ok: true, corrections: await corrections() }); return; }

    const P = periodOf(q);
    const sIso = SC.jourParis(P.start), eIso = SC.jourParis(P.end);
    const loaded = await Core.loadAll(db, { P: P });
    const DATA = loaded.DATA;
    const k = Core.computeKpis({ DATA: DATA, P: P, tunnelFilter: 'all', teamMembers: loaded.teamMembers });

    /* ── NOUVELLES règles (ce que tous les écrans affichent désormais) ── */
    const rows = (k.closeRows || []).filter(function (r) { return !(r.rv && r.rv.cancelled); });
    const nouveau = {
      rdv: { tout: pick(k.tenue), selfBooking: pick(k.tenueSB), setting: pick(k.tenueNB), manuels: pick(k.tenueMan) },
      rdvPris: { tout: k.chAll ? k.chAll.n : null, selfBooking: k.chSB ? k.chSB.n : null, setsNB: k.chNB ? k.chNB.n : null },
      closes: sums(k.closes), closesSB: sums(k.closesSB), closesNB: sums(k.closesNB),
      origine: {
        fiche: rows.filter(function (r) { return r.src === 'fiche'; }).length,
        rdvSansFiche: rows.filter(function (r) { return r.src === 'rdv'; }).length,
        paiementSeul: rows.filter(function (r) { return r.src === 'paiement'; }).length
      },
      closesSansRdvClose: rows.filter(function (r) { return !r.bookingId; }).length,
      canal: {
        parRdv: rows.filter(function (r) { return r.canalSrc === 'rdv'; }).length,
        parReponseCloser: rows.filter(function (r) { return r.canalSrc === 'declare'; }).length,
        parEtape: rows.filter(function (r) { return r.canalSrc === 'etape'; }).length,
        inconnu: rows.filter(function (r) { return r.canalSrc === 'inconnu'; }).length,
        ecartsRdvContreReponse: rows.filter(function (r) { return r.canalEcart; }).length
      },
      closerNonAttribue: rows.filter(function (r) { return !r.closer; }).length,
      closesAnnules: (k.closeRows || []).filter(function (r) { return r.rv && r.rv.cancelled; }).length,
      fichesClientesSansVente: ((k.coh && k.coh.sansSignal) || []).map(function (x) { return { leadId: x.leadId || null, jour: x.date || null }; }),
      rdvClosesHorsListe: ((k.coh && k.coh.rdvClosesHorsListe) || []).length,
      clientsDeuxRdvCloses: ((k.coh && k.coh.doublonsRdv) || []).length,
      jourDesCloses: rows.map(function (r) { return { leadId: r.leadId || null, jour: r.day, rdv: r.rdvDate || null, src: r.src, canal: r.canal, con: r2(r.rv.con), paid: r2(r.rv.paid) }; }),
      erreursLecture: k.erreursLecture || [],
      fichesGagneesTronquees: !!k.closedLeadsTruncated
    };

    /* ── ANCIENNES règles, rejouées pour comparaison ── */
    const due = (DATA.bookings || []).filter(function (b) { return b._inDue && (b._class === 'self' || b._class === 'setter'); });
    function oldResched(b) { return b.outcome === 'replanifie' || (b.status === 'cancelled' && b.rescheduled === true); }
    function oldCanc(b) { return !oldResched(b) && (b.outcome === 'annule' || b.status === 'cancelled'); }
    const oldCloseRdv = due.filter(function (b) { return b.outcome === 'close'; });
    const ancien = {
      pagesEquipe: {
        note: 'un close = un RDV au résultat close, à la date du RDV',
        closes: oldCloseRdv.length,
        closesSB: oldCloseRdv.filter(function (b) { return b._class === 'self'; }).length,
        closesNB: oldCloseRdv.filter(function (b) { return b._class === 'setter'; }).length,
        rdvCloseSB: due.filter(function (b) { return b._class === 'self'; }).length,
        rdvNB: due.filter(function (b) { return b._class === 'setter' && !oldResched(b); }).length
      },
      funnel: {
        note: 'un close = une fiche dont clientSince est dans la période (sans exiger de signal de vente) + RDV closés sans fiche + paiements',
        fichesClientSince: (DATA.closedLeads || []).length,
        rdvDuMois: due.filter(function (b) { return !oldResched(b); }).length,
        annules: due.filter(oldCanc).length,
        noShowStatutSeul: due.filter(function (b) { return b.status === 'no_show'; }).length,
        keptLigne2: due.filter(function (b) { return !oldResched(b) && !oldCanc(b) && b.status !== 'no_show'; }).length
      }
    };

    /* ── Outil de l'assistant (bookings_stats) sur la même période : doit
          rendre les mêmes closes et montants que le funnel. ── */
    let assistant = null;
    try {
      const Tools = require('./_aiTools.js');
      const out = await Tools.runTool('bookings_stats', { from: sIso, to: eIso });
      const o = typeof out === 'string' ? JSON.parse(out) : out;
      assistant = { closes: o && o.closes ? { closes: o.closes.closes, contracte: o.closes.contracte, collecte: o.closes.collecte } : null, rdv: o && o.rdv != null ? o.rdv : (o && o.totaux) || null, cles: o ? Object.keys(o) : [] };
    } catch (e) { assistant = { erreur: String((e && e.message) || e).slice(0, 200) }; }

    res.status(200).json({ ok: true, periode: { du: sIso, au: eIso }, nouveau: nouveau, ancien: ancien, assistant: assistant });
  } catch (e) {
    res.status(500).json({ ok: false, erreur: String((e && e.message) || e).slice(0, 300), pile: String((e && e.stack) || '').split('\n').slice(0, 5) });
  }
};
