// ============================================================================
// api/_acSequences.js — CONTENU EXACT DES SÉQUENCES ACTIVECAMPAIGN (24/11/2026)
// ----------------------------------------------------------------------------
// Les 7 séquences « après le RDV » (6 freins + rendez-vous manqué,
// automatisations 43-49) ont été créées par l'outil ActiveCampaign, qui a
// rempli leurs e-mails avec un brouillon d'IA. Les outils disponibles ne
// remplacent que le HTML, pas la version « texte seul » : c'est l'API v3
// (PUT /messages/{id}) qui le fait, avec la clé Vercel de Team.
//
// _acSequencesData.json = le texte validé par Adrien
// (docs/parcours-rdv/sequences-freins.md), mis en page : pour chaque message,
// objet, pré-en-tête, HTML, texte seul.
//
// GARDE-FOU : avant d'écrire, le `name` du message (= le nom de l'étape posé
// à la création de l'automatisation) doit être l'objet attendu. Sinon rien
// n'est écrit pour ce message et l'écart est rapporté.
//
// Déclenché une fois par _config/parcours_rdv.syncTextesAC === true, lu par
// le cron de api/parcours-rdv.js (seul à avoir la clé en production) ;
// résultat dans _config/parcours_rdv.syncTextesResultat. N'active rien.
// ============================================================================
'use strict';

const AC = require('./_activeCampaign');
const DATA = require('./_acSequencesData.json');

/* Réponses → strategie@ : la seule boîte que Team lit (api/gmail-inbound-sync.js)
   pour rattacher la réponse à la fiche et alerter le setter / closer. */
const EXPEDITEUR = { fromname: 'Adrien & Emily', fromemail: 'contact@adrienemily.com', reply2: 'strategie@adrienemily.com' };

function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim().toLowerCase(); }

async function synchroniser(opts) {
  opts = opts || {};
  const apply = opts.apply === true;
  const res = { apply: apply, total: DATA.length, ecrits: 0, ignores: [], erreurs: [] };
  for (let i = 0; i < DATA.length; i++) {
    const m = DATA[i];
    const g = await AC.appel('GET', '/messages/' + m.messageId);
    if (!g.ok) { res.erreurs.push({ id: m.messageId, tag: m.tag, n: m.n, erreur: g.erreur }); continue; }
    const actuel = (g.data && g.data.message) || {};
    if (norm(actuel.name) !== norm(m.subject)) {
      res.ignores.push({ id: m.messageId, tag: m.tag, n: m.n, attendu: m.subject, trouve: actuel.name || null });
      continue;
    }
    if (!apply) { res.ecrits++; continue; }
    const p = await AC.appel('PUT', '/messages/' + m.messageId, { message: Object.assign({}, EXPEDITEUR, {
      subject: m.subject, preheader_text: m.preheader || '', html: m.html, text: m.text,
      htmlfetch: 'now', textfetch: 'now',
    }) });
    if (!p.ok) { res.erreurs.push({ id: m.messageId, tag: m.tag, n: m.n, erreur: p.erreur, detail: p.data ? JSON.stringify(p.data).slice(0, 300) : null }); continue; }
    // Relecture : le texte seul doit être le nôtre.
    const v = await AC.appel('GET', '/messages/' + m.messageId);
    const lu = (v.data && v.data.message) || {};
    const debut = m.text.slice(0, 40);
    if (String(lu.text || '').indexOf(debut) !== 0 || norm(lu.subject) !== norm(m.subject)) {
      res.erreurs.push({ id: m.messageId, tag: m.tag, n: m.n, erreur: 'relecture_differente', sujetLu: lu.subject || null, texteLu: String(lu.text || '').slice(0, 60) });
      continue;
    }
    res.ecrits++;
  }
  res.at = Date.now();
  return res;
}

module.exports = { synchroniser: synchroniser, DATA: DATA };
