// ============================================================================
// api/ai-morning-brief.js — BRIEF DU MATIN (Lot 1)
// ----------------------------------------------------------------------------
// Chaque matin à 8 h (Paris) : collecte des chiffres de la veille + agenda du
// jour + alertes, synthèse par Opus, stockage dans ai_briefs/{YYYY-MM-DD},
// email aux admins. Affiché en haut des dashboards admin (ai-brief-widget.js).
//
// Collecteurs (chacun isolé : une erreur dans l'un n'empêche pas les autres) :
//   • leads entrés hier (date d'entrée réelle, par provenance), ré-optins à
//     part, et leads chauds non traités ;
//   • appels de la veille par personne (sortants, décrochés, appels reçus) ;
//   • RDV d'hier (états StatsCore : annulés, no-show, présents, pitchés,
//     à statuer…), closes d'hier (liste unique FunnelCore.loadCloses : clients
//     gagnés hier, contracté / collecté du module Paiements), RDV du jour ;
//   • clients à risque (feu rouge / orange — rempli à partir du Lot 3 par
//     clients/{id}.aiRisk) ;
//   • alertes de l'agent de surveillance (ai_watch, Lot 5) si présentes.
//
// Appels :
//   GET  Bearer <CRON_SECRET>  — crons 06:00 et 07:00 UTC ; ne travaille que
//        s'il est 8 h à Paris (gère heure d'été / d'hiver). ?force=1 pour tester.
//   POST Bearer <ID token admin> { regenerate? } — brief du jour (le génère
//        s'il n'existe pas encore, sans email).
//
// Référentiel des chiffres (audit de cohérence du 25/11/2026) : mêmes règles
// et mêmes mots que les écrans et que l'assistant (api/_aiTools.js) —
// StatsCore pour les RDV, la liste unique des closes pour Closes / Contracté /
// Collecté, jours de Paris, anciens membres comptés sous « Anciens membres »
// (plus aucune liste de prénoms en dur). Chaque bloc porte `definitions`.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, tsToMs, cap } = require('./_ai');
const { sendToAdmins } = require('./_aiMail');
const SC = require('../stats-core.js');
const FC = require('../funnel-core.js');
const T = require('./_aiTools');

// ---------------------------------------------------------------------------
//  Dates Paris
// ---------------------------------------------------------------------------

function parisDate(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }
function parisHour(ms) { return Number(new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Paris', hour: '2-digit', hour12: false })); }
function parisMidnightMs(dateStr) {
  const p = dateStr.split('-').map(Number);
  const noonUtc = Date.UTC(p[0], p[1] - 1, p[2], 12);
  const offset = parisHour(noonUtc) - 12; // 1 en hiver, 2 en été
  return Date.UTC(p[0], p[1] - 1, p[2]) - offset * 3600 * 1000;
}
function shiftDate(dateStr, days) {
  const p = dateStr.split('-').map(Number);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + days, 12)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
//  Collecte
// ---------------------------------------------------------------------------

async function collect(today) {
  const yesterday = shiftDate(today, -1);
  /* Bornes de la veille et du jour à l'heure de Paris (StatsCore). */
  const yStart = SC.debutJourParis(yesterday);
  const yEnd = SC.finJourParis(yesterday);
  const tStart = SC.debutJourParis(today);
  const out = { today: today, yesterday: yesterday, errors: [] };
  const defs = {};

  async function safe(name, fn) {
    try { await fn(); } catch (e) { out.errors.push(name + ': ' + (e && e.message)); console.warn('[ai-morning-brief] ' + name, e); }
  }
  /* Contexte commun (types de RDV, fiches d'agenda, équipe) : une lecture. */
  const ctxP = T.contexte().catch(function (e) {
    out.errors.push('contexte: ' + (e && e.message));
    return { typeMap: {}, persons: {}, team: [], bySlug: {}, resoudre: function () { return null; },
      nomDe: function (slug) { return slug ? String(slug) : SC.mot('non_attribue'); }, avert: [] };
  });

  await Promise.all([
    safe('leads', async function () {
      /* Leads entrés hier : date d'entrée réelle (FunnelCore.loadLeads, comme
         le Stats funnel), fusionnées et fiches de test retirées, ré-optins à part. */
      const D = {};
      await FC.loadLeads(db, { start: yStart, end: yEnd }, D);
      const bySrc = {};
      (D.leads || []).forEach(function (l) {
        const k = (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || l.source || 'autre';
        bySrc[k] = (bySrc[k] || 0) + 1;
      });
      out.newLeads = { leads: (D.leads || []).length, reoptins: D.reoptinsError ? null : (D.reoptins || []).length, parProvenance: bySrc };
      if (D.leadsTruncated) out.errors.push('leads: plafond de lecture atteint, total tronqué');
      if (D.reoptinsError) out.errors.push('reoptins: ' + D.reoptinsError);
      Object.assign(defs, T.definitions({ leads: 'leads', reoptins: 'reoptins' }));
    }),
    safe('hotLeads', async function () {
      /* Leads des 7 derniers jours (jours de Paris, date d'entrée réelle). */
      const since = SC.debutJourParis(shiftDate(today, -7));
      const s = await db.collection('leads').where('createdAt', '>=', since).get();
      const hot = [];
      let untouched24 = 0;
      s.forEach(function (d) {
        const l = d.data() || {};
        if (!FC.isCountedLead(l) || l.isClient) return;
        const entree = FC.realEntryMs(l);
        if (entree == null || entree < since.getTime()) return;
        const comms = (l.communications || []).filter(function (c) { return c.type === 'call' || c.type === 'sms'; });
        const st = l.status || 'nouveau';
        if (st === 'nouveau' && !comms.length && Date.now() - entree > 24 * 3600 * 1000) untouched24++;
        if (l.aiLead && l.aiLead.proba >= 60 && (st === 'nouveau' || st === 'appele') && !(l.bookingsHistory || []).length) {
          hot.push({ nom: l.nom || '?', proba: l.aiLead.proba, statut: st, assigne: l.setterSlug || l.assignedTo || null, raison: cap(l.aiLead.raison, 160), tentatives: comms.length });
        }
      });
      hot.sort(function (a, b) { return b.proba - a.proba; });
      out.hotLeads = hot.slice(0, 12);
      out.jamaisContactes24h = untouched24;
      Object.assign(defs, T.definitions({ jamaisContactes24h: 'jamais_contactes_24h' }));
    }),
    safe('calls', async function () {
      /* Appels de la veille : sortants et décrochés par la règle commune
         (StatsCore.estDecroche via FunnelCore.callStats), appels reçus à part,
         auteur = compte relié à l'appel (FunnelCore.callerOf). */
      const ctx = await ctxP;
      const s = await db.collection('call_logs').where('initiatedAt', '>=', yStart).where('initiatedAt', '<=', yEnd).get();
      const idx = FC.callerIndex(ctx.team);
      const groupes = {};
      s.forEach(function (d) {
        const c = d.data() || {};
        const who = FC.callerOf(c, idx);
        const k = !who ? SC.mot('non_attribue') : (who.departed ? SC.mot('anciens_membres') : who.name);
        (groupes[k] = groupes[k] || []).push(c);
      });
      const by = {};
      Object.keys(groupes).forEach(function (k) {
        const st = FC.callStats(groupes[k]);
        by[k] = { appels: st.out, decroches: st.answered, tempsAppelMin: Math.round(st.talkSec / 60), appelsRecus: st.inbound };
      });
      out.callsYesterday = by;
      Object.assign(defs, T.definitions({ appels: 'appels', decroches: 'decroches', tempsAppelMin: ['temps_appel', 'En minutes.'], appelsRecus: 'appels_recus' }));
    }),
    safe('bookings', async function () {
      const ctx = await ctxP;
      const now = Date.now();
      const liste = await T.lireRdvDates(yesterday, today, ctx);
      const hier = liste.filter(function (b) { return b.date === yesterday; });
      const venteHier = hier.filter(function (b) { return SC.estRdvVente(b._class); });
      /* RDV d'hier : états StatsCore (un RDV = un état ; à statuer = créneau
         passé sans résultat ; disqualifiés à part, jamais en non close). */
      const a = SC.compter(venteHier, now);
      const rdv = T.blocRdv(a);
      rdv.parCanal = {
        selfBooking: SC.compter(venteHier.filter(function (b) { return b._class === 'self'; }), now).rdv,
        setting: SC.compter(venteHier.filter(function (b) { return b._class === 'setter'; }), now).rdv,
      };
      const man = SC.compter(venteHier.filter(function (b) { return b._class === 'admin'; }), now).rdv;
      if (man) rdv.parCanal.manuels = man;
      /* À statuer d'hier, par closer du RDV (pour l'action « saisir les résultats »). */
      const aStatuerParCloser = {};
      venteHier.forEach(function (b) {
        if (SC.etat(b, now) !== 'a_statuer') return;
        const k = ctx.nomDe(SC.closerDuRdv(b, ctx.resoudre));
        aStatuerParCloser[k] = (aStatuerParCloser[k] || 0) + 1;
      });
      if (Object.keys(aStatuerParCloser).length) rdv.aStatuerParCloser = aStatuerParCloser;
      out.bookingsYesterday = rdv;

      /* Closes d'hier : la liste unique (clients gagnés hier, closes annulés
         retirés, montants du module Paiements), closer du close. */
      const CL = await FC.loadCloses(db, { start: yStart, end: yEnd, typeMap: ctx.typeMap, bookings: hier, resoudrePersonne: ctx.resoudre });
      const byId = {};
      hier.forEach(function (b) { byId[b._id] = b; });
      const closes = T.blocCloses(CL, ctx, null);
      closes.liste = CL.rows.slice(0, 20).map(function (row) {
        const cdL = (row.lead && row.lead.closedData) || {};
        const cdB = (row.bookingId && byId[row.bookingId] && byId[row.bookingId].closeData) || {};
        const o = { client: row.name || '?', offre: cdL.offre || cdB.offre || null, canal: row.sb ? SC.CLASSES.self : SC.CLASSES.setter,
          closer: ctx.nomDe(row.closer), contracte: Math.round(row.rv.con), collecte: Math.round(row.rv.paid) };
        if (!row.rv.hasPay) o.sansPaiement = true;
        return o;
      });
      out.closesYesterday = closes;
      T.avertCloses(CL).forEach(function (x) { out.errors.push(x); });

      /* Agenda du jour : RDV de vente maintenus (ni annulés, ni replanifiés,
         ni doublons), closer du RDV (StatsCore.closerDuRdv). */
      const agenda = [];
      liste.forEach(function (b) {
        if (b.date !== today || !SC.estRdvVente(b._class)) return;
        const e = SC.etat(b, now);
        if (e === 'annule' || e === 'replanifie' || e === 'doublon') return;
        agenda.push({ heure: b.time || '?', type: b.typeLabel || b.type || 'RDV', canal: SC.CLASSES[b._class], closer: ctx.nomDe(SC.closerDuRdv(b, ctx.resoudre)),
          prospect: (b.prospect ? ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim() : '') || '?' });
      });
      agenda.sort(function (x, y) { return x.heure < y.heure ? -1 : 1; });
      out.agendaToday = agenda;
      Object.assign(defs, T.definitions(T.DEF_RDV), T.definitions(T.DEF_CLOSES), T.definitions({ parCanal: 'canal', manuels: 'rdv_manuels', aStatuerParCloser: 'a_statuer' }));
    }),
    safe('clientRisk', async function () {
      // client_ai/{id} (api/_clientHealth.js) — jamais sur clients/{id}.
      const s = await db.collection('client_ai').where('risk.level', 'in', ['rouge', 'orange']).limit(60).get();
      const list = [];
      const opps = [];
      s.forEach(function (d) {
        const a = d.data() || {};
        list.push({ nom: a.nom || '?', niveau: a.risk.level, raisons: (a.risk.reasons || []).slice(0, 3), coach: a.coach || null,
          nouveau: a.prevLevel !== a.risk.level });
      });
      list.sort(function (a, b) { return (a.niveau === 'rouge' ? 0 : 1) - (b.niveau === 'rouge' ? 0 : 1); });
      out.clientsARisque = list;
      const o = await db.collection('client_ai').where('opportunity.type', 'in', ['renouvellement', 'upsell']).limit(20).get();
      o.forEach(function (d) { const a = d.data() || {}; opps.push({ nom: a.nom, type: a.opportunity.type, finDansJours: a.opportunity.daysToEnd, argument: cap(a.opportunity.argument || '', 160) }); });
      out.opportunitesClients = opps;
    }),
    safe('setterFeedback', async function () {
      const s = await db.collection('ai_feedback').where('date', '==', yesterday).get();
      const list = [];
      s.forEach(function (d) { const f = d.data() || {}; list.push({ setter: f.name, appelsNotes: f.calls, moyenne: f.avg, conseilPrincipal: cap((f.conseils || [])[0] || '', 160) }); });
      out.feedbackSetters = list;
    }),
    /* Mesure des quiz (10/11/2026, brief « chiffres justes », T5) : contrôle
       de cohérence de la veille (lqs-core quizChecks). Rien si tout concorde. */
    safe('quizMesure', async function () {
      const LC = require('../lqs-core.js');
      const FC = require('../funnel-core.js');
      const D = { views: [], quizDocs: [], leads: [], reoptins: [], extraLeads: [], bookings: [], bookingsById: {} };
      const [pv, qf, lc, lo, tu] = await Promise.all([
        db.collection('page_views_daily').where('date', '==', yesterday).get(),
        db.collection('quiz_funnel_daily').where('date', '==', yesterday).get(),
        db.collection('leads').where('createdAt', '>=', yStart).where('createdAt', '<', tStart).get(),
        db.collection('leads').where('lastOptinAt', '>=', yStart).where('lastOptinAt', '<', tStart).get(),
        db.collection('tunnels').get()
      ]);
      pv.forEach(function (d) { D.views.push(d.data() || {}); });
      qf.forEach(function (d) { D.quizDocs.push(d.data() || {}); });
      const seen = {};
      function lead(d) { const l = d.data() || {}; l._id = d.id; l._entry = FC.realEntryMs ? FC.realEntryMs(l) : tsToMs(l.createdAt); return l; }
      lc.forEach(function (d) { const l = lead(d); if (l._merged === true) return; seen[d.id] = 1; D.leads.push(l); });
      lo.forEach(function (d) { if (seen[d.id]) return; const l = lead(d); if (l._merged === true) return; if (l._entry != null && l._entry >= yStart.getTime()) D.leads.push(l); else D.reoptins.push(l); });
      const meta = {};
      tu.forEach(function (d) { const t = d.data() || {}; if (t.slug) meta[t.slug] = { name: t.name || t.slug, steps: {} }; });
      const P = { start: yStart, end: new Date(tStart.getTime() - 1) };
      const alerts = LC.quizChecks(LC.quizOverview(D, P, meta)).filter(function (c) { return c.alert; });
      out.alertesMesureQuiz = alerts.map(function (c) {
        return { quiz: c.name, arrives: c.arrives, ecarts: c.items.filter(function (i) { return i.alert; }).map(function (i) { return i.label + ' : ' + i.a + ' (' + i.aLbl + ') contre ' + i.b + ' (' + i.bLbl + ')'; }) };
      });
    }),
    /* Séquences d'après-RDV (api/_parcoursSuite.js) : prospects qui ont
       cliqué hier (choix d'une suite, bouton « réserver ») sans reprendre de
       RDV. Une ligne dans le brief plutôt qu'une cloche par clic. */
    safe('prospectsChauds', async function () {
      const list = await require('./_parcoursSuite').prospectsChauds(yStart.getTime());
      if (list.length) {
        out.prospectsChaudsApresRdv = list.slice(0, 15).map(function (x) {
          return { prenom: x.prenom, sequence: x.sequence, aCliqueReserverSansReserver: x.reserver, aVouluLire: x.choix };
        });
      }
    }),
    safe('watch', async function () {
      const s = await db.collection('ai_watch').where('status', '==', 'open').limit(15).get();
      const list = [];
      s.forEach(function (d) { const w = d.data() || {}; list.push({ gravite: w.severity || 'info', titre: cap(w.title, 140) }); });
      out.alertesSurveillance = list;
    }),
  ]);
  const ctx = await ctxP;
  (ctx.avert || []).forEach(function (x) { out.errors.push(x); });
  Object.assign(defs, T.definitions({ nonAttribue: 'non_attribue', anciensMembres: 'anciens_membres', heureParis: 'heure_paris' }));
  out.definitions = defs;
  return out;
}

// ---------------------------------------------------------------------------
//  Synthèse IA
// ---------------------------------------------------------------------------

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['titre', 'resume', 'sections', 'actions'],
  properties: {
    titre: { type: 'string', description: 'Titre accrocheur de la journée, 8 mots max' },
    resume: { type: 'string', description: '2 phrases : ce qu\'il faut retenir' },
    sections: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['icone', 'titre', 'puces'],
        properties: { icone: { type: 'string' }, titre: { type: 'string' }, puces: { type: 'array', items: { type: 'string' } } },
      },
    },
    actions: {
      type: 'array',
      items: {
        type: 'object', additionalProperties: false, required: ['qui', 'quoi', 'priorite'],
        properties: { qui: { type: 'string' }, quoi: { type: 'string' }, priorite: { type: 'string', enum: ['haute', 'normale'] } },
      },
    },
  },
};

const SYSTEM = [
  'Tu rédiges le BRIEF DU MATIN des dirigeants d\'Alteore (Adrien, Emily, Vincent) : une lecture de 60 secondes pour piloter la journée.',
  'Tu reçois les chiffres bruts de la veille, l\'agenda du jour et les alertes. Tu produis :',
  '- titre : la tonalité de la journée ;',
  '- resume : 2 phrases, le plus important d\'abord (closes et argent collecté / perdu, risque client, opportunité chaude) ;',
  '- sections, dans cet ordre et seulement si elles ont du contenu : « Hier » (📊, chiffres clés commentés), « Leads chauds à appeler » (🔥), « Clients à risque » (🚨, TOUJOURS présente s\'il y a des clients rouges ; signale les nouveaux passages au rouge), « Renouvellements & upsell » (💎), « Agenda du jour » (📅), « Alertes » (⚠️) ; 3 à 6 puces chacune, courtes, chiffrées ;',
  '- alertesMesureQuiz (si présent) : la mesure des quiz ne concorde pas hier — UNE puce dans « Alertes » par quiz, avec l\'écart chiffré (onglet Funnel Sales › Qualité leads › Quiz, encart « Contrôle de cohérence »). Absent = tout concorde : n\'en parle pas ;',
  '- prospectsChaudsApresRdv (si présent) : prospects en séquence d\'e-mails après un RDV qui ont cliqué hier sans reprendre rendez-vous — UNE puce « À rappeler » par prospect (prénom, ce qu\'il a répondu, s\'il a cliqué sur réserver). Absent : n\'en parle pas ;',
  '- actions : 3 à 6 actions concrètes pour aujourd\'hui, avec qui (prénom ou rôle) et quoi.',
  'Règles : uniquement les données fournies, aucune invention, aucun chiffre inventé. Si une donnée manque, n\'en parle pas. Ton direct, factuel, français.',
  'VOCABULAIRE (celui des écrans de l\'équipe — le champ `definitions` donne le sens exact de chaque chiffre, ne le redéfinis jamais autrement) :',
  '- bookingsYesterday = RDV de vente d\'hier (à la date du RDV) : RDV, Annulés, No-show, Présents, Disqua., Pitchés, Offres en attente, Non closes, À statuer, Kept, Show-up. « À statuer » = RDV passé sans résultat saisi (action : saisir le résultat, closer dans aStatuerParCloser). Un disqualifié n\'est JAMAIS un non close ; un replanifié n\'est pas un annulé. « RDV closés » (rdvCloses) n\'est pas « Closes ».',
  '- closesYesterday = Closes d\'hier : clients gagnés hier (liste unique, closes annulés retirés). Contracté = valeur HT des contrats ; Collecté = ce qui a déjà été prélevé ; un close « sans paiement » n\'a pas encore de paiement dans le module Paiements (son collecté est 0 : ne le présente jamais comme payé). Dis « collecté », jamais « encaissé » ni « cash ».',
  '- newLeads = Leads entrés hier (date d\'entrée réelle) ; les Ré-optins sont à part, ne les additionne pas aux leads. callsYesterday : Appels = sortants ; Décrochés = au moins 5 s de conversation, répondeurs écartés ; appels reçus à part.',
  '- « Anciens membres » et « Non attribué » sont des lignes de l\'équipe, pas des personnes : ne les nomme pas comme quelqu\'un à qui confier une action.',
  '- errors (si présent) : une lecture a échoué ou a été tronquée — si cela touche un chiffre que tu cites, dis-le (« chiffre partiel »).',
].join('\n');

async function generate(today, uid) {
  const data = await collect(today);
  const r = await callClaude({
    task: 'morning_brief',
    system: SYSTEM,
    prompt: 'Date : ' + today + '\nDONNÉES (JSON) :\n' + JSON.stringify(data, null, 1),
    schema: SCHEMA,
    uid: uid || null,
    ref: 'brief:' + today,
  });
  if (!r.ok) return r;
  const doc = { date: today, brief: r.json, stats: data, generatedAt: Date.now(), model: r.model || null };
  await db.collection('ai_briefs').doc(today).set(doc, { merge: true });
  return { ok: true, doc: doc };
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function briefToHtml(b) {
  let h = '<p style="font-size:15px"><b>' + esc(b.resume) + '</b></p>';
  (b.sections || []).forEach(function (s) {
    h += '<h3 style="margin:18px 0 6px;font-size:15px">' + esc(s.icone) + ' ' + esc(s.titre) + '</h3><ul style="margin:0;padding-left:20px">';
    (s.puces || []).forEach(function (p) { h += '<li>' + esc(p) + '</li>'; });
    h += '</ul>';
  });
  if ((b.actions || []).length) {
    h += '<h3 style="margin:18px 0 6px;font-size:15px">✅ Actions du jour</h3><ul style="margin:0;padding-left:20px">';
    b.actions.forEach(function (a) { h += '<li>' + (a.priorite === 'haute' ? '🔴 ' : '') + '<b>' + esc(a.qui) + '</b> — ' + esc(a.quoi) + '</li>'; });
    h += '</ul>';
  }
  h += '<p style="margin-top:20px;font-size:12px;color:#7a7f93">Brief généré par l\'IA à partir des données Alteore — à vérifier avant toute décision. ' +
       '<a href="https://team.alteore.com/coaching.html">Ouvrir Alteore</a></p>';
  return h;
}

// ---------------------------------------------------------------------------
//  Handler
// ---------------------------------------------------------------------------

module.exports = async function (req, res) {
  const today = parisDate(Date.now());

  if (req.method === 'GET') {
    const secret = process.env.CRON_SECRET;
    const authHeader = req.headers['authorization'] || '';
    if (!secret || (authHeader !== 'Bearer ' + secret && req.headers['x-api-key'] !== secret)) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    const force = String((req.query && req.query.force) || '') === '1';
    if (!force && parisHour(Date.now()) !== 8) { res.status(200).json({ ok: true, skipped: 'not_8am_paris' }); return; }
    try {
      const ref = db.collection('ai_briefs').doc(today);
      const s = await ref.get();
      let doc = s.exists ? s.data() : null;
      if (!doc || !doc.brief) {
        const g = await generate(today, null);
        if (!g.ok) { res.status(200).json({ ok: false, error: g.error }); return; }
        doc = g.doc;
      }
      if (doc.emailedAt && !force) { res.status(200).json({ ok: true, alreadyEmailed: true }); return; }
      // Flag posé AVANT l'envoi (convention du repo) : pas de double email
      // si les deux crons (06:00 / 07:00 UTC) se chevauchent.
      await ref.set({ emailedAt: Date.now() }, { merge: true });
      const m = await sendToAdmins('☀️ ' + (doc.brief.titre || 'Brief du matin') + ' — ' + today.split('-').reverse().join('/'), briefToHtml(doc.brief));
      res.status(200).json({ ok: true, emailed: m.ok, error: m.ok ? null : m.error });
    } catch (e) {
      console.error('[ai-morning-brief] cron', e);
      res.status(200).json({ ok: false, error: e.message });
    }
    return;
  }

  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  try {
    if (body.regenerate !== true) {
      const s = await db.collection('ai_briefs').doc(today).get();
      if (s.exists && s.data().brief) { res.status(200).json({ ok: true, doc: s.data() }); return; }
    }
    const g = await generate(today, auth.uid);
    if (!g.ok) { res.status(200).json({ ok: false, error: g.error, message: humanError(g.error) }); return; }
    res.status(200).json({ ok: true, doc: g.doc });
  } catch (e) {
    console.error('[ai-morning-brief]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};

module.exports.collect = collect;
