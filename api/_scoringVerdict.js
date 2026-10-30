// ============================================================================
// api/_scoringVerdict.js — LE FEU DE SOLVABILITÉ (30/10/2026, exclu du routing)
// ----------------------------------------------------------------------------
// L'API Societe.com ne vend pas d'« étude de solvabilité » : elle donne des
// faits. Le feu est NOTRE règle, ici et nulle part ailleurs. Pur, sans I/O.
//
//   🔴 rouge   procédure collective en cours, société cessée ou sans aucun
//              établissement ouvert, statut Societe.com autre que « active »
//   🟠 orange  procédure passée, perte ou capitaux propres négatifs sur un
//              bilan récent, siège fermé
//   🟢 vert    un bilan récent et aucun des signaux ci-dessus
//   ⚪ gris    aucun signal, mais pas de chiffres récents pour conclure
//
// Le score financier est AFFICHÉ, jamais utilisé : son échelle n'est pas
// documentée et il peut être très ancien (0,93 pour 2007 sur la société prise
// en exemple par la doc).
//
// Le statut Societe.com seul ne suffit pas : cette même société ressort
// « active » alors que son siège est fermé et qu'il ne lui reste aucun
// établissement ouvert. D'où le recoupement avec l'annuaire gratuit.
// ============================================================================

const ANNEES_BILAN_RECENT = 3;

const TITRES = {
  rouge: 'Risque élevé',
  orange: 'À surveiller',
  vert: 'Pas de signal d\'alerte',
  gris: 'Données insuffisantes',
};

function nombre(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return isFinite(n) ? n : null;
}

function euros(n) {
  return String(Math.round(Math.abs(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
}

/* AAAAMMJJ → JJ/MM/AAAA */
function dateFr(s) {
  const d = String(s || '');
  return d.length === 8 ? d.slice(6, 8) + '/' + d.slice(4, 6) + '/' + d.slice(0, 4) : d;
}

function dernierBilan(bilans) {
  const liste = ((bilans && bilans.bilans) || []).slice();
  liste.sort(function (a, b) { return String(b.datebilan || b.anneebilan).localeCompare(String(a.datebilan || a.anneebilan)); });
  return liste[0] || null;
}

function lireScore(scoring) {
  const s = scoring || {};
  const fin = s.financier || {};
  const extra = s['extra-financier'] || {};
  return {
    financier: nombre((fin.score || {}).financier),
    financierAnnee: fin.periode || null,
    extraGeneral: (extra.score || {}).general || null,
    extraAnnee: extra.periode || null,
  };
}

/* existence : data de /exist ({ common }) ; annuaire : normalize() de
   _companyLookup, ou null s'il n'a pas répondu ; now : Date. */
function calculer(entree, now) {
  const e = entree || {};
  const common = (e.existence && e.existence.common) || e.existence || null;
  const annuaire = e.annuaire || null;
  const procedures = e.procedures || null;
  const anneeCourante = (now || new Date()).getFullYear();

  const rouges = [], oranges = [], infos = [];

  if (!common) {
    infos.push('Société inconnue de Societe.com : vérifier le numéro.');
  } else {
    if (common.pcollencours === true) rouges.push('Procédure collective en cours.');
    const statut = String(common.status || '').toLowerCase();
    if (statut && statut !== 'active') rouges.push('Statut Societe.com : ' + common.status + '.');
  }

  if (annuaire) {
    if (annuaire.etatEntreprise === 'C') rouges.push('Société cessée d\'après l\'annuaire officiel.');
    else if (annuaire.siegeEtat === 'F' && annuaire.etablissementsOuverts === 0) rouges.push('Siège fermé et aucun établissement ouvert.');
    else if (annuaire.siegeEtat === 'F') oranges.push('Siège fermé d\'après l\'annuaire officiel.');
  }

  const listeProc = (procedures && procedures.procedures) || [];
  const nbProc = Number((procedures && procedures.nbprocedures) || listeProc.length || 0);
  if (nbProc > 0 && !(common && common.pcollencours === true)) {
    const derniere = listeProc.slice().sort(function (a, b) { return String(b.dateproc).localeCompare(String(a.dateproc)); })[0];
    oranges.push(nbProc + ' procédure' + (nbProc > 1 ? 's' : '') + ' collective' + (nbProc > 1 ? 's' : '') + ' passée' + (nbProc > 1 ? 's' : '')
      + (derniere && derniere.typeproc ? ', la dernière : ' + derniere.typeproc.toLowerCase() + ' (' + dateFr(derniere.dateproc) + ')' : '') + '.');
  }

  const bilan = dernierBilan(e.bilans);
  const annee = bilan ? Number(bilan.anneebilan) || null : null;
  const recent = !!(annee && annee >= anneeCourante - ANNEES_BILAN_RECENT);
  const ca = bilan ? nombre(bilan.rescatotal) : null;
  const resultat = bilan ? nombre(bilan.resresnet) : null;
  const capitaux = bilan ? nombre(bilan.passifcapprop) : null;
  const dettes = bilan ? nombre(bilan.passifdette) : null;

  if (recent) {
    if (resultat !== null && resultat < 0) oranges.push('Perte de ' + euros(resultat) + ' sur ' + annee + '.');
    if (capitaux !== null && capitaux < 0) oranges.push('Capitaux propres négatifs (-' + euros(capitaux) + ') fin ' + annee + '.');
  } else if (bilan) {
    infos.push('Dernier bilan public : ' + annee + ', trop ancien pour conclure.');
  } else if (common) {
    infos.push('Aucun bilan public : la société ne publie pas ses comptes, ou pas encore.');
  }

  if (annuaire && annuaire.creationDate) {
    const age = (now || new Date()).getTime() - Date.parse(annuaire.creationDate);
    if (age < 365 * 24 * 3600 * 1000) infos.push('Société créée il y a moins d\'un an.');
  }

  let niveau;
  if (rouges.length) niveau = 'rouge';
  else if (oranges.length) niveau = 'orange';
  else if (common && recent) niveau = 'vert';
  else niveau = 'gris';

  const score = lireScore(e.scoring);
  return {
    niveau: niveau,
    titre: TITRES[niveau],
    motifs: rouges.concat(oranges).concat(infos),
    chiffres: {
      statut: common ? String(common.status || '') : '',
      annee: annee, bilanRecent: recent, ca: ca, resultat: resultat, capitaux: capitaux, dettes: dettes,
      effectif: bilan ? nombre(bilan.reseff) : null,
      nbProcedures: nbProc,
      procedureEnCours: !!(common && common.pcollencours === true),
      procedures: listeProc.slice(0, 8).map(function (p) {
        return { type: String(p.typeproc || ''), debut: dateFr(p.dateproc), fin: dateFr(p.datefinproc) };
      }),
      scoreFinancier: score.financier, scoreAnnee: score.financierAnnee,
      scoreExtra: score.extraGeneral, scoreExtraAnnee: score.extraAnnee,
      creation: annuaire ? annuaire.creationDate || '' : '',
      forme: annuaire ? annuaire.legalFormLabel || '' : '',
      activite: annuaire ? annuaire.nafLabel || '' : '',
    },
  };
}

module.exports = { calculer, TITRES, ANNEES_BILAN_RECENT };
