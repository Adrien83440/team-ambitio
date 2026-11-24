// ============================================================================
// api/parcours-suite.js — SÉQUENCES D'APRÈS-RDV (24/11/2026)
// ----------------------------------------------------------------------------
// Moteur : api/_parcoursSuite.js.
//   GET  (cron Vercel, Bearer CRON_SECRET)        → un passage (envois dus)
//   GET  ?dry=1                                   → simulation, rien envoyé
//   GET  ?apercu=1&sequence=&douleur=&etape=&choix=  → HTML d'un e-mail (exemple)
//   GET  ?action=etat | test | profil&json=…      → clé du chantier seulement
//        test   : { sequence, douleur, etape, choix } → envoie CET e-mail à
//                 l'adresse de test (_config/relances.testEmail), rien d'autre
//        profil : { leadId } → douleur + phrases miroir que la fiche donnerait
//                 (clés seulement, aucune donnée de la fiche)
// Rien ne part tant que _config/parcours_rdv.suites.actif n'est pas vrai, et
// seulement aux prospects de test tant que le parcours est en mode test.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');
const S = require('./_parcoursSuite');

function egal(a, b) {
  a = String(a || ''); b = String(b || '');
  if (!a || a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
function cleChantier(req) {
  const want = String(process.env.PARCOURS_AUDIT_KEY || '');
  if (want.length < 24) return false;
  return egal((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '', want);
}
function cron(req) {
  const s = process.env.CRON_SECRET || '';
  const a = String((req.headers && req.headers.authorization) || '');
  return !!s && a.indexOf('Bearer ') === 0 && egal(a.slice(7).trim(), s);
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method !== 'GET') { res.status(405).json({ ok: false, error: 'GET' }); return; }
    const q = req.query || {};
    const estCron = cron(req);
    const cle = cleChantier(req);
    if (!estCron && !cle) { res.status(401).json({ ok: false, error: 'Non autorisé' }); return; }

    if (cle && q.apercu) {
      const s = S.suiteFictive({ sequence: String(q.sequence || 'frein_tresorerie'), douleur: String(q.douleur || ''), chapitre: String(q.chapitre || ''), choisi: q.choisi === '1', email: 'exemple@exemple.fr' });
      const c = S.contenuDe(s, Number(q.etape) || 1);
      if (!c || c.erreur) { res.status(404).json({ ok: false, error: (c && c.erreur) || 'etape_inconnue' }); return; }
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.status(200).send(c.html);
      return;
    }
    if (cle && q.action) {
      let corps = {};
      try { corps = q.json ? JSON.parse(String(q.json)) : {}; } catch (e) { res.status(400).json({ ok: false, error: 'json illisible' }); return; }
      const action = String(q.action);
      if (action === 'etat') {
        const C = await S.lireConfig();
        const sim = await S.passage({ simulation: true });
        const snap = await db.collection(S.COL).get();
        const etats = {};
        snap.forEach(function (d) { const e = (d.data() || {}).etat || '∅'; etats[e] = (etats[e] || 0) + 1; });
        res.status(200).json({ ok: true, reglages: C.suites, modeTest: C.cfg.modeTest !== false, parcoursActif: C.cfg.actif === true, suites: etats, simulation: sim });
        return;
      }
      if (action === 'test') { res.status(200).json(await S.envoyerTest(corps)); return; }
      if (action === 'profil') {
        const ls = await db.collection('leads').doc(String(corps.leadId || '_')).get();
        if (!ls.exists) { res.status(404).json({ ok: false, error: 'fiche_introuvable' }); return; }
        const p = S.profilDe(ls.data() || {});
        res.status(200).json({ ok: true, douleur: p.douleur, miroirs: Object.keys(p.miroirs) });
        return;
      }
      res.status(400).json({ ok: false, error: 'action inconnue' });
      return;
    }
    const out = await S.passage({ simulation: !estCron || q.dry === '1' });
    res.status(200).json(out);
  } catch (e) {
    console.error('[parcours-suite]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
