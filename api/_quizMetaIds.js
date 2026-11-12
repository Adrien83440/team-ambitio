// ============================================================================
// api/_quizMetaIds.js — IDENTIFIANTS META DES PAGES QUIZ, À LA VOLÉE (12/11/2026)
// ----------------------------------------------------------------------------
// Brief « Outil 2 », partie A. Les pages quiz (HTML écrit à la main, stocké
// dans Storage) envoient le lead à Make (« Leads QUIZ ÉLITE ») depuis leur
// fonction sendLead(c), pas par un formulaire data-alteo-optin. Ce module
// ajoute, au moment où api/tunnel-render.js sert la page (même principe que
// api/_quizTracking.js : aucune écriture Storage, rien à republier) :
//
//   1. au payload envoyé à Make, les champs de window.ALTEO.meta()
//      (tunnel-runtime.js) : event_id, fbp, fbc, user_agent, meta_allowed —
//      sans écraser ce que la page envoie déjà (le quiz Élections envoie
//      event_id / fbp / fbc / user_agent depuis sa version d'octobre) ;
//   2. au `fbq('track','Lead', {...})` de la page, l'identifiant d'événement
//      { eventID: d.event_id } s'il n'en a pas : c'est lui que l'API
//      Conversions renvoie côté serveur, Meta garde alors un seul Lead.
//
// Repérage (ancres exactes, sinon page servie telle quelle) :
//   · `function sendLead(` ;
//   · la ligne `var tp = trackParams(); Object.keys(tp).forEach(function(k){ d[k]=tp[k]; });`
//     — une seule fois ;
//   · marqueur d'idempotence `epqMetaIds`.
// Fichier préfixé `_` : hors routing Vercel.
// ============================================================================
'use strict';

const MARK = 'epqMetaIds';
const ANCHOR = 'var tp = trackParams(); Object.keys(tp).forEach(function(k){ d[k]=tp[k]; });';
const LEAD_RE = /window\.fbq\('track',\s*'Lead',\s*(\{[^{}]*\})\s*\)/;

const INJECT = ANCHOR + '\n'
  + '    /* ' + MARK + ' — identifiants Meta (API Conversions, api/_quizMetaIds.js, 12/11/2026) */\n'
  + '    try{ if(window.ALTEO && window.ALTEO.meta){ var epqM = window.ALTEO.meta(d.event_id || \'\');'
  + ' Object.keys(epqM).forEach(function(k){ if(d[k]==null || d[k]===\'\') d[k]=epqM[k]; }); } }catch(e){}';

/* Retourne { html, changed, note }. */
function patch(html) {
  const src = String(html || '');
  if (src.indexOf(MARK) >= 0) return { html: src, changed: false, note: 'déjà instrumentée' };
  const fi = src.indexOf('function sendLead(');
  if (fi < 0) return { html: src, changed: false, note: 'pas de sendLead' };
  if (src.split(ANCHOR).length - 1 !== 1) return { html: src, changed: false, note: 'ancre trackParams absente ou multiple' };
  const ai = src.indexOf(ANCHOR);
  if (ai < fi) return { html: src, changed: false, note: 'ancre hors de sendLead' };
  let out = src.slice(0, ai) + INJECT + src.slice(ai + ANCHOR.length);
  /* Lead navigateur sans identifiant → même event_id que le serveur. Cherché
     APRÈS l'ancre (dans sendLead, une fois d.event_id posé). */
  const from = ai + INJECT.length;
  const tail = out.slice(from);
  const m = LEAD_RE.exec(tail);
  let note = 'payload Make + identifiants Meta';
  if (m) {
    const repl = "window.fbq('track','Lead'," + m[1] + ',{eventID:d.event_id})';
    out = out.slice(0, from) + tail.slice(0, m.index) + repl + tail.slice(m.index + m[0].length);
    note += ' · Lead navigateur avec eventID';
  }
  return { html: out, changed: true, note: note };
}

/* Utilisé par api/tunnel-render.js : page servie telle quelle si non reconnue. */
function instrument(html) {
  try { return patch(html).html; } catch (e) { return html; }
}

module.exports = { patch, instrument, MARK };
