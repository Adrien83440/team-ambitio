// ============================================================================
// api/coaching-client-ensure.js — LA FICHE COACHING D'UN CLIENT, AU CLOSE
// ----------------------------------------------------------------------------
// POST /api/coaching-client-ensure   { leadId, coachNom?, dryRun? }  + Bearer
//   → 200 { ok:true, created:true,  clientId, programme, label }
//   → 200 { ok:true, created:false, clientId, programme, label, linked? }
//   → 200 { ok:true, dryRun:true, existing?, programme, label, nom, ... }
//   → 409 { ok:false, error:'not_client' | 'lead_merged' }
//   → 422 { ok:false, error:'programme_inconnu' }
//
// POURQUOI CET ENDPOINT
// ---------------------
// Jusqu'au 18/09/2026, une Cloud Function (`onLeadUpdate`, branche
// « autoCoaching » du _sync.js de PRODUCTION) créait la fiche `clients` dès
// qu'un lead passait client, et remplissait sur la fiche `persons` le contrat
// signé et le programme détecté. Ce code n'a jamais été dans le repo : le
// déploiement des functions du 26/09/2026 (rapatriement vérifié sur index.js
// seulement) l'a écrasé. Depuis, plus aucune fiche coaching ne se créait —
// Yann rattrapé par script le 07/10, Charlotte et Hugo Michel restés sans
// fiche le 13/10, donc absents de Coaching ET du CSM.
//
// Décision Adrien (13/10/2026) : la fiche se crée à la VALIDATION DU CLOSE,
// pas à la signature — une signature seule ne vaut pas close (même règle que
// le pilote de closing, commit bae9065). Appelé par close-wizard.js après
// l'enregistrement du close, et par le bouton de rattrapage de la fiche
// admin persons. Code serveur : les règles réservent la création de
// `clients` aux coachs/admins et l'écriture de `persons` aux admins.
//
// DEUX PROGRAMMES, PAS UN DE PLUS
// -------------------------------
// Seuls Elite Phénix et Business Phénix sont vendus aujourd'hui ; les autres
// programmes de coaching.html ne concernent que d'anciens clients. Le
// programme vient, dans l'ordre : de l'offre du close (closedData.offre),
// du choix du pilote de closing, puis du dernier contrat signé NON annulé.
// Rien de reconnu → on ne devine pas, on le dit (422).
//
// IDEMPOTENCE
// -----------
// La création se fait dans une transaction sur la fiche lead, qui reçoit
// `coachingClientId` : deux appels simultanés (close + rattrapage, double
// clic) ne créent jamais deux fiches. Une fiche coaching déjà existante pour
// ce client (même lead, même persons ou même e-mail) est reliée, jamais
// dupliquée.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const BP = require('../bp-credits.js');

const ROLES = ['admin', 'sales'];

/* Mêmes valeurs que le sélecteur « Nouveau client coaching » de coaching.html
   et que les fiches créées automatiquement jusqu'au 18/09/2026. */
const PROGRAMMES = {
  elite: { programme: 'Elite NEW - 6 Mois - 24C', nb: 24, label: 'Elite Phénix' },
  business: { programme: 'BP 12 Mois - 12C', nb: 12, label: 'Business Phénix — ancienne formule 12 mois' },
  /* Nouveau format (14/10/2026) : RDV audit business + 10 séances sur
     180 jours à compter de la signature — règles dans ../bp-credits.js. */
  business_v2: { programme: BP.PROGRAMME, nb: BP.TOTAL, label: BP.LIBELLE, v2: true },
};

/* Business : nouveau format ou ancienne formule ? Le CONTRAT SIGNÉ décide
   (décision Adrien 14/10/2026) : le modèle « Business Phénix 6 mois »
   (_config/business_phenix.templateIds, sinon nom « business … 6 mois »)
   → nouveau format ; un contrat Business 12 mois (BP12…) → ancienne
   formule. Sans contrat Business signé : l'interrupteur du moment. */
function estModeleBpV2(contrat, cfg) {
  if (!contrat) return false;
  if ((cfg.templateIds || []).indexOf(contrat.templateId) >= 0) return true;
  const n = fold(contrat.templateName);
  return n.indexOf('business') >= 0 && /6\s*mois/.test(n);
}
function formatBusiness(contrat, cfg) {
  if (estModeleBpV2(contrat, cfg)) return 'business_v2';
  if (contrat && programmeKey(contrat.templateName) === 'business') return 'business';
  return cfg.active === true ? 'business_v2' : 'business';
}

function fold(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/* « Elite », « BP 12 », « Business », « EP6 12K/13K », « BP12 6K MENS »… */
function programmeKey(s) {
  const f = fold(s);
  if (!f) return null;
  if (f.indexOf('elite') >= 0 || /^ep\s?\d/.test(f)) return 'elite';
  if (f.indexOf('business') >= 0 || /^bp\s?\d/.test(f)) return 'business';
  return null;
}

function ms(v) {
  if (!v) return 0;
  if (typeof v === 'number') return v;
  if (v.toMillis) return v.toMillis();
  if (v._seconds) return v._seconds * 1000;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/* AAAA-MM-JJ à Paris — format de dateEntree des fiches récentes. */
function dayParis(d) {
  return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/* Même gabarit que generateSessionsTemplate() de coaching.html : séance 72 h
   (numero 0, hors quota) puis les coachings numérotés. */
function sessionsTemplate(nb) {
  const out = [{ numero: 0, titre: 'RDV URGENT 72H', date: '', coach: '', resume: '', devoirs: '', statut: 'planifie', type: 'rdv72h' }];
  for (let i = 1; i <= nb; i++) {
    out.push({ numero: i, titre: 'COACHING #' + i, date: '', coach: '', resume: '', devoirs: '', statut: 'planifie' });
  }
  return out;
}

/* Contrats signés du client, du plus récent au plus ancien. Les contrats
   annulés (status 'cancelled') sont exclus d'office. */
async function contratsSignes(leadId, email) {
  const seen = {};
  const out = [];
  function add(snap) {
    snap.forEach(function (d) {
      if (seen[d.id]) return;
      seen[d.id] = 1;
      const x = d.data() || {};
      if (x.status === 'signed') out.push(Object.assign({ _id: d.id }, x));
    });
  }
  const col = db.collection('signature_requests');
  add(await col.where('leadId', '==', leadId).get());
  if (email) add(await col.where('clientEmail', '==', email).get());
  out.sort(function (a, b) { return ms(b.signedAt) - ms(a.signedAt); });
  return out;
}

function vide(v) {
  return v == null || String(v).trim() === '';
}

/* Identité société du dernier contrat signé : le signataire la choisit dans
   l'annuaire officiel pendant la signature (sign.html, recherche-entreprises
   .api.gouv.fr) — SIRET, TVA, forme, adresse du siège. */
function identiteSociete(contrat) {
  const c = contrat && contrat.company;
  if (!c || (vide(c.name) && vide(c.siret))) return null;
  const a = c.address || {};
  return {
    companyName: String(c.name || '').trim(),
    companyLegalForm: String(c.legalFormLabel || '').trim(),
    siret: String(c.siret || '').replace(/\s+/g, ''),
    vatNumber: String(c.vatNumber || '').replace(/\s+/g, ''),
    address: { line1: a.line1 || '', line2: a.line2 || '', postalCode: a.postalCode || '', city: a.city || '', country: a.country || 'France' },
    nafLabel: String(c.nafLabel || '').trim(),
  };
}

/* Nom complet du représentant signataire (« Marie Charlotte DESTOUT »). */
function nomRepresentant(contrat) {
  const r = contrat && contrat.representative;
  if (!r) return '';
  return (String(r.firstName || '').trim() + ' ' + String(r.lastName || '').trim()).trim();
}

/* Le lead ne porte souvent qu'un prénom (opt-in) : on prend le nom complet
   du représentant quand il CONTIENT ce prénom — jamais un autre nom. */
function meilleurNom(nomLead, contrat) {
  const n = String(nomLead || '').trim();
  const rep = nomRepresentant(contrat);
  if (!rep) return n;
  if (!n) return rep;
  if (n.split(/\s+/).length === 1 && fold(rep).split(/\s+/).indexOf(fold(n)) >= 0) return rep;
  return n;
}

async function trouverPersons(leadId, L, email) {
  if (L.personId) {
    const s = await db.collection('persons').doc(L.personId).get();
    if (s.exists) return { id: s.id, data: s.data() || {} };
  }
  let q = await db.collection('persons').where('leadIds', 'array-contains', leadId).limit(1).get();
  if (q.empty && email) q = await db.collection('persons').where('email', '==', email).limit(1).get();
  if (q.empty) return null;
  const d = q.docs[0];
  if ((d.data() || {})._merged === true) return null;
  return { id: d.id, data: d.data() || {} };
}

/* Une fiche d'ancien client (fin d'accompagnement, inactive) ne se recycle
   pas : un ancien client qui rachète repart sur une fiche neuve. */
function ficheActive(x) {
  return !!x && x.ancienClient !== true && x.statut !== 'inactif';
}

/* Fiche coaching ACTIVE déjà en place pour ce client : lien posé sur le lead
   ou sur la persons, sinon même lead / même persons / même e-mail. */
async function ficheExistante(leadId, L, P, email) {
  const ids = [L.coachingClientId, P && P.data.coachingId].filter(Boolean);
  for (let i = 0; i < ids.length; i++) {
    const s = await db.collection('clients').doc(ids[i]).get();
    if (s.exists && ficheActive(s.data())) return { id: s.id, data: s.data() || {} };
  }
  const col = db.collection('clients');
  const tries = [col.where('_leadId', '==', leadId)];
  if (P) tries.push(col.where('personId', '==', P.id));
  if (email) tries.push(col.where('email', '==', email));
  for (let j = 0; j < tries.length; j++) {
    const q = await tries[j].limit(10).get();
    const hit = q.docs.find(function (d) { return ficheActive(d.data()); });
    if (hit) return { id: hit.id, data: hit.data() || {} };
  }
  return null;
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }

  const body = parseBody(req) || {};
  const leadId = String(body.leadId || '').trim();
  const coachNom = String(body.coachNom || '').trim();
  const dryRun = body.dryRun === true;
  if (!leadId) { res.status(400).json({ ok: false, error: 'leadId_required' }); return; }

  try {
    const leadRef = db.collection('leads').doc(leadId);
    const lSnap = await leadRef.get();
    if (!lSnap.exists) { res.status(404).json({ ok: false, error: 'lead_not_found' }); return; }
    const L = lSnap.data() || {};
    if (L._merged === true) { res.status(409).json({ ok: false, error: 'lead_merged' }); return; }
    const estClient = L.isClient === true || L.status === 'client' || String(L.stage || '').indexOf('closed_won') === 0;
    if (!estClient) { res.status(409).json({ ok: false, error: 'not_client' }); return; }

    const email = String(L.email || '').trim().toLowerCase();
    const contrats = await contratsSignes(leadId, email);
    const contrat = contrats[0] || null;
    const choix = (L.closePilot && L.closePilot.choix) || {};
    const key = programmeKey(L.closedData && L.closedData.offre)
      || programmeKey(choix.offre)
      || programmeKey(contrat && contrat.templateName);
    if (!key) {
      res.status(422).json({ ok: false, error: 'programme_inconnu', message: 'Ni le close ni un contrat signé n\'indiquent Elite Phénix ou Business Phénix.' });
      return;
    }
    let pgKey = key;
    if (key === 'business') {
      const cfgSnap = await db.collection('_config').doc('business_phenix').get();
      pgKey = formatBusiness(contrat, cfgSnap.exists ? (cfgSnap.data() || {}) : {});
    }
    const PG = PROGRAMMES[pgKey];

    const P = await trouverPersons(leadId, L, email);
    const existante = await ficheExistante(leadId, L, P, email);
    const coach = coachNom || (L.coachAssigne && L.coachAssigne.nom) || '';
    const nom = meilleurNom(String(L.nom || '').trim() || (P && P.data.nom) || '', contrat) || email;
    const soc = identiteSociete(contrat);
    const activite = String(L.secteur || '').trim()
      || (soc ? (soc.companyName + (soc.nafLabel ? ' — ' + soc.nafLabel : '')) : '');
    const dateEntree = dayParis(new Date(ms(L.clientSince) || Date.now()));
    /* J0 du nouveau format Business = DÉMARRAGE de l'accompagnement
       (décision Adrien 14/10/2026) : la signature si le client a renoncé au
       délai de rétractation, sinon J+15 — demarragePossibleLe, posé par
       sign-session. À défaut : date de signature, puis date d'entrée. */
    const demarrage = (function (s) { const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(s || '').trim()); return m ? m[3] + '-' + m[2] + '-' + m[1] : ''; })(contrat && contrat.demarragePossibleLe);
    const j0 = PG.v2 ? (demarrage || (contrat && ms(contrat.signedAt) ? dayParis(new Date(ms(contrat.signedAt))) : dateEntree)) : null;

    if (dryRun) {
      res.status(200).json({
        ok: true, dryRun: true, nom: nom, email: email,
        programme: PG.programme, label: PG.label, dateEntree: dateEntree, coach: coach || null,
        j0: j0, finAccompagnement: j0 ? BP.addDays(j0, BP.DUREE_JOURS) : null,
        personId: P ? P.id : null, contrat: contrat ? contrat.templateName || null : null,
        activite: activite || null, societe: soc ? soc.companyName + (soc.siret ? ' (SIRET ' + soc.siret + ')' : '') : null,
        existing: existante ? { clientId: existante.id, programme: existante.data.programme || null } : null,
      });
      return;
    }

    /* Paiements du lead sans personId : rattachés après coup (paiement créé
       hors fiche puis relié au lead), ils restaient invisibles de la fiche
       admin — Charlotte, 13/10/2026. La synchro ne pose personId qu'à la
       création du paiement ou de la persons. */
    async function rattacherPaiements() {
      if (!P) return 0;
      const snap = await db.collection('payments').where('leadId', '==', leadId).get();
      const ids = [];
      for (const d of snap.docs) {
        if ((d.data() || {}).personId) continue;
        await d.ref.update({ personId: P.id, _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp() });
        ids.push(d.id);
      }
      snap.docs.forEach(function (d) { if (ids.indexOf(d.id) < 0 && d.data().personId === P.id) ids.push(d.id); });
      if (ids.length) {
        await db.collection('persons').doc(P.id).update({ paymentIds: admin.firestore.FieldValue.arrayUnion.apply(null, ids) });
      }
      return ids.length;
    }

    /* Champs de la persons : contrat signé, programme détecté, identité
       société du contrat (champs VIDES seulement — une saisie à la main
       n'est jamais écrasée ; la synchro la recopie vers la fiche
       facturation reliée) et nom complet. */
    async function majPersons(clientId, statut) {
      if (!P) return;
      const PD = P.data || {};
      const upd = {
        coachingId: clientId,
        coachingStatus: statut || 'actif',
        detectedProgramme: PG.programme,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        _lastSyncedAt: admin.firestore.FieldValue.serverTimestamp(),
      };
      if (contrat) {
        upd.signedContractTemplateName = contrat.templateName || null;
        upd.signedContractRequestId = contrat._id;
        upd.signedContractSignedAt = contrat.signedAt || null;
      }
      if (soc) {
        if (vide(PD.companyName) && soc.companyName) upd.companyName = soc.companyName;
        if (vide(PD.companyLegalForm) && soc.companyLegalForm) upd.companyLegalForm = soc.companyLegalForm;
        if (vide(PD.siret) && soc.siret) upd.siret = soc.siret;
        if (vide(PD.vatNumber) && soc.vatNumber) upd.vatNumber = soc.vatNumber;
        if ((!PD.address || vide(PD.address.line1)) && soc.address.line1) upd.address = soc.address;
        if (vide(PD.clientType)) upd.clientType = 'company';
      }
      if (nom && nom !== PD.nom && meilleurNom(PD.nom, contrat) === nom) upd.nom = nom;
      await db.collection('persons').doc(P.id).update(upd);
      await rattacherPaiements();
    }

    if (existante) {
      const lien = {};
      if (L.coachingClientId !== existante.id) lien.coachingClientId = existante.id;
      if (Object.keys(lien).length) await leadRef.update(lien);
      const fix = {};
      if (P && !existante.data.personId) fix.personId = P.id;
      if (coach && !existante.data.coach) fix.coach = coach;
      if (activite && vide(existante.data.activite)) fix.activite = activite;
      if (Object.keys(fix).length) await db.collection('clients').doc(existante.id).update(fix);
      await majPersons(existante.id, existante.data.statut);
      res.status(200).json({ ok: true, created: false, linked: true, clientId: existante.id, programme: existante.data.programme || null, label: PG.label });
      return;
    }

    const sessions = PG.v2 ? BP.sessionsTemplate() : sessionsTemplate(PG.nb);
    const tel = String(L.telephone || (P && P.data.telephone) || '').trim();
    /* Lien déjà présent à la lecture mais non retenu plus haut : fiche
       inactive ou disparue — il sera remplacé. Tout AUTRE lien apparu
       entre-temps vient d'un appel concurrent : on le garde. */
    const lienPerime = L.coachingClientId || null;
    const result = await db.runTransaction(async function (tx) {
      const s = await tx.get(leadRef);
      const cur = (s.data() || {}).coachingClientId;
      if (cur && cur !== lienPerime) return { created: false, clientId: cur };
      /* Identifiant au format historique cli_<ms>, vérifié libre : deux
         closes dans la même milliseconde ne s'écrasent pas. */
      let n = Date.now();
      let clientId = 'cli_' + n;
      for (let k = 0; k < 20; k++) {
        const pris = await tx.get(db.collection('clients').doc(clientId));
        if (!pris.exists) break;
        n += 1;
        clientId = 'cli_' + n;
      }
      const fiche = {
        nom: nom,
        email: email,
        tel: tel,
        telephone: tel,
        activite: activite,
        programme: PG.programme,
        dateEntree: dateEntree,
        nbCoachingsTotal: PG.nb,
        nbCoachingsFaits: 0,
        lastSessionDate: '',
        sessions: sessions,
        years: [{ yearNum: 1, label: 'Année 1', startDate: dateEntree, notes: PG.programme, sessions: sessions }],
        planAction: '',
        statut: 'actif',
        personId: P ? P.id : null,
        _leadId: leadId,
        source: 'auto_close',
        _createdBy: 'api:coaching-client-ensure',
        _createdByUser: auth.email || auth.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        _updatedAt: Date.now(),
      };
      if (coach) fiche.coach = coach;
      if (PG.v2) {
        fiche.j0 = j0;
        fiche.finAccompagnement = BP.addDays(j0, BP.DUREE_JOURS);
        fiche.formatOffre = 'bp_v2_6mois';
      }
      tx.set(db.collection('clients').doc(clientId), fiche);
      tx.update(leadRef, { coachingClientId: clientId });
      return { created: true, clientId: clientId };
    });

    if (result.created) await majPersons(result.clientId, 'actif');
    console.log('[coaching-client-ensure]', leadId, result.created ? 'créée' : 'déjà là', result.clientId, PG.programme, 'par=' + (auth.email || auth.uid));
    res.status(200).json({ ok: true, created: result.created, clientId: result.clientId, programme: PG.programme, label: PG.label });
  } catch (e) {
    console.error('[coaching-client-ensure]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
