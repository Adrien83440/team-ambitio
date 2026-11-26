// api/ringover-sms-inbound.js  (v5 — écritures avant res.end + logs granulaires)
const { db, admin } = require('./_firebaseAdmin');
const { ringoverFetch } = require('./_ringoverClient');
const { phoneNormalized, telVariants } = require('./_leadLookup');
const { estBloque, tracerEntrantBloque } = require('./_blockedContacts');

const OPT_OUT = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);

function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (/^\d{10,}$/.test(c)) return '+' + c;
  return null;
}

// Clés de recherche du lead, de la plus fiable à la plus laxiste :
// phoneNormalized (9 derniers chiffres), puis les écritures historiques du
// champ `telephone` (E.164, 0X, 33X, « 06 81 54 38 72 », « 06.81.54.38.72 »,
// 9 chiffres nus). Les fiches anciennes stockent le numéro avec des espaces :
// une recherche limitée aux formes compactes les ratait (SMS classé
// « Numéro inconnu » alors que la fiche existe — cas Céline du 21/10/2026).
function phoneLookups(e164) {
  if (!e164) return [];
  const out = [];
  const norm = phoneNormalized(e164);
  if (norm && norm.length === 9) out.push(['phoneNormalized', norm]);
  const tels = telVariants(e164);
  if (/^\+33\d{9}$/.test(e164)) tels.push(e164.slice(3));
  tels.forEach(v => out.push(['telephone', v]));
  return out;
}

// Retire le préfixe « Message: » / « Message : » que Ringover place parfois en
// tête du corps SMS (artefact du payload, absent du SMS réel). On ne touche
// qu'au tout début de la chaîne et on préserve le reste tel quel.
function cleanSmsText(raw) {
  if (!raw) return '';
  return String(raw).replace(/^\s*message\s*:\s*/i, '').trim();
}

// Idempotence : un même SMS peut arriver deux fois — par un second webhook
// Ringover (même providerMessageId), ou par le scénario Make, qui le trace sur
// la fiche via la Cloud Function onWebhookInbox (sans providerMessageId).
//
// Trois états (26/11/2026) :
//   'doublon'     — ce SMS a déjà été traité PAR CETTE ROUTE (même
//                   providerMessageId sur la fiche ou sur une notification) :
//                   on sort, rien à refaire.
//   'fiche_seule' — Make l'a déjà écrit sur la fiche (même texte entrant, à
//                   moins de 10 min, SANS providerMessageId). Make ne crée ni
//                   notification ni arrêt de relance : on n'écrit pas la fiche
//                   une seconde fois, mais la cloche et le reste se font.
//                   Avant, ce cas sortait comme un doublon complet : quand Make
//                   passait le premier, la réponse du prospect n'apparaissait
//                   dans aucune Inbox (cas du 26/11/2026, 08:10).
//   'nouveau'     — tout est à faire.
function smsNorm(t) {
  return String(t || '').replace(/^\s*message\s*:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function etatSurFiche(msgId, lead, text, nowMs) {
  const comms = (lead && Array.isArray(lead.communications)) ? lead.communications : [];
  const pid = msgId ? String(msgId) : '';
  if (pid && comms.some(c => c && String(c.providerMessageId || '') === pid)) return 'doublon';
  const k = smsNorm(text);
  if (!k) return 'nouveau';
  const now = nowMs || Date.now();
  const memes = comms.filter(c => c && c.type === 'sms' && /^(in|entr)/.test(String(c.direction || '').toLowerCase()) &&
    smsNorm(c.content) === k && Math.abs(now - (Date.parse(c.date || '') || 0)) < 10 * 60000);
  if (!memes.length) return 'nouveau';
  // Sans identifiant fiable, on ne sait pas distinguer un second webhook d'une
  // trace de Make : comportement d'avant, doublon complet.
  if (!pid) return 'doublon';
  // Trace sans identifiant = écrite par Make. Une trace portant un AUTRE
  // identifiant est un autre SMS (le prospect a écrit deux fois la même chose).
  return memes.some(c => !String(c.providerMessageId || '')) ? 'fiche_seule' : 'nouveau';
}

async function etatSms(msgId, lead, text) {
  const etat = etatSurFiche(msgId, lead, text);
  if (etat === 'doublon' || !msgId) return etat;
  try {
    const dup = await db.collection('inbox_notifications')
      .where('providerMessageId', '==', String(msgId))
      .limit(1).get();
    if (!dup.empty) return 'doublon';
  } catch (e) {
    console.warn('[sms-inbound] etatSms check error:', e.message);
  }
  return etat;
}

async function findLead(fromNumber) {
  for (const [field, value] of phoneLookups(fromNumber)) {
    try {
      const q = await db.collection('leads').where(field, '==', value).limit(3).get();
      if (q.empty) continue;
      const docs = q.docs.map(d => ({ id: d.id, ...d.data() })).filter(d => !d._merged);
      if (!docs.length) continue;
      docs.sort((a, b) => (b.updatedAt?.toMillis?.() || 0) - (a.updatedAt?.toMillis?.() || 0));
      return docs[0];
    } catch (e) {
      console.warn('[sms-inbound] findLead error:', e.code || e.message);
    }
  }
  return null;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).end();

  // NE PAS répondre immédiatement — faire les écritures Firestore d'abord
  // Ringover attend 200 mais tolère quelques secondes de délai

  try {
    const payload = req.body || {};
    console.log('[sms-inbound] payload reçu, event:', payload.event);

    const event = (payload.event || '').toLowerCase();
    const d     = payload.data || {};
    const dir   = (d.direction || '').toLowerCase();

    if (event === 'sent' || dir === 'outbound') {
      res.status(200).end();
      return;
    }

    // Extraire les champs
    let fromRaw = d.from_number || null;
    let toRaw   = d.to_number   || null;
    let text    = (d.body || d.content || d.text || '').trim();
    const convId  = d.conversation_id || null;
    const msgId   = d.message_id || null;
    const msgTime = d.time || null;

    // Fallback API si body manquant
    if (!text && convId) {
      console.log('[sms-inbound] body absent, fetch API conv:', convId);
      try {
        const resp = await ringoverFetch(`/conversations/${convId}/messages?limit_count=5`);
        const arr  = Array.isArray(resp) ? resp : (resp?.message_list || resp?.list || []);
        const msg  = arr[0];
        if (msg) {
          text    = (msg.body || msg.content || '').trim();
          if (!fromRaw) fromRaw = msg.from_number;
          if (!toRaw)   toRaw   = msg.to_number;
        }
      } catch (e) { console.warn('[sms-inbound] fetch conv error:', e.message); }
    }

    const fromNumber = normalizeE164(fromRaw);
    const toNumber   = normalizeE164(toRaw);

    if (!fromNumber || !text) {
      console.warn('[sms-inbound] Manquant — from:', fromRaw, 'text:', text);
      res.status(200).end();
      return;
    }

    // Nettoyage du préfixe « Message: » avant tout stockage/affichage.
    text = cleanSmsText(text);
    if (!text) { res.status(200).end(); return; }

    console.log('[sms-inbound] from:', fromNumber, 'to:', toNumber, 'body:', text.substring(0,40));

    if (OPT_OUT.has(text.toLowerCase())) {
      const lead = await findLead(fromNumber).catch(() => null);
      if (lead) {
        await db.collection('leads').doc(lead.id).update({
          smsOptOut: true, smsOptOutAt: admin.firestore.FieldValue.serverTimestamp(),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }).catch(() => {});
        /* Relances : exclusion définitive + séquence arrêtée. */
        await require('./_relances-hooks').surEntrant({ leadId: lead.id, canal: 'sms', texte: text, cle: String(msgId || '') });
      }
      res.status(200).end();
      return;
    }

    // Contact blacklisté : trace seulement, ni fiche ni notification.
    if (await estBloque({ phone: fromNumber })) {
      console.log('[sms-inbound] contact bloqué, ignoré :', fromNumber);
      await tracerEntrantBloque({
        type: 'sms', fromNumber, toNumber: toNumber || null, preview: text.substring(0, 200),
        source: 'ringover', providerMessageId: String(msgId || ''), createdAt: new Date(),
      });
      res.status(200).end();
      return;
    }

    // ── Trouver le lead ────────────────────────────────────────────────────
    console.log('[sms-inbound] findLead...');
    const lead = await findLead(fromNumber).catch(() => null);
    console.log('[sms-inbound] lead:', lead?.id || 'null');

    // Idempotence : si ce SMS (providerMessageId) a déjà été enregistré, on sort
    // sans dupliquer ni en base lead ni en notification inbox.
    const etat = await etatSms(msgId, lead, text);
    if (etat === 'doublon') {
      console.log('[sms-inbound] duplicate ignored, msgId:', String(msgId || ''));
      res.status(200).end();
      return;
    }
    if (etat === 'fiche_seule') {
      console.log('[sms-inbound] déjà sur la fiche (Make) — notification seule, msgId:', String(msgId || ''));
    }

    // ── Trouver ownerUid ───────────────────────────────────────────────────
    let ownerUid = null;
    if (toNumber) {
      try {
        const numSnap = await db.collection('phone_numbers')
          .where('phoneNumber', '==', toNumber).where('active', '==', true).limit(1).get();
        if (!numSnap.empty) ownerUid = numSnap.docs[0].data().assignedTo || null;
        console.log('[sms-inbound] ownerUid:', ownerUid);
      } catch (e) { console.warn('[sms-inbound] ownerUid error:', e.message); }
    }

    const now     = admin.firestore.FieldValue.serverTimestamp();
    const smsDate = (msgTime && msgTime > 0) ? new Date(msgTime * 1000) : new Date();
    const nowIso  = smsDate.toISOString();
    const pad     = n => String(n).padStart(2, '0');
    const tlDate  = smsDate.toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });

    // ── Écrire dans leads ──────────────────────────────────────────────────
    if (lead && etat !== 'fiche_seule') {
      try {
        await db.collection('leads').doc(lead.id).update({
          communications:   admin.firestore.FieldValue.arrayUnion({
            type: 'sms', direction: 'inbound', content: text, source: 'ringover-sms',
            date: nowIso, createdAt: nowIso, fromNumber, toNumber: toNumber || null,
            providerMessageId: String(msgId || ''),
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '💬 SMS entrant (ringover) — ' + text.substring(0,100),
            date: tlDate, color: '#60a5fa',
          }),
          lastContactAt: now, lastContactType: 'sms', updatedAt: now,
        });
        console.log('[sms-inbound] lead updated');
      } catch (e) { console.warn('[sms-inbound] lead update error:', e.message); }
    }

    // ── Créer notification inbox ────────────────────────────────────────────
    console.log('[sms-inbound] creating notification...');
    try {
      const docRef = await db.collection('inbox_notifications').add({
        type: 'sms', direction: 'inbound',
        fromNumber, toNumber: toNumber || null,
        text, content: text,
        leadId:   lead?.id   || null,
        leadName: lead ? (lead.nom || lead.fullName || null) : null,
        ownerUid, source: 'ringover',
        providerMessageId: String(msgId || ''),
        read: false, createdAt: now,
      });
      console.log('[sms-inbound] ✓ notification created:', docRef.id);
    } catch (e) {
      console.error('[sms-inbound] notification ERROR:', e.code, e.message);
    }

    /* Relances : réponse d'un lead en séquence → arrêt + setter prévenu. */
    if (lead) {
      await require('./_relances-hooks').surEntrant({
        leadId: lead.id, canal: 'sms', texte: text, fromNumber: fromNumber,
        leadName: lead.nom || null, dejaNotifieUid: ownerUid || null, cle: String(msgId || ''),
      });
    }

    res.status(200).end();

  } catch (err) {
    console.error('[sms-inbound] FATAL:', err.message);
    res.status(200).end(); // toujours 200 pour Ringover
  }
};

/* Exposé pour les essais : la décision, sans réseau ni base. */
module.exports._etatSurFiche = etatSurFiche;
