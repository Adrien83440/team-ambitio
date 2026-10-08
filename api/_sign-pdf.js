// ============================================================================
// api/_sign-pdf.js — LE CONTRAT SIGNÉ, GÉNÉRÉ PAR LE SERVEUR
// ----------------------------------------------------------------------------
// Le PDF final est le PDF du modèle, À L'IDENTIQUE, sur lequel le serveur
// appose ce que le signataire a saisi dans le parcours web, aux emplacements
// définis dans l'éditeur de modèles (sales-signatures.html) :
//   · texte (société, SIRET, siège, représentant, date, « Lu et approuvé »)
//   · paraphe sur chaque page prévue, signature manuscrite tracée
//   · cases : une vraie case dessinée, cochée ou vide — jamais un « X » seul
// Suivent les pages du DOSSIER DE PREUVE (identité, vérification SMS,
// déclarations, mentions, chronologie complète, empreintes), puis le fichier
// entier est scellé par un horodatage RFC 3161 intégré (DocTimeStamp, lisible
// dans le panneau « Signatures » d'Adobe Reader). Toute modification du
// fichier après coup invalide ce sceau.
//
// Rien de tout ça ne se fait dans le navigateur du signataire : ce qu'il
// envoie est revalidé, puis le serveur fabrique, empreinte et horodate.
// ============================================================================

const { PDFDocument, StandardFonts, rgb, degrees, PDFName, PDFNumber, PDFHexString, PDFString, PDFArray, PDFDict } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const { timestamp } = require('./_tsa');

const INK = rgb(0.06, 0.09, 0.22);
const NAVY = rgb(0.06, 0.09, 0.16);
const INDIGO = rgb(0.31, 0.27, 0.9);
const MUTED = rgb(0.39, 0.45, 0.55);
const LINE = rgb(0.89, 0.91, 0.94);
const SOFT = rgb(0.97, 0.98, 0.99);
const GREEN = rgb(0.02, 0.59, 0.41);
const RED = rgb(0.86, 0.15, 0.15);

/* ── Polices ─────────────────────────────────────────────────────────────── */
/* Montserrat, découpe « latin » de Fontsource (≈ 48 Ko par graisse, tout le
   français : accents, œ, ’ « » € … —). Les URL « static » du dépôt Google
   Fonts qu'utilise api/_billing-fonts.js répondent 404 depuis que Google n'y
   publie plus que la police variable : on ne s'appuie pas dessus ici.
   Cache module : un seul téléchargement par conteneur Vercel chaud. */
const FONT_SOURCES = {
  regular: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-400-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Regular.ttf'],
  medium: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-500-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-Medium.ttf'],
  bold: ['https://cdn.jsdelivr.net/fontsource/fonts/montserrat@latest/latin-600-normal.ttf',
    'https://raw.githubusercontent.com/JulietaUla/Montserrat/master/fonts/ttf/Montserrat-SemiBold.ttf'],
};
let _fontCache = null;
async function fetchFirst(urls) {
  let last = null;
  for (const u of urls) {
    try {
      const r = await fetch(u, { signal: AbortSignal.timeout(6000) });
      if (r.ok) return Buffer.from(await r.arrayBuffer());
      last = new Error('HTTP ' + r.status + ' ' + u);
    } catch (e) { last = e; }
  }
  throw last || new Error('police introuvable');
}
async function loadFonts() {
  if (_fontCache) return _fontCache;
  const b = await Promise.all([fetchFirst(FONT_SOURCES.regular), fetchFirst(FONT_SOURCES.medium), fetchFirst(FONT_SOURCES.bold)]);
  _fontCache = { regular: b[0], medium: b[1], bold: b[2] };
  return _fontCache;
}

async function embedFonts(doc) {
  doc.registerFontkit(fontkit);
  try {
    const f = await loadFonts();
    /* liga:false — la découpe « latin » n'a pas de glyphe pour la ligature
       « fi » : sans ça, « vérification » s'imprimerait « vérifi cation ». */
    const opt = { features: { liga: false } };
    const regular = await doc.embedFont(f.regular, opt);
    const medium = await doc.embedFont(f.medium, opt);
    const bold = await doc.embedFont(f.bold, opt);
    return { regular: regular, medium: medium, bold: bold, unicode: true };
  } catch (e) {
    console.warn('[sign-pdf] Montserrat indisponible, repli Helvetica :', e && e.message);
    return {
      regular: await doc.embedFont(StandardFonts.Helvetica),
      medium: await doc.embedFont(StandardFonts.Helvetica),
      bold: await doc.embedFont(StandardFonts.HelveticaBold),
      unicode: false,
    };
  }
}

/* Espaces insécables fines (toLocaleString) et symboles absents des polices :
   on les remplace AVANT toute mesure, sinon widthOfTextAtSize lève. En repli
   Helvetica (WinAnsi), tout ce qui n'est pas encodable devient « ? ». */
const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
function clean(fonts, s) {
  let t = String(s == null ? '' : s)
    .replace(/[    ]/g, ' ')
    .replace(/⚠️?/g, '(!)')
    .replace(/[✓✔]/g, 'v')
    .replace(/[\u{1F000}-\u{1FFFF}]/gu, '')
    .replace(/[\r\t]/g, ' ');
  if (!fonts.unicode) {
    let out = '';
    for (const ch of t) {
      const c = ch.codePointAt(0);
      out += (c < 256 || WINANSI_EXTRA.indexOf(ch) >= 0) ? ch : '?';
    }
    t = out;
  }
  return t;
}

function width(fonts, font, s, size) { return font.widthOfTextAtSize(clean(fonts, s), size); }

/* Plus grande taille (≤ max, ≥ min) à laquelle le texte tient dans maxW. */
function fitSize(fonts, font, s, maxW, max, min) {
  let size = max;
  while (size > min && width(fonts, font, s, size) > maxW) size -= 0.25;
  return size;
}

/* Tronque avec « … » si le texte ne tient toujours pas à la taille minimale. */
function truncate(fonts, font, s, size, maxW) {
  let t = clean(fonts, s);
  if (font.widthOfTextAtSize(t, size) <= maxW) return t;
  while (t.length > 1 && font.widthOfTextAtSize(t + '…', size) > maxW) t = t.slice(0, -1);
  return t + '…';
}

function wrap(fonts, font, text, size, maxW) {
  const out = [];
  clean(fonts, text).split('\n').forEach(function (para) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { out.push(''); return; }
    let line = '';
    words.forEach(function (w) {
      while (font.widthOfTextAtSize(w, size) > maxW && w.length > 1) {
        let cut = w.length;
        while (cut > 1 && font.widthOfTextAtSize(w.slice(0, cut), size) > maxW) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const test = line ? line + ' ' + w : w;
      if (font.widthOfTextAtSize(test, size) <= maxW) line = test;
      else { if (line) out.push(line); line = w; }
    });
    out.push(line);
  });
  return out;
}

/* ── Apposition sur le PDF du modèle ─────────────────────────────────────── */
/* Le texte d'un champ, tel qu'il s'imprime, pour le signataire `S`.
   null = rien à écrire (champ vide facultatif). */
function textFor(f, S, ctx) {
  const c = S.company || {};
  switch (f.fieldType) {
    case 'entreprise': return c.name || '';
    case 'type_entreprise': return c.legalFormLabel || '';
    case 'siege_social':
    case 'adresse': return c.addressLine || '';
    case 'siret': return c.siret || '';
    case 'nom_prenom': return S.repName ? (S.repName + (S.repQualite ? ', ' + S.repQualite : '')) : '';
    case 'email': return S.email || '';
    case 'telephone': return S.phone || '';
    case 'date_signature': return S.date || '';
    case 'lu_approuve': return (S.luApprouve || '') + (ctx.hasDate[S.role] ? '' : (S.date ? ' — le ' + S.date : ''));
    default: return null;
  }
}

function drawBoxText(page, fonts, txt, box, opts) {
  if (!txt) return;
  const font = (opts && opts.font) || fonts.medium;
  const max = Math.max(6, Math.min(box.h * 0.62, (opts && opts.max) || 10.5));
  let size = fitSize(fonts, font, txt, box.w - 4, max, 6);
  const t = truncate(fonts, font, txt, size, box.w - 4);
  const y = box.y + (box.h - size * 0.7) / 2;
  page.drawText(t, { x: box.x + 2, y: y, size: size, font: font, color: INK });
}

function drawFreeText(page, fonts, txt, box) {
  if (!txt) return;
  const font = fonts.regular;
  const maxW = Math.max(4, box.w - 4);
  let size = Math.min(9, Math.max(6, box.h * 0.62));
  let lh = size * 1.25;
  let lines = wrap(fonts, font, txt, size, maxW);
  while (size > 6 && lines.length * lh > box.h - 1) { size -= 0.25; lh = size * 1.25; lines = wrap(fonts, font, txt, size, maxW); }
  const maxLines = Math.max(1, Math.floor((box.h - 1) / lh));
  if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = String(lines[maxLines - 1]).replace(/.$/, '') + '…'; }
  let ty = box.y + box.h - size;
  if (lines.length === 1) ty = box.y + (box.h - size * 0.7) / 2;
  lines.forEach(function (l) {
    if (l) page.drawText(l, { x: box.x + 2, y: ty, size: size, font: font, color: INK });
    ty -= lh;
  });
}

/* Une vraie case : carré dessiné, coche vectorielle si cochée, vide sinon.
   La case vide figure aussi sur le PDF : « non coché » est une information. */
function drawCheckbox(page, checked, box) {
  const s = Math.min(box.w, box.h) * 0.78;
  const x = box.x + (box.w - s) / 2;
  const y = box.y + (box.h - s) / 2;
  page.drawRectangle({ x: x, y: y, width: s, height: s, borderColor: INK, borderWidth: 0.9, color: rgb(1, 1, 1) });
  if (!checked) return;
  page.drawLine({ start: { x: x + s * 0.2, y: y + s * 0.52 }, end: { x: x + s * 0.42, y: y + s * 0.25 }, thickness: Math.max(1.1, s * 0.12), color: INDIGO });
  page.drawLine({ start: { x: x + s * 0.42, y: y + s * 0.25 }, end: { x: x + s * 0.82, y: y + s * 0.78 }, thickness: Math.max(1.1, s * 0.12), color: INDIGO });
}

function drawImageFit(page, img, box) {
  const r = Math.min(box.w / img.width, box.h / img.height);
  const w = img.width * r;
  const h = img.height * r;
  page.drawImage(img, { x: box.x + (box.w - w) / 2, y: box.y + (box.h - h) / 2, width: w, height: h });
}

/* Signature : le tracé, et dessous une mention discrète qui relie l'image à
   la preuve (« Signé électroniquement par … le … · réf. … »). */
function drawSignature(page, fonts, img, box, caption) {
  const cap = box.h >= 36 && caption;
  const capH = cap ? 7 : 0;
  drawImageFit(page, img, { x: box.x, y: box.y + capH, w: box.w, h: box.h - capH });
  if (cap) {
    const size = fitSize(fonts, fonts.regular, caption, box.w, 5, 3.6);
    page.drawText(truncate(fonts, fonts.regular, caption, size, box.w), { x: box.x, y: box.y + 1, size: size, font: fonts.regular, color: MUTED });
  }
}

/* signers : [{ role:1|2, company, repName, repQualite, email, phone, date,
   luApprouve, checks:{id:bool}, texts:{id:str}, signaturePng, paraphePng,
   caption }]. prefill : textes libres remplis par l'équipe à l'envoi. */
async function stampContract(doc, fonts, fields, scale, signers, prefill) {
  const pages = doc.getPages();
  const hasDate = { 1: false, 2: false };
  fields.forEach(function (f) { if (f.fieldType === 'date_signature') hasDate[f.signerRole === 2 ? 2 : 1] = true; });
  const ctx = { hasDate: hasDate };
  const imgs = {};
  for (const S of signers) {
    imgs[S.role] = {
      sig: S.signaturePng ? await doc.embedPng(S.signaturePng) : null,
      par: S.paraphePng ? await doc.embedPng(S.paraphePng) : null,
    };
  }
  const byRole = {};
  signers.forEach(function (S) { byRole[S.role] = S; });
  const placed = { 1: { signature: false }, 2: { signature: false } };

  fields.forEach(function (f) {
    const pi = (f.page || 1) - 1;
    if (pi < 0 || pi >= pages.length) return;
    const role = f.signerRole === 2 ? 2 : 1;
    const page = pages[pi];
    const ph = page.getHeight();
    const box = { x: f.x / scale, y: ph - f.y / scale - f.h / scale, w: f.w / scale, h: f.h / scale };

    /* Texte libre rempli par l'équipe : il appartient au contrat, pas à un
       signataire — on l'écrit quel que soit le rôle du champ. */
    if (f.fieldType === 'texte_libre' && prefill && prefill[f.id]) { drawFreeText(page, fonts, prefill[f.id], box); return; }

    const S = byRole[role];
    if (!S) return;
    const I = imgs[role] || {};
    if (f.fieldType === 'signature') { if (I.sig) { drawSignature(page, fonts, I.sig, box, S.caption); placed[role].signature = true; } return; }
    if (f.fieldType === 'paraphe') { if (I.par) drawImageFit(page, I.par, box); return; }
    if (f.fieldType === 'case_cocher') { drawCheckbox(page, !!(S.checks && S.checks[f.id]), box); return; }
    if (f.fieldType === 'texte_libre') { drawFreeText(page, fonts, (S.texts && S.texts[f.id]) || '', box); return; }
    drawBoxText(page, fonts, textFor(f, S, ctx), box);
  });
  return placed;
}

function watermark(doc, fonts) {
  doc.getPages().forEach(function (p) {
    const w = p.getWidth();
    const h = p.getHeight();
    const txt = 'APERÇU — NON SIGNÉ';
    const size = Math.min(w, h) / 9;
    const tw = width(fonts, fonts.bold, txt, size);
    p.drawText(clean(fonts, txt), {
      x: w / 2 - (tw / 2) * Math.cos(Math.PI / 5), y: h / 2 - (tw / 2) * Math.sin(Math.PI / 5),
      size: size, font: fonts.bold, color: RED, opacity: 0.13, rotate: degrees(36),
    });
  });
}

/* ── Mise en page des pages ajoutées (dossier de preuve, annexes) ────────── */
function Flow(doc, fonts, header) {
  this.doc = doc; this.fonts = fonts; this.header = header || '';
  this.W = 595.28; this.H = 841.89; this.M = 48;
  this.page = null; this.y = 0; this.pageNo = 0;
  this.newPage();
}
Flow.prototype.newPage = function () {
  this.page = this.doc.addPage([this.W, this.H]);
  this.pageNo++;
  this.y = this.H - this.M;
  if (this.header) {
    this.page.drawText(clean(this.fonts, this.header), { x: this.M, y: this.H - 28, size: 7, font: this.fonts.medium, color: MUTED });
    this.page.drawLine({ start: { x: this.M, y: this.H - 34 }, end: { x: this.W - this.M, y: this.H - 34 }, thickness: 0.5, color: LINE });
    this.y = this.H - 52;
  }
};
Flow.prototype.need = function (h) { if (this.y - h < this.M + 20) this.newPage(); };
Flow.prototype.text = function (s, o) {
  o = o || {};
  const font = o.font || this.fonts.regular;
  const size = o.size || 9;
  const lh = size * (o.lh || 1.4);
  const x = this.M + (o.indent || 0);
  const maxW = (o.width || (this.W - 2 * this.M)) - (o.indent || 0);
  const self = this;
  wrap(this.fonts, font, s, size, maxW).forEach(function (l) {
    self.need(lh);
    if (l) self.page.drawText(l, { x: x, y: self.y - size, size: size, font: font, color: o.color || INK });
    self.y -= lh;
  });
  if (o.after) this.y -= o.after;
};
Flow.prototype.section = function (num, title) {
  this.need(40);
  this.y -= 10;
  this.page.drawRectangle({ x: this.M, y: this.y - 20, width: 3, height: 16, color: INDIGO });
  this.page.drawText(clean(this.fonts, (num ? num + '. ' : '') + title).toUpperCase(), { x: this.M + 10, y: this.y - 16, size: 10, font: this.fonts.bold, color: NAVY });
  this.y -= 30;
};
/* Lignes libellé / valeur. Les valeurs longues passent à la ligne dans
   leur colonne, sans jamais déborder sur la marge. */
Flow.prototype.kv = function (rows) {
  const self = this;
  const labelW = 150;
  const valW = this.W - 2 * this.M - labelW;
  rows.forEach(function (r) {
    if (!r || r[1] === undefined || r[1] === null || r[1] === '') return;
    const valFont = r[2] && r[2].mono ? self.fonts.regular : self.fonts.medium;
    const size = r[2] && r[2].mono ? 7.5 : 8.6;
    const lines = wrap(self.fonts, valFont, String(r[1]), size, valW);
    const lh = size * 1.38;
    const h = Math.max(lines.length * lh, 12) + 5;
    self.need(h);
    self.page.drawText(clean(self.fonts, r[0]), { x: self.M, y: self.y - 8.6, size: 7.6, font: self.fonts.regular, color: MUTED });
    let yy = self.y - size;
    lines.forEach(function (l) {
      self.page.drawText(l, { x: self.M + labelW, y: yy, size: size, font: valFont, color: (r[2] && r[2].color) || INK });
      yy -= lh;
    });
    self.y -= h;
    self.page.drawLine({ start: { x: self.M, y: self.y + 2 }, end: { x: self.W - self.M, y: self.y + 2 }, thickness: 0.35, color: LINE });
  });
  this.y -= 4;
};
Flow.prototype.box = function (lines, o) {
  o = o || {};
  const self = this;
  const size = o.size || 8.4;
  const lh = size * 1.45;
  const maxW = this.W - 2 * this.M - 24;
  let all = [];
  lines.forEach(function (l) { all = all.concat(wrap(self.fonts, l.font || self.fonts.regular, l.text, size, maxW).map(function (t) { return { t: t, font: l.font || self.fonts.regular, color: l.color }; })); });
  const h = all.length * lh + 18;
  this.need(h);
  this.page.drawRectangle({ x: this.M, y: this.y - h, width: this.W - 2 * this.M, height: h, color: o.bg || SOFT, borderColor: o.border || LINE, borderWidth: 0.6 });
  let yy = this.y - 9 - size;
  all.forEach(function (l) {
    if (l.t) self.page.drawText(l.t, { x: self.M + 12, y: yy, size: size, font: l.font, color: l.color || INK });
    yy -= lh;
  });
  this.y -= h + 8;
};
Flow.prototype.image = function (img, maxW, maxH, label) {
  const r = Math.min(maxW / img.width, maxH / img.height, 1);
  const w = img.width * r;
  const h = img.height * r;
  this.need(h + 24);
  if (label) { this.page.drawText(clean(this.fonts, label), { x: this.M, y: this.y - 8, size: 7.6, font: this.fonts.regular, color: MUTED }); this.y -= 14; }
  this.page.drawRectangle({ x: this.M, y: this.y - h - 8, width: w + 16, height: h + 8, color: rgb(1, 1, 1), borderColor: LINE, borderWidth: 0.6 });
  this.page.drawImage(img, { x: this.M + 8, y: this.y - h - 4, width: w, height: h });
  this.y -= h + 16;
};
Flow.prototype.footers = function (label) {
  const self = this;
  const pages = this.doc.getPages().slice(-this.pageNo);
  pages.forEach(function (p, i) {
    const t = clean(self.fonts, label + ' — page ' + (i + 1) + ' / ' + pages.length);
    p.drawText(t, { x: self.W - self.M - width(self.fonts, self.fonts.regular, t, 7), y: 24, size: 7, font: self.fonts.regular, color: MUTED });
  });
};

const EVENT_LABELS = {
  demande_creee: 'Demande de signature créée',
  lien_envoye: 'Lien de signature envoyé',
  lien_ouvert: 'Lien de signature ouvert',
  otp_envoye: 'Code SMS envoyé',
  otp_echec: 'Code SMS incorrect',
  otp_verifie: 'Téléphone vérifié par code SMS',
  contenu_charge: 'Contrat affiché',
  section_vue: 'Article lu à l\'écran',
  lecture_terminee: 'Lecture intégrale confirmée',
  pdf_original_ouvert: 'Document PDF original consulté',
  page_pdf_vue: 'Page du PDF original consultée',
  etape: 'Étape du parcours',
  entreprise_recherche: 'Recherche d\'entreprise',
  entreprise_selectionnee: 'Entreprise sélectionnée',
  entreprise_manuelle: 'Entreprise saisie manuellement',
  representant_saisi: 'Représentant légal renseigné',
  case_cochee: 'Case cochée',
  case_decochee: 'Case décochée',
  champ_rempli: 'Champ renseigné',
  mention_saisie: 'Mention manuscrite saisie',
  paraphe_saisi: 'Paraphe saisi',
  signature_tracee: 'Signature tracée',
  signature_effacee: 'Signature effacée',
  consentement: 'Déclaration acceptée',
  apercu_ouvert: 'Aperçu du contrat rempli consulté',
  page_masquee: 'Page quittée / mise en arrière-plan',
  page_visible: 'Retour sur la page',
  signature_validee: 'SIGNATURE VALIDÉE',
  document_genere: 'Contrat signé généré et scellé',
  copie_telechargee: 'Exemplaire signé téléchargé',
  copie_envoyee: 'Exemplaire signé envoyé par e-mail',
};

function eventDetail(e) {
  const d = e.data || {};
  if (e.type === 'section_vue') return d.titre || d.id || '';
  if (e.type === 'etape') return d.nom || '';
  if (e.type === 'case_cochee' || e.type === 'case_decochee') return d.libelle || d.id || '';
  if (e.type === 'entreprise_selectionnee' || e.type === 'entreprise_manuelle') return [d.nom, d.siret].filter(Boolean).join(' · ');
  if (e.type === 'entreprise_recherche') return d.q || '';
  if (e.type === 'consentement') return d.libelle || d.id || '';
  if (e.type === 'mention_saisie') return d.nom ? (d.nom + ' : « ' + (d.valeur || '') + ' »') : '';
  if (e.type === 'lecture_terminee') return d.duree ? ('durée de lecture ' + d.duree) : '';
  if (e.type === 'otp_envoye' || e.type === 'otp_verifie') return d.tel || '';
  if (e.type === 'lien_envoye') return d.canaux || '';
  if (e.type === 'page_pdf_vue') return d.page ? ('page ' + d.page) : '';
  return '';
}

function parisStamp(iso) {
  try {
    return new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).format(new Date(iso)).replace(' ', ' ');
  } catch (e) { return iso; }
}

/* Le dossier de preuve. P : voir buildSignedPdf. */
async function proofPages(doc, fonts, P) {
  const F = new Flow(doc, fonts, 'Dossier de preuve — ' + P.templateName + ' — réf. ' + P.certificateId);
  /* Bandeau */
  F.page.drawRectangle({ x: 0, y: F.H - 150, width: F.W, height: 150, color: NAVY });
  F.page.drawRectangle({ x: 0, y: F.H - 153, width: F.W, height: 3, color: INDIGO });
  F.page.drawText(clean(fonts, 'DOSSIER DE PREUVE'), { x: F.M, y: F.H - 62, size: 9, font: fonts.medium, color: rgb(0.65, 0.68, 1) });
  F.page.drawText(clean(fonts, 'Signature électronique du contrat'), { x: F.M, y: F.H - 88, size: 19, font: fonts.bold, color: rgb(1, 1, 1) });
  F.page.drawText(clean(fonts, '« ' + P.templateName + ' »'), { x: F.M, y: F.H - 110, size: 11, font: fonts.medium, color: rgb(0.85, 0.87, 0.95) });
  F.page.drawText(clean(fonts, 'Annexé au contrat ci-dessus, dont il fait partie intégrante.  Réf. ' + P.certificateId), { x: F.M, y: F.H - 132, size: 7.6, font: fonts.regular, color: rgb(0.7, 0.73, 0.82) });
  F.y = F.H - 180;

  F.box([
    { text: 'Ce dossier a été établi automatiquement par le serveur de SARL Ambitio Corp au moment de la signature. Il rassemble les éléments qui identifient le signataire, attestent de son consentement et garantissent l\'intégrité du document : vérification du téléphone par code à usage unique, mentions saisies de sa main, journal horodaté de chacune de ses actions, empreintes cryptographiques et jetons d\'horodatage émis par une autorité tierce.', font: fonts.regular },
  ]);

  F.section('1', 'Document');
  F.kv([
    ['Contrat', P.templateName],
    ['Référence du dossier', P.requestId],
    ['Identifiant de signature', P.certificateId],
    ['Mode de lecture', P.webMode ? 'Texte intégral du contrat, article par article (version ' + P.webVersion + '), PDF original consultable' : 'Document PDF original, page par page'],
    ['Empreinte du modèle PDF', 'SHA-256 ' + P.templatePdfSha256, { mono: true }],
    ['Empreinte du texte présenté', P.webDigest ? 'SHA-256 ' + P.webDigest : '', { mono: true }],
    ['Demande créée le', P.createdAt ? parisStamp(P.createdAt) + ' (heure de Paris)' : ''],
    ['Envoyée par', P.createdBy || ''],
  ]);

  F.section('2', 'Parties');
  F.kv([
    ['Prestataire', 'SARL Ambitio Corp — SIRET 943 098 707 00012 — 231B chemin de Mourre de Masque, 83440 Fayence — représentée par Emily UGHETTO et Adrien FRANCOIS'],
  ]);
  const C = P.company || {};
  F.kv([
    ['Client', C.name],
    ['Forme juridique', C.legalFormLabel],
    ['SIREN / SIRET', [C.siren, C.siret].filter(Boolean).join(' / ')],
    ['N° TVA intracommunautaire', C.vatNumber],
    ['Siège social', C.addressLine],
    ['Vérification au registre', C.verification],
  ]);

  P.signers.forEach(function (S, i) {
    F.section(String(3 + i), P.signers.length > 1 ? 'Signataire ' + (i + 1) : 'Signataire');
    F.kv([
      ['Nom', S.repName],
      ['Qualité', S.repQualite],
      ['Dirigeants publiés', S.dirigeantCheck],
      ['Adresse e-mail', S.email],
      ['Téléphone vérifié', S.phone],
      ['Vérification d\'identité', S.otpLine, { color: S.otpAt ? GREEN : RED }],
      ['Adresse IP à la signature', S.ip],
      ['Localisation (réseau)', S.geo],
      ['Navigateur', S.ua, { mono: true }],
      ['Signé le', S.signedAt ? parisStamp(S.signedAt) + ' (heure de Paris)' : ''],
    ]);
    F.text('Déclarations et choix', { font: fonts.bold, size: 9, after: 4 });
    F.kv(S.declarations.map(function (d) { return [d.etat, d.libelle + (d.at ? '  —  ' + parisStamp(d.at) : '')]; }));
    F.text('Lecture du contrat', { font: fonts.bold, size: 9, after: 4 });
    F.kv([
      ['Lecture intégrale', S.lecture],
      ['PDF original consulté', S.pdfConsulte],
      ['Aperçu du contrat rempli', S.apercu],
    ]);
    F.text('Mentions saisies de sa main', { font: fonts.bold, size: 9, after: 4 });
    F.kv(S.mentions.map(function (m) { return [m.nom, '« ' + m.valeur + ' »' + (m.at ? '  —  ' + parisStamp(m.at) : '')]; }));
    if (S.sigImg) F.image(S.sigImg, 260, 90, 'Signature manuscrite tracée à l\'écran — ' + S.traceInfo);
    if (S.parImg) F.image(S.parImg, 120, 40, 'Paraphe');
  });

  F.section(String(3 + P.signers.length), 'Chronologie complète');
  F.text('Chaque action est enregistrée par le serveur, à l\'heure du serveur (Paris), avec l\'adresse IP de l\'appareil. Les entrées sont chaînées par empreinte : la modification ou la suppression d\'une seule d\'entre elles est détectable.', { size: 7.8, color: MUTED, after: 6 });
  const cols = [F.M, F.M + 100, F.M + 330];
  function row(a, b, c, font, color) {
    const size = 7;
    const lb = wrap(fonts, font, b, size, 222);
    const lh = size * 1.35;
    const h = Math.max(1, lb.length) * lh + 3;
    F.need(h);
    F.page.drawText(clean(fonts, a), { x: cols[0], y: F.y - size, size: size, font: font, color: color || INK });
    let yy = F.y - size;
    lb.forEach(function (l) { F.page.drawText(l, { x: cols[1], y: yy, size: size, font: font, color: color || INK }); yy -= lh; });
    F.page.drawText(truncate(fonts, font, c, size, F.W - F.M - cols[2]), { x: cols[2], y: F.y - size, size: size, font: font, color: color || MUTED });
    F.y -= h;
  }
  row('Heure (Paris)', 'Événement', 'Signataire · IP · n° · empreinte', fonts.bold, NAVY);
  F.page.drawLine({ start: { x: F.M, y: F.y + 1 }, end: { x: F.W - F.M, y: F.y + 1 }, thickness: 0.5, color: LINE });
  P.audit.forEach(function (e) {
    const lbl = (EVENT_LABELS[e.type] || e.type) + (eventDetail(e) ? ' — ' + eventDetail(e) : '');
    const who = (e.signer === null || e.signer === undefined ? 'système' : 'S' + (e.signer + 1)) + ' · ' + (e.ip || '—') + ' · #' + e.seq + ' · ' + String(e.hash || '').slice(0, 10);
    row(parisStamp(e.at), lbl, who, e.type === 'signature_validee' ? fonts.bold : fonts.regular, e.type === 'signature_validee' ? GREEN : null);
  });

  F.section(String(4 + P.signers.length), 'Intégrité et horodatage');
  F.kv([
    ['Journal des actions', P.audit.length + ' entrées — chaîne d\'empreintes ' + (P.auditIntact ? 'vérifiée intacte' : 'NON INTÈGRE')],
    ['Tête de chaîne', 'SHA-256 ' + P.auditHead, { mono: true }],
    ['Horodatage du journal', P.auditTsa ? ('Jeton RFC 3161 émis par ' + P.auditTsa.authority + ' — ' + parisStamp(P.auditTsa.genTime) + ' (heure de Paris)') : 'Autorité d\'horodatage indisponible au moment de la signature — heure serveur seule'],
    ['Sceau du fichier', P.sealPlanned ? 'Ce fichier PDF est scellé par un horodatage RFC 3161 intégré (DocTimeStamp), visible dans le panneau « Signatures » d\'un lecteur PDF. Toute modification ultérieure du fichier invalide ce sceau.' : 'Non scellé : autorités d\'horodatage injoignables au moment de la signature. L\'empreinte du fichier est conservée par SARL Ambitio Corp.'],
  ]);

  F.box([
    { text: 'Cadre juridique', font: fonts.bold },
    { text: 'Signature électronique au sens de l\'article 1367 du Code civil et du règlement (UE) n° 910/2014 dit « eIDAS ». L\'écrit électronique a la même force probante que l\'écrit sur support papier, sous réserve que puisse être dûment identifiée la personne dont il émane et qu\'il soit établi et conservé dans des conditions de nature à en garantir l\'intégrité (article 1366 du Code civil). Le présent dossier, le journal chaîné des actions et les jetons d\'horodatage sont conservés par SARL Ambitio Corp pendant toute la durée de la relation contractuelle et au-delà, dans la limite des délais de prescription applicables.' },
  ], { size: 7.6 });

  F.footers('Dossier de preuve · réf. ' + P.certificateId);
}

/* Annexe pour un 2e signataire quand le modèle ne lui a réservé aucune zone
   de signature : son tracé et ses mentions figurent alors ici, en page
   numérotée du contrat, juste avant le dossier de preuve. */
async function cosignPage(doc, fonts, S, templateName) {
  const F = new Flow(doc, fonts, 'Signatures complémentaires — ' + templateName);
  F.text('SIGNATURES COMPLÉMENTAIRES', { font: fonts.bold, size: 15, after: 4 });
  F.text('Annexe au contrat « ' + templateName + ' », signée électroniquement par le second représentant du CLIENT.', { size: 9, color: MUTED, after: 10 });
  F.kv([
    ['Signataire', S.repName + (S.repQualite ? ', ' + S.repQualite : '')],
    ['Pour le compte de', (S.company && S.company.name) || ''],
    ['Date', S.date],
    ['Mention', '« ' + S.luApprouve + ' »'],
  ]);
  if (S.signaturePng) F.image(await doc.embedPng(S.signaturePng), 260, 100, 'Signature');
}

/* ── Sceau d'horodatage intégré (PAdES DocTimeStamp) ─────────────────────── */
const SIG_BYTES = 12000;
const BR_PH = '**********';

async function sealDocument(doc, label) {
  const ctx = doc.context;
  const byteRange = PDFArray.withContext(ctx);
  byteRange.push(PDFNumber.of(0));
  byteRange.push(PDFName.of(BR_PH));
  byteRange.push(PDFName.of(BR_PH));
  byteRange.push(PDFName.of(BR_PH));
  const sigDict = ctx.obj({
    Type: 'DocTimeStamp',
    Filter: 'Adobe.PPKLite',
    SubFilter: 'ETSI.RFC3161',
    ByteRange: byteRange,
    Contents: PDFHexString.of('0'.repeat(SIG_BYTES * 2)),
  });
  const sigRef = ctx.register(sigDict);
  const pages = doc.getPages();
  const last = pages[pages.length - 1];
  const widget = ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Sig',
    Rect: [0, 0, 0, 0], V: sigRef, F: 132, P: last.ref,
    T: PDFString.of(label || 'Horodatage'),
  });
  const widgetRef = ctx.register(widget);
  const annots = last.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
  if (annots) annots.push(widgetRef); else last.node.set(PDFName.of('Annots'), ctx.obj([widgetRef]));
  const acro = doc.catalog.lookupMaybe(PDFName.of('AcroForm'), PDFDict);
  if (acro) {
    const fl = acro.lookupMaybe(PDFName.of('Fields'), PDFArray);
    if (fl) fl.push(widgetRef); else acro.set(PDFName.of('Fields'), ctx.obj([widgetRef]));
    acro.set(PDFName.of('SigFields'), PDFNumber.of(3));
  } else {
    doc.catalog.set(PDFName.of('AcroForm'), ctx.obj({ Fields: [widgetRef], SigFields: 3 }));
  }

  const bytes = Buffer.from(await doc.save({ useObjectStreams: false }));
  const s = bytes.toString('latin1');
  const zeros = '0'.repeat(SIG_BYTES * 2);
  const hexStart = s.indexOf('<' + zeros + '>');
  if (hexStart < 0) throw new Error('emplacement du sceau introuvable');
  const hexEnd = hexStart + zeros.length + 2;
  const brRe = /\/ByteRange\s*\[\s*0\s+\/\*{10}\s+\/\*{10}\s+\/\*{10}\s*\]/;
  const m = brRe.exec(s);
  if (!m) throw new Error('ByteRange introuvable');
  const brTxt = '/ByteRange [0 ' + hexStart + ' ' + hexEnd + ' ' + (bytes.length - hexEnd) + ']';
  if (brTxt.length > m[0].length) throw new Error('ByteRange trop long');
  bytes.write(brTxt + ' '.repeat(m[0].length - brTxt.length), m.index, 'latin1');

  const hash = require('crypto').createHash('sha256')
    .update(bytes.slice(0, hexStart)).update(bytes.slice(hexEnd)).digest();
  const tsa = await timestamp(hash);
  const tokHex = tsa.token.toString('hex');
  if (tokHex.length > zeros.length) throw new Error('jeton d\'horodatage trop volumineux');
  bytes.write(tokHex, hexStart + 1, 'latin1');
  return { bytes: bytes, tsa: { authority: tsa.authority, genTime: tsa.genTime, url: tsa.url } };
}

/* ── Points d'entrée ─────────────────────────────────────────────────────── */
async function buildPreviewPdf(opts) {
  const doc = await PDFDocument.load(opts.templatePdf);
  const fonts = await embedFonts(doc);
  await stampContract(doc, fonts, opts.fields, opts.scale, opts.signers, opts.prefill);
  watermark(doc, fonts);
  return Buffer.from(await doc.save());
}

/* opts : { templatePdf, fields, scale, signers, prefill, proof }.
   Fabrique le contrat signé + dossier de preuve, puis le scelle. Si aucune
   autorité ne répond, on refabrique SANS sceau (et le dossier le dit) : la
   signature n'est jamais bloquée par un tiers, et le dossier n'affirme
   jamais un sceau qui n'existe pas. */
async function buildSignedPdf(opts) {
  async function make(sealPlanned) {
    const doc = await PDFDocument.load(opts.templatePdf);
    const fonts = await embedFonts(doc);
    doc.setTitle(opts.proof.templateName + ' — signé');
    doc.setAuthor('SARL Ambitio Corp');
    doc.setSubject('Contrat signé électroniquement — réf. ' + opts.proof.certificateId);
    doc.setProducer('Ambitio — signature électronique');
    doc.setCreator('team.alteore.com');
    const placed = await stampContract(doc, fonts, opts.fields, opts.scale, opts.signers, opts.prefill);
    for (const S of opts.signers) {
      if (S.role === 2 && !placed[2].signature) await cosignPage(doc, fonts, S, opts.proof.templateName);
    }
    const P = Object.assign({}, opts.proof, { sealPlanned: sealPlanned });
    P.signers = [];
    for (const ps of opts.proof.signers) {
      P.signers.push(Object.assign({}, ps, {
        sigImg: ps.signaturePng ? await doc.embedPng(ps.signaturePng) : null,
        parImg: ps.paraphePng ? await doc.embedPng(ps.paraphePng) : null,
      }));
    }
    await proofPages(doc, fonts, P);
    return doc;
  }
  try {
    const doc = await make(true);
    const sealed = await sealDocument(doc, 'Horodatage ' + opts.proof.certificateId);
    return { bytes: sealed.bytes, seal: sealed.tsa };
  } catch (e) {
    console.error('[sign-pdf] sceau impossible, PDF non scellé :', e && e.message);
    const doc = await make(false);
    return { bytes: Buffer.from(await doc.save()), seal: null, sealError: (e && e.message) || 'echec' };
  }
}

module.exports = { buildPreviewPdf, buildSignedPdf, EVENT_LABELS };
