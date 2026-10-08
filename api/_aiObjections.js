// ============================================================================
// api/_aiObjections.js — bibliothèque d'objections (programme IA, Lot 2)
// ----------------------------------------------------------------------------
// Les analyses IA (closing via Replay, setting via fin d'appel) détectent les
// objections du prospect. Chacune est enregistrée dans ai_objections/{id} :
//   { category, label, quote, response, worked, outcome, source, sourceId,
//     leadId, bookingId, who, at }
// id = <source>_<sourceId>_<index> → ré-analyser un appel REMPLACE ses
// objections au lieu de les dupliquer (idempotent).
//
// Catégories FIXES (pour pouvoir compter) : CATEGORIES ci-dessous. Le schéma
// JSON des tâches IA réutilise OBJECTION_ITEM_SCHEMA pour rester cohérent.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const CATEGORIES = {
  prix: 'Prix / budget',
  temps: 'Pas le temps',
  tiers: 'En parler au conjoint / associé',
  reflexion: 'Besoin de réfléchir',
  confiance: 'Confiance / légitimité',
  timing: 'Pas le bon moment',
  deja_essaye: 'Déjà essayé / mauvaise expérience',
  besoin: 'Pas convaincu du besoin',
  autonomie: 'Je peux le faire seul',
  autre: 'Autre',
};

const OBJECTION_ITEM_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['category', 'label', 'quote', 'response', 'worked'],
  properties: {
    category: { type: 'string', enum: Object.keys(CATEGORIES) },
    label: { type: 'string', description: 'Reformulation courte de l\'objection (8 mots max)' },
    quote: { type: 'string', description: 'Citation exacte du prospect, tirée de la transcription' },
    response: { type: 'string', description: 'Ce que le commercial a répondu (résumé fidèle), vide s\'il n\'a pas répondu' },
    worked: { type: 'boolean', description: 'La réponse a-t-elle levé l\'objection dans la suite de l\'échange ?' },
  },
};

/**
 * Remplace les objections d'une source par la nouvelle liste.
 * @param {Object} src { source:'closing'|'setting', sourceId, leadId?, bookingId?, who?, outcome? }
 * @param {Array} items sorties IA conformes à OBJECTION_ITEM_SCHEMA
 */
async function saveObjections(src, items) {
  const prefix = src.source + '_' + String(src.sourceId).replace(/[^A-Za-z0-9_-]/g, '_') + '_';
  const old = await db.collection('ai_objections').where('sourceKey', '==', prefix).get().catch(function () { return null; });
  const batch = db.batch();
  if (old) old.forEach(function (d) { batch.delete(d.ref); });
  (Array.isArray(items) ? items : []).slice(0, 15).forEach(function (o, i) {
    const cat = CATEGORIES[o.category] ? o.category : 'autre';
    batch.set(db.collection('ai_objections').doc(prefix + i), {
      sourceKey: prefix,
      category: cat,
      label: String(o.label || '').slice(0, 160),
      quote: String(o.quote || '').slice(0, 600),
      response: String(o.response || '').slice(0, 800),
      worked: o.worked === true,
      outcome: src.outcome || null,
      source: src.source,
      sourceId: String(src.sourceId),
      leadId: src.leadId || null,
      bookingId: src.bookingId || null,
      who: src.who || null,
      at: Date.now(),
    });
  });
  await batch.commit();
}

// Met à jour l'issue (close / non_close…) des objections d'un booking quand
// l'issue est saisie APRÈS l'analyse.
async function setOutcomeForBooking(bookingId, outcome) {
  if (!bookingId) return;
  const s = await db.collection('ai_objections').where('bookingId', '==', bookingId).get();
  if (s.empty) return;
  const batch = db.batch();
  s.forEach(function (d) { if (d.data().outcome !== outcome) batch.update(d.ref, { outcome: outcome || null }); });
  await batch.commit();
}

module.exports = { CATEGORIES: CATEGORIES, OBJECTION_ITEM_SCHEMA: OBJECTION_ITEM_SCHEMA, saveObjections: saveObjections, setOutcomeForBooking: setOutcomeForBooking };
