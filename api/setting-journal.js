// ============================================================================
// api/setting-journal.js — JOURNAL DU SETTING ÉCRIT INSTAGRAM / FACEBOOK (27/11/2026)
// ----------------------------------------------------------------------------
// Page admin-setting-social.html (Marketing → 💬 Setting Insta / FB) : tout ce
// que fait le setting écrit mené par l'agent sur les comptes Instagram et
// Facebook (réponses aux commentaires, conversations privées, liens de RDV),
// plus un reporting. ADMIN uniquement (requireAdmin).
//
// POURQUOI UN JOURNAL À PART : le setting passe par Meta Business Suite dans un
// navigateur, pas par l'API Graph. La synchro existante (ig_comments,
// ig_dm_threads, fb_*) ne voit donc pas de façon fiable ce qui est envoyé.
// L'agent tient son journal (une ligne par événement) et le dépose ici à la
// fin de chaque passage, par la page elle-même (session admin du navigateur :
// aucune clé, aucun secret).
//
//   GET  [?jours=60]                → { evenements, rdv, dernierDepot }
//   POST { action:'import', lignes:[…], passage? }  → dépose des lignes
//
// Une ligne : { at, passage, canal, type, personne, publication, texte, etape,
//               note, auteur }
//   canal : instagram_dm | messenger | instagram_commentaire | facebook_commentaire
//   type  : recu | reponse_publique | dm_ouverture | dm_reponse | dm_relance |
//           lien_rdv_envoye | remonte_adrien | sans_reponse | repris_par_adrien
//
// DONNÉES (Admin SDK seul, AUCUNE règle Firestore) :
//   setting_journal/{id}          une ligne ; id = empreinte du contenu → déposer
//                                 deux fois la même ligne ne crée pas de doublon.
//                                 AJOUT SEUL : une ligne déjà déposée n'est jamais
//                                 réécrite ni supprimée.
//   setting_journal_depots/{id}   trace de chaque dépôt (qui, quand, combien).
//
// « RDV réservés » : réservations portant landing.attribution.utm_medium ==
// 'setting_ecrit' (le lien de RDV du setting porte ce paramètre, booking.html
// le garde sur le RDV). Lecture seule.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const CANAUX = { instagram_dm: 1, messenger: 1, instagram_commentaire: 1, facebook_commentaire: 1 };
const RE_TYPE = /^[a-z][a-z0-9_]{1,39}$/;
const MAX_LIGNES = 400;          // par dépôt (un lot Firestore = 500 écritures)
const MAX_LECTURE = 6000;        // lignes renvoyées à la page
const UTM_MEDIUM = 'setting_ecrit';

function txt(v, max) {
  if (v == null) return '';
  return String(v).replace(/\u0000/g, '').trim().slice(0, max);
}

// Une ligne propre, ou { erreur } si elle est inutilisable.
function nettoyer(l) {
  if (!l || typeof l !== 'object' || Array.isArray(l)) return { erreur: 'pas un objet' };
  const canal = txt(l.canal, 40);
  if (!CANAUX[canal]) return { erreur: 'canal inconnu : ' + (canal || '(vide)') };
  const type = txt(l.type, 40);
  if (!RE_TYPE.test(type)) return { erreur: 'type invalide : ' + (type || '(vide)') };
  const at = txt(l.at, 40);
  const atMs = Date.parse(at);
  if (!at || isNaN(atMs)) return { erreur: 'date « at » illisible : ' + (at || '(vide)') };
  if (atMs > Date.now() + 36 * 3600 * 1000 || atMs < Date.parse('2024-01-01T00:00:00Z')) return { erreur: 'date « at » hors plage : ' + at };
  const personne = txt(l.personne, 160);
  if (!personne) return { erreur: 'personne manquante' };
  return {
    at: at, atMs: atMs,
    passage: txt(l.passage, 40),
    canal: canal, type: type, personne: personne,
    publication: txt(l.publication, 300),
    texte: txt(l.texte, 5000),
    etape: txt(l.etape, 120),
    note: txt(l.note, 1500),
    auteur: txt(l.auteur, 60),
  };
}

function empreinte(e) {
  return crypto.createHash('sha1')
    .update([e.at, e.canal, e.type, e.personne, e.publication, e.texte, e.note, e.auteur].join('\u001f'))
    .digest('hex').slice(0, 28);
}

function tsMs(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.seconds === 'number') return v.seconds * 1000;
  return null;
}

async function lire(jours) {
  const depuis = Date.now() - jours * 86400000;
  const snap = await db.collection('setting_journal').where('atMs', '>=', depuis).orderBy('atMs', 'asc').limit(MAX_LECTURE + 1).get();
  const evenements = [];
  snap.forEach(function (d) {
    const x = d.data() || {};
    evenements.push({ id: d.id, at: x.at || '', atMs: x.atMs || 0, passage: x.passage || '', canal: x.canal || '', type: x.type || '',
      personne: x.personne || '', publication: x.publication || '', texte: x.texte || '', etape: x.etape || '', note: x.note || '', auteur: x.auteur || '' });
  });
  const tronque = evenements.length > MAX_LECTURE;
  if (tronque) evenements.length = MAX_LECTURE;

  // RDV réservés par le lien du setting (lecture seule, échec non bloquant).
  let rdv = [], rdvErreur = null;
  try {
    const bs = await db.collection('bookings').where('landing.attribution.utm_medium', '==', UTM_MEDIUM).limit(300).get();
    bs.forEach(function (d) {
      const b = d.data() || {};
      const p = b.prospect || {};
      const a = (b.landing && b.landing.attribution) || {};
      rdv.push({
        id: d.id, date: b.date || '', time: b.time || '', status: b.status || '',
        outcome: b.outcome || (b.result && b.result.outcome) || '',
        prenom: p.prenom || '', nom: p.nom || '',
        source: a.utm_source || '', leadId: b.leadId || '',
        closer: b.personName || '', creeLeMs: tsMs(b.createdAt),
      });
    });
    rdv.sort(function (x, y) { return (y.creeLeMs || 0) - (x.creeLeMs || 0); });
  } catch (e) {
    rdvErreur = String((e && e.message) || e).slice(0, 200);
    console.warn('[setting-journal] lecture des RDV en échec :', rdvErreur);
  }

  let dernierDepot = null;
  try {
    const ds = await db.collection('setting_journal_depots').orderBy('atMs', 'desc').limit(1).get();
    ds.forEach(function (d) { const x = d.data() || {}; dernierDepot = { atMs: x.atMs || 0, passage: x.passage || '', recues: x.recues || 0, nouvelles: x.nouvelles || 0, par: x.par || '' }; });
  } catch (e) { /* trace facultative */ }

  return { evenements: evenements, tronque: tronque, rdv: rdv, rdvErreur: rdvErreur, dernierDepot: dernierDepot, jours: jours };
}

async function importer(body, par) {
  const lignes = Array.isArray(body.lignes) ? body.lignes : null;
  if (!lignes || !lignes.length) return { status: 400, json: { ok: false, error: 'aucune ligne à déposer (champ « lignes »)' } };
  if (lignes.length > MAX_LIGNES) return { status: 400, json: { ok: false, error: 'trop de lignes : ' + lignes.length + ' (maximum ' + MAX_LIGNES + ' par dépôt, envoyer en plusieurs fois)' } };

  const propres = {}, refusees = [];
  for (let i = 0; i < lignes.length; i++) {
    const e = nettoyer(lignes[i]);
    if (e.erreur) { refusees.push({ ligne: i + 1, raison: e.erreur }); continue; }
    propres[empreinte(e)] = e;                 // deux lignes identiques dans le même dépôt = une
  }
  const ids = Object.keys(propres);
  const col = db.collection('setting_journal');

  // Ajout seul : on n'écrit que les lignes qui n'existent pas encore.
  let dejaLa = 0, nouvelles = 0;
  if (ids.length) {
    const snaps = await db.getAll.apply(db, ids.map(function (id) { return col.doc(id); }));
    const lot = db.batch();
    const maintenant = Date.now();
    for (let i = 0; i < snaps.length; i++) {
      if (snaps[i].exists) { dejaLa++; continue; }
      const e = propres[snaps[i].id];
      e.deposeLeMs = maintenant;
      e.deposePar = par;
      lot.set(snaps[i].ref, e);
      nouvelles++;
    }
    if (nouvelles) await lot.commit();
  }

  const maintenant = Date.now();
  await db.collection('setting_journal_depots').add({
    atMs: maintenant, at: admin.firestore.FieldValue.serverTimestamp(), par: par,
    passage: txt(body.passage, 40), recues: lignes.length, nouvelles: nouvelles, dejaLa: dejaLa,
    refusees: refusees.slice(0, 30),
  });
  return { status: 200, json: { ok: true, recues: lignes.length, nouvelles: nouvelles, dejaLa: dejaLa, refusees: refusees } };
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const auth = await requireAdmin(req, res);
    if (!auth) return;

    if (req.method === 'GET') {
      let jours = Math.round(Number((req.query && req.query.jours) || 60));
      if (!(jours >= 1 && jours <= 365)) jours = 60;
      const r = await lire(jours);
      res.status(200).json(Object.assign({ ok: true }, r));
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'GET ou POST' }); return; }
    const body = parseBody(req) || {};
    if (String(body.action || '') !== 'import') { res.status(400).json({ ok: false, error: 'action inconnue' }); return; }
    const r = await importer(body, auth.email || auth.uid);   // écrit AVANT de répondre
    res.status(r.status).json(r.json);
  } catch (e) {
    console.error('[setting-journal]', e);
    res.status(500).json({ ok: false, error: 'server_error', detail: String((e && e.message) || e).slice(0, 300) });
  }
};

// Exposé pour les tests hors réseau.
module.exports._nettoyer = nettoyer;
module.exports._empreinte = empreinte;
