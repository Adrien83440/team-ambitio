/**
 * api/_billing-pdf.js
 *
 * Génération du PDF facture conforme avec pdf-lib.
 *
 * Layout :
 *   Page 1     — Facture (header + meta + émetteur/client + lignes + totaux
 *                + bloc paiement + footer mentions légales)
 *   Page 1bis+ — "Facture (suite)" si les lignes débordent
 *   Pages CGV  — Conditions Générales de Facturation embarquées avec
 *                titre + version + date d'effet + texte intégral
 *
 * Snapshots : la fonction reçoit `issuer` (snapshot _config/billing) et
 * `cgv` (snapshot CGV active à la validation). Aucune donnée vivante n'est
 * relue depuis Firestore — tout doit être capté avant l'appel.
 */

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');

/* ─── Constantes layout ─── */
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

/* ─── Sanitization WinAnsi ─────────────────────────────────────────────
   Helvetica (StandardFonts) supporte uniquement WinAnsi (Latin-1 + extras).
   Si Montserrat n'a pas pu charger et qu'on tombe en fallback Helvetica,
   les caractères Unicode étendus (apostrophe typo, guillemets typo, œ, etc.)
   font planter drawText avec "WinAnsi cannot encode <char>".
   
   sanitizeForPdf() remplace systématiquement les caractères problématiques
   par leurs équivalents WinAnsi-safe AVANT tout drawText. Appliqué à toutes
   les strings clients (noms, descriptions, adresses) qui peuvent contenir
   des apostrophes typographiques (Land'Ocean, etc.).
   ──────────────────────────────────────────────────────────────────── */
const _PDF_SANITIZE_MAP = {
  /* Apostrophes et guillemets typographiques → ASCII */
  '\u2018': "'", '\u2019': "'", '\u201A': "'", '\u201B': "'",
  '\u201C': '"', '\u201D': '"', '\u201E': '"', '\u201F': '"',
  '\u2032': "'", '\u2033': '"', '\u2035': "'", '\u2036': '"',
  /* Tirets typographiques → ASCII (inclut U+2212 signe moins mathématique) */
  '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2015': '-', '\u2212': '-',
  /* Ellipsis → trois points */
  '\u2026': '...',
  /* Espaces non-cassables et spéciaux → espace normal */
  '\u00A0': ' ', '\u2007': ' ', '\u2009': ' ', '\u200A': ' ', '\u202F': ' ',
  /* Ligatures latines → décomposées */
  '\u0153': 'oe', '\u0152': 'OE',
  '\u00E6': 'ae', '\u00C6': 'AE',
  /* Caractères de contrôle invisibles → vide */
  '\u200B': '', '\u200C': '', '\u200D': '', '\uFEFF': '',
  /* Symboles divers à approximer */
  '\u2022': '-', '\u2023': '-', '\u25E6': '-', '\u2043': '-',
  '\u2122': '(TM)', '\u00AE': '(R)', '\u00A9': '(C)',
};

/* Codepoints Unicode > U+00FF qui restent encodables par WinAnsi (CP1252).
   On les préserve tels quels (le reste de la map les convertit en ASCII).
   Le € est le cas critique des factures. */
const _WINANSI_EXTRA = ['\u20AC' /* € */, '\u0192' /* ƒ */, '\u2020' /* † */, '\u2021' /* ‡ */, '\u2030' /* ‰ */];

function sanitizeForPdf(str) {
  if (str == null) return '';
  let s = String(str);
  /* Remplacement caractère par caractère via la map */
  for (const k in _PDF_SANITIZE_MAP) {
    if (s.indexOf(k) >= 0) s = s.split(k).join(_PDF_SANITIZE_MAP[k]);
  }
  /* Filet de sécurité : tout caractère hors WinAnsi (Windows-1252) → '?'.
     C'est ce qui causait le crash "WinAnsi cannot encode". Mieux vaut un '?'
     qu'un PDF qui ne se génère pas.
     ATTENTION : certains codepoints > U+00FF SONT encodables en WinAnsi
     (positions 0x80-0x9F de CP1252) — il ne faut surtout PAS les détruire.
     Le plus important : € (U+20AC). On les préserve explicitement. */
  s = s.replace(/[\u0100-\uFFFF]/g, function(ch) {
    return _WINANSI_EXTRA.indexOf(ch) >= 0 ? ch : '?';
  });
  return s;
}


/**
 * Mesure de largeur SÛRE : sanitize la chaîne avant de la mesurer.
 * pdf-lib lève "WinAnsi cannot encode <char>" dès qu'on mesure (ou dessine)
 * une chaîne contenant un caractère hors WinAnsi avec une StandardFont
 * (Helvetica). Tous les widthOfTextAtSize du fichier passent par ici pour
 * garantir une cohérence parfaite avec ce que text() dessinera réellement.
 */
function widthOf(font, str, size) {
  return font.widthOfTextAtSize(sanitizeForPdf(str == null ? '' : String(str)), size);
}

/* ─── Helpers de tracé ─── */

/** Convertit y "depuis le haut" en y pdf-lib (origine bas-gauche). */
function yFromTop(yTop) { return PAGE_H - yTop; }

/** Trace une ligne horizontale. */
function hLine(page, x1, x2, yTop, color, thickness) {
  page.drawLine({
    start: { x: x1, y: yFromTop(yTop) },
    end:   { x: x2, y: yFromTop(yTop) },
    thickness: thickness || 0.5,
    color: color || COLOR_LINE,
  });
}

/** Trace un rectangle plein. */
function rect(page, x, yTop, w, h, color) {
  page.drawRectangle({ x: x, y: yFromTop(yTop + h), width: w, height: h, color: color });
}

/** Trace du texte simple à la position (depuis le haut).
    Applique sanitizeForPdf systématiquement pour éviter les crashs Helvetica. */
function text(page, str, x, yTop, font, size, color) {
  page.drawText(sanitizeForPdf(str), { x: x, y: yFromTop(yTop + size * 0.85), font: font, size: size, color: color || COLOR_TEXT });
}

/**
 * Trace du texte avec letter-spacing manuel (caractère par caractère).
 * Utilisé pour le wordmark.
 */
function textSpaced(page, str, x, yTop, font, size, color, spacing) {
  const safeStr = sanitizeForPdf(str);
  let cx = x;
  const yPdf = yFromTop(yTop + size * 0.85);
  for (let i = 0; i < safeStr.length; i++) {
    const ch = safeStr[i];
    page.drawText(ch, { x: cx, y: yPdf, font: font, size: size, color: color || COLOR_TEXT });
    cx += widthOf(font, ch, size) + (spacing || 0);
  }
  return cx - x;
}

/**
 * Word-wrap simple. Découpe le texte en lignes qui tiennent dans maxWidth.
 */
function wrapText(str, font, size, maxWidth) {
  if (!str) return [''];
  /* Sanitization en entrée pour que le calcul de largeur soit cohérent
     avec ce qui sera réellement affiché par text() (qui sanitize aussi). */
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

/** Trace du texte multi-ligne ; renvoie la nouvelle position y. */
function textBlock(page, str, x, yTop, font, size, color, maxWidth, lineHeight) {
  const lines = wrapText(str, font, size, maxWidth);
  const lh = lineHeight || size * 1.4;
  for (let i = 0; i < lines.length; i++) {
    text(page, lines[i], x, yTop + i * lh, font, size, color);
  }
  return yTop + lines.length * lh;
}

/* ─── Format helpers ─── */
function formatEur(n) {
  if (n == null || isNaN(n)) return '0,00 €';
  /* Formatage manuel : séparateur de milliers = ESPACE NORMAL (U+0020).
     On évite toLocaleString('fr-FR') qui insère une espace fine insécable
     (U+202F), non encodable par Helvetica/WinAnsi → "WinAnsi cannot encode 0x202f". */
  const num = Number(n);
  const neg = num < 0;
  const fixed = Math.abs(num).toFixed(2);
  const dot = fixed.indexOf('.');
  const intPart = fixed.slice(0, dot);
  const decPart = fixed.slice(dot + 1);
  const withThousands = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return (neg ? '-' : '') + withThousands + ',' + decPart + ' \u20AC';
}

function formatDateFr(d) {
  if (!d) return '—';
  const dt = d instanceof Date ? d : (d.toDate ? d.toDate() : new Date(d));
  return dt.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function formatIban(iban) {
  if (!iban) return '';
  return String(iban).replace(/\s/g, '').toUpperCase().replace(/(.{4})/g, '$1 ').trim();
}

/* ─── Génération PDF principale ─── */

/**
 * @param {object} args
 * @param {object} args.invoice        - Données facture (avec snapshots déjà attachés)
 * @param {object} args.issuer         - Snapshot émetteur (config _config/billing)
 * @param {object} args.cgv            - Snapshot CGV active (version + text)
 * @param {Buffer|null} args.logoBuf   - Logo image bytes si configuré (sinon null → wordmark)
 * @param {object} args.fonts          - { light, regular, medium } Buffers Montserrat (peut être null)
 *
 * @returns {Promise<Buffer>} bytes du PDF
 */
async function generateInvoicePdf(args) {
  const invoice = args.invoice;
  const issuer = args.issuer;
  const cgv = args.cgv;
  const logoBuf = args.logoBuf;
  const fontBytes = args.fonts;

  const pdf = await PDFDocument.create();
  pdf.registerFontkit(fontkit);

  /* Embed fonts */
  const helvetica = await pdf.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const helveticaOblique = await pdf.embedFont(StandardFonts.HelveticaOblique);

  let montLight = helvetica, montRegular = helvetica, montMedium = helveticaBold;
  if (fontBytes && fontBytes.light && fontBytes.regular && fontBytes.medium) {
    try {
      montLight = await pdf.embedFont(fontBytes.light);
      montRegular = await pdf.embedFont(fontBytes.regular);
      montMedium = await pdf.embedFont(fontBytes.medium);
    } catch (e) {
      console.warn('[billing-pdf] Failed to embed Montserrat, using Helvetica fallback:', e.message);
    }
  }

  const F = {
    light: montLight,
    regular: montRegular,
    medium: montMedium,
    helv: helvetica,
    helvBold: helveticaBold,
    helvIt: helveticaOblique,
  };

  /* Embed logo image si présent */
  let logoImg = null;
  let logoDims = null;
  if (logoBuf) {
    try {
      /* Détection automatique PNG vs JPG */
      const sig = logoBuf.slice(0, 4);
      if (sig[0] === 0x89 && sig[1] === 0x50 && sig[2] === 0x4E && sig[3] === 0x47) {
        logoImg = await pdf.embedPng(logoBuf);
      } else {
        logoImg = await pdf.embedJpg(logoBuf);
      }
      logoDims = logoImg.scale(1);
    } catch (e) {
      console.warn('[billing-pdf] Logo embed failed:', e.message);
    }
  }

  /* ═══ PAGE 1 — FACTURE ═══ */
  const page1 = pdf.addPage([PAGE_W, PAGE_H]);
  let cursorY = drawInvoicePage(page1, F, invoice, issuer, cgv, logoImg, logoDims, false);

  /* Si le contenu lignes a débordé sur cursorY, on a déjà eu une page 2 ajoutée
     par drawInvoiceLines ; voir gestion à l'intérieur. */

  /* ═══ PAGES CGV ═══ */
  if (cgv && cgv.text) {
    drawCgvPages(pdf, F, cgv, issuer);
  }

  const pdfBytes = await pdf.save();
  return Buffer.from(pdfBytes);
}

/* ─── Tracé page 1 (facture) ─── */
function drawInvoicePage(page, F, invoice, issuer, cgv, logoImg, logoDims, isContinuation) {
  let y = M_TOP;

  /* HEADER : zone logo (gauche) + zone meta (droite) */
  const headerHeight = 90;

  /* — Zone logo gauche — */
  if (logoImg && logoDims) {
    /* Scale pour fit dans 200x70 */
    const maxW = 200;
    const maxH = 70;
    let scale = Math.min(maxW / logoDims.width, maxH / logoDims.height, 1);
    const w = logoDims.width * scale;
    const h = logoDims.height * scale;
    page.drawImage(logoImg, {
      x: M_LEFT,
      y: yFromTop(y + h),
      width: w,
      height: h,
    });
  } else {
    /* Wordmark "ADRIEN & EMILY" stylisé */
    const wordmarkText = (issuer.wordmarkText || 'ADRIEN & EMILY').toUpperCase();
    const wordmarkSize = 18;
    const wordmarkSpacing = (issuer.wordmarkSpacing != null ? issuer.wordmarkSpacing : 8) * 0.6;
    /* Le & est tracé en font Light (plus fin) si Montserrat dispo */
    const parts = wordmarkText.split('&');
    let cx = M_LEFT;
    const baseY = y + 25;
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

  /* — Zone meta droite — */
  const metaX = PAGE_W - M_RIGHT - 200;
  const metaW = 200;
  text(page, isContinuation ? 'FACTURE (SUITE)' : 'FACTURE', metaX, y + 4, F.helvBold, 16, COLOR_TEXT);
  let metaY = y + 30;
  const num = invoice.number || 'BROUILLON';
  text(page, 'N° ' + num, metaX, metaY, F.helvBold, 10, COLOR_TEXT); metaY += 14;
  text(page, 'Émise le ' + formatDateFr(invoice.issueDate), metaX, metaY, F.helv, 9, COLOR_MUTED); metaY += 11;
  text(page, 'Échéance ' + formatDateFr(invoice.dueDate), metaX, metaY, F.helv, 9, COLOR_MUTED); metaY += 11;
  if (invoice.poNumber) { text(page, 'N° commande : ' + invoice.poNumber, metaX, metaY, F.helv, 9, COLOR_MUTED); metaY += 11; }

  y += headerHeight;
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, y, COLOR_LINE_DARK, 1.2);
  y += 18;

  if (isContinuation) return y;

  /* BLOCS ÉMETTEUR / CLIENT */
  const blocksTop = y;
  const colW = (CONTENT_W - 30) / 2;

  /* Émetteur */
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
  if (issuer.companyPhone) { text(page, issuer.companyPhone, M_LEFT, yE, F.helv, 9.5, COLOR_MUTED); yE += 12; }

  /* Client */
  const clientX = M_LEFT + colW + 30;
  text(page, 'CLIENT', clientX, y, F.helvBold, 8, COLOR_LIGHT);
  let yC = y + 12;
  const c = invoice.clientSnapshot || {};
  const clientName = c.clientType === 'company' ? (c.companyName || '—') : ((c.contactFirstName || '') + ' ' + (c.contactLastName || '')).trim() || '—';
  text(page, clientName, clientX, yC, F.helvBold, 11, COLOR_TEXT); yC += 14;
  if (c.clientType === 'company' && (c.contactFirstName || c.contactLastName)) {
    const contactName = ((c.contactFirstName || '') + ' ' + (c.contactLastName || '')).trim();
    if (contactName) { text(page, contactName, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  }
  const ca = c.address || {};
  if (ca.line1) { text(page, ca.line1, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  if (ca.line2) { text(page, ca.line2, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  const cccp = (ca.postalCode || '') + ' ' + (ca.city || '');
  if (cccp.trim()) { text(page, cccp, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  if (ca.country && ca.country !== 'France') { text(page, ca.country, clientX, yC, F.helv, 9.5, COLOR_TEXT); yC += 12; }
  if (c.siret) { text(page, 'SIRET ' + c.siret, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }
  if (c.vatNumber) { text(page, 'TVA ' + c.vatNumber, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }
  if (c.email) { text(page, c.email, clientX, yC, F.helv, 9, COLOR_MUTED); yC += 11; }

  y = Math.max(yE, yC) + 18;

  /* TABLEAU LIGNES */
  y = drawInvoiceLines(page, F, invoice, y);

  /* TOTAUX (à droite) */
  y += 6;
  const totalsX = PAGE_W - M_RIGHT - 230;
  const totalsW = 230;
  const lh = 14;

  if (invoice.totalDiscount && invoice.totalDiscount > 0) {
    text(page, 'Sous-total brut HT', totalsX, y, F.helv, 9.5, COLOR_MUTED);
    text(page, formatEur(invoice.totalGrossHt), totalsX + totalsW - widthOf(F.helvBold, formatEur(invoice.totalGrossHt), 9.5), y, F.helvBold, 9.5, COLOR_TEXT);
    y += lh;
    text(page, 'Remise', totalsX, y, F.helv, 9.5, COLOR_MUTED);
    const discStr = '−' + formatEur(invoice.totalDiscount);
    text(page, discStr, totalsX + totalsW - widthOf(F.helvBold, discStr, 9.5), y, F.helvBold, 9.5, COLOR_AMBER);
    y += lh;
  }

  hLine(page, totalsX, totalsX + totalsW, y, COLOR_LINE);
  y += 6;
  text(page, 'Total HT', totalsX, y, F.helvBold, 10, COLOR_TEXT);
  text(page, formatEur(invoice.totalHt), totalsX + totalsW - widthOf(F.helvBold, formatEur(invoice.totalHt), 10), y, F.helvBold, 10, COLOR_TEXT);
  y += lh;

  /* Ventilation TVA */
  const vatBreakdown = invoice.vatBreakdown || [];
  for (let i = 0; i < vatBreakdown.length; i++) {
    const v = vatBreakdown[i];
    text(page, 'TVA ' + v.rate + ' %', totalsX, y, F.helv, 9.5, COLOR_MUTED);
    const vStr = formatEur(v.vat);
    text(page, vStr, totalsX + totalsW - widthOf(F.helvBold, vStr, 9.5), y, F.helvBold, 9.5, COLOR_TEXT);
    y += lh;
  }

  /* Total TTC */
  hLine(page, totalsX, totalsX + totalsW, y, COLOR_LINE_DARK, 1.2);
  y += 8;
  text(page, 'Total TTC', totalsX, y, F.helvBold, 13, COLOR_TEXT);
  const ttcStr = formatEur(invoice.totalTtc);
  text(page, ttcStr, totalsX + totalsW - widthOf(F.helvBold, ttcStr, 13), y, F.helvBold, 13, COLOR_TEXT);
  y += 22;

  /* BLOC PAIEMENT */
  y = drawPaymentBlock(page, F, invoice, issuer, y);

  /* NOTES PUBLIQUES */
  if (invoice.notesPublic) {
    y += 8;
    hLine(page, M_LEFT, PAGE_W - M_RIGHT, y, COLOR_LINE);
    y += 6;
    const noteLines = wrapText(invoice.notesPublic, F.helvIt, 9, CONTENT_W);
    for (let i = 0; i < noteLines.length; i++) {
      text(page, noteLines[i], M_LEFT, y, F.helvIt, 9, COLOR_MUTED);
      y += 12;
    }
  }

  /* FOOTER MENTIONS LÉGALES */
  drawLegalFooter(page, F, issuer);

  return y;
}

/* ─── Tableau lignes ─── */
function drawInvoiceLines(page, F, invoice, yStart) {
  const lines = invoice.lines || [];
  let y = yStart;

  /* Définition colonnes */
  const colDescW = 240;
  const colQtyW = 40;
  const colUnitW = 50;
  const colPuW = 70;
  const colVatW = 40;
  const colTotalW = CONTENT_W - colDescW - colQtyW - colUnitW - colPuW - colVatW;

  const colDescX = M_LEFT;
  const colQtyX = colDescX + colDescW;
  const colUnitX = colQtyX + colQtyW;
  const colPuX = colUnitX + colUnitW;
  const colVatX = colPuX + colPuW;
  const colTotalX = colVatX + colVatW;

  /* Header tableau */
  rect(page, M_LEFT, y, CONTENT_W, 22, COLOR_BG_HEADER);
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, y + 22, COLOR_LINE_DARK, 1);
  text(page, 'Description', colDescX + 6, y + 7, F.helvBold, 8, COLOR_TEXT);
  /* Right-aligned headers */
  const hQty = 'Qté';
  text(page, hQty, colQtyX + colQtyW - widthOf(F.helvBold, hQty, 8) - 4, y + 7, F.helvBold, 8, COLOR_TEXT);
  text(page, 'Unité', colUnitX + 4, y + 7, F.helvBold, 8, COLOR_TEXT);
  const hPu = 'PU HT';
  text(page, hPu, colPuX + colPuW - widthOf(F.helvBold, hPu, 8) - 4, y + 7, F.helvBold, 8, COLOR_TEXT);
  const hVat = 'TVA';
  text(page, hVat, colVatX + colVatW - widthOf(F.helvBold, hVat, 8) - 4, y + 7, F.helvBold, 8, COLOR_TEXT);
  const hTot = 'Total HT';
  text(page, hTot, colTotalX + colTotalW - widthOf(F.helvBold, hTot, 8) - 4, y + 7, F.helvBold, 8, COLOR_TEXT);

  y += 26;

  /* Lignes */
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];

    /* Calculer la hauteur estimée de la ligne (description peut wraper) */
    const descTitle = l.productName || (l.description || '—').substring(0, 80);
    const descSubtitle = (l.description && l.description !== l.productName) ? l.description : '';
    const descWithVariant = descSubtitle && l.variantLabel ? l.variantLabel + ' — ' + descSubtitle : descSubtitle;
    const subLines = wrapText(descWithVariant, F.helv, 8.5, colDescW - 8);
    const lineHeight = 18 + (subLines.length > 0 ? subLines.length * 10 : 0) + (l.discountPct > 0 ? 10 : 0);

    /* Tracé */
    text(page, descTitle, colDescX + 6, y, F.helvBold, 9.5, COLOR_TEXT);
    let subY = y + 12;
    for (let s = 0; s < subLines.length; s++) {
      text(page, subLines[s], colDescX + 6, subY, F.helv, 8.5, COLOR_MUTED);
      subY += 10;
    }
    if (l.discountPct > 0) {
      text(page, 'Remise ' + l.discountPct + ' %', colDescX + 6, subY, F.helvIt, 8.5, COLOR_AMBER);
      subY += 10;
    }

    /* Cellules right-aligned */
    const qtyStr = String(l.qty != null ? l.qty : 0);
    text(page, qtyStr, colQtyX + colQtyW - widthOf(F.helv, qtyStr, 9.5) - 4, y, F.helv, 9.5, COLOR_TEXT);

    text(page, l.unit || 'forfait', colUnitX + 4, y, F.helv, 9.5, COLOR_TEXT);

    const puStr = formatEur(l.unitPriceHt || 0);
    text(page, puStr, colPuX + colPuW - widthOf(F.helv, puStr, 9.5) - 4, y, F.helv, 9.5, COLOR_TEXT);

    const vatStr = (l.vatRate != null ? l.vatRate : 20) + ' %';
    text(page, vatStr, colVatX + colVatW - widthOf(F.helv, vatStr, 9.5) - 4, y, F.helv, 9.5, COLOR_TEXT);

    const lineHt = (l.lineHtAfterDiscount != null ? l.lineHtAfterDiscount : computeLineHtFallback(l));
    const totStr = formatEur(lineHt);
    text(page, totStr, colTotalX + colTotalW - widthOf(F.helvBold, totStr, 9.5) - 4, y, F.helvBold, 9.5, COLOR_TEXT);

    y += lineHeight;
    hLine(page, M_LEFT, PAGE_W - M_RIGHT, y - 4, COLOR_LINE);
  }

  return y;
}

function computeLineHtFallback(l) {
  const qty = parseFloat(l.qty != null ? l.qty : 1);
  const pu = parseFloat(l.unitPriceHt != null ? l.unitPriceHt : 0);
  const disc = parseFloat(l.discountPct || 0);
  const gross = qty * pu;
  const after = gross - (gross * disc / 100);
  return Math.round(after * 100) / 100;
}

/* ─── Bloc paiement ─── */
function drawPaymentBlock(page, F, invoice, issuer, yStart) {
  let y = yStart;

  /* Background subtle */
  const blockH = 90;
  rect(page, M_LEFT, y, CONTENT_W, blockH, rgb(0.98, 0.98, 0.98));
  page.drawLine({
    start: { x: M_LEFT, y: yFromTop(y + blockH) },
    end:   { x: M_LEFT, y: yFromTop(y) },
    thickness: 2,
    color: COLOR_LINE_DARK,
  });

  text(page, 'CONDITIONS DE PAIEMENT', M_LEFT + 12, y + 8, F.helvBold, 8, COLOR_LIGHT);
  let py = y + 22;

  const paymentLabels = {
    gocardless: 'Prélèvement automatique (mandat SEPA GoCardless)',
    transfer: 'Virement bancaire',
    card: 'Carte bancaire',
    other: 'Selon accord',
  };
  text(page, 'Mode de paiement : ', M_LEFT + 12, py, F.helvBold, 9, COLOR_TEXT);
  text(page, paymentLabels[invoice.paymentMethod] || invoice.paymentMethod || '—', M_LEFT + 12 + widthOf(F.helvBold, 'Mode de paiement : ', 9), py, F.helv, 9, COLOR_TEXT);
  py += 12;

  text(page, 'Échéance : ', M_LEFT + 12, py, F.helvBold, 9, COLOR_TEXT);
  const echeStr = formatDateFr(invoice.dueDate) + (invoice.paymentTermsDays != null ? ' (' + invoice.paymentTermsDays + ' jours)' : '');
  text(page, echeStr, M_LEFT + 12 + widthOf(F.helvBold, 'Échéance : ', 9), py, F.helv, 9, COLOR_TEXT);
  py += 12;

  if (invoice.paymentMethod === 'transfer' && issuer.iban) {
    text(page, 'IBAN : ', M_LEFT + 12, py, F.helvBold, 9, COLOR_TEXT);
    text(page, formatIban(issuer.iban), M_LEFT + 12 + widthOf(F.helvBold, 'IBAN : ', 9), py, F.helv, 9, COLOR_TEXT);
    py += 12;
    if (issuer.bic) {
      text(page, 'BIC : ', M_LEFT + 12, py, F.helvBold, 9, COLOR_TEXT);
      const bicStr = issuer.bic + (issuer.bankName ? ' · ' + issuer.bankName : '');
      text(page, bicStr, M_LEFT + 12 + widthOf(F.helvBold, 'BIC : ', 9), py, F.helv, 9, COLOR_TEXT);
      py += 12;
    }
  }

  /* Mentions de pénalités obligatoires */
  py += 4;
  const lateFeeRate = issuer.defaultLateFeeRate != null ? issuer.defaultLateFeeRate : 3;
  const lateFeePenalty = issuer.defaultLateFeePenalty != null ? issuer.defaultLateFeePenalty : 40;
  const penaltyText = 'Pénalités de retard : ' + lateFeeRate + ' fois le taux d\'intérêt légal en vigueur. Indemnité forfaitaire pour frais de recouvrement : ' + lateFeePenalty + ' € (art. L441-10 et D441-5 du Code de commerce). Pas d\'escompte pour paiement anticipé.';
  const penaltyLines = wrapText(penaltyText, F.helv, 7.5, CONTENT_W - 24);
  for (let i = 0; i < penaltyLines.length; i++) {
    text(page, penaltyLines[i], M_LEFT + 12, py, F.helv, 7.5, COLOR_LIGHT);
    py += 9;
  }

  return Math.max(y + blockH, py) + 6;
}

/* ─── Footer mentions légales ─── */
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
    const addr = [a.line1, a.postalCode + ' ' + (a.city || '')].filter(function(s){ return s && s.trim(); }).join(' · ');
    if (addr) lines.push(addr);
  }

  for (let i = 0; i < lines.length; i++) {
    const w = widthOf(F.helv, lines[i], 7.5);
    text(page, lines[i], M_LEFT + (CONTENT_W - w) / 2, y, F.helv, 7.5, COLOR_LIGHT);
    y += 9;
  }
}

/* ─── Pages CGV ─── */
function drawCgvPages(pdf, F, cgv, issuer) {
  const cgvText = cgv.text || '';
  if (!cgvText.trim()) return;

  const cgvSize = 8;
  const cgvLineHeight = 11;
  const cgvParaGap = 6;

  /* Splitter par paragraphes (double saut de ligne ou ligne vide) */
  const paragraphs = cgvText.split(/\n\s*\n/).map(function(p){ return p.trim(); }).filter(function(p){ return p; });

  let page = pdf.addPage([PAGE_W, PAGE_H]);
  let y = M_TOP;

  /* Header de la page CGV */
  text(page, 'CONDITIONS GÉNÉRALES DE FACTURATION', M_LEFT, y, F.helvBold, 11, COLOR_TEXT);
  y += 16;
  const versionStr = 'Version ' + (cgv.version || '1.0') + (cgv.activeFrom ? ' — en vigueur depuis le ' + formatDateFr(cgv.activeFrom) : '');
  text(page, versionStr, M_LEFT, y, F.helv, 8.5, COLOR_MUTED);
  y += 12;
  hLine(page, M_LEFT, PAGE_W - M_RIGHT, y, COLOR_LINE);
  y += 14;

  const maxY = PAGE_H - M_BOTTOM - 20;

  for (let p = 0; p < paragraphs.length; p++) {
    const para = paragraphs[p];

    /* Détection titre : ligne courte commençant par majuscule ou un numéro d'article */
    const isHeading = /^(article\s+\d+|chapitre\s+\d+|[A-Z][A-Z\s\-\dé&'"-]{2,40})$/i.test(para.split('\n')[0].trim()) && para.split('\n').length === 1 && para.length < 80;

    const font = isHeading ? F.helvBold : F.helv;
    const size = isHeading ? 9 : cgvSize;
    const color = isHeading ? COLOR_TEXT : COLOR_TEXT;

    const lines = wrapText(para, font, size, CONTENT_W);
    /* Estimer si ça tient sur la page */
    const needed = lines.length * cgvLineHeight + cgvParaGap;
    if (y + needed > maxY) {
      page = pdf.addPage([PAGE_W, PAGE_H]);
      y = M_TOP;
      text(page, 'CONDITIONS GÉNÉRALES DE FACTURATION (suite)', M_LEFT, y, F.helvBold, 9, COLOR_LIGHT);
      y += 16;
      hLine(page, M_LEFT, PAGE_W - M_RIGHT, y - 4, COLOR_LINE);
      y += 6;
    }

    if (isHeading) y += 4;

    for (let i = 0; i < lines.length; i++) {
      if (y > maxY) {
        page = pdf.addPage([PAGE_W, PAGE_H]);
        y = M_TOP;
        text(page, 'CONDITIONS GÉNÉRALES DE FACTURATION (suite)', M_LEFT, y, F.helvBold, 9, COLOR_LIGHT);
        y += 16;
        hLine(page, M_LEFT, PAGE_W - M_RIGHT, y - 4, COLOR_LINE);
        y += 6;
      }
      text(page, lines[i], M_LEFT, y, font, size, color);
      y += cgvLineHeight;
    }
    y += cgvParaGap;
  }

  /* Numérotation pages CGV */
  /* Optionnel pour Step 2B-1 ; ajout possible plus tard si besoin */
}

module.exports = { generateInvoicePdf: generateInvoicePdf };
