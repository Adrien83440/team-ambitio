// ============================================================================
// api/litige-export.js — EXTRACTION POUR CONTENTIEUX, LECTURE SEULE (20/11/2026)
// ----------------------------------------------------------------------------
// TEMPORAIRE. Existe uniquement sur la branche de travail
// `claude/litige-elodie-vidotto-export-1b4w5r` (preview Vercel), jamais sur
// `main`. À retirer, avec sa clé, dès l'export terminé.
//
// N'ÉCRIT RIEN : aucun set / update / delete / add, uniquement des lectures.
// Aucune donnée de prospect en sortie (ni nom, ni e-mail, ni téléphone, ni
// texte libre) : les parties « découverte » ne rendent que des NOMS de champs
// et des décomptes ; les parties « données » ne rendent que des champs
// énumérés en dur ci-dessous.
//
// Accès : en-tête `x-litige-key` égal à la variable Vercel LITIGE_EXPORT_KEY
// (preview de cette branche seulement). Variable absente ou clé fausse → 404.
// Chaque réponse porte l'heure d'extraction et la requête exécutée.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');

function keyOk(req) {
  const want = String(process.env.LITIGE_EXPORT_KEY || '');
  const got = String((req.headers && req.headers['x-litige-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function ms(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function iso(v) { const t = ms(v); return t == null ? null : new Date(t).toISOString(); }
function paris(v) {
  const t = ms(v); if (t == null) return null;
  return new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' });
}
function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (v && typeof v.toMillis === 'function') return 'timestamp';
  if (v && typeof v === 'object' && v._seconds != null) return 'timestamp';
  return typeof v;
}

// Chemins jamais lus, même pour leurs noms de champs.
const DENY = /credential|token|secret|oauth|password/i;
function pathOk(p) { return /^[A-Za-z0-9_\-\/.@]+$/.test(p) && !DENY.test(p); }

function refOf(path) {
  const seg = String(path).split('/').filter(Boolean);
  let r = db;
  for (let i = 0; i < seg.length; i++) r = (i % 2 === 0) ? r.collection(seg[i]) : r.doc(seg[i]);
  return { ref: r, isDoc: seg.length % 2 === 0 };
}

function castVal(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^ts:\d{4}-\d{2}-\d{2}/.test(v)) return new Date(v.slice(3));
  if (/^str:/.test(v)) return v.slice(4);
  return v;
}

function applyWhere(q, query) {
  const used = [];
  ['', '2', '3'].forEach(function (s) {
    const f = query['field' + s], op = query['op' + s] || '==', val = query['val' + s];
    if (f && val != null) { q = q.where(String(f), String(op), castVal(String(val))); used.push(f + ' ' + op + ' ' + val); }
  });
  return { q: q, used: used };
}

// Noms de champs (jamais les valeurs), jusqu'à 4 niveaux.
function walk(obj, prefix, acc, depth) {
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    const p = prefix ? prefix + '.' + k : k;
    const t = typeOf(v);
    if (!acc[p]) acc[p] = { n: 0, types: {} };
    acc[p].n++; acc[p].types[t] = (acc[p].types[t] || 0) + 1;
    if (t === 'object' && depth < 4) walk(v, p, acc, depth + 1);
    if (t === 'array' && depth < 4) {
      const first = v.filter(function (x) { return x && typeof x === 'object' && !Array.isArray(x) && typeOf(x) === 'object'; }).slice(0, 5);
      first.forEach(function (x) { walk(x, p + '[]', acc, depth + 1); });
    }
  });
}

// Champs dont on accepte de compter les valeurs distinctes (énumérations
// techniques ou identifiants internes de l'équipe, jamais un prospect).
const DISTINCT_OK = /^(status|source|provider|direction|role|type|typeLabel|task|outcome|personId|personName|bookedBySlug|bookedByName|setterSlug|setterName|closerSlug|closerName|userSlug|slug|memberSlug|agentSlug|ownerSlug|authorSlug|month|kind|origin|via|model|ok|isCoaching|recordingStatus|transcriptionStatus|aiAnalysisStatus|userId|uid|createdBy|createdByName|createdBySlug|updatedBy|validatedBy|by|bySlug|byName|stage|scope|category|level|action|event|entity|who|date|day|closer|setter|member|user)$/;

async function partCols() {
  const cols = await db.listCollections();
  return { collections: cols.map(function (c) { return c.id; }).sort() };
}

async function partSubcols(query) {
  const path = String(query.path || '');
  if (!pathOk(path)) return { error: 'path' };
  const r = refOf(path);
  if (!r.isDoc) return { error: 'document attendu' };
  const cols = await r.ref.listCollections();
  return { path: path, subcollections: cols.map(function (c) { return c.id; }).sort() };
}

async function partCount(query) {
  const path = String(query.path || '');
  if (!pathOk(path)) return { error: 'path' };
  const r = refOf(path);
  if (r.isDoc) return { error: 'collection attendue' };
  const w = applyWhere(r.ref, query);
  const c = await w.q.count().get();
  return { path: path, where: w.used, count: c.data().count };
}

async function partFields(query) {
  const path = String(query.path || '');
  if (!pathOk(path)) return { error: 'path' };
  const r = refOf(path);
  const acc = {};
  if (r.isDoc) {
    const s = await r.ref.get();
    if (!s.exists) return { path: path, exists: false };
    walk(s.data(), '', acc, 1);
    return { path: path, exists: true, docs: 1, fields: acc };
  }
  const lim = Math.min(Math.max(Number(query.limit) || 300, 1), 3000);
  const w = applyWhere(r.ref, query);
  let q = w.q;
  if (query.orderBy) q = q.orderBy(String(query.orderBy), query.dir === 'asc' ? 'asc' : 'desc');
  const snap = await q.limit(lim).get();
  snap.forEach(function (d) { walk(d.data(), '', acc, 1); });
  return { path: path, where: w.used, orderBy: query.orderBy || null, limit: lim, docs: snap.size, fields: acc };
}

async function partDistinct(query) {
  const path = String(query.path || '');
  const f = String(query.f || '');
  if (!pathOk(path)) return { error: 'path' };
  const last = f.split('.').pop();
  if (!DISTINCT_OK.test(last)) return { error: 'champ non autorisé pour un décompte de valeurs' };
  const r = refOf(path);
  if (r.isDoc) return { error: 'collection attendue' };
  const lim = Math.min(Math.max(Number(query.limit) || 5000, 1), 60000);
  const w = applyWhere(r.ref, query);
  const snap = await w.q.select(f).limit(lim).get();
  const counts = {};
  snap.forEach(function (d) {
    let v = d.get(f);
    const t = typeOf(v);
    if (t === 'timestamp') v = paris(v).slice(0, 10);
    else if (t === 'object' || t === 'array') v = '(' + t + ')';
    else if (v === undefined) v = '(absent)';
    v = String(v).slice(0, 60);
    counts[v] = (counts[v] || 0) + 1;
  });
  const keys = Object.keys(counts);
  if (keys.length > 400) return { path: path, f: f, where: w.used, docs: snap.size, distinct: keys.length, note: 'trop de valeurs distinctes : non rendues' };
  return { path: path, f: f, where: w.used, limit: lim, docs: snap.size, values: counts };
}

// ── Traitements d'IA : agrégat officiel + recomptage du journal détaillé ──
async function partAi() {
  const out = { ai_usage_months: [], ai_usage_recount: {}, ai_usage_docs: 0, at_min: null, at_max: null };
  const m = await db.collection('ai_usage_months').get();
  m.forEach(function (d) {
    const x = d.data() || {};
    out.ai_usage_months.push({ id: d.id, month: x.month || null, calls: x.calls == null ? null : x.calls, costUsd: x.costUsd == null ? null : x.costUsd, byTask: x.byTask || null, updatedAt: iso(x.updatedAt), alertSentAt: iso(x.alertSentAt) });
  });
  const snap = await db.collection('ai_usage').select('task', 'month', 'ok', 'source', 'at').get();
  out.ai_usage_docs = snap.size;
  let mn = null, mx = null;
  snap.forEach(function (d) {
    const x = d.data() || {};
    const t = ms(x.at);
    if (t != null) { if (mn == null || t < mn) mn = t; if (mx == null || t > mx) mx = t; }
    const monthParis = t != null ? paris(t).slice(0, 7) : '(sans date)';
    const k = [monthParis, String(x.month || '(absent)'), String(x.task || '(absent)'), String(x.ok), String(x.source || '(absent)')].join('|');
    out.ai_usage_recount[k] = (out.ai_usage_recount[k] || 0) + 1;
  });
  out.at_min = iso(mn); out.at_max = iso(mx);
  out.recount_key = 'mois_Paris_du_champ_at|champ_month|task|ok|source';
  return out;
}

// ── Réglages IA (sans aucune clé) ──
function scrub(o, depth) {
  if (o == null || typeof o !== 'object') return o;
  if (typeOf(o) === 'timestamp') return iso(o);
  if (Array.isArray(o)) return o.map(function (x) { return scrub(x, depth + 1); });
  const r = {};
  Object.keys(o).forEach(function (k) {
    if (/key|secret|token|password|credential/i.test(k)) { r[k] = '(masqué)'; return; }
    r[k] = scrub(o[k], depth + 1);
  });
  return r;
}
async function partConfigAi() {
  const a = await db.collection('_config').doc('ai').get();
  const c = await db.collection('_config').doc('ai_context').get();
  return {
    '_config/ai': a.exists ? scrub(a.data(), 0) : null,
    '_config/ai__updateTime': a.exists && a.updateTime ? a.updateTime.toDate().toISOString() : null,
    '_config/ai__createTime': a.exists && a.createTime ? a.createTime.toDate().toISOString() : null,
    '_config/ai_context': c.exists ? scrub(c.data(), 0) : null,
    '_config/ai_context__updateTime': c.exists && c.updateTime ? c.updateTime.toDate().toISOString() : null,
    '_config/ai_context__createTime': c.exists && c.createTime ? c.createTime.toDate().toISOString() : null,
  };
}

// ── Équipe : identifiants internes seulement ──
async function partTeam() {
  const s = await db.collection('_meta').doc('team_members').get();
  if (!s.exists) return { exists: false };
  const data = s.data() || {};
  const acc = {};
  walk(data, '', acc, 1);
  const members = [];
  function push(slug, m) {
    if (!m || typeof m !== 'object') return;
    const row = { slug: slug };
    Object.keys(m).forEach(function (k) {
      const v = m[k];
      if (/mail|phone|tel|photo|avatar|adresse|address|iban|birth|naissance/i.test(k)) { row[k] = '(non exporté)'; return; }
      const t = typeOf(v);
      if (t === 'string' || t === 'number' || t === 'boolean' || t === 'null') row[k] = v;
      else if (t === 'timestamp') row[k] = iso(v);
      else row[k] = '(' + t + ')';
    });
    members.push(row);
  }
  const list = data.members || data.list || data;
  if (Array.isArray(list)) list.forEach(function (m, i) { push(m && (m.slug || m.id) || String(i), m); });
  else Object.keys(list).forEach(function (k) { push(k, list[k]); });
  return { exists: true, updateTime: s.updateTime ? s.updateTime.toDate().toISOString() : null, topLevelKeys: Object.keys(data).length, fieldNames: Object.keys(acc).length > 600 ? '(trop nombreux)' : acc, members: members };
}


function h(id) { return id ? crypto.createHash('sha256').update('litige:' + id).digest('hex').slice(0, 12) : null; }
function meta(d) { return { createTime: d.createTime ? d.createTime.toDate().toISOString() : null, updateTime: d.updateTime ? d.updateTime.toDate().toISOString() : null }; }

// ── EOD : dates remplies par compte (jamais le contenu) ──
async function partEod() {
  const parents = await db.collection('eod').listDocuments();
  const rows = [];
  for (const p of parents) {
    const snap = await p.collection('jours').get();
    snap.forEach(function (d) {
      const x = d.data() || {};
      const m = meta(d);
      rows.push({
        compte: p.id, jour: d.id, champ_date: x.date || null, champ_uid: x.uid || null, champ_name: x.name || null,
        updatedAt: iso(x.updatedAt), createTime: m.createTime, updateTime: m.updateTime,
        a_setting: !!x.setting, a_closing: !!x.closing, closingSkipped: x.closingSkipped === true, a_kpis: !!x.kpis,
        nb_feedback: Array.isArray(x.feedback) ? x.feedback.length : 0,
      });
    });
  }
  return { chemin: 'eod/{compte}/jours/{jour}', comptes: parents.map(function (p) { return p.id; }), lignes: rows.length, rows: rows };
}

// ── Commissions d'un compte : lignes sans client ──
const DEAL_DROP = { client: 1, email: 1, notes: 1, leadId: 1 };
async function partCommissions(query) {
  const ids = String(query.ids || '').split(',').filter(function (x) { return /^[A-Za-z0-9_\-]{2,60}$/.test(x); });
  const out = [];
  for (const id of ids) {
    const base = db.collection('commissions').doc(id);
    const parent = await base.get();
    const sub = await base.listCollections();
    const entry = { compte: id, docParentExiste: parent.exists, sousCollections: sub.map(function (c) { return c.id; }), mois: [], total: [] };
    const mois = await base.collection('mois').get();
    mois.forEach(function (d) {
      const x = d.data() || {};
      const deals = Array.isArray(x.deals) ? x.deals : [];
      const autres = Object.keys(x).filter(function (k) { return k !== 'deals'; });
      entry.mois.push(Object.assign({ id: d.id, autresChamps: autres, nbDeals: deals.length }, meta(d), {
        deals: deals.map(function (dl, i) {
          const r = { index: i, champsPresents: Object.keys(dl || {}).sort() };
          Object.keys(dl || {}).forEach(function (k) {
            if (DEAL_DROP[k]) return;
            const v = dl[k];
            if (k === 'bookingId' || k === 'dealKey') { r[k + '_empreinte'] = h(String(v)); return; }
            const t = typeOf(v);
            r[k] = (t === 'timestamp') ? iso(v) : (t === 'object' || t === 'array') ? JSON.stringify(scrub(v, 0)) : v;
          });
          return r;
        }),
      }));
    });
    const tot = await base.collection('total').get();
    tot.forEach(function (d) { entry.total.push(Object.assign({ id: d.id, data: scrub(d.data(), 0) }, meta(d))); });
    out.push(entry);
  }
  const cfg = await db.collection('_config').doc('commissions').get();
  return { comptes: out, '_config/commissions': cfg.exists ? scrub(cfg.data(), 0) : null };
}

// ── Fiches d'agenda (booking_config) : horaires et branchements, sans adresse ──
function dom(e) { e = String(e || ''); const i = e.lastIndexOf('@'); return i > 0 ? e.slice(i + 1).toLowerCase() : (e ? '(sans @)' : null); }
function conn(c) {
  if (!c || typeof c !== 'object') return null;
  const r = { champs: Object.keys(c).sort(), domaineEmail: dom(c.email) };
  ['id', 'connectedAt', 'createdAt', 'archivedAt', 'addedAt', 'updatedAt'].forEach(function (k) { if (c[k] != null) r[k] = typeOf(c[k]) === 'timestamp' ? iso(c[k]) : c[k]; });
  if (Array.isArray(c.calendars)) r.calendars = c.calendars.map(function (k) { return { primary: k.primary === true, checkConflicts: k.checkConflicts, createEvents: k.createEvents }; });
  return r;
}
async function partPersons() {
  const snap = await db.collection('booking_config').get();
  const rows = [];
  snap.forEach(function (d) {
    const x = d.data() || {};
    if (d.id.charAt(0) === '_') { rows.push(Object.assign({ id: d.id, special: true, champs: Object.keys(x).sort(), updatedAt: iso(x.updatedAt), updatedByName: x.updatedByName || null }, meta(d))); return; }
    rows.push(Object.assign({
      id: d.id, type: x.__type || null, name: x.name || null, title: x.title || null, firebaseUid: x.firebaseUid || null, isCoach: x.isCoach === true,
      champs: Object.keys(x).sort(),
      schedule: x.schedule || null,
      dateOverrides: x.dateOverrides || null,
      availabilityRules: Array.isArray(x.availabilityRules) ? x.availabilityRules : null,
      blockedDates: x.blockedDates || null,
      bufferBefore: x.bufferBefore == null ? null : x.bufferBefore, bufferAfter: x.bufferAfter == null ? null : x.bufferAfter,
      minNoticeHours: x.minNoticeHours == null ? null : x.minNoticeHours, maxPerDay: x.maxPerDay == null ? null : x.maxPerDay, maxPerWeek: x.maxPerWeek == null ? null : x.maxPerWeek,
      calendarConnected: x.calendarConnected == null ? null : x.calendarConnected,
      calendarEmailDomaine: dom(x.calendarEmail),
      calendarList: Array.isArray(x.calendarList) ? x.calendarList.map(function (k) { return { primary: k.primary === true, checkConflicts: k.checkConflicts, createEvents: k.createEvents }; }) : null,
      extraConnections: Array.isArray(x.extraConnections) ? x.extraConnections.map(conn) : null,
      extraConnectionsArchived: Array.isArray(x.extraConnectionsArchived) ? x.extraConnectionsArchived.map(conn) : (x.extraConnectionsArchived ? '(' + typeOf(x.extraConnectionsArchived) + ')' : null),
    }, meta(d)));
  });
  return { chemin: 'booking_config', rows: rows };
}

// ── Agenda Google d'une fiche : existence des branchements, sans contenu ──
async function partCalendar(query) {
  const pid = String(query.pid || '');
  if (!/^[A-Za-z0-9_\-]{2,80}$/.test(pid)) return { error: 'pid' };
  const out = { pid: pid };
  const b = await db.collection('calendar_busy').doc(pid).get();
  if (b.exists) {
    const x = b.data() || {};
    out.calendar_busy = Object.assign({ champs: Object.keys(x).sort(), updatedAt: iso(x.updatedAt), nbPlagesOccupees: Array.isArray(x.busy) ? x.busy.length : null,
      calendarsChecked: typeOf(x.calendarsChecked) === 'number' ? x.calendarsChecked : (Array.isArray(x.calendarsChecked) ? x.calendarsChecked.length : null),
      sources: Array.isArray(x.sources) ? x.sources.map(function (s2) { return (s2 && typeof s2 === 'object') ? { champs: Object.keys(s2).sort(), type: s2.type || s2.kind || null, domaineEmail: dom(s2.email || s2.account), nb: s2.count == null ? null : s2.count } : String(typeOf(s2)); }) : null,
      busyBySourceCles: x.busyBySource && typeof x.busyBySource === 'object' ? Object.keys(x.busyBySource).length : null }, meta(b));
  } else out.calendar_busy = null;
  const t = await db.collection('calendar_tokens').doc(pid).get();
  out.calendar_tokens_principal = t.exists ? meta(t) : null;
  const ex = await db.collection('calendar_extra_tokens').listDocuments();
  const mine = ex.filter(function (r) { return r.id.indexOf(pid + '__') === 0; });
  out.calendar_extra_tokens = [];
  for (const r of mine) { const s2 = await r.get(); out.calendar_extra_tokens.push(Object.assign({ id_empreinte: h(r.id), existe: s2.exists }, s2.exists ? meta(s2) : {})); }
  const av = await db.collection('availability_daily').where('personId', '==', pid).get();
  out.availability_daily = [];
  av.forEach(function (d) { const x = d.data() || {}; out.availability_daily.push(Object.assign({ id: d.id, personName: x.personName || null, month: x.month || null, days: x.days || null, updatedAt: iso(x.updatedAt) }, meta(d))); });
  return out;
}

const PARTS = {
  eod: partEod, commissions: partCommissions, persons: partPersons, calendar: partCalendar,
  cols: partCols, subcols: partSubcols, count: partCount, fields: partFields, distinct: partDistinct,
  ai: partAi, config_ai: partConfigAi, team: partTeam,
};

module.exports = async function handler(req, res) {
  if (!keyOk(req)) { res.status(404).end('Not found'); return; }
  if (req.method !== 'GET') { res.status(405).end(); return; }
  const query = req.query || {};
  const part = String(query.part || '');
  const fn = PARTS[part];
  if (!fn) { res.status(400).json({ error: 'part inconnue', parts: Object.keys(PARTS) }); return; }
  const now = new Date();
  try {
    const data = await fn(query);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({
      extraction: {
        utc: now.toISOString(),
        paris: paris(now.getTime()),
        projetFirebase: process.env.FIREBASE_ADMIN_PROJECT_ID || null,
        requete: req.url,
        commitVercel: process.env.VERCEL_GIT_COMMIT_SHA || null,
        lectureSeule: true,
      },
      resultat: data,
    });
  } catch (e) {
    res.status(200).json({ extraction: { utc: now.toISOString(), requete: req.url }, erreur: String(e && e.message || e) });
  }
};
