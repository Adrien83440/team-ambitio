// ============================================================================
// scripts/migrate-client-scope.js — MISE À NIVEAU DES FICHES invoice_clients
// ----------------------------------------------------------------------------
// Deux corrections, sur la même passe :
//
//   1. clientType → 'company' partout.
//      Alteore ne facture que des entreprises. Les fiches typées 'individual'
//      sont des restes de saisie : elles produisent des factures que la
//      transmission e-invoicing ignore en silence (sendByEinvoice ne part que
//      si clientSnapshot.clientType === 'company').
//      Quand companyName est vide, on le remplit avec le nom du contact —
//      c'est la dénomination légale d'une entreprise individuelle, et c'est
//      ce qui figure déjà sur les factures émises jusqu'ici.
//
//   2. billingScope → 'ei' pour les clients restés sur l'entreprise
//      individuelle, dont les factures sont produites hors d'Alteore.
//      Une fois marqués, ils sont bloqués à la validation (invoice-validate)
//      et exclus du flux Qonto (invoice-qonto-sync).
//
// AUCUNE SUPPRESSION : les valeurs remplacées sont conservées dans
// _previousClientType / _previousCompanyName, et chaque exécution réelle
// laisse une trace dans audit_log.
//
// USAGE
//   export GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
//   node scripts/migrate-client-scope.js              # lecture seule (défaut)
//   node scripts/migrate-client-scope.js --execute    # écrit, après validation
//
// La clé de service account reste hors du repo.
// ============================================================================

const admin = require('firebase-admin');

/* Clients restés sur l'EI. Le rapprochement se fait sur le nom, en dry-run
   d'abord : c'est à la lecture du rapport qu'on valide chaque correspondance.
   Un nom qui ne tombe pas sur exactement une fiche n'est jamais modifié. */
const EI_CLIENTS = [
  'BERNARD Mireille',
  'BERTOLINO Laure',
  'COMBES Alexandre',
  'JANVIER Delphine',
  'NAVES Anne-Lise',
  'PRAX Aurore',
];

const EXECUTE = process.argv.indexOf('--execute') >= 0;

/* Comparaison de noms tolérante : sans accents, sans ponctuation, en
   majuscules. « Anne-Lise NAVES » et « naves anne lise » se rejoignent. */
function normalizeName(value) {
  return String(value === null || value === undefined ? '' : value)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();
}

function tokensOf(value) {
  const n = normalizeName(value);
  return n ? n.split(' ') : [];
}

/* Le nom lisible d'une fiche, tous champs confondus. */
function labelOf(client) {
  const soc = String(client.companyName || '').trim();
  const person = ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')).trim();
  if (soc && person) return soc + ' — ' + person;
  return soc || person || client.email || '(sans nom)';
}

/* Tous les tokens du nom recherché doivent apparaître dans la fiche. */
function matchesClient(client, wanted) {
  const hay = normalizeName(
    (client.companyName || '') + ' '
    + (client.contactFirstName || '') + ' '
    + (client.contactLastName || '')
  );
  const parts = tokensOf(wanted);
  if (!parts.length || !hay) return false;
  for (let i = 0; i < parts.length; i++) {
    if (hay.indexOf(parts[i]) < 0) return false;
  }
  return true;
}

async function main() {
  if (!process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    console.error('GOOGLE_APPLICATION_CREDENTIALS n\'est pas défini. Abandon.');
    process.exit(1);
  }

  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
    projectId: 'ambitio-team',
  });
  const db = admin.firestore();

  const snap = await db.collection('invoice_clients').get();
  const clients = [];
  snap.forEach(function (d) { clients.push(Object.assign({ id: d.id }, d.data())); });

  console.log('');
  console.log('=== ' + (EXECUTE ? 'EXÉCUTION RÉELLE' : 'DRY-RUN — aucune écriture') + ' ===');
  console.log(clients.length + ' fiches invoice_clients lues.');
  console.log('');

  /* ── 1. Rapprochement EI ───────────────────────────────────────────────── */
  const eiIds = {};
  console.log('--- Clients EI (facturés hors Alteore) ---');
  for (let i = 0; i < EI_CLIENTS.length; i++) {
    const wanted = EI_CLIENTS[i];
    const hits = clients.filter(function (c) { return matchesClient(c, wanted); });

    if (hits.length === 1) {
      const already = hits[0].billingScope === 'ei';
      eiIds[hits[0].id] = true;
      console.log('  ' + (already ? '= déjà marqué  ' : '→ à marquer EI ') + wanted
        + '  ·  ' + labelOf(hits[0]) + '  [' + hits[0].id + ']');
    } else if (hits.length === 0) {
      console.log('  ⚠️ AUCUNE fiche pour « ' + wanted +' » — rien ne sera fait.');
    } else {
      console.log('  ⚠️ ' + hits.length + ' fiches correspondent à « ' + wanted + ' » — ambigu, rien ne sera fait :');
      for (let h = 0; h < hits.length; h++) {
        console.log('       · ' + labelOf(hits[h]) + '  [' + hits[h].id + ']');
      }
    }
  }
  console.log('');

  /* ── 2. Fiches à retyper ───────────────────────────────────────────────── */
  const toFix = [];
  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const needsType = c.clientType !== 'company';
    const needsName = !String(c.companyName || '').trim();
    if (!needsType && !needsName) continue;

    const fallbackName = ((c.contactFirstName || '') + ' ' + (c.contactLastName || '')).trim();
    toFix.push({
      client: c,
      needsType: needsType,
      /* On ne fabrique un nom que si on a de quoi : une fiche sans contact ni
         raison sociale doit être traitée à la main, pas devinée. */
      newCompanyName: (needsName && fallbackName) ? fallbackName : null,
      unnamed: needsName && !fallbackName,
    });
  }

  console.log('--- Fiches à retyper en société ---');
  if (!toFix.length) {
    console.log('  Aucune : toutes les fiches sont déjà typées société avec une raison sociale.');
  }
  for (let i = 0; i < toFix.length; i++) {
    const it = toFix[i];
    const bits = [];
    if (it.needsType) bits.push('clientType « ' + (it.client.clientType || 'vide') + ' » → « company »');
    if (it.newCompanyName) bits.push('companyName → « ' + it.newCompanyName + ' »');
    if (it.unnamed) bits.push('⚠️ RAISON SOCIALE INTROUVABLE — à compléter à la main');
    console.log('  · ' + labelOf(it.client) + '  [' + it.client.id + ']');
    console.log('      ' + bits.join('  ·  '));
  }
  console.log('');

  const eiCount = Object.keys(eiIds).length;
  console.log('--- Résumé ---');
  console.log('  EI à marquer (ou déjà marqués) : ' + eiCount);
  console.log('  Fiches à retyper               : ' + toFix.length);
  console.log('  dont sans raison sociale       : ' + toFix.filter(function (t) { return t.unnamed; }).length);
  console.log('');

  if (!EXECUTE) {
    console.log('Dry-run terminé. Relance avec --execute pour appliquer.');
    return;
  }

  /* ── 3. Écriture ───────────────────────────────────────────────────────── */
  const batchLimit = 400;
  let batch = db.batch();
  let pending = 0;
  let written = 0;

  async function flush() {
    if (!pending) return;
    await batch.commit();
    batch = db.batch();
    pending = 0;
  }

  for (let i = 0; i < clients.length; i++) {
    const c = clients[i];
    const update = {};

    if (eiIds[c.id] && c.billingScope !== 'ei') update.billingScope = 'ei';

    const fix = toFix.filter(function (t) { return t.client.id === c.id; })[0];
    if (fix) {
      if (fix.needsType) {
        update.clientType = 'company';
        update._previousClientType = c.clientType || null;
      }
      if (fix.newCompanyName) {
        update.companyName = fix.newCompanyName;
        update._previousCompanyName = c.companyName || null;
      }
    }

    if (!Object.keys(update).length) continue;

    update.updatedAt = admin.firestore.FieldValue.serverTimestamp();
    update.updatedBy = 'script:migrate-client-scope';
    batch.update(db.collection('invoice_clients').doc(c.id), update);
    pending++;
    written++;
    if (pending >= batchLimit) await flush();
  }

  await flush();

  await db.collection('audit_log').add({
    type: 'migrate_client_scope',
    actor: 'script:migrate-client-scope',
    clientsUpdated: written,
    eiMarked: eiCount,
    retyped: toFix.length,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  console.log(written + ' fiche(s) mise(s) à jour. Trace ajoutée dans audit_log.');
}

main().then(function () {
  process.exit(0);
}).catch(function (err) {
  console.error('Échec :', err && err.message ? err.message : err);
  process.exit(1);
});
