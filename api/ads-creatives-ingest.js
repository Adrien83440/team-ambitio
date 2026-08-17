// ============================================================================
// api/ads-creatives-ingest.js
// ----------------------------------------------------------------------------
// Ingestion AD-LEVEL des métriques Meta Ads + référentiel des créatives.
//
// URL  : POST https://team.alteore.com/api/ads-creatives-ingest
// Auth : header x-api-key — ADS_CREATIVES_API_KEY, repli ADS_METRICS_API_KEY
//        (même scénario Make que l'ingestion agrégée : aucun nouveau secret
//        à provisionner si tu n'en veux pas)
// CORS : pas nécessaire — appelé uniquement par Make en server-to-server
//
// ─── POURQUOI CET ENDPOINT ────────────────────────────────────────────
// api/ads-metrics-ingest.js écrit ads_insights/{date}_{tunnel} : agrégé
// jour × tunnel. Aucun coût par créative ne peut en sortir — la question
// « quelle pub a coûté quoi » est structurellement sans réponse tant que
// la donnée n'arrive pas au niveau de la pub. D'où cette collection.
//
// Et comme les insights ad-level de Meta portent DÉJÀ ad_name / adset_name /
// campaign_name, le même appel alimente le référentiel ads_creatives : c'est
// lui qui permet d'afficher « 6)NEW-été-Vision » à la place de
// « 120246655604620308 » pour les pubs dont le template d'URL envoie
// {{ad.id}} au lieu de {{ad.name}}.
//
// L'endpoint agrégé existant n'est PAS modifié : le scénario Make en place
// continue de tourner à l'identique.
//
// ─── BODY ─────────────────────────────────────────────────────────────
//   { "items": [ { ... }, { ... } ] }      // ou un item unique à plat
//
//   date          : "YYYY-MM-DD"                                    — requis
//   ad_id         : identifiant Meta de la pub                      — requis
//   ad_name       : nom de la pub                                   — optionnel
//   adset_id / adset_name / campaign_id / campaign_name             — optionnel
//   tunnel        : "elite" | "business" | "other"                  — optionnel
//   spend / impressions / clicks / leads / reach                    — optionnel
//
// ─── ÉCRITURES ────────────────────────────────────────────────────────
//   ads_insights_ad/{date}_{ad_id}   métriques du jour pour cette pub
//   ads_creatives/{ad_id}            noms (merge — jamais d'écrasement par
//                                    du vide : une valeur absente dans le
//                                    payload ne supprime pas celle en base)
//
// ─── IDEMPOTENCE ──────────────────────────────────────────────────────
// docId déterministe {date}_{ad_id} → Make peut rejouer J-1 / J-2 chaque
// matin (rattrapage d'attribution Meta) sans jamais créer de doublon.
//
// ─── DÉPLOIEMENT ──────────────────────────────────────────────────────
//   1. Déployer les rules Firestore (blocs ads_insights_ad + ads_creatives).
//   2. Ce fichier dans /api → déploiement auto GitHub → Vercel.
//   3. Scénario Make : insights Meta au niveau `ad`, breakdown par jour,
//      champs ad_id/ad_name/adset_*/campaign_*/spend/impressions/clicks.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const MAX_ITEMS = 500;          // ~16 pubs × 31 jours de rattrapage
const BATCH_SIZE = 200;         // 2 écritures par item → 400 ops max par batch

const NUM_FIELDS = [
  { key: 'spend',       int: false },
  { key: 'impressions', int: true  },
  { key: 'clicks',      int: true  },
  { key: 'leads',       int: true  },
  { key: 'reach',       int: true  },
];

const NAME_FIELDS = ['ad_name', 'adset_id', 'adset_name', 'campaign_id', 'campaign_name'];

function normalizeTunnel(raw) {
  const t = String(raw || '').toLowerCase().trim();
  if (!t) return null;
  if (t.indexOf('business') >= 0) return 'business';
  if (t.indexOf('elite') >= 0 || t.indexOf('élite') >= 0) return 'elite';
  if (t === 'other') return 'other';
  return null;
}

// Un identifiant Meta est numérique. On refuse tout le reste plutôt que de
// fabriquer un docId à partir d'une valeur libre (et de polluer durablement
// une collection dont rien n'est jamais supprimé).
function normalizeId(raw) {
  const s = String(raw == null ? '' : raw).trim();
  return /^\d{1,32}$/.test(s) ? s : null;
}

// Macro Meta non substituée ({{ad.name}}) : c'est une absence, pas un nom.
function cleanName(raw) {
  const s = String(raw == null ? '' : raw).trim();
  if (!s || s.indexOf('{{') >= 0) return null;
  return s.slice(0, 300);
}

function validateItem(raw, idx) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'item[' + idx + '] : objet attendu' };
  }
  const date = String(raw.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return { ok: false, error: 'item[' + idx + '] : date invalide (attendu YYYY-MM-DD)' };
  }
  const adId = normalizeId(raw.ad_id);
  if (!adId) {
    return { ok: false, error: 'item[' + idx + '] : ad_id invalide (identifiant Meta numérique attendu)' };
  }

  const item = { date, ad_id: adId, tunnel: normalizeTunnel(raw.tunnel), values: {}, names: {} };

  for (let i = 0; i < NUM_FIELDS.length; i++) {
    const f = NUM_FIELDS[i];
    const v = raw[f.key];
    if (v === undefined || v === null || v === '') continue;
    const n = Number(v);
    if (isNaN(n) || !isFinite(n) || n < 0) {
      return { ok: false, error: 'item[' + idx + '] : ' + f.key + ' invalide (nombre ≥ 0 attendu)' };
    }
    item.values[f.key] = f.int ? Math.round(n) : Math.round(n * 100) / 100;
  }

  for (let i = 0; i < NAME_FIELDS.length; i++) {
    const f = NAME_FIELDS[i];
    if (f === 'adset_id' || f === 'campaign_id') {
      const id = normalizeId(raw[f]);
      if (id) item.names[f] = id;
    } else {
      const n = cleanName(raw[f]);
      if (n) item.names[f] = n;
    }
  }

  return { ok: true, item };
}

module.exports = async (req, res) => {
  // ─── 1. Auth via x-api-key ──────────────────────────────────────────
  const expectedKey = process.env.ADS_CREATIVES_API_KEY || process.env.ADS_METRICS_API_KEY;
  const providedKey = req.headers['x-api-key'] || req.headers['X-API-Key'];
  if (!expectedKey) {
    console.error('[ads-creatives-ingest] ADS_CREATIVES_API_KEY / ADS_METRICS_API_KEY non posée');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  if (providedKey !== expectedKey) {
    console.warn('[ads-creatives-ingest] invalid api key');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }

  // ─── 2. Méthode ─────────────────────────────────────────────────────
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  // ─── 3. Parse + validation ──────────────────────────────────────────
  const body = parseBody(req) || {};
  const rawItems = Array.isArray(body.items) ? body.items : [body];
  if (!rawItems.length) {
    res.status(400).json({ error: 'no_items' });
    return;
  }
  if (rawItems.length > MAX_ITEMS) {
    res.status(400).json({ error: 'too_many_items', max: MAX_ITEMS, got: rawItems.length });
    return;
  }

  const items = [];
  const errors = [];
  for (let i = 0; i < rawItems.length; i++) {
    const v = validateItem(rawItems[i], i);
    if (v.ok) items.push(v.item); else errors.push(v.error);
  }
  // Un item mal formé ne doit pas faire perdre les 499 autres : on écrit ce
  // qui est valide et on remonte le détail des rejets dans la réponse.
  if (!items.length) {
    res.status(400).json({ error: 'no_valid_item', errors });
    return;
  }

  // ─── 4. Écritures ───────────────────────────────────────────────────
  // ⚠ Vercel tue la fonction dès res.end() : on écrit AVANT de répondre.
  const now = admin.firestore.FieldValue.serverTimestamp();
  let insightWrites = 0;
  const creativeSeen = {};

  try {
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
      const chunk = items.slice(i, i + BATCH_SIZE);
      const batch = db.batch();

      chunk.forEach((it) => {
        const doc = {
          date: it.date,
          ad_id: it.ad_id,
          source: 'make',
          updatedAt: now,
        };
        if (it.tunnel) doc.tunnel = it.tunnel;
        Object.keys(it.values).forEach((f) => { doc[f] = it.values[f]; });
        Object.keys(it.names).forEach((f) => { doc[f] = it.names[f]; });
        batch.set(db.collection('ads_insights_ad').doc(it.date + '_' + it.ad_id), doc, { merge: true });
        insightWrites++;

        // Référentiel : merge des seuls champs renseignés. Un payload sans
        // ad_name ne doit pas effacer le nom déjà connu de la pub.
        if (Object.keys(it.names).length || it.tunnel) {
          const cre = { ad_id: it.ad_id, source: 'make', updatedAt: now };
          Object.keys(it.names).forEach((f) => { cre[f] = it.names[f]; });
          if (it.tunnel) cre.tunnel = it.tunnel;
          batch.set(db.collection('ads_creatives').doc(it.ad_id), cre, { merge: true });
          creativeSeen[it.ad_id] = 1;
        }
      });

      await batch.commit();
    }
  } catch (e) {
    console.error('[ads-creatives-ingest] write error:', e && e.message);
    res.status(500).json({ error: 'write_failed', message: e && e.message });
    return;
  }

  console.log('[ads-creatives-ingest] OK — insights=' + insightWrites +
    ' creatives=' + Object.keys(creativeSeen).length + ' rejets=' + errors.length);

  res.status(200).json({
    ok: true,
    insightsWritten: insightWrites,
    creativesUpserted: Object.keys(creativeSeen).length,
    rejected: errors.length,
    errors: errors.slice(0, 20),
  });
};
