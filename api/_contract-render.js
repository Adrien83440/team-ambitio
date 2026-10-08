// ============================================================================
// api/_contract-render.js — CONTRAT FABRIQUÉ DEPUIS LE TEXTE (atelier)
// ----------------------------------------------------------------------------
// Un contrat édité dans l'atelier (contract-studio.html) n'a plus de PDF
// d'origine : le PDF est COMPOSÉ ici, à partir du texte structuré
// (signature_templates/{id}.web, generated:true), au moment où on en a besoin
// — aperçu vierge, aperçu rempli, contrat signé.
//
// MODÈLE DE TEXTE (web, generated:true)
//   title, subtitle, tagline
//   sections : [{ id, title, blocks:[…], signatures? }]
//   variables : [{ key, label, type, options, filledBy, required, requiredIf, help }]
//       type : text | number | money | date | choice
//       filledBy : 'equipe' (conseiller, avant l'envoi) | 'client'
//   clientChecks : [{ id, label, required, kind }]   (ex. renonciation)
//   place : 'FAYENCE' (« Fait à … »)
//
// BLOCS (une chaîne par bloc)
//   p: paragraphe · h: sous-titre · li: puce · ol: « 1. … » · i: italique
//   check:<id>                 case du client (clientChecks)
//   if:<clé>=<valeur>:<bloc>   bloc présent seulement si la variable vaut…
//   if:<clé>:<bloc>            … seulement si la variable est renseignée
// TEXTE EN LIGNE
//   **gras** · {{var:clé}} · {{entreprise}} {{nom_prenom}} {{qualite}}
//   {{siege_social}} {{siret}} {{forme_juridique}} {{email}} {{telephone}}
//   {{date_signature}}
//
// Mise en page : celle des contrats actuels — titre centré, « ARTICLE »
// en gras souligné, texte justifié — avec en pied de CHAQUE page les deux
// paraphes (« AF » du prestataire, découpé de nos PDF, et celui du client), et
// en fin de contrat le bloc de signatures avec le cachet d'Ambitio Corp.
// ============================================================================

const { PDFDocument, StandardFonts, rgb, degrees } = require('pdf-lib');
const fontkit = require('@pdf-lib/fontkit');
const brand = require('./_sign-brand');
const signPdf = require('./_sign-pdf');

const W = 595.28, H = 841.89;
const ML = 64, MR = 64, MT = 62, MB = 78;
const TEXT_W = W - ML - MR;
const INK = rgb(0.06, 0.09, 0.22);
const BLACK = rgb(0.08, 0.08, 0.1);
const MUTED = rgb(0.42, 0.46, 0.54);
const LINE = rgb(0.86, 0.88, 0.92);
const SIZE = 10.4, LH = 14.6;

const CLIENT_KEYS = {
  entreprise: 'raison sociale', nom_prenom: 'représentant', qualite: 'qualité', siege_social: 'siège social',
  siret: 'SIRET', forme_juridique: 'forme juridique', email: 'e-mail', telephone: 'téléphone', date_signature: 'date',
};

/* ── Polices du document (Source Serif 4) ─────────────────────────────────── */
const SERIF = {
  regular: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-400-normal.ttf',
  italic: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-400-italic.ttf',
  bold: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-700-normal.ttf',
  boldItalic: 'https://cdn.jsdelivr.net/fontsource/fonts/source-serif-4@latest/latin-700-italic.ttf',
};
let _serif = null;
async function loadSerif() {
  if (_serif) return _serif;
  const keys = Object.keys(SERIF);
  const bufs = await Promise.all(keys.map(function (k) {
    return fetch(SERIF[k], { signal: AbortSignal.timeout(6000) }).then(function (r) {
      if (!r.ok) throw new Error('police ' + k + ' HTTP ' + r.status);
      return r.arrayBuffer();
    }).then(function (a) { return Buffer.from(a); });
  }));
  _serif = {};
  keys.forEach(function (k, i) { _serif[k] = bufs[i]; });
  return _serif;
}
async function docFonts(doc) {
  doc.registerFontkit(fontkit);
  try {
    const f = await loadSerif();
    const o = { features: { liga: false } };
    return {
      r: await doc.embedFont(f.regular, o), i: await doc.embedFont(f.italic, o),
      b: await doc.embedFont(f.bold, o), bi: await doc.embedFont(f.boldItalic, o), unicode: true,
    };
  } catch (e) {
    console.warn('[contract-render] Source Serif indisponible, repli Times :', e && e.message);
    return {
      r: await doc.embedFont(StandardFonts.TimesRoman), i: await doc.embedFont(StandardFonts.TimesRomanItalic),
      b: await doc.embedFont(StandardFonts.TimesRomanBold), bi: await doc.embedFont(StandardFonts.TimesRomanBoldItalic), unicode: false,
    };
  }
}
function cl(F, s) { return signPdf.clean({ unicode: F.unicode }, s); }

/* ── Valeurs ──────────────────────────────────────────────────────────────── */
function fmtMoney(v) {
  const n = Number(String(v).replace(/\s/g, '').replace(',', '.'));
  if (!isFinite(n)) return String(v);
  const parts = n.toFixed(Number.isInteger(n) ? 0 : 2).split('.');
  return parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + (parts[1] ? ',' + parts[1] : '') + ' €';
}
function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ''));
  return m ? m[3] + '/' + m[2] + '/' + m[1] : String(v || '');
}
function varDef(web, key) { return (web.variables || []).find(function (v) { return v.key === key; }) || null; }
function formatVar(def, raw) {
  if (raw === undefined || raw === null || raw === '') return '';
  if (!def) return String(raw);
  if (def.type === 'money') return fmtMoney(raw);
  if (def.type === 'date') return fmtDate(raw);
  if (def.type === 'choice') {
    const o = (def.options || []).find(function (x) { return x.value === raw; });
    return o ? o.label : String(raw);
  }
  return String(raw);
}

/* Une condition « if: » est-elle remplie ? cond = « clé », « clé=valeur »
   ou « clé!=valeur ». Seules les variables (pas les données client) comptent. */
function condOk(cond, vars) {
  let m = /^([A-Za-z0-9_]+)!=(.*)$/.exec(cond);
  if (m) return String(vars[m[1]] == null ? '' : vars[m[1]]) !== m[2];
  m = /^([A-Za-z0-9_]+)=(.*)$/.exec(cond);
  if (m) return String(vars[m[1]] == null ? '' : vars[m[1]]) === m[2];
  const v = vars[cond];
  return !(v === undefined || v === null || v === '' || v === false);
}

/* Les blocs effectivement présents, une fois les conditions évaluées. */
function liveBlocks(blocks, vars) {
  const out = [];
  (blocks || []).forEach(function (b) {
    let s = String(b || '');
    for (let guard = 0; guard < 4; guard++) {
      const m = /^if:([^:]+):(.*)$/.exec(s);
      if (!m) break;
      if (!condOk(m[1], vars)) { s = null; break; }
      s = m[2];
    }
    if (s) out.push(s);
  });
  return out;
}

/* Version « page de signature » : conditions évaluées, variables du
   conseiller remplacées par leur valeur, variables du client et cases
   converties dans la syntaxe que sign.html sait afficher et faire remplir. */
function resolveForSigner(web, prefill) {
  const vars = Object.assign({}, prefill || {});
  return {
    title: web.title || '', subtitle: web.subtitle || '', tagline: web.tagline || '',
    version: web.version || 1,
    sections: (web.sections || []).map(function (sec) {
      const blocks = liveBlocks(sec.blocks, vars).map(function (b) {
        if (/^check:/.test(b)) return 'field:' + b.slice(6);
        return b.replace(/\{\{var:([A-Za-z0-9_]+)\}\}/g, function (m, k) {
          const d = varDef(web, k);
          if (d && d.filledBy === 'client') return '{{field:' + k + '}}';
          const v = formatVar(d, vars[k]);
          return v ? '**' + v + '**' : '……';
        });
      });
      if (sec.signatures) blocks.push('p:Signatures du PRESTATAIRE et du CLIENT apposées en fin de document, précédées de la date et de la mention « Lu et approuvé ».');
      return { id: sec.id, title: sec.title, blocks: blocks };
    }).filter(function (s) { return s.blocks.length || s.title; }),
  };
}

/* ── Composition du texte riche ───────────────────────────────────────────── */
/* Découpe une ligne de texte en « mots » stylés : {t, b, it, ink, blank}. */
function runs(F, text, ctx, base) {
  const out = [];
  const re = /\*\*([^*]+)\*\*|\{\{([A-Za-z0-9_:]+)\}\}/g;
  let last = 0, m;
  /* glue : mot collé au précédent (pas d'espace dans le texte source),
     ex. la virgule qui suit un **gras** ou une valeur insérée. */
  function push(t, st) {
    String(t).split(/(\s+)/).forEach(function (w) {
      if (!w) return;
      if (/^\s+$/.test(w)) out.push({ sp: true });
      else {
        const prev = out[out.length - 1];
        out.push(Object.assign({ t: w, glue: !!(prev && !prev.sp) }, st));
      }
    });
  }
  while ((m = re.exec(text))) {
    if (m.index > last) push(text.slice(last, m.index), base);
    if (m[1] !== undefined) push(m[1], Object.assign({}, base, { b: true }));
    else {
      const key = m[2];
      let val = '';
      if (key.indexOf('var:') === 0) { const k = key.slice(4); val = formatVar(varDef(ctx.web, k), ctx.vars[k]); }
      else if (key.indexOf('field:') === 0) { const k = key.slice(6); val = formatVar(varDef(ctx.web, k), ctx.vars[k]); }
      else val = ctx.client[key] || '';
      if (val) push(val, Object.assign({}, base, { b: true, ink: true }));
      else { const prev = out[out.length - 1]; out.push(Object.assign({ t: '…………………………', blank: true, glue: !!(prev && !prev.sp) }, base)); }
    }
    last = re.lastIndex;
  }
  if (last < text.length) push(text.slice(last), base);
  return out;
}
function fontOf(F, w) { return w.b ? (w.it ? F.bi : F.b) : (w.it ? F.i : F.r); }

/* Lignes justifiées : [{ words:[{t,…,w}], width, last }]. */
function layout(F, words, size, maxW) {
  const lines = [];
  let cur = [], curW = 0;
  const spW = F.r.widthOfTextAtSize(' ', size);
  words.forEach(function (w) {
    if (w.sp) return;
    w.t = cl(F, w.t);
    w.w = fontOf(F, w).widthOfTextAtSize(w.t, size);
    /* Un mot collé ne se sépare pas du précédent en fin de ligne : on
       repousse le groupe entier sur la ligne suivante. */
    const add = (cur.length && !w.glue ? spW : 0) + w.w;
    if (cur.length && curW + add > maxW) {
      let carry = [w];
      while (w.glue && cur.length > 1 && carry[0].glue) carry.unshift(cur.pop());
      const ww = function (arr) { return arr.reduce(function (a, x, i) { return a + x.w + (i && !x.glue ? spW : 0); }, 0); };
      lines.push({ words: cur, width: ww(cur) });
      cur = carry; curW = ww(carry);
    }
    else { cur.push(w); curW += add; }
  });
  if (cur.length) lines.push({ words: cur, width: curW, last: true });
  return lines;
}

function Composer(doc, F, ctx) {
  this.doc = doc; this.F = F; this.ctx = ctx;
  this.page = null; this.y = 0; this.pages = [];
  this.newPage();
}
Composer.prototype.newPage = function () {
  this.page = this.doc.addPage([W, H]);
  this.pages.push(this.page);
  this.y = H - MT;
};
Composer.prototype.need = function (h) { if (this.y - h < MB) this.newPage(); };
Composer.prototype.para = function (text, o) {
  o = o || {};
  const F = this.F;
  const size = o.size || SIZE;
  const lh = o.lh || LH;
  const indent = o.indent || 0;
  const maxW = TEXT_W - indent;
  const lines = layout(F, runs(F, text, this.ctx, { b: !!o.b, it: !!o.it }), size, maxW);
  const self = this;
  if (o.keep) this.need(Math.min(lines.length, 3) * lh + (o.keepExtra || 0));
  lines.forEach(function (ln, li) {
    self.need(lh);
    const yb = self.y - size;
    if (li === 0 && o.marker) self.page.drawText(cl(F, o.marker), { x: ML + indent - (o.markerW || 12), y: yb, size: size, font: o.markerBold ? F.b : F.r, color: BLACK });
    const gaps = ln.words.filter(function (w, i) { return i > 0 && !w.glue; }).length;
    const justify = !ln.last && !o.noJustify && gaps > 0;
    const spW = F.r.widthOfTextAtSize(' ', size);
    const extra = justify ? (maxW - ln.width) / gaps : 0;
    let x = ML + indent + (o.center ? (maxW - ln.width) / 2 : 0);
    ln.words.forEach(function (w, wi) {
      if (wi > 0) x += w.glue ? 0 : spW + extra;
      const color = w.ink ? INK : (w.blank ? MUTED : (o.color || BLACK));
      self.page.drawText(w.t, { x: x, y: yb, size: size, font: fontOf(F, w), color: color });
      if (o.underline) {
        const nx = ln.words[wi + 1];
        const tail = nx ? (nx.glue ? 0 : spW + extra) : 0;
        self.page.drawLine({ start: { x: x, y: yb - 1.6 }, end: { x: x + w.w + tail, y: yb - 1.6 }, thickness: 0.7, color: BLACK });
      }
      x += w.w;
    });
    self.y -= lh;
  });
  this.y -= (o.after === undefined ? 4 : o.after);
};
Composer.prototype.checkbox = function (checked, label, o) {
  const s = 9.5;
  const F = this.F;
  const lines = layout(F, runs(F, label, this.ctx, { b: true, it: true }), SIZE, TEXT_W - 22);
  this.need(lines.length * LH + 8);
  const top = this.y - 1;
  signPdf.drawCheckbox(this.page, !!checked, { x: ML, y: top - s - 1, w: s + 2, h: s + 2 });
  this.para(label, { indent: 22, b: true, it: true, noJustify: true, after: 8 });
};

/* ── Bloc de signatures ───────────────────────────────────────────────────── */
async function signatureBlock(C, opts, cachet) {
  const F = C.F;
  const S = (opts.signers || [])[0] || {};
  const colW = (TEXT_W - 30) / 2;
  C.need(250);
  if (C.ctx.web.place || S.date) {
    C.para('Fait à ' + (C.ctx.web.place || '……………') + ', le {{date_signature}}', { after: 14, noJustify: true });
  }
  const top = C.y;
  const page = C.page;
  function txt(t, x, y, font, size, color) { page.drawText(cl(F, t), { x: x, y: y, size: size || SIZE, font: font || F.r, color: color || BLACK }); }
  /* PRESTATAIRE */
  let y = top - SIZE;
  txt('Le PRESTATAIRE', ML, y, F.b); y -= LH;
  txt('SARL Ambitio Corp', ML, y); y -= LH;
  txt('Représentée par Emily UGHETTO', ML, y); y -= LH;
  txt('et Adrien FRANCOIS', ML, y); y -= 6;
  if (cachet) {
    const w = Math.min(colW, 190);
    const h = w * cachet.height / cachet.width;
    page.drawPage(cachet, { x: ML - 6, y: y - h, width: w, height: h });
    y -= h;
  }
  const yLeft = y;
  /* CLIENT */
  const xR = ML + colW + 30;
  let yr = top - SIZE;
  txt('Le CLIENT', xR, yr, F.b); yr -= LH;
  const co = (C.ctx.client.entreprise || '').trim();
  function wrapTo(t, font, size) { return signPdf.wrap({ unicode: F.unicode }, font, t, size, colW); }
  wrapTo(co || '……………………………', co ? F.b : F.r, SIZE).forEach(function (l) { txt(l, xR, yr, co ? F.b : F.r, SIZE, co ? INK : MUTED); yr -= LH; });
  const rep = C.ctx.client.representant || '';
  wrapTo('représentée par ' + (rep || '……………………'), F.r, SIZE).forEach(function (l) { txt(l, xR, yr); yr -= LH; });
  yr -= 4;
  if (S.luApprouve) {
    txt('« ' + S.luApprouve + ' »' + (S.date ? ', le ' + S.date : ''), xR, yr, F.i, SIZE, INK); yr -= LH;
  } else {
    txt('(Signature précédée de la date et de la', xR, yr, F.i, 9, MUTED); yr -= 12;
    txt('mention « Lu et approuvé »)', xR, yr, F.i, 9, MUTED); yr -= LH;
  }
  if (S.sigImg) {
    const r = Math.min(colW / S.sigImg.width, 74 / S.sigImg.height);
    const w = S.sigImg.width * r, h = S.sigImg.height * r;
    page.drawImage(S.sigImg, { x: xR, y: yr - h, width: w, height: h });
    yr -= h + 3;
    if (S.caption) {
      const cs = 5;
      signPdf.wrap({ unicode: F.unicode }, F.r, S.caption, cs, colW).forEach(function (l) { txt(l, xR, yr - cs, F.r, cs, MUTED); yr -= cs + 1.5; });
    }
  } else if (!opts.blank) {
    page.drawRectangle({ x: xR, y: yr - 70, width: colW, height: 70, borderColor: LINE, borderWidth: 0.8, borderDashArray: [3, 3] });
    yr -= 72;
  } else { yr -= 70; }
  C.y = Math.min(yLeft, yr) - 10;
  /* Second représentant du client, le cas échéant */
  const S2 = (opts.signers || [])[1];
  if (S2 && S2.sigImg) {
    C.need(130);
    C.para('**Pour le CLIENT, second représentant :** ' + (S2.repName || '') + (S2.repQualite ? ', ' + S2.repQualite : ''), { after: 4, noJustify: true });
    C.para('« ' + (S2.luApprouve || '') + ' », le ' + (S2.date || ''), { it: true, after: 4, noJustify: true });
    const r2 = Math.min(220 / S2.sigImg.width, 70 / S2.sigImg.height);
    C.page.drawImage(S2.sigImg, { x: ML, y: C.y - S2.sigImg.height * r2, width: S2.sigImg.width * r2, height: S2.sigImg.height * r2 });
    C.y -= S2.sigImg.height * r2 + 10;
  }
}

/* ── Pieds de page : numéro + paraphes ────────────────────────────────────── */
function footers(C, opts, af) {
  const F = C.F;
  const n = C.pages.length;
  const S = (opts.signers || [])[0] || {};
  const label = cl(F, [C.ctx.web.title, C.ctx.web.subtitle].filter(Boolean).join(' — '));
  C.pages.forEach(function (p, i) {
    p.drawLine({ start: { x: ML, y: 50 }, end: { x: W - MR, y: 50 }, thickness: 0.4, color: LINE });
    p.drawText(label.slice(0, 90), { x: ML, y: 36, size: 7.4, font: F.r, color: MUTED });
    const pg = 'Page ' + (i + 1) + ' / ' + n;
    p.drawText(pg, { x: ML, y: 26, size: 7.4, font: F.r, color: MUTED });
    /* Paraphes : prestataire (AF) puis client */
    const boxH = 22, boxW = 52;
    const x2 = W - MR - boxW, x1 = x2 - boxW - 8;
    p.drawText('Paraphes', { x: x1 - 42, y: 30, size: 7, font: F.i, color: MUTED });
    if (af) { const r = Math.min(boxW / af.width, boxH / af.height); p.drawPage(af, { x: x1 + (boxW - af.width * r) / 2, y: 22, width: af.width * r, height: af.height * r }); }
    if (S.parImg) { const r = Math.min(boxW / S.parImg.width, boxH / S.parImg.height); p.drawImage(S.parImg, { x: x2 + (boxW - S.parImg.width * r) / 2, y: 22, width: S.parImg.width * r, height: S.parImg.height * r }); }
    else if (!opts.blank) p.drawRectangle({ x: x2, y: 22, width: boxW, height: boxH, borderColor: LINE, borderWidth: 0.6, borderDashArray: [2, 2] });
  });
}

/* ── Point d'entrée ───────────────────────────────────────────────────────── */
/* opts : { web, prefill, texts, checks, client:{…}, signers:[{ luApprouve,
   date, signaturePng, paraphePng, caption, repName, repQualite }],
   blank, preview }. Renvoie { doc, fonts } — fonts = jeu Montserrat de
   _sign-pdf (dossier de preuve). */
async function composeContract(opts) {
  const web = opts.web;
  const doc = await PDFDocument.create();
  const F = await docFonts(doc);
  const ui = await signPdf.embedFonts(doc);
  const vars = Object.assign({}, opts.prefill || {}, opts.texts || {});
  const client = Object.assign({}, opts.client || {});
  if (!client.representant && client.nom_prenom) client.representant = client.nom_prenom + (client.qualite ? ', ' + client.qualite : '');
  const ctx = { web: web, vars: vars, client: client };
  const signers = [];
  for (const s of (opts.signers || [])) {
    signers.push(Object.assign({}, s, {
      sigImg: s.signaturePng ? await doc.embedPng(s.signaturePng) : null,
      parImg: s.paraphePng ? await doc.embedPng(s.paraphePng) : null,
    }));
  }
  const brandDoc = await PDFDocument.load(Buffer.from(brand.pdfBase64, 'base64'));
  const bp = brandDoc.getPages();
  const cachet = await doc.embedPage(bp[brand.cachet]);
  const af = await doc.embedPage(bp[brand.paraphe]);

  const C = new Composer(doc, F, ctx);
  /* En-tête */
  if (web.title) C.para(web.title, { size: 15, lh: 20, b: true, center: true, noJustify: true, after: 2 });
  if (web.subtitle) C.para(web.subtitle, { size: 11.5, lh: 16, b: true, center: true, noJustify: true, after: 2 });
  if (web.tagline) C.para(web.tagline, { size: 10, lh: 14, it: true, center: true, noJustify: true, color: MUTED, after: 0 });
  C.y -= 22;

  let signed = false;
  const sopts = { signers: signers, blank: opts.blank };
  for (const sec of (web.sections || [])) {
    const blocks = liveBlocks(sec.blocks, vars);
    if (!blocks.length && !sec.signatures && !sec.title) continue;
    C.y -= 8;
    if (sec.title) C.para(sec.title, { b: true, underline: /^ARTICLE|^ENTRE/i.test(sec.title), noJustify: true, keep: true, keepExtra: 30, after: 6 });
    blocks.forEach(function (b) {
      const m = /^(p|h|li|ol|i|q|check|field):(.*)$/.exec(b);
      if (!m) return;
      const k = m[1], t = m[2];
      if (k === 'p') C.para(t);
      else if (k === 'h') { C.y -= 3; C.para(t, { b: true, noJustify: true, keep: true, after: 3 }); }
      else if (k === 'li') C.para(t, { indent: 26, marker: '•', markerW: 12, after: 2 });
      else if (k === 'ol') {
        const mm = /^(\d+[.)])\s*(.*)$/.exec(t);
        if (mm) C.para(mm[2], { indent: 26, marker: mm[1], markerW: 18, after: 3 });
        else C.para(t, { indent: 26, after: 3 });
      }
      else if (k === 'i' || k === 'q') C.para(t, { it: true, size: 9.6, lh: 13.4, color: MUTED });
      else if (k === 'check' || k === 'field') {
        const def = (web.clientChecks || []).find(function (c) { return c.id === t; });
        if (def) C.checkbox(!!(opts.checks || {})[t], def.label);
      }
    });
    if (sec.signatures && !signed) { C.y -= 6; await signatureBlock(C, sopts, cachet); signed = true; }
  }
  if (!signed) {
    C.y -= 8;
    C.para('SIGNATURES', { b: true, underline: true, keep: true, keepExtra: 220, after: 8 });
    await signatureBlock(C, sopts, cachet);
  }
  footers(C, sopts, af);
  if (opts.preview) signPdf.watermark(doc, ui);
  return { doc: doc, fonts: ui };
}

/* ── Conversion d'un texte « web » historique (PDF tamponné) ──────────────── */
/* Les 3 contrats importés le 08/10/2026 parlent en champs du PDF (field:<id>,
   {{field:<id>}}, if:<id-de-case>:). On les traduit en variables et cases
   d'atelier ; la section « SIGNATURES » devient le bloc automatique. */
function legacyToGenerated(web, fields) {
  const hints = web.fieldHints || {};
  const byId = {};
  (fields || []).forEach(function (f) { byId[f.id] = f; });
  const variables = [];
  const clientChecks = [];
  const groupVar = {};
  function slug(s) { return String(s || 'choix').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'choix'; }
  (fields || []).forEach(function (f) {
    const h = hints[f.id] || {};
    const equipe = f.filledBy === 'equipe' || h.filledBy === 'equipe';
    if (f.fieldType === 'case_cocher' && equipe && (h.group || f.group)) {
      const g = h.group || f.group;
      const key = slug(g);
      if (!groupVar[key]) {
        groupVar[key] = { key: key, label: g.charAt(0).toUpperCase() + g.slice(1), type: 'choice', options: [], filledBy: 'equipe', required: true };
        variables.push(groupVar[key]);
      }
      groupVar[key].options.push({ value: f.id, label: h.label || f.label || f.id });
    } else if (f.fieldType === 'case_cocher') {
      clientChecks.push({ id: f.id, label: h.label || f.label || 'Case à cocher', required: h.required === false ? false : f.required !== false, kind: h.kind || '' });
    } else if (f.fieldType === 'texte_libre') {
      const rq = h.requiredIf ? (function () { const ff = byId[h.requiredIf] || {}; const hh = hints[h.requiredIf] || {}; const g = slug(hh.group || ff.group); return g + '=' + h.requiredIf; })() : '';
      variables.push({ key: f.id, label: h.label || f.label || 'Texte', type: h.maxLength && h.maxLength <= 3 ? 'number' : 'text', filledBy: equipe ? 'equipe' : 'client', required: equipe ? false : f.required === true, requiredIf: rq, help: (h.help || '').replace(/ ?Rempli par votre conseiller\.?/, '') });
    }
  });
  function convBlock(b) {
    b = b.replace(/^if:([A-Za-z0-9_]+):/, function (m, id) {
      for (const k in groupVar) if (groupVar[k].options.some(function (o) { return o.value === id; })) return 'if:' + k + '=' + id + ':';
      return 'if:' + id + ':';
    });
    if (/^field:/.test(b)) {
      const id = b.slice(6);
      if (clientChecks.some(function (c) { return c.id === id; })) return 'check:' + id;
      return null;
    }
    return b.replace(/\{\{field:([A-Za-z0-9_]+)\}\}/g, function (m, id) {
      const f = byId[id] || {};
      if (f.fieldType === 'date_signature') return '{{date_signature}}';
      return '{{var:' + id + '}}';
    });
  }
  let place = '';
  const sections = (web.sections || []).map(function (s) {
    const isSig = /SIGNATURE/i.test(s.title || '');
    let blocks = s.blocks.map(convBlock).filter(Boolean);
    if (isSig) {
      blocks.forEach(function (b) { const m = /Fait à ([A-ZÀ-ÿ' -]+), le/i.exec(b); if (m) place = m[1].trim(); });
      blocks = [];
    }
    return { id: s.id, title: s.title, blocks: blocks, signatures: isSig || undefined };
  });
  sections.forEach(function (s) { if (s.signatures === undefined) delete s.signatures; });
  return {
    generated: true, title: web.title || '', subtitle: web.subtitle || '', tagline: web.tagline || '',
    sections: sections, variables: variables, clientChecks: clientChecks, place: place || 'FAYENCE',
  };
}

module.exports = { composeContract, resolveForSigner, legacyToGenerated, liveBlocks, formatVar, varDef, condOk, CLIENT_KEYS };
