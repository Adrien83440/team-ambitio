// ============================================================================
// api/_clientHealth.js — SANTÉ CLIENT / FEU TRICOLORE (programme IA, Lot 3)
// ----------------------------------------------------------------------------
// Calcule, pour chaque client coaching actif, des FAITS objectifs puis un
// niveau par RÈGLES FIXES (validées par Adrien le 08/10/2026, réglables dans
// _config/ai.riskRules) :
//
//   🔴 rouge  : impayé en cours (mandat / prélèvement en échec, échéances en
//              retard, dossier en procédure) OU aucune séance depuis 21 j
//              OU 2 annulations (par le client) / absences d'affilée
//   🟠 orange : aucune séance depuis 14 j OU ≥ 2 devoirs non faits (Academy)
//              OU signal négatif repéré par l'IA dans les derniers échanges
//   🟢 vert   : le reste
//
// Le signal IA (Haiku) n'est recalculé que si les dernières séances / notes
// CSM ont changé (clé). Résultats stockés dans client_ai/{clientId} — JAMAIS
// sur clients/{id} : coaching.html réécrit la fiche entière à chaque
// sauvegarde et effacerait ces champs.
//
// Jointure paiements : clients.personId → payments.personId, puis email →
// leads (isClient) → payments.leadId, puis payments.leadEmail.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { callClaude, cap, tsToMs, getAiConfig } = require('./_ai');

const DEFAULT_RULES = { redDays: 21, orangeDays: 14, missedStreak: 2, homeworkMissed: 2, newClientGraceDays: 10 };
const LEVEL_RANK = { vert: 0, orange: 1, rouge: 2 };
const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ACADEMY_ACTOR = 'ia-risque@team.alteore.com';

function lower(s) { return String(s || '').trim().toLowerCase(); }
function parisToday() { return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function daysBetween(a, b) { // 'YYYY-MM-DD' → jours entiers b - a
  const pa = String(a).slice(0, 10).split('-').map(Number), pb = String(b).slice(0, 10).split('-').map(Number);
  if (pa.length < 3 || pb.length < 3 || pa.some(isNaN) || pb.some(isNaN)) return null;
  return Math.round((Date.UTC(pb[0], pb[1] - 1, pb[2]) - Date.UTC(pa[0], pa[1] - 1, pa[2])) / 86400000);
}
function addMonths(dateStr, n) {
  const p = String(dateStr).slice(0, 10).split('-').map(Number);
  if (p.length < 3 || p.some(isNaN)) return null;
  return new Date(Date.UTC(p[0], p[1] - 1 + n, p[2], 12)).toISOString().slice(0, 10);
}
function parseProgramme(programme) {
  const p = String(programme || '').toLowerCase();
  const mMois = p.match(/(\d+)\s*mois/), mSeances = p.match(/(\d+)\s*c\b/);
  return { mois: mMois ? parseInt(mMois[1], 10) : 0, seances: mSeances ? parseInt(mSeances[1], 10) : 0 };
}
function allSessions(c) {
  const out = [];
  if (c.years && c.years.length) c.years.forEach(function (y) { (y.sessions || []).forEach(function (s) { if (s) out.push(s); }); });
  else (c.sessions || []).forEach(function (s) { if (s) out.push(s); });
  return out;
}
function isOnboarding(s) { return s.numero === 0 || s.type === 'rdv72h'; }
function isActiveClient(c) { return c.statut !== 'inactif' && c.ancienClient !== true; }

// ---------------------------------------------------------------------------
//  Contexte (une lecture groupée par passage)
// ---------------------------------------------------------------------------

async function loadHealthContext() {
  const today = parisToday();
  const since = addMonths(today, -5);
  const [clientsSnap, paySnap, icSnap, leadsSnap, bkSnap, aiSnap, cfg] = await Promise.all([
    db.collection('clients').get(),
    db.collection('payments').get(),
    db.collection('invoice_clients').get(),
    db.collection('leads').where('isClient', '==', true).get(),
    db.collection('bookings').where('date', '>=', since).get(),
    db.collection('client_ai').get(),
    getAiConfig(),
  ]);
  const ctx = {
    today: today,
    rules: Object.assign({}, DEFAULT_RULES, cfg.riskRules || {}),
    clients: [], payByPerson: {}, payByLead: {}, payByEmail: {}, leadIdsByEmail: {},
    icByEmail: {}, icByPerson: {}, bkByClient: {}, bkByEmail: {}, ai: {},
  };
  clientsSnap.forEach(function (d) { ctx.clients.push(Object.assign({ id: d.id }, d.data() || {})); });
  function push(map, k, v) { if (!k) return; (map[k] = map[k] || []).push(v); }
  paySnap.forEach(function (d) {
    const p = Object.assign({ id: d.id }, d.data() || {});
    push(ctx.payByPerson, p.personId, p); push(ctx.payByLead, p.leadId, p); push(ctx.payByEmail, lower(p.leadEmail), p);
  });
  icSnap.forEach(function (d) {
    const ic = Object.assign({ id: d.id }, d.data() || {});
    if (ic.archived) return;
    push(ctx.icByEmail, lower(ic.email), ic); push(ctx.icByPerson, ic.personId, ic);
  });
  leadsSnap.forEach(function (d) { const l = d.data() || {}; if (l._merged) return; push(ctx.leadIdsByEmail, lower(l.email), d.id); });
  bkSnap.forEach(function (d) {
    const b = Object.assign({ id: d.id }, d.data() || {});
    if (!(b.isCoaching === true || b.clientId)) return;
    push(ctx.bkByClient, b.clientId, b);
    push(ctx.bkByEmail, lower(b.prospect && b.prospect.email), b);
  });
  aiSnap.forEach(function (d) { ctx.ai[d.id] = d.data() || {}; });
  return ctx;
}

function uniqById(arr) {
  const seen = {}, out = [];
  (arr || []).forEach(function (x) { if (x && !seen[x.id]) { seen[x.id] = 1; out.push(x); } });
  return out;
}

function paymentsOf(c, ctx) {
  const email = lower(c.email);
  let list = [].concat(ctx.payByPerson[c.personId] || [], ctx.payByEmail[email] || []);
  (ctx.leadIdsByEmail[email] || []).forEach(function (lid) { list = list.concat(ctx.payByLead[lid] || []); });
  return uniqById(list);
}
function invoiceClientsOf(c, ctx) {
  return uniqById([].concat(ctx.icByPerson[c.personId] || [], ctx.icByEmail[lower(c.email)] || []));
}
function bookingsOf(c, ctx) {
  return uniqById([].concat(ctx.bkByClient[c.id] || [], ctx.bkByEmail[lower(c.email)] || []));
}

// ---------------------------------------------------------------------------
//  Faits
// ---------------------------------------------------------------------------

function paymentFacts(c, ctx) {
  const issues = [];
  const today = ctx.today;
  const pays = paymentsOf(c, ctx);
  pays.forEach(function (p) {
    if (p.status === 'cancelled' || p.status === 'draft') return;
    const what = (p.description ? cap(p.description, 40) + ' — ' : '');
    if (p.status === 'mandate_failed') issues.push(what + 'mandat de prélèvement en échec');
    else if (p.status === 'failed') issues.push(what + 'paiement en échec');
    const f = p.lastPaymentFailure;
    if (f && f.at) {
      const fMs = tsToMs(f.at);
      const recovered = (p.paymentsHistory || []).some(function (h) { return tsToMs(h.eventAt || h.date) > fMs; });
      if (!recovered && Date.now() - fMs < 120 * 86400000) issues.push(what + 'prélèvement rejeté le ' + new Date(fMs).toLocaleDateString('fr-FR') + ' (' + (f.action || 'échec') + ')');
    }
    if ((p.status === 'active' || p.status === 'mandate_active') && Number(p.installmentsCount) > 1 && p.startDate) {
      const months = Math.floor((daysBetween(String(p.startDate).slice(0, 10), today) || 0) / 30.44);
      const expected = Math.min(Number(p.installmentsCount), Math.max(0, months) + 1);
      const behind = expected - (Number(p.paidCount) || 0);
      if (behind >= 2) issues.push(what + behind + ' échéances en retard');
    }
  });
  invoiceClientsOf(c, ctx).forEach(function (ic) {
    if (ic.clientStatus === 'procedure') issues.push('dossier en procédure / recouvrement');
  });
  const summary = pays.filter(function (p) { return p.status !== 'draft'; }).map(function (p) {
    return { id: p.id, status: p.status, total: Number(p.totalAmount) || 0, paid: Number(p.paidAmount) || 0,
      paidCount: Number(p.paidCount) || 0, count: Number(p.installmentsCount) || 1, lastFailure: p.lastPaymentFailure || null };
  });
  return { issues: issues, payments: summary };
}

function bookingFacts(c, ctx) {
  const today = ctx.today;
  const list = bookingsOf(c, ctx).filter(function (b) { return !(b.rescheduled || b.outcome === 'replanifie'); });
  const past = list.filter(function (b) { return String(b.date || '') < today; })
    .sort(function (a, b) { return String(b.date) + String(b.time || '') < String(a.date) + String(a.time || '') ? -1 : 1; });
  let streak = 0;
  for (let i = 0; i < past.length; i++) {
    const b = past[i];
    const origin = (b.cancellation && b.cancellation.origin) || b.cancelledOrigin || '';
    if (b.status === 'no_show' || (b.status === 'cancelled' && origin === 'prospect')) { streak++; continue; }
    if (b.status === 'cancelled') continue; // annulé par l'équipe / le système : neutre
    break;
  }
  const next = list.filter(function (b) { return String(b.date || '') >= today && b.status !== 'cancelled'; })
    .sort(function (a, b) { return String(a.date) + String(a.time || '') < String(b.date) + String(b.time || '') ? -1 : 1; })[0];
  return { missedStreak: streak, nextSession: next ? (next.date + (next.time ? ' ' + next.time : '')) : null };
}

async function academyFacts(c) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key || !c.email) return null;
  try {
    const ctrl = new AbortController();
    const t = setTimeout(function () { ctrl.abort(); }, 7000);
    const r = await fetch(ACADEMY_URL + '/api/bridge/seances', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ email: lower(c.email), action: 'lire', par: ACADEMY_ACTOR }),
    });
    clearTimeout(t);
    const j = await r.json().catch(function () { return null; });
    if (!j || j.ok === false || !Array.isArray(j.seances)) return null;
    const today = parisToday();
    let late = 0, nonHonorees = 0;
    j.seances.forEach(function (s) {
      if (s.statut === 'non_honoree' && (!s.date || (daysBetween(String(s.date).slice(0, 10), today) || 0) <= 60)) nonHonorees++;
      (s.devoirs || []).forEach(function (d) {
        const st = d.statut || 'a_faire';
        if (st === 'en_retard') late++;
        else if (st === 'a_faire' && d.echeance && String(d.echeance) < today) late++;
        else if (st === 'note' && String(d.note) === '0') late++;
      });
    });
    return { devoirsNonFaits: late, seancesNonHonorees: nonHonorees };
  } catch (e) { return null; }
}

function coreFacts(c, ctx) {
  const today = ctx.today;
  const sessions = allSessions(c).filter(function (s) { return !isOnboarding(s); });
  const done = sessions.filter(function (s) { return s.statut === 'fait' && s.date; })
    .sort(function (a, b) { return String(a.date) < String(b.date) ? -1 : 1; });
  const last = done.length ? done[done.length - 1] : null;
  const prog = parseProgramme(c.programme);
  const start = c.dateEntree || (done[0] && done[0].date) || null;
  const end = start && prog.mois ? addMonths(start, prog.mois) : null;
  return {
    sessionsDone: done.length,
    sessionsTotal: Number(c.nbCoachingsTotal) || prog.seances || null,
    lastSession: last ? last.date : null,
    daysSinceLastSession: last ? daysBetween(last.date, today) : null,
    daysSinceStart: start ? daysBetween(start, today) : null,
    contractEnd: end,
    daysToEnd: end ? daysBetween(today, end) : null,
    lastFollowupAt: tsToMs(c.lastCsmFollowupAt) || null,
    recentSessions: done.slice(-2).map(function (s) { return { date: s.date, coach: s.coach || '', resume: cap(s.resume || s.driveSummary || '', 900), devoirs: cap(s.devoirs || '', 400) }; }),
  };
}

// ---------------------------------------------------------------------------
//  Règles
// ---------------------------------------------------------------------------

function ruleLevel(f, rules, aiSignal) {
  const red = [], orange = [];
  (f.paymentIssues || []).forEach(function (x) { red.push('💸 ' + x); });
  const ds = f.daysSinceLastSession;
  const noSessionYet = ds == null;
  const ref = noSessionYet ? (f.daysSinceStart != null ? f.daysSinceStart - rules.newClientGraceDays : null) : ds;
  if (ref != null && ref > rules.redDays) red.push(noSessionYet ? '📅 aucune séance depuis l\'entrée (' + f.daysSinceStart + ' j)' : '📅 aucune séance depuis ' + ds + ' j');
  else if (ref != null && ref > rules.orangeDays) orange.push(noSessionYet ? '📅 pas encore de séance (' + f.daysSinceStart + ' j)' : '📅 aucune séance depuis ' + ds + ' j');
  if (f.missedStreak >= rules.missedStreak) red.push('🚫 ' + f.missedStreak + ' séances annulées / manquées d\'affilée');
  if (f.academy && f.academy.devoirsNonFaits >= rules.homeworkMissed) orange.push('📝 ' + f.academy.devoirsNonFaits + ' devoirs non faits');
  if (f.academy && f.academy.seancesNonHonorees >= rules.missedStreak) red.push('🚫 ' + f.academy.seancesNonHonorees + ' séances non honorées (Academy)');
  if (aiSignal && aiSignal.signalNegatif) orange.push('🤖 ' + aiSignal.raison);
  const level = red.length ? 'rouge' : (orange.length ? 'orange' : 'vert');
  return { level: level, reasons: red.concat(orange) };
}

// ---------------------------------------------------------------------------
//  Signal IA (Haiku) — uniquement si les échanges ont changé
// ---------------------------------------------------------------------------

const SIGNAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['signalNegatif', 'raison', 'opportunite', 'argument'],
  properties: {
    signalNegatif: { type: 'boolean', description: 'Vrai seulement si les textes montrent un désengagement, une insatisfaction, un blocage ou une intention d\'arrêter' },
    raison: { type: 'string', description: 'Une phrase factuelle (le signal, ou ce qui va bien)' },
    opportunite: { type: 'string', enum: ['aucune', 'renouvellement', 'upsell'] },
    argument: { type: 'string', description: 'Si opportunité : l\'argument le plus fort, tiré des progrès du client. Sinon vide.' },
  },
};

function signalKey(c, f) {
  return f.recentSessions.map(function (s) { return s.date + ':' + s.resume.length; }).join('|') + '#' + (c.csmNotes || []).length + '#' + (c.csmFollowupHistory || []).length;
}

async function computeSignal(c, f) {
  const P = [];
  P.push('CLIENT : ' + (c.nom || '?') + ' · ' + (c.programme || '') + ' · ' + f.sessionsDone + '/' + (f.sessionsTotal || '?') + ' séances' + (f.daysToEnd != null ? ' · fin de programme dans ' + f.daysToEnd + ' j' : ''));
  f.recentSessions.forEach(function (s) { P.push('SÉANCE ' + s.date + ' (' + s.coach + ') : ' + s.resume + (s.devoirs ? ' | devoirs : ' + s.devoirs : '')); });
  (c.csmNotes || []).slice(-4).forEach(function (n) { P.push('NOTE CSM : ' + cap(n.contenu || n.text || '', 300)); });
  (c.csmFollowupHistory || []).slice(-3).forEach(function (h) { P.push('SUIVI CSM (' + (h.channel || '') + ') : ' + cap(h.message || '', 300)); });
  if (c.clientNotes) P.push('NOTES COACH : ' + cap(c.clientNotes, 600));
  const r = await callClaude({
    task: 'client_risk',
    system: 'Tu es le Customer Success d\'Alteore (coaching business). Lis les derniers comptes-rendus de séance et notes, et dis s\'il y a un signal de désengagement / insatisfaction / blocage (sois factuel, pas alarmiste : un client qui avance ne déclenche rien), et s\'il y a une opportunité de renouvellement (fin de programme proche + client qui progresse) ou d\'upsell (besoin exprimé hors du programme actuel).',
    prompt: P.join('\n'),
    schema: SIGNAL_SCHEMA,
    ref: 'client:' + c.id,
  });
  return r.ok ? r.json : null;
}

// ---------------------------------------------------------------------------
//  Évaluation d'un client
// ---------------------------------------------------------------------------

/**
 * @param {Object} c client (avec id)
 * @param {Object} ctx loadHealthContext()
 * @param {Object} opts { withAcademy, withAi }
 * @returns {Promise<Object|null>} doc client_ai à écrire (null si client inactif)
 */
async function evaluateClient(c, ctx, opts) {
  opts = opts || {};
  if (!isActiveClient(c)) return null;
  const f = coreFacts(c, ctx);
  const pf = paymentFacts(c, ctx);
  const bf = bookingFacts(c, ctx);
  f.paymentIssues = pf.issues;
  f.payments = pf.payments;
  f.missedStreak = bf.missedStreak;
  f.nextSession = bf.nextSession;
  f.academy = opts.withAcademy ? await academyFacts(c) : ((ctx.ai[c.id] && ctx.ai[c.id].risk && ctx.ai[c.id].risk.facts && ctx.ai[c.id].risk.facts.academy) || null);

  const prev = ctx.ai[c.id] || {};
  let signal = prev.signal || null;
  const key = signalKey(c, f);
  if (opts.withAi && f.recentSessions.length && (!signal || signal.key !== key)) {
    const s = await computeSignal(c, f);
    if (s) signal = Object.assign({}, s, { key: key, at: Date.now() });
  }
  const lv = ruleLevel(f, ctx.rules, signal);

  let opportunity = null;
  if (lv.level !== 'rouge') {
    if (signal && signal.opportunite && signal.opportunite !== 'aucune') opportunity = { type: signal.opportunite, argument: signal.argument || '', daysToEnd: f.daysToEnd };
    else if (f.daysToEnd != null && f.daysToEnd >= 0 && f.daysToEnd <= 60) opportunity = { type: 'renouvellement', argument: '', daysToEnd: f.daysToEnd };
  }

  delete f.recentSessions;
  return {
    clientId: c.id,
    nom: c.nom || '',
    email: lower(c.email),
    coach: c.coachAssigned || c.coach || '',
    programme: c.programme || '',
    risk: {
      level: lv.level,
      reasons: lv.reasons,
      reason: lv.reasons.length ? lv.reasons[0].replace(/^\S+\s/, '') : ((signal && signal.raison) || 'Rien à signaler'),
      facts: f,
      computedAt: Date.now(),
    },
    prevLevel: (prev.risk && prev.risk.level) || null,
    signal: signal,
    opportunity: opportunity,
    updatedAt: Date.now(),
  };
}

/** Écrit client_ai/{id} et crée une alerte si le niveau s'aggrave. */
async function saveEvaluation(doc) {
  // merge : préserve les champs écrits ailleurs (diagnostic du cockpit CSM).
  await db.collection('client_ai').doc(doc.clientId).set(doc, { merge: true });
  const before = LEVEL_RANK[doc.prevLevel] != null ? LEVEL_RANK[doc.prevLevel] : 0;
  const after = LEVEL_RANK[doc.risk.level];
  if (after > before) {
    await db.collection('ai_alerts').add({
      type: 'client_risk', clientId: doc.clientId, clientName: doc.nom, coach: doc.coach,
      level: doc.risk.level, reasons: doc.risk.reasons, status: 'open', createdAt: Date.now(),
    });
  } else if (after < before) {
    // Le client va mieux : on ferme les alertes plus graves que son niveau actuel.
    await resolveAlerts(doc.clientId, after);
  }
}

/** Ferme les alertes ouvertes d'un client dont le niveau dépasse `maxRank` (-1 = toutes). */
async function resolveAlerts(clientId, maxRank) {
  const open = await db.collection('ai_alerts').where('clientId', '==', clientId).get();
  const batch = db.batch();
  let n = 0;
  open.forEach(function (d) {
    const a = d.data() || {};
    if (a.status !== 'open') return;
    if (maxRank >= 0 && (LEVEL_RANK[a.level] || 0) <= maxRank) return;
    batch.update(d.ref, { status: 'resolved', resolvedAt: Date.now() });
    n++;
  });
  if (n) await batch.commit();
}

module.exports = {
  DEFAULT_RULES: DEFAULT_RULES, LEVEL_RANK: LEVEL_RANK,
  loadHealthContext: loadHealthContext, evaluateClient: evaluateClient, saveEvaluation: saveEvaluation, resolveAlerts: resolveAlerts,
  isActiveClient: isActiveClient, paymentsOf: paymentsOf, invoiceClientsOf: invoiceClientsOf, bookingsOf: bookingsOf,
  allSessions: allSessions, parseProgramme: parseProgramme, addMonths: addMonths, daysBetween: daysBetween, lower: lower,
};
