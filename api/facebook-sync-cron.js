// ============================================================================
// api/facebook-sync-cron.js
// ----------------------------------------------------------------------------
// Synchronisation quotidienne de la Page FACEBOOK → Firestore, pour l'onglet
// 📘 Facebook du Funnel Sales (sales-funnel.html).
//
// URL  : GET|POST https://team.alteore.com/api/facebook-sync-cron
//        [?days=30] [?postDays=90] [?dmDays=90] [?comments=1] [?dm=1]
// Auth : Authorization: Bearer <CRON_SECRET> (envoyé seul par Vercel Cron)
//        ou x-api-key: <CRON_SECRET> (test manuel), comme les autres crons.
// Cron : voir vercel.json — tous les jours 04:50 UTC, dix minutes après
//        Instagram pour ne pas faire tourner deux gros jobs de front.
//
// ─── CE QU'IL ÉCRIT ───────────────────────────────────────────────────
//   fb_page_daily/{YYYY-MM-DD}       audience de la Page, jour par jour
//   fb_posts/{postId}                la publication + ses dernières métriques
//   fb_post_daily/{postId}_{date}    le même jeu, figé jour par jour
//   fb_comments/{commentId}          chaque commentaire + drapeau `isGo`
//   fb_dm_threads/{conversationId}   Messenger : compteurs et délais
//   fb_dm_events/{messageId}         Messenger : journal brut
//
// ─── CE QUI CHANGE PAR RAPPORT À INSTAGRAM ────────────────────────────
// · Les commentaires se demandent avec `filter=stream`, qui rend les
//   réponses À PLAT dans la même liste. Pas de sous-champ `replies` à
//   déplier, pas de niveau perdu.
// · L'identité d'un commentateur n'est divulguée que s'il utilise
//   l'application (restriction Meta de 2018). Un commentaire anonyme reste
//   parfaitement comptable ; il ne peut simplement pas être rattaché.
// · MESSENGER SE RATTRAPE. `/{page-id}/conversations` rend l'historique —
//   là où Instagram ne donne rien avant le branchement du webhook. Les
//   agrégats sont donc RECALCULÉS à chaque passage depuis les messages
//   lus : le cron fait autorité, le webhook ne fait que tenir l'écran à
//   jour entre deux nuits.
//
// ─── IDEMPOTENCE ──────────────────────────────────────────────────────
// Identifiants de documents déterministes partout ({date}, {postId},
// {postId}_{date}, {commentId}, {messageId}) : rejouable autant qu'on veut.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const FB = require('./_facebookClient');

const BUDGET_MS = 250000;
const MAX_BATCH = 400;
const HOT_DAYS = 14;              // publications encore mouvantes
const COMMENTS_VERSION = 1;

/* Version des LISTES DE CANDIDATES ci-dessous. À incrémenter dès qu'on en
   ajoute une : sans ce marqueur, la liste mémorisée — qui fonctionne — est
   réutilisée telle quelle et les nouvelles candidates ne sont JAMAIS
   testées. C'est exactement ce qui est arrivé le 01/09/2026 : page_follows,
   page_daily_follows et page_video_views étaient ajoutées au code, mais la
   Page continuait d'afficher trois métriques et des cartes vides, parce que
   la mémoire d'un premier passage réussi n'avait aucune raison d'être
   remise en cause.
     1 → listes initiales
     2 → ajout de page_follows / page_daily_follows / page_video_views */
const CANDIDATS_VERSION = 2;

/* MÉTRIQUES — DÉCOUVERTES, PAS DEVINÉES
   ─────────────────────────────────────────────────────────────────────
   Meta a supprimé 85 métriques de portée et d'impressions le 15/06/2026 :
   `post_impressions` et ses variantes ont disparu, `post_impressions_unique`
   est devenu `post_total_media_view_unique`, et pour un Reel il ne reste
   qu'un compteur de lectures. Une liste écrite en dur serait périmée à la
   prochaine vague — et son échec est SILENCIEUX au niveau du tableau : des
   colonnes vides, aucune erreur visible.

   D'où ce fonctionnement : on tente le lot complet ; s'il est refusé, on
   teste chaque métrique UNE PAR UNE et on retient celles que Meta accepte.
   La liste retenue est mémorisée dans _config/facebook_sync_state et
   réutilisée telle quelle aux passages suivants. Un seul passage paie la
   découverte ; les suivants font un appel par publication au lieu de
   quatre lots refusés — c'est aussi ce qui a fait passer la synchro de
   250 s (tronquée) à une durée tenable.

   Quand Meta déprécie à nouveau, la liste mémorisée échoue, la découverte
   se relance seule et le tableau se remplit à nouveau. Sans intervention. */
const CANDIDATS_POST = [
  'post_total_media_view_unique',   // remplaçant officiel de post_impressions_unique
  'post_impressions_unique',        // ancien nom, encore servi sur certaines Pages
  'post_views',
  'post_impressions',
  'blue_reels_play_count',          // Reels : seul compteur restant
  'post_video_views',
  'post_clicks',
  'post_reactions_by_type_total',
  'post_engaged_users',
];
const CANDIDATS_PAGE = [
  /* Les trois premières sont les remplaçantes réelles, découvertes par le
     diagnostic du 01/09/2026 : page_fans, page_impressions et
     page_impressions_unique sont refusées depuis le 15/06/2026, et la
     documentation ne nommait pas leurs successeurs. */
  'page_follows',            // total d'abonnés — remplace page_fans
  'page_daily_follows',      // nouveaux abonnés du jour
  'page_video_views',        // le seul volume d'exposition encore servi
  'page_views_total',
  'page_post_engagements',
  'page_total_actions',
  'page_impressions_unique', // conservées : elles peuvent revenir, et une
  'page_impressions',        // Page plus ancienne les sert peut-être encore
  'page_fans',
];

/**
 * Teste les métriques une par une et retourne celles que Meta accepte.
 * Coûteux (un appel par candidate), donc appelé une seule fois puis mémorisé.
 */
async function decouvrirMetriques(chemin, candidats, creds) {
  const ok = [];
  for (let i = 0; i < candidats.length; i++) {
    try {
      await FB.graphGet(chemin, { metric: candidats[i] }, creds);
      ok.push(candidats[i]);
    } catch (e) {
      /* 190 = jeton mort, 4/17/32 = quota : insister ne changerait rien et
         brûlerait le budget. Tout le reste = métrique refusée, on continue. */
      if (e.metaCode === 190 || e.metaCode === 4 || e.metaCode === 17 || e.metaCode === 32) throw e;
    }
  }
  return ok;
}

/**
 * Renvoie la liste de métriques à utiliser : celle mémorisée si elle
 * fonctionne encore, sinon une découverte fraîche.
 * `memo` est l'objet _config/facebook_sync_state déjà lu.
 */
async function metriquesUtilisables(chemin, candidats, memoListe, creds, rapport, cle, memoVersion) {
  /* La mémoire n'est valable que pour la liste de candidates qui l'a
     produite. Une liste élargie doit être re-testée, même si l'ancienne
     marche encore : « ça fonctionne » ne veut pas dire « c'est complet ». */
  if (memoVersion === CANDIDATS_VERSION && Array.isArray(memoListe) && memoListe.length) {
    try {
      await FB.graphGet(chemin, { metric: memoListe.join(',') }, creds);
      return memoListe;
    } catch (e) {
      if (e.metaCode === 190) throw e;
      rapport.erreurs.push(cle + ': liste mémorisée refusée, redécouverte');
    }
  }
  const trouvees = await decouvrirMetriques(chemin, candidats, creds);
  rapport[cle] = trouvees;
  return trouvees;
}

function nb(v) { const n = Number(v); return isFinite(n) ? n : 0; }

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

/** Aplatit la réponse insights en { metrique: valeur }. */
function aplatirInsights(data) {
  const out = {};
  (data || []).forEach((m) => {
    if (!m || !m.name) return;
    if (!Array.isArray(m.values) || !m.values.length) return;
    const v = m.values[m.values.length - 1];
    if (v == null || v.value == null) return;
    /* post_reactions_by_type_total rend un objet {like:3, love:1…} : on garde
       le détail ET le total, une réaction « colère » et un « j'adore » ne
       racontent pas la même histoire sur un post. */
    if (typeof v.value === 'object') {
      let t = 0;
      Object.keys(v.value).forEach((k) => { t += nb(v.value[k]); });
      out[m.name] = t;
      out[m.name + '_detail'] = v.value;
    } else {
      out[m.name] = nb(v.value);
    }
  });
  return out;
}

/* ══════════════════════════════════════════════════════════════════════
   1. PAGE — snapshot jour par jour
   ══════════════════════════════════════════════════════════════════════ */
async function syncPage(creds, jours, ecrivain, rapport, deadline, metriques) {
  let profil = {};
  try {
    profil = await FB.graphGet(creds.pageId, { fields: 'id,name,username,fan_count,followers_count' }, creds);
  } catch (e) {
    rapport.erreurs.push('page: ' + e.message);
    if (e.metaCode === 190) throw e;
  }
  const aujourdhui = FB.jourParis();

  for (let i = 0; i < jours.length; i++) {
    if (Date.now() > deadline) { rapport.tronque = true; break; }
    const jour = jours[i];
    const b = FB.bornesJour(jour);
    let m = {};
    if (metriques && metriques.length) {
      try {
        const json = await FB.graphGet(creds.pageId + '/insights', {
          metric: metriques.join(','), period: 'day', since: b.since, until: b.until,
        }, creds);
        m = aplatirInsights(Array.isArray(json.data) ? json.data : []);
      } catch (e) {
        if (e.metaCode === 190) throw e;
        rapport.joursSansInsights = (rapport.joursSansInsights || 0) + 1;
      }
    }

    const doc = {
      date: jour,
      pageId: creds.pageId,
      /* Noms flottants côté Meta : on prend le premier servi, et on laisse
         null plutôt que d'inventer un équivalent. La portée Page n'existe
         tout simplement plus — c'est une information, pas un trou à combler. */
      impressions: m.page_impressions != null ? m.page_impressions : null,
      reach: m.page_impressions_unique != null ? m.page_impressions_unique : null,
      videoViews: m.page_video_views != null ? m.page_video_views : null,
      nouveauxAbonnes: m.page_daily_follows != null ? m.page_daily_follows : null,
      engagements: m.page_post_engagements != null ? m.page_post_engagements : null,
      pageViews: m.page_views_total != null ? m.page_views_total : null,
      fans: m.page_follows != null ? m.page_follows
            : (m.page_fans != null ? m.page_fans : null),
      source: 'api',
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    };
    /* Le compteur d'abonnés est celui d'AUJOURD'HUI : ne l'écrire que sur le
       document du jour, sinon on antidaterait la photo actuelle sur tout le
       rattrapage et la courbe serait plate puis fausse. */
    if (jour === aujourdhui) {
      doc.followers = profil.followers_count != null ? nb(profil.followers_count) : null;
      doc.fanCount = profil.fan_count != null ? nb(profil.fan_count) : null;
      doc.pageNom = profil.name || null;
    }
    await ecrivain.set(db.collection('fb_page_daily').doc(jour), doc);
    rapport.joursPage++;
  }
  return profil;
}

/* ══════════════════════════════════════════════════════════════════════
   2. PUBLICATIONS
   ══════════════════════════════════════════════════════════════════════ */
async function listerPosts(creds, depuisIso, plafondPages) {
  const champs = [
    'id', 'created_time', 'message', 'permalink_url', 'full_picture',
    'status_type', 'attachments{media_type,type}',
    'shares', 'comments.summary(true).limit(0)', 'reactions.summary(true).limit(0)',
  ].join(',');

  const items = [];
  let page = await FB.graphGet(creds.pageId + '/posts', { fields: champs, limit: 25 }, creds);
  let n = 1;
  let stop = false;

  while (page && Array.isArray(page.data)) {
    for (let i = 0; i < page.data.length; i++) {
      const p = page.data[i];
      const jour = p.created_time ? FB.jourParis(new Date(p.created_time).getTime()) : null;
      /* Le flux est trié du plus récent au plus ancien : sous la borne, tout
         le reste est hors fenêtre. */
      if (jour && jour < depuisIso) { stop = true; break; }
      items.push(Object.assign({}, p, { _jour: jour }));
    }
    if (stop || !page.paging || !page.paging.next || n >= (plafondPages || 20)) break;
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
async function syncCommentaires(creds, post, mapLeads, ecrivain, rapport) {
  /* `filter=stream` rend les réponses À PLAT avec les commentaires de
     premier niveau — sur Instagram il a fallu déplier un sous-champ pour
     obtenir la même chose, et l'oubli avait fait perdre des GO entiers. */
  const { items, tronque } = await FB.graphGetPagine(post.id + '/comments', {
    filter: 'stream',
    fields: 'id,message,created_time,like_count,from{id,name},parent{id}',
    limit: 50,
  }, creds, 10);

  let go = 0;
  let goLeads = 0;
  let anonymes = 0;
  const auteursGo = {};

  for (let i = 0; i < items.length; i++) {
    const c = items[i];
    if (!c || !c.id) continue;
    const a = FB.auteurDe(c);
    if (!a.id) anonymes++;
    /* Le commentaire de la Page elle-même ne compte JAMAIS comme un signal :
       c'est elle qui écrit « écris GO ». */
    const estPage = a.id === creds.pageId;
    const isGo = !estPage && FB.contientMotCle(c.message, creds.keywords);
    if (isGo) { go++; if (a.id) auteursGo[a.id] = 1; }

    const leadId = a.nom && mapLeads[a.nom.trim().toLowerCase()] ? mapLeads[a.nom.trim().toLowerCase()] : null;
    if (isGo && leadId) goLeads++;
    const ts = c.created_time ? new Date(c.created_time).getTime() : null;

    await ecrivain.set(db.collection('fb_comments').doc(String(c.id)), {
      commentId: String(c.id),
      postId: String(post.id),
      pageId: creds.pageId,
      authorId: a.id,
      authorName: a.nom,
      isPage: estPage,
      isReply: !!(c.parent && c.parent.id),
      parentId: c.parent && c.parent.id ? String(c.parent.id) : null,
      text: c.message != null ? String(c.message).slice(0, 2000) : '',
      isGo: isGo,
      likeCount: nb(c.like_count),
      timestamp: c.created_time || null,
      date: ts ? FB.jourParis(ts) : (post._jour || null),
      leadId: leadId,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    rapport.commentaires++;
  }

  return {
    total: items.length,
    go: go,
    goLeads: goLeads,
    goUniques: Object.keys(auteursGo).length,
    anonymes: anonymes,
    tronque: tronque,
  };
}

/* ══════════════════════════════════════════════════════════════════════
   4. MESSENGER — avec rattrapage de l'historique
   ══════════════════════════════════════════════════════════════════════ */
async function syncMessenger(creds, depuisIso, ecrivain, rapport, deadline) {
  const { items } = await FB.graphGetPagine(creds.pageId + '/conversations', {
    fields: 'id,updated_time,message_count,participants,messages.limit(100){id,created_time,from,message}',
    limit: 25,
  }, creds, 6);

  for (let i = 0; i < items.length; i++) {
    if (Date.now() > deadline) { rapport.tronque = true; break; }
    const conv = items[i];
    if (!conv || !conv.id) continue;

    const msgs = conv.messages && Array.isArray(conv.messages.data) ? conv.messages.data.slice() : [];
    if (!msgs.length) continue;
    /* L'API rend du plus récent au plus ancien : on remet dans l'ordre du
       temps, sans quoi « qui a parlé en premier » serait inversé. */
    msgs.sort((a, b) => String(a.created_time || '').localeCompare(String(b.created_time || '')));

    const premier = msgs[0];
    const jourPremier = premier.created_time ? FB.jourParis(new Date(premier.created_time).getTime()) : null;
    if (jourPremier && jourPremier < depuisIso) continue;   // hors fenêtre demandée

    /* Interlocuteur : le participant qui n'est pas la Page. */
    const parts = conv.participants && Array.isArray(conv.participants.data) ? conv.participants.data : [];
    const autre = parts.find((p) => String(p.id) !== creds.pageId) || null;

    let sortants = 0;
    let entrants = 0;
    let premierSortantMs = null;
    let premierEntrantMs = null;
    let repondu = false;
    let delaiReponseMs = null;
    let notreDelaiMs = null;
    let dernierEntrantMs = null;

    for (let j = 0; j < msgs.length; j++) {
      const m = msgs[j];
      const ms = m.created_time ? new Date(m.created_time).getTime() : null;
      const deLaPage = m.from && String(m.from.id) === creds.pageId;
      if (deLaPage) {
        sortants++;
        if (premierSortantMs === null) premierSortantMs = ms;
        if (dernierEntrantMs !== null && notreDelaiMs === null && premierSortantMs !== ms) {
          notreDelaiMs = ms - dernierEntrantMs;
        }
      } else {
        entrants++;
        if (premierEntrantMs === null) premierEntrantMs = ms;
        dernierEntrantMs = ms;
        /* LE chiffre : une réponse APRÈS notre premier message sortant. */
        if (premierSortantMs !== null && !repondu && ms >= premierSortantMs) {
          repondu = true;
          delaiReponseMs = ms - premierSortantMs;
        }
      }

      if (m.id) {
        await ecrivain.set(db.collection('fb_dm_events').doc(String(m.id)), {
          messageId: String(m.id),
          conversationId: String(conv.id),
          direction: deLaPage ? 'out' : 'in',
          text: m.message != null ? String(m.message).slice(0, 2000) : '',
          timestampMs: ms,
          date: ms ? FB.jourParis(ms) : null,
          syncedAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        rapport.messages++;
      }
    }

    const premierMs = premier.created_time ? new Date(premier.created_time).getTime() : null;
    const initiePar = msgs[0].from && String(msgs[0].from.id) === creds.pageId ? 'us' : 'them';

    let leadId = null;
    if (autre && autre.name) {
      const lead = await FB.trouverLeadParNomFb(autre.name);
      if (lead) leadId = lead.id;
    }

    /* Le cron RECALCULE tout depuis les messages lus et fait autorité : le
       webhook ne fait que tenir l'écran à jour entre deux nuits. */
    await ecrivain.set(db.collection('fb_dm_threads').doc(String(conv.id)), {
      conversationId: String(conv.id),
      pageId: creds.pageId,
      participantId: autre && autre.id ? String(autre.id) : null,
      participantNom: autre && autre.name ? String(autre.name) : null,
      leadId: leadId,
      initiatedBy: initiePar,
      firstEventMs: premierMs,
      firstEventDate: jourPremier,
      firstOutboundMs: premierSortantMs,
      firstInboundMs: premierEntrantMs,
      outboundCount: sortants,
      inboundCount: entrants,
      messageCount: nb(conv.message_count),
      messagesTronques: nb(conv.message_count) > msgs.length,
      replied: repondu,
      responseDelayMs: delaiReponseMs,
      ourReplyDelayMs: notreDelaiMs,
      updatedTime: conv.updated_time || null,
      syncedAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    rapport.conversations++;
  }
}

/* ══════════════════════════════════════════════════════════════════════
   5. CARTE nom → leadId
   ══════════════════════════════════════════════════════════════════════ */
async function chargerMapLeads() {
  const map = {};
  try {
    const snap = await db.collection('leads').orderBy('createdAt', 'desc').limit(3000).get();
    snap.forEach((doc) => {
      const d = doc.data() || {};
      if (d._merged === true) return;              // motif pickAlive()
      const n = (d.nom || '').trim().toLowerCase();
      if (n && n.length >= 4 && !map[n]) map[n] = doc.id;
    });
  } catch (e) {
    console.warn('[facebook-sync] map leads indisponible:', e.message);
  }
  return map;
}

/* ══════════════════════════════════════════════════════════════════════
   HANDLER
   ══════════════════════════════════════════════════════════════════════ */
module.exports = async (req, res) => {
  const t0 = Date.now();
  const deadline = t0 + BUDGET_MS;

  const secret = process.env.CRON_SECRET;
  if (!secret) {
    console.error('[facebook-sync] CRON_SECRET env var not set');
    res.status(500).json({ error: 'server_misconfigured' });
    return;
  }
  const authHeader = req.headers['authorization'] || '';
  const bearerOk = authHeader === 'Bearer ' + secret;
  const apiKeyOk = (req.headers['x-api-key'] || req.headers['X-API-Key']) === secret;
  if (!bearerOk && !apiKeyOk) {
    console.warn('[facebook-sync] unauthorized');
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const q = req.query || {};
  const days = Math.max(1, Math.min(90, parseInt(q.days, 10) || 30));
  const postDays = Math.max(1, Math.min(400, parseInt(q.postDays, 10) || 90));
  const dmDays = Math.max(1, Math.min(400, parseInt(q.dmDays, 10) || 90));
  const avecCommentaires = String(q.comments || '1') !== '0';
  const avecDm = String(q.dm || '1') !== '0';

  const rapport = {
    ok: true, days, postDays, dmDays,
    joursPage: 0, posts: 0, postsInsights: 0, commentaires: 0,
    goTotal: 0, conversations: 0, messages: 0,
    ecritures: 0, tronque: false, erreurs: [],
  };

  try {
    const creds = await FB.getFacebookCreds(true);
    if (!creds.syncActif) {
      res.status(200).json({ ok: true, skipped: 'syncActif=false dans _config/facebook_credentials' });
      return;
    }

    const ecrivain = creerEcrivain();
    const aujourdhui = FB.jourParis();

    /* État mémorisé : les métriques que Meta acceptait au dernier passage. */
    const snapState = await db.collection('_config').doc('facebook_sync_state').get();
    const memo = snapState.exists ? (snapState.data() || {}) : {};

    // ─── Page ─────────────────────────────────────────────────────────
    const jours = [];
    for (let i = days - 1; i >= 0; i--) jours.push(FB.decalerJour(aujourdhui, -i));

    let metriquesPage = [];
    try {
      /* Découverte sur HIER : les métriques d'aujourd'hui sont souvent
         encore vides, et une valeur absente n'aide pas à trancher. */
      const bHier = FB.bornesJour(FB.decalerJour(aujourdhui, -1));
      metriquesPage = await metriquesUtilisables(
        creds.pageId + '/insights?period=day&since=' + bHier.since + '&until=' + bHier.until,
        CANDIDATS_PAGE, memo.metriquesPage,
        creds, rapport, 'metriquesPage', memo.metriquesVersion);
    } catch (e) {
      if (e.metaCode === 190) throw e;
      rapport.erreurs.push('métriques Page indécouvrables: ' + e.message);
    }

    const profil = await syncPage(creds, jours, ecrivain, rapport, deadline, metriquesPage);
    rapport.pageNom = profil && profil.name ? profil.name : null;

    /* ── MESSENGER AVANT LES PUBLICATIONS ──
       Il passait en dernier et n'était jamais atteint : les 196 publications
       consommaient tout le budget, la synchro s'arrêtait, et le bloc
       Messenger restait vide alors que l'API rendait bien 5 conversations.
       Cinq conversations coûtent quelques secondes ; deux cents publications
       en coûtent deux cent cinquante. C'est au petit poste de passer devant,
       sans quoi il ne passe jamais. */
    if (avecDm) {
      try {
        await syncMessenger(creds, FB.decalerJour(aujourdhui, -(dmDays - 1)), ecrivain, rapport, deadline);
      } catch (e) {
        rapport.erreurs.push('messenger: ' + e.message);
        if (e.metaCode === 190) throw e;
      }
    }

    // ─── Publications ─────────────────────────────────────────────────
    const depuis = FB.decalerJour(aujourdhui, -(postDays - 1));
    const posts = await listerPosts(creds, depuis, 20);
    rapport.posts = posts.length;

    const mapLeads = avecCommentaires ? await chargerMapLeads() : {};

    const connus = {};
    if (posts.length) {
      const refs = posts.map((p) => db.collection('fb_posts').doc(String(p.id)));
      const snaps = await db.getAll.apply(db, refs);
      snaps.forEach((s) => { if (s.exists) connus[s.id] = s.data() || {}; });
    }

    /* Même ordre de priorité que sur Instagram : les publications récentes
       d'abord — elles bougent encore — puis les autres, de la moins
       récemment synchronisée à la plus récente. La fenêtre tourne, aucune
       tranche n'est sacrifiée deux nuits de suite. */
    const seuilChaud = FB.decalerJour(aujourdhui, -(HOT_DAYS - 1));
    const msSync = (p) => {
      const d = connus[String(p.id)];
      if (!d || !d.lastSyncAt) return 0;
      try { return d.lastSyncAt.toMillis ? d.lastSyncAt.toMillis() : Number(d.lastSyncAt) || 0; }
      catch (_) { return 0; }
    };
    const chauds = posts.filter((p) => p._jour && p._jour >= seuilChaud);
    const froids = posts.filter((p) => !p._jour || p._jour < seuilChaud).sort((a, b) => msSync(a) - msSync(b));
    const ordre = chauds.concat(froids);
    rapport.chauds = chauds.length;
    rapport.froids = froids.length;

    /* Découverte sur la PREMIÈRE publication seulement — le jeu de métriques
       accepté ne dépend pas de la publication, seulement de la version d'API
       et des dépréciations en cours. */
    let metriquesPost = [];
    if (ordre.length) {
      try {
        metriquesPost = await metriquesUtilisables(
          ordre[0].id + '/insights', CANDIDATS_POST, memo.metriquesPost,
          creds, rapport, 'metriquesPost', memo.metriquesVersion);
      } catch (e) {
        if (e.metaCode === 190) throw e;
        rapport.erreurs.push('métriques post indécouvrables: ' + e.message);
      }
    }

    for (let i = 0; i < ordre.length; i++) {
      if (Date.now() > deadline) {
        rapport.tronque = true;
        rapport.reportees = ordre.length - i;
        break;
      }
      const p = ordre[i];
      /* UN LOT, PUIS DEUX REPLIS.
         Meta valide les métriques publication par publication : une seule
         refusée fait échouer TOUT l'appel, donc les cinq. Un Reel n'expose
         pas ce qu'expose une photo, et le lot mémorisé — pourtant correct —
         revenait vide sur une bonne partie des publications. D'où la
         dégradation : le lot complet, puis le lot sans les métriques vidéo,
         puis la portée seule. Elle est la seule dont l'absence viderait le
         tableau de son sens. */
      let ins = {};
      if (metriquesPost.length) {
        const sansVideo = metriquesPost.filter(function (x) {
          return x.indexOf('video') < 0 && x.indexOf('reels') < 0;
        });
        const essais = [metriquesPost];
        if (sansVideo.length && sansVideo.length !== metriquesPost.length) essais.push(sansVideo);
        if (metriquesPost.indexOf('post_total_media_view_unique') >= 0) essais.push(['post_total_media_view_unique']);

        for (let ei = 0; ei < essais.length; ei++) {
          try {
            const json = await FB.graphGet(p.id + '/insights', { metric: essais[ei].join(',') }, creds);
            ins = aplatirInsights(Array.isArray(json.data) ? json.data : []);
            rapport.postsInsights++;
            if (ei > 0) rapport.postsInsightsDegrades = (rapport.postsInsightsDegrades || 0) + 1;
            break;
          } catch (e) {
            if (e.metaCode === 190) throw e;
            if (ei === essais.length - 1) rapport.postsSansInsights = (rapport.postsSansInsights || 0) + 1;
          }
        }
      }

      const commentsCount = p.comments && p.comments.summary ? nb(p.comments.summary.total_count) : 0;
      const reactions = p.reactions && p.reactions.summary ? nb(p.reactions.summary.total_count) : 0;
      const partages = p.shares && p.shares.count != null ? nb(p.shares.count) : 0;
      /* La portée a changé de nom le 15/06/2026 : post_impressions_unique →
         post_total_media_view_unique. On accepte les deux, l'ancien étant
         encore servi sur certaines Pages. */
      const reach = ins.post_total_media_view_unique != null ? ins.post_total_media_view_unique
                  : (ins.post_impressions_unique != null ? ins.post_impressions_unique : null);
      /* Les impressions ont disparu au profit des vues ; pour un Reel il ne
         reste que le compteur de lectures. */
      const impressions = ins.post_views != null ? ins.post_views
                        : (ins.post_impressions != null ? ins.post_impressions
                        : (ins.post_video_views != null ? ins.post_video_views
                        : (ins.blue_reels_play_count != null ? ins.blue_reels_play_count : null)));
      const interactions = reactions + commentsCount + partages;
      const media = p.attachments && p.attachments.data && p.attachments.data[0]
        ? (p.attachments.data[0].media_type || p.attachments.data[0].type || null) : null;

      const doc = {
        postId: String(p.id),
        pageId: creds.pageId,
        message: p.message != null ? String(p.message).slice(0, 2200) : '',
        permalink: p.permalink_url || null,
        thumbnailUrl: p.full_picture || null,
        statusType: p.status_type || null,
        mediaType: media,
        isVideo: String(media || '').toLowerCase().indexOf('video') >= 0,
        timestamp: p.created_time || null,
        date: p._jour || null,
        impressions: impressions,
        reach: reach,
        clicks: ins.post_clicks != null ? ins.post_clicks : null,
        videoViews: ins.post_video_views != null ? ins.post_video_views : null,
        reactions: reactions,
        reactionsDetail: ins.post_reactions_by_type_total_detail || null,
        comments: commentsCount,
        shares: partages,
        totalInteractions: interactions,
        /* Engagement rapporté à la PORTÉE, pas aux fans : seul dénominateur
           qui compare honnêtement un post vu par 800 personnes et un autre
           poussé à 40 000. */
        engagementRate: reach ? Math.round((interactions / reach) * 10000) / 100 : null,
        lastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      const dejaVu = connus[String(p.id)] || {};
      const besoinComments = avecCommentaires && commentsCount > 0
        && (dejaVu.commentsFetchedCount == null
            || dejaVu.commentsVersion !== COMMENTS_VERSION
            || nb(dejaVu.commentsFetchedCount) !== commentsCount);

      if (besoinComments) {
        try {
          const c = await syncCommentaires(creds, p, mapLeads, ecrivain, rapport);
          doc.goCount = c.go;
          doc.goLeads = c.goLeads;
          doc.goUniques = c.goUniques;
          doc.commentsAnonymes = c.anonymes;
          doc.commentsFetchedCount = c.total;
          doc.commentsVersion = COMMENTS_VERSION;
          doc.commentsTronques = c.tronque;
          doc.commentsFetchedAt = admin.firestore.FieldValue.serverTimestamp();
          rapport.goTotal += c.go;
        } catch (e) {
          rapport.erreurs.push('comments ' + p.id + ': ' + e.message);
          if (e.metaCode === 190) throw e;
        }
      } else if (dejaVu.goCount != null) {
        rapport.goTotal += nb(dejaVu.goCount);
      }

      await ecrivain.set(db.collection('fb_posts').doc(String(p.id)), doc);
      await ecrivain.set(db.collection('fb_post_daily').doc(String(p.id) + '_' + aujourdhui), {
        postId: String(p.id),
        date: aujourdhui,
        postDate: p._jour || null,
        impressions: doc.impressions, reach: doc.reach, reactions: doc.reactions,
        comments: doc.comments, shares: doc.shares, clicks: doc.clicks,
        goCount: doc.goCount != null ? doc.goCount : (dejaVu.goCount != null ? nb(dejaVu.goCount) : null),
        totalInteractions: doc.totalInteractions,
        syncedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await ecrivain.flush();
    rapport.ecritures = ecrivain.total;
    rapport.dureeMs = Date.now() - t0;

    /* Écrit AVANT la réponse — Vercel tue la fonction dès res.end(). */
    await db.collection('_config').doc('facebook_sync_state').set({
      lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
      lastRun: rapport,
      /* Mémorisées pour le prochain passage : la découverte coûte un appel
         par candidate, elle ne doit se payer qu'une fois. */
      metriquesPage: metriquesPage,
      metriquesPost: metriquesPost,
      metriquesVersion: CANDIDATS_VERSION,
    }, { merge: true });

    res.status(200).json(rapport);
  } catch (e) {
    console.error('[facebook-sync]', e);
    rapport.ok = false;
    rapport.erreur = e.message;
    rapport.metaCode = e.metaCode || null;
    rapport.dureeMs = Date.now() - t0;
    try {
      await db.collection('_config').doc('facebook_sync_state').set({
        lastRunAt: admin.firestore.FieldValue.serverTimestamp(),
        lastRun: rapport,
      }, { merge: true });
    } catch (_) {}
    res.status(500).json(rapport);
  }
};
