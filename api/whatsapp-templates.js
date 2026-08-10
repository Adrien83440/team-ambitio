// ============================================================================
// api/whatsapp-templates.js — LES MODÈLES UTILISABLES, PRÊTS À REMPLIR
// ----------------------------------------------------------------------------
// GET /api/whatsapp-templates   → 200 { ok, modeles:[{nom,langue,categorie,
//                                       corps, variables, entete, pied}] }
// Réservé aux rôles `sales` et `admin`.
//
// POURQUOI PAS LE DIAGNOSTIC
// --------------------------
// Le diagnostic liste TOUS les modèles avec leur statut, pour savoir où en est
// l'examen Meta. Ici on ne renvoie que les APPROUVÉS, et surtout on renvoie le
// TEXTE et le nombre de variables : c'est ce dont l'écran a besoin pour
// afficher un aperçu et générer les bons champs de saisie.
//
// Sans ce texte, l'équipe choisirait un modèle par son nom technique
// (`rappel_rdv_j1`) sans voir ce que le client va lire — et enverrait un
// message à l'aveugle.
// ============================================================================

const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { getWhatsappCreds, graph } = require('./_whatsappClient');

/* Les variables d'un corps de modèle : {{1}}, {{2}}… On renvoie le nombre le
   plus élevé rencontré, et non le nombre d'occurrences — un modèle peut très
   bien répéter {{1}} deux fois. */
function nbVariables(texte) {
  var max = 0;
  var re = /\{\{(\d+)\}\}/g;
  var m;
  while ((m = re.exec(String(texte || ''))) !== null) {
    var n = parseInt(m[1], 10);
    if (isFinite(n) && n > max) max = n;
  }
  return max;
}

function composant(m, type) {
  const l = (m && m.components) || [];
  for (let i = 0; i < l.length; i++) {
    if (l[i] && String(l[i].type).toUpperCase() === type) return l[i];
  }
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

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

  try {
    const creds = await getWhatsappCreds();
    if (!creds.wabaId) { res.status(200).json({ ok: false, erreur: 'wabaId absent' }); return; }

    const rep = await graph(creds.wabaId
      + '/message_templates?fields=name,status,category,language,components&limit=100');
    if (!rep.ok) { res.status(200).json({ ok: false, erreur: rep.erreur || 'illisible' }); return; }

    const brut = (rep.data && rep.data.data) || [];
    const modeles = brut
      .filter((m) => String(m.status).toUpperCase() === 'APPROVED')
      .map((m) => {
        const corps = composant(m, 'BODY');
        const entete = composant(m, 'HEADER');
        const pied = composant(m, 'FOOTER');
        const texte = (corps && corps.text) || '';
        return {
          nom: m.name,
          langue: m.language,
          categorie: m.category,
          corps: texte,
          variables: nbVariables(texte),
          entete: (entete && entete.text) || null,
          pied: (pied && pied.text) || null,
          /* Un modèle à bouton ne peut pas être rempli depuis un champ texte
             simple : l'écran doit pouvoir l'écarter plutôt que de l'envoyer
             mal formé. */
          boutons: !!composant(m, 'BUTTONS'),
        };
      })
      .sort((a, b) => String(a.nom).localeCompare(String(b.nom)));

    res.status(200).json({ ok: true, modeles: modeles });
  } catch (e) {
    console.error('[whatsapp-templates]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, erreur: 'server_error' });
  }
};
