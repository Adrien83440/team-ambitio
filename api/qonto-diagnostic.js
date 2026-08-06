// ============================================================================
// api/qonto-diagnostic.js — TEST DE CONNEXION QONTO
// ----------------------------------------------------------------------------
// GET /api/qonto-diagnostic         (admin uniquement)
//   → 200 {
//        ok, env, organizationName, organizationSlug,
//        bankAccounts: [{ name, iban, status }],
//        ibanConfigured, ibanBelongsToOrg,
//        einvoicing: { ... } | null, einvoicingError: string | null,
//        checks: [{ key, label, status, detail }]
//     }
//
// Alimente le bouton « Tester la connexion » de l'onglet Paramètres. Lecture
// seule côté Qonto : aucune facture, aucun client n'est créé. La seule écriture
// est la trace du diagnostic dans _config/qonto.
//
// Pourquoi vérifier l'IBAN : payment_methods.iban DOIT désigner un compte de
// l'organisation. Un IBAN étranger à l'organisation ne casse rien ici, mais
// ferait échouer toutes les créations de facture — autant le voir maintenant.
// ============================================================================

const { admin, db, requireAuth, sendError, setCors } = require('./_billing-helpers');
const qonto = require('./_qonto-client');

function normIban(v) {
  return String(v || '').replace(/\s+/g, '').toUpperCase();
}

function maskIban(v) {
  const s = normIban(v);
  if (s.length < 8) return s;
  return s.substring(0, 4) + '…' + s.substring(s.length - 4);
}

module.exports = async function (req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  try {
    if (req.method !== 'GET') {
      const e = new Error('Méthode non autorisée'); e.status = 405; throw e;
    }
    await requireAuth(req, ['admin']);

    const checks = [];
    const result = {
      ok: false,
      env: qonto.isSandbox() ? 'sandbox' : 'production',
      baseUrl: qonto.baseUrl(),
      organizationName: null,
      organizationSlug: null,
      bankAccounts: [],
      ibanConfigured: null,
      ibanBelongsToOrg: null,
      einvoicing: null,
      einvoicingError: null,
      checks: checks,
    };

    /* ── 1. Variables d'environnement ── */
    if (!qonto.isConfigured()) {
      checks.push({
        key: 'env', label: 'Variables d\'environnement', status: 'error',
        detail: 'Manquantes : ' + qonto.missingConfig().join(', '),
      });
      result.error = 'Configuration incomplète — ajoutez les variables dans Vercel puis redéployez.';
      res.status(200).json(result);
      return;
    }
    checks.push({
      key: 'env', label: 'Variables d\'environnement', status: 'ok',
      detail: 'Environnement : ' + result.env,
    });

    /* ── 2. Organisation ── */
    const org = await qonto.qontoFetch('GET', '/v2/organization');
    const orgData = (org && org.organization) ? org.organization : (org || {});
    result.organizationSlug = orgData.slug || null;
    result.organizationName = orgData.legal_name || orgData.name || orgData.slug || null;

    const accounts = Array.isArray(orgData.bank_accounts) ? orgData.bank_accounts : [];
    for (let i = 0; i < accounts.length; i++) {
      const a = accounts[i] || {};
      result.bankAccounts.push({
        name: a.name || a.slug || 'Compte',
        iban: maskIban(a.iban),
        ibanFull: normIban(a.iban),
        status: a.status || null,
      });
    }
    checks.push({
      key: 'org', label: 'Connexion à l\'organisation', status: 'ok',
      detail: (result.organizationName || 'Organisation') + ' — ' + accounts.length + ' compte(s)',
    });

    /* ── 3. IBAN configuré ── */
    let cfg = {};
    try {
      const cfgSnap = await db.collection('_config').doc('qonto').get();
      cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
    } catch (cfgErr) {
      console.error('[qonto-diagnostic] lecture _config/qonto:', cfgErr && cfgErr.message);
    }

    const wanted = normIban(cfg.iban);
    result.ibanConfigured = wanted ? maskIban(wanted) : null;
    if (!wanted) {
      result.ibanBelongsToOrg = null;
      checks.push({
        key: 'iban', label: 'IBAN de règlement', status: 'warn',
        detail: 'Aucun IBAN renseigné — à choisir dans la liste ci-dessous.',
      });
    } else {
      let found = false;
      for (let i = 0; i < result.bankAccounts.length; i++) {
        if (result.bankAccounts[i].ibanFull === wanted) { found = true; break; }
      }
      result.ibanBelongsToOrg = found;
      checks.push({
        key: 'iban', label: 'IBAN de règlement', status: found ? 'ok' : 'error',
        detail: found
          ? (maskIban(wanted) + ' appartient bien à l\'organisation')
          : (maskIban(wanted) + ' ne correspond à aucun compte de l\'organisation — toutes les créations de facture échoueraient.'),
      });
    }

    /* ── 4. Réglages e-invoicing (scope einvoicing.read) ── */
    try {
      const ei = await qonto.qontoFetch('GET', '/v2/einvoicing/settings');
      result.einvoicing = (ei && ei.einvoicing_settings) ? ei.einvoicing_settings : ei;
      checks.push({
        key: 'einvoicing', label: 'Facturation électronique', status: 'ok',
        detail: 'Réglages lus depuis Qonto',
      });
    } catch (eiErr) {
      /* Absence du scope ou fonctionnalité non activée : on n'échoue pas le
         diagnostic, on le signale. C'est précisément ce que ce bouton doit
         rendre visible avant la bascule. */
      result.einvoicingError = String((eiErr && eiErr.message) || eiErr).substring(0, 300);
      checks.push({
        key: 'einvoicing', label: 'Facturation électronique', status: 'warn',
        detail: result.einvoicingError,
      });
    }

    let hasError = false;
    for (let i = 0; i < checks.length; i++) { if (checks[i].status === 'error') hasError = true; }
    result.ok = !hasError;

    /* ── 5. Trace ── */
    try {
      await db.collection('_config').doc('qonto').set({
        lastDiagnosticAt: admin.firestore.FieldValue.serverTimestamp(),
        lastDiagnosticResult: {
          ok: result.ok,
          env: result.env,
          organizationName: result.organizationName,
          ibanBelongsToOrg: result.ibanBelongsToOrg,
          einvoicingError: result.einvoicingError,
        },
      }, { merge: true });
    } catch (traceErr) {
      console.error('[qonto-diagnostic] trace:', traceErr && traceErr.message);
    }

    /* ibanFull ne sort pas de l'API : la page n'en a pas besoin et un IBAN
       complet n'a rien à faire dans une réponse HTTP de confort. */
    for (let i = 0; i < result.bankAccounts.length; i++) delete result.bankAccounts[i].ibanFull;

    res.status(200).json(result);
  } catch (err) {
    sendError(res, err);
  }
};
