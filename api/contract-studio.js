// ============================================================================
// api/contract-studio.js — ATELIER DE CONTRATS (admin)
// ----------------------------------------------------------------------------
// POST /api/contract-studio   Authorization: Bearer <jeton Firebase admin>
//   { action:'load',      templateId }                 → { template }
//   { action:'save',      templateId?, name, web, note } → { id, version }
//   { action:'versions',  templateId }                 → { versions:[…] }
//   { action:'version',   templateId, version }        → { web, name }
//   { action:'duplicate', templateId, name }           → { id }
//   { action:'preview',   web, prefill?, sample? }     → { pdf }  (base64)
//   { action:'ai',        web, instruction, sectionId? } → { proposal }
//   { action:'import',    pdfBase64, name }            → { web }  (brouillon)
//
// L'atelier édite le TEXTE d'un contrat (signature_templates/{id}.web,
// generated:true). Le PDF est composé à la demande par _contract-render.js.
//
// VERSIONS : chaque enregistrement crée signature_templates/{id}/versions/{n}
// (instantané complet, auteur, note). Une demande déjà envoyée garde le texte
// qu'elle a reçu (webSnapshot) : modifier un modèle ne touche jamais un
// contrat en cours de signature.
//
// CLAUDE PROPOSE, L'HUMAIN VALIDE (règle d'or de _ai.js) : « ai » et
// « import » ne renvoient que des propositions ; rien n'est enregistré tant
// qu'Adrien n'a pas accepté puis cliqué sur Enregistrer.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { callClaude } = require('./_ai');
const render = require('./_contract-render');

const KEY_RE = /^[A-Za-z0-9_]{1,40}$/;
const VAR_TYPES = { text: 1, number: 1, money: 1, date: 1, choice: 1 };

/* ── Validation du modèle de texte ───────────────────────────────────────── */
function cleanWeb(w) {
  const errs = [];
  w = w || {};
  const out = {
    generated: true,
    title: String(w.title || '').slice(0, 160),
    subtitle: String(w.subtitle || '').slice(0, 160),
    tagline: String(w.tagline || '').slice(0, 200),
    place: String(w.place || 'FAYENCE').slice(0, 60),
    sections: [], variables: [], clientChecks: [],
  };
  const ids = {};
  (Array.isArray(w.sections) ? w.sections : []).forEach(function (s, i) {
    let id = String((s && s.id) || ('s' + (i + 1))).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40) || ('s' + (i + 1));
    while (ids[id]) id += 'b';
    ids[id] = 1;
    const blocks = (Array.isArray(s.blocks) ? s.blocks : []).map(function (b) { return String(b || '').slice(0, 4000); })
      .filter(function (b) { return b.trim().length; });
    blocks.forEach(function (b) {
      const inner = b.replace(/^(if:[^:]+:)+/, '');
      if (!/^(p|h|li|ol|i|q|check):/.test(inner)) errs.push('Bloc sans type dans « ' + (s.title || id) + ' » : ' + b.slice(0, 50));
    });
    const sec = { id: id, title: String(s.title || '').slice(0, 200), blocks: blocks };
    if (s.signatures) sec.signatures = true;
    out.sections.push(sec);
  });
  const keys = {};
  (Array.isArray(w.variables) ? w.variables : []).forEach(function (v) {
    if (!v || !KEY_RE.test(String(v.key || ''))) { errs.push('Variable sans clé valide : ' + JSON.stringify(v && v.label)); return; }
    if (keys[v.key]) { errs.push('Variable en double : ' + v.key); return; }
    keys[v.key] = 1;
    const o = {
      key: v.key, label: String(v.label || v.key).slice(0, 160),
      type: VAR_TYPES[v.type] ? v.type : 'text',
      filledBy: v.filledBy === 'client' ? 'client' : 'equipe',
      required: v.required === true,
      requiredIf: String(v.requiredIf || '').slice(0, 120),
      help: String(v.help || '').slice(0, 240),
    };
    if (o.type === 'choice') {
      o.options = (Array.isArray(v.options) ? v.options : []).map(function (op) {
        return { value: String((op && op.value) || '').slice(0, 60), label: String((op && op.label) || (op && op.value) || '').slice(0, 200) };
      }).filter(function (op) { return op.value; });
      if (o.options.length < 2) errs.push('Le choix « ' + o.label + ' » doit avoir au moins 2 options.');
    }
    out.variables.push(o);
  });
  const cids = {};
  (Array.isArray(w.clientChecks) ? w.clientChecks : []).forEach(function (c) {
    if (!c || !KEY_RE.test(String(c.id || ''))) { errs.push('Case client sans identifiant valide.'); return; }
    if (cids[c.id]) return;
    cids[c.id] = 1;
    out.clientChecks.push({ id: c.id, label: String(c.label || '').slice(0, 600), required: c.required === true, kind: c.kind === 'renonciation' ? 'renonciation' : '' });
  });
  /* Références : toute variable ou case citée dans le texte doit exister. */
  out.sections.forEach(function (s) {
    s.blocks.forEach(function (b) {
      let m; const re = /\{\{var:([A-Za-z0-9_]+)\}\}/g;
      while ((m = re.exec(b))) if (!keys[m[1]]) errs.push('Variable inconnue {{var:' + m[1] + '}} dans « ' + s.title + ' »');
      const c = /(?:^|:)check:([A-Za-z0-9_]+)$/.exec(b.replace(/^(if:[^:]+:)+/, ''));
      if (c && !cids[c[1]]) errs.push('Case inconnue check:' + c[1] + ' dans « ' + s.title + ' »');
    });
  });
  if (!out.sections.length) errs.push('Le contrat ne contient aucun article.');
  if (!out.title) errs.push('Titre du contrat manquant.');
  return { web: out, errors: errs };
}

/* Le texte d'un modèle, converti si c'est un contrat « PDF tamponné ». */
function webOf(T) {
  if (T.web && T.web.generated) return T.web;
  if (T.web && Array.isArray(T.web.sections)) return render.legacyToGenerated(T.web, T.fields || []);
  return { generated: true, title: T.name || 'NOUVEAU CONTRAT', subtitle: '', tagline: '', place: 'FAYENCE', sections: [{ id: 'parties', title: 'ENTRE LES SOUSSIGNÉS', blocks: ['p:…'] }], variables: [], clientChecks: [] };
}

/* ── Consignes à Claude ──────────────────────────────────────────────────── */
const FORMAT_GUIDE = [
  'FORMAT DU CONTRAT (JSON) :',
  '- sections : liste d\'articles { id, title, blocks[] }. title en MAJUSCULES, ex. « ARTICLE 3 — DURÉE ». La section des signatures porte signatures:true et blocks:[] (le bloc de signatures est automatique).',
  '- blocks : une chaîne par bloc, préfixée : « p: » paragraphe, « h: » sous-titre (ex. « h:3.1. Prix »), « li: » puce, « ol: » élément numéroté (« ol:1. … »), « i: » mention en italique, « check:<id> » case que le client coche (définie dans clientChecks).',
  '- Bloc conditionnel : « if:<clé>=<valeur>:<bloc> » (présent seulement si la variable vaut cette valeur) ou « if:<clé>:<bloc> » (si renseignée). Ex. « if:formule=integral:p:Le prix est de **12 000 € HT**. »',
  '- Dans le texte : **gras** ; variables {{var:<clé>}} ; données du client remplies automatiquement : {{entreprise}} {{nom_prenom}} {{qualite}} {{siege_social}} {{siret}} {{forme_juridique}} {{email}} {{telephone}} {{date_signature}}.',
  '- variables : { key (lettres/chiffres/_), label, type: text|number|money|date|choice, options:[{value,label}] pour choice, filledBy: equipe (le conseiller avant l\'envoi : prix, formule, mensualités, dates…) | client, required, requiredIf (« clé=valeur »), help }.',
  '- clientChecks : { id, label (phrase exacte que le client coche), required, kind: "renonciation" pour une renonciation au délai de rétractation, sinon "" }.',
  'Le prestataire est toujours SARL Ambitio Corp (SIRET 94309870700012, 231B chemin de Mourre de Masque, 83440 Fayence), représentée par Emily Ughetto et Adrien François. Les clients sont exclusivement des sociétés (B2B).',
].join('\n');

const AI_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['summary', 'changes', 'variables', 'clientChecks', 'warnings'],
  properties: {
    summary: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    changes: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false,
        required: ['action', 'sectionId', 'afterSectionId', 'title', 'blocks', 'explanation'],
        properties: {
          action: { type: 'string', enum: ['update', 'add', 'delete'] },
          sectionId: { type: 'string' },
          afterSectionId: { type: 'string' },
          title: { type: 'string' },
          blocks: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
        },
      },
    },
    variables: { type: 'array', items: { $ref: '#/$defs/variable' } },
    clientChecks: { type: 'array', items: { $ref: '#/$defs/check' } },
  },
  $defs: {
    variable: {
      type: 'object', additionalProperties: false,
      required: ['key', 'label', 'type', 'options', 'filledBy', 'required', 'requiredIf', 'help'],
      properties: {
        key: { type: 'string' }, label: { type: 'string' },
        type: { type: 'string', enum: ['text', 'number', 'money', 'date', 'choice'] },
        options: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['value', 'label'], properties: { value: { type: 'string' }, label: { type: 'string' } } } },
        filledBy: { type: 'string', enum: ['equipe', 'client'] },
        required: { type: 'boolean' }, requiredIf: { type: 'string' }, help: { type: 'string' },
      },
    },
    check: {
      type: 'object', additionalProperties: false,
      required: ['id', 'label', 'required', 'kind'],
      properties: { id: { type: 'string' }, label: { type: 'string' }, required: { type: 'boolean' }, kind: { type: 'string', enum: ['renonciation', ''] } },
    },
  },
};

const IMPORT_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['title', 'subtitle', 'tagline', 'place', 'sections', 'variables', 'clientChecks', 'warnings'],
  properties: {
    title: { type: 'string' }, subtitle: { type: 'string' }, tagline: { type: 'string' }, place: { type: 'string' },
    warnings: { type: 'array', items: { type: 'string' } },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'title', 'blocks', 'signatures'],
        properties: { id: { type: 'string' }, title: { type: 'string' }, blocks: { type: 'array', items: { type: 'string' } }, signatures: { type: 'boolean' } },
      },
    },
    variables: { type: 'array', items: { $ref: '#/$defs/variable' } },
    clientChecks: { type: 'array', items: { $ref: '#/$defs/check' } },
  },
  $defs: AI_SCHEMA.$defs,
};

/* ── Handler ─────────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ error: 'Méthode non autorisée' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req) || {};
  const action = String(body.action || '');
  const who = auth.email || auth.uid || 'admin';

  try {
    if (action === 'load') {
      const snap = await db.collection('signature_templates').doc(String(body.templateId || '')).get();
      if (!snap.exists) { res.status(404).json({ error: 'Modèle introuvable.' }); return; }
      const T = snap.data() || {};
      res.status(200).json({ ok: true, template: {
        id: snap.id, name: T.name || '', generated: !!(T.web && T.web.generated),
        converted: !!(T.web && !T.web.generated), version: (T.web && T.web.version) || 0,
        web: webOf(T), hasPdf: !!(T.pdfBase64 || T.pages),
      } });
      return;
    }

    if (action === 'save') {
      const name = String(body.name || '').trim().slice(0, 120);
      if (!name) { res.status(400).json({ error: 'Donnez un nom au contrat.' }); return; }
      const c = cleanWeb(body.web);
      if (c.errors.length) { res.status(400).json({ error: 'Le contrat contient des erreurs.', details: c.errors }); return; }
      const col = db.collection('signature_templates');
      const ref = body.templateId ? col.doc(String(body.templateId)) : col.doc();
      const out = await db.runTransaction(async function (tx) {
        const s = await tx.get(ref);
        const T = s.exists ? (s.data() || {}) : null;
        const version = ((T && T.web && T.web.version) || 0) + 1;
        const web = Object.assign({}, c.web, { version: version, savedAt: new Date().toISOString(), savedBy: who });
        const data = { name: name, web: web, generated: true, updatedAt: admin.firestore.FieldValue.serverTimestamp() };
        if (!T) Object.assign(data, { createdAt: admin.firestore.FieldValue.serverTimestamp(), fields: [], pages: 0, isAdhoc: false, automationEnabled: false, automationWebhookUrl: '', automationNote: '', academyCourseId: '' });
        tx.set(ref, data, { merge: true });
        tx.set(ref.collection('versions').doc(String(version).padStart(4, '0')), {
          version: version, name: name, web: web, note: String(body.note || '').slice(0, 300), by: who,
          at: admin.firestore.FieldValue.serverTimestamp(), atIso: new Date().toISOString(),
        });
        return { id: ref.id, version: version };
      });
      res.status(200).json(Object.assign({ ok: true }, out));
      return;
    }

    if (action === 'versions') {
      const ref = db.collection('signature_templates').doc(String(body.templateId || ''));
      const snap = await ref.collection('versions').orderBy('version', 'desc').limit(40).get();
      const list = [];
      snap.forEach(function (d) { const v = d.data() || {}; list.push({ version: v.version, name: v.name, note: v.note || '', by: v.by || '', at: v.atIso || '' }); });
      res.status(200).json({ ok: true, versions: list });
      return;
    }

    if (action === 'version') {
      const ref = db.collection('signature_templates').doc(String(body.templateId || ''));
      const d = await ref.collection('versions').doc(String(body.version || '').padStart(4, '0')).get();
      if (!d.exists) { res.status(404).json({ error: 'Version introuvable.' }); return; }
      res.status(200).json({ ok: true, web: d.data().web, name: d.data().name });
      return;
    }

    if (action === 'duplicate') {
      const src = await db.collection('signature_templates').doc(String(body.templateId || '')).get();
      if (!src.exists) { res.status(404).json({ error: 'Modèle introuvable.' }); return; }
      const T = src.data() || {};
      const name = String(body.name || (T.name + ' (copie)')).trim().slice(0, 120);
      const web = Object.assign({}, webOf(T), { version: 1, savedAt: new Date().toISOString(), savedBy: who, duplicatedFrom: src.id });
      const ref = db.collection('signature_templates').doc();
      await ref.set({
        name: name, web: web, generated: true, fields: [], pages: 0, isAdhoc: false,
        automationEnabled: !!T.automationEnabled, automationWebhookUrl: T.automationWebhookUrl || '', automationNote: T.automationNote || '',
        academyCourseId: T.academyCourseId || '', academyCourseName: T.academyCourseName || '',
        createdAt: admin.firestore.FieldValue.serverTimestamp(), updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      await ref.collection('versions').doc('0001').set({ version: 1, name: name, web: web, note: 'Duplication de « ' + (T.name || src.id) + ' »', by: who, at: admin.firestore.FieldValue.serverTimestamp(), atIso: new Date().toISOString() });
      res.status(200).json({ ok: true, id: ref.id });
      return;
    }

    if (action === 'preview') {
      const c = cleanWeb(body.web);
      const sample = body.sample !== false;
      const prefill = body.prefill || {};
      const client = sample ? {
        entreprise: 'SOCIÉTÉ EXEMPLE SAS', nom_prenom: 'Camille Martin', qualite: 'Présidente',
        siege_social: '12 rue de la République, 83000 Toulon', siret: '12345678900012', forme_juridique: 'SAS',
        email: 'camille@exemple.fr', telephone: '+33 6 00 00 00 00', date_signature: new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }),
      } : {};
      const built = await render.composeContract({ web: c.web, prefill: prefill, client: client, checks: {}, signers: [], preview: true, blank: !sample });
      const bytes = Buffer.from(await built.doc.save());
      res.status(200).json({ ok: true, pdf: bytes.toString('base64'), pages: built.doc.getPageCount(), warnings: c.errors });
      return;
    }

    if (action === 'ai') {
      const instruction = String(body.instruction || '').trim().slice(0, 4000);
      if (!instruction) { res.status(400).json({ error: 'Écrivez une instruction.' }); return; }
      const c = cleanWeb(body.web);
      const focus = String(body.sectionId || '');
      const r = await callClaude({
        task: 'contract_edit', uid: auth.uid, ref: String(body.templateId || 'nouveau'), noContext: true, schema: AI_SCHEMA,
        system: 'Tu es juriste rédacteur pour SARL Ambitio Corp (coaching et accompagnement de dirigeants, clients 100 % sociétés). Tu modifies un contrat existant selon l\'instruction d\'Adrien, le dirigeant. Règles : français juridique clair et précis ; ne modifie QUE ce que l\'instruction demande ; garde mot pour mot tout le reste ; renvoie dans changes uniquement les articles modifiés, ajoutés ou supprimés (pour update/add : le titre et TOUS les blocs de l\'article après modification) ; renumérote les articles si tu en ajoutes ou supprimes (en renvoyant chaque article renuméroté) ; signale dans warnings tout risque juridique (clause abusive, droit de la consommation, rétractation, mentions obligatoires). Si tu ajoutes une variable ou une case, déclare-la dans variables / clientChecks (sinon tableaux vides).\n\n' + FORMAT_GUIDE,
        prompt: 'CONTRAT ACTUEL (JSON) :\n' + JSON.stringify(c.web) + (focus ? '\n\nARTICLE CIBLÉ : ' + focus : '') + '\n\nINSTRUCTION D\'ADRIEN :\n' + instruction,
      });
      if (!r.ok) { res.status(502).json({ error: 'Claude n\'a pas pu répondre (' + r.error + ').' }); return; }
      res.status(200).json({ ok: true, proposal: r.json, costUsd: r.costUsd || 0 });
      return;
    }

    if (action === 'import') {
      const b64 = String(body.pdfBase64 || '').replace(/^data:application\/pdf;base64,/, '');
      if (!b64 || b64.length > 4200000) { res.status(400).json({ error: 'PDF manquant ou trop volumineux (3 Mo maximum).' }); return; }
      const r = await callClaude({
        task: 'contract_import', uid: auth.uid, ref: 'import', noContext: true, schema: IMPORT_SCHEMA, maxTokens: 32000,
        system: 'Tu transformes un contrat PDF de SARL Ambitio Corp en modèle éditable. Recopie le texte MOT POUR MOT, sans rien reformuler ni corriger (coquilles comprises), article par article, dans l\'ordre de lecture. Repère tout ce qui doit être complété (pointillés, blancs, crochets, « Soit … mensualités », cases à cocher) : les infos de la société cliente deviennent les données automatiques ({{entreprise}}, {{nom_prenom}}, {{siege_social}}, {{siret}}…) ; les prix, formules, mensualités, dates de démarrage deviennent des variables remplies par l\'équipe ; une alternative (« au choix du CLIENT : A — ou B ») devient une variable choice avec des blocs conditionnels if: ; une case que le client doit cocher devient un clientChecks (kind "renonciation" si c\'est une renonciation à la rétractation). La section finale des signatures porte signatures:true et blocks:[]. Le lieu « Fait à … » va dans place. Signale dans warnings ce qui est ambigu.\n\n' + FORMAT_GUIDE,
        messages: [{ role: 'user', content: [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b64 } },
          { type: 'text', text: 'Nom souhaité pour ce modèle : ' + String(body.name || '').slice(0, 120) + '. Transforme ce contrat en modèle éditable selon le format.' },
        ] }],
      });
      if (!r.ok) { res.status(502).json({ error: 'Claude n\'a pas pu lire ce PDF (' + r.error + ').' }); return; }
      const c = cleanWeb(r.json);
      res.status(200).json({ ok: true, web: c.web, warnings: (r.json.warnings || []).concat(c.errors), costUsd: r.costUsd || 0 });
      return;
    }

    res.status(400).json({ error: 'Action inconnue.' });
  } catch (e) {
    console.error('[contract-studio]', action, e && e.stack ? e.stack : e);
    res.status(500).json({ error: 'Erreur serveur : ' + ((e && e.message) || 'inconnue') });
  }
};

module.exports.cleanWeb = cleanWeb;
module.exports.webOf = webOf;
