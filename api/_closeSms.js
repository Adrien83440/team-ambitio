// ============================================================================
// api/_closeSms.js — SMS « Nouvelle vente » à la direction, au VRAI close
// ----------------------------------------------------------------------------
// notifyCloseSms(leadId, source, opts?) → { envoye, raison, ... }  (ne lève jamais)
//
// RÈGLE MÉTIER (Adrien, 21/10/2026)
// ---------------------------------
// Un close, c'est un client qui a SIGNÉ son contrat ET dont le prélèvement est
// parti. Ni l'un sans l'autre. Le SMS part donc au moment où la deuxième
// condition se réalise, quelle qu'elle soit : d'où plusieurs points d'appel,
// tous serveur, et une seule fonction qui revérifie les deux conditions dans
// Firestore à chaque fois.
//   · api/sign-session.js        signature finale (le paiement était déjà là)
//   · api/gocardless-payment.js  prélèvement déclenché (cas le plus courant)
//   · api/gocardless-status.js   resynchronisation d'un abonnement
//   · api/gocardless-lookup.js   rattrapage d'un paiement créé hors fiche
//
// POURQUOI PLUS PAR MAKE
// ----------------------
// Jusqu'ici le SMS partait des scénarios Make « Elite Onboarding » et
// « Onboarding BP12 », à la signature seule, depuis l'expéditeur alphanumérique
// « adrienemily ». Le 21/10 (Nicolas PADIOU) le message est resté « sent » chez
// Twilio, jamais livré par l'opérateur. Ici : le numéro Twilio de l'équipe
// (smsFromNumber, +33939240397), dont les SMS de signature arrivent tous.
//
// CONFIG — _config/sales_close_sms
//   enabled : true pour activer (absent ou false → rien ne part)
//   phones  : ['+33688121402', …] destinataires, E.164
//   since   : 'AAAA-MM-JJ' — seules les signatures à partir de cette date
//             comptent. Sans ce garde-fou, la resynchronisation d'un vieux
//             paiement (gocardless-status / lookup) enverrait un SMS pour un
//             client signé il y a des mois.
//
// IDEMPOTENCE : un seul SMS par lead. La trace `closeSms` est posée sur la
// fiche dans une transaction AVANT l'envoi ; un close ré-enregistré, un
// double webhook ou deux points d'appel simultanés ne renvoient rien. Un
// envoi en échec (status 'echec') est retenté au prochain déclencheur.
//
// Bac à sable : sandbox-db n'a pas ce document de config → retour immédiat,
// rien ne sort.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const { getTwilioCreds, getTwilioClient } = require('./_twilioClient');

const PAID = { active: 1, completed: 1 };

function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (typeof v.toDate === 'function') return v.toDate().getTime();
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return isNaN(t) ? 0 : t;
}

/* Montants : espaces simples, jamais l'espace fine de toLocaleString (les
   SMS la rendent mal sur certains téléphones). */
function euros(n) {
  const v = Math.round(Number(n) || 0);
  return String(v).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
}

function sigSignedMs(r) {
  return ms(r.signedAt) || ms(r.signedAtIso) || ms(r.updatedAt) || ms(r.createdAt);
}

async function memberNames() {
  try {
    const s = await db.collection('_meta').doc('team_members').get();
    const raw = s.exists ? (s.data() || {}).members : null;
    const list = Array.isArray(raw) ? raw : Object.values(raw || {});
    const out = {};
    list.forEach(function (m) {
      if (m && m.slug) out[m.slug] = m.shortName || m.displayName || m.fullName || m.slug;
    });
    return out;
  } catch (e) { return {}; }
}

/* Offre lisible : le choix du pilote de closing s'il existe, sinon le
   close enregistré, sinon le nom du modèle de contrat. */
function offreDe(lead, sig) {
  const cp = (lead.closePilot && lead.closePilot.choix) || {};
  if (cp.offre === 'Elite') return 'Elite';
  if (cp.offre === 'Business') return 'Business';
  const cd = lead.closedData || {};
  if (/elite/i.test(cd.offre || '')) return 'Elite';
  if (/bp|business/i.test(cd.offre || '')) return 'Business';
  const t = String(sig.templateName || '');
  if (/elite|\bep ?\d/i.test(t)) return 'Elite';
  if (/business|\bbp ?\d/i.test(t)) return 'Business';
  return t || 'Contrat';
}

function montantDe(pay) {
  const n = Number(pay.installmentsCount) || 1;
  if (pay.type === 'installments' && n > 1) return n + ' × ' + euros(pay.installmentAmount);
  return 'PIF ' + euros(pay.totalAmount);
}

function buildMessage(lead, sig, pay, names) {
  const cd = lead.closedData || {};
  const nom = String(lead.nom || sig.clientName || 'Client').trim();
  const parts = [montantDe(pay)];
  if (cd.collecte) parts.push('encaissé ' + euros(cd.collecte));
  const closer = (cd.closerSlug && names[cd.closerSlug]) || pay.closerName
    || (lead.closePilot && lead.closePilot.byName) || '';
  const setter = (cd.setterSlug && names[cd.setterSlug]) || '';
  if (closer) parts.push('closer ' + closer);
  if (setter) parts.push('setter ' + setter);
  return '🏆 Nouvelle vente ' + offreDe(lead, sig) + ' — ' + nom + '\n' + parts.join(' · ');
}

/* opts.dryRun : calcule tout, n'écrit rien, n'envoie rien (renvoie le texte).
   opts.phones : destinataires imposés (dry-run avant création de la config). */
async function notifyCloseSms(leadId, source, opts) {
  opts = opts || {};
  try {
    if (!leadId) return { envoye: false, raison: 'sans_lead' };

    const cfgSnap = await db.collection('_config').doc('sales_close_sms').get();
    const cfg = cfgSnap.exists ? (cfgSnap.data() || {}) : {};
    if (cfg.enabled !== true && !opts.dryRun) return { envoye: false, raison: 'desactive' };
    const phones = (Array.isArray(opts.phones) ? opts.phones : (Array.isArray(cfg.phones) ? cfg.phones : [])).map(function (p) { return String(p || '').trim(); })
      .filter(function (p) { return /^\+\d{8,15}$/.test(p); });
    if (!phones.length) return { envoye: false, raison: 'aucun_destinataire' };
    const sinceMs = cfg.since ? ms(cfg.since) : 0;

    const leadRef = db.collection('leads').doc(leadId);
    const [leadSnap, sigSnap, paySnap] = await Promise.all([
      leadRef.get(),
      db.collection('signature_requests').where('leadId', '==', leadId).get(),
      db.collection('payments').where('leadId', '==', leadId).get(),
    ]);
    if (!leadSnap.exists) return { envoye: false, raison: 'lead_introuvable' };
    const lead = leadSnap.data() || {};
    if (lead._merged) return { envoye: false, raison: 'lead_fusionne' };
    if (lead.closeSms && lead.closeSms.status !== 'echec') return { envoye: false, raison: 'deja_envoye' };

    const sigs = sigSnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (r) { return r.status === 'signed'; })
      .sort(function (a, b) { return sigSignedMs(a) - sigSignedMs(b); });
    const sig = sigs[sigs.length - 1];
    if (!sig) return { envoye: false, raison: 'pas_signe' };
    if (sinceMs && sigSignedMs(sig) < sinceMs) return { envoye: false, raison: 'signature_anterieure' };

    const pays = paySnap.docs.map(function (d) { return Object.assign({ id: d.id }, d.data()); })
      .filter(function (p) { return PAID[p.status]; })
      .sort(function (a, b) { return ms(a.createdAt) - ms(b.createdAt); });
    const pay = pays[pays.length - 1];
    if (!pay) return { envoye: false, raison: 'pas_paye' };

    const body = buildMessage(lead, sig, pay, await memberNames());
    if (opts.dryRun) return { envoye: false, raison: 'dry_run', body: body, to: phones, signatureId: sig.id, paymentId: pay.id };

    /* Verrou : la trace est posée AVANT l'envoi, dans une transaction —
       deux déclencheurs simultanés ne peuvent pas envoyer chacun le leur. */
    const locked = await db.runTransaction(async function (tx) {
      const cur = await tx.get(leadRef);
      const cs = cur.exists ? (cur.data() || {}).closeSms : null;
      if (cs && cs.status !== 'echec') return false;
      tx.set(leadRef, { closeSms: {
        status: 'envoi', source: String(source || ''), signatureId: sig.id, paymentId: pay.id,
        to: phones, body: body, at: admin.firestore.FieldValue.serverTimestamp(),
      } }, { merge: true });
      return true;
    });
    if (!locked) return { envoye: false, raison: 'deja_envoye' };

    const creds = await getTwilioCreds();
    const from = creds.smsFromNumber || creds.smsFrom || null;
    let sids = [], erreurs = [];
    if (!from) erreurs.push('smsFromNumber manquant dans _config/telco_credentials.twilio');
    else {
      const client = await getTwilioClient();
      for (let k = 0; k < phones.length; k++) {
        try {
          const m = await client.messages.create({ from: from, to: phones[k], body: body });
          sids.push(m.sid);
        } catch (e) { erreurs.push(phones[k] + ' : ' + ((e && e.message) || 'erreur')); }
      }
    }

    const ok = sids.length > 0;
    await leadRef.set({ closeSms: {
      status: ok ? 'envoye' : 'echec', from: from || null, sids: sids,
      erreurs: erreurs.length ? erreurs : admin.firestore.FieldValue.delete(),
      doneAt: admin.firestore.FieldValue.serverTimestamp(),
    } }, { merge: true });
    if (erreurs.length) console.warn('[close-sms]', leadId, erreurs.join(' | '));
    else console.log('[close-sms] ✅', leadId, source, sids.join(','));
    return { envoye: ok, raison: ok ? 'ok' : 'echec', sids: sids, erreurs: erreurs };
  } catch (e) {
    console.error('[close-sms]', leadId, source, e && e.message);
    return { envoye: false, raison: 'erreur', erreur: e && e.message };
  }
}

module.exports = { notifyCloseSms, buildMessage };
