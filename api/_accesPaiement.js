// ============================================================================
// api/_accesPaiement.js — L'ACADEMY S'OUVRE AU PAIEMENT (30/10/2026, exclu du routing)
// ----------------------------------------------------------------------------
// Décision Adrien : un nouveau client signe, mais son espace Academy reste
// fermé jusqu'au paiement validé — « validé » = prélèvement déclenché
// (demarrage-core.js, paiementOk). Le closer le déclenche pendant l'appel :
// l'accès s'ouvre aussitôt (api/gocardless-payment.js → ouvrirSiPaye). Le cron
// horaire rattrape les autres chemins.
//
// PREMIER PRÉLÈVEMENT REJETÉ : l'espace se referme. Les rejets arrivent par la
// Cloud Function onWebhookInbox (lastPaymentFailure) : c'est le cron qui les lit,
// aucun déploiement de functions n'est nécessaire. Les prélèvements suivants
// restent de simples alertes, comme avant.
//
// État sur leads/{id}.accesPaiement :
//   { statut:'verrouille'|'ouvert', depuis, ouvertLe, manuel, par, rappel, historique }
// Côté Academy : users/{email}.paiementAttendu (bridge/manage-access, action
// « paiement »), indépendant de la date du démarrage différé.
//
// Chargé par api/gocardless-payment.js, donc aussi par le bac à sable : aucune
// dépendance à l'e-mail ou à WhatsApp ici, et ouvrirSiPaye ne lève jamais.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const Core = require('../demarrage-core.js');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const FENETRE_REJET_JOURS = 45;

function lower(s) { return String(s || '').trim().toLowerCase(); }

async function contratsDu(leadId, L) {
  const col = db.collection('signature_requests');
  const vus = {}, out = [];
  function add(snap) { snap.forEach(function (d) { if (!vus[d.id]) { vus[d.id] = 1; out.push(Object.assign({ _id: d.id }, d.data() || {})); } }); }
  add(await col.where('leadId', '==', leadId).get());
  const email = lower(L.email);
  if (email) add(await col.where('clientEmail', '==', email).get());
  return out;
}

async function paiementsDu(leadId, L) {
  const col = db.collection('payments');
  const vus = {}, out = [];
  function add(snap) { snap.forEach(function (d) { if (!vus[d.id]) { vus[d.id] = 1; out.push(Object.assign({ id: d.id }, d.data() || {})); } }); }
  add(await col.where('leadId', '==', leadId).get());
  if (L.personId) add(await col.where('personId', '==', L.personId).get());
  const email = lower(L.email);
  if (email) add(await col.where('leadEmail', '==', email).get());
  return out;
}

/* Le compte vit sous l'e-mail du SIGNATAIRE, qui peut différer de celui du lead. */
function emailsAcademy(L, contrats, ficheEmail) {
  const vus = {}, out = [];
  function add(e) { e = lower(e); if (e && !vus[e]) { vus[e] = 1; out.push(e); } }
  contrats.filter(function (c) { return c.status === 'signed'; }).forEach(function (c) {
    add(Array.isArray(c.signers) && c.signers[0] && c.signers[0].email);
    add(c.clientEmail);
  });
  add(L.email);
  add(ficheEmail);
  return out;
}

async function pontAcademy(emails, payload) {
  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) return { ok: false, error: 'bridge_not_configured' };
  let trouve = false;
  for (let i = 0; i < emails.length; i++) {
    let j = null;
    try {
      const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
        body: JSON.stringify(Object.assign({ email: emails[i] }, payload)),
      });
      j = await r.json().catch(function () { return null; });
    } catch (e) { j = null; }
    if (!j || j.ok !== true) return { ok: false, error: (j && j.error) || 'academy_unreachable' };
    if (j.found) trouve = true;
  }
  return { ok: true, trouve: trouve };
}

function avecHistorique(ap, prev, action, par) {
  const h = ((prev && prev.historique) || []).slice(-20);
  h.push({ at: Date.now(), par: par, action: action });
  ap.historique = h;
  return ap;
}

/* Ferme l'espace en attendant le paiement. Academy d'abord : si le pont
   échoue, rien n'est enregistré et on le dit. */
async function verrouiller(lead, par) {
  const L = lead.data;
  const contrats = await contratsDu(lead.id, L);
  const p = await pontAcademy(emailsAcademy(L, contrats), { action: 'paiement', attendu: true });
  if (!p.ok) return { ok: false, status: 502, error: p.error };
  const ap = avecHistorique({ statut: 'verrouille', depuis: Date.now(), ouvertLe: null, manuel: false, par: par, rappel: null }, L.accesPaiement, 'verrouille', par);
  await db.collection('leads').doc(lead.id).update({ accesPaiement: ap });
  return { ok: true, accesPaiement: ap, academy: p.trouve ? 'fermee' : 'pas_de_compte' };
}

/* Rouvre l'espace. `manuel` : décision d'un admin (virement hors GoCardless…) :
   le cron ne le refermera pas sur un rejet. */
async function ouvrir(lead, par, manuel) {
  const L = lead.data;
  const contrats = await contratsDu(lead.id, L);
  const p = await pontAcademy(emailsAcademy(L, contrats), { action: 'paiement', attendu: false });
  if (!p.ok) return { ok: false, status: 502, error: p.error };
  const ap = avecHistorique({ statut: 'ouvert', depuis: (L.accesPaiement && L.accesPaiement.depuis) || null, ouvertLe: Date.now(), manuel: !!manuel, par: par, rappel: null }, L.accesPaiement, manuel ? 'ouvert_manuel' : 'ouvert', par);
  await db.collection('leads').doc(lead.id).update({ accesPaiement: ap });
  return { ok: true, accesPaiement: ap };
}

/* Appelé au déclenchement du prélèvement et à chaque passage du cron. Ne lève
   jamais : un paiement ne doit pas échouer parce que l'Academy ne répond pas,
   le cron retentera. */
async function ouvrirSiPaye(leadId, par) {
  try {
    if (!leadId) return { ok: false, raison: 'pas_de_lead' };
    const s = await db.collection('leads').doc(leadId).get();
    if (!s.exists) return { ok: false, raison: 'lead_introuvable' };
    const L = s.data() || {};
    if (!L.accesPaiement || L.accesPaiement.statut !== 'verrouille') return { ok: false, raison: 'pas_verrouille' };
    const paiements = await paiementsDu(leadId, L);
    if (Core.premierRejet(paiements) || !paiements.some(function (p) { return Core.paiementOk(p); })) return { ok: false, raison: 'pas_paye' };
    return await ouvrir({ id: leadId, data: L }, par, false);
  } catch (e) {
    console.warn('[acces-paiement] ouverture', leadId, e && e.message);
    return { ok: false, raison: 'erreur' };
  }
}

/* Le passage du cron : ouvre ce qui est payé, referme ce qui vient d'être
   rejeté, signale ce qui attend depuis 3 jours. `alerter(sujet, lignes)` vient
   de api/_demarrage.js. */
async function passageAcces(alerter) {
  const bilan = { ouverts: 0, refermes: 0, signales: 0 };
  const ferme = await db.collection('leads').where('accesPaiement.statut', '==', 'verrouille').get();
  for (const d of ferme.docs) {
    const L = d.data() || {}, ap = L.accesPaiement || {};
    if (L._merged === true) continue;
    const r = await ouvrirSiPaye(d.id, 'cron-acces');
    if (r.ok) { bilan.ouverts++; continue; }
    if (r.raison === 'pas_paye' && !ap.rappel && Date.now() - Number(ap.depuis || 0) > 3 * 86400000) {
      await alerter('🔒 ' + (L.nom || L.email || 'Client') + ' : signé, pas encore payé', [
        '<b>' + (L.nom || L.email || 'Client') + '</b> a signé mais aucun prélèvement n\'est parti : son accès Academy reste fermé.',
        'Il s\'ouvrira tout seul dès que le prélèvement sera déclenché.',
      ]);
      await d.ref.update({ 'accesPaiement.rappel': Date.now() });
      bilan.signales++;
    }
  }
  const ouverts = await db.collection('leads').where('accesPaiement.statut', '==', 'ouvert').get();
  for (const d of ouverts.docs) {
    const L = d.data() || {}, ap = L.accesPaiement || {};
    if (L._merged === true || ap.manuel || Date.now() - Number(ap.ouvertLe || 0) > FENETRE_REJET_JOURS * 86400000) continue;
    try {
      const paiements = await paiementsDu(d.id, L);
      if (!Core.premierRejet(paiements)) continue;
      const r = await verrouiller({ id: d.id, data: L }, 'cron-acces');
      if (!r.ok) { console.warn('[acces-paiement] refermeture', d.id, r.error); continue; }
      await alerter('⛔ Premier prélèvement rejeté : ' + (L.nom || L.email || 'client'), [
        '<b>' + (L.nom || L.email || 'Client') + '</b> : le premier prélèvement a été rejeté, son accès Academy vient d\'être refermé.',
        'Il se rouvrira dès qu\'un nouveau prélèvement sera déclenché.',
      ]);
      bilan.refermes++;
    } catch (e) { console.warn('[acces-paiement] rejet', d.id, e && e.message); }
  }
  return bilan;
}

module.exports = { contratsDu, paiementsDu, emailsAcademy, pontAcademy, verrouiller, ouvrir, ouvrirSiPaye, passageAcces };
