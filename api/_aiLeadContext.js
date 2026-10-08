// ============================================================================
// api/_aiLeadContext.js — dossier complet d'un lead, mis en texte pour l'IA
// ----------------------------------------------------------------------------
// Rassemble tout ce qu'on sait d'un prospect pour les tâches IA (score, brief
// pré-appel, dossier de closing, relances…) :
//   • fiche leads/{id} (identité, provenance, quiz, formulaire, statut, notes,
//     timeline, communications) ;
//   • call_logs liés (leadId OU numéro appelé) avec transcriptions Ringover —
//     `transcriptText` souvent vide : repli sur la concaténation de
//     `transcriptSpeeches` (cf. api/call-detail.js) ;
//   • bookings liés (leadId) avec leurs issues ;
//   • notes vocales (sous-collection voice_notes : résumé / transcription).
//
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { cap, tsToMs, frDate } = require('./_ai');

function arr(v) { return Array.isArray(v) ? v : []; }

// Empreinte de fraîcheur du score IA. Doit rester STRICTEMENT identique à
// aiLeadKey() côté sales-leads.html et sales-dialer.js : le front s'en sert
// pour décider s'il faut redemander un score (nouvel appel, note, statut…).
function aiLeadKey(l) {
  l = l || {};
  return arr(l.communications).length + ':' + arr(l.notesHistory).length + ':' +
    String(l.status || '') + ':' + String(l.stage || '') + ':' + (l.quiz ? 1 : 0);
}

function speechesText(sp) {
  if (!Array.isArray(sp) || !sp.length) return '';
  return sp.slice().sort(function (a, b) { return (Number(a.start) || 0) - (Number(b.start) || 0); })
    .map(function (s) { return (s.channelId != null ? '[' + s.channelId + '] ' : '') + String(s.text || '').trim(); })
    .filter(function (t) { return t.length > 2; }).join('\n');
}

function callTranscript(c) {
  return String(c.transcriptText || c.transcriptionText || '').trim() || speechesText(c.transcriptSpeeches);
}

async function loadLeadBundle(leadId, opts) {
  opts = opts || {};
  const snap = await db.collection('leads').doc(leadId).get();
  if (!snap.exists) return null;
  const lead = Object.assign({ id: snap.id }, snap.data() || {});

  const callsById = {};
  const tasks = [
    db.collection('call_logs').where('leadId', '==', leadId).limit(25).get()
      .then(function (s) { s.forEach(function (d) { callsById[d.id] = Object.assign({ id: d.id }, d.data()); }); })
      .catch(function () {}),
    db.collection('bookings').where('leadId', '==', leadId).limit(20).get()
      .then(function (s) { const out = []; s.forEach(function (d) { out.push(Object.assign({ id: d.id }, d.data())); }); return out; })
      .catch(function () { return []; }),
    db.collection('leads').doc(leadId).collection('voice_notes').limit(15).get()
      .then(function (s) { const out = []; s.forEach(function (d) { out.push(d.data() || {}); }); return out; })
      .catch(function () { return []; }),
  ];
  if (lead.telephone && /^\+\d{8,15}$/.test(String(lead.telephone))) {
    tasks.push(db.collection('call_logs').where('toNumber', '==', String(lead.telephone)).limit(25).get()
      .then(function (s) { s.forEach(function (d) { callsById[d.id] = Object.assign({ id: d.id }, d.data()); }); })
      .catch(function () {}));
  }
  const res = await Promise.all(tasks);
  const bookings = res[1] || [];
  const voiceNotes = res[2] || [];
  const calls = Object.keys(callsById).map(function (k) { return callsById[k]; })
    .sort(function (a, b) { return tsToMs(a.initiatedAt || a.startTime) - tsToMs(b.initiatedAt || b.startTime); });
  bookings.sort(function (a, b) { return String(a.date || '') + String(a.time || '') < String(b.date || '') + String(b.time || '') ? -1 : 1; });

  return { lead: lead, calls: calls, bookings: bookings, voiceNotes: voiceNotes };
}

/**
 * Met le dossier en texte. opts.transcriptChars : budget de caractères par
 * transcription (les plus récentes d'abord) ; opts.maxCalls : nombre d'appels.
 */
function bundleToText(b, opts) {
  opts = opts || {};
  const l = b.lead;
  const L = [];
  L.push('FICHE PROSPECT');
  L.push('- Nom : ' + (l.nom || '(inconnu)'));
  if (l.secteur) L.push('- Secteur : ' + cap(l.secteur, 200));
  if (l.ca) L.push('- CA déclaré : ' + cap(l.ca, 100));
  if (l.defi) L.push('- Défi exprimé : ' + cap(l.defi, 600));
  if (l.message) L.push('- Message : ' + cap(l.message, 600));
  if (l.description) L.push('- Description : ' + cap(l.description, 600));
  if (l.disponibilite) L.push('- Disponibilité : ' + cap(l.disponibilite, 200));
  if (l.instagramUsername) L.push('- Instagram : @' + l.instagramUsername);
  L.push('- Entrée : ' + (frDate(tsToMs(l.createdAt)) || '?') + (l.lastOptinAt ? ' · dernier opt-in ' + frDate(tsToMs(l.lastOptinAt)) : ''));
  const prov = [];
  if (l.type) prov.push('type ' + l.type);
  if (l.source) prov.push('source ' + l.source);
  if (l.sourceDetail) prov.push(cap(l.sourceDetail, 80));
  if (l.landingFirst && l.landingFirst.label) prov.push('1re page « ' + l.landingFirst.label + (l.landingFirst.variant ? ' / ' + l.landingFirst.variant : '') + ' »');
  if (l.landingLast && l.landingLast.label && (!l.landingFirst || l.landingLast.page !== l.landingFirst.page)) prov.push('dernière page « ' + l.landingLast.label + ' »');
  if (l.attributionLast && l.attributionLast.utm_campaign) prov.push('campagne ' + cap(l.attributionLast.utm_campaign, 80));
  if (prov.length) L.push('- Provenance : ' + prov.join(' · '));
  if (arr(l.engagementHistory).length) L.push('- Ré-opt-ins précédents : ' + arr(l.engagementHistory).length);
  L.push('- Statut : ' + (l.status || 'nouveau') + (l.stage ? ' (étape ' + l.stage + ')' : '') + (l.assignedTo ? ' · assigné à ' + l.assignedTo : ''));
  if (l.leadScore) L.push('- Note qualité saisie par l\'équipe : ' + l.leadScore + '/5');
  if (l.isClient) L.push('- DÉJÀ CLIENT');

  if (l.quiz) {
    const q = l.quiz;
    L.push('');
    L.push('QUIZ (réponses du prospect)');
    if (q.score_global != null) L.push('- Score global : ' + q.score_global);
    if (q.scores) L.push('- Scores : ' + Object.keys(q.scores).map(function (k) { return k + ' ' + q.scores[k]; }).join(', '));
    if (q.pilier_prioritaire) L.push('- Pilier prioritaire : ' + q.pilier_prioritaire);
    if (q.ca_mensuel) L.push('- CA mensuel : ' + q.ca_mensuel);
    if (q.objectif) L.push('- Objectif : ' + cap(q.objectif, 300));
    if (q.equipe) L.push('- Équipe : ' + q.equipe);
    if (q.heures) L.push('- Heures / semaine : ' + q.heures);
    arr(q.reponses).slice(0, 20).forEach(function (r) { L.push('  · ' + cap(r.question, 120) + ' → ' + cap(r.reponse, 200)); });
  }

  if (arr(l.formAnswers).length) {
    L.push('');
    L.push('FORMULAIRE' + (l.formTitle ? ' « ' + l.formTitle + ' »' : ''));
    arr(l.formAnswers).slice(0, 25).forEach(function (a) {
      const v = Array.isArray(a.value) ? a.value.join(', ') : a.value;
      if (v != null && String(v).trim()) L.push('- ' + cap(a.label, 120) + ' : ' + cap(v, 300));
    });
  }

  const notes = arr(l.notesHistory).slice(-12);
  if (notes.length) {
    L.push('');
    L.push('NOTES DE L\'ÉQUIPE (anciennes → récentes)');
    notes.forEach(function (n) { L.push('- ' + (n.date ? String(n.date).slice(0, 16) + ' ' : '') + (n.authorName ? n.authorName + ' : ' : '') + cap(n.text, 500)); });
  }
  if (l.notes && typeof l.notes === 'string') L.push('- Bloc-notes : ' + cap(l.notes, 800));

  const vns = b.voiceNotes.filter(function (v) { return v.summary || v.transcription; }).slice(-6);
  if (vns.length) {
    L.push('');
    L.push('NOTES VOCALES DE L\'ÉQUIPE');
    vns.forEach(function (v) { L.push('- ' + (v.authorName ? v.authorName + ' : ' : '') + cap(v.summary || v.transcription, 400)); });
  }

  const comms = arr(l.communications).filter(function (c) { return c.type === 'call' || c.type === 'sms' || c.type === 'email'; }).slice(-15);
  if (comms.length) {
    L.push('');
    L.push('ÉCHANGES (anciens → récents)');
    comms.forEach(function (c) {
      let t = '- ' + (c.date ? frDate(Date.parse(c.date)) + ' ' : '') + c.type + (c.direction ? ' ' + c.direction : '');
      if (c.type === 'call') t += c.duration ? ' (' + c.duration + ' s)' : ' (sans réponse)';
      if (c.content) t += ' : ' + cap(c.content, 300);
      if (c.note) t += ' — note : ' + cap(c.note, 200);
      L.push(t);
    });
  }

  const maxCalls = opts.maxCalls || 4;
  const budget = opts.transcriptChars || 2500;
  const talked = b.calls.filter(function (c) { return (Number(c.durationSec) || 0) > 0 || callTranscript(c); });
  if (b.calls.length) {
    L.push('');
    L.push('APPELS TÉLÉPHONIQUES : ' + b.calls.length + ' au total, ' + talked.length + ' décroché(s)');
    talked.slice(-maxCalls).forEach(function (c) {
      L.push('- ' + frDate(tsToMs(c.initiatedAt || c.startTime)) + ' · ' + (c.userName || '?') + ' · ' + (c.durationSec || 0) + ' s');
      if (c.aiSummary) L.push('  Résumé Ringover : ' + cap(typeof c.aiSummary === 'string' ? c.aiSummary : JSON.stringify(c.aiSummary), 600));
      if (c.aiCall && c.aiCall.summary) L.push('  Résumé IA : ' + cap(c.aiCall.summary, 600));
      const tr = callTranscript(c);
      if (tr) L.push('  Transcription : ' + cap(tr, budget));
    });
  }

  if (b.bookings.length) {
    L.push('');
    L.push('RENDEZ-VOUS');
    b.bookings.forEach(function (bk) {
      let t = '- ' + (bk.date || '?') + ' ' + (bk.time || '') + ' · ' + (bk.typeLabel || bk.type || 'RDV') + ' avec ' + (bk.personName || '?');
      t += ' · statut ' + (bk.outcome || bk.status || '?');
      if (bk.outcomeNote) t += ' — ' + cap(bk.outcomeNote, 300);
      if (bk.closeData && bk.closeData.offre) t += ' — CLOSÉ ' + bk.closeData.offre + (bk.closeData.contracte ? ' (' + bk.closeData.contracte + ' €)' : '');
      L.push(t);
      if (bk.prospect && bk.prospect.message) L.push('  Message à la réservation : ' + cap(bk.prospect.message, 400));
    });
  }

  return L.join('\n');
}

module.exports = { loadLeadBundle: loadLeadBundle, bundleToText: bundleToText, aiLeadKey: aiLeadKey, callTranscript: callTranscript };
