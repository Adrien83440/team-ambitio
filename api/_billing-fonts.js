/**
 * api/_billing-fonts.js
 *
 * Loader des fonts Montserrat pour la génération PDF.
 *
 * Stratégie : fetch les 3 fonts (Light 300, Regular 400, Medium 500) depuis
 * une URL stable de raw.githubusercontent.com (Google Fonts repo officiel)
 * au PREMIER appel uniquement, puis cache module-level pour tous les appels
 * suivants tant que le container Vercel reste chaud (~5 min d'inactivité).
 *
 * Coût pratique :
 *   - 1er appel après cold start : ~150 ms (3 fetches en parallèle)
 *   - Appels suivants : ~0 ms (lecture mémoire)
 *
 * Pour basculer vers du base64 100 % embarqué (zéro dépendance externe),
 * voir le script optionnel scripts/build-fonts.js qui génère un module
 * api/_billing-fonts-data.js détecté automatiquement par ce loader.
 */

let _cache = null;
let _loadPromise = null;

const FONT_URLS = {
  light:   'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Light.ttf',
  regular: 'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Regular.ttf',
  medium:  'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Medium.ttf',
  semibold:'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-SemiBold.ttf',
  bold:    'https://raw.githubusercontent.com/google/fonts/main/ofl/montserrat/static/Montserrat-Bold.ttf',
};

async function fetchFont(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Font fetch failed (' + res.status + '): ' + url);
  const arr = await res.arrayBuffer();
  return Buffer.from(arr);
}

async function loadMontserratFonts() {
  if (_cache) return _cache;

  /* Tentative d'utiliser un module pré-encodé en base64 si présent */
  try {
    const precompiled = require('./_billing-fonts-data');
    if (precompiled && precompiled.light && precompiled.regular && precompiled.medium) {
      _cache = {
        light:    Buffer.from(precompiled.light,    'base64'),
        regular:  Buffer.from(precompiled.regular,  'base64'),
        medium:   Buffer.from(precompiled.medium,   'base64'),
        semibold: precompiled.semibold ? Buffer.from(precompiled.semibold, 'base64') : null,
        bold:     precompiled.bold     ? Buffer.from(precompiled.bold,     'base64') : null,
      };
      return _cache;
    }
  } catch (e) {
    /* Pas de fichier pré-encodé : on continue avec le fetch */
  }

  /* Garde-fou : éviter plusieurs fetches en parallèle si plusieurs requêtes
     arrivent avant la fin du premier chargement */
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async function() {
    const [light, regular, medium, semibold, bold] = await Promise.all([
      fetchFont(FONT_URLS.light),
      fetchFont(FONT_URLS.regular),
      fetchFont(FONT_URLS.medium),
      fetchFont(FONT_URLS.semibold).catch(function(){ return null; }),
      fetchFont(FONT_URLS.bold).catch(function(){ return null; }),
    ]);
    _cache = { light: light, regular: regular, medium: medium, semibold: semibold, bold: bold };
    _loadPromise = null;
    return _cache;
  })();

  return _loadPromise;
}

module.exports = { loadMontserratFonts: loadMontserratFonts };
