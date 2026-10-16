// ============================================================================
// api/meet-link.js — LIEN MEET SUIVI DES RDV (module Pilotage équipe, 16/10/2026)
// ----------------------------------------------------------------------------
// GET  /m/{bookingId}            → page relais qui compte le clic puis ouvre
//                                  la visio Google Meet du RDV
// POST /api/meet-link { id }     → beacon du clic (envoyé par la page relais)
// (réécriture /m/… déclarée dans vercel.json)
//
// POURQUOI
// --------
// Le pilotage veut savoir, en direct, si le prospect a cliqué sur le lien de
// sa visio. Les e-mails (confirmation, rappels J-1 / H-1) et la page de
// confirmation de booking.html portent désormais ce lien plutôt que le lien
// Meet brut — voir `meetTrackedLink`, posé par onBookingCreated quand
// _config/team_pilotage.meetTracking === true. L'invitation Google Agenda,
// elle, garde le lien brut (on ne la maîtrise pas) : un prospect qui rejoint
// depuis son agenda n'apparaît pas ici, d'où la présence Meet lue en plus
// par api/team-pilotage.js.
//
// REDIRECTION FERMÉE
// ------------------
// La destination n'est jamais fournie par l'appelant : on relit le meetLink
// du booking et on refuse tout ce qui n'est pas https://meet.google.com/…
// Même règle que api/group-redirect.js : aucune redirection ouverte sous
// notre nom de domaine.
//
// POURQUOI UNE PAGE RELAIS ET PAS UN 302
// --------------------------------------
// Les messageries (Outlook Safe Links, antivirus, aperçus) ouvrent les liens
// des e-mails toutes seules. Un 302 compterait ces visites automatiques comme
// des clics du prospect. La page relais ne compte le clic que si un vrai
// navigateur exécute son JavaScript (beacon POST), puis ouvre Meet ; sans
// JavaScript, la balise meta refresh ouvre Meet sans rien compter.
//
// STOCKAGE — collection `booking_meet/{bookingId}` (Admin SDK uniquement,
// aucune règle Firestore côté client) :
//   { bookingId, clicks, firstClickAt, lastClickAt, lastClickUa, updatedAt,
//     presence: {…} (écrit par api/team-pilotage.js) }
// Volontairement HORS du document bookings : les pages qui réécrivent un
// booking ne peuvent pas effacer ces champs, et aucun trigger
// onBookingUpdated ne se déclenche à chaque clic.
// Aucune adresse IP n'est journalisée.
// ============================================================================

const { admin, db } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');

const ID_VALIDE = /^[A-Za-z0-9_-]{5,64}$/;
const MEET_VALIDE = /^https:\/\/meet\.google\.com\/[a-z]{3,4}-[a-z]{4}-[a-z]{3,4}(\?[A-Za-z0-9=&_.-]*)?$/i;
// Robots connus (aperçus, scanners) : jamais comptés, même s'ils exécutent JS.
const ROBOTS = /bot|crawl|spider|preview|scanner|safelinks|proofpoint|mimecast|barracuda|headless|python|curl|wget|okhttp|facebookexternalhit|whatsapp|slack|teams|google-?(read-aloud|safety)/i;

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

async function meetLinkOf(id) {
  let lastErr = null;
  // Deux essais : un prospect qui clique à l'heure du RDV ne doit pas tomber
  // sur une page d'erreur à cause d'une lecture Firestore ratée au démarrage.
  for (let i = 0; i < 2; i++) {
    try {
      const snap = await db.collection('bookings').doc(id).get();
      if (!snap.exists) return null;
      const link = String((snap.data() || {}).meetLink || '').trim();
      return MEET_VALIDE.test(link) ? link : null;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
}

function relayPage(id, link) {
  const l = escHtml(link);
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="robots" content="noindex,nofollow">' +
    '<noscript><meta http-equiv="refresh" content="0;url=' + l + '"></noscript>' +
    '<title>Ouverture de la visioconférence…</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}' +
    '.c{max-width:420px;text-align:center}.c p{color:#475569;font-size:15px;line-height:1.6}' +
    '.c a{display:inline-block;margin-top:14px;padding:12px 22px;border-radius:10px;background:#16a34a;color:#fff;font-weight:700;text-decoration:none}</style>' +
    '</head><body><div class="c"><div style="font-size:34px">📹</div>' +
    '<p>Ouverture de votre visioconférence Google Meet…</p>' +
    '<a href="' + l + '" id="go">Rejoindre la visio</a></div>' +
    '<script>(function(){var u=' + JSON.stringify(link) + ';' +
    'try{var b=JSON.stringify({id:' + JSON.stringify(id) + '});' +
    'if(navigator.sendBeacon){navigator.sendBeacon("/api/meet-link",new Blob([b],{type:"text/plain"}));}' +
    'else{var x=new XMLHttpRequest();x.open("POST","/api/meet-link",false);x.setRequestHeader("Content-Type","text/plain");x.send(b);}}catch(e){}' +
    'setTimeout(function(){location.replace(u);},150);})();</script>' +
    '</body></html>';
}

function errorPage() {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow">' +
    '<title>Lien indisponible</title>' +
    '<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#f8fafc;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;padding:16px;box-sizing:border-box}.c{max-width:440px;text-align:center;color:#475569;font-size:15px;line-height:1.6}</style>' +
    '</head><body><div class="c"><div style="font-size:34px">📹</div>' +
    '<p>Ce lien de visioconférence n\'est pas disponible.<br>Retrouvez le lien Google Meet dans l\'invitation Google Agenda de votre rendez-vous, ou répondez à l\'e-mail de confirmation.</p>' +
    '</div></body></html>';
}

async function handleClick(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  let id = '';
  try {
    const body = parseBody(req) || {};
    id = String(body.id || '').trim();
  } catch (_) { /* corps illisible */ }
  if (!ID_VALIDE.test(id)) { res.status(204).end(); return; }

  const ua = String(req.headers['user-agent'] || '').replace(/[\r\n\t]/g, ' ').slice(0, 200);
  if (!ua || ROBOTS.test(ua)) { res.status(204).end(); return; }

  try {
    // Le booking doit exister : sinon n'importe qui pourrait créer des docs.
    const snap = await db.collection('bookings').doc(id).get();
    if (snap.exists) {
      const now = admin.firestore.Timestamp.now();
      const ref = db.collection('booking_meet').doc(id);
      await db.runTransaction(async function (tx) {
        const cur = await tx.get(ref);
        const patch = {
          bookingId: id,
          clicks: admin.firestore.FieldValue.increment(1),
          lastClickAt: now,
          lastClickUa: ua,
          updatedAt: now,
        };
        if (!cur.exists || !(cur.data() || {}).firstClickAt) patch.firstClickAt = now;
        tx.set(ref, patch, { merge: true });
      });
    }
  } catch (e) {
    console.error('[meet-link] clic', id, e.message);
  }
  // Écriture AVANT la réponse : Vercel tue la fonction dès res.end().
  res.status(204).end();
}

module.exports = async (req, res) => {
  if (req.method === 'POST') return handleClick(req, res);
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.status(405).end(); return; }

  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');

  const id = String((req.query && req.query.id) || '').trim();
  if (!ID_VALIDE.test(id)) { res.status(404).send(errorPage()); return; }

  let link = null;
  try {
    link = await meetLinkOf(id);
  } catch (e) {
    console.error('[meet-link] lecture', id, e.message);
  }
  if (!link) { res.status(404).send(errorPage()); return; }
  res.status(200).send(relayPage(id, link));
};
