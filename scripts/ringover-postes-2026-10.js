// ============================================================================
// scripts/ringover-postes-2026-10.js — postes Ringover après le départ d'Élodie
// ----------------------------------------------------------------------------
// État Ringover au 10/10/2026 (décision Adrien) :
//   • Anthony a SON poste : utilisateur Ringover 24143187, ligne +33 7 45 88 46 95.
//   • Le poste 22855712 est le compte admin d'Adrien ; la ligne d'Élodie
//     +33 7 55 54 63 71 y reste, en réserve.
//
// La plateforme relie appels et SMS à un membre par phone_numbers :
//   - ringover-call-status / ringover-sync-cron : ringoverUserId → assignedTo
//   - ringover-sms-inbound : numéro appelé → assignedTo
//   - ringover-sms-send : expéditeur = ligne active de l'auteur
//
//   A. phone_numbers/ringover_33745884695 : ligne d'Anthony (créée, ou
//      complétée si elle existe), ringoverUserId 24143187.
//   B. +33755546371 (ex-Élodie, repris par Anthony le matin) : rendue au poste
//      admin d'Adrien (22855712), qui la porte réellement dans Ringover.
//
// Volontairement NON fait : _config/telco_credentials.ringover.users. Le
// dialer fait sonner le poste PROPRIÉTAIRE de la clé API ; une entrée sans clé
// dédiée ferait sonner le téléphone d'Adrien. La clé d'Anthony se saisit à la
// main dans la Console (aucun secret dans le repo).
//
// Lecture seule par défaut. Écriture uniquement avec --apply, après
// validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/ringover-postes-2026-10.js            # dry-run
//   ... node scripts/ringover-postes-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const ANTHONY = { slug: 'anthonyreigaza', number: '+33745884695', roUser: '24143187' };
const RESERVE = { number: '+33755546371', roUser: '22855712', ownerSlug: 'adrien' };
const now = new Date();

let n = 0;
function line(path, fields) { console.log('  ' + (APPLY ? '✏️  ' : '→ ') + path + ' ' + JSON.stringify(fields)); n++; }

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const tm = (await R.getDoc('_meta/team_members')).data.members;
  const list = Array.isArray(tm) ? tm : Object.keys(tm).map(function (k) { return tm[k]; });
  const anthony = list.find(function (m) { return m && m.slug === ANTHONY.slug; });
  const owner = list.find(function (m) { return m && m.slug === RESERVE.ownerSlug; });
  if (!anthony || !anthony.firebaseUid) throw new Error('Anthony introuvable ou sans firebaseUid');
  if (!owner || !owner.firebaseUid) throw new Error(RESERVE.ownerSlug + ' introuvable ou sans firebaseUid');

  // Garde : ces postes Ringover ne doivent pas déjà servir à quelqu'un d'autre.
  const all = await R.runQuery({ from: [{ collectionId: 'phone_numbers' }] });
  all.forEach(function (p) {
    const d = p.data;
    if (d.ringoverUserId === ANTHONY.roUser && d.phoneNumber !== ANTHONY.number) throw new Error('poste ' + ANTHONY.roUser + ' déjà sur ' + d.phoneNumber);
  });

  console.log('\n── A. Ligne d\'Anthony ' + ANTHONY.number + ' → poste Ringover ' + ANTHONY.roUser);
  const aDoc = all.find(function (p) { return p.data.phoneNumber === ANTHONY.number; });
  const aFields = {
    phoneNumber: ANTHONY.number, friendlyName: 'Anthony (Ringover)', provider: 'ringover',
    numberType: 'national', countryCode: 'FR', active: true,
    assignedTo: anthony.firebaseUid, assignedToSlug: ANTHONY.slug, assignedToRole: 'sales',
    ringoverUserId: ANTHONY.roUser, updatedBy: 'script:ringover-postes-2026-10', updatedAt: now
  };
  if (aDoc) {
    line('phone_numbers/' + aDoc.id + ' (existant)', aFields);
    if (APPLY) await R.patchDoc('phone_numbers/' + aDoc.id, aFields, Object.keys(aFields));
  } else {
    const id = 'ringover_' + ANTHONY.number.replace('+', '');
    line('phone_numbers/' + id + ' (création)', aFields);
    if (APPLY) await R.createDoc('phone_numbers/' + id, Object.assign({ createdAt: now }, aFields));
  }

  console.log('\n── B. Ligne ' + RESERVE.number + ' (ex-Élodie, en réserve) → poste admin ' + RESERVE.roUser + ' (' + RESERVE.ownerSlug + ')');
  const bDoc = all.find(function (p) { return p.data.phoneNumber === RESERVE.number; });
  if (!bDoc) console.log('  · aucun document, ignoré');
  else {
    const bFields = {
      friendlyName: 'Réserve — ex-Élodie (Ringover, poste admin)',
      assignedTo: owner.firebaseUid, assignedToSlug: RESERVE.ownerSlug, assignedToRole: 'admin',
      ringoverUserId: RESERVE.roUser, updatedBy: 'script:ringover-postes-2026-10', updatedAt: now
    };
    console.log('  · avant : ' + bDoc.data.friendlyName + ' → ' + bDoc.data.assignedToSlug);
    line('phone_numbers/' + bDoc.id, bFields);
    if (APPLY) await R.patchDoc('phone_numbers/' + bDoc.id, bFields, Object.keys(bFields));
  }

  console.log('\n── C. Dialer d\'Anthony (_config/telco_credentials) : NON modifié');
  const telco = await R.getDoc('_config/telco_credentials');
  const users = (telco && telco.data.ringover && telco.data.ringover.users) || {};
  const cur = users[anthony.firebaseUid];
  console.log('  · poste dédié déclaré : ' + (cur && cur.apiKey ? 'oui (userId ' + cur.userId + ')' : 'NON — à saisir dans la Console avec sa clé API'));

  console.log('\n=== ' + (APPLY ? 'ÉCRIT' : 'SERAIT ÉCRIT') + ' : ' + n + ' opération(s) ===');
})().catch(function (e) { console.error('\n❌ ' + e.message); process.exit(1); });
