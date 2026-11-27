// ============================================================================
// api/_offerRelancesAuto.js — ENVOI AUTOMATIQUE DES RELANCES D'OFFRES
// (27/11/2026, demande d'Adrien : « à J+10, si ce n'est pas closé et qu'il y a
// une offre sans relance, ça envoie le SMS et le mail sans me demander, et ça
// refait la même chose à J+30 s'il n'y a pas eu de réponse »)
// ----------------------------------------------------------------------------
// Ne décide RIEN de nouveau : il s'appuie sur api/_offerRelances.js — la même
// liste (listOffers), la même rédaction (draftOffer), le même envoi avec tous
// ses refus (sendOffer : prospect qui a répondu, client, désinscrit, séquence
// en cours, contenu interdit, prix, plafond, écart entre deux relances…).
//
// Décisions d'Adrien (27/11/2026) :
//   1. Partent seuls les CAS NETS : catégorie « À relancer », dossier
//      exploitable. Restent à la main dans la page : situation sensible,
//      message signalé à corriger, dossier trop mince, « Rappel convenu »,
//      tout ce que l'IA reclasse. L'automate note alors `auto.etat:
//      'a_la_main'` et le motif, et ne revient pas dessus.
//   2. Jamais pendant la séquence d'e-mails d'après-RDV : une offre en attente
//      part à J+10, un non closé à la fin de sa séquence (la liste le range
//      dans « Séquence en cours » jusque-là).
//   3. Deuxième relance : sans réponse, 30 jours après le rendez-vous et au
//      moins 20 jours après la première. Jamais de troisième par l'automate.
//   4. Stock existant lissé : `plafondJour` (10) envois par jour au plus, du
//      rendez-vous le plus récent au plus ancien, 3 par passage.
//   5. À BLANC d'abord (`modeTest`, vrai par défaut) : l'automate rédige et
//      note `auto.etat: 'a_blanc'` — la page montre ce qui serait parti —
//      sans rien envoyer. En réel, le message relu à blanc part tel quel.
//
// Heures : 9 h – 19 h, heure de Paris, jamais le dimanche ni un jour férié
// (règle de relances-core.js). Une relance manuelle du closer compte comme une
// relance : l'automate ne double jamais un envoi fait à la main.
//
// Réglages : _config/offer_relances.auto { actif, modeTest, plafondJour,
//   secondeJours, secondeRdvJours, depuis, historique }.
// Traces (Admin SDK seul) : offer_relances/{bookingId}.auto { relance, etat,
//   motif, at, email, sms, essais } ; compteur du jour
//   offer_relances_auto/{AAAA-MM-JJ} { n }.
// Fichier préfixé `_` : exclu du routing Vercel.
// ============================================================================
'use strict';

const { db, admin } = require('./_firebaseAdmin');
const O = require('./_offerRelances');
const Core = require('../relances-core.js');

const COL = 'offer_relances';
const PAR_PASSAGE = 3;
const BUDGET_MS = 240000;
const PLAGE = { heureDebut: 9, heureFin: 19 };

function jourParis(ms) { return new Date(ms).toLocaleDateString('fr-CA', { timeZone: 'Europe/Paris' }); }

/* Quelle relance l'automate doit-il à ce prospect ? 0 = aucune. */
function relanceDue(x, A, now) {
  if (x.category !== 'a_relancer' || x.sensible || !x.hasEmail || x.plafond || x.nextAt) return 0;
  if (!x.note) return 0; // dossier sans note : à la main
  if (!x.dejaRelance) return 1;
  if (x.dejaRelance === 1 && x.days >= A.secondeRdvJours && x.derniereRelanceAt && now - x.derniereRelanceAt >= A.secondeJours * 86400000) return 2;
  return 0;
}

/* Déjà traité pour cette relance ? (à blanc déjà noté, laissé à la main,
   envoyé, ou trois échecs techniques) */
function dejaVu(x, n, A) {
  const a = x.auto;
  if (!a || a.relance !== n) return false;
  if (a.etat === 'a_la_main' || a.etat === 'envoye') return true;
  if (a.etat === 'a_blanc') return A.modeTest; // en réel, le message relu à blanc part
  if (a.etat === 'erreur') return (a.essais || 0) >= 3;
  return false;
}

async function noter(id, auto) {
  await db.collection(COL).doc(id).set({ auto: auto, updatedAt: Date.now() }, { merge: true });
}

async function compteurDuJour(ymd) {
  const s = await db.collection('offer_relances_auto').doc(ymd).get();
  return s.exists ? ((s.data() || {}).n || 0) : 0;
}
async function compter(ymd) {
  await db.collection('offer_relances_auto').doc(ymd).set({ n: admin.firestore.FieldValue.increment(1), majA: Date.now() }, { merge: true });
}

async function traiter(x, n, A) {
  const id = x.bookingId, now = Date.now();
  // L'automate agit au nom du closer qui porte le prospect (signature, rappel
  // d'appel du lendemain) ; `_auto` n'existe que côté serveur.
  const auth = { uid: x.closerUid || 'auto', role: 'admin', email: null };
  const me = { name: x.closerName && x.closerName !== '—' ? x.closerName : null, slug: null, _auto: true };
  const essais = (x.auto && x.auto.relance === n && x.auto.etat === 'erreur') ? (x.auto.essais || 0) : 0;
  const relu = !!(x.auto && x.auto.relance === n && x.auto.etat === 'a_blanc' && x.draft && x.draft.emailBody);

  if (!relu) {
    const d = await O.draftOffer(auth, { bookingId: id }, me);
    if (d.error) {
      // Un refus de règle (409 : séquence en cours, désinscrit…) n'est pas une panne.
      if (d.code === 409) { await noter(id, { relance: n, etat: 'a_la_main', motif: d.message || d.error, at: now }); return 'a_la_main'; }
      await noter(id, { relance: n, etat: 'erreur', motif: String(d.message || d.error).slice(0, 200), at: now, essais: essais + 1 });
      return 'erreur';
    }
    let motif = null;
    if (d.category !== 'a_relancer') motif = 'L\'IA l\'a classé « ' + (O.CATEGORIES[d.category] || d.category) + ' » : ' + (d.reason || '');
    else if (d.draft.alerte) motif = 'Message à corriger : ' + d.draft.alerte;
    else if (d.draft.ficheVide) motif = 'Dossier trop mince pour un message précis : complétez la note du rendez-vous.';
    else if (!d.draft.emailSubject || !d.draft.emailBody) motif = 'Message incomplet.';
    if (motif) { await noter(id, { relance: n, etat: 'a_la_main', motif: motif.slice(0, 300), at: now }); return 'a_la_main'; }
  }
  const sms = !!(x.hasPhone && !x.smsStop);
  if (A.modeTest) {
    if (!relu) await noter(id, { relance: n, etat: 'a_blanc', at: now, email: true, sms: sms });
    return 'a_blanc';
  }
  const r = await O.sendOffer(auth, { bookingId: id, email: true, sms: sms }, me);
  if (r.error) {
    if (r.code === 409 || r.code === 400) { await noter(id, { relance: n, etat: 'a_la_main', motif: r.message || r.error, at: now }); return 'a_la_main'; }
    await noter(id, { relance: n, etat: 'erreur', motif: String(r.message || r.error).slice(0, 200), at: now, essais: essais + 1 });
    return 'erreur';
  }
  await noter(id, { relance: n, etat: 'envoye', at: r.at || now, email: !!r.email, sms: !!r.sms, smsError: r.smsError || null });
  return 'envoye';
}

/* Un passage. `simulation` : compte seulement, aucune rédaction, aucune écriture. */
async function passage(opts) {
  const sim = !!(opts && opts.simulation);
  const debut = Date.now();
  const cfg = await O.loadConfig();
  const A = cfg.auto;
  const out = { ok: true, actif: A.actif, modeTest: A.modeTest, plafondJour: A.plafondJour, simulation: sim };
  if (!A.actif && !sim) { out.fait = 'eteint'; return out; }
  out.ouvert = Core.ouvert(debut, PLAGE);
  if (!out.ouvert && !sim) { out.fait = 'hors_plage'; return out; }

  const L = await O.listOffers({ uid: 'auto', role: 'admin' }, { days: 60, all: true });
  const dus = [];
  (L.items || []).forEach(function (x) {
    const n = relanceDue(x, A, debut);
    if (n && !dejaVu(x, n, A)) dus.push({ x: x, n: n });
  });
  // Du rendez-vous le plus récent au plus ancien.
  dus.sort(function (a, b) { return a.x.days - b.x.days; });
  const ymd = jourParis(debut);
  const deja = await compteurDuJour(ymd);
  out.dus = dus.length;
  out.premiere = dus.filter(function (d) { return d.n === 1; }).length;
  out.seconde = dus.filter(function (d) { return d.n === 2; }).length;
  out.aujourdhui = deja;
  out.reste = Math.max(0, A.plafondJour - deja);
  if (sim) return out;

  const res = { a_blanc: 0, envoye: 0, a_la_main: 0, erreur: 0 };
  let faits = 0;
  for (let i = 0; i < dus.length; i++) {
    if (faits >= PAR_PASSAGE || deja + res.a_blanc + res.envoye >= A.plafondJour || Date.now() - debut > BUDGET_MS) break;
    let r;
    try { r = await traiter(dus[i].x, dus[i].n, A); }
    catch (e) {
      console.error('[offer-relances-auto]', dus[i].x.bookingId, e && e.message);
      r = 'erreur';
      try { await noter(dus[i].x.bookingId, { relance: dus[i].n, etat: 'erreur', motif: String(e && e.message || e).slice(0, 200), at: Date.now(), essais: ((dus[i].x.auto && dus[i].x.auto.essais) || 0) + 1 }); } catch (e2) { /* trace impossible */ }
    }
    res[r] = (res[r] || 0) + 1;
    faits++;
    if (r === 'a_blanc' || r === 'envoye') await compter(ymd);
  }
  out.resultat = res;
  return out;
}

/* Réglage (allumer, éteindre, passer en réel, plafond). Trace dans
   `auto.historique`. Le passage en réel exige « PRODUCTION ». */
async function regler(body, par) {
  const ref = db.collection('_config').doc('offer_relances');
  const s = await ref.get();
  const cur = (s.exists && (s.data() || {}).auto) || {};
  const patch = {};
  if (typeof body.actif === 'boolean') patch.actif = body.actif;
  if (typeof body.modeTest === 'boolean') patch.modeTest = body.modeTest;
  if (body.plafondJour != null) patch.plafondJour = Math.min(50, Math.max(1, parseInt(body.plafondJour, 10) || 10));
  if (!Object.keys(patch).length) return { ok: false, erreur: 'rien_a_modifier' };
  if (patch.modeTest === false && String(body.confirmation || '') !== 'PRODUCTION') return { ok: false, erreur: 'Passage en réel : confirmation « PRODUCTION » exigée' };
  if (patch.actif === true && cur.actif !== true) patch.depuis = Date.now();
  const suivant = Object.assign({}, cur, patch);
  suivant.historique = (Array.isArray(cur.historique) ? cur.historique : []).concat([{ at: Date.now(), par: par, champs: patch }]).slice(-50);
  await ref.set({ auto: suivant }, { merge: true });
  return { ok: true, auto: { actif: suivant.actif === true, modeTest: suivant.modeTest !== false, plafondJour: suivant.plafondJour || 10 } };
}

module.exports = { passage, regler, relanceDue, dejaVu };
