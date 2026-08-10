// ============================================================================
// api/whatsapp-notify-coach.js — NOTIFIER LE COACH DE SON ATTRIBUTION
// ----------------------------------------------------------------------------
// POST /api/whatsapp-notify-coach
//   { clientId, coachId?, coachNom?, force? }
//   → 200 { ok, envoye, wamid, coach:{slug,nom,numero}, raison }
//
// POURQUOI
// --------
// Jusqu'ici l'attribution d'un coach était orale : la closeuse demandait un nom
// dans le groupe interne, et le coach découvrait son client en ouvrant Alteore
// — ou ne le découvrait pas. Ce message ferme la boucle au moment exact où le
// coach est choisi dans le plan d'action.
//
// LE PONT ENTRE DEUX RÉFÉRENTIELS
// -------------------------------
// Le sélecteur du plan d'action lit `booking_config` (docs `__type === 'person'`)
// et n'en tire qu'un identifiant et un nom : AUCUN numéro de téléphone.
// Les numéros vivent ailleurs, dans `_meta/team_members`, champ `ringoverPhones`
// (Admin → Utilisateurs). Les deux référentiels ne partagent pas leurs clés :
// on les rapproche donc par le nom, en plusieurs passes, du plus sûr au plus
// permissif. Si aucune passe n'aboutit, on n'envoie RIEN et on le dit — deviner
// un destinataire serait pire que ne pas notifier.
//
// ⚠️ Un numéro Ringover n'est pas nécessairement un compte WhatsApp. Si le
// coach n'est pas sur WhatsApp, Meta répond une erreur explicite (131026) que
// le journal conserve. C'est visible, donc corrigeable.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { envoyerModele, normaliserNumero } = require('./_whatsappClient');
const { prenomDe, chargerUtilisateurs, chargerFicheExpert, resoudreCoach } = require('./_coachLookup');
const parseBody = require('./_parseBody');

const MODELE = 'coach_assigne';

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  /* Réservé à l'équipe connectée : ce endpoint écrit à un salarié. */
  let par = null;
  try {
    const auth = await verifyFirebaseAuth(req);
    par = (auth && auth.email) || 'equipe';
  } catch (e) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const body = parseBody(req) || {};
  const clientId = String(body.clientId || '').trim();
  const coachId = String(body.coachId || '').trim();
  const coachNom = String(body.coachNom || '').trim();
  const force = body.force === true;
  if (!clientId) { res.status(400).json({ ok: false, error: 'clientId_required' }); return; }

  try {
    const ref = db.collection('clients').doc(clientId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'client_not_found' }); return; }
    const C = snap.data() || {};

    const nomCoach = coachNom || C.coach || '';
    /* La fiche expert porte le lien exact vers le compte ; les deux lectures
       sont indépendantes, donc menées de front. */
    const [utilisateurs, fiche] = await Promise.all([
      chargerUtilisateurs(),
      chargerFicheExpert(coachId),
    ]);
    const r = resoudreCoach(utilisateurs, fiche, nomCoach, normaliserNumero);
    if (r.erreur) {
      console.warn('[whatsapp-notify-coach]', clientId, r.erreur, 'coachId=' + coachId, 'nom=' + nomCoach);
      res.status(200).json({ ok: true, envoye: false, raison: r.erreur });
      return;
    }

    /* Idempotence. Le plan d'action est enregistré plusieurs fois de suite —
       sans ce garde-fou, le coach recevrait le même message à chaque
       sauvegarde. On ne rejoue que si le coach a changé, ou sur `force`. */
    const deja = C.whatsappCoachNotifie || null;
    if (!force && deja && deja.coachUid === r.utilisateur.uid) {
      res.status(200).json({ ok: true, envoye: false, raison: 'deja_notifie', coach: { uid: r.utilisateur.uid } });
      return;
    }

    /* {{3}} = le contexte du client. `activite` est saisie à la main et peut
       manquer ; le programme, lui, est toujours présent et reste une
       information utile au coach. Un paramètre vide ferait échouer l'envoi
       entier — d'où ce repli plutôt qu'un blocage. */
    const contexte = String(C.activite || '').trim() || String(C.programme || '').trim();
    const nomClient = String(C.nom || '').trim();
    if (!nomClient || !contexte) {
      res.status(200).json({ ok: true, envoye: false, raison: 'fiche_incomplete' });
      return;
    }

    const envoi = await envoyerModele({
      to: r.numero,
      template: MODELE,
      langue: 'fr',
      params: [prenomDe(r.utilisateur.displayName), nomClient, contexte],
      contexte: {
        type: 'coach_assigne',
        clientId: clientId,
        coachUid: r.utilisateur.uid,
        par: par,
      },
    });

    /* Trace sur la fiche AVANT de répondre : Vercel tue la fonction dès que la
       réponse est partie, et une écriture non attendue serait perdue. */
    if (envoi.ok) {
      await ref.set({
        whatsappCoachNotifie: {
          coachUid: r.utilisateur.uid,
          coachNom: r.utilisateur.displayName || null,
          via: r.via,
          wamid: envoi.wamid,
          at: Date.now(),
          par: par,
        },
      }, { merge: true }).catch((e) => console.warn('[whatsapp-notify-coach] trace:', e && e.message));
    }

    res.status(200).json({
      ok: true,
      envoye: envoi.ok,
      wamid: envoi.wamid,
      raison: envoi.ok ? null : envoi.erreur,
      coach: { uid: r.utilisateur.uid, nom: r.utilisateur.displayName || null, via: r.via },
    });
  } catch (e) {
    console.error('[whatsapp-notify-coach]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
