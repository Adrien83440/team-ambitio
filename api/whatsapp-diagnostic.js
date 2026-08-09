// ============================================================================
// api/whatsapp-diagnostic.js — ÉTAT DE SANTÉ DU CANAL WHATSAPP
// ----------------------------------------------------------------------------
// GET /api/whatsapp-diagnostic   → 200 { ok, config, token, numero, modeles, coachs }
// Réservé aux administrateurs.
//
// POURQUOI
// --------
// Trois questions reviennent sans arrêt et n'ont aucune réponse lisible dans
// la console Meta :
//   1. Le token en base est-il le PERMANENT ou le temporaire de 24 h ?
//      Les deux commencent par `EAA` et sont indiscernables à l'œil. Ici,
//      `expires_at = 0` répond définitivement.
//   2. Quels modèles sont réellement approuvés, et sous quelle catégorie ?
//   3. Quels coachs sont joignables — c'est-à-dire ont un numéro exploitable
//      dans Admin → Utilisateurs ?
//
// AUCUN SECRET NE SORT D'ICI. Le token, la clé secrète et le jeton de
// vérification ne sont jamais renvoyés, même tronqués : on ne renvoie que leur
// présence. Un diagnostic qui fuit ce qu'il diagnostique n'en est pas un.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { getWhatsappCreds, graph, normaliserNumero } = require('./_whatsappClient');
const { chargerMembres, coachsActifs, numeroDe } = require('./_teamMembers');

function quand(secondes) {
  if (!secondes) return null;
  return new Date(Number(secondes) * 1000).toISOString();
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  const sortie = { ok: true, config: {}, token: null, numero: null, modeles: null, coachs: null };

  // ── 1. Complétude de la configuration ──────────────────────────────────
  let creds;
  try {
    creds = await getWhatsappCreds();
  } catch (e) {
    res.status(200).json({ ok: false, erreur: (e && e.message) || 'config_illisible' });
    return;
  }
  sortie.config = {
    tokenPresent: !!creds.token,
    phoneNumberId: creds.phoneNumberId,
    wabaId: creds.wabaId,
    apiVersion: creds.apiVersion,
    verifyTokenPresent: !!creds.verifyToken,
    /* appSecret conditionne TOUT le webhook : sans lui, aucun accusé de
       réception ne peut être vérifié, donc aucun ne sera accepté. */
    appSecretPresent: !!creds.appSecret,
  };

  // ── 2. Le token est-il permanent ? ─────────────────────────────────────
  const dbg = await graph('debug_token?input_token=' + encodeURIComponent(creds.token));
  if (!dbg.ok) {
    sortie.token = { valide: false, erreur: dbg.erreur || 'introspection_impossible' };
  } else {
    const d = (dbg.data && dbg.data.data) || {};
    const exp = Number(d.expires_at || 0);
    sortie.token = {
      valide: d.is_valid === true,
      type: d.type || null,
      appId: d.app_id || null,
      application: d.application || null,
      /* expires_at = 0 signifie « n'expire jamais » : c'est LA signature du
         token d'utilisateur système. Toute autre valeur est un temporaire. */
      permanent: exp === 0,
      expireLe: exp === 0 ? null : quand(exp),
      scopes: Array.isArray(d.scopes) ? d.scopes : [],
    };
  }

  // ── 3. Le numéro ───────────────────────────────────────────────────────
  const num = await graph(creds.phoneNumberId
    + '?fields=verified_name,display_phone_number,quality_rating,code_verification_status,platform_type');
  if (!num.ok) {
    sortie.numero = { erreur: num.erreur || 'illisible' };
  } else {
    const n = num.data || {};
    sortie.numero = {
      affichage: n.display_phone_number || null,
      nomVerifie: n.verified_name || null,
      qualite: n.quality_rating || null,
      verification: n.code_verification_status || null,
      plateforme: n.platform_type || null,
    };
  }

  // ── 4. Les modèles ─────────────────────────────────────────────────────
  if (creds.wabaId) {
    const t = await graph(creds.wabaId + '/message_templates?fields=name,status,category,language&limit=100');
    if (!t.ok) {
      sortie.modeles = { erreur: t.erreur || 'illisible' };
    } else {
      const l = (t.data && t.data.data) || [];
      sortie.modeles = l.map((m) => ({
        nom: m.name,
        statut: m.status,
        categorie: m.category,
        langue: m.language,
      }));
    }
  } else {
    sortie.modeles = { erreur: 'wabaId absent de la configuration' };
  }

  // ── 5. Les coachs sont-ils joignables ? ────────────────────────────────
  /* La panne la plus probable du module, et la plus invisible : un coach sans
     numéro exploitable dans Admin → Utilisateurs. Même résolution que l'envoi,
     en version constat — on ne cherche personne, on liste qui est joignable. */
  try {
    const membres = await chargerMembres();
    sortie.coachs = coachsActifs(membres).map((m) => ({
      slug: m.slug || null,
      nom: m.displayName || null,
      joignable: !!numeroDe(m, normaliserNumero),
    }));
  } catch (e) {
    sortie.coachs = { erreur: (e && e.message) || 'illisible' };
  }

  res.status(200).json(sortie);
};
