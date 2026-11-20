// ============================================================================
// api/meta-ip.js — ADRESSE IP DU VISITEUR POUR L'API CONVERSIONS (20/11/2026)
// ----------------------------------------------------------------------------
// Diagnostic Meta « Envoyez le paramètre d'adresse IP manquant » : pour les
// leads du quiz Élite (créés par Make → lead-optin : l'IP vue est celle de
// Make) et pour les RDV (booking.html écrit le RDV directement dans
// Firestore), aucun serveur ne voyait l'IP réelle du visiteur. Le navigateur
// appelle donc ici, au même moment que son événement pixel :
//   · le quiz, à l'envoi du formulaire (api/_quizMetaIds.js), avec l'event_id
//     du Lead ;
//   · booking.html, à la confirmation du RDV, avec l'id du RDV (= event_id
//     du Schedule).
// Seulement quand le pixel est autorisé chez ce visiteur (jamais YouTube,
// jamais un refus de cookies : la page n'appelle pas).
//
//   POST { e: <event_id> }  public, aucune réponse utile (204)
//
// DONNÉES : meta_ip/{event_id} { ip, ua, at, expireAt } — Admin SDK seul,
// AUCUNE règle Firestore. Jamais écrasé (le premier appel fait foi). Lu par
// api/meta-capi-cron.js, qui joint l'IP (et le navigateur de CET appel) à
// l'événement correspondant. EFFACÉ après 8 jours (expireAt, purge dans le
// cron) : Meta refuse tout événement de plus de 7 jours, l'IP ne sert plus à
// rien ensuite — exception à « rien n'est jamais supprimé » validée par
// Adrien le 20/11/2026 (comme tunnel_visits).
// ============================================================================
'use strict';

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const MetaIds = require('./_metaIds');

const COL = 'meta_ip';
const KEEP_MS = 8 * 86400000;
/* Clé du document pour un event_id (aussi utilisée par la lecture). */
function keyOf(e) { return String(e || '').replace(/[/.]/g, '_').slice(0, 100); }

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.status(405).end(); return; }
  try {
    const body = parseBody(req) || {};
    const e = String(body.e || '').trim();
    const ip = MetaIds.clientIp(req);
    if (!/^[A-Za-z0-9_.:-]{6,100}$/.test(e) || !ip) { res.status(204).end(); return; }
    const ref = db.collection(COL).doc(keyOf(e));
    const now = Date.now();
    try {
      await ref.create({
        ip: ip,
        ua: String(req.headers['user-agent'] || '').slice(0, 400),
        at: admin.firestore.Timestamp.fromMillis(now),
        expireAt: admin.firestore.Timestamp.fromMillis(now + KEEP_MS)
      });
    } catch (err) {
      /* Déjà présent (code 6 ALREADY_EXISTS) : le premier appel fait foi. */
      if (!(err && (err.code === 6 || /already exists/i.test(String(err.message))))) throw err;
    }
    res.status(204).end();
  } catch (err) {
    console.error('[meta-ip]', err && err.message);
    res.status(204).end();
  }
};
module.exports.COL = COL;
module.exports.keyOf = keyOf;
