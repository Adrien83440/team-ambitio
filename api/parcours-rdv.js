// ============================================================================
// api/parcours-rdv.js — PARCOURS « RENDEZ-VOUS » DES PROSPECTS (24/11/2026)
// ----------------------------------------------------------------------------
// Moteur : api/_parcoursRdv.js (règles, textes, envois). Cette route :
//
//   GET  (cron Vercel, Bearer CRON_SECRET)            → un passage
//   GET  ?dry=1                                        → simulation, rien envoyé
//   GET  ?apercu=confirmation|valeur                   → HTML d'un e-mail (exemple)
//   POST { action:'etat' }                             → réglages + modèle WhatsApp + simulation
//   POST { action:'test', quoi, membre }               → envoie UN message AU MEMBRE
//        quoi ∈ confirmation_email | confirmation_sms | valeur_email
//               | wa_veille | sms_h1 | rattrapage
//   POST { action:'reglage', ... }                     → modifie _config/parcours_rdv
//        (champs autorisés uniquement, trace dans `historique`)
//   POST { action:'types', ids:[…], parcoursRdv, displayDuration, apply }
//        → coche le parcours / la durée annoncée sur ces consultations
//          (à blanc sans apply:true)
//
// Accès : cron (CRON_SECRET), admin connecté (POST), ou clé temporaire
// PARCOURS_AUDIT_KEY (en-tête x-audit-key ou ?k=) pour le chantier.
// Un passage n'envoie RIEN tant que `_config/parcours_rdv.actif` n'est pas
// vrai, et seulement aux RDV de test tant que `modeTest` est vrai.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const P = require('./_parcoursRdv');

function egal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cleChantier(req) {
  const want = String(process.env.PARCOURS_AUDIT_KEY || '');
  if (want.length < 24) return false;
  const got = (req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '';
  return egal(got, want);
}
function cron(req) {
  const s = process.env.CRON_SECRET || '';
  const a = String((req.headers && req.headers.authorization) || '');
  return !!s && a.indexOf('Bearer ') === 0 && egal(a.slice(7).trim(), s);
}

/* Champs modifiables par `reglage` (jamais le reste du document). */
const REGLAGES = ['actif', 'modeTest', 'testMembres', 'testTelephones', 'testEmails', 'whatsapp', 'activeCampaign', 'textes', 'rattrapage', 'emailCompte', 'syncTextesAC'];

async function reglage(body, par) {
  const ref = db.collection('_config').doc('parcours_rdv');
  const patch = {};
  REGLAGES.forEach(function (k) { if (body[k] !== undefined) patch[k] = body[k]; });
  if (patch.modeTest === false && String(body.confirmation || '') !== 'PRODUCTION') {
    return { ok: false, erreur: 'Passage en réel : confirmation « PRODUCTION » exigée' };
  }
  if (patch.actif === true) {
    const s = await ref.get();
    const d = s.exists ? (s.data() || {}) : {};
    // `depuis` posé à la PREMIÈRE activation : jamais de rattrapage du passé.
    if (!d.depuis) patch.depuis = Date.now();
  }
  if (!Object.keys(patch).length) return { ok: false, erreur: 'rien_a_modifier' };
  const trace = { at: Date.now(), par: par, champs: Object.keys(patch) };
  patch.historique = admin.firestore.FieldValue.arrayUnion(trace);
  patch.majA = Date.now();
  await ref.set(patch, { merge: true });
  return { ok: true, modifie: trace.champs };
}

/* Coche le parcours (et la durée annoncée) sur des consultations précises de
   booking_config/_types. Transaction ; seuls `notifications.parcoursRdv` et
   `displayDuration` changent, sur les seuls identifiants demandés. À blanc
   tant que `apply` n'est pas vrai. L'état d'avant est gardé dans
   _config/parcours_rdv.historiqueTypes. */
async function types(body, par) {
  const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
  if (!ids.length) return { ok: false, erreur: 'ids requis' };
  const parcours = body.parcoursRdv === undefined ? null : body.parcoursRdv === true;
  const duree = body.displayDuration === undefined ? undefined : (body.displayDuration === null ? null : Number(body.displayDuration));
  const ref = db.collection('booking_config').doc('_types');
  const apply = body.apply === true;
  const resultat = await db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    const list = (s.exists && Array.isArray((s.data() || {}).list)) ? s.data().list : [];
    const avant = [], apres = [];
    const inconnus = ids.filter(function (id) { return !list.some(function (t) { return t && t.id === id; }); });
    if (inconnus.length) return { ok: false, erreur: 'consultations inconnues : ' + inconnus.join(', ') };
    const nouvelle = list.map(function (t) {
      if (!t || ids.indexOf(t.id) < 0) return t;
      avant.push({ id: t.id, parcoursRdv: !!(t.notifications && t.notifications.parcoursRdv), displayDuration: t.displayDuration == null ? null : t.displayDuration });
      const c = Object.assign({}, t);
      if (parcours !== null) c.notifications = Object.assign({}, t.notifications || {}, { parcoursRdv: parcours });
      if (duree !== undefined) c.displayDuration = duree;
      apres.push({ id: c.id, label: c.label, parcoursRdv: !!(c.notifications && c.notifications.parcoursRdv), displayDuration: c.displayDuration == null ? null : c.displayDuration });
      return c;
    });
    if (apply) tx.update(ref, { list: nouvelle });
    return { ok: true, applique: apply, avant: avant, apres: apres };
  });
  if (resultat.ok && apply) {
    await db.collection('_config').doc('parcours_rdv').set({
      historiqueTypes: admin.firestore.FieldValue.arrayUnion({ at: Date.now(), par: par, avant: resultat.avant, apres: resultat.apres }),
    }, { merge: true });
  }
  return resultat;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const q = req.query || {};

    if (req.method === 'GET') {
      if (q.apercu && cleChantier(req)) {
        const a = P.apercuEmails();
        const m = q.apercu === 'valeur' ? a.valeur : a.confirmation;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.status(200).send(m.html);
        return;
      }
      // Actions par GET (clé du chantier seulement) : l'outil qui lit la
      // preview ne sait faire que des GET. Paramètres dans ?json=…
      if (q.action && cleChantier(req)) {
        let corps = {};
        try { corps = q.json ? JSON.parse(String(q.json)) : {}; } catch (e) { res.status(400).json({ ok: false, error: 'json illisible' }); return; }
        corps.action = String(q.action);
        await actionner(corps, 'cle_chantier', res);
        return;
      }
      const estCron = cron(req);
      if (!estCron && !cleChantier(req)) { res.status(401).json({ ok: false, error: 'Non autorisé' }); return; }
      const sim = !estCron || q.dry === '1';
      /* Une fois, à la demande (_config/parcours_rdv.syncTextesAC = 'dry' ou
         true) : le texte validé des séquences ActiveCampaign est posé par
         l'API (seul le cron de production a la clé). Le drapeau retombe à
         false après le passage, le résultat est gardé. */
      if (estCron) {
        const cfgSync = await P.lireConfig();
        if (cfgSync.syncTextesAC === true || cfgSync.syncTextesAC === 'dry') {
          const ref = db.collection('_config').doc('parcours_rdv');
          await ref.set({ syncTextesAC: false }, { merge: true });
          const r = await require('./_acSequences').synchroniser({ apply: cfgSync.syncTextesAC === true });
          await ref.set({ syncTextesResultat: r }, { merge: true });
        }
      }
      const out = await P.passage({ simulation: sim });
      res.status(200).json(out);
      return;
    }

    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'GET ou POST' }); return; }
    const body = (await parseBody(req)) || {};
    let par = 'cle_chantier';
    if (!cleChantier(req)) {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      par = auth.email || auth.uid;
    }
    await actionner(body, par, res);
  } catch (e) {
    console.error('[parcours-rdv]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};

async function actionner(body, par, res) {
    const action = String(body.action || '');

    if (action === 'etat') {
      const cfg = await P.lireConfig();
      const modele = await P.lireModeleWhatsapp(cfg, {});
      const sim = await P.passage({ simulation: true });
      const vue = Object.assign({}, cfg);
      delete vue.historique;
      res.status(200).json({ ok: true, reglages: vue, modeleWhatsapp: modele, simulation: sim });
      return;
    }
    if (action === 'test') {
      const r = await P.envoyerTest({ quoi: String(body.quoi || ''), membre: String(body.membre || 'adrien'), email: body.email || null, expert: body.expert || null });
      res.status(200).json(r);
      return;
    }
    if (action === 'types') {
      const r = await types(body, par);
      res.status(r.ok ? 200 : 400).json(r);
      return;
    }
    if (action === 'reglage') {
      const r = await reglage(body, par);
      res.status(r.ok ? 200 : 400).json(r);
      return;
    }
    res.status(400).json({ ok: false, error: 'action inconnue' });
}
