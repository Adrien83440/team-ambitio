// ============================================================================
// api/relance-lien.js — LIENS COURTS DES RELANCES (12/11/2026)
// ----------------------------------------------------------------------------
// GET  /r/{jeton}   (réécriture vercel.json → /api/relance-lien?t={jeton})
//   · lien « rdv »  → 302 vers le lien de réservation du SETTER ASSIGNÉ
//                     (type « 🔗 setter », compté en No Booking), pré-rempli
//                     et rattaché à la fiche par ?leadId= ;
//   · lien « stop » → page de confirmation « Plus intéressé ».
// POST /r/{jeton}   (lien « stop » seulement) → confirme : étape Disqualifié,
//                   statut pas_interesse, exclusion définitive des relances.
//
// POURQUOI UN LIEN COURT
//   · Le bouton d'un modèle WhatsApp a une base d'URL FIGÉE à l'approbation
//     (https://team.alteore.com/r/{{1}}) : seul le jeton varie.
//   · Le setter est lu AU CLIC : une réattribution entre l'envoi et le clic
//     envoie quand même vers la bonne personne.
//   · On compte les clics, par étape.
//
// REDIRECTION FERMÉE : la destination est toujours construite ici, jamais
// lue dans l'URL. Aucune adresse IP n'est journalisée.
//
// « PLUS INTÉRESSÉ » EXIGE UN CLIC SUR LA PAGE : WhatsApp, Gmail et les
// antivirus de messagerie pré-chargent les liens. Un GET qui disqualifierait
// le lead le ferait donc à la place du prospect.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const R = require('./_relances');

function page(res, code, titre, corps) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  res.status(code).send('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>' + titre + '</title>'
    + '<style>body{font-family:Arial,sans-serif;background:#f6f5fb;color:#1f2937;margin:0;padding:40px 18px}'
    + '.c{max-width:460px;margin:0 auto;background:#fff;border-radius:16px;padding:28px 24px;box-shadow:0 6px 30px rgba(0,0,0,.07);text-align:center}'
    + 'h1{font-size:20px;margin:0 0 10px}p{font-size:15px;line-height:1.6;color:#4b5563}'
    + 'button{margin-top:14px;padding:12px 20px;border:0;border-radius:10px;background:#6d5efc;color:#fff;font-size:15px;font-weight:700;cursor:pointer}</style>'
    + '</head><body><div class="c">' + corps + '</div></body></html>');
}

module.exports = async (req, res) => {
  const t = String((req.query && req.query.t) || '').trim();
  if (!/^[A-Za-z0-9]{6,32}$/.test(t)) { page(res, 404, 'Lien introuvable', '<h1>Lien introuvable</h1><p>Ce lien n\'est pas valide.</p>'); return; }

  const ref = db.collection('relance_liens').doc(t);
  let lien;
  try {
    const s = await ref.get();
    lien = s.exists ? (s.data() || {}) : null;
  } catch (e) {
    console.error('[relance-lien]', e && e.message);
    page(res, 500, 'Erreur', '<h1>Un instant…</h1><p>Le lien n\'a pas pu s\'ouvrir. Réessayez dans quelques minutes.</p>');
    return;
  }
  if (!lien) { page(res, 404, 'Lien expiré', '<h1>Lien expiré</h1><p>Répondez simplement au message reçu : nous revenons vers vous.</p>'); return; }

  /* ── « Plus intéressé » ─────────────────────────────────────────────── */
  if (lien.type === 'stop') {
    if (req.method === 'POST') {
      try {
        if (!lien.test && lien.leadId) {
          await require('./_relances-hooks').plusInteresse(lien.leadId, { canal: 'lien', campagneId: lien.campagneId });
        }
        await ref.set({ confirmeA: Date.now() }, { merge: true });
      } catch (e) {
        console.error('[relance-lien] stop', e && e.message);
      }
      page(res, 200, 'C\'est noté', '<h1>C\'est noté.</h1><p>Nous ne vous relancerons plus. Merci de nous avoir répondu, et belle continuation.</p>');
      return;
    }
    page(res, 200, 'Plus intéressé ?', '<h1>Vous ne souhaitez plus être recontacté(e) ?</h1>'
      + '<p>Un clic suffit : nous arrêtons nos messages.</p>'
      + '<form method="POST"><button type="submit">Je ne suis plus intéressé(e)</button></form>');
    return;
  }

  /* ── Lien de réservation et page vidéo ─────────────────────────────────
     LE CLIC EST COMPTÉ PAR LE NAVIGATEUR DU LEAD, PAS À LA LECTURE DU LIEN :
     iMessage, WhatsApp et les antivirus de messagerie ouvrent le lien eux-
     mêmes pour fabriquer l'aperçu. Compté côté serveur, presque chaque lead
     passerait pour « a cliqué » et sortirait à tort de la campagne de suivi.
     La page envoie donc un POST (action=clic / vue) depuis le navigateur ;
     les robots d'aperçu n'exécutent pas ce JavaScript. */
  try {
    if (req.method === 'POST') {
      const b = (req.body && typeof req.body === 'object') ? req.body : {};
      const act = String(b.action || '');
      if (lien.type === 'video' && act === 'stop') {
        if (!lien.test && lien.leadId) await require('./_relances-hooks').plusInteresse(lien.leadId, { canal: 'lien', campagneId: lien.campagneId });
        await ref.set({ stopA: Date.now() }, { merge: true });
        page(res, 200, 'C\'est noté', '<h1>C\'est noté.</h1><p>Nous ne vous relancerons plus. Merci de nous avoir répondu, et belle continuation.</p>');
        return;
      }
      if (act === 'clic' || act === 'vue') await compterClic(ref, lien);
      res.setHeader('Cache-Control', 'no-store');
      res.status(204).end();
      return;
    }

    const cfg = await R.config();
    const types = await R.typesRdv();
    let lead = null;
    if (lien.leadId && !lien.test) {
      const ls = await db.collection('leads').doc(String(lien.leadId)).get();
      if (ls.exists) lead = Object.assign({ id: ls.id }, ls.data() || {});
    }
    /* Lien PUBLIC par défaut (Self Booking, choix d'Adrien du 14/11/2026) ;
       lien du setter seulement si la campagne porte lienRdv: 'setter'. */
    let camp = null;
    if (lien.campagneId) {
      const cs = await db.collection('relance_campagnes').doc(String(lien.campagneId)).get();
      if (cs.exists) camp = cs.data() || {};
    }
    const choix = R.typeReservation(types, camp, cfg, lead ? lead.assignedTo : (lien.setter || null));
    const resa = choix ? R.urlReservation(choix.type, lead) : null;
    const compte = "<script>(function(){try{var x=new XMLHttpRequest();x.open('POST',location.href,true);"
      + "x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');x.send('action=ACT');}catch(e){}})();</script>";

    if (lien.type === 'video') {
      const video = videoDe(camp, cfg);
      const prenom = lead ? R.Core.prenom(lead) : '';
      pageVideo(res, prenom, video, resa, compte.replace('ACT', 'vue'));
      return;
    }

    if (!resa) {
      page(res, 200, 'Réservation', '<h1>Merci !</h1><p>Répondez simplement au message reçu : nous vous proposons un créneau dans la journée.</p>');
      return;
    }
    /* Page relais : compte le clic depuis le navigateur, puis ouvre la
       réservation aussitôt (lien de secours sans JavaScript). */
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    res.status(200).send('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
      + '<title>Réservation</title></head><body style="font-family:Arial,sans-serif;text-align:center;padding:40px 16px;color:#374151">'
      + '<p>Ouverture de la page de réservation…</p><p><a href="' + echap(resa) + '">Continuer</a></p>'
      + "<script>(function(){var d='" + resa.replace(/\\/g, '').replace(/'/g, '%27') + "',f=false;function go(){if(f)return;f=true;location.replace(d);}"
      + "try{var x=new XMLHttpRequest();x.open('POST',location.href,true);x.setRequestHeader('Content-Type','application/x-www-form-urlencoded');"
      + "x.onloadend=go;x.send('action=clic');}catch(e){go();}setTimeout(go,900);})();</script></body></html>");
  } catch (e) {
    console.error('[relance-lien] rdv', e && e.message);
    page(res, 500, 'Erreur', '<h1>Un instant…</h1><p>Le lien n\'a pas pu s\'ouvrir. Réessayez dans quelques minutes.</p>');
  }
};

function echap(t) {
  return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
async function compterClic(ref, lien) {
  await ref.set({ clics: admin.firestore.FieldValue.increment(1), dernierClicA: Date.now(),
    premierClicA: lien.premierClicA || Date.now() }, { merge: true });
  if (lien.inscriptionId && !lien.test) {
    await db.collection('relance_inscriptions').doc(String(lien.inscriptionId))
      .set({ clics: admin.firestore.FieldValue.increment(1), dernierClicA: Date.now() }, { merge: true });
  }
}
/* Vidéo de la page : URL saisie sur la 1re étape WhatsApp de la campagne,
   sinon la vidéo par défaut servie par team.alteore.com. */
function videoDe(camp, cfg) {
  const e = ((camp && camp.etapes) || []).filter(function (x) { return x && x.canal === 'whatsapp' && /^https:\/\//.test(String(x.videoUrl || '')); })[0];
  let v = (e && e.videoUrl) || cfg.videoPage || R.Core.DEFAUTS.videoPage;
  if (v.charAt(0) === '/') v = R.BASE_URL + v;
  return v;
}
/* Page vidéo du SMS de repli : la vidéo, et le calendrier de réservation
   INTÉGRÉ à côté (ordinateur) ou juste en dessous (téléphone). booking.html
   en ?embed=1 envoie sa hauteur (bk_height) et, une fois le RDV confirmé,
   redirige toute la page vers la confirmation. */
function pageVideo(res, prenom, video, resa, compte) {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex');
  const cadre = resa ? resa + (resa.indexOf('?') >= 0 ? '&' : '?') + 'embed=1' : null;
  res.status(200).send('<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1"><title>Une vidéo pour vous</title>'
    + '<style>body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif;background:#f6f5fb;color:#1f2937}'
    + '.c{max-width:1180px;margin:0 auto;padding:22px 16px 40px}h1{font-size:21px;margin:6px 0 4px}p{font-size:15px;line-height:1.55;color:#4b5563;margin:0 0 14px}'
    + '.g{display:grid;grid-template-columns:minmax(0,1fr);gap:18px;align-items:start}'
    + '@media (min-width:900px){.g{grid-template-columns:minmax(0,1fr) minmax(0,1.15fr)}.v{position:sticky;top:16px}}'
    + 'video{width:100%;border-radius:14px;background:#000;display:block;box-shadow:0 6px 30px rgba(0,0,0,.12)}'
    + '.r{background:#fff;border-radius:14px;box-shadow:0 6px 30px rgba(0,0,0,.07);overflow:hidden}'
    + '.r h2{font-size:16px;margin:0;padding:14px 16px 4px}.r iframe{display:block;width:100%;height:760px;border:0}'
    + '.b{display:block;margin:14px 0 0;padding:15px;border-radius:12px;background:#6d5efc;color:#fff;text-align:center;font-size:17px;font-weight:700;text-decoration:none}'
    + '.s{background:none;border:0;color:#9ca3af;font-size:13px;text-decoration:underline;cursor:pointer;display:block;margin:18px auto 0}</style></head>'
    + '<body><div class="c"><h1>' + (prenom ? 'Bonjour ' + echap(prenom) + ',' : 'Bonjour,') + '</h1>'
    + '<p>J\'ai enregistré cette courte vidéo pour vous. Regardez-la, puis choisissez votre créneau' + (cadre ? ' juste à côté.' : ' juste en dessous.') + '</p>'
    + '<div class="g"><div class="v"><video src="' + echap(video) + '" controls playsinline preload="metadata"></video>'
    + (resa ? '<a class="b" href="' + echap(cadre ? '#resa' : resa) + '">Réserver mon appel</a>' : '') + '</div>'
    + (cadre ? '<div class="r" id="resa"><h2>Choisissez votre créneau</h2><iframe id="bk" src="' + echap(cadre) + '" title="Réservation" loading="lazy"></iframe></div>' : '')
    + '</div>'
    + '<form method="POST"><input type="hidden" name="action" value="stop"><button class="s" type="submit">Je ne suis plus intéressé(e)</button></form>'
    + '<p style="text-align:center;font-size:13px;margin-top:22px">Adrien &amp; Emily</p></div>'
    + "<script>(function(){var f=document.getElementById('bk');if(!f)return;window.addEventListener('message',function(e){"
    + "if(e.origin!==location.origin||!e.data||e.data.type!=='bk_height')return;var h=+e.data.h;if(h>200)f.style.height=Math.min(h+20,2400)+'px';});})();</script>"
    + compte + '</body></html>');
}
