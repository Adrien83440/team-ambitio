// ============================================================================
// api/signature-completed.js — LA COPIE DU CONTRAT SIGNÉ, PAR EMAIL
// ----------------------------------------------------------------------------
// POST /api/signature-completed   { requestId, token }            (signataire)
// POST /api/signature-completed   { requestId, force }  + Bearer  (équipe)
//   → 200 { ok:true, sentTo, filename, envois }
//   → 200 { ok:true, already:true }     déjà envoyée, on ne double pas
//
// POURQUOI CET ENDPOINT
// ---------------------
// À la fin de la signature, sign.html déposait un document
// webhook_inbox { action:'signature_completed' } et comptait sur la Cloud
// Function onWebhookInbox pour envoyer la copie au client. Cette fonction a
// été redéployée depuis le repo, dont la copie ne contenait plus les handlers
// signature : le document est toujours écrit, plus personne ne le lit. Le
// client signait et ne recevait jamais son contrat, sans qu'aucune erreur
// n'apparaisse nulle part.
//
// C'est EXACTEMENT la panne qui avait déjà emporté le code SMS (voir
// api/signature-otp.js, même en-tête). On applique le même remède : le
// traitement revient sur Vercel, qui déploie depuis git — le code lu est donc
// le code exécuté, et la divergence n'est plus possible.
//
// DEUX PORTES D'ENTRÉE, TOUTES DEUX VÉRIFIÉES — même modèle que
// api/signature-send-link.js :
//   · le signataire, avec le token de la demande — il n'a pas de compte, mais
//     il vient de signer et son token prouve qu'il est bien sur ce dossier ;
//   · l'équipe, avec un jeton Firebase — c'est le bouton « Envoyer la copie »
//     de l'onglet Terminés dans sales-signatures.
// Aucune des deux ne choisit le destinataire : l'adresse vient TOUJOURS du
// document Firestore, jamais du corps de requête — sinon n'importe qui ferait
// expédier un contrat signé à l'adresse de son choix.
//
// IDEMPOTENCE — ET SA LEVÉE VOLONTAIRE
// `copieEnvoyeeAt` marque l'envoi : un rechargement de la page de fin ou un
// double clic ne renvoie pas le contrat une seconde fois. L'équipe, elle, peut
// passer outre avec force:true — c'est tout l'intérêt du bouton : le client a
// perdu son mail, il est parti en spam, l'adresse a été corrigée. Le garde
// reste absolu pour la porte publique, qui ne peut PAS demander force.
//
// COUCHE ADDITIVE : l'écriture dans webhook_inbox reste en place côté
// sign.html. Si la Cloud Function revenait un jour à la vie, le garde
// d'idempotence empêcherait le double envoi.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');

/* Comptes d'envoi autorisés — mêmes que signature-fallback.js. */
const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

function safeFilename(s) {
  return String(s || 'contrat')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '_')
    .slice(0, 60) || 'contrat';
}

/* Même vérification que api/academy-grant.js : le token du lien de signature,
   à la racine (ancien modèle) ou porté par un signataire (nouveau). */
function tokenMatches(reqData, token) {
  if (!token) return false;
  if (reqData.token && reqData.token === token) return true;
  if (Array.isArray(reqData.signers)) {
    return reqData.signers.some((s) => s && s.token && s.token === token);
  }
  return false;
}

/* Le PDF signé vit soit en clair sur la demande, soit découpé en morceaux
   dans la sous-collection signed_pdf — au-delà de ~900 Ko, sign.html découpe
   pour tenir sous la limite de 1 Mo par document Firestore.
   orderBy('chunk') : les morceaux se recollent par leur index, jamais par
   l'ordre alphabétique de leur identifiant. */
async function lirePdfSigne(reqRef, reqData) {
  if (reqData.signedPdfBase64) return reqData.signedPdfBase64;
  const snap = await reqRef.collection('signed_pdf').orderBy('chunk').get();
  if (snap.empty) return null;
  let b64 = '';
  snap.forEach((d) => { b64 += (d.data() || {}).data || ''; });
  return b64 || null;
}

/* Le destinataire : l'adresse du document, jamais celle du corps de requête. */
function emailDuClient(R) {
  if (R.clientEmail) return String(R.clientEmail).trim();
  if (Array.isArray(R.signers)) {
    const s = R.signers.find((x) => x && x.email);
    if (s) return String(s.email).trim();
  }
  return '';
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const body = parseBody(req) || {};
  const requestId = String(body.requestId || '').trim();
  const token = String(body.token || '').trim();
  if (!requestId) { res.status(400).json({ ok: false, error: 'requestId_required' }); return; }

  try {
    const reqRef = db.collection('signature_requests').doc(requestId);
    const snap = await reqRef.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'request_not_found' }); return; }
    const R = snap.data() || {};

    /* Porte 1 : l'équipe, avec un jeton Firebase. Porte 2 : le token de la
       demande. L'une des deux suffit, aucune n'est facultative. */
    let par = null;
    let equipe = false;
    try {
      const auth = await verifyFirebaseAuth(req);
      if (auth) { equipe = true; par = auth.email || 'equipe'; }
    } catch (e) { /* pas de jeton : on tente le token de la demande */ }
    if (!equipe) {
      if (!tokenMatches(R, token)) { res.status(401).json({ ok: false, error: 'invalid_token' }); return; }
      par = 'systeme';
    }

    if (R.status !== 'signed') {
      res.status(409).json({ ok: false, error: 'not_signed_yet' });
      return;
    }

    /* Déjà envoyée : on répond sans rien refaire. Un rechargement de la page
       de fin ne doit pas expédier le contrat une deuxième fois. Seule l'équipe
       peut passer outre, et seulement en le demandant explicitement. */
    const force = equipe && body.force === true;
    if (R.copieEnvoyeeAt && !force) {
      res.status(200).json({ ok: true, already: true, sentTo: R.copieEnvoyeeA || null });
      return;
    }

    const to = emailDuClient(R);
    if (!to || to.indexOf('@') < 0) {
      console.error('[signature-completed] aucune adresse sur la demande', requestId);
      res.status(400).json({ ok: false, error: 'no_client_email' });
      return;
    }

    const b64 = await lirePdfSigne(reqRef, R);
    if (!b64) {
      console.error('[signature-completed] PDF signé introuvable', requestId);
      res.status(409).json({ ok: false, error: 'signed_pdf_missing' });
      return;
    }

    const nomDoc = R.templateName || 'Contrat';
    const fichier = safeFilename(nomDoc + ' - ' + (R.clientName || 'client')) + '.pdf';
    const account = ACCOUNTS[R.sendAccount] ? R.sendAccount : 'contact';

    const bodyText = [
      'Bonjour ' + (R.clientName || '') + ',',
      '',
      'Votre contrat « ' + nomDoc + ' » a bien été signé.',
      'Vous en trouverez la copie signée en pièce jointe de cet e-mail.',
      '',
      'Conservez-la : elle fait foi.',
      '',
      'Bien à vous,',
      'L\'équipe Ambitio',
    ].join('\n');

    const sent = await sendGmailWithAttachment({
      tokenAccount: account,
      fromName: 'Ambitio',
      to: [to],
      subject: 'Votre contrat signé — ' + nomDoc,
      bodyText,
      attachments: [{
        filename: fichier,
        contentBytes: Buffer.from(b64, 'base64'),
        contentType: 'application/pdf',
      }],
    });

    /* Trace sur la demande : sert de garde d'idempotence ET de preuve d'envoi
       dans la fiche signature. Le compteur dit combien de fois la copie est
       partie — un renvoi manuel ne doit pas effacer la trace du premier. */
    const envois = (Number(R.copieEnvoyeeCount) || (R.copieEnvoyeeAt ? 1 : 0)) + 1;
    await reqRef.set({
      copieEnvoyeeAt: admin.firestore.FieldValue.serverTimestamp(),
      copieEnvoyeeA: to,
      copieEnvoyeeCount: envois,
      copieEnvoyeePar: par,
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'copie_envoyee',
        date: new Date().toISOString(),
        to,
        by: par,
      }),
    }, { merge: true });

    console.log('[signature-completed] copie envoyée', requestId, '→', to,
      'par=' + par, 'envoi n°' + envois, 'msg=' + (sent && sent.messageId));
    res.status(200).json({ ok: true, sentTo: to, filename: fichier, envois });
  } catch (e) {
    console.error('[signature-completed]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
