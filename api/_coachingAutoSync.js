// ============================================================================
// api/_coachingAutoSync.js — SYNCHRO AUTOMATIQUE DES COACHINGS INDIVIDUELS
// ----------------------------------------------------------------------------
// Demande d'Adrien (16/11/2026) : les coachs oublient le bouton « 🔍 Chercher
// les résumés » de la fiche coaching (la vidéo Google arrive tard), et la
// séance n'est alors jamais remplie. Ce module fait, seul, deux fois par
// jour, EXACTEMENT ce que fait le coach à la main — pour tous les clients.
//
// ─── SOURCES ──────────────────────────────────────────────────────────────
//  · Drive de coaching@adrienemily.com (email_tokens/drive_coaching, connecté
//    depuis admin-email-auth « Drive Coaching ») : tous les coachings 1:1 y
//    sont enregistrés — obligatoire, les coachs n'utilisent pas leur compte.
//    Notes Gemini (Google Doc) + vidéo (« … - Recording »).
//  · Réservations Booking (bookings, isCoaching) : QUI a coaché QUI, QUAND
//    (date + heure). Une réservation sans enregistrement = séance non tenue.
//
// ─── RAPPROCHEMENT D'UN DOC GEMINI ────────────────────────────────────────
//  1. Réservation coaching du même jour, heure à ±ecartMaxMin (90 min) de
//     l'heure du titre Meet, dont le client ressemble au nom du titre
//     (coaching-gemini-core.scoreNom ≥ 5) → client = celui de la réservation.
//  2. Sinon (séance calée hors Booking) : nom du titre comparé à TOUS les
//     clients actifs — retenu seulement si UN client sort nettement en tête
//     (score ≥ 10 et strictement devant le deuxième). Ambigu → rien n'est
//     écrit, la ligne remonte dans le rapport.
//
// ─── ÉCRITURE DANS LA FICHE (clients/{id}, transaction) ───────────────────
//  Mêmes règles que le scan manuel de coaching.html, plus :
//  · séance cible : celle du même jour → à ±2 jours → sinon la PREMIÈRE
//    séance « planifiée » sans date (72 h pour un RDV urgent / post
//    inscription) de la dernière année du client ;
//  · une séance encore « planifiée » passe en « fait » (décision Adrien : la
//    vidéo prouve que la séance a eu lieu, sinon elle n'est pas décomptée) —
//    date, heure, coach et bookingId repris de la réservation, trace
//    s.autoSync. nbCoachingsFaits / lastSessionDate recalculés (72 h exclue) ;
//  · jamais d'écrasement : visioUrl, resume, coach, date déjà saisis restent ;
//  · contenu : RÉSUMÉ + DÉTAILS (+ étapes suivantes) des notes Gemini, jamais
//    la transcription intégrale (coaching-gemini-core.extraireNotes) ;
//  · vidéo seule (pas de notes Gemini) : liée après videoSeuleApresH (24 h).
//  · aucune séance possible → rangé dans driveDocs (« non liés »), comme le
//    scan manuel.
//
// ─── APRÈS L'ÉCRITURE (« aval », mêmes routes que la page) ────────────────
//  Appels internes (api/_internalCall.js) : academy-seance (séance + devoirs
//  dans l'Academy), coaching-send-replay en mode auto (email au client —
//  registre anti-doublon, complément si la vidéo arrive après la synthèse),
//  puis, pour une NOUVELLE synthèse : proposition de parcours (academy-path,
//  rangée en attente de validation) et workbooks (academy-workbook).
//  Au plus maxAval séances par passage ; le reste au passage suivant.
//  Pas d'email pour une séance de plus de mailMaxJours (14) jours.
//
// ─── TRACES (Admin SDK seul, aucune règle Firestore) ─────────────────────
//  coaching_autosync/{fileId Drive} : statut ('lie' | 'non_lie' | 'ambigu'
//    | 'client_inconnu' | 'en_attente_video'), client, séance, liens,
//    résumé/synthèse (pour reposer le lien si une sauvegarde de la page
//    l'efface : coaching.html réécrit la fiche entière), état de l'aval.
//  bookings/{id}.coachingSync : { statut 'lie' | 'aucun_enregistrement' |
//    'deja_dans_la_fiche', clientId, numero, fileId, at } — affiché dans la
//    fiche (liste des RDV coaching du mois).
// ============================================================================

const { google } = require('googleapis');
const { admin, db } = require('./_firebaseAdmin');
const Gem = require('../coaching-gemini-core.js');
const BP = require('../bp-credits.js');
const appeler = require('./_internalCall');

const CFG_PATH = '_config/coaching_auto_sync';
const TRACE = 'coaching_autosync';
const PAR = 'coaching-auto-sync';
const DOC_MIME = 'application/vnd.google-apps.document';

const DEFAUTS = {
  enabled: false,
  tokenKey: 'drive_coaching',
  compte: 'coaching@adrienemily.com',
  days: 16,                 // fenêtre de recherche (jours)
  delaiAbandonJours: 14,    // réservation sans enregistrement au-delà → « aucun enregistrement »
  videoSeuleApresH: 24,     // vidéo sans notes Gemini : liée seule après ce délai
  ecartMaxMin: 90,          // écart toléré entre l'heure du titre Meet et la réservation
  maxAval: 12,              // séances traitées en aval (email, Academy, IA) par passage
  partageVideo: 'aucun',    // 'lien' = rendre la vidéo lisible par lien si elle ne l'est pas
  mailMaxJours: 14,         // pas d'email client pour une séance plus ancienne (rattrapage : fiche seule)
};

const BUDGET_DOCS_MS = 170000;
const BUDGET_TOTAL_MS = 250000;
const MAX_TENTATIVES_AVAL = 3;

// ─── Dates (Europe/Paris) ────────────────────────────────────────────────
function parisIso(d) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
}
function parisHeure(d) {
  return Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(d || new Date()));
}
function isoAddDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function joursEntre(isoA, isoB) {
  return Math.round((new Date(isoB + 'T00:00:00Z') - new Date(isoA + 'T00:00:00Z')) / 86400000);
}
// Fin approximative d'une réservation (heure Paris lue comme UTC : marge de
// 1 à 2 h, jamais pendant la séance).
function finReservationMs(b) {
  const d = new Date(String(b.date) + 'T' + (b.time || '23:00') + ':00Z');
  if (isNaN(d.getTime())) return 0;
  return d.getTime() + (Number(b.duration) || 60) * 60000;
}

// ─── Config ──────────────────────────────────────────────────────────────
async function chargerConfig() {
  const snap = await db.doc(CFG_PATH).get();
  const cfg = Object.assign({}, DEFAUTS, snap.exists ? (snap.data() || {}) : {});
  cfg.enabled = cfg.enabled === true;
  return cfg;
}

// ─── Drive de coaching@ ──────────────────────────────────────────────────
async function getOAuthConfig() {
  const ids = ['oauth', 'oauth_calendar'];
  for (let i = 0; i < ids.length; i++) {
    const snap = await db.collection('_config').doc(ids[i]).get();
    if (snap.exists) {
      const d = snap.data() || {};
      const clientId = d.client_id || d.clientId;
      const clientSecret = d.client_secret || d.clientSecret;
      if (clientId && clientSecret) return { clientId: clientId, clientSecret: clientSecret };
    }
  }
  throw new Error('_config/oauth introuvable (client_id + client_secret)');
}

async function getDrive(tokenKey, compteAttendu) {
  const snap = await db.collection('email_tokens').doc(tokenKey).get();
  const tok = snap.exists ? (snap.data() || {}) : {};
  if (!tok.refreshToken) {
    const e = new Error('Drive de ' + compteAttendu + ' non connecté : Admin → Connexions email → « Drive Coaching ».');
    e.code = 'drive_non_connecte';
    throw e;
  }
  if (tok.email && String(tok.email).toLowerCase() !== String(compteAttendu).toLowerCase()) {
    const e2 = new Error('« Drive Coaching » est connecté avec ' + tok.email + ' au lieu de ' + compteAttendu + '.');
    e2.code = 'mauvais_compte';
    throw e2;
  }
  const conf = await getOAuthConfig();
  const client = new google.auth.OAuth2(conf.clientId, conf.clientSecret);
  client.setCredentials({ refresh_token: tok.refreshToken, access_token: tok.accessToken || undefined });
  return google.drive({ version: 'v3', auth: client });
}

async function listerTout(drive, q) {
  const out = [];
  let pageToken = null;
  let tours = 0;
  do {
    const r = await drive.files.list({
      q: q,
      fields: 'nextPageToken, files(id,name,mimeType,createdTime,webViewLink)',
      pageSize: 200,
      orderBy: 'createdTime',
      pageToken: pageToken || undefined,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
    });
    (r.data.files || []).forEach(function (f) { out.push(f); });
    pageToken = r.data.nextPageToken || null;
    tours++;
  } while (pageToken && tours < 20);
  return out;
}

// Deux requêtes séparées (docs / vidéos) : la requête combinée avec un OR
// sur mimeType est mal interprétée par l'API Drive (cf. scan manuel).
async function listerFichiersCoaching(drive, depuisIso) {
  const noms = "(name contains 'Coaching' or name contains 'RDV' or name contains 'inscription')";
  const base = " and trashed = false and createdTime > '" + depuisIso + "T00:00:00' and " + noms;
  const docs = await listerTout(drive, "mimeType = '" + DOC_MIME + "'" + base);
  const videos = await listerTout(drive, "mimeType contains 'video/'" + base);
  return { docs: docs, videos: videos };
}

async function texteDoc(drive, fileId) {
  const r = await drive.files.export({ fileId: fileId, mimeType: 'text/plain' }, { responseType: 'text' });
  return String(r.data || '').substring(0, 80000);
}

async function estLisibleParLien(drive, fileId) {
  try {
    const r = await drive.permissions.list({ fileId: fileId, fields: 'permissions(type,role)', supportsAllDrives: true });
    return (r.data.permissions || []).some(function (p) { return p.type === 'anyone'; });
  } catch (_) { return null; }
}

function urlDoc(f) { return 'https://docs.google.com/document/d/' + f.id + '/edit'; }
function urlVideo(f) { return f.webViewLink || ('https://drive.google.com/file/d/' + f.id + '/view'); }

// ─── Équipe (coach canonique, même règle que nav.js normalizeCoach) ──────
async function chargerEquipe() {
  try {
    const snap = await db.collection('_meta').doc('team_members').get();
    const raw = snap.exists ? (snap.data() || {}).members : null;
    const list = [];
    if (Array.isArray(raw)) raw.forEach(function (m) { if (m && typeof m === 'object') list.push(m); });
    else if (raw && typeof raw === 'object') Object.keys(raw).forEach(function (k) { if (raw[k] && typeof raw[k] === 'object') list.push(Object.assign({ slug: k }, raw[k])); });
    return list;
  } catch (_) { return []; }
}
function sansAccent(s) { return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim(); }
function coachCanon(equipe, brut) {
  const s = String(brut || '').trim();
  if (!s) return '';
  const sl = sansAccent(s);
  for (let i = 0; i < equipe.length; i++) {
    const m = equipe[i];
    if (m.active === false) continue;
    const cands = [m.displayName, m.shortName, m.slug].filter(Boolean);
    for (let j = 0; j < cands.length; j++) {
      const c = sansAccent(cands[j]);
      if (c && (c === sl || c.indexOf(sl) === 0 || sl.indexOf(c) === 0)) return m.displayName || m.shortName || m.slug;
    }
  }
  const first = s.split(/[\s.]/)[0];
  return first.charAt(0).toUpperCase() + first.slice(1).toLowerCase();
}

// ─── Réservations coaching ───────────────────────────────────────────────
async function chargerTypesCoaching() {
  const map = {};
  try {
    const snap = await db.collection('booking_config').doc('_types').get();
    const list = snap.exists ? ((snap.data() || {}).list || []) : [];
    list.forEach(function (t) { if (t && t.id) map[t.id] = t; });
  } catch (_) { /* fail-soft */ }
  return map;
}
const STATUTS_NON_TENUS = { cancelled: 1, no_show: 1, noshow: 1, rescheduled: 1, replanifie: 1 };

async function chargerReservations(debutIso, finIso) {
  const types = await chargerTypesCoaching();
  const snap = await db.collection('bookings').where('date', '>=', debutIso).where('date', '<=', finIso).limit(3000).get();
  const out = [];
  snap.forEach(function (d) {
    const b = d.data() || {};
    const t = b.type && types[b.type];
    const coaching = b.isCoaching === true || !!(t && t.isCoaching === true);
    if (!coaching) return;
    out.push(Object.assign({ _id: d.id }, b));
  });
  return out;
}

// ─── Clients (lecture légère, fiche complète seulement si on écrit) ──────
async function chargerClientsLegers() {
  const snap = await db.collection('clients').select('nom', 'email', 'statut', 'ancienClient', 'programme').get();
  const byId = {};
  const byEmail = {};
  const list = [];
  snap.forEach(function (d) {
    const c = d.data() || {};
    const x = { id: d.id, nom: c.nom || '', email: String(c.email || '').trim().toLowerCase(), actif: !(c.ancienClient === true || c.statut === 'inactif'), programme: c.programme || '' };
    byId[d.id] = x;
    if (x.email && !byEmail[x.email]) byEmail[x.email] = x;
    list.push(x);
  });
  return { byId: byId, byEmail: byEmail, list: list };
}

function clientDeReservation(b, clients) {
  if (b.clientId && clients.byId[b.clientId]) return clients.byId[b.clientId];
  const em = String((b.prospect && b.prospect.email) || '').trim().toLowerCase();
  return em ? (clients.byEmail[em] || null) : null;
}
function nomDeReservation(b, client) {
  const p = b.prospect || {};
  return [client ? client.nom : '', b.clientNom || '', ((p.prenom || '') + ' ' + (p.nom || '')).trim(), p.name || ''].filter(Boolean).join(' ');
}

// Rapprochement d'un fichier Meet avec une réservation puis un client.
function rapprocher(info, reservations, clients, cfg) {
  if (info.date) {
    const cands = [];
    reservations.forEach(function (b) {
      if (b.date !== info.date) return;
      if (STATUTS_NON_TENUS[String(b.status || '')]) return;
      const ec = Gem.ecartMinutes(info.heure, b.time);
      if (ec != null && ec > cfg.ecartMaxMin) return;
      const client = clientDeReservation(b, clients);
      const score = Gem.scoreNom(info.nomClient, nomDeReservation(b, client));
      if (score < 5) return;
      cands.push({ b: b, client: client, score: score, ecart: ec == null ? 999 : ec });
    });
    cands.sort(function (a, z) { return (z.score - a.score) || (a.ecart - z.ecart); });
    if (cands.length && cands[0].client) return { ok: true, via: 'reservation', booking: cands[0].b, client: cands[0].client };
    // Réservation trouvée mais non reliée à une fiche (ni clientId, ni même
    // email) : la fiche se cherche par le nom, la réservation garde l'heure
    // et le coach (via « reservation_nom »).
    if (cands.length && !cands[0].client) {
      const parNom = rapprocherParNom(info, clients);
      if (parNom.ok) return { ok: true, via: 'reservation_nom', booking: cands[0].b, client: parNom.client };
      return Object.assign({}, parNom, { raison: 'reservation_sans_fiche', booking: cands[0].b });
    }
  }
  return rapprocherParNom(info, clients);
}

function rapprocherParNom(info, clients) {
  const scores = clients.list.filter(function (c) { return c.actif; }).map(function (c) {
    return { client: c, score: Gem.scoreNom(info.nomClient, c.nom) };
  }).filter(function (x) { return x.score >= 5; }).sort(function (a, z) { return z.score - a.score; });
  if (!scores.length) return { ok: false, raison: 'client_inconnu' };
  if (scores[0].score < 10 || (scores[1] && scores[1].score >= scores[0].score)) {
    return { ok: false, raison: 'ambigu', candidats: scores.slice(0, 3).map(function (x) { return x.client.nom; }) };
  }
  return { ok: true, via: 'nom', booking: null, client: scores[0].client };
}

// ─── Fiche : séances ─────────────────────────────────────────────────────
function seancesDe(c) {
  const out = [];
  if (Array.isArray(c.years) && c.years.length) {
    c.years.forEach(function (y, yi) { ((y && y.sessions) || []).forEach(function (s) { if (s) out.push({ s: s, yi: yi }); }); });
  } else if (Array.isArray(c.sessions)) {
    c.sessions.forEach(function (s) { if (s) out.push({ s: s, yi: null }); });
  }
  return out;
}
function est72(s) { return s.numero === 0 || s.type === 'rdv72h'; }

function recalculerStats(c) {
  let fait = 0;
  const dates = [];
  seancesDe(c).forEach(function (x) {
    if (x.s.statut === 'fait' && !est72(x.s)) { fait++; if (x.s.date) dates.push(x.s.date); }
  });
  c.nbCoachingsFaits = fait;
  c.lastSessionDate = dates.length ? dates.sort().pop() : '';
}

function choisirSeance(c, item) {
  const toutes = seancesDe(c).filter(function (x) { return x.s.statut !== 'consommee'; });
  const veut72 = item.type === 'rdv72h';
  const bonType = function (x) { return veut72 ? est72(x.s) : !est72(x.s); };
  const libre = function (x) { return item.docUrl ? !x.s.driveUrl : !x.s.visioUrl; };
  if (item.date) {
    let x = toutes.find(function (y) { return y.s.date === item.date && libre(y) && bonType(y); })
      || toutes.find(function (y) { return y.s.date === item.date && libre(y); });
    if (x) return x;
    const d0 = new Date(item.date + 'T00:00:00Z').getTime();
    x = toutes.find(function (y) {
      if (!y.s.date || !libre(y) || !bonType(y)) return false;
      return Math.abs(new Date(y.s.date + 'T00:00:00Z').getTime() - d0) < 2 * 86400000;
    });
    if (x) return x;
  }
  // Première séance planifiée sans date, dans la dernière année qui en a une.
  const planif = toutes.filter(function (y) { return y.s.statut !== 'fait' && !y.s.date && bonType(y); });
  if (!planif.length) return null;
  const derniereAnnee = planif.reduce(function (m, y) { return y.yi == null ? m : Math.max(m, y.yi); }, -1);
  const memeAnnee = planif.filter(function (y) { return derniereAnnee < 0 ? true : y.yi === derniereAnnee; });
  memeAnnee.sort(function (a, z) { return (Number(a.s.numero) || 0) - (Number(z.s.numero) || 0); });
  return memeAnnee[0] || null;
}

// Applique un fichier Meet sur la fiche (objet en mémoire). Renvoie l'action.
function appliquer(c, item, nowIso) {
  if (!Array.isArray(c.driveDocs)) c.driveDocs = [];
  const toutes = seancesDe(c);

  // Déjà lié (même doc, ou même vidéo pour une vidéo seule)
  const deja = toutes.find(function (x) {
    return item.docUrl ? x.s.driveUrl === item.docUrl : (x.s.visioUrl && x.s.visioUrl === item.videoUrl);
  });
  if (deja) {
    if (item.videoUrl && !deja.s.visioUrl) {
      deja.s.visioUrl = item.videoUrl;
      deja.s.autoSync = Object.assign({}, deja.s.autoSync || {}, { videoAt: nowIso });
      return { action: 'video_ajoutee', yi: deja.yi, numero: deja.s.numero, date: deja.s.date };
    }
    return { action: 'deja_lie', yi: deja.yi, numero: deja.s.numero, date: deja.s.date };
  }

  const cible = choisirSeance(c, item);
  if (!cible) {
    const dejaNonLie = c.driveDocs.some(function (d) { return item.docUrl ? d.docUrl === item.docUrl : d.videoUrl === item.videoUrl; });
    if (dejaNonLie) return { action: 'deja_non_lie' };
    c.driveDocs.push({
      date: item.date || null, docUrl: item.docUrl || '', docTitle: item.titre || '', type: item.type,
      summary: item.synthese || '', videoUrl: item.videoUrl || '', heure: item.heure || '', autoSync: true,
    });
    return { action: 'non_lie' };
  }

  const s = cible.s;
  const passeEnFait = s.statut !== 'fait';
  if (item.docUrl) {
    s.driveUrl = item.docUrl;
    s.driveTitle = item.titre || '';
    s.driveSummary = item.synthese || '';
    if (!s.resume || String(s.resume).length < 20) s.resume = item.resume || item.synthese || '';
  }
  if (item.videoUrl && !s.visioUrl) s.visioUrl = item.videoUrl;
  if (!s.date && item.date) s.date = item.date;
  if (!s.heure && item.heure) s.heure = item.heure;
  if (!s.coach && item.coach) s.coach = item.coach;
  if (!s.bookingId && item.bookingId) s.bookingId = item.bookingId;
  if (passeEnFait) { s.statut = 'fait'; delete s.consoMotif; }
  s.autoSync = { at: nowIso, par: 'auto', passeEnFait: passeEnFait, bookingId: item.bookingId || null, fileId: item.fileId };

  // Retirer des « non liés » s'il y était
  c.driveDocs = c.driveDocs.filter(function (d) { return item.docUrl ? d.docUrl !== item.docUrl : d.videoUrl !== item.videoUrl; });
  recalculerStats(c);
  return { action: 'lie', yi: cible.yi, numero: s.numero, date: s.date, passeEnFait: passeEnFait };
}

async function ecrireFiche(clientId, item, dry) {
  const ref = db.collection('clients').doc(clientId);
  const nowIso = new Date().toISOString();
  if (dry) {
    const snap = await ref.get();
    if (!snap.exists) return { action: 'fiche_introuvable' };
    return appliquer(snap.data() || {}, item, nowIso);
  }
  return db.runTransaction(async function (tx) {
    const snap = await tx.get(ref);
    if (!snap.exists) return { action: 'fiche_introuvable' };
    const c = snap.data() || {};
    const r = appliquer(c, item, nowIso);
    if (r.action === 'lie' || r.action === 'video_ajoutee' || r.action === 'non_lie') {
      const patch = { driveDocs: c.driveDocs, _updatedAt: Date.now() };
      if (Array.isArray(c.years) && c.years.length) patch.years = c.years;
      else patch.sessions = c.sessions || [];
      patch.nbCoachingsFaits = c.nbCoachingsFaits || 0;
      patch.lastSessionDate = c.lastSessionDate || '';
      tx.update(ref, patch);
    }
    return r;
  });
}

// ─── Aval : mêmes routes que la page coaching.html ───────────────────────
function estParcoursEtapes(c) {
  const p = String((c && c.programme) || '');
  return /^\s*elite\s+new\b/i.test(p) || BP.isBusinessV2(p);
}
function wbAutoTargets(steps) {
  const st = steps || [];
  let cur = -1;
  for (let i = 0; i < st.length; i++) { if (st[i].status === 'open' && !st[i].done) { cur = i; break; } }
  if (cur < 0) return [];
  const out = [st[cur].key];
  for (let j = cur + 1; j < st.length; j++) { if (!st[j].done && st[j].status !== 'done') { out.push(st[j].key); break; } }
  return out;
}

async function avalIA(clientId, c) {
  const em = String(c.email || '').trim().toLowerCase();
  if (!em) return { ok: true, note: 'pas_email' };
  if (estParcoursEtapes(c)) return { ok: true, note: 'parcours_etapes' };
  const pr = await appeler(require('./academy-progress'), { email: em }, { par: PAR });
  const pj = pr.body || {};
  if (pj.ok !== true) return { ok: false, erreur: pj.error || 'academy_progress' };
  if (!pj.found) return { ok: true, note: 'pas_academy' };
  const withPath = ((pj.dossier && pj.dossier.courses) || []).filter(function (co) { return co.path && (co.path.steps || []).length; });
  if (!withPath.length) return { ok: true, note: 'pas_parcours' };
  const course = withPath.find(function (co) { return co.path.guided && co.pct < 100; })
    || withPath.find(function (co) { return co.pct < 100; }) || withPath[0];
  const res = { ok: true, proposition: false, workbooks: 0 };

  // 1) Copilote : proposition rangée en attente de validation humaine.
  const r = await appeler(require('./academy-path'), { action: 'propose', email: em, courseId: course.id, clientId: clientId }, { par: PAR });
  const j = r.body || {};
  if (j.ok === true && j.proposal) {
    const prop = { at: Date.now(), trigger: 'sync', par: 'auto', status: 'pending', courseId: course.id, courseName: course.name,
      objectif: j.proposal.objectif || '', steps: j.proposal.steps || [], changes: j.proposal.changes || [], resume: j.proposal.resume || '' };
    await db.collection('clients').doc(clientId).update({ academyPathProposal: prop });
    res.proposition = true;
  } else if (j.ok === false && j.error) res.erreurCopilote = j.error;

  // 2) Scribe : workbooks du sujet en cours (+ suivant s'il manque).
  const cr = await appeler(require('./academy-workbook'), { action: 'context', email: em, courseId: course.id }, { par: PAR });
  const cj = cr.body || {};
  if (cj.ok === true && cj.learner && cj.learner.found !== false) {
    const wbs = cj.learner.workbooks || {};
    const cibles = wbAutoTargets(cj.learner.steps || []);
    for (let i = 0; i < cibles.length; i++) {
      const w = wbs[cibles[i]];
      if (w && w.frozen) continue;
      if (i > 0 && w) continue;
      const g = await appeler(require('./academy-workbook'), { action: 'generate', email: em, courseId: course.id, clientId: clientId, subId: cibles[i], trigger: 'sync' }, { par: PAR });
      if (g.body && g.body.ok === true && g.body.applied) res.workbooks++;
    }
  }
  return res;
}

async function traiterAval(traceRef, t, cfg) {
  const aval = Object.assign({ academy: false, mail: false, ia: true }, t.aval || {});
  const tentatives = (t.avalTentatives || 0) + 1;
  const journal = {};
  const snap = await db.collection('clients').doc(t.clientId).get();
  if (!snap.exists) {
    await traceRef.set({ avalAFaire: false, avalNote: 'fiche_introuvable' }, { merge: true });
    return { note: 'fiche_introuvable' };
  }
  const c = snap.data() || {};
  const x = seancesDe(c).find(function (y) {
    return Number(y.s.numero) === Number(t.numero) && (t.yi == null ? y.yi == null : y.yi === t.yi);
  });
  if (!x || x.s.statut !== 'fait') {
    // La page a pu réécrire la fiche : le passage suivant reposera le lien.
    await traceRef.set({ avalTentatives: tentatives, avalNote: 'seance_absente_ou_non_faite' }, { merge: true });
    return { note: 'seance_absente_ou_non_faite' };
  }
  const annee = x.yi != null && c.years[x.yi] ? (c.years[x.yi].label || '') : '';

  if (!aval.academy) {
    const r = await appeler(require('./academy-seance'), { clientId: t.clientId, numero: Number(t.numero), annee: annee }, { par: PAR });
    const j = r.body || {};
    journal.academy = j.ok === true ? (j.found === false ? 'pas_de_compte' : 'ok') : (j.error || 'erreur');
    if (j.ok === true || j.error === 'email_client_absent') aval.academy = true;
  }
  // Séance trop ancienne (rattrapage, décision Adrien du 16/11/2026) : la
  // fiche est remplie, mais aucun email ne part au client des mois après.
  const maxJ = Number(cfg && cfg.mailMaxJours);
  if (!aval.mail && maxJ > 0 && x.s.date && joursEntre(x.s.date, parisIso()) > maxJ) {
    aval.mail = true;
    journal.mail = 'trop_ancienne_pas_d_email';
  }
  if (!aval.mail) {
    const r2 = await appeler(require('./coaching-send-replay'), { clientId: t.clientId, sessionNumero: x.s.numero, yearIndex: x.yi, sessionDate: x.s.date || null, auto: true }, { par: PAR });
    const j2 = r2.body || {};
    journal.mail = j2.ok === true ? (j2.skipped || ('envoye:' + (j2.to || ''))) : (j2.error || 'erreur');
    if (j2.ok === true) aval.mail = true;
  }
  if (!aval.ia) {
    try {
      const r3 = await avalIA(t.clientId, c);
      journal.ia = r3;
      if (r3.ok) aval.ia = true;
    } catch (e) { journal.ia = { ok: false, erreur: e.message }; }
  }

  const fini = aval.academy && aval.mail && aval.ia;
  await traceRef.set({
    aval: aval,
    avalAFaire: !(fini || tentatives >= MAX_TENTATIVES_AVAL),
    avalTentatives: tentatives,
    avalJournal: journal,
    avalAt: admin.firestore.FieldValue.serverTimestamp(),
  }, { merge: true });
  return { fini: fini, journal: journal };
}

// ─── Passage complet ─────────────────────────────────────────────────────
async function executer(opts) {
  const o = opts || {};
  const t0 = Date.now();
  const dry = o.dry === true;
  const cfg = o.cfg || await chargerConfig();
  let days = parseInt(o.days, 10);
  if (!Number.isFinite(days) || days <= 0) days = Number(cfg.days) || DEFAUTS.days;
  if (days > 90) days = 90;

  const aujourdhui = parisIso();
  const debut = isoAddDays(aujourdhui, -days);
  const rapport = {
    ok: true, mode: dry ? 'dry' : 'apply', fenetre: { du: debut, au: aujourdhui }, compte: cfg.compte,
    fichiers: { docs: 0, videos: 0 }, lies: [], videosAjoutees: [], nonLies: [], aVerifier: [],
    enAttenteVideo: 0, dejaLies: 0, reservations: { total: 0, sansEnregistrement: [], dejaDansLaFiche: 0 },
    videosNonPartagees: [], aval: [], avalRestant: 0, erreurs: [],
  };

  const drive = await getDrive(cfg.tokenKey || DEFAUTS.tokenKey, cfg.compte || DEFAUTS.compte);
  const fichiers = await listerFichiersCoaching(drive, isoAddDays(debut, -1));
  const reservations = await chargerReservations(isoAddDays(debut, -1), aujourdhui);
  const clients = await chargerClientsLegers();
  const equipe = await chargerEquipe();
  rapport.reservations.total = reservations.length;

  // 1. Lecture des titres
  const docs = [];
  const videos = [];
  fichiers.docs.forEach(function (f) {
    const info = Gem.lireTitre(f.name, false);
    if (info.ok) docs.push({ f: f, info: info });
  });
  fichiers.videos.forEach(function (f) {
    const info = Gem.lireTitre(f.name, true);
    if (info.ok) videos.push({ f: f, info: info, prise: false });
  });
  rapport.fichiers.docs = docs.length;
  rapport.fichiers.videos = videos.length;

  function videoDe(info) {
    let v = videos.find(function (x) { return !x.prise && x.info.baseTitle && x.info.baseTitle === info.baseTitle; });
    if (!v) v = videos.find(function (x) { return !x.prise && x.info.date && x.info.date === info.date && Gem.scoreNom(x.info.nomClient, info.nomClient) >= 10 && (Gem.ecartMinutes(x.info.heure, info.heure) || 0) <= 30; });
    if (v) v.prise = true;
    return v || null;
  }

  // 2. Éléments à traiter : chaque doc Gemini (avec sa vidéo), puis les vidéos seules
  const items = [];
  docs.forEach(function (d) {
    const v = videoDe(d.info);
    items.push({ fileId: d.f.id, doc: d.f, video: v ? v.f : null, info: d.info, created: d.f.createdTime });
  });
  videos.forEach(function (v) {
    if (v.prise) return;
    items.push({ fileId: v.f.id, doc: null, video: v.f, info: v.info, created: v.f.createdTime });
  });
  items.sort(function (a, z) { return String(a.created).localeCompare(String(z.created)); });

  // Traces existantes (une lecture groupée)
  const traces = {};
  for (let i = 0; i < items.length; i += 100) {
    const refs = items.slice(i, i + 100).map(function (it) { return db.collection(TRACE).doc(it.fileId); });
    if (!refs.length) continue;
    const snaps = await db.getAll.apply(db, refs);
    snaps.forEach(function (s) { if (s.exists) traces[s.id] = s.data() || {}; });
  }

  const reservationsLiees = {};
  const nowMs = Date.now();

  for (let k = 0; k < items.length; k++) {
    if (Date.now() - t0 > BUDGET_DOCS_MS) { rapport.interrompu = 'budget_temps'; break; }
    const it = items[k];
    const info = it.info;
    const tr = traces[it.fileId] || null;
    const ligne = { fichier: (it.doc || it.video).name, date: info.date, heure: info.heure };
    try {
      // Rapprochement (stable : une trace déjà liée garde son client)
      let rap;
      if (tr && tr.clientId && clients.byId[tr.clientId]) {
        const b0 = tr.bookingId ? reservations.find(function (b) { return b._id === tr.bookingId; }) : null;
        rap = { ok: true, via: tr.via || 'trace', booking: b0 || null, client: clients.byId[tr.clientId] };
      } else {
        rap = rapprocher(info, reservations, clients, cfg);
      }
      if (!rap.ok) {
        ligne.raison = rap.raison;
        if (rap.candidats) ligne.candidats = rap.candidats;
        if (rap.booking) { ligne.reservation = rap.booking._id; reservationsLiees[rap.booking._id] = true; }
        rapport.aVerifier.push(ligne);
        if (!dry) await db.collection(TRACE).doc(it.fileId).set({ statut: rap.raison, nom: info.nomClient, date: info.date, heure: info.heure, titre: ligne.fichier, vuA: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
        continue;
      }
      const b = rap.booking;
      if (b) reservationsLiees[b._id] = true;
      ligne.client = rap.client.nom;
      ligne.via = rap.via;

      // Vidéo seule : attendre les notes Gemini videoSeuleApresH heures
      if (!it.doc) {
        const ageH = (nowMs - new Date(it.created).getTime()) / 3600000;
        if (ageH < (Number(cfg.videoSeuleApresH) || DEFAUTS.videoSeuleApresH)) { rapport.enAttenteVideo++; continue; }
      }

      // Contenu des notes (relu une fois, gardé dans la trace)
      let resume = tr && tr.resume ? tr.resume : '';
      let synthese = tr && tr.synthese ? tr.synthese : '';
      if (it.doc && !synthese) {
        const n = Gem.extraireNotes(await texteDoc(drive, it.doc.id));
        resume = n.resume; synthese = n.synthese;
      }

      const item = {
        fileId: it.fileId,
        docUrl: it.doc ? urlDoc(it.doc) : '',
        videoUrl: it.video ? urlVideo(it.video) : '',
        titre: (it.doc || it.video).name,
        type: info.type,
        date: (b && b.date) || info.date,
        heure: (b && b.time) || info.heure || '',
        coach: b ? coachCanon(equipe, b.personName || '') : '',
        bookingId: b ? b._id : null,
        resume: resume,
        synthese: synthese,
      };

      const r = await ecrireFiche(rap.client.id, item, dry);
      ligne.action = r.action;
      if (r.numero != null) ligne.seance = r.numero;
      if (r.passeEnFait) ligne.passeEnFait = true;

      if (it.video && item.videoUrl && (r.action === 'lie' || r.action === 'video_ajoutee')) {
        const lisible = await estLisibleParLien(drive, it.video.id);
        if (lisible === false) {
          if (!dry && cfg.partageVideo === 'lien') {
            try {
              await drive.permissions.create({ fileId: it.video.id, supportsAllDrives: true, requestBody: { type: 'anyone', role: 'reader' } });
              ligne.videoPartagee = true;
            } catch (pe) { rapport.videosNonPartagees.push({ fichier: it.video.name, client: rap.client.nom, erreur: pe.message }); }
          } else {
            rapport.videosNonPartagees.push({ fichier: it.video.name, client: rap.client.nom });
          }
        }
      }

      if (r.action === 'lie') rapport.lies.push(ligne);
      else if (r.action === 'video_ajoutee') rapport.videosAjoutees.push(ligne);
      else if (r.action === 'non_lie' || r.action === 'deja_non_lie') rapport.nonLies.push(ligne);
      else if (r.action === 'deja_lie') rapport.dejaLies++;
      else rapport.aVerifier.push(ligne);

      if (!dry) {
        const patch = {
          statut: (r.action === 'lie' || r.action === 'video_ajoutee' || r.action === 'deja_lie') ? 'lie' : (r.action === 'fiche_introuvable' ? 'fiche_introuvable' : 'non_lie'),
          via: rap.via, clientId: rap.client.id, clientNom: rap.client.nom, bookingId: item.bookingId,
          date: item.date || null, heure: item.heure || null, titre: item.titre, type: item.type,
          docUrl: item.docUrl || null, videoUrl: item.videoUrl || null, resume: resume, synthese: synthese,
          vuA: admin.firestore.FieldValue.serverTimestamp(),
        };
        if (r.numero != null) { patch.numero = r.numero; patch.yi = r.yi == null ? null : r.yi; }
        if (r.action === 'lie') {
          patch.lieA = admin.firestore.FieldValue.serverTimestamp();
          // Re-pose après une sauvegarde de la page : pas de 2e passage IA.
          const iaDejaFait = !!(tr && tr.aval && tr.aval.ia === true && tr.lieA);
          patch.aval = { academy: false, mail: false, ia: !item.docUrl || iaDejaFait };
          patch.avalAFaire = true;
          patch.avalTentatives = 0;
        } else if (r.action === 'video_ajoutee') {
          patch.aval = Object.assign({ academy: true, ia: true }, (tr && tr.aval) || {}, { mail: false });
          patch.avalAFaire = true;
          patch.avalTentatives = 0;
        }
        await db.collection(TRACE).doc(it.fileId).set(patch, { merge: true });
        const dejaMarquee = b && b.coachingSync && b.coachingSync.statut === 'lie' && b.coachingSync.fileId === it.fileId && r.action === 'deja_lie';
        if (b && !dejaMarquee && (r.action === 'lie' || r.action === 'video_ajoutee' || r.action === 'deja_lie')) {
          await db.collection('bookings').doc(b._id).set({ coachingSync: { statut: 'lie', clientId: rap.client.id, numero: r.numero == null ? null : r.numero, fileId: it.fileId, at: new Date().toISOString() } }, { merge: true });
        }
      }
    } catch (e) {
      ligne.erreur = e.message;
      rapport.erreurs.push(ligne);
    }
  }

  // 3. Réservations passées sans enregistrement
  for (let m = 0; m < reservations.length; m++) {
    const b = reservations[m];
    if (STATUTS_NON_TENUS[String(b.status || '')]) continue;
    if (reservationsLiees[b._id] || (b.coachingSync && b.coachingSync.statut)) continue;
    if (finReservationMs(b) > nowMs) continue;
    if (joursEntre(b.date, aujourdhui) < (Number(cfg.delaiAbandonJours) || DEFAUTS.delaiAbandonJours)) continue;
    const cl = clientDeReservation(b, clients);
    let statut = 'aucun_enregistrement';
    if (cl) {
      const fs = await db.collection('clients').doc(cl.id).get();
      const dansFiche = fs.exists && seancesDe(fs.data() || {}).some(function (x) { return x.s.date === b.date && (x.s.driveUrl || x.s.visioUrl); });
      if (dansFiche) statut = 'deja_dans_la_fiche';
    }
    if (statut === 'deja_dans_la_fiche') rapport.reservations.dejaDansLaFiche++;
    else rapport.reservations.sansEnregistrement.push({ reservation: b._id, date: b.date, heure: b.time || null, coach: b.personName || null, client: cl ? cl.nom : (b.clientNom || null) });
    if (!dry) await db.collection('bookings').doc(b._id).set({ coachingSync: { statut: statut, clientId: cl ? cl.id : null, at: new Date().toISOString() } }, { merge: true });
  }

  // 4. Aval : email, Academy, copilote, workbooks
  if (!dry) {
    const snapA = await db.collection(TRACE).where('avalAFaire', '==', true).limit(50).get();
    let n = 0;
    for (let q = 0; q < snapA.docs.length; q++) {
      if (n >= (Number(cfg.maxAval) || DEFAUTS.maxAval) || Date.now() - t0 > BUDGET_TOTAL_MS) { rapport.avalRestant = snapA.docs.length - q; break; }
      const d = snapA.docs[q];
      const t = d.data() || {};
      try {
        const r = await traiterAval(d.ref, t, cfg);
        rapport.aval.push({ client: t.clientNom, seance: t.numero, resultat: r });
      } catch (e) {
        rapport.erreurs.push({ fichier: t.titre, erreur: 'aval: ' + e.message });
      }
      n++;
    }
  } else {
    rapport.avalPrevu = rapport.lies.length + rapport.videosAjoutees.length;
  }

  rapport.dureeMs = Date.now() - t0;
  return rapport;
}

module.exports = {
  executer: executer,
  chargerConfig: chargerConfig,
  parisHeure: parisHeure,
  CFG_PATH: CFG_PATH,
  DEFAUTS: DEFAUTS,
  // exposés pour les tests
  _appliquer: appliquer,
  _choisirSeance: choisirSeance,
  _rapprocher: rapprocher,
};
