// ============================================================================
// api/tunnel-source.js — HTML SOURCE D'UNE VARIANTE DE TUNNEL (10/2026)
// ----------------------------------------------------------------------------
// admin-tunnels.html a besoin du HTML brut d'une page publiée (tel que déposé,
// sans le runtime injecté) pour deux usages : le télécharger sur l'ordinateur
// et l'ouvrir dans l'éditeur de code. Le bucket Storage ne répond pas aux
// requêtes CORS de team.alteore.com, d'où ce relais côté serveur.
//
//   GET /api/tunnel-source?t=<tunnelId>&s=<stepId>&v=<variantId>
//   → 200 text/plain (UTF-8) : le HTML brut, jamais mis en cache.
//
//   GET /api/tunnel-source?t=…&s=…&v=…&ver=<version>   (historique, 19/10/2026)
//   → une version précédemment publiée, copiée à la publication dans
//     tunnels/<t>/<s>/<v>/versions/<version>.html. L'étape peut avoir été
//     archivée depuis (retirée du document) : seul le tunnel doit exister.
//     404 « Version non conservée » pour une publication antérieure à
//     l'historique.
//
// Auth : admin uniquement (Bearer Firebase). Lecture seule, aucune écriture.
// Le document tunnel est lu directement (pas le registre en cache) : une
// variante archivée ou une étape en brouillon reste lisible ici.
// ============================================================================

const { db, storage } = require('./_firebaseAdmin');
const { requireAdmin } = require('./_verifyFirebaseAuth');

function clean(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 60); }

module.exports = async (req, res) => {
  if (req.method !== 'GET') { res.status(405).json({ error: 'GET only' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  let url;
  try { url = new URL(req.url, 'http://localhost'); } catch (e) { res.status(400).json({ error: 'Requête invalide' }); return; }
  const tunnelId = clean(url.searchParams.get('t'), 80);
  const stepId = clean(url.searchParams.get('s'), 80);
  const variantId = clean(url.searchParams.get('v'), 20);
  if (!tunnelId || !stepId || !variantId) { res.status(400).json({ error: 'Paramètres t, s, v requis' }); return; }
  const ver = clean(url.searchParams.get('ver'), 20);
  if (ver && !/^\d{1,16}$/.test(ver)) { res.status(400).json({ error: 'Version invalide' }); return; }
  if (ver && !/^[A-Za-z0-9_-]+$/.test(tunnelId + stepId + variantId)) { res.status(400).json({ error: 'Identifiants invalides' }); return; }

  const doc = await db.collection('tunnels').doc(tunnelId).get();
  if (!doc.exists) { res.status(404).json({ error: 'Tunnel introuvable' }); return; }

  if (ver) {
    const vpath = 'tunnels/' + tunnelId + '/' + stepId + '/' + variantId + '/versions/' + ver + '.html';
    let vhtml;
    try {
      const file = storage.bucket().file(vpath);
      const [exists] = await file.exists();
      if (!exists) { res.status(404).json({ error: 'Version non conservée (publiée avant le début de l\'historique)' }); return; }
      const [vbuf] = await file.download();
      vhtml = vbuf.toString('utf8');
    } catch (e) {
      console.error('[tunnel-source] lecture version :', vpath, e && e.message);
      res.status(502).json({ error: 'Lecture Storage impossible' });
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Alteo-Version', ver);
    res.end(vhtml);
    return;
  }
  const steps = Array.isArray(doc.data().steps) ? doc.data().steps : [];
  const step = steps.filter(function (s) { return s && s.id === stepId; })[0];
  const variant = step && Array.isArray(step.variants) ? step.variants.filter(function (v) { return v && v.id === variantId; })[0] : null;
  if (!variant || !variant.html || !variant.html.path) { res.status(404).json({ error: 'Aucune page publiée pour cette variante' }); return; }

  /* Garde-fou : le chemin doit rester dans le dossier du tunnel. */
  const expected = 'tunnels/' + tunnelId + '/';
  if (String(variant.html.path).indexOf(expected) !== 0) { res.status(400).json({ error: 'Chemin Storage inattendu' }); return; }

  let html;
  try {
    const [buf] = await storage.bucket().file(variant.html.path).download();
    html = buf.toString('utf8');
  } catch (e) {
    console.error('[tunnel-source] lecture Storage :', variant.html.path, e && e.message);
    res.status(502).json({ error: 'Lecture Storage impossible' });
    return;
  }
  res.status(200);
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Alteo-Version', String(variant.html.version || ''));
  res.end(html);
};
