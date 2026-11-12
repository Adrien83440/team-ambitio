// ============================================================================
// api/_metaIds.js — IDENTIFIANTS META CAPTÉS À L'OPT-IN (12/11/2026)
// ----------------------------------------------------------------------------
// Brief « Outil 2 » (qualité par pub + API Conversions), partie A.
// Construit le bloc `metaIds` posé sur la fiche lead à chaque opt-in :
//
//   metaIds : {
//     eventId   : identifiant de l'événement Lead du pixel navigateur (le
//                 même part côté serveur → Meta dédoublonne) ;
//     fbp, fbc  : cookies Meta du visiteur (_fbp, _fbc) ;
//     fbclid    : identifiant de clic (repli pour reconstruire fbc) ;
//     ua, ip    : navigateur et adresse IP du visiteur (correspondance Meta —
//                 l'IP seulement quand le navigateur appelle Team en direct,
//                 jamais celle de Make) ;
//     adId, adsetId, campaignId : pub d'origine (paramètres d'URL Meta) ;
//     allowed   : false si le pixel n'était PAS autorisé chez ce visiteur
//                 (visiteur YouTube, refus du bandeau cookies du site vitrine)
//                 — l'API Conversions n'envoie alors RIEN pour ce lead ;
//     pageUrl, via ('tunnel' | 'optin'), at (Timestamp) }
//
// Le bloc est réécrit à chaque opt-in (dernier engagement) : il ne sert qu'à
// l'API Conversions. L'attribution publicitaire de référence reste
// attributionFirst / attributionLast (funnel-core.js). Les fiches d'avant le
// 12/11/2026 n'ont pas de metaIds : rien n'est reconstruit pour elles.
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================
'use strict';

function s(v, max) {
  if (v == null) return '';
  const t = String(v).trim();
  if (!t || t.indexOf('{{') >= 0) return '';
  return t.slice(0, max || 300);
}

/* _fbp : fb.1.<ms>.<aléa> · _fbc : fb.1.<ms>.<fbclid>. Tout autre format est
   ignoré plutôt qu'envoyé à Meta (un cookie corrompu dégrade la
   correspondance au lieu de l'améliorer). */
const FBP_RE = /^fb\.\d\.\d{10,16}\.\d{3,}$/;
const FBC_RE = /^fb\.\d\.\d{10,16}\.[A-Za-z0-9_\-]{10,500}$/;
const ID_RE = /^\d{6,25}$/;

function cleanFbp(v) { const t = s(v, 120); return FBP_RE.test(t) ? t : ''; }
function cleanFbc(v) { const t = s(v, 600); return FBC_RE.test(t) ? t : ''; }
function cleanId(v) { const t = s(v, 30); return ID_RE.test(t) ? t : ''; }
function cleanEventId(v) { return s(v, 80).replace(/[^A-Za-z0-9_.:\-]/g, '').slice(0, 80); }

function clientIp(req) {
  const fwd = req && req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip']);
  if (!fwd) return '';
  const ip = String(fwd).split(',')[0].trim();
  return /^[0-9a-fA-F:.]{3,45}$/.test(ip) ? ip : '';
}

/* allowed : la page dit explicitement si le pixel tournait ('0' / '1', ou
   booléen). Absent (vieux runtime, Make sans le champ) → déduit : jamais
   pour un visiteur YouTube, sinon autorisé — les tunnels de vente n'ont pas
   de bandeau (choix Adrien) et le pixel y tourne pour tout visiteur Meta. */
function allowedOf(raw, youtube) {
  if (youtube) return false;
  if (raw === false || raw === 0 || raw === '0' || raw === 'false' || raw === 'non') return false;
  return true;
}

function isYoutube(attr) {
  const src = String((attr && attr.utm_source) || '').toLowerCase();
  return src.indexOf('youtube') >= 0 || src === 'yt';
}

/**
 * meta        : objet envoyé par la page (event_id, fbp, fbc, user_agent,
 *               meta_allowed) — directement (tunnel-optin) ou relayé par Make
 *               (lead-optin, champ `meta`) ; les noms courts (eventId, ua,
 *               allowed) sont acceptés aussi.
 * attribution : bloc d'attribution déjà construit (utm_*, ad_id, fbclid…).
 * opts        : { ip, via, pageUrl, FieldValue }
 * Retourne le bloc à écrire, ou null si rien d'exploitable.
 */
function build(meta, attribution, opts) {
  meta = (meta && typeof meta === 'object') ? meta : {};
  attribution = (attribution && typeof attribution === 'object') ? attribution : {};
  opts = opts || {};
  const out = {};
  const eid = cleanEventId(meta.event_id || meta.eventId);
  if (eid) out.eventId = eid;
  const fbp = cleanFbp(meta.fbp);
  if (fbp) out.fbp = fbp;
  const fbc = cleanFbc(meta.fbc);
  if (fbc) out.fbc = fbc;
  const fbclid = s(meta.fbclid || attribution.fbclid, 500).replace(/[^A-Za-z0-9_\-]/g, '');
  if (fbclid.length >= 10) out.fbclid = fbclid;
  const ua = s(meta.user_agent || meta.ua, 400);
  if (ua) out.ua = ua;
  const ip = s(opts.ip, 45);
  if (ip) out.ip = ip;
  const adId = cleanId(attribution.ad_id), adsetId = cleanId(attribution.adset_id), campaignId = cleanId(attribution.campaign_id);
  if (adId) out.adId = adId;
  if (adsetId) out.adsetId = adsetId;
  if (campaignId) out.campaignId = campaignId;
  const pageUrl = s(opts.pageUrl || attribution.landingPage, 500);
  if (pageUrl && /^https:\/\//i.test(pageUrl)) out.pageUrl = pageUrl;

  const signal = out.eventId || out.fbp || out.fbc || out.fbclid || out.adId;
  if (!signal) return null;
  const yt = isYoutube(attribution);
  out.allowed = allowedOf(meta.meta_allowed != null ? meta.meta_allowed : meta.allowed, yt);
  if (yt) out.youtube = true;
  out.via = s(opts.via, 20) || 'optin';
  out.at = opts.FieldValue ? opts.FieldValue.serverTimestamp() : new Date();
  return out;
}

module.exports = { build, clientIp, cleanFbp, cleanFbc, cleanEventId, isYoutube, FBP_RE, FBC_RE };
