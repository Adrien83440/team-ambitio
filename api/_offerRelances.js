// ============================================================================
// api/_offerRelances.js — RELANCES D'OFFRES (26/11/2026)
// ----------------------------------------------------------------------------
// Module « Relances d'offres » (sales-relances-offres.html), servi par les
// actions offers / offer_draft / offer_set de api/ai-followup.js.
//
// Qui entre (règle Adrien du 26/11/2026) :
//   - un RDV de vente « non closé » (outcome 'non_close') ;
//   - une offre faite (outcome 'offre') depuis PLUS DE 7 JOURS sans retour.
//   Une offre de moins de 7 jours est affichée « trop récente », sans message.
//   Sortent seuls : devenu client, a répondu depuis le RDV, a repris RDV,
//   fiche fusionnée / poubelle / faux numéro, contact bloqué.
//   Un prospect = une carte : son RDV non closé le plus récent.
//
// ENVOI — uniquement au clic « Envoyer » d'un membre de l'équipe (action
// offer_send), jamais automatique, jamais groupé. Et seulement si
// _config/offer_relances.sendEnabled === true ; tant que ce drapeau est
// absent ou faux, seul un prospect listé dans testLeadIds (fiche de test)
// peut recevoir un message. E-mail d'abord (strategie@, réponses captées par
// gmail-inbound-sync), SMS ensuite (Twilio).
// Garde-fous avant chaque envoi : mis de côté, devenu client, contact bloqué,
// STOP SMS, plafond (maxSends, 3) et écart minimal (gapDays, 5 jours) — les
// relances déjà parties de l'ancien moteur (ai_followups) comptent.
//
// _config/offer_relances : { sendEnabled, testLeadIds[], minDays, gapDays,
//   maxSends, callTask (rappel d'appel le lendemain, vrai par défaut),
//   replaceLegacy (coupe la création de séquences de l'ancien cron), prompt }
//
// Données : offer_relances/{bookingId} (Admin SDK seul, pas de règle Firestore)
//   { bookingId, leadId, category, categoryBy, reason, excluded:{by,byName,at,
//     motif}|null, draft:{emailSubject, emailBody, sms, ficheVide, generatedAt,
//     model, editedAt, editedBy}|null, sends:[{at, by, byName, email, sms,
//     emailSubject, emailBody, smsText, smsSid, smsError}], sentCount,
//     lastSentAt, firstSentAt, closerUid, closerName, prospectName, updatedAt }
//   Les brouillons restent HORS de la fiche lead (limite 1 Mo).
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { callClaude, cap, tsToMs } = require('./_ai');
const { loadLeadBundle, bundleToText } = require('./_aiLeadContext');
const { estBloque } = require('./_blockedContacts');
const { sendLeadEmail } = require('./_leadEmail');
const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
const { toE164 } = require('./_leadLookup');

const COL = 'offer_relances';
const OUTCOMES = ['offre', 'non_close'];
const DEFAULT_MIN_DAYS = 7;      // offre : délai avant relance (_config/offer_relances.minDays)
const DEFAULT_WINDOW_DAYS = 60;  // profondeur de la liste
const MAX_ITEMS = 300;
const DEFAULT_GAP_DAYS = 5;      // écart minimal entre deux relances
const DEFAULT_MAX_SENDS = 3;     // relances au total par prospect
// Jamais dans un message, même retapé à la main (règles de contenu Adrien).
const RE_INTERDIT = /(titan|garantie\s+(de\s+)?30|30\s*jours\s+(satisfait|rembours))/i;

const CATEGORIES = {
  a_relancer: 'À relancer',
  rappel_convenu: 'Rappel convenu',
  trop_recent: 'Trop récent',
  de_cote: 'Laissé de côté',
};

const RE_RAPPEL = /(rappel|rappeler|recontact|reprendre contact|revenir vers|refaire un point|janvier|f[ée]vrier|\bmars\b|avril|\bmai\b|\bjuin\b|juillet|ao[uû]t|septembre|octobre|novembre|d[ée]cembre|apr[èe]s les f[êe]tes|apr[èe]s la saison|fin de saison|d[ée]but d['’ ]ann[ée]e|mois prochain|rentr[ée]e)/i;
const RE_SENSIBLE = /(d[ée]c[èe]s|d[ée]c[ée]d|deuil|maladie|malade|hospitalis|h[ôo]pital|cancer|op[ée]ration|accident|divorce|s[ée]paration|liquidation|redressement|sauvegarde|tribunal|proc[èe]s|burn[- ]?out|d[ée]pression)/i;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['categorie', 'raison', 'ficheVide', 'emailSubject', 'emailBody', 'sms'],
  properties: {
    categorie: { type: 'string', enum: ['a_relancer', 'rappel_convenu', 'de_cote'] },
    raison: { type: 'string', description: 'Une phrase, pour le closer : pourquoi cette catégorie' },
    ficheVide: { type: 'boolean', description: 'true si la note du RDV manque ou ne dit rien d\'exploitable' },
    emailSubject: { type: 'string', description: 'Objet court et concret. Vide si categorie = de_cote' },
    emailBody: { type: 'string', description: '3 à 4 paragraphes brefs séparés par une ligne vide. Vide si categorie = de_cote' },
    sms: { type: 'string', description: '160 caractères si possible, 320 au plus. Vide si categorie = de_cote' },
  },
};

// Prompt par défaut. Surchargé par _config/offer_relances.prompt s'il existe.
const DEFAULT_PROMPT = [
  'Tu prépares la relance d\'un prospect d\'Alteore (accompagnement de dirigeants) après un rendez-vous de vente qui n\'a pas abouti à une signature.',
  '',
  'D\'ABORD, classe le prospect :',
  '- a_relancer : offre faite ou rendez-vous non closé, aucune réponse, aucune prochaine étape datée. Relance directe.',
  '- rappel_convenu : le prospect a demandé du temps et une période de rappel a été évoquée (« début janvier », « après les fêtes », « après la saison »). Le message sert à FIXER UNE DATE précise, sans presser.',
  '- de_cote : la fiche signale une situation personnelle (santé, famille, deuil), une procédure ou une difficulté grave de l\'entreprise, ou le prospect a demandé à ne plus être contacté. Aucun message : laisse emailSubject, emailBody et sms vides. Le closer décidera.',
  'Écris en une phrase pourquoi (champ raison).',
  '',
  'ENSUITE, rédige un e-mail et un SMS :',
  '- Vouvoiement, ton direct et respectueux, phrases courtes. Aucun emoji.',
  '- Signé du prénom du closer, suivi de « équipe Adrien & Emily ».',
  '- Pars de ce que le prospect a dit lui-même : son objectif, son frein, un chiffre qu\'il a donné.',
  '- N\'utilise QUE des faits présents dans le dossier. N\'invente rien. Si le dossier est vide ou ne dit rien d\'exploitable, écris un message ouvert qui demande quelle question lui reste, et mets ficheVide à true.',
  '- Une seule demande par message : répondre avec un créneau, pour un échange de 15 à 20 minutes.',
  '- a_relancer : rappelle la date du rendez-vous, nomme le frein s\'il est connu, propose un échange court, laisse la porte ouverte à un oui comme à un non.',
  '- rappel_convenu : ne presse pas. Propose deux dates précises en semaine (jour et quantième), dans la période évoquée par le prospect, postérieures à la date du jour.',
  '- Rendez-vous non closé (refus exprimé) : prends acte du refus sans le discuter, apporte un élément utile lié à son frein, et demande simplement si la situation a évolué.',
  '',
  'INTERDITS ABSOLUS :',
  '- Aucun prix, aucune fourchette de prix, aucun montant de l\'offre.',
  '- Jamais de garantie 30 jours. Jamais l\'offre Titan.',
  '- Si le chiffre d\'affaires mensuel est inférieur à 20 000 €, évoque « une formule plus adaptée à la taille de votre entreprise », sans jamais nommer la formule.',
  '- Alteore (le logiciel) ne fait pas partie de l\'accompagnement : ne le présente pas comme inclus.',
  '- Ne cite jamais une information de santé, familiale ou judiciaire, même si elle figure dans le dossier.',
  '- Aucune adresse postale, aucun numéro de téléphone de l\'entreprise.',
  '- Aucune promesse de résultat chiffré, aucune fausse urgence, aucune réduction.',
  '',
  'FORMAT :',
  '- E-mail : objet court et concret, puis 3 à 4 paragraphes brefs séparés par une ligne vide, terminé par « Répondez simplement à ce message avec le créneau qui vous arrange. » ou équivalent.',
  '- SMS : 160 caractères au plus si possible, commence par « Bonjour {prénom}, c\'est {prénom du closer} (Adrien & Emily). », et renvoie vers l\'e-mail pour répondre.',
].join('\n');

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function shiftDate(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days, 12)).toISOString().slice(0, 10);
}
function frDay(dateStr) {
  if (!dateStr) return '';
  const p = String(dateStr).split('-').map(Number);
  if (p.length < 3 || !p[0]) return String(dateStr);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2], 12)).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
function prospectName(b, l) {
  const p = b.prospect || {};
  const n = ((p.prenom || '') + ' ' + (p.nom || '')).trim();
  if (n) return n;
  const ln = ((l && (l.prenom || l.firstName) || '') + ' ' + (l && (l.nom || l.lastName) || '')).trim();
  return ln || p.email || '?';
}
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }

// Même règle que api/lead-reply-watch.js.
function isClient(l) {
  return l.isClient === true || l.status === 'client' || !!l.clientSince ||
    String(l.stage || '').indexOf('closed_won') === 0;
}
function isInbound(dir) { const d = String(dir || '').toLowerCase(); return d === 'inbound' || d === 'entrant' || d === 'in'; }

function numOr(v, def, min, max) {
  const n = Number(v);
  return v != null && v !== '' && n >= min && n <= max ? n : def;
}

async function loadConfig() {
  let c = {};
  try {
    const s = await db.collection('_config').doc('offer_relances').get();
    c = s.exists ? (s.data() || {}) : {};
  } catch (e) { c = {}; }
  return {
    minDays: numOr(c.minDays, DEFAULT_MIN_DAYS, 0, 60),
    gapDays: numOr(c.gapDays, DEFAULT_GAP_DAYS, 0, 60),
    maxSends: numOr(c.maxSends, DEFAULT_MAX_SENDS, 1, 10),
    sendEnabled: c.sendEnabled === true,
    testLeadIds: Array.isArray(c.testLeadIds) ? c.testLeadIds.map(String) : [],
    callTask: c.callTask !== false,
    replaceLegacy: c.replaceLegacy === true,
    prompt: String(c.prompt || '').trim() || DEFAULT_PROMPT,
  };
}

// Relances déjà parties : ce module + l'ancien moteur (ai_followups).
function sendHistory(state, legacy) {
  const mine = (state && Array.isArray(state.sends)) ? state.sends : [];
  const old = ((legacy && legacy.steps) || []).filter(function (x) { return x.status === 'sent'; });
  const times = mine.map(function (x) { return x.at || 0; }).concat(old.map(function (x) { return x.sentAt || 0; }));
  return { count: times.length, last: times.length ? Math.max.apply(null, times) : 0, moduleCount: mine.length };
}

// Closer du RDV : booking_config/{personId}.firebaseUid, repli outcomeBy.
function closerResolver() {
  const cache = {};
  return async function (b) {
    let uid = null; const name = b.personName || b.expertName || null;
    if (b.personId) {
      if (!(b.personId in cache)) {
        try {
          const p = await db.collection('booking_config').doc(b.personId).get();
          cache[b.personId] = p.exists ? (p.data().firebaseUid || null) : null;
        } catch (e) { cache[b.personId] = null; }
      }
      uid = cache[b.personId];
    }
    if (!uid && b.outcomeBy) return { uid: b.outcomeBy, name: name || b.outcomeByName || null };
    return { uid: uid, name: name };
  };
}

function heuristic(b, l, days, minDays) {
  const note = String(b.outcomeNote || '');
  const hay = note + ' ' + String(l.notes || '').slice(0, 1500);
  const out = { category: 'a_relancer', reason: '', sensible: false };
  if (RE_SENSIBLE.test(hay)) out.sensible = true;
  if (b.outcome === 'offre' && days < minDays) {
    out.category = 'trop_recent';
    out.reason = 'Offre faite il y a ' + days + ' jour' + (days > 1 ? 's' : '') + ' : relance possible à partir de ' + minDays + ' jours.';
    return out;
  }
  const futureFu = (Array.isArray(l.followUps) ? l.followUps : []).some(function (f) {
    return f && !f.done && f.source !== 'offer_relance' && Date.parse(f.dateTime || '') > Date.now();
  });
  if (futureFu) { out.category = 'rappel_convenu'; out.reason = 'Un rappel est déjà programmé sur la fiche.'; }
  else if (RE_RAPPEL.test(note)) { out.category = 'rappel_convenu'; out.reason = 'La note du rendez-vous évoque un rappel ou une période : à transformer en date fixée.'; }
  else if (b.outcome === 'offre') out.reason = 'Offre faite il y a ' + days + ' jours, sans réponse ni prochaine étape datée.';
  else out.reason = 'Rendez-vous non closé il y a ' + days + ' jour' + (days > 1 ? 's' : '') + ', sans échange depuis.';
  if (!note.trim()) out.reason += ' La note du rendez-vous est vide.';
  return out;
}

// ---------------------------------------------------------------------------
//  Liste
// ---------------------------------------------------------------------------

async function listOffers(auth, opts) {
  const cfg = await loadConfig();
  const isAdmin = auth.role === 'admin';
  const all = isAdmin && opts.all !== false;
  const win = Math.min(Math.max(parseInt(opts.days, 10) || DEFAULT_WINDOW_DAYS, 7), 365);
  const today = parisDate(Date.now());
  const from = shiftDate(today, -win);

  // Une seule inégalité (date) : pas d'index composite. L'issue est filtrée ici.
  // (requête unique : sert aussi à repérer un RDV plus récent du même prospect)
  const fut = await db.collection('bookings').where('date', '>=', from).get();
  const byLead = {};
  const bkByLead = {};
  fut.forEach(function (d) {
    const b = d.data() || {};
    if (b.leadId) (bkByLead[b.leadId] = bkByLead[b.leadId] || []).push({ id: d.id, b: b });
    if (OUTCOMES.indexOf(b.outcome) < 0 || !b.leadId || b.isCoaching === true) return;
    if (String(b.date || '') > today) return;
    const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || 0;
    const cur = byLead[b.leadId];
    if (!cur || at > cur.at) byLead[b.leadId] = { id: d.id, b: b, at: at };
  });

  // Un RDV plus récent (close, nouveau RDV à venir…) fait sortir le prospect.
  const later = {};
  fut.forEach(function (d) {
    const x = d.data() || {};
    if (!x.leadId || !byLead[x.leadId] || d.id === byLead[x.leadId].id) return;
    if (x.status === 'cancelled') return;
    const ref = byLead[x.leadId].b;
    if (x.outcome === 'close') later[x.leadId] = 'close';
    else if (!x.outcome && String(x.date || '') >= today) later[x.leadId] = later[x.leadId] || 'a_repris_rdv';
    else if (String(x.date || '') > String(ref.date || '') && OUTCOMES.indexOf(x.outcome) < 0 && x.outcome !== 'no_show' && x.outcome !== 'annule' && x.outcome !== 'replanifie') later[x.leadId] = later[x.leadId] || 'rdv_plus_recent';
  });

  const resolve = closerResolver();
  const entries = Object.keys(byLead).map(function (k) { return byLead[k]; });
  const out = [];
  const sortis = { client: 0, a_repondu: 0, a_repris_rdv: 0, fiche: 0, bloque: 0 };

  for (let i = 0; i < entries.length; i += 25) {
    const chunk = entries.slice(i, i + 25);
    const refs = [];
    chunk.forEach(function (e) {
      refs.push(db.collection('leads').doc(e.b.leadId));
      refs.push(db.collection(COL).doc(e.id));
      refs.push(db.collection('ai_followups').doc(e.id));
    });
    const docs = await db.getAll.apply(db, refs);
    for (let j = 0; j < chunk.length; j++) {
      const e = chunk[j], b = e.b;
      const ls = docs[j * 3], st = docs[j * 3 + 1], old = docs[j * 3 + 2];
      if (!ls.exists) { sortis.fiche++; continue; }
      const l = ls.data() || {};
      if (l._merged === true || l.stage === 'poubelle' || l.stage === 'faux_numero') { sortis.fiche++; continue; }
      if (isClient(l) || later[b.leadId] === 'close') { sortis.client++; continue; }
      if (later[b.leadId]) { sortis.a_repris_rdv++; continue; }
      const replied = (Array.isArray(l.communications) ? l.communications : []).some(function (c) {
        return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > e.at;
      });
      if (replied) { sortis.a_repondu++; continue; }

      const closer = await resolve(b);
      if (!all && closer.uid !== auth.uid) continue;

      const p = b.prospect || {};
      const phone = l.telephone || p.telephone || '';
      const email = l.email || p.email || '';
      if (await estBloque({ phone: phone, email: email })) { sortis.bloque++; continue; }

      const days = Math.max(0, Math.floor((Date.now() - e.at) / 86400000));
      const h = heuristic(b, l, days, cfg.minDays);
      const state = st.exists ? (st.data() || {}) : {};
      let category = h.category, reason = h.reason, categoryBy = 'regle';
      if (state.excluded) { category = 'de_cote'; reason = 'Laissé de côté' + (state.excluded.byName ? ' par ' + state.excluded.byName : '') + (state.excluded.motif ? ' : ' + state.excluded.motif : '.'); categoryBy = 'manuel'; }
      else if (h.category !== 'trop_recent' && state.category && CATEGORIES[state.category]) { category = state.category; reason = state.reason || reason; categoryBy = state.categoryBy || 'ia'; }

      const hist = sendHistory(state, old.exists ? old.data() : null);
      const nextAt = hist.last ? hist.last + cfg.gapDays * 86400000 : 0;
      const lastSend = (state.sends || []).length ? state.sends[state.sends.length - 1] : null;
      const an = b.replay && b.replay.analysis;
      out.push({
        bookingId: e.id, leadId: b.leadId, name: prospectName(b, l), entreprise: l.entreprise || l.company || p.entreprise || '',
        outcome: b.outcome, rdvDate: b.date || '', rdvDateFr: frDay(b.date), days: days,
        closerName: closer.name || '—', closerUid: closer.uid || null, mine: closer.uid === auth.uid,
        typeLabel: b.typeLabel || '', note: cap(String(b.outcomeNote || ''), 600),
        freins: an && an.prospect ? (an.prospect.freins || []).slice(0, 3) : [],
        conseil: an ? cap(String(an.conseilRelance || ''), 300) : '',
        category: category, reason: reason, categoryBy: categoryBy, sensible: h.sensible,
        hasEmail: !!email, hasPhone: !!phone, smsStop: l.smsOptedOut === true || l.smsOptOut === true,
        dejaRelance: hist.count, derniereRelanceAt: hist.last, maxSends: cfg.maxSends,
        nextAt: nextAt > Date.now() ? nextAt : 0, plafond: hist.count >= cfg.maxSends,
        dernierEnvoi: lastSend ? { at: lastSend.at, byName: lastSend.byName || null, email: !!lastSend.email, sms: !!lastSend.sms, smsError: lastSend.smsError || null } : null,
        envoiPossible: cfg.sendEnabled || cfg.testLeadIds.indexOf(b.leadId) >= 0,
        draft: state.draft || null,
      });
    }
    if (out.length >= MAX_ITEMS) break;
  }

  const order = { a_relancer: 0, rappel_convenu: 1, trop_recent: 2, de_cote: 3 };
  out.sort(function (a, b) { return (order[a.category] - order[b.category]) || (b.days - a.days); });
  const counts = { a_relancer: 0, rappel_convenu: 0, trop_recent: 0, de_cote: 0 };
  out.forEach(function (x) { counts[x.category]++; });
  let stats = null;
  try { stats = await computeStats(auth, all, bkByLead); } catch (e) { console.warn('[offer-relances] stats', e && e.message); }
  return { ok: true, items: out, counts: counts, categories: CATEGORIES, sortis: sortis, isAdmin: isAdmin, all: all,
    minDays: cfg.minDays, gapDays: cfg.gapDays, maxSends: cfg.maxSends, days: win, envoi: cfg.sendEnabled, stats: stats };
}

// ---------------------------------------------------------------------------
//  Mesure : ce que les relances envoyées depuis ce module ont produit
// ---------------------------------------------------------------------------

async function computeStats(auth, all, bkByLead) {
  const st = { prospects: 0, messages: 0, reponses: 0, rdvRepris: 0, ventes: 0 };
  const snap = await db.collection(COL).where('lastSentAt', '>', 0).limit(400).get();
  const rows = [];
  snap.forEach(function (d) {
    const x = d.data() || {};
    if (!all && x.closerUid !== auth.uid) return;
    if (x.leadId) rows.push({ id: d.id, x: x });
  });
  for (let i = 0; i < rows.length; i += 100) {
    const chunk = rows.slice(i, i + 100);
    const docs = await db.getAll.apply(db, chunk.map(function (r) { return db.collection('leads').doc(r.x.leadId); }));
    chunk.forEach(function (r, j) {
      const x = r.x, first = x.firstSentAt || x.lastSentAt;
      st.prospects++;
      (x.sends || []).forEach(function (s) { st.messages += (s.email ? 1 : 0) + (s.sms && !s.smsError ? 1 : 0); });
      const l = docs[j].exists ? (docs[j].data() || {}) : {};
      if ((Array.isArray(l.communications) ? l.communications : []).some(function (c) {
        return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > first;
      })) st.reponses++;
      if (isClient(l)) st.ventes++;
      if ((bkByLead[x.leadId] || []).some(function (k) {
        return k.id !== r.id && k.b.status !== 'cancelled' && tsToMs(k.b.createdAt) > first;
      })) st.rdvRepris++;
    });
  }
  return st;
}

// ---------------------------------------------------------------------------
//  Droit d'agir sur une carte
// ---------------------------------------------------------------------------

async function loadCard(auth, bookingId) {
  const id = String(bookingId || '');
  if (!id) return { error: 'bad_request', code: 400 };
  const bs = await db.collection('bookings').doc(id).get();
  if (!bs.exists) return { error: 'not_found', code: 404 };
  const b = bs.data() || {};
  if (OUTCOMES.indexOf(b.outcome) < 0 || !b.leadId) return { error: 'not_an_open_offer', code: 409 };
  const closer = await closerResolver()(b);
  if (auth.role !== 'admin' && closer.uid !== auth.uid) return { error: 'not_your_prospect', code: 403 };
  return { id: id, b: b, closer: closer, ref: db.collection(COL).doc(id) };
}

// ---------------------------------------------------------------------------
//  Brouillon IA (à la demande, une carte à la fois)
// ---------------------------------------------------------------------------

async function draftOffer(auth, body) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const b = card.b;
  const cfg = await loadConfig();
  const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || Date.now();
  const days = Math.max(0, Math.floor((Date.now() - at) / 86400000));
  if (b.outcome === 'offre' && days < cfg.minDays) return { error: 'too_recent', code: 409, message: 'Offre trop récente : relance possible à partir de ' + cfg.minDays + ' jours.' };
  const st = await card.ref.get();
  if (st.exists && (st.data() || {}).excluded) return { error: 'excluded', code: 409, message: 'Ce prospect est laissé de côté.' };

  const name = prospectName(b, null);
  const P = [];
  P.push('DATE DU JOUR : ' + frDay(parisDate(Date.now())));
  P.push('CLOSER : ' + (firstName(card.closer.name) || '?') + ' (signe de ce prénom)');
  P.push('PROSPECT : ' + name);
  P.push('RENDEZ-VOUS : ' + (frDay(b.date) || '?') + ' — il y a ' + days + ' jours — issue « ' + (b.outcome === 'offre' ? 'offre faite, en attente de réponse' : 'non closé (refus exprimé)') + ' »');
  P.push('NOTE DU RENDEZ-VOUS : ' + (String(b.outcomeNote || '').trim() ? cap(b.outcomeNote, 1200) : '(vide)'));
  const an = b.replay && b.replay.analysis;
  if (an) {
    P.push('ANALYSE DE L\'ENREGISTREMENT DU CLOSING :');
    if (an.verdict) P.push('- Verdict : ' + an.verdict);
    if (an.prospect) {
      if ((an.prospect.douleurs || []).length) P.push('- Douleurs : ' + an.prospect.douleurs.join(' | '));
      if ((an.prospect.motivations || []).length) P.push('- Motivations : ' + an.prospect.motivations.join(' | '));
      if ((an.prospect.freins || []).length) P.push('- Freins : ' + an.prospect.freins.join(' | '));
    }
    (an.objections || []).slice(0, 5).forEach(function (o) { P.push('- Objection : « ' + cap(o.quote, 200) + ' »'); });
    if (an.conseilRelance) P.push('- Conseil de relance : ' + an.conseilRelance);
  }
  const bundle = await loadLeadBundle(b.leadId);
  if (bundle) { P.push(''); P.push(bundleToText(bundle, { maxCalls: 2, transcriptChars: 3000 })); }
  const instr = String(body.instruction || '').trim().slice(0, 500);
  if (instr) { P.push(''); P.push('CONSIGNE DU CLOSER POUR CETTE VERSION : ' + instr); }

  const r = await callClaude({ task: 'offer_followup', system: cfg.prompt, prompt: P.join('\n'), schema: SCHEMA, uid: auth.uid, ref: 'offer:' + card.id, source: 'offer_relances' });
  if (!r.ok) throw new Error(r.error);
  const j = r.json || {};
  const draft = {
    emailSubject: String(j.emailSubject || '').trim().slice(0, 200),
    emailBody: String(j.emailBody || '').trim().slice(0, 6000),
    sms: String(j.sms || '').trim().slice(0, 640),
    ficheVide: j.ficheVide === true, generatedAt: Date.now(), model: r.model || null, instruction: instr || null,
  };
  const patch = {
    bookingId: card.id, leadId: b.leadId, category: j.categorie, categoryBy: 'ia',
    reason: String(j.raison || '').trim().slice(0, 400), draft: draft, updatedAt: Date.now(),
  };
  await card.ref.set(patch, { merge: true });
  return { ok: true, category: patch.category, reason: patch.reason, categoryBy: 'ia', draft: draft };
}

// ---------------------------------------------------------------------------
//  Réglages manuels d'une carte : catégorie, mise de côté, texte modifié
// ---------------------------------------------------------------------------

async function setOffer(auth, body, me) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const patch = { bookingId: card.id, leadId: card.b.leadId, updatedAt: Date.now() };
  if (body.exclude === true) {
    const motif = String(body.motif || '').trim().slice(0, 300);
    if (!motif) return { error: 'motif_required', code: 400, message: 'Indiquez le motif.' };
    patch.excluded = { by: auth.uid, byName: (me && me.name) || auth.email || null, at: Date.now(), motif: motif };
  } else if (body.exclude === false) {
    patch.excluded = null;
  }
  if (body.category) {
    if (body.category !== 'a_relancer' && body.category !== 'rappel_convenu') return { error: 'bad_category', code: 400 };
    patch.category = body.category; patch.categoryBy = 'manuel';
    patch.reason = 'Classé à la main' + ((me && me.name) ? ' par ' + me.name : '') + '.';
  }
  if (body.draft && typeof body.draft === 'object') {
    const st = await card.ref.get();
    const cur = (st.exists && (st.data() || {}).draft) || {};
    patch.draft = Object.assign({}, cur, {
      emailSubject: String(body.draft.emailSubject || '').trim().slice(0, 200),
      emailBody: String(body.draft.emailBody || '').trim().slice(0, 6000),
      sms: String(body.draft.sms || '').trim().slice(0, 640),
      editedAt: Date.now(), editedBy: auth.uid,
    });
  }
  await card.ref.set(patch, { merge: true });
  return { ok: true };
}

// ---------------------------------------------------------------------------
//  Envoi (au clic uniquement)
// ---------------------------------------------------------------------------

function fail(error, code, message) { return { error: error, code: code, message: message }; }

// Demain 10 h, heure de Paris, au format des rappels de Leads Live.
function tomorrowAt10() { return shiftDate(parisDate(Date.now()), 1) + 'T10:00:00'; }

async function sendOffer(auth, body, me) {
  const card = await loadCard(auth, body.bookingId);
  if (card.error) return card;
  const b = card.b, leadId = b.leadId;
  const wantEmail = body.email === true, wantSms = body.sms === true;
  if (!wantEmail && !wantSms) return fail('no_channel', 400, 'Choisissez l\'e-mail, le SMS ou les deux.');

  const cfg = await loadConfig();
  if (!cfg.sendEnabled && cfg.testLeadIds.indexOf(leadId) < 0) {
    return fail('send_disabled', 409, 'L\'envoi n\'est pas encore activé (hors fiche de test).');
  }
  const got = await db.getAll(db.collection('leads').doc(leadId), card.ref, db.collection('ai_followups').doc(card.id));
  if (!got[0].exists) return fail('lead_not_found', 404, 'Fiche prospect introuvable.');
  const lead = got[0].data() || {};
  const state = got[1].exists ? (got[1].data() || {}) : {};

  if (state.excluded) return fail('excluded', 409, 'Ce prospect est laissé de côté.');
  if (lead._merged === true) return fail('merged', 409, 'Cette fiche a été fusionnée.');
  if (isClient(lead)) return fail('client', 409, 'Ce prospect est devenu client.');
  const at = tsToMs(b.outcomeAt) || Date.parse((b.date || '') + 'T12:00:00Z') || Date.now();
  if (b.outcome === 'offre' && Date.now() - at < cfg.minDays * 86400000) return fail('too_recent', 409, 'Offre trop récente : relance possible à partir de ' + cfg.minDays + ' jours.');
  if ((Array.isArray(lead.communications) ? lead.communications : []).some(function (c) {
    return c && isInbound(c.direction) && Date.parse(c.date || c.createdAt || '') > at;
  })) return fail('replied', 409, 'Ce prospect a écrit depuis le rendez-vous : répondez-lui depuis sa fiche.');

  const hist = sendHistory(state, got[2].exists ? got[2].data() : null);
  if (hist.count >= cfg.maxSends) return fail('cap', 409, 'Déjà ' + hist.count + ' relances envoyées : plafond atteint.');
  if (hist.last && Date.now() - hist.last < cfg.gapDays * 86400000) {
    return fail('gap', 409, 'Dernière relance le ' + new Date(hist.last).toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }) + ' : ' + cfg.gapDays + ' jours minimum entre deux relances.');
  }

  const phoneRaw = lead.telephone || (b.prospect || {}).telephone || '';
  const email = String(lead.email || '').trim();
  if (await estBloque({ phone: phoneRaw, email: email })) return fail('blocked', 409, 'Ce contact est bloqué.');

  const d = state.draft || {};
  const subject = String(body.emailSubject != null ? body.emailSubject : d.emailSubject || '').trim().slice(0, 200);
  const mailBody = String(body.emailBody != null ? body.emailBody : d.emailBody || '').trim().slice(0, 6000);
  const smsText = String(body.smsText != null ? body.smsText : d.sms || '').trim().slice(0, 640);
  if (wantEmail && (!subject || !mailBody)) return fail('empty_email', 400, 'L\'objet et le texte de l\'e-mail sont obligatoires.');
  if (wantEmail && email.indexOf('@') < 0) return fail('no_email', 409, 'Ce prospect n\'a pas d\'e-mail.');
  if (wantSms && !smsText) return fail('empty_sms', 400, 'Le SMS est vide.');
  if (RE_INTERDIT.test((wantEmail ? subject + ' ' + mailBody : '') + ' ' + (wantSms ? smsText : ''))) {
    return fail('forbidden_content', 400, 'Le message mentionne l\'offre Titan ou une garantie 30 jours : à retirer.');
  }
  let toNumber = null, smsFrom = null;
  if (wantSms) {
    if (lead.smsOptedOut === true || lead.smsOptOut === true) return fail('sms_stop', 409, 'Ce prospect a demandé l\'arrêt des SMS.');
    toNumber = toE164(phoneRaw);
    if (!/^\+\d{8,15}$/.test(toNumber)) return fail('no_phone', 409, 'Numéro du prospect manquant ou invalide.');
    const creds = await getTwilioCreds();
    smsFrom = creds.smsFromNumber || creds.smsFrom || null;
    if (!smsFrom) return fail('sms_not_configured', 500, 'Numéro d\'envoi SMS non configuré.');
  }

  // Verrou anti double clic : un seul envoi en cours par carte.
  const locked = await db.runTransaction(async function (tx) {
    const s = await tx.get(card.ref);
    const cur = s.exists ? (s.data() || {}) : {};
    if (cur.sendingAt && Date.now() - cur.sendingAt < 120000) return false;
    tx.set(card.ref, { bookingId: card.id, leadId: leadId, sendingAt: Date.now() }, { merge: true });
    return true;
  });
  if (!locked) return fail('busy', 409, 'Un envoi est déjà en cours pour ce prospect.');

  const now = Date.now();
  const rec = { at: now, by: auth.uid, byName: (me && me.name) || auth.email || null, email: false, sms: false };
  let firstError = null;
  try {
    if (wantEmail) {
      try {
        await sendLeadEmail(auth, leadId, subject, mailBody, { label: '✉️ Relance d\'offre (e-mail)', flag: 'offerRelance' });
        rec.email = true; rec.emailSubject = subject; rec.emailBody = mailBody;
      } catch (e) { firstError = 'E-mail non envoyé : ' + (e && e.message ? e.message : e); }
    }
    // Pas de SMS « je viens de vous envoyer un e-mail » si l'e-mail a échoué.
    if (wantSms && !firstError) {
      try {
        const client = await getTwilioClient();
        const msg = await client.messages.create({ from: smsFrom, to: toNumber, body: smsText });
        const nowIso = new Date().toISOString();
        await db.collection('leads').doc(leadId).update({
          communications: admin.firestore.FieldValue.arrayUnion({
            type: 'sms', direction: 'outbound', content: smsText, source: 'twilio-sms', date: nowIso, createdAt: nowIso,
            ownerUid: auth.uid, ownerName: rec.byName, ownerSlug: (me && me.slug) || null,
            providerMessageSid: msg.sid, fromNumber: smsFrom, toNumber: toNumber, offerRelance: true,
          }),
          timeline_history: admin.firestore.FieldValue.arrayUnion({
            text: '💬 Relance d\'offre (SMS) — ' + smsText.substring(0, 100),
            date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#60a5fa',
          }),
          lastContactAt: admin.firestore.FieldValue.serverTimestamp(), lastContactType: 'sms',
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        rec.sms = true; rec.smsText = smsText; rec.smsSid = msg.sid;
      } catch (e) { rec.smsError = String(e && e.message ? e.message : e).slice(0, 300); }
    }
  } finally {
    // Toujours écrit avant de répondre : trace de l'envoi + levée du verrou.
    const patch = { sendingAt: null, updatedAt: Date.now() };
    if (rec.email || rec.sms) {
      patch.sends = admin.firestore.FieldValue.arrayUnion(rec);
      patch.sentCount = admin.firestore.FieldValue.increment(1);
      patch.lastSentAt = now;
      if (!state.firstSentAt) patch.firstSentAt = now;
      patch.closerUid = card.closer.uid || null;
      patch.closerName = card.closer.name || null;
      patch.prospectName = prospectName(b, lead);
      patch.outcome = b.outcome;
      patch.draft = Object.assign({}, d, { emailSubject: subject || d.emailSubject || '', emailBody: mailBody || d.emailBody || '', sms: smsText || d.sms || '' });
    }
    try { await card.ref.set(patch, { merge: true }); } catch (e) { console.error('[offer-relances] trace envoi', e && e.message); }
  }
  if (!rec.email && !rec.sms) return fail('send_failed', 502, firstError || ('SMS non envoyé : ' + (rec.smsError || 'erreur inconnue')));

  // Rappel d'appel pour le lendemain, visible dans les rappels de la fiche.
  let callTask = null;
  if (cfg.callTask) {
    try {
      callTask = tomorrowAt10();
      await db.collection('leads').doc(leadId).update({
        followUps: admin.firestore.FieldValue.arrayUnion({
          id: now.toString(36) + Math.random().toString(36).substr(2, 4), dateTime: callTask,
          note: 'Appeler : relance d\'offre envoyée la veille, sans réponse', duration: 15, done: false,
          createdBy: 'Relances d\'offres', createdAt: new Date().toISOString(), source: 'offer_relance', bookingId: card.id,
        }),
      });
    } catch (e) { callTask = null; console.warn('[offer-relances] rappel', e && e.message); }
  }
  return { ok: true, email: rec.email, sms: rec.sms, smsError: rec.smsError || null, at: now, callTask: callTask,
    warning: rec.smsError ? 'E-mail envoyé, mais le SMS a échoué : ' + rec.smsError : null };
}

module.exports = { listOffers, draftOffer, setOffer, sendOffer, loadConfig, CATEGORIES, DEFAULT_PROMPT };
