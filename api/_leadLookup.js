// ============================================================================
// api/_leadLookup.js — helpers partagés de résolution d'une fiche lead
// ----------------------------------------------------------------------------
// Même logique que api/booking-setter-attribution.js et findLead() de la
// Cloud Function onBookingCreated : leadId direct → email (minuscules puis
// tel quel) → phoneNormalized (9 derniers chiffres) → variantes historiques
// du champ `telephone`. Les fiches `_merged: true` sont toujours ignorées
// (motif pickAlive).
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');

function str(v, max) {
  return (v == null ? '' : String(v)).trim().slice(0, max || 300);
}

// 9 derniers digits — même clé que api/alteoform-submit.js et sales-leads.html.
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

// Téléphone canonique des leads : E.164 strict +33XXXXXXXXX. On ne convertit
// que les numéros français reconnaissables ; le reste est gardé tel quel
// (sans espaces) plutôt que d'inventer un indicatif.
function toE164(raw) {
  const s = String(raw || '').replace(/[^\d+]/g, '');
  if (!s) return '';
  if (/^\+33\d{9}$/.test(s)) return s;
  if (/^\+330\d{9}$/.test(s)) return '+33' + s.slice(4);
  if (/^0033\d{9}$/.test(s)) return '+33' + s.slice(4);
  if (/^33\d{9}$/.test(s)) return '+' + s;
  if (/^0\d{9}$/.test(s)) return '+33' + s.slice(1);
  if (/^[1-9]\d{8}$/.test(s)) return '+33' + s;
  return s;
}

// Variantes historiques du champ `telephone` — filet pour les vieilles fiches
// sans phoneNormalized.
function telVariants(raw) {
  const e164 = toE164(raw);
  const out = {};
  const clean = String(raw || '').replace(/\s+/g, '');
  if (clean) out[clean] = 1;
  if (/^\+33\d{9}$/.test(e164)) {
    const base = '0' + e164.slice(3);
    out[e164] = 1;
    out[base] = 1;
    out['33' + e164.slice(3)] = 1;
    out[base.replace(/(\d{2})(?=\d)/g, '$1 ')] = 1;
    out[base.replace(/(\d{2})(?=\d)/g, '$1.')] = 1;
  }
  return Object.keys(out);
}

function pickAlive(snap) {
  if (snap.empty) return null;
  for (const d of snap.docs) {
    if (d.data()._merged !== true) return d;
  }
  return null;
}

/* Retourne le DocumentSnapshot de la fiche vivante, ou null. */
async function findLeadDoc(leadId, emailRaw, telRaw) {
  if (leadId) {
    const direct = await db.collection('leads').doc(leadId).get();
    if (direct.exists && direct.data()._merged !== true) return direct;
  }
  const emailIn = str(emailRaw, 200);
  const emailLc = emailIn.toLowerCase();
  const emails = emailIn && emailIn !== emailLc ? [emailLc, emailIn] : [emailLc];
  for (const e of emails) {
    if (!e) continue;
    const sn = await db.collection('leads').where('email', '==', e).limit(5).get();
    const hit = pickAlive(sn);
    if (hit) return hit;
  }
  const phoneNorm = phoneNormalized(telRaw);
  if (phoneNorm && phoneNorm.length === 9) {
    const sn = await db.collection('leads').where('phoneNormalized', '==', phoneNorm).limit(5).get();
    const hit = pickAlive(sn);
    if (hit) return hit;
    for (const v of telVariants(telRaw)) {
      const sn2 = await db.collection('leads').where('telephone', '==', v).limit(5).get();
      const hit2 = pickAlive(sn2);
      if (hit2) return hit2;
    }
  }
  return null;
}

function dateNowFR() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

module.exports = { str, phoneNormalized, toE164, telVariants, pickAlive, findLeadDoc, dateNowFR };
