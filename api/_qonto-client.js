// ============================================================================
// api/_qonto-client.js — CLIENT HTTP QONTO + MAPPERS
// ----------------------------------------------------------------------------
// Helper partagé, préfixé « _ » : hors routing Vercel, jamais appelable en HTTP.
//
// Qonto est immatriculée Plateforme Agréée PA-0025. Pour une organisation
// française, les factures créées via l'API sont générées au format Factur-X.
//
// AUTHENTIFICATION — piège classique
// ----------------------------------
// Le header vaut littéralement « login:secret ». Ce n'est PAS du Basic Auth :
// aucun encodage base64, aucun préfixe Bearer. Toute « correction » vers du
// Basic Auth casse l'appel avec un 401 peu bavard.
//
// SECRETS
// -------
// Les identifiants sont des accès bancaires : variables d'environnement Vercel
// uniquement (QONTO_LOGIN, QONTO_SECRET_KEY, QONTO_ENV, QONTO_STAGING_TOKEN).
// Jamais dans Firestore, jamais dans le repo. Les réglages NON secrets vivent
// dans _config/qonto.
//
// Convention d'erreur du dossier billing : e.status = 4xx/5xx puis throw.
// ============================================================================

const PROD_BASE = 'https://thirdparty.qonto.com';
const SANDBOX_BASE = 'https://thirdparty-sandbox.staging.qonto.co';

/* Rate limits Qonto : 1 000 req / 10 s et 10 000 / 10 min par IP. On est à
   ~100 factures par mois, donc très loin du plafond — mais un 429 doit être
   absorbé proprement plutôt que remonté comme un échec de facturation. */
const MAX_RETRIES = 3;
const TIMEOUT_MS = 20000;

function env(name) {
  const v = process.env[name];
  return (typeof v === 'string' && v.trim()) ? v.trim() : '';
}

function isSandbox() {
  return env('QONTO_ENV').toLowerCase() !== 'production';
}

function baseUrl() {
  return isSandbox() ? SANDBOX_BASE : PROD_BASE;
}

/* Vrai seulement si TOUT est présent. Utilisé par le diagnostic et par les
   appelants pour retomber proprement sur le chemin legacy. */
function isConfigured() {
  if (!env('QONTO_LOGIN') || !env('QONTO_SECRET_KEY')) return false;
  if (isSandbox() && !env('QONTO_STAGING_TOKEN')) return false;
  return true;
}

function missingConfig() {
  const miss = [];
  if (!env('QONTO_LOGIN')) miss.push('QONTO_LOGIN');
  if (!env('QONTO_SECRET_KEY')) miss.push('QONTO_SECRET_KEY');
  if (isSandbox() && !env('QONTO_STAGING_TOKEN')) miss.push('QONTO_STAGING_TOKEN');
  return miss;
}

function authHeaders() {
  const h = {
    /* Littéral « login:secret » — surtout pas de base64 ni de Bearer. */
    'Authorization': env('QONTO_LOGIN') + ':' + env('QONTO_SECRET_KEY'),
    'Accept': 'application/json',
  };
  if (isSandbox()) h['X-Qonto-Staging-Token'] = env('QONTO_STAGING_TOKEN');
  return h;
}

/* Format d'erreur Qonto : { errors: [{ code, detail, source: { pointer } }] }.
   On en tire un message lisible dans un toast, avec le champ fautif quand il
   est fourni — c'est ce qui fait gagner du temps sur les 422. */
function describeQontoError(payload, status) {
  if (!payload || typeof payload !== 'object') return 'Erreur Qonto ' + status;
  const errs = Array.isArray(payload.errors) ? payload.errors : [];
  if (!errs.length) {
    if (payload.message) return String(payload.message);
    return 'Erreur Qonto ' + status;
  }
  const parts = [];
  for (let i = 0; i < errs.length && i < 4; i++) {
    const e = errs[i] || {};
    const ptr = e.source && e.source.pointer ? String(e.source.pointer).replace(/^\/data\/attributes\//, '') : '';
    const txt = e.detail || e.title || e.code || 'erreur';
    parts.push(ptr ? (ptr + ' : ' + txt) : String(txt));
  }
  return parts.join(' · ');
}

function firstErrorCode(payload) {
  if (!payload || !Array.isArray(payload.errors) || !payload.errors.length) return null;
  return payload.errors[0].code || null;
}

function sleep(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}

/**
 * Appel HTTP Qonto.
 *
 * @param {string} method  GET | POST | PATCH
 * @param {string} path    ex. '/v2/organization'
 * @param {Object} body    corps JSON (optionnel)
 * @param {Object} opts    { raw: true } pour récupérer un Buffer (PDF)
 * @returns {Promise<Object|Buffer>}
 */
async function qontoFetch(method, path, body, opts) {
  opts = opts || {};
  if (!isConfigured()) {
    const e = new Error('Qonto non configuré — variables manquantes : ' + missingConfig().join(', '));
    e.status = 500;
    throw e;
  }

  const url = baseUrl() + path;
  const headers = authHeaders();
  if (body) headers['Content-Type'] = 'application/json';

  let lastErr = null;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    /* Un appel qui traîne bloquerait la fonction Vercel jusqu'au timeout
       global : on coupe nous-mêmes pour garder la main sur l'erreur. */
    const controller = new AbortController();
    const timer = setTimeout(function () { controller.abort(); }, TIMEOUT_MS);

    let response;
    try {
      response = await fetch(url, {
        method: method,
        headers: headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (netErr) {
      clearTimeout(timer);
      lastErr = new Error(
        netErr && netErr.name === 'AbortError'
          ? ('Qonto n\'a pas répondu en moins de ' + (TIMEOUT_MS / 1000) + ' s (' + method + ' ' + path + ')')
          : ('Réseau indisponible vers Qonto : ' + ((netErr && netErr.message) || 'inconnu'))
      );
      lastErr.status = 504;
      /* Un timeout sur un POST peut avoir ABOUTI côté Qonto. On ne rejoue
         donc jamais automatiquement une écriture — seul un GET est rejouable. */
      if (method !== 'GET' || attempt === MAX_RETRIES - 1) throw lastErr;
      await sleep(1000 * Math.pow(2, attempt));
      continue;
    }
    clearTimeout(timer);

    if (response.status === 429) {
      const retryAfter = parseInt(response.headers.get('retry-after') || '0', 10);
      const waitMs = retryAfter > 0 ? (retryAfter * 1000) : (1000 * Math.pow(2, attempt));
      if (attempt === MAX_RETRIES - 1) {
        const e = new Error('Qonto sature (429) après ' + MAX_RETRIES + ' tentatives.');
        e.status = 429;
        throw e;
      }
      await sleep(waitMs);
      continue;
    }

    if (opts.raw) {
      if (!response.ok) {
        const txt = await response.text().catch(function () { return ''; });
        const e = new Error('Téléchargement Qonto échoué (' + response.status + ') : ' + txt.substring(0, 300));
        e.status = response.status;
        throw e;
      }
      const arrayBuf = await response.arrayBuffer();
      return Buffer.from(arrayBuf);
    }

    let payload = null;
    const text = await response.text().catch(function () { return ''; });
    if (text) { try { payload = JSON.parse(text); } catch (parseErr) { payload = null; } }

    if (!response.ok) {
      const e = new Error(describeQontoError(payload, response.status));
      e.status = response.status;
      e.qontoCode = firstErrorCode(payload);
      e.qontoPayload = payload;
      throw e;
    }

    return payload || {};
  }

  throw lastErr || new Error('Appel Qonto impossible');
}

// ═══════════════════════════════════════════════════════════════════════════
// MAPPERS
// ═══════════════════════════════════════════════════════════════════════════

/* Tous les montants Qonto sont des chaînes, séparateur décimal « . ». */
function moneyStr(value) {
  const n = Number(value);
  return (isFinite(n) ? n : 0).toFixed(2);
}

/* Nos lignes portent vatRate en POURCENTAGE (20), Qonto attend un décimal
   ("0.2"). Le repli sur 20 reproduit celui de _billing-pdf.js : sans lui, une
   ligne sans taux serait facturée à 0 % chez Qonto et à 20 % sur le PDF. */
function vatRateToDecimal(vatRate) {
  const n = (vatRate === null || vatRate === undefined || vatRate === '') ? 20 : Number(vatRate);
  const safe = isFinite(n) ? n : 20;
  return String(Math.round(safe * 100) / 10000);
}

/* Codes EN16931 attendus par Qonto. Nos lignes stockent un libellé français
   libre (« mois »), d'où la table de correspondance. */
const UNIT_MAP = {
  'mois': 'month', 'month': 'month',
  'heure': 'hour', 'heures': 'hour', 'hour': 'hour', 'h': 'hour',
  'jour': 'day', 'jours': 'day', 'day': 'day', 'j': 'day',
  'semaine': 'week', 'semaines': 'week', 'week': 'week',
  'an': 'year', 'annee': 'year', 'année': 'year', 'ans': 'year', 'year': 'year',
  'unite': 'unit', 'unité': 'unit', 'unites': 'unit', 'unités': 'unit', 'unit': 'unit',
};

function mapUnit(unit) {
  const key = String(unit || '').trim().toLowerCase();
  if (!key) return 'unit';
  return UNIT_MAP[key] || 'unit';
}

/* items.title est OBLIGATOIRE et plafonné à 40 caractères. Nos lignes ont un
   productName parfois vide et une description longue : on compose, puis on
   coupe sur un mot entier pour ne pas produire « Accompagnement Elite Ph ». */
function buildItemTitle(line) {
  line = line || {};
  let base = String(line.productName || '').trim();
  const variant = String(line.variantLabel || '').trim();
  if (base && variant) base = base + ' ' + variant;
  if (!base) base = String(line.description || '').trim();
  if (!base) base = 'Prestation';

  base = base.replace(/\s+/g, ' ').trim();
  if (base.length <= 40) return base;

  const cut = base.substring(0, 40);
  const lastSpace = cut.lastIndexOf(' ');
  /* On ne coupe sur l'espace que s'il reste un titre lisible. */
  if (lastSpace >= 20) return cut.substring(0, lastSpace).trim();
  return cut.trim();
}

function truncate(value, max) {
  const s = String(value === null || value === undefined ? '' : value).trim();
  return s.length > max ? s.substring(0, max) : s;
}

/**
 * invoice_clients/{id} → payload client Qonto.
 * street_address concatène line1 et line2 : Qonto n'a qu'un champ.
 */
function mapClientToQonto(client) {
  client = client || {};
  const addr = client.address || {};
  const line1 = String(addr.line1 || '').trim();
  const line2 = String(addr.line2 || '').trim();
  const street = truncate(line1 + (line2 ? (', ' + line2) : ''), 250);

  /* Le champ s'appelle « kind » côté Qonto, PAS « type ». Avec « type », l'API
     répond « Client.kind failed on the required tag », et enchaîne sur des
     erreurs en cascade pour name / first_name / last_name : sans kind, elle ne
     sait pas lesquels sont obligatoires. Le message n'est pas explicite, la
     cause est unique. */
  const payload = {
    kind: client.clientType === 'individual' ? 'individual' : 'company',
    email: String(client.email || '').trim(),
    currency: 'EUR',
    locale: 'fr',
  };

  if (payload.kind === 'company') {
    payload.name = truncate(client.companyName || '', 250);
  } else {
    payload.first_name = truncate(client.contactFirstName || '', 100);
    payload.last_name = truncate(client.contactLastName || '', 100);
  }

  if (client.vatNumber) payload.vat_number = truncate(client.vatNumber, 30);
  if (client.siret) payload.tax_identification_number = truncate(client.siret, 30);

  payload.billing_address = {
    street_address: street,
    city: truncate(addr.city || '', 100),
    zip_code: truncate(addr.postalCode || '', 20),
    country_code: truncate(addr.country || 'FR', 2).toUpperCase() || 'FR',
  };

  /* Adresse de livraison : uniquement si elle est réellement renseignée et
     différente — l'envoyer vide ferait échouer la validation Qonto. */
  const del = client.deliveryAddress || null;
  if (del && String(del.line1 || '').trim()) {
    const dl1 = String(del.line1 || '').trim();
    const dl2 = String(del.line2 || '').trim();
    payload.delivery_address = {
      street_address: truncate(dl1 + (dl2 ? (', ' + dl2) : ''), 250),
      city: truncate(del.city || '', 100),
      zip_code: truncate(del.postalCode || '', 20),
      country_code: truncate(del.country || 'FR', 2).toUpperCase() || 'FR',
    };
  }

  return payload;
}

/**
 * invoices/{id} → payload POST /v2/client_invoices.
 *
 * @param {Object} args { invoice, qontoClientId, iban, issuer, qontoConfig }
 */
function mapInvoiceToQonto(args) {
  args = args || {};
  const invoice = args.invoice || {};
  const issuer = args.issuer || {};
  const cfg = args.qontoConfig || {};

  const lines = Array.isArray(invoice.lines) ? invoice.lines : [];
  const items = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] || {};
    const item = {
      title: buildItemTitle(l),
      quantity: String(l.qty === null || l.qty === undefined ? 1 : l.qty),
      unit: mapUnit(l.unit),
      unit_price: { value: moneyStr(l.unitPriceHt), currency: 'EUR' },
      vat_rate: vatRateToDecimal(l.vatRate),
    };
    const desc = truncate(l.description || '', 1800);
    if (desc) item.description = desc;
    const disc = Number(l.discountPct);
    if (isFinite(disc) && disc > 0) {
      item.discount = { type: 'percentage', value: String(Math.round(disc * 100) / 10000) };
    }
    items.push(item);
  }

  const payload = {
    client_id: args.qontoClientId,
    number: truncate(invoice.number || '', 40),
    issue_date: toYmd(invoice.issueDate),
    due_date: toYmd(invoice.dueDate),
    currency: 'EUR',
    status: 'unpaid',
    payment_methods: { iban: String(args.iban || '').replace(/\s+/g, '') },
    items: items,
    settings: {
      /* Mentions rendues obligatoires par la réforme. */
      transaction_type: cfg.transactionType || 'services',
      vat_payment_condition: cfg.vatPaymentCondition || 'on_receipts',
    },
  };

  if (issuer.companyVatNumber) payload.settings.vat_number = String(issuer.companyVatNumber);
  if (issuer.companyRcs) payload.settings.commercial_register_number = String(issuer.companyRcs);
  if (issuer.companyShareCapital) {
    payload.settings.legal_capital_share = { value: moneyStr(issuer.companyShareCapital), currency: 'EUR' };
  }

  /* terms_and_conditions est plafonné à 525 caractères par l'API. */
  const terms = truncate(cfg.cgvShortText || '', 525);
  if (terms) payload.terms_and_conditions = terms;

  if (invoice.notesPublic) payload.footer = truncate(invoice.notesPublic, 500);

  return payload;
}

/* Timestamp Firestore, Date ou chaîne → 'YYYY-MM-DD'.
   Getters LOCAUX volontairement : toISOString() décalerait la date d'un jour
   pour toute facture validée en soirée (France = UTC+1/+2). */
function toYmd(value) {
  let d = null;
  if (!value) return null;
  if (typeof value.toDate === 'function') d = value.toDate();
  else if (value instanceof Date) d = value;
  else if (typeof value._seconds === 'number') d = new Date(value._seconds * 1000);
  else if (typeof value === 'string') d = new Date(value);
  if (!d || isNaN(d.getTime())) return null;
  return d.getFullYear() + '-'
    + String(d.getMonth() + 1).padStart(2, '0') + '-'
    + String(d.getDate()).padStart(2, '0');
}

module.exports = {
  qontoFetch: qontoFetch,
  isConfigured: isConfigured,
  missingConfig: missingConfig,
  isSandbox: isSandbox,
  baseUrl: baseUrl,
  describeQontoError: describeQontoError,
  mapClientToQonto: mapClientToQonto,
  mapInvoiceToQonto: mapInvoiceToQonto,
  buildItemTitle: buildItemTitle,
  mapUnit: mapUnit,
  vatRateToDecimal: vatRateToDecimal,
  moneyStr: moneyStr,
  toYmd: toYmd,
};
