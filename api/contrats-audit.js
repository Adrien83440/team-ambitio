// ============================================================================
// api/contrats-audit.js — RELECTURE DES MODÈLES DE CONTRAT, LECTURE SEULE
// (23/11/2026, demande d'Adrien : relire les contrats des indépendants de
// l'équipe — closers, setters, freelances — contre le risque de requalification)
// ----------------------------------------------------------------------------
// N'ÉCRIT RIEN. Renvoie la liste des modèles de `signature_templates` et, pour
// un modèle demandé, son texte. E-mails, téléphones et longues suites de
// chiffres (SIRET, IBAN…) sont masqués en sortie.
//
//   GET                → liste : id, nom, ponctuel ou non, généré ou PDF, date
//   GET ?id=<id>       → texte complet du modèle (sections et blocs)
//   GET ?id=<id>&pdf=1 → PDF d'origine d'un modèle importé (base64)
//
// Clé : en-tête `x-audit-key` égal à la variable Vercel CONTRATS_AUDIT_KEY
// (preview de la branche, jamais dans le dépôt) ; absente ou fausse → 404.
// Route temporaire : à retirer après la relecture.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');

function keyOk(req) {
  const want = String(process.env.CONTRATS_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function mask(s) {
  return String(s)
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[e-mail]')
    .replace(/(?:\+|00)\d[\d .-]{8,}\d/g, '[téléphone]')
    .replace(/\b0\d(?:[ .-]?\d{2}){4}\b/g, '[téléphone]')
    .replace(/\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,}(?: ?[A-Z0-9]{1,4})?\b/g, '[IBAN]');
}
function iso(v) {
  if (!v) return null;
  if (typeof v.toDate === 'function') return v.toDate().toISOString();
  return String(v);
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).end('Not found'); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET seulement' }); return; }
  try {
    const id = String((req.query && req.query.id) || '');
    if (!id) {
      const snap = await db.collection('signature_templates').get();
      const list = [];
      snap.forEach(function (d) {
        const T = d.data() || {};
        const hasWeb = !!(T.web && Array.isArray(T.web.sections));
        let chars = 0;
        if (hasWeb) T.web.sections.forEach(function (s) { (s.blocks || []).forEach(function (b) { chars += String(b).length; }); });
        list.push({
          id: d.id, nom: mask(T.name || ''), ponctuel: !!T.isAdhoc, audience: T.audience || '',
          genere: !!(hasWeb && T.web.generated), copieTexte: hasWeb, pagesPdf: T.pages || 0,
          articles: hasWeb ? T.web.sections.length : 0, caracteres: chars, version: hasWeb ? (T.web.version || 0) : null,
          titre: hasWeb ? mask(T.web.title || '') : '', majLe: iso(T.updatedAt), creeLe: iso(T.createdAt),
        });
      });
      res.status(200).json({ total: list.length, modeles: list });
      return;
    }
    const ref = db.collection('signature_templates').doc(id);
    const snap = await ref.get();
    if (!snap.exists) { res.status(404).json({ error: 'Modèle introuvable' }); return; }
    const T = snap.data() || {};
    if (String((req.query && req.query.pdf) || '') === '1') {
      const ch = await ref.collection('pdf').orderBy('chunk').get();
      let b64 = '';
      ch.forEach(function (d) { b64 += String((d.data() || {}).data || (d.data() || {}).b64 || (d.data() || {}).content || ''); });
      if (!b64 && T.pdfBase64) b64 = String(T.pdfBase64);
      res.status(200).json({ id: id, morceaux: ch.size, champs: ch.size ? Object.keys(ch.docs[0].data() || {}) : [], pdfBase64: b64 });
      return;
    }
    const web = T.web || {};
    res.status(200).json({
      id: id, nom: mask(T.name || ''), ponctuel: !!T.isAdhoc, genere: !!web.generated, version: web.version || 0,
      titre: mask(web.title || ''), sousTitre: mask(web.subtitle || ''),
      variables: (web.variables || []).map(function (v) { return { key: v.key, label: v.label, type: v.type, filledBy: v.filledBy, options: (v.options || []).map(function (o) { return o.label; }) }; }),
      sections: (web.sections || []).map(function (s) { return { titre: s.title || '', blocs: (s.blocks || []).map(mask) }; }),
    });
  } catch (e) {
    console.error('[contrats-audit]', e);
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
