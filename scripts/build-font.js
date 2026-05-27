/**
 * scripts/build-fonts.js
 *
 * Télécharge les 3 fonts Montserrat (Light/Regular/Medium) depuis
 * Google Fonts repo et les encode en base64 dans api/_billing-fonts-data.js.
 *
 * À lancer UNE FOIS depuis la racine du repo :
 *   node scripts/build-fonts.js
 *
 * Le fichier généré est automatiquement détecté et utilisé par
 * api/_billing-fonts.js, éliminant la dépendance réseau au runtime
 * (qui causait HTTP 502 sur Vercel quand raw.githubusercontent.com
 * était lent au cold start).
 *
 * Coût : ~600 KB ajoutés au bundle Vercel (acceptable).
 */

const fs = require('fs');
const path = require('path');

const FONTS = {
  light:    'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Light.ttf',
  regular:  'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Regular.ttf',
  medium:   'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Medium.ttf',
  semibold: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-SemiBold.ttf',
  bold:     'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Bold.ttf',
};

const OUT_PATH = path.join(__dirname, '..', 'api', '_billing-fonts-data.js');

async function fetchFont(url) {
  console.log('  → fetching ' + url);
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed (' + res.status + '): ' + url);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr).toString('base64');
}

(async function main() {
  console.log('\n📦 build-fonts.js — génération api/_billing-fonts-data.js\n');
  const out = {};
  for (const key of Object.keys(FONTS)) {
    try {
      out[key] = await fetchFont(FONTS[key]);
      console.log('  ✅ ' + key + ' : ' + (out[key].length / 1024).toFixed(0) + ' KB base64');
    } catch (e) {
      console.warn('  ⚠️  ' + key + ' : ' + e.message + ' (optional, skipping)');
      out[key] = null;
    }
  }

  const banner = [
    '/**',
    ' * api/_billing-fonts-data.js',
    ' *',
    ' * AUTO-GENERATED par scripts/build-fonts.js — NE PAS ÉDITER À LA MAIN.',
    ' *',
    ' * Fonts Montserrat encodées en base64 pour élimination de la dépendance',
    ' * réseau raw.githubusercontent.com au runtime Vercel.',
    ' *',
    ' * Pour régénérer : node scripts/build-fonts.js',
    ' */',
    '',
    'module.exports = {',
  ].join('\n');

  let body = '';
  for (const key of Object.keys(out)) {
    if (out[key]) {
      body += '  ' + key + ': ' + JSON.stringify(out[key]) + ',\n';
    } else {
      body += '  ' + key + ': null,\n';
    }
  }
  body += '};\n';

  fs.writeFileSync(OUT_PATH, banner + '\n' + body, 'utf8');
  const stats = fs.statSync(OUT_PATH);
  console.log('\n✅ ' + OUT_PATH + ' généré (' + (stats.size / 1024).toFixed(0) + ' KB)\n');
  console.log('   → git add api/_billing-fonts-data.js && git commit && git push\n');
})().catch(function(err) {
  console.error('\n❌ Erreur : ' + err.message + '\n');
  process.exit(1);
});
