// ============================================================================
// api/_settingReveil.js — RÉVEIL DU SETTING ÉCRIT SUR MESSAGE REÇU (27/11/2026)
// ----------------------------------------------------------------------------
// Demande d'Adrien : quand un prospect répond en message privé Instagram ou
// Messenger, le setting écrit (agent Claude dans Meta Business Suite) doit lui
// répondre dans les minutes qui suivent, pas au passage horaire suivant.
//
// COMMENT : Meta prévient déjà Team à chaque message (instagram-webhook,
// facebook-webhook). Sur un message ENTRANT (jamais un écho de nos propres
// envois), Team appelle l'adresse d'appel d'une tâche Claude sans horaire
// (« Setting Insta/FB : relais du signal de Team »), qui réveille le fil du
// setting pour un passage léger. Rien ne tourne à l'horloge côté Claude : le
// réveil ne part que sur un vrai message reçu.
//
// GARDE-FOUS
//   · `_config/setting_reveil.actif` FAUX par défaut : rien ne part.
//   · Au plus UN appel toutes les `intervalleMin` minutes (10 par défaut, jamais
//     moins de 2 : la tâche accepte 30 appels par heure). Un message arrivé
//     entre-temps est noté « en attente » et pris par le cron
//     api/setting-reveil.js dès que l'intervalle est écoulé.
//   · Seulement de `heureDebut` à `heureFin` (9 h – 22 h, heure de Paris) : les
//     messages de la nuit sont traités au passage de 8 h 30.
//   · Plafond d'appels par jour (`plafondJour`, 120).
//   · AUCUNE donnée du prospect ne sort de Team : l'appel part sans contenu.
//     L'agent relit la conversation dans Business Suite, seule source de vérité.
//   · Un appel en échec n'est jamais une erreur du webhook : Meta reçoit son
//     200, le message reste « en attente » et le cron réessaie.
//
// SECRET : variable Vercel `SETTING_REVEIL_TOKEN` (jeton propre à la tâche,
// créé par Adrien ; en générer un nouveau révoque l'ancien). Jamais en base,
// jamais dans le dépôt. Sans jeton : rien ne part, l'état le dit.
//
// DONNÉES (Admin SDK seul, AUCUNE règle Firestore) :
//   _config/setting_reveil        réglages { actif, intervalleMin, heureDebut,
//                                 heureFin, plafondJour, modifiePar, modifieLe }
//   setting_reveil_etat/courant   état { dernierAppelMs, enAttente,
//                                 enAttenteDepuisMs, dernierSignalMs,
//                                 dernierCanal, dernierResultat, jour,
//                                 appelsJour, signauxJour }
// ============================================================================
'use strict';

const { db } = require('./_firebaseAdmin');

const TACHE_DEFAUT = 'trig_01J3HiqciSg5kAMTZHqibR2C';   // identifiant de tâche, pas un secret
const DEFAUTS = { actif: false, intervalleMin: 10, heureDebut: 9, heureFin: 22, plafondJour: 120 };
const DELAI_APPEL_MS = 8000;

function refConfig() { return db.collection('_config').doc('setting_reveil'); }
function refEtat() { return db.collection('setting_reveil_etat').doc('courant'); }

function entier(v, min, max, defaut) {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < min || n > max) return defaut;
  return n;
}

// Réglages propres, quelles que soient les valeurs en base.
function reglages(d) {
  d = d || {};
  const r = {
    actif: d.actif === true,
    intervalleMin: entier(d.intervalleMin, 2, 60, DEFAUTS.intervalleMin),
    heureDebut: entier(d.heureDebut, 0, 23, DEFAUTS.heureDebut),
    heureFin: entier(d.heureFin, 1, 24, DEFAUTS.heureFin),
    plafondJour: entier(d.plafondJour, 1, 400, DEFAUTS.plafondJour),
  };
  if (r.heureFin <= r.heureDebut) { r.heureDebut = DEFAUTS.heureDebut; r.heureFin = DEFAUTS.heureFin; }
  return r;
}

// Heure (0-23) et jour (AAAA-MM-JJ) à Paris.
function paris(ms) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms));
  const o = {};
  for (let i = 0; i < p.length; i++) o[p[i].type] = p[i].value;
  return { jour: o.year + '-' + o.month + '-' + o.day, heure: Number(o.hour) };
}

function dansLaPlage(cfg, ms) {
  const h = paris(ms).heure;
  return h >= cfg.heureDebut && h < cfg.heureFin;
}

// Décision PURE (testable hors réseau) : que faire d'un signal, ou d'un
// passage du cron (`signal` faux), vu les réglages et l'état ?
//   eteint | hors_plage | rien | attente | plafond | appel
function decider(cfg, etat, ms, signal) {
  etat = etat || {};
  if (!cfg.actif) return 'eteint';
  if (!dansLaPlage(cfg, ms)) return 'hors_plage';
  if (!signal && !etat.enAttente) return 'rien';
  const jour = paris(ms).jour;
  const appelsJour = etat.jour === jour ? (Number(etat.appelsJour) || 0) : 0;
  if (appelsJour >= cfg.plafondJour) return 'plafond';
  const ecoule = ms - (Number(etat.dernierAppelMs) || 0);
  if (ecoule < cfg.intervalleMin * 60000) return 'attente';
  return 'appel';
}

// L'appel lui-même. Ne jette jamais : rend { ok, code, detail }.
async function appeler() {
  const jeton = String(process.env.SETTING_REVEIL_TOKEN || '');
  if (jeton.length < 20) return { ok: false, code: 0, detail: 'jeton_absent' };
  const tache = String(process.env.SETTING_REVEIL_ROUTINE || TACHE_DEFAUT);
  if (!/^trig_[A-Za-z0-9]{10,60}$/.test(tache)) return { ok: false, code: 0, detail: 'tache_invalide' };
  try {
    const r = await fetch('https://api.anthropic.com/v1/claude_code/routines/' + tache + '/fire', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + jeton,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'experimental-cc-routine-2026-04-01',
        'Content-Type': 'application/json',
      },
      body: '{}',                      // aucun contenu : rien du prospect ne sort de Team
      signal: AbortSignal.timeout(DELAI_APPEL_MS),
    });
    if (r.ok) return { ok: true, code: r.status, detail: '' };
    let detail = '';
    try { detail = String(await r.text()).slice(0, 200); } catch (_) { detail = ''; }
    return { ok: false, code: r.status, detail: detail };
  } catch (e) {
    return { ok: false, code: 0, detail: String((e && e.name) || 'erreur') + ' ' + String((e && e.message) || '').slice(0, 160) };
  }
}

// Cœur commun au signal (webhook) et au rattrapage (cron). La réservation de
// l'appel se fait en TRANSACTION : Meta livre ses événements en parallèle, deux
// messages simultanés ne doivent produire qu'un seul réveil.
async function traiter(signal, canal) {
  const maintenant = Date.now();
  const cfg = reglages((await refConfig().get()).data());
  const ref = refEtat();

  const decision = await db.runTransaction(async function (tx) {
    const snap = await tx.get(ref);
    const etat = snap.exists ? (snap.data() || {}) : {};
    const d = decider(cfg, etat, maintenant, signal);
    const jour = paris(maintenant).jour;
    const memeJour = etat.jour === jour;
    const patch = { jour: jour };
    if (!memeJour) { patch.appelsJour = 0; patch.signauxJour = 0; }
    if (signal) {
      patch.dernierSignalMs = maintenant;
      patch.dernierCanal = String(canal || '').slice(0, 40);
      patch.signauxJour = (memeJour ? (Number(etat.signauxJour) || 0) : 0) + 1;
    }
    if (d === 'appel') {
      patch.dernierAppelMs = maintenant;
      patch.enAttente = false;
      patch.appelsJour = (memeJour ? (Number(etat.appelsJour) || 0) : 0) + 1;
    } else if (signal && (d === 'attente' || d === 'plafond')) {
      if (!etat.enAttente) patch.enAttenteDepuisMs = maintenant;
      patch.enAttente = true;
    } else if (d === 'hors_plage' && etat.enAttente) {
      patch.enAttente = false;       // la nuit : le passage de 8 h 30 s'en charge
    }
    if (d === 'rien' && memeJour) return d;   // rien à écrire
    tx.set(ref, patch, { merge: true });
    return d;
  });

  if (decision !== 'appel') return { decision: decision };

  const r = await appeler();
  const suite = { dernierResultat: { ok: r.ok, code: r.code, detail: r.detail, atMs: maintenant } };
  if (!r.ok) {
    // Le message reste à prendre : le cron réessaiera après l'intervalle.
    suite.enAttente = true;
    suite.enAttenteDepuisMs = maintenant;
    console.warn('[setting-reveil] appel en échec', r.code, r.detail);
  }
  await ref.set(suite, { merge: true });
  return { decision: 'appel', ok: r.ok, code: r.code };
}

// Appelé par les webhooks Meta quand au moins un message privé ENTRANT vient
// d'être journalisé. Ne jette jamais : un réveil raté ne doit pas faire
// échouer la réponse à Meta.
async function signaler(canal) {
  try { return await traiter(true, canal); }
  catch (e) { console.error('[setting-reveil] signal', e && e.message); return { decision: 'erreur' }; }
}

// Appelé par le cron : prend un message resté en attente.
async function rattraper() { return traiter(false, ''); }

async function lireEtat() {
  const s = await Promise.all([refConfig().get(), refEtat().get()]);
  const brut = s[0].data() || {};
  return {
    reglages: reglages(brut),
    modifiePar: brut.modifiePar || '',
    modifieLeMs: Number(brut.modifieLeMs) || 0,
    etat: s[1].exists ? (s[1].data() || {}) : {},
    jetonPresent: String(process.env.SETTING_REVEIL_TOKEN || '').length >= 20,
    dansLaPlage: dansLaPlage(reglages(brut), Date.now()),
  };
}

async function regler(actif, par) {
  await refConfig().set({ actif: actif === true, modifiePar: String(par || '').slice(0, 120), modifieLeMs: Date.now() }, { merge: true });
  return lireEtat();
}

module.exports = {
  signaler: signaler, rattraper: rattraper, lireEtat: lireEtat, regler: regler,
  // Exposé pour les tests hors réseau.
  _reglages: reglages, _decider: decider, _paris: paris,
};
