// ============================================================================
// api/company-search.js — RECHERCHE D'ENTREPRISES (API DINUM)
// ----------------------------------------------------------------------------
// GET /api/company-search?q=<SIRET | SIREN | raison sociale>   (admin)
//   → 200 { results: [{ siren, siret, name, legalForm, naf, nafLabel,
//                       vatNumber, address:{line1,postalCode,city,country},
//                       active, closed }] }
//
// Source : https://recherche-entreprises.api.gouv.fr — API publique de la
// DINUM, gratuite, sans clé, sans quota contractuel (≈ 7 req/s). Elle sert de
// remplissage automatique des fiches clients : on saisit un SIRET, on obtient
// raison sociale, forme juridique, adresse et numéro de TVA.
//
// POURQUOI PASSER PAR LE SERVEUR plutôt que d'appeler l'API depuis le
// navigateur : on garde l'endpoint réservé aux admins (comme tout le module
// facturation), on normalise la réponse une seule fois, et un changement de
// l'API amont ne casse qu'un fichier.
//
// Aucune écriture : cet endpoint est en lecture seule. C'est l'utilisateur qui
// décide d'appliquer le résultat à la fiche.
// ============================================================================

const { requireAuth, sendError, setCors } = require('./_billing-helpers');

const API_BASE = 'https://recherche-entreprises.api.gouv.fr/search';
const TIMEOUT_MS = 12000;

/* Clé de TVA intracommunautaire française : FR + clé + SIREN, avec
   clé = (12 + 3 × (SIREN mod 97)) mod 97, sur deux chiffres. Formule
   officielle et déterministe — autant remplir le champ automatiquement. */
function vatFromSiren(siren) {
  const s = String(siren || '').replace(/\D/g, '');
  if (s.length !== 9) return '';
  const key = (12 + 3 * (Number(s) % 97)) % 97;
  return 'FR' + String(key).padStart(2, '0') + s;
}

/* L'API renvoie une adresse déjà composée, mais elle inclut le code postal et
   la commune — qu'on stocke séparément. On reconstruit donc la voie à partir
   des composants, et on retombe sur l'adresse complète nettoyée si besoin. */
/* L'INSEE masque les données des entreprises ayant refusé la diffusion
   publique : les champs valent littéralement « [NON-DIFFUSIBLE] ». Sans ce
   filtre, on remplirait les fiches clients avec ce texte. */
function clean(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  if (s.toUpperCase().indexOf('NON-DIFFUSIBLE') >= 0) return '';
  return s;
}

function buildStreet(siege) {
  siege = siege || {};
  const parts = [];
  if (clean(siege.numero_voie)) parts.push(clean(siege.numero_voie));
  if (clean(siege.indice_repetition)) parts.push(clean(siege.indice_repetition));
  if (clean(siege.type_voie)) parts.push(clean(siege.type_voie));
  if (clean(siege.libelle_voie)) parts.push(clean(siege.libelle_voie));
  let street = parts.join(' ').trim();

  if (!street && clean(siege.adresse)) {
    street = clean(siege.adresse);
    /* On retire code postal + commune de la chaîne complète pour ne garder
       que la voie, sinon l'adresse serait dupliquée dans la fiche. */
    const cp = clean(siege.code_postal);
    const ville = clean(siege.libelle_commune);
    if (cp) street = street.split(cp).join('');
    if (ville) street = street.replace(new RegExp(ville.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    street = street.replace(/\s{2,}/g, ' ').trim().replace(/[,\s]+$/, '');
  }
  return street;
}

function normalize(entry) {
  entry = entry || {};
  const siege = entry.siege || {};
  const name = clean(entry.nom_raison_sociale) || clean(entry.nom_complet) || '';
  const etat = String(siege.etat_administratif || entry.etat_administratif || '').toUpperCase();

  return {
    siren: String(entry.siren || ''),
    siret: String(siege.siret || ''),
    name: String(name).trim(),
    legalForm: String(entry.nature_juridique || ''),
    naf: String(entry.activite_principale || ''),
    nafLabel: String(entry.libelle_activite_principale || ''),
    vatNumber: vatFromSiren(entry.siren),
    address: {
      line1: buildStreet(siege),
      line2: clean(siege.complement_adresse),
      postalCode: clean(siege.code_postal),
      city: clean(siege.libelle_commune),
      country: 'France',
    },
    /* Vrai quand l'INSEE masque l'adresse : l'écran doit alors demander une
       saisie manuelle au lieu de laisser croire que le remplissage a marché. */
    addressHidden: !clean(siege.code_postal) && !buildStreet(siege),
    /* « C » = cessée. On l'affiche au lieu de masquer : un client peut avoir
       été facturé avant la radiation, et cacher l'info induirait en erreur. */
    active: etat !== 'C',
    closed: etat === 'C',
  };
}

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'GET') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    await requireAuth(req, ['admin']);

    const q = String((req.query && req.query.q) || '').trim();
    if (q.length < 3) {
      const e = new Error('Saisis au moins 3 caractères (ou un SIRET / SIREN).'); e.status = 400; throw e;
    }

    /* Un SIREN/SIRET est cherché tel quel, sans espaces : l'API n'accepte pas
       les groupes « 123 456 789 » copiés depuis un document. */
    const digits = q.replace(/\D/g, '');
    const isIdentifier = (digits.length === 9 || digits.length === 14) && digits.length === q.replace(/\s/g, '').length;
    const term = isIdentifier ? digits : q;

    const url = API_BASE + '?q=' + encodeURIComponent(term) + '&page=1&per_page=10';

    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
    } catch (netErr) {
      clearTimeout(timer);
      const e = new Error(
        netErr && netErr.name === 'AbortError'
          ? 'L\'annuaire des entreprises ne répond pas. Réessaie dans un instant.'
          : 'Annuaire des entreprises injoignable.'
      );
      e.status = 504;
      throw e;
    }
    clearTimeout(timer);

    if (response.status === 429) {
      const e = new Error('Trop de recherches d\'affilée. Attends quelques secondes.'); e.status = 429; throw e;
    }
    if (!response.ok) {
      const txt = await response.text().catch(function () { return ''; });
      const e = new Error('Annuaire des entreprises : erreur ' + response.status + ' ' + txt.substring(0, 200));
      e.status = 502;
      throw e;
    }

    const data = await response.json();
    const list = Array.isArray(data.results) ? data.results : [];
    const results = [];
    for (let i = 0; i < list.length; i++) results.push(normalize(list[i]));

    res.status(200).json({ results: results, total: data.total_results || results.length, query: term });
  } catch (err) {
    sendError(res, err);
  }
};
