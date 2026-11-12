// ============================================================================
// api/_metaCapi.js — API CONVERSIONS META : RÈGLES, CONSTRUCTION, ENVOI (12/11/2026)
// ----------------------------------------------------------------------------
// Brief « Outil 2 », partie C. Dire à Meta quels leads sont bons, pour qu'il
// optimise sur des RDV tenus et des ventes plutôt que sur des opt-ins.
//
// ÉVÉNEMENTS (pixel « Ambitio Elite » 1341581597802071 par défaut)
//   Lead          jumeau serveur du Lead navigateur du quiz (même event_id
//                 → Meta n'en garde qu'un) — opt-in, action_source website
//   LeadQualifie  opt-in dont le CA déclaré ≥ 20 000 €/mois
//                 (FunnelCore.caQualifOf — même règle que l'onglet)
//   Schedule      jumeau serveur du Schedule de booking.html (event_id = id
//                 du RDV, déjà posé côté navigateur depuis septembre)
//   RdvPose       RDV commercial créé (self ou setter, hors coaching, hors
//                 replanification)
//   RdvHonore     issue saisie close / non close / offre
//   Vente         issue close — value = contracté HT déclaré au close (EUR)
//
// AUCUN ÉVÉNEMENT (journal « skipped », avec la raison) pour :
//   · une fiche faux numéro / poubelle (stage) ou un contact bloqué ;
//   · un visiteur chez qui le pixel n'était pas autorisé (metaIds.allowed
//     false : visiteur YouTube, refus du bandeau cookies du site vitrine) ;
//   · une fiche venue de YouTube (utm_source) ;
//   · une fiche sans metaIds ET sans attribution publicitaire (organique :
//     son consentement n'est pas connu) ;
//   · LeadQualifie avec un téléphone invalide.
//
// IDENTIFIANTS (user_data) — hachés SHA-256 comme l'exige Meta : email
// (minuscules), téléphone (E.164 sans « + »), external_id (id de la fiche),
// pays ; en clair : fbp, fbc (reconstruit depuis fbclid si le cookie manque),
// user-agent et IP du visiteur quand ils sont connus.
//
// JOURNAL : meta_capi_events/{clé} — une ligne par événement : nom, fiche,
// RDV, statut (sent | error | skipped), réponse de Meta (events_received,
// fbtrace_id, message d'erreur), mode test ou réel. Admin SDK seul (aucune
// règle Firestore) ; lu par api/meta-capi.js. Aucune donnée personnelle en
// clair dans le journal : seulement les NOMS des clés de correspondance.
// Clé = « t_ » + event_id en test, event_id en réel : un passage en réel
// renvoie donc les événements à venir sans être bloqué par les tests.
//
// RÉGLAGES : _config/meta_capi { enabled, testMode, testEventCode, pixelId,
// apiVersion, testSince, productionSince } — interrupteur, mode test (VRAI
// tant qu'on n'a pas tapé PRODUCTION), code de test du Gestionnaire
// d'événements. Jeton d'accès : variable Vercel META_CAPI_TOKEN, jamais en
// base ni dans le dépôt.
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const Core = require('../funnel-core.js');
const Lookup = require('./_leadLookup');
const MetaIds = require('./_metaIds');

const DEFAULT_PIXEL = '1341581597802071';
const DEFAULT_API_VERSION = 'v23.0';
const MAX_AGE_MS = 7 * 86400000 - 3600000;   // Meta refuse un event_time de plus de 7 jours
const JOURNAL = 'meta_capi_events';
const HONORED = { close: 1, non_close: 1, offre: 1 };
const BOOKING_HTML_SOURCES = { self_booking: 1, setter_booking: 1 };
const MAX_ATTEMPTS = 3;

function sha(v) { return crypto.createHash('sha256').update(String(v), 'utf8').digest('hex'); }
function ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function leadRef(id) { return id ? sha('capi:' + id).slice(0, 10) : null; }

/* ── Réglages ─────────────────────────────────────────────────────────── */
async function loadConfig() {
  let c = {};
  try { const s = await db.collection('_config').doc('meta_capi').get(); if (s.exists) c = s.data() || {}; } catch (e) { c = {}; }
  return {
    enabled: c.enabled === true,
    testMode: c.testMode !== false,                       // test tant que rien ne dit le contraire
    testEventCode: String(c.testEventCode || '').trim().slice(0, 40),
    pixelId: String(c.pixelId || DEFAULT_PIXEL).replace(/[^\d]/g, '') || DEFAULT_PIXEL,
    apiVersion: /^v\d{2}\.\d$/.test(String(c.apiVersion || '')) ? c.apiVersion : DEFAULT_API_VERSION,
    testSince: ms(c.testSince),
    productionSince: ms(c.productionSince),
    tokenSet: !!process.env.META_CAPI_TOKEN
  };
}
/* Date à partir de laquelle un fait (opt-in, RDV, issue) peut être envoyé :
   jamais de rattrapage du passé au moment où l'on active. */
function sinceOf(cfg) { return cfg.testMode ? cfg.testSince : cfg.productionSince; }

/* ── Téléphone ────────────────────────────────────────────────────────── */
function phoneE164(raw) {
  const e = Lookup.toE164(raw);
  return /^\+\d{10,15}$/.test(e) ? e : '';
}
/* « Valide » pour LeadQualifie : format international plausible, pas une
   suite de chiffres identiques ni 0123456789 (faux numéros typiques). */
function phonePlausible(raw) {
  const e = phoneE164(raw);
  if (!e) return false;
  const nat = e.slice(-9);
  if (/(\d)\1{6,}/.test(nat)) return false;               // 0600000000, 0611111112…
  if ('123456789'.indexOf(nat) >= 0 || '987654321'.indexOf(nat) >= 0) return false;
  if (/^\+33/.test(e) && !/^\+33[1-9]\d{8}$/.test(e)) return false;
  return true;
}

/* ── Éligibilité d'une fiche ──────────────────────────────────────────── */
async function isBlocked(lead) {
  const keys = [];
  const em = String(lead.email || '').toLowerCase().trim();
  const p9 = Lookup.phoneNormalized(lead.telephone || lead.phone);
  if (em) keys.push('email:' + em.replace(/\//g, '_'));
  if (p9) keys.push('phone:' + String(p9).replace(/\//g, '_'));
  try {
    const snaps = await Promise.all(keys.map(function (k) { return db.collection('blocked_contacts').doc(k).get(); }));
    return snaps.some(function (s) { return s.exists; });
  } catch (e) { return false; }
}
/* → null si éligible, sinon la raison (journal). */
async function ineligibility(lead) {
  if (!lead) return 'fiche_introuvable';
  if (Core.isFauxNumeroLead(lead)) return 'faux_numero';
  const mi = lead.metaIds || null;
  if (mi && mi.allowed === false) return mi.youtube ? 'youtube' : 'pixel_non_autorise';
  const a = Core.leadAttribution(lead) || lead.attributionLast || lead.attributionFirst || null;
  if (MetaIds.isYoutube(a)) return 'youtube';
  if (!mi && !Core.isAdvertisingLead(lead)) return 'hors_pub';
  if (!lead.email && !phoneE164(lead.telephone || lead.phone)) return 'sans_contact';
  if (await isBlocked(lead)) return 'contact_bloque';
  return null;
}

/* ── user_data ────────────────────────────────────────────────────────── */
function userData(lead, extra) {
  const mi = (lead && lead.metaIds) || {};
  const u = {};
  const em = String((lead && lead.email) || (extra && extra.email) || '').toLowerCase().trim();
  if (em && em.indexOf('@') > 0) u.em = [sha(em)];
  const ph = phoneE164((lead && (lead.telephone || lead.phone)) || (extra && extra.telephone));
  if (ph) {
    u.ph = [sha(ph.slice(1))];
    if (/^\+33/.test(ph)) u.country = [sha('fr')];
  }
  if (lead && lead._id) u.external_id = [sha(lead._id)];
  if (mi.fbp) u.fbp = mi.fbp;
  if (mi.fbc) u.fbc = mi.fbc;
  else {
    const fbclid = mi.fbclid || ((Core.leadAttribution(lead) || {}).fbclid) || '';
    const clickMs = ms(mi.at) || ms(lead && lead.createdAt);
    if (fbclid && clickMs) u.fbc = 'fb.1.' + clickMs + '.' + fbclid;
  }
  if (mi.ua) u.client_user_agent = mi.ua;
  if (mi.ip) u.client_ip_address = mi.ip;
  return u;
}
function matchKeys(u) { return Object.keys(u).filter(function (k) { return u[k] && (!Array.isArray(u[k]) || u[k].length); }); }

/* ── Construction des événements ──────────────────────────────────────── */
function baseEvent(name, eventId, timeMs, actionSource, lead, extra) {
  const ev = {
    event_name: name,
    event_time: Math.floor(timeMs / 1000),
    event_id: eventId,
    action_source: actionSource,
    user_data: userData(lead, extra)
  };
  /* Événement « site web » : Meta exige user-agent et URL. Sans user-agent
     connu (fiche d'avant le 12/11, ou Make sans le champ), l'événement part
     en system_generated plutôt que d'être refusé. */
  if (actionSource === 'website') {
    const url = (lead.metaIds && lead.metaIds.pageUrl) || (lead.landingLast && lead.landingLast.pageUrl) || '';
    if (ev.user_data.client_user_agent && /^https:\/\//.test(url)) ev.event_source_url = url;
    else ev.action_source = 'system_generated';
  }
  return ev;
}
function crmData(extra) {
  return Object.assign({ event_source: 'crm', lead_event_source: 'Team Alteore' }, extra || {});
}

/* Événements d'un opt-in (fiche dont metaIds.at est dans la fenêtre). */
function optinEvents(lead) {
  const mi = lead.metaIds || {};
  const at = ms(mi.at);
  if (!at) return [];
  const out = [];
  const label = (lead.landingLast && lead.landingLast.label) || lead.sourceDetail || '';
  if (mi.eventId) {
    const e = baseEvent('Lead', mi.eventId, at, 'website', lead);
    e.custom_data = { content_name: label };
    out.push({ ev: e, kind: 'Lead', leadId: lead._id, at: at });
  }
  if (Core.caQualifOf(lead) === true) {
    const e2 = baseEvent('LeadQualifie', 'lq_' + lead._id, at, 'website', lead);
    e2.custom_data = { content_name: label, ca_declare: Core.caDeclaredOf(lead).slice(0, 80) };
    out.push({ ev: e2, kind: 'LeadQualifie', leadId: lead._id, at: at, needsPhone: true });
  }
  return out;
}
function bookingIsCommercial(b) {
  if (!b || b.isCoaching === true) return false;
  if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return false;
  return true;
}
/* Événements d'un RDV créé dans la fenêtre. */
function bookingCreatedEvents(b, lead) {
  const at = ms(b.createdAt);
  if (!at || !bookingIsCommercial(b) || b.rescheduledFromId) return [];
  const out = [];
  const name = b.typeLabel || b.type || '';
  if (BOOKING_HTML_SOURCES[b.source]) {
    const s = baseEvent('Schedule', String(b._id), at, 'website', lead, b.prospect);
    s.custom_data = { content_name: name };
    out.push({ ev: s, kind: 'Schedule', leadId: lead._id, bookingId: b._id, at: at });
  }
  const r = baseEvent('RdvPose', 'rp_' + b._id, at, 'system_generated', lead, b.prospect);
  r.custom_data = crmData({ content_name: name, rdv_source: String(b.source || '') });
  out.push({ ev: r, kind: 'RdvPose', leadId: lead._id, bookingId: b._id, at: at });
  return out;
}
/* Événements d'une issue saisie dans la fenêtre. */
function bookingOutcomeEvents(b, lead) {
  const at = ms(b.outcomeAt);
  if (!at || !bookingIsCommercial(b) || !HONORED[b.outcome]) return [];
  const out = [];
  const h = baseEvent('RdvHonore', 'rh_' + b._id, at, 'system_generated', lead, b.prospect);
  h.custom_data = crmData({ issue: b.outcome });
  out.push({ ev: h, kind: 'RdvHonore', leadId: lead._id, bookingId: b._id, at: at });
  if (b.outcome === 'close') {
    const cd = b.closeData || lead.closedData || {};
    const value = Math.round((Number(cd.contracte) || 0) * 100) / 100;
    const v = baseEvent('Vente', 'v_' + b._id, at, 'system_generated', lead, b.prospect);
    v.custom_data = crmData({ currency: 'EUR', value: value, content_name: String(cd.offre || '') });
    out.push({ ev: v, kind: 'Vente', leadId: lead._id, bookingId: b._id, at: at, value: value });
  }
  return out;
}

/* ── Envoi ────────────────────────────────────────────────────────────── */
async function postEvents(cfg, events, testCode) {
  const token = process.env.META_CAPI_TOKEN;
  if (!token) return { ok: false, error: 'META_CAPI_TOKEN absent' };
  const url = 'https://graph.facebook.com/' + cfg.apiVersion + '/' + cfg.pixelId + '/events?access_token=' + encodeURIComponent(token);
  const body = { data: events };
  if (testCode) body.test_event_code = testCode;
  try {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch (e) { j = null; }
    if (!r.ok || !j || j.error) {
      const er = (j && j.error) || {};
      return { ok: false, status: r.status, error: String(er.message || ('HTTP ' + r.status)).slice(0, 400), code: er.code || null, fbtrace_id: er.fbtrace_id || null };
    }
    return { ok: true, status: r.status, events_received: j.events_received, fbtrace_id: j.fbtrace_id || null, messages: (j.messages || []).slice(0, 5) };
  } catch (e) {
    return { ok: false, error: 'réseau : ' + String(e && e.message).slice(0, 200) };
  }
}

function journalKey(cfg, eventId) { return (cfg.testMode ? 't_' : '') + String(eventId).replace(/\//g, '_').slice(0, 140); }

/* Prépare un lot : élimine ce qui est déjà parti, ce qui est trop vieux, ce
   qui n'est pas éligible (journalisé « skipped »). Renvoie les items à
   envoyer. */
async function prepare(cfg, items, leadsById) {
  const FV = admin.firestore.FieldValue;
  const toSend = [];
  const eligCache = {};
  for (const it of items) {
    const key = journalKey(cfg, it.ev.event_id);
    const ref = db.collection(JOURNAL).doc(key);
    const snap = await ref.get();
    const prev = snap.exists ? snap.data() : null;
    if (prev && (prev.status === 'sent' || prev.status === 'skipped')) continue;
    if (prev && prev.status === 'error' && (prev.attempts || 0) >= MAX_ATTEMPTS) continue;
    const lead = leadsById[it.leadId];
    if (!(it.leadId in eligCache)) eligCache[it.leadId] = await ineligibility(lead);
    let reason = eligCache[it.leadId];
    if (!reason && it.needsPhone && !phonePlausible(lead.telephone || lead.phone)) reason = 'telephone_invalide';
    if (!reason && Date.now() - it.at > MAX_AGE_MS) reason = 'trop_ancien';
    const base = {
      key: key, event: it.kind, eventId: it.ev.event_id, leadId: it.leadId || null, leadRef: leadRef(it.leadId),
      bookingId: it.bookingId || null, eventTime: new Date(it.at), test: cfg.testMode,
      value: it.value != null ? it.value : null, actionSource: it.ev.action_source,
      matchKeys: matchKeys(it.ev.user_data), updatedAt: FV.serverTimestamp()
    };
    if (reason) {
      await ref.set(Object.assign(base, { status: 'skipped', reason: reason, createdAt: prev ? prev.createdAt || FV.serverTimestamp() : FV.serverTimestamp() }), { merge: true });
      continue;
    }
    toSend.push({ it: it, ref: ref, base: base, prev: prev });
  }
  return toSend;
}

async function sendBatch(cfg, toSend) {
  const FV = admin.firestore.FieldValue;
  const testCode = cfg.testMode ? cfg.testEventCode : '';
  let sent = 0, errors = 0;
  for (let i = 0; i < toSend.length; i += 50) {
    const chunk = toSend.slice(i, i + 50);
    const resp = await postEvents(cfg, chunk.map(function (x) { return x.it.ev; }), testCode);
    for (const x of chunk) {
      const doc = Object.assign({}, x.base, {
        status: resp.ok ? 'sent' : 'error',
        response: resp,
        testEventCode: testCode || null,
        attempts: ((x.prev && x.prev.attempts) || 0) + 1,
        sentAt: FV.serverTimestamp(),
        createdAt: (x.prev && x.prev.createdAt) || FV.serverTimestamp()
      });
      await x.ref.set(doc, { merge: true });
      if (resp.ok) sent++; else errors++;
    }
  }
  return { sent: sent, errors: errors };
}

module.exports = {
  JOURNAL, DEFAULT_PIXEL, loadConfig, sinceOf, ms, sha, leadRef,
  phoneE164, phonePlausible, ineligibility, userData, matchKeys,
  optinEvents, bookingCreatedEvents, bookingOutcomeEvents, bookingIsCommercial,
  postEvents, prepare, sendBatch, journalKey
};
