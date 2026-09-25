// ============================================================================
// api/booking-attribution.js — ATTRIBUTION D'UN RDV PRIS DEPUIS UNE VSL
// ----------------------------------------------------------------------------
// Contexte (23/09/2026) : les tunnels Élite / Business passent d'une page
// d'opt-in system.io (lead créé par Make → /api/lead-optin) à une VSL avec
// prise de RDV directe. Plus d'opt-in = plus de lead « à l'entrée ». Le
// premier et unique acte du prospect est le RDV, créé par booking.html.
//
// Sans cet endpoint, la Cloud Function onBookingCreated crée la fiche lead
// avec `utm: 'Booking direct'` — sans créative, sans campagne, sans page ni
// variante. L'axe Créative du funnel se viderait et l'A/B test des deux VSL
// serait impossible à lire.
//
// Endpoint public appelé par booking.html JUSTE AVANT l'écriture du RDV,
// uniquement quand la page porte une provenance (paramètres `lp` / `v`
// posés par la VSL, ou UTM). Il retrouve ou crée la fiche lead, y pose
// l'attribution structurée et la provenance, puis renvoie le `leadId` que
// booking.html inscrit sur le RDV : la Cloud Function prend alors sa branche
// « lead existant » et n'écrase rien.
//
// URL  : POST https://team.alteore.com/api/booking-attribution
// Auth : aucune — endpoint public (visiteur anonyme du booking)
//
// Body (JSON) :
//   {
//     leadId      : "<id>",                 // optionnel (?leadId= de l'URL)
//     prenom, nom, email, telephone, secteur, message,
//     typeId      : "call_strat_phenix_all",
//     typeLabel   : "Diagnostic offert",
//     landing     : { page: "vsl_elite", variant: "b", pageUrl: "https://…" },
//     attribution : { utm_source, utm_medium, utm_campaign, utm_content,
//                     utm_term, ad_id, adset_id, campaign_id, fbclid }
//   }
//
// Réponse 200 :
//   { ok:true, attributed:true,  leadId, created:bool }
//   { ok:true, attributed:false, reason:"…" }              → rien à faire
//
// CE QUI EST ÉCRIT SUR LA FICHE
// -----------------------------
//   attributionFirst — PREMIER touch, jamais réécrit s'il porte déjà un signal
//   attributionLast  — rafraîchi à chaque passage porteur d'UTM
//   landingFirst     — première page / variante vue, jamais réécrite
//   landingLast      — dernière page / variante
//   utm              — posé seulement s'il est vide (Leads Live, CRM, export)
// Aucun stage / status / assignedTo / setter n'est touché : la Cloud
// Function fait évoluer le pipeline, ce fichier ne fait qu'attribuer.
//
// Fail-open : toute erreur → booking.html crée le RDV quand même, la Cloud
// Function crée la fiche `bk_<bookingId>` comme avant.
// ============================================================================

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const Lookup = require('./_leadLookup');
// Parsing d'attribution : implémentation UNIQUE, partagée avec le funnel,
// lead-optin et alteoform-submit.
const Core = require('../funnel-core.js');
// Pages des tunnels hébergés (`<tunnel>__<etape>`) : registre en cache.
const Reg = require('./_tunnelRegistry');

const str = Lookup.str;

// Pages de provenance reconnues (même liste que api/page-view.js, côté VSL).
// Les pages de tunnel s'y ajoutent dynamiquement (voir buildLanding).
const ALLOWED_PAGES = { vsl_elite: 1, vsl_business: 1, elite: 1, business: 1 };

function cleanSlug(v, max) {
  return String(v || '').toLowerCase().trim().replace(/[^a-z0-9_-]/g, '').slice(0, max || 40);
}

async function buildLanding(body) {
  const src = body && typeof body.landing === 'object' ? body.landing : null;
  if (!src) return null;
  const page = cleanSlug(src.page, 90);
  if (!page) return null;
  let tunnelHit = null;
  if (!ALLOWED_PAGES[page]) {
    if (!Reg.isTunnelPageKey(page)) return null;
    try { tunnelHit = await Reg.findByPage(page); } catch (e) { tunnelHit = null; }
    if (!tunnelHit) return null;
  }
  const out = { page: page, variant: cleanSlug(src.variant, 20) || null };
  const url = str(src.pageUrl, 500);
  if (url) out.pageUrl = url;
  if (tunnelHit) {
    out.tunnelId = tunnelHit.tunnel.id;
    out.stepId = tunnelHit.step.id;
    out.label = Reg.pageLabel(tunnelHit.tunnel, tunnelHit.step);
    out.leadType = String((tunnelHit.tunnel.settings && tunnelHit.tunnel.settings.leadType) || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 40);
  }
  out.capturedAt = new Date().toISOString();
  return out;
}

function buildAttribution(body, landing) {
  const attr = Core.parseAttribution(body && typeof body.attribution === 'object' ? body.attribution : null)
    || Core.parseAttribution(landing && landing.pageUrl);
  if (!attr) return null;
  const out = Object.assign({}, attr);
  out.via = 'booking';
  out.capturedAt = new Date().toISOString();
  if (landing && landing.pageUrl) out.landingPage = landing.pageUrl;
  return out;
}

function landingLabel(landing) {
  if (!landing) return '';
  if (landing.label) return landing.label + (landing.variant ? ' · variante ' + landing.variant.toUpperCase() : '');
  const base = landing.page.indexOf('business') >= 0 ? 'VSL Business' : (landing.page.indexOf('elite') >= 0 ? 'VSL Élite' : landing.page);
  return base + (landing.variant ? ' · variante ' + landing.variant.toUpperCase() : '');
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req) || {};
  const leadIdIn = str(body.leadId, 120).replace(/\//g, '');
  const prenom = str(body.prenom, 80);
  const nom = str(body.nom, 80);
  const emailRaw = str(body.email, 200);
  const telRaw = str(body.telephone, 40);
  const secteur = str(body.secteur, 200);
  const message = str(body.message, 2000);
  const typeId = str(body.typeId, 80);
  const typeLabel = str(body.typeLabel, 120) || typeId;

  const landing = await buildLanding(body);
  const attribution = buildAttribution(body, landing);
  // Champs de service du registre : ne partent pas dans bookings.landing.
  const leadTypeFromTunnel = landing ? (landing.leadType || '') : '';
  if (landing) delete landing.leadType;

  if (!landing && !attribution) {
    res.status(200).json({ ok: true, attributed: false, reason: 'no_signal' });
    return;
  }
  if (!emailRaw && !Lookup.phoneNormalized(telRaw) && !leadIdIn) {
    // Aucun moyen d'identifier le prospect : on ne crée pas une fiche fantôme.
    res.status(200).json({ ok: true, attributed: false, reason: 'no_contact' });
    return;
  }

  const FV = admin.firestore.FieldValue;
  const dateFR = Lookup.dateNowFR();
  const label = landingLabel(landing);

  try {
    // ── 1. Fiche existante → attribution posée sans toucher au pipeline ────
    const existing = await Lookup.findLeadDoc(leadIdIn, emailRaw, telRaw);
    if (existing) {
      const d = existing.data() || {};
      const update = { updatedAt: FV.serverTimestamp() };
      if (attribution) {
        update.attributionLast = attribution;
        if (!Core.attrHasSignal(d.attributionFirst)) update.attributionFirst = attribution;
        if (!str(d.utm, 300)) {
          update.utm = attribution.utm_content || attribution.utm_campaign || (label || 'Booking direct');
        }
      }
      if (landing) {
        update.landingLast = landing;
        if (!d.landingFirst || !d.landingFirst.page) update.landingFirst = landing;
        if (!str(d.utm, 300) && !update.utm) update.utm = label;
      }
      if (label) {
        update.timeline_history = FV.arrayUnion({
          text: '🎬 RDV pris depuis la ' + label + (typeLabel ? ' · ' + typeLabel : ''),
          date: dateFR, color: '#22d3ee'
        });
      }
      await existing.ref.update(update);
      res.status(200).json({ ok: true, attributed: true, created: false, leadId: existing.id });
      return;
    }

    // ── 2. Pas de fiche → création, attribution posée à la naissance ───────
    // ID déterministe (contact) : une double soumission retombe sur la même
    // fiche au lieu d'en créer une seconde. La Cloud Function onBookingCreated
    // fera ensuite évoluer stage / status / bookingsHistory (branche « lead
    // existant » grâce au leadId inscrit sur le RDV).
    const emailLc = emailRaw.toLowerCase();
    const phoneNorm = Lookup.phoneNormalized(telRaw);
    const key = emailLc || phoneNorm;
    const newId = 'va_' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
    let fullName = (prenom + ' ' + nom).trim();
    if (!fullName) fullName = emailLc || telRaw || 'Sans nom';

    const lead = {
      nom: fullName,
      email: emailLc,
      telephone: Lookup.toE164(telRaw),
      phoneNormalized: phoneNorm,
      secteur: secteur,
      message: message,
      type: leadTypeFromTunnel || ((landing && landing.page.indexOf('business') >= 0) ? 'business' : 'self_booking'),
      source: 'booking_direct',
      sourceDetail: label || typeLabel,
      utm: (attribution && (attribution.utm_content || attribution.utm_campaign)) || label || 'Booking direct',
      stage: 'lead',
      status: 'nouveau',
      assignedTo: '',
      notesHistory: [],
      timeline_history: [{
        text: '✨ Lead créé à la prise de RDV' + (label ? ' · ' + label : '') + (typeLabel ? ' · ' + typeLabel : ''),
        date: dateFR, color: '#a78bfa'
      }],
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    };
    if (attribution) {
      lead.attributionFirst = attribution;
      lead.attributionLast = attribution;
    }
    if (landing) {
      lead.landingFirst = landing;
      lead.landingLast = landing;
    }

    const ref = db.collection('leads').doc(newId);
    let created = true;
    try {
      await ref.create(lead);
    } catch (e) {
      // ALREADY_EXISTS (code 6) : double soumission — la fiche est déjà là.
      if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) created = false;
      else throw e;
    }

    res.status(200).json({ ok: true, attributed: true, created: created, leadId: newId });
  } catch (e) {
    console.error('[booking-attribution] unexpected error:', e);
    // Fail-open : booking.html crée le RDV quand même.
    res.status(200).json({ ok: true, attributed: false, reason: 'internal_error' });
  }
};
