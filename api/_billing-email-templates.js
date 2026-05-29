/**
 * api/_billing-email-templates.js
 *
 * Helpers de rendu des templates d'email facturation :
 *   - substitution {variables}
 *   - labels des modes de paiement
 *   - instructions de paiement conditionnelles selon mode
 *   - templates par défaut (utilisés en fallback si _config/billing.emailTemplates absent)
 */

/* ─── Templates par défaut ─── */
const DEFAULT_INVOICE_SUBJECT = 'Votre facture {invoiceNumber} — {issuerName}';

const DEFAULT_INVOICE_BODY =
'Bonjour {clientFirstName},\n' +
'\n' +
'Vous trouverez en pièce jointe votre facture {invoiceNumber} d\'un montant de {totalTtc} TTC.\n' +
'\n' +
'{paymentInstructions}\n' +
'\n' +
'Pour toute question, n\'hésitez pas à nous répondre directement à cet email.\n' +
'\n' +
'Bien cordialement,\n' +
'{issuerName}';

/* ─── Format helpers ─── */
function formatEur(n) {
  if (n == null || isNaN(n)) return '';
  return Number(n).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
}

function formatDateFr(d) {
  if (!d) return '';
  const dt = d instanceof Date ? d : (d && d.toDate ? d.toDate() : new Date(d));
  if (isNaN(dt.getTime())) return '';
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatIban(iban) {
  if (!iban) return '';
  return String(iban).replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
}

/* ─── Labels modes de paiement ─── */
const PAYMENT_METHOD_LABELS = {
  gocardless: 'Prélèvement automatique (mandat SEPA GoCardless)',
  transfer: 'Virement bancaire',
  card: 'Carte bancaire',
  check: 'Chèque',
  cash: 'Espèces',
  other: 'Selon accord',
};

function getPaymentMethodLabel(method) {
  return PAYMENT_METHOD_LABELS[method] || method || '—';
}

/* ─── Instructions de paiement conditionnelles ─── */
function buildPaymentInstructions(invoice, issuer) {
  const method = invoice.paymentMethod;
  switch (method) {
    case 'gocardless':
      return 'Paiement : prélèvement automatique immédiat, aucune action requise.';
    case 'transfer':
      const lines = ['Merci d\'effectuer un virement vers le compte suivant :'];
      if (issuer.iban) lines.push('IBAN : ' + formatIban(issuer.iban));
      if (issuer.bic) lines.push('BIC : ' + issuer.bic + (issuer.bankName ? ' (' + issuer.bankName + ')' : ''));
      lines.push('Référence à indiquer : ' + (invoice.number || ''));
      return lines.join('\n');
    case 'card':
      return 'Vous pouvez régler par carte bancaire en nous contactant.';
    case 'check':
      return 'Merci de faire parvenir votre chèque à l\'ordre de ' + (issuer.companyName || '') + '.';
    case 'cash':
      return 'Règlement en espèces selon les modalités convenues.';
    default:
      return 'Selon les modalités convenues entre nous.';
  }
}

/* ─── Construction des variables disponibles ─── */
function buildInvoiceVars(invoice, issuer) {
  const c = invoice.clientSnapshot || {};
  const clientFirstName = c.contactFirstName || '';
  const clientLastName = c.contactLastName || '';
  const fullName = (clientFirstName + ' ' + clientLastName).trim();
  const clientName = c.clientType === 'company' ? (c.companyName || fullName || '') : (fullName || c.companyName || '');

  /* VAT amount */
  let vatAmount = 0;
  if (invoice.vatBreakdown && invoice.vatBreakdown.length) {
    for (let i = 0; i < invoice.vatBreakdown.length; i++) {
      vatAmount += parseFloat(invoice.vatBreakdown[i].vat || 0);
    }
  }

  return {
    invoiceNumber: invoice.number || '',
    issueDate: formatDateFr(invoice.issueDate),
    dueDate: formatDateFr(invoice.dueDate),
    clientFirstName: clientFirstName || 'Madame, Monsieur',
    clientLastName: clientLastName || '',
    clientName: clientName || 'Madame, Monsieur',
    clientEmail: c.email || '',
    totalTtc: formatEur(invoice.totalTtc),
    totalHt: formatEur(invoice.totalHt),
    vatAmount: formatEur(vatAmount),
    paymentMethod: getPaymentMethodLabel(invoice.paymentMethod),
    paymentInstructions: buildPaymentInstructions(invoice, issuer),
    issuerName: issuer.companyName || '',
    issuerEmail: issuer.companyEmail || '',
    issuerPhone: issuer.companyPhone || '',
    poNumber: invoice.poNumber || '',
  };
}

/* ─── Substitution des variables ─── */
function renderTemplate(template, vars) {
  let out = String(template || '');
  Object.keys(vars).forEach(function(k) {
    const re = new RegExp('\\{' + k + '\\}', 'g');
    out = out.replace(re, vars[k] != null ? String(vars[k]) : '');
  });
  return out;
}

/* ─── HTML wrapper sobre pour l'email ─── */
function wrapAsHtml(plainText, issuer) {
  const escaped = String(plainText || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  const paragraphs = escaped.split(/\r?\n\r?\n+/).map(function(para) {
    const lines = para.split(/\r?\n/).join('<br>');
    return '<p style="margin:0 0 14px 0;line-height:1.5;color:#1a1a1a;">' + lines + '</p>';
  }).join('\n');

  return '' +
    '<!DOCTYPE html>\n' +
    '<html><head><meta charset="UTF-8"></head>\n' +
    '<body style="margin:0;padding:0;background:#f5f5f5;font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',Helvetica,Arial,sans-serif;">\n' +
    '<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f5f5f5;padding:24px 0;">\n' +
    '<tr><td align="center">\n' +
    '<table width="600" cellpadding="0" cellspacing="0" border="0" style="background:#ffffff;border:1px solid #e5e5e5;max-width:600px;">\n' +
    '<tr><td style="padding:32px 36px 24px 36px;font-size:14px;color:#1a1a1a;">\n' +
    paragraphs + '\n' +
    '</td></tr>\n' +
    '<tr><td style="padding:0 36px 28px 36px;border-top:1px solid #e5e5e5;font-size:11px;color:#999999;line-height:1.5;">\n' +
    '<p style="margin:14px 0 0 0;">' +
    (issuer.companyName || '') +
    (issuer.companyAddress && issuer.companyAddress.line1 ? ' · ' + issuer.companyAddress.line1 : '') +
    (issuer.companyAddress && issuer.companyAddress.postalCode ? ' · ' + issuer.companyAddress.postalCode + ' ' + (issuer.companyAddress.city || '') : '') +
    '</p>\n' +
    (issuer.companySiret ? '<p style="margin:4px 0 0 0;">SIRET ' + issuer.companySiret + (issuer.companyVatNumber ? ' · TVA ' + issuer.companyVatNumber : '') + '</p>\n' : '') +
    '</td></tr>\n' +
    '</table>\n' +
    '</td></tr>\n' +
    '</table>\n' +
    '</body></html>';
}

module.exports = {
  DEFAULT_INVOICE_SUBJECT: DEFAULT_INVOICE_SUBJECT,
  DEFAULT_INVOICE_BODY: DEFAULT_INVOICE_BODY,
  PAYMENT_METHOD_LABELS: PAYMENT_METHOD_LABELS,
  getPaymentMethodLabel: getPaymentMethodLabel,
  buildPaymentInstructions: buildPaymentInstructions,
  buildInvoiceVars: buildInvoiceVars,
  renderTemplate: renderTemplate,
  wrapAsHtml: wrapAsHtml,
  formatEur: formatEur,
  formatDateFr: formatDateFr,
};
