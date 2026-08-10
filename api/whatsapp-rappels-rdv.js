// ============================================================================
// api/whatsapp-rappels-rdv.js — RAPPELS DE SÉANCE DE COACHING (J−1 et H−2)
// ----------------------------------------------------------------------------
// Cron toutes les 5 minutes.
//   GET /api/whatsapp-rappels-rdv                → exécution réelle
//   GET /api/whatsapp-rappels-rdv?dryRun=1       → ce qui SERAIT envoyé, sans
//                                                  rien envoyer ni écrire
//
// Auth : Bearer CRON_SECRET (posé par Vercel Cron) ou x-api-key (curl manuel),
// exactement comme api/availability-snapshot.js et api/ringover-sync-cron.js.
// Fail-closed : pas de secret configuré → 500, jamais de contournement.
//
// PÉRIMÈTRE : les séances de COACHING uniquement (`isCoaching === true`).
// Décision d'Adrien du 10/08/2026. Un prospect qui reçoit un WhatsApp d'un
// numéro inconnu avant un premier rendez-vous commercial est bien plus enclin
// à le signaler — et la qualité du numéro se dégraderait pour tout le monde.
// Les RDV commerciaux auront leur propre modèle le jour où on le décidera.
//
// POURQUOI UN SEUL CRON POUR LES DEUX RAPPELS
// -------------------------------------------
// Le H−2 impose de tourner dans la journée : un cron quotidien ne peut pas
// prévenir deux heures avant une séance de 14 h 30. Une fois qu'on tourne
// toutes les 5 minutes, un second cron pour le J−1 n'apporterait rien — et
// une heure fixe en UTC dériverait d'une heure deux fois par an. On lit donc
// l'heure DE PARIS à chaque passage, et chaque rappel décide seul.
//
// LE DOUBLON EST LE VRAI DANGER
// -----------------------------
// Un rappel envoyé deux fois, c'est un client qui se désabonne. Chaque envoi
// est donc RÉSERVÉ dans une transaction sur le RDV lui-même avant de partir :
// deux exécutions simultanées ne peuvent pas réserver le même rappel. Un envoi
// qui échoue reste réservé et n'est PAS rejoué — l'échec est tracé dans le
// journal `whatsapp_messages` et sur le RDV, à lire, pas à retenter en boucle.
// ============================================================================

const { db } = require('./_firebaseAdmin');
const { envoyerModele, normaliserNumero } = require('./_whatsappClient');
const Dispo = require('../dispo-core.js');

/* Heures de silence : rien avant 8 h, rien après 21 h, heure de Paris.
   Un H−2 pour une séance de 9 h partirait sinon à 7 h du matin. */
const OUVERTURE = 8 * 60;
const FERMETURE = 21 * 60;

/* Le J−1 part à partir de 18 h. Ce n'est pas un instant mais un seuil : si un
   passage saute, le suivant rattrape, et la réservation empêche le doublon. */
const HEURE_J1 = 18 * 60;

const AVANCE_H2 = 120;

/* ── Auth : Bearer (Vercel Cron) ou x-api-key (curl manuel) ── */
function checkAuth(req) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return { ok: false, code: 500, error: 'CRON_SECRET non configuré' };
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
  const apiKey = req.headers['x-api-key'] || null;
  if (bearer === secret || apiKey === secret) return { ok: true };
  return { ok: false, code: 401, error: 'Non autorisé' };
}

/* « mardi 12 août » — sans année, comme on le dirait à l'oral. Midi UTC pour
   que le changement d'heure ne fasse jamais basculer d'un jour. */
function dateLisible(ymd) {
  try {
    return new Intl.DateTimeFormat('fr-FR', {
      timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long',
    }).format(new Date(ymd + 'T12:00:00Z'));
  } catch (_) {
    return ymd;
  }
}

/* '14:30' → '14h30' — et '14:00' → '14h', comme on l'écrit en français. */
function heureLisible(hhmm) {
  const p = String(hhmm || '').split(':');
  const h = String(parseInt(p[0], 10) || 0);
  const m = (p[1] || '00').padStart(2, '0');
  return m === '00' ? h + 'h' : h + 'h' + m;
}

/* Le moment visé pour le H−2, repoussé à l'ouverture s'il tombe la nuit :
   un rappel décalé vaut mieux qu'un téléphone qui sonne à 7 h. */
function cibleH2(debutMin) {
  return Math.max(debutMin - AVANCE_H2, OUVERTURE);
}

/* Faut-il envoyer le H−2 maintenant ? Trois refus : la nuit, avant la cible,
   et une fois la séance commencée — un rappel en retard est pire qu'absent. */
function doitEnvoyerH2(nowMin, debutMin) {
  if (nowMin >= FERMETURE) return false;
  if (nowMin < cibleH2(debutMin)) return false;
  return nowMin < debutMin;
}

/* Le J−1 part à partir de 18 h et jusqu'à la fermeture. Seuil et non instant :
   si un passage saute, le suivant rattrape. */
function doitEnvoyerJ1(nowMin) {
  return nowMin >= HEURE_J1 && nowMin < FERMETURE;
}

function prenomDe(nom) {
  const t = String(nom || '').trim().split(/\s+/);
  return t[0] || '';
}

/** Les RDV d'un jour donné. Filtre sur `date` seul : un champ, aucun index
 *  composite à créer, et le tri fin se fait en mémoire sur un volume d'une
 *  journée. */
async function rdvDuJour(ymd) {
  const snap = await db.collection('bookings').where('date', '==', ymd).get();
  const l = [];
  snap.forEach((d) => l.push({ id: d.id, ref: d.ref, data: d.data() || {} }));
  return l;
}

/** Le numéro du client : celui saisi au RDV, sinon celui de sa fiche. */
async function numeroDuClient(b) {
  const direct = normaliserNumero((b.prospect && b.prospect.telephone) || '');
  if (direct) return direct;
  if (!b.clientId) return null;
  try {
    const s = await db.collection('clients').doc(String(b.clientId)).get();
    if (!s.exists) return null;
    const c = s.data() || {};
    return normaliserNumero(c.telephone || c.tel || '');
  } catch (e) {
    console.warn('[rappels-rdv] fiche client', b.clientId, e && e.message);
    return null;
  }
}

/**
 * Réserve puis envoie. La réservation est la seule protection contre le
 * doublon ; elle doit donc précéder l'envoi, pas le suivre.
 * @returns {string} 'envoye' | 'echec' | 'deja' | 'annule'
 */
async function reserverEtEnvoyer(item, type, modele, params, to) {
  const ref = item.ref;

  const verdict = await db.runTransaction(async (tx) => {
    const s = await tx.get(ref);
    if (!s.exists) return 'annule';
    const d = s.data() || {};
    if (d.status === 'cancelled') return 'annule';
    if ((d.rappelsWhatsapp || {})[type]) return 'deja';
    const patch = { rappelsWhatsapp: {} };
    patch.rappelsWhatsapp[type] = { reserveA: Date.now() };
    tx.set(ref, patch, { merge: true });
    return 'ok';
  });
  if (verdict !== 'ok') return verdict;

  const envoi = await envoyerModele({
    to: to,
    template: modele,
    langue: 'fr',
    params: params,
    contexte: { type: type, bookingId: item.id, clientId: item.data.clientId || null },
  });

  /* Le résultat s'écrit sur le RDV, à côté de la réservation : c'est là qu'on
     regardera « pourquoi ce client n'a pas eu son rappel ». */
  const patch = { rappelsWhatsapp: {} };
  patch.rappelsWhatsapp[type] = {
    at: Date.now(),
    ok: envoi.ok,
    wamid: envoi.wamid || null,
    erreur: envoi.erreur || null,
  };
  await ref.set(patch, { merge: true }).catch((e) => console.warn('[rappels-rdv] trace:', e && e.message));

  return envoi.ok ? 'envoye' : 'echec';
}

/** Retient les seules séances de coaching encore debout. */
function seancesCoaching(liste) {
  return liste.filter((x) => {
    const b = x.data;
    return b.isCoaching === true && b.status !== 'cancelled' && !!b.time;
  });
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  const auth = checkAuth(req);
  if (!auth.ok) {
    if (auth.code === 500) console.error('[rappels-rdv] CRON_SECRET absent');
    res.status(auth.code).json({ ok: false, error: auth.error });
    return;
  }

  const dryRun = !!(req.query && (req.query.dryRun === '1' || req.query.dryRun === 'true'));
  const maintenant = Dispo.parisStamp(new Date());
  const aujourdhui = maintenant.ymd;
  const demain = Dispo.addDays(aujourdhui, 1);

  const sortie = {
    ok: true, dryRun: dryRun, parisLe: aujourdhui,
    parisA: Dispo.minToTime(maintenant.min),
    j1: { examines: 0, envoyes: 0, detail: [] },
    h2: { examines: 0, envoyes: 0, detail: [] },
  };

  try {
    // ── H−2 : les séances d'aujourd'hui ────────────────────────────────
    if (maintenant.min < FERMETURE) {
      const dujour = seancesCoaching(await rdvDuJour(aujourdhui));
      sortie.h2.examines = dujour.length;

      for (let i = 0; i < dujour.length; i++) {
        const it = dujour[i];
        const b = it.data;
        if (!doitEnvoyerH2(maintenant.min, Dispo.timeToMin(b.time))) continue;
        if ((b.rappelsWhatsapp || {}).h2) continue;

        const to = await numeroDuClient(b);
        const ligne = {
          id: it.id, heure: b.time, avec: b.personName || null,
          client: (b.prospect && b.prospect.prenom) || b.clientName || null,
        };
        if (!to) {
          ligne.resultat = 'numero_absent';
          sortie.h2.detail.push(ligne);
          continue;
        }
        const params = [
          (b.prospect && b.prospect.prenom) || prenomDe(b.clientName),
          prenomDe(b.personName),
          heureLisible(b.time),
        ];
        if (dryRun) {
          ligne.resultat = 'simule';
          ligne.params = params;
          sortie.h2.detail.push(ligne);
          continue;
        }
        ligne.resultat = await reserverEtEnvoyer(it, 'h2', 'rappel_rdv_h2', params, to);
        if (ligne.resultat === 'envoye') sortie.h2.envoyes++;
        sortie.h2.detail.push(ligne);
      }
    }

    // ── J−1 : les séances de demain, à partir de 18 h ───────────────────
    if (doitEnvoyerJ1(maintenant.min)) {
      const dedemain = seancesCoaching(await rdvDuJour(demain));
      sortie.j1.examines = dedemain.length;

      for (let i = 0; i < dedemain.length; i++) {
        const it = dedemain[i];
        const b = it.data;
        if ((b.rappelsWhatsapp || {}).j1) continue;

        const to = await numeroDuClient(b);
        const ligne = {
          id: it.id, heure: b.time, avec: b.personName || null,
          client: (b.prospect && b.prospect.prenom) || b.clientName || null,
        };
        if (!to) {
          ligne.resultat = 'numero_absent';
          sortie.j1.detail.push(ligne);
          continue;
        }
        const params = [
          (b.prospect && b.prospect.prenom) || prenomDe(b.clientName),
          prenomDe(b.personName),
          dateLisible(demain),
          heureLisible(b.time),
        ];
        if (dryRun) {
          ligne.resultat = 'simule';
          ligne.params = params;
          sortie.j1.detail.push(ligne);
          continue;
        }
        ligne.resultat = await reserverEtEnvoyer(it, 'j1', 'rappel_rdv_j1', params, to);
        if (ligne.resultat === 'envoye') sortie.j1.envoyes++;
        sortie.j1.detail.push(ligne);
      }
    }

    if (sortie.j1.envoyes || sortie.h2.envoyes) {
      console.log('[rappels-rdv] J−1 ' + sortie.j1.envoyes + ' · H−2 ' + sortie.h2.envoyes);
    }
    res.status(200).json(sortie);
  } catch (e) {
    console.error('[rappels-rdv]', e && e.stack ? e.stack : e);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};

/* Exposés pour le harnais de test : la décision d'envoi et les deux mises en
   forme sont les seules parties où une erreur d'une minute ou d'un caractère
   se verrait directement chez le client. */
module.exports.cibleH2 = cibleH2;
module.exports.doitEnvoyerH2 = doitEnvoyerH2;
module.exports.doitEnvoyerJ1 = doitEnvoyerJ1;
module.exports.dateLisible = dateLisible;
module.exports.heureLisible = heureLisible;
