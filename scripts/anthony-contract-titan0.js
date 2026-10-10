// ============================================================================
// scripts/anthony-contract-titan0.js — barème d'Anthony aligné sur son contrat
// ----------------------------------------------------------------------------
// Contrat Full Cycle d'Anthony REIGAZA (signé le 09/10/2026, effet 10/10/2026) :
//   • art. 7.3 : seules Elite et Business ouvrent droit à commission ; toute
//     autre formule (Titan) → aucune commission sans avenant écrit.
//     → contract.closing.Titan, contract.setting.Titan, contract.pifBonus.Titan = 0
//   • art. 8.3 : points de bonus cumulés par période de 12 mois à compter de
//     la prise d'effet, remis à zéro à chaque date anniversaire.
//     → contract.bonusPeriod = 'annuel' (lu par sales-commissions.html)
//
// Le roster _meta/team_members.members est un tableau : il est relu et
// réécrit en brut (types Firestore préservés), seule l'entrée d'Anthony change.
//
// Lecture seule par défaut. Écriture uniquement avec --apply, après
// validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/anthony-contract-titan0.js            # dry-run
//   ... node scripts/anthony-contract-titan0.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const SLUG = 'anthonyreigaza';
const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const ZERO = { integerValue: '0' };

function show(f) {
  const n = function (v) { return v ? Number(v.integerValue != null ? v.integerValue : (v.doubleValue || 0)) : '∅'; };
  const sub = function (sec, k) { return sec && sec.mapValue && sec.mapValue.fields[k] && sec.mapValue.fields[k].mapValue && sec.mapValue.fields[k].mapValue.fields; };
  const cl = sub(f.closing, 'Titan') || {};
  const se = sub(f.setting, 'Titan') || {};
  const pb = f.pifBonus && f.pifBonus.mapValue && f.pifBonus.mapValue.fields.Titan;
  return 'Titan closing ' + n(cl.mensualise) + '/' + n(cl.pif) + ' · setting ' + n(se.noBooking) + '/' + n(se.selfBooking) +
    ' · prime PIF ' + n(pb) + ' · bonusPeriod ' + ((f.bonusPeriod && f.bonusPeriod.stringValue) || '∅');
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const t = await R.token();
  const raw = await R.request('GET', BASE + '/_meta/team_members', { Authorization: 'Bearer ' + t });
  const vals = raw.fields.members && raw.fields.members.arrayValue && raw.fields.members.arrayValue.values;
  if (!vals) throw new Error('_meta/team_members.members n\'est pas un tableau : arrêt.');
  const entry = vals.find(function (v) { const f = v.mapValue && v.mapValue.fields; return f && f.slug && f.slug.stringValue === SLUG; });
  if (!entry) throw new Error('membre ' + SLUG + ' introuvable');
  const ct = entry.mapValue.fields.contract && entry.mapValue.fields.contract.mapValue && entry.mapValue.fields.contract.mapValue.fields;
  if (!ct || !ct.closing || !ct.setting || !ct.pifBonus) throw new Error('contrat d\'Anthony incomplet dans le roster : arrêt.');

  console.log('Avant : ' + show(ct));
  ct.closing.mapValue.fields.Titan = { mapValue: { fields: { mensualise: ZERO, pif: ZERO } } };
  ct.setting.mapValue.fields.Titan = { mapValue: { fields: { noBooking: ZERO, selfBooking: ZERO } } };
  ct.pifBonus.mapValue.fields.Titan = ZERO;
  ct.bonusPeriod = { stringValue: 'annuel' };
  ct.updatedAt = { stringValue: new Date().toISOString() };
  console.log('Après : ' + show(ct));
  console.log('Elite et Business : inchangés.');

  if (!APPLY) { console.log('\n→ relancer avec --apply pour écrire.'); return; }
  await R.request('PATCH', BASE + '/_meta/team_members?updateMask.fieldPaths=members&currentDocument.exists=true',
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { fields: { members: raw.fields.members } });
  await R.createDoc('audit_log/contract_' + SLUG + '_' + Date.now(), {
    action: 'contract_update', via: 'script:anthony-contract-titan0', targetSlug: SLUG, at: new Date(),
    change: 'Titan closing/setting/pifBonus = 0 ; bonusPeriod = annuel (contrat Full Cycle art. 7.3 et 8.3)'
  });
  console.log('\n✏️  écrit + audit_log.');
})().catch(function (e) { console.error('\n❌ ' + e.message); process.exit(1); });
