// ============================================================================
// api/scoring.js — MODULE SCORING DES SOCIÉTÉS (30/10/2026)
// ----------------------------------------------------------------------------
// Relié à l'API Societe.com (api/_societeCom.js). Deux publics :
//
//   ADMINS  : page admin-scoring.html. Tout le catalogue de l'API, au choix, et
//             les documents officiels, quand ils veulent, sans validation.
//   CLOSERS : la solvabilité, et rien d'autre, sur demande validée par un admin.
//             Le bouton est sur la fiche en phase de closing (alteore-scoring.js).
//             La demande part par e-mail à tous les admins actifs et en pop-up ;
//             le premier qui répond décide.
//
// Le feu (rouge, orange, vert, gris) est NOTRE règle : api/_scoringVerdict.js.
//
// Coûts : voir CATALOGUE. Tout ce qui a été payé est gardé. Une étude reste
// valable 30 jours pour la même société ; une donnée ou un document acheté se
// rouvre gratuitement. « Actualiser » (force) repaye, admin uniquement.
//
// Données (Admin SDK uniquement : aucune règle Firestore, donc aucun accès
// direct depuis le navigateur — refus par défaut) :
//   scoring_societes/{siren}                 { nom, solvabilite, updatedAt }
//   scoring_societes/{siren}/donnees/{item}  { data, at, par }
//   scoring_societes/{siren}/documents/{cle} { titre, chemin, type, taille, at, par }
//   scoring_demandes/{id}                    la demande du closer et sa réponse
//   scoring_journal/{id}                     qui a dépensé quoi
// Fichiers : Storage scoring/{siren}/{cle}.{ext}.
//
// GET  ?action=etat | societe&siren= | lead&leadId= | notifs
// POST { action: recherche | demander | decider | solvabilite | charger |
//        documents | telecharger | ouvrir | mandats | vu, … }
// Réponses : { ok:true, … } ou { ok:false, error, detail? }.
// ============================================================================

const { admin, db, storage } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { requireAuth } = require('./_verifyFirebaseAuth');
const { sendEmailFromAccount } = require('./_gmailSend');
const company = require('./_companyLookup');
const societe = require('./_societeCom');
const verdict = require('./_scoringVerdict');

const VALIDITE_ETUDE_MS = 30 * 24 * 3600 * 1000;
const VERROU_DECISION_MS = 2 * 60 * 1000;
const LIEN_URL_MS = 60 * 60 * 1000;
const TAILLE_MAX_DONNEE = 900000;
const ADMIN_SECOURS = 'contact@adrienemily.com';
const COMPTES_ENVOI = ['contact', 'coaching', 'strategie'];
const SITE = 'https://team.alteore.com';
const ROLES_CLOSER = { closer: 1, closer_setter: 1, closing: 1 };

function maintenant() { return new Date().toISOString(); }
function texte(v, max) { return String(v === null || v === undefined ? '' : v).trim().slice(0, max || 200); }
function html(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function repondre(res, status, corps) { res.status(status).json(corps); }

function echec(res, e) {
  const status = (e && e.status) || 500;
  if (status >= 500) console.error('[scoring]', e && (e.stack || e.message));
  repondre(res, status, { ok: false, error: (e && e.code) || 'server_error', detail: e && e.code ? e.message : undefined });
}

/* ── Équipe ─────────────────────────────────────────────────────────────── */

async function equipe() {
  const s = await db.collection('_meta').doc('team_members').get();
  const raw = s.exists ? (s.data() || {}).members : null;
  return (Array.isArray(raw) ? raw : Object.values(raw || {})).filter(function (m) {
    return m && m.active !== false && !m.archivedAt && !m.departed;
  });
}

function nomDe(auth, membre) {
  return (membre && (membre.fullName || membre.shortName)) || (auth.userData || {}).displayName || auth.email || 'Équipe';
}

/* Admin, ou closer / closer-setter du roster. Le rôle Firebase « sales » ne
   suffit pas : il couvre aussi les setters. */
async function droits(auth) {
  const liste = await equipe();
  const membre = liste.filter(function (m) { return m.firebaseUid === auth.uid; })[0] || null;
  const estAdmin = auth.role === 'admin';
  return { admin: estAdmin, closer: !!(membre && ROLES_CLOSER[membre.role]), membre: membre, equipe: liste };
}

function emailsAdmins(liste) {
  const out = [];
  liste.forEach(function (m) {
    if (m.role === 'admin' && m.email && out.indexOf(m.email) < 0) out.push(m.email);
  });
  return out.length ? out : [ADMIN_SECOURS];
}

/* ── Journal et solde ───────────────────────────────────────────────────── */

async function journal(type, info, parNom, parUid) {
  await db.collection('scoring_journal').add(Object.assign({ at: maintenant(), type: type, par: parNom, parUid: parUid }, info));
}

async function soldeOuNull() {
  try { return (await societe.solde()).credits; } catch (e) { return null; }
}

/* ── Identité de la société ─────────────────────────────────────────────── */

async function annuaireDe(siren) {
  try { return await company.lookupByIdentifier(siren); }
  catch (e) { console.warn('[scoring] annuaire', e && e.message); return null; }
}

/* ── L'étude de solvabilité ─────────────────────────────────────────────── */

function etudeValide(s) {
  return !!(s && s.at && Date.now() - Date.parse(s.at) < VALIDITE_ETUDE_MS);
}

async function lancerEtude(siren, nomDonne, force, parNom, parUid) {
  const ref = db.collection('scoring_societes').doc(siren);
  const snap = await ref.get();
  const existant = snap.exists ? (snap.data() || {}) : {};
  if (!force && etudeValide(existant.solvabilite)) return { etude: existant.solvabilite, nom: existant.nom || nomDonne, cache: true };

  const annuaire = await annuaireDe(siren);
  const nom = (annuaire && annuaire.name) || nomDonne || existant.nom || siren;

  /* Une société inconnue s'arrête là : les trois autres appels seraient payés
     pour rien. */
  const exist = await societe.donnee(siren, 'exist');
  let credits = 0.2;
  let trio = [{ data: null }, { data: null }, { data: null }];
  if (!exist.vide) {
    trio = await Promise.all([
      societe.donnee(siren, 'scoring'),
      societe.donnee(siren, 'procedurescollectives'),
      societe.donnee(siren, 'bilans'),
    ]);
    credits += (trio[0].vide ? 0 : 0.5) + (trio[1].vide ? 0 : 2) + (trio[2].vide ? 0 : 2);
  }

  const etude = verdict.calculer({
    existence: exist.data, scoring: trio[0].data, procedures: trio[1].data, bilans: trio[2].data, annuaire: annuaire,
  });
  etude.at = maintenant();
  etude.par = parNom;

  await ref.set({ siren: siren, nom: nom, solvabilite: etude, updatedAt: etude.at }, { merge: true });
  await journal('solvabilite', { siren: siren, nom: nom, credits: credits, niveau: etude.niveau }, parNom, parUid);
  return { etude: etude, nom: nom, cache: false, credits: credits };
}

/* ── Demandes des closers ───────────────────────────────────────────────── */

function demandePublique(id, d) {
  return {
    id: id, leadId: d.leadId || '', leadNom: d.leadNom || '', siren: d.siren, nom: d.nom,
    note: d.note || '', statut: d.statut, origine: d.origine || 'closer',
    demandeurNom: d.demandeurNom || '', demandeAt: d.demandeAt || '',
    decideurNom: d.decideurNom || '', decideAt: d.decideAt || '', motif: d.motif || '',
    erreur: d.erreur || '', resultat: d.resultat || null, vu: d.vu === true,
  };
}

async function envoyerDemande(id, d, destinataires) {
  const lien = SITE + '/admin-scoring.html?demande=' + encodeURIComponent(id);
  const sujet = '🔎 Solvabilité à valider : ' + d.nom;
  const lignes = [
    '<b>' + html(d.demandeurNom) + '</b> demande une étude de solvabilité.',
    'Société : <b>' + html(d.nom) + '</b> (SIREN ' + html(d.siren) + ')',
    d.leadNom ? 'Prospect : ' + html(d.leadNom) : '',
    d.note ? 'Sa remarque : ' + html(d.note) : '',
    '<a href="' + html(lien) + '" style="display:inline-block;padding:10px 16px;border-radius:9px;background:#6d5efc;color:#fff;font-weight:700;text-decoration:none">Valider ou refuser</a>',
  ].filter(Boolean);
  const bodyHtml = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">'
    + lignes.map(function (x) { return '<p style="margin:0 0 10px">' + x + '</p>'; }).join('') + '</div>';
  for (let i = 0; i < COMPTES_ENVOI.length; i++) {
    try {
      await sendEmailFromAccount({
        accountKey: COMPTES_ENVOI[i], to: destinataires[0], cc: destinataires.slice(1).join(', ') || undefined,
        subject: sujet, bodyHtml: bodyHtml, bodyText: lignes.join('\n').replace(/<[^>]+>/g, '') + '\n' + lien,
      });
      return true;
    } catch (e) { console.warn('[scoring] e-mail via ' + COMPTES_ENVOI[i], e && e.message); }
  }
  return false;
}

async function derniereDemandeDuLead(leadId) {
  const s = await db.collection('scoring_demandes').where('leadId', '==', leadId).get();
  const liste = s.docs.map(function (x) { return demandePublique(x.id, x.data() || {}); });
  liste.sort(function (a, b) { return String(b.demandeAt).localeCompare(String(a.demandeAt)); });
  return liste[0] || null;
}

/* La société du dernier contrat du lead, s'il y en a un : le client la choisit
   dans l'annuaire en signant. Avant ça, le closer la cherche lui-même. */
async function societeDuContrat(leadId) {
  try {
    const s = await db.collection('signature_requests').where('leadId', '==', leadId).get();
    const docs = s.docs.map(function (x) { return x.data() || {}; }).filter(function (d) {
      return d.status !== 'cancelled' && d.company && (d.company.siret || d.company.siren);
    });
    const c = docs.length ? docs[docs.length - 1].company : null;
    if (!c || c.country === 'CA') return null;
    return { siren: String(c.siren || String(c.siret).slice(0, 9)), nom: String(c.name || '') };
  } catch (e) { console.warn('[scoring] contrat', e && e.message); return null; }
}

async function actionDemander(body, auth, d) {
  if (!d.admin && !d.closer) return { status: 403, corps: { ok: false, error: 'forbidden' } };
  const leadId = texte(body.leadId, 120);
  if (!leadId || leadId.indexOf('/') >= 0) return { status: 400, corps: { ok: false, error: 'bad_request' } };
  const siren = societe.sirenDe(body.siren);
  if (!company.sirenValid(siren)) return { status: 400, corps: { ok: false, error: 'siren_invalide', detail: 'Ce numéro n\'existe pas (clé de contrôle fausse).' } };

  const leadSnap = await db.collection('leads').doc(leadId).get();
  if (!leadSnap.exists) return { status: 404, corps: { ok: false, error: 'lead_introuvable' } };

  /* Double clic, ou deux closers sur la même fiche : une seule demande. */
  const courante = await derniereDemandeDuLead(leadId);
  if (courante && courante.statut === 'attente') return { status: 200, corps: { ok: true, demande: courante, deja: true } };

  const doc = {
    leadId: leadId, leadNom: texte((leadSnap.data() || {}).nom, 120), siren: siren, nom: texte(body.nom, 160) || siren,
    note: texte(body.note, 500), statut: 'attente', origine: 'closer',
    demandeurUid: auth.uid, demandeurNom: nomDe(auth, d.membre), demandeAt: maintenant(), vu: false,
  };
  const ref = await db.collection('scoring_demandes').add(doc);
  const envoye = await envoyerDemande(ref.id, doc, emailsAdmins(d.equipe));
  await ref.update({ emailEnvoye: envoye });
  return { status: 200, corps: { ok: true, demande: demandePublique(ref.id, doc), emailEnvoye: envoye } };
}

async function actionDecider(body, auth, d) {
  const id = texte(body.id, 60);
  if (!id || id.indexOf('/') >= 0) return { status: 400, corps: { ok: false, error: 'bad_request' } };
  const accord = body.accord === true;
  const ref = db.collection('scoring_demandes').doc(id);
  const parNom = nomDe(auth, d.membre);

  /* Le premier admin qui répond décide. Le verrou de 2 minutes rattrape une
     fonction coupée en pleine étude. */
  const prise = await db.runTransaction(async function (t) {
    const s = await t.get(ref);
    if (!s.exists) return { absent: true };
    const x = s.data() || {};
    const libre = x.statut === 'attente'
      || (x.statut === 'en_cours' && Date.now() - Date.parse(x.traiteAt || 0) > VERROU_DECISION_MS);
    if (!libre) return { deja: x };
    const maj = { decideurUid: auth.uid, decideurNom: parNom, decideAt: maintenant(), motif: texte(body.motif, 500), erreur: admin.firestore.FieldValue.delete() };
    if (accord) { maj.statut = 'en_cours'; maj.traiteAt = maintenant(); } else { maj.statut = 'refusee'; }
    t.update(ref, maj);
    return { doc: x };
  });

  if (prise.absent) return { status: 404, corps: { ok: false, error: 'demande_introuvable' } };
  if (prise.deja) return { status: 409, corps: { ok: false, error: 'deja_traitee', demande: demandePublique(id, prise.deja) } };

  if (!accord) {
    await journal('refus', { siren: prise.doc.siren, nom: prise.doc.nom, credits: 0 }, parNom, auth.uid);
    const s = await ref.get();
    return { status: 200, corps: { ok: true, demande: demandePublique(id, s.data() || {}) } };
  }

  try {
    const r = await lancerEtude(prise.doc.siren, prise.doc.nom, false, parNom, auth.uid);
    await ref.update({ statut: 'acceptee', resultat: r.etude, nom: r.nom, vu: false });
    const s = await ref.get();
    return { status: 200, corps: { ok: true, demande: demandePublique(id, s.data() || {}), solde: await soldeOuNull() } };
  } catch (e) {
    await ref.update({ statut: 'attente', erreur: e.message || 'Étude impossible', traiteAt: admin.firestore.FieldValue.delete() });
    throw e;
  }
}

/* ── Catalogue admin ────────────────────────────────────────────────────── */

async function actionCharger(body, auth, d) {
  const siren = societe.sirenDe(body.siren);
  const ids = (Array.isArray(body.items) ? body.items : []).filter(function (x) { return societe.element(x); }).slice(0, 20);
  if (!ids.length) return { status: 400, corps: { ok: false, error: 'bad_request' } };
  const parNom = nomDe(auth, d.membre);
  const parent = db.collection('scoring_societes').doc(siren);
  const force = body.force === true;
  const resultats = {};
  let credits = 0;

  for (let i = 0; i < ids.length; i++) {
    const id = ids[i];
    const ref = parent.collection('donnees').doc(id);
    if (!force) {
      const s = await ref.get();
      if (s.exists) { resultats[id] = Object.assign({ ok: true, cache: true }, s.data()); continue; }
    }
    try {
      const r = await societe.donnee(siren, id);
      if (r.vide) { resultats[id] = { ok: true, vide: true, at: maintenant() }; continue; }
      const at = maintenant();
      const cout = societe.element(id).cout;
      credits += cout;
      resultats[id] = { ok: true, data: r.data, at: at, par: parNom };
      if (JSON.stringify(r.data).length < TAILLE_MAX_DONNEE) await ref.set({ data: r.data, at: at, par: parNom });
      await journal('donnee', { siren: siren, nom: texte(body.nom, 160), item: id, credits: cout }, parNom, auth.uid);
    } catch (e) {
      if (e.code === 'credits_epuises') { resultats[id] = { ok: false, error: e.code, detail: e.message }; break; }
      resultats[id] = { ok: false, error: e.code || 'server_error', detail: e.code ? e.message : 'Erreur inattendue.' };
    }
  }

  await parent.set({ siren: siren, nom: texte(body.nom, 160) || siren, updatedAt: maintenant() }, { merge: true });
  return { status: 200, corps: { ok: true, resultats: resultats, credits: credits, solde: await soldeOuNull() } };
}

/* Lien temporaire vers le fichier stocké : une réponse Vercel plafonne à
   4,5 Mo, et des statuts seuls pèsent déjà 3,4 Mo. */
async function lienFichier(meta) {
  const [url] = await storage.bucket().file(meta.chemin).getSignedUrl({
    version: 'v4', action: 'read', expires: Date.now() + LIEN_URL_MS,
    responseDisposition: 'inline; filename="' + String(meta.nomFichier || 'document').replace(/[^\w.-]/g, '_') + '"',
  });
  return url;
}

async function actionTelecharger(body, auth, d) {
  const siren = societe.sirenDe(body.siren);
  const doc = body.doc || {};
  const cle = societe.cleDocument({ categorie: doc.categorie, titre: doc.titre, date: doc.date, libelle: doc.libelle });
  const ref = db.collection('scoring_societes').doc(siren).collection('documents').doc(cle);
  const snap = await ref.get();
  if (snap.exists) return { status: 200, corps: { ok: true, url: await lienFichier(snap.data() || {}), cache: true, cle: cle } };

  const parNom = nomDe(auth, d.membre);
  const f = await societe.telecharger(doc);
  const chemin = 'scoring/' + siren + '/' + cle + '.' + f.ext;
  await storage.bucket().file(chemin).save(f.buffer, { resumable: false, contentType: f.type });
  const meta = {
    categorie: texte(doc.categorie, 40), titre: texte(doc.titre, 200), date: texte(doc.date, 20), libelle: texte(doc.libelle, 300),
    chemin: chemin, type: f.type, taille: f.buffer.length, at: maintenant(), par: parNom,
    nomFichier: siren + '-' + texte(doc.categorie, 40) + '-' + cle.slice(0, 6) + '.' + f.ext,
  };
  await ref.set(meta);
  await journal('document', { siren: siren, nom: texte(body.nom, 160), item: meta.libelle || meta.titre, credits: societe.COUT_DOCUMENT }, parNom, auth.uid);
  return { status: 200, corps: { ok: true, url: await lienFichier(meta), cle: cle, solde: await soldeOuNull() } };
}

async function actionOuvrir(body) {
  const siren = societe.sirenDe(body.siren);
  const cle = texte(body.cle, 40);
  if (!/^[a-f0-9]+$/.test(cle)) return { status: 400, corps: { ok: false, error: 'bad_request' } };
  const s = await db.collection('scoring_societes').doc(siren).collection('documents').doc(cle).get();
  if (!s.exists) return { status: 404, corps: { ok: false, error: 'document_introuvable' } };
  return { status: 200, corps: { ok: true, url: await lienFichier(s.data() || {}) } };
}

async function vueSociete(siren) {
  const parent = db.collection('scoring_societes').doc(siren);
  const res = await Promise.all([annuaireDe(siren), parent.get(), parent.collection('donnees').get(), parent.collection('documents').get()]);
  const doc = res[1].exists ? (res[1].data() || {}) : {};
  const donnees = {};
  res[2].docs.forEach(function (x) { donnees[x.id] = Object.assign({ ok: true, cache: true }, x.data()); });
  const documents = {};
  res[3].docs.forEach(function (x) { const m = x.data() || {}; documents[x.id] = { at: m.at, par: m.par, taille: m.taille }; });
  return { siren: siren, annuaire: res[0], nom: (res[0] && res[0].name) || doc.nom || siren, solvabilite: doc.solvabilite || null, donnees: donnees, documents: documents };
}

async function vueEtat() {
  const res = await Promise.all([
    db.collection('scoring_demandes').orderBy('demandeAt', 'desc').limit(100).get(),
    db.collection('scoring_journal').orderBy('at', 'desc').limit(100).get(),
    soldeOuNull(),
  ]);
  return {
    configure: societe.configure(), solde: res[2],
    catalogue: societe.CATALOGUE, coutDocument: societe.COUT_DOCUMENT, coutMandats: societe.COUT_MANDATS, coutSolvabilite: societe.COUT_SOLVABILITE,
    demandes: res[0].docs.map(function (x) { return demandePublique(x.id, x.data() || {}); }),
    journal: res[1].docs.map(function (x) { return Object.assign({ id: x.id }, x.data()); }),
  };
}

async function vueNotifs(auth, d) {
  const out = { admin: d.admin, closer: d.closer, attente: [], reponses: [] };
  if (d.admin) {
    const s = await db.collection('scoring_demandes').where('statut', '==', 'attente').get();
    out.attente = s.docs.map(function (x) { return demandePublique(x.id, x.data() || {}); });
    out.attente.sort(function (a, b) { return String(a.demandeAt).localeCompare(String(b.demandeAt)); });
    /* Le pop-up annonce le prix : une étude récente ne coûte rien. */
    for (let i = 0; i < out.attente.length; i++) {
      const c = await db.collection('scoring_societes').doc(out.attente[i].siren).get();
      out.attente[i].gratuit = c.exists && etudeValide((c.data() || {}).solvabilite);
    }
  }
  if (d.closer || d.admin) {
    const s = await db.collection('scoring_demandes').where('demandeurUid', '==', auth.uid).where('vu', '==', false).get();
    s.docs.forEach(function (x) {
      const v = demandePublique(x.id, x.data() || {});
      if (v.statut === 'acceptee' || v.statut === 'refusee') out.reponses.push(v);
    });
  }
  return out;
}

/* ── Routage ────────────────────────────────────────────────────────────── */

module.exports = async function handler(req, res) {
  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'admin' && auth.role !== 'sales') { repondre(res, 403, { ok: false, error: 'forbidden' }); return; }

  try {
    const d = await droits(auth);

    if (req.method === 'GET') {
      const q = req.query || {};
      const action = String(q.action || '');
      if (action === 'notifs') { repondre(res, 200, Object.assign({ ok: true }, await vueNotifs(auth, d))); return; }
      if (action === 'lead') {
        if (!d.admin && !d.closer) { repondre(res, 200, { ok: true, peut: false }); return; }
        const leadId = texte(q.leadId, 120);
        if (!leadId || leadId.indexOf('/') >= 0) { repondre(res, 400, { ok: false, error: 'bad_request' }); return; }
        const r = await Promise.all([derniereDemandeDuLead(leadId), societeDuContrat(leadId)]);
        repondre(res, 200, { ok: true, peut: true, admin: d.admin, demande: r[0], suggestion: r[1] });
        return;
      }
      if (!d.admin) { repondre(res, 403, { ok: false, error: 'forbidden' }); return; }
      if (action === 'etat') { repondre(res, 200, Object.assign({ ok: true }, await vueEtat())); return; }
      if (action === 'societe') { repondre(res, 200, Object.assign({ ok: true }, await vueSociete(societe.sirenDe(q.siren)))); return; }
      repondre(res, 400, { ok: false, error: 'bad_request' });
      return;
    }

    if (req.method !== 'POST') { repondre(res, 405, { ok: false, error: 'method_not_allowed' }); return; }
    const body = parseBody(req) || {};
    const action = String(body.action || '');

    if (action === 'recherche') {
      if (!d.admin && !d.closer) { repondre(res, 403, { ok: false, error: 'forbidden' }); return; }
      const r = await company.searchCompanies(texte(body.q, 120), 8);
      repondre(res, 200, { ok: true, results: r.results });
      return;
    }
    if (action === 'demander') { const r = await actionDemander(body, auth, d); repondre(res, r.status, r.corps); return; }
    if (action === 'vu') {
      const ref = db.collection('scoring_demandes').doc(texte(body.id, 60) || '-');
      const s = await ref.get();
      if (s.exists && (s.data() || {}).demandeurUid === auth.uid) await ref.update({ vu: true });
      repondre(res, 200, { ok: true });
      return;
    }

    /* Tout le reste : admins uniquement. */
    if (!d.admin) { repondre(res, 403, { ok: false, error: 'forbidden' }); return; }

    if (action === 'decider') { const r = await actionDecider(body, auth, d); repondre(res, r.status, r.corps); return; }
    if (action === 'solvabilite') {
      const siren = societe.sirenDe(body.siren);
      const parNom = nomDe(auth, d.membre);
      const r = await lancerEtude(siren, texte(body.nom, 160), body.force === true, parNom, auth.uid);
      /* Lancée depuis une fiche : le résultat doit s'y afficher. */
      const leadId = texte(body.leadId, 120);
      if (leadId && leadId.indexOf('/') < 0) {
        await db.collection('scoring_demandes').add({
          leadId: leadId, leadNom: texte(body.leadNom, 120), siren: siren, nom: r.nom, statut: 'acceptee', origine: 'admin',
          demandeurUid: auth.uid, demandeurNom: parNom, demandeAt: maintenant(), decideurUid: auth.uid, decideurNom: parNom,
          decideAt: maintenant(), resultat: r.etude, vu: true,
        });
      }
      repondre(res, 200, { ok: true, etude: r.etude, nom: r.nom, cache: r.cache, solde: await soldeOuNull() });
      return;
    }
    if (action === 'charger') { const r = await actionCharger(body, auth, d); repondre(res, r.status, r.corps); return; }
    if (action === 'documents') { repondre(res, 200, { ok: true, documents: await societe.listeDocuments(societe.sirenDe(body.siren)) }); return; }
    if (action === 'telecharger') { const r = await actionTelecharger(body, auth, d); repondre(res, r.status, r.corps); return; }
    if (action === 'ouvrir') { const r = await actionOuvrir(body); repondre(res, r.status, r.corps); return; }
    if (action === 'mandats') {
      const r = await societe.mandats(body.dirid);
      if (!r.vide) await journal('mandats', { siren: texte(body.siren, 14), nom: texte(body.nom, 160), item: texte(body.dirNom, 120), credits: societe.COUT_MANDATS }, nomDe(auth, d.membre), auth.uid);
      repondre(res, 200, { ok: true, vide: r.vide, data: r.data, solde: await soldeOuNull() });
      return;
    }
    repondre(res, 400, { ok: false, error: 'bad_request' });
  } catch (e) {
    echec(res, e);
  }
};
