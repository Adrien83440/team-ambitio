// api/payments-send-mandate-sms.js  (v3 — endpoint /push/sms correct)
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
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') { res.status(403).json({ error: 'Rôle requis' }); return; }

  try {
    const { paymentId } = parseBody(req);
    if (!paymentId) { res.status(400).json({ error: 'paymentId requis' }); return; }

    const paySnap = await db.collection('payments').doc(paymentId).get();
    if (!paySnap.exists) { res.status(404).json({ error: 'Paiement introuvable' }); return; }
    const pay = paySnap.data();

    if (auth.role !== 'admin' && pay.createdBy !== auth.uid) { res.status(403).json({ error: 'Accès refusé' }); return; }
    if (!pay.gcBillingRequestFlowUrl) { res.status(400).json({ error: 'Aucun lien mandat généré' }); return; }

    const toNumber = normalizeE164(pay.leadPhone);
    if (!toNumber) { res.status(400).json({ error: 'Numéro invalide' }); return; }

    const creds = await getRingoverCreds();
    if (!creds.fromNumber) { res.status(500).json({ error: 'ringover.fromNumber manquant' }); return; }

    const firstName = String(pay.leadName || 'Bonjour').trim().split(/\s+/)[0];
    const content = `Bonjour ${firstName},\n\nPour finaliser votre prélèvement (${pay.description || 'Programme'}), renseignez votre IBAN ici :\n\n${pay.gcBillingRequestFlowUrl}\n\nL'équipe Ambitio`;

    let resp;
    try {
      resp = await ringoverFetch('/push/sms', {
        method: 'POST',
        body: { from_number: creds.fromNumber, to_number: toNumber, content },
      });
    } catch (e) {
      console.error('[payments-send-mandate-sms] Ringover error:', e.message);
      res.status(502).json({ error: e.message });
      return;
    }

    if (pay.leadId) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const nowIso = new Date().toISOString();
      const d = new Date();
      const pad = n => String(n).padStart(2, '0');
      const tlDate = `${pad(d.getDate())}/${pad(d.getMonth()+1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
      db.collection('leads').doc(pay.leadId).update({
        communications: admin.firestore.FieldValue.arrayUnion({
          type: 'sms', direction: 'outbound', content, source: 'ringover-sms',
          date: nowIso, createdAt: nowIso, ownerUid: auth.uid,
          fromNumber: creds.fromNumber, toNumber,
        }),
        timeline_history: admin.firestore.FieldValue.arrayUnion({
          text: '💬 SMS mandat envoyé', date: tlDate, color: '#60a5fa',
        }),
        lastContactAt: now, lastContactType: 'sms', updatedAt: now,
      }).catch(e => console.warn('[payments-mandate-sms] log lead:', e.message));
    }

    res.json({ ok: true, messageId: resp?.message_id || null, from: creds.fromNumber, to: toNumber });
  } catch (e) {
    console.error('[payments-send-mandate-sms]', e.message);
    res.status(500).json({ error: e.message });
  }
};
