// ============================================================================
// api/academy-seance.js — LA SÉANCE PART VERS L'ACADEMY
// ----------------------------------------------------------------------------
// Les séances de coaching se tiennent ICI, dans la fiche client. Cette route
// les pousse vers l'Academy pour que le dirigeant y voie son compte rendu et
// surtout les devoirs qu'on lui a donnés — et qu'il puisse cocher ce qu'il a
// fait avant la séance suivante.
//
// Rien n'est ressaisi : on transporte ce qui est déjà écrit dans la fiche.
//
// URL  : POST https://team.alteore.com/api/academy-seance
// Auth : Bearer ID token Firebase — rôles admin / coach / csm.
// Body : { clientId, numero, annee?, email? }
//        `numero` = le numéro de la séance dans la fiche.
//        `annee`  = le libellé de l'année si la fiche en utilise (les numéros
//                   repartent à 1 chaque année, l'identifiant doit les
//                   distinguer).
//
// Variable Vercel requise : ACADEMY_BRIDGE_KEY — déjà en place, la même que
// pour les autres ponts Academy. Rien à créer.
//
// LES DEVOIRS. Dans la fiche, « devoirs » est une zone de texte libre. Une
// LIGNE = UN DEVOIR : le coach continue d'écrire comme il l'a toujours fait,
// et chaque ligne devient une tâche cochable côté élève. Les puces (-, •, *)
// et la numérotation en tête de ligne sont retirées.
//
// L'ÉCHÉANCE d'un devoir est la date de la séance SUIVANTE quand elle est
// planifiée : c'est bien pour cette date-là qu'il est donné.
//
// IDENTIFIANTS STABLES. La séance et chacun de ses devoirs portent un
// identifiant déduit de leur position, pas tiré au hasard. Renvoyer deux fois
// la même séance la MET À JOUR au lieu d'en créer une seconde, et l'Academy
// conserve alors ce que l'élève a coché et ce que le coach a noté là-bas.
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { admin, db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');
const ROLES = ['admin', 'coach', 'csm'];

function cap(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

// AAAA-MM-JJ, ou chaîne vide. On ne convertit pas : on valide ce qui est écrit.
function dateOk(v) { return typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v); }

// Une ligne = un devoir. On retire les puces et la numérotation de tête, on
// écarte les lignes vides et les lignes trop courtes pour être une consigne.
function devoirsDepuisTexte(texte, echeance, prefixe) {
  return String(texte == null ? '' : texte)
    .split(/\r?\n/)
    .map(function (l) { return l.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, '').trim(); })
    .filter(function (l) { return l.length > 2; })
    .slice(0, 20)
    .map(function (l, i) {
      return { id: prefixe + '-d' + i, texte: cap(l, 600), outil: '', echeance: echeance || '' };
    });
}

// Toutes les séances de la fiche, à plat, avec l'année d'où elles viennent.
function toutesLesSeances(c) {
  const out = [];
  ((c.years) || []).forEach(function (y) {
    ((y.sessions) || []).forEach(function (s) { out.push({ s: s, annee: y.label || y.annee || y.year || '' }); });
  });
  ((c.sessions) || []).forEach(function (s) { out.push({ s: s, annee: '' }); });
  return out;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }

  let auth = null;
  try {
    auth = await requireAuth(req, res);
    if (!auth) return;
    if (ROLES.indexOf(auth.role) < 0) { res.status(403).json({ ok: false, error: 'forbidden' }); return; }
  } catch (e) {
    res.status(e && e.statusCode ? e.statusCode : 401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  const key = process.env.ACADEMY_BRIDGE_KEY || '';
  if (!key) { res.status(200).json({ ok: false, error: 'bridge_not_configured' }); return; }

  const body = req.body || {};
  const clientId = String(body.clientId || '').trim();
  const numero = Number(body.numero);
  if (!clientId || !isFinite(numero)) {
    res.status(200).json({ ok: false, error: 'clientId_numero_required' });
    return;
  }

  try {
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) { res.status(200).json({ ok: false, error: 'client_not_found' }); return; }
    const c = snap.data() || {};

    const email = String(body.email || c.email || '').trim().toLowerCase();
    if (!email) { res.status(200).json({ ok: false, error: 'email_client_absent' }); return; }

    const annee = String(body.annee || '').trim();
    const liste = toutesLesSeances(c);
    const trouvee = liste.find(function (x) {
      return Number(x.s.numero) === numero && (!annee || String(x.annee) === annee);
    });
    if (!trouvee) { res.status(200).json({ ok: false, error: 'seance_introuvable' }); return; }
    const s = trouvee.s;

    // La séance suivante, pour dater les devoirs. On cherche dans la même
    // année, puis à défaut la première séance planifiée plus tard.
    const memeAnnee = liste.filter(function (x) { return String(x.annee) === String(trouvee.annee); });
    const suivante = memeAnnee.find(function (x) { return Number(x.s.numero) === numero + 1; })
      || liste.filter(function (x) { return dateOk(x.s.date) && dateOk(s.date) && x.s.date > s.date; })
        .sort(function (a, b) { return a.s.date.localeCompare(b.s.date); })[0];
    const echeance = suivante && dateOk(suivante.s.date) ? suivante.s.date : '';

    // Identifiant stable : même séance renvoyée = mise à jour, jamais doublon.
    const seanceId = 'alteor-' + (trouvee.annee ? String(trouvee.annee).replace(/\s+/g, '') + '-' : '') + numero;

    const charge = {
      email: email,
      seanceId: seanceId,
      date: dateOk(s.date) ? s.date : '',
      coach: String(s.coach || ''),
      lienVisio: String(s.lienVisio || s.visio || s.meetUrl || ''),
      lienCompteRendu: String(s.lienCompteRendu || s.docUrl || s.lienDoc || ''),
      // Ce que l'élève LIT.
      resumePartage: cap(s.resume || '', 4000),
      // Ce qu'il ne verra jamais : l'Academy le range dans une zone séparée.
      notesInternes: cap(s.notes || '', 8000),
      devoirs: devoirsDepuisTexte(s.devoirs, echeance, seanceId),
    };

    const r = await fetch(ACADEMY_URL + '/api/bridge/seance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify(charge),
    });
    let j = null;
    try { j = await r.json(); } catch (e) { j = null; }
    if (!j || j.ok !== true) { res.status(200).json({ ok: false, error: 'academy_unreachable' }); return; }
    if (!j.found) { res.status(200).json({ ok: true, found: false }); return; }

    // Trace dans la fiche — fail-soft : l'envoi a déjà réussi, une trace
    // manquante ne doit pas faire croire à un échec.
    try {
      await db.collection('clients').doc(clientId).update({
        academySeanceHistory: admin.firestore.FieldValue.arrayUnion({
          at: Date.now(),
          by: auth.email || auth.uid,
          seanceId: seanceId,
          numero: numero,
          devoirs: charge.devoirs.length,
          misAJour: !!j.misAJour,
        }),
      });
    } catch (e) { console.warn('[academy-seance] trace fiche impossible:', e && e.message); }

    res.status(200).json({
      ok: true, found: true,
      seance: j.seance || {},
      misAJour: !!j.misAJour,
      devoirs: charge.devoirs.length,
      echeance: echeance,
    });
  } catch (e) {
    console.error('[academy-seance]', e && e.message);
    res.status(200).json({ ok: false, error: 'internal' });
  }
};
