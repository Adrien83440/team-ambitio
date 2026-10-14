// ============================================================================
// scripts/bp-mise-en-service.js — MISE EN SERVICE DU NOUVEAU BUSINESS PHÉNIX
// ----------------------------------------------------------------------------
// Toutes les écritures de données de la refonte du 14/10/2026, dans l'ordre,
// rejouables sans doublon. DRY-RUN PAR DÉFAUT : affiche ce qui serait fait.
//
//   node scripts/bp-mise-en-service.js            # à blanc (lecture seule)
//   node scripts/bp-mise-en-service.js --apply    # écrit
//
// Clés (hors repo, jamais committées) :
//   ~/.secrets/ambitio-team-sa.json         (Firestore + Storage ambitio-team)
//   ~/.secrets/adrienemily-academy-sa.json  (cours Academy)
//
// Étapes :
//   1. Modèle de contrat « Business Phénix 6 mois — BP PIF / BP MENS »
//      (signature_templates/bp6m-business-phenix, via bp-create-contract-template)
//   2. _config/business_phenix : modèle, personnes autorisées à ajouter des
//      séances (Adrien, Emily). L'INTERRUPTEUR N'EST PAS ALLUMÉ : c'est le
//      bouton « Démarrer » de admin-offres.html.
//   3. _config/sales_close_pilot.typeBusinessAudit = rdv_audit_business
//   4. Type de RDV « RDV AUDIT BUSINESS » (copie du RDV plan d'action Elite,
//      30 min, coachs) dans booking_config/_types + agendas des coachs
//   5. Site public : pages accueil, about, product, contacts-page, CGV,
//      mentions légales (Storage + tunnels/{id}, mêmes liens de téléchargement)
//   6. Formations internes : ressources Business (bp-formations-ressources)
//   7. Academy : cours « Business Phénix » sans vidéo (creer-cours-business-6m)
//
// Rien n'est jamais supprimé. Chaque écriture relit l'état avant d'agir.
// ============================================================================
'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const HOME = process.env.HOME;
process.env.GOOGLE_APPLICATION_CREDENTIALS = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(HOME, '.secrets/ambitio-team-sa.json');
const R = require('./_firestore-rest.js');

const APPLY = process.argv.indexOf('--apply') >= 0;
const ROOT = path.join(__dirname, '..');
const ACADEMY = process.env.ACADEMY_REPO || path.join(HOME, 'Documents/ae-academy-bp');
const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';
const BUCKET = 'ambitio-team.firebasestorage.app';

const TEMPLATE_ID = 'bp6m-business-phenix';
const AUDIT_TYPE = 'rdv_audit_business';
const COACHS = ['edouard', 'flore_qox3', 'thomaspinet_dxstrq', 'farahjouffroy_3mbvgj'];
const GRANTERS = ['adrien_6j5q', 'emily'];          // booking_config → firebaseUid
const SITE = [
  { tunnel: '2eESotyqrGhi76AN0Vve', slug: 'accueil', file: 'site-adrienemily/index.html' },
  { tunnel: '2eESotyqrGhi76AN0Vve', slug: 'about', file: 'site-adrienemily/about.html' },
  { tunnel: '2eESotyqrGhi76AN0Vve', slug: 'product', file: 'site-adrienemily/product.html' },
  { tunnel: '2eESotyqrGhi76AN0Vve', slug: 'contacts-page', file: 'site-adrienemily/contacts-page.html' },
  { tunnel: 'CkbgqY9JVBR3ERBttBAE', slug: 'cgv', file: 'site-adrienemily/legal/cgv.html' },
  { tunnel: 'CkbgqY9JVBR3ERBttBAE', slug: 'mentions-legales', file: 'site-adrienemily/legal/mentions-legales.html' },
];

function titre(t) { console.log('\n━━ ' + t + ' ━━'); }
function info(t) { console.log('  ' + t); }
const F = function (m, k) { return m && m.mapValue && m.mapValue.fields && m.mapValue.fields[k]; };
async function raw(pathDoc) {
  const t = await R.token();
  try { return await R.request('GET', BASE + '/' + pathDoc, { Authorization: 'Bearer ' + t }); }
  catch (e) { if (/HTTP 404/.test(e.message)) return null; throw e; }
}
async function patchRaw(pathDoc, fields, mask) {
  const t = await R.token();
  const q = mask.map(function (m) { return 'updateMask.fieldPaths=' + encodeURIComponent(m); }).join('&');
  return R.request('PATCH', BASE + '/' + pathDoc + '?' + q, { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { fields: fields });
}
function child(cmd, args, env) {
  const out = execFileSync(cmd, args, { cwd: ROOT, env: Object.assign({}, process.env, env || {}), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  return out;
}

(async function () {
  console.log(APPLY ? '=== MISE EN SERVICE — ÉCRITURE (--apply) ===' : '=== MISE EN SERVICE — À BLANC (lecture seule) ===');

  /* 1. Modèle de contrat */
  titre('1. Modèle de contrat Business 6 mois');
  const tpl = await R.getDoc('signature_templates/' + TEMPLATE_ID);
  if (tpl) info('déjà en place : signature_templates/' + TEMPLATE_ID + ' (« ' + tpl.data.name + ' »)');
  else {
    const out = child('node', ['scripts/bp-create-contract-template.js', '--id=' + TEMPLATE_ID].concat(APPLY ? ['--apply'] : []));
    out.split('\n').filter(function (l) { return /✓|✗|Modèle|name|Relancer|erreur|Erreur/.test(l); }).slice(0, 12).forEach(info);
  }

  /* 2. _config/business_phenix */
  titre('2. _config/business_phenix');
  const uids = [];
  for (const g of GRANTERS) { const p = await R.getDoc('booking_config/' + g); if (p && p.data.firebaseUid) uids.push(p.data.firebaseUid); }
  const cfg = await R.getDoc('_config/business_phenix');
  const cur = (cfg && cfg.data) || {};
  const patch = {}, mask = [];
  const ids = (cur.templateIds || []).slice(); if (ids.indexOf(TEMPLATE_ID) < 0) { ids.push(TEMPLATE_ID); patch.templateIds = ids; mask.push('templateIds'); }
  const gr = (cur.sessionGranters || []).slice(); uids.forEach(function (u) { if (gr.indexOf(u) < 0) gr.push(u); });
  if (gr.length !== (cur.sessionGranters || []).length) { patch.sessionGranters = gr; mask.push('sessionGranters'); }
  if (cur.active === undefined) { patch.active = false; mask.push('active'); }
  if (cur.communityUrl === undefined) { patch.communityUrl = ''; mask.push('communityUrl'); }
  if (mask.length) { patch.updatedAt = new Date(); patch.updatedByName = 'Mise en service (Claude Code, validée par Adrien)'; mask.push('updatedAt', 'updatedByName'); }
  info(mask.length ? 'à écrire : ' + JSON.stringify(patch) : 'déjà à jour');
  info('interrupteur : ' + (cur.active === true ? 'ALLUMÉ' : 'éteint (bouton « Démarrer » de Offres & formules)'));
  if (APPLY && mask.length) await R.patchDoc('_config/business_phenix', patch, mask);

  /* 3. Pilote de closing */
  titre('3. _config/sales_close_pilot.typeBusinessAudit');
  const pil = await R.getDoc('_config/sales_close_pilot');
  if (pil && pil.data.typeBusinessAudit === AUDIT_TYPE) info('déjà à jour');
  else { info('à écrire : typeBusinessAudit = ' + AUDIT_TYPE + ' (typeBusiness inchangé : ' + ((pil && pil.data.typeBusiness) || '—') + ')'); if (APPLY) await R.patchDoc('_config/sales_close_pilot', { typeBusinessAudit: AUDIT_TYPE }, ['typeBusinessAudit']); }

  /* 4. Type de RDV « RDV AUDIT BUSINESS » */
  titre('4. Type de RDV « RDV AUDIT BUSINESS » (30 min, coachs)');
  const typesRaw = await raw('booking_config/_types');
  const list = typesRaw.fields.list.arrayValue.values;
  const has = list.some(function (v) { return F(v, 'id') && F(v, 'id').stringValue === AUDIT_TYPE; });
  if (has) info('type déjà présent');
  else {
    const src = list.find(function (v) { return F(v, 'id') && F(v, 'id').stringValue === 'rdv_plan_action_adrien'; });
    if (!src) throw new Error('modèle rdv_plan_action_adrien introuvable');
    const copy = JSON.parse(JSON.stringify(src));
    const f = copy.mapValue.fields;
    f.id = { stringValue: AUDIT_TYPE };
    f.label = { stringValue: 'RDV AUDIT BUSINESS' };
    f.duration = { integerValue: '30' };
    f.color = { stringValue: '#f97316' };
    f.isCoaching = { booleanValue: true };
    f.description = { stringValue: 'Dès la validation de votre inscription à Business Phénix, un rendez-vous de 30 minutes avec un coach du programme.\n\nUn premier point pour faire l\'état des lieux de votre entreprise et de vos problématiques, et préparer le démarrage de votre accompagnement.\n\nC\'est le point de départ de vos 10 séances individuelles.' };
    if (F(copy, 'rules')) F(copy, 'rules').mapValue.fields.maxNoticeDays = { integerValue: '4' };
    list.push(copy);
    info('à ajouter dans booking_config/_types (copie du « RDV PLAN ACTION AVEC ADRIEN & EMILY », 30 min, réservable sous 4 jours)');
    if (APPLY) await patchRaw('booking_config/_types', { list: typesRaw.fields.list }, ['list']);
  }
  for (const c of COACHS) {
    const p = await raw('booking_config/' + c);
    if (!p) { info('agenda introuvable : ' + c); continue; }
    const tv = (p.fields.types && p.fields.types.arrayValue && p.fields.types.arrayValue.values) || [];
    if (tv.some(function (x) { return x.stringValue === AUDIT_TYPE; })) { info(c + ' : déjà attribué'); continue; }
    info(c + ' : type à attribuer (' + tv.length + ' types aujourd\'hui)');
    if (APPLY) { tv.push({ stringValue: AUDIT_TYPE }); await patchRaw('booking_config/' + c, { types: { arrayValue: { values: tv } } }, ['types']); }
  }

  /* 5. Site public */
  titre('5. Site public (www.adrienemily.com)');
  const ds = await R.token();
  const gcs = await R.tokenFor('https://www.googleapis.com/auth/devstorage.read_write');
  const byT = {};
  SITE.forEach(function (s) { (byT[s.tunnel] = byT[s.tunnel] || []).push(s); });
  for (const tid of Object.keys(byT)) {
    const doc = await raw('tunnels/' + tid);
    let changed = false;
    for (const s of byT[tid]) {
      const st = doc.fields.steps.arrayValue.values.find(function (x) { return F(x, 'slug') && F(x, 'slug').stringValue === s.slug; });
      const va = F(st, 'variants').arrayValue.values.find(function (v) { return F(v, 'id').stringValue === 'a'; });
      const h = F(va, 'html').mapValue.fields;
      const url = h.url.stringValue, objPath = h.path.stringValue;
      const dl = (/[?&]token=([^&]+)/.exec(url) || [])[1];
      const html = fs.readFileSync(path.join(ROOT, s.file), 'utf8');
      const live = await (await fetch(url)).text();
      if (live === html) { info(s.slug + ' : déjà en ligne'); continue; }
      if (!dl) throw new Error('jeton de téléchargement absent : ' + s.slug);
      info(s.slug + ' : à publier (' + html.length + ' car., en ligne ' + live.length + ')');
      if (!APPLY) continue;
      const version = Date.now(), b = 'bnd' + version;
      const meta = { name: objPath, contentType: 'text/html; charset=utf-8', cacheControl: 'no-cache', metadata: { firebaseStorageDownloadTokens: dl, version: String(version) } };
      const body = '--' + b + '\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n' + JSON.stringify(meta) + '\r\n--' + b + '\r\nContent-Type: text/html; charset=utf-8\r\n\r\n' + html + '\r\n--' + b + '--';
      await R.request('POST', 'https://storage.googleapis.com/upload/storage/v1/b/' + BUCKET + '/o?uploadType=multipart', { Authorization: 'Bearer ' + gcs, 'Content-Type': 'multipart/related; boundary=' + b }, body);
      if ((await (await fetch(url)).text()) !== html) throw new Error('vérification après envoi échouée : ' + s.slug);
      h.version = { integerValue: String(version) }; h.size = { integerValue: String(html.length) }; h.updatedAt = { stringValue: new Date(version).toISOString() };
      changed = true;
    }
    if (APPLY && changed) {
      await R.request('PATCH', BASE + '/tunnels/' + tid + '?updateMask.fieldPaths=steps', { Authorization: 'Bearer ' + ds, 'Content-Type': 'application/json' }, { fields: { steps: doc.fields.steps } });
      info('tunnels/' + tid + ' : versions mises à jour (en ligne sous ~20 s)');
    }
  }

  /* 6. Formations internes */
  titre('6. Formations internes (Closing LAB, Coach LAB)');
  child('node', ['scripts/bp-formations-ressources.js'].concat(APPLY ? ['--apply'] : [])).split('\n').filter(function (l) { return l.trim(); }).slice(-15).forEach(info);

  /* 7. Academy : cours Business */
  titre('7. Academy : cours « Business Phénix » (sans vidéo)');
  const acadKey = path.join(HOME, '.secrets/adrienemily-academy-sa.json');
  child('node', [path.join(ACADEMY, 'scripts/creer-cours-business-6m.mjs')].concat(APPLY ? ['--apply'] : []), { GOOGLE_APPLICATION_CREDENTIALS: acadKey })
    .split('\n').filter(function (l) { return l.trim(); }).slice(-12).forEach(info);

  console.log(APPLY ? '\n✓ Mise en service écrite.' : '\nÀ blanc terminé — relancer avec --apply pour écrire.');
})().catch(function (e) { console.error('\n✗ ERREUR :', e && e.message); process.exit(1); });
