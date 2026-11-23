// ============================================================================
// api/_visiteur.js — LIEU ET APPAREIL DU PROSPECT (23/11/2026)
// ----------------------------------------------------------------------------
// Construit le bloc `visiteur` posé sur la fiche lead (et sur le RDV) :
//
//   visiteur : { city, region, country, device, os, browser, app, via, at }
//
// Le lieu vient des en-têtes de géolocalisation de Vercel (x-vercel-ip-city,
// x-vercel-ip-country-region, x-vercel-ip-country) : il n'est juste que si
// c'est le NAVIGATEUR du prospect qui appelle Team (tunnel-optin, beacon
// api/visiteur) — jamais Make. L'adresse IP n'est PAS conservée : seul le
// résultat (ville approximative) l'est. L'appareil est lu dans le
// user-agent par FunnelCore.uaDevice (règle partagée avec l'affichage).
//
// Règle : le PREMIER relevé fait foi, jamais écrasé (`firstWins`).
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================
'use strict';

const FC = require('../funnel-core.js');

function dec(v) {
  try { return decodeURIComponent(String(v || '')); } catch (e) { return String(v || ''); }
}
function s(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 80); }

/* Bloc depuis la requête du navigateur. `ua` : user-agent à utiliser à la
   place de celui de la requête (rare). Retourne null si rien d'exploitable. */
function fromReq(req, opts) {
  opts = opts || {};
  const h = (req && req.headers) || {};
  const ua = s(opts.ua != null ? opts.ua : h['user-agent'], 400);
  const out = {};
  const city = s(dec(h['x-vercel-ip-city']), 80);
  const region = s(dec(h['x-vercel-ip-country-region']), 10).toUpperCase();
  const country = s(h['x-vercel-ip-country'], 2).toUpperCase();
  if (city) out.city = city;
  if (region) out.region = region;
  if (/^[A-Z]{2}$/.test(country)) out.country = country;
  const d = FC.uaDevice(ua);
  ['device', 'os', 'browser', 'app'].forEach(function (k) { if (d[k]) out[k] = d[k]; });
  if (!out.country && !out.device) return null;
  out.via = s(opts.via, 20) || 'optin';
  out.at = new Date().toISOString();
  return out;
}

/* Bloc lieu seul depuis le texte « Ville, RÉGION, FR » d'une signature
   (api/_sign-core.js : audit `geo` ou progress.lieu « Ville, FR »). */
function fromGeoText(txt, via) {
  const parts = String(txt || '').split(',').map(function (x) { return x.trim(); }).filter(Boolean);
  if (!parts.length) return null;
  const out = {};
  const last = parts[parts.length - 1];
  if (/^[A-Z]{2}$/.test(last)) { out.country = last; parts.pop(); }
  if (!out.country) return null;
  if (parts.length >= 2) { out.city = parts[0].slice(0, 80); out.region = parts[1].slice(0, 10).toUpperCase(); }
  else if (parts.length === 1) {
    if (/^[A-Z0-9]{1,3}$/.test(parts[0])) out.region = parts[0];
    else out.city = parts[0].slice(0, 80);
  }
  out.via = via || 'signature';
  out.at = new Date().toISOString();
  return out;
}

/* La fiche a-t-elle déjà un lieu / un appareil relevé ? */
function hasGeo(v) { return !!(v && (v.city || v.country)); }

module.exports = { fromReq, fromGeoText, hasGeo };
