// ============================================================================
// scripts/fix-person-links-2026-10.js — rattrapage des fiches person (08/10/2026)
// ----------------------------------------------------------------------------
// Diagnostic du client Yann (closé le 07/10/2026) : la fiche person créée à la
// signature du contrat ne remontait ni le closeur, ni les paiements, ni la
// fiche coaching. Les causes sont corrigées dans Functions/_sync.js ; ce
// script répare l'existant :
//   A. closeur vide sur une person → lu sur le lead principal
//      (closeurSlug, sinon closedData.closerSlug, sinon assignedTo) ;
//   B. paiement sans personId alors que son lead en a un → rattaché
//      (payments.personId + persons.paymentIds) ;
//   C. fiche coaching (clients) sans personId → rattachée à la person qui a le
//      même email et pas encore de coachingId ;
//   D. lead de Yann : type / tag « VSL Élite » posés par un opt-in pendant
//      l'appel de close → tunnel d'origine restauré depuis engagementHistory.
//
// Effets de bord à connaître (triggers _sync.js) : écrire persons.closeurSlug
// le propage à leads.closeurSlug et invoice_clients.salesOwner. Le dry-run
// signale tout salesOwner existant qui serait remplacé.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-person-links-2026-10.js            # dry-run
//   ... node scripts/fix-person-links-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const YANN_LEAD_ID = 'sl_48143a45ee0f558049df';
const nowIso = new Date().toISOString();

function lower(s) { return (s || '').toString().trim().toLowerCase(); }

async function all(collectionId) {
  return R.runQuery({ from: [{ collectionId: collectionId }] });
}

function closeurOf(lead) {
  if (!lead) return { slug: null, src: null };
  if (lead.closeurSlug) return { slug: lead.closeurSlug, src: 'leads.closeurSlug' };
  if (lead.closedData && lead.closedData.closerSlug) return { slug: lead.closedData.closerSlug, src: 'closedData.closerSlug' };
  if (lead.assignedTo) return { slug: lead.assignedTo, src: 'assignedTo' };
  return { slug: null, src: null };
}

async function patch(path, fields) {
  const keys = Object.keys(fields);
  console.log('    ' + (APPLY ? '✏️  ' : '→ ') + path + ' ' + JSON.stringify(fields));
  if (APPLY) await R.patchDoc(path, fields, keys);
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');

  const tm = await R.getDoc('_meta/team_members');
  const raw = (tm && tm.data && tm.data.members) || [];
  const members = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
  const nameOf = {};
  members.forEach(function (m) { if (m && m.slug) nameOf[m.slug] = m.fullName || m.shortName || m.slug; });

  const persons = await all('persons');
  const byId = {};
  persons.forEach(function (p) { byId[p.id] = p; });
  const ics = await all('invoice_clients');
  const icByPerson = {};
  ics.forEach(function (ic) { if (ic.data.personId) icByPerson[ic.data.personId] = ic; });

  // ── A. Closeur ────────────────────────────────────────────────────────────
  console.log('\n── A. Closeur vide sur les fiches person');
  let nA = 0;
  for (const p of persons) {
    const d = p.data;
    if (d.closeurSlug || d._merged === true) continue;
    const leadId = d.primaryLeadId || (d.leadIds || [])[0];
    if (!leadId) continue;
    const lead = await R.getDoc('leads/' + leadId);
    const c = closeurOf(lead && lead.data);
    if (!c.slug) { console.log('  · ' + (d.nom || p.id) + ' — aucun closeur trouvé sur ' + leadId + ', ignoré'); continue; }
    console.log('  ' + (d.nom || p.id) + ' ← ' + c.slug + ' (' + c.src + ')' + (nameOf[c.slug] ? '' : '  ⚠ slug absent du roster'));
    const ic = icByPerson[p.id];
    if (ic && ic.data.salesOwner && ic.data.salesOwner !== c.slug) {
      console.log('    ⚠ invoice_clients/' + ic.id + '.salesOwner « ' + ic.data.salesOwner + ' » sera remplacé par la propagation');
    }
    const fields = { closeurSlug: c.slug, _lastSyncedAt: nowIso };
    if (!d.closeurName && nameOf[c.slug]) fields.closeurName = nameOf[c.slug];
    if (!d.salesOwner) fields.salesOwner = c.slug;
    await patch('persons/' + p.id, fields);
    nA++;
  }

  // ── B. Paiements ──────────────────────────────────────────────────────────
  console.log('\n── B. Paiements sans personId');
  let nB = 0;
  const payments = await all('payments');
  const addByPerson = {};
  for (const pay of payments) {
    const d = pay.data;
    if (d.personId || !d.leadId) continue;
    const lead = await R.getDoc('leads/' + d.leadId);
    const personId = lead && lead.data.personId;
    if (!personId || !byId[personId]) continue;
    console.log('  ' + (d.leadName || pay.id) + ' · ' + (d.description || '') + ' ' + (d.totalAmount || '') + ' € → persons/' + personId);
    await patch('payments/' + pay.id, { personId: personId, _lastSyncedAt: nowIso });
    (addByPerson[personId] = addByPerson[personId] || []).push(pay.id);
    nB++;
  }
  for (const pid of Object.keys(addByPerson)) {
    const cur = byId[pid].data.paymentIds || [];
    const next = cur.slice();
    addByPerson[pid].forEach(function (id) { if (next.indexOf(id) < 0) next.push(id); });
    await patch('persons/' + pid, { paymentIds: next, _lastSyncedAt: nowIso });
  }

  // ── C. Fiches coaching ────────────────────────────────────────────────────
  console.log('\n── C. Fiches coaching sans personId');
  let nC = 0;
  const personByEmail = {};
  persons.forEach(function (p) {
    if (p.data._merged === true) return;
    const e = lower(p.data.email);
    if (e) (personByEmail[e] = personByEmail[e] || []).push(p);
  });
  const clients = await all('clients');
  const taken = {};
  clients.forEach(function (c) { if (c.data.personId) taken[c.data.personId] = 1; });
  for (const c of clients) {
    if (c.data.personId) continue;
    const e = lower(c.data.email);
    const cands = (e && personByEmail[e]) || [];
    if (cands.length !== 1) {
      if (cands.length > 1) console.log('  · ' + (c.data.nom || c.id) + ' — ' + cands.length + ' persons avec cet email, ignoré');
      continue;
    }
    const p = cands[0];
    if (p.data.coachingId || taken[p.id]) { console.log('  · ' + (c.data.nom || c.id) + ' — persons/' + p.id + ' a déjà une fiche coaching, ignoré'); continue; }
    console.log('  ' + (c.data.nom || c.id) + ' (' + c.id + ') ↔ persons/' + p.id);
    await patch('clients/' + c.id, { personId: p.id });
    await patch('persons/' + p.id, { coachingId: c.id, _lastSyncedAt: nowIso });
    taken[p.id] = 1;
    nC++;
  }

  // ── D. Lead de Yann ───────────────────────────────────────────────────────
  console.log('\n── D. Tunnel d\'origine du lead de Yann');
  let nD = 0;
  const y = await R.getDoc('leads/' + YANN_LEAD_ID);
  const hist = (y && y.data.engagementHistory) || [];
  const orig = hist[hist.length - 1];
  if (y && orig && y.data.type === 'vsl_elite' && orig.type) {
    const fields = {
      type: orig.type,
      tags: (y.data.tags || []).filter(function (t) { return t !== 'VSL Élite'; })
    };
    if (orig.source) fields.source = orig.source;
    if (orig.utm) fields.utm = orig.utm;
    console.log('  type vsl_elite → ' + orig.type + ', tag « VSL Élite » retiré');
    await patch('leads/' + YANN_LEAD_ID, fields);
    nD++;
  } else {
    console.log('  · rien à faire (déjà restauré ou historique absent)');
  }

  console.log('\nRésumé : A ' + nA + ' closeur(s) · B ' + nB + ' paiement(s) · C ' + nC + ' fiche(s) coaching · D ' + nD + ' lead');
  if (!APPLY) console.log('Dry-run terminé — relancer avec --apply après validation.');
})().catch(function (e) { console.error('ERREUR', e.message); process.exit(1); });
