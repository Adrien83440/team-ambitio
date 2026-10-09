// ============================================================================
// api/_leadRouting.js — RÉPARTITION DES LEADS (09/10/2026)
// ----------------------------------------------------------------------------
// Règles réglées par les admins (carte « 🎯 Répartition des leads », page
// Équipe Sales) dans _config/lead_routing :
//   {
//     leads:       { mode: 'round_robin' | 'single' | 'weighted',
//                    members: [slug], single: slug, weights: { slug: % } },
//     selfBooking: { mode: 'round_robin' | 'single', members: [slug], single: slug },
//     updatedAt, updatedBy
//   }
// • round_robin : à tour de rôle, parts égales, entre les membres cochés ;
// • single      : 100 % à une personne ;
// • weighted    : pourcentages (total 100) — répartition PONDÉRÉE
//                 DÉTERMINISTE (« smooth weighted round-robin ») : 70/30 sur
//                 10 leads donne exactement 7 et 3, intercalés.
// Un membre désactivé / archivé / parti est sauté, sa part redistribuée au
// prorata. État de rotation : _meta/lead_routing_state.{leads|selfBooking}.
// Ré-opt-in : un lead DÉJÀ attribué garde sa personne (continuité).
//
// Sans règle enregistrée → comportement historique : round-robin égal entre
// les membres `eligibleForLeads` (_meta/roundrobin) ; self-bookings au porteur
// du drapeau `selfBookingOwner`.
//
// MIROIR : Functions/index.js (_lr*) applique la même logique côté Cloud
// Function (onNewLead, onBookingCreated). Toute modification ici doit y être
// reportée.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');

const DEPARTED = { guillaumes: 1 };

async function roster() {
  const s = await db.collection('_meta').doc('team_members').get();
  const raw = s.exists ? (s.data() || {}).members : null;
  const arr = Array.isArray(raw) ? raw : Object.values(raw || {});
  return arr.filter(function (m) { return m && m.slug; });
}

function isActive(m) { return m && m.active !== false && !m.archivedAt && !DEPARTED[m.slug]; }

async function loadConfig() {
  const s = await db.collection('_config').doc('lead_routing').get();
  return s.exists ? (s.data() || {}) : {};
}

// Les fiches nées d'un RDV pris par le prospect lui-même (même règle que
// isSelfBookingBornLead() de sales-leads.html).
function isSelfBorn(l) {
  if (!l) return false;
  if (l.stage === 'rdv_self_booking' || l.status === 'rdv_self_booking') return true;
  return l.source === 'booking_direct' || l.source === 'forms_self_booking';
}

/** Candidats { slug: poids } d'une règle, membres inactifs exclus. */
function candidates(rule, members) {
  const bySlug = {};
  members.forEach(function (m) { bySlug[m.slug] = m; });
  const out = {};
  if (!rule || !rule.mode) return out;
  if (rule.mode === 'single') {
    if (rule.single && isActive(bySlug[rule.single])) out[rule.single] = 1;
  } else if (rule.mode === 'weighted') {
    Object.keys(rule.weights || {}).forEach(function (slug) {
      const w = Number(rule.weights[slug]) || 0;
      if (w > 0 && isActive(bySlug[slug])) out[slug] = w;
    });
  } else {
    (rule.members || []).forEach(function (slug) { if (isActive(bySlug[slug])) out[slug] = 1; });
  }
  return out;
}

/** Smooth weighted round-robin : renvoie [choisi, nouvel état]. */
function swrr(weights, current) {
  const slugs = Object.keys(weights).sort();
  const total = slugs.reduce(function (s, k) { return s + weights[k]; }, 0);
  const cur = {};
  let best = null;
  slugs.forEach(function (k) {
    cur[k] = (Number(current && current[k]) || 0) + weights[k];
    if (best === null || cur[k] > cur[best]) best = k;
  });
  cur[best] -= total;
  return [best, cur];
}

/**
 * Attribue un lead NON attribué selon les règles, en UNE transaction (lecture
 * du lead + état de rotation + écritures) : plusieurs onglets / la Cloud
 * Function peuvent demander en même temps sans doubler la rotation. Ne touche
 * jamais un lead déjà attribué (continuité commerciale) ni une fiche fusionnée.
 * @returns {Promise<{assignedTo, via, already?}|null>}
 */
async function assignLead(leadId) {
  if (!leadId) return null;
  const [cfg, members] = await Promise.all([loadConfig(), roster()]);
  const leadRef = db.collection('leads').doc(leadId);
  return db.runTransaction(async function (tx) {
    const ls = await tx.get(leadRef);
    if (!ls.exists) return null;
    const l = ls.data() || {};
    if (l._merged) return null;
    if (l.assignedTo) return { assignedTo: l.assignedTo, already: true };
    const kind = isSelfBorn(l) ? 'selfBooking' : 'leads';
    const weights = candidates(cfg[kind], members);
    const slugs = Object.keys(weights);
    let slug = null, via = 'routing:' + kind;

    if (slugs.length === 1) {
      slug = slugs[0];
    } else if (slugs.length > 1) {
      const stRef = db.collection('_meta').doc('lead_routing_state');
      const st = (await tx.get(stRef)).data() || {};
      const r = swrr(weights, (st[kind] || {}).current);
      slug = r[0];
      const patch = {};
      patch[kind] = { current: r[1], lastAssigned: slug, updatedAt: Date.now() };
      tx.set(stRef, patch, { merge: true });
    } else if (kind === 'selfBooking') {
      // Repli historique : porteur du drapeau selfBookingOwner.
      const owner = members.find(function (m) { return m.selfBookingOwner === true && isActive(m); });
      if (owner) { slug = owner.slug; via = 'self_booking_owner'; }
    } else {
      // Repli historique : round-robin entre membres éligibles (_meta/roundrobin).
      const pool = members.filter(function (m) { return isActive(m) && m.eligibleForLeads === true; }).map(function (m) { return m.slug; });
      if (pool.length === 1) { slug = pool[0]; via = 'roundrobin'; }
      else if (pool.length > 1) {
        const rrRef = db.collection('_meta').doc('roundrobin');
        const last = ((await tx.get(rrRef)).data() || {}).lastAssigned || null;
        slug = pool[(pool.indexOf(last) + 1) % pool.length];
        via = 'roundrobin';
        tx.set(rrRef, { lastAssigned: slug }, { merge: true });
      }
    }
    if (!slug) return null;
    tx.update(leadRef, {
      assignedTo: slug,
      assignedVia: via,
      assignedAt: admin.firestore.FieldValue.serverTimestamp(),
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: '📥 Attribution automatique : ' + slug + (kind === 'selfBooking' ? ' (self-booking)' : ''),
        date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }), color: '#22d3ee',
      }),
    });
    return { assignedTo: slug, via: via };
  });
}

module.exports = { roster: roster, isActive: isActive, loadConfig: loadConfig, isSelfBorn: isSelfBorn, candidates: candidates, swrr: swrr, assignLead: assignLead, DEPARTED: DEPARTED };
