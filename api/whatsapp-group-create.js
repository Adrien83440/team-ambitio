// ============================================================================
// api/whatsapp-group-create.js — CRÉER LE GROUPE DE SUIVI D'UN CLIENT
// ----------------------------------------------------------------------------
// POST /api/whatsapp-group-create
//   { leadId, coachNom?, coachId?, force? }
//   → 200 { ok, groupId, lien, code, invitations:[{qui,numero,ok,erreur}], deja }
// Réservé aux rôles `sales` et `admin`.
//
// CE QUE FAIT CET ENDPOINT, ET CE QU'IL NE FAIT PAS
// -------------------------------------------------
// Il crée le groupe, récupère son lien d'invitation et envoie le modèle
// `invitation_groupe` à chaque membre. Il n'AJOUTE personne : l'API Cloud n'a
// aucun endpoint pour ça — un groupe WhatsApp se rejoint en cliquant un lien,
// jamais d'office. C'est toute la raison d'être du modèle d'invitation.
//
// Il n'envoie PAS non plus les messages de bienvenue. `bienvenue_groupe_1`
// attend la date du RDV Plan d'Action, qui n'est pas connue à cet instant : un
// paramètre vide ferait échouer l'envoi entier, et personne ne comprendrait
// pourquoi le groupe est resté muet.
//
// HUIT PARTICIPANTS MAXIMUM
// -------------------------
// Limite dure de Meta. Client + closer + Adrien + Emily + Marine + coach = 6.
// On refuse au-delà plutôt que de laisser Meta rejeter des arrivants au
// compte-gouttes, ce qui produirait un groupe incomplet sans message d'erreur.
//
// L'IDEMPOTENCE N'EST PAS UN LUXE
// -------------------------------
// Un second appel créerait un SECOND groupe et enverrait six invitations de
// plus, sans rien pour rattraper le premier. La trace posée sur le lead
// (`whatsappGroupe`) est donc consultée avant toute création, et seule une
// demande explicite (`force`) passe outre.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { creerGroupe, lienInvitationGroupe, envoyerModele,
        normaliserNumero } = require('./_whatsappClient');
const { prenomDe, cle, estActif, numeroDe, chargerUtilisateurs,
        chargerFicheExpert, resoudreCoach } = require('./_coachLookup');
const parseBody = require('./_parseBody');

const MODELE_INVITATION = 'invitation_groupe';

/* Les trois personnes présentes dans TOUS les groupes de suivi. Résolues par
   nom dans les comptes actifs — pas par identifiant : `booking_config` et
   `users` ne partagent pas leurs clés, et coder un uid en dur ici le rendrait
   faux au premier changement de compte.
   Un permanent introuvable ne fait pas échouer la création : le groupe existe,
   son absence est rapportée, et l'invitation se renvoie à la main. */
const PERMANENTS = ['Adrien', 'Emily', 'Marine'];

/* Meta refuse au-delà. Le client compte comme participant. */
const MAX_PARTICIPANTS = 8;

/** Le code d'invitation seul, pour le passer à `team.alteore.com/g/{code}`. */
function codeDuLien(lien) {
  const m = String(lien || '').match(/chat\.whatsapp\.com\/([A-Za-z0-9_-]{5,64})/);
  return m ? m[1] : null;
}

/** Un compte actif dont le nom (ou le prénom seul, s'il est unique) colle. */
function parNom(utilisateurs, nom) {
  const actifs = (utilisateurs || []).filter(estActif);
  const k = cle(nom);
  if (!k) return null;
  const exact = actifs.find((u) => cle(u.displayName) === k);
  if (exact) return exact;
  const candidats = actifs.filter((u) => cle(prenomDe(u.displayName)) === cle(prenomDe(k)));
  /* Deux « Thomas » et on préfère ne rien envoyer qu'écrire au mauvais —
     même règle que resoudreCoach. */
  return candidats.length === 1 ? candidats[0] : null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
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
  const par = (auth && auth.email) || 'equipe';

  const body = parseBody(req) || {};
  const leadId = String(body.leadId || '').trim();
  const coachNom = String(body.coachNom || '').trim();
  const coachId = String(body.coachId || '').trim();
  const force = body.force === true;
  if (!leadId) { res.status(400).json({ ok: false, erreur: 'leadId_requis' }); return; }

  try {
    const ref = db.collection('leads').doc(leadId);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, erreur: 'lead_introuvable' }); return; }
    const L = snap.data() || {};

    /* ── Le groupe existe déjà ? ─────────────────────────────────────── */
    const deja = L.whatsappGroupe || null;
    if (!force && deja && deja.groupId) {
      res.status(200).json({
        ok: true, deja: true,
        groupId: deja.groupId, lien: deja.lien || null, code: deja.code || null,
        invitations: deja.invitations || [],
      });
      return;
    }

    const nomClient = String(L.nom || '').trim();
    if (!nomClient) { res.status(200).json({ ok: false, erreur: 'nom_client_absent' }); return; }

    /* ── Qui sera dans le groupe ─────────────────────────────────────── */
    const utilisateurs = await chargerUtilisateurs();
    const membres = [];
    const manquants = [];

    /* Le client. Sans son numéro, le groupe n'a aucun sens : on refuse. */
    const numClient = normaliserNumero(L.telephone || L.phone || '');
    if (!numClient) { res.status(200).json({ ok: false, erreur: 'numero_client_absent' }); return; }
    membres.push({ qui: 'client', nom: nomClient, prenom: prenomDe(nomClient), numero: numClient });

    /* Le coach, résolu comme dans whatsapp-notify-coach : fiche expert
       d'abord, nom ensuite. */
    const fiche = await chargerFicheExpert(coachId);
    const rc = resoudreCoach(utilisateurs, fiche, coachNom, normaliserNumero);
    if (rc.erreur) manquants.push({ qui: 'coach', raison: rc.erreur });
    else membres.push({
      qui: 'coach', nom: rc.utilisateur.displayName,
      prenom: prenomDe(rc.utilisateur.displayName), numero: rc.numero,
    });

    /* Le closer : celui à qui le lead est attribué. `assignedTo` est un SLUG
       d'équipe, pas un uid — on repasse donc par le nom. */
    if (L.assignedTo) {
      const u = parNom(utilisateurs, L.assignedTo)
             || (utilisateurs.filter(estActif).find((x) => cle(x.slug || '') === cle(L.assignedTo)) || null);
      const n = u ? numeroDe(u, normaliserNumero) : null;
      if (u && n) membres.push({ qui: 'closer', nom: u.displayName, prenom: prenomDe(u.displayName), numero: n });
      else manquants.push({ qui: 'closer', raison: u ? 'numero_absent' : 'compte_introuvable' });
    }

    /* Les permanents. Un doublon est possible — le closer PEUT être l'un
       d'eux : on déduplique sur le numéro, sinon la même personne recevrait
       deux invitations et occuperait deux places sur huit. */
    PERMANENTS.forEach((nom) => {
      const u = parNom(utilisateurs, nom);
      const n = u ? numeroDe(u, normaliserNumero) : null;
      if (!u || !n) { manquants.push({ qui: nom, raison: u ? 'numero_absent' : 'compte_introuvable' }); return; }
      membres.push({ qui: nom, nom: u.displayName, prenom: prenomDe(u.displayName), numero: n });
    });

    const vus = {};
    const destinataires = membres.filter((m) => {
      if (vus[m.numero]) return false;
      vus[m.numero] = 1;
      return true;
    });

    if (destinataires.length > MAX_PARTICIPANTS) {
      res.status(200).json({
        ok: false, erreur: 'trop_de_participants',
        detail: destinataires.length + ' personnes pour ' + MAX_PARTICIPANTS + ' places maximum.',
        destinataires: destinataires.map((d) => d.qui),
      });
      return;
    }

    /* ── Le groupe ───────────────────────────────────────────────────── */
    const g = await creerGroupe({ sujet: 'Alteore — ' + nomClient });
    if (!g.ok) {
      /* La réponse brute de Meta est renvoyée telle quelle : c'est elle qui
         dira si le refus vient de l'absence de badge vérifié (OBA) ou d'autre
         chose. Deviner à la place de Meta n'aiderait personne. */
      res.status(200).json({ ok: false, erreur: g.erreur || 'creation_impossible', brut: g.brut || null });
      return;
    }

    let lien = g.lien;
    if (!lien) {
      const li = await lienInvitationGroupe(g.groupId, false);
      lien = li.ok ? li.lien : null;
    }
    if (!lien) {
      /* Le groupe existe mais personne ne peut le rejoindre. On trace quand
         même pour ne pas en créer un second au prochain appel. */
      await ref.set({ whatsappGroupe: { groupId: g.groupId, lien: null, code: null,
        creeA: Date.now(), par: par, invitations: [], erreur: 'lien_indisponible' } }, { merge: true })
        .catch((e) => console.warn('[whatsapp-group] trace:', e && e.message));
      res.status(200).json({ ok: false, groupId: g.groupId, erreur: 'lien_indisponible' });
      return;
    }

    const code = codeDuLien(lien);

    /* ── Les invitations ─────────────────────────────────────────────── */
    /* En série et non en parallèle : Meta limite le débit, et six envois
       simultanés sur un numéro tout juste réenregistré est le meilleur moyen
       de récolter des refus sans rapport avec le contenu. */
    const invitations = [];
    for (let i = 0; i < destinataires.length; i++) {
      const d = destinataires[i];
      const envoi = await envoyerModele({
        to: d.numero,
        template: MODELE_INVITATION,
        langue: 'fr',
        /* {{1}} prénom du destinataire · {{2}} nom du client · {{3}} code */
        params: [d.prenom || d.nom, nomClient, code || lien],
        contexte: { type: 'invitation_groupe', leadId: leadId, groupId: g.groupId, par: par },
      });
      invitations.push({ qui: d.qui, numero: d.numero, ok: envoi.ok, erreur: envoi.erreur || null });
    }

    /* Trace AVANT la réponse : Vercel tue la fonction dès que celle-ci part,
       et un groupe créé sans trace serait recréé au prochain clic. */
    await ref.set({
      whatsappGroupe: {
        groupId: g.groupId, lien: lien, code: code,
        sujet: 'Alteore — ' + nomClient,
        creeA: Date.now(), par: par,
        coach: (rc && rc.utilisateur) ? rc.utilisateur.displayName : (coachNom || null),
        invitations: invitations,
        manquants: manquants,
      },
    }, { merge: true }).catch((e) => console.warn('[whatsapp-group] trace:', e && e.message));

    console.log('[whatsapp-group]', leadId, g.groupId, invitations.filter((x) => x.ok).length
      + '/' + invitations.length + ' invitations');

    res.status(200).json({
      ok: true, deja: false,
      groupId: g.groupId, lien: lien, code: code,
      invitations: invitations, manquants: manquants,
    });
  } catch (e) {
    console.error('[whatsapp-group-create]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, erreur: 'server_error' });
  }
};
