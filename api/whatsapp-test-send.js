// ============================================================================
// api/whatsapp-test-send.js — ENVOI DE VÉRIFICATION
// ----------------------------------------------------------------------------
// POST /api/whatsapp-test-send
//   { to, template?, langue?, params? }
//   → 200 { ok, wamid, erreur }
// Réservé aux administrateurs.
//
// POURQUOI
// --------
// Jusqu'ici, la seule façon de déclencher un envoi réel était de modifier le
// plan d'action d'un vrai client — inacceptable pour un test. Cet endpoint
// permet de valider la chaîne complète (identifiants → numéro enregistré →
// modèle → journal) sur SON PROPRE numéro, sans toucher à aucune donnée
// métier.
//
// Il reste utile après : à chaque modèle approuvé, un envoi de contrôle avant
// de l'ouvrir à de vrais destinataires.
//
// GARDE-FOU : le destinataire est OBLIGATOIRE et vient du corps de la requête.
// Aucune valeur par défaut, aucune lecture de fiche client — il est impossible
// d'écrire à un client par erreur depuis ici.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { envoyerModele } = require('./_whatsappClient');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  const body = parseBody(req) || {};
  const to = String(body.to || '').trim();
  if (!to) {
    res.status(400).json({ ok: false, erreur: 'to_requis', detail: 'Le destinataire doit être fourni explicitement.' });
    return;
  }

  /* `hello_world` par défaut : approuvé d'office sur tout compte, sans
     paramètre, et en anglais — donc utilisable pour tester la plomberie avant
     que le moindre modèle français ne soit validé. */
  const template = String(body.template || 'hello_world').trim();
  const langue = String(body.langue || (template === 'hello_world' ? 'en_US' : 'fr')).trim();
  const params = Array.isArray(body.params) ? body.params : [];

  try {
    const envoi = await envoyerModele({
      to: to,
      template: template,
      langue: langue,
      params: params,
      contexte: { type: 'test', par: (auth && auth.email) || 'admin' },
    });
    res.status(200).json({
      ok: envoi.ok,
      wamid: envoi.wamid,
      erreur: envoi.erreur,
      envoyeA: to,
      modele: template,
      langue: langue,
    });
  } catch (e) {
    console.error('[whatsapp-test-send]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
