// ============================================================================
// api/group-redirect.js — REDIRECTION VERS UNE INVITATION DE GROUPE
// ----------------------------------------------------------------------------
// GET /g/{identifiant}   → 302 vers https://chat.whatsapp.com/{identifiant}
// (réécriture déclarée dans vercel.json)
//
// POURQUOI PASSER PAR NOTRE DOMAINE
// ---------------------------------
// Meta REFUSE les liens `chat.whatsapp.com` dans les boutons de modèle :
// « Les liens directs vers WhatsApp ne sont pas autorisés pour les boutons ».
// Le modèle `invitation_groupe` était donc impossible tel quel.
//
// Un bouton pointant vers notre domaine passe, et apporte mieux : on sait QUI
// a cliqué. C'est exactement ce que réclame l'écran de suivi des arrivées de
// la vague 3 — « qui a rejoint, qui manque, relance en un clic ». Avec un lien
// direct vers WhatsApp, cette information n'aurait jamais existé.
//
// REDIRECTION FERMÉE, PAS OUVERTE
// -------------------------------
// La destination n'est jamais fournie par l'appelant : seul un identifiant
// d'invitation l'est, et il est validé caractère par caractère avant d'être
// concaténé à une base FIXE. Il est donc impossible de faire pointer ce lien
// ailleurs que vers WhatsApp — une redirection ouverte serait une porte
// d'hameçonnage utilisant notre nom de domaine.
//
// Aucune adresse IP n'est journalisée : le clic suffit à savoir qu'on a
// rejoint, l'IP serait une donnée personnelle de plus sans usage.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const BASE = 'https://chat.whatsapp.com/';
/* Les codes d'invitation WhatsApp sont alphanumériques. On refuse tout le
   reste — point, barre oblique, deux-points — ce qui rend toute évasion vers
   un autre hôte impossible. */
const CODE_VALIDE = /^[A-Za-z0-9_-]{5,64}$/;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }

  const code = String((req.query && req.query.id) || '').trim();
  if (!CODE_VALIDE.test(code)) {
    res.status(400).send('Lien d\'invitation invalide.');
    return;
  }

  /* Le clic est tracé AVANT la redirection : Vercel arrête la fonction dès la
     réponse envoyée, une écriture lancée après serait perdue. */
  try {
    await db.collection('whatsapp_group_clicks').add({
      code: code,
      at: Date.now(),
      date: new Date().toISOString(),
      ua: String(req.headers['user-agent'] || '').slice(0, 300),
    });
  } catch (e) {
    /* Un journal indisponible ne doit jamais empêcher quelqu'un de rejoindre
       son groupe. On perd la trace, pas le client. */
    console.warn('[group-redirect] journal:', e && e.message);
  }

  res.writeHead(302, { Location: BASE + code });
  res.end();
};
