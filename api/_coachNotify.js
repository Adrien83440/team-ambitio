// ============================================================================
// api/_coachNotify.js — LE MESSAGE WHATSAPP AU COACH (exclu du routing)
// ----------------------------------------------------------------------------
// Corps de /api/whatsapp-notify-coach, sorti le 30/10/2026 pour être aussi
// appelé par le rappel J-7 du démarrage différé (api/_demarrage.js).
// Le pourquoi du message et du rapprochement des référentiels est documenté en
// tête de api/whatsapp-notify-coach.js.
//
// notifierCoach({ clientId, leadId, coachId, coachNom, programme, force, par,
//                 ignorerDemarrage }) → { status, body }
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { envoyerModele, normaliserNumero } = require('./_whatsappClient');
const { prenomDe, chargerUtilisateurs, chargerFicheExpert, resoudreCoach } = require('./_coachLookup');
const Demarrage = require('../demarrage-core.js');

const MODELE = 'coach_assigne';

async function notifierCoach(o) {
  const clientId = o.clientId || '';
  const leadId = o.leadId || '';
  const coachId = o.coachId || '';
  const coachNom = o.coachNom || '';
  const programme = o.programme || '';
  const force = o.force === true;
  const par = o.par || 'equipe';

  const ref = clientId
    ? db.collection('clients').doc(clientId)
    : db.collection('leads').doc(leadId);
  const snap = await ref.get();
  if (!snap.exists) return { status: 404, body: { ok: false, error: clientId ? 'client_not_found' : 'lead_not_found' } };
  const C = snap.data() || {};

  /* Démarrage différé (30/10/2026) : prévenir le coach deux mois à l'avance
     ne lui sert à rien. Il est attribué au close, et le message part à J-7
     (api/_demarrage.js) ou au démarrage s'il est avancé. */
  if (!force && !o.ignorerDemarrage && Demarrage.enAttente(C.demarrageDiffere)
    && Demarrage.joursEntre(Demarrage.aujourdhui(), C.demarrageDiffere.date) > Demarrage.RAPPEL_JOURS) {
    return { status: 200, body: { ok: true, envoye: false, raison: 'demarrage_differe' } };
  }

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
    return { status: 200, body: { ok: true, envoye: false, raison: r.erreur } };
  }

  /* Idempotence. Le plan d'action est enregistré plusieurs fois de suite —
     sans ce garde-fou, le coach recevrait le même message à chaque
     sauvegarde. On ne rejoue que si le coach a changé, ou sur `force`. */
  const deja = C.whatsappCoachNotifie || null;
  if (!force && deja && deja.coachUid === r.utilisateur.uid) {
    return { status: 200, body: { ok: true, envoye: false, raison: 'deja_notifie', coach: { uid: r.utilisateur.uid } } };
  }

  /* {{3}} = le contexte du client. `activite` est saisie à la main et peut
     manquer ; le programme, lui, est toujours présent et reste une
     information utile au coach. Un paramètre vide ferait échouer l'envoi
     entier — d'où ce repli plutôt qu'un blocage.

     Depuis un lead, ni l'un ni l'autre n'existe encore : le parcours de
     close transmet le contrat qu'il vient de faire choisir (« Elite » ou
     « Business »), qui est exactement l'information utile au coach à cet
     instant. */
  const contexte = String(C.activite || '').trim()
                || String(C.programme || '').trim()
                || programme;
  const nomClient = String(C.nom || '').trim();
  if (!nomClient || !contexte) {
    return { status: 200, body: { ok: true, envoye: false, raison: 'fiche_incomplete' } };
  }

  const envoi = await envoyerModele({
    to: r.numero,
    template: MODELE,
    langue: 'fr',
    params: [prenomDe(r.utilisateur.displayName), nomClient, contexte],
    contexte: {
      type: 'coach_assigne',
      clientId: clientId || null,
      leadId: leadId || null,
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

  return {
    status: 200,
    body: {
      ok: true,
      envoye: envoi.ok,
      wamid: envoi.wamid,
      raison: envoi.ok ? null : envoi.erreur,
      coach: { uid: r.utilisateur.uid, nom: r.utilisateur.displayName || null, via: r.via },
    },
  };
}

module.exports = { notifierCoach };
