// ============================================================================
// api/lead-optin.js
// ----------------------------------------------------------------------------
// Endpoint d'opt-in webhook pour les tunnels VSL (Élite, Business, etc.).
//
// URL  : POST https://team.alteore.com/api/lead-optin
// Auth : header x-api-key (validé contre process.env.LEAD_OPTIN_API_KEY)
// CORS : pas nécessaire — appelé uniquement par Make en server-to-server
//
// Body (JSON) :
//   {
//     type      : "business" | "vsl_elite",     // tunnel d'origine
//     nom       : "Adrien François",            // prénom + nom concat
//     email     : "adrien@example.com",
//     telephone : "+33688121402",
//     utm       : "VSL Business - Page inscription",  // optionnel
//     source    : "webhook"                            // optionnel
//   }
//
// Réponse 200 :
//   {
//     ok     : true,
//     action : "updated" | "created",
//     leadId : string,
//     wasExisting : boolean
//   }
//
// ─── POURQUOI cet endpoint existe ─────────────────────────────────────
// Avant : Make écrivait directement dans Firestore /leads/ avec un nouveau
// doc à chaque opt-in. La dédup en Cloud Function rapprochait par
// email/téléphone et fusionnait — MAIS elle préservait l'ancien `type`,
// l'ancien `stage`, et l'ancien `formAnswers`. Résultat : un lead Élite
// qui se ré-inscrivait via VSL Business voyait sa fiche rester en
// "Self-Booking" avec les anciennes réponses du formulaire affichées,
// alors qu'on attendait une fiche "fraîche" avec le tunnel Business.
//
// Maintenant : Make appelle cet endpoint qui orchestre proprement :
//   - Cherche un lead existant par email puis téléphone (phoneNormalized)
//   - Si EXISTANT : archive l'état actuel (type/stage/status/utm/form*)
//     dans engagementHistory[], puis reset les déclaratifs avec les
//     nouvelles infos d'opt-in. La fiche affiche en haut "Business
//     · Nouveau · UTM VSL Business" et en bas l'historique des passages
//     précédents (accordéon).
//   - Si NOUVEAU : crée un lead classique
//
// ─── PHILOSOPHIE (validée avec Adrien) ────────────────────────────────
// Vue Lead Live = état FRAIS du dernier engagement.
// Ce qui est RESET : type, stage, status, utm, source, sourceDetail,
//                    formId, formTitle, formAnswers, formSubmittedAt
// Ce qui PERSISTE :  assignedTo (continuité commerciale), notesHistory
//                    (audit du closer), bookings (collection séparée),
//                    timeline_history (audit technique complet).
//
// CLIENTS protégés : un lead avec stage = closed_won_setting/closed_won_self
// ou isClient = true ne se voit JAMAIS reset (pas de rétrogradation).
//
// ─── SÉCURITÉ ─────────────────────────────────────────────────────────
// - x-api-key validée contre une env var (à poser sur Vercel)
// - Pas de champs libres : seul un set restreint de champs est accepté
// - phoneNormalized pour éviter les collisions trop laxistes
// - Aucun retour de données sensibles
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
// Parsing d'attribution : implémentation UNIQUE, partagée avec le funnel
// (même module que celui qui relit ces champs — aucune dérive possible).
const Core = require('../funnel-core.js');

// ─── ATTRIBUTION PUBLICITAIRE (chantier UTM 17/08/2026) ───────────────
// Le champ `utm` reste écrit tel quel (Leads Live, CRM, export en
// dépendent), mais il est écrasé à chaque ré-engagement : il ne peut pas
// servir d'axe créative. On pose donc deux blocs structurés :
//   attributionFirst — PREMIER touch, jamais réécrit une fois posé
//   attributionLast  — rafraîchi à chaque opt-in porteur d'UTM
// Sources acceptées, dans l'ordre : body.attribution (objet), champs
// utm_* posés à plat dans le body, querystring contenue dans `utm`,
// URL de landing complète. Rien d'exploitable → aucun bloc écrit.
function buildAttribution(body, utmRaw, via) {
  const landing = body && (body.landingUrl || body.pageUrl || body.url) ;
  const attr =
    Core.parseAttribution(body && typeof body.attribution === 'object' ? body.attribution : null) ||
    Core.parseAttribution(body) ||
    Core.parseAttribution(utmRaw) ||
    Core.parseAttribution(landing);
  if (!attr) return null;
  const out = Object.assign({}, attr);
  out.via = via;
  out.capturedAt = new Date().toISOString();
  if (landing) out.landingPage = String(landing).slice(0, 500);
  return out;
}

// 9 derniers digits — cohérent avec sales-leads.html telVariants() et
// alteoform-submit.js phoneNormalized().
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

function dateNowFR() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' });
}

/* Liste de blocage (api/lead-block.js) — lecture par ID de document, donc
   deux get() au pire, aucune requête ni index. Retourne la clé qui a
   matché, ou null. En cas d'erreur Firestore on NE bloque pas : mieux vaut
   laisser passer un lead pourri que perdre un vrai lead. */
async function isBlockedContact(emailLc, phoneNorm) {
  const keys = [];
  if (emailLc) keys.push('email:' + emailLc.replace(/\//g, '_'));
  if (phoneNorm) keys.push('phone:' + String(phoneNorm).replace(/\//g, '_'));
  if (!keys.length) return null;
  try {
    const snaps = await Promise.all(
      keys.map((k) => db.collection('blocked_contacts').doc(k).get())
    );
    for (let i = 0; i < snaps.length; i++) if (snaps[i].exists) return keys[i];
    return null;
  } catch (e) {
    console.warn('[lead-optin] blocklist injoignable, on laisse passer :', e && e.message);
    return null;
  }
}

// Mapping type brut → clé canonique LEAD_TYPES côté front
// Make peut envoyer plusieurs variantes ("VSL BUSINESS", "Business", "business"...)
// → on canonise pour que le badge Lead Live s'affiche correctement.
function canonicalizeType(rawType) {
  if (!rawType) return 'vsl_elite';
  const t = String(rawType).toLowerCase().trim();
  if (t.indexOf('business') >= 0) return 'business';
  if (t.indexOf('elite') >= 0 || t.indexOf('élite') >= 0) return 'vsl_elite';
  if (t.indexOf('self') >= 0) return 'self_booking';
  if (t.indexOf('webinaire') >= 0 || t.indexOf('webinar') >= 0) return 'webinaire';
  // Fallback : on garde tel quel, le front affichera un badge "other"
  return t;
}

module.exports = async (req, res) => {
  // ─── 1. Auth via x-api-key ──────────────────────────────────────────
  const expectedKey = process.env.LEAD_OPTIN_API_KEY;
  const providedKey = req.headers['x-api-key'] || req.headers['X-API-Key'];
  if (!expectedKey) {
    console.error('[lead-optin] LEAD_OPTIN_API_KEY env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  if (providedKey !== expectedKey) {
    console.warn('[lead-optin] invalid api key');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // ─── 2. Méthode ─────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ─── 3. Parse body ──────────────────────────────────────────────────
  const body = parseBody(req);
  const {
    type:      typeRaw,
    nom:       nomRaw,
    email:     emailRaw,
    telephone: telRaw,
    utm:       utmRaw,
    source:    sourceRaw
  } = body || {};

  // Validation minimale
  const emailLc = String(emailRaw || '').trim().toLowerCase();
  const tel     = String(telRaw || '').replace(/\s+/g, '');
  if (!emailLc && !tel) {
    res.status(400).json({ error: 'email_or_telephone_required' });
    return;
  }

  const type        = canonicalizeType(typeRaw);
  const phoneNorm   = phoneNormalized(tel);
  const tunnelLabel = type === 'business' ? 'VSL Business'
                    : type === 'vsl_elite' ? 'VSL Élite'
                    : (typeRaw || type);
  // Décodage défensif : certaines landing pages transmettent l'utm_campaign
  // %-encodé ("3%29NEW-%C3%A9t%C3%A9"). Le correctif existait dans une copie
  // du fichier restée à la racine du repo — donc jamais routée par Vercel,
  // donc jamais en production. Il est à sa place ici.
  const utm         = Core.decodeUtm(String(utmRaw || tunnelLabel));
  const source      = String(sourceRaw || 'webhook');
  const attribution = buildAttribution(body, utmRaw, 'optin');

  // ─── 3bis. LISTE DE BLOCAGE ─────────────────────────────────────────
  // Faux numéros et emails bidon bloqués depuis Leads Live : on s'arrête
  // AVANT toute écriture — ni création, ni résurrection d'une fiche
  // existante (sinon un contact bloqué reviendrait à chaque ré-opt-in).
  // Réponse 200 volontaire : Make ne doit pas la traiter comme une panne
  // et rejouer l'appel en boucle.
  const blockHit = await isBlockedContact(emailLc, phoneNorm);
  if (blockHit) {
    console.log('[lead-optin] contact bloqué → ignoré :', blockHit);
    res.status(200).json({ ok: true, action: 'blocked', blockedBy: blockHit });
    return;
  }

  // ─── 4. Recherche d'un lead existant ────────────────────────────────
  // Stratégie : email d'abord (clé la plus fiable), puis téléphone normalisé.
  let existingSnap = null;
  if (emailLc) {
    const byEmail = await db.collection('leads')
      .where('email', '==', emailLc)
      .limit(1)
      .get();
    if (!byEmail.empty) existingSnap = byEmail.docs[0];
  }
  if (!existingSnap && phoneNorm) {
    const byPhone = await db.collection('leads')
      .where('phoneNormalized', '==', phoneNorm)
      .limit(1)
      .get();
    if (!byPhone.empty) existingSnap = byPhone.docs[0];
  }

  // ─── 5a. EXISTANT → archive + reset + nouveau tunnel ────────────────
  if (existingSnap) {
    const prev = existingSnap.data() || {};

    // Protection clients : on ne reset JAMAIS un client coaching actif.
    const CLIENT_STAGES = ['closed_won_setting', 'closed_won_self'];
    const isClient = prev.isClient === true
                  || CLIENT_STAGES.indexOf(prev.stage) >= 0;

    const noteTxt = '🔄 Nouvel opt-in ' + tunnelLabel;
    const dateFR  = dateNowFR();

    const update = {
      // ─── Nouveau tunnel ─────────────────────────────────────────────
      type:         type,
      source:       source,
      sourceDetail: tunnelLabel,
      utm:          utm,

      // ─── Reset des champs déclaratifs de formulaire ────────────────
      // Les anciennes réponses partent dans engagementHistory[] (cf. plus bas)
      // et sont retirées de la vue principale.
      formId:           admin.firestore.FieldValue.delete(),
      formTitle:        admin.firestore.FieldValue.delete(),
      formAnswers:      admin.firestore.FieldValue.delete(),
      formSubmittedAt:  admin.firestore.FieldValue.delete(),

      // ─── lastOptinAt déclencheur résurrection Lead Live ─────────────
      lastOptinAt: admin.firestore.FieldValue.serverTimestamp(),

      // ─── Snapshot de l'état précédent dans engagementHistory[] ──────
      // Affiché dans le bloc accordéon "📜 Historique des passages".
      engagementHistory: admin.firestore.FieldValue.arrayUnion({
        archivedAt:      new Date().toISOString(),
        archivedFor:     'optin',
        type:            prev.type            || null,
        stage:           prev.stage           || null,
        status:          prev.status          || null,
        utm:             prev.utm             || null,
        source:          prev.source          || null,
        sourceDetail:    prev.sourceDetail    || null,
        formId:          prev.formId          || null,
        formTitle:       prev.formTitle       || null,
        formAnswers:     prev.formAnswers     || null,
        formSubmittedAt: prev.formSubmittedAt || null,
        attribution:     prev.attributionLast || prev.attributionFirst || null
      }),

      // ─── Audit trails ──────────────────────────────────────────────
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: noteTxt,
        date: dateFR,
        color: '#fb923c'
      }),
      notesHistory: admin.firestore.FieldValue.arrayUnion({
        text: noteTxt,
        date: dateFR
      }),

      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    // ─── Attribution ───────────────────────────────────────────────────
    // Dernier touch toujours rafraîchi ; premier touch posé UNIQUEMENT
    // s'il n'existe pas encore — c'est tout l'intérêt du champ, il ne doit
    // jamais bouger une fois la créative d'origine connue.
    if (attribution) {
      update.attributionLast = attribution;
      if (!Core.attrHasSignal(prev.attributionFirst)) update.attributionFirst = attribution;
    }

    // ─── Soft-reset stage/status (sauf clients) ────────────────────────
    if (!isClient) {
      update.previousStatus = prev.status || null;
      update.previousStage  = prev.stage  || null;
      update.stage  = 'lead';
      update.status = 'nouveau';
    }

    // ─── Met à jour nom/tel/email si fournis et non posés ─────────────
    // On ne les écrase PAS si déjà présents (l'identité du lead a été
    // établie en premier, on ne la modifie pas via opt-in).
    if (nomRaw && !prev.nom)          update.nom = String(nomRaw).trim();
    if (tel    && !prev.telephone)    update.telephone = tel;
    if (phoneNorm && !prev.phoneNormalized) update.phoneNormalized = phoneNorm;
    if (emailLc && !prev.email)       update.email = emailLc;

    try {
      await existingSnap.ref.update(update);
    } catch (e) {
      console.error('[lead-optin] update error:', e);
      res.status(500).json({ error: 'update_failed' });
      return;
    }

    console.log('[lead-optin] updated existing lead', existingSnap.id, 'type=', type);
    res.status(200).json({
      ok:          true,
      action:      'updated',
      leadId:      existingSnap.id,
      wasExisting: true
    });
    return;
  }

  // ─── 5b. NOUVEAU LEAD → création classique ──────────────────────────
  const noteTxt = '✨ Lead créé via opt-in ' + tunnelLabel;
  const dateFR  = dateNowFR();

  const newLead = {
    nom:             String(nomRaw || emailLc || tel || 'Sans nom').trim(),
    email:           emailLc,
    telephone:       tel,
    phoneNormalized: phoneNorm,
    type:            type,
    source:          source,
    sourceDetail:    tunnelLabel,
    utm:             utm,
    stage:           'lead',
    status:          'nouveau',
    assignedTo:      '',
    tags:            [],
    notesHistory:    [{ text: noteTxt, date: dateFR }],
    timeline_history: [{ text: noteTxt, date: dateFR, color: '#a78bfa' }],
    communications:  [],
    createdAt:       admin.firestore.FieldValue.serverTimestamp(),
    updatedAt:       admin.firestore.FieldValue.serverTimestamp()
  };
  if (attribution) {
    newLead.attributionFirst = attribution;
    newLead.attributionLast  = attribution;
  }

  try {
    const ref = await db.collection('leads').add(newLead);
    console.log('[lead-optin] created new lead', ref.id, 'type=', type,
      'attribution=', attribution ? (attribution.utm_content || attribution.ad_id || 'partielle') : 'aucune');
    res.status(200).json({
      ok:          true,
      action:      'created',
      leadId:      ref.id,
      wasExisting: false
    });
  } catch (e) {
    console.error('[lead-optin] create error:', e);
    res.status(500).json({ error: 'create_failed' });
  }
};
