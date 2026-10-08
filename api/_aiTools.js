// ============================================================================
// api/_aiTools.js — OUTILS « DONNÉES ALTEORE » en LECTURE SEULE (Lot 5)
// ----------------------------------------------------------------------------
// Une seule définition d'outils, deux consommateurs :
//   • api/ai-ask.js  — « Demande à Alteore » (chat vocal des admins, Opus) ;
//   • api/mcp.js     — serveur MCP (Claude Desktop / claude.ai d'Adrien).
// AUCUN outil n'écrit en base. Chaque outil renvoie un objet JSON compact.
// Périmètre : données sales, coaching, paiements, IA. Pas de factures
// détaillées ni de données personnelles au-delà de nom / contact.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { tsToMs, cap } = require('./_ai');

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function parisMidnightMs(dateStr) {
  const p = String(dateStr).split('-').map(Number);
  const noon = Date.UTC(p[0], p[1] - 1, p[2], 12);
  const h = Number(new Date(noon).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }));
  return Date.UTC(p[0], p[1] - 1, p[2]) - (h - 12) * 3600000;
}
function range(input) {
  const today = parisDate(Date.now());
  const from = /^\d{4}-\d{2}-\d{2}$/.test(input && input.from || '') ? input.from : new Date(Date.now() - 29 * 86400000).toISOString().slice(0, 10);
  const to = /^\d{4}-\d{2}-\d{2}$/.test(input && input.to || '') ? input.to : today;
  return { from: from, to: to, fromMs: parisMidnightMs(from), toMs: parisMidnightMs(to) + 86400000 };
}
function inc(map, k, field, n) { k = k || '(inconnu)'; if (!map[k]) map[k] = {}; map[k][field] = (map[k][field] || 0) + (n == null ? 1 : n); }
function isCoaching(b) { return !!(b.isCoaching || b.clientId || b.source === 'csm_manual' || b.skipLeadCreation); }
function srcOf(l) { return (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || l.source || 'autre'; }

const RANGE_PROPS = {
  from: { type: 'string', description: 'Début AAAA-MM-JJ (défaut : il y a 30 jours)' },
  to: { type: 'string', description: 'Fin incluse AAAA-MM-JJ (défaut : aujourd\'hui)' },
};

const TOOLS = [
  {
    name: 'leads_stats',
    description: 'Nombre de leads entrés sur une période, ventilés par provenance (page / tunnel / quiz / VSL), par setter assigné, et par statut actuel. Pour « combien de leads… », « d\'où viennent les leads… ».',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const s = await db.collection('leads').where('createdAt', '>=', new Date(r.fromMs)).where('createdAt', '<', new Date(r.toMs)).get();
      const bySrc = {}, bySetter = {}, byStatus = {};
      let n = 0;
      s.forEach(function (d) {
        const l = d.data() || {};
        if (l._merged) return;
        n++;
        inc(bySrc, srcOf(l), 'leads'); inc(bySetter, l.assignedTo, 'leads'); inc(byStatus, l.status || 'nouveau', 'leads');
        if (l.aiLead && l.aiLead.niveau === 'chaud') inc(bySrc, srcOf(l), 'chauds');
      });
      return { periode: r.from + ' → ' + r.to, total: n, parProvenance: bySrc, parSetter: bySetter, parStatut: byStatus };
    },
  },
  {
    name: 'bookings_stats',
    description: 'RDV commerciaux (hors coaching) dont la date tombe dans la période : nombre, issues (close, non close, offre, no-show, annulé), CA contracté et encaissé, par closer, par setter (bookedBySlug) et par provenance du lead. Pour les taux de show / de close / le CA.',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const s = await db.collection('bookings').where('date', '>=', r.from).where('date', '<=', r.to).get();
      const tot = { rdv: 0, close: 0, non_close: 0, offre: 0, no_show: 0, annule: 0, sans_issue: 0, contracte: 0, collecte: 0 };
      const byCloser = {}, bySetter = {};
      s.forEach(function (d) {
        const b = d.data() || {};
        if (isCoaching(b) || b.rescheduled) return;
        const o = b.outcome || (b.status === 'cancelled' ? 'annule' : (b.status === 'no_show' ? 'no_show' : ''));
        tot.rdv++;
        const k = o === 'close' ? 'close' : o === 'non_close' ? 'non_close' : o === 'offre' ? 'offre' : o === 'no_show' ? 'no_show' : (o === 'annule' || o === 'replanifie') ? 'annule' : 'sans_issue';
        tot[k]++;
        inc(byCloser, b.personName, 'rdv'); inc(byCloser, b.personName, k);
        if (b.bookedBySlug) { inc(bySetter, b.bookedBySlug, 'rdv'); inc(bySetter, b.bookedBySlug, k); }
        if (o === 'close' && b.closeData) {
          const ct = Number(b.closeData.contracte) || 0, cl = Number(b.closeData.collecte) || 0;
          tot.contracte += ct; tot.collecte += cl;
          inc(byCloser, b.personName, 'contracte', ct);
        }
      });
      const tenus = tot.close + tot.non_close + tot.offre;
      return { periode: r.from + ' → ' + r.to, totaux: tot,
        tauxShow: tot.rdv ? Math.round((tenus / Math.max(1, tenus + tot.no_show)) * 100) + ' %' : null,
        tauxClose: tenus ? Math.round(tot.close / tenus * 100) + ' %' : null,
        parCloser: byCloser, parSetter: bySetter };
    },
  },
  {
    name: 'calls_stats',
    description: 'Appels téléphoniques (Ringover) sur la période, par membre de l\'équipe : nombre, décrochés, minutes, note IA moyenne quand l\'appel a été analysé.',
    input_schema: { type: 'object', properties: RANGE_PROPS, additionalProperties: false },
    run: async function (i) {
      const r = range(i);
      const s = await db.collection('call_logs').where('initiatedAt', '>=', new Date(r.fromMs)).where('initiatedAt', '<', new Date(r.toMs)).get();
      const by = {};
      s.forEach(function (d) {
        const c = d.data() || {};
        const who = c.userName || c.ringoverUserName || 'inconnu';
        inc(by, who, 'appels');
        if ((Number(c.durationSec) || 0) > 20) inc(by, who, 'decroches');
        inc(by, who, 'minutes', Math.round((Number(c.durationSec) || 0) / 60));
        if (c.aiCall && c.aiCall.notation) { inc(by, who, 'notes'); inc(by, who, 'sommeNotes', c.aiCall.notation.score || 0); }
      });
      Object.keys(by).forEach(function (k) { if (by[k].notes) { by[k].noteMoyenne = Math.round(by[k].sommeNotes / by[k].notes); } delete by[k].sommeNotes; });
      return { periode: r.from + ' → ' + r.to, parPersonne: by };
    },
  },
  {
    name: 'search_leads',
    description: 'Cherche des leads par nom, email ou téléphone (30 résultats max, fiches fusionnées exclues). Renvoie statut, provenance, score IA, dernier contact.',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false },
    run: async function (i) {
      const q = String(i.query || '').trim().toLowerCase();
      if (q.length < 2) return { error: 'requête trop courte' };
      const digits = q.replace(/\D/g, '');
      let snap;
      if (digits.length >= 9) snap = await db.collection('leads').where('phoneNormalized', '==', digits.slice(-9)).limit(10).get();
      else if (q.indexOf('@') > 0) snap = await db.collection('leads').where('email', '==', q).limit(10).get();
      else snap = await db.collection('leads').orderBy('createdAt', 'desc').limit(3000).get();
      const out = [];
      snap.forEach(function (d) {
        if (out.length >= 30) return;
        const l = d.data() || {};
        if (l._merged) return;
        if (digits.length < 9 && q.indexOf('@') < 0 && String(l.nom || '').toLowerCase().indexOf(q) < 0) return;
        out.push({ id: d.id, nom: l.nom, email: l.email, telephone: l.telephone, statut: l.status || 'nouveau', etape: l.stage || null, provenance: srcOf(l),
          scoreIA: l.aiLead ? l.aiLead.proba : null, assigne: l.assignedTo || null, entree: parisDate(tsToMs(l.createdAt) || Date.now()), client: !!l.isClient });
      });
      return { resultats: out };
    },
  },
  {
    name: 'get_lead',
    description: 'Dossier d\'un lead par son id : fiche, brief IA, dernier appel analysé, notes récentes, RDV.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'], additionalProperties: false },
    run: async function (i) {
      const s = await db.collection('leads').doc(String(i.id)).get();
      if (!s.exists) return { error: 'lead introuvable' };
      const l = s.data() || {};
      const bs = await db.collection('bookings').where('leadId', '==', s.id).get();
      const rdv = [];
      bs.forEach(function (d) { const b = d.data() || {}; rdv.push({ date: b.date, heure: b.time, avec: b.personName, issue: b.outcome || b.status, note: cap(b.outcomeNote || '', 200) }); });
      return { id: s.id, nom: l.nom, email: l.email, telephone: l.telephone, statut: l.status, etape: l.stage, provenance: srcOf(l), secteur: l.secteur, defi: cap(l.defi || '', 300),
        briefIA: l.aiLead || null, dernierAppel: l.aiLastCall ? { resume: l.aiLastCall.resume, resultat: l.aiLastCall.resultat } : null,
        notes: (l.notesHistory || []).slice(-5).map(function (n) { return cap(n.text, 200); }), rdv: rdv };
    },
  },
  {
    name: 'clients_risk',
    description: 'Portefeuille coaching : clients actifs par feu (rouge / orange / vert) avec les raisons, et opportunités de renouvellement / upsell (calculés chaque nuit).',
    input_schema: { type: 'object', properties: { niveau: { type: 'string', enum: ['rouge', 'orange', 'vert', 'tous'] } }, additionalProperties: false },
    run: async function (i) {
      const s = await db.collection('client_ai').get();
      const counts = { rouge: 0, orange: 0, vert: 0 };
      const list = [], opps = [];
      s.forEach(function (d) {
        const a = d.data() || {};
        if (!a.risk) return;
        counts[a.risk.level] = (counts[a.risk.level] || 0) + 1;
        if (!i.niveau || i.niveau === 'tous' || i.niveau === a.risk.level) list.push({ client: a.nom, niveau: a.risk.level, coach: a.coach, raisons: a.risk.reasons });
        if (a.opportunity) opps.push({ client: a.nom, type: a.opportunity.type, finDansJours: a.opportunity.daysToEnd, argument: a.opportunity.argument });
      });
      return { compteurs: counts, clients: list.slice(0, 60), opportunites: opps.slice(0, 30) };
    },
  },
  {
    name: 'unpaid_summary',
    description: 'Impayés : plans de paiement en échec, prélèvements rejetés non rattrapés, échéances en retard, état du recouvrement.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function () {
      const s = await db.collection('payments').get();
      const out = [];
      let due = 0;
      s.forEach(function (d) {
        const p = d.data() || {};
        const bad = p.status === 'failed' || p.status === 'mandate_failed' || !!p.lastPaymentFailure || (p.recouvrement && p.recouvrement.status);
        if (!bad || p.status === 'cancelled') return;
        const rest = Math.max(0, (Number(p.totalAmount) || 0) - (Number(p.paidAmount) || 0));
        due += rest;
        out.push({ client: p.leadName, statut: p.status, resteDu: rest, dernierRejet: p.lastPaymentFailure ? p.lastPaymentFailure.at : null, recouvrement: p.recouvrement ? p.recouvrement.status : null, closer: p.closerName });
      });
      out.sort(function (a, b) { return b.resteDu - a.resteDu; });
      return { dossiers: out.length, resteDuTotal: Math.round(due), liste: out.slice(0, 40) };
    },
  },
  {
    name: 'objections_top',
    description: 'Objections les plus fréquentes détectées par l\'IA (closings et appels de setting) sur N jours, avec le taux de levée.',
    input_schema: { type: 'object', properties: { jours: { type: 'integer' } }, additionalProperties: false },
    run: async function (i) {
      const days = Math.max(1, Math.min(365, Number(i.jours) || 90));
      const s = await db.collection('ai_objections').where('at', '>=', Date.now() - days * 86400000).get();
      const by = {};
      s.forEach(function (d) { const o = d.data() || {}; inc(by, o.category, 'total'); if (o.worked) inc(by, o.category, 'levees'); if (o.outcome === 'close') inc(by, o.category, 'closes'); });
      return { jours: days, parCategorie: by };
    },
  },
  {
    name: 'ai_usage',
    description: 'Consommation de l\'IA ce mois-ci (coût en dollars, nombre d\'appels, par tâche).',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
    run: async function () {
      const k = parisDate(Date.now()).slice(0, 7);
      const s = await db.collection('ai_usage_months').doc(k).get();
      return s.exists ? s.data() : { month: k, costUsd: 0, calls: 0 };
    },
  },
  {
    name: 'today_agenda',
    description: 'Agenda d\'un jour (défaut aujourd\'hui) : RDV commerciaux et RDV coaching, avec heure, personne, prospect / client, statut.',
    input_schema: { type: 'object', properties: { date: { type: 'string', description: 'AAAA-MM-JJ' } }, additionalProperties: false },
    run: async function (i) {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(i.date || '') ? i.date : parisDate(Date.now());
      const s = await db.collection('bookings').where('date', '==', date).get();
      const out = [];
      s.forEach(function (d) {
        const b = d.data() || {};
        const who = b.prospect ? ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim() : (b.clientName || '');
        out.push({ heure: b.time, type: isCoaching(b) ? 'coaching' : 'commercial', libelle: b.typeLabel || b.type, avec: b.personName, personne: who, statut: b.outcome || b.status });
      });
      out.sort(function (a, b) { return String(a.heure) < String(b.heure) ? -1 : 1; });
      return { date: date, rdv: out };
    },
  },
];

const BY_NAME = {};
TOOLS.forEach(function (t) { BY_NAME[t.name] = t; });

/** Définitions au format Messages API (tools[]). */
function claudeTools() {
  return TOOLS.map(function (t) { return { name: t.name, description: t.description, input_schema: t.input_schema }; });
}

async function runTool(name, input) {
  const t = BY_NAME[name];
  if (!t) return { error: 'outil inconnu : ' + name };
  try { return await t.run(input || {}); }
  catch (e) { return { error: e && e.message ? e.message : String(e) }; }
}

module.exports = { TOOLS: TOOLS, claudeTools: claudeTools, runTool: runTool };
