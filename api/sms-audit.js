// ============================================================================
// api/sms-audit.js — LECTURE SEULE, TEMPORAIRE (26/11/2026)
// ----------------------------------------------------------------------------
// Du 09/10 au 26/11/2026, un SMS Ringover tracé sur la fiche par Make AVANT
// l'arrivée du webhook était classé « doublon » : aucune notification Inbox.
// Cette route compte ces SMS : pour chaque SMS entrant écrit sur une fiche
// dans la fenêtre, y a-t-il une notification (Inbox ou archive) ?
//
// N'ÉCRIT RIEN. Aucun nom, aucun numéro, aucun texte en sortie : identifiant
// de fiche, jour et heure, longueur du texte, étape, et si l'équipe a
// recontacté le prospect après ce SMS.
//
// Accès : paramètre `k` égal à la variable Vercel SMS_AUDIT_KEY (preview de
// la branche seulement). Variable absente ou clé fausse → 404.
//   GET /api/sms-audit?k=…[&days=30]   (60 au plus)
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');

const STOP = { stop: 1, stopall: 1, unsubscribe: 1, cancel: 1, end: 1, quit: 1 };

function keyOk(req) {
  const want = String(process.env.SMS_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || (req.query && req.query.k) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function norm(t) {
  return String(t || '').replace(/^\s*message\s*:\s*/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
}
function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v === 'object' && typeof v.seconds === 'number') return v.seconds * 1000;
  const p = Date.parse(v);
  return isNaN(p) ? 0 : p;
}
function paris(t) {
  return new Date(t).toLocaleString('sv-SE', { timeZone: 'Europe/Paris' }).slice(0, 16);
}
function entrant(c) { return /^(in|entr)/.test(String((c && c.direction) || '').toLowerCase()); }
function sortant(c) { return /^(out|sort)/.test(String((c && c.direction) || '').toLowerCase()); }

module.exports = async function (req, res) {
  if (!keyOk(req)) { res.status(404).json({ error: 'Not found' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  try {
    const days = Math.max(1, Math.min(60, parseInt((req.query && req.query.days) || '30', 10) || 30));
    const now = Date.now();
    const since = now - days * 86400000;

    /* Notifications SMS de la fenêtre (Inbox + archive), par fiche. */
    const parLead = {};
    const parNumero = {};
    let nbNotifs = 0;
    const lots = await Promise.all([
      db.collection('inbox_notifications').where('createdAt', '>=', new Date(since - 3600000)).get(),
      db.collection('inbox_notifications_archive').where('createdAt', '>=', new Date(since - 3600000)).get(),
    ]);
    lots.forEach(function (snap) {
      snap.forEach(function (d) {
        const n = d.data() || {};
        if (n.type !== 'sms') return;
        nbNotifs++;
        const e = { t: ms(n.createdAt), k: norm(n.text || n.content || n.preview) };
        if (n.leadId) (parLead[n.leadId] = parLead[n.leadId] || []).push(e);
        const num = String(n.fromNumber || '').replace(/\D/g, '').slice(-9);
        if (num) (parNumero[num] = parNumero[num] || []).push(e);
      });
    });

    /* Fiches contactées dans la fenêtre. */
    const leads = await db.collection('leads').where('lastContactAt', '>=', new Date(since))
      .select('communications', 'telephone', 'stage', 'status', 'isClient', '_merged').get();

    const tot = { fiches: leads.size, notifsSms: nbNotifs, smsEntrants: 0, avecNotif: 0, sansNotif: 0, stop: 0, twilio: 0 };
    const parSource = {};
    const parSemaine = {};
    const liste = [];
    leads.forEach(function (doc) {
      const l = doc.data() || {};
      if (l._merged === true) return;
      const comms = Array.isArray(l.communications) ? l.communications : [];
      const num = String(l.telephone || '').replace(/\D/g, '').slice(-9);
      const cand = (parLead[doc.id] || []).concat(num ? (parNumero[num] || []) : []);
      const vus = {};
      comms.forEach(function (c) {
        if (!c || c.type !== 'sms' || !entrant(c)) return;
        const t = ms(c.date) || ms(c.createdAt);
        if (!t || t < since) return;
        const k = norm(c.content);
        /* Même SMS écrit deux fois sur la fiche (Make + webhook) : compté une fois. */
        const cle = k + '|' + Math.round(t / 600000);
        if (vus[cle]) return;
        vus[cle] = 1;
        if (String(c.source || '').indexOf('twilio') >= 0) { tot.twilio++; return; }
        if (STOP[k]) { tot.stop++; return; }
        tot.smsEntrants++;
        const src = String(c.source || 'sans_source') + (c.providerMessageId ? '+id' : '');
        parSource[src] = parSource[src] || { total: 0, sansNotif: 0 };
        parSource[src].total++;
        const ok = cand.some(function (n) {
          return Math.abs(n.t - t) < 15 * 60000 && (!n.k || !k || n.k === k || n.k.indexOf(k) === 0 || k.indexOf(n.k) === 0);
        });
        const sem = paris(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000).slice(0, 10);
        parSemaine[sem] = parSemaine[sem] || { total: 0, sansNotif: 0 };
        parSemaine[sem].total++;
        if (ok) { tot.avecNotif++; return; }
        tot.sansNotif++;
        parSource[src].sansNotif++;
        parSemaine[sem].sansNotif++;
        let suivi = null;
        comms.forEach(function (o) {
          if (!o || !sortant(o)) return;
          const to = ms(o.date) || ms(o.createdAt);
          if (to > t && (!suivi || to < suivi.t)) suivi = { t: to, type: o.type || '?' };
        });
        liste.push({
          leadId: doc.id, le: paris(t), longueur: k.length, source: src,
          etape: l.stage || l.status || null, client: l.isClient === true,
          recontacteApres: suivi ? (suivi.type + ' ' + paris(suivi.t)) : null,
        });
      });
    });
    liste.sort(function (a, b) { return a.le < b.le ? 1 : -1; });
    res.status(200).json({
      fenetre: { jours: days, depuis: paris(since), jusqu: paris(now) },
      totaux: tot, parSource: parSource, parSemaine: parSemaine,
      sansRecontact: liste.filter(function (x) { return !x.recontacteApres; }).length,
      sansNotif: liste.slice(0, 300), tronque: liste.length > 300,
    });
  } catch (e) {
    res.status(500).json({ error: String((e && e.message) || e) });
  }
};
