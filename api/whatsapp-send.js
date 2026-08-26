// ============================================================================
// api/whatsapp-send.js — RÉPONDRE DEPUIS LA BOÎTE PARTAGÉE
// ----------------------------------------------------------------------------
// POST /api/whatsapp-send
//   { numero, texte }                      → message libre
//   { numero, template, langue?, params? } → modèle approuvé
//   → 200 { ok, wamid, erreur }
//   → 409 { erreur: 'fenetre_fermee' }     → seul un modèle peut encore partir
//
// Réservé aux rôles `sales` et `admin`, comme la boîte elle-même.
//
// LA FENÊTRE EST VÉRIFIÉE ICI, PAS SEULEMENT À L'ÉCRAN
// ----------------------------------------------------
// L'interface masque déjà le champ libre quand la fenêtre est fermée. Ça ne
// suffit pas : un onglet resté ouvert affiche un état vieux de trois heures, et
// rien n'empêche d'appeler cet endpoint directement. On relit donc
// `fenetreExpireA` en base avant tout envoi libre.
//
// Le refus est volontairement FERMANT : si la conversation n'existe pas, ou si
// la fenêtre a expiré, on refuse. Un envoi hors fenêtre serait de toute façon
// rejeté par Meta (erreur 131047) — autant refuser avec un message clair plutôt
// que de laisser l'équipe croire que le message est parti.
//
// LA PIÈCE JOINTE EST ARCHIVÉE AVANT DE PARTIR
// -------------------------------------------
// Meta ne rend pas relisible un média SORTANT : l'identifiant rendu par le
// téléversement ne sert qu'une fois, à l'envoi. Sans copie de notre côté, la
// bulle afficherait « 📎 devis.pdf » sans jamais pouvoir rouvrir le fichier —
// impossible de vérifier après coup LEQUEL est parti.
//
// On archive donc dans Firebase Storage avant l'envoi, exactement comme le
// webhook le fait pour les médias entrants. L'archivage ne bloque jamais un
// envoi : s'il échoue, le message part quand même, sans sa copie.
//
// LE DESTINATAIRE VIENT DU CORPS, ET C'EST ASSUMÉ
// Contrairement aux notifications automatiques, ici c'est un humain qui choisit
// à qui il écrit : c'est le principe même d'une messagerie. La restriction de
// rôle est la seule barrière, et elle suffit.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { envoyerTexte, envoyerModele, envoyerMedia, televerserMedia,
        normaliserNumero, archiverMedia, extensionDe, MEDIAS } = require('./_whatsappClient');
const crypto = require('crypto');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let auth = null;
  try {
    auth = await verifyFirebaseAuth(req);
  } catch (e) {
    res.status(401).json({ ok: false, erreur: 'unauthorized' });
    return;
  }
  const role = (auth && auth.role) || '';
  if (role !== 'sales' && role !== 'admin') {
    res.status(403).json({ ok: false, erreur: 'role_non_autorise' });
    return;
  }

  const body = parseBody(req) || {};
  const numero = normaliserNumero(body.numero);
  const texte = String(body.texte == null ? '' : body.texte).trim();
  const template = String(body.template || '').trim();
  const params = Array.isArray(body.params) ? body.params : [];
  const media64 = String(body.mediaBase64 || '');
  const mime = String(body.mime || '');

  if (!numero) { res.status(400).json({ ok: false, erreur: 'numero_invalide' }); return; }
  if (!texte && !template && !media64) {
    res.status(400).json({ ok: false, erreur: 'texte_media_ou_template_requis' });
    return;
  }

  const par = (auth && auth.email) || 'equipe';
  const contexte = { type: 'reponse', par: par, uid: (auth && auth.uid) || null };

  try {
    /* ── Modèle : autorisé à tout moment, c'est justement son rôle ── */
    if (template) {
      const envoi = await envoyerModele({
        to: numero, template: template,
        langue: body.langue || 'fr', params: params, contexte: contexte,
      });
      res.status(200).json({ ok: envoi.ok, wamid: envoi.wamid, erreur: envoi.erreur });
      return;
    }

    /* ── Texte libre : la fenêtre décide ── */
    const snap = await db.collection('whatsapp_conversations').doc(numero).get();
    const c = snap.exists ? (snap.data() || {}) : {};
    const fin = Number(c.fenetreExpireA || 0);
    if (!fin || fin <= Date.now()) {
      res.status(409).json({
        ok: false,
        erreur: 'fenetre_fermee',
        detail: 'Le contact n\'a pas écrit depuis plus de 24 h. Seul un modèle approuvé peut encore partir.',
        fenetreExpireA: fin || null,
      });
      return;
    }

    /* ── Média : même fenêtre, deux temps (téléversement puis envoi) ── */
    if (media64) {
      if (!MEDIAS[mime]) {
        res.status(400).json({ ok: false, erreur: 'type_non_supporte',
          detail: 'Images JPEG/PNG/WebP et PDF uniquement.' });
        return;
      }
      let buf;
      try { buf = Buffer.from(media64, 'base64'); }
      catch (e) { res.status(400).json({ ok: false, erreur: 'fichier_illisible' }); return; }
      /* Vercel plafonne le corps d'une requête : au-delà, la fonction n'est
         même pas appelée. On refuse avant, avec un message compréhensible,
         plutôt que de laisser un échec réseau sans explication. */
      if (buf.length > 3500000) {
        res.status(400).json({ ok: false, erreur: 'fichier_trop_lourd',
          detail: 'Maximum 3,5 Mo. Au-delà, la requête n\'atteint même pas le serveur.' });
        return;
      }

      const up = await televerserMedia(buf, mime, body.nom || 'fichier');
      if (!up.ok) {
        res.status(200).json({ ok: false, erreur: up.erreur || 'televersement_echoue' });
        return;
      }

      /* La copie pour le fil. Nom aléatoire plutôt que le nom d'origine : deux
         « photo.jpg » envoyés à la même personne s'écraseraient l'un l'autre,
         et la première bulle pointerait alors sur le fichier de la seconde.
         Le wamid ferait un meilleur nom, mais il n'existe qu'après l'envoi —
         et l'envoi écrit déjà la bulle. */
      let mediaUrl = null;
      try {
        mediaUrl = await archiverMedia(
          buf,
          'whatsapp_media/' + numero + '/out-' + crypto.randomUUID() + '.' + extensionDe(mime),
          mime
        );
      } catch (e) {
        console.warn('[whatsapp-send] archivage sortant:', e && e.message);
      }

      const envoiM = await envoyerMedia({
        to: numero, mediaId: up.id, mime: mime,
        nom: body.nom || 'fichier', legende: texte, contexte: contexte,
        mediaUrl: mediaUrl,
      });
      res.status(200).json({ ok: envoiM.ok, wamid: envoiM.wamid, erreur: envoiM.erreur });
      return;
    }

    const envoi = await envoyerTexte({ to: numero, texte: texte, contexte: contexte });
    res.status(200).json({ ok: envoi.ok, wamid: envoi.wamid, erreur: envoi.erreur });
  } catch (e) {
    console.error('[whatsapp-send]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, erreur: 'server_error' });
  }
};
