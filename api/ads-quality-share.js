// ============================================================================
// api/ads-quality-share.js — « QUALITÉ PAR PUB » EN LECTURE SEULE (12/11/2026)
// ----------------------------------------------------------------------------
// Brief « Outil 2 », partie B : accès partageable avec la média buyeuse.
// Même principe que api/agency-funnel.js — un lien secret (jeton dans
// l'URL), sans compte, sans accès Firestore, calcul À LA DEMANDE avec
// funnel-core.js (exactement les chiffres de l'onglet admin).
//
// URL  : GET /api/ads-quality-share?t=TOKEN
//          &mode=month|day|7d|30d|custom  &month=YYYY-MM  &day=YYYY-MM-DD
//          &from=&to=   &tunnel=all|elite|business
// Front: ads-quality.html (page autonome, aucun SDK Firebase).
// Jeton : _config/ads_quality_access { active, token } — généré, régénéré ou
// coupé depuis l'onglet « 🎯 Qualité par pub » du Funnel Sales. Distinct du
// lien agence : on peut couper l'un sans l'autre.
//
// CE QUI SORT — LISTE BLANCHE (rowFields ci-dessous) : par pub / ensemble /
// campagne, des NOMBRES et le nom de la pub. Jamais un nom de lead, un
// e-mail, un téléphone, un nom de membre de l'équipe ni une commission.
// Chaque accès (accepté ou refusé) est journalisé dans audit_log.
// ============================================================================
'use strict';

process.env.TZ = 'Europe/Paris';   // bornes de période en heure de Paris (cf. agency-funnel)

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const Core = require('../funnel-core.js');

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TUNNEL_RE = /^(all|elite|business)$/;
const MODE_RE = /^(month|day|7d|30d|custom)$/;
const MAX_RANGE_DAYS = 92;
const CACHE_TTL_MS = 120 * 1000;
const AXES = ['creative', 'adset', 'campaign'];

const ROW_FIELDS = ['key', 'group', 'legacy', 'outOfAds', 'adIdList',
  'leads', 'caKnown', 'qualCa', 'faux', 'disq', 'neverReached', 'neverEligible',
  'booked', 'honored', 'cancelled', 'noshow', 'closes', 'con', 'col',
  'spend', 'hasSpend', 'cpl', 'cpq', 'cph', 'cpv', 'smallSample'];
const K_FIELDS = ['leads', 'attributedLeads', 'attributedPct', 'hasAdLevelSpend', 'adLevelSpend',
  'adSpendComplete', 'adSpendDaysCovered', 'adSpendDaysExpected', 'creativeIndexSize'];

function pick(src, fields) {
  const o = {};
  fields.forEach(function (f) { if (src && src[f] !== undefined) o[f] = src[f]; });
  return o;
}
function shareData(k) {
  const rows = {};
  AXES.forEach(function (ax) {
    rows[ax] = ((k.utmRowsByAxis && k.utmRowsByAxis[ax]) || []).map(function (r) { return pick(r, ROW_FIELDS); });
  });
  return JSON.parse(JSON.stringify({ rowsByAxis: rows, coverage: pick(k, K_FIELDS) }));
}

function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string' || !expected || !given) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}
async function logAccess(req, ok, info) {
  try {
    const fwd = req.headers['x-forwarded-for'];
    await db.collection('audit_log').add({
      type: 'ads_quality_read', ok: !!ok,
      from: info.from || null, to: info.to || null, tunnel: info.tunnel || null,
      ip: fwd ? String(fwd).split(',')[0].trim() : null,
      ua: String(req.headers['user-agent'] || '').slice(0, 300) || null,
      at: admin.firestore.FieldValue.serverTimestamp()
    });
  } catch (e) { console.warn('[ads-quality-share] audit_log:', e && e.message); }
}
function buildPeriod(q) {
  const mode = MODE_RE.test(q.mode) ? q.mode : 'month';
  if (mode === 'day' && DAY_RE.test(q.day)) return Core.periodDay(q.day);
  if (mode === '7d') return Core.periodPreset(7);
  if (mode === '30d') return Core.periodPreset(30);
  if (mode === 'custom' && DAY_RE.test(q.from) && DAY_RE.test(q.to) && q.from <= q.to) {
    const P = Core.periodCustom(q.from, q.to);
    const days = Math.round((P.end.getTime() - P.start.getTime()) / 86400000) + 1;
    if (days > MAX_RANGE_DAYS) {
      const s = new Date(P.end.getTime() - (MAX_RANGE_DAYS - 1) * 86400000);
      return Core.periodCustom(Core.isoDate(s), Core.isoDate(P.end));
    }
    return P;
  }
  if (mode === 'month' && MONTH_RE.test(q.month)) {
    const p = q.month.split('-');
    return Core.periodMonth(+p[0], +p[1] - 1);
  }
  const now = new Date();
  return Core.periodMonth(now.getFullYear(), now.getMonth());
}

const cache = new Map();
async function loadPeriodData(P) {
  const key = Core.isoDate(P.start) + '|' + Core.isoDate(P.end);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.res;
  const res = await Core.loadAll(db, { P: P });
  cache.set(key, { at: Date.now(), res: res });
  if (cache.size > 6) cache.delete(cache.keys().next().value);
  return res;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ ok: false }); return; }
  const q = req.query || {};
  const token = typeof q.t === 'string' ? q.t : '';
  const tunnel = TUNNEL_RE.test(q.tunnel) ? q.tunnel : 'all';
  const P = buildPeriod(q);
  const info = { from: Core.isoDate(P.start), to: Core.isoDate(P.end), tunnel: tunnel };
  try {
    const cfgSnap = await db.collection('_config').doc('ads_quality_access').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;
    if (!cfg || cfg.active !== true || !tokenMatches(cfg.token, token)) {
      await logAccess(req, false, info);
      res.status(403).json({ ok: false });
      return;
    }
    const loaded = await loadPeriodData(P);
    const k = Core.computeKpis({ DATA: loaded.DATA, P: P, tunnelFilter: tunnel, sourceFilter: 'other', teamMembers: loaded.teamMembers });
    await logAccess(req, true, info);
    res.status(200).json(Object.assign({ ok: true, mode: P.mode, tunnel: tunnel, from: info.from, to: info.to, computedAt: Date.now() }, shareData(k)));
  } catch (e) {
    console.error('[ads-quality-share]', e && e.message);
    res.status(500).json({ ok: false });
  }
};
module.exports.shareData = shareData;
