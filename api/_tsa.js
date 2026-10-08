// ============================================================================
// api/_tsa.js — HORODATAGE RFC 3161 PAR UNE AUTORITÉ TIERCE
// ----------------------------------------------------------------------------
// Demande à une autorité d'horodatage (TSA) un jeton signé attestant qu'une
// empreinte SHA-256 existait à un instant donné. Le jeton est signé par la
// TSA avec son propre certificat : ni nous ni le client ne pouvons le
// fabriquer ou l'antidater. C'est la pièce qui rend l'heure de signature
// opposable, indépendamment de nos serveurs.
//
// Trois autorités, essayées dans l'ordre : si la première ne répond pas, on
// passe à la suivante. Aucune n'exige de compte ni de clé.
//   · DigiCert  — racine reconnue par Adobe (le PDF s'affiche « horodaté »)
//   · Sectigo   — idem
//   · FreeTSA   — dernier recours
//
// Zéro dépendance : la requête ASN.1/DER (TimeStampReq) est construite à la
// main, et la réponse est découpée juste assez pour en extraire le jeton,
// vérifier qu'il porte bien NOTRE empreinte et lire l'heure (genTime).
// ============================================================================

const crypto = require('crypto');

const AUTHORITIES = [
  { name: 'DigiCert', url: 'http://timestamp.digicert.com' },
  { name: 'Sectigo', url: 'http://timestamp.sectigo.com' },
  { name: 'FreeTSA', url: 'https://freetsa.org/tsr' },
];
const TIMEOUT_MS = 8000;

function derLen(n) {
  if (n < 128) return Buffer.from([n]);
  const b = [];
  while (n > 0) { b.unshift(n & 0xff); n = Math.floor(n / 256); }
  return Buffer.from([0x80 | b.length].concat(b));
}
function der(tag, content) { return Buffer.concat([Buffer.from([tag]), derLen(content.length), content]); }

/* TimeStampReq ::= SEQUENCE { version 1, messageImprint, nonce, certReq TRUE } */
function buildRequest(hash, nonce) {
  const sha256Alg = der(0x30, Buffer.concat([
    der(0x06, Buffer.from('608648016503040201', 'hex')),   // 2.16.840.1.101.3.4.2.1
    Buffer.from([0x05, 0x00]),
  ]));
  const imprint = der(0x30, Buffer.concat([sha256Alg, der(0x04, hash)]));
  return der(0x30, Buffer.concat([
    der(0x02, Buffer.from([0x01])),
    imprint,
    der(0x02, nonce),
    Buffer.from([0x01, 0x01, 0xff]),
  ]));
}

/* Lecture d'un TLV DER à la position pos → { tag, start (contenu), end }. */
function readTlv(buf, pos) {
  const tag = buf[pos];
  let len = buf[pos + 1];
  let hdr = 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos + 2 + i];
    hdr = 2 + n;
  }
  return { tag: tag, start: pos + hdr, end: pos + hdr + len, total: hdr + len };
}

/* TimeStampResp ::= SEQUENCE { status PKIStatusInfo, timeStampToken OPTIONAL } */
function parseResponse(buf, hash) {
  const outer = readTlv(buf, 0);
  if (outer.tag !== 0x30) throw new Error('réponse TSA illisible');
  const statusInfo = readTlv(buf, outer.start);
  const statusInt = readTlv(buf, statusInfo.start);
  const status = buf[statusInt.start];
  if (status !== 0 && status !== 1) throw new Error('TSA a refusé (statut ' + status + ')');
  const tokenPos = statusInfo.end;
  if (tokenPos >= outer.end) throw new Error('réponse TSA sans jeton');
  const tok = readTlv(buf, tokenPos);
  const token = buf.slice(tokenPos, tok.end);
  /* Le jeton doit porter NOTRE empreinte : sinon on horodaterait autre chose. */
  const at = token.indexOf(hash);
  if (at < 0) throw new Error('jeton TSA sans notre empreinte');
  /* genTime (GeneralizedTime, tag 0x18) suit l'empreinte et le numéro de série. */
  let genTime = null;
  for (let i = at + hash.length; i < Math.min(token.length - 2, at + hash.length + 80); i++) {
    if (token[i] === 0x18) {
      const l = token[i + 1];
      const s = token.slice(i + 2, i + 2 + l).toString('latin1');
      const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d+)?Z$/.exec(s);
      if (m) { genTime = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], m[7] ? Math.round(parseFloat(m[7]) * 1000) : 0)).toISOString(); break; }
    }
  }
  return { token: token, genTime: genTime };
}

async function askOne(auth, hash) {
  const nonce = crypto.randomBytes(8);
  nonce[0] = (nonce[0] & 0x7f) | 0x01;
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  try {
    const r = await fetch(auth.url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/timestamp-query', 'Accept': 'application/timestamp-reply' },
      body: buildRequest(hash, nonce),
      signal: controller.signal,
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const buf = Buffer.from(await r.arrayBuffer());
    const p = parseResponse(buf, hash);
    return { authority: auth.name, url: auth.url, token: p.token, genTime: p.genTime };
  } finally {
    clearTimeout(timer);
  }
}

/* Horodate une empreinte (Buffer de 32 octets). Renvoie le premier jeton
   obtenu, ou lève une erreur listant chaque échec. `skip` permet de viser
   une autorité différente pour un second jeton indépendant. */
async function timestamp(hash, skip) {
  if (!Buffer.isBuffer(hash) || hash.length !== 32) throw new Error('empreinte SHA-256 attendue');
  const errors = [];
  for (const auth of AUTHORITIES) {
    if (skip && skip === auth.name) continue;
    try {
      return await askOne(auth, hash);
    } catch (e) {
      errors.push(auth.name + ': ' + ((e && e.message) || 'échec'));
    }
  }
  const err = new Error('aucune autorité d\'horodatage disponible (' + errors.join(' ; ') + ')');
  err.details = errors;
  throw err;
}

module.exports = { timestamp, AUTHORITIES };
