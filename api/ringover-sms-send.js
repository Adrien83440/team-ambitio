// api/ringover-sms-send.js  (v2 — endpoint /push/sms correct)
const { db, admin } = require('./_firebaseAdmin');
const { requireAuth }  = require('./_verifyFirebaseAuth');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');
const parseBody = require('./_parseBody');

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (c.startsWith('33') && c.length >= 11) return '+' + c;
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') return res.status(403).json({ error: 'Rôle requis' });

  const body = parseBody(req);
  const { leadId, message, to } = body;
  if (!message || !String(message).trim()) return res.status(400).json({ error: 'message requis (string)' });
  const trimmed = String(message).trim();

  try {
    let lead = null;
    let toNumber = null;

    // Cas 1 : leadId fourni → récupérer le numéro du lead
    if (leadId) {
      const leadSnap = await db.collection('leads').doc(leadId).get();
      if (leadSnap.exists) {
        lead = leadSnap.data();
        toNumber = normalizeE164(lead.telephone);
      }
    }

    // Cas 2 : pas de lead → utiliser le numéro "to" passé directement (réponse rapide depuis cloche)
    if (!toNumber && to) {
      toNumber = normalizeE164(to);
    }

    if (!toNumber) return res.status(400).json({ error: 'Numéro destinataire manquant ou invalide' });

    const creds = await getRingoverCreds();

    /* ── Numéro expéditeur : celui de l'AUTEUR s'il en a un ────────────────
       Chaque commercial a sa propre ligne Ringover, déclarée dans
       phone_numbers (admin-numbers.html). Envoyer depuis sa ligne, et non
       depuis la ligne partagée, est ce qui permet au prospect de répondre à
       la bonne personne : api/ringover-sms-inbound.js retrouve le
       destinataire d'un SMS entrant par le numéro appelé.
       Repli sur la ligne partagée si l'auteur n'a pas encore de ligne. */
    let fromNumber = null;
    try {
      const numSnap = await db.collection('phone_numbers')
        .where('assignedTo', '==', auth.uid)
        .where('provider', '==', 'ringover')
        .where('active', '==', true)
        .limit(1).get();
      if (!numSnap.empty) fromNumber = numSnap.docs[0].data().phoneNumber || null;
    } catch (e) {
      console.warn('[ringover-sms-send] lookup ligne:', e.message);
    }
    fromNumber = fromNumber || creds.fromNumber; // E.164 string : "+33755546371"
    if (!fromNumber) return res.status(500).json({ error: 'ringover.fromNumber manquant' });

    // Nom + slug expéditeur (non-bloquant)
    let ownerName = null;
    let ownerSlug = null;
    try {
      const metaSnap = await db.collection('_meta').doc('team_members').get();
      if (metaSnap.exists) {
        const raw = metaSnap.data().members;
        const list = Array.isArray(raw) ? raw : Object.values(raw || {});
        const me = list.find(m => m && m.firebaseUid === auth.uid);
        if (me) {
          ownerName = me.shortName || me.displayName || me.fullName || null;
          ownerSlug = me.slug || null;
        }
      }
    } catch (_) {}

    // POST /push/sms — champs E.164 strings, body.content (pas text)
    let resp;
    try {
      resp = await ringoverFetch('/push/sms', {
        method: 'POST',
        body: {
          from_number: fromNumber,  // E.164 string "+33..."
          to_number:   toNumber,    // E.164 string "+33..."
          content:     trimmed,     // champ "content" (pas "text")
        },
      });
      console.log('[ringover-sms-send] sent:', JSON.stringify(resp));
    } catch (e) {
      console.error('[ringover-sms-send] Ringover error:', e.message, e.rawResponse);
      return res.status(502).json({ error: e.message });
    }

    const now    = admin.firestore.FieldValue.serverTimestamp();
    const smsDate = new Date();
    const nowIso  = smsDate.toISOString();
    const pad     = n => String(n).padStart(2, '0');
    const tlDate  = `${pad(smsDate.getDate())}/${pad(smsDate.getMonth()+1)}/${smsDate.getFullYear()} ${pad(smsDate.getHours())}:${pad(smsDate.getMinutes())}`;

    if (leadId && lead) await db.collection('leads').doc(leadId).update({
      communications: admin.firestore.FieldValue.arrayUnion({
        type: 'sms', direction: 'outbound', content: trimmed,
        source: 'ringover-sms', date: nowIso, createdAt: nowIso,
        ownerUid: auth.uid, ownerName: ownerName || auth.email, ownerSlug: ownerSlug || null,
        providerMessageId: String(resp?.message_id || ''),
        fromNumber, toNumber,
      }),
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: '💬 SMS sortant (ringover) — ' + trimmed.substring(0,100),
        date: tlDate, color: '#60a5fa',
      }),
      lastContactAt: now, lastContactType: 'sms', updatedAt: now,
    });

    res.status(200).json({ ok: true, messageId: resp?.message_id || null, from: fromNumber, to: toNumber });
  } catch (err) {
    console.error('[ringover-sms-send] error:', err.message);
    res.status(500).json({ error: err.message });
  }
};
