// ============================================================================
// api/_blockedContacts.js
// ----------------------------------------------------------------------------
// LA BLACKLIST À L'ARRIVÉE DES MESSAGES, ET L'ARCHIVE DE L'INBOX.
//
// blocked_contacts (écrite par api/lead-block.js et api/inbox-spam.js) n'était
// lue qu'aux opt-in et à la prise de RDV. Un numéro bloqué continuait donc
// d'écrire : incident du 30/10/2026, bot +33652254334 bloqué depuis le 13/10,
// 8 notifications WhatsApp dans l'Inbox. Tout canal entrant passe maintenant
// par estBloque() : whatsapp-webhook, ringover-sms-inbound, twilio-sms-inbound,
// gmail-inbound-sync.
//
// ─── PANNE DE LECTURE = ON LAISSE PASSER ───────────────────────────────
// Même choix que lead-optin et alteoform-submit : perdre un vrai message
// coûterait plus cher qu'une notification de spam en trop.
//
// ─── RIEN N'EST EFFACÉ ─────────────────────────────────────────────────
// « Supprimer » une ligne de l'Inbox la déplace dans
// inbox_notifications_archive/{même id}, avec qui, quand et pourquoi. Le
// déplacement plutôt qu'un drapeau : aucun lecteur d'inbox_notifications
// (widget, lead-reply-watch) n'a à apprendre à filtrer, et la limite de
// 50 notifications chargées n'est pas mangée par des lignes cachées.
// Pas de règle Firestore pour l'archive : Admin SDK seulement.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { phoneNormalized } = require('./_leadLookup');

const ARCHIVE = 'inbox_notifications_archive';

function clePhone(raw) {
  const n = phoneNormalized(raw);
  return n ? 'phone:' + n.replace(/\//g, '_') : null;
}

function cleEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  return e ? 'email:' + e.replace(/\//g, '_') : null;
}

/* Renvoie la clé blacklistée, ou null. Ne lance jamais. */
async function estBloque(o) {
  const keys = [clePhone(o && o.phone), cleEmail(o && o.email)].filter(Boolean);
  if (!keys.length) return null;
  try {
    const snaps = await Promise.all(keys.map((k) => db.collection('blocked_contacts').doc(k).get()));
    for (let i = 0; i < snaps.length; i++) if (snaps[i].exists) return keys[i];
    return null;
  } catch (e) {
    console.warn('[blocked-contacts] blacklist injoignable, on laisse passer :', e && e.message);
    return null;
  }
}

/* Déplace des notifications (snapshots Firestore) vers l'archive. */
async function archiverNotifs(snaps, meta) {
  const now = admin.firestore.FieldValue.serverTimestamp();
  for (let i = 0; i < snaps.length; i += 200) {
    const batch = db.batch();
    snaps.slice(i, i + 200).forEach((s) => {
      batch.set(db.collection(ARCHIVE).doc(s.id), Object.assign({}, s.data(), {
        archivedAt: now,
        archivedReason: meta.reason,
        archivedBy: meta.uid || null,
        archivedByEmail: meta.email || null,
      }));
      batch.delete(s.ref);
    });
    await batch.commit();
  }
}

/* Message d'un contact bloqué : aucune notification, mais une trace, pour
   pouvoir relire ce qu'il a envoyé si le blocage était une erreur. */
async function tracerEntrantBloque(doc) {
  try {
    await db.collection(ARCHIVE).add(Object.assign({}, doc, {
      direction: 'inbound',
      archivedAt: admin.firestore.FieldValue.serverTimestamp(),
      archivedReason: 'contact_bloque',
    }));
  } catch (e) {
    console.warn('[blocked-contacts] trace', e && e.message);
  }
}

module.exports = { clePhone, cleEmail, estBloque, archiverNotifs, tracerEntrantBloque };
