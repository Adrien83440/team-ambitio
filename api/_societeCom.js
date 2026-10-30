// ============================================================================
// api/_societeCom.js — CLIENT DE L'API SOCIETE.COM (30/10/2026, exclu du routing)
// ----------------------------------------------------------------------------
// Doc : https://api.societe.com/apisite/documentations/v1/documentation-api.html
// Jeton : variable d'environnement SOCIETE_API_TOKEN (Vercel). Societe.com attribue
// les crédits au jeton : vérifier le solde après tout changement de clé.
//
// Ce que la doc ne dit pas, mesuré le 30/10/2026 sur de vraies réponses :
//   · /infoclient et la LISTE des documents officiels ne coûtent aucun crédit ;
//   · un 404 (rien de publié, ex. pas de score) ne coûte rien non plus ;
//   · événements : 1 crédit (la page commerciale en annonce 2) ;
//   · le filtre d'IP n'est appliqué qu'aux bénéficiaires effectifs (403 « L'IP
//     … n'est pas autorisee ») : tout le reste passe sans IP déclarée ;
//   · /exist renvoie { common: {…} }, et « deno » vaut le SIREN quand la société
//     est non diffusible : le nom se prend dans l'annuaire, pas ici ;
//   · bilans : montants en euros sous forme de chaînes, dernierca = -1 si rien ;
//   · un document se télécharge en PDF brut (3,4 Mo pour de simples statuts).
//     Il passe donc par Firebase Storage : une réponse Vercel plafonne à 4,5 Mo.
// ============================================================================

const crypto = require('crypto');

const API_BASE = 'https://api.societe.com/api/v1';
const TIMEOUT_MS = 20000;
const TIMEOUT_DOC_MS = 45000;

/* Les boutons de la page admin. cout = crédits par appel (0,5 = 1/2 crédit) ;
   restreint = accès à faire ouvrir par Societe.com. */
const CATALOGUE = [
  { id: 'exist',                   label: 'Existence et statut',    ic: '✅', cout: 0.2 },
  { id: 'infoslegales',            label: 'Informations légales',   ic: '🏛️', cout: 0.5 },
  { id: 'etablissements',          label: 'Établissements',         ic: '🏢', cout: 0.5 },
  { id: 'scoring',                 label: 'Score',                  ic: '📊', cout: 0.5 },
  { id: 'contact',                 label: 'Contact',                ic: '📇', cout: 0.5 },
  { id: 'marques',                 label: 'Marques',                ic: '™️', cout: 0.5 },
  { id: 'evenements',              label: 'Événements',             ic: '🗓️', cout: 1 },
  { id: 'dirigeants',              label: 'Dirigeants',             ic: '👤', cout: 2 },
  { id: 'bilans',                  label: 'Bilans (chiffres)',      ic: '💶', cout: 2 },
  { id: 'procedurescollectives',   label: 'Procédures collectives', ic: '⚖️', cout: 2 },
  { id: 'beneficiaires-effectifs', label: 'Bénéficiaires effectifs', ic: '🧾', cout: 0, restreint: true },
];
const COUT_DOCUMENT = 5;
const COUT_MANDATS = 2;

/* exist + scoring + procédures + bilans. Le score peut ne rien coûter (404). */
const COUT_SOLVABILITE = 4.7;

const CATEGORIES_DOC = {
  actes: 'Actes et procès-verbaux',
  jalbodacc: 'Annonces JAL et BODACC',
  bilans: 'Bilans (PDF)',
  bilansxml: 'Bilans (CSV)',
};

function configure() { return !!process.env.SOCIETE_API_TOKEN; }

function erreur(code, status, detail) {
  const e = new Error(detail || code);
  e.code = code;
  e.status = status;
  return e;
}

function entetes() {
  return { 'X-Authorization': 'socapi ' + process.env.SOCIETE_API_TOKEN, 'Accept': 'application/json' };
}

async function requete(url, ms) {
  if (!configure()) throw erreur('non_configure', 503);
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, ms);
  try {
    return await fetch(url, { headers: entetes(), signal: controller.signal });
  } catch (e) {
    throw erreur('indisponible', 504, e && e.name === 'AbortError' ? 'Societe.com ne répond pas.' : 'Societe.com injoignable.');
  } finally {
    clearTimeout(timer);
  }
}

/* Traduit un statut HTTP d'erreur. 404 n'en est pas une : voir appel(). */
async function leverErreur(response) {
  const txt = await response.text().catch(function () { return ''; });
  let desc = '';
  try { desc = ((JSON.parse(txt) || {}).error || {}).desc || ''; } catch (e) {}
  if (response.status === 402) throw erreur('credits_epuises', 402, 'Plus de crédits Societe.com.');
  if (response.status === 401 || response.status === 403) throw erreur('acces_refuse', 403, desc || 'Accès refusé par Societe.com.');
  if (response.status === 429) throw erreur('trop_de_requetes', 429, 'Trop de requêtes d\'affilée. Réessaie dans quelques secondes.');
  if (response.status === 400) throw erreur('requete_invalide', 400, desc || 'Numéro refusé par Societe.com.');
  throw erreur('indisponible', 502, 'Societe.com : erreur ' + response.status + '.');
}

/* Retire l'enveloppe de version répétée dans chaque réponse. */
function nettoyer(o) {
  if (Array.isArray(o)) return o.map(nettoyer);
  if (!o || typeof o !== 'object') return o;
  const out = {};
  Object.keys(o).forEach(function (k) {
    if (/^(versioncourante|liendocversioncourante|derniereversion|liendocderniereversion)$/.test(k)) return;
    out[k] = nettoyer(o[k]);
  });
  return out;
}

/* → { vide:true } si Societe.com n'a rien (404, gratuit), sinon { data }. */
async function appel(chemin) {
  const response = await requete(API_BASE + chemin, TIMEOUT_MS);
  if (response.status === 404) return { vide: true, data: null };
  if (!response.ok) await leverErreur(response);
  const j = await response.json().catch(function () { return null; });
  if (!j) throw erreur('indisponible', 502, 'Réponse illisible de Societe.com.');
  return { vide: false, data: nettoyer(j.data !== undefined ? j.data : j) };
}

function sirenDe(numero) {
  const d = String(numero || '').replace(/\D/g, '');
  if (d.length !== 9 && d.length !== 14) throw erreur('siren_invalide', 400, 'SIREN (9 chiffres) ou SIRET (14 chiffres) attendu.');
  return d.slice(0, 9);
}

function element(id) {
  return CATALOGUE.filter(function (x) { return x.id === id; })[0] || null;
}

async function donnee(siren, id) {
  if (!element(id)) throw erreur('element_inconnu', 400);
  return appel('/entreprise/' + siren + '/' + id);
}

async function solde() {
  const r = await appel('/infoclient');
  const d = r.data || {};
  return { credits: Number(d.creditrestant), actif: d.compteactif !== false, gele: d.comptegele === true };
}

/* Un document se retrouve par son contenu : on ne suppose rien de la durée de
   vie de l'identifiant fourni par l'API. */
function cleDocument(doc) {
  return crypto.createHash('sha1')
    .update([doc.categorie, doc.titre, doc.date, doc.libelle].join('|'))
    .digest('hex').slice(0, 24);
}

function idDocument(doc) {
  const m = /\/documents-officiels\/([^/?#]+)\/download/.exec(String(doc.link || ''));
  const id = m ? m[1] : String(doc.id || '');
  if (!/^[\w.~-]+$/.test(id)) throw erreur('document_invalide', 400);
  return id;
}

/* Gratuit. Liste à plat, dans l'ordre des catégories de la doc. */
async function listeDocuments(siren) {
  const r = await appel('/entreprise/' + siren + '/documents-officiels');
  const groupes = (r.data && r.data.doc_officiel) || {};
  const out = [];
  Object.keys(groupes).forEach(function (categorie) {
    const liste = (groupes[categorie] && groupes[categorie].doc) || [];
    liste.forEach(function (d) {
      const doc = {
        categorie: categorie, categorieLabel: CATEGORIES_DOC[categorie] || categorie,
        titre: String(d.titre || ''), date: String(d.date || ''), libelle: String(d.libelle || ''),
        id: String(d.id || ''), link: String(d.link || ''),
      };
      doc.key = cleDocument(doc);
      out.push(doc);
    });
  });
  return out;
}

/* Le fichier lui-même : c'est ICI que partent les 5 crédits. */
async function telecharger(doc) {
  const url = API_BASE + '/documents-officiels/' + idDocument(doc) + '/download';
  const response = await requete(url, TIMEOUT_DOC_MS);
  if (response.status === 404) throw erreur('document_introuvable', 404, 'Document indisponible chez Societe.com.');
  if (!response.ok) await leverErreur(response);
  const type = String(response.headers.get('content-type') || 'application/octet-stream').split(';')[0].trim();
  const buffer = Buffer.from(await response.arrayBuffer());
  return { buffer: buffer, type: type, ext: type === 'application/pdf' ? 'pdf' : (/csv/.test(type) ? 'csv' : (/xml/.test(type) ? 'xml' : 'bin')) };
}

async function mandats(dirid) {
  if (!/^[\w.-]+$/.test(String(dirid || ''))) throw erreur('dirigeant_invalide', 400);
  return appel('/mandats/' + encodeURIComponent(dirid));
}

module.exports = {
  CATALOGUE, COUT_DOCUMENT, COUT_MANDATS, COUT_SOLVABILITE,
  configure, sirenDe, element, donnee, solde, appel,
  listeDocuments, cleDocument, telecharger, mandats, erreur,
};
