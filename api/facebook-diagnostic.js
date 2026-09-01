// ============================================================================
// api/facebook-diagnostic.js
// ----------------------------------------------------------------------------
// Diagnostic de la chaîne Facebook, appelable depuis le navigateur par un
// admin connecté (bouton « 🩺 Diagnostic » de l'onglet 📘 du Funnel Sales).
//
// URL  : GET https://team.alteore.com/api/facebook-diagnostic[?postId=...]
// Auth : jeton Firebase d'un admin, comme api/instagram-diagnostic.js.
//
// POURQUOI IL EXISTE, ET CE QU'IL SAIT DE PLUS QUE SON JUMEAU INSTAGRAM
// --------------------------------------------------------------------
// La chaîne Instagram a coûté une matinée à mettre au point, pour une cause
// finale invisible : l'application était en mode Développement, et l'API
// rendait des listes VIDES SANS ERREUR. Rien ne distinguait « pas le droit »
// de « rien à voir ». Ce diagnostic naît de cette leçon et teste d'emblée
// tout ce qui peut échouer en silence.
//
// Il dispose ici d'un atout que l'autre n'a pas : `debug_token` fonctionne
// pour un jeton Facebook (il refusait les jetons Instagram). Les permissions
// réellement portées sont donc LISIBLES, et non plus déduites.
//
// AUCUNE ÉCRITURE. Aucun secret dans la réponse : ni jeton, ni appSecret,
// ni verifyToken — seulement leur présence.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { db } = require('./_firebaseAdmin');
const FB = require('./_facebookClient');

function extraitErreur(e) {
  return {
    message: e && e.message ? String(e.message).slice(0, 400) : String(e),
    metaCode: e && e.metaCode != null ? e.metaCode : null,
    metaSubcode: e && e.metaSubcode != null ? e.metaSubcode : null,
    httpStatus: e && e.httpStatus != null ? e.httpStatus : null,
  };
}

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return;

  const out = { ok: true, etapes: {} };

  try {
    // ─── 1. Configuration ─────────────────────────────────────────────
    let creds;
    try {
      creds = await FB.getFacebookCreds(true);
      out.etapes.config = {
        ok: true,
        pageId: creds.pageId, pageNom: creds.pageNom,
        apiVersion: creds.apiVersion, keywords: creds.keywords,
        syncActif: creds.syncActif,
        tokenPresent: !!creds.token, appIdPresent: !!creds.appId,
        appSecretPresent: !!creds.appSecret, verifyTokenPresent: !!creds.verifyToken,
      };
    } catch (e) {
      out.ok = false;
      out.etapes.config = { ok: false, erreur: extraitErreur(e) };
      res.status(200).json(out);
      return;
    }

    // ─── 2. Permissions — lisibles, ici ───────────────────────────────
    try {
      if (!creds.appId || !creds.appSecret) {
        out.etapes.permissions = { ok: false, raison: 'appId et/ou appSecret absents — scopes non vérifiables' };
      } else {
        const u = 'https://graph.facebook.com/' + creds.apiVersion + '/debug_token'
          + '?input_token=' + encodeURIComponent(creds.token)
          + '&access_token=' + encodeURIComponent(creds.appId + '|' + creds.appSecret);
        const rep = await fetch(u);
        const txt = await rep.text();
        let j = {};
        try { j = txt ? JSON.parse(txt) : {}; } catch (_) { j = {}; }
        if (j.error) {
          out.etapes.permissions = { ok: false, erreur: { message: String(j.error.message || '').slice(0, 300), code: j.error.code } };
        } else {
          const d = j.data || {};
          const scopes = Array.isArray(d.scopes) ? d.scopes : [];
          out.etapes.permissions = {
            ok: true,
            type: d.type || null,
            valide: d.is_valid,
            /* expires_at = 0 signifie « n'expire jamais » : c'est le cas
               normal d'un jeton de Page dérivé d'un jeton longue durée. */
            expire: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : 'jamais',
            scopes: scopes,
            peutLireCommentaires: scopes.indexOf('pages_read_user_content') >= 0,
            peutLireInsights: scopes.indexOf('read_insights') >= 0,
            peutLireMessenger: scopes.indexOf('pages_messaging') >= 0,
            peutLireEngagement: scopes.indexOf('pages_read_engagement') >= 0,
          };
        }
      }
    } catch (e) {
      out.etapes.permissions = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 3. La Page ───────────────────────────────────────────────────
    try {
      const p = await FB.graphGet(creds.pageId, { fields: 'id,name,username,fan_count,followers_count,link' }, creds);
      out.etapes.page = { ok: true, nom: p.name, username: p.username || null,
                          fans: p.fan_count, followers: p.followers_count, lien: p.link || null };
    } catch (e) {
      out.ok = false;
      out.etapes.page = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 4. Publications ──────────────────────────────────────────────
    let posts = [];
    try {
      const r = await FB.graphGet(creds.pageId + '/posts', {
        fields: 'id,created_time,message,permalink_url,comments.summary(true).limit(0),reactions.summary(true).limit(0)',
        limit: 12,
      }, creds);
      posts = Array.isArray(r.data) ? r.data : [];
      out.etapes.posts = {
        ok: true, recus: posts.length,
        apercu: posts.map((p) => ({
          id: p.id,
          date: p.created_time ? String(p.created_time).slice(0, 10) : null,
          commentaires: p.comments && p.comments.summary ? p.comments.summary.total_count : null,
          reactions: p.reactions && p.reactions.summary ? p.reactions.summary.total_count : null,
          texte: p.message ? String(p.message).replace(/\s+/g, ' ').slice(0, 60) : '',
        })),
      };
    } catch (e) {
      out.ok = false;
      out.etapes.posts = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 5. Commentaires — le test qui tranche ────────────────────────
    const cible = req.query && req.query.postId
      ? posts.find((p) => String(p.id) === String(req.query.postId)) || { id: String(req.query.postId) }
      : posts.find((p) => p.comments && p.comments.summary && Number(p.comments.summary.total_count) > 0);

    if (!cible) {
      out.etapes.commentaires = { ok: false, raison: 'aucune publication récente ne déclare de commentaire' };
    } else {
      const annonce = cible.comments && cible.comments.summary ? cible.comments.summary.total_count : null;
      out.etapes.commentaires = { postId: cible.id, commentsCountAnnonce: annonce };
      try {
        const r = await FB.graphGet(cible.id + '/comments', {
          filter: 'stream',
          fields: 'id,message,created_time,like_count,from{id,name},parent{id}',
          limit: 25,
        }, creds);
        const data = Array.isArray(r.data) ? r.data : [];
        const ech = data.slice(0, 20).map((c) => {
          const a = FB.auteurDe(c);
          return {
            de: a.nom, anonyme: !a.id,
            reponse: !!(c.parent && c.parent.id),
            texte: c.message != null ? String(c.message).slice(0, 80) : '',
            estGo: FB.contientMotCle(c.message, creds.keywords),
          };
        });
        out.etapes.commentaires.recus = data.length;
        out.etapes.commentaires.goDetectes = ech.filter((x) => x.estGo).length;
        out.etapes.commentaires.auteursIdentifies = ech.filter((x) => !x.anonyme).length + ' / ' + ech.length;
        out.etapes.commentaires.echantillon = ech;
        /* Le verdict porte sur ce qui est REÇU, pas sur l'absence d'erreur :
           une liste vide et une liste pleine ont le même code HTTP — c'est
           exactement ce qui a masqué le mode Développement côté Instagram. */
        out.etapes.commentaires.ok = data.length > 0;
        out.etapes.commentaires.verdict = data.length > 0
          ? 'commentaires accessibles'
          : 'Meta annonce ' + annonce + ' commentaire(s) et n\'en rend AUCUN, sans erreur : application en mode Développement, ou permission pages_read_user_content absente.';
        if (!data.length) out.ok = false;
      } catch (e) {
        out.etapes.commentaires.ok = false;
        out.etapes.commentaires.erreur = extraitErreur(e);
        out.ok = false;
      }
    }

    // ─── 5 bis. INSIGHTS — quelle métrique Meta accepte-t-il encore ? ──
    // Meta a supprimé 85 métriques de portée le 15/06/2026 et continuera.
    // Deviner leurs remplaçantes depuis la documentation s'est révélé
    // inutile : seule la réponse de l'API fait foi. On les teste donc une
    // par une, et on affiche le refus mot pour mot — c'est cette liste qui
    // dit ce que le tableau peut afficher, et ce qui n'existe plus.
    const CANDIDATS_POST = [
      'post_total_media_view_unique', 'post_impressions_unique', 'post_views',
      'post_impressions', 'blue_reels_play_count', 'post_video_views',
      'post_clicks', 'post_reactions_by_type_total', 'post_engaged_users',
      'post_activity', 'post_activity_unique', 'post_negative_feedback',
    ];
    const CANDIDATS_PAGE = [
      'page_views_total', 'page_post_engagements', 'page_impressions_unique',
      'page_impressions', 'page_fans', 'page_total_actions',
      'page_daily_follows', 'page_follows', 'page_video_views',
    ];

    async function testerMetriques(chemin, candidats, params) {
      const out = [];
      for (let i = 0; i < candidats.length; i++) {
        try {
          const j = await FB.graphGet(chemin, Object.assign({ metric: candidats[i] }, params || {}), creds);
          const d = Array.isArray(j.data) ? j.data : [];
          const v = d.length && Array.isArray(d[0].values) && d[0].values.length
            ? d[0].values[d[0].values.length - 1].value : null;
          out.push({ metrique: candidats[i], ok: true, valeur: v });
        } catch (e) {
          out.push({ metrique: candidats[i], ok: false, refus: String(e.message || '').slice(0, 120) });
        }
      }
      return out;
    }

    try {
      const state = await db.collection('_config').doc('facebook_sync_state').get();
      const st = state.exists ? (state.data() || {}) : {};
      out.etapes.insights = {
        memorisePost: st.metriquesPost || null,
        memorisePage: st.metriquesPage || null,
      };
      if (cible && cible.id) {
        out.etapes.insights.post = await testerMetriques(cible.id + '/insights', CANDIDATS_POST, {});
      }
      const b = FB.bornesJour(FB.decalerJour(FB.jourParis(), -1));
      out.etapes.insights.page = await testerMetriques(creds.pageId + '/insights', CANDIDATS_PAGE,
        { period: 'day', since: b.since, until: b.until });
      const okPost = (out.etapes.insights.post || []).filter((x) => x.ok).map((x) => x.metrique);
      const okPage = (out.etapes.insights.page || []).filter((x) => x.ok).map((x) => x.metrique);
      out.etapes.insights.verdict = 'publications : ' + (okPost.length ? okPost.join(', ') : 'AUCUNE métrique acceptée')
        + ' — page : ' + (okPage.length ? okPage.join(', ') : 'AUCUNE métrique acceptée');
    } catch (e) {
      out.etapes.insights = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 6. Messenger ─────────────────────────────────────────────────
    try {
      const r = await FB.graphGet(creds.pageId + '/conversations', {
        fields: 'id,updated_time,message_count', limit: 5,
      }, creds);
      const data = Array.isArray(r.data) ? r.data : [];
      out.etapes.messenger = {
        ok: true, conversationsVisibles: data.length,
        derniereMaj: data.length ? data[0].updated_time : null,
        /* Facebook, lui, rend l'historique : le rattrapage est possible,
           contrairement à Instagram où tout commence au branchement. */
        rattrapagePossible: data.length > 0,
      };
    } catch (e) {
      out.etapes.messenger = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 7. Ce que la base a retenu ───────────────────────────────────
    try {
      const [st, sp, sc, sd] = await Promise.all([
        db.collection('_config').doc('facebook_sync_state').get(),
        db.collection('fb_posts').limit(1).get(),
        db.collection('fb_comments').limit(1).get(),
        db.collection('fb_dm_threads').limit(1).get(),
      ]);
      const s = st.exists ? (st.data() || {}) : null;
      out.etapes.base = {
        ok: true,
        derniereSynchro: s && s.lastRun ? {
          posts: s.lastRun.posts, commentaires: s.lastRun.commentaires,
          goTotal: s.lastRun.goTotal, conversations: s.lastRun.conversations,
          messages: s.lastRun.messages, tronque: s.lastRun.tronque,
          erreurs: (s.lastRun.erreurs || []).slice(0, 5), dureeMs: s.lastRun.dureeMs,
        } : null,
        fbPostsVide: sp.empty, fbCommentsVide: sc.empty, fbDmVide: sd.empty,
      };
    } catch (e) {
      out.etapes.base = { ok: false, erreur: extraitErreur(e) };
    }

    res.status(200).json(out);
  } catch (e) {
    console.error('[facebook-diagnostic]', e);
    res.status(500).json({ ok: false, erreur: extraitErreur(e) });
  }
};
