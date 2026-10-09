// ============================================================================
// api/ai-followup.js — RELANCES DES NON-CLOSÉS (programme IA, Lot 2)
// ----------------------------------------------------------------------------
// Règle d'or : l'IA PROPOSE, le closer du deal VALIDE. Rien ne part sans un
// clic « Envoyer » dans la pop-up (ai-followup-popup.js).
//
// Séquence par RDV non closé (issue 'non_close' ou 'offre') :
//   étape 1 — proposée dès que l'issue est saisie (« on relance ou pas ? ») ;
//   étape 2 — proposée à J+3 ; étape 3 — à J+7 ;
//   arrêt automatique si le prospect reprend RDV, devient client, ou répond
//   (échange entrant après notre dernier envoi), ou si le closer dit « stop ».
// Chaque message reprend les MOTS du prospect (analyse du closing si dispo).
//
// Données : ai_followups/{bookingId}
//   { bookingId, leadId, prospectName, outcome, closerUid, closerName,
//     status: active|stopped|done, stopReason, steps:[{ n, dueAt, status:
//     draft|pending|sent|skipped, sms, emailSubject, emailBody, angle,
//     channel, sentAt, decidedBy }], createdAt, updatedAt }
//
// Appels :
//   GET  Bearer <CRON_SECRET> (cron */15) → crée / avance les séquences
//   POST Bearer <ID token> (admin / sales)
//        { action:'mine', all? }           → étapes en attente (les miennes ;
//                                            admin + all → toute l'équipe)
//        { action:'decide', id, decision:'send'|'skip'|'stop'|'later',
//          channel:'sms'|'email', sms, emailSubject, emailBody }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db, admin } = require('./_firebaseAdmin');
const { callClaude, humanError, cap, tsToMs, TONE_PROSPECT } = require('./_ai');
const { sendLeadEmail } = require('./_leadEmail');
const { loadLeadBundle, bundleToText } = require('./_aiLeadContext');
const { setOutcomeForBooking } = require('./_aiObjections');
const { getRingoverCreds, ringoverFetch } = require('./_ringoverClient');

const ROLES = ['admin', 'sales'];
const STEP_OFFSETS_DAYS = [0, 3, 7];
const NON_CLOSED = { non_close: 1, offre: 1 };
const CRON_GEN_MAX = 5;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['angle', 'sms', 'emailSubject', 'emailBody'],
  properties: {
    angle: { type: 'string', description: 'L\'angle choisi pour cette relance, une phrase (pour le closer)' },
    sms: { type: 'string', description: 'SMS de relance, 320 caractères max, vouvoiement, signé du prénom du closer' },
    emailSubject: { type: 'string' },
    emailBody: { type: 'string', description: 'Email court (80-150 mots), vouvoiement, paragraphes séparés par une ligne vide, signé du prénom du closer' },
  },
};

const SYSTEM = [
  'Tu rédiges une relance pour un prospect d\'Alteore qui n\'a pas signé lors de son RDV de closing.',
  'Objectif : rouvrir la conversation et obtenir une réponse ou un nouveau créneau, sans pression ni insistance lourde.',
  'Reprends les MOTS du prospect (ses douleurs, son objectif) tels qu\'ils apparaissent dans le dossier. Une seule idée par message, une seule question à la fin.',
  'Étape 1 (lendemain) : remerciement + rappel de SA douleur principale + question ouverte. Étape 2 (J+3) : apporte un élément nouveau qui répond à son frein principal. Étape 3 (J+7) : dernier message, porte ouverte, sans culpabiliser.',
  'Interdits : promesse de résultat chiffré, fausse urgence, réduction non prévue dans le contexte Alteore, tutoiement.',
  'Si le prospect a explicitement dit non ou demandé à ne plus être relancé, l\'email prend acte, apporte un conseil utile et ferme la porte avec élégance — sans proposer de nouveau RDV.',
  TONE_PROSPECT,
].join('\n');

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function shiftDate(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days, 12)).toISOString().slice(0, 10);
}
function prospectName(b) {
  const p = b.prospect || {};
  return ((p.prenom || '') + ' ' + (p.nom || '')).trim() || p.email || '?';
}
function normalizeE164(raw) {
  if (!raw) return null;
  const c = String(raw).replace(/[\s\-().]/g, '');
  if (c.startsWith('+')) return c;
  if (c.startsWith('00')) return '+' + c.slice(2);
  if (c.startsWith('0') && c.length === 10) return '+33' + c.slice(1);
  if (c.startsWith('33') && c.length >= 11) return '+' + c;
  return null;
}

async function resolveCloser(b) {
  let uid = null, name = b.personName || null;
  if (b.personId) {
    try {
      const p = await db.collection('booking_config').doc(b.personId).get();
      if (p.exists && p.data().firebaseUid) uid = p.data().firebaseUid;
    } catch (e) { /* repli */ }
  }
  if (!uid && b.outcomeBy) { uid = b.outcomeBy; name = name || b.outcomeByName || null; }
  return { uid: uid, name: name };
}

// ---------------------------------------------------------------------------
//  Génération d'une étape
// ---------------------------------------------------------------------------

async function generateStep(fu, stepIdx, b) {
  const P = [];
  P.push('ÉTAPE ' + (stepIdx + 1) + ' / 3');
  P.push('CLOSER : ' + (fu.closerName || '?') + ' (signe avec son prénom)');
  P.push('PROSPECT : ' + fu.prospectName);
  P.push('RDV : ' + (b.date || '?') + ' — issue « ' + (b.outcome === 'offre' ? 'offre faite, en réflexion' : 'non closé') + ' »' + (b.outcomeNote ? ' — note du closer : ' + cap(b.outcomeNote, 500) : ''));
  const an = b.replay && b.replay.analysis;
  if (an) {
    P.push('ANALYSE DU CLOSING :');
    if (an.verdict) P.push('- Verdict : ' + an.verdict);
    if (an.prospect) {
      if ((an.prospect.douleurs || []).length) P.push('- Douleurs : ' + an.prospect.douleurs.join(' | '));
      if ((an.prospect.motivations || []).length) P.push('- Motivations : ' + an.prospect.motivations.join(' | '));
      if ((an.prospect.freins || []).length) P.push('- Freins : ' + an.prospect.freins.join(' | '));
    }
    (an.objections || []).slice(0, 5).forEach(function (o) { P.push('- Objection : « ' + cap(o.quote, 200) + ' »'); });
    if (an.conseilRelance) P.push('- Conseil de relance : ' + an.conseilRelance);
  }
  if (fu.leadId) {
    const bundle = await loadLeadBundle(fu.leadId);
    if (bundle) { P.push(''); P.push(bundleToText(bundle, { maxCalls: 2, transcriptChars: 3000 })); }
  }
  const prevSent = (fu.steps || []).filter(function (s) { return s.status === 'sent'; });
  if (prevSent.length) {
    P.push('');
    P.push('RELANCES DÉJÀ ENVOYÉES (ne pas répéter) :');
    prevSent.forEach(function (s) { P.push('- Étape ' + s.n + ' (' + s.channel + ') : ' + cap(s.channel === 'email' ? s.emailBody : s.sms, 400)); });
  }
  return callClaude({ task: 'closing_followup', system: SYSTEM, prompt: P.join('\n'), schema: SCHEMA, ref: 'followup:' + fu.bookingId });
}

// ---------------------------------------------------------------------------
//  Cron
// ---------------------------------------------------------------------------

async function shouldStop(fu) {
  if (!fu.leadId) return null;
  const ls = await db.collection('leads').doc(fu.leadId).get();
  if (!ls.exists) return 'lead_introuvable';
  const l = ls.data() || {};
  if (l.isClient || l.stage === 'closed_won_self' || l.stage === 'closed_won_setting') return 'devenu_client';
  const lastSent = Math.max.apply(null, [0].concat((fu.steps || []).map(function (s) { return s.sentAt || 0; })));
  const ref = lastSent || fu.createdAt || 0;
  const inbound = (l.communications || []).some(function (c) {
    const dir = String(c.direction || '').toLowerCase();
    return (dir === 'inbound' || dir === 'entrant' || dir === 'in') && Date.parse(c.date || '') > ref;
  });
  if (inbound) return 'a_repondu';
  const bs = await db.collection('bookings').where('leadId', '==', fu.leadId).get();
  let rebooked = false;
  bs.forEach(function (d) {
    const x = d.data() || {};
    if (d.id !== fu.bookingId && x.status !== 'cancelled' && !x.outcome && String(x.date || '') >= parisDate(Date.now())) rebooked = true;
  });
  return rebooked ? 'a_repris_rdv' : null;
}

async function runCron(res) {
  const out = { ok: true, created: 0, generated: 0, stopped: 0, outcomesSynced: 0, errors: [] };
  const today = parisDate(Date.now());
  const recent = await db.collection('bookings').where('date', '>=', shiftDate(today, -4)).where('date', '<=', today).get();
  let gen = 0;

  for (const d of recent.docs) {
    const b = d.data() || {};
    // Synchronise l'issue sur les objections déjà extraites de ce closing.
    if (b.outcome && b.replay && b.replay.analysis) {
      try { await setOutcomeForBooking(d.id, b.outcome); out.outcomesSynced++; } catch (e) { /* non bloquant */ }
    }
    if (!NON_CLOSED[b.outcome] || !b.leadId) continue;
    if (Date.now() - tsToMs(b.outcomeAt) > 4 * 86400000) continue;
    const ref = db.collection('ai_followups').doc(d.id);
    const ex = await ref.get();
    if (ex.exists) continue;
    if (gen >= CRON_GEN_MAX) break;
    const closer = await resolveCloser(b);
    const base = tsToMs(b.outcomeAt) || Date.now();
    const fu = {
      bookingId: d.id, leadId: b.leadId, prospectName: prospectName(b), outcome: b.outcome,
      closerUid: closer.uid, closerName: closer.name, status: 'active', stopReason: null,
      steps: STEP_OFFSETS_DAYS.map(function (off, i) { return { n: i + 1, dueAt: base + off * 86400000, status: 'draft' }; }),
      createdAt: Date.now(), updatedAt: Date.now(),
    };
    const r = await generateStep(fu, 0, b);
    gen++;
    if (!r.ok) { out.errors.push(d.id + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; continue; }
    Object.assign(fu.steps[0], r.json, { status: 'pending', generatedAt: Date.now() });
    await ref.set(fu);
    out.created++;
  }

  // Étapes suivantes arrivées à échéance.
  const act = await db.collection('ai_followups').where('status', '==', 'active').limit(100).get();
  for (const d of act.docs) {
    if (gen >= CRON_GEN_MAX) break;
    const fu = d.data() || {};
    const idx = (fu.steps || []).findIndex(function (s) { return s.status === 'draft'; });
    const pendingIdx = (fu.steps || []).findIndex(function (s) { return s.status === 'pending'; });
    if (idx < 0) {
      if (pendingIdx < 0) await d.ref.update({ status: 'done', updatedAt: Date.now() });
      continue;
    }
    if (pendingIdx >= 0 || fu.steps[idx].dueAt > Date.now()) continue;
    try {
      const stop = await shouldStop(fu);
      if (stop) { await d.ref.update({ status: 'stopped', stopReason: stop, updatedAt: Date.now() }); out.stopped++; continue; }
      const bs = await db.collection('bookings').doc(fu.bookingId).get();
      const r = await generateStep(fu, idx, bs.exists ? bs.data() : {});
      gen++;
      if (!r.ok) { out.errors.push(d.id + ':' + r.error); if (/^ai_(budget|disabled|task)/.test(r.error)) break; continue; }
      const steps = fu.steps.slice();
      steps[idx] = Object.assign({}, steps[idx], r.json, { status: 'pending', generatedAt: Date.now() });
      await d.ref.update({ steps: steps, updatedAt: Date.now() });
      out.generated++;
    } catch (e) { out.errors.push(d.id + ':' + e.message); }
  }
  res.status(200).json(out);
}

// ---------------------------------------------------------------------------
//  Envoi (après validation humaine uniquement)
// ---------------------------------------------------------------------------

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

async function sendSms(auth, leadId, lead, text) {
  const toNumber = normalizeE164(lead.telephone);
  if (!toNumber) throw new Error('Numéro du prospect manquant ou invalide');
  const creds = await getRingoverCreds();
  let fromNumber = null;
  try {
    const numSnap = await db.collection('phone_numbers').where('assignedTo', '==', auth.uid)
      .where('provider', '==', 'ringover').where('active', '==', true).limit(1).get();
    if (!numSnap.empty) fromNumber = numSnap.docs[0].data().phoneNumber || null;
  } catch (e) { /* repli ligne partagée */ }
  fromNumber = fromNumber || creds.fromNumber;
  if (!fromNumber) throw new Error('Aucune ligne Ringover pour envoyer');
  const resp = await ringoverFetch('/push/sms', { method: 'POST', body: { from_number: fromNumber, to_number: toNumber, content: text } });
  const me = await memberOf(auth.uid);
  const nowIso = new Date().toISOString();
  await db.collection('leads').doc(leadId).update({
    communications: admin.firestore.FieldValue.arrayUnion({
      type: 'sms', direction: 'outbound', content: text, source: 'ringover-sms', date: nowIso, createdAt: nowIso,
      ownerUid: auth.uid, ownerName: me.name || auth.email, ownerSlug: me.slug || null,
      providerMessageId: String((resp && resp.message_id) || ''), fromNumber: fromNumber, toNumber: toNumber, aiFollowup: true,
    }),
    timeline_history: admin.firestore.FieldValue.arrayUnion({
      text: '💬 Relance IA validée (SMS) — ' + text.substring(0, 100),
      date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#60a5fa',
    }),
    lastContactAt: admin.firestore.FieldValue.serverTimestamp(), lastContactType: 'sms',
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
}

async function sendEmail(auth, leadId, lead, subject, bodyText) {
  // Helper partagé (api/_leadEmail.js) : même compte d'envoi, même traçabilité.
  return sendLeadEmail(auth, leadId, subject, bodyText, { label: '✉️ Relance IA validée (email)', flag: 'aiFollowup' });
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { await runCron(res); } catch (e) { console.error('[ai-followup] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);

  try {
    if (body.action === 'mine') {
      const all = body.all === true && auth.role === 'admin';
      const snap = await db.collection('ai_followups').where('status', '==', 'active').limit(200).get();
      const items = [];
      let teamPending = 0;
      snap.forEach(function (d) {
        const fu = d.data() || {};
        const step = (fu.steps || []).find(function (s) { return s.status === 'pending'; });
        if (!step) return;
        if (step.snoozeUntil && step.snoozeUntil > Date.now()) return;
        if (fu.closerUid !== auth.uid) teamPending++;
        if (!all && fu.closerUid !== auth.uid) return;
        items.push({ id: d.id, leadId: fu.leadId, prospectName: fu.prospectName, outcome: fu.outcome, closerName: fu.closerName,
          mine: fu.closerUid === auth.uid, step: step, totalSteps: (fu.steps || []).length });
      });
      items.sort(function (a, b) { return (a.step.dueAt || 0) - (b.step.dueAt || 0); });
      res.status(200).json({ ok: true, items: items, teamPending: auth.role === 'admin' ? teamPending : 0 });
      return;
    }

    if (body.action === 'decide') {
      const ref = db.collection('ai_followups').doc(String(body.id || ''));
      const s = await ref.get();
      if (!s.exists) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const fu = s.data() || {};
      if (fu.closerUid !== auth.uid && auth.role !== 'admin') { res.status(403).json({ ok: false, error: 'not_your_followup' }); return; }
      const steps = (fu.steps || []).slice();
      const idx = steps.findIndex(function (x) { return x.status === 'pending'; });
      if (idx < 0) { res.status(409).json({ ok: false, error: 'no_pending_step' }); return; }
      const st = Object.assign({}, steps[idx]);
      const dec = body.decision;
      const patch = { updatedAt: Date.now() };

      if (dec === 'send') {
        const channel = body.channel === 'email' ? 'email' : 'sms';
        const ls = await db.collection('leads').doc(fu.leadId).get();
        if (!ls.exists) { res.status(404).json({ ok: false, error: 'lead_not_found' }); return; }
        const lead = ls.data() || {};
        if (channel === 'sms') {
          const txt = String(body.sms || st.sms || '').trim().slice(0, 640);
          if (!txt) { res.status(400).json({ ok: false, error: 'empty_message' }); return; }
          await sendSms(auth, fu.leadId, lead, txt);
          st.sms = txt;
        } else {
          const subj = String(body.emailSubject || st.emailSubject || '').trim().slice(0, 200);
          const txt = String(body.emailBody || st.emailBody || '').trim().slice(0, 6000);
          if (!subj || !txt) { res.status(400).json({ ok: false, error: 'empty_message' }); return; }
          await sendEmail(auth, fu.leadId, lead, subj, txt);
          st.emailSubject = subj; st.emailBody = txt;
        }
        st.status = 'sent'; st.channel = channel; st.sentAt = Date.now(); st.decidedBy = auth.uid;
        if (idx === steps.length - 1) patch.status = 'done';
      } else if (dec === 'skip') {
        st.status = 'skipped'; st.decidedBy = auth.uid; st.decidedAt = Date.now();
        if (idx === steps.length - 1) patch.status = 'done';
      } else if (dec === 'stop') {
        st.status = 'skipped'; st.decidedBy = auth.uid; st.decidedAt = Date.now();
        patch.status = 'stopped'; patch.stopReason = 'decision_closer';
      } else if (dec === 'later') {
        st.snoozeUntil = Date.now() + 3 * 3600 * 1000;
      } else {
        res.status(400).json({ ok: false, error: 'bad_decision' }); return;
      }
      steps[idx] = st;
      patch.steps = steps;
      await ref.update(patch);
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[ai-followup]', e);
    const msg = e && e.message ? e.message : String(e);
    res.status(200).json({ ok: false, error: msg, message: /^ai_/.test(msg) ? humanError(msg) : msg });
  }
};
