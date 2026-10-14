// ============================================================================
// api/_aide.js — AIDE TEAM : helpers partagés (exclu du routing Vercel)
// ----------------------------------------------------------------------------
// L'« Aide Team » répond aux questions TECHNIQUES des setters / closers (où
// cliquer, comment connecter son agenda, créer un groupe WhatsApp…) à partir
// d'une base de FICHES PRATIQUES. Validé par Adrien le 14/10/2026.
//
// Fiches = fiches de départ du code (api/_aide-fiches.js, rédigées depuis le
// code réel des pages) + documents Firestore aide_articles/{id} :
//   • même id qu'une fiche de départ → la remplace (modifiée dans la page
//     admin), sauf si useSeed:true (retour à la version d'origine) ;
//   • autre id → fiche ajoutée à la main ;
//   • archived:true → retirée de la base (rien n'est jamais supprimé).
// Aucune écriture Firestore n'est nécessaire pour que les fiches de départ
// existent : elles vivent dans le code.
//
// _config/aide : { enabled, dailyLimit, contact, welcome, links:[{key,label,url,note}] }
// Les fiches citent les liens par {{lien:cle}} (remplacé à la lecture).
// ============================================================================

const { db } = require('./_firebaseAdmin');
const SEED = require('./_aide-fiches');

const CATEGORIES = SEED.CATEGORIES;

const DEFAULT_LINKS = [
  { key: 'agenda_strategie', label: 'Agenda Stratégie (lien à ajouter dans son Google Agenda)', url: '', note: '' },
  { key: 'groupe_whatsapp_equipe', label: 'Groupe WhatsApp de l\'équipe Sales', url: '', note: '' },
  { key: 'communaute_whatsapp_clients', label: 'Communauté WhatsApp des clients', url: '', note: '' },
  { key: 'ringover_app', label: 'Application Ringover (téléchargement / connexion)', url: '', note: '' },
  { key: 'canal_closing', label: 'Canal d\'annonce des closings', url: '', note: '' },
];

const DEFAULT_CONFIG = {
  enabled: true,
  dailyLimit: 30,
  contact: 'Vincent ou Adrien',
  welcome: '',
};

const CACHE_MS = 60 * 1000;
let _artCache = null, _artAt = 0;
let _cfgCache = null, _cfgAt = 0;

function invalidate() { _artCache = null; _cfgCache = null; }

async function getConfig(fresh) {
  if (!fresh && _cfgCache && Date.now() - _cfgAt < CACHE_MS) return _cfgCache;
  let d = {};
  try {
    const s = await db.collection('_config').doc('aide').get();
    if (s.exists) d = s.data() || {};
  } catch (e) { console.warn('[_aide] lecture _config/aide impossible', e.message); }
  const cfg = Object.assign({}, DEFAULT_CONFIG, d);
  // Liens : ceux enregistrés gardent leur ordre ; les liens par défaut absents
  // sont ajoutés à la suite (une nouvelle clé du code apparaît d'elle-même).
  const saved = Array.isArray(d.links) ? d.links.filter(function (l) { return l && l.key; }) : [];
  const keys = saved.map(function (l) { return l.key; });
  cfg.links = saved.concat(DEFAULT_LINKS.filter(function (l) { return keys.indexOf(l.key) < 0; }));
  _cfgCache = cfg; _cfgAt = Date.now();
  return cfg;
}

// Fiches fusionnées (code + Firestore), y compris archivées et brouillons :
// le filtrage se fait à l'usage (publishedFor).
async function getAllFiches(fresh) {
  if (!fresh && _artCache && Date.now() - _artAt < CACHE_MS) return _artCache;
  const docs = {};
  try {
    const s = await db.collection('aide_articles').get();
    s.forEach(function (d) { docs[d.id] = d.data() || {}; });
  } catch (e) { console.warn('[_aide] lecture aide_articles impossible', e.message); }

  const out = [];
  SEED.FICHES.forEach(function (f) {
    const o = docs[f.id];
    const base = Object.assign({}, f, { source: 'seed', status: 'published', archived: false });
    if (o && !o.useSeed) {
      out.push(Object.assign(base, pickFiche(o), { source: 'modifiee', updatedAt: o.updatedAt || null, updatedByName: o.updatedByName || null }));
    } else {
      if (o && o.archived) base.archived = true;
      if (o) base.useSeed = true;
      out.push(base);
    }
    delete docs[f.id];
  });
  Object.keys(docs).forEach(function (id) {
    const o = docs[id];
    if (!o.title) return;
    out.push(Object.assign({ id: id, source: 'manuelle' }, pickFiche(o), { updatedAt: o.updatedAt || null, updatedByName: o.updatedByName || null }));
  });
  _artCache = out; _artAt = Date.now();
  return out;
}

function pickFiche(o) {
  return {
    title: String(o.title || ''),
    cat: CATEGORIES.indexOf(o.cat) >= 0 ? o.cat : 'Dépannage',
    body: String(o.body || ''),
    tags: String(o.tags || ''),
    pages: Array.isArray(o.pages) ? o.pages.map(String) : [],
    adminOnly: o.adminOnly === true,
    guide: Array.isArray(o.guide) ? o.guide.filter(function (g) { return g && g.text; }).map(function (g) {
      return { page: String(g.page || ''), sel: String(g.sel || ''), text: String(g.text || '') };
    }) : [],
    images: Array.isArray(o.images) ? o.images.map(String).slice(0, 6) : [],
    status: o.status === 'draft' ? 'draft' : 'published',
    archived: o.archived === true,
  };
}

function publishedFor(fiches, role) {
  return fiches.filter(function (f) {
    if (f.archived || f.status === 'draft') return false;
    if (f.adminOnly && role !== 'admin') return false;
    return true;
  });
}

function linkMap(links) {
  const m = {};
  (links || []).forEach(function (l) { m[l.key] = l; });
  return m;
}

// {{lien:cle}} → URL, ou mention explicite quand le lien n'est pas renseigné
// (le bot sait alors dire « pas encore renseigné » et la question remonte).
function fillLinks(text, links) {
  const m = linkMap(links);
  return String(text || '').replace(/\{\{lien:([a-z0-9_]+)\}\}/gi, function (all, k) {
    const l = m[k];
    if (l && l.url) return l.url;
    return '[lien « ' + (l ? l.label : k) + ' » pas encore renseigné]';
  });
}

function sortFiches(list) {
  return list.slice().sort(function (a, b) {
    const ca = CATEGORIES.indexOf(a.cat), cb = CATEGORIES.indexOf(b.cat);
    if (ca !== cb) return ca - cb;
    return a.id < b.id ? -1 : (a.id > b.id ? 1 : 0);
  });
}

// Base de connaissance envoyée au modèle — DÉTERMINISTE (même entrée → même
// texte, octet pour octet) pour que le cache Anthropic serve.
function knowledgeText(fiches, cfg) {
  const L = [];
  L.push('=== LIENS UTILES (fournis par l\'équipe) ===');
  (cfg.links || []).forEach(function (l) {
    L.push('- ' + l.key + ' — ' + l.label + ' : ' + (l.url ? l.url : '(pas encore renseigné)') + (l.note ? ' — ' + l.note : ''));
  });
  L.push('');
  L.push('=== FICHES PRATIQUES ===');
  sortFiches(fiches).forEach(function (f) {
    L.push('');
    L.push('### [' + f.id + '] ' + f.title);
    L.push('Catégorie : ' + f.cat + (f.pages && f.pages.length ? ' · Pages : ' + f.pages.join(', ') : '') + (f.adminOnly ? ' · RÉSERVÉ AUX ADMINS' : '') +
      (f.guide && f.guide.length ? ' · Guidage « Montre-moi » : ' + f.guide.length + ' étape(s)' : '') +
      (f.images && f.images.length ? ' · ' + f.images.length + ' capture(s) jointe(s)' : ''));
    if (f.tags) L.push('Mots-clés : ' + f.tags);
    L.push(fillLinks(f.body, cfg.links));
  });
  return L.join('\n');
}

// ---------------------------------------------------------------------------
//  Profil de l'utilisateur (diagnostic personnalisé, lecture seule)
// ---------------------------------------------------------------------------

const JOURS = ['lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche'];

async function userProfile(auth) {
  const u = auth.userData || {};
  const P = { uid: auth.uid, role: auth.role, email: auth.email || '', name: u.name || u.displayName || '' };
  const flags = [];
  if (auth.role !== 'admin') {
    flags.push('Paiements : ' + (u.paymentsAccess === true || u.paymentsTrigger === true ? 'oui' : 'non'));
    flags.push('Déclenchement des prélèvements : ' + (u.paymentsTrigger === true ? 'oui' : 'non'));
    flags.push('Signatures : ' + (u.signaturesAccess === true ? 'oui' : 'non'));
    const fa = u.formationsAccess || {};
    const opened = Object.keys(fa).filter(function (k) { return fa[k] === true; });
    flags.push('Formations ouvertes : ' + (opened.length ? opened.join(', ') : 'aucune'));
  } else {
    flags.push('Admin : accès à tous les modules');
  }
  P.flags = flags;

  // Membre d'équipe (_meta/team_members, relié par firebaseUid)
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    const list = Array.isArray(raw) ? raw : (raw && typeof raw === 'object' ? Object.keys(raw).map(function (k) { return Object.assign({ slug: k }, raw[k]); }) : []);
    const m = list.find(function (x) { return x && x.firebaseUid === auth.uid; });
    if (m) {
      P.member = { slug: m.slug, displayName: m.displayName || m.shortName || m.slug, role: m.role || '', active: m.active !== false };
      if (!P.name) P.name = P.member.displayName;
    }
  } catch (e) { /* diagnostic best-effort */ }

  // Fiche expert Booking (booking_config, reliée par firebaseUid)
  try {
    const s = await db.collection('booking_config').where('firebaseUid', '==', auth.uid).limit(2).get();
    if (!s.empty) {
      const d = s.docs[0].data() || {};
      const sc = d.schedule || {};
      const jours = JOURS.filter(function (j) { return Array.isArray(sc[j]) && sc[j].length; }).map(function (j) {
        return j + ' ' + sc[j].map(function (p) { return (p.start || p.s || '?') + '-' + (p.end || p.e || '?'); }).join(' / ');
      });
      let typeLabels = [];
      try {
        const t = await db.collection('booking_config').doc('_types').get();
        const tl = t.exists ? ((t.data() || {}).list || []) : [];
        typeLabels = (d.types || []).map(function (id) { const x = tl.find(function (y) { return y && y.id === id; }); return x ? x.label : id; });
      } catch (e) { typeLabels = d.types || []; }
      P.booking = {
        personId: s.docs[0].id,
        name: d.name || '',
        calendarConnected: d.calendarConnected === true,
        calendarEmail: d.calendarEmail || '',
        meetLink: !!d.meetLink,
        horaires: jours,
        consultations: typeLabels,
        consultationParDefaut: d.defaultTypeId || '',
        exceptions: Array.isArray(d.availabilityRules) ? d.availabilityRules.length : 0,
      };
    }
  } catch (e) { /* best-effort */ }
  return P;
}

function profileText(P, client) {
  const L = [];
  L.push('PROFIL DE LA PERSONNE QUI TE PARLE (lecture seule, pour personnaliser) :');
  L.push('- Prénom / nom : ' + (P.name || '(inconnu)') + ' · rôle applicatif : ' + P.role + (P.member ? ' · rôle équipe : ' + (P.member.role || '?') : ' · compte NON relié à un membre de l\'équipe (_meta/team_members)'));
  L.push('- Accès : ' + P.flags.join(' · '));
  if (P.booking) {
    const b = P.booking;
    L.push('- Fiche Booking : « ' + (b.name || '?') + ' » · Google Agenda ' + (b.calendarConnected ? 'CONNECTÉ (' + (b.calendarEmail || 'email ?') + ')' : 'NON connecté') +
      ' · lien Meet de secours : ' + (b.meetLink ? 'oui' : 'non'));
    L.push('- Horaires Booking (heure de Paris) : ' + (b.horaires.length ? b.horaires.join(' ; ') : 'AUCUN horaire renseigné'));
    L.push('- Consultations attribuées : ' + (b.consultations.length ? b.consultations.join(', ') : 'AUCUNE') + ' · exceptions/absences : ' + b.exceptions);
  } else {
    L.push('- Fiche Booking : AUCUNE fiche expert reliée à ce compte (un admin doit la relier dans Admin → Utilisateurs).');
  }
  if (client) {
    L.push('- Page ouverte : ' + (client.page || '?') + (client.title ? ' (« ' + client.title + ' »)' : ''));
    if (client.tz) L.push('- Fuseau de l\'appareil : ' + client.tz + (client.tz !== 'Europe/Paris' ? ' — DIFFÉRENT de Paris : les heures de Booking et des follow-ups sont en heure de Paris' : ''));
    if (client.mobile) L.push('- Appareil : téléphone / petit écran');
  }
  return L.join('\n');
}

function dayKey(d) {
  return (d || new Date()).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' });
}

module.exports = {
  CATEGORIES: CATEGORIES,
  DEFAULT_LINKS: DEFAULT_LINKS,
  DEFAULT_CONFIG: DEFAULT_CONFIG,
  getConfig: getConfig,
  getAllFiches: getAllFiches,
  publishedFor: publishedFor,
  fillLinks: fillLinks,
  sortFiches: sortFiches,
  knowledgeText: knowledgeText,
  userProfile: userProfile,
  profileText: profileText,
  pickFiche: pickFiche,
  invalidate: invalidate,
  dayKey: dayKey,
  SEED_IDS: SEED.FICHES.map(function (f) { return f.id; }),
};
