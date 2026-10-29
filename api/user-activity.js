// ============================================================================
// api/user-activity.js — suivi des connexions et du temps d'activité
// ----------------------------------------------------------------------------
// Alimente la section « Activité de connexion » de admin-users.html.
//
// Deux actions (POST + Authorization: Bearer <idToken>) :
//
//   { action: 'beat', page, activeMs, login }        → tout utilisateur connecté
//     Signal envoyé par nav.js (chargement de page, toutes les 5 min quand
//     l'onglet est visible, et au passage en arrière-plan). `activeMs` est le
//     temps d'onglet visible accumulé côté client depuis le signal précédent.
//     Le serveur décide seul de l'ouverture d'une nouvelle « connexion » :
//       - premier signal jamais reçu pour cet utilisateur ;
//       - ou plus de SESSION_GAP_MS depuis le dernier signal ;
//       - ou `login: true` (arrivée depuis login.html).
//
//   { action: 'report', days }                        → admin uniquement
//     Retourne, pour chaque utilisateur : cumul à vie (résumé), cumul sur la
//     période demandée (docs journaliers), et les métadonnées Firebase Auth
//     (dernier sign-in, dernier rafraîchissement de token) comme repère
//     approximatif tant que le traceur n'a pas d'historique.
//
// Stockage (collection `user_activity`, écrite uniquement par l'Admin SDK,
// aucune règle Firestore côté client — la collection reste inaccessible aux
// navigateurs, le rapport passe par cet endpoint) :
//
//   user_activity/{uid}                  kind: 'summary'
//     { uid, email, displayName, role, lastSeenAt, lastLoginAt, loginCount,
//       totalActiveMs, lastPage, lastUserAgent, firstSeenAt, updatedAt }
//
//   user_activity/{uid}_{YYYY-MM-DD}     kind: 'daily'   (jour Europe/Paris)
//     { uid, date, sessions, activeMs, firstSeenAt, lastSeenAt, updatedAt }
//
// Les docs journaliers portent un champ `date`, les résumés non : la requête
// `where('date', '>=', from)` n'a donc besoin d'aucun index composite.
//
// CONSERVATION (décision Adrien 16/10/2026, module Pilotage équipe) :
// données de connexion = données personnelles → les docs journaliers de plus
// de 12 mois sont supprimés (exception assumée à « rien n'est supprimé »).
// Le résumé par personne est conservé.
//   GET  Bearer <CRON_SECRET>                 → purge (cron mensuel, vercel.json)
//   POST { action: 'purge', dryRun: true }    → admin : aperçu, rien n'est écrit
//   POST { action: 'purge', dryRun: false }   → admin : purge immédiate
//
// JOURNAL DES CLICS (16/10/2026) :
//   { action: 'events', events: [{ k, t, p, l, a, h, v, lead, ms }] }  → tout utilisateur connecté
//     Lots envoyés par nav.js : k = 'page' (page ouverte), 'leave' (page
//     quittée, ms = temps visible), 'click' (libellé l, data-action a, lien h,
//     état v d'une case), 'change' (liste déroulante, option v). Jamais le
//     contenu d'un champ de saisie. Un doc par lot et par jour :
//       user_events/{auto}  { uid, date, at, count, events[] }
//     + compteurs `clicks` / `pages` sur le doc journalier user_activity.
//     Même conservation (12 mois) et même purge que les docs journaliers.
//
// Toute l'équipe est suivie, setters compris (décision Adrien 16/10/2026) :
// ces données alimentent aussi admin-pilotage.html (présence et temps de
// connexion par personne).
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth, requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const COLLECTION = 'user_activity';

// Inactivité au-delà de laquelle le prochain signal ouvre une nouvelle connexion.
const SESSION_GAP_MS = 30 * 60 * 1000;
// Plafond de temps actif accepté par signal (le client émet toutes les 5 min).
const BEAT_CAP_MS = 15 * 60 * 1000;
// Plafond du premier signal d'une nouvelle connexion (l'écart avec le signal
// précédent dépasse 30 min : le temps accumulé côté client n'est plus fiable).
const NEW_SESSION_CAP_MS = 5 * 60 * 1000;

const MAX_REPORT_DAYS = 365;
const DEFAULT_REPORT_DAYS = 30;
const RETENTION_DAYS = 365;
const EVENTS_COLLECTION = 'user_events';
const EVENT_KINDS = { page: 1, leave: 1, click: 1, change: 1 };
const MAX_EVENTS_PER_CALL = 200;
const PURGE_MAX_DOCS = 4000;

// Helpers (supprimés par erreur le 16/10/2026 avec l'exclusion des
// prestataires : beat, events et report répondaient 500 depuis).
function todayIsoParis(d) {
  // 'en-CA' → format YYYY-MM-DD
  return (d || new Date()).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}

function tsToMillis(ts) {
  if (!ts) return 0;
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (ts instanceof Date) return ts.getTime();
  if (typeof ts === 'number') return ts;
  return 0;
}

function tsToIso(ts) {
  const ms = tsToMillis(ts);
  return ms ? new Date(ms).toISOString() : null;
}

function cleanPage(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 60) || null;
}

function cleanUserAgent(raw) {
  return String(raw || '').replace(/[\r\n\t]/g, ' ').slice(0, 200) || null;
}

// ─── BEAT ───────────────────────────────────────────────────────────────────
async function handleBeat(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;

  const body = parseBody(req);
  const now = Date.now();
  const nowTs = admin.firestore.Timestamp.fromMillis(now);
  const date = todayIsoParis(new Date(now));
  const page = cleanPage(body.page);
  const forceLogin = body.login === true;

  const summaryRef = db.collection(COLLECTION).doc(auth.uid);
  const dailyRef = db.collection(COLLECTION).doc(auth.uid + '_' + date);

  const [summarySnap, dailySnap] = await Promise.all([summaryRef.get(), dailyRef.get()]);
  const summary = summarySnap.exists ? summarySnap.data() : null;
  const daily = dailySnap.exists ? dailySnap.data() : null;

  const lastSeenMs = summary ? tsToMillis(summary.lastSeenAt) : 0;
  const gapMs = lastSeenMs ? now - lastSeenMs : Infinity;
  const newSession = forceLogin || !lastSeenMs || gapMs > SESSION_GAP_MS;

  // Temps actif accepté : borné par ce que le client annonce, par l'écart réel
  // avec le signal précédent (+ marge réseau) et par un plafond absolu.
  let activeMs = Number(body.activeMs);
  if (!isFinite(activeMs) || activeMs < 0) activeMs = 0;
  activeMs = Math.round(activeMs);
  if (newSession) {
    activeMs = Math.min(activeMs, NEW_SESSION_CAP_MS);
  } else {
    activeMs = Math.min(activeMs, BEAT_CAP_MS, gapMs + 5000);
  }

  const inc = admin.firestore.FieldValue.increment;
  const batch = db.batch();

  const summaryPatch = {
    kind: 'summary',
    uid: auth.uid,
    email: auth.email || null,
    displayName: (auth.userData && auth.userData.displayName) || null,
    role: auth.role || null,
    lastSeenAt: nowTs,
    lastPage: page,
    lastUserAgent: cleanUserAgent(req.headers['user-agent']),
    totalActiveMs: inc(activeMs),
    loginCount: inc(newSession ? 1 : 0),
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (newSession) summaryPatch.lastLoginAt = nowTs;
  if (!summary || !summary.firstSeenAt) summaryPatch.firstSeenAt = nowTs;
  batch.set(summaryRef, summaryPatch, { merge: true });

  const dailyPatch = {
    kind: 'daily',
    uid: auth.uid,
    date,
    sessions: inc(newSession ? 1 : 0),
    activeMs: inc(activeMs),
    lastSeenAt: nowTs,
    updatedAt: admin.firestore.FieldValue.serverTimestamp(),
  };
  if (!daily || !daily.firstSeenAt) dailyPatch.firstSeenAt = nowTs;
  batch.set(dailyRef, dailyPatch, { merge: true });

  // Écriture AVANT la réponse : Vercel tue la fonction dès res.end().
  await batch.commit();

  res.status(200).json({ ok: true, newSession, activeMs, date });
}

// ─── REPORT ─────────────────────────────────────────────────────────────────
async function listAuthUsers() {
  // Métadonnées Firebase Auth : repère indépendant du traceur.
  const out = {};
  let pageToken;
  let guard = 0;
  do {
    const page = await admin.auth().listUsers(1000, pageToken);
    page.users.forEach((u) => {
      const meta = u.metadata || {};
      out[u.uid] = {
        lastSignInTime: meta.lastSignInTime ? new Date(meta.lastSignInTime).toISOString() : null,
        lastRefreshTime: meta.lastRefreshTime ? new Date(meta.lastRefreshTime).toISOString() : null,
        creationTime: meta.creationTime ? new Date(meta.creationTime).toISOString() : null,
        disabled: !!u.disabled,
      };
    });
    pageToken = page.pageToken;
    guard++;
  } while (pageToken && guard < 20);
  return out;
}

async function handleReport(req, res) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req);
  let days = parseInt(body.days, 10);
  if (!isFinite(days) || days < 1) days = DEFAULT_REPORT_DAYS;
  if (days > MAX_REPORT_DAYS) days = MAX_REPORT_DAYS;

  const now = new Date();
  const fromDate = new Date(now.getTime() - (days - 1) * 24 * 60 * 60 * 1000);
  const from = todayIsoParis(fromDate);
  const today = todayIsoParis(now);

  const col = db.collection(COLLECTION);
  const [summarySnap, dailySnap, authUsers] = await Promise.all([
    col.where('kind', '==', 'summary').get(),
    col.where('date', '>=', from).get(),
    listAuthUsers().catch((e) => {
      console.warn('[user-activity] listUsers failed:', e.message);
      return {};
    }),
  ]);

  const users = {};
  function entry(uid) {
    if (!users[uid]) {
      users[uid] = {
        uid,
        lastSeenAt: null,
        lastLoginAt: null,
        firstSeenAt: null,
        loginCount: 0,
        totalActiveMs: 0,
        lastPage: null,
        period: { sessions: 0, activeMs: 0, activeDays: 0 },
        today: { sessions: 0, activeMs: 0 },
        auth: null,
      };
    }
    return users[uid];
  }

  summarySnap.forEach((d) => {
    const s = d.data() || {};
    const e = entry(s.uid || d.id);
    e.lastSeenAt = tsToIso(s.lastSeenAt);
    e.lastLoginAt = tsToIso(s.lastLoginAt);
    e.firstSeenAt = tsToIso(s.firstSeenAt);
    e.loginCount = Number(s.loginCount) || 0;
    e.totalActiveMs = Number(s.totalActiveMs) || 0;
    e.lastPage = s.lastPage || null;
  });

  dailySnap.forEach((d) => {
    const s = d.data() || {};
    if (s.kind && s.kind !== 'daily') return;
    if (!s.uid) return;
    const e = entry(s.uid);
    const sessions = Number(s.sessions) || 0;
    const activeMs = Number(s.activeMs) || 0;
    e.period.sessions += sessions;
    e.period.activeMs += activeMs;
    if (activeMs > 0 || sessions > 0) e.period.activeDays += 1;
    if (s.date === today) {
      e.today.sessions += sessions;
      e.today.activeMs += activeMs;
    }
  });

  Object.keys(authUsers).forEach((uid) => {
    entry(uid).auth = authUsers[uid];
  });

  res.status(200).json({
    ok: true,
    days,
    from,
    today,
    generatedAt: now.toISOString(),
    sessionGapMinutes: SESSION_GAP_MS / 60000,
    users,
  });
}

// ─── EVENTS (journal des clics et des pages) ────────────────────────────────
function cleanStr(v, n) {
  return String(v == null ? '' : v).replace(/[\r\n\t]+/g, ' ').trim().slice(0, n) || null;
}

async function handleEvents(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  const body = parseBody(req);
  const raw = Array.isArray(body.events) ? body.events.slice(0, MAX_EVENTS_PER_CALL) : [];
  const now = Date.now();
  const byDate = {};
  raw.forEach((e) => {
    if (!e || !EVENT_KINDS[e.k]) return;
    let t = Number(e.t);
    // Tampon localStorage : un lot peut dater de la veille, jamais du futur.
    // Plus de 3 jours : ignoré (et non redaté), sinon un tampon resté bloqué
    // (panne du 16 au 29/10/2026) apparaîtrait comme de l'activité du jour.
    if (isFinite(t) && t < now - 3 * 24 * 3600 * 1000) return;
    if (!isFinite(t) || t > now + 60000) t = now;
    const ev = { k: e.k, t: Math.round(t) };
    const p = cleanPage(e.p); if (p) ev.p = p;
    const l = cleanStr(e.l, 80); if (l) ev.l = l;
    const a = cleanStr(e.a, 40); if (a) ev.a = a;
    const h = cleanStr(e.h, 120); if (h) ev.h = h;
    const v = cleanStr(e.v, 80); if (v) ev.v = v;
    const lead = String(e.lead || '').trim();
    if (/^[A-Za-z0-9_-]{3,80}$/.test(lead)) ev.lead = lead;
    const ms = Number(e.ms);
    if (e.k === 'leave' && isFinite(ms) && ms >= 0) ev.ms = Math.min(Math.round(ms), 24 * 3600 * 1000);
    const date = todayIsoParis(new Date(ev.t));
    (byDate[date] = byDate[date] || []).push(ev);
  });
  const dates = Object.keys(byDate);
  if (!dates.length) { res.status(200).json({ ok: true, stored: 0 }); return; }

  const inc = admin.firestore.FieldValue.increment;
  const batch = db.batch();
  dates.forEach((date) => {
    const evs = byDate[date].sort((x, y) => x.t - y.t);
    batch.set(db.collection(EVENTS_COLLECTION).doc(), {
      uid: auth.uid, date, at: admin.firestore.Timestamp.fromMillis(evs[0].t),
      count: evs.length, events: evs,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    const clicks = evs.filter((x) => x.k === 'click' || x.k === 'change').length;
    const pages = evs.filter((x) => x.k === 'page').length;
    batch.set(db.collection(COLLECTION).doc(auth.uid + '_' + date), {
      kind: 'daily', uid: auth.uid, date,
      clicks: inc(clicks), pages: inc(pages),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });
  });
  // Écriture AVANT la réponse : Vercel tue la fonction dès res.end().
  await batch.commit();
  res.status(200).json({ ok: true, stored: raw.length });
}

// ─── PURGE (conservation 12 mois des docs journaliers et du journal) ────────
async function purgeCollection(name, cutoff, dryRun, keep) {
  const snap = await db.collection(name).where('date', '<', cutoff).limit(PURGE_MAX_DOCS).get();
  const ids = [];
  snap.forEach((d) => { if (!keep || keep(d.data() || {})) ids.push(d.id); });
  if (!dryRun) {
    for (let i = 0; i < ids.length; i += 400) {
      const batch = db.batch();
      ids.slice(i, i + 400).forEach((id) => batch.delete(db.collection(name).doc(id)));
      await batch.commit();
    }
  }
  return { count: ids.length, sample: ids.slice(0, 10), more: snap.size >= PURGE_MAX_DOCS };
}

async function runPurge(dryRun) {
  const cutoff = todayIsoParis(new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000));
  // Jamais un résumé (kind 'summary', sans champ date de toute façon).
  const daily = await purgeCollection(COLLECTION, cutoff, dryRun, (s) => !s.kind || s.kind === 'daily');
  const events = await purgeCollection(EVENTS_COLLECTION, cutoff, dryRun, null);
  return { dryRun: !!dryRun, cutoff, count: daily.count + events.count, daily, events };
}

async function handlePurge(req, res, body) {
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const dryRun = body.dryRun !== false;
  res.status(200).json(Object.assign({ ok: true }, await runPurge(dryRun)));
}

// ─── ROUTER ─────────────────────────────────────────────────────────────────
module.exports = async (req, res) => {
  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const r = await runPurge(false);
      console.log('[user-activity] purge', r.cutoff, r.count);
      return res.status(200).json(Object.assign({ ok: true }, r));
    } catch (e) {
      console.error('[user-activity] purge failed:', e);
      return res.status(200).json({ ok: false, error: e.message });
    }
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const body = parseBody(req);
  const action = String(body.action || '').trim();

  try {
    if (action === 'beat') return await handleBeat(req, res);
    if (action === 'report') return await handleReport(req, res);
    if (action === 'purge') return await handlePurge(req, res, body);
    if (action === 'events') return await handleEvents(req, res);
    return res.status(400).json({ error: 'Unknown action: ' + (action || '(vide)') });
  } catch (e) {
    console.error('[user-activity] ' + action + ' failed:', e);
    if (!res.headersSent) res.status(500).json({ error: e.message || 'Internal error' });
  }
};
