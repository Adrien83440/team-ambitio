// ============================================================================
// api/_relances-hooks.js — CE QUE FAIT UNE RÉPONSE À UNE RELANCE (12/11/2026)
// ----------------------------------------------------------------------------
// Appelé par les quatre portes d'entrée déjà existantes, APRÈS leur propre
// traitement (fiche, cloche, boîte partagée) :
//   · api/whatsapp-webhook.js     message ou clic de bouton WhatsApp
//   · api/twilio-sms-inbound.js   SMS reçu sur le numéro Twilio (STOP compris)
//   · api/ringover-sms-inbound.js SMS reçu sur une ligne Ringover (STOP compris)
//   · api/gmail-inbound-sync.js   e-mail humain rattaché à une fiche
//
// Trois cas :
//   1. « Plus intéressé » (bouton WhatsApp RLC_STOP:…, ou le texte « plus
//      intéressé ») → étape Disqualifié (setting), statut `pas_interesse`,
//      exclusion DÉFINITIVE des relances, séquence arrêtée ;
//   2. STOP (SMS ou WhatsApp) → exclusion définitive, séquence arrêtée. Le
//      champ historique smsOptedOut / smsOptOut reste posé par l'appelant ;
//   3. toute autre réponse d'un lead EN SÉQUENCE → séquence arrêtée,
//      marqueur `relanceRepondu` + ligne d'historique sur la fiche, et
//      notification immédiate au setter assigné (sauf s'il vient déjà de
//      recevoir la cloche du message lui-même).
//
// NE LANCE JAMAIS, et ne coûte qu'UNE lecture (le verrou du lead) quand le
// lead n'est dans aucune séquence : le message entrant ordinaire n'en paie
// pas le prix.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const R = require('./_relances');

const FV = admin.firestore.FieldValue;
const STOP = { stop: 1, stopall: 1, unsubscribe: 1, arret: 1, arreter: 1, desabonner: 1, desinscrire: 1 };
const PLUS_INTERESSE = { 'plus interesse': 1, 'plus interessee': 1, 'pas interesse': 1, 'pas interessee': 1 };

function nettoyer(t) {
  return R.Core.norm(t).replace(/[«»"'.,!?;:()\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
}

async function verrouDe(leadId) {
  const s = await db.collection('relance_verrous').doc(String(leadId)).get();
  const v = s.exists ? (s.data() || {}) : null;
  return v && v.actif === true ? v : null;
}

async function exclure(leadId, motif, o) {
  await db.collection('relance_exclusions').doc(String(leadId)).set({
    motif: motif, at: Date.now(), via: (o && o.canal) || null,
    campagneId: (o && o.campagneId) || null,
  }, { merge: true });
}

async function plusInteresse(leadId, o) {
  o = o || {};
  const v = await verrouDe(leadId);
  const campagneId = (v && v.campagneId) || o.campagneId || null;
  await exclure(leadId, 'plus_interesse', { canal: o.canal, campagneId: campagneId });
  if (v && v.inscriptionId) await R.arreter(v.inscriptionId, 'plus_interesse');

  const ref = db.collection('leads').doc(String(leadId));
  const s = await ref.get();
  if (!s.exists) return;
  const l = s.data() || {};
  if (l.relancePlusInteresse) return;            // déjà traité (rejeu Meta)
  const upd = {
    relancePlusInteresse: { at: Date.now(), via: o.canal || null, campagneId: campagneId },
    updatedAt: FV.serverTimestamp(),
  };
  /* Un client ne change jamais d'étape sur un clic de relance : on l'exclut
     des relances, c'est tout. */
  if (!R.Core.estClient(l)) {
    /* Libellés du Pipeline si pipeline-etapes.js est embarqué dans cette
       fonction ; sinon la clé brute — la trace reste lisible. */
    let lab = {};
    try { lab = R.etapesPipeline().STAGE_LABEL || {}; } catch (e) { lab = {}; }
    const avant = l.stage || 'lead';
    upd.stage = 'disqualification';
    upd.status = 'pas_interesse';
    upd.timeline_history = FV.arrayUnion({
      text: 'Étape : ' + (lab[avant] || avant) + ' → ' + (lab.disqualification || 'Disqualifié (setting)')
        + ' — « Plus intéressé » (relance, ' + (o.canal || '?') + ')',
      date: R.dateFr(), color: '#ef4444',
    });
  }
  await ref.update(upd);
}

/**
 * @param {Object} o
 * @param {string} o.leadId          fiche rattachée (sans fiche : rien à faire)
 * @param {'whatsapp'|'sms'|'email'} o.canal
 * @param {string} [o.texte]
 * @param {string} [o.payload]       charge d'un bouton WhatsApp
 * @param {string} [o.fromNumber]
 * @param {string} [o.leadName]
 * @param {string} [o.dejaNotifieUid] uid déjà prévenu par la cloche d'origine
 * @param {string} o.cle             identifiant du message (anti-doublon)
 */
async function surEntrant(o) {
  try {
    if (!o || !o.leadId) return;
    const t = nettoyer(o.texte);
    const payload = String(o.payload || '');
    if (/^RLC_STOP:test$/.test(payload)) return;  // clic sur un message de test

    if (/^RLC_STOP:/.test(payload) || PLUS_INTERESSE[t]) {
      await plusInteresse(o.leadId, { canal: o.canal });
      return;
    }
    if ((o.canal === 'sms' || o.canal === 'whatsapp') && STOP[t]) {
      const v = await verrouDe(o.leadId);
      await exclure(o.leadId, 'stop', { canal: o.canal, campagneId: v && v.campagneId });
      if (v && v.inscriptionId) await R.arreter(v.inscriptionId, 'stop');
      return;
    }

    const v = await verrouDe(o.leadId);
    if (!v || !v.inscriptionId) return;
    const extrait = String(o.texte || '').replace(/\s+/g, ' ').slice(0, 200);
    await R.arreter(v.inscriptionId, 'a_repondu', { reponse: { canal: o.canal, extrait: extrait, at: Date.now() } });

    const camp = v.campagneId ? await db.collection('relance_campagnes').doc(String(v.campagneId)).get() : null;
    const campNom = camp && camp.exists ? (camp.data() || {}).nom || '' : '';
    const ref = db.collection('leads').doc(String(o.leadId));
    const ls = await ref.get();
    const l = ls.exists ? (ls.data() || {}) : {};
    const lib = { whatsapp: 'WhatsApp', sms: 'SMS', email: 'e-mail' }[o.canal] || o.canal;
    await ref.update({
      relanceRepondu: { at: Date.now(), campagneId: v.campagneId || null, campagneNom: campNom, canal: o.canal, extrait: extrait },
      timeline_history: FV.arrayUnion({
        text: '💬 A répondu à la relance « ' + campNom + ' » (' + lib + ') — ' + extrait.slice(0, 100),
        date: R.dateFr(), color: '#22c55e',
      }),
    }).catch(function (e) { console.warn('[relances-hooks] fiche', o.leadId, e && e.message); });

    await R.notifierSetter({
      cle: String(v.inscriptionId) + '_' + String(o.cle || Date.now()),
      canal: o.canal, leadId: o.leadId, leadName: o.leadName || l.nom || null,
      fromNumber: o.fromNumber || null, texte: extrait, campagneNom: campNom,
      setterSlug: l.assignedTo || null, dejaNotifieUid: o.dejaNotifieUid || null,
      dejaNotifieSetter: o.dejaNotifieSetter === true,
    });
  } catch (e) {
    console.error('[relances-hooks]', e && e.stack ? e.stack : e);
  }
}

module.exports = { surEntrant, plusInteresse };
