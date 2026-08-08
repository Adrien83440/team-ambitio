// ============================================================================
// api/signature-send-link.js — ENVOI DU LIEN DE SIGNATURE (email + SMS)
// ----------------------------------------------------------------------------
// POST /api/signature-send-link
//   { requestId, signerIndex?, token? }
//   → 200 { ok:true, email:{envoye,dest}, sms:{envoye,dest,sid,erreur} }
//
// POURQUOI CET ENDPOINT
// ---------------------
// TROIS chemins déposaient un document webhook_inbox { action:'signature_resend' }
// en comptant sur la Cloud Function onWebhookInbox :
//   · sales-signatures.html — l'envoi initial du contrat au client ;
//   · sales-signatures.html — le bouton « Renvoyer » ;
//   · sign.html            — la notification du 2e signataire.
// Cette fonction a été redéployée sans ses handlers signature. Les documents
// sont toujours écrits, plus personne ne les lit : le client ne recevait donc
// JAMAIS son lien de signature, et l'écran affichait « ✅ Email + SMS
// renvoyés ». C'est la même panne que le code SMS et que la copie du contrat
// signé — même cause, même remède : le traitement revient sur Vercel, qui
// déploie depuis git.
//
// DEUX PORTES D'ENTRÉE, TOUTES DEUX VÉRIFIÉES
//   · l'équipe (sales-signatures) présente un jeton Firebase ;
//   · la page de signature publique présente le token de la demande — le
//     signataire 1 n'a pas de compte, mais il vient de signer et son token
//     prouve qu'il est bien sur ce dossier.
// Aucune des deux ne permet de choisir le destinataire : numéros et adresses
// viennent TOUJOURS du document Firestore.
//
// EMAIL ET SMS SONT INDÉPENDANTS
// Un SMS qui échoue ne doit pas empêcher l'email de partir — c'est justement
// le canal qui fonctionne pendant que la remise SMS est en panne côté
// opérateur. La réponse dit ce qui est parti et ce qui ne l'est pas, et
// l'appelant l'affiche : plus de « ✅ envoyé » qui ment.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { verifyFirebaseAuth } = require('./_verifyFirebaseAuth');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');

const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

/* Même normalisation que api/signature-otp.js (E.164, France par défaut). */
function normalizePhone(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/[\s\-().]/g, '');
  if (cleaned.startsWith('+')) return cleaned;
  if (cleaned.startsWith('00')) return '+' + cleaned.slice(2);
  if (cleaned.startsWith('0') && cleaned.length === 10) return '+33' + cleaned.slice(1);
  if (cleaned.startsWith('33') && cleaned.length >= 11) return '+' + cleaned;
  return null;
}

function tokenMatches(R, token) {
  if (!token) return false;
  if (R.token && R.token === token) return true;
  if (Array.isArray(R.signers)) return R.signers.some((s) => s && s.token && s.token === token);
  return false;
}

/* Le signataire visé, et son token — c'est LUI qui ouvre le bon document. */
function signataire(R, index) {
  const s = Array.isArray(R.signers) ? R.signers : [];
  const i = Number.isInteger(index) ? index : (R.currentSigner || 0);
  if (s[i]) return { i, ...s[i] };
  if (s.length) return { i: 0, ...s[0] };
  /* Ancien modèle : pas de tableau signers, tout est à la racine. */
  return { i: 0, name: R.clientName, email: R.clientEmail, phone: R.clientPhone, token: R.token };
}

function origineDe(req) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return 'https://' + host;
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
  const signerIndex = Number.isInteger(body.signerIndex) ? body.signerIndex : null;
  if (!requestId) { res.status(400).json({ ok: false, error: 'requestId_required' }); return; }

  try {
    const reqRef = db.collection('signature_requests').doc(requestId);
    const snap = await reqRef.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'request_not_found' }); return; }
    const R = snap.data() || {};
    if (R.status === 'cancelled') { res.status(409).json({ ok: false, error: 'request_cancelled' }); return; }

    /* Porte 1 : l'équipe, avec un jeton Firebase. Porte 2 : le token de la
       demande. L'une des deux suffit, aucune n'est facultative. */
    let par = null;
    try {
      const auth = await verifyFirebaseAuth(req);
      par = auth && auth.email ? auth.email : 'equipe';
    } catch (e) { /* pas de jeton : on tente le token de la demande */ }
    if (!par) {
      if (!tokenMatches(R, token)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      par = 'page_signature';
    }

    const S = signataire(R, signerIndex);
    if (!S.token) {
      console.error('[signature-send-link] signataire sans token', requestId, S.i);
      res.status(409).json({ ok: false, error: 'signer_token_missing' });
      return;
    }

    const lien = origineDe(req) + '/sign.html?t=' + encodeURIComponent(S.token);
    const nomDoc = R.templateName || 'votre contrat';
    const prenom = String(S.name || R.clientName || '').split(' ')[0] || '';
    const perso = String(R.message || '').trim();

    /* ── EMAIL ─────────────────────────────────────────────────────────── */
    const dest = String(S.email || '').trim();
    const email = { envoye: false, dest: dest || null, erreur: null };
    if (dest && dest.indexOf('@') > 0) {
      try {
        const account = ACCOUNTS[R.sendAccount] ? R.sendAccount : 'contact';
        await sendGmailWithAttachment({
          tokenAccount: account,
          fromName: 'Ambitio',
          to: [dest],
          subject: 'À signer — ' + nomDoc,
          bodyText: [
            'Bonjour ' + prenom + ',',
            '',
            perso ? perso + '\n' : '',
            'Votre document « ' + nomDoc + ' » est prêt à être signé.',
            'Ouvrez ce lien pour le lire et le signer :',
            lien,
            '',
            'Ce lien vous est personnel : ne le transmettez pas.',
            '',
            'Bien à vous,',
            'L\'équipe Ambitio',
          ].filter((l) => l !== '').join('\n'),
        });
        email.envoye = true;
      } catch (e) {
        email.erreur = (e && e.message) || 'echec';
        console.error('[signature-send-link] email', requestId, e && e.message);
      }
    } else {
      email.erreur = 'aucune adresse sur la demande';
    }

    /* ── SMS ───────────────────────────────────────────────────────────── */
    const to = normalizePhone(S.phone);
    const sms = { envoye: false, dest: to || null, sid: null, erreur: null };
    if (to) {
      try {
        const creds = await getTwilioCreds();
        const from = creds.smsFromNumber || creds.smsFrom || null;
        if (!from) throw new Error('smsFromNumber absent de _config/telco_credentials.twilio');
        const client = await getTwilioClient();
        /* statusCallback : la remise SMS est suivie ici comme pour le code de
           signature. Sans lui, un message filtré par l'opérateur resterait
           invisible — c'est exactement ce qui a masqué la panne du code. */
        const msg = await client.messages.create({
          from,
          to,
          body: 'Bonjour ' + prenom + ', votre document « ' + nomDoc + ' » est à signer ici : ' + lien,
          statusCallback: origineDe(req) + '/api/twilio-sms-status?reqId=' + encodeURIComponent(requestId),
        });
        sms.envoye = true;
        sms.sid = msg && msg.sid;
      } catch (e) {
        sms.erreur = (e && e.message) || 'echec';
        console.error('[signature-send-link] sms', requestId, e && e.message, e && e.code);
      }
    } else {
      sms.erreur = 'aucun numéro valide sur la demande';
    }

    /* Trace : qui a envoyé quoi, et ce qui a échoué. */
    await reqRef.set({
      dernierEnvoi: {
        at: Date.now(), par, signerIndex: S.i,
        email: { envoye: email.envoye, dest: email.dest, erreur: email.erreur },
        sms: { envoye: sms.envoye, dest: sms.dest, sid: sms.sid, erreur: sms.erreur },
      },
      events: admin.firestore.FieldValue.arrayUnion({
        type: 'lien_envoye',
        date: new Date().toISOString(),
        by: par,
        canaux: (email.envoye ? 'email ' : '') + (sms.envoye ? 'sms' : ''),
      }),
    }, { merge: true }).catch((e) => console.warn('[signature-send-link] trace:', e && e.message));

    console.log('[signature-send-link]', requestId, 'signataire=' + S.i,
      'email=' + email.envoye, 'sms=' + sms.envoye, 'sid=' + sms.sid);

    /* On répond 200 même si un canal a échoué : l'autre est peut-être passé,
       et l'appelant doit pouvoir le dire précisément. 502 seulement si RIEN
       n'est parti — là, il n'y a vraiment rien à annoncer au client. */
    if (!email.envoye && !sms.envoye) {
      res.status(502).json({ ok: false, error: 'aucun_canal', email, sms });
      return;
    }
    res.status(200).json({ ok: true, email, sms });
  } catch (e) {
    console.error('[signature-send-link]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
