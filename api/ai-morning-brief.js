// ============================================================================
// api/ai-morning-brief.js — BRIEF DU MATIN (Lot 1)
// ----------------------------------------------------------------------------
// Chaque matin à 8 h (Paris) : collecte des chiffres de la veille + agenda du
// jour + alertes, synthèse par Opus, stockage dans ai_briefs/{YYYY-MM-DD},
// email aux admins. Affiché en haut des dashboards admin (ai-brief-widget.js).
//
// Collecteurs (chacun isolé : une erreur dans l'un n'empêche pas les autres) :
//   • leads entrés hier (par provenance) et leads chauds non traités ;
//   • appels de la veille par setter (call_logs) ;
//   • RDV d'hier et leurs issues (close, montants, no-show…), RDV du jour ;
//   • clients à risque (feu rouge / orange — rempli à partir du Lot 3 par
//     clients/{id}.aiRisk) ;
//   • alertes de l'agent de surveillance (ai_watch, Lot 5) si présentes.
//
// Appels :
//   GET  Bearer <CRON_SECRET>  — crons 06:00 et 07:00 UTC ; ne travaille que
//        s'il est 8 h à Paris (gère heure d'été / d'hiver). ?force=1 pour tester.
//   POST Bearer <ID token admin> { regenerate? } — brief du jour (le génère
//        s'il n'existe pas encore, sans email).
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, humanError, tsToMs, cap } = require('./_ai');
const { sendToAdmins } = require('./_aiMail');

const DEPARTED = { guillaumes: 1 };

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

function isCoachingBooking(b) { return !!(b.isCoaching || b.clientId || b.isCsm); }

// ---------------------------------------------------------------------------
//  Collecte
// ---------------------------------------------------------------------------

async function collect(today) {
  const yesterday = shiftDate(today, -1);
  const yStart = new Date(parisMidnightMs(yesterday));
  const tStart = new Date(parisMidnightMs(today));
  const out = { today: today, yesterday: yesterday, errors: [] };

  async function safe(name, fn) {
    try { await fn(); } catch (e) { out.errors.push(name + ': ' + (e && e.message)); console.warn('[ai-morning-brief] ' + name, e); }
  }

  await Promise.all([
    safe('leads', async function () {
      const s = await db.collection('leads').where('createdAt', '>=', yStart).where('createdAt', '<', tStart).get();
      const bySrc = {};
      let n = 0;
      s.forEach(function (d) {
        const l = d.data() || {};
        if (l._merged) return;
        n++;
        const k = (l.landingFirst && l.landingFirst.label) || l.sourceDetail || l.type || l.source || 'autre';
        bySrc[k] = (bySrc[k] || 0) + 1;
      });
      out.newLeads = { total: n, parProvenance: bySrc };
    }),
    safe('hotLeads', async function () {
      const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
      const s = await db.collection('leads').where('createdAt', '>=', since).get();
      const hot = [];
      let untouched24 = 0;
      s.forEach(function (d) {
        const l = d.data() || {};
        if (l._merged || l.isClient) return;
        const comms = (l.communications || []).filter(function (c) { return c.type === 'call' || c.type === 'sms'; });
        const st = l.status || 'nouveau';
        if (st === 'nouveau' && !comms.length && Date.now() - tsToMs(l.createdAt) > 24 * 3600 * 1000) untouched24++;
        if (l.aiLead && l.aiLead.proba >= 60 && (st === 'nouveau' || st === 'appele') && !(l.bookingsHistory || []).length) {
          hot.push({ nom: l.nom || '?', proba: l.aiLead.proba, statut: st, assigne: l.assignedTo || null, raison: cap(l.aiLead.raison, 160), tentatives: comms.length });
        }
      });
      hot.sort(function (a, b) { return b.proba - a.proba; });
      out.hotLeads = hot.slice(0, 12);
      out.untouched24h = untouched24;
    }),
    safe('calls', async function () {
      const s = await db.collection('call_logs').where('initiatedAt', '>=', yStart).where('initiatedAt', '<', tStart).get();
      const by = {};
      s.forEach(function (d) {
        const c = d.data() || {};
        const who = c.userName || c.ringoverUserName || 'inconnu';
        if (!by[who]) by[who] = { appels: 0, decroches: 0, minutes: 0 };
        by[who].appels++;
        if ((Number(c.durationSec) || 0) > 20) by[who].decroches++;
        by[who].minutes += Math.round((Number(c.durationSec) || 0) / 60);
      });
      out.callsYesterday = by;
    }),
    safe('bookings', async function () {
      const s = await db.collection('bookings').where('date', 'in', [yesterday, today]).get();
      const y = { total: 0, close: 0, contracte: 0, collecte: 0, no_show: 0, non_close: 0, annule: 0, sans_issue: 0, closes: [] };
      const agenda = [];
      s.forEach(function (d) {
        const b = d.data() || {};
        if (isCoachingBooking(b)) return;
        if (DEPARTED[b.personId]) return;
        const name = b.prospect ? ((b.prospect.prenom || '') + ' ' + (b.prospect.nom || '')).trim() : '';
        if (b.date === yesterday) {
          if (b.status === 'cancelled' && !b.outcome) { y.annule++; return; }
          y.total++;
          const o = b.outcome || '';
          if (o === 'close') {
            y.close++;
            const cd = b.closeData || {};
            y.contracte += Number(cd.contracte) || 0;
            y.collecte += Number(cd.collecte) || 0;
            y.closes.push((name || '?') + ' — ' + (cd.offre || '?') + ' par ' + (b.personName || '?'));
          } else if (o === 'no_show') y.no_show++;
          else if (o === 'non_close' || o === 'offre' || o === 'disqualifie') y.non_close++;
          else if (o === 'annule' || o === 'replanifie') y.annule++;
          else y.sans_issue++;
        } else if (b.status !== 'cancelled') {
          agenda.push({ heure: b.time || '?', type: b.typeLabel || b.type || 'RDV', avec: b.personName || '?', prospect: name || '?' });
        }
      });
      agenda.sort(function (a, b) { return a.heure < b.heure ? -1 : 1; });
      out.bookingsYesterday = y;
      out.agendaToday = agenda;
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
    safe('watch', async function () {
      const s = await db.collection('ai_watch').where('status', '==', 'open').limit(15).get();
      const list = [];
      s.forEach(function (d) { const w = d.data() || {}; list.push({ gravite: w.severity || 'info', titre: cap(w.title, 140) }); });
      out.alertesSurveillance = list;
    }),
  ]);
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
  '- resume : 2 phrases, le plus important d\'abord (argent encaissé / perdu, risque client, opportunité chaude) ;',
  '- sections, dans cet ordre et seulement si elles ont du contenu : « Hier » (📊, chiffres clés commentés), « Leads chauds à appeler » (🔥), « Clients à risque » (🚨, TOUJOURS présente s\'il y a des clients rouges ; signale les nouveaux passages au rouge), « Renouvellements & upsell » (💎), « Agenda du jour » (📅), « Alertes » (⚠️) ; 3 à 6 puces chacune, courtes, chiffrées ;',
  '- actions : 3 à 6 actions concrètes pour aujourd\'hui, avec qui (prénom ou rôle) et quoi.',
  'Règles : uniquement les données fournies, aucune invention, aucun chiffre inventé. Si une donnée manque, n\'en parle pas. Ton direct, factuel, français.',
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
