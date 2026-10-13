// ============================================================================
// scripts/fix-hugo-michel-2026-10.js — rattrapage du 13/10/2026
// ----------------------------------------------------------------------------
// Hugo MICHEL (leads/M82t9JX2gJW32kEb2WYi) a été closé Business Phénix le
// 13/10 à 17:06 (pilote de closing, Anthony). À 17:08, la réservation de son
// RDV URGENT POST INSCRIPTION depuis Leads Live a repassé la fiche en
// stage 'set' / status 'rdv_pose' et écrasé la date de son RDV commercial
// par celle du RDV 72 h (bug corrigé dans sales-leads.html le même jour).
//
// Ce script remet UNIQUEMENT :
//   · stage  'set'      → 'closed_won_setting'  (close Setting NB, closedData.sb false)
//   · status 'rdv_pose' → 'client'
//   · rdvDate / rdvHeure / dateRdv → le RDV commercial réel, relu dans
//     bookings (Audit Stratégique du 12/10/2026 15:00)
//   · + une ligne de timeline qui explique la correction.
// isClient, clientSince, closedData, closePilot, commissions : déjà justes,
// non touchés. Le faux SET d'Anthony du 13/10 (journal lead_actions, immuable)
// se corrige dans SET NB → « ✎ Corriger », pas ici.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-hugo-michel-2026-10.js            # dry-run
//   ... node scripts/fix-hugo-michel-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const LEAD_ID = 'M82t9JX2gJW32kEb2WYi';
const RDV_COMMERCIAL_ID = 'sl-2026-10-12-15-00-1i0s22q';

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const lead = await R.getDoc('leads/' + LEAD_ID);
  if (!lead) throw new Error('lead introuvable');
  const L = lead.data;
  console.log('Fiche : ' + L.nom + ' — stage=' + L.stage + ' status=' + L.status + ' isClient=' + L.isClient);

  /* Garde-fous : on ne corrige que l'état cassé exact, jamais autre chose. */
  if (L.isClient !== true || !L.closedData || L.closedData.sb !== false) {
    console.log('⛔ Fiche pas dans l\'état attendu (client Setting NB) — rien à faire.');
    return;
  }
  if (L.stage === 'closed_won_setting' && L.status === 'client') {
    console.log('✅ Déjà corrigée — rien à faire.');
    return;
  }
  if (L.stage !== 'set' || L.status !== 'rdv_pose') {
    console.log('⛔ État inattendu (stage=' + L.stage + ', status=' + L.status + ') — rien à faire, à regarder à la main.');
    return;
  }

  const bk = await R.getDoc('bookings/' + RDV_COMMERCIAL_ID);
  if (!bk || bk.data.leadId !== LEAD_ID) throw new Error('RDV commercial introuvable ou d\'un autre lead');
  const B = bk.data;
  const dateFr = B.date.split('-').reverse().join('/');

  const timeline = (L.timeline_history || []).slice();
  timeline.push({
    text: '🔧 Fiche remise en client — la réservation du RDV 72 h l\'avait repassée en « RDV posé » (bug corrigé le 13/10/2026)',
    date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
    color: '#10b981',
  });

  const fields = {
    stage: 'closed_won_setting',
    status: 'client',
    rdvDate: B.date,
    rdvHeure: B.time,
    dateRdv: dateFr + ' à ' + B.time,
    timeline_history: timeline,
    updatedAt: new Date(),
  };
  console.log('\nModifications :');
  ['stage', 'status', 'rdvDate', 'rdvHeure', 'dateRdv'].forEach(function (k) {
    console.log('  ' + k + ' : ' + JSON.stringify(L[k]) + ' → ' + JSON.stringify(fields[k]));
  });
  console.log('  timeline_history : +1 ligne « ' + timeline[timeline.length - 1].text + ' »');

  if (!APPLY) { console.log('\n(dry-run) Relancer avec --apply pour écrire.'); return; }
  await R.patchDoc('leads/' + LEAD_ID, fields, Object.keys(fields));
  console.log('\n✅ Fiche corrigée.');
})().catch(function (e) { console.error('❌', e.message); process.exit(1); });
