// ═══════════════════════════════════════════════════════════════════════════
// build-sandbox-leads-live.js — génère sandbox-leads-live.html (LABO)
// ─────────────────────────────────────────────────────────────────────────
// Le labo Leads Live est une COPIE de sales-leads.html dont le SDK Firebase
// est remplacé par sandbox-leads-live-db.js (faux Firebase, faux leads) et
// sandbox-leads-live-api.js (faux serveur + pare-feu). La nouvelle
// présentation (leads-live-v3.js) y est toujours active. Rien de réel ne
// peut partir : pas de SMS, WhatsApp, e-mail, appel ni écriture Firestore.
//
//   node scripts/build-sandbox-leads-live.js           # régénère la page
//   node scripts/build-sandbox-leads-live.js --check   # vérifie qu'elle est à jour
//
// À relancer après toute modification de sales-leads.html.
// ═══════════════════════════════════════════════════════════════════════════
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'sales-leads.html');
const DST = path.join(ROOT, 'sandbox-leads-live.html');

function construire() {
  let html = fs.readFileSync(SRC, 'utf8');
  function remplacer(a, b) {
    const n = html.split(a).length - 1;
    if (n !== 1) throw new Error('Motif attendu 1 fois, trouvé ' + n + ' : ' + a.slice(0, 70));
    html = html.split(a).join(b);
  }
  // 1. SDK Firebase réel → faux Firebase + faux serveur (dans cet ordre, avant tout le reste)
  let premier = true, trouves = 0;
  html = html.replace(/<script src="https:\/\/www\.gstatic\.com\/firebasejs\/[^"]+"><\/script>\n?/g, () => {
    trouves++;
    if (!premier) return '';
    premier = false;
    return '<script src="sandbox-leads-live-db.js"></script>\n<script src="sandbox-leads-live-api.js"></script>\n';
  });
  if (!trouves) throw new Error('Scripts Firebase introuvables dans sales-leads.html');
  if (/gstatic\.com\/firebasejs/.test(html)) throw new Error('Un script Firebase réel subsiste');
  // 2. Mode application : pas de barre latérale (ses liens mènent au vrai logiciel)
  remplacer("var isAppMode = new URLSearchParams(window.location.search).has('app');", 'var isAppMode = true;');
  // 3. Identité de la page
  html = html.replace(/<title>[^<]*<\/title>/, '<title>Alteore — Labo Leads Live</title>\n<meta name="robots" content="noindex,nofollow"/>');
  html = html.replace(/<link rel="manifest"[^>]*>\n?/, '').replace(/<link rel="apple-touch-icon"[^>]*>\n?/, '');
  html = html.replace(/<!DOCTYPE html>\s*/i, '<!DOCTYPE html>\n<!-- GÉNÉRÉ par scripts/build-sandbox-leads-live.js depuis sales-leads.html : ne pas éditer à la main. -->\n');
  return html;
}

const html = construire();
if (process.argv.includes('--check')) {
  const actuel = fs.existsSync(DST) ? fs.readFileSync(DST, 'utf8') : '';
  if (actuel !== html) { console.error('sandbox-leads-live.html n\'est pas à jour — relancer scripts/build-sandbox-leads-live.js'); process.exit(1); }
  console.log('sandbox-leads-live.html à jour');
} else {
  fs.writeFileSync(DST, html);
  console.log('sandbox-leads-live.html généré (' + Math.round(html.length / 1024) + ' Ko)');
}
