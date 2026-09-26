// ============================================================================
// api/site-config.js — CONTENU ÉDITABLE DU SITE VITRINE adrienemily.com
// ----------------------------------------------------------------------------
// Le site (pages du tunnel « site », dossier site-adrienemily/ du repo) est
// hydraté au chargement par cette config : chiffres clés, photos, témoignages
// vidéo, secteurs du bandeau défilant, note Trustpilot, URL du CTA. Adrien
// modifie tout depuis admin-site.html (Site & pages) — plus besoin de toucher
// au code des pages pour changer un chiffre ou un témoignage.
//
//   GET  /api/site-config
//        Public (les pages du site l'appellent depuis go/www/adrienemily.com,
//        d'où le CORS ouvert — contenu 100 % public par nature).
//        Cache edge 60 s (stale-while-revalidate 5 min) : une modification
//        est visible sur le site au plus tard une minute plus tard.
//        → { ok:true, config:{...}, version, updatedAt }
//
//   POST /api/site-config          (Authorization: Bearer <idToken>, admin)
//        Body { config:{...} } — nettoyé champ par champ (whitelist, bornes)
//        puis écrit dans Firestore `site_config/public` via l'Admin SDK
//        (aucune règle Firestore à déployer). Les champs absents du body
//        reprennent leur valeur par défaut : l'admin envoie toujours la
//        config complète (le formulaire est pré-rempli par le GET).
//
// Les DÉFAUTS ci-dessous répliquent le contenu codé en dur dans les pages :
// tant que rien n'a été enregistré, le GET renvoie exactement ce que le
// site affiche déjà — aucun écart possible entre les deux.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { requireAdmin } = require('./_verifyFirebaseAuth');

const DOC = () => db.collection('site_config').doc('public');

const DEFAULTS = {
  stats: { dirigeants: 200, margePct: 36, heuresSemaine: 7, experienceAns: 26 },
  trustpilot: { note: '4,8', visible: true },
  ctaUrl: 'https://team.alteore.com/alteoforms-render.html?id=MIdcp9T5fczESwm6zUEE',
  secteurs: ['Retail', 'Restauration', 'Artisanat', 'Bien-être', 'Services', 'BTP', 'Commerce', 'Boulangerie', 'Épicerie', 'Beauté'],
  photos: {
    hero:     'https://lh3.googleusercontent.com/d/1J8a64atR2eX_S_vhGf7p5Gdb1ycVG2Ae=w1000-rw',
    histoire: 'https://lh3.googleusercontent.com/d/1Y057woWFhBguJWPmEDzuCHL-X1FSRQLe=w900-rw',
    adrien:   'https://lh3.googleusercontent.com/d/1E4CifBShs3CyVigYyE392cL-bOAtd6Cn=w720-rw',
    emily:    'https://lh3.googleusercontent.com/d/1mryOuGZtOKFZ9fvr0l1o_l0kXM5VRFZl=w720-rw',
    groupe:   'https://i.postimg.cc/15rPxXSC/2025-09-16-MASTER-MIND-JJ-126.jpg'
  },
  temoignages: [
    { nom: 'Margaux',   activite: 'Épicerie / Restaurant', resultat: '+20 % de CA/mois',        vimeoId: '1204547192', vimeoHash: 'd73c2ad778', format: 'portrait' },
    { nom: 'Sébastien', activite: 'Frigoriste',            resultat: '+30 % de devis acceptés', vimeoId: '1204547193', vimeoHash: '4b10e394b6', format: 'paysage' },
    { nom: 'Franck',    activite: 'Boulangerie',           resultat: '+7 K€/mois de bénéfice',  vimeoId: '1204547163', vimeoHash: '09b6c1202b', format: 'paysage' }
  ]
};

// ─── Nettoyage strict : seuls les champs connus passent, tous bornés ───
function s(v, max) { return String(v == null ? '' : v).trim().slice(0, max || 300); }
function n(v, min, max, dflt) {
  const x = Number(v);
  if (!isFinite(x)) return dflt;
  return Math.max(min, Math.min(max, Math.round(x)));
}
function url(v) {
  const u = s(v, 500);
  return /^https:\/\/[^\s"'<>]+$/.test(u) ? u : '';
}

function sanitize(raw) {
  const c = (raw && typeof raw === 'object') ? raw : {};
  const out = {};

  const st = (c.stats && typeof c.stats === 'object') ? c.stats : {};
  out.stats = {
    dirigeants:    n(st.dirigeants,    0, 100000, DEFAULTS.stats.dirigeants),
    margePct:      n(st.margePct,      0, 1000,   DEFAULTS.stats.margePct),
    heuresSemaine: n(st.heuresSemaine, 0, 100,    DEFAULTS.stats.heuresSemaine),
    experienceAns: n(st.experienceAns, 0, 100,    DEFAULTS.stats.experienceAns)
  };

  const tp = (c.trustpilot && typeof c.trustpilot === 'object') ? c.trustpilot : {};
  out.trustpilot = { note: s(tp.note, 8) || DEFAULTS.trustpilot.note, visible: tp.visible !== false };

  out.ctaUrl = url(c.ctaUrl) || DEFAULTS.ctaUrl;

  out.secteurs = (Array.isArray(c.secteurs) ? c.secteurs : DEFAULTS.secteurs)
    .map(function (x) { return s(x, 40); })
    .filter(Boolean)
    .slice(0, 20);
  if (!out.secteurs.length) out.secteurs = DEFAULTS.secteurs;

  const ph = (c.photos && typeof c.photos === 'object') ? c.photos : {};
  out.photos = {};
  Object.keys(DEFAULTS.photos).forEach(function (k) {
    out.photos[k] = url(ph[k]) || DEFAULTS.photos[k];
  });

  const tems = Array.isArray(c.temoignages) ? c.temoignages : DEFAULTS.temoignages;
  out.temoignages = [];
  for (let i = 0; i < tems.length && out.temoignages.length < 12; i++) {
    const t = tems[i];
    if (!t || typeof t !== 'object') continue;
    const vid = s(t.vimeoId, 20).replace(/[^\d]/g, '');
    if (!vid) continue;
    out.temoignages.push({
      nom:       s(t.nom, 60) || 'Client',
      activite:  s(t.activite, 80),
      resultat:  s(t.resultat, 80),
      vimeoId:   vid,
      vimeoHash: s(t.vimeoHash, 20).replace(/[^0-9a-f]/gi, ''),
      format:    t.format === 'portrait' ? 'portrait' : 'paysage'
    });
  }

  return out;
}

module.exports = async (req, res) => {
  // CORS : le GET est appelé depuis les domaines marketing (go/www/apex),
  // le contenu est public par nature — aucune donnée sensible ici.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }

  // ─── GET : config publique, cache edge court ───
  if (req.method === 'GET') {
    try {
      const doc = await DOC().get();
      const d = doc.exists ? (doc.data() || {}) : {};
      const config = sanitize(d.config || {});
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      res.status(200).json({
        ok: true,
        config: config,
        version: Number(d.version) || 0,
        updatedAt: d.updatedAtIso || null
      });
    } catch (e) {
      console.error('[site-config] GET :', e);
      // Fail-safe : les pages ont leurs défauts en dur, on renvoie les mêmes.
      res.status(200).json({ ok: true, config: sanitize({}), version: 0, updatedAt: null, degraded: true });
    }
    return;
  }

  // ─── POST : écriture admin uniquement ───
  if (req.method !== 'POST') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const body = parseBody(req);
  const config = sanitize(body && body.config);

  try {
    const prev = await DOC().get();
    const version = (prev.exists ? Number((prev.data() || {}).version) || 0 : 0) + 1;
    await DOC().set({
      config: config,
      version: version,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAtIso: new Date().toISOString(),
      updatedBy: auth.email || auth.uid
    });
    console.log('[site-config] v' + version + ' enregistrée par', auth.email || auth.uid);
    res.status(200).json({ ok: true, version: version, config: config });
  } catch (e) {
    console.error('[site-config] POST :', e);
    res.status(500).json({ error: 'write_failed' });
  }
};
