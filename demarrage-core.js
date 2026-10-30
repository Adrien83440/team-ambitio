// ============================================================================
// demarrage-core.js — DÉMARRAGE DIFFÉRÉ D'UN CLIENT (30/10/2026)
// ----------------------------------------------------------------------------
// Le client signe et paie aujourd'hui, mais ne commence que plus tard (« je
// n'attaque qu'en janvier »). Partagé navigateur ↔ serveur, comme bp-credits.js.
//
// LA RÈGLE D'ADRIEN : on peut décaler le DÉMARRAGE, jamais le PAIEMENT. Date
// de close, commissions, prélèvements et factures ne bougent pas. Le contrat
// doit être signé et le premier prélèvement déclenché (ou le paiement intégral
// fait) : « payé » se lit ici, à un seul endroit (paiementOk).
//
// Forme de leads/{id}.demarrageDiffere (source de vérité) :
//   { statut:'attente'|'demarre'|'annule', date:'AAAA-MM-JJ' (date prévue),
//     demarreLe:'AAAA-MM-JJ' (jour réel), historique:[{at,par,action,date}],
//     rappels:{ j7, bloque } }
// Copie résumée sur clients/{id} et persons/{id} (resume) : coaching.html
// réécrit la fiche entière depuis une copie locale, la copie peut donc être en
// retard. Tout ce qui décide côté serveur repasse par le lead.
//
// AUCUNE dépendance : ni Firebase, ni DOM. ES5 strict.
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.DemarrageCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RAPPEL_JOURS = 7;      // premier rappel et prévenance du coach
  var MAX_JOURS = 366;       // au-delà, c'est une faute de frappe
  /* GoCardless repousse le premier prélèvement d'un NOUVEAU mandat au préavis
     SEPA (api/gocardless-payment.js réécrit startDate) : quelques jours ne
     sont pas un décalage de paiement. Au-delà, si. */
  var TOLERANCE_SEPA_JOURS = 10;

  function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(String(s || '')); }
  function aujourdhui(d) {
    return new Intl.DateTimeFormat('fr-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d || new Date());
  }
  function joursEntre(a, b) { // b - a, en jours calendaires
    if (!isDate(a) || !isDate(b)) return null;
    var pa = a.split('-'), pb = b.split('-');
    return Math.round((Date.UTC(+pb[0], +pb[1] - 1, +pb[2]) - Date.UTC(+pa[0], +pa[1] - 1, +pa[2])) / 86400000);
  }
  function fr(ymd) { return isDate(ymd) ? ymd.split('-').reverse().join('/') : ''; }

  function enAttente(dd) { return !!(dd && dd.statut === 'attente' && isDate(dd.date)); }
  /* Le jour qui compte pour les jalons, la fin de programme et la santé. */
  function debut(dd) {
    if (!dd) return '';
    if (dd.statut === 'attente') return isDate(dd.date) ? dd.date : '';
    if (dd.statut === 'demarre') return isDate(dd.demarreLe) ? dd.demarreLe : (isDate(dd.date) ? dd.date : '');
    return '';
  }
  function dateValable(date, today) {
    var j = joursEntre(today || aujourdhui(), date);
    return j !== null && j > 0 && j <= MAX_JOURS;
  }
  function resume(dd) {
    if (!dd) return null;
    return { statut: dd.statut || '', date: dd.date || '', demarreLe: dd.demarreLe || '' };
  }
  function badge(dd) { return enAttente(dd) ? '⏳ Démarre le ' + fr(dd.date) : ''; }

  function prelevementDecale(p, today) {
    var d = String((p && p.startDate) || '').slice(0, 10);
    var j = isDate(d) ? joursEntre(today || aujourdhui(), d) : null;
    return j !== null && j > TOLERANCE_SEPA_JOURS;
  }
  /* « Payé » (décision Adrien 30/10/2026) : premier prélèvement déclenché ou
     paiement intégral fait. Un mandat seul ne suffit pas, et un prélèvement
     programmé plus tard non plus : le paiement ne se décale jamais. */
  function paiementOk(p, today) {
    if (!p || (p.status !== 'active' && p.status !== 'completed')) return false;
    return !prelevementDecale(p, today);
  }
  function msDe(v) {
    if (!v) return 0;
    if (typeof v === 'number') return v;
    if (v.toMillis) return v.toMillis();
    if (v._seconds) return v._seconds * 1000;
    var t = Date.parse(v);
    return isNaN(t) ? 0 : t;
  }
  /* Le PREMIER prélèvement a-t-il été rejeté ? On regarde le dernier paiement
     réellement parti chez GoCardless : un paiement refait après un rejet
     efface le rejet. Dès qu'un prélèvement est encaissé, ce n'est plus le
     premier : on ne referme plus rien. */
  function premierRejet(paiements) {
    var liste = paiements || [];
    if (liste.some(function (p) { return p && (Number(p.paidCount) > 0 || Number(p.paidAmount) > 0); })) return false;
    var partis = liste.filter(function (p) { return p && (p.gcPaymentId || p.gcSubscriptionId); })
      .sort(function (a, b) { return msDe(b.createdAt) - msDe(a.createdAt); });
    var d = partis[0];
    if (!d) return false;
    return !!d.lastPaymentFailure || d.status === 'failed' || d.status === 'mandate_failed' || d.status === 'cancelled';
  }
  function conditions(contrats, paiements, today) {
    var signe = (contrats || []).some(function (c) { return c && c.status === 'signed'; });
    var paye = (paiements || []).some(function (p) { return paiementOk(p, today); });
    var manque = [];
    if (!signe) manque.push('Contrat non signé');
    if (!paye) manque.push('Paiement non déclenché');
    return { signe: signe, paye: paye, ok: signe && paye, manque: manque };
  }

  return {
    RAPPEL_JOURS: RAPPEL_JOURS, MAX_JOURS: MAX_JOURS,
    isDate: isDate, aujourdhui: aujourdhui, joursEntre: joursEntre, fr: fr,
    enAttente: enAttente, debut: debut, dateValable: dateValable, resume: resume, badge: badge,
    paiementOk: paiementOk, prelevementDecale: prelevementDecale, premierRejet: premierRejet, conditions: conditions, msDe: msDe
  };
}));
