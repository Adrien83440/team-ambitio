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
//   LeadLQS3plus  opt-in dont la note LQS (lqs-core.js, barème
//   LeadLQS4plus  _config/lqs_grid — exactement la note de l'onglet
//   LeadLQS5      « ⭐ Qualité leads ») est ≥ 3, ≥ 4, = 5. CUMULATIFS :
//                 un lead noté 5 envoie les trois, un 4 les deux premiers.
//                 custom_data.lqs = la note, lqs_points = le total.
//                 (19/11/2026, demande de la média buyeuse : optimiser et
//                 bâtir des audiences sur les bons profils.) Note calculée
//                 UNE fois, au passage qui suit l'opt-in, avec le barème du
//                 moment ; jamais renvoyée si le barème change ensuite, et
//                 jamais écrite sur la fiche (règle LQS).
//   LeadDisqualifie opt-in dont une réponse est ÉLIMINATOIRE (⛔) dans le
//                 barème LQS (sc.ko) — et SEULEMENT celles-là : une note 1-2
//                 obtenue par cumul de points n'est pas envoyée (le lead peut
//                 évoluer). Sert aux audiences d'exclusion de la média
//                 buyeuse (19/11/2026). Pas d'exigence de téléphone : l'e-mail
//                 suffit à exclure.
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
//   · LeadQualifie et LeadLQS* avec un téléphone invalide.
//
// IDENTIFIANTS (user_data) — hachés SHA-256 comme l'exige Meta : email
// (minuscules), téléphone (E.164 sans « + »), external_id (id de la fiche),
// pays, prénom et nom (19/11/2026 : minuscules, sans ponctuation ; champ
// prenom de la fiche s'il existe, sinon premier mot du nom complet `nom`) ;
// IP + navigateur : metaIds.ip (opt-in direct) sinon meta_ip/{event_id}
// (api/meta-ip.js, 20/11/2026 : quiz via Make et RDV — appel du navigateur
// au moment de l'événement pixel ; jointure par attachNet, toujours en PAIRE) ; en clair : fbp, fbc (reconstruit depuis fbclid si le cookie manque),
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
const Lqs = require('../lqs-core.js');

const DEFAULT_PIXEL = '1341581597802071';
const DEFAULT_API_VERSION = 'v23.0';
const MAX_AGE_MS = 7 * 86400000 - 3600000;   // Meta refuse un event_time de plus de 7 jours
const JOURNAL = 'meta_capi_events';
const HONORED = { close: 1, non_close: 1, offre: 1 };
const BOOKING_HTML_SOURCES = { self_booking: 1, setter_booking: 1 };
const MAX_ATTEMPTS = 3;
/* Événements LQS cumulatifs : seuil de note → nom, préfixe d'event_id. */
const LQS_EVENTS = [
  { min: 3, name: 'LeadLQS3plus', pre: 'lqs3_' },
  { min: 4, name: 'LeadLQS4plus', pre: 'lqs4_' },
  { min: 5, name: 'LeadLQS5', pre: 'lqs5_' }
];

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
/* Prénom / nom pour Meta : minuscules, lettres seulement (accents gardés,
   UTF-8), sans ponctuation ni espace. Un « nom » qui est en fait un e-mail,
   un numéro ou « Sans nom » n'est pas envoyé. */
function nameKey(v) {
  let t = String(v == null ? '' : v).toLowerCase().trim();
  if (!t || /@|\d/.test(t) || t === 'sans nom') return '';
  t = t.replace(/[^a-zà-öø-ÿœæ]/g, '');
  return t.length >= 1 ? t : '';
}
function namesOf(lead, extra) {
  const src = lead || {};
  const ex = extra || {};
  let full = String(src.nom || ex.nom || ex.name || '').replace(/\s+/g, ' ').trim();
  if (/@|\d/.test(full) || full.toLowerCase() === 'sans nom') full = '';
  let fn = String(src.prenom || src.firstName || ex.prenom || ex.firstName || '').trim();
  let ln = String(src.lastName || ex.lastName || '').trim();
  if (!fn) {
    /* Nom complet « Prénom Nom » : premier mot = prénom, le reste = nom. */
    const w = full ? full.split(' ') : [];
    fn = w[0] || '';
    if (!ln) ln = w.slice(1).join(' ');
  } else if (!ln && full) {
    /* Prénom connu : le nom = le nom complet sans le prénom en tête. */
    ln = full.toLowerCase().indexOf(fn.toLowerCase() + ' ') === 0 ? full.slice(fn.length + 1) : (full.toLowerCase() === fn.toLowerCase() ? '' : full);
  }
  return { fn: nameKey(fn), ln: nameKey(ln) };
}
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
  const nm = namesOf(lead, extra);
  if (nm.fn) u.fn = [sha(nm.fn)];
  if (nm.ln) u.ln = [sha(nm.ln)];
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
  else if (lead && lead._capiNet && lead._capiNet.ip) {
    /* IP vue par api/meta-ip.js : jointe avec le navigateur du MÊME appel. */
    u.client_ip_address = lead._capiNet.ip;
    if (lead._capiNet.ua) u.client_user_agent = lead._capiNet.ua;
  }
  return u;
}
function matchKeys(u) { return Object.keys(u).filter(function (k) { return u[k] && (!Array.isArray(u[k]) || u[k].length); }); }

/* ── IP des visiteurs (meta_ip, api/meta-ip.js) ─────────────────────────── */
const NET_COL = 'meta_ip';
function netKey(e) { return String(e || '').replace(/[/.]/g, '_').slice(0, 100); }
/* Pose lead._capiNet (event_id de l'opt-in, si la fiche n'a pas d'IP) et
   b._capiNet (id du RDV) depuis meta_ip. Lecture groupée, jamais d'erreur
   bloquante : sans IP, l'événement part comme avant. */
async function attachNet(leads, bookings) {
  const want = {};
  (leads || []).forEach(function (l) {
    const mi = (l && l.metaIds) || {};
    if (mi.eventId && !mi.ip) (want[netKey(mi.eventId)] = want[netKey(mi.eventId)] || []).push(l);
  });
  (bookings || []).forEach(function (b) { if (b && b._id) (want[netKey(b._id)] = want[netKey(b._id)] || []).push(b); });
  const keys = Object.keys(want);
  for (let i = 0; i < keys.length; i += 100) {
    const refs = keys.slice(i, i + 100).map(function (k) { return db.collection(NET_COL).doc(k); });
    let snaps = [];
    try { snaps = await db.getAll.apply(db, refs); } catch (e) { snaps = []; }
    snaps.forEach(function (s) {
      if (!s || !s.exists) return;
      const x = s.data() || {};
      if (!x.ip) return;
      (want[s.id] || []).forEach(function (o) { o._capiNet = { ip: String(x.ip), ua: String(x.ua || '') }; });
    });
  }
}
/* RDV : l'IP de la confirmation prime sur celle de l'opt-in (même paire). */
function applyBookingNet(ev, b) {
  if (b && b._capiNet && b._capiNet.ip) {
    ev.user_data.client_ip_address = b._capiNet.ip;
    if (b._capiNet.ua) ev.user_data.client_user_agent = b._capiNet.ua;
  }
  return ev;
}
/* Purge des IP de plus de 8 jours (exception validée le 20/11/2026). */
async function purgeNet(limit) {
  const snap = await db.collection(NET_COL).where('expireAt', '<', admin.firestore.Timestamp.fromMillis(Date.now())).limit(limit || 300).get();
  if (snap.empty) return 0;
  const batch = db.batch();
  snap.forEach(function (d) { batch.delete(d.ref); });
  await batch.commit();
  return snap.size;
}

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

/* Barème LQS (_config/lqs_grid), normalisé comme dans l'onglet. Une erreur
   de lecture REMONTE : le passage échoue sans avancer le curseur, plutôt
   que de laisser filer des opt-ins sans leur événement LQS. */
async function loadLqsGrid() {
  const s = await db.collection('_config').doc('lqs_grid').get();
  return Lqs.normalizeGrid(s.exists ? s.data() : null);
}
/* Note LQS d'une fiche → { note: 1..5 | null, pts, ko }. */
function lqsOf(lead, grid) {
  const sc = Lqs.scoreAnswers(Lqs.extractAnswers(lead), grid);
  return { note: sc.note, pts: sc.pts, ko: sc.ko };
}
/* Événements LQS d'une note donnée (cumulatifs). */
function lqsEventsFor(lead, sc, at, label) {
  const out = [];
  if (!sc || !(sc.note >= 3)) return out;
  LQS_EVENTS.forEach(function (d) {
    if (sc.note < d.min) return;
    const e = baseEvent(d.name, d.pre + lead._id, at, 'website', lead);
    e.custom_data = { content_name: label || '', lqs: sc.note, lqs_points: sc.pts };
    out.push({ ev: e, kind: d.name, leadId: lead._id, at: at, needsPhone: true, lqs: sc.note });
  });
  return out;
}

/* Lead disqualifié : réponse éliminatoire (⛔) du barème, rien d'autre. */
function disqualEventsFor(lead, sc, at, label) {
  if (!sc || sc.ko !== true) return [];
  const e = baseEvent('LeadDisqualifie', 'ldq_' + lead._id, at, 'website', lead);
  e.custom_data = { content_name: label || '', lqs: sc.note, motif: 'reponse_eliminatoire' };
  return [{ ev: e, kind: 'LeadDisqualifie', leadId: lead._id, at: at, lqs: sc.note }];
}

/* Événements d'un opt-in (fiche dont metaIds.at est dans la fenêtre).
   lqsGrid : barème LQS (loadLqsGrid) ; absent → pas d'événement LQS. */
function optinEvents(lead, lqsGrid) {
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
  if (lqsGrid) {
    const sc = lqsOf(lead, lqsGrid);
    lqsEventsFor(lead, sc, at, label).forEach(function (x) { out.push(x); });
    disqualEventsFor(lead, sc, at, label).forEach(function (x) { out.push(x); });
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
    const s = applyBookingNet(baseEvent('Schedule', String(b._id), at, 'website', lead, b.prospect), b);
    s.custom_data = { content_name: name };
    out.push({ ev: s, kind: 'Schedule', leadId: lead._id, bookingId: b._id, at: at });
  }
  const r = applyBookingNet(baseEvent('RdvPose', 'rp_' + b._id, at, 'system_generated', lead, b.prospect), b);
  r.custom_data = crmData({ content_name: name, rdv_source: String(b.source || '') });
  out.push({ ev: r, kind: 'RdvPose', leadId: lead._id, bookingId: b._id, at: at });
  return out;
}
/* Événements d'une issue saisie dans la fenêtre. */
function bookingOutcomeEvents(b, lead) {
  const at = ms(b.outcomeAt);
  if (!at || !bookingIsCommercial(b) || !HONORED[b.outcome]) return [];
  const out = [];
  const h = applyBookingNet(baseEvent('RdvHonore', 'rh_' + b._id, at, 'system_generated', lead, b.prospect), b);
  h.custom_data = crmData({ issue: b.outcome });
  out.push({ ev: h, kind: 'RdvHonore', leadId: lead._id, bookingId: b._id, at: at });
  if (b.outcome === 'close') {
    const cd = b.closeData || lead.closedData || {};
    const value = Math.round((Number(cd.contracte) || 0) * 100) / 100;
    const v = applyBookingNet(baseEvent('Vente', 'v_' + b._id, at, 'system_generated', lead, b.prospect), b);
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
      value: it.value != null ? it.value : null, lqs: it.lqs != null ? it.lqs : null, actionSource: it.ev.action_source,
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
  attachNet, purgeNet, NET_COL,
  LQS_EVENTS, loadLqsGrid, lqsOf, lqsEventsFor, disqualEventsFor, namesOf,
  optinEvents, bookingCreatedEvents, bookingOutcomeEvents, bookingIsCommercial,
  postEvents, prepare, sendBatch, journalKey
};
