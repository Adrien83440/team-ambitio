// ============================================================================
// api/parcours-audit.js — LECTURE SEULE, TEMPORAIRE (24/11/2026)
// ----------------------------------------------------------------------------
// Chantier « parcours entre la réservation et le RDV de vente » : avant de
// toucher aux envois, relire en production ce que le code ne dit pas :
//   - le modèle WhatsApp `rappel_rdv_closing` tel que Meta l'a validé
//     (texte, variables, boutons, statut) et la qualité du numéro ;
//   - les réglages de notification des consultations commerciales
//     (booking_config/_types), les textes globaux, la durée affichée ;
//   - l'expéditeur des SMS de l'agenda (_config/twilio) et de Vercel
//     (_config/telco_credentials) — numéros d'entreprise, jamais de jeton ;
//   - les interrupteurs utiles (meetTracking, rappelsActifs, modeTest) ;
//   - la FORME des RDV commerciaux à venir (noms de champs, taux de
//     remplissage), pour écrire le moteur sans deviner un champ.
//
// N'ÉCRIT RIEN. Aucune donnée personnelle de prospect en sortie : des
// compteurs et des noms de champs. Pour le membre de test, seulement la
// présence d'un téléphone et ses deux derniers chiffres.
//
// Accès : en-tête `x-audit-key` égal à la variable Vercel PARCOURS_AUDIT_KEY.
// Variable absente ou clé fausse → 404. À retirer une fois le chantier lancé.
//
//   GET /api/parcours-audit            → tout
//   GET /api/parcours-audit?membre=adrien   → slug du membre de test
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const { graph, getWhatsappCreds } = require('./_whatsappClient');

function keyOk(req) {
  const want = String(process.env.PARCOURS_AUDIT_KEY || '');
  /* En-tête, ou paramètre `k` : l'outil Vercel qui lit la preview ne sait
     pas poser d'en-tête. Clé limitée à la preview de la branche. */
  const got = String((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

function fin2(v) {
  const d = String(v || '').replace(/\D/g, '');
  return d.length >= 6 ? ('…' + d.slice(-2)) : (d ? 'court' : null);
}
function masque(v) {
  if (!v) return null;
  const s = String(v);
  return s.length <= 6 ? '***' : (s.slice(0, 4) + '…' + s.slice(-2));
}
function parisDay(t) { return new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); }

/* Clés d'un objet, à un ou deux niveaux, sans aucune valeur. */
function formeDe(obj, prof) {
  const out = {};
  Object.keys(obj || {}).forEach(function (k) {
    const v = obj[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof v.toMillis !== 'function' && prof > 0) {
      out[k] = formeDe(v, prof - 1);
    } else if (Array.isArray(v)) out[k] = 'array';
    else if (v && typeof v.toMillis === 'function') out[k] = 'timestamp';
    else out[k] = v === null ? 'null' : typeof v;
  });
  return out;
}

async function lireModele() {
  try {
    const creds = await getWhatsappCreds();
    const out = { rappelsActifs: creds.rappelsActifs, wabaId: !!creds.wabaId, apiVersion: creds.apiVersion };
    const num = await graph(creds.phoneNumberId + '?fields=display_phone_number,verified_name,quality_rating,messaging_limit_tier,throughput');
    out.numero = num.ok ? num.data : { erreur: num.erreur };
    if (!creds.wabaId) { out.modele = { erreur: 'wabaId absent' }; return out; }
    const rep = await graph(creds.wabaId + '/message_templates?name=rappel_rdv_closing&fields=name,status,category,language,components,parameter_format,quality_score,rejected_reason&limit=20');
    out.modele = rep.ok ? (rep.data && rep.data.data) : { erreur: rep.erreur };
    const liste = await graph(creds.wabaId + '/message_templates?fields=name,status,category,language&limit=100');
    out.autresModeles = liste.ok ? (liste.data.data || []).map(function (t) { return t.name + ' / ' + t.language + ' / ' + t.status + ' / ' + t.category; }) : { erreur: liste.erreur };
    return out;
  } catch (e) { return { erreur: e.message }; }
}

async function lireTypes() {
  const snap = await db.collection('booking_config').doc('_types').get();
  const list = (snap.exists && Array.isArray(snap.data().list)) ? snap.data().list : [];
  return list.map(function (t) {
    return {
      id: t.id || null, label: t.label || t.name || null, isCoaching: t.isCoaching === true,
      skipLeadCreation: t.skipLeadCreation === true, csm_manual: t.csm_manual === true,
      active: t.active, duration: t.duration == null ? null : t.duration,
      displayDuration: t.displayDuration == null ? null : t.displayDuration,
      confirmationRedirect: t.confirmationRedirect || null,
      notifications: t.notifications || null,
      cles: Object.keys(t),
    };
  });
}

async function lireConfig() {
  const ids = ['booking_reminders', 'twilio', 'telco_credentials', 'team_pilotage', 'relances', 'whatsapp_credentials'];
  const out = {};
  for (const id of ids) {
    const s = await db.collection('_config').doc(id).get();
    if (!s.exists) { out[id] = null; continue; }
    const d = s.data() || {};
    if (id === 'booking_reminders') out[id] = d;
    else if (id === 'twilio' || id === 'telco_credentials') {
      out[id] = { fromNumber: d.fromNumber || d.twilioFromNumber || null, messagingServiceSid: masque(d.messagingServiceSid),
        alphaSender: d.alphaSender || d.senderId || null, cles: Object.keys(d) };
    } else if (id === 'team_pilotage') out[id] = { meetTracking: d.meetTracking === true, cles: Object.keys(d) };
    else if (id === 'relances') out[id] = { modeTest: d.modeTest, cles: Object.keys(d) };
    else out[id] = { cles: Object.keys(d) };
  }
  const tok = {};
  for (const k of ['strategie', 'contact', 'coaching', 'meet_closing']) {
    const s = await db.collection('email_tokens').doc(k).get();
    tok[k] = s.exists ? { present: true, email: (s.data() || {}).email || null } : { present: false };
  }
  out.email_tokens = tok;
  return out;
}

async function lireMembre(slug) {
  const s = await db.collection('_meta').doc('team_members').get();
  if (!s.exists) return null;
  const d = s.data() || {};
  const membres = d.members || d.list || d;
  let m = null;
  if (Array.isArray(membres)) m = membres.find(function (x) { return x && x.slug === slug; }) || null;
  else if (membres && typeof membres === 'object') m = membres[slug] || null;
  if (!m) return { trouve: false, formeDoc: Object.keys(d).slice(0, 30) };
  const out = { trouve: true, cles: Object.keys(m) };
  Object.keys(m).forEach(function (k) {
    if (/phone|tel|mobile|whatsapp/i.test(k)) out[k] = fin2(m[k]);
    if (/mail/i.test(k)) out[k] = m[k] ? 'present' : null;
  });
  return out;
}

async function lireRdv() {
  const now = Date.now();
  const debut = parisDay(now - 30 * 86400000);
  const fin = parisDay(now + 4 * 86400000);
  const snap = await db.collection('bookings').where('date', '>=', debut).where('date', '<=', fin).get();
  const st = { total: 0, commerciaux: 0, aVenir: 0, champs: {}, statuts: {}, outcomes: {}, typeIds: {}, forme: null };
  const prospectCles = {};
  snap.forEach(function (doc) {
    const b = doc.data() || {};
    st.total++;
    if (b.isCoaching === true || b.csm_manual === true || b.skipLeadCreation === true || b.clientId) return;
    st.commerciaux++;
    if (b.date >= parisDay(now)) st.aVenir++;
    st.statuts[b.status || '∅'] = (st.statuts[b.status || '∅'] || 0) + 1;
    st.outcomes[b.outcome || '∅'] = (st.outcomes[b.outcome || '∅'] || 0) + 1;
    const tk = (b.typeId || '∅') + ' | ' + (b.typeLabel || '');
    st.typeIds[tk] = (st.typeIds[tk] || 0) + 1;
    Object.keys(b).forEach(function (k) { st.champs[k] = (st.champs[k] || 0) + 1; });
    Object.keys(b.prospect || {}).forEach(function (k) { prospectCles[k] = (prospectCles[k] || 0) + 1; });
    if (!st.forme && b.date >= parisDay(now)) st.forme = formeDe(b, 1);
  });
  st.prospectCles = prospectCles;
  return st;
}

async function lireConfirmations() {
  const snap = await db.collection('rdv_confirmations').limit(5).get();
  const formes = [];
  snap.forEach(function (d) { formes.push(formeDe(d.data() || {}, 1)); });
  return { echantillon: snap.size, formes: formes };
}

module.exports = async function (req, res) {
  if (!keyOk(req)) { res.status(404).json({ error: 'Not found' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  const slug = String((req.query && req.query.membre) || 'adrien').replace(/[^a-z0-9_-]/gi, '').slice(0, 40);
  const out = { lu: new Date().toISOString() };
  const parts = [
    ['whatsapp', lireModele], ['types', lireTypes], ['config', lireConfig],
    ['membreTest', function () { return lireMembre(slug); }], ['rdv', lireRdv], ['confirmations', lireConfirmations],
  ];
  for (const p of parts) {
    try { out[p[0]] = await p[1](); } catch (e) { out[p[0]] = { erreur: e.message }; }
  }
  res.status(200).json(out);
};
