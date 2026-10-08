// ============================================================================
// api/sign-session.js — LA PAGE DE SIGNATURE PARLE UNIQUEMENT À CET ENDPOINT
// ----------------------------------------------------------------------------
// POST /api/sign-session   { action, token, ... }
//
//   load     → état du lien (avant code SMS) : à signer, déjà signé, en attente
//   content  → contrat + formulaire à remplir           (code SMS validé)
//   events   → journal des actions du signataire        (code SMS validé)
//   company  → recherche SIRET / SIREN / raison sociale (code SMS validé)
//   pdf      → le PDF original du modèle, pour lecture  (code SMS validé)
//   preview  → le contrat rempli, filigrané « APERÇU »  (code SMS validé)
//   submit   → validation + PDF signé + dossier de preuve + sceau
//   signed   → télécharger le contrat signé (après signature)
//
// POURQUOI UN ENDPOINT UNIQUE ET PAS FIRESTORE
// Avant, sign.html lisait et écrivait signature_requests directement, avec des
// règles ouvertes à tous (lecture ET modification sans compte). N'importe qui
// pouvait lire tous les contrats et réécrire un contrat signé : indéfendable
// devant un juge. Désormais le navigateur du signataire ne touche plus la
// base : il présente le token de son lien, le serveur vérifie, valide tout ce
// qui est saisi, écrit le journal de preuve, fabrique et scelle le PDF.
//
// Le token ne sert jamais à choisir un destinataire ni un numéro : tout ce qui
// part (SMS, e-mail) vient du document Firestore.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const core = require('./_sign-core');
const company = require('./_companyLookup');
const { buildPreviewPdf, buildSignedPdf } = require('./_sign-pdf');
const { timestamp } = require('./_tsa');

/* Événements que la page peut journaliser. Tout le reste est ignoré : le
   journal ne doit contenir que des actions qui ont un sens probatoire. */
const CLIENT_EVENTS = {
  section_vue: 1, lecture_terminee: 1, pdf_original_ouvert: 1, page_pdf_vue: 1,
  etape: 1, entreprise_selectionnee: 1, entreprise_manuelle: 1, representant_saisi: 1,
  case_cochee: 1, case_decochee: 1, champ_rempli: 1, mention_saisie: 1, paraphe_saisi: 1,
  signature_tracee: 1, signature_effacee: 1, consentement: 1,
  page_masquee: 1, page_visible: 1,
};

const QUALITES = ['Gérant', 'Co-gérant', 'Président', 'Directeur général', 'Directeur général délégué', 'Associé', 'Mandataire habilité', 'Entrepreneur individuel'];

const DECLARATIONS = {
  pouvoir: 'Je certifie être habilité(e) à engager la société désignée ci-dessus et signer le présent contrat en son nom.',
  esign: 'J\'accepte de signer ce contrat électroniquement. Je reconnais que ma signature électronique a la même valeur qu\'une signature manuscrite et m\'engage au même titre.',
};

function send(res, status, obj) { res.status(status).json(obj); }

function roleOf(i) { return i >= 1 ? 2 : 1; }

/* Résumé de données client pour le journal : jamais plus de 600 caractères,
   jamais d'objet imbriqué arbitraire. */
function smallData(d) {
  if (!d || typeof d !== 'object') return null;
  const out = {};
  Object.keys(d).slice(0, 10).forEach(function (k) {
    const v = d[k];
    if (v === null || v === undefined) return;
    if (typeof v === 'number' || typeof v === 'boolean') out[k] = v;
    else out[k] = String(v).slice(0, 200);
  });
  const s = JSON.stringify(out);
  return s.length > 600 ? { tronque: s.slice(0, 590) } : out;
}

function pngFromDataUrl(s, maxBytes) {
  const raw = String(s || '').replace(/^data:image\/png;base64,/, '');
  if (!raw || raw.length > maxBytes * 1.4) return null;
  const b = Buffer.from(raw, 'base64');
  if (b.length < 100 || b.length > maxBytes) return null;
  if (b.slice(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return b;
}

/* Les champs du modèle (instantané pris à l'envoi), dédoublonnés : « Nom
   Prénom » posé trois fois se remplit une fois ; une case ou un texte libre
   est une exigence par champ. */
/* Un champ « rempli par l'équipe » (le conseiller, dans la fenêtre d'envoi) :
   formule de paiement, nombre de mensualités… Marqué sur le champ du modèle
   (filledBy, éditeur sales-signatures) ou dans la version web (fieldHints). */
function isEquipe(f, h) { return (f && f.filledBy === 'equipe') || (h && h.filledBy === 'equipe'); }

/* Date à partir de laquelle l'accompagnement peut démarrer sans renonciation :
   le délai de 14 jours court à compter de la conclusion (aujourd'hui) ; il
   expire à la fin du 14e jour, le démarrage est donc possible le 15e. */
function startNoWaiver() {
  const p = core.parisToday().split('/');
  const d = new Date(Date.UTC(+p[2], +p[1] - 1, +p[0] + 15));
  return String(d.getUTCDate()).padStart(2, '0') + '/' + String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + d.getUTCFullYear();
}

function formSpec(fields, role, hints, prefill) {
  const seen = {};
  const checks = [];
  const texts = [];
  const conditions = [];
  let paraphe = false;
  let dateField = false;
  let signature = false;
  (fields || []).forEach(function (f) {
    const r = f.signerRole === 2 ? 2 : 1;
    const h = (hints && hints[f.id]) || {};
    if (f.fieldType === 'texte_libre') {
      if (seen[f.id]) return; seen[f.id] = 1;
      const equipe = isEquipe(f, h);
      const pre = prefill && prefill[f.id] ? String(prefill[f.id]) : '';
      if (r !== role && !pre) return;
      texts.push({
        id: f.id, label: h.label || (f.label && f.label !== 'Texte libre' ? f.label : 'Texte libre'),
        help: h.help || '', required: !equipe && f.required === true && r === role,
        locked: equipe || !!pre, value: pre, maxLength: h.maxLength || 500,
      });
      return;
    }
    if (f.fieldType === 'case_cocher' && isEquipe(f, h)) {
      if (seen[f.id]) return; seen[f.id] = 1;
      conditions.push({ id: f.id, label: h.label || f.label || 'Option', group: h.group || f.group || '', value: !!(prefill && prefill[f.id] === true) });
      return;
    }
    if (r !== role) return;
    if (f.fieldType === 'case_cocher') {
      if (seen[f.id]) return; seen[f.id] = 1;
      const label = h.label || (f.label && f.label !== 'Case à cocher' ? f.label : 'Case à cocher');
      checks.push({
        id: f.id, label: label, help: h.help || '',
        required: h.required === false ? false : f.required !== false,
        kind: h.kind || (/renonce/i.test(label) && /r[ée]tractation/i.test(label) ? 'renonciation' : ''),
      });
      return;
    }
    if (f.fieldType === 'paraphe') paraphe = true;
    if (f.fieldType === 'date_signature') dateField = true;
    if (f.fieldType === 'signature') signature = true;
  });
  return { checks: checks, texts: texts, conditions: conditions, paraphe: paraphe, dateField: dateField, signatureField: signature };
}

function initials(first, last) {
  const w = (String(first || '') + ' ' + String(last || '')).trim().split(/[\s-]+/).filter(Boolean);
  return w.map(function (x) { return x.charAt(0).toUpperCase(); }).join('.') + (w.length ? '.' : '');
}

/* Le représentant figure-t-il parmi les dirigeants publiés ? On le dit tel
   quel dans le dossier de preuve — sans bloquer : un mandataire habilité peut
   signer, il l'a certifié. */
function dirigeantCheck(reg, first, last) {
  if (!reg) return 'Registre non consulté (saisie manuelle)';
  const list = reg.dirigeants || [];
  if (!list.length) return 'Aucun dirigeant publié au registre';
  const target = core.foldText(first + ' ' + last);
  const targetLast = core.foldText(last);
  const hit = list.find(function (d) {
    if (d.type !== 'physique' || d.masque) return false;
    const full = core.foldText(d.prenoms + ' ' + d.nom);
    return full === target || (core.foldText(d.nom) === targetLast && full.indexOf(core.foldText(first).split(' ')[0]) >= 0);
  });
  if (hit) return 'Correspond au dirigeant publié (' + (hit.qualite || 'dirigeant') + ')';
  if (list.every(function (d) { return d.masque; })) return 'Dirigeants non diffusibles (masqués par l\'INSEE) — habilitation certifiée par le signataire';
  return 'Non trouvé parmi les dirigeants publiés — habilitation certifiée par le signataire';
}

/* ── Chargement commun ───────────────────────────────────────────────────── */
async function context(found) {
  const R = found.R;
  const tpl = await core.loadTemplate(R.templateId);
  if (!tpl || !tpl.pdf) { const e = new Error('modele_introuvable'); e.status = 409; e.msg = 'Le document de ce contrat est introuvable. Contactez votre conseiller.'; throw e; }
  const frozen = R.frozen || null;
  if (frozen && frozen.templatePdfSha256 && frozen.templatePdfSha256 !== tpl.pdfSha256) {
    const e = new Error('modele_modifie'); e.status = 409;
    e.msg = 'Le contrat a été modifié depuis l\'envoi de ce lien. Pour votre sécurité, la signature est bloquée : demandez un nouveau lien à votre conseiller.';
    throw e;
  }
  const web = R.webSnapshot || (tpl.T && tpl.T.web) || null;
  const webMode = core.webIsValid(web, tpl.pdfSha256);
  return {
    tpl: tpl, web: webMode ? web : null, webMode: webMode,
    fields: Array.isArray(R.fields) && R.fields.length ? R.fields : (tpl.T.fields || []),
    scale: Number(R.pdfScale) || 1.2,
    prefill: R.prefill || {},
    hints: webMode ? (web.fieldHints || {}) : {},
  };
}

/* ── Validation complète d'une soumission ────────────────────────────────── */
async function validate(body, found, ctx, strict) {
  const i = found.signerIndex;
  const role = roleOf(i);
  const spec = formSpec(ctx.fields, role, ctx.hints, ctx.prefill);
  const errs = [];
  const f = body.form || {};
  const out = { spec: spec };

  /* Société — saisie par le 1er signataire, reprise telle quelle par le 2e. */
  if (i === 0) {
    const c = f.company || {};
    const ident = String(c.siret || c.siren || '').replace(/\D/g, '');
    let reg = null;
    let regError = null;
    if (ident.length === 9 || ident.length === 14) {
      try { reg = await company.lookupByIdentifier(ident); } catch (e) { regError = e; }
    }
    const manualAddr = {
      line1: String((c.address && c.address.line1) || '').trim().slice(0, 140),
      line2: String((c.address && c.address.line2) || '').trim().slice(0, 140),
      postalCode: String((c.address && c.address.postalCode) || '').replace(/\s/g, '').slice(0, 10),
      city: String((c.address && c.address.city) || '').trim().slice(0, 80),
    };
    const C = {};
    if (reg) {
      if (reg.closed && strict) errs.push('Cette entreprise est radiée au registre : le contrat ne peut pas être signé en son nom. Contactez votre conseiller.');
      C.name = reg.name; C.siren = reg.siren; C.siret = reg.siret; C.vatNumber = reg.vatNumber;
      C.legalForm = reg.legalForm; C.legalFormLabel = reg.legalFormLabel;
      C.address = reg.addressHidden ? manualAddr : reg.address;
      C.addressSource = reg.addressHidden ? 'saisie (adresse non diffusible au registre)' : 'registre';
      C.verification = 'Vérifiée dans l\'annuaire officiel des entreprises le ' + core.parisToday() + ' — ' + (reg.closed ? 'ENTREPRISE RADIÉE' : 'entreprise active') + (reg.creationDate ? ', créée le ' + reg.creationDate.split('-').reverse().join('/') : '') + ' — source : ' + company.SOURCE_LABEL;
      out.registry = reg;
    } else {
      /* Annuaire injoignable, ou entreprise trop récente pour y figurer :
         saisie manuelle acceptée si le SIRET est mathématiquement valide, et
         le dossier de preuve le dit sans détour. */
      if (!company.siretValid(c.siret)) errs.push('Numéro SIRET invalide (14 chiffres, clé de contrôle incorrecte).');
      C.name = String(c.name || '').trim().slice(0, 160);
      C.siret = String(c.siret || '').replace(/\D/g, '');
      C.siren = C.siret.slice(0, 9);
      C.vatNumber = company.vatFromSiren(C.siren);
      C.legalForm = '';
      C.legalFormLabel = String(c.legalFormLabel || '').trim().slice(0, 60);
      C.address = manualAddr;
      C.addressSource = 'saisie';
      C.verification = regError
        ? 'Annuaire officiel injoignable au moment de la signature — données saisies par le signataire, SIRET contrôlé (clé de Luhn)'
        : 'Entreprise non trouvée dans l\'annuaire officiel au ' + core.parisToday() + ' — données saisies par le signataire, SIRET contrôlé (clé de Luhn)';
      if (!C.name) errs.push('Raison sociale manquante.');
      if (!C.legalFormLabel) errs.push('Forme juridique manquante.');
    }
    if (!C.address.line1 || !/^\d{5}$/.test(C.address.postalCode) || !C.address.city) errs.push('Adresse du siège social incomplète (voie, code postal à 5 chiffres, ville).');
    C.addressLine = company.addressLine(C.address);
    out.company = C;
  } else {
    const s0 = (found.R.signers && found.R.signers[0]) || {};
    out.company = s0.company || null;
    if (!out.company) errs.push('Les informations de la société sont introuvables. Contactez votre conseiller.');
  }

  /* Représentant */
  const rep = f.representative || {};
  const first = String(rep.firstName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const last = String(rep.lastName || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  let qualite = String(rep.qualite || '').trim().slice(0, 60);
  if (qualite === 'Autre') qualite = String(rep.qualiteAutre || '').trim().slice(0, 60);
  if (first.length < 2 || !/[A-Za-zÀ-ÿ]/.test(first)) errs.push('Prénom du représentant manquant.');
  if (last.length < 2 || !/[A-Za-zÀ-ÿ]/.test(last)) errs.push('Nom du représentant manquant.');
  if (qualite.length < 3) errs.push('Qualité du représentant manquante (gérant, président…).');
  out.rep = { first: first, last: last, full: first + ' ' + last, qualite: qualite };

  /* Déclarations */
  const decl = f.declarations || {};
  if (decl.pouvoir !== true) errs.push('Vous devez certifier être habilité(e) à engager la société.');
  if (decl.esign !== true) errs.push('Vous devez accepter la signature électronique.');

  /* Cases et textes */
  const checks = {};
  spec.checks.forEach(function (c) {
    const v = !!(f.checks && f.checks[c.id] === true);
    checks[c.id] = v;
    if (c.required && !v) errs.push('Case obligatoire non cochée : « ' + String(c.label).replace(/^[«"\s]+|[»"\s]+$/g, '') + ' ».');
  });
  out.checks = checks;
  const texts = {};
  spec.texts.forEach(function (t) {
    if (t.locked) return;
    const v = String((f.texts && f.texts[t.id]) || '').trim().slice(0, t.maxLength || 500);
    texts[t.id] = v;
    if (t.required && !v) errs.push('Champ obligatoire vide : « ' + t.label + ' ».');
  });
  out.texts = texts;

  /* Mentions manuscrites */
  const date = String(f.date || '').trim();
  if (!/^\d{2}\/\d{2}\/\d{4}$/.test(date)) errs.push('Date de signature à saisir au format JJ/MM/AAAA.');
  else if (date !== core.parisToday()) errs.push('La date saisie doit être celle d\'aujourd\'hui : ' + core.parisToday() + '.');
  const lu = String(f.luApprouve || '').trim().replace(/\s+/g, ' ').slice(0, 40);
  if (core.foldText(lu) !== 'lu et approuve') errs.push('Recopiez la mention « Lu et approuvé ».');
  out.date = date;
  out.luApprouve = lu;

  if (spec.paraphe) {
    const p = String(f.paraphe || '').trim().slice(0, 12);
    if (!/^[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ.\- ]{0,11}$/.test(p)) errs.push('Saisissez vos initiales pour parapher le contrat.');
    out.paraphe = p;
    out.paraphePng = pngFromDataUrl(f.paraphePng, 200000);
    if (!out.paraphePng) errs.push('Paraphe illisible : ressaisissez vos initiales.');
  }

  /* Signature tracée */
  const sig = f.signature || {};
  out.signaturePng = pngFromDataUrl(sig.png, 600000);
  out.trace = { strokes: Number(sig.strokes) || 0, points: Number(sig.points) || 0, durationMs: Number(sig.durationMs) || 0 };
  out.signatureName = String(sig.name || '').trim().replace(/\s+/g, ' ').slice(0, 120);
  if (strict) {
    if (!out.signaturePng || out.trace.points < 20) errs.push('Tracez votre signature dans le cadre prévu.');
    if (core.foldText(out.signatureName) !== core.foldText(out.rep.full)) errs.push('Le nom saisi sous la signature doit être celui du représentant : ' + out.rep.full + '.');
  }
  out.errors = errs;
  return out;
}

/* Données de stampage d'un signataire, depuis une validation (v) ou depuis
   ce qui a été enregistré (signer_data). */
function stampSigner(role, d, caption) {
  return {
    role: role,
    company: d.company,
    repName: d.rep.full, repQualite: d.rep.qualite,
    email: d.email, phone: d.phone,
    date: d.date, luApprouve: d.luApprouve,
    checks: d.checks, texts: d.texts,
    signaturePng: d.signaturePng || null,
    paraphePng: d.paraphePng || null,
    caption: caption || '',
  };
}

function fmtDuree(ms) {
  const s = Math.round((Number(ms) || 0) / 1000);
  if (!s) return '';
  const m = Math.floor(s / 60);
  return (m ? m + ' min ' : '') + (s % 60) + ' s';
}

/* ── Handler ─────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  if (req.method !== 'POST') { send(res, 405, { error: 'Méthode non autorisée' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '');
  let found = null;
  try {
    found = await core.findByToken(body.token);
  } catch (e) {
    console.error('[sign-session] findByToken', e && e.message);
    send(res, 500, { error: 'Service momentanément indisponible. Réessayez dans un instant.' });
    return;
  }
  if (!found) { send(res, 404, { error: 'Lien invalide ou expiré.' }); return; }

  const R = found.R;
  const i = found.signerIndex;
  const info = core.clientInfo(req);
  const signers = Array.isArray(R.signers) ? R.signers : [];
  const mineSigned = (found.signer && found.signer.status === 'signed') || R.status === 'signed';
  const waiting = i >= 1 && signers[0] && signers[0].status !== 'signed';

  try {
    if (R.status === 'cancelled') { send(res, 409, { error: 'Cette demande de signature a été annulée.' }); return; }

    /* ── load ──────────────────────────────────────────────────────────── */
    if (action === 'load') {
      const stage = mineSigned ? 'signed' : (waiting ? 'waiting' : 'sign');
      if (stage === 'sign') {
        const upd = {};
        if (R.status === 'pending') upd.status = 'opened';
        if (signers[i] && signers[i].status === 'pending') {
          const ns = signers.slice();
          ns[i] = Object.assign({}, ns[i], { status: 'opened', openedAt: new Date().toISOString() });
          upd.signers = ns;
        }
        upd.events = admin.firestore.FieldValue.arrayUnion({ type: 'opened', by: 'signer' + (i + 1), date: new Date().toISOString() });
        await found.ref.update(upd);
        await core.appendAudit(found.ref, [{ type: 'lien_ouvert', signer: i, data: { geo: [info.city, info.country].filter(Boolean).join(', ') } }], info);
      }
      const name = String(found.signer.name || R.clientName || '');
      send(res, 200, {
        ok: true, stage: stage, reqId: found.id, signerIndex: i,
        templateName: R.templateName || 'Contrat',
        firstName: name.split(' ')[0] || '',
        phoneHint: core.maskPhone(found.signer.phone || R.clientPhone),
        otpOk: core.otpOk(R, i),
        twoSigners: signers.length > 1,
        firstSignerName: i >= 1 && signers[0] ? signers[0].name : '',
      });
      return;
    }

    /* ── signed : télécharger son exemplaire ───────────────────────────── */
    if (action === 'signed') {
      if (R.status !== 'signed') { send(res, 409, { error: 'Le contrat n\'est pas encore signé par toutes les parties.' }); return; }
      let b64 = R.signedPdfBase64 || '';
      if (!b64) {
        const ch = await found.ref.collection('signed_pdf').orderBy('chunk').get();
        ch.forEach(function (d) { b64 += (d.data() || {}).data || ''; });
      }
      if (!b64) { send(res, 404, { error: 'Document signé introuvable.' }); return; }
      await core.appendAudit(found.ref, [{ type: 'copie_telechargee', signer: i, data: null }], info).catch(function () {});
      send(res, 200, { ok: true, pdf: b64, filename: (R.templateName || 'Contrat').replace(/[^A-Za-z0-9 _-]/g, '').trim().replace(/\s+/g, '_') + '_signe.pdf' });
      return;
    }

    if (mineSigned) { send(res, 409, { error: 'Vous avez déjà signé ce contrat.', stage: 'signed' }); return; }
    if (waiting) { send(res, 409, { error: 'Le premier signataire doit signer avant vous.', stage: 'waiting' }); return; }
    if (!core.otpOk(R, i)) { send(res, 401, { error: 'Vérification par code SMS requise.', stage: 'otp' }); return; }

    /* ── events ────────────────────────────────────────────────────────── */
    if (action === 'events') {
      const list = (Array.isArray(body.events) ? body.events : []).slice(0, 60)
        .filter(function (e) { return e && CLIENT_EVENTS[e.type]; })
        .map(function (e) { return { type: e.type, signer: i, data: smallData(e.data) }; });
      if (list.length) await core.appendAudit(found.ref, list, info);
      const done = list.find(function (e) { return e.type === 'lecture_terminee'; });
      if (done) {
        const upd = {};
        upd['readDone.' + i] = { at: new Date().toISOString(), data: done.data || null };
        await found.ref.update(upd);
      }
      send(res, 200, { ok: true, n: list.length });
      return;
    }

    const ctx = await context(found);

    /* ── content ───────────────────────────────────────────────────────── */
    if (action === 'content') {
      const upd = {};
      if (!R.frozen) upd.frozen = { templatePdfSha256: ctx.tpl.pdfSha256, webVersion: ctx.web ? (ctx.web.version || 1) : null, webDigest: core.webDigest(ctx.web), at: new Date().toISOString() };
      if (ctx.webMode && !R.webSnapshot) upd.webSnapshot = ctx.web;
      if (Object.keys(upd).length) await found.ref.update(upd);
      const spec = formSpec(ctx.fields, roleOf(i), ctx.hints, ctx.prefill);
      let pages = 0;
      try { pages = (await require('pdf-lib').PDFDocument.load(ctx.tpl.pdf, { updateMetadata: false })).getPageCount(); } catch (e) { pages = 0; }
      await core.appendAudit(found.ref, [{ type: 'contenu_charge', signer: i, data: { mode: ctx.webMode ? 'texte' : 'pdf', version: ctx.web ? (ctx.web.version || 1) : null } }], info);
      const s0 = signers[0] || {};
      send(res, 200, {
        ok: true,
        mode: ctx.webMode ? 'web' : 'pdf',
        templateName: R.templateName || 'Contrat',
        web: ctx.webMode ? { title: ctx.web.title, subtitle: ctx.web.subtitle, tagline: ctx.web.tagline, sections: ctx.web.sections, version: ctx.web.version || 1 } : null,
        pages: pages,
        form: {
          needsCompany: i === 0,
          company: i >= 1 ? (s0.company || null) : null,
          checks: spec.checks, texts: spec.texts, conditions: spec.conditions,
          paraphe: spec.paraphe, dateField: spec.dateField,
          startNoWaiver: startNoWaiver(),
          qualites: QUALITES,
          declarations: DECLARATIONS,
        },
        signer: { name: found.signer.name || '', email: found.signer.email || '', phone: found.signer.phone || '', index: i },
        today: core.parisToday(),
        message: R.message || '',
      });
      return;
    }

    /* ── company ───────────────────────────────────────────────────────── */
    if (action === 'company') {
      const q = String(body.q || '').trim().slice(0, 120);
      const r = await company.searchCompanies(q, 8);
      await core.appendAudit(found.ref, [{ type: 'entreprise_recherche', signer: i, data: { q: q, resultats: r.results.length } }], info);
      send(res, 200, {
        ok: true,
        results: r.results.map(function (x) {
          return {
            siren: x.siren, siret: x.siret, name: x.name, legalFormLabel: x.legalFormLabel,
            address: x.address, addressHidden: x.addressHidden, closed: x.closed,
            vatNumber: x.vatNumber, creationDate: x.creationDate,
            dirigeants: (x.dirigeants || []).filter(function (d) { return d.type === 'physique' && !d.masque; })
              .map(function (d) { return { prenoms: d.prenoms, nom: d.nom, qualite: d.qualite }; }),
            qualites: (x.dirigeants || []).map(function (d) { return d.qualite; }).filter(Boolean),
          };
        }),
      });
      return;
    }

    /* ── pdf original ──────────────────────────────────────────────────── */
    if (action === 'pdf') {
      await core.appendAudit(found.ref, [{ type: 'pdf_original_ouvert', signer: i, data: null }], info);
      send(res, 200, { ok: true, pdf: ctx.tpl.pdf.toString('base64'), sha256: ctx.tpl.pdfSha256 });
      return;
    }

    /* ── preview ───────────────────────────────────────────────────────── */
    if (action === 'preview') {
      const v = await validate(body, found, ctx, false);
      const role = roleOf(i);
      const S = stampSigner(role, Object.assign({}, v, { email: found.signer.email, phone: found.signer.phone }), 'Aperçu — non signé');
      const list = [S];
      if (i >= 1) {
        const d0 = await found.ref.collection('signer_data').doc('0').get();
        if (d0.exists) list.unshift(storedToStamp(1, d0.data()));
      }
      const pdf = await buildPreviewPdf({ templatePdf: ctx.tpl.pdf, fields: ctx.fields, scale: ctx.scale, signers: list, prefill: ctx.prefill });
      await core.appendAudit(found.ref, [{ type: 'apercu_ouvert', signer: i, data: { manquants: v.errors.length } }], info);
      send(res, 200, { ok: true, pdf: pdf.toString('base64'), missing: v.errors });
      return;
    }

    /* ── submit ────────────────────────────────────────────────────────── */
    if (action === 'submit') {
      if (!(R.readDone && R.readDone[String(i)])) { send(res, 400, { error: 'Lisez le contrat jusqu\'au bout avant de signer.', details: ['Lecture intégrale non confirmée.'] }); return; }
      const v = await validate(body, found, ctx, true);
      if (v.errors.length) { send(res, 400, { error: 'Le formulaire est incomplet.', details: v.errors }); return; }

      /* Verrou : un double clic ou deux onglets ne produisent jamais deux
         signatures. Le verrou expire seul au bout de 90 s si tout plante. */
      const locked = await db.runTransaction(async function (tx) {
        const s = await tx.get(found.ref);
        const X = s.data() || {};
        const sx = (X.signers || [])[i];
        if ((sx && sx.status === 'signed') || X.status === 'signed') return 'deja';
        if (X.submitLock && X.submitLock.at > Date.now() - 90000) return 'encours';
        tx.update(found.ref, { submitLock: { at: Date.now(), signer: i } });
        return 'ok';
      });
      if (locked === 'deja') { send(res, 409, { error: 'Vous avez déjà signé ce contrat.', stage: 'signed' }); return; }
      if (locked === 'encours') { send(res, 409, { error: 'Signature déjà en cours de traitement. Patientez quelques secondes.' }); return; }

      try {
        const result = await finalize(found, ctx, v, info, body);
        send(res, 200, result);
      } catch (e) {
        await found.ref.update({ submitLock: admin.firestore.FieldValue.delete() }).catch(function () {});
        throw e;
      }
      return;
    }

    send(res, 400, { error: 'Action inconnue.' });
  } catch (e) {
    if (e && e.status && e.msg) { send(res, e.status, { error: e.msg }); return; }
    if (e && e.status === 429) { send(res, 429, { error: e.message || 'Trop de requêtes.' }); return; }
    if (e && e.status && e.status < 500) { send(res, e.status, { error: e.message }); return; }
    console.error('[sign-session]', action, found && found.id, e && e.stack ? e.stack : e);
    send(res, 500, { error: 'Erreur serveur. Réessayez dans un instant.' });
  }
};

function storedToStamp(role, d) {
  return {
    role: role, company: d.company, repName: d.rep.full, repQualite: d.rep.qualite,
    email: d.email, phone: d.phone, date: d.date, luApprouve: d.luApprouve,
    checks: d.checks || {}, texts: d.texts || {},
    signaturePng: d.signaturePngB64 ? Buffer.from(d.signaturePngB64, 'base64') : null,
    paraphePng: d.paraphePngB64 ? Buffer.from(d.paraphePngB64, 'base64') : null,
    caption: d.caption || '',
  };
}

/* ── Signature : enregistrement, PDF, preuve, sceau ──────────────────────── */
async function finalize(found, ctx, v, info, body) {
  const R = found.R;
  const i = found.signerIndex;
  const signers = Array.isArray(R.signers) ? R.signers.slice() : [];
  const nowIso = new Date().toISOString();
  const certId = 'SIG-' + Date.now().toString(36).toUpperCase() + '-' + crypto.randomBytes(3).toString('hex').toUpperCase();
  const caption = 'Signé électroniquement par ' + v.rep.full + ' le ' + core.parisDateTime(new Date()) + ' · réf. ' + certId;
  const otp = (R.otpBySigner || {})[String(i)] || {};

  /* Ce que le signataire a fait, tel que relu depuis le journal serveur. */
  const audit0 = await core.readAudit(found.ref);
  const mine = audit0.entries.filter(function (e) { return e.signer === i; });
  function firstAt(type, pred) { const e = mine.find(function (x) { return x.type === type && (!pred || pred(x)); }); return e ? e.at : ''; }
  function lastAt(type, pred) { const l = mine.filter(function (x) { return x.type === type && (!pred || pred(x)); }); return l.length ? l[l.length - 1].at : ''; }

  const readDone = (R.readDone || {})[String(i)] || {};
  const rd = readDone.data || {};
  const sectionsVues = rd.vues != null ? rd.vues : mine.filter(function (e) { return e.type === 'section_vue'; }).length;

  const data = {
    signerIndex: i,
    certificateId: certId,
    company: v.company,
    rep: v.rep,
    email: found.signer.email || R.clientEmail || '',
    phone: found.signer.phone || R.clientPhone || '',
    date: v.date, luApprouve: v.luApprouve,
    paraphe: v.paraphe || '',
    checks: v.checks, texts: v.texts,
    signatureName: v.signatureName,
    trace: v.trace,
    signaturePngB64: v.signaturePng.toString('base64'),
    paraphePngB64: v.paraphePng ? v.paraphePng.toString('base64') : '',
    caption: caption,
    signedAt: nowIso,
    ip: info.ip, ua: info.ua, geo: [info.city, info.region, info.country].filter(Boolean).join(', '),
    dirigeantCheck: i === 0 ? dirigeantCheck(v.registry || null, v.rep.first, v.rep.last) : 'Second signataire',
    declarations: [
      { id: 'pouvoir', etat: 'Accepté', libelle: DECLARATIONS.pouvoir, at: lastAt('consentement', function (e) { return e.data && e.data.id === 'pouvoir'; }) },
      { id: 'esign', etat: 'Accepté', libelle: DECLARATIONS.esign, at: lastAt('consentement', function (e) { return e.data && e.data.id === 'esign'; }) },
    ].concat(v.spec.checks.map(function (c) {
      const ty = v.checks[c.id] ? 'case_cochee' : 'case_decochee';
      let lib = c.label;
      if (c.kind === 'renonciation') {
        lib += v.checks[c.id]
          ? ' — Démarrage immédiat demandé ; renonciation au délai de rétractation.'
          : ' — Pas de renonciation : l\'accompagnement démarrera à l\'issue du délai de rétractation, à partir du ' + startNoWaiver() + '. Information affichée au signataire avant signature.';
      }
      return { id: c.id, etat: v.checks[c.id] ? 'Coché' : 'Non coché', libelle: lib, at: lastAt(ty, function (e) { return e.data && e.data.id === c.id; }) };
    })),
    lecture: (ctx.webMode ? sectionsVues + ' article(s) sur ' + (ctx.web.sections || []).length + ' affichés à l\'écran' : 'PDF original lu page par page')
      + (rd.duree ? ' — durée de lecture ' + rd.duree : '') + ' — fin de lecture confirmée le ' + core.parisDateTime(new Date(readDone.at || nowIso)),
    pdfConsulte: firstAt('pdf_original_ouvert') ? 'Oui, le ' + core.parisDateTime(new Date(firstAt('pdf_original_ouvert'))) : 'Non',
    apercu: firstAt('apercu_ouvert') ? 'Oui, le ' + core.parisDateTime(new Date(firstAt('apercu_ouvert'))) : 'Non consulté',
    otpLine: otp.atMs ? ('Code à usage unique envoyé par SMS au ' + (otp.phone || '') + ', validé le ' + core.parisDateTime(new Date(otp.atMs))) : 'Non vérifié',
    otpAtMs: otp.atMs || null,
  };
  data.mentions = [
    { nom: 'Date de signature', valeur: v.date, at: lastAt('mention_saisie', function (e) { return e.data && e.data.nom === 'date'; }) },
    { nom: 'Mention', valeur: v.luApprouve, at: lastAt('mention_saisie', function (e) { return e.data && e.data.nom === 'lu_approuve'; }) },
    { nom: 'Nom sous la signature', valeur: v.signatureName, at: '' },
  ];
  if (v.paraphe) data.mentions.push({ nom: 'Paraphe (initiales)', valeur: v.paraphe, at: lastAt('paraphe_saisi') });
  Object.keys(v.texts || {}).forEach(function (k) {
    const t = v.spec.texts.find(function (x) { return x.id === k; });
    if (v.texts[k]) data.mentions.push({ nom: (t && t.label) || 'Texte', valeur: v.texts[k], at: '' });
  });

  await found.ref.collection('signer_data').doc(String(i)).set(Object.assign({}, data, { serverTs: admin.firestore.FieldValue.serverTimestamp() }));
  await core.appendAudit(found.ref, [{
    type: 'signature_validee', signer: i,
    data: { ref: certId, nom: v.rep.full, qualite: v.rep.qualite, societe: (v.company && v.company.name) || '', empreinte: core.sha256Hex(JSON.stringify([data.company, data.rep, data.date, data.luApprouve, data.checks, data.texts, data.signaturePngB64])) },
  }], info);

  const isFinal = !signers.length || i >= signers.length - 1;
  const signerSummary = {
    status: 'signed', signedAtLocal: nowIso, signedAt: nowIso,
    signatureText: v.signatureName, parapheText: v.paraphe || '',
    certificateId: certId, company: i === 0 ? v.company : undefined,
    representative: { firstName: v.rep.first, lastName: v.rep.last, qualite: v.rep.qualite },
  };
  if (signerSummary.company === undefined) delete signerSummary.company;
  if (signers[i]) signers[i] = Object.assign({}, signers[i], signerSummary);

  if (!isFinal) {
    await found.ref.update({
      signers: signers, status: 'partial', currentSigner: i + 1,
      partialSignedAt: admin.firestore.FieldValue.serverTimestamp(),
      events: admin.firestore.FieldValue.arrayUnion({ type: 'signed', by: 'signer' + (i + 1), date: nowIso }),
      submitLock: admin.firestore.FieldValue.delete(),
    });
    return { ok: true, final: false, certificateId: certId, nextSigner: (signers[i + 1] && signers[i + 1].name) || '' };
  }

  /* ── Signature finale : PDF + dossier de preuve + sceaux ─────────────── */
  const all = [];
  for (let k = 0; k <= i; k++) {
    const d = k === i ? data : ((await found.ref.collection('signer_data').doc(String(k)).get()).data() || null);
    if (d) all.push(d);
  }
  const audit = await core.readAudit(found.ref);
  let auditTsa = null;
  try {
    const t = await timestamp(Buffer.from(audit.headHash, 'hex'));
    auditTsa = { authority: t.authority, genTime: t.genTime, url: t.url, tokenB64: t.token.toString('base64') };
  } catch (e) { console.error('[sign-session] horodatage du journal impossible :', e && e.message); }

  /* Conditions convenues, remplies par le conseiller à l'envoi : elles
     figurent au dossier de preuve, le client les a vues sans pouvoir les
     modifier. */
  const spec0 = formSpec(ctx.fields, 1, ctx.hints, ctx.prefill);
  const conditions = spec0.conditions.map(function (c) { return (c.value ? 'Retenu : ' : 'Non retenu : ') + c.label; })
    .concat(spec0.texts.filter(function (t) { return t.locked; }).map(function (t) { return t.label + ' : ' + (t.value || '—'); }));
  const renCheck = spec0.checks.find(function (c) { return c.kind === 'renonciation'; });
  const renonce = renCheck ? !!(all[0].checks || {})[renCheck.id] : null;

  const proof = {
    conditions: conditions,
    templateName: R.templateName || 'Contrat',
    requestId: found.id,
    certificateId: certId,
    webMode: ctx.webMode,
    webVersion: ctx.web ? (ctx.web.version || 1) : null,
    templatePdfSha256: ctx.tpl.pdfSha256,
    webDigest: core.webDigest(ctx.web),
    createdAt: R.createdAt && R.createdAt.toDate ? R.createdAt.toDate().toISOString() : '',
    createdBy: ((R.events || []).find(function (e) { return e && e.type === 'created'; }) || {}).by || '',
    company: Object.assign({}, all[0].company),
    signers: all.map(function (d) {
      return {
        repName: d.rep.full, repQualite: d.rep.qualite, dirigeantCheck: d.dirigeantCheck,
        email: d.email, phone: d.phone, otpLine: d.otpLine, otpAt: d.otpAtMs,
        ip: d.ip, geo: d.geo, ua: d.ua, signedAt: d.signedAt,
        declarations: d.declarations, lecture: d.lecture, pdfConsulte: d.pdfConsulte, apercu: d.apercu,
        mentions: d.mentions,
        signaturePng: Buffer.from(d.signaturePngB64, 'base64'),
        paraphePng: d.paraphePngB64 ? Buffer.from(d.paraphePngB64, 'base64') : null,
        traceInfo: d.trace.strokes + ' trait(s), ' + d.trace.points + ' points' + (d.trace.durationMs ? ', ' + fmtDuree(d.trace.durationMs) : ''),
      };
    }),
    audit: audit.entries,
    auditIntact: audit.intact,
    auditHead: audit.headHash,
    auditTsa: auditTsa,
  };

  const out = await buildSignedPdf({
    templatePdf: ctx.tpl.pdf, fields: ctx.fields, scale: ctx.scale, prefill: ctx.prefill,
    signers: all.map(function (d, k) { return storedToStamp(roleOf(k), d); }),
    proof: proof,
  });
  const finalSha = core.sha256Hex(out.bytes);
  const b64 = out.bytes.toString('base64');

  /* Le PDF : en clair sous ~900 Ko, sinon en morceaux (limite 1 Mo/doc).
     Même stockage qu'avant : signature-completed, le bouton Télécharger de
     l'équipe et la Cloud Function le relisent tel quel. */
  const upd = {};
  if (b64.length < 900000) upd.signedPdfBase64 = b64;
  else {
    const CS = 600000;
    const batch = db.batch();
    for (let k = 0, n = 0; k < b64.length; k += CS, n++) {
      batch.set(found.ref.collection('signed_pdf').doc('chunk_' + String(n).padStart(3, '0')), { chunk: n, data: b64.slice(k, k + CS) });
    }
    await batch.commit();
    upd.signedPdfBase64 = admin.firestore.FieldValue.delete();
  }

  const d0 = all[0];
  const fv = {
    nom_prenom: d0.rep.full, email: d0.email, telephone: d0.phone,
    entreprise: d0.company.name, type_entreprise: d0.company.legalFormLabel,
    siege_social: d0.company.addressLine, adresse: d0.company.addressLine, siret: d0.company.siret,
    date_signature: d0.date, lu_approuve: d0.luApprouve, qualite: d0.rep.qualite,
  };
  Object.keys(d0.checks || {}).forEach(function (k) { fv[k] = d0.checks[k]; });
  Object.keys(d0.texts || {}).forEach(function (k) { if (d0.texts[k]) fv[k] = d0.texts[k]; });
  Object.keys(ctx.prefill || {}).forEach(function (k) { if (ctx.prefill[k]) fv[k] = ctx.prefill[k]; });

  Object.assign(upd, {
    status: 'signed',
    signedAt: admin.firestore.FieldValue.serverTimestamp(),
    signedAtIso: nowIso,
    signers: signers,
    fieldValues: fv,
    signatureText: d0.signatureName, parapheText: d0.paraphe || '',
    certificateId: certId,
    documentHash: finalSha,
    signedPdfSha256: finalSha,
    signedPdfBytes: out.bytes.length,
    flow: 'v2',
    renonciationRetractation: renonce,
    demarragePossibleLe: renonce === false ? startNoWaiver() : (renonce === true ? core.parisToday() : null),
    company: d0.company,
    representative: { firstName: d0.rep.first, lastName: d0.rep.last, qualite: d0.rep.qualite },
    seal: out.seal ? { authority: out.seal.authority, genTime: out.seal.genTime } : { error: out.sealError || 'echec' },
    auditTsa: auditTsa,
    auditHeadAtSignature: { seq: audit.entries.length, hash: audit.headHash, intact: audit.intact },
    signingMeta: { userAgent: info.ua, ip: info.ip, geo: d0.geo, language: info.lang, signedAtLocal: nowIso },
    events: admin.firestore.FieldValue.arrayUnion({ type: 'signed', by: 'signer' + (i + 1), date: nowIso }),
    submitLock: admin.firestore.FieldValue.delete(),
  });
  await found.ref.update(upd);
  await core.appendAudit(found.ref, [{ type: 'document_genere', signer: null, data: { sha256: finalSha, octets: out.bytes.length, sceau: out.seal ? out.seal.authority : 'aucun' } }], info);

  /* Passage du lead en client + webhook Make : traités par la Cloud Function
     onWebhookInbox (action publique signature_completed), comme avant. */
  await db.collection('webhook_inbox').add({
    action: 'signature_completed',
    signatureRequestId: found.id,
    clientName: R.clientName || d0.rep.full,
    clientEmail: R.clientEmail || d0.email,
    templateName: R.templateName || '',
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  return { ok: true, final: true, certificateId: certId, sha256: finalSha, sealed: !!out.seal };
}
