// ============================================================================
// api/ai-command.js — BARRE DE COMMANDE ⌘K (programme IA, Lot 5)
// ----------------------------------------------------------------------------
// Interprète une phrase libre (« ouvre la fiche de Martin », « note sur
// Dupont : rappelle jeudi », « va aux impayés ») en INTENTION. Rien ne
// s'exécute ici sans confirmation : l'interface montre la proposition, l'humain
// clique. Seule écriture possible : ajouter une note à un lead (action
// 'addNote', déclenchée par le clic de confirmation).
//
// POST Bearer <ID token> (admin / sales / csm / coach)
//   { action:'interpret', text, pages:[{label, href}] }
//     → { ok, intent:{ type, href?, leads?, note?, question? } }
//   { action:'addNote', leadId, text } (admin / sales) → note ajoutée
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db, admin } = require('./_firebaseAdmin');
const { callClaude, humanError, cap } = require('./_ai');
const { runTool } = require('./_aiTools');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'href', 'recherche', 'note', 'question'],
  properties: {
    type: { type: 'string', enum: ['naviguer', 'ouvrir_lead', 'note_lead', 'question', 'inconnu'] },
    href: { type: 'string', description: 'Pour naviguer : le href EXACT d\'une page de la liste, sinon vide' },
    recherche: { type: 'string', description: 'Pour ouvrir_lead / note_lead : nom, email ou téléphone du lead, sinon vide' },
    note: { type: 'string', description: 'Pour note_lead : le texte de la note, reformulé proprement, sinon vide' },
    question: { type: 'string', description: 'Pour question : la question sur les données, sinon vide' },
  },
};

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (['admin', 'sales', 'csm', 'coach'].indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  const body = parseBody(req);

  try {
    if (body.action === 'addNote') {
      if (auth.role !== 'admin' && auth.role !== 'sales') { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
      const text = String(body.text || '').trim().slice(0, 3000);
      const ref = db.collection('leads').doc(String(body.leadId || ''));
      const s = await ref.get();
      if (!text || !s.exists) { res.status(400).json({ ok: false, error: 'bad_request' }); return; }
      const now = new Date();
      const pad = function (n) { return String(n).padStart(2, '0'); };
      const p = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
      const date = pad(p.getDate()) + '/' + pad(p.getMonth() + 1) + '/' + p.getFullYear() + ' ' + pad(p.getHours()) + ':' + pad(p.getMinutes());
      const name = (auth.userData && (auth.userData.name || auth.userData.displayName || auth.userData.firstName)) || auth.email || '';
      await ref.update({
        notesHistory: admin.firestore.FieldValue.arrayUnion({ text: text, date: date, authorUid: auth.uid, authorName: name, via: 'cmdk' }),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
      res.status(200).json({ ok: true });
      return;
    }

    if (body.action !== 'interpret') { res.status(400).json({ ok: false, error: 'unknown_action' }); return; }
    const text = String(body.text || '').trim().slice(0, 500);
    if (!text) { res.status(400).json({ ok: false, error: 'empty' }); return; }
    const pages = (Array.isArray(body.pages) ? body.pages : []).slice(0, 80)
      .map(function (p) { return '- ' + cap(p.label, 60) + ' → ' + cap(p.href, 120); }).join('\n');

    const r = await callClaude({
      task: 'command',
      noContext: true,
      system: 'Tu interprètes une commande tapée dans la barre ⌘K du logiciel interne Alteore. Types : naviguer (aller sur une page de la liste), ouvrir_lead (ouvrir la fiche d\'un prospect), note_lead (ajouter une note à un prospect), question (question sur les chiffres / l\'activité), inconnu. Pour naviguer, choisis un href EXACT de la liste.',
      prompt: 'PAGES DISPONIBLES :\n' + pages + '\n\nCOMMANDE : ' + text,
      schema: SCHEMA,
      uid: auth.uid,
      ref: 'cmdk',
    });
    if (!r.ok) { res.status(200).json({ ok: false, error: r.error, message: humanError(r.error) }); return; }
    const intent = r.json || {};
    if ((intent.type === 'ouvrir_lead' || intent.type === 'note_lead') && intent.recherche && (auth.role === 'admin' || auth.role === 'sales')) {
      const found = await runTool('search_leads', { query: intent.recherche });
      intent.leads = (found.resultats || []).slice(0, 6).map(function (l) { return { id: l.id, nom: l.nom, statut: l.statut, telephone: l.telephone }; });
    }
    if (intent.type === 'question' && auth.role !== 'admin') intent.type = 'inconnu';
    res.status(200).json({ ok: true, intent: intent });
  } catch (e) {
    console.error('[ai-command]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
