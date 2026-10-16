// ============================================================================
// api/rdv-presence.js — CONFIRMATION DE PRÉSENCE AU RDV, AVEC PREUVE
// ----------------------------------------------------------------------------
// Demande d'Adrien du 16/10/2026 : la pré-confirmation WhatsApp de la page
// /merci est supprimée. C'est le setter qui confirme le RDV avec le prospect,
// et il le déclare dans Leads Live — mais jamais sur parole : chaque
// confirmation est adossée à un TOUCH POINT réel, retrouvé ici en base.
//
// Preuves acceptées (validé par Adrien le 16/10/2026) :
//   • un APPEL décroché d'au moins MIN_CALL_SEC secondes avec le numéro du
//     prospect (sortant ou entrant, Ringover ou Twilio) — call_logs ;
//   • un SMS ENVOYÉ PAR LE PROSPECT — leads/{id}.communications[] ;
//   • un WhatsApp ENVOYÉ PAR LE PROSPECT — whatsapp_conversations/{n}/messages.
// Un message sortant seul ne prouve rien : il n'est jamais proposé.
// Fenêtre : de la prise du RDV (createdAt − MARGIN_MS, l'appel de setting
// pendant lequel le RDV est posé commence avant la réservation) jusqu'à la
// fin du RDV. Pour un appel, c'est la FIN de l'appel qui doit tomber après.
//
// IMMUABLE. Une confirmation s'écrit une seule fois, dans une transaction :
//   rdv_confirmations/{bookingId}  — preuve complète + résumé IA (lecture
//                                     équipe via cet endpoint ; aucune
//                                     écriture client, cf. firestore.rules) ;
//   bookings/{id}.presenceConfirmed — marqueur léger {at, by, byName, bySlug,
//                                     channel}, verrouillé par les rules.
// La preuve détaillée ne va PAS sur le booking : bookings est en lecture
// publique (booking.html calcule les créneaux libres).
// Personne ne peut la retirer, admin compris. Un RDV replanifié est un
// nouveau RDV : il doit être confirmé à nouveau.
//
// Résumé IA (appel uniquement) : Haiku lit la transcription et rend un
// verdict (confirmé / pas clair / non confirmé), deux phrases et la phrase
// clé du prospect. Généré à la confirmation si la transcription est déjà là,
// sinon à la première consultation qui la trouve (Ringover transcrit
// quelques minutes après le raccroché). Écrit une seule fois lui aussi.
//
// POST Bearer <ID token> (admin / sales)
//   { action:'proofs',  bookingId }            → preuves disponibles
//   { action:'confirm', bookingId, kind, id }  → confirme (409 si déjà fait)
//   { action:'get',     bookingId }            → confirmation + résumé
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { callClaude, humanError, cap, tsToMs } = require('./_ai');
const { callTranscript } = require('./_aiLeadContext');
const { toE164, dateNowFR } = require('./_leadLookup');

const ROLES = ['admin', 'sales'];
const MIN_CALL_SEC = 15;               // vu en prod : une vraie confirmation en 29 s
const MARGIN_MS = 5 * 60 * 1000;
const NO_TRANSCRIPT_AFTER_MS = 6 * 3600 * 1000;   // au-delà : on n'attend plus Ringover
const CHANNEL_LABEL = { call: 'appel', sms: 'SMS', wa: 'WhatsApp' };

const SUMMARY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'resume', 'citation'],
  properties: {
    verdict: { type: 'string', enum: ['confirme', 'pas_clair', 'non_confirme'] },
    resume: { type: 'string', description: '2 phrases maximum : ce que le prospect a dit de sa présence au rendez-vous.' },
    citation: { type: 'string', description: 'La phrase exacte du prospect qui confirme (ou non) sa présence, telle que transcrite. Vide si aucune.' },
  },
};

const SUMMARY_SYSTEM = [
  'Tu vérifies la transcription d\'un appel entre un membre de l\'équipe Alteore et un prospect, à propos d\'un rendez-vous en visio déjà réservé.',
  'Question unique : le PROSPECT a-t-il clairement confirmé qu\'il serait présent à ce rendez-vous ?',
  'verdict = confirme si le prospect dit explicitement qu\'il sera là (ou valide la date / l\'heure) ; non_confirme s\'il annule, refuse ou veut déplacer ; pas_clair dans tous les autres cas (messagerie, appel coupé, sujet non abordé, réponse évasive).',
  'Les locuteurs sont repérés par canal [n] : déduis qui est le prospect. N\'invente rien : la citation doit être recopiée de la transcription. Français.',
].join('\n');

/* ── Dates ─────────────────────────────────────────────────────────────── */
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'string') { const t = Date.parse(v); return isNaN(t) ? 0 : t; }
  return tsToMs(v);
}
/* « 2026-10-21 » + « 13:30 », heure de Paris → epoch ms (même convention que
   dispo-core et Leads Live : les RDV sont stockés en heure de Paris). */
function parisToMs(date, time) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date || ''));
  const t = /^(\d{1,2}):(\d{2})/.exec(String(time || '00:00'));
  if (!m || !t) return 0;
  const guess = Date.UTC(+m[1], +m[2] - 1, +m[3], +t[1], +t[2]);
  const p = {};
  new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(guess)).forEach(function (x) { p[x.type] = x.value; });
  const asParis = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute);
  return guess - (asParis - guess);
}
function frWhen(ms) {
  return new Date(ms).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function frDur(sec) {
  sec = Math.round(Number(sec) || 0);
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? m + ' min ' + (s < 10 ? '0' : '') + s : s + ' s';
}

/* ── Téléphones ────────────────────────────────────────────────────────── */
function phoneVariants(list) {
  const out = {};
  list.forEach(function (raw) {
    const e = toE164(raw);
    if (!/^\+\d{9,15}$/.test(e)) return;
    out[e] = 1;
    out[e.slice(1)] = 1;
    if (/^\+33\d{9}$/.test(e)) out['0' + e.slice(3)] = 1;
  });
  return Object.keys(out).slice(0, 10);
}

/* ── Équipe ────────────────────────────────────────────────────────────── */
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
function memberName(m) { return m ? (m.displayName || m.shortName || m.slug || '') : ''; }

/* ── Contexte : RDV, fiche, fenêtre ────────────────────────────────────── */
async function loadContext(bookingId) {
  const bSnap = await db.collection('bookings').doc(bookingId).get();
  if (!bSnap.exists) return { error: 'rdv_introuvable', code: 404 };
  const b = Object.assign({ id: bSnap.id }, bSnap.data() || {});
  if (b.isCoaching === true) return { error: 'rdv_coaching', code: 400 };

  let lead = null;
  if (b.leadId) {
    const lSnap = await db.collection('leads').doc(String(b.leadId)).get();
    if (lSnap.exists) lead = Object.assign({ id: lSnap.id }, lSnap.data() || {});
  }
  const pr = b.prospect || {};
  const startMs = parisToMs(b.date, b.time);
  const endMs = startMs + (Number(b.duration) || 30) * 60000;
  const createdMs = toMs(b.createdAt) || (startMs - 30 * 86400000);
  return {
    b: b, lead: lead,
    phones: phoneVariants([lead && lead.telephone, pr.telephone, pr.phone]),
    prospectName: (lead && lead.nom) || ((pr.prenom || '') + ' ' + (pr.nom || '')).trim() || '',
    startMs: startMs, endMs: endMs,
    fromMs: createdMs - MARGIN_MS, toMs: endMs,
  };
}

/* ── Preuves disponibles ───────────────────────────────────────────────── */
async function findProofs(ctx, members) {
  const out = [];
  const inWin = function (ms) { return ms && ms >= ctx.fromMs && ms <= ctx.toMs; };

  // 1. Appels : par leadId (Dialer) et par numéro (Ringover synchronisé).
  const calls = {};
  const qs = [];
  if (ctx.lead) qs.push(db.collection('call_logs').where('leadId', '==', ctx.lead.id).limit(60).get());
  if (ctx.phones.length) {
    qs.push(db.collection('call_logs').where('toNumber', 'in', ctx.phones).limit(60).get());
    qs.push(db.collection('call_logs').where('fromNumber', 'in', ctx.phones).limit(60).get());
  }
  const snaps = await Promise.all(qs.map(function (q) { return q.catch(function () { return null; }); }));
  snaps.forEach(function (s) { if (s) s.forEach(function (d) { calls[d.id] = d.data() || {}; }); });
  Object.keys(calls).forEach(function (id) {
    const c = calls[id];
    const dur = Number(c.durationSec) || 0;
    if (dur < MIN_CALL_SEC) return;
    const startMs = toMs(c.answeredAt) || toMs(c.initiatedAt);
    const endMs = startMs + dur * 1000;
    if (!startMs || endMs < ctx.fromMs || startMs > ctx.toMs) return;
    const m = c.userId ? memberByUid(members, c.userId) : null;
    out.push({
      kind: 'call', id: id, atMs: startMs,
      direction: c.direction === 'inbound' ? 'in' : 'out',
      durationSec: dur,
      userName: memberName(m) || c.userName || c.ringoverUserName || '',
      hasRecording: !!(c.ringoverRecordingUrl || c.recordingStoragePath || c.recordingUrl),
      hasTranscript: !!callTranscript(c),
      ringoverSummary: cap(c.aiSummary || '', 400),
    });
  });

  // 2. SMS reçus du prospect (fil de la fiche).
  if (ctx.lead && Array.isArray(ctx.lead.communications)) {
    const seen = {};
    ctx.lead.communications.forEach(function (c) {
      if (!c || c.type !== 'sms') return;
      if (!/^(in|entr)/.test(String(c.direction || '').toLowerCase())) return;
      const ms = toMs(c.date) || toMs(c.createdAt);
      if (!inWin(ms)) return;
      const text = String(c.content || '').replace(/^\s*message\s*:\s*/i, '').trim();
      const id = c.providerMessageId ? 'sms_' + c.providerMessageId : 'sms_' + ms;
      const k = text.toLowerCase() + '|' + Math.round(ms / 600000);   // doublon Ringover / Make
      if (seen[id] || seen[k]) return;
      seen[id] = seen[k] = 1;
      out.push({ kind: 'sms', id: id, atMs: ms, text: cap(text, 600), source: c.source || '' });
    });
  }

  // 3. WhatsApp reçus du prospect.
  const e164 = ctx.phones.filter(function (p) { return p.charAt(0) === '+'; })[0];
  if (e164) {
    try {
      const s = await db.collection('whatsapp_conversations').doc(e164.slice(1))
        .collection('messages').where('at', '>=', ctx.fromMs).limit(80).get();
      s.forEach(function (d) {
        const w = d.data() || {};
        if (w.sens !== 'in' || !inWin(Number(w.at))) return;
        out.push({ kind: 'wa', id: d.id, atMs: Number(w.at), text: cap(w.texte || '(message sans texte)', 600) });
      });
    } catch (e) { console.warn('[rdv-presence] whatsapp', e && e.message); }
  }

  out.sort(function (a, b) { return b.atMs - a.atMs; });
  return out;
}

/* ── Résumé IA de l'appel (écrit une seule fois) ───────────────────────── */
async function ensureSummary(confRef, conf, uid) {
  if (!conf || conf.channel !== 'call' || conf.summary || conf.summaryStatus === 'no_transcript') return conf;
  const cSnap = await db.collection('call_logs').doc(String(conf.proof.id)).get();
  const c = cSnap.exists ? (cSnap.data() || {}) : {};
  const tr = callTranscript(c);
  if (!tr || tr.length < 40) {
    if (Date.now() - (Number(conf.proof.atMs) || 0) > NO_TRANSCRIPT_AFTER_MS) {
      await confRef.update({ summaryStatus: 'no_transcript' });
      conf.summaryStatus = 'no_transcript';
    }
    // Le résumé Ringover arrive souvent avant la transcription : on le garde.
    if (c.aiSummary && !conf.proof.ringoverSummary) conf.proof.ringoverSummary = cap(c.aiSummary, 400);
    return conf;
  }
  const P = [
    'RENDEZ-VOUS : ' + conf.rdvLabel,
    'PROSPECT : ' + (conf.leadName || '?') + ' · MEMBRE DE L\'ÉQUIPE : ' + (conf.proof.userName || '?'),
    'Appel du ' + frWhen(conf.proof.atMs) + ', ' + frDur(conf.proof.durationSec),
    '',
    'TRANSCRIPTION :',
    cap(tr, 30000),
  ];
  const r = await callClaude({ task: 'presence_check', system: SUMMARY_SYSTEM, prompt: P.join('\n'), schema: SUMMARY_SCHEMA, noContext: true, uid: uid || null, ref: 'rdv:' + conf.bookingId });
  if (!r.ok || !r.json) {
    console.warn('[rdv-presence] résumé', conf.bookingId, r.error);
    conf.summaryError = humanError(r.error);
    return conf;
  }
  const summary = {
    verdict: ['confirme', 'pas_clair', 'non_confirme'].indexOf(r.json.verdict) >= 0 ? r.json.verdict : 'pas_clair',
    resume: cap(r.json.resume || '', 600),
    citation: cap(r.json.citation || '', 400),
    atMs: Date.now(),
  };
  await db.runTransaction(async function (tx) {
    const s = await tx.get(confRef);
    if (!s.exists || (s.data() || {}).summary) return;   // un autre passage l'a écrit
    tx.update(confRef, { summary: summary, summaryStatus: 'done' });
  });
  conf.summary = summary;
  conf.summaryStatus = 'done';
  return conf;
}

function publicConf(d) {
  if (!d) return null;
  return {
    bookingId: d.bookingId, leadId: d.leadId || null, leadName: d.leadName || '',
    rdvLabel: d.rdvLabel || '', channel: d.channel, proof: d.proof || {},
    confirmedAtMs: d.confirmedAtMs || 0, by: d.by || {},
    summary: d.summary || null, summaryStatus: d.summaryStatus || null,
    summaryError: d.summaryError || null,
  };
}

/* ── Handler ───────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'Method not allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'Réservé à l\'équipe sales' }); return; }

  const body = parseBody(req) || {};
  const action = String(body.action || '');
  const bookingId = String(body.bookingId || '').trim();
  if (!bookingId || bookingId.indexOf('/') >= 0) { res.status(400).json({ ok: false, error: 'bookingId requis' }); return; }
  const confRef = db.collection('rdv_confirmations').doc(bookingId);

  try {
    if (action === 'get') {
      const s = await confRef.get();
      if (!s.exists) { res.status(404).json({ ok: false, error: 'Aucune confirmation pour ce RDV' }); return; }
      const conf = await ensureSummary(confRef, s.data() || {}, auth.uid);
      res.status(200).json({ ok: true, confirmation: publicConf(conf) });
      return;
    }

    const ctx = await loadContext(bookingId);
    if (ctx.error) { res.status(ctx.code).json({ ok: false, error: ctx.error }); return; }
    const members = await loadMembers();

    if (action === 'proofs') {
      const existing = await confRef.get();
      const proofs = existing.exists ? [] : await findProofs(ctx, members);
      res.status(200).json({
        ok: true,
        alreadyConfirmed: existing.exists || !!ctx.b.presenceConfirmed,
        booking: { id: ctx.b.id, date: ctx.b.date, time: ctx.b.time, personName: ctx.b.personName || '', leadId: ctx.lead ? ctx.lead.id : null, leadName: ctx.prospectName },
        minCallSec: MIN_CALL_SEC,
        window: { fromMs: ctx.fromMs, toMs: ctx.toMs },
        proofs: proofs,
      });
      return;
    }

    if (action !== 'confirm') { res.status(400).json({ ok: false, error: 'action inconnue' }); return; }

    const b = ctx.b;
    if (b.status === 'cancelled' || b.outcome) { res.status(409).json({ ok: false, error: 'Ce RDV est annulé ou déjà statué' }); return; }
    if (Date.now() > ctx.endMs) { res.status(409).json({ ok: false, error: 'Ce RDV est terminé : il n\'y a plus de présence à confirmer' }); return; }

    // La preuve est recherchée À NOUVEAU côté serveur : le client ne fait que la désigner.
    const kind = String(body.kind || ''), pid = String(body.id || '');
    const proofs = await findProofs(ctx, members);
    const proof = proofs.filter(function (p) { return p.kind === kind && p.id === pid; })[0];
    if (!proof) { res.status(400).json({ ok: false, error: 'Preuve introuvable ou hors des conditions (appel décroché ≥ ' + MIN_CALL_SEC + ' s, ou message reçu du prospect, depuis la prise du RDV)' }); return; }

    const me = memberByUid(members, auth.uid);
    const byName = memberName(me) || (auth.userData && (auth.userData.displayName || auth.userData.name)) || auth.email || '';
    const now = Date.now();
    const rdvLabel = new Date(ctx.startMs).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
      + (b.personName ? ' avec ' + b.personName : '');
    const conf = {
      bookingId: bookingId,
      leadId: ctx.lead ? ctx.lead.id : null,
      leadName: ctx.prospectName,
      rdvDate: b.date || '', rdvTime: b.time || '', rdvPersonId: b.personId || null, rdvLabel: rdvLabel,
      channel: proof.kind,
      proof: proof,
      confirmedAt: admin.firestore.FieldValue.serverTimestamp(),
      confirmedAtMs: now,
      by: { uid: auth.uid, slug: me ? me.slug : null, name: byName, role: auth.role },
      summary: null,
      summaryStatus: proof.kind === 'call' ? 'pending' : 'n/a',
    };
    const marker = { at: now, by: auth.uid, byName: byName, bySlug: me ? me.slug : null, channel: proof.kind };

    const bRef = db.collection('bookings').doc(bookingId);
    try {
      await db.runTransaction(async function (tx) {
        const [bs, cs] = await Promise.all([tx.get(bRef), tx.get(confRef)]);
        if (cs.exists || (bs.data() || {}).presenceConfirmed) { const e = new Error('already'); e.code409 = true; throw e; }
        tx.set(confRef, conf);
        tx.update(bRef, { presenceConfirmed: marker });
      });
    } catch (e) {
      if (e && e.code409) { res.status(409).json({ ok: false, error: 'Présence déjà confirmée pour ce RDV' }); return; }
      throw e;
    }

    // Trace sur la fiche (best-effort : la confirmation est déjà écrite).
    if (ctx.lead) {
      const what = proof.kind === 'call' ? 'appel ' + frDur(proof.durationSec) : CHANNEL_LABEL[proof.kind] + ' du prospect';
      try {
        await db.collection('leads').doc(ctx.lead.id).update({
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '✅ Présence au RDV du ' + frWhen(ctx.startMs) + ' confirmée par ' + (byName || 'l\'équipe') + ' — preuve : ' + what,
            date: dateNowFR(), color: '#34d399',
          }),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } catch (e) { console.warn('[rdv-presence] timeline', e && e.message); }
    }

    let out = Object.assign({}, conf, { confirmedAt: null });
    if (proof.kind === 'call') {
      try { out = await ensureSummary(confRef, out, auth.uid); } catch (e) { console.warn('[rdv-presence] résumé', e && e.message); }
    }
    res.status(200).json({ ok: true, confirmation: publicConf(out) });
  } catch (e) {
    console.error('[rdv-presence]', action, bookingId, e);
    res.status(500).json({ ok: false, error: (e && e.message) || 'Erreur serveur' });
  }
};
