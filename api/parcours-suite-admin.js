// ============================================================================
// api/parcours-suite-admin.js — MODULE ADMIN « SÉQUENCES » (24/11/2026)
// ----------------------------------------------------------------------------
// Page admin-sequences.html : voir et contrôler les séquences d'e-mails
// d'après-RDV envoyées par Team (moteur api/_parcoursSuite.js).
// ADMIN uniquement (requireAdmin).
//
//   GET  ?action=etat                       → réglages, chiffres, prospects, arbre
//   POST { action:'apercu', sequence, douleur, etape, choix }   → { objet, html }
//   POST { action:'test',   sequence, douleur, etape, choix }   → envoie CET
//        e-mail à l'adresse de l'admin connecté (exemple, aucun prospect)
//   POST { action:'reglage', actif?, plafondJour?, off? }       → _config/parcours_rdv.suites
//        off : { 'seq:<séquence>' | 'douleur:<histoire>' | 'email:<clé>' : true|false }
//   POST { action:'suite', id, quoi, valeur }  → agir sur UN prospect
//        quoi : pause | reprendre | arreter | forcer | douleur | choix
// Le passage du test au réel n'est PAS ici : c'est le mode du parcours RDV
// tout entier (api/parcours-rdv.js, confirmation « PRODUCTION »).
// ============================================================================
'use strict';

const { admin, db } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const S = require('./_parcoursSuite');

const RE_OFF = /^(seq:[a-z_]+|douleur:[a-z_]+|email:[a-z_]+#[A-Za-z0-9]{1,4})$/;

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const auth = await requireAdmin(req, res);
    if (!auth) return;
    const par = auth.email || auth.uid;

    if (req.method === 'GET') {
      const C = await S.lireConfig();
      const liste = await S.listeAdmin();
      res.status(200).json({
        ok: true,
        reglages: { actif: C.suites.actif === true, plafondJour: C.suites.plafondJour, off: C.suites.off || {},
          heureDebut: C.suites.heureDebut, heureFin: C.suites.heureFin, newsletterAutomation: C.suites.newsletterAutomation },
        parcoursActif: C.cfg.actif === true, modeTest: C.cfg.modeTest !== false,
        compteurJour: C.cfg.suitesCompteur || null,
        stats: S.statsDe(liste), prospects: liste, arbre: S.arbre(C.suites.off || {}),
        libelles: { sequences: S.LIB_SEQ, douleurs: S.LIB_DOULEUR },
      });
      return;
    }
    if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'GET ou POST' }); return; }
    const body = (await parseBody(req)) || {};
    const action = String(body.action || '');

    if (action === 'apercu') {
      const s = S.suiteFictive({ sequence: String(body.sequence || ''), douleur: String(body.douleur || ''), chapitre: String(body.chapitre || ''), choisi: body.choisi === true, email: 'exemple@exemple.fr', prenom: 'Julie' });
      const c = S.contenuDe(s, Number(body.etape) || 1);
      if (!c || c.erreur) { res.status(404).json({ ok: false, error: (c && c.erreur) || 'e-mail introuvable' }); return; }
      res.status(200).json({ ok: true, objet: c.subject, cle: c.cle, html: c.html });
      return;
    }
    if (action === 'test') {
      if (!auth.email) { res.status(400).json({ ok: false, error: 'adresse de l\'admin inconnue' }); return; }
      const r = await S.envoyerTest({ sequence: String(body.sequence || ''), douleur: String(body.douleur || ''), chapitre: String(body.chapitre || ''), choisi: body.choisi === true, etape: Number(body.etape) || 1, vers: auth.email });
      res.status(r.ok ? 200 : 400).json(Object.assign({ vers: auth.email }, r));
      return;
    }
    if (action === 'reglage') {
      const ref = db.collection('_config').doc('parcours_rdv');
      const patch = { suites: {} };
      const champs = [];
      if (typeof body.actif === 'boolean') { patch.suites.actif = body.actif; champs.push('actif=' + body.actif); }
      if (body.plafondJour != null) {
        const n = Math.round(Number(body.plafondJour));
        if (!(n >= 1 && n <= 500)) { res.status(400).json({ ok: false, error: 'plafond entre 1 et 500' }); return; }
        patch.suites.plafondJour = n; champs.push('plafondJour=' + n);
      }
      if (body.off && typeof body.off === 'object') {
        patch.suites.off = {};
        const cles = Object.keys(body.off);
        for (let i = 0; i < cles.length; i++) {
          if (!RE_OFF.test(cles[i])) { res.status(400).json({ ok: false, error: 'clé inconnue : ' + cles[i] }); return; }
          patch.suites.off[cles[i]] = body.off[cles[i]] === true;
          champs.push((body.off[cles[i]] === true ? 'désactive ' : 'réactive ') + cles[i]);
        }
      }
      if (!champs.length) { res.status(400).json({ ok: false, error: 'rien à modifier' }); return; }
      patch.suitesHistorique = admin.firestore.FieldValue.arrayUnion({ at: Date.now(), par: par, champs: champs });
      await ref.set(patch, { merge: true });
      res.status(200).json({ ok: true, modifie: champs });
      return;
    }
    if (action === 'suite') {
      const r = await S.actionAdmin(body.id, String(body.quoi || ''), body.valeur, par);
      res.status(r.ok ? 200 : 400).json(r.ok ? r : { ok: false, error: r.erreur });
      return;
    }
    res.status(400).json({ ok: false, error: 'action inconnue' });
  } catch (e) {
    console.error('[parcours-suite-admin]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
