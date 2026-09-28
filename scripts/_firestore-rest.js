// ============================================================================
// scripts/_firestore-rest.js — accès Firestore par l'API REST, sans SDK
// ----------------------------------------------------------------------------
// Pourquoi : depuis Claude Code (Node 26, 28/09/2026), firebase-admin bloque
// indéfiniment sur la première requête, même avec preferRest. Ce helper ne
// dépend que des modules natifs (crypto, https) : JWT RS256 signé avec la clé
// de service account, échange contre un access token, puis runQuery / patch.
//
// Clé : GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
// Projet : ambitio-team, base (default).
//
// API :
//   runQuery(structuredQuery)          → [{ id, path, data }]
//   patchDoc(path, fields, fieldPaths) → écrit UNIQUEMENT les champs listés
//   ff(field, op, value)               → fieldFilter Firestore
//   enc(jsValue)                       → valeur Firestore (string/number/bool/
//                                        null/array/objet/Date)
// ============================================================================
'use strict';
const fs = require('fs');
const crypto = require('crypto');
const https = require('https');

const PROJECT = 'ambitio-team';
const BASE = 'https://firestore.googleapis.com/v1/projects/' + PROJECT + '/databases/(default)/documents';

function loadSa() {
  const p = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!p) throw new Error('GOOGLE_APPLICATION_CREDENTIALS manquant');
  return JSON.parse(fs.readFileSync(p.replace(/^~/, process.env.HOME || ''), 'utf8'));
}

function b64u(b) {
  return Buffer.from(b).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function request(method, url, headers, body) {
  return new Promise(function (resolve, reject) {
    const u = new URL(url);
    const data = body == null ? '' : (typeof body === 'string' ? body : JSON.stringify(body));
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: method,
      headers: Object.assign({ 'Content-Length': Buffer.byteLength(data) }, headers)
    }, function (r) {
      const chunks = [];
      r.on('data', function (c) { chunks.push(c); });
      r.on('end', function () {
        const txt = Buffer.concat(chunks).toString();
        if (r.statusCode >= 300) return reject(new Error('HTTP ' + r.statusCode + ' ' + txt.slice(0, 600)));
        try { resolve(txt ? JSON.parse(txt) : null); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

let TOKEN = null;
async function token() {
  if (TOKEN) return TOKEN;
  const sa = loadSa();
  const now = Math.floor(Date.now() / 1000);
  const hdr = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({
    iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600
  }));
  const sig = crypto.sign('RSA-SHA256', Buffer.from(hdr + '.' + pl), sa.private_key);
  const jwt = hdr + '.' + pl + '.' + b64u(sig);
  const r = await request('POST', 'https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + jwt);
  TOKEN = r.access_token;
  return TOKEN;
}

function dec(v) {
  if (v == null) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return v.timestampValue;
  if ('mapValue' in v) return decFields(v.mapValue.fields || {});
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(dec);
  if ('referenceValue' in v) return v.referenceValue;
  return v;
}
function decFields(f) { const o = {}; Object.keys(f).forEach(function (k) { o[k] = dec(f[k]); }); return o; }

function enc(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(enc) } };
  if (typeof v === 'object') { const f = {}; Object.keys(v).forEach(function (k) { f[k] = enc(v[k]); }); return { mapValue: { fields: f } }; }
  throw new Error('type non encodable : ' + typeof v);
}

function ff(field, op, value) { return { fieldFilter: { field: { fieldPath: field }, op: op, value: enc(value) } }; }

async function runQuery(structuredQuery) {
  const t = await token();
  const r = await request('POST', BASE + ':runQuery',
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { structuredQuery: structuredQuery });
  return (r || []).filter(function (x) { return x.document; }).map(function (x) {
    return { id: x.document.name.split('/').pop(), path: x.document.name, data: decFields(x.document.fields || {}) };
  });
}

// path = 'leads/<id>' ; fields = { champ: valeurJs } ; seuls les champs de
// fieldPaths sont touchés (updateMask) — jamais d'écrasement du document.
async function patchDoc(path, fields, fieldPaths) {
  const t = await token();
  const mask = fieldPaths.map(function (p) { return 'updateMask.fieldPaths=' + encodeURIComponent(p); }).join('&');
  const f = {}; Object.keys(fields).forEach(function (k) { f[k] = enc(fields[k]); });
  return request('PATCH', BASE + '/' + path + '?' + mask + '&currentDocument.exists=true',
    { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json' }, { fields: f });
}

module.exports = { runQuery, patchDoc, ff, enc, token };
