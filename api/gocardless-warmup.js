// ==========================================================================
// api/gocardless-warmup.js
// --------------------------------------------------------------------------
// Reconstruit le cache Firestore `gc_customers_cache` en scannant TOUS les
// customers GoCardless (pagination complète, sans limite des 1000 derniers).
//
// Utilisé par /api/gocardless-lookup pour matcher rapidement par email,
// même pour les vieux customers (au-delà des 1000 plus récents).
//
// Body : aucun (POST)
// Auth : Bearer Firebase ID token (rôle admin uniquement)
// Réponse : { ok, count, errors, durationMs }
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Accept': 'application/json'
    }
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const startedAt = Date.now();

  try {
    let after = null;
    let pages = 0;
    let count = 0;
    let withEmail = 0;
    const MAX_PAGES = 200; // 200 × 200 = 40 000 customers max (large safety net)

    // Batch Firestore writes (max 500 ops par batch)
    let batch = db.batch();
    let batchOps = 0;
    const BATCH_LIMIT = 450;

    while (pages < MAX_PAGES) {
      const url = `/customers?limit=200${after ? `&after=${after}` : ''}`;
      const page = await gcGet(url);
      if (!page || !page.customers || !page.customers.length) break;

      for (const c of page.customers) {
        count++;
        if (!c.email) continue;
        withEmail++;
        const email = c.email.toLowerCase().trim();
        const ref = db.collection('gc_customers_cache').doc(c.id);
        batch.set(ref, {
          customerId: c.id,
          email,
          givenName: c.given_name || '',
          familyName: c.family_name || '',
          createdAt: c.created_at || null,
          indexedAt: admin.firestore.FieldValue.serverTimestamp()
        }, { merge: true });
        batchOps++;

        if (batchOps >= BATCH_LIMIT) {
          await batch.commit();
          batch = db.batch();
          batchOps = 0;
        }
      }

      const meta = page.meta && page.meta.cursors;
      if (!meta || !meta.after) break;
      after = meta.after;
      pages++;
    }

    if (batchOps > 0) await batch.commit();

    // Marquer la dernière reconstruction
    await db.collection('_meta').doc('gc_customers_cache').set({
      lastWarmupAt: admin.firestore.FieldValue.serverTimestamp(),
      count,
      withEmail,
      pages,
      triggeredBy: auth.email
    }, { merge: true });

    const durationMs = Date.now() - startedAt;
    res.json({
      ok: true,
      count,
      withEmail,
      pages,
      durationMs
    });

  } catch (e) {
    console.error('[gocardless-warmup]', e.message);
    res.status(500).json({ error: e.message });
  }
};
