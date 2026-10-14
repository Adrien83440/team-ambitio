// ============================================================================
// scripts/full-cycle-canada-template.js — « CONTRAT FULL CYCLE — CANADA »
// ----------------------------------------------------------------------------
// Crée le modèle de signature « Contrat Full Cycle — Canada »
// (signature_templates/full-cycle-canada) en partant du « Contrat Full
// Cycle » actuel (5ji06Vk86eXGcLdkXQ5b), adapté à un prestataire (closer)
// établi au Canada. Le droit applicable reste le droit français.
//
// CE QUI CHANGE PAR RAPPORT AU CONTRAT SOURCE
//   · Parties : identité canadienne ({{immatriculation}} = NEQ / NE,
//     {{numeros_taxes}} = TPS/TVH, TVQ) au lieu de SIRET / RCS / capital ;
//   · 3.4  heure de Paris pour les rendez-vous et délais ;
//   · 4.3  justificatifs canadiens (état de renseignements, taxes, D.8222-7)
//          au lieu de l'attestation URSSAF ; 4.6 aucun lien d'emploi, ni en
//          droit français ni en droit canadien / québécois ;
//   · 7    montants en euros, TVA française autoliquidée (CGI 259-1° et
//          283-2), taxes canadiennes à la charge du prestataire — au lieu de
//          « TVA non applicable, article 293 B » ;
//   · 8    lots expédiés au Canada (douane à sa charge) ou acquis sur place ;
//   · 9    facture en euros, virement international, frais SHA, change,
//          anti-fraude au RIB, retenue à la source CGI 182 B écartée sur
//          attestation de résidence (convention France–Canada du 2 mai 1975) ;
//   · 10.3 réglementation du pays du prospect, à l'heure du prospect ;
//   · 11.6–11.7 transfert de données vers le Canada (décision 2002/2/CE,
//          clauses contractuelles types 2021/914 en secours, loi québécoise) ;
//   · 14.3 non-concurrence définie par la clientèle visée (France), plus par
//          le territoire français ;
//   · 18.1 assurance couvrant les dommages en France ;
//   · 19   code de vérification par e-mail, LCCJTI (Québec) ;
//   · 20.5 la Société peut céder le contrat à une entité du groupe ou à un
//          repreneur, y compris étranger (passage prévu en LLC américaine) ;
//          20.7 langue, 20.8 notifications internationales ;
//   · 21   droit français, juridictions de Draguignan, art. 3148 et 3155 C.c.Q.
//   · web.roleSignataire = 'prestataire' : le PDF signe « La SOCIÉTÉ » /
//     « Le PRESTATAIRE » (et non plus « Le PRESTATAIRE » / « Le CLIENT »).
//   · variables capital_social et rcs_ville retirées (sans objet au Canada).
//
// SÉCURITÉ DU PATCH : chaque clause remplacée doit figurer EXACTEMENT une
// fois, à l'identique, dans le contrat source. Si Adrien a retouché le
// « Contrat Full Cycle » depuis le 14/10/2026, le script s'arrête et dit
// quelle clause a changé : on relit avant de recréer.
//
// Règle n°3 du repo : MODE LECTURE SEULE PAR DÉFAUT. L'écriture n'a lieu
// qu'avec --apply, après validation d'Adrien. createDoc échoue si le modèle
// existe déjà : le script ne peut pas écraser un modèle.
//
// Usage :
//   export GOOGLE_APPLICATION_CREDENTIALS=~/.secrets/ambitio-team-sa.json
//   node scripts/full-cycle-canada-template.js                     # à blanc
//   node scripts/full-cycle-canada-template.js --texte             # + texte intégral
//   node scripts/full-cycle-canada-template.js --apercu=/tmp/x.pdf # + PDF d'aperçu
//   node scripts/full-cycle-canada-template.js --apply             # création
//   node scripts/full-cycle-canada-template.js --source=<dump.json> # à blanc, hors ligne
//   node scripts/full-cycle-canada-template.js --export=<web.json>  # + texte produit en JSON (tests)
// ============================================================================
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ARGS = process.argv.slice(2);
function flag(n) { return ARGS.indexOf(n) >= 0; }
function opt(n) {
  const a = ARGS.find(function (x) { return x.indexOf(n + '=') === 0; });
  return a ? a.slice(n.length + 1) : '';
}
const APPLY = flag('--apply');
const SHOW_TEXT = flag('--texte');
const PREVIEW = opt('--apercu');
const SOURCE_FILE = opt('--source');
const EXPORT_FILE = opt('--export');

const ROOT = path.join(__dirname, '..');
const SOURCE_ID = '5ji06Vk86eXGcLdkXQ5b';           // « Contrat Full Cycle »
const TARGET_ID = 'full-cycle-canada';
const NAME = 'Contrat Full Cycle — Canada';
const BY = 'script full-cycle-canada-template.js';

/* ── cleanWeb de l'atelier, lu dans api/contract-studio.js ──────────────────
   Même technique que scripts/bp-create-contract-template.js : le fichier ne
   se require() pas hors Vercel, on en extrait la fonction de validation. */
function loadCleanWeb() {
  const src = fs.readFileSync(path.join(ROOT, 'api', 'contract-studio.js'), 'utf8');
  const a = src.indexOf('const KEY_RE');
  const b = src.indexOf('/* Le texte d\'un modèle');
  if (a < 0 || b < 0 || b <= a) throw new Error('cleanWeb introuvable dans api/contract-studio.js (le fichier a changé ?)');
  const code = src.slice(a, b).replace(/^const KEY_RE/, 'var KEY_RE');
  const box = {};
  vm.runInNewContext(code + '\nthis.cleanWeb = cleanWeb;', box);
  if (typeof box.cleanWeb !== 'function') throw new Error('cleanWeb non chargée');
  return box.cleanWeb;
}

/* ── Les modifications, article par article ─────────────────────────────── */
/* op 'replace' : un bloc → un ou plusieurs blocs ; op 'after' : insertion
   après un bloc existant ; op 'append' : ajout en fin d'article. */
const OPS = [
  /* ENTRE LES SOUSSIGNÉS — identité canadienne du Prestataire. */
  { sec: 'parties', op: 'replace', old: 'p:Nom et prénom / Dénomination sociale : {{entreprise}}', add: ['p:Dénomination de l’entreprise : {{entreprise}}'] },
  { sec: 'parties', op: 'replace', old: 'p:Forme juridique (micro-entreprise, EI, EURL, SASU…) : {{forme_juridique}}', add: ['p:Forme juridique : {{forme_juridique}}'] },
  { sec: 'parties', op: 'replace', old: 'p:Capital social (le cas échéant) : {{var:capital_social}}', add: [] },
  { sec: 'parties', op: 'replace', old: 'p:Adresse du siège social / domicile professionnel : {{siege_social}}', add: ['p:Adresse de l’établissement principal (Canada) : {{siege_social}}'] },
  { sec: 'parties', op: 'replace', old: 'p:Immatriculée au RCS / RM de : {{var:rcs_ville}}', add: [] },
  { sec: 'parties', op: 'replace', old: 'p:Numéro SIRET : {{siret}}', add: ['p:Immatriculation : {{immatriculation}}'] },
  { sec: 'parties', op: 'replace', old: 'p:Numéro de TVA intracommunautaire (le cas échéant) : {{tva}}', add: ['p:Numéros d’inscription aux taxes de vente canadiennes (TPS/TVH, TVQ) : {{numeros_taxes}}'] },

  /* PRÉAMBULE */
  { sec: 'preambule', op: 'replace',
    old: 'p:Le Prestataire déclare exercer son activité de manière indépendante, être régulièrement immatriculé et à jour de l’ensemble de ses obligations déclaratives, sociales et fiscales.',
    add: ['p:Le Prestataire est une entreprise établie au Canada, où elle est immatriculée et exerce son activité. Il déclare exercer cette activité de manière indépendante, être régulièrement immatriculé auprès du registre compétent et à jour de l’ensemble de ses obligations déclaratives, sociales et fiscales au regard du droit canadien et de celui de sa province d’établissement. La mission est exécutée à distance, depuis le Canada, auprès d’une clientèle principalement établie en France.'] },

  /* ARTICLE 3 — fuseau horaire */
  { sec: 'art3', op: 'append',
    add: ['p:3.4. Les heures de rendez-vous, délais et échéances prévus au présent contrat et dans les process de la Société s’entendent à l’heure de Paris (France), sauf mention contraire. Le Prestataire, établi dans un autre fuseau horaire, organise ses disponibilités en conséquence, la clientèle de la Société étant principalement établie en France ; le décalage horaire ne peut justifier un manquement aux articles 3.2 et 6.1.'] },

  /* ARTICLE 4 — justificatifs et absence de lien d'emploi */
  { sec: 'art4', op: 'replace',
    old: 'p:4.3. Le Prestataire déclare et garantit être régulièrement immatriculé et à jour de ses obligations. Il remet à la Société, à la signature des présentes puis tous les six (6) mois, les documents visés aux articles L.8222-1 et D.8222-5 du Code du travail, et notamment son attestation de vigilance URSSAF ainsi qu’un extrait d’immatriculation de moins de six (6) mois. À défaut de remise dans un délai de quinze (15) jours suivant une demande écrite, la Société pourra suspendre tout paiement jusqu’à régularisation, sans que cette suspension n’ouvre droit à indemnité ni ne constitue un manquement de sa part.',
    add: ['p:4.3. Le Prestataire déclare et garantit être régulièrement immatriculé auprès du registre des entreprises compétent de sa province d’établissement, inscrit le cas échéant aux fichiers de la TPS/TVH et de la TVQ, et à jour de ses obligations fiscales, sociales et déclaratives au Canada et dans sa province, notamment auprès de l’Agence du revenu du Canada et, s’il est établi au Québec, de Revenu Québec. Il remet à la Société, à la signature des présentes puis tous les six (6) mois : (i) un état de renseignements ou extrait du registre des entreprises datant de moins de trois (3) mois ; (ii) le cas échéant, la preuve de ses numéros d’inscription aux taxes de vente ; (iii) une attestation sur l’honneur de la régularité de sa situation fiscale et sociale ; ainsi que, en tant que de besoin, les documents visés à l’article D.8222-7 du Code du travail applicables à un cocontractant établi à l’étranger, accompagnés le cas échéant de leur traduction en langue française. À défaut de remise dans un délai de quinze (15) jours suivant une demande écrite, la Société pourra suspendre tout paiement jusqu’à régularisation, sans que cette suspension n’ouvre droit à indemnité ni ne constitue un manquement de sa part.'] },
  { sec: 'art4', op: 'append',
    add: ['p:4.6. Le présent contrat ne crée aucun lien d’emploi entre les Parties, ni au sens du droit français, ni au sens du droit canadien ou québécois. Le Prestataire, qui exerce pour son propre compte et assume les risques de son activité, acquitte seul ses impôts ainsi que l’ensemble des cotisations et contributions dont il est redevable dans son pays d’établissement (notamment, au Québec, au titre du Régime de rentes du Québec, du Régime québécois d’assurance parentale et, le cas échéant, de la CNESST). Il garantit la Société contre toute réclamation d’un organisme fiscal ou social, canadien ou étranger, relative à sa situation.'] },

  /* ARTICLE 7 — devise et taxes */
  { sec: 'art7', op: 'replace',
    old: 'p:Les montants stipulés au présent contrat sont exprimés hors taxes (HT) et constituent des montants forfaitaires par vente. La TVA s’y ajoute au taux en vigueur lorsque le Prestataire y est assujetti ; à défaut, ses factures portent la mention « TVA non applicable, article 293 B du CGI ».',
    add: ['p:Les montants stipulés au présent contrat sont exprimés en euros (€), hors taxes (HT), et constituent des montants forfaitaires par vente. Les prestations étant rendues à la Société, assujettie établie en France, elles sont localisées en France au sens de l’article 259, 1° du Code général des impôts : le Prestataire facture sans TVA française, la taxe éventuellement due étant acquittée par la Société selon le mécanisme d’autoliquidation (article 283, 2 du même code). Les taxes de vente canadiennes (TPS/TVH et TVQ) relèvent de la seule appréciation et de la seule responsabilité du Prestataire, notamment quant à la détaxation éventuelle des services fournis à une entreprise non résidente ; les montants stipulés s’entendent toutes taxes canadiennes éventuelles comprises, aucune somme supplémentaire ne pouvant être réclamée à la Société à ce titre.'] },

  /* ARTICLE 8 — lots expédiés hors de France, fiscalité */
  { sec: 'art8', op: 'replace',
    old: 'p:b) Les lots matériels sont remis ou expédiés au Prestataire dans un délai de soixante (60) jours suivant la constatation du palier.',
    add: ['p:b) Les lots matériels sont remis ou expédiés au Prestataire dans un délai de soixante (60) jours suivant la constatation du palier. Le Prestataire étant établi hors de France, la Société peut, à son choix, soit expédier le lot à l’adresse qu’il lui indique, les droits de douane, taxes à l’importation et frais de dédouanement restant à la charge du Prestataire, soit faire acquérir et livrer au Canada un lot de nature et de valeur équivalentes au sens de l’article 8.4.'] },
  { sec: 'art8', op: 'replace',
    old: 'p:Les lots constituent un complément de rémunération en nature de la prestation. La Société communique au Prestataire, lors de la remise, la valeur du lot attribué. Le Prestataire fait son affaire personnelle de l’ensemble des obligations déclaratives, fiscales et sociales attachées à cet avantage, la Société n’en supportant aucune charge ni aucun complément.',
    add: ['p:Les lots constituent un complément de rémunération en nature de la prestation. La Société communique au Prestataire, lors de la remise, la valeur du lot attribué. Le Prestataire fait son affaire personnelle de l’ensemble des obligations déclaratives, fiscales et sociales attachées à cet avantage, notamment au regard de la législation fiscale canadienne et de celle de sa province d’établissement, la Société n’en supportant aucune charge ni aucun complément.'] },

  /* ARTICLE 9 — facture, paiement international, retenue à la source */
  { sec: 'art9', op: 'replace',
    old: 'p:9.1. Le Prestataire adresse à la Société une facture unique par mois, établie sur la base du décompte visé à l’article 7.5.d), faisant apparaître distinctement les commissions de closing et les commissions de setting, et comportant l’ensemble des mentions légales obligatoires (numéro SIRET, numéro et date de facture, détail des prestations et, le cas échéant, la mention « TVA non applicable, article 293 B du CGI »).',
    add: ['p:9.1. Le Prestataire adresse à la Société une facture unique par mois, établie en euros sur la base du décompte visé à l’article 7.5.d), faisant apparaître distinctement les commissions de closing et les commissions de setting. Outre les mentions exigées par la législation qui lui est applicable, elle comporte au minimum : la dénomination et l’adresse du Prestataire, son numéro d’entreprise (NEQ ou numéro d’entreprise fédéral) et, le cas échéant, ses numéros de TPS/TVH et de TVQ ; la dénomination, l’adresse, le numéro SIRET et le numéro de TVA intracommunautaire de la Société (SARL AMBITIO CORP, SIRET 943 098 707 00012, TVA FR36943098707) ; le numéro et la date de la facture ; le détail des prestations ; la mention « Autoliquidation — TVA due par le preneur (article 283, 2 du CGI) ».'] },
  { sec: 'art9', op: 'replace',
    old: 'p:9.2. Le règlement intervient par virement bancaire dans un délai de dix (10) jours ouvrés à compter de la réception d’une facture conforme.',
    add: ['p:9.2. Le règlement intervient en euros, par virement bancaire international sur le compte désigné par écrit par le Prestataire, dans un délai de dix (10) jours ouvrés à compter de la réception d’une facture conforme. Les frais bancaires sont partagés : chaque Partie supporte ceux de sa propre banque (option « SHA »). Les frais de conversion et le risque de change entre l’euro et le dollar canadien sont supportés par le Prestataire. Toute modification des coordonnées bancaires doit être notifiée par écrit par le représentant du Prestataire et ne prend effet qu’après confirmation par la Société au moyen d’un canal distinct.'] },
  { sec: 'art9', op: 'append',
    add: ['p:9.5. Le Prestataire déclare n’avoir en France ni établissement stable ni base fixe et y relever, pour les sommes perçues au titre du présent contrat, des stipulations de la convention fiscale conclue entre la France et le Canada le 2 mai 1975, en vertu desquelles ces revenus ne sont imposables qu’au Canada. Il remet à la Société, à la signature des présentes puis au début de chaque année civile, une attestation de résidence fiscale au Canada (formulaire n° 5000 visé par l’administration fiscale canadienne, ou document équivalent) permettant à la Société de ne pas pratiquer la retenue à la source prévue par l’article 182 B du Code général des impôts. À défaut de remise de ce document, la Société pratique sur les sommes versées la retenue légalement due, dont le montant vient en déduction des sommes payées au Prestataire.'] },

  /* ARTICLE 10 — prospection depuis l'étranger */
  { sec: 'art10', op: 'after',
    anchor: 'li:à n’utiliser aucun automate d’appel, numéro masqué, numéro usurpé ou dispositif d’envoi ou de composition automatique non expressément validé par la Société.',
    add: ['li:à appliquer, quel que soit son propre lieu d’établissement, la réglementation du pays où se trouve le prospect — la réglementation française pour les prospects établis en France —, les jours et plages horaires de prospection s’appréciant à l’heure locale du prospect.'] },

  /* ARTICLE 11 — transfert de données vers le Canada */
  { sec: 'art11', op: 'append',
    add: [
      'p:11.6. Le Prestataire, établi au Canada, accède aux données à caractère personnel depuis ce pays. Ce transfert est encadré par la décision de la Commission européenne du 20 décembre 2001 constatant le niveau de protection adéquat assuré par la loi canadienne sur la protection des renseignements personnels et les documents électroniques (décision 2002/2/CE). Si cette décision ne trouvait pas à s’appliquer au Prestataire, les Parties s’engagent à conclure, à première demande de la Société, les clauses contractuelles types adoptées par la Commission européenne (décision d’exécution (UE) 2021/914, module « responsable du traitement vers sous-traitant »), lesquelles prévaudront alors sur toute stipulation contraire du présent article.',
      'p:11.7. Le Prestataire respecte en outre la législation canadienne et provinciale qui lui est applicable en matière de protection des renseignements personnels, notamment, s’il est établi au Québec, la Loi sur la protection des renseignements personnels dans le secteur privé. Il n’accède aux données qu’au moyen des outils et comptes de la Société et ne les enregistre sur aucun support local ni aucun service tiers.',
    ] },

  /* ARTICLE 14 — périmètre de la non-concurrence */
  { sec: 'art14', op: 'replace',
    old: 'p:14.3. Les obligations du présent article sont limitées au territoire français et aux seules activités visées à l’article 14.1. Elles ne font pas obstacle à l’exercice par le Prestataire d’une activité de setting, de closing ou de prospection commerciale dans tout autre secteur d’activité, de sorte qu’elles ne le privent pas de la possibilité d’exercer son activité professionnelle.',
    add: ['p:14.3. Les obligations du présent article sont limitées aux seules activités visées à l’article 14.1, exercées au profit d’entreprises qui commercialisent leurs services auprès de dirigeants ou de commerçants établis en France, quel que soit le lieu d’établissement du Prestataire ou de ces entreprises. Elles ne font pas obstacle à l’exercice par le Prestataire d’une activité de setting, de closing ou de prospection commerciale dans tout autre secteur d’activité, ou auprès d’une clientèle établie hors de France, de sorte qu’elles ne le privent pas de la possibilité d’exercer son activité professionnelle.'] },

  /* ARTICLE 18 — assurance */
  { sec: 'art18', op: 'replace',
    old: 'p:18.1. Le Prestataire déclare être titulaire d’une assurance de responsabilité civile professionnelle couvrant les conséquences pécuniaires de la responsabilité qu’il peut encourir dans le cadre de son activité, et s’engage à en justifier à première demande de la Société.',
    add: ['p:18.1. Le Prestataire déclare être titulaire d’une assurance de responsabilité civile professionnelle couvrant les conséquences pécuniaires de la responsabilité qu’il peut encourir dans le cadre de son activité, y compris pour les dommages survenus en France ou causés à des personnes qui y sont établies, et s’engage à en justifier à première demande de la Société.'] },

  /* ARTICLE 19 — signature électronique */
  { sec: 'art19', op: 'replace',
    old: 'p:19.1. Les Parties conviennent expressément que le présent contrat pourra être conclu et signé par voie électronique, au moyen d’un procédé de signature électronique fiable au sens de l’article 1367 du Code civil et du Règlement (UE) n° 910/2014 dit « eIDAS ».',
    add: ['p:19.1. Les Parties conviennent expressément que le présent contrat pourra être conclu et signé par voie électronique, au moyen d’un procédé de signature électronique fiable au sens de l’article 1367 du Code civil et du Règlement (UE) n° 910/2014 dit « eIDAS ». L’identité du Prestataire peut être vérifiée au moyen d’un code à usage unique adressé à son adresse e-mail.'] },
  { sec: 'art19', op: 'append',
    add: ['p:19.4. Le Prestataire reconnaît que le contrat ainsi signé et son dossier de preuve constituent également, au regard du droit québécois, un document technologique dont l’intégrité est assurée au sens de la Loi concernant le cadre juridique des technologies de l’information (RLRQ, c. C-1.1), et s’interdit d’en contester la validité au seul motif de sa forme électronique.'] },

  /* ARTICLE 20 — cession par la Société, langue, notifications */
  { sec: 'art20', op: 'replace',
    old: 'p:20.5. Cession : le contrat étant conclu intuitu personae, le Prestataire ne peut le céder, le transférer ni l’apporter à un tiers sans l’accord écrit et préalable de la Société.',
    add: ['p:20.5. Cession : le contrat étant conclu intuitu personae, le Prestataire ne peut le céder, le transférer ni l’apporter à un tiers sans l’accord écrit et préalable de la Société. La Société peut en revanche céder le présent contrat, ou les droits et obligations qui en résultent, à toute entité qui la contrôle, qu’elle contrôle ou qui est placée sous le même contrôle qu’elle, ainsi qu’à toute entité, de droit français ou étranger, qui reprendrait tout ou partie de son activité, notamment dans le cadre d’une réorganisation ou d’un transfert d’activité. Le Prestataire y consent dès à présent au sens de l’article 1216 du Code civil ; la cession lui devient opposable à compter de sa notification écrite, et les droits qu’il a acquis, notamment au titre des commissions et du programme de bonus, sont maintenus.'] },
  { sec: 'art20', op: 'append',
    add: [
      'p:20.7. Langue : le présent contrat est rédigé en langue française, langue choisie d’un commun accord par les Parties ; toute traduction n’a qu’une valeur informative.',
      'p:20.8. Notifications : les notifications prévues au contrat sont valablement faites par courrier électronique aux adresses figurant en tête des présentes. Lorsqu’un envoi postal est exigé, il peut l’être par courrier international recommandé ou par service de messagerie avec preuve de remise.',
    ] },

  /* ARTICLE 21 — droit français, juridiction, exécution au Canada */
  { sec: 'art21', op: 'replace',
    old: 'p:Le présent contrat est soumis au droit français. En cas de différend relatif à sa validité, son interprétation, son exécution ou sa cessation, les Parties s’efforceront de parvenir à une solution amiable. À défaut d’accord dans un délai de trente (30) jours à compter de la première notification écrite du différend, le litige relèvera de la compétence exclusive des tribunaux du ressort du siège social de la Société, conformément au droit français.',
    add: [
      'p:Le présent contrat, ainsi que toute question relative à sa formation, sa validité, son interprétation, son exécution ou sa cessation, est régi par le droit français, nonobstant l’établissement du Prestataire au Canada et à l’exclusion de toute règle de conflit de lois qui conduirait à l’application d’une autre loi.',
      'p:En cas de différend, les Parties s’efforceront de parvenir à une solution amiable. À défaut d’accord dans un délai de trente (30) jours à compter de la première notification écrite du différend, le litige relèvera de la compétence exclusive des juridictions de Draguignan (France), y compris en cas de référé, d’appel en garantie ou de pluralité de défendeurs. Les Parties entendent ainsi soumettre leurs différends aux seules autorités françaises, notamment au sens de l’article 3148 du Code civil du Québec ; le Prestataire reconnaît que les décisions rendues par ces juridictions pourront être reconnues et exécutées au Canada, notamment dans les conditions des articles 3155 et suivants du même code.',
    ] },

  /* ANNEXE 1 — devise */
  { sec: 'annexe1', op: 'replace',
    old: 'i:La présente annexe fait partie intégrante du contrat. Tous les montants sont exprimés hors taxes (HT), fermes et forfaitaires par vente. Aucune rémunération fixe n’est due (art. 7.1).',
    add: ['i:La présente annexe fait partie intégrante du contrat. Tous les montants sont exprimés et payés en euros (€), hors taxes (HT), fermes et forfaitaires par vente (art. 7 et 9.2). Aucune rémunération fixe n’est due (art. 7.1).'] },
];
const DROP_VARS = ['capital_social', 'rcs_ville'];

/* Points à faire relire — repris dans noteRelecture et la note de version. */
const NOTE = {
  statut: 'a_relire',
  titre: 'Contrat Full Cycle — Canada : points à faire valider',
  resume: 'Adaptation du Contrat Full Cycle à un prestataire établi au Canada (droit français maintenu).',
  points: [
    '1. Expert-comptable : retenue à la source art. 182 B CGI et attestation de résidence (formulaire 5000) — article 9.5.',
    '2. Expert-comptable : autoliquidation de la TVA (CGI 259-1° et 283-2) et mention sur facture — articles 7 et 9.1.',
    '3. Avocat : documents D.8222-7 demandés « en tant que de besoin » à un prestataire travaillant depuis l\'étranger — article 4.3.',
    '4. Avocat : transfert de données vers le Canada (décision 2002/2/CE, CCT 2021/914 en secours) — article 11.6.',
    '5. Avocat : clause attributive aux juridictions de Draguignan et exécution au Québec (C.c.Q. 3148, 3155) — article 21.',
    '6. Barème : « Business Phénix (12 mois) » repris tel quel du contrat source — à mettre à jour si la commission BP 6 mois diffère.',
  ],
};

function applyOps(src) {
  const web = JSON.parse(JSON.stringify(src));
  const errs = [];
  OPS.forEach(function (o, k) {
    const sec = (web.sections || []).find(function (s) { return s.id === o.sec; });
    if (!sec) { errs.push('#' + k + ' article « ' + o.sec + ' » introuvable'); return; }
    if (o.op === 'append') { sec.blocks = sec.blocks.concat(o.add); return; }
    const needle = o.op === 'replace' ? o.old : o.anchor;
    const hits = sec.blocks.filter(function (b) { return b === needle; }).length;
    if (hits !== 1) { errs.push('#' + k + ' « ' + o.sec + ' » : clause attendue ' + hits + ' fois au lieu de 1 → ' + needle.slice(0, 90) + '…'); return; }
    const i = sec.blocks.indexOf(needle);
    if (o.op === 'replace') sec.blocks.splice.apply(sec.blocks, [i, 1].concat(o.add));
    else sec.blocks.splice.apply(sec.blocks, [i + 1, 0].concat(o.add));
  });
  web.variables = (web.variables || []).filter(function (v) { return DROP_VARS.indexOf(v.key) < 0; });
  web.subtitle = 'Mission « full cycle » — prestataire établi au Canada';
  web.roleSignataire = 'prestataire';
  return { web: web, errors: errs };
}

/* Contrôles propres à la version Canada. */
function canadaChecks(web) {
  const errs = [];
  const txt = web.sections.map(function (s) { return s.title + '\n' + s.blocks.join('\n'); }).join('\n');
  [[/293 B/, 'mention « 293 B »'], [/URSSAF/, 'URSSAF'], [/\{\{siret\}\}/, '{{siret}}'], [/\{\{tva\}\}/, '{{tva}}'],
    [/capital_social|rcs_ville/, 'variable française'], [/territoire français/, '« territoire français »']]
    .forEach(function (r) { if (r[0].test(txt)) errs.push('reste du contrat français : ' + r[1]); });
  [[/\{\{immatriculation\}\}/, '{{immatriculation}}'], [/\{\{numeros_taxes\}\}/, '{{numeros_taxes}}'], [/droit français/, 'droit français'],
    [/Draguignan/, 'Draguignan'], [/182 B/, 'retenue à la source'], [/2002\/2\/CE/, 'transfert de données'], [/1216 du Code civil/, 'cession par la Société']]
    .forEach(function (r) { if (!r[0].test(txt)) errs.push('mention attendue absente : ' + r[1]); });
  if (web.roleSignataire !== 'prestataire') errs.push('roleSignataire perdu au nettoyage');
  return errs;
}

function plain(web) {
  const render = require('../api/_contract-render');
  const r = render.resolveForSigner(web, {});
  const out = [r.title, r.subtitle, r.tagline, ''];
  r.sections.forEach(function (s) {
    out.push('', s.title);
    s.blocks.forEach(function (b) {
      const m = /^(p|h|li|ol|i|q|field):(.*)$/.exec(b);
      if (m) out.push((m[1] === 'li' ? '   • ' : (m[1] === 'h' ? '  ' : '   ')) + m[2].replace(/\*\*/g, ''));
    });
  });
  return out.join('\n');
}

/* Aperçu PDF avec une entreprise québécoise fictive, signé comme le serait
   le vrai contrat (clientMap de api/sign-session.js reproduit à la main). */
async function makePreview(web, file) {
  const render = require('../api/_contract-render');
  const company = require('../api/_companyLookup');
  const ca = company.canadaCompany({
    province: 'QC', registryNumber: '1170000000', name: 'GESTION EXEMPLE INC.', legalFormLabel: 'Société par actions (compagnie)',
    gstNumber: '123456789 RT0001', qstNumber: '1234567890 TQ0001',
    address: { line1: '1000 rue Sherbrooke Ouest', line2: 'bureau 200', city: 'Montréal', postalCode: 'H3A 3G4' },
  }, '14/10/2026').company;
  const client = {
    entreprise: ca.name, nom_prenom: 'Camille Tremblay', qualite: 'Président', forme_juridique: ca.legalFormLabel,
    siege_social: company.addressLine(ca.address), immatriculation: company.registrationLine(ca), numeros_taxes: ca.taxNumbers || 'néant',
    email: 'camille@exemple.ca', telephone: '+1 514 555 1234', date_signature: '14/10/2026',
  };
  const prefill = { date_effet: '2026-10-20', interlocuteur_referent: 'Adrien François', comptes_outils: 'CRM Alteore', ligne_telephonie: 'Ringover', outil_visio: 'Google Meet', enregistrement: 'oui' };
  const built = await render.composeContract({ web: web, prefill: prefill, client: client, checks: {}, signers: [], preview: true });
  fs.writeFileSync(file, Buffer.from(await built.doc.save()));
  console.log('Aperçu PDF :', file, '(' + built.doc.getPageCount() + ' pages)');
}

(async function () {
  console.log(APPLY ? '=== MODE ÉCRITURE ===' : '=== MODE À BLANC (aucune écriture) ===');
  if (APPLY && SOURCE_FILE) { console.log('✗ --apply et --source sont incompatibles : la création repart toujours de la base.'); process.exit(1); }
  let R = null;
  let T;
  if (SOURCE_FILE) {
    T = JSON.parse(fs.readFileSync(SOURCE_FILE, 'utf8'));
    console.log('Source : fichier ' + SOURCE_FILE);
  } else {
    R = require('./_firestore-rest');
    const d = await R.getDoc('signature_templates/' + SOURCE_ID);
    if (!d) { console.log('✗ Modèle source ' + SOURCE_ID + ' introuvable'); process.exit(1); }
    T = d.data;
    console.log('Source : signature_templates/' + SOURCE_ID + ' « ' + T.name + ' » (version ' + ((T.web && T.web.version) || '?') + ')');
    const exists = await R.getDoc('signature_templates/' + TARGET_ID);
    if (exists) { console.log('✗ signature_templates/' + TARGET_ID + ' existe déjà (« ' + exists.data.name + ' ») : rien à faire. Modifier ce modèle dans l\'atelier.'); process.exit(1); }
  }
  if (!T.web || !T.web.generated) { console.log('✗ Le modèle source n\'est pas un contrat de l\'atelier'); process.exit(1); }

  const a = applyOps(T.web);
  if (a.errors.length) {
    console.log('\n✗ Le contrat source a changé — patch refusé :');
    a.errors.forEach(function (e) { console.log('   -', e); });
    process.exit(1);
  }
  const c = loadCleanWeb()(a.web);
  const errs = c.errors.concat(canadaChecks(c.web));
  if (errs.length) {
    console.log('\n✗ Contrat refusé :');
    errs.forEach(function (e) { console.log('   -', e); });
    process.exit(1);
  }
  console.log('✓ ' + OPS.length + ' modifications appliquées, texte validé par cleanWeb (atelier) et par les contrôles Canada');

  const nowIso = new Date().toISOString();
  const web = Object.assign({}, c.web, { version: 1, savedAt: nowIso, savedBy: BY, duplicatedFrom: SOURCE_ID });
  const doc = {
    name: NAME, web: web, generated: true, fields: [], pages: 0, isAdhoc: false,
    audience: 'admin',
    academyCourseId: T.academyCourseId || '', academyCourseName: T.academyCourseName || '',
    automationEnabled: false, automationWebhookUrl: '', automationNote: '',
    noteRelecture: Object.assign({}, NOTE, { creeLe: nowIso, creePar: BY }),
    createdAt: new Date(nowIso), updatedAt: new Date(nowIso),
  };
  const version = { version: 1, name: NAME, web: web, note: NOTE.resume, by: BY, at: new Date(nowIso), atIso: nowIso };

  console.log('\n' + NOTE.titre);
  NOTE.points.forEach(function (p) { console.log('  ' + p); });
  console.log('\n── signature_templates/' + TARGET_ID + ' ──');
  console.log('  name      : ' + doc.name);
  console.log('  audience  : admin (confidentiel)');
  console.log('  academy   : ' + (doc.academyCourseId || '—'));
  console.log('  articles  : ' + web.sections.length + ' · variables : ' + web.variables.map(function (v) { return v.key; }).join(', '));
  console.log('  signature : « La SOCIÉTÉ » / « Le PRESTATAIRE » (roleSignataire = prestataire)');
  console.log('── signature_templates/' + TARGET_ID + '/versions/0001 ── (note : « ' + version.note + ' »)');

  if (SHOW_TEXT) console.log('\n' + plain(web));
  if (PREVIEW) await makePreview(web, PREVIEW);
  if (EXPORT_FILE) { fs.writeFileSync(EXPORT_FILE, JSON.stringify(web, null, 1)); console.log('Texte exporté :', EXPORT_FILE); }

  if (!APPLY) { console.log('\nRelancer avec --apply pour écrire.'); return; }
  await R.createDoc('signature_templates/' + TARGET_ID, doc);
  await R.createDoc('signature_templates/' + TARGET_ID + '/versions/0001', version);
  console.log('\n✓ Modèle créé : signature_templates/' + TARGET_ID);
  console.log('  → à relire dans l\'atelier : contract-studio.html?id=' + TARGET_ID);
})().catch(function (e) { console.error('✗', e && e.stack ? e.stack : e); process.exit(1); });
