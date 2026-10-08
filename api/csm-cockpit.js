// ============================================================================
// api/csm-cockpit.js — COCKPIT CSM (refonte du module CSM, programme IA Lot 3)
// ----------------------------------------------------------------------------
// Toutes les données du cockpit passent par ici (Admin SDK) : la CSM n'a pas
// le droit de lire `payments` depuis le navigateur (règle), ce qui faussait
// l'ancien écran (« aucun paiement » partout). Rôles : admin + csm.
//
// GET  ?scope=active|all          → { clients[], kpis, coaches }
// GET  ?id=<clientId>             → détail complet d'un client
// POST { action:'note', id, text }                 → clients/{id}.csmNotes
// POST { action:'followup', id, channel, message } → suivi CSM tracé
// POST { action:'status', id, clientStatus }       → statut CSM
// POST { action:'diagnostic', id }                 → diagnostic IA (Opus)
//                                                    → client_ai/{id}.diagnostic
// Les champs écrits sur clients/{id} sont EXACTEMENT ceux de l'ancien écran
// (csmNotes, csmFollowupHistory, lastCsmFollowupAt/By, clientStatus) : les
// deux vues restent compatibles.
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db, admin } = require('./_firebaseAdmin');
const { callClaude, humanError, cap, tsToMs } = require('./_ai');
const H = require('./_clientHealth');
const Q = require('./_coaching-quota');

const ROLES = ['admin', 'csm'];
const STATUSES = ['active', 'paused', 'completed', 'stopped', 'procedure'];
const CHANNELS = ['note', 'appel', 'sms', 'email', 'whatsapp', 'visio'];

function monthKey(today) { return today.slice(0, 7); }

function doneThisMonth(c, ym) {
  return H.allSessions(c).filter(function (s) {
    return s.statut === 'fait' && s.numero !== 0 && s.type !== 'rdv72h' && String(s.date || '').slice(0, 7) === ym;
  }).length;
}

function row(c, ctx, ev) {
  const ym = monthKey(ctx.today);
  const f = ev ? ev.risk.facts : {};
  const quota = Q.effectiveMonthlyQuota(c, ym);
  const ai = ctx.ai[c.id] || {};
  return {
    id: c.id,
    nom: c.nom || '(sans nom)',
    email: c.email || '',
    telephone: c.telephone || c.tel || '',
    programme: c.programme || '',
    coach: c.coachAssigned || c.coach || '',
    active: H.isActiveClient(c),
    clientStatus: c.clientStatus || (H.isActiveClient(c) ? 'active' : 'completed'),
    dateEntree: c.dateEntree || null,
    contractEnd: f.contractEnd || null,
    daysToEnd: f.daysToEnd != null ? f.daysToEnd : null,
    sessionsDone: f.sessionsDone || 0,
    sessionsTotal: f.sessionsTotal || null,
    lastSession: f.lastSession || null,
    daysSinceLastSession: f.daysSinceLastSession != null ? f.daysSinceLastSession : null,
    nextSession: f.nextSession || null,
    quota: { month: ym, done: doneThisMonth(c, ym), target: quota },
    level: ev ? ev.risk.level : null,
    reasons: ev ? ev.risk.reasons : [],
    unpaid: !!(f.paymentIssues && f.paymentIssues.length),
    payments: f.payments || [],
    opportunity: ev ? ev.opportunity : null,
    aiSignal: ai.signal ? { negatif: !!ai.signal.signalNegatif, raison: ai.signal.raison || '' } : null,
    riskComputedAt: ai.risk ? ai.risk.computedAt : null,
    lastFollowupAt: tsToMs(c.lastCsmFollowupAt) || null,
    notesCount: (c.csmNotes || []).length,
  };
}

async function listAll(scope) {
  const ctx = await H.loadHealthContext();
  const rows = [];
  for (const c of ctx.clients) {
    const active = H.isActiveClient(c);
    if (scope !== 'all' && !active) continue;
    // Règles recalculées à chaque ouverture (aucune IO) ; devoirs Academy et
    // signal IA repris du dernier passage du cron (client_ai).
    const ev = active ? await H.evaluateClient(c, ctx, { withAcademy: false, withAi: false }) : null;
    rows.push(row(c, ctx, ev));
  }
  const act = rows.filter(function (r) { return r.active; });
  const kpis = {
    actifs: act.length,
    rouge: act.filter(function (r) { return r.level === 'rouge'; }).length,
    orange: act.filter(function (r) { return r.level === 'orange'; }).length,
    vert: act.filter(function (r) { return r.level === 'vert'; }).length,
    impayes: act.filter(function (r) { return r.unpaid; }).length,
    opportunites: act.filter(function (r) { return !!r.opportunity; }).length,
    finProche: act.filter(function (r) { return r.daysToEnd != null && r.daysToEnd >= 0 && r.daysToEnd <= 60; }).length,
    sansSuivi30j: act.filter(function (r) { return !r.lastFollowupAt || Date.now() - r.lastFollowupAt > 30 * 86400000; }).length,
  };
  const coaches = {};
  rows.forEach(function (r) { if (r.coach) coaches[r.coach] = 1; });
  return { clients: rows, kpis: kpis, coaches: Object.keys(coaches).sort(), today: ctx.today };
}

async function detail(id) {
  const ctx = await H.loadHealthContext();
  const c = ctx.clients.find(function (x) { return x.id === id; });
  if (!c) return null;
  const active = H.isActiveClient(c);
  const ev = active ? await H.evaluateClient(c, ctx, { withAcademy: false, withAi: false }) : null;
  const r = row(c, ctx, ev);
  const ai = ctx.ai[id] || {};
  const sessions = H.allSessions(c).filter(function (s) { return s.statut === 'fait'; })
    .sort(function (a, b) { return String(b.date || '') < String(a.date || '') ? -1 : 1; }).slice(0, 8)
    .map(function (s) { return { numero: s.numero, date: s.date, coach: s.coach || '', resume: cap(s.resume || s.driveSummary || '', 600), devoirs: cap(s.devoirs || '', 300), onboarding: s.numero === 0 || s.type === 'rdv72h' }; });
  const bookings = H.bookingsOf(c, ctx).sort(function (a, b) { return String(b.date) + (b.time || '') < String(a.date) + (a.time || '') ? -1 : 1; }).slice(0, 8)
    .map(function (b) { return { date: b.date, time: b.time || '', status: b.status, origin: (b.cancellation && b.cancellation.origin) || b.cancelledOrigin || null, rescheduled: !!b.rescheduled, coach: b.personName || '' }; });
  const pays = H.paymentsOf(c, ctx).map(function (p) {
    return { id: p.id, description: p.description || '', status: p.status, totalAmount: Number(p.totalAmount) || 0, paidAmount: Number(p.paidAmount) || 0,
      paidCount: Number(p.paidCount) || 0, installmentsCount: Number(p.installmentsCount) || 1, installmentAmount: Number(p.installmentAmount) || 0,
      startDate: p.startDate || null, lastPaymentFailure: p.lastPaymentFailure || null, recouvrement: p.recouvrement || null };
  });
  const ics = H.invoiceClientsOf(c, ctx).map(function (ic) { return { id: ic.id, companyName: ic.companyName || '', clientStatus: ic.clientStatus || '' }; });
  const alertsSnap = await db.collection('ai_alerts').where('clientId', '==', id).get();
  const alerts = [];
  alertsSnap.forEach(function (d) { const a = d.data() || {}; if (a.status === 'open') alerts.push({ id: d.id, level: a.level, reasons: a.reasons || [], createdAt: a.createdAt }); });
  return {
    client: r,
    activite: c.activite || '',
    planAction: cap(c.planAction || '', 3000),
    clientNotes: cap(c.clientNotes || '', 2000),
    sessions: sessions,
    bookings: bookings,
    payments: pays,
    invoiceClients: ics,
    csmNotes: (c.csmNotes || []).slice(-30).reverse(),
    followups: (c.csmFollowupHistory || []).slice(-30).reverse(),
    academy: (ev && ev.risk.facts.academy) || null,
    signal: ai.signal || null,
    diagnostic: ai.diagnostic || null,
    alerts: alerts,
  };
}

const DIAG_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['synthese', 'coaching', 'paiement', 'engagement', 'risques', 'leviers', 'plan30j', 'messageClient'],
  properties: {
    synthese: { type: 'string', description: '3 phrases : où en est le client, ce qui va, ce qui coince' },
    coaching: { type: 'string', description: 'État du coaching (rythme, progrès, devoirs) en 2 phrases' },
    paiement: { type: 'string', description: 'État des paiements en 1-2 phrases (factuel)' },
    engagement: { type: 'string', description: 'Niveau d\'engagement et signaux en 1-2 phrases' },
    risques: { type: 'array', items: { type: 'string' } },
    leviers: { type: 'array', items: { type: 'string' }, description: 'Ce qui peut relancer / fidéliser ce client' },
    plan30j: { type: 'array', items: { type: 'string' }, description: '3 à 5 actions CSM datées dans les 30 jours' },
    messageClient: { type: 'string', description: 'Message de prise de nouvelles à envoyer au client (vouvoiement, 60-110 mots), à valider par la CSM' },
  },
};

async function runDiagnostic(id, uid) {
  const d = await detail(id);
  if (!d) return { ok: false, error: 'client_not_found' };
  const c = d.client;
  const P = [];
  P.push('CLIENT : ' + c.nom + ' · ' + c.programme + ' · coach ' + (c.coach || '?') + ' · entré le ' + (c.dateEntree || '?') + (c.contractEnd ? ' · fin prévue ' + c.contractEnd : ''));
  P.push('FEU : ' + (c.level || '?') + ' — ' + (c.reasons || []).join(' · '));
  P.push('SÉANCES : ' + c.sessionsDone + '/' + (c.sessionsTotal || '?') + ' · dernière ' + (c.lastSession || 'aucune') + ' · prochaine ' + (c.nextSession || 'aucune') + ' · quota du mois ' + c.quota.done + '/' + c.quota.target);
  if (d.activite) P.push('ACTIVITÉ : ' + cap(d.activite, 300));
  if (d.planAction) P.push('PLAN D\'ACTION : ' + d.planAction);
  d.sessions.forEach(function (s) { P.push('- Séance ' + s.date + ' (' + s.coach + ') : ' + s.resume + (s.devoirs ? ' | devoirs : ' + s.devoirs : '')); });
  d.bookings.forEach(function (b) { P.push('- RDV ' + b.date + ' ' + b.time + ' : ' + b.status + (b.origin ? ' (annulé par ' + b.origin + ')' : '')); });
  d.payments.forEach(function (p) { P.push('- Paiement « ' + p.description + ' » : ' + p.status + ', ' + p.paidAmount + ' / ' + p.totalAmount + ' €' + (p.lastPaymentFailure ? ', dernier rejet ' + (p.lastPaymentFailure.at || '') : '')); });
  if (d.academy) P.push('ACADEMY : ' + d.academy.devoirsNonFaits + ' devoirs non faits, ' + d.academy.seancesNonHonorees + ' séances non honorées');
  d.csmNotes.slice(0, 8).forEach(function (n) { P.push('- Note CSM : ' + cap(n.contenu || '', 300)); });
  d.followups.slice(0, 6).forEach(function (h) { P.push('- Suivi ' + (h.channel || '') + ' ' + (h.at || '') + ' : ' + cap(h.message || '', 300)); });
  if (d.clientNotes) P.push('NOTES COACH : ' + d.clientNotes);

  const r = await callClaude({
    task: 'csm_diagnostic',
    system: 'Tu es la Customer Success Manager senior d\'Alteore (coaching business d\'entrepreneurs). Établis le diagnostic d\'un client à partir de TOUTES les données fournies : synthèse, état coaching / paiement / engagement, risques, leviers, plan d\'action CSM sur 30 jours, et un message de prise de nouvelles à envoyer (la CSM le relira). Factuel, aucune invention, français.',
    prompt: P.join('\n'),
    schema: DIAG_SCHEMA,
    uid: uid,
    ref: 'client:' + id,
  });
  if (!r.ok) return r;
  const diag = Object.assign({}, r.json, { generatedAt: Date.now(), model: r.model || null });
  await db.collection('client_ai').doc(id).set({ diagnostic: diag }, { merge: true });
  return { ok: true, diagnostic: diag };
}

async function memberName(uid, email) {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? s.data().members : null;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const m = list.find(function (x) { return x && x.firebaseUid === uid; });
    if (m) return m.shortName || m.displayName || m.fullName || email;
  } catch (e) { /* repli */ }
  return email || '';
}

module.exports = async function (req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden', message: 'Réservé aux CSM et administrateurs.' }); return; }

  try {
    if (req.method === 'GET') {
      const q = req.query || {};
      if (q.id) {
        const d = await detail(String(q.id));
        if (!d) { res.status(404).json({ ok: false, error: 'client_not_found' }); return; }
        res.status(200).json(Object.assign({ ok: true }, d));
        return;
      }
      res.status(200).json(Object.assign({ ok: true }, await listAll(q.scope === 'all' ? 'all' : 'active')));
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

    const body = parseBody(req);
    const id = String(body.id || '').trim();
    if (!id) { res.status(400).json({ ok: false, error: 'id_required' }); return; }
    const ref = db.collection('clients').doc(id);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ ok: false, error: 'client_not_found' }); return; }

    if (body.action === 'note') {
      const text = String(body.text || '').trim().slice(0, 4000);
      if (!text) { res.status(400).json({ ok: false, error: 'empty' }); return; }
      await ref.update({ csmNotes: admin.firestore.FieldValue.arrayUnion({ contenu: text, auteur: auth.email || auth.uid, createdAt: new Date().toISOString() }) });
      res.status(200).json({ ok: true });
      return;
    }
    if (body.action === 'followup') {
      const channel = CHANNELS.indexOf(body.channel) >= 0 ? body.channel : 'note';
      const message = String(body.message || '').trim().slice(0, 4000);
      const byName = await memberName(auth.uid, auth.email);
      await ref.update({
        lastCsmFollowupAt: admin.firestore.FieldValue.serverTimestamp(),
        lastCsmFollowupBy: auth.uid,
        csmFollowupHistory: admin.firestore.FieldValue.arrayUnion({ at: new Date().toISOString(), by: auth.uid, byName: byName, channel: channel, message: message }),
      });
      res.status(200).json({ ok: true });
      return;
    }
    if (body.action === 'status') {
      if (STATUSES.indexOf(body.clientStatus) < 0) { res.status(400).json({ ok: false, error: 'bad_status' }); return; }
      await ref.update({ clientStatus: body.clientStatus, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
      res.status(200).json({ ok: true });
      return;
    }
    if (body.action === 'diagnostic') {
      const r = await runDiagnostic(id, auth.uid);
      if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
      res.status(200).json({ ok: true, diagnostic: r.diagnostic });
      return;
    }
    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[csm-cockpit]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
