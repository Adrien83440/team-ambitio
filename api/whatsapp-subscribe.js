// ============================================================================
// api/whatsapp-subscribe.js — ABONNER L'APP AU COMPTE WHATSAPP
// ----------------------------------------------------------------------------
// POST /api/whatsapp-subscribe   → 200 { ok, wabaId }
// Réservé aux administrateurs.
//
// POURQUOI
// --------
// Enregistrer une URL de rappel ne suffit pas. Il faut EN PLUS abonner
// l'application au compte WhatsApp Business, sinon Meta n'appelle jamais le
// webhook : l'URL est déclarée, elle répond correctement à la vérification, et
// pourtant aucun message n'arrive. Aucune erreur, aucun journal, rien — la
// panne la plus silencieuse de toute la chaîne.
//
// Le parcours guidé de Meta pose cet abonnement pour le numéro de TEST et
// considère l'étape faite ; le compte de production, lui, reste non abonné.
// Même angle mort que l'enregistrement du numéro.
//
// Idempotent : réabonner une app déjà abonnée renvoie un succès.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getWhatsappCreds, graph } = require('./_whatsappClient');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  try {
    const creds = await getWhatsappCreds();
    if (!creds.wabaId) {
      res.status(400).json({ ok: false, erreur: 'wabaId absent de la configuration' });
      return;
    }

    const rep = await graph(creds.wabaId + '/subscribed_apps', { method: 'POST' });
    console.log('[whatsapp-subscribe]', creds.wabaId, rep.ok ? 'abonnée' : ('échec : ' + rep.erreur));

    if (!rep.ok) {
      res.status(200).json({
        ok: false, wabaId: creds.wabaId,
        erreur: rep.erreur || 'echec',
        code: rep.code != null ? rep.code : null,
      });
      return;
    }
    res.status(200).json({ ok: true, wabaId: creds.wabaId });
  } catch (e) {
    console.error('[whatsapp-subscribe]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
