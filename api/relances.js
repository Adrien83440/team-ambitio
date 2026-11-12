// ============================================================================
// api/relances.js — PAGE ADMIN « RELANCES » (admin-relances.html), 12/11/2026
// ----------------------------------------------------------------------------
// Réservé au rôle admin. Toutes les lectures et écritures du module passent
// ici (Admin SDK) : aucune règle Firestore à déployer.
//
// GET  ?action=etat                     réglages, segments, campagnes, setters,
//                                       liens setter, qualité WhatsApp
// POST { action, … }
//   apercu        { filtres }           nombre, exclusions, liste (aperçu)
//   segment       { id?, nom, filtres } enregistre un segment
//   campagne      { id?, nom, vagues, etapes, dateDebut, plafondJour, setterRepli }
//                                       enregistre (brouillon uniquement)
//   modeles       {}                    modèles WhatsApp (détail, boutons, prix)
//   modelesProposes {}                  les deux modèles de la 1re campagne
//   soumettreModele { nom, videoUrl? }  soumet un modèle proposé à Meta
//   test          { campagneId }        envoie CHAQUE étape (et son SMS de
//                                       repli) à TES coordonnées de test
//   preparer      { campagneId }        ce que le lancement inscrirait
//   lancer        { campagneId, nb }    inscrit les leads (nb = confirmation)
//   pause / reprendre / arreter { campagneId }
//   stats         { campagneId }        suivi + lignes CSV
//   config        { patch, confirmation? }  réglages (_config/relances)
//   preconfigurer {}                    crée la 1re campagne (brouillon)
//
// GARDE-FOUS DU LANCEMENT (tous serveur, aucun contournement) :
//   · modeTest doit être `false` (bascule explicite « PRODUCTION ») ;
//   · un test réussi sur l'empreinte EXACTE de la séquence ;
//   · aucune étape ne contient de prix (relances-core contientPrix) ;
//   · le nombre confirmé à l'écran = le nombre recalculé au lancement ;
//   · un lead déjà dans une séquence active n'est jamais inscrit deux fois.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const R = require('./_relances');

const Core = R.Core;
const FV = admin.firestore.FieldValue;

/* ── Modèles WhatsApp de la première campagne (aucun prix) ─────────────── */
const MODELES_PROPOSES = [
  {
    nom: 'relance_reactivation_video', categorie: 'MARKETING', langue: 'fr', entete: 'VIDEO',
    corps: 'Bonjour {{1}},\n\nIl y a quelques semaines, vous vous êtes intéressé(e) à l\'accompagnement Élite Phénix d\'Adrien & Emily.\n\n'
      + 'Nous avons enregistré cette courte vidéo pour vous : elle montre concrètement comment nos clients structurent le développement de leur activité.\n\n'
      + 'Si vous voulez en parler, {{2}} vous propose un échange, sans engagement.',
    exemples: ['Stéphanie', 'Valentin'],
    pied: 'Répondez à ce message pour nous écrire.',
    boutons: [{ type: 'URL', texte: 'Réserver un échange' }, { type: 'QUICK_REPLY', texte: 'Plus intéressé' }],
  },
  {
    nom: 'relance_dernier_message', categorie: 'MARKETING', langue: 'fr', entete: null,
    corps: 'Bonjour {{1}},\n\nDernier message de notre part, nous ne voulons pas vous importuner.\n\n'
      + 'Si le développement de votre activité reste une priorité, {{2}} garde un créneau pour vous cette semaine.\n\n'
      + 'Sinon, dites-le-nous d\'un clic : nous ne vous relancerons plus.',
    exemples: ['Stéphanie', 'Valentin'],
    pied: 'Répondez à ce message pour nous écrire.',
    boutons: [{ type: 'URL', texte: 'Choisir un créneau' }, { type: 'QUICK_REPLY', texte: 'Plus intéressé' }],
  },
];

/* SMS : alphabet GSM-7 seulement (é, è, à oui ; ê, ç, î, ô, û, ’, « » non)
   → 160 caractères par segment au lieu de 70. La mention STOP est
   obligatoire pour un SMS commercial. */
const PRECONFIG = {
  segA: { id: 'seg_followup_elite', nom: 'A · Follow-up Elite (depuis le 13/08)',
    filtres: { statuts: ['follow_up_pm'], provenances: ['elite'], entreDu: '2026-08-13' } },
  segB: { id: 'seg_jamais_joints_elite', nom: 'B · Jamais joints Elite (depuis le 13/08)',
    filtres: { statuts: ['all_nrp', 'nrp1', 'nrp2', 'nrp3'], provenances: ['elite'], entreDu: '2026-08-13' } },
  camp: {
    id: 'camp_reactivation_elite_2026_11', nom: 'Réactivation Elite — novembre 2026', plafondJour: 120,
    etapes: [
      { canal: 'whatsapp', delaiJours: 0, modele: 'relance_reactivation_video', langue: 'fr', parametres: ['prenom', 'setter'], videoUrl: '',
        texteRepli: 'Bonjour {{prenom}}, {{setter}} de l\'équipe Adrien & Emily. Vous vous étiez intéressé(e) à l\'accompagnement Élite Phénix : si vous voulez en parler, choisissez un créneau ici {{lien_rdv}} Répondez STOP pour ne plus recevoir de messages.' },
      { canal: 'sms', delaiJours: 2,
        texte: 'Bonjour {{prenom}}, c\'est {{setter}} de l\'équipe Adrien & Emily. Je reviens vers vous suite à mon dernier message : si le sujet vous parle toujours, un court échange suffit pour faire le point. {{lien_rdv}} Répondez STOP pour ne plus recevoir de messages.' },
      { canal: 'whatsapp', delaiJours: 5, modele: 'relance_dernier_message', langue: 'fr', parametres: ['prenom', 'setter'],
        texteRepli: 'Bonjour {{prenom}}, dernier message de ma part : si votre développement reste une priorité, je garde un créneau pour vous cette semaine {{lien_rdv}} Sinon, répondez simplement "plus intéressé". Répondez STOP pour ne plus recevoir de messages.' },
    ],
  },
};

function ymdOk(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
function nettoyerFiltres(f) {
  f = f || {};
  const liste = function (v) { return (Array.isArray(v) ? v : []).map(function (x) { return String(x).trim(); }).filter(Boolean).slice(0, 30); };
  const num = function (v) { return v === '' || v == null || !isFinite(+v) ? null : Math.max(0, Math.min(100, +v)); };
  return {
    statuts: liste(f.statuts), etapes: liste(f.etapes), provenances: liste(f.provenances), setters: liste(f.setters),
    entreDu: ymdOk(f.entreDu) ? f.entreDu : null, entreAu: ymdOk(f.entreAu) ? f.entreAu : null,
    contactAvant: ymdOk(f.contactAvant) ? f.contactAvant : null, contactApres: ymdOk(f.contactApres) ? f.contactApres : null,
    scoreMin: num(f.scoreMin), scoreMax: num(f.scoreMax), sansScore: f.sansScore !== false,
  };
}
function nettoyerEtapes(etapes) {
  return (Array.isArray(etapes) ? etapes : []).slice(0, 8).map(function (e, i) {
    e = e || {};
    const canal = ['whatsapp', 'sms', 'email'].indexOf(e.canal) >= 0 ? e.canal : 'sms';
    const o = { canal: canal, delaiJours: i === 0 ? 0 : Math.max(1, Math.min(60, Math.round(+e.delaiJours || 0))) };
    if (canal === 'whatsapp') {
      o.modele = String(e.modele || '').trim();
      o.langue = String(e.langue || 'fr').trim();
      o.parametres = (Array.isArray(e.parametres) ? e.parametres : []).map(String).filter(function (k) { return Core.VARIABLES.indexOf(k) >= 0; }).slice(0, 5);
      o.videoUrl = String(e.videoUrl || '').trim();
      o.texteRepli = String(e.texteRepli || '').slice(0, 1000);
    } else if (canal === 'sms') {
      o.texte = String(e.texte || '').slice(0, 1000);
    } else {
      o.objet = String(e.objet || '').slice(0, 200);
      o.texte = String(e.texte || '').slice(0, 5000);
    }
    return o;
  });
}

/* Vérifie une séquence contre les modèles réellement approuvés. */
function erreursSequence(etapes, modeles) {
  const err = [];
  if (!etapes.length) err.push('La séquence est vide.');
  etapes.forEach(function (e, i) {
    const m = e.canal === 'whatsapp' ? modeles[e.modele] : null;
    const x = Core.verifierEtape(Object.assign({}, e, m ? { enteteFormat: m.enteteFormat, corpsModele: m.corps } : {}), i);
    if (x) err.push(x);
    if (e.canal === 'whatsapp') {
      if (!m) err.push('Étape ' + (i + 1) + ' : modèle « ' + e.modele + ' » introuvable ou pas encore approuvé par Meta.');
      if (!String(e.texteRepli || '').trim()) err.push('Étape ' + (i + 1) + ' : SMS de repli requis (si le numéro n\'est pas sur WhatsApp).');
      else {
        const p = Core.contientPrix(e.texteRepli);
        if (p) err.push('Étape ' + (i + 1) + ' : le SMS de repli contient un élément de prix (« ' + p + ' »).');
      }
    }
    if (i > 0 && etapes[i - 1] && +e.delaiJours <= +etapes[i - 1].delaiJours) err.push('Étape ' + (i + 1) + ' : le délai doit être après celui de l\'étape précédente.');
  });
  return err;
}
async function modelesApprouves() {
  const mw = await R.modelesWhatsapp();
  const map = {};
  (mw.modeles || []).forEach(function (m) { if (String(m.statut).toUpperCase() === 'APPROVED') map[m.nom] = m; });
  return { map: map, liste: mw.modeles || [], erreur: mw.ok ? null : mw.erreur };
}

/* ── Leads d'une campagne (vagues → segments, sans doublon) ────────────── */
async function leadsCampagne(camp) {
  const ctx = await R.contexteExclusions();
  const vus = {};
  const vagues = [];
  for (let i = 0; i < (camp.vagues || []).length; i++) {
    const v = camp.vagues[i];
    const sg = await db.collection('relance_segments').doc(String(v.segmentId)).get();
    if (!sg.exists) { vagues.push({ segmentId: v.segmentId, erreur: 'segment_introuvable', leads: [] }); continue; }
    const seg = sg.data() || {};
    const r = await R.calculerSegment(seg.filtres || {}, ctx);
    const leads = r.leads.filter(function (l) { if (vus[l.id]) return false; vus[l.id] = 1; return true; });
    vagues.push({ segmentId: v.segmentId, nom: seg.nom, jours: v.jours || [1], leads: leads, exclus: r.exclus });
  }
  return vagues;
}
function planVagues(camp, vagues) {
  return vagues.map(function (v) {
    let k = 0;
    const rep = Core.repartir(v.leads.length, v.jours).map(function (x) {
      const r = { jour: x.jour, date: Core.jourCampagne(camp.dateDebut, x.jour), nb: x.nb, leads: v.leads.slice(k, k + x.nb) };
      k += x.nb;
      return r;
    });
    return { segmentId: v.segmentId, nom: v.nom, total: v.leads.length, exclus: v.exclus, jours: rep };
  });
}

/* ── Actions ───────────────────────────────────────────────────────────── */
async function etat() {
  const [cfg, ss, cs, liste, types, q] = await Promise.all([
    R.config(), db.collection('relance_segments').get(), db.collection('relance_campagnes').get(),
    R.membres(), R.typesRdv(), R.qualiteWhatsapp(),
  ]);
  const segments = [], campagnes = [];
  ss.forEach(function (d) { segments.push(Object.assign({ id: d.id }, d.data() || {})); });
  cs.forEach(function (d) { campagnes.push(Object.assign({ id: d.id }, d.data() || {})); });
  campagnes.sort(function (a, b) { return (b.creeA || 0) - (a.creeA || 0); });
  const setters = liste.filter(function (m) { return m.actif; }).map(function (m) {
    const t = R.typePourSetter(types, m.slug, null);
    return { slug: m.slug, nom: m.nom, role: m.role, uid: !!m.uid, lien: t ? (t.type.label || t.type.id) : null };
  });
  return { ok: true, config: cfg, segments: segments, campagnes: campagnes, setters: setters, whatsapp: q,
    statuts: Core.STATUTS, motifs: Core.MOTIFS, variables: Core.VARIABLES };
}

async function apercu(b) {
  const f = nettoyerFiltres(b.filtres);
  const r = await R.calculerSegment(f);
  return { ok: true, filtres: f, total: r.leads.length, exclus: r.exclus, examines: r.examines,
    leads: r.leads.slice(0, 500), tronque: r.leads.length > 500 };
}

async function enregistrerSegment(b, auth) {
  const nom = String(b.nom || '').trim().slice(0, 120);
  if (!nom) return { code: 400, ok: false, error: 'nom_requis' };
  const ref = b.id ? db.collection('relance_segments').doc(String(b.id)) : db.collection('relance_segments').doc();
  const doc = { nom: nom, filtres: nettoyerFiltres(b.filtres), majA: Date.now(), majPar: auth.email || auth.uid };
  if (!b.id) doc.creeA = Date.now();
  await ref.set(doc, { merge: true });
  return { ok: true, id: ref.id };
}

async function enregistrerCampagne(b, auth) {
  const ref = b.id ? db.collection('relance_campagnes').doc(String(b.id)) : db.collection('relance_campagnes').doc();
  const s = await ref.get();
  if (s.exists && (s.data() || {}).etat && (s.data() || {}).etat !== 'brouillon') {
    return { code: 409, ok: false, error: 'campagne_lancee', detail: 'Une campagne lancée ne se modifie plus : mets-la en pause ou arrête-la, puis crée-en une nouvelle.' };
  }
  const etapes = nettoyerEtapes(b.etapes);
  const vagues = (Array.isArray(b.vagues) ? b.vagues : []).slice(0, 6).map(function (v) {
    return { segmentId: String(v && v.segmentId || ''), jours: (Array.isArray(v && v.jours) ? v.jours : [1])
      .map(function (j) { return Math.max(1, Math.min(30, Math.round(+j || 1))); }).slice(0, 10) };
  }).filter(function (v) { return v.segmentId; });
  const doc = {
    nom: String(b.nom || 'Campagne').trim().slice(0, 120), etat: 'brouillon', etapes: etapes, vagues: vagues,
    dateDebut: ymdOk(b.dateDebut) ? b.dateDebut : Core.prochainJourOuvre(Core.decaler(Core.aujourdhui(), 1)),
    plafondJour: Math.max(1, Math.min(1000, Math.round(+b.plafondJour || 0))) || null,
    setterRepli: String(b.setterRepli || '').trim() || null,
    empreinte: Core.empreinte(etapes), majA: Date.now(), majPar: auth.email || auth.uid,
  };
  if (!s.exists) doc.creeA = Date.now();
  await ref.set(doc, { merge: true });
  return { ok: true, id: ref.id, empreinte: doc.empreinte };
}

async function lireCampagne(id) {
  const s = await db.collection('relance_campagnes').doc(String(id || '')).get();
  return s.exists ? Object.assign({ id: s.id }, s.data() || {}) : null;
}

async function tester(b, auth) {
  const cfg = await R.config();
  const camp = await lireCampagne(b.campagneId);
  if (!camp) return { code: 404, ok: false, error: 'campagne_introuvable' };
  const m = await modelesApprouves();
  const err = erreursSequence(camp.etapes || [], m.map);
  if (err.length) return { code: 409, ok: false, error: 'sequence_invalide', erreurs: err };
  const canaux = (camp.etapes || []).map(function (e) { return e.canal; });
  if ((canaux.indexOf('whatsapp') >= 0 || canaux.indexOf('sms') >= 0) && !Core.telephoneE164(cfg.testTelephone)) {
    return { code: 409, ok: false, error: 'test_telephone_absent', detail: 'Renseigne ton numéro de test dans Réglages.' };
  }
  if (canaux.indexOf('email') >= 0 && !/@/.test(String(cfg.testEmail || ''))) {
    return { code: 409, ok: false, error: 'test_email_absent', detail: 'Renseigne ton e-mail de test dans Réglages.' };
  }
  /* Variables tirées d'un VRAI lead du premier segment (prénom, setter), mais
     les liens de test n'ouvrent jamais sa fiche : un RDV pris pendant le test
     ne lui serait pas attribué. */
  let exemple = null;
  try {
    const v = await leadsCampagne({ vagues: (camp.vagues || []).slice(0, 1), dateDebut: camp.dateDebut });
    exemple = v[0] && v[0].leads[0] || null;
  } catch (e) { exemple = null; }
  const liste = await R.membres();
  const choix = R.typePourSetter(await R.typesRdv(), exemple && exemple.setter, camp.setterRepli || cfg.setterRepli);
  const setterSlug = choix ? choix.setter : ((exemple && exemple.setter) || null);
  const mb = setterSlug ? R.membre(liste, setterSlug) : null;
  const jr = await R.creerLien({ type: 'rdv', test: true, campagneId: camp.id });
  await db.collection('relance_liens').doc(jr).set({ setter: setterSlug }, { merge: true });
  const js = await R.creerLien({ type: 'stop', test: true, campagneId: camp.id });
  const vars = { prenom: (exemple && exemple.prenom) || 'Adrien', setter: mb ? mb.nom : 'notre équipe',
    lien_rdv: R.urlLien(jr), lien_stop: R.urlLien(js) };
  const resultats = [];
  const etapes = camp.etapes || [];
  for (let i = 0; i < etapes.length; i++) {
    const e = etapes[i];
    const r = await R.envoyerEtape({ etape: e, lead: { id: null }, inscription: null, campagne: camp, cfg: cfg,
      test: true, modeles: m.map, vars: vars });
    resultats.push({ n: i, canal: r.canal, ok: r.ok, bascule: !!r.bascule, erreur: r.erreur || null, code: r.code || null, erreurWhatsapp: r.erreurWhatsapp || null });
    if (e.canal === 'whatsapp' && e.texteRepli) {
      const s = await R.envoyerSms('[TEST repli] ' + Core.remplir(e.texteRepli, vars), Core.telephoneE164(cfg.testTelephone), { module: 'relances', test: true });
      resultats.push({ n: i, canal: 'sms', repli: true, ok: s.ok, erreur: s.erreur || null });
    }
  }
  const ok = resultats.every(function (x) { return x.ok; });
  const trace = { empreinte: Core.empreinte(etapes), at: Date.now(), par: auth.email || auth.uid, ok: ok, resultats: resultats,
    variables: { prenom: vars.prenom, setter: vars.setter } };
  await db.collection('relance_campagnes').doc(camp.id).set(ok ? { testOk: trace, dernierTest: trace } : { dernierTest: trace }, { merge: true });
  return { ok: true, testReussi: ok, resultats: resultats, variables: trace.variables,
    rappel: 'Ouvre chaque message reçu, clique le lien de réservation, et vérifie le texte avant de lancer.' };
}

async function preparer(b) {
  const cfg = await R.config();
  const camp = await lireCampagne(b.campagneId);
  if (!camp) return { code: 404, ok: false, error: 'campagne_introuvable' };
  const m = await modelesApprouves();
  const erreurs = erreursSequence(camp.etapes || [], m.map);
  const vagues = planVagues(camp, await leadsCampagne(camp));
  const total = vagues.reduce(function (a, v) { return a + v.total; }, 0);
  const types = await R.typesRdv();
  const sansLien = {};
  vagues.forEach(function (v) { v.jours.forEach(function (j) { j.leads.forEach(function (l) {
    if (!R.typePourSetter(types, l.setter, camp.setterRepli || cfg.setterRepli)) sansLien[l.setter || '(aucun)'] = (sansLien[l.setter || '(aucun)'] || 0) + 1;
  }); }); });
  const bloquants = erreurs.slice();
  if (cfg.modeTest !== false) bloquants.push('Le mode test est actif : aucun envoi réel n\'est possible (Réglages → passer en production).');
  if (!camp.testOk || camp.testOk.empreinte !== Core.empreinte(camp.etapes || [])) bloquants.push('« M\'envoyer un test » doit avoir réussi sur cette séquence exacte.');
  if (camp.dateDebut < Core.aujourdhui()) bloquants.push('La date de début est passée.');
  if (Object.keys(sansLien).length) bloquants.push('Aucun lien de réservation setter (ni setter de repli) pour : ' + Object.keys(sansLien).join(', ') + '.');
  if (!total) bloquants.push('Aucun lead à relancer.');
  return {
    ok: true, total: total, cout: Core.coutEstime(total, camp.etapes || [], cfg), bloquants: bloquants, sansLien: sansLien,
    vagues: vagues.map(function (v) { return { nom: v.nom, total: v.total, exclus: v.exclus,
      jours: v.jours.map(function (j) { return { jour: j.jour, date: j.date, nb: j.nb }; }) }; }),
    plafondJour: camp.plafondJour || cfg.plafondJour, empreinte: Core.empreinte(camp.etapes || []),
  };
}

async function lancer(b, auth) {
  const p = await preparer(b);
  if (!p.ok) return p;
  if (p.bloquants.length) return { code: 409, ok: false, error: 'lancement_bloque', bloquants: p.bloquants };
  if (+b.nb !== p.total) return { code: 409, ok: false, error: 'nombre_change', detail: 'Le segment a bougé : ' + p.total + ' leads maintenant (tu as confirmé ' + b.nb + '). Reconfirme.', total: p.total };
  const camp = await lireCampagne(b.campagneId);
  if (camp.etat !== 'brouillon') return { code: 409, ok: false, error: 'deja_lancee' };
  const cfg = await R.config();
  const plan = planVagues(camp, await leadsCampagne(camp));
  const aInscrire = [];
  plan.forEach(function (v) { v.jours.forEach(function (j) { j.leads.forEach(function (l) {
    aInscrire.push({ l: l, segmentId: v.segmentId, jourDepart: j.date });
  }); }); });
  let inscrits = 0, ignores = 0;
  for (let i = 0; i < aInscrire.length; i += 100) {
    const lot = aInscrire.slice(i, i + 100);
    await db.runTransaction(async function (tx) {
      const refs = lot.map(function (x) { return db.collection('relance_verrous').doc(String(x.l.id)); });
      const snaps = await tx.getAll.apply(tx, refs);
      snaps.forEach(function (s, k) {
        if (s.exists && (s.data() || {}).actif === true) { ignores++; return; }
        const x = lot[k];
        const id = camp.id + '_' + x.l.id;
        tx.set(refs[k], { actif: true, campagneId: camp.id, inscriptionId: id, at: Date.now() });
        tx.set(db.collection('relance_inscriptions').doc(id), {
          campagneId: camp.id, leadId: x.l.id, segmentId: x.segmentId, nom: x.l.nom, setter: x.l.setter || null,
          etat: 'active', etape: 0, jourDepart: x.jourDepart,
          prochainA: Core.instantParis(x.jourDepart, +cfg.heureDebut || 9), creeA: Date.now(), envois: [],
        });
        inscrits++;
      });
    });
  }
  await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'en_cours', lanceA: Date.now(), lancePar: auth.email || auth.uid,
    inscrits: inscrits, ignoresAuLancement: ignores, coutEstime: p.cout,
    planLancement: p.vagues }, { merge: true });
  return { ok: true, inscrits: inscrits, ignores: ignores };
}

async function changerEtat(b, auth, action) {
  const camp = await lireCampagne(b.campagneId);
  if (!camp) return { code: 404, ok: false, error: 'campagne_introuvable' };
  if (action === 'pause') {
    if (camp.etat !== 'en_cours') return { code: 409, ok: false, error: 'pas_en_cours' };
    await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'pause', pauseA: Date.now(), motifPause: 'manuel', pausePar: auth.email || auth.uid }, { merge: true });
    return { ok: true };
  }
  if (action === 'reprendre') {
    if (camp.etat !== 'pause') return { code: 409, ok: false, error: 'pas_en_pause' };
    await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'en_cours', repriseA: Date.now(), motifPause: null }, { merge: true });
    return { ok: true };
  }
  /* arreter : définitif, toutes les inscriptions actives s'arrêtent. */
  const is = await db.collection('relance_inscriptions').where('campagneId', '==', camp.id).get();
  let n = 0;
  for (let i = 0; i < is.docs.length; i++) {
    const d = is.docs[i].data() || {};
    if (d.etat === 'active') { await R.arreter(is.docs[i].id, 'campagne_arretee'); n++; }
  }
  await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'terminee', termineeA: Date.now(), arreteePar: auth.email || auth.uid }, { merge: true });
  return { ok: true, arretees: n };
}

/* ── Suivi ─────────────────────────────────────────────────────────────── */
async function getAllEnLots(col, ids) {
  const out = {};
  const uniq = ids.filter(function (x, i) { return x && ids.indexOf(x) === i; });
  for (let i = 0; i < uniq.length; i += 300) {
    const refs = uniq.slice(i, i + 300).map(function (id) { return db.collection(col).doc(String(id)); });
    const snaps = refs.length ? await db.getAll.apply(db, refs) : [];
    snaps.forEach(function (s) { if (s.exists) out[s.id] = s.data() || {}; });
  }
  return out;
}
async function stats(b) {
  const camp = await lireCampagne(b.campagneId);
  if (!camp) return { code: 404, ok: false, error: 'campagne_introuvable' };
  const [is, es] = await Promise.all([
    db.collection('relance_inscriptions').where('campagneId', '==', camp.id).get(),
    db.collection('relance_envois').where('campagneId', '==', camp.id).get(),
  ]);
  const inscs = is.docs.map(function (d) { return Object.assign({ id: d.id }, d.data() || {}); });
  const envois = es.docs.map(function (d) { return d.data() || {}; }).filter(function (e) { return !e.test; });
  const wa = await getAllEnLots('whatsapp_messages', envois.filter(function (e) { return e.canal === 'whatsapp' && e.fournisseurId; }).map(function (e) { return e.fournisseurId; }));
  const sms = await getAllEnLots('sms_delivery', envois.filter(function (e) { return e.canal === 'sms' && e.fournisseurId; }).map(function (e) { return e.fournisseurId; }));
  const leadIds = inscs.map(function (x) { return x.leadId; });
  const leads = await getAllEnLots('leads', leadIds);

  /* RDV posés après le premier envoi ; honorés = issue renseignée (close,
     non close, offre) ; ventes = devenu client depuis. */
  const rdvParLead = {};
  for (let i = 0; i < leadIds.length; i += 30) {
    const lot = leadIds.slice(i, i + 30);
    if (!lot.length) continue;
    const s = await db.collection('bookings').where('leadId', 'in', lot).get();
    s.forEach(function (d) {
      const x = d.data() || {};
      if (x.isCoaching === true) return;
      (rdvParLead[x.leadId] = rdvParLead[x.leadId] || []).push(x);
    });
  }
  const nbEtapes = (camp.etapes || []).length;
  const parEtape = [];
  for (let n = 0; n < nbEtapes; n++) parEtape.push({ n: n, canal: camp.etapes[n].canal, envoyes: 0, echecs: 0, bascules: 0, delivres: 0, lus: 0, reponses: 0, rdv: 0, honores: 0, ventes: 0, clics: 0 });
  envois.forEach(function (e) {
    const p = parEtape[e.etape];
    if (!p) return;
    if (!e.ok) { p.echecs++; return; }
    p.envoyes++;
    if (e.bascule) p.bascules++;
    if (e.canal === 'whatsapp') {
      const st = (wa[e.fournisseurId] || {}).statut;
      if (st === 'delivered' || st === 'read') p.delivres++;
      if (st === 'read') p.lus++;
    } else if (e.canal === 'sms') {
      if ((sms[e.fournisseurId] || {}).livre) p.delivres++;
    }
  });
  const lignes = [];
  const total = { inscrits: inscs.length, actives: 0, terminees: 0, arretees: 0, reponses: 0, plusInteresse: 0, stop: 0, rdv: 0, honores: 0, ventes: 0, clics: 0 };
  inscs.forEach(function (x) {
    const l = leads[x.leadId] || {};
    const depuis = x.debutA || 0;
    const rdvs = (rdvParLead[x.leadId] || []).filter(function (r) { return depuis && Core.msDe(r.createdAt) > depuis && r.status !== 'cancelled'; });
    const honore = rdvs.some(function (r) { return ['close', 'non_close', 'offre'].indexOf(r.outcome) >= 0; });
    const vente = depuis && Core.estClient(l);
    const etapeAttrib = x.derniereEtape != null ? x.derniereEtape : 0;
    const p = parEtape[etapeAttrib];
    if (x.etat === 'active') total.actives++;
    else if (x.etat === 'terminee') total.terminees++;
    else total.arretees++;
    if (x.motifArret === 'a_repondu') { total.reponses++; if (p) p.reponses++; }
    if (x.motifArret === 'plus_interesse') total.plusInteresse++;
    if (x.motifArret === 'stop' || x.motifArret === 'exclu_stop') total.stop++;
    if (rdvs.length) { total.rdv++; if (p) p.rdv++; }
    if (honore) { total.honores++; if (p) p.honores++; }
    if (vente) { total.ventes++; if (p) p.ventes++; }
    if (x.clics) { total.clics++; if (p) p.clics++; }
    lignes.push({
      leadId: x.leadId, nom: x.nom || l.nom || '', setter: x.setter || l.assignedTo || '', segment: x.segmentId,
      etat: x.etat, motif: x.motifArret || '', etapesEnvoyees: (x.envois || []).filter(function (e) { return e.ok; }).length,
      canaux: (x.envois || []).map(function (e) { return e.canal + (e.bascule ? '(repli)' : '') + (e.ok ? '' : '(echec)'); }).join(' > '),
      jourDepart: x.jourDepart || '', reponse: x.reponse ? x.reponse.extrait : '', clics: x.clics || 0,
      rdv: rdvs.length, honore: honore ? 1 : 0, vente: vente ? 1 : 0, statutActuel: l.status || '',
    });
  });
  const compteurs = [];
  const cs = await db.collection('relance_compteurs').where('campagneId', '==', camp.id).get();
  cs.forEach(function (d) { compteurs.push(d.data() || {}); });
  compteurs.sort(function (a, b) { return String(a.jour).localeCompare(String(b.jour)); });
  return { ok: true, campagne: { id: camp.id, nom: camp.nom, etat: camp.etat, lanceA: camp.lanceA || null, motifPause: camp.motifPause || null },
    total: total, parEtape: parEtape, parJour: compteurs, lignes: lignes };
}

/* ── Réglages ──────────────────────────────────────────────────────────── */
async function majConfig(b, auth) {
  const p = b.patch || {};
  const up = {};
  if (p.testTelephone !== undefined) {
    const t = Core.telephoneE164(p.testTelephone);
    if (p.testTelephone && !t) return { code: 400, ok: false, error: 'telephone_invalide' };
    up.testTelephone = t || '';
  }
  if (p.testEmail !== undefined) {
    const e = String(p.testEmail || '').trim();
    if (e && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return { code: 400, ok: false, error: 'email_invalide' };
    up.testEmail = e;
  }
  if (p.plafondJour !== undefined) up.plafondJour = Math.max(1, Math.min(1000, Math.round(+p.plafondJour || 100)));
  if (p.heureDebut !== undefined) up.heureDebut = Math.max(8, Math.min(19, Math.round(+p.heureDebut || 9)));
  if (p.heureFin !== undefined) up.heureFin = Math.max(10, Math.min(20, Math.round(+p.heureFin || 19)));
  ['coutWhatsapp', 'coutSms', 'coutEmail'].forEach(function (k) { if (p[k] !== undefined) up[k] = Math.max(0, Math.min(5, +p[k] || 0)); });
  if (p.emailCompte !== undefined) up.emailCompte = ['strategie', 'contact', 'coaching'].indexOf(p.emailCompte) >= 0 ? p.emailCompte : 'strategie';
  if (p.setterRepli !== undefined) up.setterRepli = String(p.setterRepli || '').trim();
  if (p.pauseSiQualiteRouge !== undefined) up.pauseSiQualiteRouge = p.pauseSiQualiteRouge !== false;
  if (p.modeTest !== undefined) {
    if (p.modeTest === false) {
      if (b.confirmation !== 'PRODUCTION') return { code: 409, ok: false, error: 'confirmation_requise', detail: 'Tape PRODUCTION pour autoriser les envois réels.' };
      up.modeTest = false;
      up.productionA = Date.now();
      up.productionPar = auth.email || auth.uid;
    } else up.modeTest = true;
  }
  up.majA = Date.now();
  up.majPar = auth.email || auth.uid;
  await db.collection('_config').doc('relances').set(up, { merge: true });
  return { ok: true, config: await R.config() };
}

/* ── Première campagne, préconfigurée (brouillon, jamais lancée) ───────── */
async function preconfigurer(auth) {
  const out = {};
  const segs = [PRECONFIG.segA, PRECONFIG.segB];
  for (let i = 0; i < segs.length; i++) {
    const ref = db.collection('relance_segments').doc(segs[i].id);
    const s = await ref.get();
    if (!s.exists) await ref.set({ nom: segs[i].nom, filtres: nettoyerFiltres(segs[i].filtres), creeA: Date.now(), majA: Date.now(), majPar: auth.email || auth.uid });
    out[segs[i].id] = s.exists ? 'existait' : 'cree';
  }
  const ref = db.collection('relance_campagnes').doc(PRECONFIG.camp.id);
  const s = await ref.get();
  if (!s.exists) {
    const etapes = nettoyerEtapes(PRECONFIG.camp.etapes);
    await ref.set({
      nom: PRECONFIG.camp.nom, etat: 'brouillon', etapes: etapes,
      vagues: [{ segmentId: PRECONFIG.segA.id, jours: [1] }, { segmentId: PRECONFIG.segB.id, jours: [2, 3] }],
      dateDebut: Core.prochainJourOuvre(Core.decaler(Core.aujourdhui(), 1)), plafondJour: PRECONFIG.camp.plafondJour,
      setterRepli: null, empreinte: Core.empreinte(etapes), creeA: Date.now(), majA: Date.now(), majPar: auth.email || auth.uid,
    });
  }
  out[PRECONFIG.camp.id] = s.exists ? 'existait' : 'cree';
  return { ok: true, crees: out };
}

/* ── Soumission d'un modèle à Meta ─────────────────────────────────────── */
async function soumettreModele(b) {
  const def = MODELES_PROPOSES.filter(function (m) { return m.nom === b.nom; })[0];
  if (!def) return { code: 400, ok: false, error: 'modele_inconnu' };
  if (Core.contientPrix(def.corps)) return { code: 409, ok: false, error: 'prix_dans_le_modele' };
  const { getWhatsappCreds, graph } = require('./_whatsappClient');
  const creds = await getWhatsappCreds();
  if (!creds.wabaId) return { code: 409, ok: false, error: 'wabaId_absent' };
  const composants = [];
  if (def.entete === 'VIDEO') {
    const url = String(b.videoUrl || '').trim();
    if (!/^https:\/\//.test(url)) return { code: 400, ok: false, error: 'video_requise', detail: 'URL https publique de la vidéo (mp4, 16 Mo max).' };
    const h = await televerserExemple(url, creds, graph);
    if (!h.ok) return { code: 502, ok: false, error: 'televersement_video', detail: h.erreur };
    composants.push({ type: 'HEADER', format: 'VIDEO', example: { header_handle: [h.handle] } });
  }
  composants.push({ type: 'BODY', text: def.corps, example: { body_text: [def.exemples] } });
  if (def.pied) composants.push({ type: 'FOOTER', text: def.pied });
  composants.push({ type: 'BUTTONS', buttons: def.boutons.map(function (x) {
    return x.type === 'URL'
      ? { type: 'URL', text: x.texte, url: R.BASE_URL + '/r/{{1}}', example: [R.BASE_URL + '/r/exemple'] }
      : { type: 'QUICK_REPLY', text: x.texte };
  }) });
  const rep = await graph(creds.wabaId + '/message_templates', { method: 'POST',
    body: { name: def.nom, language: def.langue, category: def.categorie, components: composants } });
  if (!rep.ok) return { code: 502, ok: false, error: 'refus_meta', detail: rep.erreur, codeMeta: rep.code };
  return { ok: true, meta: rep.data };
}
async function televerserExemple(url, creds, graph) {
  let buf, mime;
  try {
    const r = await fetch(url);
    if (!r.ok) return { ok: false, erreur: 'vidéo inaccessible (HTTP ' + r.status + ')' };
    mime = String(r.headers.get('content-type') || 'video/mp4').split(';')[0];
    buf = Buffer.from(await r.arrayBuffer());
  } catch (e) { return { ok: false, erreur: 'vidéo inaccessible : ' + (e && e.message) }; }
  if (buf.length > 16 * 1024 * 1024) return { ok: false, erreur: 'vidéo de plus de 16 Mo' };
  if (mime !== 'video/mp4' && mime !== 'video/3gpp') mime = 'video/mp4';
  let appId = null;
  const a = await graph('app');
  if (a.ok && a.data && a.data.id) appId = a.data.id;
  if (!appId) {
    const d = await graph('debug_token?input_token=' + encodeURIComponent(creds.token));
    appId = d.ok && d.data && d.data.data ? d.data.data.app_id : null;
  }
  if (!appId) return { ok: false, erreur: 'identifiant de l\'application Meta introuvable' };
  const base = 'https://graph.facebook.com/' + creds.apiVersion + '/';
  const s1 = await fetch(base + appId + '/uploads?file_name=relance.mp4&file_length=' + buf.length + '&file_type=' + encodeURIComponent(mime),
    { method: 'POST', headers: { Authorization: 'Bearer ' + creds.token } }).then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!s1 || !s1.id) return { ok: false, erreur: 'ouverture du téléversement refusée' + (s1 && s1.error ? ' : ' + s1.error.message : '') };
  const s2 = await fetch(base + s1.id, { method: 'POST', headers: { Authorization: 'OAuth ' + creds.token, file_offset: '0' }, body: buf })
    .then(function (r) { return r.json(); }).catch(function () { return null; });
  if (!s2 || !s2.h) return { ok: false, erreur: 'téléversement refusé' + (s2 && s2.error ? ' : ' + s2.error.message : '') };
  return { ok: true, handle: s2.h };
}

/* ── Routeur ───────────────────────────────────────────────────────────── */
module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  try {
    let r;
    if (req.method === 'GET') {
      r = await etat();
    } else if (req.method === 'POST') {
      const b = parseBody(req) || {};
      const a = String(b.action || '');
      if (a === 'apercu') r = await apercu(b);
      else if (a === 'segment') r = await enregistrerSegment(b, auth);
      else if (a === 'campagne') r = await enregistrerCampagne(b, auth);
      else if (a === 'modeles') { const m = await modelesApprouves(); r = { ok: !m.erreur, erreur: m.erreur, modeles: m.liste }; }
      else if (a === 'modelesProposes') r = { ok: true, modeles: MODELES_PROPOSES };
      else if (a === 'soumettreModele') r = await soumettreModele(b);
      else if (a === 'test') r = await tester(b, auth);
      else if (a === 'preparer') r = await preparer(b);
      else if (a === 'lancer') r = await lancer(b, auth);
      else if (a === 'pause' || a === 'reprendre' || a === 'arreter') r = await changerEtat(b, auth, a);
      else if (a === 'stats') r = await stats(b);
      else if (a === 'config') r = await majConfig(b, auth);
      else if (a === 'preconfigurer') r = await preconfigurer(auth);
      else r = { code: 400, ok: false, error: 'action_inconnue' };
    } else {
      r = { code: 405, ok: false, error: 'method_not_allowed' };
    }
    const code = r.code || 200;
    delete r.code;
    res.status(code).json(r);
  } catch (e) {
    console.error('[relances]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
