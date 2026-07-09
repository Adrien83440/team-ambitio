// ============================================================================
// api/ads-metrics-ingest.js
// ----------------------------------------------------------------------------
// Endpoint d'ingestion des métriques publicitaires (Meta/Facebook Ads) pour
// le Funnel Sales (sales-funnel.html).
//
// URL  : POST https://team.alteore.com/api/ads-metrics-ingest
// Auth : header x-api-key (validé contre process.env.ADS_METRICS_API_KEY)
// CORS : pas nécessaire — appelé uniquement par Make en server-to-server
//        (même pattern que api/lead-optin.js).
//
// Body (JSON) — un item unique OU un batch :
//   { "date": "2026-07-08", "tunnel": "elite",
//     "spend": 42.37, "impressions": 15230, "clicks": 214,
//     "leads": 18, "reach": 9800 }
//   ou
//   { "items": [ {...}, {...} ] }        // max 62 items par appel
//
// Champs :
//   date        : "YYYY-MM-DD" (jour des insights, fuseau du compte pub) — requis
//   tunnel      : "elite" | "business" | "other"                        — requis
//   spend       : dépense € (float ≥ 0)                                 — optionnel
//   impressions : int ≥ 0                                               — optionnel
//   clicks      : clics sortants (int ≥ 0)                              — optionnel
//   leads       : leads reportés par Meta / pixel (int ≥ 0)             — optionnel
//   reach       : int ≥ 0                                               — optionnel
//
// Écriture : upsert Firestore ads_insights/{date}_{tunnel} (Admin SDK).
//
// ─── RÈGLE DE PRIORITÉ manuel > Make ──────────────────────────────────
// Si le doc existe avec source == 'manual' (édité depuis la grille de
// sales-funnel.html), les valeurs Make N'ÉCRASENT PAS les champs :
// elles sont stockées dans makeSuggested{} + makeSuggestedAt, et la grille
// propose un bouton ↩ pour les reprendre. Sinon : écriture directe avec
// source == 'make'.
//
// ─── IDEMPOTENCE ──────────────────────────────────────────────────────
// Make peut renvoyer J-1 et J-2 chaque matin (rattrapage d'attribution) :
// l'upsert par docId déterministe {date}_{tunnel} rend l'appel rejouable
// sans doublon.
//
// ─── DÉPLOIEMENT ──────────────────────────────────────────────────────
//   1. Poser la variable Vercel : ADS_METRICS_API_KEY (valeur forte, à
//      reporter dans le module HTTP du scénario Make).
//   2. Ce fichier dans /api → déploiement auto GitHub → Vercel.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const ALLOWED_TUNNELS = ['elite', 'business', 'other'];
const MAX_ITEMS = 62; // 2 tunnels × 31 jours

const NUM_FIELDS = [
  { key: 'spend',       int: false },
  { key: 'impressions', int: true  },
  { key: 'clicks',      int: true  },
  { key: 'leads',       int: true  },
  { key: 'reach',       int: true  },
];

function normalizeTunnel(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (t.indexOf('business') >= 0) return 'business';
  if (t.indexOf('elite') >= 0 || t.indexOf('élite') >= 0) return 'elite';
  if (ALLOWED_TUNNELS.indexOf(t) >= 0) return t;
  return null;
}

// Valide + normalise un item. Retourne { ok, error?, item? }
function validateItem(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'item[' + idx + ']: objet attendu' };
  }
  const date = String(raw.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'item[' + idx + ']: date invalide (attendu YYYY-MM-DD)' };
  }
  const tunnel = normalizeTunnel(raw.tunnel);
  if (!tunnel) {
    return { ok: false, error: 'item[' + idx + ']: tunnel invalide (elite | business | other)' };
  }
  const item = { date, tunnel, values: {} };
  for (let i = 0; i < NUM_FIELDS.length; i++) {
    const f = NUM_FIELDS[i];
    const v = raw[f.key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      return { ok: false, error: 'item[' + idx + ']: ' + f.key + ' invalide (nombre ≥ 0 attendu)' };
    }
    item.values[f.key] = f.int ? Math.round(n) : Math.round(n * 100) / 100;
  }
  if (Object.keys(item.values).length === 0) {
    return { ok: false, error: 'item[' + idx + ']: aucune métrique fournie' };
  }
  return { ok: true, item };
}

module.exports = async (req, res) => {
  // ─── 1. Auth via x-api-key ──────────────────────────────────────────
  const expectedKey = process.env.ADS_METRICS_API_KEY;
  const providedKey = req.headers['x-api-key'] || req.headers['X-API-Key'];
  if (!expectedKey) {
    console.error('[ads-metrics-ingest] ADS_METRICS_API_KEY env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  if (providedKey !== expectedKey) {
    console.warn('[ads-metrics-ingest] invalid api key');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // ─── 2. Méthode ─────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ─── 3. Parse + validation ──────────────────────────────────────────
  const body = parseBody(req);
  const rawItems = Array.isArray(body && body.items) ? body.items : [body];
  if (!rawItems.length) {
    res.status(400).json({ error: 'empty_payload' });
    return;
  }
  if (rawItems.length > MAX_ITEMS) {
    res.status(400).json({ error: 'too_many_items', max: MAX_ITEMS });
    return;
  }

  const items = [];
  const errors = [];
  for (let i = 0; i < rawItems.length; i++) {
    const v = validateItem(rawItems[i], i);
    if (v.ok) items.push(v.item);
    else errors.push(v.error);
  }
  if (!items.length) {
    res.status(400).json({ error: 'no_valid_items', details: errors });
    return;
  }

  // ─── 4. Upsert ads_insights/{date}_{tunnel} ─────────────────────────
  const now = admin.firestore.FieldValue.serverTimestamp();
  let written = 0;
  let skippedManual = 0;
  const writtenIds = [];

  try {
    for (let i = 0; i < items.length; i++) {
      const it = items[i];
      const docId = it.date + '_' + it.tunnel;
      const ref = db.collection('ads_insights').doc(docId);
      const snap = await ref.get();

      if (snap.exists && snap.data().source === 'manual') {
        // Ne pas écraser une saisie manuelle : proposer les valeurs Make.
        await ref.set({
          makeSuggested: it.values,
          makeSuggestedAt: now,
        }, { merge: true });
        skippedManual++;
      } else {
        const payload = {
          date: it.date,
          tunnel: it.tunnel,
          source: 'make',
          receivedAt: now,
          updatedAt: now,
        };
        Object.keys(it.values).forEach((k) => { payload[k] = it.values[k]; });
        await ref.set(payload, { merge: true });
        written++;
        writtenIds.push(docId);
      }
    }
  } catch (e) {
    console.error('[ads-metrics-ingest] firestore error:', e.message);
    res.status(500).json({ error: 'firestore_error', message: e.message, written, skippedManual });
    return;
  }

  console.log('[ads-metrics-ingest] ok — written:', written, 'skippedManual:', skippedManual, 'invalid:', errors.length);
  res.status(200).json({
    ok: true,
    written,
    skippedManual,
    invalid: errors.length ? errors : undefined,
    ids: writtenIds,
  });
};
