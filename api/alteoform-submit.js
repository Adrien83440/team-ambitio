// ============================================================================
// api/alteoform-submit.js
// ----------------------------------------------------------------------------
// Endpoint d'orchestration des soumissions AlteoForm côté CRM.
//
// URL  : POST https://team.alteore.com/api/alteoform-submit
// Auth : aucune — endpoint public (visiteur anonyme du formulaire)
// CORS : ouvert (formulaire embedded sur landing pages tierces)
//
// Body (JSON) :
//   {
//     formId   : "abc123",                              // requis
//     contact  : { prenom, nom, email, telephone },     // au moins email OU tel
//     answers  : { fld_xxx: value, fld_yyy: value }     // map brute du renderer
//   }
//
// Réponse 200 :
//   {
//     ok       : true,
//     action   : "updated" | "created" | "skipped",
//     leadId   : string|null,
//     assignedTo: string                                // pour booking routing
//   }
//
// POURQUOI cet endpoint existe (au lieu d'écrire côté frontend)
// -------------------------------------------------------------
// Les rules Firestore /leads/{id} interdisent l'update aux non-authentifiés
// (`allow update: if isSalesOrAdmin()`). Or les visiteurs qui remplissent un
// AlteoForm ne sont JAMAIS authentifiés en prod. L'écriture directe côté
// renderer marche uniquement quand un admin teste le form depuis sa session
// connectée — pour les vrais prospects, l'update échoue silencieusement.
// On délègue donc à cette Vercel Function qui utilise l'Admin SDK et bypass
// les rules. Bonus : on en profite pour câbler le pattern "résurrection"
// (lastOptinAt + timeline orange) qui faisait défaut au flux AlteoForm,
// et que Lead Live attendait déjà via startOptinResurrectListening.
//
// COMPORTEMENT
// ------------
// 1. Charge alteo_forms/{formId} pour récupérer settings + fields
// 2. Construit le tableau enrichi formAnswers depuis answers (map) + fields
// 3. Si !settings.createLead → action: "skipped" (pas de touche au CRM)
// 4. Cherche un lead existant par email lowercased puis phoneNormalized
//    (9 derniers digits, cohérent avec le reste du code)
// 5. EXISTANT → update avec lastOptinAt + timeline orange #fb923c +
//    notesHistory + formAnswers. Pose `_resurrectedOptin` côté Lead Live
//    via le listener startOptinResurrectListening qui écoute lastOptinAt.
//    Le tri Lead Live (effectiveTs = max(createdAt, lastOptinAt, ...))
//    fait remonter le lead en haut du flux automatiquement.
// 6. PAS D'EXISTANT et settings.createLeadIfMissing ON → création complète
//    équivalente à l'ancienne createFormLead côté frontend.
// 7. PAS D'EXISTANT et createLeadIfMissing OFF → action: "skipped".
//
// SÉCURITÉ
// --------
// - Validation business stricte : seul un formId existant en base est
//   accepté (sinon 404). Un attaquant ne peut pas forger un formId pour
//   créer/modifier des leads sur un form qui n'existe pas.
// - Champs limités : on n'écrit QUE les champs documentés ci-dessous.
//   Aucun moyen pour le payload de poser stage, assignedTo, _merged, etc.
// - phoneNormalized robuste : pas de matching trop laxiste qui pollerait
//   le CRM en cas de collision.
// - Pas de retour de données sensibles : l'endpoint répond avec {leadId,
//   assignedTo} uniquement. assignedTo est nécessaire pour le routing
//   booking et n'est pas considéré sensible.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

// 9 derniers digits — cohérent avec sales-leads.html telVariants() et
// l'ancienne _phoneNormalized() côté alteoforms-render.html.
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

// Format date FR pour timeline_history et notesHistory — cohérent avec
// le reste du code (ex: Cloud Function onWebhookInbox).
function dateNowFR() {
  return new Date().toLocaleString('fr-FR');
}

module.exports = async (req, res) => {
  // ── CORS — endpoint appelé depuis l'iframe AlteoForm qui est hébergée
  // sur team.alteore.com mais peut être embeddée sur n'importe quel
  // domaine tiers. La page elle-même tourne en team.alteore.com donc le
  // fetch est same-origin du point de vue iframe → CORS technique pas
  // strictement requis, mais on garde le pattern par cohérence et au cas
  // où on déciderait demain de servir le renderer depuis un CDN ou autre.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req);
  const formId = body.formId;
  const contact = body.contact || {};
  const answers = body.answers || {};

  if (!formId || typeof formId !== 'string') {
    res.status(400).json({ error: 'formId_required' });
    return;
  }
  if (typeof answers !== 'object' || Array.isArray(answers)) {
    res.status(400).json({ error: 'answers_must_be_object' });
    return;
  }

  // ── 1. Charge le formulaire (source de vérité serveur) ──────────────────
  let formData;
  try {
    const formDoc = await db.collection('alteo_forms').doc(formId).get();
    if (!formDoc.exists) {
      res.status(404).json({ error: 'form_not_found' });
      return;
    }
    formData = formDoc.data() || {};
  } catch (e) {
    console.error('[alteoform-submit] form fetch error:', e);
    res.status(500).json({ error: 'form_fetch_failed' });
    return;
  }

  const fields = formData.fields || [];
  const settings = formData.settings || {};
  const formTitle = formData.title || '';
  const fieldIndex = {}; // {fieldId: {label, type}}
  fields.forEach(f => {
    if (f && f.id) fieldIndex[f.id] = { label: f.label || '', type: f.type || 'text' };
  });

  // ── 2. Tableau enrichi formAnswers (même format que _buildAnswersArr) ──
  const formAnswersArr = [];
  Object.keys(answers).forEach(k => {
    const v = answers[k];
    if (v === '' || v == null) return;
    const meta = fieldIndex[k];
    if (meta && meta.label) {
      formAnswersArr.push({ fieldId: k, label: meta.label, type: meta.type || 'text', value: v });
    } else {
      // fieldId inconnu (form édité entre temps, champ supprimé) → on garde
      // l'ID brut comme libellé. Cohérent avec le filet d'affichage côté
      // sales-leads.html et le script de migration.
      formAnswersArr.push({ fieldId: k, label: k, type: 'text', value: v });
    }
  });

  // ── 3. Toggle createLead : si OFF, on ne touche jamais au CRM ─────────
  if (!settings.createLead) {
    res.status(200).json({ ok: true, action: 'skipped', leadId: null, assignedTo: '' });
    return;
  }

  const emailLc = (contact.email || '').trim().toLowerCase();
  const telRaw = (contact.telephone || '').replace(/\s+/g, '');
  const phoneNorm = phoneNormalized(telRaw);

  if (!emailLc && !phoneNorm) {
    // Pas de moyen d'identifier le prospect — on ne touche pas au CRM mais
    // on retourne ok pour que le flow front continue normalement vers
    // l'écran de remerciement ou la redirection booking.
    res.status(200).json({ ok: true, action: 'skipped', leadId: null, assignedTo: '' });
    return;
  }

  // ── 4. Match : email exact (lowercased) puis phoneNormalized ──────────
  // On exclut activement les leads mergés (_merged === true) pour ne pas
  // écrire sur des fantômes — le doc vivant est référencé via _mergedInto.
  // Limit(5) pour avoir une marge si plusieurs docs partagent l'email
  // (cas typique : ancien doc fusionné + nouveau doc actif).
  function pickAlive(snap) {
    if (snap.empty) return null;
    for (const d of snap.docs) {
      if (d.data()._merged !== true) return d;
    }
    return null;
  }

  let existing = null;
  try {
    if (emailLc) {
      const sn = await db.collection('leads').where('email', '==', emailLc).limit(5).get();
      existing = pickAlive(sn);
    }
    if (!existing && phoneNorm) {
      const sn = await db.collection('leads').where('phoneNormalized', '==', phoneNorm).limit(5).get();
      existing = pickAlive(sn);
    }
  } catch (e) {
    console.error('[alteoform-submit] lead search error:', e);
    res.status(500).json({ error: 'search_failed' });
    return;
  }

  // ── 5. EXISTANT → update + résurrection ───────────────────────────────
  if (existing) {
    const noteTxt = '🔄 Re-soumission formulaire' + (formTitle ? ' : ' + formTitle : '');
    const dateFR = dateNowFR();
    const update = {
      formId,
      formTitle,
      formAnswers: formAnswersArr,
      formSubmittedAt: new Date().toISOString(),
      // Déclencheur de la résurrection côté Lead Live
      // (startOptinResurrectListening écoute ce champ).
      lastOptinAt: admin.firestore.FieldValue.serverTimestamp(),
      // Timeline orange #fb923c — cohérent avec le pattern webhook.
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: noteTxt,
        date: dateFR,
        color: '#fb923c'
      }),
      // notesHistory pour la traçabilité dans la fiche détail.
      notesHistory: admin.firestore.FieldValue.arrayUnion({
        text: noteTxt,
        date: dateFR
      }),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };
    try {
      await existing.ref.update(update);
    } catch (e) {
      console.error('[alteoform-submit] update error:', e);
      res.status(500).json({ error: 'update_failed' });
      return;
    }
    const ld = existing.data() || {};
    res.status(200).json({
      ok: true,
      action: 'updated',
      leadId: existing.id,
      assignedTo: ld.assignedTo || ''
    });
    return;
  }

  // ── 6. PAS D'EXISTANT — création seulement si createLeadIfMissing ─────
  if (!settings.createLeadIfMissing) {
    res.status(200).json({ ok: true, action: 'skipped', leadId: null, assignedTo: '' });
    return;
  }

  const prenom = (contact.prenom || '').trim();
  const nomBrut = (contact.nom || '').trim();
  let fullName = (prenom + ' ' + nomBrut).trim();
  if (!fullName) fullName = emailLc || telRaw || 'Sans nom';

  const noteTxt = '📝 Lead créé via formulaire' + (formTitle ? ' : ' + formTitle : '');
  const dateFR = dateNowFR();

  const newLead = {
    nom: fullName,
    email: emailLc,
    telephone: telRaw,
    phoneNormalized: phoneNorm,
    type: 'alteoform',
    source: 'alteoform',
    sourceDetail: formTitle,
    stage: 'lead',
    status: 'nouveau',
    assignedTo: '',
    utm: 'AlteoForm' + (formTitle ? ' - ' + formTitle : ''),
    formId,
    formTitle,
    formAnswers: formAnswersArr,
    formSubmittedAt: new Date().toISOString(),
    tags: [],
    notesHistory: [{ text: noteTxt, date: dateFR }],
    timeline_history: [{ text: '✨ ' + noteTxt, date: dateFR, color: '#f59e0b' }],
    communications: [],
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    const ref = await db.collection('leads').add(newLead);
    res.status(200).json({ ok: true, action: 'created', leadId: ref.id, assignedTo: '' });
  } catch (e) {
    console.error('[alteoform-submit] create error:', e);
    res.status(500).json({ error: 'create_failed' });
  }
};
