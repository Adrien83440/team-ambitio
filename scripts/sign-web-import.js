// ============================================================================
// scripts/sign-web-import.js — VERSION WEB DES CONTRATS (lecture → web)
// ----------------------------------------------------------------------------
// Le nouveau parcours de signature (sign.html) affiche le contrat en texte,
// article par article, au lieu d'un PDF à remplir. Ce texte est transcrit à
// l'identique depuis les PDF en base, dans scripts/data/contrats-web/<id>.json.
//
// Ce script pose ce texte dans signature_templates/{id}.web. Si le fichier
// porte aussi `fieldPatches` (propriétés à changer sur des champs existants)
// ou `fieldAdds` (nouveaux champs, ajoutés une seule fois), il met à jour
// `fields`. Écriture par updateMask sur `web` (et `fields` si besoin) : le
// PDF, les réglages Make / Academy ne sont jamais touchés.
//
// L'empreinte SHA-256 du PDF du modèle est enregistrée avec le texte
// (web.sourcePdfSha256). Si le PDF du modèle est remplacé plus tard, la page
// de signature le détecte et repasse en lecture du PDF original : le texte
// web ne peut jamais diverger en silence du document réellement signé.
//
// Règle n°3 du repo : MODE LECTURE SEULE PAR DÉFAUT. Il affiche ce qui serait
// écrit. L'écriture n'a lieu qu'avec --apply, après validation d'Adrien.
//
// Usage :
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/sign-web-import.js            # à blanc
//   GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json \
//     node scripts/sign-web-import.js --apply    # écriture
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const R = require('./_firestore-rest');

const APPLY = process.argv.indexOf('--apply') >= 0;
const DIR = path.join(__dirname, 'data', 'contrats-web');
const BASE = 'https://firestore.googleapis.com/v1/projects/ambitio-team/databases/(default)/documents';

async function templatePdf(id, T) {
  let b64 = T.pdfBase64 || '';
  if (!b64) {
    const t = await R.token();
    const parts = [];
    let pageToken = '';
    do {
      const url = BASE + '/signature_templates/' + id + '/pdf?pageSize=300' + (pageToken ? '&pageToken=' + pageToken : '');
      const r = await R.request('GET', url, { Authorization: 'Bearer ' + t });
      (r.documents || []).forEach(function (x) {
        const f = x.fields || {};
        parts.push({ c: Number(f.chunk.integerValue || f.chunk.doubleValue), d: f.data.stringValue || '' });
      });
      pageToken = r.nextPageToken || '';
    } while (pageToken);
    parts.sort(function (a, b) { return a.c - b.c; });
    b64 = parts.map(function (p) { return p.d; }).join('');
  }
  const raw = b64.indexOf(',') >= 0 ? b64.split(',')[1] : b64;
  return raw ? Buffer.from(raw, 'base64') : null;
}

/* Toute référence à un champ (field:<id>, {{field:<id>}}, fieldHints) doit
   viser un champ qui existe vraiment sur le modèle — sinon la page de
   signature afficherait une zone orpheline. */
function checkRefs(data, fieldIds) {
  const errs = [];
  Object.keys(data.fieldHints || {}).forEach(function (k) {
    if (fieldIds.indexOf(k) < 0) errs.push('fieldHints → champ inconnu ' + k);
  });
  (data.sections || []).forEach(function (s) {
    if (!s.id || !s.title || !Array.isArray(s.blocks) || !s.blocks.length) errs.push('section incomplète ' + (s.id || '?'));
    (s.blocks || []).forEach(function (b) {
      const re = /field:([A-Za-z0-9_]+)/g;
      let m;
      while ((m = re.exec(b))) if (fieldIds.indexOf(m[1]) < 0) errs.push(s.id + ' → champ inconnu ' + m[1]);
      if (!/^(p|h|li|ol|i|q|field):/.test(b)) errs.push(s.id + ' → bloc sans préfixe : ' + b.slice(0, 40));
    });
  });
  return errs;
}

(async function () {
  const files = fs.readdirSync(DIR).filter(function (f) { return /\.json$/.test(f); });
  console.log(APPLY ? '=== MODE ÉCRITURE ===' : '=== MODE À BLANC (aucune écriture) ===');
  let ko = 0;
  for (const f of files) {
    const data = JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
    const id = data.templateId;
    const doc = await R.getDoc('signature_templates/' + id);
    if (!doc) { console.log('✗', id, 'modèle introuvable'); ko++; continue; }
    const T = doc.data;
    /* Champs : patches puis ajouts (idempotent — un ajout déjà présent est ignoré). */
    const fields = JSON.parse(JSON.stringify(T.fields || []));
    const fieldLog = [];
    Object.keys(data.fieldPatches || {}).forEach(function (fid) {
      const f = fields.find(function (x) { return x.id === fid; });
      if (!f) { fieldLog.push('✗ patch : champ inconnu ' + fid); return; }
      Object.keys(data.fieldPatches[fid]).forEach(function (k) {
        const v = data.fieldPatches[fid][k];
        if (JSON.stringify(f[k]) !== JSON.stringify(v)) { fieldLog.push('~ ' + fid + ' (' + f.fieldType + ') ' + k + ' : ' + JSON.stringify(f[k]) + ' → ' + JSON.stringify(v)); f[k] = v; }
      });
    });
    (data.fieldAdds || []).forEach(function (a) {
      if (fields.some(function (x) { return x.id === a.id; })) return;
      fields.push(a);
      fieldLog.push('+ ' + a.id + ' (' + a.fieldType + ') page ' + a.page + ' x=' + a.x + ' y=' + a.y + ' « ' + a.label + ' »');
    });
    const fieldsChanged = fieldLog.some(function (l) { return l.charAt(0) !== '✗'; });
    const fieldIds = fields.map(function (x) { return x.id; }).filter(Boolean);
    const errs = checkRefs(data, fieldIds);
    const pdf = await templatePdf(id, T);
    if (!pdf) errs.push('PDF du modèle introuvable');
    fieldLog.filter(function (l) { return l.charAt(0) === '✗'; }).forEach(function (l) { errs.push(l); });
    if (errs.length) { console.log('✗', id, T.name); errs.forEach(function (e) { console.log('   -', e); }); ko++; continue; }

    const sha = crypto.createHash('sha256').update(pdf).digest('hex');
    const prev = T.web && T.web.version ? Number(T.web.version) : 0;
    const web = {
      version: prev + 1,
      source: 'transcription-pdf',
      importedAt: new Date().toISOString(),
      sourcePdfSha256: sha,
      title: data.title || '',
      subtitle: data.subtitle || '',
      tagline: data.tagline || '',
      fieldHints: data.fieldHints || {},
      sections: data.sections,
    };
    const nBlocks = data.sections.reduce(function (a, s) { return a + s.blocks.length; }, 0);
    console.log('✓', id, '«' + T.name + '»', '| sections', data.sections.length, '| blocs', nBlocks,
      '| PDF sha256', sha.slice(0, 16) + '…', '| web v' + prev, '→ v' + web.version,
      '| taille', Math.round(JSON.stringify(web).length / 1024) + ' Ko');
    fieldLog.forEach(function (l) { console.log('   champ', l); });
    if (APPLY) {
      if (fieldsChanged) await R.patchDoc('signature_templates/' + id, { web: web, fields: fields }, ['web', 'fields']);
      else await R.patchDoc('signature_templates/' + id, { web: web }, ['web']);
      console.log('   → écrit' + (fieldsChanged ? ' (texte web + champs)' : ' (texte web)'));
    }
  }
  if (ko) { console.log('\n' + ko + ' modèle(s) en erreur — rien n\'a été écrit pour eux.'); process.exit(1); }
  if (!APPLY) console.log('\nRelancer avec --apply pour écrire.');
})().catch(function (e) { console.error(e); process.exit(1); });
