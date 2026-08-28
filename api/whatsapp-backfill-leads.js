// ============================================================================
// api/whatsapp-backfill-leads.js — POSER LA TRACE SUR LES ENVOIS PASSÉS
// ----------------------------------------------------------------------------
// GET /api/whatsapp-backfill-leads            → ce qui SERAIT écrit (dry-run)
// GET /api/whatsapp-backfill-leads?execute=1  → écrit
// Réservé aux administrateurs.
//
// POURQUOI
// --------
// Le champ `whatsappEnvoye` n'existait pas avant le 28/08/2026 : tous les
// messages partis jusque-là n'ont laissé aucune trace sur la fiche, et leur
// badge reste éteint dans Leads Live alors que le prospect a bien reçu un
// message. Rien ne se réparera tout seul — un lead déjà contacté ne le sera
// pas une seconde fois.
//
// On relit donc les conversations, on retrouve le premier et le dernier envoi
// SORTANT de chacune, et on pose la trace sur le lead correspondant.
//
// LECTURE SEULE PAR DÉFAUT. Conformément à la règle du dépôt, l'écriture
// n'a lieu qu'avec `execute=1`, après lecture du rapport.
//
// IDEMPOTENT : un lead qui porte déjà `whatsappEnvoye.premierAt` n'est pas
// retouché — sa date de premier contact est la vérité, et l'écraser avec une
// autre passe de rattrapage la fausserait.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const { rattacherLead } = require('./_whatsappClient');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  const execute = String((req.query && req.query.execute) || '') === '1';

  try {
    const convs = await db.collection('whatsapp_conversations').get();
    const sortie = { ok: true, execute: execute, conversations: convs.size,
                     traites: 0, ecrits: 0, detail: [] };

    for (const c of convs.docs) {
      const numero = c.id;
      const conv = c.data() || {};

      /* Les envois sortants de cette conversation, du plus ancien au plus
         récent. On lit tout : une conversation active en compte quelques
         dizaines, et le tri en mémoire évite un index composite. */
      const msgs = await c.ref.collection('messages').get();
      const sortants = [];
      msgs.forEach((m) => {
        const d = m.data() || {};
        if (d.sens === 'out') sortants.push(d);
      });
      if (!sortants.length) continue;
      sortants.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));

      const premier = sortants[0];
      const dernier = sortants[sortants.length - 1];
      const ligne = {
        numero: numero,
        nom: conv.nomLead || null,
        envois: sortants.length,
        premierAt: Number(premier.at) || null,
        dernierAt: Number(dernier.at) || null,
        modele: dernier.modele || null,
      };

      /* Le lead : celui de l'index si présent, sinon on le retrouve — c'est
         justement le cas qui a produit des conversations orphelines. */
      let leadId = conv.leadId || null;
      if (!leadId) {
        const l = await rattacherLead(numero);
        leadId = l ? l.leadId : null;
        ligne.retrouve = !!leadId;
      }
      if (!leadId) {
        ligne.resultat = 'lead_introuvable';
        sortie.detail.push(ligne);
        continue;
      }
      ligne.leadId = leadId;

      const ls = await db.collection('leads').doc(leadId).get();
      if (!ls.exists) { ligne.resultat = 'lead_supprime'; sortie.detail.push(ligne); continue; }
      const deja = (ls.data() || {}).whatsappEnvoye || {};
      if (deja.premierAt) { ligne.resultat = 'deja_trace'; sortie.detail.push(ligne); continue; }

      sortie.traites++;
      if (!execute) {
        ligne.resultat = 'simule';
        sortie.detail.push(ligne);
        continue;
      }

      await db.collection('leads').doc(leadId).set({
        whatsappEnvoye: {
          at: ligne.dernierAt || Date.now(),
          premierAt: ligne.premierAt || ligne.dernierAt || Date.now(),
          modele: ligne.modele,
          par: 'rattrapage',
        },
      }, { merge: true });

      /* L'index de conversation est réparé au passage : sans leadId, la boîte
         partagée continue d'afficher un numéro nu à la place du nom. */
      if (!conv.leadId) {
        await c.ref.set({ leadId: leadId }, { merge: true })
          .catch((e) => console.warn('[backfill] index', numero, e && e.message));
      }

      sortie.ecrits++;
      ligne.resultat = 'ecrit';
      sortie.detail.push(ligne);
    }

    console.log('[whatsapp-backfill]', execute ? 'écrit' : 'dry-run',
      sortie.ecrits + '/' + sortie.traites);
    res.status(200).json(sortie);
  } catch (e) {
    console.error('[whatsapp-backfill]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, erreur: 'server_error' });
  }
};
