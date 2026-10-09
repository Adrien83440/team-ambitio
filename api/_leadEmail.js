// ============================================================================
// api/_leadEmail.js — envoi d'un email à un prospect, APRÈS validation humaine
// ----------------------------------------------------------------------------
// Utilisé par les fonctions IA qui proposent des emails (assistant de messages
// de Leads Live, relances des non-closés). N'est appelé qu'au clic « Envoyer »
// d'un membre de l'équipe — jamais automatiquement.
// Compte Gmail d'envoi : _config/ai.followupEmailAccount ('strategie' par
// défaut, cf. api/_gmailSend.js). L'envoi est tracé dans leads.communications
// et leads.timeline_history.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');
const { getAiConfig } = require('./_ai');

function textToHtml(t) {
  return String(t || '').split(/\n\s*\n/).map(function (p) {
    return '<p>' + p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br/>') + '</p>';
  }).join('');
}

async function memberOf(uid) {
  try {
    const metaSnap = await db.collection('_meta').doc('team_members').get();
    const raw = metaSnap.exists ? metaSnap.data().members : null;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const me = list.find(function (m) { return m && m.firebaseUid === uid; });
    if (me) return { name: me.shortName || me.displayName || me.fullName || null, slug: me.slug || null };
  } catch (e) { /* non bloquant */ }
  return { name: null, slug: null };
}

/**
 * @param {Object} auth   requireAuth()
 * @param {string} leadId
 * @param {string} subject
 * @param {string} bodyText texte brut, paragraphes séparés par une ligne vide
 * @param {Object} [opts] { label: libellé timeline, flag: champ booléen posé sur la communication }
 */
async function sendLeadEmail(auth, leadId, subject, bodyText, opts) {
  opts = opts || {};
  const ref = db.collection('leads').doc(leadId);
  const s = await ref.get();
  if (!s.exists) throw new Error('Fiche prospect introuvable');
  const lead = s.data() || {};
  const to = String(lead.email || '').trim();
  if (!to || to.indexOf('@') < 0) throw new Error('Email du prospect manquant');
  const cfg = await getAiConfig();
  const accountKey = cfg.followupEmailAccount || 'strategie';
  const r = await sendEmailFromAccount({ accountKey: accountKey, to: to, subject: subject, bodyHtml: textToHtml(bodyText), bodyText: bodyText });
  if (!r || !r.ok) throw new Error((r && r.error) || 'Envoi email impossible');
  const me = await memberOf(auth.uid);
  const nowIso = new Date().toISOString();
  const comm = {
    type: 'email', direction: 'outbound', content: subject + '\n\n' + bodyText, source: 'gmail-' + accountKey,
    date: nowIso, createdAt: nowIso, ownerUid: auth.uid, ownerName: me.name || auth.email, ownerSlug: me.slug || null,
  };
  if (opts.flag) comm[opts.flag] = true;
  await ref.update({
    communications: admin.firestore.FieldValue.arrayUnion(comm),
    timeline_history: admin.firestore.FieldValue.arrayUnion({
      text: (opts.label || '✉️ Email envoyé') + ' — ' + subject.substring(0, 100),
      date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#f59e0b',
    }),
    lastContactAt: admin.firestore.FieldValue.serverTimestamp(), lastContactType: 'email',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true, from: r.from || null };
}

module.exports = { sendLeadEmail: sendLeadEmail, textToHtml: textToHtml };
