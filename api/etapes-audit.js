// ============================================================================
// api/etapes-audit.js — FICHES RANGÉES EN FU PAR ERREUR (11/11/2026)
// ----------------------------------------------------------------------------
// Retour d'Élodie : des NRP 1 partaient en FU au lieu de NRP 2. Cause : dans
// Leads Live, l'écran « Quand le rappeler ? » qui suit « Pas de réponse » /
// « Messagerie » posait un rappel, et tout rappel sur un Lead / NRP faisait
// passer la fiche en FU. Corrigé dans le code le même jour ; cet endpoint
// remet à leur place les fiches déjà déplacées.
//
// Règle (lue dans le journal lead_actions, écrit à chaque clic de statut) :
//   fiche à l'étape follow_up_pm dont la DERNIÈRE action d'étape est un NRP
//   (nrp1 / nrp2 / nrp3 / all_nrp), sans « décroché », « follow up », RDV…
//   après lui → elle n'a jamais été joignable : retour à ce NRP. Le rappel
//   programmé est GARDÉ (il devient un pense-bête).
// Les autres fiches FU ne sont pas touchées ; celles sans rappel à venir
// sont seulement comptées (sous-filtre « FU · Sans rappel daté »).
//
// Deux temps, jamais d'écriture sans accord :
//   GET  /api/etapes-audit                 → dry-run : ce qui serait modifié
//   POST /api/etapes-audit?apply=1         → écrit, uniquement sur les fiches
//        body { ids: [...] }                 de la liste validée ET qui
//                                            remplissent encore la règle
//
// Accès : en-tête `x-audit-key` égal à la variable Vercel ETAPES_AUDIT_KEY.
// Variable absente ou clé fausse → 404. La clé vit dans Vercel, jamais dans le
// dépôt ; la retirer coupe l'accès. Aucune donnée personnelle en sortie :
// identifiants de fiche, étapes, dates, prénom du membre de l'équipe.
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');

/* Mode étapes actif pour tous depuis le 29/10/2026 : le bug ne peut pas être antérieur */
const DEPUIS = '2026-10-29';
const NRP = { nrp1: 'NRP 1', nrp2: 'NRP 2', nrp3: 'NRP 3', all_nrp: 'All NRP' };
/* Actions qui prouvent un vrai contact ou une suite décidée après le NRP */
const CONTACT = { decroche: 1, follow_up_pm: 1, set: 1, rdv_pose: 1, rdv_self_booking: 1, pas_interesse: 1, disqualifie: 1, poubelle: 1, faux_numero: 1, client: 1 };

function keyOk(req) {
  const want = String(process.env.ETAPES_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function ms(v) {
  if (!v) return null;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? null : t;
}
function iso(t) { return t ? new Date(t).toISOString() : null; }
function frNow() {
  return new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }).replace(',', '');
}
function rappelEnAttente(l) {
  return (Array.isArray(l.followUps) ? l.followUps : []).some(function (f) { return f && !f.done; });
}

/* Journal des actions depuis DEPUIS, tous membres, regroupé par fiche */
async function actionsParLead() {
  const meta = await db.collection('_meta').doc('team_members').get();
  const membres = (meta.exists && Array.isArray((meta.data() || {}).members)) ? meta.data().members : [];
  const slugs = membres.map(function (m) { return m && m.slug; }).filter(Boolean);
  const par = {};
  await Promise.all(slugs.map(async function (slug) {
    const snap = await db.collection('lead_actions').doc(slug).collection('items').where('day', '>=', DEPUIS).get();
    snap.forEach(function (d) {
      const a = d.data() || {};
      if (!a.leadId || !a.action) return;
      (par[a.leadId] = par[a.leadId] || []).push({ action: a.action, at: ms(a.createdAt) || 0, by: slug });
    });
  }));
  Object.keys(par).forEach(function (k) { par[k].sort(function (x, y) { return x.at - y.at; }); });
  return par;
}

/* Verdict pour une fiche FU */
function verdict(l, acts) {
  let dernierNrp = null, apres = false;
  (acts || []).forEach(function (a) {
    if (NRP[a.action]) { dernierNrp = a; apres = false; }
    else if (CONTACT[a.action] && dernierNrp) apres = true;
  });
  /* Jamais de NRP dans le journal, ou un contact / une suite après lui : FU légitime */
  if (!dernierNrp || apres) return null;
  /* Un contact avant le NRP mais l'étape FU posée après le dernier NRP par une
     autre voie (Pipeline, fiche CRM) : on ne devine pas, on laisse. */
  const vers = (Array.isArray(l.timeline_history) ? l.timeline_history : []).some(function (t) {
    return t && /→\s*FU\b/.test(String(t.text || '')) && /\(Pipeline\)|rappel programmé/.test(String(t.text || ''));
  });
  return { cible: dernierNrp.action, nrpLe: iso(dernierNrp.at), par: dernierNrp.by, viaAutreEcran: vers };
}

async function analyser() {
  const [snap, par] = await Promise.all([
    db.collection('leads').where('stage', '==', 'follow_up_pm').get(),
    actionsParLead(),
  ]);
  const aCorriger = [], laisses = { fuLegitime: 0, sansRappelDate: 0, autreEcran: 0 };
  const parCible = {};
  snap.forEach(function (d) {
    const l = d.data() || {};
    if (l._merged === true) return;
    const v = verdict(l, par[d.id]);
    if (!v) {
      laisses.fuLegitime++;
      if (!rappelEnAttente(l)) laisses.sansRappelDate++;
      return;
    }
    if (v.viaAutreEcran) { laisses.autreEcran++; return; }
    parCible[v.cible] = (parCible[v.cible] || 0) + 1;
    aCorriger.push({ id: d.id, cible: v.cible, nrpLe: v.nrpLe, par: v.par, rappelEnAttente: rappelEnAttente(l), assignedTo: l.assignedTo || null });
  });
  aCorriger.sort(function (a, b) { return String(b.nrpLe).localeCompare(String(a.nrpLe)); });
  return { totalFu: snap.size, aCorriger: aCorriger, parCible: parCible, laisses: laisses };
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  try {
    const q = req.query || {};
    const r = await analyser();
    if (!(req.method === 'POST' && String(q.apply) === '1')) {
      res.status(200).json({ mode: 'dry-run', generatedAt: new Date().toISOString(), regle: 'FU dont la dernière action d\'étape est un NRP sans contact après → retour à ce NRP, rappel gardé', ...r });
      return;
    }
    /* Écriture : seulement les fiches validées qui remplissent ENCORE la règle */
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    const voulus = new Set(Array.isArray(body && body.ids) ? body.ids.map(String) : []);
    if (!voulus.size) { res.status(400).json({ error: 'ids_requis' }); return; }
    const cibles = r.aCorriger.filter(function (x) { return voulus.has(x.id); });
    const FV = admin.firestore.FieldValue;
    const faits = [];
    for (let i = 0; i < cibles.length; i += 400) {
      const batch = db.batch();
      cibles.slice(i, i + 400).forEach(function (x) {
        batch.update(db.collection('leads').doc(x.id), {
          stage: x.cible, status: x.cible, dernierNrp: x.cible, updatedAt: FV.serverTimestamp(),
          timeline_history: FV.arrayUnion({ text: 'Étape : FU → ' + NRP[x.cible] + ' (correction : passé en FU par erreur après un appel sans réponse)', date: frNow(), color: '#f59e0b' }),
        });
        faits.push({ id: x.id, cible: x.cible });
      });
      await batch.commit();
    }
    res.status(200).json({ mode: 'apply', ecrits: faits.length, ignores: voulus.size - faits.length, faits: faits });
  } catch (e) {
    console.error('[etapes-audit]', e && e.message);
    res.status(500).json({ error: 'audit', message: String(e && e.message || e).slice(0, 300) });
  }
};
