/**
 * api/_statement-core.js
 *
 * Agrégation du relevé de compte client (grand livre) — helper partagé par
 * /api/client-statement (JSON, PDF, CSV) et /api/client-statement-send (email).
 *
 * Modèle comptable :
 *   - Débit  : chaque facture émise (status validated | sent | paid), au TTC,
 *              à sa date d'émission.
 *   - Crédit : chaque règlement (paidAt / paidAmount posés par invoice-mark-paid
 *              ou la sync GoCardless), à sa date de règlement.
 *   - Solde  : progressif ligne à ligne. Positif = restant dû par le client.
 *
 * Exclusions systématiques : brouillons (status 'draft', y compris les
 * _pendingValidation issus de GoCardless), factures _archived, 'cancelled'.
 * Les avoirs n'existent pas encore dans le système (creditNoteNextSeq réservé,
 * jamais utilisé) — le relevé n'a donc que des factures et des règlements.
 *
 * Le préfixe underscore exclut ce fichier du routing Vercel.
 */

const { db } = require('./_billing-helpers');
const { PAYMENT_METHOD_LABELS } = require('./_billing-email-templates');

/* Statuts de facture qui entrent dans le relevé */
const STATEMENT_STATUSES = ['validated', 'sent', 'paid'];

/* ─── Petits helpers ─── */

function tsToDate(v) {
  if (!v) return null;
  if (v instanceof Date) return isNaN(v.getTime()) ? null : v;
  if (typeof v.toDate === 'function') {
    try { return v.toDate(); } catch (e) { return null; }
  }
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function formatDateFr(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* Nom d'affichage d'une fiche invoice_clients (même logique que le frontend) */
function clientDisplayName(c) {
  if (!c) return '—';
  const company = (c.companyName || '').toString().trim();
  if (company) return company;
  const contact = ((c.contactFirstName || '') + ' ' + (c.contactLastName || '')).trim();
  if (contact) return contact;
  return c.email || '—';
}

/* Nom d'affichage depuis un clientSnapshot de facture (fallback quand la
   facture n'a pas de clientId — anciennes factures de rattrapage) */
function snapshotDisplayName(inv) {
  const cs = inv.clientSnapshot || {};
  return (cs.companyName || '').trim()
    || ((cs.contactFirstName || '') + ' ' + (cs.contactLastName || '')).trim()
    || cs.email || '—';
}

function paymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || '';
}

/* ─── Construction des écritures depuis une liste de factures ─── */

/**
 * Transforme les docs factures d'UN client en écritures brutes (non filtrées
 * par période, non soldées).
 * @returns [{date: ISO string, type: 'invoice'|'payment', piece, label,
 *            debit, credit, invoiceId, invoiceStatus}]
 */
function invoicesToEvents(invoices) {
  const events = [];
  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    if (inv._archived === true) continue;
    if (STATEMENT_STATUSES.indexOf(inv.status) === -1) continue;

    const issue = tsToDate(inv.issueDate) || tsToDate(inv.createdAt);
    if (!issue) continue;
    const piece = inv.number || inv.id;

    /* Libellé débit : la première ligne produit aide le comptable à situer */
    const firstLine = (inv.lines && inv.lines.length) ? inv.lines[0] : null;
    const product = firstLine ? (firstLine.productName || firstLine.description || '') : '';
    let debitLabel = 'Facture';
    if (product) debitLabel += ' — ' + String(product).substring(0, 60);

    events.push({
      date: issue.toISOString(),
      type: 'invoice',
      piece: piece,
      label: debitLabel,
      debit: round2(inv.totalTtc),
      credit: 0,
      invoiceId: inv.id,
      invoiceStatus: inv.status,
    });

    if (inv.status === 'paid') {
      const paidDate = tsToDate(inv.paidAt) || issue;
      const paidAmount = (inv.paidAmount != null && !isNaN(Number(inv.paidAmount)))
        ? round2(inv.paidAmount)
        : round2(inv.totalTtc);
      let creditLabel = 'Règlement ' + piece;
      const via = paymentMethodLabel(inv.paidVia);
      if (via) creditLabel += ' — ' + via;
      if (inv.paymentRef) creditLabel += ' (réf. ' + String(inv.paymentRef).substring(0, 40) + ')';

      events.push({
        date: paidDate.toISOString(),
        type: 'payment',
        piece: piece,
        label: creditLabel,
        debit: 0,
        credit: paidAmount,
        invoiceId: inv.id,
        invoiceStatus: inv.status,
      });
    }
  }
  return events;
}

/**
 * Trie les écritures, calcule le report à nouveau, filtre la période et pose
 * le solde progressif.
 *
 * @param events écritures brutes (invoicesToEvents)
 * @param from   'YYYY-MM-DD' ou null (début de l'historique)
 * @param to     'YYYY-MM-DD' ou null (aujourd'hui)
 * @returns { opening, entries, totals: {debit, credit, balance},
 *            counts: {invoices, payments, unpaid} }
 */
function buildLedger(events, from, to) {
  const sorted = events.slice().sort(function(a, b) {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    /* Même instant : la facture avant son règlement */
    if (a.type !== b.type) return a.type === 'invoice' ? -1 : 1;
    return (a.piece || '').localeCompare(b.piece || '');
  });

  const fromD = from ? new Date(from + 'T00:00:00') : null;
  const toD = to ? new Date(to + 'T23:59:59.999') : null;

  let opening = 0;
  const entries = [];
  for (let i = 0; i < sorted.length; i++) {
    const ev = sorted[i];
    const d = new Date(ev.date);
    if (fromD && d < fromD) {
      opening = round2(opening + ev.debit - ev.credit);
      continue;
    }
    if (toD && d > toD) continue;
    entries.push(ev);
  }

  let balance = opening;
  let totalDebit = 0;
  let totalCredit = 0;
  let nInvoices = 0;
  let nPayments = 0;
  const paidInvoiceIds = {};
  for (let i = 0; i < entries.length; i++) {
    const ev = entries[i];
    balance = round2(balance + ev.debit - ev.credit);
    ev.balance = balance;
    totalDebit = round2(totalDebit + ev.debit);
    totalCredit = round2(totalCredit + ev.credit);
    if (ev.type === 'invoice') nInvoices++;
    if (ev.type === 'payment') { nPayments++; paidInvoiceIds[ev.invoiceId] = true; }
  }
  let nUnpaid = 0;
  for (let i = 0; i < entries.length; i++) {
    const ev = entries[i];
    if (ev.type === 'invoice' && ev.invoiceStatus !== 'paid') nUnpaid++;
  }

  return {
    opening: round2(opening),
    entries: entries,
    totals: { debit: totalDebit, credit: totalCredit, balance: balance },
    counts: { invoices: nInvoices, payments: nPayments, unpaid: nUnpaid },
  };
}

/* ─── Relevé d'un client ─── */

/**
 * Construit le relevé de compte complet d'un client.
 * Lance { status: 404 } si la fiche client n'existe pas.
 */
async function buildClientStatement(clientId, from, to) {
  const clientSnap = await db.collection('invoice_clients').doc(clientId).get();
  if (!clientSnap.exists) {
    const e = new Error('Client introuvable'); e.status = 404; throw e;
  }
  const client = clientSnap.data();

  /* Requête mono-champ : pas d'index composite nécessaire, tri en mémoire */
  const invSnap = await db.collection('invoices').where('clientId', '==', clientId).get();
  const invoices = [];
  invSnap.forEach(function(d) { invoices.push(Object.assign({ id: d.id }, d.data())); });

  const ledger = buildLedger(invoicesToEvents(invoices), from, to);

  return {
    clientId: clientId,
    clientName: clientDisplayName(client),
    client: {
      companyName: client.companyName || '',
      contactFirstName: client.contactFirstName || '',
      contactLastName: client.contactLastName || '',
      email: client.email || '',
      siret: client.siret || '',
      vatNumber: client.vatNumber || '',
      address: client.address || {},
    },
    scope: (client.billingScope === 'ei') ? 'ei' : 'sarl',
    period: { from: from || null, to: to || null },
    opening: ledger.opening,
    entries: ledger.entries,
    totals: ledger.totals,
    counts: ledger.counts,
  };
}

/* ─── Grand livre tous clients ─── */

/**
 * Construit le grand livre global : toutes les écritures de tous les clients
 * sur la période, groupées par client (tri alphabétique).
 */
async function buildGlobalLedger(from, to) {
  const [invSnap, cliSnap] = await Promise.all([
    db.collection('invoices').get(),
    db.collection('invoice_clients').get(),
  ]);

  const clientsById = {};
  cliSnap.forEach(function(d) { clientsById[d.id] = d.data(); });

  /* Groupement par clientId ('' = factures sans fiche client) */
  const byClient = {};
  invSnap.forEach(function(d) {
    const inv = Object.assign({ id: d.id }, d.data());
    const key = inv.clientId || '';
    if (!byClient[key]) byClient[key] = [];
    byClient[key].push(inv);
  });

  const clients = [];
  const keys = Object.keys(byClient);
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const ledger = buildLedger(invoicesToEvents(byClient[key]), from, to);
    if (!ledger.entries.length && ledger.opening === 0) continue;
    const fiche = key ? clientsById[key] : null;
    clients.push({
      clientId: key || null,
      clientName: fiche ? clientDisplayName(fiche) : snapshotDisplayName(byClient[key][0]),
      scope: (fiche && fiche.billingScope === 'ei') ? 'ei' : 'sarl',
      opening: ledger.opening,
      entries: ledger.entries,
      totals: ledger.totals,
      counts: ledger.counts,
    });
  }
  clients.sort(function(a, b) { return a.clientName.localeCompare(b.clientName, 'fr'); });

  let totalDebit = 0, totalCredit = 0, totalBalance = 0;
  for (let i = 0; i < clients.length; i++) {
    totalDebit = round2(totalDebit + clients[i].totals.debit);
    totalCredit = round2(totalCredit + clients[i].totals.credit);
    totalBalance = round2(totalBalance + clients[i].totals.balance);
  }

  return {
    period: { from: from || null, to: to || null },
    clients: clients,
    totals: { debit: totalDebit, credit: totalCredit, balance: totalBalance },
  };
}

/* ─── CSV (Excel FR : BOM ajouté par l'appelant, séparateur ;, décimale ,) ─── */

const CSV_SEP = ';';

function csvCell(v) {
  const s = (v == null) ? '' : String(v);
  if (s.indexOf(CSV_SEP) > -1 || s.indexOf('"') > -1 || s.indexOf('\n') > -1) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvEur(n) {
  const v = Number(n);
  if (!isFinite(v)) return '';
  return v.toFixed(2).replace('.', ',');
}

function periodLabel(period) {
  if (period.from && period.to) return 'du ' + formatDateFr(period.from + 'T12:00:00') + ' au ' + formatDateFr(period.to + 'T12:00:00');
  if (period.from) return 'depuis le ' + formatDateFr(period.from + 'T12:00:00');
  if (period.to) return 'jusqu\'au ' + formatDateFr(period.to + 'T12:00:00');
  return 'historique complet';
}

/**
 * CSV du relevé d'un client. Retourne la string SANS le BOM.
 */
function clientStatementCsv(st) {
  const rows = [];
  rows.push(['Relevé de compte client', st.clientName].map(csvCell).join(CSV_SEP));
  rows.push(['Période', periodLabel(st.period)].map(csvCell).join(CSV_SEP));
  if (st.scope === 'ei') {
    rows.push([csvCell('Attention'), csvCell('Client facturé sur l\'entreprise individuelle, hors périmètre Alteore — relevé partiel ou vide par construction.')].join(CSV_SEP));
  }
  rows.push('');
  rows.push(['Date', 'Pièce', 'Libellé', 'Débit', 'Crédit', 'Solde'].join(CSV_SEP));
  if (st.period.from) {
    rows.push([csvCell(formatDateFr(st.period.from + 'T12:00:00')), '', csvCell('Report à nouveau'), '', '', csvEur(st.opening)].join(CSV_SEP));
  }
  for (let i = 0; i < st.entries.length; i++) {
    const ev = st.entries[i];
    rows.push([
      csvCell(formatDateFr(ev.date)),
      csvCell(ev.piece),
      csvCell(ev.label),
      ev.debit ? csvEur(ev.debit) : '',
      ev.credit ? csvEur(ev.credit) : '',
      csvEur(ev.balance),
    ].join(CSV_SEP));
  }
  rows.push('');
  rows.push(['', '', csvCell('Totaux de la période'), csvEur(st.totals.debit), csvEur(st.totals.credit), ''].join(CSV_SEP));
  rows.push(['', '', csvCell('Solde ' + (st.period.to ? 'au ' + formatDateFr(st.period.to + 'T12:00:00') : 'final')), '', '', csvEur(st.totals.balance)].join(CSV_SEP));
  return rows.join('\r\n');
}

/**
 * CSV du grand livre tous clients. Retourne la string SANS le BOM.
 */
function globalLedgerCsv(ledger) {
  const rows = [];
  rows.push(['Grand livre clients', periodLabel(ledger.period)].map(csvCell).join(CSV_SEP));
  rows.push('');
  rows.push(['Client', 'Date', 'Pièce', 'Libellé', 'Débit', 'Crédit', 'Solde client'].join(CSV_SEP));
  for (let c = 0; c < ledger.clients.length; c++) {
    const cl = ledger.clients[c];
    if (ledger.period.from && cl.opening !== 0) {
      rows.push([csvCell(cl.clientName), csvCell(formatDateFr(ledger.period.from + 'T12:00:00')), '', csvCell('Report à nouveau'), '', '', csvEur(cl.opening)].join(CSV_SEP));
    }
    for (let i = 0; i < cl.entries.length; i++) {
      const ev = cl.entries[i];
      rows.push([
        csvCell(cl.clientName),
        csvCell(formatDateFr(ev.date)),
        csvCell(ev.piece),
        csvCell(ev.label),
        ev.debit ? csvEur(ev.debit) : '',
        ev.credit ? csvEur(ev.credit) : '',
        csvEur(ev.balance),
      ].join(CSV_SEP));
    }
    rows.push([csvCell(cl.clientName), '', '', csvCell('Sous-total ' + cl.clientName), csvEur(cl.totals.debit), csvEur(cl.totals.credit), csvEur(cl.totals.balance)].join(CSV_SEP));
  }
  rows.push('');
  rows.push(['', '', '', csvCell('TOTAL GÉNÉRAL'), csvEur(ledger.totals.debit), csvEur(ledger.totals.credit), csvEur(ledger.totals.balance)].join(CSV_SEP));
  return rows.join('\r\n');
}

/* Nom de fichier sûr (mêmes remplacements que l'export ZIP frontend) */
function safeFileName(n) {
  return String(n || '').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').trim() || 'releve';
}

function rangeSuffix(from, to) {
  return (from || 'debut') + '_' + (to || 'aujourdhui');
}

module.exports = {
  buildClientStatement: buildClientStatement,
  buildGlobalLedger: buildGlobalLedger,
  clientStatementCsv: clientStatementCsv,
  globalLedgerCsv: globalLedgerCsv,
  periodLabel: periodLabel,
  safeFileName: safeFileName,
  rangeSuffix: rangeSuffix,
  formatDateFr: formatDateFr,
};
