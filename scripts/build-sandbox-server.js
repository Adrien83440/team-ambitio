#!/usr/bin/env node
/* ═══════════════════════════════════════════════════════════════════════
   build-sandbox-server.js — fabrique sandbox-server.js (bac à sable closer)
   ─────────────────────────────────────────────────────────────────────────
   Empaquette le VRAI code serveur de la signature et des paiements
   (api/sign-session.js, signature-otp, signature-send-link,
   signature-completed, gocardless-*, payments-send-mandate-*) et ses
   helpers, pour qu'il tourne dans le navigateur du bac à sable, branché sur
   la fausse base (sandbox-db.js) et sur des services simulés
   (scripts/sandbox/shim-*.js). Aucune dépendance : un mini-bundler
   CommonJS suffit.

   À relancer après TOUTE modification d'un de ces fichiers api/* :
     node scripts/build-sandbox-server.js           # régénère
     node scripts/build-sandbox-server.js --check   # vérifie qu'il est à jour
   (comme scripts/build-theme-light.py pour theme-light-pages.css)
   ═══════════════════════════════════════════════════════════════════════ */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'sandbox-server.js');
const SHIM_DIR = path.join(__dirname, 'sandbox');

const ENTRIES = [
  'api/sign-session.js', 'api/signature-otp.js', 'api/signature-send-link.js', 'api/signature-completed.js',
  'api/gocardless-billing-request.js', 'api/gocardless-finalize.js', 'api/gocardless-payment.js',
  'api/payments-send-mandate-sms.js', 'api/payments-send-mandate-email.js',
];

/* Requêtes remplacées par un module simulé (clé = texte exact du require). */
const SHIMMED = {
  'crypto': '__crypto',
  'firebase-admin': "__shim['firebase-admin']",
  './_firebaseAdmin': "__shim['./_firebaseAdmin']",
  'twilio': "__shim['twilio']",
  './_billing-gmail': "__shim['./_billing-gmail']",
  './_gmailSend': "__shim['./_gmailSend']",
  './_ringoverClient': "__shim['./_ringoverClient']",
  './_tsa': "__shim['./_tsa']",
  'pdf-lib': "__shim['pdf-lib']",
  '@pdf-lib/fontkit': "__shim['@pdf-lib/fontkit']",
};

function rel(p) { return './' + path.relative(ROOT, p).split(path.sep).join('/'); }
function resolveFrom(fromFile, req) {
  let p = path.resolve(path.dirname(fromFile), req);
  if (!fs.existsSync(p) && fs.existsSync(p + '.js')) p += '.js';
  if (!fs.existsSync(p)) throw new Error('Module introuvable : ' + req + ' (depuis ' + rel(fromFile) + ')');
  return p;
}

const modules = new Map();
function collect(file) {
  const id = rel(file);
  if (modules.has(id)) return;
  const src = fs.readFileSync(file, 'utf8');
  const map = {};
  modules.set(id, { src: src, map: map });
  const re = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const req = m[1];
    if (SHIMMED[req]) continue;
    if (!req.startsWith('.')) throw new Error('Dépendance Node non gérée par le bac à sable : ' + req + ' (dans ' + id + ')');
    const target = resolveFrom(file, req);
    map[req] = rel(target);
    collect(target);
  }
}
ENTRIES.forEach(function (e) { collect(path.join(ROOT, e)); });

function shim(name) { return fs.readFileSync(path.join(SHIM_DIR, name), 'utf8'); }

let out = '';
out += '/* ═══════════════════════════════════════════════════════════════════════\n';
out += '   sandbox-server.js — GÉNÉRÉ par scripts/build-sandbox-server.js.\n';
out += '   NE PAS ÉDITER : relancer `node scripts/build-sandbox-server.js`.\n';
out += '   Le vrai code serveur (api/*) empaqueté pour le bac à sable closer,\n';
out += '   branché sur la fausse base et des services simulés. Rien ne sort.\n';
out += '   Modules : ' + Array.from(modules.keys()).join(', ') + '\n';
out += '   ═══════════════════════════════════════════════════════════════════════ */\n';
out += '(function () {\n';
out += shim('shim-node.js') + '\n';
out += shim('shim-services.js') + '\n';
out += 'var fetch = __sbxFetch;\n';
out += 'const __defs = {}, __cache = {};\n';
out += 'function __require(id) {\n';
out += '  if (__cache[id]) return __cache[id].exports;\n';
out += '  const def = __defs[id];\n';
out += '  if (!def) throw new Error("Bac à sable : module " + id + " non empaqueté");\n';
out += '  const module = { exports: {} };\n';
out += '  __cache[id] = module;\n';
out += '  def.fn(module, module.exports, function (r) { return __resolveReq(def, r); });\n';
out += '  return module.exports;\n';
out += '}\n';
out += 'function __resolveReq(def, r) {\n';
out += '  if (def.shims[r] !== undefined) return def.shims[r]();\n';
out += '  if (def.map[r]) return __require(def.map[r]);\n';
out += '  throw new Error("Bac à sable : require(" + r + ") non disponible");\n';
out += '}\n';
modules.forEach(function (m, id) {
  const shims = Object.keys(SHIMMED).filter(function (k) { return m.src.indexOf("'" + k + "'") >= 0 || m.src.indexOf('"' + k + '"') >= 0; })
    .map(function (k) { return JSON.stringify(k) + ': function () { return ' + SHIMMED[k] + '; }'; });
  out += '\n/* ── ' + id + ' ── */\n';
  out += '__defs[' + JSON.stringify(id) + '] = { map: ' + JSON.stringify(m.map) + ', shims: {' + shims.join(', ') + '}, fn: function (module, exports, require) {\n';
  out += m.src.replace(/^#!.*\n/, '') + '\n}};\n';
});
out += '\n' + shim('server-entry.js') + '\n';
out += '})();\n';

if (process.argv.indexOf('--check') >= 0) {
  const cur = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (cur !== out) { console.error('sandbox-server.js n\'est pas à jour — relancer node scripts/build-sandbox-server.js'); process.exit(1); }
  console.log('sandbox-server.js à jour (' + modules.size + ' modules)');
} else {
  fs.writeFileSync(OUT, out);
  console.log('sandbox-server.js : ' + modules.size + ' modules, ' + Math.round(out.length / 1024) + ' Ko');
}
