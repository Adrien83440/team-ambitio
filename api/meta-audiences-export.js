// ============================================================================
// api/meta-audiences-export.js — AUDIENCES META ADS, LECTURE SEULE (12/11/2026)
// ----------------------------------------------------------------------------
// Demande Adrien : trois fichiers d'audiences personnalisées Meta tirés des
// leads Elite. ENDPOINT TEMPORAIRE : il vit sur la branche de travail, sur la
// preview Vercel uniquement, et n'est jamais fusionné sur main.
//
// N'ÉCRIT RIEN. Deux modes :
//   GET ?mode=count               → effectifs + diagnostic, AUCUNE donnée
//                                   personnelle (libellés de provenance,
//                                   réponses CA du quiz, compteurs) ;
//   GET ?mode=csv&file=1|2|3      → le CSV (email, phone, fn, ln, country).
//                                   Données personnelles en clair : exception
//                                   à la règle 8 du CLAUDE.md validée par
//                                   Adrien le 12/11/2026 pour cet export.
//
// Accès : en-tête `x-export-key` égal à la variable Vercel META_EXPORT_KEY.
// Variable absente ou clé fausse → 404. La retirer coupe l'accès.
//
// Règles (validées par Adrien, « tes recos ») :
//   · périmètre Elite = une trace de provenance d'un des 4 tunnels (quiz
//     Elite, quiz Élections, VSL Élite, Audit Stratégique Personnalisé) ET
//     aucune trace Business (fiche, historique des passages, RDV) ;
//   · fiches `_merged: true` ignorées ; contacts bloqués / STOP retirés des
//     fichiers 1 et 2 et ajoutés au fichier 3 ;
//   · CA déclaré : quiz.ca_mensuel, sinon quiz.reponses[] / formAnswers[]
//     sur une question de CA, sinon le dernier passage archivé
//     (engagementHistory[]). ≥ 20 000 € = BORNE BASSE de la tranche ;
//   · date d'entrée = realEntryMs (plus ancienne de dateWebinaire,
//     importedCreatedAt, createdAt) ;
//   · client = status 'client' OU isClient OU stage closed_won_* ;
//     client Elite = offre Elite ou Titan (fiche ou RDV closé), ou offre
//     inconnue sur une fiche du périmètre Elite ;
//   · RDV honoré = bookings.outcome close / non_close / offre sur un RDV
//     commercial (classifyBooking ≠ excluded) ; chaud = aiLead.niveau ;
//   · fichier 3 = TOUS tunnels (+ collection clients + blocked_contacts) ;
//   · une ligne par email (sinon par téléphone), country = FR.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const { toE164 } = require('./_leadLookup');
const { realEntryMs, parseFlexMs } = require('./_leadDates');

const DAY = 86400000;

function keyOk(req) {
  const want = String(process.env.META_EXPORT_KEY || '');
  const got = String((req.headers && req.headers['x-export-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function norm(s) {
  let t = String(s == null ? '' : s);
  if (typeof t.normalize === 'function') t = t.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return t.toLowerCase().replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/* ── Provenance ─────────────────────────────────────────────────────────── */
const ELITE_RULES = [
  { k: 'quiz_elections', re: /election/ },
  { k: 'audit_strategique', re: /audit strat/ },
  { k: 'quiz_elite', re: /quiz.{0,20}elite|elite.{0,20}quiz|quiz_elite|^quiz_funnel$/ },
  { k: 'vsl_elite', re: /vsl.{0,3}elite|^elite$/ }
];
const BUSINESS_RE = /business|\bbp\b|bp_|phenix business/;

function landingTokens(L, tmap, out) {
  if (!L || typeof L !== 'object') return;
  if (L.page) {
    out.push(String(L.page));
    const t = tmap[String(L.page).split('__')[0]];
    if (t) { out.push(t.name); if (t.crmLabel) out.push(t.crmLabel); }
  }
  if (L.label) out.push(String(L.label));
  if (L.tunnelId && tmap['#' + L.tunnelId]) {
    const t2 = tmap['#' + L.tunnelId];
    out.push(t2.name); if (t2.crmLabel) out.push(t2.crmLabel);
  }
  if (L.pageUrl) {
    try { out.push(new URL(String(L.pageUrl)).pathname.slice(0, 80)); } catch (e) { /* ignoré */ }
  }
}

function provenanceTokens(l, tmap, bks, typeMap) {
  const out = [];
  if (l.type) out.push(String(l.type));
  if (l.sourceDetail) out.push(String(l.sourceDetail));
  if (l.utm) out.push(String(l.utm));
  landingTokens(l.landingFirst, tmap, out);
  landingTokens(l.landingLast, tmap, out);
  (Array.isArray(l.engagementHistory) ? l.engagementHistory : []).forEach(function (h) {
    if (!h) return;
    if (h.type) out.push(String(h.type));
    if (h.sourceDetail) out.push(String(h.sourceDetail));
    if (h.utm) out.push(String(h.utm));
    landingTokens(h.landing, tmap, out);
  });
  (bks || []).forEach(function (b) {
    const t = typeMap[b.type];
    if (t && t.label) out.push('rdv:' + t.label);
    else if (b.type) out.push('rdv:' + b.type);
    landingTokens(b.landing, tmap, out);
  });
  return out.map(function (x) { return String(x).slice(0, 120); }).filter(Boolean);
}

function classifyTunnel(tokens) {
  const elite = {};
  let business = false;
  tokens.forEach(function (t) {
    const n = norm(t);
    if (BUSINESS_RE.test(n)) business = true;
    ELITE_RULES.forEach(function (r) { if (r.re.test(n)) elite[r.k] = 1; });
  });
  return { business: business, elite: Object.keys(elite) };
}

/* ── CA mensuel déclaré ─────────────────────────────────────────────────── */
const CA_Q_RE = /chiffre d.?affaires|\bca\b|ca_mensuel/;

function amounts(text) {
  const t = String(text || '').toLowerCase().replace(/[\s  .]/g, '');
  const re = /(\d+(?:,\d+)?)(k|m(?!ois))?/g;
  let m; const out = []; let anyK = false;
  while ((m = re.exec(t))) {
    let n = parseFloat(m[1].replace(',', '.'));
    if (m[2] === 'k') { n *= 1000; anyK = true; } else if (m[2] === 'm') n *= 1000000;
    out.push({ n: n, raw: !m[2] });
  }
  if (anyK) out.forEach(function (x) { if (x.raw && x.n < 1000) x.n *= 1000; });
  return out.map(function (x) { return x.n; });
}

/* Borne basse mensuelle de la réponse (null si illisible). */
function caLowerBound(answer, question) {
  const a = norm(answer), q = norm(question);
  if (/pas encore|aucun|^0 ?€?$|^0$/.test(a)) return 0;
  const ns = amounts(a);
  if (!ns.length) return null;
  const max = Math.max.apply(null, ns), min = Math.min.apply(null, ns);
  let lb;
  if (/moins de|inferieur|jusqu|</.test(a)) lb = 0;
  else if (/plus de|superieur|au-dela|>|\+/.test(a)) lb = max;
  else lb = min;
  const annual = /annuel|par an|\/ ?an\b|l.annee/.test(q + ' ' + a) && !/mensuel|par mois|\/ ?mois/.test(q + ' ' + a);
  return annual ? lb / 12 : lb;
}

function caFromBlock(quiz, formAnswers) {
  if (quiz && typeof quiz === 'object') {
    if (quiz.ca_mensuel) return { v: String(quiz.ca_mensuel), q: 'ca_mensuel', src: 'quiz.ca_mensuel' };
    const reps = Array.isArray(quiz.reponses) ? quiz.reponses : [];
    for (let i = 0; i < reps.length; i++) {
      const r = reps[i];
      if (r && r.question && CA_Q_RE.test(norm(r.question)) && r.reponse) {
        return { v: Array.isArray(r.reponse) ? r.reponse.join(', ') : String(r.reponse), q: r.question, src: 'quiz.reponses' };
      }
    }
  }
  const fas = Array.isArray(formAnswers) ? formAnswers : [];
  for (let j = 0; j < fas.length; j++) {
    const f = fas[j];
    const lbl = f && (f.label || f.fieldId);
    if (lbl && CA_Q_RE.test(norm(lbl)) && f.value != null && f.value !== '') {
      return { v: Array.isArray(f.value) ? f.value.join(', ') : String(f.value), q: lbl, src: 'formAnswers' };
    }
  }
  return null;
}

function declaredCa(l) {
  let c = caFromBlock(l.quiz, l.formAnswers);
  if (!c) {
    const hist = (Array.isArray(l.engagementHistory) ? l.engagementHistory : []).slice().sort(function (a, b) {
      return (parseFlexMs(b && b.archivedAt) || 0) - (parseFlexMs(a && a.archivedAt) || 0);
    });
    for (let i = 0; i < hist.length && !c; i++) {
      const h = hist[i];
      if (!h) continue;
      c = caFromBlock(h.quiz, h.formAnswers);
      if (c) c.src = 'engagementHistory.' + c.src;
    }
  }
  if (!c) return null;
  c.v = c.v.replace(/\s+/g, ' ').trim().slice(0, 200);
  c.lb = caLowerBound(c.v, c.q);
  return c;
}

/* ── Contact ────────────────────────────────────────────────────────────── */
function cleanEmail(v) {
  const e = String(v || '').trim().toLowerCase();
  return /^[^\s@,;]+@[^\s@,;]+\.[a-z]{2,}$/.test(e) ? e : '';
}
function cleanPhone(v) {
  const p = toE164(v);
  return /^\+\d{8,15}$/.test(p) ? p : '';
}
function phone9(v) { const d = String(v || '').replace(/\D/g, ''); return d.length >= 9 ? d.slice(-9) : ''; }

function splitName(o) {
  let fn = String(o.prenom || o.firstName || '').trim();
  let ln = String(o.lastName || '').trim();
  const nom = String(o.nom || '').trim();
  const bad = !nom || /@|\d{4,}|^sans nom$/i.test(nom);
  if (fn) {
    if (!ln && !bad) {
      ln = nom;
      if (norm(ln).indexOf(norm(fn) + ' ') === 0) ln = ln.slice(fn.length).trim();
      else if (norm(ln) === norm(fn)) ln = '';
    }
  } else if (!bad) {
    const parts = nom.split(/\s+/);
    fn = parts.shift() || '';
    ln = parts.join(' ');
  }
  return { fn: fn.slice(0, 60), ln: ln.slice(0, 80) };
}

function contactOf(o) {
  const n = splitName(o);
  return { email: cleanEmail(o.email), phone: cleanPhone(o.telephone || o.phone), fn: n.fn, ln: n.ln };
}

/* Une ligne par email ; sans email, une ligne par téléphone (et pas de
   doublon d'un téléphone déjà porté par une ligne email). */
function dedupe(contacts) {
  const byEmail = {}, byPhone = {}, rows = [];
  contacts.forEach(function (c) {
    if (c.email) {
      const ex = byEmail[c.email];
      if (ex) {
        if (!ex.phone && c.phone) ex.phone = c.phone;
        if (!ex.fn && c.fn) { ex.fn = c.fn; ex.ln = c.ln; }
        return;
      }
      const r = { email: c.email, phone: c.phone, fn: c.fn, ln: c.ln };
      byEmail[c.email] = r; rows.push(r);
    }
  });
  rows.forEach(function (r) { if (r.phone) byPhone[r.phone] = r; });
  contacts.forEach(function (c) {
    if (c.email || !c.phone) return;
    const ex = byPhone[c.phone];
    if (ex) { if (!ex.fn && c.fn) { ex.fn = c.fn; ex.ln = c.ln; } return; }
    const r = { email: '', phone: c.phone, fn: c.fn, ln: c.ln };
    byPhone[c.phone] = r; rows.push(r);
  });
  return rows;
}

function csvCell(v) {
  const s = String(v == null ? '' : v);
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCsv(rows) {
  const lines = ['email,phone,fn,ln,country'];
  rows.forEach(function (r) { lines.push([r.email, r.phone, r.fn, r.ln, 'FR'].map(csvCell).join(',')); });
  return lines.join('\n') + '\n';
}

/* ── Chargement ─────────────────────────────────────────────────────────── */
async function all(col, fields) {
  let q = db.collection(col);
  if (fields) q = q.select.apply(q, fields);
  const snap = await q.get();
  const out = [];
  snap.forEach(function (d) { const x = d.data() || {}; x._id = d.id; out.push(x); });
  return out;
}

const LEAD_FIELDS = ['email', 'telephone', 'phone', 'nom', 'prenom', 'firstName', 'lastName', 'type', 'sourceDetail', 'utm',
  'landingFirst', 'landingLast', 'engagementHistory', 'quiz', 'formAnswers', 'status', 'stage', 'isClient', 'closedData',
  'aiLead', '_merged', 'createdAt', 'importedCreatedAt', 'dateWebinaire', 'smsOptedOut', 'smsOptOut'];
const BOOKING_FIELDS = ['leadId', 'type', 'outcome', 'isCoaching', 'source', 'skipLeadCreation', 'clientId', 'closeData', 'landing'];

function bookingCommercial(b, typeMap) {
  const t = typeMap[b.type] || {};
  if (b.isCoaching === true || t.isCoaching === true) return false;
  if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return false;
  return true;
}

function bump(map, k) { map[k] = (map[k] || 0) + 1; }
function top(map, n) {
  return Object.keys(map).map(function (k) { return [k, map[k]]; }).sort(function (a, b) { return b[1] - a[1]; }).slice(0, n || 80);
}

async function build() {
  const now = Date.now();
  const cutoff = new Date(new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) + 'T00:00:00Z');
  cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  const cutoffMs = cutoff.getTime() - 2 * 3600000;   // minuit Paris (marge été/hiver)

  const res = await Promise.all([
    all('leads', LEAD_FIELDS),
    all('bookings', BOOKING_FIELDS),
    all('tunnels', ['name', 'slug', 'settings']),
    db.collection('booking_config').doc('_types').get(),
    all('blocked_contacts', null),
    all('clients', ['email', 'telephone', 'phone', 'nom', 'prenom', 'firstName', 'lastName'])
  ]);
  const leads = res[0], bookings = res[1], tunnels = res[2], typesSnap = res[3], blocked = res[4], clients = res[5];

  const typeMap = {};
  ((typesSnap.exists && (typesSnap.data() || {}).list) || []).forEach(function (t) {
    if (t && t.id) typeMap[t.id] = { isCoaching: t.isCoaching === true, label: t.label || t.id };
  });
  const tmap = {};
  tunnels.forEach(function (t) {
    const o = { name: t.name || t.slug || t._id, crmLabel: (t.settings && t.settings.crmLabel) || '' };
    if (t.slug) tmap[String(t.slug).toLowerCase()] = o;
    tmap['#' + t._id] = o;
  });
  const bkByLead = {};
  bookings.forEach(function (b) { if (b.leadId) (bkByLead[b.leadId] = bkByLead[b.leadId] || []).push(b); });

  const blockedEmail = {}, blockedPhone9 = {};
  blocked.forEach(function (b) {
    const id = String(b._id || '');
    if (id.indexOf('email:') === 0) blockedEmail[id.slice(6).toLowerCase()] = 1;
    else if (id.indexOf('phone:') === 0) blockedPhone9[phone9(id.slice(6))] = 1;
  });

  const D = {
    leadsTotal: leads.length, merged: 0, alive: 0, elite: 0, eliteByTunnel: {}, businessExcluded: 0, eliteAndBusiness: 0,
    unmatched: 0, blockedAlive: 0,
    tokensElite: {}, tokensBusiness: {}, tokensUnmatched: {},
    ca: { found: 0, bySource: {}, unreadable: 0, ge20k: 0, answers: {} },
    f1: { ca20k: 0, statusOk: 0, recent: 0, final: 0, droppedNoContact: 0 },
    f2: { clientElite: 0, clientEliteOfferUnknown: 0, rdvHonored: 0, hotCa20k: 0, hotTotal: 0, leads: 0 },
    f3: { clients: 0, statusExcl: 0, blockedLeads: 0, clientsCollection: clients.length, blockedContacts: blocked.length }
  };

  const F1 = [], F2 = [], F3 = [];
  const EXCL_F1 = { disqualifie: 1, faux_numero: 1, pas_interesse: 1, poubelle: 1, client: 1 };
  const EXCL_F3 = { disqualifie: 1, faux_numero: 1, pas_interesse: 1 };

  leads.forEach(function (l) {
    if (l._merged === true) { D.merged++; return; }
    D.alive++;
    const bks = bkByLead[l._id] || [];
    const c = contactOf(l);
    const status = String(l.status || '');
    const isClient = status === 'client' || l.isClient === true || /^closed_won/.test(String(l.stage || ''));
    const isBlocked = l.smsOptedOut === true || l.smsOptOut === true ||
      (c.email && blockedEmail[c.email]) || (phone9(c.phone) && blockedPhone9[phone9(c.phone)]);
    if (isBlocked) D.blockedAlive++;

    /* Fichier 3 : tous tunnels. */
    if (isClient) D.f3.clients++;
    else if (EXCL_F3[status]) D.f3.statusExcl++;
    else if (isBlocked) D.f3.blockedLeads++;
    if (isClient || EXCL_F3[status] || isBlocked) F3.push(c);

    /* Périmètre Elite. */
    const tokens = provenanceTokens(l, tmap, bks, typeMap);
    const cl = classifyTunnel(tokens);
    const seen = {};
    tokens.forEach(function (t) {
      const k = t.slice(0, 80);
      if (seen[k]) return; seen[k] = 1;
      bump(cl.business ? D.tokensBusiness : (cl.elite.length ? D.tokensElite : D.tokensUnmatched), k);
    });
    if (cl.business) { D.businessExcluded++; if (cl.elite.length) D.eliteAndBusiness++; return; }
    if (!cl.elite.length) { D.unmatched++; return; }
    D.elite++;
    cl.elite.forEach(function (k) { bump(D.eliteByTunnel, k); });

    const ca = declaredCa(l);
    if (ca) {
      D.ca.found++; bump(D.ca.bySource, ca.src);
      if (ca.lb == null) D.ca.unreadable++;
      bump(D.ca.answers, (ca.lb != null && ca.lb >= 20000 ? '≥20k | ' : '<20k | ') + ca.v.slice(0, 90));
    }
    const ca20 = !!(ca && ca.lb != null && ca.lb >= 20000);
    if (ca20) D.ca.ge20k++;

    /* Fichier 1. */
    if (ca20 && !isBlocked) {
      D.f1.ca20k++;
      if (!EXCL_F1[status] && !isClient) {
        D.f1.statusOk++;
        const entry = realEntryMs(l);
        if (entry != null && entry >= cutoffMs) {
          D.f1.recent++;
          if (c.email || c.phone) F1.push(c); else D.f1.droppedNoContact++;
        }
      }
    }

    /* Fichier 2. */
    if (isBlocked) return;
    let offers = [];
    if (l.closedData && l.closedData.offre) offers.push(String(l.closedData.offre));
    bks.forEach(function (b) { if (b.outcome === 'close' && b.closeData && b.closeData.offre) offers.push(String(b.closeData.offre)); });
    const eliteOffer = offers.some(function (o) { return /elite|titan/i.test(o); });
    const clientElite = isClient && (eliteOffer || !offers.length);
    if (clientElite) { D.f2.clientElite++; if (!offers.length) D.f2.clientEliteOfferUnknown++; }
    const honored = bks.some(function (b) {
      return (b.outcome === 'close' || b.outcome === 'non_close' || b.outcome === 'offre') && bookingCommercial(b, typeMap);
    });
    if (honored) D.f2.rdvHonored++;
    const hot = !!(l.aiLead && norm(l.aiLead.niveau) === 'chaud');
    if (hot) D.f2.hotTotal++;
    if (hot && ca20) D.f2.hotCa20k++;
    if (clientElite || honored || (hot && ca20)) { D.f2.leads++; F2.push(c); }
  });

  clients.forEach(function (x) { F3.push(contactOf(x)); });
  blocked.forEach(function (b) {
    const id = String(b._id || '');
    if (id.indexOf('email:') === 0) F3.push({ email: cleanEmail(id.slice(6)), phone: '', fn: '', ln: '' });
    else if (id.indexOf('phone:') === 0) F3.push({ email: '', phone: cleanPhone(id.slice(6)), fn: '', ln: '' });
  });

  const rows = { 1: dedupe(F1), 2: dedupe(F2), 3: dedupe(F3) };
  function shape(r) {
    return {
      rows: r.length,
      withEmail: r.filter(function (x) { return x.email; }).length,
      withPhone: r.filter(function (x) { return x.phone; }).length,
      phoneOnly: r.filter(function (x) { return !x.email; }).length,
      withName: r.filter(function (x) { return x.fn; }).length,
      phoneNotFr: r.filter(function (x) { return x.phone && x.phone.indexOf('+33') !== 0; }).length
    };
  }
  return {
    rows: rows,
    report: {
      generatedAt: new Date(now).toISOString(),
      cutoff6mois: new Date(cutoffMs).toISOString(),
      files: { 'elite-qualifies.csv': shape(rows[1]), 'elite-meilleurs-profils.csv': shape(rows[2]), 'exclusions.csv': shape(rows[3]) },
      detail: {
        leadsTotal: D.leadsTotal, merged: D.merged, alive: D.alive, elite: D.elite, eliteByTunnel: D.eliteByTunnel,
        businessExcluded: D.businessExcluded, eliteAndBusiness: D.eliteAndBusiness, unmatched: D.unmatched,
        blockedAlive: D.blockedAlive, f1: D.f1, f2: D.f2, f3: D.f3,
        ca: { found: D.ca.found, bySource: D.ca.bySource, unreadable: D.ca.unreadable, ge20k: D.ca.ge20k, answers: top(D.ca.answers, 120) }
      },
      provenance: { elite: top(D.tokensElite, 80), business: top(D.tokensBusiness, 50), unmatched: top(D.tokensUnmatched, 80) },
      bookingTypes: Object.keys(typeMap).map(function (k) { return [k, typeMap[k].label, typeMap[k].isCoaching]; }),
      tunnels: tunnels.map(function (t) { return [t.slug || null, t.name || null, (t.settings && t.settings.crmLabel) || null]; })
    }
  };
}

module.exports = async function (req, res) {
  if (!keyOk(req)) { res.status(404).end(); return; }
  if (req.method !== 'GET') { res.status(405).end(); return; }
  try {
    const q = req.query || {};
    const out = await build();
    if (q.mode === 'csv') {
      const f = String(q.file || '');
      if (!out.rows[f]) { res.status(400).json({ error: 'file' }); return; }
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).send(toCsv(out.rows[f]));
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json(out.report);
  } catch (e) {
    console.error('[meta-audiences-export]', e);
    res.status(500).json({ error: e && e.message ? e.message : 'erreur' });
  }
};
