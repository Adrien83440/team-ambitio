// ============================================================================
// api/coach-provision.js — MISE EN PLACE AUTOMATIQUE D'UNE FICHE COACH (Booking)
// (23/11/2026, demande d'Adrien : « que je n'aie plus rien à faire »)
// ----------------------------------------------------------------------------
// ÉTAPE 1 (ce fichier, pour l'instant) : AUDIT en lecture seule des fiches
// expert de booking_config, pour recopier les réglages des coachs en place
// sans les deviner. Aucune écriture.
//
//   GET ?key=<COACH_PROVISION_KEY>&action=audit
//
// Clé : variable Vercel COACH_PROVISION_KEY (jamais dans le dépôt) ; absente
// ou trop courte → 404. Sortie : structure des fiches (prénoms de l'équipe,
// comptes d'agenda de l'entreprise) — aucun client, aucun jeton.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');

function keyOk(k) {
  const want = process.env.COACH_PROVISION_KEY || '';
  const a = Buffer.from(String(k || '')), b = Buffer.from(want);
  return want.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* Identifiant d'agenda → nature, sans exposer une adresse personnelle. */
function natureAgenda(id) {
  const s = String(id || '');
  if (/@group\.calendar\.google\.com$/.test(s)) return 'sous-agenda';
  if (/@(group\.v|import)\.calendar\.google\.com$/.test(s)) return 'agenda-systeme';
  const m = /^([^@]+)@(.+)$/.exec(s);
  if (m) return 'compte:' + m[1].slice(0, 3) + '…@' + m[2];
  return s ? 'autre' : '';
}
function compte(email) {
  const m = /^([^@]+)@(.+)$/.exec(String(email || ''));
  return m ? m[1] + '@' + m[2] : '';
}
function prenom(nom) { return String(nom || '').trim().split(/\s+/)[0] || ''; }

async function audit() {
  const [cfgSnap, usersSnap, tokSnap, extraSnap, tmSnap] = await Promise.all([
    db.collection('booking_config').get(),
    db.collection('users').get(),
    db.collection('calendar_tokens').get(),
    db.collection('calendar_extra_tokens').get(),
    db.collection('_meta').doc('team_members').get(),
  ]);
  const users = {};
  usersSnap.forEach(function (d) { const u = d.data() || {}; users[d.id] = { role: u.role || '', alsoCoach: u.alsoCoach === true, status: u.status || '', prenom: prenom(u.displayName || u.fullName || '') }; });
  const tokens = {};
  tokSnap.forEach(function (d) { const t = d.data() || {}; tokens[d.id] = { email: compte(t.email), refresh: !!t.refreshToken, scope: t.scope || null }; });
  const extras = {};
  extraSnap.forEach(function (d) { const t = d.data() || {}; (extras[t.personId] = extras[t.personId] || []).push({ id: d.id.split('__')[1] ? 'conn' : d.id, email: compte(t.email), refresh: !!t.refreshToken }); });

  let types = [];
  const persons = [];
  const autres = [];
  cfgSnap.forEach(function (d) {
    const v = d.data() || {};
    if (d.id === '_types') {
      types = (v.list || []).map(function (t) {
        return { id: t.id, label: t.label || '', isCoaching: t.isCoaching === true, active: t.active !== false, duration: t.duration || null, isSetterOnly: t.isSetterOnly === true, location: t.location || '' };
      });
      return;
    }
    if (v.__type !== 'person') { autres.push({ id: d.id, type: v.__type || null, champs: Object.keys(v).slice(0, 30) }); return; }
    const u = v.firebaseUid ? users[v.firebaseUid] : null;
    const sch = v.schedule || {};
    persons.push({
      id: d.id,
      nom: v.name || '',
      role: v.role || '',
      isCoach: v.isCoach === true,
      active: v.active !== false,
      createdVia: v.createdVia || null,
      createdAt: v.createdAt || null,
      compteLie: u ? { role: u.role, alsoCoach: u.alsoCoach, status: u.status, prenom: u.prenom } : (v.firebaseUid ? 'uid inconnu' : null),
      champs: Object.keys(v).sort(),
      types: v.types || [],
      defaultTypeId: v.defaultTypeId || null,
      horaires: Object.keys(sch).map(function (k) { const x = sch[k]; return k + ':' + (Array.isArray(x) ? x.length : (x && typeof x === 'object' ? JSON.stringify(x).slice(0, 80) : String(x))); }),
      bufferBefore: v.bufferBefore == null ? null : v.bufferBefore,
      bufferAfter: v.bufferAfter == null ? null : v.bufferAfter,
      minNoticeHours: v.minNoticeHours == null ? null : v.minNoticeHours,
      maxPerDay: v.maxPerDay == null ? null : v.maxPerDay,
      maxPerWeek: v.maxPerWeek == null ? null : v.maxPerWeek,
      availabilityRules: v.availabilityRules ? JSON.stringify(v.availabilityRules).slice(0, 300) : null,
      dateOverrides: v.dateOverrides ? Object.keys(v.dateOverrides).length : 0,
      meetLink: !!v.meetLink,
      photo: !!v.photoUrl,
      bio: !!v.bio,
      email: compte(v.email),
      notifEmailDomaine: v.personalEmail ? String(v.personalEmail).split('@')[1] || '' : '',
      calendarConnected: v.calendarConnected === true,
      calendarEmail: compte(v.calendarEmail),
      calendarList: (v.calendarList || []).map(function (c) {
        return { nom: c.name || '', nature: natureAgenda(c.id), primary: c.primary === true, checkConflicts: c.checkConflicts === true, createEvents: c.createEvents === true };
      }),
      jeton: tokens[d.id] || null,
      extraConnections: (v.extraConnections || []).map(function (c) {
        return { email: compte(c.email), agendas: (c.calendars || []).map(function (k) { return { nom: k.name || '', nature: natureAgenda(k.id), checkConflicts: k.checkConflicts === true }; }) };
      }),
      jetonsExtra: extras[d.id] || [],
    });
  });

  const raw = tmSnap.exists ? (tmSnap.data() || {}).members : null;
  const equipe = [];
  const push = function (m) { if (m && typeof m === 'object') equipe.push({ slug: m.slug || '', prenom: prenom(m.shortName || m.displayName || m.fullName || ''), role: m.role || '', alsoCoach: m.alsoCoach === true, active: m.active !== false, lieCompte: !!m.firebaseUid, compte: m.firebaseUid && users[m.firebaseUid] ? users[m.firebaseUid].role : null }); };
  if (Array.isArray(raw)) raw.forEach(push); else if (raw) Object.keys(raw).forEach(function (k) { push(Object.assign({ slug: k }, raw[k])); });

  return { ok: true, types: types, persons: persons, autresDocs: autres, equipe: equipe };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  if (!keyOk(q.key)) { res.status(404).json({ ok: false }); return; }
  try {
    const action = String(q.action || 'audit');
    if (action === 'audit') { res.status(200).json(await audit()); return; }
    res.status(400).json({ ok: false, error: 'action inconnue' });
  } catch (e) {
    console.error('[coach-provision]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 400) });
  }
};
