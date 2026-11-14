// ============================================================================
// api/_relances.js — MOTEUR SERVEUR DU MODULE « RELANCES » (12/11/2026)
// ----------------------------------------------------------------------------
// Helper partagé (préfixe `_` : exclu du routing Vercel). Utilisé par :
//   · api/relances.js        page admin (segments, campagnes, test, stats)
//   · api/relances-cron.js   envois planifiés, toutes les 10 min
//   · api/_relances-hooks.js réponses entrantes (WhatsApp, SMS, e-mail)
//   · api/relance-lien.js    liens courts /r/{jeton}
//
// RIEN DE NEUF CÔTÉ FOURNISSEURS : WhatsApp = _whatsappClient (Meta Cloud
// API), SMS = Twilio (+33939240397, _config/telco_credentials), e-mail =
// _gmailSend (compte OAuth, `strategie` par défaut). Les règles (filtres,
// exclusions, calendrier, prix) vivent dans ../relances-core.js.
//
// DONNÉES (écriture Admin SDK seule — aucune règle Firestore nécessaire, la
// page ne lit rien en direct) :
//   _config/relances                 réglages (DEFAUTS dans relances-core.js)
//   relance_segments/{id}            { nom, filtres, creeA, creePar }
//   relance_campagnes/{id}           { nom, etat, vagues, etapes, dateDebut,
//                                      plafondJour, setterRepli, testOk… }
//   relance_inscriptions/{camp}_{lead} un lead dans une campagne
//   relance_verrous/{leadId}         { actif, campagneId } — une séquence à la fois
//   relance_exclusions/{leadId}      exclusion DÉFINITIVE (STOP, plus intéressé)
//   relance_envois/{id}              un message parti (ou tenté)
//   relance_liens/{jeton}            lien court → lien de réservation du setter
//   relance_compteurs/{AAAA-MM-JJ}   { debuts, envois, whatsapp }
//
// SUR LA FICHE LEAD, UNIQUEMENT DES AJOUTS : communications[] et
// timeline_history[] (historique), `relanceRepondu` (marqueur « a répondu »,
// reco 4 validée le 12/11/2026). Seul « Plus intéressé » change l'étape :
// stage 'disqualification' + status 'pas_interesse' (reco 5).
// ============================================================================

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const Core = require('../relances-core.js');
const { phoneNormalized } = require('./_leadLookup');

const BASE_URL = process.env.RELANCES_BASE_URL || 'https://team.alteore.com';
const FV = admin.firestore.FieldValue;
const DEPARTED = { guillaumes: 1 };

/* ── Règle de classement du Pipeline, chargée telle quelle ─────────────── */
let _E = null;
function etapesPipeline() {
  if (_E) return _E;
  const ctx = { window: {} };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'pipeline-etapes.js'), 'utf8'), ctx);
  _E = ctx.window.PipelineEtapes;
  return _E;
}

/* ── Réglages ──────────────────────────────────────────────────────────── */
async function config() {
  const s = await db.collection('_config').doc('relances').get();
  return Object.assign({}, Core.DEFAUTS, s.exists ? (s.data() || {}) : {});
}

/* ── Équipe : `_meta/team_members` (map ou tableau, comme nav.js) ──────── */
async function membres() {
  const snap = await db.collection('_meta').doc('team_members').get();
  const brut = (snap.exists ? (snap.data() || {}) : {}).members;
  const liste = Array.isArray(brut) ? brut
    : (brut && typeof brut === 'object' ? Object.keys(brut).map(function (k) { return Object.assign({ slug: k }, brut[k]); }) : []);
  return liste.filter(function (m) { return m && m.slug && !DEPARTED[m.slug]; }).map(function (m) {
    return {
      slug: String(m.slug),
      nom: m.shortName || m.displayName || m.name || m.slug,
      uid: m.firebaseUid ? String(m.firebaseUid) : null,
      role: m.role || null,
      actif: m.active !== false && !m.archivedAt,
    };
  });
}
function membre(liste, slug) {
  for (let i = 0; i < liste.length; i++) if (liste[i].slug === slug) return liste[i];
  return null;
}

/* ── Types de RDV : le lien « 🔗 setter » de chacun ────────────────────── */
async function typesRdv() {
  const s = await db.collection('booking_config').doc('_types').get();
  return (s.exists ? ((s.data() || {}).list || []) : []).filter(function (t) { return t && t.id; });
}
/* Le type attribué au setter (attributedSetterSlug), sinon celui du setter
   de repli. JAMAIS le lien public : il compterait le RDV en Self Booking. */
function typePourSetter(types, slug, repli) {
  function de(s) {
    if (!s) return null;
    for (let i = 0; i < types.length; i++) {
      const t = types[i];
      if (t.attributedSetterSlug === s && t.active !== false && t.archived !== true && !t.isCoaching) return t;
    }
    return null;
  }
  const t = de(slug);
  if (t) return { type: t, setter: slug, repli: false };
  const r = de(repli);
  return r ? { type: r, setter: repli, repli: true } : null;
}
/* Lien PUBLIC de réservation (Self Booking) : choix d'Adrien du 14/11/2026 —
   un RDV pris depuis une relance n'ouvre pas de commission de setting. */
function typePublic(types, cfg) {
  const cle = String((cfg && cfg.typePublic) || Core.DEFAUTS.typePublic);
  for (let i = 0; i < types.length; i++) if (types[i].id === cle || (types[i].slug && types[i].slug === cle)) return types[i];
  return null;
}
/* Type de RDV derrière {{lien_rdv}} et le bouton : public par défaut, lien du
   setter seulement si la campagne le demande (lienRdv: 'setter'). */
function typeReservation(types, camp, cfg, setterSlug) {
  if (camp && camp.lienRdv === 'setter') return typePourSetter(types, setterSlug, (camp && camp.setterRepli) || cfg.setterRepli);
  const t = typePublic(types, cfg);
  return t ? { type: t, setter: null, repli: false, public: true } : null;
}
function urlReservation(type, lead) {
  const nom = String(lead && (lead.nom || lead.fullName) || '').trim().split(/\s+/);
  let u = BASE_URL + '/booking.html?type=' + encodeURIComponent(type.slug || type.id);
  if (lead && lead.id) {
    u += '&leadId=' + encodeURIComponent(lead.id)
      + '&prenom=' + encodeURIComponent(nom[0] || '') + '&nom=' + encodeURIComponent(nom.slice(1).join(' '))
      + '&email=' + encodeURIComponent(lead.email || '') + '&tel=' + encodeURIComponent(lead.telephone || '');
  }
  return u;
}

/* ── Liens courts /r/{jeton} ───────────────────────────────────────────── */
function jeton() {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const b = crypto.randomBytes(10);
  let s = '';
  for (let i = 0; i < b.length; i++) s += c[b[i] % c.length];
  return s;
}
async function creerLien(o) {
  const t = jeton();
  await db.collection('relance_liens').doc(t).set({
    type: o.type, campagneId: o.campagneId || null, inscriptionId: o.inscriptionId || null,
    leadId: o.leadId || null, test: o.test === true, clics: 0, creeA: Date.now(),
  });
  return t;
}
function urlLien(t) { return BASE_URL + '/r/' + t; }

/* ── Segment ───────────────────────────────────────────────────────────── */
const CHAMPS = ['nom', 'prenom', 'fullName', 'telephone', 'email', 'stage', 'status', 'isClient', 'assignedTo',
  'landingFirst', 'sourceDetail', 'type', 'source', 'createdAt', 'importedCreatedAt', 'dateWebinaire',
  'lastContactAt', 'aiLead', 'smsOptedOut', 'smsOptOut', '_merged', 'lastOptinAt', 'lastBookingAt',
  /* Dernier contact RÉEL et rappels programmés (Core.dernierContactReel,
     Core.rappelPrevu) : toujours lus, c'est ce qui écarte les leads récents. */
  'communications', 'followUps', 'whatsappEnvoye', 'whatsappFenetre'];

/* Contexte des exclusions : RDV à venir, blacklist, exclus définitifs, leads
   déjà dans une séquence active. Lu une fois, pour tout le segment. */
async function contexteExclusions() {
  const today = Core.aujourdhui();
  const [bs, bl, ex, vr] = await Promise.all([
    db.collection('bookings').where('date', '>=', today).get(),
    db.collection('blocked_contacts').get(),
    db.collection('relance_exclusions').get(),
    db.collection('relance_verrous').where('actif', '==', true).get(),
  ]);
  const rdvAVenir = {}, rdvs = {};
  bs.forEach(function (d) {
    const b = d.data() || {};
    if (!b.leadId || b.isCoaching === true || b.status === 'cancelled' || b.outcome) return;
    rdvAVenir[b.leadId] = 1;
    (rdvs[b.leadId] = rdvs[b.leadId] || []).push(b);
  });
  const blocs = {};
  bl.forEach(function (d) { blocs[d.id] = 1; });
  const exclus = {};
  ex.forEach(function (d) { exclus[d.id] = (d.data() || {}).motif || 'exclu'; });
  const enSequence = {};
  vr.forEach(function (d) { enSequence[d.id] = (d.data() || {}).campagneId || 1; });
  return { rdvAVenir: rdvAVenir, rdvs: rdvs, blocs: blocs, exclus: exclus, enSequence: enSequence };
}
function estBloqueCtx(l, ctx) {
  const n = phoneNormalized(l.telephone);
  if (n && ctx.blocs['phone:' + n.replace(/\//g, '_')]) return true;
  const e = String(l.email || '').trim().toLowerCase();
  return !!(e && ctx.blocs['email:' + e.replace(/\//g, '_')]);
}

/**
 * Calcule un segment. Ne lit que des champs utiles (select), et ne charge
 * `communications` que si le filtre « étape Pipeline » est demandé.
 * @returns {{ leads:Array, exclus:Object, examines:number }}
 */
async function calculerSegment(filtres, ctx, cfg) {
  filtres = filtres || {};
  ctx = ctx || await contexteExclusions();
  cfg = cfg || await config();
  const now = Date.now();
  const champs = CHAMPS.slice();
  let q = db.collection('leads');
  /* Date d'entrée = la plus ANCIENNE de dateWebinaire / importedCreatedAt /
     createdAt : elle est toujours ≤ createdAt, donc « createdAt ≥ début »
     ramène bien tous les candidats ; le filtre exact se fait ensuite. */
  if (filtres.entreDu && /^\d{4}-\d{2}-\d{2}$/.test(filtres.entreDu)) {
    q = q.where('createdAt', '>=', new Date(Core.instantParis(filtres.entreDu, 0)));
  }
  const snap = await q.select.apply(q, champs).get();
  const E = (filtres.etapes && filtres.etapes.length) ? etapesPipeline() : null;
  const out = [], exclus = {};
  let examines = 0;
  snap.forEach(function (d) {
    const l = Object.assign({ id: d.id }, d.data() || {});
    if (!Core.filtrer(l, filtres, { E: E, rdvs: ctx.rdvs })) return;
    examines++;
    const bloque = estBloqueCtx(l, ctx);
    const motif = Core.exclusion(l, {
      rdvAVenir: ctx.rdvAVenir, exclus: ctx.exclus, enSequence: ctx.enSequence, now: now,
      optinRecentJours: cfg.optinRecentJours,
      bloques: bloque ? (function () { const o = {}; o[l.id] = 1; return o; })() : null,
    }) || Core.raisonRecence(l, filtres, cfg, now);
    if (motif) { exclus[motif] = (exclus[motif] || 0) + 1; return; }
    out.push({
      id: l.id,
      nom: l.nom || l.fullName || '',
      prenom: Core.prenom(l),
      telephone: Core.telephoneE164(l.telephone),
      email: String(l.email || '').trim() || null,
      setter: l.assignedTo || null,
      statut: l.status || 'nouveau',
      provenance: Core.provenance(l),
      entree: Core.dateEntree(l) || null,
      dernierContact: Core.dernierContactReel(l) || null,
      anciennete: Core.dateEntree(l) ? Math.floor((now - Core.dateEntree(l)) / 864e5) : null,
      score: l.aiLead && typeof l.aiLead.proba === 'number' ? l.aiLead.proba : null,
    });
  });
  out.sort(function (a, b) { return (b.entree || 0) - (a.entree || 0); });
  return { leads: out, exclus: exclus, examines: examines };
}

/* ── Modèles WhatsApp approuvés, en détail ─────────────────────────────── */
async function modelesWhatsapp() {
  const { getWhatsappCreds, graph } = require('./_whatsappClient');
  const creds = await getWhatsappCreds();
  if (!creds.wabaId) return { ok: false, erreur: 'wabaId absent de _config/whatsapp_credentials', modeles: [] };
  const rep = await graph(creds.wabaId + '/message_templates?fields=name,status,category,language,components&limit=200');
  if (!rep.ok) return { ok: false, erreur: rep.erreur || 'illisible', modeles: [] };
  const tous = (rep.data && rep.data.data) || [];
  const modeles = tous.map(function (m) {
    const comp = function (t) { return (m.components || []).filter(function (c) { return String(c.type).toUpperCase() === t; })[0] || null; };
    const corps = comp('BODY'), entete = comp('HEADER'), pied = comp('FOOTER'), btns = comp('BUTTONS');
    const texte = (corps && corps.text) || '';
    let nbVar = 0;
    texte.replace(/\{\{(\d+)\}\}/g, function (x, n) { nbVar = Math.max(nbVar, +n); return x; });
    return {
      nom: m.name, langue: m.language, categorie: m.category, statut: m.status,
      corps: texte, variables: nbVar,
      enteteFormat: entete ? String(entete.format || 'TEXT').toUpperCase() : null,
      entete: entete && entete.text ? entete.text : null,
      pied: pied ? pied.text || null : null,
      boutons: ((btns && btns.buttons) || []).map(function (b, i) {
        return { index: i, type: String(b.type || '').toUpperCase(), texte: b.text || '', url: b.url || null,
          dynamique: String(b.type).toUpperCase() === 'URL' && /\{\{1\}\}/.test(String(b.url || '')) };
      }),
      prix: Core.contientPrix(texte + ' ' + ((entete && entete.text) || '') + ' ' + ((pied && pied.text) || '')),
    };
  }).sort(function (a, b) { return String(a.nom).localeCompare(String(b.nom)); });
  return { ok: true, modeles: modeles };
}

/* Qualité du numéro et palier d'envoi (Meta). Ne lance jamais. */
async function qualiteWhatsapp() {
  try {
    const { getWhatsappCreds, graph } = require('./_whatsappClient');
    const creds = await getWhatsappCreds();
    let rep = await graph(creds.phoneNumberId + '?fields=quality_rating,messaging_limit_tier,display_phone_number,verified_name');
    if (!rep.ok) rep = await graph(creds.phoneNumberId + '?fields=quality_rating,display_phone_number');
    if (!rep.ok) return { ok: false, erreur: rep.erreur || 'illisible' };
    const d = rep.data || {};
    const tier = String(d.messaging_limit_tier || '');
    const m = /(\d+)/.exec(tier);
    return {
      ok: true, qualite: d.quality_rating || 'UNKNOWN', palier: tier || null,
      limite: /UNLIMITED/i.test(tier) ? null : (m ? +m[1] * (/K$/i.test(tier) ? 1000 : 1) : null),
      numero: d.display_phone_number || null, nom: d.verified_name || null,
    };
  } catch (e) {
    return { ok: false, erreur: e && e.message };
  }
}

/* ── Envoi d'une étape ─────────────────────────────────────────────────────
   o = { etape, lead, inscription (null en test), campagne, cfg, test, modeles,
         vars:{prenom, setter, lien_rdv, lien_stop}, jetonRdv }
   EN MODE TEST (o.test ou cfg.modeTest), LE DESTINATAIRE EST FORCÉ sur
   cfg.testTelephone / cfg.testEmail : c'est la ceinture sous les bretelles du
   cron, qui ne tourne de toute façon pas tant que modeTest est vrai.
   Renvoie { ok, canal, id, erreur, code, bascule, texte }. Ne lance jamais. */
async function envoyerEtape(o) {
  const cfg = o.cfg;
  const test = o.test === true || cfg.modeTest !== false;
  const tel = test ? Core.telephoneE164(cfg.testTelephone) : Core.telephoneE164(o.lead.telephone);
  const email = test ? String(cfg.testEmail || '').trim() : String(o.lead.email || '').trim();
  const e = o.etape;
  const v = o.vars || {};
  const contexte = { module: 'relances', campagneId: o.campagne && o.campagne.id || null,
    inscriptionId: o.inscription && o.inscription.id || null, leadId: o.lead && o.lead.id || null, test: test };

  if (e.canal === 'whatsapp') {
    const r = await envoyerWhatsapp(e, tel, v, o, contexte);
    if (r.ok) return r;
    /* Bascule immédiate sur le SMS : numéro invalide, modèle refusé, limite
       Meta par destinataire (131049)… L'échec asynchrone (« pas sur
       WhatsApp », 131026) est rattrapé par le cron via `aVerifier`. */
    if (!String(e.texteRepli || '').trim()) return Object.assign(r, { bascule: false });
    const s = await envoyerSms(Core.remplir(e.texteRepli, v), tel, contexte);
    return Object.assign(s, { bascule: true, erreurWhatsapp: r.erreur, codeWhatsapp: r.code || null });
  }
  if (e.canal === 'sms') return envoyerSms(Core.remplir(e.texte, v), tel, contexte);
  if (e.canal === 'email') return envoyerEmail(Core.remplir(e.objet, v), Core.remplir(e.texte, v), email, cfg);
  return { ok: false, canal: e.canal, erreur: 'canal_inconnu' };
}

async function envoyerWhatsapp(e, tel, v, o, contexte) {
  const { envoyerModele } = require('./_whatsappClient');
  if (!tel) return { ok: false, canal: 'whatsapp', erreur: 'numero_invalide' };
  const m = (o.modeles || {})[e.modele];
  if (!m) return { ok: false, canal: 'whatsapp', erreur: 'modele_introuvable_ou_non_approuve' };
  if (m.prix) return { ok: false, canal: 'whatsapp', erreur: 'modele_contient_un_prix' };
  const noms = Array.isArray(e.parametres) ? e.parametres : [];
  const params = [];
  for (let i = 0; i < m.variables; i++) {
    const k = noms[i] || 'prenom';
    let val = v[k];
    if (!val) val = k === 'prenom' ? 'à vous' : (k === 'setter' ? 'notre équipe' : '');
    params.push(val);
  }
  const boutons = [];
  m.boutons.forEach(function (b) {
    if (b.type === 'URL' && b.dynamique) {
      /* Le bouton porte la base fixe https://team.alteore.com/r/{{1}} : on ne
         lui passe que le jeton du lien court. */
      const jt = /\/r\/([A-Za-z0-9]+)/.exec(v.lien_rdv || '');
      boutons.push({ index: b.index, sousType: 'url', texte: jt ? jt[1] : 'test' });
    } else if (b.type === 'QUICK_REPLY') {
      boutons.push({ index: b.index, sousType: 'quick_reply',
        payload: 'RLC_STOP:' + (contexte.inscriptionId || 'test') });
    }
  });
  const entete = m.enteteFormat === 'VIDEO' ? { type: 'video', lien: e.videoUrl }
    : (m.enteteFormat === 'IMAGE' && e.videoUrl ? { type: 'image', lien: e.videoUrl } : null);
  const r = await envoyerModele({ to: tel, template: m.nom, langue: m.langue || 'fr', params: params,
    entete: entete, boutons: boutons, contexte: contexte });
  return { ok: r.ok, canal: 'whatsapp', id: r.wamid || null, erreur: r.erreur || null, code: r.code || null,
    texte: Core.remplir(m.corps.replace(/\{\{(\d+)\}\}/g, function (x, n) { return params[+n - 1] || x; }), {}) };
}

async function envoyerSms(texte, tel, contexte) {
  if (!tel) return { ok: false, canal: 'sms', erreur: 'numero_invalide' };
  if (Core.contientPrix(texte)) return { ok: false, canal: 'sms', erreur: 'texte_contient_un_prix' };
  try {
    const { getTwilioClient, getTwilioCreds } = require('./_twilioClient');
    const creds = await getTwilioCreds();
    const from = creds.smsFromNumber || creds.smsFrom;
    if (!from) return { ok: false, canal: 'sms', erreur: 'smsFromNumber_absent' };
    const client = await getTwilioClient();
    const m = await client.messages.create({ from: from, to: tel, body: texte,
      statusCallback: BASE_URL + '/api/twilio-sms-status' });
    return { ok: true, canal: 'sms', id: m.sid, erreur: null, texte: texte, from: from };
  } catch (err) {
    return { ok: false, canal: 'sms', erreur: (err && err.message) || 'echec_twilio', code: err && err.code || null };
  }
}

function texteVersHtml(t) {
  const esc = String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.6;color:#1f2937">'
    + esc.replace(/(https:\/\/[^\s<]+)/g, '<a href="$1">$1</a>').replace(/\n/g, '<br>') + '</div>';
}
async function envoyerEmail(objet, texte, email, cfg) {
  if (!email || !/@/.test(email)) return { ok: false, canal: 'email', erreur: 'email_invalide' };
  if (Core.contientPrix(objet + ' ' + texte)) return { ok: false, canal: 'email', erreur: 'texte_contient_un_prix' };
  try {
    const { sendEmailFromAccount } = require('./_gmailSend');
    const r = await sendEmailFromAccount({ accountKey: cfg.emailCompte || 'strategie', to: email, subject: objet,
      bodyHtml: texteVersHtml(texte), bodyText: texte });
    if (!r || !r.ok) return { ok: false, canal: 'email', erreur: (r && r.error) || 'echec_gmail' };
    return { ok: true, canal: 'email', id: r.messageId || null, erreur: null, texte: objet + '\n\n' + texte };
  } catch (err) {
    return { ok: false, canal: 'email', erreur: (err && err.message) || 'echec_gmail' };
  }
}

/* ── Trace sur la fiche (ajouts seulement) ─────────────────────────────── */
function dateFr() { return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }); }
async function tracerSurLead(leadId, r, campagne, n) {
  if (!leadId || !r || !r.ok) return;
  const iso = new Date().toISOString();
  const libCanal = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'E-mail' }[r.canal] || r.canal;
  const comm = {
    type: r.canal, direction: 'outbound', content: String(r.texte || '').slice(0, 2000),
    source: 'relance', auto: true, date: iso, createdAt: iso,
    relanceCampagneId: campagne.id, relanceEtape: n, providerMessageSid: r.id || null,
    ownerName: 'Relance auto',
  };
  try {
    await db.collection('leads').doc(leadId).update({
      communications: FV.arrayUnion(comm),
      timeline_history: FV.arrayUnion({
        text: '🔁 Relance « ' + (campagne.nom || 'campagne') + ' » — étape ' + (n + 1) + ' (' + libCanal
          + (r.bascule ? ', bascule SMS' : '') + ')',
        date: dateFr(), color: '#a78bfa',
      }),
    });
  } catch (e) {
    console.warn('[relances] trace lead', leadId, e && e.message);
  }
}

/* ── Arrêts ────────────────────────────────────────────────────────────── */
async function arreter(inscriptionId, motif, extra) {
  const ref = db.collection('relance_inscriptions').doc(inscriptionId);
  let leadId = null;
  await db.runTransaction(async function (tx) {
    const s = await tx.get(ref);
    if (!s.exists) return;
    const d = s.data() || {};
    leadId = d.leadId;
    if (d.etat !== 'active') return;
    tx.set(ref, Object.assign({ etat: 'arretee', motifArret: motif, arreteA: Date.now(), envoiEnCours: null }, extra || {}), { merge: true });
    tx.set(db.collection('relance_verrous').doc(String(d.leadId)), { actif: false, libereA: Date.now(), motif: motif }, { merge: true });
  });
  return leadId;
}

/* Faut-il arrêter avant d'envoyer ? Relit la fiche et les RDV. */
async function motifArret(insc, lead, cfg) {
  if (!lead) return 'lead_introuvable';
  const ex = await db.collection('relance_exclusions').doc(String(insc.leadId)).get();
  if (ex.exists) return 'exclu_' + ((ex.data() || {}).motif || 'definitif');
  /* Revérifié avant CHAQUE message (14/11/2026) : rappel programmé entre-temps,
     nouvel opt-in, RDV, client, STOP… La liste figée au lancement ne suffit
     pas : la vague B part plusieurs jours après. */
  const m = Core.exclusion(Object.assign({ id: insc.leadId }, lead),
    { optinRecentJours: cfg ? cfg.optinRecentJours : undefined });
  if (m && m !== 'sans_coordonnees') return m;
  const depuis = insc.debutA || insc.creeA || 0;
  if (lead.relanceRepondu && Core.msDe(lead.relanceRepondu.at) > depuis) return 'a_repondu';
  if (Core.msDe(lead.lastBookingAt) > depuis) return 'a_reserve';
  /* L'équipe a repris la main : message envoyé à la main, ou appel DÉCROCHÉ
     (un appel sans réponse du dialer ne compte pas). */
  const equipe = (lead.communications || []).some(function (c) {
    const dir = String(c && c.direction || '').toLowerCase();
    return (dir === 'outbound' || dir === 'out' || dir === 'sortant') && Core.contactReel(c)
      && Core.msDe(c.date || c.createdAt) > depuis;
  });
  if (equipe) return 'contact_equipe';
  const entrant = (lead.communications || []).some(function (c) {
    const dir = String(c && c.direction || '').toLowerCase();
    return (dir === 'inbound' || dir === 'in' || dir === 'entrant') && Core.msDe(c.date || c.createdAt) > depuis;
  });
  if (entrant) return 'a_repondu';
  const tel = Core.telephoneE164(lead.telephone);
  if (tel) {
    const conv = await db.collection('whatsapp_conversations').doc(tel.slice(1)).get();
    const dm = conv.exists ? (conv.data() || {}).dernierMessage : null;
    if (dm && dm.sens === 'in' && Core.msDe(dm.at) > depuis) return 'a_repondu';
  }
  const bs = await db.collection('bookings').where('leadId', '==', String(insc.leadId)).get();
  let rdv = null;
  const today = Core.aujourdhui();
  bs.forEach(function (d) {
    const b = d.data() || {};
    if (b.isCoaching === true || b.status === 'cancelled') return;
    if (Core.msDe(b.createdAt) > depuis) rdv = 'a_reserve';
    else if (!b.outcome && String(b.date || '') >= today && !rdv) rdv = 'rdv';
  });
  if (rdv) return rdv;
  /* RDV pris sur le lien public avec un autre e-mail ET un autre téléphone
     que la fiche… sauf l'un des deux : onBookingCreated l'aurait rattaché à
     une autre fiche. On le rattrape par le contact du prospect. */
  const cles = [];
  if (tel) cles.push(['prospect.telephone', tel]);
  const em = String(lead.email || '').trim().toLowerCase();
  if (em) cles.push(['prospect.email', em]);
  for (let i = 0; i < cles.length; i++) {
    const s = await db.collection('bookings').where(cles[i][0], '==', cles[i][1]).limit(10).get().catch(function () { return null; });
    if (!s) continue;
    let trouve = false;
    s.forEach(function (d) {
      const b = d.data() || {};
      if (b.isCoaching !== true && b.status !== 'cancelled' && Core.msDe(b.createdAt) > depuis) trouve = true;
    });
    if (trouve) return 'a_reserve';
  }
  return null;
}

/* ── Notification « a répondu » au setter ──────────────────────────────── */
async function notifierSetter(o) {
  try {
    const liste = await membres();
    const m = o.setterSlug ? membre(liste, o.setterSlug) : null;
    const uid = m && m.actif && m.uid ? m.uid : null;
    if (o.dejaNotifieSetter === true) return;
    if (uid && o.dejaNotifieUid && String(o.dejaNotifieUid) === uid) return;
    await db.collection('inbox_notifications').doc('relance_' + String(o.cle).replace(/\//g, '_')).set({
      type: o.canal === 'email' ? 'email' : (o.canal === 'whatsapp' ? 'whatsapp' : 'sms'),
      direction: 'inbound',
      leadId: o.leadId || null, leadName: o.leadName || null,
      fromNumber: o.fromNumber || null, toNumber: null,
      preview: ('🔁 Réponse à la relance « ' + (o.campagneNom || '') + ' » — ' + String(o.texte || '')).slice(0, 200),
      ownerUid: uid, ownerSlug: o.setterSlug || null,
      deepLinkUrl: 'sales-leads.html?leadId=' + encodeURIComponent(o.leadId || ''),
      source: 'relance',
      /* copyOf : la veille « prospect sans réponse » (lead-reply-watch) ne
         compte pas deux fois le même message entrant. */
      copyOf: 'relance',
      readBy: {}, createdAt: FV.serverTimestamp(),
    }, { merge: true });
  } catch (e) {
    console.warn('[relances] notification', e && e.message);
  }
}

module.exports = {
  Core, BASE_URL, etapesPipeline, config, membres, membre, typesRdv, typePourSetter, typePublic, typeReservation, urlReservation,
  creerLien, urlLien, contexteExclusions, calculerSegment, modelesWhatsapp, qualiteWhatsapp,
  envoyerEtape, envoyerSms, tracerSurLead, arreter, motifArret, notifierSetter, dateFr,
};
