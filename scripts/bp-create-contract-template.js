// ============================================================================
// scripts/bp-create-contract-template.js — MODÈLE DE CONTRAT BUSINESS 6 MOIS
// ----------------------------------------------------------------------------
// Crée le modèle de signature « Business Phénix 6 mois — BP PIF / BP MENS »
// (signature_templates/{id}) à partir du texte rédigé dans
// scripts/data/contrats-atelier/business-phenix-6-mois.json.
//
// FORMAT : contrat de l'ATELIER (web.generated = true). Aucun PDF d'origine :
// le PDF est composé par api/_contract-render.js à l'aperçu et à la signature,
// exactement comme pour les contrats créés dans contract-studio.html. Le
// document écrit est celui que l'atelier écrirait (action « save » sans
// templateId) : même nettoyage (cleanWeb, lu dans api/contract-studio.js),
// mêmes champs, plus la version 1 dans signature_templates/{id}/versions/0001.
//
// NOTE DE RELECTURE AVOCAT : jamais dans `web` (le texte envoyé au client et
// composé dans le PDF). Elle est posée :
//   - au niveau du document : signature_templates/{id}.noteRelecture
//     (conservée par les enregistrements de l'atelier, qui fusionnent) ;
//   - dans la note de la version 1, visible dans l'atelier (bouton Versions).
//
// Règle n°3 du repo : MODE LECTURE SEULE PAR DÉFAUT. Le script lit la base
// (modèle Elite de référence, modèles BP12, doublon éventuel) et affiche ce
// qu'il écrirait. L'écriture n'a lieu qu'avec --apply, après validation
// d'Adrien.
//
// Usage :
//   export GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
//   node scripts/bp-create-contract-template.js                  # à blanc
//   node scripts/bp-create-contract-template.js --apply          # création
//   node scripts/bp-create-contract-template.js --archiver-anciens   # à blanc
//   node scripts/bp-create-contract-template.js --archiver-anciens --remplace-par=<id> --apply
//
// Options :
//   --apply               écrit (sinon : à blanc)
//   --archiver-anciens    montre (ou, avec --apply, pose) le marquage
//                         « archivé » des deux modèles BP12, sans rien supprimer
//   --remplace-par=<id>   id du nouveau modèle, pour l'archivage seul
//   --copier-make         reprend le webhook Make « Onboarding BP » du modèle
//                         BP12 5K PIF (désactivé par défaut, voir plus bas)
//   --apercu=<fichier>    compose un PDF d'aperçu (filigrane) des deux formules
//   --texte               affiche le contrat en texte lisible, article par article
//   --hors-ligne          à blanc sans lire la base (contrôles locaux seulement)
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ARGS = process.argv.slice(2);
function flag(n) { return ARGS.indexOf(n) >= 0; }
function opt(n) {
  const a = ARGS.find(function (x) { return x.indexOf(n + '=') === 0; });
  return a ? a.slice(n.length + 1) : '';
}
const APPLY = flag('--apply');
const ARCHIVE = flag('--archiver-anciens');
const COPY_MAKE = flag('--copier-make');
const SHOW_TEXT = flag('--texte');
const PREVIEW = opt('--apercu');
const REPLACE_BY = opt('--remplace-par');
const OFFLINE = flag('--hors-ligne');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(__dirname, 'data', 'contrats-atelier', 'business-phenix-6-mois.json');
const NAME = 'Business Phénix 6 mois — BP PIF / BP MENS';
const ELITE_ID = 'RLdu8SffTL3zGrHPzH0a';            // EP6 12K/13K — modèle de structure
const BP12_IDS = ['UrrTWtDS3jPbzqbWt1c4', 'KcbNLtTOnXYWjt4FyrBM']; // BP12 5K PIF, BP12 6K MENS
const BY = 'script bp-create-contract-template.js';

/* ── cleanWeb de l'atelier, lu dans api/contract-studio.js ──────────────────
   On ne peut pas require() ce fichier hors Vercel (il initialise
   firebase-admin avec les variables d'environnement Vercel). On en extrait
   la fonction de validation et on l'exécute dans un bac à sable : le texte
   est nettoyé et contrôlé EXACTEMENT comme l'atelier le ferait. */
function loadCleanWeb() {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'contract-studio.js'), 'utf8');
  const a = src.indexOf('const KEY_RE');
  const b = src.indexOf('/* Le texte d\'un modèle');
  if (a < 0 || b < 0 || b <= a) throw new Error('cleanWeb introuvable dans api/contract-studio.js (le fichier a changé ?)');
  const code = src.slice(a, b).replace(/^const KEY_RE/, 'var KEY_RE');
  const box = {};
  vm.runInNewContext(code + '\nthis.cleanWeb = cleanWeb;', box);
  if (typeof box.cleanWeb !== 'function') throw new Error('cleanWeb non chargée');
  return box.cleanWeb;
}

/* ── Contrôles propres au cahier des charges Business ───────────────────── */
/* JSON à clés triées : compare deux structures sans dépendre de l'ordre des clés. */
function canon(v) {
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
  return JSON.stringify(v);
}
function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase(); }
/* Copie de _formuleOf (sales-signatures.html) : c'est elle qui coche la
   formule quand le pilote de closing ouvre la fenêtre d'envoi. */
function formuleOf(txt) {
  txt = fold(txt);
  if (/integral|une fois|comptant/.test(txt)) return 'pif';
  if (/echelonn|mensualis|plusieurs fois/.test(txt)) return 'mensualise';
  return '';
}
function allText(web) {
  const parts = [web.title, web.subtitle, web.tagline];
  web.sections.forEach(function (s) { parts.push(s.title); s.blocks.forEach(function (b) { parts.push(b); }); });
  web.variables.forEach(function (v) { parts.push(v.label, v.help); (v.options || []).forEach(function (o) { parts.push(o.label); }); });
  web.clientChecks.forEach(function (c) { parts.push(c.label); });
  return parts.join('\n');
}
function businessChecks(web) {
  const errs = [];
  const txt = allText(web);
  const f = fold(txt);
  /* Interdits du cahier (§2.1, recette §14) dans un document client. */
  [
    [/\bformations?\b/, '« formation »'], [/garanti/, '« garantie »'], [/titan/, 'Titan'],
    [/12 mois|douze mois|10 mois|douze \(12\) mois/, 'durée 12 / 10 mois'], [/piliers/, '« piliers »'],
    [/mini.?elite|petit elite/, '« mini Elite »'], [/remise/, 'remise'], [/seances? offerte/, 'séances offertes'],
    [/231b|mourre|83440/, 'adresse du siège'], [/\{\{telephone\}\}|\+33|\b0[1-9](?:[ .]?\d\d){4}\b/, 'numéro de téléphone'],
    [/30 jours pour|delai de 30 jours/, 'délai de 30 jours pour passer au comptant'],
    [/the vault|le cercle|whatsapp/, 'élément réservé à Elite (The Vault, Le Cercle, WhatsApp)'],
  ].forEach(function (r) { if (r[0].test(f)) errs.push('terme interdit présent : ' + r[1]); });
  /* Présences obligatoires. */
  [
    [/contact@adrienemily\.com/, 'contact de rétractation contact@adrienemily.com'],
    [/accompagnement/, '« accompagnement »'], [/cent quatre-vingts \(180\) jours/, '180 jours'],
    [/dix \(10\) coachings individuels de soixante \(60\) minutes/, '10 coachings de 60 min'],
    [/rdv audit business/, 'RDV audit business'], [/quarante-huit \(48\) heures/, 'report 48 h'],
    [/obligation de moyens/, 'obligation de moyens'], [/5 000 € ht/, '5 000 € HT'], [/6 000 € ht/, '6 000 € HT'],
    [/six \(6\)/, '6 mensualités maximum'], [/943 098 707/, 'SIREN / SIRET'], [/draguignan/, 'RCS / juridiction'],
  ].forEach(function (r) { if (!r[0].test(f)) errs.push('mention attendue absente : ' + r[1]); });
  /* Formule : un choix « integral / echelonne » que le pilote sait cocher. */
  const fv = web.variables.find(function (v) { return v.type === 'choice'; });
  if (!fv) errs.push('aucune variable « formule de paiement » (choix)');
  else {
    const found = (fv.options || []).map(function (o) { return formuleOf(o.value + ' ' + o.label); });
    if (found.indexOf('pif') < 0 || found.indexOf('mensualise') < 0) errs.push('les options de « ' + fv.label + ' » ne sont pas reconnues comme pif / mensualise par _formuleOf : ' + JSON.stringify(found));
  }
  const mv = web.variables.find(function (v) { return /mensualit/i.test(v.label); });
  if (!mv) errs.push('aucune variable dont le libellé contient « mensualit » (pré-remplissage du nombre de mensualités)');
  else if (!fv || mv.requiredIf !== fv.key + '=' + ((fv.options || []).find(function (o) { return formuleOf(o.value + ' ' + o.label) === 'mensualise'; }) || {}).value) errs.push('« ' + mv.label + ' » doit être requis si la formule est échelonnée (requiredIf)');
  const ren = web.clientChecks.filter(function (c) { return c.kind === 'renonciation'; });
  if (ren.length !== 1) errs.push('il faut exactement une case client kind « renonciation » (' + ren.length + ' trouvée(s))');
  if (!web.sections.some(function (s) { return s.signatures; })) errs.push('pas de section de signatures (signatures:true)');
  return errs;
}

/* Identifiant au format Firestore (20 caractères alphanumériques). */
function newId() {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(40);
  let s = '';
  for (let i = 0; i < bytes.length && s.length < 20; i++) if (bytes[i] < 248) s += A.charAt(bytes[i] % 62);
  return s;
}

function plain(web, prefill) {
  const render = require('../api/_contract-render');
  const r = render.resolveForSigner(web, prefill);
  const out = [r.title, r.subtitle, r.tagline, ''];
  r.sections.forEach(function (s) {
    out.push('', s.title);
    s.blocks.forEach(function (b) {
      const m = /^(p|h|li|ol|i|q|field):(.*)$/.exec(b);
      if (!m) return;
      if (m[1] === 'field') {
        const c = web.clientChecks.find(function (x) { return x.id === m[2]; });
        out.push('   [ ] ' + (c ? c.label : m[2]) + (c && c.kind ? '   (kind : ' + c.kind + ')' : ''));
      } else out.push((m[1] === 'li' ? '   • ' : (m[1] === 'h' ? '  ' : '   ')) + m[2].replace(/\*\*/g, ''));
    });
  });
  return out.join('\n');
}

async function makePreview(web, file) {
  const render = require('../api/_contract-render');
  const { PDFDocument } = require('pdf-lib');
  const client = {
    entreprise: 'SOCIÉTÉ EXEMPLE SARL', nom_prenom: 'Camille Martin', qualite: 'Gérante',
    siege_social: '12 rue de la République, 83000 Toulon', siret: '12345678900012', forme_juridique: 'SARL',
    date_signature: new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }),
  };
  const out = await PDFDocument.create();
  const variants = [{ formule: 'integral' }, { formule: 'echelonne', mensualites: '6' }];
  for (const prefill of variants) {
    const built = await render.composeContract({ web: web, prefill: prefill, client: client, checks: {}, signers: [], preview: true });
    const pages = await out.copyPages(built.doc, built.doc.getPageIndices());
    pages.forEach(function (p) { out.addPage(p); });
  }
  fs.writeFileSync(file, Buffer.from(await out.save()));
  console.log('Aperçu PDF (comptant puis échelonné en 6 fois) :', file);
}

(async function () {
  console.log(APPLY ? '=== MODE ÉCRITURE ===' : '=== MODE À BLANC (aucune écriture) ===');
  const data = JSON.parse(fs.readFileSync(SRC, 'utf8'));
  const cleanWeb = loadCleanWeb();
  const c = cleanWeb(data.web);
  const errs = c.errors.concat(businessChecks(c.web));
  /* cleanWeb ne doit rien perdre du fichier source (sinon une clé est mal écrite). */
  ['title', 'subtitle', 'tagline', 'place'].forEach(function (k) { if ((data.web[k] || '') !== c.web[k]) errs.push('le nettoyage de l\'atelier modifie « ' + k + ' »'); });
  ['variables', 'clientChecks', 'sections'].forEach(function (k) { if (canon(data.web[k]) !== canon(c.web[k])) errs.push('le nettoyage de l\'atelier modifie « ' + k + ' » (clé mal écrite ou valeur hors limites)'); });

  if (APPLY && OFFLINE) { console.log('✗ --apply et --hors-ligne sont incompatibles'); process.exit(1); }
  const R = OFFLINE ? null : require('./_firestore-rest');
  let elite = null;
  let bp12 = [];
  let existing = [];
  if (R) {
    try {
      elite = await R.getDoc('signature_templates/' + ELITE_ID);
      for (const id of BP12_IDS) bp12.push(await R.getDoc('signature_templates/' + id));
      existing = await R.runQuery({ from: [{ collectionId: 'signature_templates' }], where: R.ff('name', 'EQUAL', NAME), select: { fields: [{ fieldPath: 'name' }, { fieldPath: 'createdAt' }] } });
    } catch (e) {
      if (APPLY) throw e;
      console.log('⚠ Lecture de la base impossible (' + e.message.slice(0, 120) + ') — contrôles en ligne sautés.');
    }
  }

  /* Le schéma du texte doit être celui du modèle Elite (atelier). Les clés
     propres aux transcriptions PDF (fieldHints, source, importedAt,
     sourcePdfSha256) n'existent pas dans un contrat créé dans l'atelier. */
  if (elite && elite.data.web) {
    const ek = Object.keys(elite.data.web).filter(function (k) { return ['fieldHints', 'source', 'importedAt', 'sourcePdfSha256'].indexOf(k) < 0; }).sort();
    const nk = Object.keys(Object.assign({}, c.web, { version: 1, savedAt: '', savedBy: '' })).sort();
    if (JSON.stringify(ek) !== JSON.stringify(nk)) errs.push('clés de web différentes du modèle Elite : Elite ' + ek.join(',') + ' / nouveau ' + nk.join(','));
    else console.log('✓ Schéma du texte identique au modèle Elite (' + nk.join(', ') + ')');
    if (!elite.data.web.generated) errs.push('le modèle Elite n\'est plus un contrat de l\'atelier — vérifier le format avant de continuer');
  }
  if (existing.length) errs.push('un modèle « ' + NAME + ' » existe déjà : ' + existing.map(function (x) { return x.id; }).join(', ') + ' — rien n\'est recréé');

  if (errs.length) {
    console.log('\n✗ Contrat refusé :');
    errs.forEach(function (e) { console.log('   -', e); });
    process.exit(1);
  }
  console.log('✓ Texte validé par le nettoyage de l\'atelier (cleanWeb) et par les contrôles Business');

  /* ── Document à créer ─────────────────────────────────────────────────── */
  const nowIso = new Date().toISOString();
  const web = Object.assign({}, c.web, { version: 1, savedAt: nowIso, savedBy: BY });
  /* Make : le scénario « Onboarding BP » des modèles BP12 n'est PAS repris
     par défaut — il a été construit pour l'ancienne formule 12 mois (libellés,
     accès). À vérifier dans Make, puis --copier-make ou réglage dans
     l'atelier (Réglages après signature). */
  let make = { automationEnabled: false, automationWebhookUrl: '', automationNote: '' };
  if (COPY_MAKE) {
    const src = bp12[0] && bp12[0].data;
    if (!src || !src.automationWebhookUrl) { console.log('✗ --copier-make : webhook du modèle BP12 5K PIF introuvable'); process.exit(1); }
    make = { automationEnabled: !!src.automationEnabled, automationWebhookUrl: src.automationWebhookUrl, automationNote: (src.automationNote || 'Onboarding BP') + ' (repris de BP12 5K PIF)' };
  }
  const note = data.noteRelecture || {};
  const doc = {
    name: NAME,
    web: web,
    generated: true,
    fields: [],
    pages: 0,
    isAdhoc: false,
    audience: 'equipe',
    academyCourseId: data.academyCourseId || 'parcours-v2-business',
    academyCourseName: data.academyCourseName || '',
    automationEnabled: make.automationEnabled,
    automationWebhookUrl: make.automationWebhookUrl,
    automationNote: make.automationNote,
    noteRelecture: {
      statut: note.statut || 'a_relire',
      titre: note.titre || '',
      resume: note.resume || '',
      points: note.points || [],
      creeLe: nowIso,
      creePar: BY,
    },
    createdAt: new Date(nowIso),
    updatedAt: new Date(nowIso),
  };
  const version = {
    version: 1, name: NAME, web: web,
    note: String(note.resume || 'Création du modèle Business 6 mois').slice(0, 300),
    by: BY, at: new Date(nowIso), atIso: nowIso,
  };

  console.log('\n' + (note.titre || 'NOTE DE RELECTURE'));
  (note.points || []).forEach(function (p) { console.log('  ' + p); });

  /* --id=<id> : identifiant choisi (mise en service rejouable sans doublon :
     createDoc échoue si le document existe déjà). */
  const FIXED_ID = (ARGS.find(function (a) { return a.indexOf('--id=') === 0; }) || '').slice(5);
  const id = FIXED_ID || (APPLY && !ARCHIVE ? newId() : '<nouvelId>');
  console.log('\n── signature_templates/' + id + ' ──');
  const shown = JSON.parse(JSON.stringify(doc));
  if (shown.automationWebhookUrl) shown.automationWebhookUrl = shown.automationWebhookUrl.replace(/[^/]+$/, '…');
  console.log(JSON.stringify(shown, null, 2));
  console.log('\n── signature_templates/' + id + '/versions/0001 ── (note : « ' + version.note + ' », web identique)');

  /* Rendu côté signataire, pour les deux formules : prix et mensualités. */
  const render = require('../api/_contract-render');
  [{ formule: 'integral' }, { formule: 'echelonne', mensualites: '6' }].forEach(function (p) {
    const r = render.resolveForSigner(web, p);
    const prix = r.sections.find(function (s) { return s.id === 'art4'; }).blocks.filter(function (b) { return /€ HT/.test(b); });
    console.log('Formule « ' + p.formule + ' » → ' + prix.join(' | ').replace(/\*\*/g, ''));
  });
  if (SHOW_TEXT) console.log('\n' + plain(web, { formule: 'echelonne', mensualites: '6' }));
  if (PREVIEW) await makePreview(web, path.resolve(PREVIEW));

  /* ── Archivage des modèles BP12 (jamais de suppression) ───────────────
     Aucun champ « archivé » n'existe aujourd'hui sur signature_templates :
     sales-signatures.html masque seulement isAdhoc et audience 'admin'. Le
     champ proposé est `archived` (+ date, auteur, motif, remplaçant) ; tant
     que la grille ne le lit pas, le marquage n'a AUCUN effet visible. */
  if (ARCHIVE) {
    console.log('\n── Archivage des modèles BP12 ──');
    if (APPLY && !REPLACE_BY) { console.log('✗ --archiver-anciens --apply exige --remplace-par=<id du nouveau modèle>'); process.exit(1); }
    if (REPLACE_BY && R) {
      const nd = await R.getDoc('signature_templates/' + REPLACE_BY);
      if (!nd || nd.data.name !== NAME) { console.log('✗ --remplace-par : ' + REPLACE_BY + ' n\'est pas le modèle « ' + NAME + ' »'); process.exit(1); }
    }
    const patch = { archived: true, archivedAt: new Date(nowIso), archivedBy: BY, archivedReason: 'Remplacé par le contrat Business Phénix 6 mois (nouveau format, 14/10/2026). Reste la référence des clients signés en ancienne formule 12 mois.', replacedBy: REPLACE_BY || '<nouvelId>' };
    for (let i = 0; i < BP12_IDS.length; i++) {
      const t = bp12[i];
      if (!t) { console.log('✗', BP12_IDS[i], 'introuvable'); continue; }
      console.log((t.data.archived ? '= déjà archivé ' : '~ ') + BP12_IDS[i] + ' « ' + t.data.name + ' » : ' + JSON.stringify(Object.assign({}, patch, { archivedAt: nowIso })));
      if (APPLY && !t.data.archived) {
        await R.patchDoc('signature_templates/' + BP12_IDS[i], patch, Object.keys(patch));
        console.log('   → marqué archivé (rien d\'autre n\'est modifié : texte, PDF, Make, Academy intacts)');
      }
    }
    if (APPLY) return;
  }

  if (!APPLY) { console.log('\nRelancer avec --apply pour écrire.'); return; }

  /* ── Écriture ────────────────────────────────────────────────────────── */
  await R.createDoc('signature_templates/' + id, doc);
  await R.createDoc('signature_templates/' + id + '/versions/0001', version);
  console.log('\n✓ Modèle créé : signature_templates/' + id);
  console.log('  → à ajouter dans _config/business_phenix.templateIds');
  console.log('  → à relire dans l\'atelier : contract-studio.html?id=' + id);
})().catch(function (e) { console.error(e); process.exit(1); });
