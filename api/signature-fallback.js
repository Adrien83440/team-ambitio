// ============================================================================
// api/signature-fallback.js — ENVOI DE SECOURS D'UN CONTRAT
// ----------------------------------------------------------------------------
// POST /api/signature-fallback
//   { templateId, clientName, clientEmail, message? }
//   → 200 { ok:true, sentTo, filename }
//
// À QUOI ÇA SERT
// --------------
// Filet de secours quand la signature électronique ne passe pas (code SMS qui
// n'arrive pas, panne, client sans téléphone sous la main) : le closeur envoie
// le contrat en PDF par email, le client l'imprime, le signe et le renvoie.
// Aucune dépendance à la chaîne de signature : ni OTP, ni Cloud Function, ni
// document webhook_inbox. Un seul appel HTTP, une réponse immédiate.
//
// COUCHE ADDITIVE — cet endpoint ne modifie RIEN de l'existant :
//   - lecture seule sur signature_templates ;
//   - aucune écriture dans signature_requests ;
//   - la trace de l'envoi va dans signature_fallback_log, collection neuve.
// Le parcours de signature électronique n'est pas touché.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { sendGmailWithAttachment } = require('./_billing-gmail');
const parseBody = require('./_parseBody');

/* Comptes d'envoi autorisés — mêmes que le sélecteur « Compte d'envoi » des
   modèles. Tout autre valeur retombe sur contact@. */
const ACCOUNTS = { contact: 1, strategie: 1, coaching: 1 };

function safeFilename(s) {
  return String(s || 'contrat')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-zA-Z0-9 _-]/g, '')
    .trim().replace(/\s+/g, '_')
    .slice(0, 60) || 'contrat';
}

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/* Le PDF vit soit en clair sur le document (petit modèle), soit découpé en
   morceaux dans la sous-collection `pdf`. Même lecture que sales-signatures.html :
   pdfBase64 d'abord, morceaux ensuite. */
async function loadTemplatePdf(templateId) {
  const ref = db.collection('signature_templates').doc(templateId);
  const snap = await ref.get();
  if (!snap.exists) return { error: 'Modèle introuvable' };
  const T = snap.data() || {};

  let b64 = T.pdfBase64 || '';
  if (!b64) {
    const chunks = await ref.collection('pdf').orderBy('chunk').get();
    if (chunks.empty) return { error: 'Ce modèle n\'a pas de document PDF enregistré.' };
    const parts = [];
    chunks.forEach((d) => parts.push((d.data() || {}).data || ''));
    b64 = parts.join('');
  }
  const raw = b64.indexOf(',') >= 0 ? b64.split(',')[1] : b64;
  if (!raw) return { error: 'Document PDF illisible.' };
  return { name: T.name || 'Contrat', emailAccount: T.notifications && T.notifications.emailAccount, buffer: Buffer.from(raw, 'base64') };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin' && auth.role !== 'csm') {
    res.status(403).json({ error: 'Rôle sales, CSM ou admin requis' });
    return;
  }

  const body = parseBody(req) || {};
  const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
  const clientName = String(body.clientName || '').trim();
  const clientEmail = String(body.clientEmail || '').trim();
  const message = String(body.message || '').trim();

  if (!templateId) { res.status(400).json({ error: 'Choisissez un modèle.' }); return; }
  if (!clientName) { res.status(400).json({ error: 'Le nom du client est obligatoire.' }); return; }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clientEmail)) {
    res.status(400).json({ error: 'Email du client invalide.' });
    return;
  }

  try {
    const tpl = await loadTemplatePdf(templateId);
    if (tpl.error) { res.status(404).json({ error: tpl.error }); return; }

    const filename = safeFilename(tpl.name) + '.pdf';
    const account = ACCOUNTS[tpl.emailAccount] ? tpl.emailAccount : 'contact';
    const prenom = clientName.split(/\s+/)[0] || clientName;

    const intro = message
      || 'Vous trouverez votre contrat en pièce jointe.';

    const bodyText =
      'Bonjour ' + prenom + ',\n\n'
      + intro + '\n\n'
      + 'Pour finaliser :\n'
      + '1. Imprimez le document ci-joint.\n'
      + '2. Datez et signez la dernière page, en ajoutant la mention « Lu et approuvé ».\n'
      + '3. Renvoyez-le signé en réponse à cet email (une photo nette de chaque page suffit).\n\n'
      + 'Nous restons à votre disposition pour toute question.\n\n'
      + 'Bien à vous,\n'
      + 'L\'équipe Ambitio';

    const bodyHtml =
      '<div style="font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.6;color:#1a1a2e">'
      + '<p>Bonjour ' + esc(prenom) + ',</p>'
      + '<p>' + esc(intro).replace(/\n/g, '<br>') + '</p>'
      + '<p style="margin:18px 0 8px"><strong>Pour finaliser :</strong></p>'
      + '<ol style="margin:0 0 18px;padding-left:20px">'
      + '<li>Imprimez le document ci-joint.</li>'
      + '<li>Datez et signez la dernière page, en ajoutant la mention «&nbsp;Lu et approuvé&nbsp;».</li>'
      + '<li>Renvoyez-le signé en réponse à cet email (une photo nette de chaque page suffit).</li>'
      + '</ol>'
      + '<p>Nous restons à votre disposition pour toute question.</p>'
      + '<p style="margin-top:18px">Bien à vous,<br>L\'équipe Ambitio</p>'
      + '</div>';

    const sent = await sendGmailWithAttachment({
      tokenAccount: account,
      fromName: 'Ambitio',
      to: [clientEmail],
      subject: 'Votre contrat — ' + tpl.name,
      bodyText: bodyText,
      bodyHtml: bodyHtml,
      attachments: [{ filename: filename, contentBytes: tpl.buffer, contentType: 'application/pdf' }],
    });

    /* Trace dans une collection NEUVE : on ne touche pas signature_requests,
       dont dépend tout le parcours de signature électronique. */
    db.collection('signature_fallback_log').add({
      templateId, templateName: tpl.name,
      clientName, clientEmail,
      sentBy: auth.email || auth.uid || null,
      account,
      messageId: sent && sent.messageId ? sent.messageId : null,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    }).catch((e) => console.error('[signature-fallback] log:', e && e.message));

    res.status(200).json({ ok: true, sentTo: clientEmail, filename });
  } catch (e) {
    console.error('[signature-fallback]', e && e.stack ? e.stack : e);
    res.status(e && e.status === 401 ? 502 : 500).json({
      error: (e && e.message) ? ('Envoi impossible : ' + e.message) : 'Envoi impossible.',
    });
  }
};
