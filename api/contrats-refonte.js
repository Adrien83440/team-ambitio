// ============================================================================
// api/contrats-refonte.js — REFONTE DES CONTRATS D'INDÉPENDANTS (24/11/2026)
// (demande d'Adrien après la relecture « requalification en salariat » :
//  « rédige les clauses corrigées et refais les modèles »)
// ----------------------------------------------------------------------------
// Pose dans `signature_templates` les sept modèles de api/_contrats-refonte-data.js
// (copie des JSON de scripts/data/contrats-atelier/) :
//   · modèle EXISTANT (Full Cycle, Full Cycle — Canada, Marine) → NOUVELLE
//     VERSION, comme un enregistrement de l'Atelier ; l'ancienne reste dans la
//     sous-collection versions. Refusé si le modèle a changé depuis la relecture
//     (version attendue) : on relit avant d'écraser le travail de quelqu'un.
//   · modèle NOUVEAU (setting téléphonique, setting écrit, coach Elite Phénix,
//     coach Business Phénix) → créé, audience admin. Les anciens PDF importés
//     restent en base, intacts.
//
//   GET            → À BLANC : ce qui serait fait, rien d'écrit
//   GET ?apply=1   → écrit
//
// Rien n'est supprimé. Clé : en-tête `x-audit-key` = variable Vercel
// CONTRATS_AUDIT_KEY (preview de la branche) ; absente → 404. Route temporaire.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const studio = require('./contract-studio');
const DATA = require('./_contrats-refonte-data');

/* Version du modèle au moment de la relecture (23/11/2026, après le passage en SAS). */
const ATTENDU = { '5ji06Vk86eXGcLdkXQ5b': 2, 'full-cycle-canada': 2, 'TiSsuFgNni218AC9n1bd': 3 };
const NOTE = 'Refonte « indépendance » (24/11/2026) : plus d’heures ni de temps de travail, niveaux de service convenus, pas de pouvoir hiérarchique, phase de démarrage, révisions par avenant, clauses pénales et non-concurrence ramenées.';

function keyOk(req) {
  const want = String(process.env.CONTRATS_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).end('Not found'); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET seulement' }); return; }
  const apply = String((req.query && req.query.apply) || '') === '1';
  const nowIso = new Date().toISOString();
  const TS = admin.firestore.FieldValue.serverTimestamp();
  const report = { mode: apply ? 'APPLIQUÉ' : 'À BLANC — rien écrit', at: nowIso, modeles: [] };
  try {
    const keys = Object.keys(DATA);
    for (let i = 0; i < keys.length; i++) {
      const M = DATA[keys[i]];
      const c = studio.cleanWeb(M.web);
      const line = { cle: keys[i], id: M.templateId, nom: M.templateName, articles: c.web.sections.length, variables: c.web.variables.length, signataire: c.web.roleSignataire || '' };
      if (c.errors.length) { line.action = 'REFUSÉ : modèle invalide'; line.erreurs = c.errors.slice(0, 5); report.modeles.push(line); continue; }
      const ref = db.collection('signature_templates').doc(M.templateId);
      const out = await db.runTransaction(async function (tx) {
        const s = await tx.get(ref);
        if (!s.exists) {
          if (ATTENDU[M.templateId]) return { action: 'REFUSÉ : modèle attendu introuvable' };
          if (!apply) return { action: 'création', version: 1 };
          const web = Object.assign({}, c.web, { version: 1, savedAt: nowIso, savedBy: 'contrats-refonte' });
          tx.set(ref, { name: M.templateName, web: web, generated: true, fields: [], pages: 0, isAdhoc: false, audience: 'admin',
            automationEnabled: false, automationWebhookUrl: '', automationNote: '', academyCourseId: '', createdAt: TS, updatedAt: TS });
          tx.set(ref.collection('versions').doc('0001'), { version: 1, name: M.templateName, web: web, note: NOTE, by: 'contrats-refonte', at: TS, atIso: nowIso });
          return { action: 'créé', version: 1 };
        }
        const T = s.data() || {};
        const cur = (T.web && T.web.version) || 0;
        if (T.web && T.web.savedBy === 'contrats-refonte' && JSON.stringify(studio.cleanWeb(T.web).web) === JSON.stringify(c.web)) return { action: 'déjà à jour', version: cur };
        if (!ATTENDU[M.templateId]) return { action: 'REFUSÉ : un modèle porte déjà cet identifiant', version: cur };
        if (cur !== ATTENDU[M.templateId] && !(T.web && T.web.savedBy === 'contrats-refonte')) return { action: 'REFUSÉ : modèle modifié depuis la relecture (version ' + cur + ', attendue ' + ATTENDU[M.templateId] + ')', version: cur };
        if (!apply) return { action: 'nouvelle version', de: cur, vers: cur + 1 };
        const version = cur + 1;
        const web = Object.assign({}, c.web, { version: version, savedAt: nowIso, savedBy: 'contrats-refonte' });
        const prev = ref.collection('versions').doc(String(cur).padStart(4, '0'));
        const p = await tx.get(prev);
        if (!p.exists) tx.set(prev, { version: cur, name: T.name || '', web: T.web, note: 'Version d’avant la refonte (sauvegarde automatique)', by: 'contrats-refonte', at: TS, atIso: nowIso });
        tx.set(ref, { web: web, generated: true, updatedAt: TS }, { merge: true });
        tx.set(ref.collection('versions').doc(String(version).padStart(4, '0')), { version: version, name: T.name || M.templateName, web: web, note: NOTE, by: 'contrats-refonte', at: TS, atIso: nowIso });
        return { action: 'nouvelle version écrite', de: cur, vers: version };
      });
      report.modeles.push(Object.assign(line, out));
    }
    if (apply) await db.collection('sas_migration_log').doc('refonte-' + nowIso.replace(/[:.]/g, '-')).set({ at: nowIso, by: 'contrats-refonte', modeles: report.modeles });
    res.status(200).json(report);
  } catch (e) {
    console.error('[contrats-refonte]', e);
    res.status(500).json({ error: String((e && e.message) || e), partiel: report });
  }
};
