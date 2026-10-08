// ============================================================================
// api/payments-unpaid.js — MODULE IMPAYÉS (programme IA, Lot 3) — admin only
// ----------------------------------------------------------------------------
// Pas de relance automatique : Alteore travaille avec un cabinet de
// recouvrement. Ce module RASSEMBLE l'information pour le suivi :
//
// GET                         → dossiers à problème (plans de paiement) :
//     mandat / paiement en échec, dernier prélèvement rejeté non rattrapé,
//     échéances en retard, dossier marqué « recouvrement », facturation en
//     procédure — avec client, closer, montants, état du recouvrement.
// POST { action:'history', paymentId }
//     → historique LIVE des prélèvements GoCardless du mandat (tous statuts,
//       y compris failed / charged_back, avec la cause GoCardless). Le doc
//       payments ne garde que les succès et le DERNIER rejet, sans cause.
// POST { action:'recouvrement', paymentId, status, note }
//     → payments/{id}.recouvrement = { status, note, at, by, history[] }
//       status ∈ a_transmettre | transmis | en_cours | regle | abandonne | ''
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { tsToMs } = require('./_ai');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox' ? 'https://api-sandbox.gocardless.com' : 'https://api.gocardless.com';
const RECOUVREMENT = ['', 'a_transmettre', 'transmis', 'en_cours', 'regle', 'abandonne'];

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN non configuré');
  const r = await fetch(GC_BASE + path, { headers: { 'Authorization': 'Bearer ' + token, 'GoCardless-Version': '2015-07-06', 'Accept': 'application/json' } });
  if (r.status === 404) return null;
  const j = await r.json();
  if (!r.ok) throw new Error('GoCardless ' + r.status + ' : ' + JSON.stringify(j.error || j).slice(0, 200));
  return j;
}

function parisToday() { return new Date().toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function monthsSince(dateStr, today) {
  const a = String(dateStr).slice(0, 10).split('-').map(Number), b = today.split('-').map(Number);
  if (a.length < 3 || a.some(isNaN)) return 0;
  return (b[0] - a[0]) * 12 + (b[1] - a[1]) - (b[2] < a[2] ? 1 : 0);
}

async function listUnpaid() {
  const today = parisToday();
  const [paySnap, icSnap] = await Promise.all([db.collection('payments').get(), db.collection('invoice_clients').where('clientStatus', '==', 'procedure').get()]);
  const procByCustomer = {}, procByEmail = {};
  icSnap.forEach(function (d) {
    const ic = d.data() || {};
    if (ic.gcCustomerId) procByCustomer[ic.gcCustomerId] = ic;
    if (ic.gocardlessCustomerId) procByCustomer[ic.gocardlessCustomerId] = ic;
    if (ic.email) procByEmail[String(ic.email).toLowerCase()] = ic;
  });
  const items = [];
  paySnap.forEach(function (d) {
    const p = d.data() || {};
    if (p.status === 'draft' || p.status === 'cancelled') return;
    const issues = [];
    let severity = 0;
    if (p.status === 'mandate_failed') { issues.push('Mandat en échec' + (p.mandateFailedReason ? ' (' + p.mandateFailedReason + ')' : '')); severity = 2; }
    if (p.status === 'failed') { issues.push('Paiement en échec'); severity = 2; }
    const f = p.lastPaymentFailure;
    if (f && f.at) {
      const fMs = tsToMs(f.at);
      const recovered = (p.paymentsHistory || []).some(function (h) { return tsToMs(h.eventAt || h.date) > fMs; });
      if (!recovered) { issues.push('Prélèvement rejeté le ' + new Date(fMs).toLocaleDateString('fr-FR') + ' (' + (f.action || 'échec') + ')'); severity = Math.max(severity, 2); }
    }
    let behind = 0;
    if ((p.status === 'active' || p.status === 'mandate_active') && Number(p.installmentsCount) > 1 && p.startDate) {
      const expected = Math.min(Number(p.installmentsCount), Math.max(0, monthsSince(p.startDate, today)) + 1);
      behind = expected - (Number(p.paidCount) || 0);
      if (behind >= 1) { issues.push(behind + ' échéance' + (behind > 1 ? 's' : '') + ' en retard'); severity = Math.max(severity, behind >= 2 ? 2 : 1); }
    }
    const proc = procByCustomer[p.gcCustomerId] || procByEmail[String(p.leadEmail || '').toLowerCase()];
    if (proc) { issues.push('Facturation en procédure'); severity = 2; }
    const rec = p.recouvrement || null;
    if (rec && rec.status && rec.status !== 'regle' && rec.status !== 'abandonne') severity = Math.max(severity, 1);
    if (!issues.length && !(rec && rec.status)) return;
    const total = Number(p.totalAmount) || 0, paid = Number(p.paidAmount) || 0;
    items.push({
      id: d.id,
      client: p.leadName || p.contactName || '(sans nom)',
      email: p.leadEmail || '',
      phone: p.leadPhone || '',
      leadId: p.leadId || null,
      closer: p.closerName || '',
      description: p.description || '',
      status: p.status,
      totalAmount: total,
      paidAmount: paid,
      dueAmount: Math.max(0, Math.round((total - paid) * 100) / 100),
      installmentAmount: Number(p.installmentAmount) || 0,
      paidCount: Number(p.paidCount) || 0,
      installmentsCount: Number(p.installmentsCount) || 1,
      behind: behind,
      startDate: p.startDate || null,
      lastFailure: f || null,
      issues: issues,
      severity: severity,
      recouvrement: rec,
      hasMandate: !!p.gcMandateId,
      createdAt: tsToMs(p.createdAt) || null,
    });
  });
  items.sort(function (a, b) { return b.severity - a.severity || b.dueAmount - a.dueAmount; });
  const kpis = {
    dossiers: items.length,
    critiques: items.filter(function (x) { return x.severity >= 2; }).length,
    montantRestant: Math.round(items.reduce(function (s, x) { return s + x.dueAmount; }, 0)),
    chezCabinet: items.filter(function (x) { return x.recouvrement && (x.recouvrement.status === 'transmis' || x.recouvrement.status === 'en_cours'); }).length,
  };
  return { items: items, kpis: kpis };
}

module.exports = async function (req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    if (req.method === 'GET') { res.status(200).json(Object.assign({ ok: true }, await listUnpaid())); return; }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
    const body = parseBody(req);
    const ref = db.collection('payments').doc(String(body.paymentId || ''));
    const s = await ref.get();
    if (!s.exists) { res.status(404).json({ ok: false, error: 'payment_not_found' }); return; }
    const p = s.data() || {};

    if (body.action === 'history') {
      if (!p.gcMandateId) { res.status(200).json({ ok: true, events: [], note: 'Aucun mandat GoCardless sur ce dossier.' }); return; }
      const list = await gcGet('/payments?mandate=' + encodeURIComponent(p.gcMandateId) + '&sort_field=charge_date&sort_direction=desc&limit=100');
      const pays = (list && list.payments) || [];
      // Cause des échecs : événements GoCardless de chaque prélèvement raté.
      const events = [];
      for (const gp of pays) {
        const ev = { id: gp.id, status: gp.status, amount: gp.amount / 100, chargeDate: gp.charge_date, description: gp.description || '', cause: null, detail: null };
        if (['failed', 'charged_back', 'cancelled', 'customer_approval_denied'].indexOf(gp.status) >= 0) {
          try {
            const e = await gcGet('/events?payment=' + encodeURIComponent(gp.id) + '&limit=20');
            const fail = ((e && e.events) || []).filter(function (x) { return ['failed', 'charged_back', 'cancelled', 'chargeback_settled', 'customer_approval_denied'].indexOf(x.action) >= 0; })[0];
            if (fail && fail.details) { ev.cause = fail.details.cause || null; ev.detail = fail.details.description || null; ev.reasonCode = fail.details.reason_code || null; ev.at = fail.created_at; }
          } catch (er) { ev.detail = 'Cause indisponible (' + er.message + ')'; }
        }
        events.push(ev);
      }
      res.status(200).json({ ok: true, events: events });
      return;
    }

    if (body.action === 'recouvrement') {
      const st = String(body.status || '');
      if (RECOUVREMENT.indexOf(st) < 0) { res.status(400).json({ ok: false, error: 'bad_status' }); return; }
      const prev = p.recouvrement || {};
      const entry = { status: st, note: String(body.note || '').slice(0, 1000), at: Date.now(), by: auth.email || auth.uid };
      await ref.update({ recouvrement: { status: st, note: entry.note, at: entry.at, by: entry.by, history: (prev.history || []).concat([entry]).slice(-30) } });
      res.status(200).json({ ok: true });
      return;
    }
    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[payments-unpaid]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
