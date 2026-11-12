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

  /* ── Lien de réservation ────────────────────────────────────────────── */
  try {
    await ref.set({ clics: admin.firestore.FieldValue.increment(1), dernierClicA: Date.now(),
      premierClicA: lien.premierClicA || Date.now() }, { merge: true });
    if (lien.inscriptionId && !lien.test) {
      await db.collection('relance_inscriptions').doc(String(lien.inscriptionId))
        .set({ clics: admin.firestore.FieldValue.increment(1), dernierClicA: Date.now() }, { merge: true });
    }
    const cfg = await R.config();
    const types = await R.typesRdv();
    let lead = null;
    if (lien.leadId && !lien.test) {
      const ls = await db.collection('leads').doc(String(lien.leadId)).get();
      if (ls.exists) lead = Object.assign({ id: ls.id }, ls.data() || {});
    }
    /* Setter de repli : celui de la campagne d'abord, sinon le réglage général. */
    let repli = cfg.setterRepli;
    if (lien.campagneId) {
      const cs = await db.collection('relance_campagnes').doc(String(lien.campagneId)).get();
      if (cs.exists && (cs.data() || {}).setterRepli) repli = (cs.data() || {}).setterRepli;
    }
    const choix = R.typePourSetter(types, lead ? lead.assignedTo : (lien.setter || null), repli);
    if (!choix) {
      page(res, 200, 'Réservation', '<h1>Merci !</h1><p>Répondez simplement au message reçu : nous vous proposons un créneau dans la journée.</p>');
      return;
    }
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(302, { Location: R.urlReservation(choix.type, lead) });
    res.end();
  } catch (e) {
    console.error('[relance-lien] rdv', e && e.message);
    page(res, 500, 'Erreur', '<h1>Un instant…</h1><p>Le lien n\'a pas pu s\'ouvrir. Réessayez dans quelques minutes.</p>');
  }
};
