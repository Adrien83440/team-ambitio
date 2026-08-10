// ============================================================================
// api/whatsapp-register-number.js — ENREGISTRER LE NUMÉRO SUR L'API CLOUD
// ----------------------------------------------------------------------------
// POST /api/whatsapp-register-number   { pin: "123456" }
//   → 200 { ok:true }  ·  200 { ok:false, erreur, code }
// Réservé aux administrateurs.
//
// POURQUOI
// --------
// Un numéro ajouté au compte WhatsApp Business n'est pas encore utilisable :
// il doit être ENREGISTRÉ sur l'API Cloud. Tant qu'il ne l'est pas, son
// `platform_type` vaut NOT_APPLICABLE et tout envoi échoue.
//
// Le parcours guidé de la console Meta considère l'étape « faite » dès qu'un
// numéro de TEST a été enregistré, et ne la rouvre pas pour le numéro de
// production. On appelle donc directement l'API — c'est exactement ce que fait
// la console, sans le labyrinthe.
//
// LE PIN
// ------
// C'est le code de vérification en deux étapes du numéro, exigé à chaque
// réenregistrement. Il est transmis à Meta et **jamais journalisé ni stocké**
// ici : ni dans Firestore, ni dans les traces. À Adrien de le conserver — il
// lui sera redemandé s'il doit un jour refaire cette opération.
//
// Idempotent côté Meta : réenregistrer un numéro déjà enregistré avec le même
// PIN renvoie un succès.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getWhatsappCreds, graph } = require('./_whatsappClient');
const parseBody = require('./_parseBody');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  const body = parseBody(req) || {};
  const pin = String(body.pin || '').trim();
  /* Meta exige exactement 6 chiffres. Autant refuser ici, avec un message
     clair, plutôt que de renvoyer une erreur Graph obscure. */
  if (!/^[0-9]{6}$/.test(pin)) {
    res.status(400).json({ ok: false, erreur: 'pin_invalide', detail: 'Six chiffres exactement.' });
    return;
  }

  try {
    const creds = await getWhatsappCreds();
    const rep = await graph(creds.phoneNumberId + '/register', {
      method: 'POST',
      body: { messaging_product: 'whatsapp', pin: pin },
    });

    /* On ne journalise que l'issue et le numéro visé — jamais le PIN. */
    console.log('[whatsapp-register]', creds.phoneNumberId, rep.ok ? 'enregistré' : ('échec : ' + rep.erreur));

    if (!rep.ok) {
      res.status(200).json({
        ok: false,
        phoneNumberId: creds.phoneNumberId,
        erreur: rep.erreur || 'echec',
        code: rep.code != null ? rep.code : null,
        sousCode: rep.sousCode != null ? rep.sousCode : null,
      });
      return;
    }
    res.status(200).json({ ok: true, phoneNumberId: creds.phoneNumberId });
  } catch (e) {
    console.error('[whatsapp-register]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
