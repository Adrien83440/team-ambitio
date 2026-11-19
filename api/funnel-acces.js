// ============================================================================
// api/funnel-acces.js — LIENS D'ACCÈS EN LECTURE AU MODULE STATS FUNNEL (19/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien : donner à une personne (média buyeuse…) un LIEN qui ouvre
// sales-funnel.html en lecture seule, sans compte ni mot de passe, avec une
// durée choisie, désactivable à tout moment, un lien par personne, et le
// journal de ses connexions.
//
// PRINCIPE — le lien connecte la personne comme un compte « lecteur funnel » :
//   · chaque lien a un utilisateur technique uid = « fl_<id> », doc
//     users/{uid} { role: 'funnel_viewer', status, expiresAt, funnelLink } ;
//   · ouvrir le lien (funnel-acces.html#t=<id>.<secret>) → action « login »
//     → jeton Firebase personnalisé (createCustomToken) → la page se connecte
//     et part sur sales-funnel.html, en mode lecture seule ;
//   · la VRAIE barrière reste les règles Firestore (bloc « LECTEUR FUNNEL ») :
//     elles relisent users/{uid} à CHAQUE lecture → désactiver ou laisser
//     expirer coupe l'accès en quelques secondes, page ouverte comprise.
//
// DONNÉES (Admin SDK seul, AUCUNE règle Firestore : illisibles du navigateur)
//   funnel_links/{id}  { name, secret, uid, createdAt, createdBy, expiresAt,
//                        disabledAt, disabledBy, linkOpens, lastLinkOpenAt,
//                        sessions, lastSeenAt, lastCity, history[] }
//   funnel_links/{id}/sessions/{sid}  { startedAt, lastSeenAt, city, region,
//                        country, device, ua } — une par ouverture de page.
//   Rien n'est supprimé : désactiver = disabledAt (réactivable tant que non
//   expiré), l'historique des actions est gardé sur le lien.
//
// ROUTES
//   POST { action: 'login', t }             public : valide le lien → jeton
//   POST { action: 'open' }                 lecteur : ouvre une session (page)
//   POST { action: 'ping', sid }            lecteur : signe de vie (5 min)
//   GET  ?action=list                       admin : liens + état
//   GET  ?action=sessions&id=               admin : 100 dernières sessions
//   POST { action: 'create', name, days | until }   admin
//   POST { action: 'extend', id, days | until }     admin
//   POST { action: 'disable', id }                  admin
//   POST { action: 'enable', id }                   admin (si non expiré)
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin, requireFunnelReader, FUNNEL_VIEWER_ROLE } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const COL = 'funnel_links';
const MAX_DAYS = 366;
const DAY = 86400000;

function FV() { return admin.firestore.FieldValue; }
function TS(ms) { return admin.firestore.Timestamp.fromMillis(ms); }
function ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v instanceof Date) return v.getTime();
  const n = typeof v === 'number' ? v : Date.parse(v);
  return isFinite(n) ? n : null;
}
function iso(v) { const t = ms(v); return t ? new Date(t).toISOString() : null; }
function randId(bytes) { return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function safeEq(a, b) {
  const x = Buffer.from(String(a || ''), 'utf8');
  const y = Buffer.from(String(b || ''), 'utf8');
  return x.length === y.length && x.length > 0 && crypto.timingSafeEqual(x, y);
}
function dec(v) { try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); } }

/* Fin de journée à Paris pour « AAAA-MM-JJ » (heure d'été de fin mars à fin
   octobre, approchée au mois — l'écart possible est d'une heure, deux jours
   par an). */
function endOfParisDay(isoDay) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoDay || ''));
  if (!m) return null;
  const month = Number(m[2]);
  const off = (month >= 4 && month <= 10) ? '+02:00' : '+01:00';
  const t = Date.parse(m[1] + '-' + m[2] + '-' + m[3] + 'T23:59:59' + off);
  return isFinite(t) ? t : null;
}
/* Échéance demandée → ms, bornée à MAX_DAYS. null = invalide. */
function expiryOf(body) {
  const now = Date.now();
  let t = null;
  if (body.until) t = endOfParisDay(body.until);
  else if (body.days != null) {
    const d = Number(body.days);
    if (isFinite(d) && d > 0) t = now + d * DAY;
  }
  if (!t || t <= now || t > now + MAX_DAYS * DAY) return null;
  return t;
}

function stateOf(x) {
  if (x.disabledAt) return 'desactive';
  const e = ms(x.expiresAt);
  if (!e || e <= Date.now()) return 'expire';
  return 'actif';
}
function linkUrl(req, id, secret) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'team.alteore.com');
  return 'https://' + host + '/funnel-acces.html#t=' + encodeURIComponent(id + '.' + secret);
}

/* Appareil lisible depuis le user-agent (journal seulement). */
function deviceOf(ua) {
  const u = String(ua || '');
  let os = /iPhone/.test(u) ? 'iPhone' : /iPad/.test(u) ? 'iPad' : /Android/.test(u) ? 'Android'
    : /Macintosh|Mac OS X/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Appareil inconnu';
  let br = /Edg\//.test(u) ? 'Edge' : /OPR\//.test(u) ? 'Opera' : /Firefox\//.test(u) ? 'Firefox'
    : /CriOS|Chrome\//.test(u) ? 'Chrome' : /Safari\//.test(u) ? 'Safari' : 'navigateur inconnu';
  return os + ' · ' + br;
}
function geoOf(req) {
  const h = req.headers || {};
  return { city: dec(h['x-vercel-ip-city']), region: dec(h['x-vercel-ip-country-region']), country: String(h['x-vercel-ip-country'] || '') };
}

/* Utilisateur technique du lien (users/{uid}) — miroir de l'état du lien,
   relu par les règles Firestore à chaque lecture. */
async function syncUser(id, x) {
  const st = stateOf(x);
  await db.collection('users').doc(x.uid).set({
    role: FUNNEL_VIEWER_ROLE,
    status: st === 'actif' ? 'active' : 'disabled',
    displayName: x.name,
    email: null,
    funnelLink: id,
    expiresAt: x.expiresAt,
    updatedAt: FV().serverTimestamp()
  }, { merge: true });
}

/* ── Public : ouverture du lien ────────────────────────────────────────── */
async function login(req, body) {
  const raw = String(body.t || '');
  const dot = raw.indexOf('.');
  if (dot < 1) return [404, { ok: false, error: 'Lien invalide.' }];
  const id = raw.slice(0, dot), secret = raw.slice(dot + 1);
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return [404, { ok: false, error: 'Lien invalide.' }];
  const ref = db.collection(COL).doc(id);
  const snap = await ref.get();
  if (!snap.exists) return [404, { ok: false, error: 'Lien invalide.' }];
  const x = snap.data() || {};
  if (!safeEq(secret, x.secret)) return [404, { ok: false, error: 'Lien invalide.' }];
  const st = stateOf(x);
  if (st === 'desactive') return [403, { ok: false, error: 'Ce lien a été désactivé.' }];
  if (st === 'expire') return [410, { ok: false, error: 'Ce lien a expiré.' }];
  await syncUser(id, x);
  const token = await admin.auth().createCustomToken(x.uid, { funnelLink: id });
  await ref.set({ linkOpens: FV().increment(1), lastLinkOpenAt: FV().serverTimestamp() }, { merge: true });
  return [200, { ok: true, token: token, name: x.name, expiresAt: iso(x.expiresAt) }];
}

/* ── Lecteur : sessions (une par ouverture de la page) ─────────────────── */
async function linkOfAuth(auth) {
  const id = auth.userData && auth.userData.funnelLink;
  return id ? String(id) : null;
}
async function openSession(req, auth) {
  const id = await linkOfAuth(auth);
  if (!id) return [200, { ok: true, skip: true }];
  const g = geoOf(req);
  const ua = String(req.headers['user-agent'] || '').slice(0, 300);
  const ref = db.collection(COL).doc(id).collection('sessions').doc();
  const now = FV().serverTimestamp();
  await ref.set({ startedAt: now, lastSeenAt: now, city: g.city, region: g.region, country: g.country, device: deviceOf(ua), ua: ua });
  await db.collection(COL).doc(id).set({ sessions: FV().increment(1), lastSeenAt: now, lastCity: g.city || g.country || '' }, { merge: true });
  return [200, { ok: true, sid: ref.id }];
}
async function ping(req, auth, body) {
  const id = await linkOfAuth(auth);
  if (!id) return [200, { ok: true, skip: true }];
  const sid = String(body.sid || '');
  const now = FV().serverTimestamp();
  if (/^[A-Za-z0-9]{10,40}$/.test(sid)) {
    await db.collection(COL).doc(id).collection('sessions').doc(sid).set({ lastSeenAt: now }, { merge: true });
  }
  await db.collection(COL).doc(id).set({ lastSeenAt: now }, { merge: true });
  return [200, { ok: true }];
}

/* ── Admin ──────────────────────────────────────────────────────────────── */
function rowOf(req, id, x) {
  return {
    id: id, name: x.name || '', state: stateOf(x), url: x.secret ? linkUrl(req, id, x.secret) : null,
    createdAt: iso(x.createdAt), createdByName: x.createdByName || null, expiresAt: iso(x.expiresAt),
    disabledAt: iso(x.disabledAt), linkOpens: x.linkOpens || 0, sessions: x.sessions || 0,
    lastSeenAt: iso(x.lastSeenAt), lastLinkOpenAt: iso(x.lastLinkOpenAt), lastCity: x.lastCity || ''
  };
}
async function list(req) {
  const snap = await db.collection(COL).orderBy('createdAt', 'desc').limit(200).get();
  const rows = [];
  snap.forEach(function (d) { rows.push(rowOf(req, d.id, d.data() || {})); });
  return [200, { ok: true, links: rows }];
}
async function sessions(req, q) {
  const id = String(q.id || '');
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) return [400, { ok: false, error: 'id invalide' }];
  const snap = await db.collection(COL).doc(id).collection('sessions').orderBy('startedAt', 'desc').limit(100).get();
  const rows = [];
  snap.forEach(function (d) {
    const s = d.data() || {};
    rows.push({ id: d.id, startedAt: iso(s.startedAt), lastSeenAt: iso(s.lastSeenAt), city: s.city || '', region: s.region || '', country: s.country || '', device: s.device || '' });
  });
  return [200, { ok: true, sessions: rows }];
}
function histEntry(auth, what, extra) {
  return Object.assign({ at: new Date().toISOString(), by: auth.uid, byEmail: auth.email || null, action: what }, extra || {});
}
async function create(req, auth, body) {
  const name = String(body.name || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!name) return [400, { ok: false, error: 'Nom de la personne requis.' }];
  const exp = expiryOf(body);
  if (!exp) return [400, { ok: false, error: 'Durée invalide (1 jour à 1 an).' }];
  const id = randId(9);
  const secret = randId(32);
  const x = {
    name: name, secret: secret, uid: 'fl_' + id,
    createdAt: FV().serverTimestamp(), createdBy: auth.uid, createdByName: (auth.userData && auth.userData.displayName) || auth.email || null,
    expiresAt: TS(exp), disabledAt: null, linkOpens: 0, sessions: 0,
    history: [histEntry(auth, 'creation', { expiresAt: new Date(exp).toISOString() })]
  };
  await db.collection(COL).doc(id).set(x);
  await syncUser(id, x);
  return [200, { ok: true, id: id, url: linkUrl(req, id, secret), expiresAt: new Date(exp).toISOString() }];
}
async function loadLink(id) {
  if (!/^[A-Za-z0-9_-]{6,40}$/.test(String(id || ''))) return null;
  const snap = await db.collection(COL).doc(id).get();
  return snap.exists ? snap.data() || {} : null;
}
async function extend(req, auth, body) {
  const x = await loadLink(body.id);
  if (!x) return [404, { ok: false, error: 'Lien introuvable.' }];
  const exp = expiryOf(body);
  if (!exp) return [400, { ok: false, error: 'Durée invalide (1 jour à 1 an).' }];
  x.expiresAt = TS(exp);
  await db.collection(COL).doc(body.id).set({ expiresAt: x.expiresAt, history: FV().arrayUnion(histEntry(auth, 'prolongation', { expiresAt: new Date(exp).toISOString() })) }, { merge: true });
  await syncUser(body.id, x);
  return [200, { ok: true, expiresAt: new Date(exp).toISOString(), state: stateOf(x) }];
}
async function disable(req, auth, body) {
  const x = await loadLink(body.id);
  if (!x) return [404, { ok: false, error: 'Lien introuvable.' }];
  x.disabledAt = TS(Date.now());
  await db.collection(COL).doc(body.id).set({ disabledAt: x.disabledAt, disabledBy: auth.uid, history: FV().arrayUnion(histEntry(auth, 'desactivation')) }, { merge: true });
  await syncUser(body.id, x);
  /* Coupe aussi le renouvellement de session (les règles coupent déjà les
     lectures, via users/{uid}.status). */
  try { await admin.auth().revokeRefreshTokens(x.uid); } catch (e) { /* utilisateur Auth jamais créé : rien à révoquer */ }
  return [200, { ok: true, state: 'desactive' }];
}
async function enable(req, auth, body) {
  const x = await loadLink(body.id);
  if (!x) return [404, { ok: false, error: 'Lien introuvable.' }];
  const e = ms(x.expiresAt);
  if (!e || e <= Date.now()) return [409, { ok: false, error: 'Lien expiré : prolonge-le d\'abord.' }];
  x.disabledAt = null;
  await db.collection(COL).doc(body.id).set({ disabledAt: null, disabledBy: null, history: FV().arrayUnion(histEntry(auth, 'reactivation')) }, { merge: true });
  await syncUser(body.id, x);
  return [200, { ok: true, state: stateOf(x) }];
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    let out;
    if (req.method === 'GET') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const q = req.query || {};
      if (q.action === 'sessions') out = await sessions(req, q);
      else out = await list(req);
    } else if (req.method === 'POST') {
      const body = parseBody(req) || {};
      const act = String(body.action || '');
      if (act === 'login') out = await login(req, body);
      else if (act === 'open' || act === 'ping') {
        const auth = await requireFunnelReader(req, res);
        if (!auth) return;
        out = act === 'open' ? await openSession(req, auth) : await ping(req, auth, body);
      } else {
        const auth = await requireAdmin(req, res);
        if (!auth) return;
        if (act === 'create') out = await create(req, auth, body);
        else if (act === 'extend') out = await extend(req, auth, body);
        else if (act === 'disable') out = await disable(req, auth, body);
        else if (act === 'enable') out = await enable(req, auth, body);
        else out = [400, { ok: false, error: 'action inconnue' }];
      }
    } else {
      out = [405, { ok: false }];
    }
    res.status(out[0]).json(out[1]);
  } catch (e) {
    console.error('[funnel-acces]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 300) });
  }
};
module.exports.deviceOf = deviceOf;
module.exports.endOfParisDay = endOfParisDay;
