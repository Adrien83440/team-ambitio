// ============================================================================
// scripts/fix-setting-mois-du-close-2026-10.js — rattrapage du 07/10/2026
// ----------------------------------------------------------------------------
// Décision Adrien 07/10/2026 : les commissions de setting sont désormais
// versées sur le MOIS DU CLOSE (plus en M+1). Ce script :
//   1. ramène sur 2026-10 les deals Setting AUTO d'un close d'octobre que la
//      règle M+1 avait rangés en 2026-11 (shifted:true, closeMonth 2026-10) ;
//   2. crée le pop-up de félicitations (sale_celebrations/{dealKey}) pour
//      chacun de ces deals, si le setter n'est pas le closer et qu'aucun
//      document n'existe déjà.
//
// Lecture seule par défaut (dry-run). Écriture uniquement avec --apply,
// après validation du dry-run par Adrien (CLAUDE.md, règle 3).
//
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/fix-setting-mois-du-close-2026-10.js            # dry-run
//   ... node scripts/fix-setting-mois-du-close-2026-10.js --apply  # écriture
// ============================================================================
'use strict';
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const CLOSE_MONTH = '2026-10';
const FROM_MONTH = '2026-11';
const OFFRE_LABELS = { 'BP 12': 'Business Phénix', 'Elite': 'Élite Phénix', 'Titan': 'Titan', 'BP 6': 'BP 6' };

function isTarget(d) {
  return d && d.type === 'Setting' && d.auto === true && d.shifted === true && d.closeMonth === CLOSE_MONTH;
}

(async function main() {
  console.log(APPLY ? '=== APPLY — écriture ===' : '=== DRY-RUN — aucune écriture ===');
  const tm = await R.getDoc('_meta/team_members');
  const raw = (tm && tm.data && tm.data.members) || [];
  const members = Array.isArray(raw) ? raw : Object.keys(raw).map(function (k) { return raw[k]; });
  const bySlug = {};
  members.forEach(function (m) { if (m && m.slug) bySlug[m.slug] = m; });

  let moved = 0, celebs = 0;
  for (const slug of Object.keys(bySlug)) {
    const src = await R.getDoc('commissions/' + slug + '/mois/' + FROM_MONTH);
    const srcDeals = (src && src.data && src.data.deals) || [];
    const targets = srcDeals.filter(isTarget);
    if (!targets.length) continue;

    const dst = await R.getDoc('commissions/' + slug + '/mois/' + CLOSE_MONTH);
    const dstDeals = (dst && dst.data && dst.data.deals) || [];
    const dstKeys = {};
    dstDeals.forEach(function (d) { if (d && d.dealKey) dstKeys[d.dealKey] = 1; });

    const nowIso = new Date().toISOString();
    const toAdd = [];
    targets.forEach(function (d) {
      if (dstKeys[d.dealKey]) { console.log('  ⚠ ' + slug + ' · ' + d.dealKey + ' déjà présent sur ' + CLOSE_MONTH + ' — ignoré'); return; }
      const moved1 = Object.assign({}, d, {
        shifted: false,
        movedByHand: true,
        movedAt: nowIso,
        movedReason: 'Setting versé sur le mois du close (décision 07/10/2026)',
        notes: 'AUTO — Setting ' + (d.subtype === 'selfBooking' ? 'Self Booking' : 'No-Booking') + ' du close de ' + d.client
      });
      toAdd.push(moved1);
      console.log('  → ' + slug + ' : ' + d.client + ' · ' + d.offre + ' · ' + d.comm + ' € · ' + FROM_MONTH + ' ⇒ ' + CLOSE_MONTH + ' (' + d.dealKey + ')');
    });
    if (!toAdd.length) continue;
    const addKeys = {};
    toAdd.forEach(function (d) { addKeys[d.dealKey] = 1; });
    const newSrc = srcDeals.filter(function (d) { return !(d && d.dealKey && addKeys[d.dealKey]); });
    const newDst = dstDeals.concat(toAdd);
    console.log('    ' + FROM_MONTH + ' : ' + srcDeals.length + ' → ' + newSrc.length + ' deal(s) · ' + CLOSE_MONTH + ' : ' + dstDeals.length + ' → ' + newDst.length + ' deal(s)' + (dst ? '' : ' (document créé)'));

    if (APPLY) {
      // Destination d'abord : en cas d'échec au milieu, le deal est en double
      // (visible, rattrapable), jamais perdu.
      if (dst) await R.patchDoc('commissions/' + slug + '/mois/' + CLOSE_MONTH, { deals: newDst }, ['deals']);
      else await R.createDoc('commissions/' + slug + '/mois/' + CLOSE_MONTH, { deals: newDst });
      await R.patchDoc('commissions/' + slug + '/mois/' + FROM_MONTH, { deals: newSrc }, ['deals']);
    }
    moved += toAdd.length;

    // — Pop-up de félicitations —
    for (const d of toAdd) {
      const bk = d.bookingId ? await R.getDoc('bookings/' + d.bookingId) : null;
      const cd = (bk && bk.data && bk.data.closeData) || {};
      if (cd.closerSlug && cd.closerSlug === slug) { console.log('    (pas de pop-up : setter = closer)'); continue; }
      const target = bySlug[slug];
      if (!target || !target.firebaseUid) { console.log('    ⚠ pas de firebaseUid pour ' + slug + ' — pop-up ignoré'); continue; }
      const existing = await R.getDoc('sale_celebrations/' + d.dealKey);
      if (existing) { console.log('    (pop-up déjà présent)'); continue; }
      const closer = cd.closerSlug ? bySlug[cd.closerSlug] : null;
      const doc = {
        kind: 'setting',
        targetUid: target.firebaseUid,
        targetSlug: slug,
        targetName: target.shortName || target.fullName || slug,
        client: d.client || 'Client',
        offre: d.offre || null,
        offreLabel: OFFRE_LABELS[d.offre] || d.offre || '',
        comm: Number(d.comm) || 0,
        closerSlug: cd.closerSlug || null,
        closerName: closer ? (closer.shortName || closer.fullName || cd.closerSlug) : null,
        closeMonth: CLOSE_MONTH,
        payMonth: CLOSE_MONTH,
        bookingId: d.bookingId || null,
        leadId: d.leadId || null,
        dealKey: d.dealKey,
        createdAt: new Date(),
        createdBy: null,
        createdByName: 'Rattrapage 07/10/2026',
        seenAt: null
      };
      console.log('    🎉 pop-up pour ' + doc.targetName + ' : « ' + doc.client + ' — ' + doc.offreLabel + (doc.closerName ? ', closée par ' + doc.closerName : '') + ' · ' + doc.comm + ' € »');
      if (APPLY) await R.createDoc('sale_celebrations/' + d.dealKey, doc);
      celebs++;
    }
  }
  console.log('\n' + moved + ' deal(s) à ramener sur ' + CLOSE_MONTH + ', ' + celebs + ' pop-up(s) à créer' + (APPLY ? ' — ÉCRIT.' : ' — dry-run, rien écrit.'));
})().catch(function (e) { console.error('ERREUR', e && e.message); process.exit(1); });
