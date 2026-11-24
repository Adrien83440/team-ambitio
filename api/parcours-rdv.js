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
const REGLAGES = ['actif', 'modeTest', 'testMembres', 'testTelephones', 'testEmails', 'whatsapp', 'activeCampaign', 'textes', 'rattrapage', 'emailCompte'];

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
      const estCron = cron(req);
      if (!estCron && !cleChantier(req)) { res.status(401).json({ ok: false, error: 'Non autorisé' }); return; }
      const sim = !estCron || q.dry === '1';
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
    if (action === 'reglage') {
      const r = await reglage(body, par);
      res.status(r.ok ? 200 : 400).json(r);
      return;
    }
    res.status(400).json({ ok: false, error: 'action inconnue' });
  } catch (e) {
    console.error('[parcours-rdv]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
