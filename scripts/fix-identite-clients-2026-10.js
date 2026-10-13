// ============================================================================
// scripts/fix-identite-clients-2026-10.js — rattrapage du 13/10/2026
// ----------------------------------------------------------------------------
// Pour chaque fiche persons CLIENTE (hors fusionnées), mêmes règles que
// api/coaching-client-ensure.js au close :
//   1. identité société depuis le dernier contrat signé NON annulé
//      (signature_requests.company, choisie dans l'annuaire officiel pendant
//      la signature) : companyName, companyLegalForm, siret, vatNumber,
//      address, clientType — champs VIDES uniquement, rien n'est écrasé ;
//   2. nom complet du représentant quand la fiche ne porte qu'un prénom
//      contenu dans ce nom (« Charlotte » → « Marie Charlotte DESTOUT ») ;
//   3. paiements des leads de la persons sans personId → rattachés
//      (+ persons.paymentIds) — invisibles de la fiche admin sinon ;
//   4. fiche coaching liée : activité vide → société du contrat.
// Les écritures sur persons sont recopiées par la synchro (Cloud Function
// onPersonsUpdate) vers la fiche facturation et les fiches liées.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply.
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-identite-clients-2026-10.js            # dry-run
//   ... node scripts/fix-identite-clients-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;

function vide(v) { return v == null || String(v).trim() === ''; }
function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
function ms(v) { const t = Date.parse(v || ''); return isNaN(t) ? 0 : t; }

function meilleurNom(nom, rep) {
  const n = String(nom || '').trim();
  if (!rep) return n;
  if (!n) return rep;
  if (n.split(/\s+/).length === 1 && fold(rep).split(/\s+/).indexOf(fold(n)) >= 0) return rep;
  return n;
}

async function contrats(leadIds, email) {
  const seen = {}, out = [];
  const reqs = leadIds.map(function (id) { return R.runQuery({ from: [{ collectionId: 'signature_requests' }], where: R.ff('leadId', 'EQUAL', id) }); });
  if (email) reqs.push(R.runQuery({ from: [{ collectionId: 'signature_requests' }], where: R.ff('clientEmail', 'EQUAL', email) }));
  (await Promise.all(reqs)).forEach(function (rows) {
    rows.forEach(function (d) { if (!seen[d.id] && d.data.status === 'signed') { seen[d.id] = 1; out.push(d); } });
  });
  out.sort(function (a, b) { return ms(b.data.signedAt) - ms(a.data.signedAt); });
  return out;
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const persons = await R.runQuery({ from: [{ collectionId: 'persons' }], where: R.ff('isClient', 'EQUAL', true) });
  let nP = 0, nPay = 0, nCo = 0;
  for (const p of persons) {
    const P = p.data;
    if (P._merged === true) continue;
    const leadIds = (P.leadIds || []).filter(Boolean);
    const email = String(P.email || '').trim().toLowerCase();
    const sigs = await contrats(leadIds, email);
    const withCo = sigs.find(function (s) { return s.data.company && (s.data.company.siret || s.data.company.name); });
    const lines = [];
    const upd = {};

    if (withCo) {
      const c = withCo.data.company, a = c.address || {};
      if (vide(P.companyName) && c.name) upd.companyName = String(c.name).trim();
      if (vide(P.companyLegalForm) && c.legalFormLabel) upd.companyLegalForm = String(c.legalFormLabel).trim();
      if (vide(P.siret) && c.siret) upd.siret = String(c.siret).replace(/\s+/g, '');
      if (vide(P.vatNumber) && c.vatNumber) upd.vatNumber = String(c.vatNumber).replace(/\s+/g, '');
      if ((!P.address || vide(P.address.line1)) && a.line1) upd.address = { line1: a.line1 || '', line2: a.line2 || '', postalCode: a.postalCode || '', city: a.city || '', country: a.country || 'France' };
      if (vide(P.clientType)) upd.clientType = 'company';
      const r = withCo.data.representative;
      const rep = r ? (String(r.firstName || '').trim() + ' ' + String(r.lastName || '').trim()).trim() : '';
      const nom = meilleurNom(P.nom, rep);
      if (nom && nom !== P.nom) upd.nom = nom;
    }

    /* Paiements des leads sans personId. */
    const payIds = (P.paymentIds || []).slice();
    const payFix = [];
    for (const lid of leadIds) {
      const pays = await R.runQuery({ from: [{ collectionId: 'payments' }], where: R.ff('leadId', 'EQUAL', lid) });
      pays.forEach(function (d) {
        if (!d.data.personId) payFix.push(d);
        if ((!d.data.personId || d.data.personId === p.id) && payIds.indexOf(d.id) < 0) payIds.push(d.id);
      });
    }
    if (payIds.length !== (P.paymentIds || []).length) upd.paymentIds = payIds;

    /* Fiche coaching : activité vide. */
    let coFix = null;
    if (P.coachingId && withCo && withCo.data.company && withCo.data.company.name) {
      const co = await R.getDoc('clients/' + P.coachingId);
      if (co && vide(co.data.activite)) {
        const naf = String(withCo.data.company.nafLabel || '').trim();
        coFix = String(withCo.data.company.name).trim() + (naf ? ' — ' + naf : '');
      }
    }

    if (!Object.keys(upd).length && !payFix.length && !coFix) continue;
    nP++;
    console.log('\n■ ' + (P.nom || p.id) + '  (persons/' + p.id + ')' + (withCo ? '  — contrat « ' + withCo.data.templateName + ' »' : ''));
    Object.keys(upd).forEach(function (k) {
      if (k === 'paymentIds') lines.push('  paymentIds : ' + (P.paymentIds || []).length + ' → ' + upd.paymentIds.length);
      else lines.push('  ' + k + ' : ' + JSON.stringify(P[k] == null ? null : P[k]) + ' → ' + JSON.stringify(upd[k]));
    });
    payFix.forEach(function (d) { lines.push('  payments/' + d.id + ' (' + d.data.totalAmount + ' €, ' + d.data.status + ') : personId → ' + p.id); });
    if (coFix) lines.push('  clients/' + P.coachingId + '.activite : "" → ' + JSON.stringify(coFix));
    console.log(lines.join('\n'));

    if (!APPLY) continue;
    for (const d of payFix) { await R.patchDoc('payments/' + d.id, { personId: p.id, _lastSyncedAt: new Date() }, ['personId', '_lastSyncedAt']); nPay++; }
    if (Object.keys(upd).length) {
      upd.updatedAt = new Date(); upd._lastSyncedAt = new Date();
      await R.patchDoc('persons/' + p.id, upd, Object.keys(upd));
    }
    if (coFix) { await R.patchDoc('clients/' + P.coachingId, { activite: coFix }, ['activite']); nCo++; }
  }
  console.log('\n' + nP + ' fiche(s) concernée(s)' + (APPLY ? ' — écrites (' + nPay + ' paiement(s), ' + nCo + ' fiche(s) coaching).' : ' — dry-run, relancer avec --apply.'));
})().catch(function (e) { console.error('❌', e.message); process.exit(1); });
