/**
 * api/_statement-pdf.js
 *
 * Génération du PDF « Relevé de compte client » avec pdf-lib.
 * Même patte visuelle que _billing-pdf.js (dont les primitives ne sont pas
 * exportées : elles sont recopiées ici pour garder chaque helper autonome).
 *
 * Reçoit le relevé déjà agrégé par _statement-core.js — aucune lecture
 * Firestore ici.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

/* ─── Constantes layout (identiques à _billing-pdf.js) ─── */
const PAGE_W = 595.28;
const PAGE_H = 841.89;
const M_LEFT = 40;
const M_RIGHT = 40;
const M_TOP = 40;
const M_BOTTOM = 40;
const CONTENT_W = PAGE_W - M_LEFT - M_RIGHT;

const COLOR_TEXT = rgb(0.04, 0.04, 0.04);
const COLOR_MUTED = rgb(0.40, 0.40, 0.40);
const COLOR_LIGHT = rgb(0.60, 0.60, 0.60);
const COLOR_LINE = rgb(0.85, 0.85, 0.85);
const COLOR_LINE_DARK = rgb(0.10, 0.10, 0.10);
const COLOR_BG_HEADER = rgb(0.96, 0.96, 0.96);
const COLOR_AMBER = rgb(0.85, 0.46, 0.02);
const COLOR_GREEN = rgb(0.02, 0.55, 0.35);

/* ─── Sanitization WinAnsi (copie de _billing-pdf.js) ─── */
const _PDF_SANITIZE_MAP = {
  /* Apostrophes et guillemets typographiques \u2192 ASCII */
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2032': "'", '\u2033': '"', '\u2035': "'", '\u2036': '"',
  /* Tirets typographiques \u2192 ASCII (inclut U+2212 signe moins) */
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  /* Ellipsis \u2192 trois points */
  '\u2026': '...',
  /* Espaces non-cassables et sp\u00e9ciaux \u2192 espace normal */
  '\u00A0': ' ', '\u2007': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ',
  /* Ligatures latines \u2192 d\u00e9compos\u00e9es */
  '\u0153': 'oe', '\u0152': 'OE',
  '\u00E6': 'ae', '\u00C6': 'AE',
  /* Caract\u00e8res de contr\u00f4le invisibles \u2192 vide */
  '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '',
  /* Symboles divers \u00e0 approximer */
  '\u2022': '-', '\u2023': '-', '\u25E6': '-', '\u2043': '-',
  '\u2122': '(TM)', '\u00AE': '(R)', '\u00A9': '(C)',
};

/* Codepoints > U+00FF encodables par WinAnsi (CP1252), pr\u00e9serv\u00e9s tels quels.
   Le \u20ac est le cas critique. */
const _WINANSI_EXTRA = ['\u20AC' /* \u20ac */, '\u0192', '\u2020', '\u2021', '\u2030'];

function sanitizeForPdf(str) {
  if (str == null) return '';
  let s = String(str);
  for (const k in _PDF_SANITIZE_MAP) {
    if (s.indexOf(k) >= 0) s = s.split(k).join(_PDF_SANITIZE_MAP[k]);
  }
  /* Filet de s\u00e9curit\u00e9 : tout caract\u00e8re hors WinAnsi \u2192 '?' */
  s = s.replace(/[\u0100-\uFFFF]/g, function(ch) {
    return _WINANSI_EXTRA.indexOf(ch) >= 0 ? ch : '?';
  });
  return s;
}

function widthOf(font, str, size) {
  return font.widthOfTextAtSize(sanitizeForPdf(str == null ? '' : String(str)), size);
}

/* ─── Helpers de tracé ─── */
function yFromTop(yTop) { return PAGE_H - yTop; }

function hLine(page, x1, x2, yTop, color, thickness) {
  page.drawLine({
    start: { x: x1, y: yFromTop(yTop) },
    end:   { x: x2, y: yFromTop(yTop) },
    thickness: thickness || 0.5,
    color: color || COLOR_LINE,
  });
}

function rect(page, x, yTop, w, h, color) {
  page.drawRectangle({ x: x, y: yFromTop(yTop + h), width: w, height: h, color: color });
}

function text(page, str, x, yTop, font, size, color) {
  page.drawText(sanitizeForPdf(str), { x: x, y: yFromTop(yTop + size * 0.85), font: font, size: size, color: color || COLOR_TEXT });
}

function wrapText(str, font, size, maxWidth) {
  if (!str) return [''];
  const paragraphs = sanitizeForPdf(str).split(/\r?\n/);
  const out = [];
  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];
    if (!para.trim()) { out.push(''); continue; }
    const words = para.split(/\s+/);
    let line = '';
    for (let i = 0; i < words.length; i++) {
      const word = words[i];
      const test = line ? line + ' ' + word : word;
      const w = widthOf(font, test, size);
      if (w > maxWidth && line) {
        out.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/* ─── Format helpers ─── */
function formatEur(n) {
  if (n == null || isNaN(n)) return '0,00 €';
  /* Séparateur de milliers = espace normal, jamais toLocaleString (U+202F) */
  const num = Number(n);
  const neg = num < 0;
  const fixed = Math.abs(num).toFixed(2);
  const dot = fixed.indexOf('.');
  const intPart = fixed.slice(0, dot);
  const decPart = fixed.slice(dot + 1);
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + withThousands + ',' + decPart + ' €';
}

function formatDateFr(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : (d.toDate ? d.toDate() : new Date(d));
  if (isNaN(dt.getTime())) return '—';
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

/* ─── Colonnes du tableau ─── */
const COL_DATE_W = 58;
const COL_PIECE_W = 82;
const COL_DEBIT_W = 72;
const COL_CREDIT_W = 72;
const COL_SOLDE_W = 78;
const COL_LABEL_W = CONTENT_W - COL_DATE_W - COL_PIECE_W - COL_DEBIT_W - COL_CREDIT_W - COL_SOLDE_W;

const COL_DATE_X = M_LEFT;
const COL_PIECE_X = COL_DATE_X + COL_DATE_W;
const COL_LABEL_X = COL_PIECE_X + COL_PIECE_W;
const COL_DEBIT_X = COL_LABEL_X + COL_LABEL_W;
const COL_CREDIT_X = COL_DEBIT_X + COL_DEBIT_W;
const COL_SOLDE_X = COL_CREDIT_X + COL_CREDIT_W;

const MAX_Y = PAGE_H - M_BOTTOM - 50; /* réserve pour le footer légal */

/* ─── Génération principale ─── */

/**
 * @param {object} args
 * @param {object} args.statement   - Relevé agrégé (_statement-core.buildClientStatement)
 * @param {string} args.periodText  - Libellé de période prêt à afficher
 * @param {object} args.issuer      - _config/billing (identité émetteur)
 * @param {Buffer|null} args.logoBuf
 * @param {object|null} args.fonts  - { light, regular, medium } Buffers Montserrat
 * @returns {Promise<Buffer>}
 */
async function generateStatementPdf(args) {
  const st = args.statement;
  const issuer = args.issuer || {};
  const periodText = args.periodText || '';

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helveticaOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let montLight = helvetica, montMedium = helveticaBold;
  const fontBytes = args.fonts;
  if (fontBytes && fontBytes.light && fontBytes.medium) {
    try {
      montLight = await pdf.embedFont(fontBytes.light);
      montMedium = await pdf.embedFont(fontBytes.medium);
    } catch (e) {
      console.warn('[statement-pdf] Failed to embed Montserrat, using Helvetica fallback:', e.message);
    }
  }

  const F = { light: montLight, medium: montMedium, helv: helvetica, helvBold: helveticaBold, helvIt: helveticaOblique };

  /* Logo */
  let logoImg = null;
  let logoDims = null;
  if (args.logoBuf) {
    try {
      const sig = args.logoBuf.slice(0, 4);
      if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4E && sig[3] === 0x47) {
        logoImg = await pdf.embedPng(args.logoBuf);
      } else {
        logoImg = await pdf.embedJpg(args.logoBuf);
      }
      logoDims = logoImg.scale(1);
    } catch (e) {
      console.warn('[statement-pdf] Logo embed failed:', e.message);
    }
  }

  /* ── Page 1 : header complet ── */
  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = drawHeader(page, F, issuer, logoImg, logoDims, periodText, false);
  drawLegalFooter(page, F, issuer);

  /* Blocs émetteur / client */
  y = drawParties(page, F, issuer, st, y);

  /* Mention EI le cas échéant */
  if (st.scope === 'ei') {
    const warn = 'Client facturé sur l\'entreprise individuelle, hors périmètre Alteore : ce relevé ne couvre que les éventuelles écritures émises depuis cet outil.';
    const warnLines = wrapText(warn, F.helvIt, 8.5, CONTENT_W);
    for (let i = 0; i < warnLines.length; i++) {
      text(page, warnLines[i], M_LEFT, y, F.helvIt, 8.5, COLOR_AMBER);
      y += 11;
    }
    y += 6;
  }

  /* ── Tableau des écritures ── */
  y = drawTableHead(page, F, y);

  function newPage() {
    page = pdf.addPage([PAGE_W, PAGE_H]);
    let ny = drawHeader(page, F, issuer, logoImg, logoDims, periodText, true);
    drawLegalFooter(page, F, issuer);
    return drawTableHead(page, F, ny);
  }

  /* Report à nouveau */
  if (st.period.from) {
    if (y + 16 > MAX_Y) y = newPage();
    text(page, formatDateFr(st.period.from + 'T12:00:00'), COL_DATE_X + 4, y, F.helv, 8.5, COLOR_MUTED);
    text(page, 'Report à nouveau', COL_LABEL_X + 4, y, F.helvIt, 8.5, COLOR_MUTED);
    drawAmountCell(page, F, COL_SOLDE_X, COL_SOLDE_W, y, formatEur(st.opening), F.helvBold, COLOR_TEXT);
    y += 15;
    hLine(page, M_LEFT, PAGE_W - M_RIGHT, y - 4, COLOR_LINE);
  }

  /* Écritures */
  for (let i = 0; i < st.entries.length; i++) {
    const ev = st.entries[i];
    const labelLines = wrapText(ev.label, F.helv, 8.5, COL_LABEL_W - 8);
    const rowH = Math.max(15, labelLines.length * 11 + 4);
    if (y + rowH > MAX_Y) y = newPage();

    text(page, formatDateFr(ev.date), COL_DATE_X + 4, y, F.helv, 8.5, COLOR_TEXT);
    text(page, ev.piece || '—', COL_PIECE_X + 4, y, F.helv, 8.5, COLOR_TEXT);
    for (let l = 0; l < labelLines.length; l++) {
      text(page, labelLines[l], COL_LABEL_X + 4, y + l * 11, F.helv, 8.5, l === 0 ? COLOR_TEXT : COLOR_MUTED);
    }
    if (ev.debit) {
      drawAmountCell(page, F, COL_DEBIT_X, COL_DEBIT_W, y, formatEur(ev.debit), F.helv, COLOR_TEXT);
    }
    if (ev.credit) {
      drawAmountCell(page, F, COL_CREDIT_X, COL_CREDIT_W, y, formatEur(ev.credit), F.helv, COLOR_GREEN);
    }
    drawAmountCell(page, F, COL_SOLDE_X, COL_SOLDE_W, y, formatEur(ev.balance), F.helvBold, COLOR_TEXT);

    y += rowH;
    hLine(page, M_LEFT, PAGE_W - M_RIGHT, y - 4, COLOR_LINE);
  }

  if (!st.entries.length) {
    if (y + 20 > MAX_Y) y = newPage();
    text(page, 'Aucune écriture sur la période.', M_LEFT + 4, y + 4, F.helvIt, 9, COLOR_MUTED);
    y += 24;
  }

  /* ── Bloc totaux ── */
  const totalsH = 78;
  if (y + totalsH + 10 > MAX_Y) y = newPage();
  y += 8;
  const totalsX = PAGE_W - M_RIGHT - 250;
  const totalsW = 250;
  const lh = 14;

  text(page, 'Total débits (factures)', totalsX, y, F.helv, 9.5, COLOR_MUTED);
  drawAmountRight(page, F, totalsX + totalsW, y, formatEur(st.totals.debit), F.helvBold, 9.5, COLOR_TEXT);
  y += lh;
  text(page, 'Total crédits (règlements)', totalsX, y, F.helv, 9.5, COLOR_MUTED);
  drawAmountRight(page, F, totalsX + totalsW, y, formatEur(st.totals.credit), F.helvBold, 9.5, COLOR_GREEN);
  y += lh;
  hLine(page, totalsX, totalsX + totalsW, y, COLOR_LINE_DARK, 1.2);
  y += 8;
  const soldeLabel = 'Solde ' + (st.period.to ? 'au ' + formatDateFr(st.period.to + 'T12:00:00') : 'final');
  text(page, soldeLabel, totalsX, y, F.helvBold, 12, COLOR_TEXT);
  drawAmountRight(page, F, totalsX + totalsW, y, formatEur(st.totals.balance), F.helvBold, 12, COLOR_TEXT);
  y += 18;
  let soldeNote;
  if (st.totals.balance > 0) soldeNote = 'Montant restant dû par le client.';
  else if (st.totals.balance < 0) soldeNote = 'Solde en faveur du client.';
  else soldeNote = 'Compte soldé.';
  const noteW = widthOf(F.helvIt, soldeNote, 8.5);
  text(page, soldeNote, totalsX + totalsW - noteW, y, F.helvIt, 8.5, COLOR_MUTED);
  y += 16;

  /* Récapitulatif chiffré à gauche du bloc totaux */
  const recap = st.counts.invoices + ' facture(s) · ' + st.counts.payments + ' règlement(s)'
    + (st.counts.unpaid ? ' · ' + st.counts.unpaid + ' facture(s) en attente de paiement' : '');
  text(page, recap, M_LEFT, y, F.helv, 8.5, COLOR_LIGHT);

  const pdfBytes = await pdf.save();
  return Buffer.from(pdfBytes);
}

/* Montant aligné à droite dans une cellule [x, x+w] */
function drawAmountCell(page, F, x, w, yTop, str, font, color) {
  const tw = widthOf(font, str, 8.5);
  text(page, str, x + w - tw - 4, yTop, font, 8.5, color);
}

/* Montant aligné à droite sur un bord */
function drawAmountRight(page, F, rightX, yTop, str, font, size, color) {
  const tw = widthOf(font, str, size);
  text(page, str, rightX - tw, yTop, font, size, color);
}

/* ─── Header (logo/wordmark + titre) ─── */
function drawHeader(page, F, issuer, logoImg, logoDims, periodText, isContinuation) {
  let y = M_TOP;
  const headerHeight = 78;

  if (logoImg && logoDims) {
    const maxW = 200;
    const maxH = 60;
    const scale = Math.min(maxW / logoDims.width, maxH / logoDims.height, 1);
    const w = logoDims.width * scale;
    const h = logoDims.height * scale;
    page.drawImage(logoImg, { x: M_LEFT, y: yFromTop(y + h), width: w, height: h });
  } else {
    /* Wordmark avec letter-spacing, & en Light — même logique que la facture */
    const wordmarkText = (issuer.wordmarkText || 'ADRIEN & EMILY').toUpperCase();
    const wordmarkSize = 16;
    const wordmarkSpacing = (issuer.wordmarkSpacing != null ? issuer.wordmarkSpacing : 8) * 0.6;
    const parts = wordmarkText.split('&');
    let cx = M_LEFT;
    const baseY = y + 20;
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i].trim();
      if (i > 0) {
        cx += wordmarkSpacing * 2.5;
        const ampSize = wordmarkSize * 1.05;
        page.drawText('&', { x: cx, y: yFromTop(baseY + ampSize * 0.85), font: F.light, size: ampSize, color: COLOR_TEXT });
        cx += widthOf(F.light, '&', ampSize) + wordmarkSpacing * 2.5;
      }
      for (let j = 0; j < part.length; j++) {
        const ch = part[j];
        page.drawText(ch, { x: cx, y: yFromTop(baseY + wordmarkSize * 0.85), font: F.medium, size: wordmarkSize, color: COLOR_TEXT });
        cx += widthOf(F.medium, ch, wordmarkSize) + wordmarkSpacing;
      }
    }
  }

  /* Zone meta droite */
  const metaX = PAGE_W - M_RIGHT - 220;
  const title = isContinuation ? 'RELEVÉ DE COMPTE (SUITE)' : 'RELEVÉ DE COMPTE';
  text(page, title, metaX, y + 4, F.helvBold, isContinuation ? 12 : 15, COLOR_TEXT);
  let metaY = y + (isContinuation ? 22 : 28);
  text(page, 'Édité le ' + formatDateFr(new Date()), metaX, metaY, F.helv, 9, COLOR_MUTED); metaY += 11;
  if (periodText) { text(page, 'Période : ' + periodText, metaX, metaY, F.helv, 9, COLOR_MUTED); metaY += 11; }

  y += headerHeight;
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, y, COLOR_LINE_DARK, 1.2);
  y += 16;
  return y;
}

/* ─── Blocs émetteur / client ─── */
function drawParties(page, F, issuer, st, yStart) {
  let y = yStart;
  const colW = (CONTENT_W - 30) / 2;

  text(page, 'ÉMETTEUR', M_LEFT, y, F.helvBold, 8, COLOR_LIGHT);
  let yE = y + 12;
  text(page, issuer.companyName || '—', M_LEFT, yE, F.helvBold, 11, COLOR_TEXT); yE += 14;
  if (issuer.companyAddress) {
    if (issuer.companyAddress.line1) { text(page, issuer.companyAddress.line1, M_LEFT, yE, F.helv, 9.5, COLOR_TEXT); yE += 12; }
    if (issuer.companyAddress.line2) { text(page, issuer.companyAddress.line2, M_LEFT, yE, F.helv, 9.5, COLOR_TEXT); yE += 12; }
    const cp = (issuer.companyAddress.postalCode || '') + ' ' + (issuer.companyAddress.city || '');
    if (cp.trim()) { text(page, cp, M_LEFT, yE, F.helv, 9.5, COLOR_TEXT); yE += 12; }
  }
  if (issuer.companyEmail) { text(page, issuer.companyEmail, M_LEFT, yE, F.helv, 9.5, COLOR_MUTED); yE += 12; }

  const clientX = M_LEFT + colW + 30;
  text(page, 'CLIENT', clientX, y, F.helvBold, 8, COLOR_LIGHT);
  let yC = y + 12;
  const c = st.client || {};
  text(page, st.clientName || '—', clientX, yC, F.helvBold, 11, COLOR_TEXT); yC += 14;
  const contactName = ((c.contactFirstName || '') + ' ' + (c.contactLastName || '')).trim();
  if (contactName && contactName !== st.clientName) { text(page, contactName, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  const ca = c.address || {};
  if (ca.line1) { text(page, ca.line1, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  if (ca.line2) { text(page, ca.line2, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  const cccp = (ca.postalCode || '') + ' ' + (ca.city || '');
  if (cccp.trim()) { text(page, cccp, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  if (c.siret) { text(page, 'SIRET ' + c.siret, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }
  if (c.vatNumber) { text(page, 'TVA ' + c.vatNumber, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }
  if (c.email) { text(page, c.email, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }

  return Math.max(yE, yC) + 16;
}

/* ─── En-tête du tableau ─── */
function drawTableHead(page, F, yStart) {
  let y = yStart;
  rect(page, M_LEFT, y, CONTENT_W, 20, COLOR_BG_HEADER);
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, y + 20, COLOR_LINE_DARK, 1);
  text(page, 'Date', COL_DATE_X + 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  text(page, 'Pièce', COL_PIECE_X + 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  text(page, 'Libellé', COL_LABEL_X + 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  const hD = 'Débit';
  text(page, hD, COL_DEBIT_X + COL_DEBIT_W - widthOf(F.helvBold, hD, 8) - 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  const hC = 'Crédit';
  text(page, hC, COL_CREDIT_X + COL_CREDIT_W - widthOf(F.helvBold, hC, 8) - 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  const hS = 'Solde';
  text(page, hS, COL_SOLDE_X + COL_SOLDE_W - widthOf(F.helvBold, hS, 8) - 4, y + 6, F.helvBold, 8, COLOR_TEXT);
  return y + 26;
}

/* ─── Footer mentions légales (copie de _billing-pdf.js) ─── */
function drawLegalFooter(page, F, issuer) {
  const yFooter = PAGE_H - M_BOTTOM - 32;
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, yFooter, COLOR_LINE);

  let y = yFooter + 6;
  const lines = [];

  let line1 = issuer.companyName || '';
  if (issuer.companyLegalForm) line1 += ' — ' + issuer.companyLegalForm;
  if (issuer.companyShareCapital) line1 += ' au capital de ' + issuer.companyShareCapital;
  if (line1) lines.push(line1);

  const l2parts = [];
  if (issuer.companySiret) l2parts.push('SIRET ' + issuer.companySiret);
  if (issuer.companyRcs) l2parts.push(issuer.companyRcs);
  if (issuer.companyVatNumber) l2parts.push('TVA intracom. ' + issuer.companyVatNumber);
  if (l2parts.length) lines.push(l2parts.join(' · '));

  if (issuer.companyAddress) {
    const a = issuer.companyAddress;
    const addr = [a.line1, (a.postalCode || '') + ' ' + (a.city || '')].filter(function(s){ return s && s.trim(); }).join(' · ');
    if (addr) lines.push(addr);
  }

  for (let i = 0; i < lines.length; i++) {
    const w = widthOf(F.helv, lines[i], 7.5);
    text(page, lines[i], M_LEFT + (CONTENT_W - w) / 2, y, F.helv, 7.5, COLOR_LIGHT);
    y += 9;
  }
}

module.exports = { generateStatementPdf: generateStatementPdf };
