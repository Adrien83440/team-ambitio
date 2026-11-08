// ============================================================================
// scripts/booking-audit-45min.js — Audit Stratégique : 60 → 45 min (08/11/2026)
// ----------------------------------------------------------------------------
// Décision Adrien (brief « quiz → réservation », 08/11/2026) : l'appel du quiz
// Élite (consultation call_strat_phenix_all, « Audit Stratégique
// Personnalisé ») passe à 45 min, comme le promettent les pages du quiz.
//
// Ce que le script change, sur CETTE consultation seulement :
//   · duration            → 45
//   · rules.slotInterval  → 60 (+ rules.slotIntervalUnit 'minutes')
//     Sans intervalle explicite, la grille suit la durée : 09:00, 09:45,
//     10:30… au lieu de 09:00, 10:00… Avec 60, les créneaux proposés restent
//     ceux d'aujourd'hui (15 min libres entre deux appels).
// Rien d'autre : ni les autres consultations, ni les RDV déjà posés (ils
// gardent leur `duration` de 60 min, lue par l'agenda, le Meet, les e-mails
// et les rappels). Tout l'aval lit booking.duration : aucun code à changer.
//
// Le document booking_config/_types est réécrit sur le seul champ `list`
// (+ updatedAt / updatedBy / updatedByName, comme Booking admin), à partir
// du JSON BRUT lu juste avant : les types Firestore (horodatages…) des
// autres consultations sont recopiés tels quels, jamais réencodés. Écriture
// conditionnée à updateTime : si quelqu'un a modifié les consultations entre
// la lecture et l'écriture, Firestore refuse et rien ne change.
//
// Usage (lecture seule par défaut — règle « dry-run validé par Adrien ») :
//   node scripts/booking-audit-45min.js            # constat, aucune écriture
//   node scripts/booking-audit-45min.js --apply    # sauvegarde locale + écriture
// Options :
//   --type <id>        consultation visée (défaut call_strat_phenix_all)
//   --duree 45         nouvelle durée (minutes)
//   --intervalle 60    écart entre créneaux (minutes) ; 0 = ne pas toucher
// Sauvegarde du document d'origine (--apply) : ~/Downloads/backup-booking-types-<date>.json
// Env : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Idempotent : si durée et intervalle sont déjà bons, aucune écriture.
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const R = require('./_firestore-rest.js');

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : def;
}
const APPLY = process.argv.indexOf('--apply') >= 0;
const TYPE_ID = arg('--type', 'call_strat_phenix_all');
const DUREE = parseInt(arg('--duree', '45'), 10);
const INTERVALLE = parseInt(arg('--intervalle', '60'), 10);
const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const DOC = 'booking_config/_types';

function num(v) {
  if (!v) return null;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  return null;
}
function str(v) { return v && 'stringValue' in v ? v.stringValue : ''; }

/* Textes de la consultation qui pourraient annoncer l'ancienne durée en dur
   (description, modèles d'e-mail / SMS) : signalés, jamais modifiés. */
function texts(fields, prefix, out) {
  Object.keys(fields || {}).forEach(function (k) {
    const v = fields[k], p = prefix ? prefix + '.' + k : k;
    if ('stringValue' in v) out.push([p, v.stringValue]);
    else if (v.mapValue) texts(v.mapValue.fields, p, out);
    else if (v.arrayValue) (v.arrayValue.values || []).forEach(function (x, i) {
      if ('stringValue' in x) out.push([p + '[' + i + ']', x.stringValue]);
      else if (x.mapValue) texts(x.mapValue.fields, p + '[' + i + ']', out);
    });
  });
  return out;
}
const OLD_DURATION_RE = /(\b60\s?min|\b1\s?h(?!\d)|\bune heure\b|\b1 heure\b)/i;

(async function main() {
  if (!(DUREE > 0)) throw new Error('--duree invalide');
  const t = await R.token();
  const raw = await R.request('GET', BASE + '/' + DOC, { Authorization: 'Bearer ' + t });
  const list = raw.fields && raw.fields.list && raw.fields.list.arrayValue && raw.fields.list.arrayValue.values;
  if (!list) throw new Error(DOC + ' : champ list introuvable');

  const idx = list.findIndex(function (x) { return x.mapValue && str((x.mapValue.fields || {}).id) === TYPE_ID; });
  if (idx < 0) throw new Error('Consultation ' + TYPE_ID + ' introuvable dans ' + DOC);
  const f = list[idx].mapValue.fields;
  const rules = (f.rules && f.rules.mapValue && f.rules.mapValue.fields) || {};

  const avant = {
    duration: num(f.duration),
    slotInterval: num(rules.slotInterval),
    slotIntervalUnit: str(rules.slotIntervalUnit) || null,
    bufferBefore: num(rules.bufferBefore),
    bufferAfter: num(rules.bufferAfter)
  };
  console.log('Document     : ' + DOC + ' (updateTime ' + raw.updateTime + ', ' + list.length + ' consultations)');
  console.log('Consultation : ' + TYPE_ID + ' — « ' + str(f.label) + ' » (position ' + idx + ')');
  console.log('Avant        : ' + JSON.stringify(avant));
  const grilleAvant = avant.slotInterval || avant.duration;
  console.log('Grille avant : un créneau toutes les ' + grilleAvant + ' min' + (avant.slotInterval ? '' : ' (pas d\'intervalle : suit la durée)'));

  const changeDuree = avant.duration !== DUREE;
  const changeInter = INTERVALLE > 0 && (avant.slotInterval !== INTERVALLE || (avant.slotIntervalUnit && avant.slotIntervalUnit !== 'minutes'));
  const apres = Object.assign({}, avant, { duration: DUREE });
  if (INTERVALLE > 0) { apres.slotInterval = INTERVALLE; apres.slotIntervalUnit = 'minutes'; }
  console.log('Après        : ' + JSON.stringify(apres));
  console.log('Grille après : un créneau toutes les ' + (apres.slotInterval || apres.duration) + ' min');
  const marge = Math.max(apres.bufferBefore || 0, apres.bufferAfter || 0);
  if (apres.duration + marge > (apres.slotInterval || apres.duration)) {
    console.log('⚠ Durée + marge (' + apres.duration + ' + ' + marge + ' min) dépassent l\'intervalle : le créneau voisin d\'un RDV posé sautera.');
  }

  const suspects = texts(f, '', []).filter(function (p) { return OLD_DURATION_RE.test(p[1]); });
  if (suspects.length) {
    console.log('\n⚠ Textes de la consultation qui citent peut-être l\'ancienne durée (à corriger dans Booking admin, le script n\'y touche pas) :');
    suspects.forEach(function (p) { console.log('   · ' + p[0] + ' : ' + p[1].replace(/\s+/g, ' ').slice(0, 160)); });
  } else {
    console.log('\nAucun texte de la consultation ne cite « 60 min » / « 1h » / « une heure ».');
  }

  if (!changeDuree && !changeInter) { console.log('\n✓ Déjà à jour : aucune écriture.'); return; }
  if (!APPLY) { console.log('\nLecture seule. Relancer avec --apply pour écrire.'); return; }

  const dir = path.join(process.env.HOME || '.', 'Downloads');
  try { fs.mkdirSync(dir, { recursive: true }); } catch (e) {}
  const bk = path.join(dir, 'backup-booking-types-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(bk, JSON.stringify(raw, null, 2));
  console.log('\nSauvegarde : ' + bk);

  f.duration = { integerValue: String(DUREE) };
  if (INTERVALLE > 0) {
    rules.slotInterval = { integerValue: String(INTERVALLE) };
    rules.slotIntervalUnit = { stringValue: 'minutes' };
    f.rules = { mapValue: { fields: rules } };
  }
  const body = { fields: {
    list: { arrayValue: { values: list } },
    updatedAt: { timestampValue: new Date().toISOString() },
    updatedBy: { stringValue: 'script:booking-audit-45min' },
    updatedByName: { stringValue: 'Script Audit 45 min' }
  } };
  const mask = ['list', 'updatedAt', 'updatedBy', 'updatedByName']
    .map(function (p) { return 'updateMask.fieldPaths=' + encodeURIComponent(p); }).join('&');
  await R.request('PATCH', BASE + '/' + DOC + '?' + mask + '&currentDocument.updateTime=' + encodeURIComponent(raw.updateTime),
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, body);
  console.log('✓ Écrit : ' + TYPE_ID + ' → ' + DUREE + ' min' + (INTERVALLE > 0 ? ', créneaux toutes les ' + INTERVALLE + ' min' : '') + '.');
})().catch(function (e) { console.error('✗ ' + (e && e.message)); process.exit(1); });
