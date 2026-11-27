// ============================================================================
// api/offre-lien.js — LIEN COURT DE PRISE DE RDV (Relances d'offres, 27/11/2026)
// ----------------------------------------------------------------------------
// GET  /o/{code}                → page relais qui compte le clic puis ouvre la
//                                 prise de rendez-vous du prospect
// POST /api/offre-lien { c }    → compte le clic (envoyé par la page relais)
// (réécriture /o/… déclarée dans vercel.json)
//
// Le code (6 caractères) est créé par api/_offerRelances.js, qui écrit aussi la
// destination dans `offer_liens/{code}` (Admin SDK seul, aucune règle
// Firestore). La destination n'est JAMAIS fournie par l'appelant, et seule une
// adresse https://team.alteore.com/… est ouverte : aucune redirection ouverte
// sous notre nom de domaine.
//
// Page relais plutôt qu'une redirection directe : les messageries ouvrent les
// liens toutes seules pour l'aperçu. Le clic n'est compté que si un vrai
// navigateur exécute le script ; sans script, la balise meta ouvre la page
// sans rien compter. Aucune adresse IP n'est conservée.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const CODE = /^[a-z0-9]{6}$/;
const CIBLE = /^https:\/\/team\.alteore\.com\/[A-Za-z0-9._~:/?#\[\]@!$&'()*+,;=%-]*$/;
const ROBOTS = /bot|crawl|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|headless|python|curl|wget|okhttp|facebookexternalhit|whatsapp|slack|teams|google-?(read-aloud|safety)/i;

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

async function cibleDe(code) {
  let err = null;
  // Deux essais : une lecture ratée au démarrage ne doit pas coûter un RDV.
  for (let i = 0; i < 2; i++) {
    try {
      const s = await db.collection('offer_liens').doc(code).get();
      if (!s.exists) return null;
      const u = String((s.data() || {}).url || '').trim();
      return CIBLE.test(u) ? u : null;
    } catch (e) { err = e; }
  }
  throw err;
}

function page(titre, corps, script) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>' + esc(titre) + '</title>'
    + '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f3f4f8;color:#1f2937;font-family:Helvetica,Arial,sans-serif;padding:16px;box-sizing:border-box}'
    + '.c{max-width:420px;text-align:center}.c p{color:#4b5563;font-size:16px;line-height:1.6}'
    + '.c a{display:inline-block;margin-top:14px;padding:14px 24px;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;text-decoration:none}</style>'
    + corps + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
}

async function clic(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let code = '';
  try { code = String(((await parseBody(req)) || {}).c || '').trim(); } catch (e) { /* corps illisible */ }
  const ua = String(req.headers['user-agent'] || '');
  if (!CODE.test(code) || !ua || ROBOTS.test(ua)) { res.status(204).end(); return; }
  try {
    const ref = db.collection('offer_liens').doc(code);
    const s = await ref.get();
    // Le lien doit exister : sinon n'importe qui pourrait créer des documents.
    if (s.exists) {
      const now = Date.now();
      const patch = { clics: admin.firestore.FieldValue.increment(1), dernierClicA: now };
      if (!(s.data() || {}).premierClicA) patch.premierClicA = now;
      await ref.set(patch, { merge: true });
    }
  } catch (e) { console.error('[offre-lien] clic', code, e && e.message); }
  // Écriture AVANT la réponse : Vercel arrête la fonction dès la fin de la réponse.
  res.status(204).end();
}

module.exports = async function (req, res) {
  if (req.method === 'POST') return clic(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const code = String((req.query && req.query.c) || '').trim();
  let url = null;
  if (CODE.test(code)) {
    try { url = await cibleDe(code); } catch (e) { console.error('[offre-lien] lecture', code, e && e.message); }
  }
  if (!url) {
    res.status(404).send(page('Lien indisponible', '</head><body><div class="c"><p>Ce lien n\'est plus disponible.<br>Répondez simplement à notre e-mail : nous vous proposerons un créneau.</p></div>'));
    return;
  }
  const u = esc(url);
  res.status(200).send(page('Prise de rendez-vous',
    '<noscript><meta http-equiv="refresh" content="0;url=' + u + '"></noscript></head><body><div class="c"><p>Ouverture de la prise de rendez-vous…</p><a href="' + u + '">Choisir mon créneau</a></div>',
    '(function(){var u=' + JSON.stringify(url) + ';try{var b=JSON.stringify({c:' + JSON.stringify(code) + '});'
    + 'if(navigator.sendBeacon){navigator.sendBeacon("/api/offre-lien",new Blob([b],{type:"text/plain"}));}'
    + 'else{var x=new XMLHttpRequest();x.open("POST","/api/offre-lien",false);x.setRequestHeader("Content-Type","text/plain");x.send(b);}}catch(e){}'
    + 'setTimeout(function(){location.replace(u);},150);})();'));
};
