// ============================================================================
// api/agency-funnel.js
// ----------------------------------------------------------------------------
// Accès AGENCE au tunnel marketing — lecture seule, sans compte, sans accès
// Firestore. Calcule les KPIs À LA DEMANDE avec funnel-core.js, le module
// que fait tourner sales-funnel.html : mêmes données, même code, mêmes
// chiffres, pour n'importe quelle période.
//
// URL  : GET https://team.alteore.com/api/agency-funnel
//          ?t=TOKEN
//          &mode=month|day|7d|30d|custom      (défaut : month)
//          &month=YYYY-MM      (mode month)
//          &day=YYYY-MM-DD     (mode day)
//          &from=&to=          (mode custom, YYYY-MM-DD)
//          &tunnel=all|elite|business          (défaut : all)
// Auth : token secret dans l'URL (capacité) — PAS de Firebase Auth.
// Front: agency-funnel.html (page publique autonome, aucun SDK Firebase).
//
// Réponses
//   200 { ok:true, mode, tunnel, month, day, from, to, months:[…],
//         computedAt:<ms>, k, instagram, journal }
//   403 { ok:false }   ← token absent / faux / révoqué
//   405 { ok:false }   ← autre verbe que GET
//   500 { ok:false }
//
// SÉCURITÉ
// --------
// - Le token EST le secret (24 octets base64url, généré depuis la modale
//   « 🔗 Agence » du funnel). La collection n'est pas lisible côté client :
//   tout passe par cet endpoint (Admin SDK, bypass des rules).
// - Comparaison timing-safe (sha256 des deux valeurs puis timingSafeEqual :
//   digests de 32 octets, aucune fuite de longueur).
// - Réponse d'erreur volontairement pauvre : { ok:false } — impossible de
//   savoir si c'est le token, le mois ou le tunnel qui est en cause.
// - ⚠ CE FICHIER EST LE SEUL POINT DE SORTIE des chiffres du funnel vers
//   l'extérieur : l'assainissement (AGENCY_EXCLUDE ci-dessous) s'y fait,
//   et nulle part ailleurs.
// - Chaque accès (accepté comme refusé) est journalisé dans audit_log.
// ============================================================================

/* ⚠ AVANT TOUTE MANIPULATION DE DATE — les bornes de période sont
   construites en heure LOCALE (new Date(y, m, 1)). Vercel tourne en UTC :
   sans ça, « juillet » commencerait le 01/07 à 02:00 heure de Paris et les
   leads des deux premières heures du mois tomberaient hors période. Le
   funnel interne, lui, calcule en heure de Paris — les deux vues doivent
   découper le temps exactement pareil. */
process.env.TZ = 'Europe/Paris';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const Core = require('../funnel-core.js');

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TUNNEL_RE = /^(all|elite|business)$/;
const MODE_RE = /^(month|day|7d|30d|custom)$/;
const MONTHS_LISTED = 12;
const MAX_RANGE_DAYS = 92;      // garde-fou de charge sur les plages libres
const CACHE_TTL_MS = 120 * 1000;

/* ⚠ CONTRAT DE DONNÉES — champs de K qui ne sortent JAMAIS de la maison.
   Toute évolution future de K qui ajoute un champ nominatif (nom de client,
   de prospect ou de membre d'équipe) ou une donnée financière interne
   (salaire, commission, coût d'outillage) DOIT être ajoutée ici — c'est
   l'absence totale de donnée personnelle dans la réponse qui rend l'accès
   externe conforme (RGPD) sans contrat de sous-traitance de données. */
const AGENCY_EXCLUDE = {
  /* Nominatifs clients / prospects */
  collecteMissingNames: 1,
  payCloseNames: 1,
  payCloseOther: 1,
  /* Équipe, par personne */
  callsByUser: 1,
  /* Coûts internes & commissions */
  commSetting: 1,
  commSettingN: 1,
  costFixe: 1,
  costOutils: 1,
  costConfigured: 1,
  costSrcMonth: 1,
  costOwnEntry: 1,
  costSetting: 1,
  costPerRdvNB: 1,
};

/* ⚠ INSTAGRAM — LISTE BLANCHE, pas liste noire.
   Le reste du fichier assainit K en retirant des champs connus ; ici on fait
   l'inverse et c'est délibéré. Les collections ig_* portent des données
   PERSONNELLES DE TIERS — pseudo d'un commentateur, identifiant de
   conversation, contenu de message privé — qui n'ont rien à faire hors de
   la maison, et une whitelist est la seule forme qui reste sûre quand un
   champ est ajouté plus tard sans que personne ne repense à ce fichier.
   Ne sortent donc QUE des mesures d'audience de publications publiques.

   NE SORTENT JAMAIS, et ce n'est pas un oubli :
   · ig_comments  — le pseudo d'un commentateur est une donnée personnelle
                    d'un tiers qui n'a rien signé avec l'agence ;
   · ig_dm_threads — contenu et métriques de messagerie privée ;
   · goLeads       — combien de GO sont devenus des fiches est une donnée
                    CRM interne, pas une mesure d'audience. */
const AGENCY_IG_MEDIA_FIELDS = [
  'date', 'timestamp', 'mediaType', 'mediaProductType', 'isReel',
  'caption', 'permalink', 'thumbnailUrl',
  'reach', 'views', 'likes', 'comments', 'saved', 'shares',
  'totalInteractions', 'engagementRate', 'avgWatchTimeMs',
  'goCount', 'goUniques',
];
const AGENCY_IG_ACCOUNT_FIELDS = [
  'date', 'followers', 'reach', 'views', 'profileViews',
  'websiteClicks', 'accountsEngaged', 'totalInteractions',
];

function pickFields(src, champs) {
  const out = {};
  champs.forEach((f) => { if (src[f] !== undefined) out[f] = src[f]; });
  return out;
}

/* Publications et audience du compte sur la période. Aucune lecture de
   ig_comments ni de ig_dm_threads : ces collections ne sont pas interrogées
   du tout, pas même pour en tirer un agrégat. */
async function loadInstagram(P) {
  const a = Core.isoDate(P.start);
  const b = Core.isoDate(P.end);
  try {
    const [snapMedia, snapAcc] = await Promise.all([
      db.collection('ig_media').where('date', '>=', a).where('date', '<=', b).limit(500).get(),
      db.collection('ig_account_daily').where('date', '>=', a).where('date', '<=', b).limit(400).get(),
    ]);

    const medias = snapMedia.docs
      .map((d) => pickFields(d.data() || {}, AGENCY_IG_MEDIA_FIELDS))
      .sort((x, y) => String(y.timestamp || y.date || '').localeCompare(String(x.timestamp || x.date || '')));

    const jours = snapAcc.docs
      .map((d) => pickFields(d.data() || {}, AGENCY_IG_ACCOUNT_FIELDS))
      .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));

    const tot = { reach: 0, views: 0, profileViews: 0, websiteClicks: 0,
                  accountsEngaged: 0, totalInteractions: 0 };
    let followersFin = null;
    let followersDebut = null;
    jours.forEach((d) => {
      Object.keys(tot).forEach((f) => { tot[f] += Number(d[f]) || 0; });
      if (d.followers != null) {
        if (followersDebut === null) followersDebut = d.followers;
        followersFin = d.followers;
      }
    });

    return JSON.parse(JSON.stringify({
      jours: jours.length,
      compte: Object.assign({}, tot, {
        followers: followersFin,
        followersDelta: (followersDebut !== null && followersFin !== null && jours.length > 1)
          ? followersFin - followersDebut : null,
      }),
      publications: medias,
    }));
  } catch (e) {
    /* Instagram ne doit jamais faire tomber la vue agence : le tunnel
       publicitaire, lui, est la raison d'être de cette page. */
    console.warn('[agency-funnel] instagram indisponible:', e && e.message);
    return null;
  }
}

function sanitizeK(k) {
  const out = {};
  Object.keys(k || {}).forEach((f) => { if (!AGENCY_EXCLUDE[f]) out[f] = k[f]; });
  /* JSON round-trip : supprime les undefined et transforme NaN/Infinity en
     null — la page agence affiche « — » pour tout null. */
  return JSON.parse(JSON.stringify(out));
}

/* Journal marketing : date / catégorie / texte seulement. L'auteur (membre
   de l'équipe) et l'_id Firestore ne sortent pas. */
function sanitizeJournal(list) {
  return (list || []).map((j) => ({
    date: j.date || null,
    category: j.category || null,
    text: j.text || '',
  }));
}

/* Comparaison timing-safe. On hache les deux valeurs avant de comparer :
   timingSafeEqual exige des buffers de même longueur (il jette sinon, ce qui
   révélerait la longueur du vrai token) — les digests SHA-256 normalisent. */
function tokenMatches(expected, given) {
  if (typeof expected !== 'string' || typeof given !== 'string') return false;
  if (!expected || !given) return false;
  const a = crypto.createHash('sha256').update(expected, 'utf8').digest();
  const b = crypto.createHash('sha256').update(given, 'utf8').digest();
  return crypto.timingSafeEqual(a, b);
}

function clientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (!fwd) return null;
  return String(fwd).split(',')[0].trim() || null;
}

/* Journalisation best-effort : une trace d'audit ne doit JAMAIS faire échouer
   la réponse. */
async function logAccess(req, ok, info) {
  try {
    await db.collection('audit_log').add({
      type: 'agency_funnel_read',
      ok: !!ok,
      mode: (info && info.mode) || null,
      from: (info && info.from) || null,
      to: (info && info.to) || null,
      tunnel: (info && info.tunnel) || null,
      ip: clientIp(req),
      ua: String(req.headers['user-agent'] || '').slice(0, 300) || null,
      at: admin.firestore.FieldValue.serverTimestamp(),
    });
  } catch (e) {
    console.warn('[agency-funnel] audit_log:', e && e.message);
  }
}

/* Construit la période demandée. Toute valeur malformée retombe sur le mois
   courant — jamais d'erreur qui distinguerait « mauvais paramètre » de
   « mauvais token ». */
function buildPeriod(q) {
  const mode = MODE_RE.test(q.mode) ? q.mode : 'month';
  if (mode === 'day' && DAY_RE.test(q.day)) return Core.periodDay(q.day);
  if (mode === '7d') return Core.periodPreset(7);
  if (mode === '30d') return Core.periodPreset(30);
  if (mode === 'custom' && DAY_RE.test(q.from) && DAY_RE.test(q.to) && q.from <= q.to) {
    const P = Core.periodCustom(q.from, q.to);
    const days = Math.round((P.end.getTime() - P.start.getTime()) / 86400000) + 1;
    /* Plage trop large : on la ramène à MAX_RANGE_DAYS en gardant la fin
       demandée. Mieux qu'un timeout silencieux côté agence. */
    if (days > MAX_RANGE_DAYS) {
      const s = new Date(P.end.getTime() - (MAX_RANGE_DAYS - 1) * 86400000);
      return Core.periodCustom(Core.isoDate(s), Core.isoDate(P.end));
    }
    return P;
  }
  if (mode === 'month' && MONTH_RE.test(q.month)) {
    const p = q.month.split('-');
    return Core.periodMonth(+p[0], +p[1] - 1);
  }
  const now = new Date();
  return Core.periodMonth(now.getFullYear(), now.getMonth());
}

/* Les MONTHS_LISTED derniers mois calendaires — sert à peupler le sélecteur
   de mois côté agence. Aucune requête Firestore : la liste ne dépend que du
   calendrier, et un mois sans activité s'affiche naturellement à zéro. */
function recentMonths() {
  const out = [];
  const now = new Date();
  for (let i = 0; i < MONTHS_LISTED; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(d.getFullYear() + '-' + Core.pad2(d.getMonth() + 1));
  }
  return out;
}

/* Cache mémoire par instance de lambda. On met en cache les DONNÉES CHARGÉES
   (la partie coûteuse), pas les KPIs : le calcul par tunnel est instantané
   et computeKpis() est rejouable sur les mêmes données — c'est exactement ce
   que fait le sélecteur de tunnel du funnel interne. */
const cache = new Map();
async function loadPeriodData(P) {
  const key = Core.isoDate(P.start) + '|' + Core.isoDate(P.end);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.res;
  const res = await Core.loadAll(db, { P });
  cache.set(key, { at: Date.now(), res });
  /* Bornage trivial : une instance ne garde que quelques périodes. */
  if (cache.size > 8) cache.delete(cache.keys().next().value);
  return res;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    res.status(405).json({ ok: false });
    return;
  }

  const q = req.query || {};
  const token = typeof q.t === 'string' ? q.t : '';
  const tunnel = TUNNEL_RE.test(q.tunnel) ? q.tunnel : 'all';
  const P = buildPeriod(q);
  const info = { mode: P.mode, from: Core.isoDate(P.start), to: Core.isoDate(P.end), tunnel };

  try {
    const cfgSnap = await db.collection('_config').doc('agency_access').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;

    if (!cfg || cfg.active !== true || !tokenMatches(cfg.token, token)) {
      await logAccess(req, false, info);
      res.status(403).json({ ok: false });
      return;
    }

    const [loaded, instagram] = await Promise.all([
      loadPeriodData(P),
      loadInstagram(P),
    ]);
    const k = Core.computeKpis({
      DATA: loaded.DATA,
      P,
      tunnelFilter: tunnel,
      teamMembers: loaded.teamMembers,
    });

    await logAccess(req, true, info);

    res.status(200).json({
      ok: true,
      mode: P.mode,
      tunnel,
      from: info.from,
      to: info.to,
      month: P.mode === 'month' ? info.from.slice(0, 7) : null,
      day: P.mode === 'day' ? info.from : null,
      months: recentMonths(),
      computedAt: Date.now(),
      k: sanitizeK(k),
      instagram: instagram,
      journal: sanitizeJournal(loaded.DATA.journalPeriod),
    });
  } catch (e) {
    console.error('[agency-funnel]', e && e.message);
    res.status(500).json({ ok: false });
  }
};

/* Le chargement complet d'une grande période (jusqu'à 6000 leads + 5000
   appels) dépasse largement les 10 s par défaut. */
module.exports.config = { maxDuration: 60 };
