// ============================================================================
// api/_demarrage.js — MOTEUR DU DÉMARRAGE DIFFÉRÉ (exclu du routing)
// ----------------------------------------------------------------------------
// Règles et forme des données : ../demarrage-core.js. Ici, tout ce qui écrit :
// le lead (source de vérité), les copies sur clients/persons, l'Academy, les
// rappels. Utilisé par api/client-demarrage.js (page + cron).
//
// Ce qui n'est JAMAIS touché : date du close, commissions, paiements, factures.
//
// L'Academy s'ouvre à la signature (api/academy-grant.js). Deux cas :
//   · date posée avant la signature : academy-grant transmet la date, l'espace
//     est fermé d'emblée ;
//   · date posée après : le pont manage-access (action « demarrage ») le ferme.
// Le jour J, le même pont lève l'attente et recale le contrat Academy.
// L'ouverture au paiement (pour tous les nouveaux clients) : ./_accesPaiement.js.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const Core = require('../demarrage-core.js');
const BP = require('../bp-credits.js');
const { notifierCoach } = require('./_coachNotify');
const { sendEmailFromAccount } = require('./_gmailSend');
const Acces = require('./_accesPaiement');
const { contratsDu, paiementsDu, pontAcademy } = Acces;

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ADMIN_EMAIL = 'contact@adrienemily.com';
const COMPTES_ENVOI = ['contact', 'coaching', 'strategie'];

function lower(s) { return String(s || '').trim().toLowerCase(); }
function nomDe(L) { return String((L && L.nom) || (L && L.email) || 'Client').trim(); }

// ---------------------------------------------------------------------------
//  Lectures
// ---------------------------------------------------------------------------

async function leadParId(id) {
  if (!id) return null;
  const s = await db.collection('leads').doc(id).get();
  if (!s.exists) return null;
  const d = s.data() || {};
  return d._merged === true ? null : { id: s.id, data: d };
}

/* Le lead d'un client, quelle que soit la page d'où l'on vient. */
async function trouverLead(o) {
  if (o.leadId) return leadParId(o.leadId);
  if (o.clientId) {
    const s = await db.collection('clients').doc(o.clientId).get();
    if (!s.exists) return null;
    const c = s.data() || {};
    const direct = await leadParId(c._leadId);
    if (direct) return direct;
    const q = await db.collection('leads').where('coachingClientId', '==', o.clientId).limit(5).get();
    const hit = q.docs.find(function (d) { return (d.data() || {})._merged !== true; });
    if (hit) return { id: hit.id, data: hit.data() || {} };
    if (c.personId) return trouverLead({ personId: c.personId });
    return null;
  }
  if (o.personId) {
    const s = await db.collection('persons').doc(o.personId).get();
    if (!s.exists) return null;
    const ids = (s.data() || {}).leadIds || [];
    let repli = null;
    for (let i = 0; i < ids.length; i++) {
      const l = await leadParId(ids[i]);
      if (!l) continue;
      if (l.data.isClient === true) return l;
      if (!repli) repli = l;
    }
    return repli;
  }
  return null;
}

async function ficheDu(leadId, L) {
  const id = L.coachingClientId;
  if (id) {
    const s = await db.collection('clients').doc(id).get();
    if (s.exists) return { id: s.id, data: s.data() || {} };
  }
  const q = await db.collection('clients').where('_leadId', '==', leadId).limit(5).get();
  const hit = q.docs.find(function (d) { const x = d.data() || {}; return x.ancienClient !== true && x.statut !== 'inactif'; });
  return hit ? { id: hit.id, data: hit.data() || {} } : null;
}

async function personneDu(leadId, L) {
  if (L.personId) {
    const s = await db.collection('persons').doc(L.personId).get();
    if (s.exists) return s.id;
  }
  const q = await db.collection('persons').where('leadIds', 'array-contains', leadId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

/* Conditions du jour pour ce client — une seule lecture pour tout le monde. */
async function conditionsDu(leadId, L) {
  const [contrats, paiements] = await Promise.all([contratsDu(leadId, L), paiementsDu(leadId, L)]);
  return { contrats: contrats, paiements: paiements, conditions: Core.conditions(contrats, paiements, Core.aujourdhui()) };
}

// ---------------------------------------------------------------------------
//  Écritures
// ---------------------------------------------------------------------------

/* Copies sur la fiche coaching et la persons. `update` ciblé : aucun autre
   champ n'est touché. Business nouveau format : J0 et fin suivent la date. */
async function recopier(leadId, L, dd) {
  const res = Core.resume(dd);
  const fiche = await ficheDu(leadId, L);
  if (fiche) {
    const upd = { demarrageDiffere: res, _updatedAt: Date.now() };
    if (BP.isBusinessV2(fiche.data.programme)) {
      const j0 = Core.debut(dd) || fiche.data.dateEntree;
      if (j0 && j0 !== fiche.data.j0) { upd.j0 = j0; upd.finAccompagnement = BP.addDays(j0, BP.DUREE_JOURS); }
    }
    await db.collection('clients').doc(fiche.id).update(upd);
  }
  const personId = await personneDu(leadId, L);
  if (personId) await db.collection('persons').doc(personId).update({ demarrageDiffere: res });
  return fiche;
}

/* Une ligne d'historique : qui a fait quoi, jamais effacée. */
function avecHistorique(dd, prev, action, par) {
  const h = ((prev && prev.historique) || []).slice(-30);
  h.push({ at: Date.now(), par: par, action: action, date: dd.date || '' });
  dd.historique = h;
  return dd;
}

/* Pose ou change la date. Contrat déjà signé : l'Academy est ouverte, on la
   ferme D'ABORD — si le pont échoue, rien n'est enregistré et on le dit. */
async function poser(lead, date, par) {
  const L = lead.data, prev = L.demarrageDiffere || null;
  if (prev && prev.statut === 'demarre') return { ok: false, status: 409, error: 'deja_demarre' };
  if (!Core.dateValable(date)) return { ok: false, status: 400, error: 'date_invalide' };
  const c = await conditionsDu(lead.id, L);
  if (c.conditions.signe) {
    const fiche = await ficheDu(lead.id, L);
    const p = await pontAcademy(Acces.emailsAcademy(L, c.contrats, fiche && fiche.data.email), { action: 'demarrage', date: date });
    if (!p.ok) return { ok: false, status: 502, error: p.error };
  }
  const memeDate = !!(prev && prev.statut === 'attente' && prev.date === date);
  const dd = avecHistorique({ statut: 'attente', date: date, demarreLe: '', rappels: memeDate ? (prev.rappels || {}) : {} }, prev, prev && prev.statut === 'attente' ? 'date_changee' : 'pose', par);
  await db.collection('leads').doc(lead.id).update({ demarrageDiffere: dd });
  await recopier(lead.id, L, dd);
  return { ok: true, demarrage: dd, conditions: c.conditions };
}

/* Retire une date posée par erreur, tant que rien n'est signé. Une fois signé,
   c'est « Démarrer maintenant » : l'Academy et le calendrier doivent suivre. */
async function retirer(lead, par) {
  const L = lead.data, prev = L.demarrageDiffere || null;
  if (!Core.enAttente(prev)) return { ok: false, status: 409, error: 'rien_a_retirer' };
  const c = await conditionsDu(lead.id, L);
  if (c.conditions.signe) return { ok: false, status: 409, error: 'contrat_signe' };
  const dd = avecHistorique({ statut: 'annule', date: prev.date, demarreLe: '', rappels: {} }, prev, 'retire', par);
  await db.collection('leads').doc(lead.id).update({ demarrageDiffere: dd });
  await recopier(lead.id, L, dd);
  return { ok: true, demarrage: dd, conditions: c.conditions };
}

/* Coach prévenu UNE fois : à J-7, ou au démarrage s'il est avancé.
   _coachNotify est idempotent ; un coach pas encore choisi n'empêche rien. */
async function prevenirCoach(lead, fiche, par) {
  const L = lead.data;
  const nom = (L.coachAssigne && L.coachAssigne.nom) || (fiche && (fiche.data.coach || fiche.data.coachAssigned)) || '';
  if (!nom) return { envoye: false, raison: 'pas_de_coach' };
  try {
    const r = await notifierCoach({
      clientId: fiche ? fiche.id : '', leadId: fiche ? '' : lead.id, coachNom: nom,
      programme: (L.coachAssigne && L.coachAssigne.programme) || '', par: par, ignorerDemarrage: true,
    });
    return r.body || {};
  } catch (e) {
    console.warn('[demarrage] coach non prévenu', lead.id, e && e.message);
    return { envoye: false, raison: 'erreur' };
  }
}

/* Démarre le client : Academy ouverte, calendrier recalé, statut posé, coach
   prévenu. Contrat signé + payé obligatoires, sauf `force` (admin, ex. : un
   virement hors GoCardless) — tracé dans l'historique. */
async function demarrer(lead, o) {
  const L = lead.data, prev = L.demarrageDiffere || null, par = o.par;
  if (!Core.enAttente(prev)) return { ok: false, status: 409, error: 'pas_en_attente' };
  const c = await conditionsDu(lead.id, L);
  if (!c.conditions.ok && !o.force) return { ok: false, status: 409, error: 'conditions', manque: c.conditions.manque };
  const jour = Core.aujourdhui();
  const fiche = await ficheDu(lead.id, L);
  const p = await pontAcademy(Acces.emailsAcademy(L, c.contrats, fiche && fiche.data.email), { action: 'demarrage', date: null, demarreLe: jour });
  if (!p.ok) return { ok: false, status: 502, error: p.error };
  /* Démarrer lève aussi le verrou « paiement » : sinon un démarrage forcé par
     un admin resterait fermé. */
  if (L.accesPaiement && L.accesPaiement.statut === 'verrouille') {
    const ouvert = await Acces.ouvrir(lead, par, o.force === true);
    if (!ouvert.ok) return { ok: false, status: 502, error: ouvert.error };
  }
  const dd = avecHistorique({ statut: 'demarre', date: prev.date, demarreLe: jour, rappels: prev.rappels || {} }, prev, o.force ? 'demarre_force' : (o.auto ? 'demarre_auto' : 'demarre'), par);
  await db.collection('leads').doc(lead.id).update({ demarrageDiffere: dd });
  await recopier(lead.id, L, dd);
  const coach = await prevenirCoach(lead, fiche, par);
  return { ok: true, demarrage: dd, conditions: c.conditions, academy: p.trouve ? 'ouverte' : 'pas_de_compte', coach: coach };
}

// ---------------------------------------------------------------------------
//  Rappels
// ---------------------------------------------------------------------------

async function destinataires() {
  const out = [ADMIN_EMAIL];
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    (Array.isArray(raw) ? raw : Object.values(raw || {})).forEach(function (m) {
      if (m && m.role === 'csm' && m.active !== false && !m.archivedAt && m.email && out.indexOf(m.email) < 0) out.push(m.email);
    });
  } catch (e) { console.warn('[demarrage] équipe illisible', e && e.message); }
  return out;
}

async function envoyerRappel(sujet, lignes) {
  const to = await destinataires();
  const corps = lignes.map(function (x) { return '<p style="margin:0 0 10px">' + x + '</p>'; }).join('');
  const bodyHtml = '<div style="font-family:Arial,sans-serif;font-size:14px;color:#1f2937;line-height:1.5">' + corps + '</div>';
  for (let i = 0; i < COMPTES_ENVOI.length; i++) {
    try {
      await sendEmailFromAccount({ accountKey: COMPTES_ENVOI[i], to: to[0], cc: to.slice(1).join(', ') || undefined, subject: sujet, bodyHtml: bodyHtml, bodyText: lignes.join('\n').replace(/<[^>]+>/g, '') });
      return true;
    } catch (e) { console.warn('[demarrage] e-mail via ' + COMPTES_ENVOI[i], e && e.message); }
  }
  return false;
}

function lignesClient(lead, c) {
  const L = lead.data, dd = L.demarrageDiffere || {};
  const coach = (L.coachAssigne && L.coachAssigne.nom) || 'à attribuer';
  const out = ['<b>' + nomDe(L) + '</b> — démarrage prévu le <b>' + Core.fr(dd.date) + '</b>', 'Coach : ' + coach];
  out.push(c.conditions.ok ? '✅ Contrat signé et paiement en place.' : '⛔ À régler : ' + c.conditions.manque.join(', ') + '.');
  return out;
}

/* Le passage du cron (toutes les heures). Rejouable : les rappels sont datés
   sur le lead, un pont Academy en panne est retenté au passage suivant. */
async function passage(o) {
  const today = Core.aujourdhui();
  const heure = o && o.heure != null ? o.heure : Number(new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false }).format(new Date()));
  const snap = await db.collection('leads').where('demarrageDiffere.statut', '==', 'attente').get();
  const bilan = { attente: snap.size, rappels: 0, demarres: 0, bloques: 0 };

  for (const d of snap.docs) {
    const lead = { id: d.id, data: d.data() || {} };
    const dd = lead.data.demarrageDiffere || {};
    if (lead.data._merged === true || !Core.enAttente(dd)) continue;
    try {
      /* Une sauvegarde depuis un vieil onglet coaching peut avoir effacé la
         copie : on la repose. */
      const fiche = await ficheDu(lead.id, lead.data);
      if (fiche && !Core.enAttente(fiche.data.demarrageDiffere)) await recopier(lead.id, lead.data, dd);

      const jours = Core.joursEntre(today, dd.date);
      const rappels = dd.rappels || {};
      if (jours > 0 && jours <= Core.RAPPEL_JOURS && !rappels.j7) {
        const c = await conditionsDu(lead.id, lead.data);
        await prevenirCoach(lead, fiche, 'cron-demarrage');
        await envoyerRappel('⏳ ' + nomDe(lead.data) + ' démarre dans ' + jours + ' j', lignesClient(lead, c).concat([
          'À préparer : RDV de démarrage, groupe WhatsApp et message de bienvenue. L\'accès Academy s\'ouvrira tout seul le jour J.',
        ]));
        await d.ref.update({ 'demarrageDiffere.rappels.j7': Date.now() });
        bilan.rappels++;
      }
      if (jours <= 0 && heure >= 6) {
        const r = await demarrer(lead, { par: 'cron-demarrage', auto: true });
        if (r.ok) {
          bilan.demarres++;
          await envoyerRappel('🚀 ' + nomDe(lead.data) + ' démarre aujourd\'hui', [
            '<b>' + nomDe(lead.data) + '</b> : démarrage du ' + Core.fr(dd.date) + ' lancé automatiquement.',
            r.academy === 'ouverte' ? '✅ Academy ouverte.' : '⚠️ Aucun compte Academy trouvé pour ce client : à ouvrir depuis Signatures.',
          ]);
        } else {
          bilan.bloques++;
          console.warn('[demarrage] bloqué', lead.id, r.error, r.manque || '');
          if (!rappels.bloque) {
            const manque = r.error === 'conditions' ? (r.manque || []).join(', ') : 'Academy injoignable (' + r.error + ') — nouvel essai à chaque heure';
            await envoyerRappel('⛔ Démarrage bloqué : ' + nomDe(lead.data), [
              '<b>' + nomDe(lead.data) + '</b> devait démarrer le ' + Core.fr(dd.date) + '. Son espace reste fermé.',
              'Motif : ' + manque + '.',
              'Une fois réglé, utilise « Démarrer maintenant » dans sa fiche.',
            ]);
            await d.ref.update({ 'demarrageDiffere.rappels.bloque': Date.now() });
          }
        }
      }
    } catch (e) {
      console.error('[demarrage] passage', lead.id, e && e.stack ? e.stack : e);
    }
  }
  bilan.acces = await Acces.passageAcces(envoyerRappel);
  return bilan;
}

/* Tout ce qui attend, pour l'encart de nav.js et le cockpit CSM. */
async function liste() {
  const today = Core.aujourdhui();
  const snap = await db.collection('leads').where('demarrageDiffere.statut', '==', 'attente').get();
  const out = [];
  for (const d of snap.docs) {
    const L = d.data() || {}, dd = L.demarrageDiffere || {};
    if (L._merged === true || !Core.enAttente(dd)) continue;
    const c = await conditionsDu(d.id, L);
    out.push({ leadId: d.id, clientId: L.coachingClientId || '', nom: nomDe(L), date: dd.date, jours: Core.joursEntre(today, dd.date), conditions: c.conditions, bloque: !!(dd.rappels && dd.rappels.bloque) });
  }
  out.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
  /* Signés mais pas payés depuis 3 jours : même encart. */
  const ferme = await db.collection('leads').where('accesPaiement.statut', '==', 'verrouille').get();
  ferme.forEach(function (d) {
    const L = d.data() || {}, ap = L.accesPaiement || {};
    if (L._merged === true || Date.now() - Number(ap.depuis || 0) < 3 * 86400000) return;
    out.push({ leadId: d.id, clientId: L.coachingClientId || '', nom: nomDe(L), date: '', jours: 0, verrou: true, conditions: { ok: false, manque: [] }, bloque: true });
  });
  return out;
}

/* Pour les vérifications de réservation : y a-t-il une attente, d'après le
   LEAD (la copie de la fiche peut avoir vieilli) ? Ne relit le lead que si la
   copie annonce une attente : aucun coût pour les autres clients. */
async function attenteDuClient(clientId, c) {
  if (!c || !Core.enAttente(c.demarrageDiffere)) return '';
  const lead = await trouverLead({ clientId: clientId });
  const dd = lead ? lead.data.demarrageDiffere : c.demarrageDiffere;
  return Core.enAttente(dd) ? dd.date : '';
}

module.exports = { trouverLead, conditionsDu, poser, retirer, demarrer, passage, liste, attenteDuClient, nomDe, verrouillerAcces: Acces.verrouiller, ouvrirAcces: Acces.ouvrir };
