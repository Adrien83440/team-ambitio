// ============================================================================
// api/instagram-sync-cron.js
// ----------------------------------------------------------------------------
// Synchronisation quotidienne des INSIGHTS INSTAGRAM → Firestore, pour
// l'onglet 📸 Instagram du Funnel Sales (sales-funnel.html).
//
// URL  : GET|POST https://team.alteore.com/api/instagram-sync-cron
//        [?days=3] [?mediaDays=30] [?comments=1] [?dry=1]
// Auth : 2 modes acceptés, identiques à api/ringover-sync-cron.js —
//        • Authorization: Bearer <CRON_SECRET>   (Vercel Cron l'envoie seul)
//        • x-api-key: <CRON_SECRET>              (test manuel via curl)
// Cron : voir vercel.json — tous les jours 04:40 UTC.
//
// ─── CE QU'IL ÉCRIT ───────────────────────────────────────────────────
//   ig_account_daily/{YYYY-MM-DD}      abonnés, portée, visites de profil…
//   ig_media/{mediaId}                 la publication + ses dernières métriques
//   ig_media_daily/{mediaId}_{date}    le même jeu, figé jour par jour
//   ig_comments/{commentId}            chaque commentaire + drapeau `isGo`
//
// ─── POURQUOI UN SNAPSHOT QUOTIDIEN DU COMPTE ─────────────────────────
// Les métriques « jour » du compte ne sont interrogeables que sur une fenêtre
// glissante d'environ 30 jours côté Meta. Passé ce délai, elles sont perdues
// pour toujours — aucun rattrapage n'est possible, quel que soit l'outil.
// C'est ce cron qui constitue l'historique long ; il n'existera nulle part
// ailleurs. Les publications, elles, restent interrogeables : leur rattrapage
// est faisable après coup (?days=60 au premier lancement).
//
// ─── POURQUOI UNE DÉGRADATION EN CASCADE SUR LES MÉTRIQUES ────────────
// Meta renomme et retire des métriques à chaque version d'API (`impressions`
// a laissé la place à `views`), et le jeu disponible dépend du type de
// publication : un Reel expose `avg_watch_time`, pas une image. Demander une
// métrique non supportée fait échouer TOUT l'appel, pas seulement le champ
// fautif. D'où le repli : liste riche, puis socle, puis rien — on préfère un
// tableau partiellement rempli à une synchro qui tombe en bloc chaque nuit.
//
// ─── IDEMPOTENCE ──────────────────────────────────────────────────────
// Tous les identifiants de documents sont déterministes ({date}, {mediaId},
// {mediaId}_{date}, {commentId}) : le cron est rejouable autant de fois qu'on
// veut, sans jamais créer de doublon. C'est ce qui rend le rattrapage sûr.
//
// ─── DÉPLOIEMENT ──────────────────────────────────────────────────────
//   1. Rules Firestore (blocs ig_*) déployées.
//   2. _config/instagram_credentials renseigné (igUserId, token, appId,
//      appSecret, verifyToken, apiVersion, keywords: ['go']).
//   3. Variable Vercel CRON_SECRET déjà en place (partagée avec les autres
//      crons) + vercel.json à jour.
//   4. Rattrapage initial :
//      curl -H "x-api-key: <CRON_SECRET>" \
//        "https://team.alteore.com/api/instagram-sync-cron?days=60&mediaDays=60"
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const IG = require('./_instagramClient');

/* Une exécution Vercel a 300 s (voir vercel.json). On s'arrête à 240 s pour
   avoir le temps d'écrire et de répondre : une synchro tuée en plein vol par
   le runtime ne dit jamais où elle en était. */
const BUDGET_MS = 240000;
const MAX_BATCH = 400;

/* Version de la logique de comptage des commentaires. À incrémenter à CHAQUE
   changement de ce qui est lu ou de ce qui compte comme « GO » : les
   publications dont la version stockée diffère sont recomptées au passage
   suivant, sans intervention. Sans ce marqueur, une correction du comptage
   ne s'appliquerait qu'aux nouvelles publications, et l'historique resterait
   faux — invisible, donc pire.
     1 → commentaires de premier niveau uniquement
     2 → réponses aux commentaires incluses (01/09/2026)
     3 → commentaires du compte lui-même exclus du comptage (01/09/2026)
     4 → auteur résolu via from{} quand username est absent (01/09/2026) */
const COMMENTS_VERSION = 4;

/* Métriques tentées par type de publication, de la plus riche à la plus
   pauvre. La dernière ligne est vide : on renonce aux insights et on garde
   like_count / comments_count, qui viennent du média lui-même et ne
   dépendent d'aucune permission d'insights. */
const METRIQUES_MEDIA = {
  REELS: [
    ['reach', 'likes', 'comments', 'saved', 'shares', 'views', 'total_interactions', 'avg_watch_time'],
    ['reach', 'likes', 'comments', 'saved', 'shares', 'views', 'total_interactions'],
    ['reach', 'likes', 'comments', 'saved', 'shares'],
  ],
  FEED: [
    ['reach', 'likes', 'comments', 'saved', 'shares', 'views', 'total_interactions'],
    ['reach', 'likes', 'comments', 'saved', 'shares', 'total_interactions'],
    ['reach', 'likes', 'comments', 'saved'],
  ],
};

/* Métriques compte tentées jour par jour, même principe de repli. */
const METRIQUES_COMPTE = [
  ['reach', 'profile_views', 'website_clicks', 'accounts_engaged', 'total_interactions', 'views'],
  ['reach', 'profile_views', 'website_clicks', 'accounts_engaged', 'total_interactions'],
  ['reach', 'profile_views', 'accounts_engaged'],
  ['reach'],
];

function nb(v) {
  const n = Number(v);
  return isFinite(n) ? n : 0;
}

/* ── Écriture par lots, sans jamais dépasser la limite Firestore ── */
function creerEcrivain() {
  let batch = db.batch();
  let n = 0;
  let total = 0;
  return {
    set(ref, data, opts) {
      batch.set(ref, data, opts || { merge: true });
      n++; total++;
      if (n >= MAX_BATCH) { const b = batch; batch = db.batch(); n = 0; return b.commit(); }
      return Promise.resolve();
    },
    async flush() { if (n > 0) { await batch.commit(); batch = db.batch(); n = 0; } return total; },
    get total() { return total; },
  };
}

/**
 * Appelle un endpoint d'insights en dégradant la liste de métriques jusqu'à
 * ce que Meta accepte. Retourne { data, metriques } ou null si tout a échoué.
 */
async function insightsAvecRepli(chemin, paramsBase, cascades, creds) {
  let derniereErreur = null;
  for (let i = 0; i < cascades.length; i++) {
    const metriques = cascades[i];
    if (!metriques.length) break;
    try {
      const params = Object.assign({}, paramsBase, { metric: metriques.join(',') });
      const json = await IG.graphGet(chemin, params, creds);
      return { data: Array.isArray(json.data) ? json.data : [], metriques };
    } catch (e) {
      derniereErreur = e;
      /* 190 = jeton mort, 4/17/32 = quota. Insister avec moins de métriques
         ne changerait rien et brûlerait le budget : on remonte. */
      if (e.metaCode === 190 || e.metaCode === 4 || e.metaCode === 17 || e.metaCode === 32) throw e;
    }
  }
  if (derniereErreur) console.warn('[instagram-sync] insights abandonnés', chemin, derniereErreur.message);
  return null;
}

/** Aplatit la réponse insights en { metrique: valeur }. */
function aplatirInsights(data) {
  const out = {};
  (data || []).forEach((m) => {
    if (!m || !m.name) return;
    if (m.total_value && m.total_value.value != null) { out[m.name] = nb(m.total_value.value); return; }
    if (Array.isArray(m.values) && m.values.length) {
      /* Série « day » : on prend la dernière valeur de la fenêtre demandée. */
      const v = m.values[m.values.length - 1];
      if (v && v.value != null) out[m.name] = nb(v.value);
    }
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   1. COMPTE — snapshot jour par jour
   ══════════════════════════════════════════════════════════════════════ */
async function syncCompte(creds, jours, ecrivain, rapport, deadline) {
  /* Profil : instantané, non historisé par Meta. Le nombre d'abonnés d'hier
     est irrécupérable — c'est ce snapshot qui le conserve. */
  let profil = {};
  try {
    profil = await IG.graphGet(creds.igUserId, {
      fields: 'user_id,username,name,followers_count,follows_count,media_count',
    }, creds);
  } catch (e) {
    rapport.erreurs.push('profil: ' + e.message);
    if (e.metaCode === 190) throw e;
  }

  /* En mode Instagram Login, `creds.igUserId` vaut « me » : on range en base
     l'identifiant réel renvoyé par le profil, sinon toutes les lignes
     porteraient la chaîne « me » et deviendraient inexploitables le jour où
     un deuxième compte arriverait. */
  const idReel = profil.user_id || profil.id || creds.igUserId;
  rapport.igUserId = idReel;
  rapport.username = profil.username || null;

  const aujourdhui = IG.jourParis();

  for (let i = 0; i < jours.length; i++) {
    if (Date.now() > deadline) { rapport.tronque = true; break; }
    const jour = jours[i];
    const b = IG.bornesJour(jour);

    /* Deux formes d'appel, dans cet ordre. Meta a déplacé une partie des
       métriques compte vers `metric_type=total_value`, mais pas toutes et pas
       à la même version : `reach` reste servi en série temporelle. Essayer la
       forme moderne puis retomber sur la forme historique évite d'écrire une
       journée entière de `null` parce qu'un seul paramètre a bougé. */
    let res = await insightsAvecRepli(creds.igUserId + '/insights', {
      period: 'day',
      metric_type: 'total_value',
      since: b.since,
      until: b.until,
    }, METRIQUES_COMPTE, creds);

    if (!res) {
      res = await insightsAvecRepli(creds.igUserId + '/insights', {
        period: 'day',
        since: b.since,
        until: b.until,
      }, METRIQUES_COMPTE, creds);
    }

    const m = res ? aplatirInsights(res.data) : {};
    if (!res) rapport.joursSansInsights = (rapport.joursSansInsights || 0) + 1;

    const doc = {
      date: jour,
      igUserId: idReel,
      reach: m.reach != null ? m.reach : null,
      views: m.views != null ? m.views : null,
      profileViews: m.profile_views != null ? m.profile_views : null,
      websiteClicks: m.website_clicks != null ? m.website_clicks : null,
      accountsEngaged: m.accounts_engaged != null ? m.accounts_engaged : null,
      totalInteractions: m.total_interactions != null ? m.total_interactions : null,
      source: 'api',
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    /* Le compteur d'abonnés est celui d'AUJOURD'HUI : ne l'écrire que sur le
       document du jour, sinon on antidaterait la photo actuelle sur tout le
       rattrapage et la courbe d'abonnés serait plate puis fausse. */
    if (jour === aujourdhui) {
      doc.followers = profil.followers_count != null ? nb(profil.followers_count) : null;
      doc.follows = profil.follows_count != null ? nb(profil.follows_count) : null;
      doc.mediaCount = profil.media_count != null ? nb(profil.media_count) : null;
      doc.username = profil.username || null;
    }

    await ecrivain.set(db.collection('ig_account_daily').doc(jour), doc);
    rapport.joursCompte++;
  }
  return profil;
}

/* ══════════════════════════════════════════════════════════════════════
   2. PUBLICATIONS
   ══════════════════════════════════════════════════════════════════════ */
async function listerMedias(creds, depuisIso, plafondPages) {
  const champs = [
    'id', 'caption', 'media_type', 'media_product_type', 'permalink',
    'thumbnail_url', 'media_url', 'timestamp', 'like_count', 'comments_count',
  ].join(',');

  const items = [];
  let page = await IG.graphGet(creds.igUserId + '/media', { fields: champs, limit: 50 }, creds);
  let n = 1;
  let stop = false;

  while (page && Array.isArray(page.data)) {
    for (let i = 0; i < page.data.length; i++) {
      const m = page.data[i];
      const jour = m.timestamp ? IG.jourParis(new Date(m.timestamp).getTime()) : null;
      /* Le flux média est trié du plus récent au plus ancien : dès qu'on
         passe sous la borne, tout le reste est hors fenêtre. */
      if (jour && jour < depuisIso) { stop = true; break; }
      items.push(Object.assign({}, m, { _jour: jour }));
    }
    if (stop || !page.paging || !page.paging.next || n >= (plafondPages || 12)) break;
    const rep = await fetch(page.paging.next);
    const txt = await rep.text();
    try { page = txt ? JSON.parse(txt) : null; } catch (_) { page = null; }
    if (!page || page.error) break;
    n++;
  }
  return items;
}

/* ══════════════════════════════════════════════════════════════════════
   3. COMMENTAIRES + COMPTAGE « GO »
   ══════════════════════════════════════════════════════════════════════ */
/* Champs des commentaires, du plus complet au plus pauvre.
   ─────────────────────────────────────────────────────────────────────
   L'edge /comments ne renvoie QUE les commentaires de premier niveau. Or
   sous un appel à l'action « écris GO », une partie des réponses arrive en
   RÉPONSE à un commentaire (souvent celui, épinglé, qui porte la consigne) —
   ces messages n'apparaissent nulle part dans la liste principale. Les
   compter à zéro, c'est déclarer qu'une publication n'a produit aucun
   signal alors qu'elle en a produit.
   D'où `replies{...}` demandé dans le même appel : une seule requête, les
   deux niveaux. Si Meta refuse le sous-champ, on retombe sur la forme
   simple plutôt que de perdre tous les commentaires. */
const REP = 'replies.limit(50){id,text,username,timestamp,like_count,from{id,username}}';
const REP_SANS_FROM = 'replies.limit(50){id,text,username,timestamp,like_count}';
const CHAMPS_COMMENTAIRES = [
  /* `from{id,username}` en premier : sur l'API Instagram, le champ `username`
     d'un commentaire n'est servi que pour le propriétaire du compte — les
     autres arrivent anonymes. Or sans pseudo, un GO ne peut être relié à
     aucune fiche lead : on saurait combien de personnes ont réagi, jamais
     lesquelles. `from` est l'autre porte ; si Meta la refuse, on dégrade
     plutôt que de perdre les commentaires. */
  'id,text,username,timestamp,like_count,from{id,username},' + REP,
  'id,text,username,timestamp,like_count,' + REP_SANS_FROM,
  'id,text,username,timestamp,like_count',
];

/** Aplatit un commentaire et ses réponses en une liste unique. */
function aplatirCommentaires(items) {
  const out = [];
  (items || []).forEach((c) => {
    if (!c || !c.id) return;
    out.push({ c: c, parentId: null });
    const rep = c.replies && Array.isArray(c.replies.data) ? c.replies.data : [];
    rep.forEach((r) => { if (r && r.id) out.push({ c: r, parentId: String(c.id) }); });
  });
  return out;
}

async function syncCommentaires(creds, media, mapLeads, ecrivain, rapport, usernameCompte) {
  let bruts = null;
  let tronque = false;
  let derniereErreur = null;
  let forme = null;

  for (let ci = 0; ci < CHAMPS_COMMENTAIRES.length; ci++) {
    try {
      const r = await IG.graphGetPagine(media.id + '/comments', {
        fields: CHAMPS_COMMENTAIRES[ci],
        limit: 25,
      }, creds, 20);
      bruts = r.items;
      tronque = r.tronque;
      forme = ci;
      break;
    } catch (e) {
      derniereErreur = e;
      if (e.metaCode === 190 || e.metaCode === 4 || e.metaCode === 17 || e.metaCode === 32) throw e;
    }
  }
  if (bruts === null) throw (derniereErreur || new Error('commentaires illisibles'));

  const items = aplatirCommentaires(bruts);
  let go = 0;
  let goLeads = 0;
  const auteursGo = {};
  const auteursTous = {};

  for (let i = 0; i < items.length; i++) {
    const c = items[i].c;
    const parentId = items[i].parentId;
    if (!c || !c.id) continue;
    const username = IG.normaliserUsername(c.username || (c.from && c.from.username));
    const igsid = c.from && c.from.id ? String(c.from.id) : null;
    /* Le commentaire du compte lui-même ne compte JAMAIS comme un signal.
       La consigne s'écrit précisément « écris GO » : sans cette exclusion,
       chaque publication portant l'appel à l'action se créditerait d'un GO
       qui n'est que sa propre voix. */
    const estAuteur = !!(usernameCompte && username === usernameCompte);
    const isGo = !estAuteur && IG.contientMotCle(c.text, creds.keywords);
    if (isGo) { go++; if (username) auteursGo[username] = 1; }
    if (username && !estAuteur) auteursTous[username] = 1;

    const leadId = username && mapLeads[username] ? mapLeads[username] : null;
    if (isGo && leadId) goLeads++;
    const ts = c.timestamp ? new Date(c.timestamp).getTime() : null;

    await ecrivain.set(db.collection('ig_comments').doc(String(c.id)), {
      commentId: String(c.id),
      mediaId: String(media.id),
      parentId: parentId,
      isReply: parentId != null,
      isAuthor: estAuteur,
      username: username,
      igsid: igsid,
      text: c.text != null ? String(c.text).slice(0, 2000) : '',
      isGo: isGo,
      likeCount: nb(c.like_count),
      timestamp: c.timestamp || null,
      date: ts ? IG.jourParis(ts) : (media._jour || null),
      leadId: leadId,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    rapport.commentaires++;
  }

  return {
    total: items.length,
    replies: items.filter((x) => x.parentId != null).length,
    champs: forme,
    go: go,
    goLeads: goLeads,
    goUniques: Object.keys(auteursGo).length,
    auteursUniques: Object.keys(auteursTous).length,
    tronque: tronque,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   4. CARTE @username → leadId (une seule lecture par exécution)
   ══════════════════════════════════════════════════════════════════════ */
async function chargerMapLeads() {
  const map = {};
  try {
    /* `>= ''` ne remonte que les fiches où le champ existe ET est une chaîne :
       inutile de balayer toute la collection leads pour rattacher 40 pseudos. */
    const snap = await db.collection('leads')
      .where('instagramUsername', '>=', '')
      .limit(3000).get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (d._merged === true) return;              // motif pickAlive()
      const u = IG.normaliserUsername(d.instagramUsername);
      if (u && !map[u]) map[u] = doc.id;
    });
  } catch (e) {
    console.warn('[instagram-sync] map leads indisponible:', e.message);
  }
  return map;
}

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  const t0 = Date.now();
  const deadline = t0 + BUDGET_MS;

  // ─── 1. Auth ───────────────────────────────────────────────────────
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[instagram-sync] CRON_SECRET env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerOk = authHeader === 'Bearer ' + secret;
  const apiKeyOk = (req.headers['x-api-key'] || req.headers['X-API-Key']) === secret;
  if (!bearerOk && !apiKeyOk) {
    console.warn('[instagram-sync] unauthorized');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const q = req.query || {};
  /* days : 30 par défaut. Meta ne sert les statistiques JOUR du compte que
     sur ~30 jours glissants — les redemander toutes les nuits ne coûte
     qu'une poignée d'appels et rattrape automatiquement tout trou laissé par
     une nuit en échec. Un défaut à 3 laissait ces trous définitifs.
     mediaDays : 60 le temps du rattrapage initial des deux derniers mois,
     à repasser à 30 ensuite (au-delà d'un mois, les compteurs d'un post ne
     bougent quasiment plus, et 120 publications par nuit frôlent le budget
     de temps de la fonction). */
  const days = Math.max(1, Math.min(90, parseInt(q.days, 10) || 30));
  const mediaDays = Math.max(1, Math.min(400, parseInt(q.mediaDays, 10) || 60));
  const avecCommentaires = String(q.comments || '1') !== '0';

  const rapport = {
    ok: true, days, mediaDays,
    joursCompte: 0, medias: 0, mediasInsights: 0, commentaires: 0,
    goTotal: 0, ecritures: 0, tronque: false, erreurs: [],
  };

  try {
    const creds = await IG.getInstagramCreds(true);
    if (!creds.syncActif) {
      res.status(200).json({ ok: true, skipped: 'syncActif=false dans _config/instagram_credentials' });
      return;
    }

    // ─── 2. Jeton : le rafraîchir AVANT de s'en servir ────────────────
    rapport.token = await IG.rafraichirTokenSiBesoin(10);
    const credsAJour = await IG.getInstagramCreds(rapport.token.fait === true);

    const ecrivain = creerEcrivain();
    const aujourdhui = IG.jourParis();

    // ─── 3. Compte, du plus ancien au plus récent ─────────────────────
    const jours = [];
    for (let i = days - 1; i >= 0; i--) jours.push(IG.decalerJour(aujourdhui, -i));
    const profil = await syncCompte(credsAJour, jours, ecrivain, rapport, deadline);
    const igUserIdReel = (profil && (profil.user_id || profil.id)) || credsAJour.igUserId;
    const usernameCompte = IG.normaliserUsername((profil && profil.username) || credsAJour.compteNom);

    // ─── 4. Publications ──────────────────────────────────────────────
    const depuis = IG.decalerJour(aujourdhui, -(mediaDays - 1));
    const medias = await listerMedias(credsAJour, depuis, 12);
    rapport.medias = medias.length;

    const mapLeads = avecCommentaires ? await chargerMapLeads() : {};

    /* Les compteurs de commentaires déjà connus : si rien n'a bougé sur une
       vieille publication, on ne repagine pas ses commentaires. Sans ce
       garde-fou, chaque nuit relirait des milliers de commentaires figés. */
    const connus = {};
    if (avecCommentaires && medias.length) {
      const refs = medias.map((m) => db.collection('ig_media').doc(String(m.id)));
      const snaps = await db.getAll.apply(db, refs);
      snaps.forEach((s) => { if (s.exists) connus[s.id] = s.data() || {}; });
    }

    for (let i = 0; i < medias.length; i++) {
      if (Date.now() > deadline) { rapport.tronque = true; break; }
      const m = medias[i];
      const estReel = String(m.media_product_type || '').toUpperCase() === 'REELS';
      const cascade = estReel ? METRIQUES_MEDIA.REELS : METRIQUES_MEDIA.FEED;

      let ins = {};
      const resIns = await insightsAvecRepli(m.id + '/insights', {}, cascade, credsAJour);
      if (resIns) { ins = aplatirInsights(resIns.data); rapport.mediasInsights++; }

      const likes = ins.likes != null ? ins.likes : nb(m.like_count);
      const commentaires = ins.comments != null ? ins.comments : nb(m.comments_count);
      const reach = ins.reach != null ? ins.reach : null;
      const interactions = ins.total_interactions != null
        ? ins.total_interactions
        : (likes + commentaires + nb(ins.saved) + nb(ins.shares));

      const doc = {
        mediaId: String(m.id),
        igUserId: igUserIdReel,
        caption: m.caption != null ? String(m.caption).slice(0, 2200) : '',
        mediaType: m.media_type || null,
        mediaProductType: m.media_product_type || null,
        isReel: estReel,
        permalink: m.permalink || null,
        thumbnailUrl: m.thumbnail_url || m.media_url || null,
        timestamp: m.timestamp || null,
        date: m._jour || null,
        likes: likes,
        comments: commentaires,
        saved: ins.saved != null ? ins.saved : null,
        shares: ins.shares != null ? ins.shares : null,
        reach: reach,
        views: ins.views != null ? ins.views : null,
        avgWatchTimeMs: ins.avg_watch_time != null ? ins.avg_watch_time : null,
        totalInteractions: interactions,
        /* Taux d'engagement rapporté à la PORTÉE, pas aux abonnés : c'est le
           seul dénominateur qui compare honnêtement un post vu par 800
           personnes et un autre poussé à 40 000. */
        engagementRate: reach ? Math.round((interactions / reach) * 10000) / 100 : null,
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      // ─── Commentaires + GO ──────────────────────────────────────────
      const dejaVu = connus[String(m.id)] || {};
      const besoinComments = avecCommentaires && nb(m.comments_count) > 0
        && (dejaVu.commentsFetchedCount == null
            || dejaVu.commentsVersion !== COMMENTS_VERSION
            || nb(dejaVu.commentsFetchedCount) !== nb(m.comments_count));

      if (besoinComments) {
        try {
          const c = await syncCommentaires(credsAJour, m, mapLeads, ecrivain, rapport, usernameCompte);
          doc.goCount = c.go;
          /* Combien de ces GO ont déjà une fiche : le reste, c'est le volume
             de setting laissé sur la table sous la publication. */
          doc.goLeads = c.goLeads;
          doc.goUniques = c.goUniques;
          doc.commentAuthors = c.auteursUniques;
          doc.commentsFetchedCount = c.total;
          doc.commentsReplies = c.replies;
          doc.commentsVersion = COMMENTS_VERSION;
          doc.commentsTronques = c.tronque;
          doc.commentsFetchedAt = admin.firestore.FieldValue.serverTimestamp();
          rapport.goTotal += c.go;
        } catch (e) {
          rapport.erreurs.push('comments ' + m.id + ': ' + e.message);
          if (e.metaCode === 190) throw e;
        }
      } else if (dejaVu.goCount != null) {
        rapport.goTotal += nb(dejaVu.goCount);
      }

      await ecrivain.set(db.collection('ig_media').doc(String(m.id)), doc);

      /* Photo du jour : c'est elle qui permettra de dire « ce Reel a pris
         12 000 vues en 48 h » — impossible avec le seul dernier état. */
      await ecrivain.set(db.collection('ig_media_daily').doc(String(m.id) + '_' + aujourdhui), {
        mediaId: String(m.id),
        date: aujourdhui,
        mediaDate: m._jour || null,
        reach: doc.reach, views: doc.views, likes: doc.likes,
        comments: doc.comments, saved: doc.saved, shares: doc.shares,
        goCount: doc.goCount != null ? doc.goCount : (dejaVu.goCount != null ? nb(dejaVu.goCount) : null),
        totalInteractions: doc.totalInteractions,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await ecrivain.flush();
    rapport.ecritures = ecrivain.total;
    rapport.dureeMs = Date.now() - t0;

    /* Le journal de la dernière exécution est lu par l'onglet Instagram :
       « dernière synchro » affichée à l'écran vaut mieux qu'un log Vercel
       que personne n'ouvre. Écrit AVANT la réponse — Vercel tue la fonction
       dès res.end(), les écritures en vol seraient perdues. */
    await db.collection('_config').doc('instagram_sync_state').set({
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRun: rapport,
      tokenExpiresAt: credsAJour.tokenExpiresAt || null,
    }, { merge: true });

    res.status(200).json(rapport);
  } catch (e) {
    console.error('[instagram-sync]', e);
    rapport.ok = false;
    rapport.erreur = e.message;
    rapport.metaCode = e.metaCode || null;
    rapport.dureeMs = Date.now() - t0;
    try {
      await db.collection('_config').doc('instagram_sync_state').set({
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRun: rapport,
      }, { merge: true });
    } catch (_) {}
    res.status(500).json(rapport);
  }
};
