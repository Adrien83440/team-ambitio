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
//         computedAt:<ms>, k, alertes:[…], instagram, facebook, journal }
//         k        = K de funnel-core.js PASSÉ PAR LA LISTE BLANCHE
//                    (AGENCY_K_FIELDS) : seuls les champs que la page lit.
//         alertes  = phrases fixes (lecture en échec, liste tronquée) écrites
//                    ICI : jamais le texte brut d'une erreur Firestore, qui
//                    peut contenir un chemin de document ou un identifiant.
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
//   l'extérieur : l'assainissement (LISTE BLANCHE AGENCY_K_FIELDS ci-dessous,
//   champ par champ, y compris dans les tableaux d'objets) s'y fait, et nulle
//   part ailleurs. Un champ ajouté plus tard à K ne sort PAS par défaut.
// - Chaque accès (accepté comme refusé) est journalisé dans audit_log.
// ============================================================================

/* Fuseau : les bornes de période viennent de FunnelCore.period* (heure de
   Paris, calculée explicitement — référentiel §7), les clés de jour et de
   mois de StatsCore.jourParis / moisParis. Aucune date n'est construite ici
   à l'heure locale. La ligne ci-dessous n'est qu'une ceinture pour un code
   tiers qui lirait encore l'heure locale : Vercel tourne en UTC. */
process.env.TZ = 'Europe/Paris';

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const SC = require('../stats-core.js');
const Core = require('../funnel-core.js');

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TUNNEL_RE = /^(all|elite|business)$/;
const MODE_RE = /^(month|day|7d|30d|custom)$/;
const MONTHS_LISTED = 12;
const MAX_RANGE_DAYS = 92;      // garde-fou de charge sur les plages libres
const CACHE_TTL_MS = 120 * 1000;
/* Plafonds de lecture des réseaux sociaux : atteints → « liste tronquée ». */
const IG_MEDIA_LIMIT = 500;
const IG_DAYS_LIMIT = 400;
const DM_LIMIT = 3000;
const FB_POSTS_LIMIT = 500;

/* ⚠ CONTRAT DE DONNÉES — LISTE BLANCHE (audit du 25/11/2026, TRA-07 / COU-07 /
   SEC-01). Avant : une liste NOIRE retirait quelques champs connus, et tout
   champ ajouté plus tard à K sortait par défaut (délais par setter avec son
   prénom, coût interne du setting par soustraction, listes nominatives des
   closes…). Désormais ne sortent QUE les champs ci-dessous, relevés dans
   agency-funnel.html et funnel-pages-table.js (les deux seuls lecteurs), et
   les tableaux d'objets sont filtrés champ par champ.
   Notation : 1 = valeur simple (nombre, booléen, texte, null) ; { … } = objet
   dont seuls les champs nommés sortent ; [ spec ] = tableau dont chaque
   élément suit spec ; { '*': spec } = table à clés libres (clés contrôlées).
   C'est l'absence totale de donnée personnelle et de coût interne dans la
   réponse qui rend l'accès externe conforme (RGPD) sans contrat de
   sous-traitance de données : AVANT d'ajouter un champ ici, vérifier qu'il ne
   porte ni nom (lead, client, membre), ni e-mail, ni téléphone, ni slug de
   membre, ni coût du setting, commission ou délai par personne. */
const AB = 1;
/* Cellule d'une page du tunnel (funnel-core.js, vslCell / zero) : RDV pris
   depuis la page, présents, RDV closés, et les Closes / Contracté / Collecté
   de la liste unique rangés sur la page. */
const PAGE_CELL = { views: AB, ctas: AB, leads: AB, bookings: AB, present: AB, rdvCloses: AB, closes: AB, con: AB, col: AB };
function cellPlus(extra) { return Object.assign({}, PAGE_CELL, extra); }
/* Agrégat StatsCore (k.tenue*) : seuls les compteurs affichés. */
const TENUE = { rdv: AB, annules: AB, noshow: AB, presents: AB, pitches: AB, disqua: AB, sansDetail: AB,
  offres: AB, nonCloses: AB, aStatuer: AB, aVenir: AB, kept: AB, keptPct: AB, showUp: AB, tauxPitch: AB };
/* Chaînes de RDV pris (k.chAll / chSB / chNB). */
const CHAINE = { n: AB, sansSuite: AB, cancelled: AB, noshow: AB, present: AB, disqua: AB, pitched: AB, offres: AB,
  closesOc: AB, nonCloses: AB, sansDetail: AB, aStatuer: AB, aVenir: AB, kept: AB, keptPct: AB, showUp: AB, tauxPitch: AB };
/* Totaux de la liste unique des closes (FunnelCore.sumCloses) : des sommes,
   jamais les lignes (k.closeRows est nominatif). */
const CLOSES = { closes: AB, con: AB, paid: AB, pending: AB, reste: AB, panier: AB, collecteParClose: AB, sansPaiement: AB };
const TAUX = { rdv: AB, presents: AB, pitches: AB };
const TUNNELS = { elite: AB, business: AB };
/* Ligne du tableau « Performance publicitaire » : agrégats par pub / adset /
   campagne / canal. adIdList, caKnown, faux, disq, neverReached… ne sont pas
   lus par la page : ils ne sortent pas. */
const UTM_ROW = { key: AB, legacy: AB, outOfAds: AB, leads: AB, scoreSum: AB, scoreN: AB, qual: AB,
  booked: AB, cancelled: AB, noshow: AB, pitched: AB, closes: AB, con: AB, col: AB, spend: AB, hasSpend: AB, cpl: AB, roas: AB };
const UTM_UNATTR = { booked: AB, cancelled: AB, noshow: AB, pitched: AB, closes: AB };
const UTM_AXES = ['creative', 'adset', 'campaign', 'channel'];
function parAxe(spec) { const o = {}; UTM_AXES.forEach((ax) => { o[ax] = spec; }); return o; }

const AGENCY_K_FIELDS = {
  /* Leads */
  leads: AB, reoptins: AB, leadsTest: AB, reoptinsEcartes: AB, leadsAds: AB,
  leadsByTunnel: TUNNELS, bookedByTunnel: TUNNELS, bookedNoTunnel: AB,
  /* Ligne 1 — RDV pris (axe création) */
  chAll: CHAINE, chSB: CHAINE, chNB: CHAINE,
  /* Ligne 2 — RDV de la période (axe date du RDV) */
  rdvMois: AB, rdvSB: AB, rdvNB: AB, rdvMan: AB,
  kept: AB, keptSB: AB, keptNB: AB, keptMan: AB, keptPct: AB,
  dueCancelled: AB, dueNoShow: AB, dueUpcoming: AB, dueRescheduled: AB, dueCreatedBefore: AB, dueReplacement: AB,
  showUp: AB, showUpSB: AB, showUpNB: AB, showUpMan: AB,
  tenue: TENUE, tenueSB: TENUE, tenueNB: TENUE, tenueMan: TENUE,
  /* Closes et montants — totaux de la liste unique */
  closes: CLOSES, closesSB: CLOSES, closesNB: CLOSES, closesCancelled: AB,
  resteAEncaisser: AB, panierMoyen: AB, collecteParClose: AB,
  tauxClose: TAUX, tauxCloseSB: TAUX, tauxCloseNB: TAUX,
  /* Setting (NB) — leads reçus et récupération (comptes, jamais par personne) */
  leadsNbRecus: AB, leadsNbRecusNonTravailles: AB, cohortSetter: AB, recovery: AB,
  /* Publicité */
  hasAds: AB, spend: AB, impressions: AB, clicks: AB, cpm: AB, ctr: AB, cpc: AB, cpl: AB, cplAds: AB,
  adsDays: AB, adsDaysCovered: AB, adsDaysExpected: AB, adsSpendOk: AB,
  views: AB, optinReal: AB, optinLeads: AB, optinClicks: AB,
  roasAds: AB, collecteSurDepense: AB, wonCollecteAds: AB, wonCollecteHorsPub: AB, wonCollecteNonRattache: AB,
  cacAds: AB, closesWonAds: AB,
  cprSB: AB, cprKept: AB, cprLive: AB, cprOffre: AB,
  abTests: [{ page: AB, variants: [{ variant: AB, views: AB, optins: AB }] }],
  /* Pages du tunnel (funnel-pages-table.js) */
  vslActive: AB, vslViews: AB, vslCtas: AB, vslCtaRate: AB, vslLeads: AB, vslBookings: AB, vslBookRate: AB,
  vslPresent: AB, vslCpr: AB, vslCloses: AB, vslContracte: AB, vslCollecte: AB,
  vslClosesAutresPages: AB, vslClosesNonRattaches: AB,
  vslLabels: { '*': AB },
  vslFunnels: [cellPlus({ slug: AB, name: AB, kind: AB,
    steps: [cellPlus({ page: AB, slug: AB, name: AB, type: AB, order: AB, orphan: AB,
      variants: [cellPlus({ id: AB, label: AB, weight: AB, status: AB })] })] })],
  vslLegacy: [cellPlus({ page: AB, label: AB })],
  vslLegacyTotals: PAGE_CELL,
  /* Performance publicitaire */
  utmRowsByAxis: parAxe([UTM_ROW]), utmUnattrByAxis: parAxe(UTM_UNATTR),
  attributedPct: AB, attributedLeads: AB, creativeIndexSize: AB,
  hasAdLevelSpend: AB, adSpendComplete: AB, adSpendDaysCovered: AB, adSpendDaysExpected: AB,
};

/* ⛔ JAMAIS — garde-fou : ces champs de K sont nominatifs (noms de leads, de
   clients, de membres, listes cliquables, contrôle de cohérence) ou internes
   (coût du setting, commissions, délais et appels par personne). Si l'un
   d'eux est ajouté par erreur à la liste blanche, le module refuse de se
   charger (erreur au déploiement plutôt qu'une fuite silencieuse). */
const AGENCY_NEVER = [
  'closeRows', 'drill', 'coh', 'collecteMissingNames', 'closesCancelledNames', 'payCloseNames', 'payCloseOther',
  'statutsSetSansRdvListe', 'actWorkedBySlug', 'ltsByUser', 'callsByUser', 'erreursLecture',
  'commSetting', 'commSettingN', 'commSettingSB', 'commSettingNB', 'commSettingOk', 'commSettingSbInconnu',
  'costFixe', 'costOutils', 'costConfigured', 'costSrcMonth', 'costOwnEntry', 'costSetting', 'costPerRdvNB',
  'costPerRdvNBBase', 'costFiltered', 'costDaysDone', 'costDaysElapsed', 'costDaysTotal',
  'coutTotal', 'roasGlobal', 'margeGlobale', 'roasPubSetting', 'margeAvantClosing',
];
AGENCY_NEVER.forEach((f) => {
  if (Object.prototype.hasOwnProperty.call(AGENCY_K_FIELDS, f)) {
    throw new Error('[agency-funnel] champ interdit dans la liste blanche : ' + f);
  }
});

/* Clés libres d'une table (k.vslLabels) : identifiant de page seulement. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,80}$/;

/* Applique une spécification de la liste blanche. Renvoie undefined pour ce
   qui ne doit pas sortir (type inattendu compris : un objet là où un nombre
   est attendu ne passe pas). */
function pickSpec(v, spec) {
  if (spec === AB) {
    if (v === null || typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string') return v;
    return undefined;
  }
  if (Array.isArray(spec)) {
    if (!Array.isArray(v)) return undefined;
    return v.map((x) => pickSpec(x, spec[0])).filter((x) => x !== undefined);
  }
  if (spec && typeof spec === 'object') {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = {};
    if (spec['*'] !== undefined) {
      Object.keys(v).forEach((key) => {
        if (!SAFE_KEY.test(key)) return;
        const r = pickSpec(v[key], spec['*']);
        if (r !== undefined) out[key] = r;
      });
      return out;
    }
    Object.keys(spec).forEach((f) => {
      if (!Object.prototype.hasOwnProperty.call(v, f)) return;
      const r = pickSpec(v[f], spec[f]);
      if (r !== undefined) out[f] = r;
    });
    return out;
  }
  return undefined;
}

/* ⚠ INSTAGRAM — LISTE BLANCHE, pas liste noire.
   Le reste du fichier assainit K en retirant des champs connus ; ici on fait
   l'inverse et c'est délibéré. Les collections ig_* portent des données
   PERSONNELLES DE TIERS — pseudo d'un commentateur, identifiant de
   conversation, contenu de message privé — qui n'ont rien à faire hors de
   la maison, et une whitelist est la seule forme qui reste sûre quand un
   champ est ajouté plus tard sans que personne ne repense à ce fichier.
   Ne sortent donc QUE des mesures d'audience de publications publiques.

   NE SORTENT JAMAIS, et ce n'est pas un oubli :
   · le PSEUDO d'un commentateur ou d'un interlocuteur — donnée personnelle
     d'un tiers, qui n'apporte rien à une lecture de performance ;
   · le CONTENU d'un message privé — jamais lu, jamais transmis.

   Les métriques de messagerie, elles, SONT exposées (décision d'Adrien du
   01/09/2026 : l'agence a déjà accès au compte Instagram lui-même). Elles
   sont agrégées ICI, côté serveur : ig_dm_threads porte des pseudos, des
   identifiants de conversation et des noms de leads, et ces documents ne
   quittent jamais la maison — seuls des nombres sortent. */
const AGENCY_IG_MEDIA_FIELDS = [
  'date', 'timestamp', 'mediaType', 'mediaProductType', 'isReel',
  'caption', 'permalink', 'thumbnailUrl',
  'reach', 'views', 'likes', 'comments', 'saved', 'shares',
  'totalInteractions', 'engagementRate', 'avgWatchTimeMs',
  'goCount', 'goUniques', 'goLeads',
];
const AGENCY_IG_ACCOUNT_FIELDS = [
  'date', 'followers', 'reach', 'views', 'profileViews',
  'websiteClicks', 'accountsEngaged', 'totalInteractions',
];

/* Facebook — même doctrine de liste blanche que pour Instagram, et pour la
   même raison : fb_comments porte le NOM d'un commentateur et fb_dm_threads
   celui d'un interlocuteur. Seules des mesures d'audience sortent. */
const AGENCY_FB_POST_FIELDS = [
  'date', 'timestamp', 'message', 'permalink', 'thumbnailUrl',
  'isVideo', 'mediaType', 'statusType',
  'reach', 'impressions', 'reactions', 'comments', 'shares', 'clicks',
  'videoViews', 'totalInteractions', 'engagementRate',
  'goCount', 'goUniques', 'goLeads',
];
const AGENCY_FB_PAGE_FIELDS = [
  'date', 'followers', 'fans', 'fanCount',
  'reach', 'impressions', 'engagements', 'pageViews',
  'videoViews', 'nouveauxAbonnes',
];

function pickFields(src, champs) {
  const out = {};
  champs.forEach((f) => { if (src[f] !== undefined) out[f] = src[f]; });
  return out;
}

function mediane(arr) {
  if (!arr.length) return null;
  const a = arr.slice().sort((x, y) => x - y);
  const m = Math.floor(a.length / 2);
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
}

/* Messagerie privée — AGRÉGATS SEULEMENT.
   Les documents ig_dm_threads portent le pseudo de l'interlocuteur, son
   identifiant de conversation et parfois le nom du lead rattaché. Ils sont
   lus ici et réduits à des nombres avant de sortir : rien de nominatif ne
   traverse cette fonction, et il n'existe aucun chemin qui renverrait un
   thread brut.
   Deux populations distinctes, jamais mélangées : les conversations que
   NOUS ouvrons (« ont-ils répondu ? ») et celles qu'ILS ouvrent (« avons-
   nous répondu, et en combien de temps ? »). Un taux unique sur les deux
   ne voudrait rien dire. */
async function loadInstagramDm(P) {
  const a = Core.isoDate(P.start);
  const b = Core.isoDate(P.end);
  try {
    const snap = await db.collection('ig_dm_threads')
      .where('firstEventDate', '>=', a).where('firstEventDate', '<=', b)
      .limit(DM_LIMIT).get();

    const o = { conversations: snap.size, tronque: snap.size >= DM_LIMIT, sortants: 0, entrants: 0,
                initiesNous: 0, repondus: 0, tauxReponse: null,
                delaiMedianMs: null, initiesEux: 0, notreDelaiMedianMs: null,
                rattacheesFiche: 0 };
    const delais = [];
    const nos = [];

    snap.forEach((doc) => {
      const t = doc.data() || {};
      o.sortants += Number(t.outboundCount) || 0;
      o.entrants += Number(t.inboundCount) || 0;
      if (t.leadId) o.rattacheesFiche++;
      if (t.initiatedBy === 'us') {
        o.initiesNous++;
        if (t.replied === true) {
          o.repondus++;
          if (t.responseDelayMs != null) delais.push(Number(t.responseDelayMs));
        }
      } else if (t.initiatedBy === 'them') {
        o.initiesEux++;
        if (t.ourReplyDelayMs != null) nos.push(Number(t.ourReplyDelayMs));
      }
    });

    if (o.initiesNous > 0) o.tauxReponse = (o.repondus / o.initiesNous) * 100;
    o.delaiMedianMs = mediane(delais);
    o.notreDelaiMedianMs = mediane(nos);
    return JSON.parse(JSON.stringify(o));
  } catch (e) {
    console.warn('[agency-funnel] dm indisponible:', e && e.message);
    return null;
  }
}

/* Publications et audience du compte sur la période. Aucune lecture de
   ig_comments : le contenu et l'auteur d'un commentaire ne sortent pas. */
async function loadInstagram(P) {
  const a = Core.isoDate(P.start);
  const b = Core.isoDate(P.end);
  try {
    const [snapMedia, snapAcc] = await Promise.all([
      db.collection('ig_media').where('date', '>=', a).where('date', '<=', b).limit(IG_MEDIA_LIMIT).get(),
      db.collection('ig_account_daily').where('date', '>=', a).where('date', '<=', b).limit(IG_DAYS_LIMIT).get(),
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
      /* Plafond de lecture atteint : dit à l'écran (« liste tronquée »). */
      tronque: snapMedia.size >= IG_MEDIA_LIMIT || snapAcc.size >= IG_DAYS_LIMIT,
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

/* Publications et audience de la Page. Aucune lecture de fb_comments :
   le nom d'un commentateur ne sort pas. */
async function loadFacebook(P) {
  const a = Core.isoDate(P.start);
  const b = Core.isoDate(P.end);
  try {
    const [snapPosts, snapPage, snapDm] = await Promise.all([
      db.collection('fb_posts').where('date', '>=', a).where('date', '<=', b).limit(FB_POSTS_LIMIT).get(),
      db.collection('fb_page_daily').where('date', '>=', a).where('date', '<=', b).limit(IG_DAYS_LIMIT).get(),
      db.collection('fb_dm_threads').where('firstEventDate', '>=', a).where('firstEventDate', '<=', b).limit(DM_LIMIT).get(),
    ]);

    const posts = snapPosts.docs
      .map((d) => pickFields(d.data() || {}, AGENCY_FB_POST_FIELDS))
      .sort((x, y) => String(y.timestamp || y.date || '').localeCompare(String(x.timestamp || x.date || '')));

    const jours = snapPage.docs
      .map((d) => pickFields(d.data() || {}, AGENCY_FB_PAGE_FIELDS))
      .sort((x, y) => String(x.date || '').localeCompare(String(y.date || '')));

    const tot = { reach: 0, impressions: 0, engagements: 0, pageViews: 0,
                  videoViews: 0, nouveauxAbonnes: 0 };
    let fin = null;
    let debut = null;
    jours.forEach((d) => {
      Object.keys(tot).forEach((f) => { tot[f] += Number(d[f]) || 0; });
      const f = d.followers != null ? d.followers : (d.fans != null ? d.fans : null);
      if (f != null) { if (debut === null) debut = f; fin = f; }
    });

    /* Messenger — agrégats seulement, calculés ici : fb_dm_threads porte le
       nom de l'interlocuteur et parfois celui du lead rattaché, et aucun de
       ces documents ne sort. Seuls des nombres traversent. */
    const dm = { conversations: snapDm.size, tronque: snapDm.size >= DM_LIMIT, sortants: 0, entrants: 0,
                 initiesNous: 0, repondus: 0, tauxReponse: null,
                 delaiMedianMs: null, initiesEux: 0, notreDelaiMedianMs: null,
                 rattacheesFiche: 0 };
    const d1 = [];
    const d2 = [];
    snapDm.forEach((doc) => {
      const t = doc.data() || {};
      dm.sortants += Number(t.outboundCount) || 0;
      dm.entrants += Number(t.inboundCount) || 0;
      if (t.leadId) dm.rattacheesFiche++;
      if (t.initiatedBy === 'us') {
        dm.initiesNous++;
        if (t.replied === true) {
          dm.repondus++;
          if (t.responseDelayMs != null) d1.push(Number(t.responseDelayMs));
        }
      } else if (t.initiatedBy === 'them') {
        dm.initiesEux++;
        if (t.ourReplyDelayMs != null) d2.push(Number(t.ourReplyDelayMs));
      }
    });
    if (dm.initiesNous > 0) dm.tauxReponse = (dm.repondus / dm.initiesNous) * 100;
    dm.delaiMedianMs = mediane(d1);
    dm.notreDelaiMedianMs = mediane(d2);

    return JSON.parse(JSON.stringify({
      jours: jours.length,
      tronque: snapPosts.size >= FB_POSTS_LIMIT || snapPage.size >= IG_DAYS_LIMIT,
      page: Object.assign({}, tot, {
        followers: fin,
        followersDelta: (debut !== null && fin !== null && jours.length > 1) ? fin - debut : null,
      }),
      publications: posts,
      dm: dm,
    }));
  } catch (e) {
    console.warn('[agency-funnel] facebook indisponible:', e && e.message);
    return null;
  }
}

function sanitizeK(k) {
  const out = pickSpec(k || {}, AGENCY_K_FIELDS) || {};
  /* JSON round-trip : supprime les undefined et transforme NaN/Infinity en
     null — la page agence affiche « — » pour tout null. */
  return JSON.parse(JSON.stringify(out));
}

/* Lectures en échec ou tronquées (référentiel P7 : jamais un zéro muet).
   Phrases FIXES, écrites ici : k.erreursLecture embarque le texte brut des
   erreurs Firestore (chemin de document, identifiant de membre) et parle de
   données internes (coûts, commissions, journal d'actions, appels) — il ne
   sort pas. Seules les lectures qui touchent un chiffre de la page Agence
   sont signalées. */
function alertesLecture(DATA, extra) {
  const D = DATA || {};
  const out = [];
  if (extra && extra.typesErreur) out.push('Types de RDV illisibles : la répartition Self Booking / Setting (NB) peut être fausse.');
  if (D.bookingsError) out.push('Les RDV n’ont pas pu être lus : RDV, Kept, Présents, Pitchés et RDV pris sont incomplets.');
  if (D.chainsTruncated) out.push('Certaines chaînes de reports sont trop longues : le résultat de leur dernier RDV peut manquer (RDV pris).');
  if (D.closedLeadsError) out.push('Les clients gagnés n’ont pas pu être lus : Closes, Contracté et Collecté sont incomplets.');
  if (D.closedLeadsTruncated) out.push('Liste des clients gagnés tronquée (plafond de lecture atteint) : Closes, Contracté et Collecté sont sous-estimés. Réduis la période.');
  if (D.paymentsError) out.push('Le module Paiements n’a pas pu être lu : le Contracté affiché est le tarif déclaré au close, le Collecté est à 0, et les closes repérés par le seul paiement manquent.');
  if (D.closeBookingsError) out.push('Les RDV des closes n’ont pas pu être lus : la répartition Self Booking / Setting (NB) des closes peut être fausse.');
  if (D.leadsError) out.push('Les leads n’ont pas pu être lus : Leads, LTB, CPL et tout ce qui se calcule par lead sont à zéro ou incomplets.');
  if (D.leadsTruncated) out.push('Liste des leads tronquée (plafond de lecture atteint) : Leads, LTB et CPL sont faux. Réduis la période.');
  if (D.reoptinsError) out.push('Les ré-optins n’ont pas pu être lus : Ré-optins à zéro.');
  if (D.reoptinsTruncated) out.push('Liste des ré-optins tronquée (plafond de lecture atteint) : Ré-optins sous-estimés. Réduis la période.');
  if (D.adsError) out.push('La dépense pub n’a pas pu être lue : Dépense, CPL, CPR, CAC et ROAS pub ne sont pas fiables.');
  if (D.adsByAdError) out.push('La dépense par pub n’a pas pu être lue : coûts par créative masqués.');
  if (D.viewsError) out.push('Les visites des pages n’ont pas pu être lues : Vues et taux d’opt-in à zéro.');
  if (D.creativesError) out.push('Le référentiel des pubs n’a pas pu être lu : certaines pubs restent affichées par leur identifiant.');
  if (extra) {
    if (extra.instagram === null) out.push('Instagram : lecture impossible pour le moment, section masquée.');
    else if (extra.instagram && extra.instagram.tronque) out.push('Instagram : plus de ' + IG_MEDIA_LIMIT + ' publications ou ' + IG_DAYS_LIMIT + ' jours sur la période, liste tronquée. Réduis la période.');
    if (extra.instagram && extra.instagramDm === null) out.push('Instagram : messages privés illisibles pour le moment, bloc masqué.');
    else if (extra.instagramDm && extra.instagramDm.tronque) out.push('Instagram : plus de ' + DM_LIMIT + ' conversations sur la période, chiffres des messages privés sous-estimés.');
    if (extra.facebook === null) out.push('Facebook : lecture impossible pour le moment, section masquée.');
    else if (extra.facebook && extra.facebook.tronque) out.push('Facebook : plus de ' + FB_POSTS_LIMIT + ' publications ou ' + IG_DAYS_LIMIT + ' jours sur la période, liste tronquée. Réduis la période.');
    if (extra.facebook && extra.facebook.dm && extra.facebook.dm.tronque) out.push('Facebook : plus de ' + DM_LIMIT + ' conversations Messenger sur la période, chiffres sous-estimés.');
  }
  return out;
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

/* Jour calendaire réel (« 2026-02-31 » refusé) : calcul pur sur des clés
   AAAA-MM-JJ, sans fuseau. */
function vraiJour(iso) {
  if (!DAY_RE.test(iso || '')) return false;
  const p = iso.split('-');
  return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])).toISOString().slice(0, 10) === iso;
}

/* Mois de Paris d'aujourd'hui → [année, mois 0-11]. */
function moisParisCourant() {
  const p = SC.moisParis(new Date()).split('-');
  return [+p[0], +p[1] - 1];
}

/* Construit la période demandée. Toute valeur malformée retombe sur le mois
   courant — jamais d'erreur qui distinguerait « mauvais paramètre » de
   « mauvais token ». Bornes : FunnelCore.period* (heure de Paris), comme le
   Stats funnel interne. Renvoie aussi `reduite` quand une plage trop large a
   été ramenée à MAX_RANGE_DAYS (dit à l'écran). */
function buildPeriod(q) {
  const mode = MODE_RE.test(q.mode) ? q.mode : 'month';
  if (mode === 'day' && vraiJour(q.day)) return { P: Core.periodDay(q.day), reduite: false };
  if (mode === '7d') return { P: Core.periodPreset(7), reduite: false };
  if (mode === '30d') return { P: Core.periodPreset(30), reduite: false };
  if (mode === 'custom' && vraiJour(q.from) && vraiJour(q.to) && q.from <= q.to) {
    /* Jours calendaires de la plage (clés AAAA-MM-JJ, sans fuseau : un
       changement d'heure ne décale rien). Plage trop large : ramenée aux
       MAX_RANGE_DAYS derniers jours demandés — mieux qu'un timeout silencieux
       côté agence, et dit à l'écran. */
    const jours = Core.joursEntre(q.from, q.to);
    if (jours.length > MAX_RANGE_DAYS) {
      return { P: Core.periodCustom(jours[jours.length - MAX_RANGE_DAYS], q.to), reduite: true };
    }
    return { P: Core.periodCustom(q.from, q.to), reduite: false };
  }
  if (mode === 'month' && MONTH_RE.test(q.month)) {
    const p = q.month.split('-');
    const m0 = +p[1] - 1;
    if (m0 >= 0 && m0 <= 11) return { P: Core.periodMonth(+p[0], m0), reduite: false };
  }
  const cur = moisParisCourant();
  return { P: Core.periodMonth(cur[0], cur[1]), reduite: false };
}

/* Les MONTHS_LISTED derniers mois calendaires de Paris — sert à peupler le
   sélecteur de mois côté agence. Aucune requête Firestore : la liste ne
   dépend que du calendrier, et un mois sans activité s'affiche à zéro. */
function recentMonths() {
  const out = [];
  const cur = moisParisCourant();
  const base = cur[0] * 12 + cur[1];
  for (let i = 0; i < MONTHS_LISTED; i++) {
    const n = base - i;
    out.push(Math.floor(n / 12) + '-' + Core.pad2((n % 12) + 1));
  }
  return out;
}

/* Table des types de RDV : lue ICI pour que son échec soit DIT (le chargeur
   de funnel-core.js l'avale et classe alors tout RDV au repli). */
async function loadTypes() {
  try {
    const snap = await db.collection('booking_config').doc('_types').get();
    return { map: Core.buildTypeMap((snap.exists && (snap.data() || {}).list) || []), erreur: false };
  } catch (e) {
    console.warn('[agency-funnel] types illisibles:', e && e.message);
    return { map: null, erreur: true };
  }
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
  const types = await loadTypes();
  const opts = { P };
  if (types.map) opts.typeMap = types.map;
  const res = await Core.loadAll(db, opts);
  res.typesErreur = types.erreur;
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
  const per = buildPeriod(q);
  const P = per.P;
  const info = { mode: P.mode, from: Core.isoDate(P.start), to: Core.isoDate(P.end), tunnel };

  try {
    const cfgSnap = await db.collection('_config').doc('agency_access').get();
    const cfg = cfgSnap.exists ? cfgSnap.data() : null;

    if (!cfg || cfg.active !== true || !tokenMatches(cfg.token, token)) {
      await logAccess(req, false, info);
      res.status(403).json({ ok: false });
      return;
    }

    const [loaded, instagram, instagramDm, facebook] = await Promise.all([
      loadPeriodData(P),
      loadInstagram(P),
      loadInstagramDm(P),
      loadFacebook(P),
    ]);
    if (instagram) instagram.dm = instagramDm;
    const k = Core.computeKpis({
      DATA: loaded.DATA,
      P,
      tunnelFilter: tunnel,
      teamMembers: loaded.teamMembers,
      typeMap: loaded.typeMap,
    });
    const alertes = alertesLecture(loaded.DATA, {
      typesErreur: loaded.typesErreur, instagram, instagramDm, facebook,
    });
    if (per.reduite) {
      alertes.unshift('Plage ramenée aux ' + MAX_RANGE_DAYS + ' derniers jours demandés (du ' + info.from.split('-').reverse().join('/')
        + ' au ' + info.to.split('-').reverse().join('/') + ') : au-delà, le calcul serait trop long.');
    }

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
      alertes: alertes,
      instagram: instagram,
      facebook: facebook,
      journal: sanitizeJournal(loaded.DATA.journalPeriod),
    });
  } catch (e) {
    console.error('[agency-funnel]', e && e.message);
    res.status(500).json({ ok: false });
  }
};

/* Le chargement complet d'une grande période (leads, RDV, appels lus par
   pages) dépasse largement les 10 s par défaut. */
module.exports.config = { maxDuration: 60 };
/* Pour les tests (node) : la liste blanche et son application. */
module.exports._test = { AGENCY_K_FIELDS, AGENCY_NEVER, sanitizeK, pickSpec, alertesLecture, buildPeriod, recentMonths,
  viderCache: () => cache.clear() };
