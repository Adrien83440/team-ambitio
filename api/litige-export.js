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
const { db, admin } = require('./_firebaseAdmin');

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
      else if (k === 'contract') row[k] = scrub(v, 0);
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
  ['connectedAt', 'createdAt', 'archivedAt', 'addedAt', 'updatedAt'].forEach(function (k) { if (c[k] != null) r[k] = typeOf(c[k]) === 'timestamp' ? iso(c[k]) : c[k]; });
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


function dayBounds(from, to) {
  // Jours de Paris → bornes UTC larges (un jour de marge), filtrage exact ensuite sur le jour de Paris.
  return { a: new Date(new Date(from + 'T00:00:00Z').getTime() - 86400000), b: new Date(new Date(to + 'T00:00:00Z').getTime() + 2 * 86400000) };
}
function isoDay(x) { return /^\d{4}-\d{2}-\d{2}$/.test(String(x || '')); }
function normFirst(v) { return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim().split(/\s+/)[0]; }

// ── Rendez-vous rattachés à un compte : aucune donnée du prospect ──
async function partBookings(query) {
  const from = String(query.from || ''), to = String(query.to || ''), pid = String(query.pid || ''), slug = String(query.slug || ''), uid = String(query.uid || '');
  if (!isoDay(from) || !isoDay(to) || !pid || !slug) return { error: 'from, to, pid, slug' };
  const snap = await db.collection('bookings').where('date', '>=', from).where('date', '<=', to).get();
  const rows = [];
  const leadRefs = {};
  snap.forEach(function (d) {
    const x = d.data() || {};
    const cd = x.closeData || {};
    const why = [];
    if (x.personId === pid) why.push('personId');
    if (x.expertSlug === slug) why.push('expertSlug');
    if (cd.closerSlug === slug) why.push('closeData.closerSlug');
    if (cd.setterSlug === slug) why.push('closeData.setterSlug');
    if (x.bookedBySlug === slug || (uid && x.bookedByUid === uid)) why.push('bookedBy');
    if (!why.length) return;
    const c = x.cancellation || {}, L = x.landing || {}, rp = x.replay || {}, pc = x.presenceConfirmed || null;
    const m = meta(d);
    rows.push({
      rdv: h(d.id), motif_rattachement: why.join('+'),
      date: x.date || null, time: x.time || null, timezone: x.timezone || null, duration: x.duration == null ? null : x.duration,
      type: x.type || null, typeLabel: x.typeLabel || null, isCoaching: x.isCoaching === true,
      personId: x.personId || null, personName: x.personName || null, expertSlug: x.expertSlug || null,
      createdAt_utc: iso(x.createdAt), createdAt_paris: paris(x.createdAt), firestore_createTime: m.createTime, firestore_updateTime: m.updateTime,
      source: x.source == null ? null : x.source, bookedBySlug: x.bookedBySlug || null, bookedByName: x.bookedByName || null, bookedByUid_present: !!x.bookedByUid,
      leadLinkType: x.leadLinkType || null, formId_present: !!x.formId, clientId_present: !!x.clientId, skipLeadCreation: x.skipLeadCreation === true,
      landing_page: L.page || null, landing_variant: L.variant || null,
      status: x.status || null, statusUpdatedAt: iso(x.statusUpdatedAt), statusUpdatedByName: x.statusUpdatedByName || null,
      outcome: x.outcome || null, outcomeAt_utc: iso(x.outcomeAt), outcomeAt_paris: paris(x.outcomeAt), outcomeDay: x.outcomeDay || null, outcomeByName: x.outcomeByName || null,
      outcomeHistory: Array.isArray(x.outcomeHistory) ? x.outcomeHistory.map(function (o) { return { outcome: o.outcome || null, at: typeof o.at === 'string' ? o.at : iso(o.at), byName: o.byName || null }; }) : null,
      cancelledAt: iso(x.cancelledAt), cancelledOrigin: x.cancelledOrigin || null, cancelledByName: x.cancelledByName || null,
      cancellation_at: iso(c.at), cancellation_origin: c.origin || null, cancellation_via: c.via || null, cancellation_byRole: c.byRole || null, cancellation_kind: c.kind || null,
      noShowAt: iso(x.noShowAt), noShowByName: x.noShowByName || null, completedAt: iso(x.completedAt),
      transferredAt: iso(x.transferredAt), transferredBy_present: !!x.transferredBy,
      closeData_closerSlug: cd.closerSlug || null, closeData_setterSlug: cd.setterSlug || null, closeData_offre: cd.offre || null, closeData_subtype: cd.subtype || null, closeData_sb: typeof cd.sb === 'boolean' ? cd.sb : null,
      slotOpen: x.slotOpen == null ? null : x.slotOpen,
      presenceConfirmed_at: pc ? iso(pc.at) : null, presenceConfirmed_bySlug: pc ? (pc.bySlug || null) : null, presenceConfirmed_channel: pc ? (pc.channel || null) : null,
      replay_status: rp.status || null, replay_importedAt: iso(rp.importedAt), replay_chaptersGeneratedAt: iso(rp.chaptersGeneratedAt), replay_analysisAt: iso(rp.analysisAt),
      aiPrep_present: !!x.aiPrep,
      _lead: x.leadId || null,
    });
    if (x.leadId) leadRefs[x.leadId] = 1;
  });
  // Provenance : mêmes champs que srcOf() de api/_aiTools.js, lus sur la fiche lead (rien d'autre).
  const ids = Object.keys(leadRefs), prov = {};
  for (let i = 0; i < ids.length; i += 200) {
    const refs = ids.slice(i, i + 200).map(function (id) { return db.collection('leads').doc(id); });
    const docs = await db.getAll.apply(db, refs.concat([{ fieldMask: ['landingFirst.label', 'sourceDetail', 'type', 'source'] }]));
    docs.forEach(function (d) {
      if (!d.exists) { prov[d.id] = { existe: false }; return; }
      const l = d.data() || {};
      prov[d.id] = { existe: true, landingFirst_label: (l.landingFirst && l.landingFirst.label) || null, sourceDetail: l.sourceDetail || null, type: l.type || null, source: l.source || null };
    });
  }
  rows.forEach(function (r) {
    const p2 = r._lead ? prov[r._lead] : null;
    r.lead_present = !!r._lead; r.lead_fiche_existe = p2 ? p2.existe : null;
    r.lead_landingFirst_label = p2 ? (p2.landingFirst_label || null) : null; r.lead_sourceDetail = p2 ? (p2.sourceDetail || null) : null;
    r.lead_type = p2 ? (p2.type || null) : null; r.lead_source = p2 ? (p2.source || null) : null;
    delete r._lead;
  });
  rows.sort(function (a, b) { return String(a.date + a.time).localeCompare(String(b.date + b.time)); });
  return { requete: "bookings where date >= '" + from + "' and date <= '" + to + "'", lus: snap.size, retenus: rows.length, critere: { personId: pid, slug: slug, uid_fourni: !!uid }, rows: rows };
}

// ── Appels d'un compte : ni numéro ni nom de prospect ──
const CALL_SEL = ['provider', 'direction', 'status', 'initiatedAt', 'startTime', 'answeredAt', 'endTime', 'endedAt', 'durationSec', 'talkDurationSec', 'totalDurationSec',
  'ringingDurationSec', 'amd', 'hangupBy', 'disposition', 'userId', 'userName', 'ringoverUserName', 'ringoverUserId', 'syncedVia', 'recordingStatus', 'transcriptionStatus',
  'aiAnalysisStatus', 'aiAnalyzedAt', 'transcribedAt', 'aiCall.at', 'leadId', 'sessionId', 'campaignId', 'createdAt'];
async function partCalls(query) {
  const from = String(query.from || ''), to = String(query.to || ''), uid = String(query.uid || ''), first = normFirst(query.first || '');
  if (!isoDay(from) || !isoDay(to) || !uid || !first) return { error: 'from, to, uid, first' };
  const B = dayBounds(from, to);
  const q = db.collection('call_logs').where('initiatedAt', '>=', B.a).where('initiatedAt', '<', B.b);
  const snap = await q.select.apply(q, CALL_SEL).get();
  const rows = []; let inRange = 0;
  const userIds = {};
  snap.forEach(function (d) {
    const x = d.data() || {};
    const day = paris(x.initiatedAt); if (!day) return;
    const dd = day.slice(0, 10); if (dd < from || dd > to) return;
    inRange++;
    const byUid = x.userId === uid;
    const byUserName = normFirst(x.userName) === first;
    const byRingover = normFirst(x.ringoverUserName) === first;
    if (!byUid && !byUserName && !byRingover) return;
    userIds[String(x.userId || '(absent)')] = (userIds[String(x.userId || '(absent)')] || 0) + 1;
    rows.push({
      appel: h(d.id), rattachement: [byUid ? 'userId' : null, byUserName ? 'userName' : null, byRingover ? 'ringoverUserName' : null].filter(Boolean).join('+'),
      userId_est_le_compte: byUid, userId_autre_compte: !!x.userId && !byUid,
      provider: x.provider || null, direction: x.direction || null, status: x.status || null,
      initiatedAt_utc: iso(x.initiatedAt), initiatedAt_paris: day,
      startTime: x.startTime || null, answeredAt_utc: iso(x.answeredAt), endTime: x.endTime || null, endedAt_utc: iso(x.endedAt),
      durationSec: x.durationSec == null ? null : x.durationSec, talkDurationSec: x.talkDurationSec == null ? null : x.talkDurationSec,
      totalDurationSec: x.totalDurationSec == null ? null : x.totalDurationSec, ringingDurationSec: x.ringingDurationSec == null ? null : x.ringingDurationSec,
      amd: x.amd == null ? null : x.amd, hangupBy: x.hangupBy || null, disposition: x.disposition || null, syncedVia: x.syncedVia || null,
      recordingStatus: x.recordingStatus || null, transcriptionStatus: x.transcriptionStatus || null, transcribedAt: iso(x.transcribedAt),
      aiAnalysisStatus: x.aiAnalysisStatus || null, aiAnalyzedAt: iso(x.aiAnalyzedAt), aiCall_at: x.aiCall && x.aiCall.at ? iso(x.aiCall.at) : null,
      lead_rattache: !!x.leadId, session_dialer: !!x.sessionId, campagne_dialer: !!x.campaignId,
    });
  });
  rows.sort(function (a, b) { return String(a.initiatedAt_utc).localeCompare(String(b.initiatedAt_utc)); });
  return { requete: 'call_logs where initiatedAt >= ' + B.a.toISOString() + ' and < ' + B.b.toISOString() + ' ; puis jour de Paris entre ' + from + ' et ' + to,
    lus: snap.size, dans_la_periode_tous_comptes: inRange, retenus: rows.length, critere: { uid: uid, prenom_normalise: first }, userId_des_lignes_retenues: Object.keys(userIds).length, rows: rows };
}

// ── Traitements automatiques hors journal ai_usage, par mois (toute l'équipe) ──
async function partAiLegacy(query) {
  const from = String(query.from || ''), to = String(query.to || '');
  if (!isoDay(from) || !isoDay(to)) return { error: 'from, to' };
  const B = dayBounds(from, to);
  const out = { appels: {}, rdv: {}, notes_vocales: {} };
  function inc(o, k) { o[k] = (o[k] || 0) + 1; }
  function mo(v) { const p2 = paris(v); return p2 ? p2.slice(0, 7) : null; }
  const q = db.collection('call_logs').where('initiatedAt', '>=', B.a).where('initiatedAt', '<', B.b);
  const cs = await q.select('initiatedAt', 'provider', 'recordingStatus', 'transcriptionStatus', 'transcribedAt', 'aiAnalysisStatus', 'aiAnalyzedAt', 'aiCall.at', 'aiCall.model', 'transcriptionLanguage').get();
  out.appels_lus = cs.size;
  cs.forEach(function (d) {
    const x = d.data() || {}; const m = mo(x.initiatedAt); if (!m) return; const p2 = x.provider || '(absent)';
    inc(out.appels, m + '|' + p2 + '|appels');
    if (x.recordingStatus) inc(out.appels, m + '|' + p2 + '|recordingStatus=' + x.recordingStatus);
    if (x.transcriptionStatus) inc(out.appels, m + '|' + p2 + '|transcriptionStatus=' + x.transcriptionStatus);
    if (x.transcribedAt) inc(out.appels, m + '|' + p2 + '|transcribedAt_present');
    if (x.aiAnalysisStatus) inc(out.appels, m + '|' + p2 + '|aiAnalysisStatus=' + x.aiAnalysisStatus);
    if (x.aiAnalyzedAt) inc(out.appels, m + '|' + p2 + '|aiAnalyzedAt_present');
    if (x.aiCall && x.aiCall.at) inc(out.appels, m + '|' + p2 + '|aiCall_present');
  });
  const bs = await db.collection('bookings').where('date', '>=', from).where('date', '<=', to).select('date', 'replay.status', 'replay.importedAt', 'replay.chaptersGeneratedAt', 'replay.chaptersModel', 'replay.analysisAt', 'replay.analysisModel', 'aiPrep.generatedAt', 'aiPrep.model', 'isCoaching').get();
  out.rdv_lus = bs.size;
  bs.forEach(function (d) {
    const x = d.data() || {}; const m = String(x.date || '').slice(0, 7); const rp = x.replay || {};
    inc(out.rdv, m + '|rdv');
    if (rp.status) inc(out.rdv, m + '|replay.status=' + rp.status);
    if (rp.importedAt) inc(out.rdv, m + '|replay.importedAt_present');
    if (rp.chaptersGeneratedAt) inc(out.rdv, m + '|replay.chaptersGeneratedAt_present|modele=' + (rp.chaptersModel || '(absent)'));
    if (rp.analysisAt) inc(out.rdv, m + '|replay.analysisAt_present|modele=' + (rp.analysisModel || '(absent)'));
    if (x.aiPrep) inc(out.rdv, m + '|aiPrep_present');
  });
  try {
    const vs = await db.collectionGroup('voice_notes').select('createdAt', 'transcriptionStatus', 'transcribedAt').get();
    out.notes_vocales_lues = vs.size;
    vs.forEach(function (d) { const x = d.data() || {}; const m = mo(x.createdAt) || mo(x.transcribedAt) || '(sans date)'; inc(out.notes_vocales, m + '|notes'); if (x.transcriptionStatus) inc(out.notes_vocales, m + '|transcriptionStatus=' + x.transcriptionStatus); });
  } catch (e) { out.notes_vocales_erreur = String(e && e.message || e).slice(0, 300); }
  out.cle = 'mois|...|indicateur (mois de Paris de initiatedAt pour les appels, mois du champ date pour les RDV, mois de createdAt pour les notes vocales)';
  return out;
}

// ── Existence (jamais le contenu) des traces liées à un compte ──
async function partTraces(query) {
  const uid = String(query.uid || ''), slug = String(query.slug || '');
  if (!/^[A-Za-z0-9]{20,40}$/.test(uid) || !/^[a-z0-9_\-]{2,40}$/.test(slug)) return { error: 'uid, slug' };
  const out = { uid: uid, slug: slug };
  async function cnt(q) { try { return (await q.count().get()).data().count; } catch (e) { return 'erreur: ' + String(e && e.message || e).slice(0, 160); } }
  async function ex(path) { try { const r = refOf(path); const s2 = await r.ref.get(); return s2.exists ? Object.assign({ existe: true, champs: Object.keys(s2.data() || {}).sort() }, meta(s2)) : { existe: false }; } catch (e) { return 'erreur: ' + String(e.message).slice(0, 160); } }
  const FP = admin.firestore.FieldPath.documentId();
  out['users/{uid}'] = await ex('users/' + uid);
  out['user_activity/{uid}'] = await ex('user_activity/' + uid);
  try {
    const ua = await db.collection('user_activity').where(FP, '>=', uid + '_').where(FP, '<', uid + '_').select().get();
    const ids = ua.docs.map(function (d) { return d.id.slice(uid.length + 1); }).sort();
    out['user_activity/{uid}_{jour}'] = { nombre: ids.length, premier_jour: ids[0] || null, dernier_jour: ids[ids.length - 1] || null };
  } catch (e) { out['user_activity/{uid}_{jour}'] = 'erreur: ' + String(e.message).slice(0, 160); }
  out['user_events (uid)'] = await cnt(db.collection('user_events').where('uid', '==', uid));
  out['dialer_sessions/{uid}'] = await ex('dialer_sessions/' + uid);
  out['dialer_sessions (userId)'] = await cnt(db.collection('dialer_sessions').where('userId', '==', uid));
  out['ai_usage (uid)'] = await cnt(db.collection('ai_usage').where('uid', '==', uid));
  out['ai_training (uid)'] = await cnt(db.collection('ai_training').where('uid', '==', uid));
  out['ai_followups (closerUid)'] = await cnt(db.collection('ai_followups').where('closerUid', '==', uid));
  out['rdv_confirmations (by.uid)'] = await cnt(db.collection('rdv_confirmations').where('by.uid', '==', uid));
  out['sale_celebrations (targetUid)'] = await cnt(db.collection('sale_celebrations').where('targetUid', '==', uid));
  out['sale_celebrations (closerSlug)'] = await cnt(db.collection('sale_celebrations').where('closerSlug', '==', slug));
  out['fcm_tokens/{uid}'] = (await db.collection('fcm_tokens').doc(uid).get()).exists;
  out['call_logs (userId)'] = await cnt(db.collection('call_logs').where('userId', '==', uid));
  out['call_logs (aiCall.setterUid)'] = await cnt(db.collection('call_logs').where('aiCall.setterUid', '==', uid));
  try {
    const fb = await db.collection('ai_feedback').select().get();
    const mine = fb.docs.map(function (d) { return d.id; }).filter(function (id) { return id.slice(-uid.length) === uid; }).sort();
    out['ai_feedback/{jour}_{uid}'] = { nombre: mine.length, total_tous_comptes: fb.size, premier: mine[0] ? mine[0].slice(0, 10) : null, dernier: mine.length ? mine[mine.length - 1].slice(0, 10) : null };
  } catch (e) { out['ai_feedback'] = 'erreur: ' + String(e.message).slice(0, 160); }
  for (const col of ['lead_actions', 'saisies', 'commissions', 'eod']) {
    for (const id of [slug, uid]) {
      try {
        const subs = await db.collection(col).doc(id).listCollections();
        const o = {};
        for (const c of subs) { o[c.id] = await cnt(c); }
        out[col + '/' + (id === slug ? '{slug}' : '{uid}')] = { sousCollections: o };
      } catch (e) { out[col + '/' + id] = 'erreur'; }
    }
  }
  try {
    const u = await admin.auth().getUser(uid);
    out.firebase_auth = { existe: true, disabled: u.disabled === true, creationTime_present: !!(u.metadata && u.metadata.creationTime), lastSignInTime_present: !!(u.metadata && u.metadata.lastSignInTime), lastRefreshTime_present: !!(u.metadata && u.metadata.lastRefreshTime), creationTime: u.metadata ? u.metadata.creationTime : null, tokensValidAfterTime: u.tokensValidAfterTime || null };
  } catch (e) { out.firebase_auth = 'erreur: ' + String(e && e.message || e).slice(0, 160); }
  // Journal d'audit : entrées qui visent ce compte (champs techniques seulement).
  const AUD = ['action', 'type', 'at', 'timestamp', 'createdAt', 'fromSlug', 'toSlug', 'targetUid', 'targetSlug', 'byUid', 'actorUid', 'toUid', 'counts', 'transferCount', 'includeClosed', 'includeHistory', 'bookingPersonId', 'bookingsCancelled', 'archived', 'via', 'mode'];
  out.audit_log = [];
  const seen = {};
  for (const w of [['targetUid', uid], ['fromSlug', slug], ['targetSlug', slug], ['bookingPersonId', slug]]) {
    try {
      const a = await db.collection('audit_log').where(w[0], '==', w[1]).get();
      a.forEach(function (d) {
        if (seen[d.id]) return; seen[d.id] = 1;
        const x = d.data() || {}; const r = { id: d.id, trouve_par: w[0], champs: Object.keys(x).sort() };
        AUD.forEach(function (k) { if (x[k] != null) r[k] = scrub(x[k], 0); });
        out.audit_log.push(Object.assign(r, meta(d)));
      });
    } catch (e) { out.audit_log.push({ erreur: w[0] + ': ' + String(e.message).slice(0, 160) }); }
  }
  try {
    const a2 = await db.collection('audit_log').where(FP, '>=', 'transfer_').where(FP, '<', 'transfer_').get();
    a2.forEach(function (d) { if (seen[d.id]) return; seen[d.id] = 1; const x = d.data() || {}; const r = { id: d.id, trouve_par: 'identifiant transfer_*', champs: Object.keys(x).sort() }; AUD.forEach(function (k) { if (x[k] != null) r[k] = scrub(x[k], 0); }); out.audit_log.push(Object.assign(r, meta(d))); });
  } catch (e) { out.audit_log.push({ erreur: 'transfer_: ' + String(e.message).slice(0, 160) }); }
  return out;
}

const PARTS = {
  bookings: partBookings, calls: partCalls, ai_legacy: partAiLegacy, traces: partTraces,
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
