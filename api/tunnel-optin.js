// ============================================================================
// api/tunnel-optin.js — OPT-IN D'UNE PAGE DE TUNNEL → FICHE LEADS LIVE
// ----------------------------------------------------------------------------
// Appelé par tunnel-runtime.js quand un visiteur envoie un formulaire
// `data-alteo-optin` sur une page hébergée (api/tunnel-render.js). Remplace
// la chaîne System.io → Make → /api/lead-optin : plus d'intermédiaire, la
// fiche est créée ou réveillée directement, avec la provenance complète.
//
// URL  : POST /api/tunnel-optin      (même origine que la page ; CORS ouvert
//                                     pour une page hébergée ailleurs)
// Auth : aucune — visiteur anonyme. Garde-fous : tunnel + étape doivent
//        exister et être en ligne, contact obligatoire (email valide ou
//        téléphone ≥ 9 chiffres), liste de blocage, pot de miel, champs
//        bornés. Aucun champ de pipeline (stage, assignedTo, _merged…) ne
//        peut être forcé par le payload.
//
// Body (JSON, text/plain) :
//   { t: tunnelId, s: stepId, v: variante,
//     fields : { prenom, nom, email, telephone, secteur, ca, defi, message,
//                website (pot de miel) },
//     extras : [ { name, label, value } ],        // réponses libres
//     attribution : { utm_*, ad_id, … } | null,
//     leadId : "<id>" | "",                        // fiche déjà connue
//     pageUrl, src }
//
// Réponse 200 : { ok:true, action:'created'|'updated'|'blocked', leadId }
//
// CE QUI EST ÉCRIT SUR LA FICHE (même philosophie que api/lead-optin.js,
// validée avec Adrien : Leads Live = état FRAIS du dernier engagement)
//   Fiche EXISTANTE (email, puis téléphone, fiches _merged ignorées) :
//     · état précédent archivé dans engagementHistory[] ;
//     · type / source / sourceDetail / formAnswers rafraîchis ;
//     · stage → lead, status → nouveau (jamais pour un client) ;
//     · lastOptinAt (résurrection Leads Live), timeline orange ;
//     · assignedTo INTOUCHÉ (continuité commerciale) ;
//     · attributionLast rafraîchi, attributionFirst posé s'il manquait ;
//     · landingLast rafraîchi, landingFirst posé s'il manquait.
//   Fiche NEUVE : id déterministe `tn_<sha1 contact>` (double envoi = même
//     fiche), type = réglage du tunnel, source 'tunnel', utm = créative
//     Meta si connue sinon nom du tunnel, formAnswers = réponses (affichées
//     par Leads Live comme celles d'un AlteoForm).
//
// Compteurs : optins +1 dans page_views_daily (étape × variante) et
// tunnel_stats_daily (tunnel, étape, source). Écrits AVANT la réponse.
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const Lookup = require('./_leadLookup');
const Reg = require('./_tunnelRegistry');
const Core = require('../funnel-core.js');

const str = Lookup.str;
const KNOWN_TYPES = { vsl_elite: 1, business: 1, self_booking: 1, webinaire: 1 };

function todayIsoParis() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' });
}
function keyPart(v) { return str(v, 60).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40); }
function sourceKey(src) {
  const s = keyPart(src.utm_source), c = keyPart(src.utm_campaign), n = keyPart(src.utm_content);
  if (!s && !c && !n) return 'direct';
  return (s || '-') + '~' + (c || '-') + '~' + (n || '-');
}

/* Liste de blocage (api/lead-block.js) — même lecture que lead-optin.js. */
async function isBlockedContact(emailLc, phoneNorm) {
  const keys = [];
  if (emailLc) keys.push('email:' + emailLc.replace(/\//g, '_'));
  if (phoneNorm) keys.push('phone:' + String(phoneNorm).replace(/\//g, '_'));
  if (!keys.length) return null;
  try {
    const snaps = await Promise.all(keys.map((k) => db.collection('blocked_contacts').doc(k).get()));
    for (let i = 0; i < snaps.length; i++) if (snaps[i].exists) return keys[i];
    return null;
  } catch (e) {
    console.warn('[tunnel-optin] blocklist injoignable, on laisse passer :', e && e.message);
    return null;
  }
}

function leadTypeOf(tunnel) {
  const t = String((tunnel.settings && tunnel.settings.leadType) || '').toLowerCase().trim();
  if (t && KNOWN_TYPES[t]) return t;
  if (t) return t.replace(/[^a-z0-9_]/g, '').slice(0, 40) || 'vsl_elite';
  const name = (tunnel.name + ' ' + tunnel.slug).toLowerCase();
  return name.indexOf('business') >= 0 ? 'business' : 'vsl_elite';
}

function buildAttribution(body, pageUrl, tunnel) {
  const attr = Core.parseAttribution(body && typeof body.attribution === 'object' ? body.attribution : null)
    || Core.parseAttribution(pageUrl);
  if (attr) {
    const out = Object.assign({}, attr);
    out.via = 'tunnel';
    out.capturedAt = new Date().toISOString();
    if (pageUrl) out.landingPage = pageUrl;
    return out;
  }
  const channel = str(tunnel.settings && tunnel.settings.defaultChannel, 120);
  if (!channel) return null;
  return { channel: channel, via: 'tunnel-default', declared: true, tunnelId: tunnel.id, capturedAt: new Date().toISOString() };
}

async function countOptin(tunnel, step, variant, src) {
  const FV = admin.firestore.FieldValue;
  const inc = FV.increment(1);
  const date = todayIsoParis();
  const pageK = Reg.pageKey(tunnel, step);
  const pv = {
    date: date, page: pageK, variant: variant || null, tunnelId: tunnel.id, stepId: step.id,
    pageLabel: Reg.pageLabel(tunnel, step), optins: inc, updatedAt: FV.serverTimestamp()
  };
  const stats = {
    date: date, tunnelId: tunnel.id, tunnelName: tunnel.name, tunnelSlug: tunnel.slug,
    optins: inc, updatedAt: FV.serverTimestamp(), steps: {}, sources: {}
  };
  stats.steps[step.id] = { name: step.name || step.slug, slug: step.slug, optins: inc };
  const sk = sourceKey(src);
  stats.sources[sk] = { utm_source: src.utm_source, utm_campaign: src.utm_campaign, utm_content: src.utm_content, optins: inc };
  try {
    await Promise.all([
      db.collection('page_views_daily').doc(date + '_' + pageK + (variant ? '--' + variant : '')).set(pv, { merge: true }),
      db.collection('tunnel_stats_daily').doc(date + '_' + tunnel.id).set(stats, { merge: true })
    ]);
  } catch (e) {
    console.error('[tunnel-optin] compteurs :', e && e.message);
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const body = parseBody(req) || {};
  const tunnelId = str(body.t, 80).replace(/[^A-Za-z0-9_-]/g, '');
  const stepId = str(body.s, 80).replace(/[^A-Za-z0-9_-]/g, '');
  const variant = Reg.cleanSlug(body.v, 20) || null;
  const fields = (body.fields && typeof body.fields === 'object') ? body.fields : {};
  const extrasIn = Array.isArray(body.extras) ? body.extras.slice(0, 40) : [];
  const leadIdIn = str(body.leadId, 120).replace(/\//g, '');
  const pageUrl = str(body.pageUrl, 500);
  const srcIn = (body.src && typeof body.src === 'object') ? body.src : {};
  const src = { utm_source: str(srcIn.utm_source, 120), utm_campaign: str(srcIn.utm_campaign, 200), utm_content: str(srcIn.utm_content, 200) };

  if (!tunnelId || !stepId) { res.status(400).json({ ok: false, error: 'tunnel_required' }); return; }

  // Pot de miel : un robot a rempli le champ caché → succès simulé, rien écrit.
  if (str(fields.website, 10)) { res.status(200).json({ ok: true, action: 'ignored' }); return; }

  let hit = null;
  try { hit = await Reg.findByIds(tunnelId, stepId); } catch (e) { console.error('[tunnel-optin] registre :', e && e.message); }
  if (!hit) { res.status(404).json({ ok: false, error: 'tunnel_not_found' }); return; }
  const tunnel = hit.tunnel, step = hit.step;
  if (tunnel.status !== 'live' || step.status !== 'live') { res.status(403).json({ ok: false, error: 'tunnel_not_live' }); return; }

  const prenom = str(fields.prenom, 80);
  const nomIn = str(fields.nom, 80);
  const emailRaw = str(fields.email, 200);
  const emailLc = emailRaw.toLowerCase();
  const telRaw = str(fields.telephone, 40).replace(/\s+/g, '');
  const phoneNorm = Lookup.phoneNormalized(telRaw);
  const emailOk = !!emailLc && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(emailLc);
  if (!emailOk && !phoneNorm) { res.status(400).json({ ok: false, error: 'contact_required' }); return; }
  if (emailLc && !emailOk) { res.status(400).json({ ok: false, error: 'email_invalid' }); return; }

  const blockHit = await isBlockedContact(emailLc, phoneNorm);
  if (blockHit) {
    console.log('[tunnel-optin] contact bloqué → CRM ignoré :', blockHit);
    res.status(200).json({ ok: true, action: 'blocked' });
    return;
  }

  const FV = admin.firestore.FieldValue;
  const dateFR = Lookup.dateNowFR();
  const label = Reg.pageLabel(tunnel, step);
  const pageK = Reg.pageKey(tunnel, step);
  const type = leadTypeOf(tunnel);
  const attribution = buildAttribution(body, pageUrl, tunnel);
  const landing = { page: pageK, variant: variant, tunnelId: tunnel.id, stepId: step.id, label: label, capturedAt: new Date().toISOString() };
  if (pageUrl) landing.pageUrl = pageUrl;

  // Réponses affichées par Leads Live (même format que les AlteoForms).
  const formAnswers = [];
  ['secteur', 'ca', 'defi', 'message'].forEach(function (k) {
    const v = str(fields[k], 2000);
    if (v) formAnswers.push({ fieldId: k, label: { secteur: 'Secteur', ca: 'CA actuel', defi: 'Défi', message: 'Message' }[k], type: 'text', value: v });
  });
  extrasIn.forEach(function (x) {
    if (!x || typeof x !== 'object') return;
    const v = str(x.value, 2000);
    const l = str(x.label || x.name, 120);
    if (v && l) formAnswers.push({ fieldId: keyPart(x.name || l) || 'champ', label: l, type: 'text', value: v });
  });

  const utmLabel = (attribution && (attribution.utm_content || attribution.utm_campaign)) || tunnel.name;
  const directFields = {};
  if (str(fields.secteur, 200)) directFields.secteur = str(fields.secteur, 200);
  if (str(fields.ca, 120)) directFields.ca = str(fields.ca, 120);
  if (str(fields.defi, 2000)) directFields.defi = str(fields.defi, 2000);
  if (str(fields.message, 2000)) directFields.message = str(fields.message, 2000);

  try {
    // ── 1. Fiche existante → archive + reset (sauf client) ────────────────
    const existing = await Lookup.findLeadDoc(leadIdIn, emailRaw, telRaw);
    if (existing) {
      const prev = existing.data() || {};
      const isClient = prev.isClient === true || prev.stage === 'closed_won_setting' || prev.stage === 'closed_won_self';
      const noteTxt = '🔄 Nouvel opt-in tunnel · ' + label;
      const update = Object.assign({
        type: type,
        source: 'tunnel',
        sourceDetail: label,
        utm: prev.utm ? prev.utm : Core.decodeUtm(utmLabel),
        formId: 'tunnel:' + tunnel.id + ':' + step.id,
        formTitle: label,
        formAnswers: formAnswers,
        formSubmittedAt: new Date().toISOString(),
        lastOptinAt: FV.serverTimestamp(),
        landingLast: landing,
        engagementHistory: FV.arrayUnion({
          archivedAt: new Date().toISOString(),
          archivedFor: 'optin',
          type: prev.type || null,
          stage: prev.stage || null,
          status: prev.status || null,
          utm: prev.utm || null,
          source: prev.source || null,
          sourceDetail: prev.sourceDetail || null,
          formId: prev.formId || null,
          formTitle: prev.formTitle || null,
          formAnswers: prev.formAnswers || null,
          formSubmittedAt: prev.formSubmittedAt || null,
          attribution: prev.attributionLast || prev.attributionFirst || null
        }),
        timeline_history: FV.arrayUnion({ text: noteTxt, date: dateFR, color: '#fb923c' }),
        notesHistory: FV.arrayUnion({ text: noteTxt, date: dateFR }),
        updatedAt: FV.serverTimestamp()
      }, directFields);
      if (!prev.landingFirst || !prev.landingFirst.page) update.landingFirst = landing;
      if (attribution) {
        update.attributionLast = attribution;
        if (!Core.attrHasSignal(prev.attributionFirst)) update.attributionFirst = attribution;
      }
      if (!isClient) {
        update.previousStatus = prev.status || null;
        update.previousStage = prev.stage || null;
        update.stage = 'lead';
        update.status = 'nouveau';
      }
      const fullName = (prenom + ' ' + nomIn).trim();
      if (fullName && !prev.nom) update.nom = fullName;
      if (emailLc && !prev.email) update.email = emailLc;
      if (telRaw && !prev.telephone) update.telephone = Lookup.toE164(telRaw);
      if (phoneNorm && !prev.phoneNormalized) update.phoneNormalized = phoneNorm;

      await existing.ref.update(update);
      await countOptin(tunnel, step, variant, src);
      res.status(200).json({ ok: true, action: 'updated', leadId: existing.id });
      return;
    }

    // ── 2. Fiche neuve — id déterministe sur le contact ───────────────────
    const key = emailLc || phoneNorm;
    const newId = 'tn_' + crypto.createHash('sha1').update(String(key)).digest('hex').slice(0, 20);
    let fullName = (prenom + ' ' + nomIn).trim();
    if (!fullName) fullName = emailLc || telRaw || 'Sans nom';
    const noteTxt = '✨ Lead créé via tunnel · ' + label;
    const lead = Object.assign({
      nom: fullName,
      email: emailLc,
      telephone: Lookup.toE164(telRaw),
      phoneNormalized: phoneNorm,
      type: type,
      source: 'tunnel',
      sourceDetail: label,
      utm: Core.decodeUtm(utmLabel),
      stage: 'lead',
      status: 'nouveau',
      assignedTo: '',
      formId: 'tunnel:' + tunnel.id + ':' + step.id,
      formTitle: label,
      formAnswers: formAnswers,
      formSubmittedAt: new Date().toISOString(),
      landingFirst: landing,
      landingLast: landing,
      tags: [],
      notesHistory: [{ text: noteTxt, date: dateFR }],
      timeline_history: [{ text: noteTxt, date: dateFR, color: '#a78bfa' }],
      communications: [],
      createdAt: FV.serverTimestamp(),
      updatedAt: FV.serverTimestamp()
    }, directFields);
    if (attribution) { lead.attributionFirst = attribution; lead.attributionLast = attribution; }

    const ref = db.collection('leads').doc(newId);
    let action = 'created';
    try {
      await ref.create(lead);
    } catch (e) {
      // ALREADY_EXISTS : double envoi — la fiche est déjà là.
      if (e && (e.code === 6 || /already exists/i.test(String(e.message)))) action = 'updated';
      else throw e;
    }
    await countOptin(tunnel, step, variant, src);
    res.status(200).json({ ok: true, action: action, leadId: newId });
  } catch (e) {
    console.error('[tunnel-optin] erreur :', e);
    res.status(500).json({ ok: false, error: 'internal_error' });
  }
};
