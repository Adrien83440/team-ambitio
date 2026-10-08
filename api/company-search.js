// ============================================================================
// api/company-search.js — RECHERCHE D'ENTREPRISES (API DINUM)
// ----------------------------------------------------------------------------
// GET /api/company-search?q=<SIRET | SIREN | raison sociale>   (admin)
//   → 200 { results: [{ siren, siret, name, legalForm, legalFormLabel, naf,
//                       nafLabel, vatNumber, address:{line1,line2,postalCode,
//                       city,country}, addressHidden, dirigeants, active,
//                       closed }] }
//
// Source : https://recherche-entreprises.api.gouv.fr — API publique de la
// DINUM, gratuite, sans clé, sans quota contractuel (≈ 7 req/s). Elle sert de
// remplissage automatique des fiches clients : on saisit un SIRET, on obtient
// raison sociale, forme juridique, adresse et numéro de TVA.
//
// La normalisation vit dans api/_companyLookup.js, partagée avec la page de
// signature (api/sign-session.js). Cet endpoint-ci reste réservé aux admins,
// comme tout le module facturation.
//
// Aucune écriture : cet endpoint est en lecture seule. C'est l'utilisateur qui
// décide d'appliquer le résultat à la fiche.
// ============================================================================

const { requireAuth, sendError, setCors } = require('./_billing-helpers');
const { searchCompanies } = require('./_companyLookup');

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'GET') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    await requireAuth(req, ['admin']);

    const q = String((req.query && req.query.q) || '').trim();
    const r = await searchCompanies(q, 10);
    res.status(200).json({ results: r.results, total: r.total, query: r.query });
  } catch (err) {
    sendError(res, err);
  }
};
