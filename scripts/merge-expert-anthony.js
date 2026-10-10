// ============================================================================
// scripts/merge-expert-anthony.js — une seule fiche expert pour Anthony
// ----------------------------------------------------------------------------
// Anthony avait sa propre fiche expert (anthonyreigaza_bsniw4, vide : aucun
// type, aucun RDV) avant de reprendre celle d'Élodie (booking_config/elodie,
// qui porte les liens de réservation, les RDV et l'agenda). Fusion :
//   1. booking_config/elodie reçoit les informations de la fiche vide qui lui
//      manquent (champs vides seulement : téléphone, bio).
//   2. la fiche vide passe en __type 'person_archived' : elle disparaît de
//      Booking, de la page de réservation et des sélecteurs (tous filtrent
//      __type === 'person'). Jamais supprimée ; réversible en remettant
//      __type à 'person'. Refus si elle porte des RDV ou des types.
//
// Lecture seule par défaut. Écriture uniquement avec --apply.
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/merge-expert-anthony.js [--apply]
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const KEEP = 'elodie';
const DUP = 'anthonyreigaza_bsniw4';
const FILL = ['phone', 'bio'];

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const keep = await R.getDoc('booking_config/' + KEEP);
  const dup = await R.getDoc('booking_config/' + DUP);
  if (!keep || keep.data.__type !== 'person') throw new Error('fiche ' + KEEP + ' introuvable');
  if (!dup) throw new Error('fiche ' + DUP + ' introuvable');
  if (dup.data.__type !== 'person') { console.log('· ' + DUP + ' déjà archivée (' + dup.data.__type + ')'); return; }
  if (dup.data.firebaseUid) throw new Error(DUP + ' est encore reliée à un compte : arrêt.');
  if ((dup.data.types || []).length) throw new Error(DUP + ' porte des types de RDV : arrêt.');
  const bks = await R.runQuery({ from: [{ collectionId: 'bookings' }], where: R.ff('personId', 'EQUAL', DUP) });
  if (bks.length) throw new Error(DUP + ' porte ' + bks.length + ' RDV : arrêt.');

  const fill = {};
  FILL.forEach(function (k) { if (dup.data[k] && !keep.data[k]) fill[k] = dup.data[k]; });
  console.log('\n1. booking_config/' + KEEP + ' (« ' + keep.data.name + ' ») ← ' + (Object.keys(fill).length ? JSON.stringify(fill) : 'rien à reprendre'));
  if (APPLY && Object.keys(fill).length) await R.patchDoc('booking_config/' + KEEP, fill, Object.keys(fill));

  const arch = { __type: 'person_archived', archivedAt: new Date(), archivedReason: 'doublon — fusionnée dans booking_config/' + KEEP, mergedInto: KEEP };
  console.log('2. booking_config/' + DUP + ' (« ' + dup.data.name + ' – ' + dup.data.role + ' ») → ' + JSON.stringify(arch));
  if (APPLY) await R.patchDoc('booking_config/' + DUP, arch, Object.keys(arch));
  console.log('\n' + (APPLY ? '✏️  fait.' : '→ relancer avec --apply pour écrire.'));
})().catch(function (e) { console.error('\n❌ ' + e.message); process.exit(1); });
