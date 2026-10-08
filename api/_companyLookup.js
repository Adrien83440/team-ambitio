// ============================================================================
// api/_companyLookup.js — ANNUAIRE DES ENTREPRISES (API DINUM), PARTAGÉ
// ----------------------------------------------------------------------------
// Extrait de api/company-search.js (facturation, admin) pour servir aussi la
// page de signature publique (api/sign-session.js, action « company »).
// Un seul endroit normalise la réponse de recherche-entreprises.api.gouv.fr :
// un changement de l'API amont ne casse qu'un fichier.
//
// Source : https://recherche-entreprises.api.gouv.fr — publique, gratuite,
// sans clé (≈ 7 req/s).
// ============================================================================

const API_BASE = 'https://recherche-entreprises.api.gouv.fr/search';
const SOURCE_LABEL = 'Annuaire des entreprises (recherche-entreprises.api.gouv.fr — données SIRENE / RNE)';
const TIMEOUT_MS = 12000;

/* Clé de TVA intracommunautaire française : FR + clé + SIREN, avec
   clé = (12 + 3 × (SIREN mod 97)) mod 97, sur deux chiffres. */
function vatFromSiren(siren) {
  const s = String(siren || '').replace(/\D/g, '');
  if (s.length !== 9) return '';
  const key = (12 + 3 * (Number(s) % 97)) % 97;
  return 'FR' + String(key).padStart(2, '0') + s;
}

/* L'INSEE masque les données des entreprises ayant refusé la diffusion
   publique : les champs valent littéralement « [NON-DIFFUSIBLE] ». */
function clean(value) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  if (!s) return '';
  if (s.toUpperCase().indexOf('NON-DIFFUSIBLE') >= 0) return '';
  return s;
}

/* Contrôle de Luhn : SIREN (9) et SIRET (14). Exception connue : les
   établissements de La Poste (SIREN 356000000) ne respectent pas Luhn sur le
   SIRET — la somme des chiffres est alors un multiple de 5. */
function luhnOk(digits) {
  const d = String(digits || '');
  if (!/^\d+$/.test(d)) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = Number(d.charAt(d.length - 1 - i));
    if (i % 2 === 1) { n *= 2; if (n > 9) n -= 9; }
    sum += n;
  }
  return sum % 10 === 0;
}
function sirenValid(siren) {
  const s = String(siren || '').replace(/\D/g, '');
  return s.length === 9 && luhnOk(s);
}
function siretValid(siret) {
  const s = String(siret || '').replace(/\D/g, '');
  if (s.length !== 14) return false;
  if (s.slice(0, 9) === '356000000') {
    let sum = 0; for (let i = 0; i < 14; i++) sum += Number(s.charAt(i));
    return sum % 5 === 0;
  }
  return luhnOk(s) && sirenValid(s.slice(0, 9));
}

/* Catégories juridiques INSEE (niveau III) les plus courantes. Au-delà, on
   retombe sur la famille (deux premiers chiffres) : jamais un code nu. */
const LEGAL_FORMS = {
  '1000': 'Entrepreneur individuel',
  '5202': 'SNC', '5306': 'SCS', '5308': 'SCA',
  '5385': 'SELCA',
  '5410': 'SARL', '5422': 'SARL immobilière de gestion', '5426': 'SARL immobilière',
  '5458': 'SCOP SARL', '5460': 'SARL coopérative',
  '5470': 'SPFPL SARL', '5485': 'SELARL',
  '5498': 'EURL', '5499': 'SARL',
  '5505': 'SA', '5510': 'SA', '5515': 'SA', '5520': 'SA', '5522': 'SA', '5525': 'SA',
  '5530': 'SA', '5531': 'SA', '5532': 'SA', '5542': 'SA', '5543': 'SA', '5546': 'SA',
  '5547': 'SA', '5551': 'SA', '5552': 'SA', '5553': 'SA', '5554': 'SA', '5555': 'SA',
  '5558': 'SA coopérative', '5559': 'SA', '5560': 'SA', '5585': 'SELAFA', '5599': 'SA',
  '5605': 'SA à directoire', '5699': 'SA à directoire', '5685': 'SELAFA',
  '5710': 'SAS', '5720': 'SASU', '5770': 'SPFPL SAS', '5785': 'SELAS', '5800': 'Société européenne',
  '6540': 'SCI', '6541': 'SCI', '6542': 'SCI', '6543': 'SCI', '6544': 'SCI',
  '6551': 'SCI', '6554': 'SCI', '6558': 'SCI', '6560': 'SCI',
  '6561': 'SCP', '6562': 'SCP', '6563': 'SCP', '6564': 'SCP', '6565': 'SCP',
  '6566': 'SCP', '6567': 'SCP', '6568': 'SCP', '6569': 'SCP',
  '6585': 'SEL', '6588': 'Société civile', '6589': 'Société civile de moyens',
  '6595': 'Caisse de crédit mutuel', '6596': 'Caisse de crédit agricole',
  '6597': 'Société civile d\'exploitation agricole', '6598': 'EARL', '6599': 'Société civile',
  '9210': 'Association', '9220': 'Association déclarée', '9221': 'Association déclarée',
  '9222': 'Association intermédiaire', '9230': 'Association reconnue d\'utilité publique',
};
const LEGAL_FAMILIES = {
  '10': 'Entrepreneur individuel', '52': 'Société en nom collectif', '53': 'Société en commandite',
  '54': 'SARL', '55': 'SA', '56': 'SA à directoire', '57': 'SAS', '58': 'Société européenne',
  '65': 'Société civile', '92': 'Association', '63': 'Société coopérative agricole',
};
function legalFormLabel(code) {
  const c = String(code || '');
  if (LEGAL_FORMS[c]) return LEGAL_FORMS[c];
  if (LEGAL_FAMILIES[c.slice(0, 2)]) return LEGAL_FAMILIES[c.slice(0, 2)];
  return c ? ('Forme juridique ' + c) : '';
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
    const cp = clean(siege.code_postal);
    const ville = clean(siege.libelle_commune);
    if (cp) street = street.split(cp).join('');
    if (ville) street = street.replace(new RegExp(ville.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '');
    street = street.replace(/\s{2,}/g, ' ').trim().replace(/[,\s]+$/, '');
  }
  return street;
}

/* Dirigeants publiés. Une personne physique masquée par l'INSEE reste
   comptée (on garde sa qualité) mais sans nom : l'écran ne peut alors rien
   proposer, et le dossier de preuve dit « non diffusible » au lieu de
   « absent ». */
function normalizeDirigeants(list) {
  return (Array.isArray(list) ? list : []).map(function (d) {
    d = d || {};
    const morale = String(d.type_dirigeant || '').indexOf('morale') >= 0;
    return {
      type: morale ? 'morale' : 'physique',
      prenoms: morale ? '' : clean(d.prenoms),
      nom: morale ? '' : clean(d.nom),
      denomination: morale ? clean(d.denomination) : '',
      qualite: clean(d.qualite),
      masque: !morale && !clean(d.nom),
    };
  }).slice(0, 12);
}

function normalize(entry) {
  entry = entry || {};
  const siege = entry.siege || {};
  const name = clean(entry.nom_raison_sociale) || clean(entry.nom_complet) || '';
  const etat = String(siege.etat_administratif || entry.etat_administratif || '').toUpperCase();
  const address = {
    line1: buildStreet(siege),
    line2: clean(siege.complement_adresse),
    postalCode: clean(siege.code_postal),
    city: clean(siege.libelle_commune),
    country: 'France',
  };

  return {
    siren: String(entry.siren || ''),
    siret: String(siege.siret || ''),
    name: String(name).trim(),
    legalForm: String(entry.nature_juridique || ''),
    legalFormLabel: legalFormLabel(entry.nature_juridique),
    naf: String(entry.activite_principale || ''),
    nafLabel: String(entry.libelle_activite_principale || ''),
    vatNumber: vatFromSiren(entry.siren),
    creationDate: clean(entry.date_creation),
    address: address,
    /* Vrai quand l'INSEE masque l'adresse : l'écran doit alors demander une
       saisie manuelle au lieu de laisser croire que le remplissage a marché. */
    addressHidden: !clean(siege.code_postal) && !buildStreet(siege),
    dirigeants: normalizeDirigeants(entry.dirigeants),
    active: etat !== 'C',
    closed: etat === 'C',
  };
}

/* Adresse sur une ligne, telle qu'elle s'imprime dans le contrat. */
function addressLine(a) {
  a = a || {};
  const l1 = [a.line1, a.line2].filter(Boolean).join(', ');
  const l2 = [a.postalCode, a.city].filter(Boolean).join(' ');
  return [l1, l2].filter(Boolean).join(', ');
}

/* Recherche brute. Lève une Error portant .status (400/429/502/504). */
async function searchCompanies(q, perPage) {
  q = String(q || '').trim();
  if (q.length < 3) {
    const e = new Error('Saisissez au moins 3 caractères (ou un SIRET / SIREN).'); e.status = 400; throw e;
  }
  const digits = q.replace(/\D/g, '');
  const isIdentifier = (digits.length === 9 || digits.length === 14) && digits.length === q.replace(/\s/g, '').length;
  const term = isIdentifier ? digits : q;
  const url = API_BASE + '?q=' + encodeURIComponent(term) + '&page=1&per_page=' + (perPage || 10);

  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);
  let response;
  try {
    response = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: controller.signal });
  } catch (netErr) {
    clearTimeout(timer);
    const e = new Error(netErr && netErr.name === 'AbortError'
      ? 'L\'annuaire des entreprises ne répond pas. Réessayez dans un instant.'
      : 'Annuaire des entreprises injoignable.');
    e.status = 504;
    throw e;
  }
  clearTimeout(timer);

  if (response.status === 429) {
    const e = new Error('Trop de recherches d\'affilée. Patientez quelques secondes.'); e.status = 429; throw e;
  }
  if (!response.ok) {
    const txt = await response.text().catch(function () { return ''; });
    const e = new Error('Annuaire des entreprises : erreur ' + response.status + ' ' + txt.substring(0, 200));
    e.status = 502;
    throw e;
  }
  const data = await response.json();
  const list = Array.isArray(data.results) ? data.results : [];
  return { results: list.map(normalize), total: data.total_results || list.length, query: term, isIdentifier: isIdentifier };
}

/* L'entreprise exacte derrière un SIRET ou un SIREN, ou null. Le SIRET
   retourné est celui saisi s'il appartient bien à l'entreprise trouvée,
   sinon celui du siège. */
async function lookupByIdentifier(ident) {
  const digits = String(ident || '').replace(/\D/g, '');
  if (digits.length !== 9 && digits.length !== 14) return null;
  const r = await searchCompanies(digits, 5);
  const siren = digits.slice(0, 9);
  const hit = r.results.find(function (x) { return x.siren === siren; });
  if (!hit) return null;
  if (digits.length === 14 && hit.siret !== digits) hit.siretSaisi = digits;
  return hit;
}

module.exports = {
  SOURCE_LABEL,
  vatFromSiren, clean, luhnOk, sirenValid, siretValid,
  legalFormLabel, normalize, addressLine,
  searchCompanies, lookupByIdentifier,
};
