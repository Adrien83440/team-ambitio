// ============================================================================
// api/ai-client-risk.js — RISQUE CLIENT + ALERTES (programme IA, Lot 3)
// ----------------------------------------------------------------------------
// GET  Bearer <CRON_SECRET> (cron quotidien 05:20 UTC, avant le brief du
//      matin) → évalue tous les clients actifs (règles + Academy + signal IA
//      si les échanges ont changé), écrit client_ai/{id}, crée les alertes.
// POST Bearer <ID token> (admin / csm / coach)
//      { action:'recompute', clientId }  → réévalue un client tout de suite
//      { action:'alerts' }               → alertes ouvertes (coach : ses
//                                          clients seulement)
//      { action:'ack', alertId }         → marque une alerte comme vue
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const H = require('./_clientHealth');

const ROLES = ['admin', 'csm', 'coach'];
const AI_MAX_PER_RUN = 30;
const CONCURRENCY = 5;

async function myCoachKeys(uid) {
  const keys = {};
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? s.data().members : null;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    list.forEach(function (m) {
      if (m && m.firebaseUid === uid) [m.slug, m.shortName, m.displayName, m.fullName].forEach(function (k) { if (k) keys[H.lower(k)] = 1; });
    });
  } catch (e) { /* aucun filtre possible */ }
  return keys;
}

async function runCron(res) {
  const ctx = await H.loadHealthContext();
  const active = ctx.clients.filter(H.isActiveClient);
  const out = { ok: true, clients: active.length, rouge: 0, orange: 0, vert: 0, aiCalls: 0, errors: [] };
  let aiBudget = AI_MAX_PER_RUN;
  let i = 0;
  async function worker() {
    while (i < active.length) {
      const c = active[i++];
      try {
        const useAi = aiBudget > 0;
        const prevSig = ctx.ai[c.id] && ctx.ai[c.id].signal;
        const doc = await H.evaluateClient(c, ctx, { withAcademy: true, withAi: useAi });
        if (!doc) continue;
        if (doc.signal && (!prevSig || prevSig.at !== doc.signal.at)) { aiBudget--; out.aiCalls++; }
        await H.saveEvaluation(doc);
        out[doc.risk.level]++;
      } catch (e) { out.errors.push(c.id + ':' + (e && e.message)); }
    }
  }
  const ws = [];
  for (let k = 0; k < CONCURRENCY; k++) ws.push(worker());
  await Promise.all(ws);
  res.status(200).json(out);
}

module.exports = async function (req, res) {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { await runCron(res); } catch (e) { console.error('[ai-client-risk] cron', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);

  try {
    if (body.action === 'recompute') {
      const id = String(body.clientId || '').trim();
      if (!id) { res.status(400).json({ ok: false, error: 'clientId_required' }); return; }
      const ctx = await H.loadHealthContext();
      const c = ctx.clients.find(function (x) { return x.id === id; });
      if (!c) { res.status(404).json({ ok: false, error: 'client_not_found' }); return; }
      // light : recalcul « temps réel » après une sauvegarde de fiche coaching
      // (règles seules — pas d'appel Academy ni IA ; le cron de nuit complète).
      const light = body.light === true;
      const doc = await H.evaluateClient(c, ctx, { withAcademy: !light, withAi: !light });
      if (!doc) {
        // Client devenu inactif : ses alertes n'ont plus lieu d'être.
        await H.resolveAlerts(id, -1);
        res.status(200).json({ ok: true, inactive: true });
        return;
      }
      await H.saveEvaluation(doc);
      res.status(200).json({ ok: true, ai: doc });
      return;
    }

    if (body.action === 'alerts') {
      const snap = await db.collection('ai_alerts').where('status', '==', 'open').limit(200).get();
      const keys = auth.role === 'coach' ? await myCoachKeys(auth.uid) : null;
      const raw = [];
      snap.forEach(function (d) {
        const a = d.data() || {};
        if (keys && !keys[H.lower(a.coach)]) return;
        if ((a.seenBy || []).indexOf(auth.uid) >= 0) return;
        raw.push({ id: d.id, a: a });
      });
      // État ACTUEL du client (client_ai, mis à jour en temps réel à chaque
      // sauvegarde de fiche) : une alerte dont le client est repassé au vert
      // disparaît, et on affiche les raisons du moment, pas celles d'hier.
      // Réévaluation « light » (règles seules) des clients concernés, à
      // chaque ouverture : l'affichage reste juste même si le changement vient
      // d'ailleurs (séance saisie dans un autre onglet, RDV, paiement…).
      const ids = Array.from(new Set(raw.map(function (x) { return x.a.clientId; }).filter(Boolean)));
      const cur = {};
      if (ids.length) {
        const ctx = await H.loadHealthContext();
        for (const cid of ids) {
          const c = ctx.clients.find(function (x) { return x.id === cid; });
          if (!c) continue;
          const doc = await H.evaluateClient(c, ctx, { withAcademy: false, withAi: false });
          if (!doc) { await H.resolveAlerts(cid, -1); continue; }
          const prev = ctx.ai[cid] && ctx.ai[cid].risk;
          if (!prev || prev.level !== doc.risk.level || JSON.stringify(prev.reasons) !== JSON.stringify(doc.risk.reasons)) await H.saveEvaluation(doc);
          cur[cid] = doc;
        }
      }
      const items = [];
      const seenClient = {};
      raw.forEach(function (x) {
        const a = x.a;
        const now = cur[a.clientId] && cur[a.clientId].risk;
        if (!now || now.level === 'vert') return;
        if (seenClient[a.clientId]) return; // une seule ligne par client
        seenClient[a.clientId] = 1;
        items.push({ id: x.id, type: a.type, clientId: a.clientId, clientName: a.clientName, coach: a.coach,
          level: now.level, reasons: now.reasons || a.reasons || [], createdAt: a.createdAt });
      });
      items.sort(function (a, b) { return (a.level === 'rouge' ? 0 : 1) - (b.level === 'rouge' ? 0 : 1) || (b.createdAt || 0) - (a.createdAt || 0); });
      res.status(200).json({ ok: true, items: items });
      return;
    }

    if (body.action === 'ack') {
      const ref = db.collection('ai_alerts').doc(String(body.alertId || ''));
      const s = await ref.get();
      if (!s.exists) { res.status(404).json({ ok: false, error: 'not_found' }); return; }
      const seen = (s.data().seenBy || []).concat([auth.uid]);
      await ref.update({ seenBy: seen, lastSeenAt: Date.now() });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown_action' });
  } catch (e) {
    console.error('[ai-client-risk]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
