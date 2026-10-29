// ============================================================================
// scripts/audit-etapes-statuts.js — LECTURE SEULE (29/10/2026)
// ----------------------------------------------------------------------------
// Avant de basculer Leads Live sur les étapes du Pipeline (_config/crm_v2) :
// compte les leads dont l'étape `stage` (désormais la seule source de
// vérité) et le statut Leads Live `status` ne racontent pas la même chose,
// et montre dans quelle colonne / quel filtre chacun apparaîtra.
// N'écrit RIEN. S'il faut corriger, un script séparé, avec dry-run validé
// par Adrien, s'en chargera.
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/audit-etapes-statuts.js [--exemples 5] [--json sortie.json]
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { runQuery } = require('./_firestore-rest');

// Même règle de classement que le Pipeline et Leads Live
const ctx = { window: {} };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pipeline-etapes.js'), 'utf8'), ctx);
const E = ctx.window.PipelineEtapes;

const arg = function (k, d) { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const NEX = +arg('--exemples', 5);
const OUT = arg('--json', null);

/* Statut Leads Live → étape qu'il « veut dire » (STATUS_TO_STAGE de sales-leads.html) */
const STATUS_TO_STAGE = {
  nouveau: 'lead', appele: 'lead', decroche: 'lead', messagerie: 'lead',
  nrp1: 'nrp1', nrp2: 'nrp2', nrp3: 'nrp3', all_nrp: 'all_nrp', faux_numero: 'faux_numero',
  follow_up_pm: 'follow_up_pm', set: 'set', rdv_self_booking: 'rdv_self_booking', rdv_pose: 'rdv_confirmes',
  pas_interesse: 'disqualification', disqualifie: 'disqualification', poubelle: 'poubelle'
};
/* Statuts compatibles avec chaque étape (écrits par Leads Live, AlteoreFlow ou le Pipeline) */
function compatible(stage, status) {
  if (!status) return true;
  if (STATUS_TO_STAGE[status] === stage) return true;
  if (E.STATUS_OF[stage] === status) return true;
  const ok = {
    set: ['rdv_pose', 'set'], rdv_confirmes: ['rdv_pose', 'set'], rdv_self_booking: ['rdv_pose', 'rdv_self_booking'], partenariats: ['rdv_pose'],
    rdv_annules_prospect: ['follow_up_pm', 'pas_interesse'], rdv_annules_equipe: ['follow_up_pm', 'pas_interesse'],
    no_show_self: ['follow_up_pm', 'pas_interesse'], no_show_setting: ['follow_up_pm', 'pas_interesse'],
    follow_up_closing: ['appele', 'follow_up_pm', 'rdv_pose', 'decroche'], closed_lost: ['pas_interesse', 'follow_up_pm'],
    closed_won_setting: ['client', 'rdv_pose'], closed_won_self: ['client', 'rdv_pose'],
    disqualification: ['disqualifie', 'pas_interesse'], disqualifie_closing: ['disqualifie', 'pas_interesse'],
    all_nrp: ['all_nrp', 'nrp3']
  };
  return (ok[stage] || []).indexOf(status) > -1;
}

function ms(v) { if (!v) return null; if (v instanceof Date) return v.getTime(); const t = Date.parse(v); return isNaN(t) ? null : t; }

(async function () {
  console.log('Lecture des leads…');
  const leads = await runQuery({ from: [{ collectionId: 'leads' }], select: { fields: ['nom', 'stage', 'status', 'isClient', 'type', 'source', '_merged', 'createdAt', 'importedCreatedAt', 'dateWebinaire', 'lastOptinAt', 'assignedTo'].map(function (f) { return { fieldPath: f }; }) } });
  console.log(leads.length + ' leads. Lecture des RDV…');
  const books = await runQuery({ from: [{ collectionId: 'bookings' }], select: { fields: ['leadId', 'date', 'time', 'status', 'outcome', 'source', 'type', 'cancellation', 'closeData', 'presenceConfirmed', 'isCoaching', 'clientId', 'skipLeadCreation'].map(function (f) { return { fieldPath: f }; }) } });
  console.log(books.length + ' RDV.\n');
  const byLead = {};
  books.forEach(function (b) {
    const d = b.data; d.id = b.id;
    if (!d.leadId || d.isCoaching === true || d.clientId || d.skipLeadCreation === true || d.source === 'csm_manual') return;
    (byLead[d.leadId] = byLead[d.leadId] || []).push(d);
  });

  const now = Date.now(), J30 = now - 30 * 864e5;
  const cols = {}, cols30 = {}, pairs = {}, sansStage = [], rapport = { generatedAt: new Date().toISOString(), totals: {}, colonnes: {}, colonnes30j: {}, ecarts: [] };
  let vivants = 0, vus30 = 0, ecarts = 0, ecarts30 = 0;
  leads.forEach(function (x) {
    const l = x.data; l.id = x.id;
    if (l._merged === true || l.source === 'migration_suivi_client') return;
    vivants++;
    const r = E.classify(l, byLead[l.id] || []);
    cols[r.key] = (cols[r.key] || 0) + 1;
    const eff = Math.max(ms(l.createdAt) || 0, ms(l.lastOptinAt) || 0);
    const dans30 = eff > J30;
    if (dans30) { vus30++; cols30[r.key] = (cols30[r.key] || 0) + 1; }
    if (!l.stage) sansStage.push(l);
    if (!compatible(l.stage || 'lead', l.status || 'nouveau')) {
      ecarts++; if (dans30) ecarts30++;
      const k = (l.status || 'nouveau') + ' ⟶ ' + (l.stage || '(aucune étape)');
      const p = pairs[k] || (pairs[k] = { n: 0, n30: 0, ex: [] });
      p.n++; if (dans30) p.n30++;
      if (p.ex.length < NEX) p.ex.push(l.id + ' · ' + (l.nom || '—') + ' → ' + E.label(r.key));
    }
  });

  console.log('Leads vivants : ' + vivants + ' (dont ' + vus30 + ' visibles dans Leads Live, fenêtre 30 j)');
  console.log('Sans étape (rangés en « Lead ») : ' + sansStage.length + '\n');
  console.log('── Où ils apparaîtront (tous / 30 j Leads Live) ──');
  E.options().forEach(function (o) {
    const n = o.sub ? (cols[o.key] || 0) : Object.keys(cols).filter(function (k) { return k === o.key || k.indexOf(o.key + ':') === 0; }).reduce(function (s, k) { return s + cols[k]; }, 0);
    const n30 = o.sub ? (cols30[o.key] || 0) : Object.keys(cols30).filter(function (k) { return k === o.key || k.indexOf(o.key + ':') === 0; }).reduce(function (s, k) { return s + cols30[k]; }, 0);
    rapport.colonnes[o.key] = n; rapport.colonnes30j[o.key] = n30;
    console.log((o.sub ? '    ↳ ' : '  ') + o.label + ' : ' + n + ' / ' + n30);
  });
  console.log('\n── Statut Leads Live ≠ étape : ' + ecarts + ' leads (dont ' + ecarts30 + ' dans la fenêtre 30 j) ──');
  console.log('   Avec le mode étapes, ces leads se rangent selon l\'ÉTAPE (colonne de droite).');
  Object.keys(pairs).sort(function (a, b) { return pairs[b].n - pairs[a].n; }).forEach(function (k) {
    const p = pairs[k];
    console.log('  ' + k + ' : ' + p.n + ' (30 j : ' + p.n30 + ')');
    p.ex.forEach(function (e) { console.log('      ' + e); });
    rapport.ecarts.push({ paire: k, n: p.n, n30: p.n30, exemples: p.ex });
  });
  rapport.totals = { vivants: vivants, fenetre30j: vus30, sansStage: sansStage.length, ecarts: ecarts, ecarts30j: ecarts30 };
  if (OUT) { fs.writeFileSync(OUT, JSON.stringify(rapport, null, 2)); console.log('\nRapport JSON : ' + OUT); }
  console.log('\nAucune écriture effectuée.');
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
