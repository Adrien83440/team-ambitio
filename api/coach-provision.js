// ============================================================================
// api/coach-provision.js — MISE EN PLACE AUTOMATIQUE D'UNE FICHE COACH (Booking)
// (23/11/2026, demande d'Adrien : « que je n'aie plus rien à faire »)
// ----------------------------------------------------------------------------
// Ce que faisait Adrien à la main pour chaque nouveau coach, fait ici d'un
// coup, pour un compte donné (rôle `coach`, ou double casquette `alsoCoach`) :
//
//   1. FICHE EXPERT : celle du compte marquée « 🎯 Coach » ; pour une double
//      casquette, une fiche SÉPARÉE de sa fiche d'origine (créée si absente).
//   2. PARAMÈTRES : consultations coaching portées par la majorité des coachs
//      déjà réglés, consultation par défaut, tampons / délais / plafonds des
//      coachs en place, e-mail de notification. Les horaires ne sont JAMAIS
//      recopiés : ils sont personnels, la fiche n'est réservable qu'une fois
//      posés par le coach.
//   3. AGENDA : la connexion Google du compte partagé coaching (celui que
//      partagent les fiches coach) est recopiée d'une fiche coach en place.
//   4. SOUS-AGENDA : un agenda au prénom du coach dans ce compte — repris s'il
//      existe déjà, sinon créé (exige l'autorisation unique « créer des
//      agendas », action `master`). Il devient l'agenda des RDV de la fiche,
//      et il est ajouté DÉCOCHÉ aux autres fiches coach (sinon la Cloud
//      Function le cocherait d'office et ses RDV bloqueraient tout le monde).
//   5. AGENDA PERSONNEL (double casquette) : les connexions de sa fiche
//      d'origine sont recopiées en agendas supplémentaires — pas de double
//      réservation entre ses deux casquettes.
//
// Règle d'or : ne remplit que ce qui MANQUE. Rien n'est écrasé, rien supprimé.
// À blanc par défaut ; `apply=1` pour écrire. Trace : coach_provision_log/*.
//
//   POST { action:'provision', uid | personId, apply? }   (admin connecté)
//   POST { action:'master', code }                        (admin connecté)
//   GET  ?key=<COACH_PROVISION_KEY>&action=audit|provision&uid=…[&apply=1]
//
// Clé : variable Vercel COACH_PROVISION_KEY (temporaire, jamais dans le
// dépôt) ; absente ou trop courte → seul l'accès admin connecté fonctionne.
// Réglages facultatifs : _config/coach_provision { types, typesAussiCoach,
// nomSousAgenda:{<uid>:'…'} }. Jetons : Admin SDK seul (calendar_master_tokens
// n'a aucune règle navigateur).
// ============================================================================
'use strict';

const crypto = require('crypto');
const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const SCOPE_MASTER = 'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/userinfo.email';
const LABEL_COACH = 'Coach';

function keyOk(k) {
  const want = process.env.COACH_PROVISION_KEY || '';
  const a = Buffer.from(String(k || '')), b = Buffer.from(want);
  return want.length >= 24 && a.length === b.length && crypto.timingSafeEqual(a, b);
}
function fold(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }
function prenom(nom) { return String(nom || '').trim().split(/\s+/)[0] || ''; }
function capitale(s) { s = String(s || ''); return s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : ''; }
function estSousAgenda(id) { return /@group\.calendar\.google\.com$/.test(String(id || '')); }

// ─── Google ──────────────────────────────────────────────────────────────
async function oauthConf() {
  const out = {};
  const ids = ['oauth', 'oauth_calendar'];
  for (let i = 0; i < ids.length; i++) {
    const s = await db.collection('_config').doc(ids[i]).get();
    const d = s.exists ? (s.data() || {}) : {};
    if (!out.clientId && (d.client_id || d.clientId)) out.clientId = d.client_id || d.clientId;
    if (!out.clientSecret && (d.client_secret || d.clientSecret)) out.clientSecret = d.client_secret || d.clientSecret;
    /* L'adresse de retour est celle que la page utilise : _config/oauth_calendar d'abord. */
    if (ids[i] === 'oauth_calendar' && (d.redirect_uri || d.redirectUri)) out.redirectUri = d.redirect_uri || d.redirectUri;
    if (!out.redirectUri && (d.redirect_uri || d.redirectUri)) out.redirectUri = d.redirect_uri || d.redirectUri;
  }
  if (!out.clientId || !out.clientSecret) throw new Error('_config/oauth introuvable (client_id + client_secret)');
  return out;
}
function clientDe(conf, refreshToken) {
  const c = new google.auth.OAuth2(conf.clientId, conf.clientSecret, conf.redirectUri);
  c.setCredentials({ refresh_token: refreshToken });
  return c;
}
async function listerAgendas(conf, refreshToken) {
  const cal = google.calendar({ version: 'v3', auth: clientDe(conf, refreshToken) });
  const r = await cal.calendarList.list({ maxResults: 100 });
  return (r.data.items || []).map(function (c) {
    return { id: c.id, name: c.summary || c.id, color: c.backgroundColor || '#4285f4', primary: c.primary === true };
  });
}

// ─── Lecture de l'existant ───────────────────────────────────────────────
async function charger() {
  const [cfgSnap, usersSnap, tokSnap, extraSnap, tmSnap, reglSnap, masterSnap] = await Promise.all([
    db.collection('booking_config').get(),
    db.collection('users').get(),
    db.collection('calendar_tokens').get(),
    db.collection('calendar_extra_tokens').get(),
    db.collection('_meta').doc('team_members').get(),
    db.collection('_config').doc('coach_provision').get(),
    db.collection('calendar_master_tokens').doc('coaching').get(),
  ]);
  const users = {};
  usersSnap.forEach(function (d) { users[d.id] = d.data() || {}; });
  const tokens = {};
  tokSnap.forEach(function (d) { tokens[d.id] = d.data() || {}; });
  const extras = {};
  extraSnap.forEach(function (d) { const t = d.data() || {}; if (t.personId) (extras[t.personId] = extras[t.personId] || []).push(Object.assign({ _doc: d.id }, t)); });
  let types = [];
  const persons = [];
  cfgSnap.forEach(function (d) {
    const v = d.data() || {};
    if (d.id === '_types') { types = v.list || []; return; }
    if (v.__type === 'person') persons.push(Object.assign({ id: d.id }, v));
  });
  const equipe = [];
  const raw = tmSnap.exists ? (tmSnap.data() || {}).members : null;
  if (Array.isArray(raw)) raw.forEach(function (m) { if (m && typeof m === 'object') equipe.push(m); });
  else if (raw && typeof raw === 'object') Object.keys(raw).forEach(function (k) { if (raw[k] && typeof raw[k] === 'object') equipe.push(Object.assign({ slug: k }, raw[k])); });
  return {
    users: users, tokens: tokens, extras: extras, types: types, persons: persons, equipe: equipe,
    reglages: reglSnap.exists ? (reglSnap.data() || {}) : {},
    master: masterSnap.exists ? (masterSnap.data() || {}) : null,
  };
}

/* Les fiches coach déjà RÉGLÉES servent de modèle : marquées coach, reliées à
   un compte de rôle `coach`, avec agenda connecté et au moins une consultation. */
function modeles(ctx) {
  return ctx.persons.filter(function (p) {
    const u = p.firebaseUid ? ctx.users[p.firebaseUid] : null;
    return p.isCoach === true && u && u.role === 'coach' && p.calendarConnected === true
      && Array.isArray(p.types) && p.types.length && ctx.tokens[p.id] && ctx.tokens[p.id].refreshToken;
  });
}
/* Compte Google partagé des coachs = celui de la majorité des fiches modèles. */
function comptePartage(mods) {
  const n = {};
  mods.forEach(function (p) { const e = String(p.calendarEmail || '').toLowerCase(); if (e) n[e] = (n[e] || 0) + 1; });
  const tri = Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
  return tri[0] || '';
}
function majorite(listes) {
  const n = {};
  listes.forEach(function (l) { const vu = {}; (l || []).forEach(function (x) { if (!vu[x]) { vu[x] = 1; n[x] = (n[x] || 0) + 1; } }); });
  const seuil = listes.length / 2;
  return Object.keys(n).filter(function (k) { return n[k] > seuil; });
}
function mediane(vals) {
  const v = vals.filter(function (x) { return typeof x === 'number' && isFinite(x); }).sort(function (a, b) { return a - b; });
  return v.length ? v[Math.floor((v.length - 1) / 2)] : 0;
}
function frequent(vals) {
  const n = {};
  vals.forEach(function (x) { if (x) n[x] = (n[x] || 0) + 1; });
  const tri = Object.keys(n).sort(function (a, b) { return n[b] - n[a]; });
  return tri[0] || null;
}

function typesPour(ctx, mods, double) {
  const actifs = {};
  ctx.types.forEach(function (t) { if (t && t.id && t.isCoaching === true && t.active !== false) actifs[t.id] = t; });
  const forces = double ? ctx.reglages.typesAussiCoach : ctx.reglages.types;
  if (Array.isArray(forces) && forces.length) return forces.filter(function (id) { return actifs[id]; });
  let ids = majorite(mods.map(function (p) { return p.types; })).filter(function (id) { return actifs[id]; });
  /* Double casquette : les séances de coaching seulement, pas les RDV
     d'accueil et d'audit du coach référent (elle ne l'est jamais). */
  if (double) ids = ids.filter(function (id) { return /^coaching_/.test(id); });
  return ctx.types.map(function (t) { return t.id; }).filter(function (id) { return ids.indexOf(id) >= 0; });
}

// ─── Le traitement ───────────────────────────────────────────────────────
async function provisionner(input, apply, par) {
  const ctx = await charger();
  const rap = { ok: true, dry: !apply, etapes: [], aFaire: [], ecrit: [] };
  const note = function (cle, etat, detail) { rap.etapes.push({ etape: cle, etat: etat, detail: detail || '' }); };

  // 0. Le compte
  let uid = String(input.uid || '');
  let cible = null;
  if (input.personId) {
    cible = ctx.persons.find(function (p) { return p.id === String(input.personId); }) || null;
    if (!cible) return { ok: false, error: 'fiche_introuvable' };
    if (!uid) uid = cible.firebaseUid || '';
  }
  const u = uid ? ctx.users[uid] : null;
  if (!u) return { ok: false, error: 'compte_introuvable', message: 'La fiche doit être reliée à un compte (Booking → fiche → Compte).' };
  const coach = u.role === 'coach';
  const double = !coach && u.alsoCoach === true;
  if (!coach && !double) return { ok: false, error: 'pas_coach', message: 'Ce compte n\'est ni coach ni « Aussi coach ».' };
  if (u.status === 'disabled' || u.status === 'archived') return { ok: false, error: 'compte_inactif' };
  const membre = ctx.equipe.find(function (m) { return m.firebaseUid === uid; }) || {};
  const nomComplet = u.displayName || u.fullName || membre.displayName || membre.fullName || '';
  rap.compte = { prenom: prenom(nomComplet), role: u.role, double: double };

  // 1. La fiche
  const siennes = ctx.persons.filter(function (p) { return p.firebaseUid === uid; });
  if (!cible) cible = siennes.find(function (p) { return p.isCoach === true; }) || null;
  if (!cible && coach && siennes.length === 1) cible = siennes[0];
  const origine = double ? (siennes.find(function (p) { return !cible || p.id !== cible.id; }) || null) : null;
  let creation = null;
  if (!cible) {
    const base = fold(nomComplet || 'coach').replace(/[^a-z0-9]/g, '').slice(0, 15) || 'coach';
    const id = base + '_' + crypto.randomBytes(3).toString('hex');
    creation = {
      __type: 'person', name: nomComplet || 'Coach', role: LABEL_COACH, color: membre.color || '#a78bfa',
      types: [], schedule: {}, blockedDates: [], isCoach: true, firebaseUid: uid,
      personalEmail: (origine && origine.personalEmail) || u.email || '',
      createdAt: new Date().toISOString(), createdVia: 'coach-provision',
    };
    cible = Object.assign({ id: id }, creation);
    note('fiche', 'a_creer', 'Nouvelle fiche « ' + cible.name + ' » (séparée de sa fiche d\'origine).');
  } else {
    note('fiche', 'existe', cible.id + ' — « ' + (cible.name || '') + ' »');
  }
  rap.personId = cible.id;
  const patch = {};
  if (cible.isCoach !== true) patch.isCoach = true;
  if (!cible.role) patch.role = LABEL_COACH;
  if (!cible.personalEmail) { const em = (origine && origine.personalEmail) || u.email || ''; if (em) patch.personalEmail = em; }

  // 2. Les paramètres
  const mods = modeles(ctx).filter(function (p) { return p.id !== cible.id; });
  if (!mods.length) rap.aFaire.push('Aucune fiche coach déjà réglée pour servir de modèle : consultations à cocher à la main.');
  if (!(cible.types || []).length) {
    const ids = typesPour(ctx, mods, double);
    if (ids.length) { patch.types = ids; note('consultations', 'a_poser', ids.join(', ')); }
    else note('consultations', 'vide', 'Aucune consultation coaching commune trouvée.');
  } else note('consultations', 'inchange', (cible.types || []).join(', '));
  const typesFinaux = patch.types || cible.types || [];
  if (!cible.defaultTypeId && typesFinaux.length) {
    const def = frequent(mods.map(function (p) { return p.defaultTypeId; }));
    patch.defaultTypeId = def && typesFinaux.indexOf(def) >= 0 ? def : typesFinaux[0];
  }
  ['bufferBefore', 'bufferAfter', 'minNoticeHours', 'maxPerDay', 'maxPerWeek'].forEach(function (k) {
    if (cible[k] == null) patch[k] = mediane(mods.map(function (p) { return p[k]; }));
  });
  note('regles', 'ok', 'Tampons, délai, plafonds : valeurs des coachs en place là où rien n\'était saisi.');
  const horairesPoses = Object.keys(cible.schedule || {}).some(function (k) { const x = (cible.schedule || {})[k]; return Array.isArray(x) && x.length; });
  if (!horairesPoses) rap.aFaire.push('Horaires de disponibilité à poser par le coach (Booking → sa fiche → Horaires) : la fiche n\'est pas réservable avant.');

  // 3 + 4. L'agenda du compte partagé et le sous-agenda
  const partage = comptePartage(mods);
  const source = mods.find(function (p) { return String(p.calendarEmail || '').toLowerCase() === partage; }) || null;
  let conf = null;
  let ecrireJeton = null;
  let autresFiches = [];
  let extraDocs = [];
  if (cible.calendarConnected === true && ctx.tokens[cible.id] && ctx.tokens[cible.id].refreshToken) {
    note('agenda', 'inchange', 'Déjà connecté (' + (cible.calendarEmail || '') + ').');
  } else if (!source) {
    note('agenda', 'impossible', 'Aucune fiche coach connectée au compte partagé pour recopier la connexion.');
    rap.aFaire.push('Connecter le Google Agenda du compte coaching sur la fiche (Booking → fiche → Agenda).');
  } else {
    conf = await oauthConf();
    const jeton = ctx.tokens[source.id];
    let agendas = [];
    try { agendas = await listerAgendas(conf, jeton.refreshToken); }
    catch (e) { note('agenda', 'erreur', 'Lecture des agendas de ' + partage + ' : ' + String(e && e.message || e).slice(0, 160)); }
    if (agendas.length) {
      const voulu = String((ctx.reglages.nomSousAgenda || {})[uid] || capitale(prenom(membre.shortName || nomComplet)));
      /* Sous-agendas déjà pris par une autre fiche : jamais réutilisés. */
      const pris = {};
      ctx.persons.forEach(function (p) {
        if (p.id === cible.id) return;
        (p.calendarList || []).forEach(function (c) { if (c && c.createEvents === true && c.id) pris[c.id] = p.name || p.id; });
      });
      /* Repris s'il existe : même nom, sinon le SEUL sous-agenda libre dont le
         nom commence par le prénom (« Edouard.DW », « Marine C. »…). */
      const libres = agendas.filter(function (c) { return estSousAgenda(c.id) && !pris[c.id]; });
      rap.sousAgendasLibres = libres.map(function (c) { return c.name; });
      let sien = libres.find(function (c) { return fold(c.name) === fold(voulu); }) || null;
      if (!sien) {
        const proches = libres.filter(function (c) { return fold(c.name).indexOf(fold(voulu)) === 0; });
        if (proches.length === 1) sien = proches[0];
      }
      if (sien) note('sous_agenda', 'existe', '« ' + sien.name + ' » déjà présent dans ' + partage + ' : repris.');
      else if (!ctx.master || !ctx.master.refreshToken) {
        note('sous_agenda', 'autorisation_manquante', 'Le sous-agenda « ' + voulu + ' » n\'existe pas dans ' + partage + ' et l\'autorisation unique de créer des agendas n\'a pas encore été donnée.');
        rap.masterManquant = true;
        rap.comptePartage = partage;
        rap.aFaire.push('Une seule fois : Booking → fiche du coach → « ⚡ Mise en place automatique » → se connecter avec ' + partage + '. Le sous-agenda se crée ensuite tout seul, pour ce coach et les suivants.');
      } else if (String(ctx.master.email || '').toLowerCase() !== partage) {
        note('sous_agenda', 'mauvais_compte', 'L\'autorisation a été donnée avec ' + ctx.master.email + ' au lieu de ' + partage + '.');
        rap.masterManquant = true;
        rap.comptePartage = partage;
      } else if (!apply) {
        sien = { id: '(à créer)', name: voulu, color: '#a78bfa', primary: false, _aCreer: true };
        note('sous_agenda', 'a_creer', '« ' + voulu + ' » sera créé dans ' + partage + '.');
      } else {
        const calM = google.calendar({ version: 'v3', auth: clientDe(conf, ctx.master.refreshToken) });
        const cr = await calM.calendars.insert({ requestBody: { summary: voulu, timeZone: 'Europe/Paris' } });
        sien = { id: cr.data.id, name: cr.data.summary || voulu, color: '#a78bfa', primary: false };
        agendas.push(sien);
        rap.ecrit.push('sous-agenda « ' + sien.name + ' » créé');
        note('sous_agenda', 'cree', '« ' + sien.name + ' » créé dans ' + partage + '.');
      }
      if (sien) {
        const liste = agendas.filter(function (c) { return !sien._aCreer || c.id !== sien.id; }).map(function (c) {
          const moi = c.id === sien.id;
          return { id: c.id, name: c.name, color: c.color, primary: c.primary === true, checkConflicts: moi, createEvents: moi };
        });
        if (sien._aCreer) liste.push({ id: sien.id, name: sien.name, color: sien.color, primary: false, checkConflicts: true, createEvents: true });
        patch.calendarConnected = true;
        patch.calendarEmail = jeton.email || partage;
        patch.calendarList = liste;
        ecrireJeton = { refreshToken: jeton.refreshToken, email: jeton.email || partage, copieDe: source.id };
        note('agenda', 'a_connecter', 'Connexion ' + partage + ' recopiée de la fiche « ' + (source.name || source.id) + ' » ; RDV créés dans « ' + sien.name + ' », seul agenda vérifié de ce compte.');
        /* Les autres fiches du même compte : le nouvel agenda y entre DÉCOCHÉ. */
        if (!sien._aCreer) {
          autresFiches = ctx.persons.filter(function (p) {
            return p.id !== cible.id && String(p.calendarEmail || '').toLowerCase() === partage
              && !(p.calendarList || []).some(function (c) { return c && c.id === sien.id; });
          }).map(function (p) {
            return { id: p.id, calendarList: (p.calendarList || []).concat([{ id: sien.id, name: sien.name, color: sien.color, primary: false, checkConflicts: false, createEvents: false }]) };
          });
        }
        note('autres_fiches', autresFiches.length || sien._aCreer ? 'a_proteger' : 'ok', 'Le sous-agenda est ajouté décoché aux autres fiches de ' + partage + ' : ses RDV ne bloquent pas les autres coachs.');
      }
    }
  }

  // 5. Agendas personnels (double casquette) : ceux de sa fiche d'origine
  if (double && origine && !(cible.extraConnections || []).length) {
    const conns = [];
    const ajoute = function (email, refreshToken, calendars) {
      if (!email || !refreshToken) return;
      const cid = String(email).replace(/[^a-zA-Z0-9]/g, '_');
      if (conns.some(function (c) { return c.id === cid; })) return;
      conns.push({ id: cid, email: email, calendars: calendars || [] });
      extraDocs.push({ doc: cible.id + '__' + cid, data: { accessToken: '', refreshToken: refreshToken, expiresAt: null, email: email, personId: cible.id, copieDe: origine.id } });
    };
    const tOrig = ctx.tokens[origine.id];
    if (tOrig && tOrig.refreshToken) {
      ajoute(tOrig.email || origine.calendarEmail, tOrig.refreshToken, (origine.calendarList || []).map(function (c) {
        return { id: c.id, name: c.name, color: c.color, primary: c.primary === true, checkConflicts: c.checkConflicts !== false };
      }));
    }
    (ctx.extras[origine.id] || []).forEach(function (t) {
      const ec = (origine.extraConnections || []).find(function (c) { return c && c.email === t.email; });
      ajoute(t.email, t.refreshToken, ec ? (ec.calendars || []) : []);
    });
    if (conns.length) { patch.extraConnections = conns; note('agendas_perso', 'a_recopier', conns.length + ' agenda(s) de sa fiche d\'origine : pas de double réservation entre ses deux casquettes.'); }
    else rap.aFaire.push('Aucun agenda personnel connecté sur sa fiche d\'origine : à connecter depuis sa fiche coach pour éviter les doubles réservations.');
  } else if (!double && !(cible.extraConnections || []).length) {
    rap.aFaire.push('Le coach connecte son agenda personnel depuis sa fiche (un clic) pour éviter les doubles réservations.');
  }

  rap.changements = Object.keys(patch);
  rap.lien = '/booking.html?person=' + cible.id;
  if (!apply) return rap;

  // ─── Écritures (ordre : fiche, jetons, autres fiches, synchro) ───
  const ref = db.collection('booking_config').doc(cible.id);
  if (creation) { await ref.set(Object.assign({}, creation, patch)); rap.ecrit.push('fiche créée'); }
  else if (Object.keys(patch).length) { await ref.update(patch); rap.ecrit.push('fiche complétée (' + Object.keys(patch).join(', ') + ')'); }
  if (ecrireJeton) {
    await db.collection('calendar_tokens').doc(cible.id).set({
      accessToken: '', refreshToken: ecrireJeton.refreshToken, expiresAt: null, email: ecrireJeton.email,
      copieDe: ecrireJeton.copieDe, connectedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    rap.ecrit.push('connexion agenda recopiée');
  }
  for (let i = 0; i < extraDocs.length; i++) {
    await db.collection('calendar_extra_tokens').doc(extraDocs[i].doc).set(Object.assign({ connectedAt: admin.firestore.FieldValue.serverTimestamp() }, extraDocs[i].data));
  }
  if (extraDocs.length) rap.ecrit.push(extraDocs.length + ' agenda(s) personnel(s) recopié(s)');
  for (let j = 0; j < autresFiches.length; j++) {
    await db.collection('booking_config').doc(autresFiches[j].id).update({ calendarList: autresFiches[j].calendarList });
  }
  if (autresFiches.length) rap.ecrit.push('sous-agenda ajouté décoché à ' + autresFiches.length + ' autre(s) fiche(s)');
  if (ecrireJeton || extraDocs.length) {
    /* La Cloud Function recalcule les créneaux occupés de la fiche. */
    await db.collection('calendar_sync_requests').doc(cible.id).set({ requestedAt: admin.firestore.FieldValue.serverTimestamp() });
  }
  await db.collection('coach_provision_log').add({
    at: admin.firestore.FieldValue.serverTimestamp(), par: par || '', uid: uid, personId: cible.id,
    ecrit: rap.ecrit, etapes: rap.etapes, aFaire: rap.aFaire,
  });
  return rap;
}

// ─── Autorisation unique « créer des agendas » ───────────────────────────
async function enregistrerMaster(code, par) {
  const conf = await oauthConf();
  if (!conf.redirectUri) return { ok: false, error: 'redirect_uri_absent' };
  const client = new google.auth.OAuth2(conf.clientId, conf.clientSecret, conf.redirectUri);
  const r = await client.getToken(String(code));
  const tokens = r.tokens || {};
  if (!tokens.refresh_token) return { ok: false, error: 'pas_de_refresh_token', message: 'Google n\'a pas renvoyé de jeton durable : recommencer la connexion.' };
  client.setCredentials(tokens);
  const info = await google.oauth2({ version: 'v2', auth: client }).userinfo.get();
  const email = String((info.data && info.data.email) || '').toLowerCase();
  const ctx = await charger();
  const partage = comptePartage(modeles(ctx));
  if (partage && email !== partage) return { ok: false, error: 'mauvais_compte', message: 'Connecté avec ' + email + ' : il faut le compte ' + partage + '.' };
  if (String(tokens.scope || '').indexOf('auth/calendar') < 0) return { ok: false, error: 'droit_refuse', message: 'Le droit de gérer les agendas n\'a pas été accordé.' };
  await db.collection('calendar_master_tokens').doc('coaching').set({
    refreshToken: tokens.refresh_token, email: email, scope: tokens.scope || '',
    par: par || '', at: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true, email: email };
}

// ─── Audit (lecture seule, sans donnée client ni jeton) ──────────────────
async function audit() {
  const ctx = await charger();
  const mods = modeles(ctx);
  return {
    ok: true,
    comptePartage: comptePartage(mods),
    master: ctx.master ? { email: ctx.master.email || '', scope: ctx.master.scope || '' } : null,
    modeles: mods.map(function (p) { return { id: p.id, prenom: prenom(p.name), types: p.types, defaultTypeId: p.defaultTypeId || null }; }),
    typesCoach: typesPour(ctx, mods, false),
    typesAussiCoach: typesPour(ctx, mods, true),
    fichesCoach: ctx.persons.filter(function (p) { return p.isCoach === true; }).map(function (p) {
      const u = p.firebaseUid ? ctx.users[p.firebaseUid] : null;
      return {
        id: p.id, prenom: prenom(p.name), compte: u ? u.role + (u.alsoCoach === true ? '+coach' : '') : null,
        types: (p.types || []).length, agenda: p.calendarConnected === true ? (p.calendarEmail || '') : '',
        agendaRdv: ((p.calendarList || []).find(function (c) { return c && c.createEvents === true; }) || {}).name || '',
        extra: (p.extraConnections || []).length,
      };
    }),
  };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const q = req.query || {};
  try {
    let body = {};
    if (req.method === 'POST') { try { body = (await parseBody(req)) || {}; } catch (_) { body = {}; } }
    const p = Object.assign({}, q, body);
    const action = String(p.action || 'provision');
    let par = '';
    if (q.key) {
      if (!keyOk(q.key)) { res.status(404).json({ ok: false }); return; }
      par = 'cle-temporaire';
    } else {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      par = auth.email || auth.uid;
    }
    if (action === 'audit') { res.status(200).json(await audit()); return; }
    if (action === 'master') {
      if (par === 'cle-temporaire' || !p.code) { res.status(400).json({ ok: false, error: 'code_requis' }); return; }
      res.status(200).json(await enregistrerMaster(p.code, par));
      return;
    }
    if (action === 'provision') {
      if (!p.uid && !p.personId) { res.status(400).json({ ok: false, error: 'uid_ou_personId_requis' }); return; }
      const apply = p.apply === true || p.apply === 1 || p.apply === '1';
      res.status(200).json(await provisionner({ uid: p.uid, personId: p.personId }, apply, par));
      return;
    }
    res.status(400).json({ ok: false, error: 'action_inconnue' });
  } catch (e) {
    console.error('[coach-provision]', e);
    res.status(500).json({ ok: false, error: String(e && e.message || e).slice(0, 400) });
  }
};
module.exports.SCOPE_MASTER = SCOPE_MASTER;
