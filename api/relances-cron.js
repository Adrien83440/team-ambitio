// ============================================================================
// api/relances-cron.js — ENVOIS PLANIFIÉS DES RELANCES (12/11/2026)
// ----------------------------------------------------------------------------
// Cron Vercel toutes les 10 minutes.
//   GET  Bearer <CRON_SECRET>                       → passe réelle
//   POST Bearer <ID token admin> { dryRun:true }    → ce qui partirait, sans
//                                                     rien envoyer ni écrire
//
// NE FAIT RIEN tant que _config/relances.modeTest n'est pas explicitement
// `false`. Les tests passent par api/relances.js (« M'envoyer un test »),
// jamais par ici.
//
// À CHAQUE PASSAGE
//   1. Plage d'envoi : 9 h – 19 h heure de Paris, ni dimanche ni jour férié.
//   2. Qualité du numéro WhatsApp (Meta) : ROUGE → toutes les campagnes en
//      pause, rien ne part (le numéro sert aussi aux rappels de coaching).
//   3. Rattrapage des échecs WhatsApp ASYNCHRONES (« pas sur WhatsApp »,
//      131026…) : le SMS de repli part.
//   4. Étapes dues, LISSÉES sur la journée (à 9 h, 111 leads dus partent par
//      paquets jusqu'à 19 h, pas en une rafale), dans la limite du plafond
//      quotidien de NOUVEAUX leads par campagne et de 80 % du palier Meta.
//   5. Avant CHAQUE envoi, la fiche est relue : réponse, RDV, STOP, client,
//      exclusion… → séquence arrêtée au lieu d'envoyer.
//
// ANTI-DOUBLON : chaque envoi est réservé par une transaction sur
// l'inscription (`envoiEnCours`) avant de partir. Une réservation de plus de
// 10 minutes est considérée comme abandonnée (fonction tuée).
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const R = require('./_relances');

const Core = R.Core;
const FV = admin.firestore.FieldValue;
const PAS_MIN = 10;              // intervalle du cron
const MAX_PAR_PASSAGE = 45;      // ~1 s par envoi : large marge sous 300 s
const RESERVATION_MS = 10 * 60000;

function checkCron(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, code: 500, error: 'CRON_SECRET non configuré' };
  const h = req.headers.authorization || '';
  const bearer = h.startsWith('Bearer ') ? h.slice(7).trim() : null;
  if (bearer === secret || req.headers['x-api-key'] === secret) return { ok: true };
  return { ok: false, code: 401, error: 'Non autorisé' };
}

/* ── Variables d'un message pour un lead ───────────────────────────────── */
async function variables(insc, lead, camp, cfg, liste, etape, dry) {
  /* {{setter}} = le setter assigné. Avec lienRdv 'setter', c'est la personne
     dont le lien sera ouvert (le setter de repli si l'assigné n'en a pas) :
     le message et le calendrier nomment alors la même personne. */
  const choix = R.typeReservation(ctxTypes(), camp, cfg, lead.assignedTo);
  const setterSlug = (choix && choix.setter) || lead.assignedTo || camp.setterRepli || cfg.setterRepli || null;
  const m = setterSlug ? R.membre(liste, setterSlug) : null;
  const v = { prenom: Core.prenom(lead), setter: m ? m.nom : '' };
  const besoins = JSON.stringify([etape.texte, etape.texteRepli, etape.objet]) + (etape.canal === 'whatsapp' ? '{{lien_rdv}}' : '');
  const liens = Object.assign({}, insc.liens || {});
  if (/lien_rdv/.test(besoins)) {
    if (!liens.rdv && !dry) liens.rdv = await R.creerLien({ type: 'rdv', campagneId: camp.id, inscriptionId: insc.id, leadId: insc.leadId });
    v.lien_rdv = R.urlLien(liens.rdv || 'apercu');
  }
  if (/lien_video/.test(besoins)) {
    if (!liens.video && !dry) liens.video = await R.creerLien({ type: 'video', campagneId: camp.id, inscriptionId: insc.id, leadId: insc.leadId });
    v.lien_video = R.urlLien(liens.video || 'apercu');
  }
  if (/lien_stop/.test(besoins)) {
    if (!liens.stop && !dry) liens.stop = await R.creerLien({ type: 'stop', campagneId: camp.id, inscriptionId: insc.id, leadId: insc.leadId });
    v.lien_stop = R.urlLien(liens.stop || 'apercu');
  }
  return { vars: v, liens: liens };
}

let _types = [];
function ctxTypes() { return _types; }

function prochainInstant(jourDepart, etape, cfg) {
  return Core.instantParis(Core.jourEtape(jourDepart, etape.delaiJours), +cfg.heureDebut || 9);
}

/* ── Réservation d'un envoi ────────────────────────────────────────────── */
async function reserver(id, attendu, now) {
  const ref = db.collection('relance_inscriptions').doc(id);
  return db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    if (!s.exists) return null;
    const d = s.data() || {};
    if (d.etat !== 'active' || d.etape !== attendu) return null;
    if (d.envoiEnCours && now - d.envoiEnCours < RESERVATION_MS) return null;
    tx.set(ref, { envoiEnCours: now }, { merge: true });
    return Object.assign({ id: id }, d);
  });
}

async function journalEnvoi(camp, insc, n, r, test) {
  await db.collection('relance_envois').add({
    campagneId: camp.id, inscriptionId: insc.id, leadId: insc.leadId, etape: n,
    canal: r.canal || null, fournisseurId: r.id || null, ok: !!r.ok, erreur: r.erreur || null,
    code: r.code || null, bascule: !!r.bascule, erreurWhatsapp: r.erreurWhatsapp || null,
    test: !!test, at: Date.now(), jour: Core.aujourdhui(),
  });
}

async function compter(campId, champs) {
  const jour = Core.aujourdhui();
  const inc = {};
  Object.keys(champs).forEach(function (k) { if (champs[k]) inc[k] = FV.increment(champs[k]); });
  if (!Object.keys(inc).length) return;
  await Promise.all([
    db.collection('relance_compteurs').doc(jour + '_' + campId).set(Object.assign({ jour: jour, campagneId: campId }, inc), { merge: true }),
    db.collection('relance_compteurs').doc(jour).set(Object.assign({ jour: jour }, inc), { merge: true }),
  ]);
}

/* ── Un envoi ──────────────────────────────────────────────────────────── */
async function traiter(insc0, camp, ctx) {
  const now = Date.now();
  const n = insc0.etape;
  const etape = camp.etapes[n];
  if (!etape) return { id: insc0.id, saute: 'etape_absente' };
  if (ctx.dry) return { id: insc0.id, lead: insc0.leadId, etape: n, canal: etape.canal, dry: true };

  const insc = await reserver(insc0.id, n, now);
  if (!insc) return { id: insc0.id, saute: 'deja_pris' };
  const ref = db.collection('relance_inscriptions').doc(insc.id);
  try {
    const ls = await db.collection('leads').doc(String(insc.leadId)).get();
    const lead = ls.exists ? Object.assign({ id: ls.id }, ls.data() || {}) : null;
    const motif = await R.motifArret(insc, lead, ctx.cfg);
    if (motif) {
      await R.arreter(insc.id, motif);
      return { id: insc.id, arret: motif };
    }
    /* WhatsApp au-delà de 80 % du palier Meta : l'étape attend demain. */
    if (etape.canal === 'whatsapp' && ctx.limiteWa && ctx.waJour >= ctx.limiteWa) {
      const demain = Core.prochainJourOuvre(Core.decaler(Core.aujourdhui(), 1));
      await ref.set({ envoiEnCours: null, prochainA: Core.instantParis(demain, +ctx.cfg.heureDebut || 9) }, { merge: true });
      return { id: insc.id, reporte: 'palier_whatsapp' };
    }

    const vv = await variables(insc, lead, camp, ctx.cfg, ctx.membres, etape, false);
    const r = await R.envoyerEtape({ etape: etape, lead: lead, inscription: insc, campagne: camp, cfg: ctx.cfg,
      modeles: ctx.modeles, vars: vv.vars });
    if (r.pasDeRepli) {
      /* Problème de configuration (vidéo), pas du lead : rien n'est compté,
         l'étape repartira au prochain passage. */
      await ref.set({ envoiEnCours: null }, { merge: true });
      return { id: insc.id, reporte: r.erreur };
    }
    await journalEnvoi(camp, insc, n, r, false);
    await R.tracerSurLead(insc.leadId, r, camp, n);
    if (r.ok && r.canal === 'whatsapp') ctx.waJour++;
    await compter(camp.id, { envois: r.ok ? 1 : 0, debuts: (r.ok && n === 0) ? 1 : 0,
      whatsapp: (r.ok && r.canal === 'whatsapp') ? 1 : 0, echecs: r.ok ? 0 : 1 });

    const jourDepart = n === 0 ? Core.aujourdhui() : insc.jourDepart;
    const suivante = camp.etapes[n + 1];
    const echecs = r.ok ? 0 : (+insc.echecsSuite || 0) + 1;
    const patch = {
      envoiEnCours: null, liens: vv.liens, derniereEtape: n, dernierEnvoiA: now, echecsSuite: echecs,
      envois: FV.arrayUnion({ n: n, canal: r.canal || null, id: r.id || null, ok: !!r.ok, bascule: !!r.bascule,
        erreur: r.erreur || null, at: now }),
      aVerifier: (r.ok && r.canal === 'whatsapp') ? { wamid: r.id, n: n, at: now } : null,
      /* Interrogeable même une fois la séquence terminée : un « pas sur
         WhatsApp » arrive APRÈS l'envoi, souvent après la dernière étape. */
      aVerifierActif: !!(r.ok && r.canal === 'whatsapp'),
    };
    if (n === 0) { patch.debutA = now; patch.jourDepart = jourDepart; }
    if (!r.ok && echecs >= 2) {
      await ref.set(patch, { merge: true });
      await R.arreter(insc.id, 'injoignable');
      return { id: insc.id, echec: r.erreur, arret: 'injoignable' };
    }
    if (suivante) {
      patch.etape = n + 1;
      patch.prochainA = prochainInstant(jourDepart, suivante, ctx.cfg);
      await ref.set(patch, { merge: true });
    } else {
      patch.etape = n + 1;
      patch.etat = 'terminee';
      patch.termineeA = now;
      await ref.set(patch, { merge: true });
      await db.collection('relance_verrous').doc(String(insc.leadId)).set({ actif: false, libereA: now, motif: 'terminee' }, { merge: true });
    }
    return { id: insc.id, etape: n, canal: r.canal, ok: r.ok, bascule: !!r.bascule, erreur: r.erreur || null };
  } catch (e) {
    console.error('[relances-cron] traiter', insc.id, e && e.stack ? e.stack : e);
    await ref.set({ envoiEnCours: null, derniereErreur: String(e && e.message || e).slice(0, 300) }, { merge: true }).catch(function () {});
    return { id: insc.id, erreur: e && e.message };
  }
}

/* ── Échec WhatsApp asynchrone → SMS de repli ──────────────────────────── */
async function rattraper(insc, camp, ctx) {
  const av = insc.aVerifier;
  const now = Date.now();
  const ref = db.collection('relance_inscriptions').doc(insc.id);
  /* 72 h : un échec signalé samedi soir n'est rattrapable que lundi matin
     (rien ne part le dimanche). À 36 h, le SMS de repli était perdu. */
  if (now - av.at > 72 * 3600000) { if (!ctx.dry) await ref.set({ aVerifier: null, aVerifierActif: false }, { merge: true }); return null; }
  const s = await db.collection('whatsapp_messages').doc(String(av.wamid)).get();
  const statut = s.exists ? (s.data() || {}).statut : null;
  if (statut === 'delivered' || statut === 'read') { if (!ctx.dry) await ref.set({ aVerifier: null, aVerifierActif: false }, { merge: true }); return null; }
  if (statut !== 'failed') return null;
  const etape = camp.etapes[av.n] || {};
  if (ctx.dry) return { id: insc.id, rattrapage: 'sms', etape: av.n };
  if (!String(etape.texteRepli || '').trim()) { await ref.set({ aVerifier: null, aVerifierActif: false }, { merge: true }); return { id: insc.id, rattrapage: 'aucun_texte_repli' }; }
  const ok = await db.runTransaction(async function (tx) {
    const x = await tx.get(ref);
    const d = x.data() || {};
    if (!d.aVerifier || d.aVerifier.wamid !== av.wamid) return false;
    tx.set(ref, { aVerifier: null, aVerifierActif: false }, { merge: true });
    return true;
  });
  if (!ok) return null;
  const ls = await db.collection('leads').doc(String(insc.leadId)).get();
  const lead = ls.exists ? Object.assign({ id: ls.id }, ls.data() || {}) : null;
  const motif = await R.motifArret(insc, lead, ctx.cfg);
  if (motif) { await R.arreter(insc.id, motif); return { id: insc.id, arret: motif }; }
  const vv = await variables(insc, lead, camp, ctx.cfg, ctx.membres, etape, false);
  const texte = Core.remplir(etape.texteRepli, vv.vars);
  const r = await R.envoyerSms(texte, Core.telephoneE164(lead.telephone), { module: 'relances' });
  r.bascule = true;
  r.erreurWhatsapp = (s.data() || {}).erreurMeta ? JSON.stringify((s.data() || {}).erreurMeta).slice(0, 200) : 'failed';
  await journalEnvoi(camp, insc, av.n, r, false);
  await R.tracerSurLead(insc.leadId, r, camp, av.n);
  await compter(camp.id, { envois: r.ok ? 1 : 0, rattrapages: 1 });
  await ref.set({ liens: vv.liens, envois: FV.arrayUnion({ n: av.n, canal: 'sms', id: r.id || null, ok: !!r.ok,
    bascule: true, erreur: r.erreur || null, at: Date.now() }) }, { merge: true });
  return { id: insc.id, rattrapage: 'sms', ok: r.ok };
}

/* ── Passage complet ───────────────────────────────────────────────────── */
async function passage(dry) {
  const cfg = await R.config();
  const now = Date.now();
  const rapport = { ok: true, dry: !!dry, at: new Date(now).toISOString() };
  /* Le dry-run passe outre les deux portes (il n'envoie rien) : c'est lui qui
     montre, avant la mise en production, ce que le premier passage ferait. */
  rapport.modeTest = cfg.modeTest !== false;
  rapport.ouvert = Core.ouvert(now, cfg);
  if (!dry && rapport.modeTest) return Object.assign(rapport, { saute: 'mode_test' });
  if (!dry && !rapport.ouvert) return Object.assign(rapport, { saute: 'hors_plage' });

  const cs = await db.collection('relance_campagnes').where('etat', '==', 'en_cours').get();
  const camps = {};
  cs.forEach(function (d) { camps[d.id] = Object.assign({ id: d.id }, d.data() || {}); });
  let ids = Object.keys(camps);
  if (!ids.length) return Object.assign(rapport, { saute: 'aucune_campagne' });

  const ctx = { cfg: cfg, dry: !!dry, membres: await R.membres(), modeles: {}, limiteWa: null, waJour: 0 };
  _types = await R.typesRdv();
  const avecWa = ids.some(function (id) { return (camps[id].etapes || []).some(function (e) { return e.canal === 'whatsapp'; }); });
  if (avecWa) {
    const q = await R.qualiteWhatsapp();
    rapport.whatsapp = q;
    if (q.ok && q.qualite === 'RED' && cfg.pauseSiQualiteRouge !== false) {
      if (!dry) {
        await Promise.all(ids.map(function (id) {
          return db.collection('relance_campagnes').doc(id).set({ etat: 'pause', motifPause: 'qualite_whatsapp_rouge', pauseA: now }, { merge: true });
        }));
      }
      return Object.assign(rapport, { saute: 'qualite_whatsapp_rouge', pausees: ids });
    }
    if (q.ok && q.limite) ctx.limiteWa = Math.floor(q.limite * 0.8);
    const mw = await R.modelesWhatsapp();
    /* Liste des modèles illisible (panne Meta passagère) : on ne décide rien,
       on réessaie au prochain passage — surtout pas de pause ni de SMS. */
    if (!mw.ok) return Object.assign(rapport, { saute: 'modeles_illisibles', detail: mw.erreur || null });
    (mw.modeles || []).forEach(function (m) { if (String(m.statut).toUpperCase() === 'APPROVED') ctx.modeles[m.nom] = m; });
    /* Modèle repassé en relecture chez Meta (modifié, mis en pause…) pendant
       une campagne : PAUSE, jamais une bascule de tous les leads en SMS. */
    for (let c = 0; c < ids.length; c++) {
      const camp = camps[ids[c]];
      const absent = (camp.etapes || []).filter(function (e) { return e.canal === 'whatsapp' && !ctx.modeles[e.modele]; })[0];
      if (absent) {
        if (!dry) {
          await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'pause', motifPause: 'modele_non_approuve',
            detailPause: 'Le modèle « ' + absent.modele + ' » n\'est plus approuvé chez Meta (en relecture ?). Reprends la campagne une fois validé.', pauseA: now }, { merge: true });
        }
        rapport.pausees = (rapport.pausees || []).concat([{ id: camp.id, motif: 'modele_non_approuve' }]);
        delete camps[ids[c]];
      }
    }
    ids = Object.keys(camps);
    /* Vidéo d'en-tête prête AVANT d'envoyer : sinon on mettrait la campagne en
       pause plutôt que de faire échouer (ou basculer en SMS) chaque lead. */
    for (let c = 0; c < ids.length; c++) {
      const camp = camps[ids[c]];
      const etapesVideo = (camp.etapes || []).filter(function (e) {
        const m = e.canal === 'whatsapp' ? ctx.modeles[e.modele] : null;
        return m && (m.enteteFormat === 'VIDEO' || m.enteteFormat === 'IMAGE');
      });
      for (let k = 0; k < etapesVideo.length; k++) {
        const mv = dry ? {} : await R.mediaEntete(ctx.modeles[etapesVideo[k].modele], etapesVideo[k]);
        if (mv.erreur) {
          await db.collection('relance_campagnes').doc(camp.id).set({ etat: 'pause', motifPause: 'video_indisponible',
            detailPause: String(mv.erreur).slice(0, 300), pauseA: now }, { merge: true });
          rapport.pausees = (rapport.pausees || []).concat([{ id: camp.id, motif: mv.erreur }]);
          delete camps[ids[c]];
          break;
        }
      }
    }
  }
  const jour = Core.aujourdhui();
  const cg = await db.collection('relance_compteurs').doc(jour).get();
  ctx.waJour = cg.exists ? (+(cg.data() || {}).whatsapp || 0) : 0;

  ids = Object.keys(camps); // après le contrôle vidéo : sans les campagnes mises en pause
  if (!ids.length) return Object.assign(rapport, { saute: 'aucune_campagne_envoyable' });
  const is = await db.collection('relance_inscriptions').where('etat', '==', 'active').get();
  const actives = [];
  is.forEach(function (d) {
    const x = Object.assign({ id: d.id }, d.data() || {});
    if (camps[x.campagneId]) actives.push(x);
  });

  /* 3. Rattrapages — sur TOUTE inscription en attente de vérification, y
     compris terminée (campagne d'un seul message). */
  const av = await db.collection('relance_inscriptions').where('aVerifierActif', '==', true).get();
  const enAttente = [];
  av.forEach(function (d) {
    const x = Object.assign({ id: d.id }, d.data() || {});
    if (camps[x.campagneId]) enAttente.push(x);
  });
  const rattrapages = [];
  for (let i = 0; i < enAttente.length; i++) {
    const x = enAttente[i];
    if (x.aVerifier && x.aVerifier.wamid && now - x.aVerifier.at > 10 * 60000) {
      const r = await rattraper(x, camps[x.campagneId], ctx);
      if (r) rattrapages.push(r);
    }
  }
  rapport.rattrapages = rattrapages;

  /* 4. Étapes dues, lissées */
  const passagesRestants = Math.max(1, Math.ceil(Core.minutesRestantes(now, cfg) / PAS_MIN));
  const choisis = [];
  for (let c = 0; c < ids.length; c++) {
    const camp = camps[ids[c]];
    const dues = actives.filter(function (x) { return x.campagneId === camp.id && (+x.prochainA || 0) <= now && !x.envoiEnCours; })
      .sort(function (a, b) { return (+a.prochainA || 0) - (+b.prochainA || 0); });
    const debuts = dues.filter(function (x) { return x.etape === 0; });
    const suites = dues.filter(function (x) { return x.etape > 0; });
    const cc = await db.collection('relance_compteurs').doc(jour + '_' + camp.id).get();
    const faits = cc.exists ? (+(cc.data() || {}).debuts || 0) : 0;
    const plafond = +camp.plafondJour || +cfg.plafondJour || 100;
    const nDebuts = Math.max(0, Math.min(plafond - faits, Math.ceil(debuts.length / passagesRestants)));
    const nSuites = Math.ceil(suites.length / passagesRestants);
    debuts.slice(0, nDebuts).concat(suites.slice(0, nSuites)).forEach(function (x) { choisis.push([x, camp]); });
  }
  const lot = choisis.slice(0, MAX_PAR_PASSAGE);
  const resultats = [];
  for (let i = 0; i < lot.length; i++) resultats.push(await traiter(lot[i][0], lot[i][1], ctx));
  rapport.envois = resultats;
  rapport.dues = choisis.length;

  /* Campagne vide → terminée */
  if (!dry) {
    for (let c = 0; c < ids.length; c++) {
      const reste = actives.filter(function (x) { return x.campagneId === ids[c]; }).length
        + enAttente.filter(function (x) { return x.campagneId === ids[c]; }).length;
      if (!reste) {
        await db.collection('relance_campagnes').doc(ids[c]).set({ etat: 'terminee', termineeA: now }, { merge: true });
        /* Campagne de suivi créée d'office, en BROUILLON (Adrien, 14/11/2026). */
        await R.creerSuivi(Object.assign({}, camps[ids[c]], { etat: 'terminee' })).catch(function (e) { console.error('[relances-cron] suivi', ids[c], e && e.message); });
      }
    }
  }
  return rapport;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'GET') {
      const a = checkCron(req);
      if (!a.ok) { res.status(a.code).json({ ok: false, error: a.error }); return; }
      const r = await passage(false);
      console.log('[relances-cron]', JSON.stringify({ saute: r.saute || null, dues: r.dues || 0,
        envois: (r.envois || []).length, rattrapages: (r.rattrapages || []).length }));
      res.status(200).json(r);
      return;
    }
    if (req.method === 'POST') {
      const auth = await requireAdmin(req, res);
      if (!auth) return;
      const b = parseBody(req) || {};
      res.status(200).json(await passage(b.dryRun !== false));
      return;
    }
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
  } catch (e) {
    console.error('[relances-cron]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error', detail: e && e.message });
  }
};
