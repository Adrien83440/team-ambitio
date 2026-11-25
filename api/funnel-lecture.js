// ============================================================================
// api/funnel-lecture.js — DONNÉES AGRÉGÉES DU LECTEUR FUNNEL (19/11/2026)
// ----------------------------------------------------------------------------
// Le rôle `funnel_viewer` (compte de la média buyeuse) voit le module Stats
// funnel en lecture seule. Presque tout est lu directement dans Firestore
// (règles « LECTEUR FUNNEL » de firestore.rules). UNE exception : le coût du
// setting, calculé depuis commissions/{setter}/mois/{AAAA-MM}, qui détaille
// la paie de chaque membre. Le lecteur n'a AUCUN accès à ces documents : il
// reçoit ici les seuls montants des deals Setting de la période, sans le
// setter ni le client — exactement ce que la page additionne
// (FunnelCore.loadSettingDeals, même code que l'admin et que l'API agence).
//
//   GET ?part=setting&start=<ms>&end=<ms>   Bearer <ID token admin | lecteur>
//     → { ok, deals: [{ comm, ok, sb }] }
//       comm : commission du deal (prime comprise) ; ok : validée ;
//       sb   : vrai si le deal paie le setting d'un close Self Booking — ces
//              commissions restent dans « Coût du setting » mais sortent du
//              « Coût / RDV pris NB » (audit 25/11/2026, COU-05 : elles n'ont
//              produit aucun RDV du setting). Sans ce champ, la page du
//              lecteur les comptait côté Setting (k.commSettingSbInconnu).
//     → { ok:false, error } si une lecture a échoué : la page affiche alors
//       « coût du setting non disponible » (k.erreursLecture) plutôt qu'un
//       total partiel (référentiel P7 : jamais un chiffre amputé en silence).
//
// Bornes : start / end en millisecondes, calculées par la page avec
// FunnelCore.period* (heure de Paris). Les dates des deals (« JJ/MM/AAAA »)
// sont lues à midi heure de Paris par FunnelCore.frDateMs.
//
// Aucune donnée nominative ne sort : ni setter, ni client, ni chemin de
// document dans les messages d'erreur (le lecteur est une personne extérieure).
// Lecture seule, aucune écriture.
// ============================================================================
'use strict';

/* Ceinture : funnel-core.js calcule déjà les dates à l'heure de Paris de façon
   explicite ; Vercel tourne en UTC. */
process.env.TZ = 'Europe/Paris';

const { db } = require('./_firebaseAdmin');
const { requireFunnelReader } = require('./_verifyFirebaseAuth');
const Core = require('../funnel-core.js');

const MAX_SPAN_MS = 400 * 86400000;

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') { res.status(405).json({ ok: false }); return; }
  const auth = await requireFunnelReader(req, res);
  if (!auth) return;
  const q = req.query || {};
  try {
    if (q.part !== 'setting') { res.status(400).json({ ok: false, error: 'part inconnu' }); return; }
    const start = Number(q.start), end = Number(q.end);
    if (!isFinite(start) || !isFinite(end) || end < start || end - start > MAX_SPAN_MS) {
      res.status(400).json({ ok: false, error: 'période invalide' });
      return;
    }
    const P = { start: new Date(start), end: new Date(end) };
    const TEAM = await Core.loadTeamMembers(db);
    /* Équipe illisible : aucun membre à lire, donc un coût à 0 € qui
       passerait pour un vrai zéro. On le dit. */
    if (TEAM && TEAM._erreur) {
      console.error('[funnel-lecture] équipe illisible:', TEAM._erreur);
      res.status(503).json({ ok: false, error: 'Lecture de l’équipe impossible : coût du setting non disponible.' });
      return;
    }
    const DATA = {};
    await Core.loadSettingDeals(db, P, DATA, TEAM);
    if (DATA.settingDealsUnavailable || DATA.settingDealsError) {
      /* Le détail (qui peut nommer un document de commissions, donc un
         membre) reste dans les journaux du serveur. */
      console.error('[funnel-lecture] commissions illisibles:', DATA.settingDealsError);
      res.status(503).json({ ok: false, error: 'Lecture des commissions de setting incomplète : coût du setting non disponible.' });
      return;
    }
    const deals = (DATA.settingDeals || []).map(function (d) {
      return { comm: Number(d.comm) || 0, ok: d.ok === true, sb: d.sb === true };
    });
    res.status(200).json({ ok: true, deals: deals });
  } catch (e) {
    console.error('[funnel-lecture]', e);
    res.status(500).json({ ok: false, error: 'Lecture impossible : coût du setting non disponible.' });
  }
};
