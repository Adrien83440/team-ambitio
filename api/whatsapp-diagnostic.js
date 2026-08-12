// ============================================================================
// api/whatsapp-diagnostic.js — ÉTAT DE SANTÉ DU CANAL WHATSAPP
// ----------------------------------------------------------------------------
// GET /api/whatsapp-diagnostic   → 200 { ok, config, token, numero, abonnement,
//                                         facturation, sante, modeles, coachs }
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
const { chargerUtilisateurs, chargerFichesExperts, resoudreCoach } = require('./_coachLookup');

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

  const sortie = { ok: true, config: {}, token: null, numero: null, numerosDuCompte: null, abonnement: null, facturation: null, sante: null, modeles: null, effectifs: null, coachs: null };

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
    /* L'interrupteur des rappels automatiques : tant qu'il est faux, le cron
       tourne à vide. C'est la première chose à regarder si « les rappels ne
       partent pas ». */
    rappelsActifs: creds.rappelsActifs === true,
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
      /* Les comptes WhatsApp que ce token peut réellement piloter. C'est le
         moyen le plus direct de retrouver le bon `wabaId` : la console Meta ne
         l'affiche nulle part clairement, et un `wabaId` qui ne contient pas le
         numéro configuré condamne silencieusement tous les envois. */
      comptesAccessibles: (Array.isArray(d.granular_scopes) ? d.granular_scopes : [])
        .filter((g) => g && String(g.scope || '').indexOf('whatsapp_business') === 0)
        .reduce((acc, g) => acc.concat(Array.isArray(g.target_ids) ? g.target_ids : []), [])
        .filter((v, i, a) => a.indexOf(v) === i),
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

  // ── 3 bis. Le numéro appartient-il bien au WABA configuré ? ────────────
  /* Un modèle n'est utilisable que par les numéros de SON compte. Si le
     `phoneNumberId` et le `wabaId` de la configuration ne désignent pas le
     même compte, chaque envoi échouerait sur un « template not found » très
     peu bavard. Les deux lectures précédentes ne le disent pas : elles
     réussissent séparément. */
  if (creds.wabaId) {
    const np = await graph(creds.wabaId + '/phone_numbers?fields=id,display_phone_number,platform_type&limit=50');
    if (!np.ok) {
      sortie.numerosDuCompte = { erreur: np.erreur || 'illisible' };
    } else {
      const l = (np.data && np.data.data) || [];
      sortie.numerosDuCompte = {
        liste: l.map((n) => ({
          id: n.id,
          affichage: n.display_phone_number || null,
          plateforme: n.platform_type || null,
          configure: String(n.id) === String(creds.phoneNumberId),
        })),
        configureAppartientAuCompte: l.some((n) => String(n.id) === String(creds.phoneNumberId)),
      };
    }
  }

  // ── 3 ter. L'app est-elle abonnée au compte ? ──────────────────────────
  /* Sans cet abonnement, Meta n'appelle JAMAIS le webhook : l'URL est
     enregistrée, elle répond, et pourtant rien n'arrive. Aucune erreur nulle
     part — c'est la panne la plus silencieuse de toute la chaîne. */
  if (creds.wabaId) {
    const ab = await graph(creds.wabaId + '/subscribed_apps');
    if (!ab.ok) {
      sortie.abonnement = { erreur: ab.erreur || 'illisible' };
    } else {
      const l = (ab.data && ab.data.data) || [];
      sortie.abonnement = {
        apps: l.map((a) => ({
          id: (a.whatsapp_business_api_data || {}).id || null,
          nom: (a.whatsapp_business_api_data || {}).name || null,
        })),
        actif: l.length > 0,
      };
    }
  }

  // ── 3 quater. Le compte peut-il PAYER ses envois ? ─────────────────────
  /* Depuis la facturation au message, tout modèle est payant. Sans moyen de
     paiement rattaché au compte, Meta ACCEPTE l'envoi (200 + wamid, donc une
     bulle dans la boîte partagée) puis refuse de le distribuer avec l'erreur
     131042. Rien dans le token, le numéro ni les modèles ne le laisse voir :
     tout est vert, et rien n'arrive. C'est exactement la panne du 12/08/2026.

     Deux lectures indépendantes, isolées l'une de l'autre : un champ retiré
     d'une version de l'API ferait échouer la requête entière, et ce diagnostic
     doit continuer de répondre même amputé d'une section. */
  if (creds.wabaId) {
    const fac = await graph(creds.wabaId
      + '?fields=account_review_status,business_verification_status,currency,primary_funding_id');
    if (!fac.ok) {
      sortie.facturation = { erreur: fac.erreur || 'illisible' };
    } else {
      const f = fac.data || {};
      sortie.facturation = {
        examenCompte: f.account_review_status || null,
        verificationEntreprise: f.business_verification_status || null,
        devise: f.currency || null,
        /* LE champ qui répond à « pourquoi 131042 ». Absent = aucun moyen de
           paiement rattaché au compte WhatsApp — c'est le portefeuille du
           portfolio publicitaire qui ne descend pas jusqu'au WABA. */
        moyenDePaiementId: f.primary_funding_id || null,
        moyenDePaiementPresent: !!f.primary_funding_id,
      };
    }
  }

  /* L'avis de Meta lui-même sur la capacité à envoyer. Quand il existe, c'est
     la réponse la plus directe : `can_send_message` passe à BLOCKED avec le
     motif, avant même la première tentative. Le champ est récent — s'il n'est
     pas servi par cette version de l'API, on le dit et on n'en fait pas un
     échec. */
  const sante = await graph(creds.phoneNumberId + '?fields=health_status');
  if (!sante.ok) {
    sortie.sante = { erreur: sante.erreur || 'indisponible' };
  } else {
    const hs = (sante.data && sante.data.health_status) || null;
    sortie.sante = hs
      ? {
          envoiPossible: hs.can_send_message || null,
          entites: (Array.isArray(hs.entities) ? hs.entities : []).map((e) => ({
            type: e.entity_type || null,
            id: e.id || null,
            envoiPossible: e.can_send_message || null,
            motifs: (Array.isArray(e.errors) ? e.errors : []).map((x) => ({
              code: x.error_code != null ? x.error_code : null,
              description: x.error_description || null,
              solution: x.possible_solution || null,
            })),
          })),
        }
      : { erreur: 'health_status non servi par ' + creds.apiVersion };
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

  // ── 5. Qui est joignable dans le sélecteur de coach ? ──────────────────
  /* On parcourt EXACTEMENT la liste que voit le mentor dans le plan d'action
     — les fiches expert de booking_config — et on tente pour chacune la même
     résolution que l'envoi. `via` dit par quel chemin le compte a été trouvé :
     `firebaseUid` est le lien propre, tout le reste est un repli qui mériterait
     d'être réparé dans Admin → Utilisateurs. */
  try {
    const [utilisateurs, fiches] = await Promise.all([
      chargerUtilisateurs(),
      chargerFichesExperts(),
    ]);
    /* Sans ces compteurs, un `coachs` vide ne dit pas s'il n'y a aucune fiche
       expert, aucun compte, ou si la résolution échoue. Trois causes très
       différentes qui se ressemblaient toutes. */
    sortie.effectifs = { utilisateurs: utilisateurs.length, fichesExpert: fiches.length };
    sortie.coachs = fiches.map((f) => {
      const r = resoudreCoach(utilisateurs, f, f.name, normaliserNumero);
      return {
        id: f.id,
        nom: f.name || null,
        joignable: !r.erreur,
        via: r.via || null,
        probleme: r.erreur || null,
      };
    });
  } catch (e) {
    sortie.coachs = { erreur: (e && e.message) || 'illisible' };
  }

  res.status(200).json(sortie);
};
