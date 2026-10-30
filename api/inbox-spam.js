// ============================================================================
// api/inbox-spam.js
// ----------------------------------------------------------------------------
// BLOQUER / SUPPRIMER UNE CONVERSATION DEPUIS L'INBOX (inbox-widget.js).
//
// URL  : POST https://team.alteore.com/api/inbox-spam
// Auth : Bearer ID token Firebase.
// Body : { action:'delete'|'block', notifIds:[id, …] }
//        notifIds[0] = le message affiché : c'est son expéditeur qu'on bloque.
//
// Droits : ceux de la lecture de l'Inbox — un admin agit sur tout, un sales sur
// ses propres notifications. Les ids hors de son périmètre sont ignorés.
//
// delete : les notifications passent dans l'archive (api/_blockedContacts.js).
//          La fiche et son historique ne bougent pas.
// block  : UNE valeur blacklistée (le numéro, ou l'e-mail pour un e-mail), comme
//          lead-block. Avec une fiche : même effet qu'en Leads Live (poubelle,
//          RDV à venir annulés). Toutes les notifications de cet expéditeur
//          sont archivées, y compris celles qui ne sont pas chargées à l'écran.
//
// Réponses
//   200 { ok:true, archived:[ids], key?, bookingsCancelled?, warnings? }
//   400 { ok:false, error }   403 { ok:false, error:'forbidden' }
//   409 { ok:false, error:'lead_is_client' | 'no_contact' }
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { phoneNormalized } = require('./_leadLookup');
const { clePhone, cleEmail, archiverNotifs } = require('./_blockedContacts');
const { appliquerBlocage } = require('./lead-block');

const MAX_IDS = 100;
const REASON = 'Spam (Inbox)';

function cibleDe(n) {
  const key = clePhone(n.fromNumber);
  if (key) return { key: key, type: 'phone', value: phoneNormalized(n.fromNumber) };
  const em = cleEmail(n.fromEmail);
  if (em) return { key: em, type: 'email', value: String(n.fromEmail).trim().toLowerCase() };
  return null;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;

  let body;
  try { body = await parseBody(req); } catch (e) { body = null; }
  const action = body && (body.action === 'delete' || body.action === 'block') ? body.action : null;
  const ids = (body && Array.isArray(body.notifIds) ? body.notifIds : [])
    .filter((x) => typeof x === 'string' && x && x.indexOf('/') < 0)
    .slice(0, MAX_IDS);

  if (!action || !ids.length) {
    res.status(400).json({ ok: false, error: 'bad_request' });
    return;
  }

  try {
    const snaps = await db.getAll.apply(db, ids.map((id) => db.collection('inbox_notifications').doc(id)));
    const existants = snaps.filter((s) => s.exists);
    /* Déjà archivées (double clic, autre admin) : rien à faire. */
    if (!existants.length) {
      res.status(200).json({ ok: true, archived: [] });
      return;
    }
    const miens = existants.filter((s) => auth.role === 'admin' || (s.data() || {}).ownerUid === auth.uid);
    if (!miens.length) {
      res.status(403).json({ ok: false, error: 'forbidden' });
      return;
    }

    const meta = { reason: action === 'block' ? 'bloque' : 'supprime', uid: auth.uid, email: auth.email };
    const aArchiver = {};
    miens.forEach((s) => { aArchiver[s.id] = s; });
    let cancelled = { bookings: [], warnings: [] };
    let t = null;

    if (action === 'block') {
      const rep = miens.find((s) => cibleDe(s.data() || {}));
      t = rep ? cibleDe(rep.data()) : null;
      if (!t) {
        res.status(409).json({ ok: false, error: 'no_contact' });
        return;
      }
      const n = rep.data();
      const leadSnap = n.leadId ? await db.collection('leads').doc(String(n.leadId)).get() : null;
      const lead = leadSnap && leadSnap.exists ? (leadSnap.data() || {}) : null;

      /* Depuis une fiche, le blocage d'un client passe par un geste réfléchi.
         Ici il suffit d'un clic sur une notification : on refuse. */
      if (lead && (lead.status === 'client' || lead.isCoaching === true)) {
        res.status(409).json({ ok: false, error: 'lead_is_client' });
        return;
      }

      if (lead) {
        cancelled = await appliquerBlocage({ lead: lead, leadId: leadSnap.id, t: t, action: 'block', reason: REASON, auth: auth });
      } else {
        await db.collection('blocked_contacts').doc(t.key).set({
          type: t.type,
          value: t.value,
          reason: REASON,
          leadId: null,
          leadName: n.leadName || null,
          by: auth.uid || null,
          byEmail: auth.email || null,
          at: admin.firestore.FieldValue.serverTimestamp(),
        }, { merge: true });
      }

      const champ = t.type === 'phone' ? 'fromNumber' : 'fromEmail';
      const memes = await db.collection('inbox_notifications').where(champ, '==', n[champ]).limit(300).get();
      memes.docs.forEach((s) => { aArchiver[s.id] = s; });
    }

    const liste = Object.keys(aArchiver).map((k) => aArchiver[k]);
    await archiverNotifs(liste, meta);

    /* Trace d'audit — best-effort, l'action est déjà faite. */
    try {
      await db.collection('audit_log').add({
        type: 'inbox_spam',
        action: action,
        key: t ? t.key : null,
        notifs: liste.length,
        actorUid: auth.uid || null,
        actorEmail: auth.email || null,
        at: admin.firestore.FieldValue.serverTimestamp(),
      });
    } catch (e) {
      console.warn('[inbox-spam] audit_log:', e && e.message);
    }

    res.status(200).json({
      ok: true,
      archived: liste.map((s) => s.id),
      key: t ? t.key : null,
      bookingsCancelled: cancelled.bookings,
      warnings: cancelled.warnings,
    });
  } catch (e) {
    console.error('[inbox-spam]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
