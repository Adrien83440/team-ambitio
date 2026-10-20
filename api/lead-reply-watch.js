// ============================================================================
// api/lead-reply-watch.js — VEILLE « PROSPECT SANS RÉPONSE » (Leads Live)
// ----------------------------------------------------------------------------
// Toutes les 10 min (cron Vercel). Un prospect qui nous écrit (SMS Twilio,
// SMS Ringover, WhatsApp, e-mail humain relevé par gmail-inbound-sync) et qui n'a reçu AUCUNE réponse 2 h ouvrées plus
// tard déclenche une popup ⚡ ciblée sur les admins (cloche Infos équipe,
// collection `announcements`, même mécanisme que Mes Notes CSM).
//
// Heures ouvrées : lundi → samedi, 9 h → 20 h, heure de Paris. Un message reçu
// à 23 h donne donc une alerte à 11 h le lendemain s'il est resté sans suite.
//
// Compte comme une réponse, postérieure au message entrant :
//   • un SMS sortant dans `leads.communications` ;
//   • un WhatsApp humain (`leads.whatsappEnvoye.at`, posé par whatsapp-send) ;
//   • un e-mail envoyé DEPUIS LA FICHE par l'équipe (ownerUid / ownerName,
//     ou source 'app') — jamais une confirmation ou une relance automatique ;
//   • un appel DÉCROCHÉ avec une vraie conversation dans `call_logs` (par
//     leadId ou par numéro, sortant ou entrant). Règle validée par Adrien le
//     19/10/2026 : une messagerie, un répondeur ou un appel sans décroché ne
//     remplace PAS une réponse écrite. Décroché = règle du Funnel
//     (funnel-core.js isAnsweredCall : ≥ 5 s de parole, pas la signature
//     répondeur sonnerie ≥ 15 s + parole < 15 s), et ni AMD répondeur ni
//     analyse IA « messagerie » / « faux_numero ».
//   Les appels de `leads.communications` (via Make) ne comptent pas : ils ne
//   disent pas si quelqu'un a décroché.
//
// Exclus : numéros sans fiche lead, fiches `_merged`, clients déjà closés.
// Une seule popup par prospect tant qu'il reste sans réponse ; elle est
// archivée (active:false, rien n'est supprimé) dès qu'une réponse est vue.
//
// Flag : _config/lead_reply_watch { enabled, enabledAt, delayMinutes,
//        startHour, endHour, recipients:[slugs] }
//   • enabledAt est posé au premier passage s'il manque : tout message
//     antérieur à l'activation est ignoré (pas de rafale au démarrage).
//   • recipients vide → tous les comptes `users.role == 'admin'` actifs.
// Trace : lead_reply_alerts/{leadId}_{inboundMs} (écriture serveur seule).
//
// GET  Bearer <CRON_SECRET>                         → passe complète
// POST Bearer <ID token admin> { dryRun:true }      → ce qui serait alerté,
//                                                     sans aucune écriture
// POST Bearer <ID token admin> { action:'run' }     → passe complète
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');

const CFG_DOC = 'lead_reply_watch';
const DEFAULT_DELAY_MIN = 120;
const DEFAULT_START = 9;
const DEFAULT_END = 20;
const LOOKBACK_MS = 5 * 86400000;   // couvre un week-end entier d'heures fermées
const TYPES = { sms: 'SMS', whatsapp: 'WhatsApp', email: 'e-mail' };
const DEPARTED = { guillaumes: 1 };

/* ── Dates ─────────────────────────────────────────────────────────────── */
function toMs(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  if (v.seconds) return v.seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

const FMT = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function parisParts(ms) {
  const o = {};
  FMT.formatToParts(new Date(ms)).forEach(function (p) { o[p.type] = p.value; });
  return { y: +o.year, mo: +o.month, d: +o.day, h: +o.hour, mi: +o.minute, s: +o.second, dow: DOW[o.weekday] };
}
function wallMs(p) { return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s); }
// Instant UTC correspondant à y-mo-d h:00 heure de Paris (débordement de jour géré par Date.UTC).
function parisMs(y, mo, d, h) {
  const guess = Date.UTC(y, mo - 1, d, h, 0, 0);
  let res = guess - (wallMs(parisParts(guess)) - guess);
  res = guess - (wallMs(parisParts(res)) - res);
  return res;
}
// startMs + durMs, en ne comptant que les heures ouvrées (lun-sam, start→end).
function addBusiness(startMs, durMs, startH, endH) {
  let t = startMs;
  let rem = durMs;
  for (let i = 0; i < 40; i++) {
    const p = parisParts(t);
    const open = parisMs(p.y, p.mo, p.d, startH);
    const close = parisMs(p.y, p.mo, p.d, endH);
    if (p.dow === 0 || t >= close) { t = parisMs(p.y, p.mo, p.d + 1, startH); continue; }
    if (t < open) t = open;
    const avail = close - t;
    if (rem <= avail) return t + rem;
    rem -= avail;
    t = close;
  }
  return t + rem;
}
function frDate(ms) {
  return new Date(ms).toLocaleString('fr-FR', {
    timeZone: 'Europe/Paris', weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
  });
}

/* ── Équipe ────────────────────────────────────────────────────────────── */
async function teamMembers() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    if (Array.isArray(raw)) return raw.filter(Boolean);
    return Object.keys(raw || {}).map(function (k) { return Object.assign({ slug: k }, raw[k]); });
  } catch (e) { return []; }
}
function isActive(m) { return m && m.active !== false && !m.archivedAt && !DEPARTED[m.slug]; }
function nameOf(m, fallback) { return m ? (m.shortName || m.displayName || m.fullName || fallback) : fallback; }

async function recipients(cfg, members) {
  const slugs = Array.isArray(cfg.recipients) ? cfg.recipients.map(String) : [];
  const out = [];
  if (slugs.length) {
    members.forEach(function (m) {
      if (slugs.indexOf(String(m.slug)) >= 0 && isActive(m) && m.firebaseUid) out.push({ uid: String(m.firebaseUid), name: nameOf(m, m.slug) });
    });
    return out;
  }
  const us = await db.collection('users').where('role', '==', 'admin').get();
  us.forEach(function (d) {
    const u = d.data() || {};
    if (u.disabled === true || u.active === false) return;
    const m = members.find(function (x) { return x && String(x.firebaseUid || '') === d.id; });
    if (m && !isActive(m)) return;
    out.push({ uid: d.id, name: nameOf(m, u.displayName || u.name || u.email || d.id) });
  });
  return out;
}

/* ── Lead ──────────────────────────────────────────────────────────────── */
function isClient(l) {
  return l.isClient === true || l.status === 'client' || !!l.clientSince ||
    String(l.stage || '').indexOf('closed_won') === 0;
}
function isOut(dir) { return /^out/i.test(String(dir || '')); }

// Dernière réponse visible sur la fiche (sans requête supplémentaire).
function replyFromLead(l) {
  let last = 0;
  (Array.isArray(l.communications) ? l.communications : []).forEach(function (c) {
    if (!c || !isOut(c.direction)) return;
    if (c.type === 'email') {
      // Seul un e-mail écrit par l'équipe répond au prospect.
      if (!c.ownerUid && !c.ownerName && c.source !== 'app') return;
    } else if (c.type !== 'sms' && c.type !== 'whatsapp') return;
    const ms = toMs(c.date) || toMs(c.createdAt);
    if (ms > last) last = ms;
  });
  const wa = l.whatsappEnvoye && toMs(l.whatsappEnvoye.at);
  if (wa > last) last = wa;
  return last;
}
// Vraie conversation téléphonique — même seuils que funnel-core.js / team-pilotage.js.
const ANSWERED_MIN_SEC = 5;
const VOICEMAIL_MIN_RING_SEC = 15;
const VOICEMAIL_MAX_TALK_SEC = 15;
function isConversation(c) {
  if (c.amd === true) return false;
  const ia = c.aiCall && c.aiCall.resultat;
  if (ia === 'messagerie' || ia === 'faux_numero') return false;
  const talk = Number(c.durationSec) || 0;
  if (talk < ANSWERED_MIN_SEC) return false;
  let ring = Number(c.ringingDurationSec);
  if (c.ringingDurationSec == null || !isFinite(ring) || ring < 0) {
    const a = toMs(c.answeredAt), i = toMs(c.initiatedAt);
    ring = a && i && a >= i ? Math.round((a - i) / 1000) : null;
  }
  if (ring == null) return true;
  return !(ring >= VOICEMAIL_MIN_RING_SEC && talk < VOICEMAIL_MAX_TALK_SEC);
}

// Appels aboutis du journal téléphonique (dialer, Ringover app, Twilio).
async function replyFromCalls(leadId, tel) {
  let last = 0;
  const qs = [db.collection('call_logs').where('leadId', '==', leadId).get()];
  // call_logs.toNumber / fromNumber sont en E.164 ; certaines fiches gardent un 06… brut.
  const raw = String(tel || '').replace(/[\s.\-()]/g, '');
  const e164 = /^0\d{9}$/.test(raw) ? '+33' + raw.slice(1) : (/^33\d{9}$/.test(raw) ? '+' + raw : raw);
  [raw, e164].filter(function (v, k, arr) { return v && arr.indexOf(v) === k; }).forEach(function (n) {
    qs.push(db.collection('call_logs').where('toNumber', '==', n).get());
    qs.push(db.collection('call_logs').where('fromNumber', '==', n).get());
  });
  const snaps = await Promise.all(qs.map(function (p) { return p.catch(function () { return null; }); }));
  snaps.forEach(function (s) {
    if (!s) return;
    s.forEach(function (d) {
      const c = d.data() || {};
      if (!isConversation(c)) return;
      const ms = toMs(c.initiatedAt) || toMs(c.createdAt);
      if (ms > last) last = ms;
    });
  });
  return last;
}

/* ── Passe ─────────────────────────────────────────────────────────────── */
async function run(opts) {
  const dry = !!(opts && opts.dryRun);
  const now = Date.now();
  const cfgRef = db.collection('_config').doc(CFG_DOC);
  const cfgSnap = await cfgRef.get();
  const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
  if (cfg.enabled !== true && !dry) return { skipped: 'disabled' };

  let enabledAt = toMs(cfg.enabledAt);
  if (!enabledAt) {
    if (dry) enabledAt = now - LOOKBACK_MS;
    else { await cfgRef.set({ enabledAt: now }, { merge: true }); return { initialized: true, enabledAt: now }; }
  }
  const delayMs = (Number(cfg.delayMinutes) > 0 ? Number(cfg.delayMinutes) : DEFAULT_DELAY_MIN) * 60000;
  const startH = Number.isInteger(cfg.startHour) ? cfg.startHour : DEFAULT_START;
  const endH = Number.isInteger(cfg.endHour) && cfg.endHour > startH ? cfg.endHour : DEFAULT_END;
  const since = Math.max(enabledAt, now - LOOKBACK_MS);

  // 1. Messages entrants récents, regroupés par lead.
  const ns = await db.collection('inbox_notifications').where('createdAt', '>=', new Date(since)).get();
  const byLead = {};
  ns.forEach(function (d) {
    const n = d.data() || {};
    // copyOf : copie de la cloche pour le closer — un seul message compté.
    if (n.direction !== 'inbound' || !TYPES[n.type] || !n.leadId || n.copyOf) return;
    const ms = toMs(n.createdAt);
    if (!ms || ms < since) return;
    (byLead[n.leadId] = byLead[n.leadId] || []).push({
      id: d.id, ms: ms, type: n.type, preview: String(n.preview || n.text || n.content || '').slice(0, 200),
    });
  });

  // 2. Alertes encore ouvertes (pour les archiver quand une réponse arrive).
  const openByLead = {};
  const os = await db.collection('lead_reply_alerts').where('status', '==', 'open').get();
  os.forEach(function (d) { const a = d.data() || {}; if (a.leadId) openByLead[a.leadId] = Object.assign({ id: d.id }, a); });

  const leadIds = Object.keys(Object.assign({}, byLead, openByLead));
  if (!leadIds.length) return { leads: 0, created: 0, closed: 0 };

  const leadSnaps = await db.getAll.apply(db, leadIds.map(function (id) { return db.collection('leads').doc(id); }));
  const members = await teamMembers();
  let targets = null;
  const created = [], closed = [], pending = [];

  async function closeAlert(a, status, extra) {
    closed.push({ leadId: a.leadId, nom: a.leadName, status: status });
    if (dry) return;
    const at = new Date();
    await db.collection('lead_reply_alerts').doc(a.id).set(Object.assign({ status: status, closedAt: at }, extra || {}), { merge: true });
    if (a.announcementId) {
      await db.collection('announcements').doc(a.announcementId)
        .set({ active: false, archivedAt: at, archivedReason: 'lead_reply_watch:' + status }, { merge: true })
        .catch(function (e) { console.warn('[lead-reply-watch] archive', a.announcementId, e.message); });
    }
  }

  for (let i = 0; i < leadSnaps.length; i++) {
    const snap = leadSnaps[i];
    const leadId = leadIds[i];
    const open = openByLead[leadId] || null;
    try {
      const l = snap.exists ? (snap.data() || {}) : null;
      if (!l || l._merged || isClient(l)) {
        if (open) await closeAlert(open, 'excluded');
        continue;
      }
      const msgs = (byLead[leadId] || []).sort(function (a, b) { return a.ms - b.ms; });
      // Le journal d'appels n'est interrogé que si la fiche ne montre pas déjà
      // une réponse postérieure au message le plus récent à surveiller.
      const latest = Math.max(open ? open.inboundAtMs : 0, msgs.length ? msgs[msgs.length - 1].ms : 0);

      let lastReply = replyFromLead(l);
      if (lastReply < latest) {
        lastReply = Math.max(lastReply, await replyFromCalls(leadId, l.telephone || null));
      }

      if (open && lastReply > open.inboundAtMs) {
        await closeAlert(open, 'answered', { answeredAt: new Date(lastReply) });
      }
      const unanswered = msgs.filter(function (m) { return m.ms > lastReply; });
      if (!unanswered.length) continue;

      if (open && lastReply <= open.inboundAtMs) {
        // Toujours sans réponse : on enrichit l'alerte existante, sans nouvelle popup.
        if (!dry) {
          await db.collection('lead_reply_alerts').doc(open.id).set({
            lastInboundAtMs: unanswered[unanswered.length - 1].ms, messagesCount: unanswered.length, checkedAt: new Date(),
          }, { merge: true });
        }
        continue;
      }

      const first = unanswered[0];
      const lastMsg = unanswered[unanswered.length - 1];
      const deadline = addBusiness(first.ms, delayMs, startH, endH);
      const nom = l.nom || l.fullName || [l.prenom, l.nomFamille].filter(Boolean).join(' ') || 'Prospect';
      if (now < deadline) { pending.push({ leadId: leadId, nom: nom, alerteA: new Date(deadline).toISOString() }); continue; }

      const owner = l.assignedTo ? members.find(function (m) { return m && m.slug === l.assignedTo; }) : null;
      const canaux = unanswered.map(function (m) { return TYPES[m.type]; })
        .filter(function (v, k, arr) { return arr.indexOf(v) === k; }).join(' + ');
      created.push({ leadId: leadId, nom: nom, depuis: new Date(first.ms).toISOString(), canaux: canaux, messages: unanswered.length });
      if (dry) continue;

      const alertId = leadId + '_' + first.ms;
      const alertRef = db.collection('lead_reply_alerts').doc(alertId);
      const exists = await alertRef.get();
      if (exists.exists) continue;   // déjà alerté pour ce message (rejeu du cron)

      if (!targets) targets = await recipients(cfg, members);
      if (!targets.length) { console.warn('[lead-reply-watch] aucun destinataire'); continue; }

      const heures = Math.round(delayMs / 3600000 * 10) / 10;
      const body = nom + ' nous a écrit par ' + canaux + ' le ' + frDate(first.ms) +
        (unanswered.length > 1 ? ' (' + unanswered.length + ' messages)' : '') +
        ' et n\'a reçu aucune réponse des setters / closers depuis ' + heures + ' h ouvrées.\n\n' +
        'Dernier message : « ' + (lastMsg.preview || '—') + ' »\n' +
        'Assigné à : ' + (owner ? nameOf(owner, l.assignedTo) : (l.assignedTo || 'personne'));
      const links = [{ label: 'Ouvrir dans Leads Live', url: 'https://team.alteore.com/sales-leads.html?leadId=' + encodeURIComponent(leadId) }];
      if (unanswered.some(function (m) { return m.type === 'whatsapp'; }) && l.telephone) {
        links.push({ label: 'Ouvrir le WhatsApp', url: 'https://team.alteore.com/whatsapp.html?n=' + encodeURIComponent(String(l.telephone).replace(/^\+/, '')) });
      }
      const ann = await db.collection('announcements').add({
        title: '⏰ Sans réponse — ' + nom,
        body: body,
        links: links,
        audience: ['admin'],
        targets: targets.map(function (t) { return t.uid; }),
        targetsNames: targets.map(function (t) { return t.name; }),
        popup: true,
        urgent: true,
        active: true,
        createdAt: new Date(),
        createdBy: 'system',
        createdByName: 'Veille réponses prospects',
        source: 'lead_reply_watch',
        leadId: leadId,
      });
      await alertRef.set({
        leadId: leadId,
        leadName: nom,
        assignedTo: l.assignedTo || null,
        inboundAtMs: first.ms,
        lastInboundAtMs: lastMsg.ms,
        messagesCount: unanswered.length,
        canaux: canaux,
        deadlineMs: deadline,
        announcementId: ann.id,
        status: 'open',
        createdAt: new Date(),
      });
    } catch (e) {
      console.warn('[lead-reply-watch] lead', leadId, e.message);
    }
  }

  return { dryRun: dry, leads: leadIds.length, created: created.length, closed: closed.length, alertes: created, archivees: closed, enAttente: pending };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) { res.status(401).json({ error: 'unauthorized' }); return; }
    try { res.status(200).json(Object.assign({ ok: true }, await run({}))); } catch (e) { console.error('[lead-reply-watch]', e); res.status(200).json({ ok: false, error: e.message }); }
    return;
  }
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req) || {};
  try {
    const out = await run({ dryRun: body.action !== 'run' || body.dryRun === true });
    res.status(200).json(Object.assign({ ok: true }, out));
  } catch (e) {
    console.error('[lead-reply-watch]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
