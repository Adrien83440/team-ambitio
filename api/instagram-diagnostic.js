// ============================================================================
// api/instagram-diagnostic.js
// ----------------------------------------------------------------------------
// Diagnostic de la chaîne Instagram, appelable depuis le navigateur par un
// admin connecté (bouton « 🩺 Diagnostic » de l'onglet 📸 du Funnel Sales).
//
// URL  : GET https://team.alteore.com/api/instagram-diagnostic[?mediaId=...]
// Auth : jeton Firebase d'un admin (header Authorization: Bearer <idToken>),
//        même protocole que api/whatsapp-diagnostic.js. Aucun secret de cron
//        n'est nécessaire — c'est tout l'intérêt : le diagnostic se lance
//        depuis l'écran, par la personne qui constate le problème.
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// Un compteur de GO à zéro a deux causes opposées et de même apparence :
// les commentaires ne sont pas récupérés, ou ils le sont et ne contiennent
// pas le mot-clé. Les distinguer depuis l'écran relevait de la devinette ;
// depuis les logs, c'était invisible — l'échec d'un appel /comments est
// rangé dans un rapport, pas dans la console.
//
// Ce diagnostic interroge l'API EN DIRECT et renvoie la réponse brute :
// ce que Meta accepte, ce qu'il refuse, et pourquoi. Il ne lit aucune
// donnée déjà stockée — c'est la chaîne réelle qui est testée, pas son
// souvenir.
//
// AUCUNE ÉCRITURE. Aucun secret dans la réponse : ni jeton, ni appSecret,
// ni verifyToken — seulement leur présence et, pour le jeton, son échéance.
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const { db } = require('./_firebaseAdmin');
const IG = require('./_instagramClient');

function extraitErreur(e) {
  return {
    message: e && e.message ? String(e.message).slice(0, 400) : String(e),
    metaCode: e && e.metaCode != null ? e.metaCode : null,
    metaSubcode: e && e.metaSubcode != null ? e.metaSubcode : null,
    metaType: e && e.metaType ? e.metaType : null,
    httpStatus: e && e.httpStatus != null ? e.httpStatus : null,
  };
}

module.exports = async (req, res) => {
  const auth = await requireAdmin(req, res);
  if (!auth) return; /* requireAdmin a déjà répondu 401/403 */

  const out = { ok: true, etapes: {} };

  try {
    // ─── 1. Configuration ─────────────────────────────────────────────
    let creds;
    try {
      creds = await IG.getInstagramCreds(true);
      out.etapes.config = {
        ok: true,
        authMode: creds.authMode,
        host: creds.host,
        apiVersion: creds.apiVersion,
        igUserId: creds.igUserId,
        compteNom: creds.compteNom,
        keywords: creds.keywords,
        syncActif: creds.syncActif,
        tokenPresent: !!creds.token,
        tokenExpiresAt: creds.tokenExpiresAt,
        appSecretPresent: !!creds.appSecret,
        verifyTokenPresent: !!creds.verifyToken,
      };
    } catch (e) {
      out.ok = false;
      out.etapes.config = { ok: false, erreur: extraitErreur(e) };
      res.status(200).json(out);   // 200 : le diagnostic a abouti, c'est la config qui échoue
      return;
    }

    // ─── 2. Profil ────────────────────────────────────────────────────
    try {
      const p = await IG.graphGet(creds.igUserId, {
        fields: 'user_id,username,name,followers_count,media_count',
      }, creds);
      out.etapes.profil = { ok: true, username: p.username, userId: p.user_id || p.id,
                            followers: p.followers_count, medias: p.media_count };
    } catch (e) {
      out.ok = false;
      out.etapes.profil = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 2 bis. Permissions portées par le jeton ──────────────────────
    // Le point aveugle du reste du diagnostic : sans la permission
    // commentaires, l'edge /comments répond 200 avec une liste VIDE — pas
    // une erreur. Impossible de distinguer « pas le droit » de « pas de
    // commentaire » sans regarder les scopes eux-mêmes.
    // debug_token vit sur graph.facebook.com et exige appId + appSecret ;
    // si l'un manque, on le dit plutôt que d'échouer en silence.
    try {
      if (!creds.appId || !creds.appSecret) {
        out.etapes.permissions = {
          ok: false,
          raison: 'appId et/ou appSecret absents de _config/instagram_credentials — scopes non vérifiables',
        };
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
            scopes: scopes,
            valide: d.is_valid,
            expireLe: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
            /* Le verdict, en clair : c'est la seule ligne à lire. */
            peutLireCommentaires: scopes.some((x) => String(x).indexOf('manage_comments') >= 0),
            peutLireMessages: scopes.some((x) => String(x).indexOf('manage_messages') >= 0),
            peutLireInsights: scopes.some((x) => String(x).indexOf('manage_insights') >= 0),
          };
        }
      }
    } catch (e) {
      out.etapes.permissions = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 3. Dernières publications ────────────────────────────────────
    let medias = [];
    try {
      const r = await IG.graphGet(creds.igUserId + '/media', {
        fields: 'id,caption,media_type,media_product_type,timestamp,like_count,comments_count,permalink',
        limit: 12,
      }, creds);
      medias = Array.isArray(r.data) ? r.data : [];
      out.etapes.medias = {
        ok: true,
        recus: medias.length,
        apercu: medias.map((m) => ({
          id: m.id,
          date: m.timestamp ? String(m.timestamp).slice(0, 10) : null,
          type: m.media_product_type || m.media_type,
          commentsCount: m.comments_count,
          legende: m.caption ? String(m.caption).replace(/\s+/g, ' ').slice(0, 60) : '',
        })),
      };
    } catch (e) {
      out.ok = false;
      out.etapes.medias = { ok: false, erreur: extraitErreur(e) };
    }

    // ─── 4. Commentaires — LE test qui tranche ────────────────────────
    // Cible : la publication demandée, sinon la plus récente qui EN DÉCLARE.
    // Une publication à zéro commentaire ne prouverait rien.
    const cible = req.query && req.query.mediaId
      ? medias.find((m) => String(m.id) === String(req.query.mediaId)) || { id: String(req.query.mediaId) }
      : medias.find((m) => Number(m.comments_count) > 0);

    if (!cible) {
      out.etapes.commentaires = { ok: false, raison: 'aucune publication récente ne déclare de commentaire' };
    } else {
      out.etapes.commentaires = { mediaId: cible.id, commentsCountAnnonce: cible.comments_count };

      /* Deux formes, exactement celles du cron : avec les réponses, puis
         sans. Savoir LAQUELLE passe est la moitié du diagnostic. */
      const formes = [
        ['avec réponses', 'id,text,username,timestamp,like_count,replies.limit(50){id,text,username,timestamp,like_count}'],
        ['sans réponses', 'id,text,username,timestamp,like_count'],
      ];
      out.etapes.commentaires.essais = [];

      for (let i = 0; i < formes.length; i++) {
        try {
          const r = await IG.graphGet(cible.id + '/comments', { fields: formes[i][1], limit: 25 }, creds);
          const data = Array.isArray(r.data) ? r.data : [];
          let replies = 0;
          data.forEach((c) => { if (c.replies && Array.isArray(c.replies.data)) replies += c.replies.data.length; });

          /* Échantillon des textes : c'est ce qui permet de voir si un « Go »
             est là et n'a pas été reconnu, plutôt que d'en débattre. */
          const echantillon = [];
          data.slice(0, 15).forEach((c) => {
            echantillon.push({
              de: c.username || null,
              texte: c.text != null ? String(c.text).slice(0, 80) : '',
              estGo: IG.contientMotCle(c.text, creds.keywords),
              reponse: false,
            });
            const rep = c.replies && Array.isArray(c.replies.data) ? c.replies.data : [];
            rep.slice(0, 10).forEach((rr) => {
              echantillon.push({
                de: rr.username || null,
                texte: rr.text != null ? String(rr.text).slice(0, 80) : '',
                estGo: IG.contientMotCle(rr.text, creds.keywords),
                reponse: true,
              });
            });
          });

          out.etapes.commentaires.essais.push({
            forme: formes[i][0], ok: true,
            premierNiveau: data.length, reponses: replies,
            pageSuivante: !!(r.paging && r.paging.next),
            goDetectes: echantillon.filter((x) => x.estGo).length,
            echantillon: echantillon.slice(0, 25),
          });
          break;  // la première forme qui passe suffit
        } catch (e) {
          out.etapes.commentaires.essais.push({ forme: formes[i][0], ok: false, erreur: extraitErreur(e) });
        }
      }
      out.etapes.commentaires.ok = out.etapes.commentaires.essais.some((x) => x.ok);
      if (!out.etapes.commentaires.ok) out.ok = false;
    }

    // ─── 5. Ce que la base a retenu ───────────────────────────────────
    try {
      const snapState = await db.collection('_config').doc('instagram_sync_state').get();
      const st = snapState.exists ? (snapState.data() || {}) : null;
      const snapMedia = await db.collection('ig_media').limit(1).get();
      const snapComm = await db.collection('ig_comments').limit(1).get();
      out.etapes.base = {
        ok: true,
        derniereSynchro: st && st.lastRun ? {
          medias: st.lastRun.medias, commentaires: st.lastRun.commentaires,
          goTotal: st.lastRun.goTotal, days: st.lastRun.days, mediaDays: st.lastRun.mediaDays,
          tronque: st.lastRun.tronque, erreurs: (st.lastRun.erreurs || []).slice(0, 5),
          dureeMs: st.lastRun.dureeMs,
        } : null,
        igMediaVide: snapMedia.empty,
        igCommentsVide: snapComm.empty,
      };
    } catch (e) {
      out.etapes.base = { ok: false, erreur: extraitErreur(e) };
    }

    res.status(200).json(out);
  } catch (e) {
    console.error('[instagram-diagnostic]', e);
    res.status(500).json({ ok: false, erreur: extraitErreur(e) });
  }
};
