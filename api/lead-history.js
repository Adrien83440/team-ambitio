// ============================================================================
// api/lead-history.js — COMPLÉMENTS DE L'HISTORIQUE D'UNE FICHE (Leads Live)
// ----------------------------------------------------------------------------
// Demande d'Adrien du 19/10/2026, écran « Historique » de la nouvelle vue
// Leads Live : sur chaque appel, déplier la conversation et écouter ; voir
// les SMS partis automatiquement ; voir les WhatsApp sans ouvrir la
// conversation.
//
// La fiche (leads/{id}.communications) ne suffit pas :
//   • les appels écrits par Make n'ont pas de lien vers call_logs (plus
//     personne ne pose callLogId) — l'enregistrement et la transcription
//     Ringover sont dans call_logs, retrouvés ici par leadId ET par numéro ;
//   • les SMS automatiques (rappels J-1 / H-1, confirmation, automatisations)
//     partent par Twilio et ne sont jamais écrits sur la fiche ;
//   • les WhatsApp vivent dans whatsapp_conversations/{n}/messages, et ceux
//     refusés ou en échec seulement dans le journal whatsapp_messages.
// Même lecture que Pilotage équipe (api/team-pilotage.js, action 'lead'),
// ouverte ici à l'équipe sales.
//
// POST Bearer <ID token> (admin / sales)   { leadId }
//   → { ok, leadId,
//       calls:    [{ id, atMs, direction 'in'|'out', durationSec, answered,
//                    userName, hasRecording, hasTranscript, summary,
//                    canListen }],
//       sms:      [{ sid, atMs, direction 'in'|'out', status, failed, body }],
//       smsError,
//       whatsapp: [{ id, atMs, direction 'in'|'out', texte, statut, bad,
//                    erreur, par }] }
//
// canListen reprend la règle de api/call-detail.js (et des rules call_logs) :
// admin, users/{uid}.canListenCalls, ou son propre appel. L'écoute elle-même
// passe toujours par /api/call-detail, qui revérifie.
//
// LECTURE SEULE. Aucune écriture, nulle part.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { toE164 } = require('./_leadLookup');

const ROLES = ['admin', 'sales'];
const MAX_CALLS = 120;
const MAX_WA = 150;
const TWILIO_TIMEOUT_MS = 8000;

const CALL_FIELDS = [
  'direction', 'status', 'leadId', 'fromNumber', 'toNumber', 'initiatedAt', 'answeredAt', 'endedAt',
  'durationSec', 'ringingDurationSec', 'userId', 'userName', 'ringoverUserName', 'provider',
  'recordingStatus', 'ringoverRecordingUrl', 'recordingStoragePath',
  'transcriptionStatus', 'transcribedAt', 'transcriptText', 'transcriptionText',
  'aiSummary', 'aiAnalysis.summary',
];

function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}
function cap(s, n) {
  s = String(s || '').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* Variantes du numéro telles qu'on les trouve dans call_logs. */
function phoneVariants(raw) {
  const e = toE164(raw);
  if (!/^\+\d{9,15}$/.test(e)) return [];
  const out = [e, e.slice(1)];
  if (/^\+33\d{9}$/.test(e)) out.push('0' + e.slice(3));
  return out;
}

async function loadMembers() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    return Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw).map(function (k) { return Object.assign({ slug: k }, raw[k]); }) : []);
  } catch (e) { return []; }
}
function memberByUid(list, uid) {
  for (let i = 0; i < list.length; i++) if (list[i] && list[i].firebaseUid === uid) return list[i];
  return null;
}
function memberName(m) { return m ? (m.shortName || m.displayName || m.slug || '') : ''; }

/* Doublons : le dialer crée un doc au lancement, Ringover un autre à la fin ;
   l'un des deux reste en 'ringing' / 'initiated' sans endedAt. Même sens à
   moins de 90 s, l'un jamais terminé → on garde le plus renseigné
   (même règle que dedupeSnap de api/team-pilotage.js). */
function isStuck(c) { return !c.endedAt && (c.status === 'ringing' || c.status === 'initiated'); }
function callScore(c) {
  return (c.endedAt ? 4 : 0) + (c.answeredAt ? 2 : 0) + (Number(c.durationSec) ? 1 : 0) +
    (c.status === 'completed' ? 1 : 0) + (c.aiSummary ? 1 : 0) + (c.ringoverRecordingUrl || c.recordingStoragePath ? 2 : 0);
}
function dedupe(items) {
  items.sort(function (a, b) { return toMs(a.c.initiatedAt) - toMs(b.c.initiatedAt); });
  const keep = [];
  items.forEach(function (x) {
    const prev = keep[keep.length - 1];
    if (prev && prev.c.direction === x.c.direction && Math.abs(toMs(x.c.initiatedAt) - toMs(prev.c.initiatedAt)) < 90000 && (isStuck(x.c) || isStuck(prev.c))) {
      if (callScore(x.c) > callScore(prev.c)) keep[keep.length - 1] = x;
      return;
    }
    keep.push(x);
  });
  return keep;
}

/* « Décroché » : règle du Funnel (funnel-core.js isAnsweredCall). */
function isAnswered(c) {
  const talk = Number(c.durationSec) || 0;
  if (talk < 5) return false;
  let ring = c.ringingDurationSec == null ? NaN : Number(c.ringingDurationSec);
  if (!isFinite(ring) || ring < 0) {
    const a = toMs(c.answeredAt), i = toMs(c.initiatedAt);
    ring = a && i && a >= i ? Math.round((a - i) / 1000) : null;
  }
  if (ring == null) return true;
  return !(ring >= 15 && talk < 15);
}

async function loadTwilioSms(e164) {
  const { getTwilioClient } = require('./_twilioClient');
  const client = await getTwilioClient();
  let timer = null;
  const timeout = new Promise(function (_, reject) {
    timer = setTimeout(function () { reject(new Error('Twilio ne répond pas')); }, TWILIO_TIMEOUT_MS);
  });
  try {
    const r = await Promise.race([Promise.all([
      client.messages.list({ to: e164, limit: 100, pageSize: 100 }),
      client.messages.list({ from: e164, limit: 100, pageSize: 100 }),
    ]), timeout]);
    return r[0].concat(r[1]);
  } finally {
    clearTimeout(timer);
  }
}

function waText(w) {
  const t = String(w.texte || '').trim();
  if (w.modele && (!t || t === '[' + w.modele + ']')) {
    const p = Array.isArray(w.params) ? w.params.filter(Boolean) : [];
    return 'Modèle « ' + w.modele + ' »' + (p.length ? ' (' + p.join(' · ') + ')' : '');
  }
  if (!t && (w.media || w.nomFichier)) return 'Fichier ' + (w.nomFichier || '');
  return t || '(sans texte)';
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'Réservé à l\'équipe sales' }); return; }

  const body = parseBody(req) || {};
  let leadId = String(body.leadId || '').trim();
  if (!/^[A-Za-z0-9_-]{3,80}$/.test(leadId)) { res.status(400).json({ ok: false, error: 'leadId invalide' }); return; }

  try {
    let snap = await db.collection('leads').doc(leadId).get();
    // Fiche fusionnée : on suit le survivant (motif pickAlive).
    for (let i = 0; i < 3 && snap.exists && (snap.data() || {})._merged === true && (snap.data() || {})._mergedInto; i++) {
      leadId = String(snap.data()._mergedInto);
      snap = await db.collection('leads').doc(leadId).get();
    }
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'Fiche introuvable' }); return; }
    const l = snap.data() || {};
    const e164 = toE164(l.telephone || '');
    const okE164 = /^\+\d{9,15}$/.test(e164);
    const phones = phoneVariants(l.telephone || '');
    const waNum = okE164 ? e164.slice(1) : '';

    const isAdmin = auth.role === 'admin';
    const canListenAll = isAdmin || !!(auth.userData && auth.userData.canListenCalls === true);

    const callQs = [db.collection('call_logs').where('leadId', '==', leadId).limit(MAX_CALLS)];
    if (phones.length) {
      callQs.push(db.collection('call_logs').where('toNumber', 'in', phones).limit(MAX_CALLS));
      callQs.push(db.collection('call_logs').where('fromNumber', 'in', phones).limit(MAX_CALLS));
    }
    let smsError = null;
    const results = await Promise.all([
      Promise.all(callQs.map(function (q) { return q.select.apply(q, CALL_FIELDS).get().catch(function (e) { console.warn('[lead-history] calls', e.message); return null; }); })),
      loadMembers(),
      waNum.length >= 10
        ? db.collection('whatsapp_conversations').doc(waNum).collection('messages').orderBy('at', 'desc').limit(MAX_WA).get().catch(function () { return null; })
        : Promise.resolve(null),
      waNum.length >= 10
        ? db.collection('whatsapp_messages').where('to', '==', waNum).limit(MAX_WA).get().catch(function () { return null; })
        : Promise.resolve(null),
      okE164
        ? loadTwilioSms(e164).catch(function (e) { console.warn('[lead-history] twilio', e.message); smsError = e.message || 'erreur'; return null; })
        : Promise.resolve(null),
    ]);
    const callSnaps = results[0], members = results[1], waSnap = results[2], waOutSnap = results[3], twSms = results[4];

    // ── Appels ──────────────────────────────────────────────────────────
    const byId = {};
    callSnaps.forEach(function (s) { if (s) s.forEach(function (d) { byId[d.id] = { id: d.id, c: d.data() || {} }; }); });
    const calls = dedupe(Object.keys(byId).map(function (k) { return byId[k]; })).map(function (x) {
      const c = x.c;
      const m = c.userId ? memberByUid(members, c.userId) : null;
      const summary = c.aiSummary || (c.aiAnalysis && typeof c.aiAnalysis.summary === 'string' ? c.aiAnalysis.summary : '');
      return {
        id: x.id,
        atMs: toMs(c.initiatedAt) || toMs(c.answeredAt),
        direction: c.direction === 'inbound' ? 'in' : 'out',
        durationSec: Number(c.durationSec) || 0,
        answered: isAnswered(c),
        userName: memberName(m) || c.userName || c.ringoverUserName || '',
        hasRecording: !!(c.ringoverRecordingUrl || c.recordingStoragePath),
        hasTranscript: c.transcriptionStatus === 'done' || !!c.transcriptText || !!c.transcriptionText || !!c.transcribedAt,
        summary: summary ? cap(summary, 400) : '',
        canListen: canListenAll || (!!c.userId && c.userId === auth.uid),
      };
    }).filter(function (c) { return c.atMs; });
    calls.sort(function (a, b) { return b.atMs - a.atMs; });

    // ── SMS Twilio ──────────────────────────────────────────────────────
    const sms = [];
    if (Array.isArray(twSms)) {
      const seen = {};
      twSms.forEach(function (t) {
        if (!t || !t.sid || seen[t.sid]) return;
        seen[t.sid] = 1;
        const st = String(t.status || '');
        sms.push({
          sid: t.sid,
          atMs: toMs(t.dateSent || t.dateCreated),
          direction: String(t.direction || '') === 'inbound' ? 'in' : 'out',
          status: st,
          failed: /^(failed|undelivered|canceled)$/.test(st),
          body: cap(t.body, 1200),
        });
      });
      sms.sort(function (a, b) { return b.atMs - a.atMs; });
    }

    // ── WhatsApp : la conversation, puis le journal d'envoi pour les
    //    messages refusés ou en échec, absents de la conversation. ────────
    const whatsapp = [];
    const waSeen = {};
    function pushWa(id, w) {
      const ctx = w.contexte || {};
      const m = ctx.uid ? memberByUid(members, ctx.uid) : null;
      const st = String(w.statut || '');
      whatsapp.push({
        id: id,
        atMs: toMs(w.at),
        direction: w.sens === 'in' ? 'in' : 'out',
        texte: cap(waText(w), 1200),
        statut: st,
        bad: st === 'refuse' || st === 'echec' || st === 'failed',
        erreur: w.erreur ? cap(w.erreur, 160) : '',
        par: w.sens === 'in' ? '' : (memberName(m) || (ctx.par ? String(ctx.par).split('@')[0] : (w.par ? String(w.par).split('@')[0] : ''))),
      });
    }
    if (waSnap) waSnap.forEach(function (d) {
      const w = d.data() || {};
      waSeen[d.id] = 1;
      if (w.wamid) waSeen[w.wamid] = 1;
      pushWa(d.id, w);
    });
    if (waOutSnap) waOutSnap.forEach(function (d) {
      const w = d.data() || {};
      if ((w.wamid && waSeen[w.wamid]) || waSeen[d.id]) return;
      if (w.wamid) waSeen[w.wamid] = 1;
      pushWa(d.id, w);
    });
    whatsapp.sort(function (a, b) { return b.atMs - a.atMs; });

    res.status(200).json({
      ok: true, leadId: leadId,
      calls: calls.slice(0, MAX_CALLS),
      sms: sms, smsError: smsError,
      whatsapp: whatsapp.filter(function (w) { return w.atMs; }).slice(0, MAX_WA),
    });
  } catch (e) {
    console.error('[lead-history]', e);
    if (!res.headersSent) res.status(500).json({ ok: false, error: e.message || 'Erreur interne' });
  }
};
