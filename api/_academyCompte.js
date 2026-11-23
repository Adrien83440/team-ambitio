// ============================================================================
// api/_academyCompte.js — SOUS QUEL E-MAIL VIT LE COMPTE ACADEMY (23/11/2026,
// exclu du routing)
// ----------------------------------------------------------------------------
// Le compte Academy est créé sous l'e-mail du SIGNATAIRE du contrat
// (api/academy-grant.js). La fiche coaching, elle, garde l'e-mail du lead
// (celui de l'opt-in). Quand les deux diffèrent, tout ce qui part de la fiche
// vers l'Academy répondait « Aucun compte Academy pour cet e-mail » alors que
// le compte existe : avancement, séances, parcours, cahiers de travail,
// désactivation.
//
// fetchPont(url, init) remplace fetch() pour les appels au pont qui portent un
// e-mail. Même signature, même réponse. Seule différence : si l'Academy répond
// « aucun élève à cet e-mail », l'appel est rejoué avec l'e-mail du signataire
// des contrats signés du même client (retrouvés par l'e-mail du contrat, par
// le lead, par la fiche). Sans contrat à un autre e-mail, la première réponse
// est rendue telle quelle : aucun coût pour les clients dont les e-mails
// concordent.
//
// Ne lève jamais plus que fetch() : une recherche de contrat qui échoue rend
// la première réponse. N'écrit rien.
// ============================================================================

const { db } = require('./_firebaseAdmin');

const MEMO_MS = 10 * 60000;
const memo = {}; // e-mail de la fiche → { email du compte, at }

function lower(s) { return String(s || '').trim().toLowerCase(); }

function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/* « Aucun élève à cet e-mail » : la réponse commune de toutes les routes du
   pont, plus celle de workbook (action context), rangée sous learner. */
function sansCompte(j) {
  return !!j && j.ok === true && (j.found === false || (!!j.learner && j.learner.found === false));
}

/* Les autres e-mails sous lesquels le compte de ce client peut vivre : le
   signataire des contrats signés (le plus récent d'abord), puis l'e-mail du
   lead de la fiche. Jamais l'e-mail reçu. */
async function autresEmails(email) {
  email = lower(email);
  if (!email) return [];
  const col = db.collection('signature_requests');
  const contrats = {}, leadIds = {}, emailsLead = [];
  function garder(snap) { snap.forEach(function (d) { contrats[d.id] = d.data() || {}; }); }

  const lus = await Promise.all([
    col.where('clientEmail', '==', email).get(),
    db.collection('leads').where('email', '==', email).limit(5).get(),
    db.collection('clients').where('email', '==', email).limit(5).get(),
  ]);
  garder(lus[0]);
  lus[1].forEach(function (d) { if ((d.data() || {})._merged !== true) leadIds[d.id] = 1; });
  const aLire = [];
  lus[2].forEach(function (d) {
    const id = String((d.data() || {})._leadId || '');
    if (id && !leadIds[id]) { leadIds[id] = 1; aLire.push(id); }
  });
  for (let i = 0; i < aLire.length; i++) {
    const s = await db.collection('leads').doc(aLire[i]).get();
    if (s.exists) emailsLead.push((s.data() || {}).email);
  }
  const ids = Object.keys(leadIds);
  for (let i = 0; i < ids.length; i++) garder(await col.where('leadId', '==', ids[i]).get());

  const vus = {}, out = [];
  function add(e) { e = lower(e); if (e && e !== email && !vus[e]) { vus[e] = 1; out.push(e); } }
  Object.keys(contrats).map(function (id) { return contrats[id]; })
    .filter(function (c) { return c.status === 'signed'; })
    .sort(function (a, b) { return ms(b.signedAt) - ms(a.signedAt); })
    .forEach(function (c) {
      add(Array.isArray(c.signers) && c.signers[0] && c.signers[0].email);
      add(c.clientEmail);
    });
  emailsLead.forEach(add);
  return out;
}

function avecEmail(init, charge, email) {
  return Object.assign({}, init, { body: JSON.stringify(Object.assign({}, charge, { email: email })) });
}

async function lire(r) {
  try { return await r.clone().json(); } catch (e) { return null; }
}

async function fetchPont(url, init) {
  let charge = null;
  try { charge = JSON.parse((init && init.body) || ''); } catch (e) { charge = null; }
  const email = charge && typeof charge === 'object' ? lower(charge.email) : '';
  if (!email) return fetch(url, init);

  /* Déjà résolu il y a peu : on part directement du bon e-mail. */
  const connu = memo[email];
  if (connu && Date.now() - connu.at < MEMO_MS) {
    const rc = await fetch(url, avecEmail(init, charge, connu.email));
    if (!sansCompte(await lire(rc))) return rc;
    delete memo[email];
  }

  const r = await fetch(url, init);
  if (!sansCompte(await lire(r))) return r;

  let autres = [];
  try { autres = await autresEmails(email); }
  catch (e) { console.warn('[academy-compte] contrats illisibles :', e && e.message); return r; }
  for (let i = 0; i < autres.length; i++) {
    const r2 = await fetch(url, avecEmail(init, charge, autres[i]));
    const j2 = await lire(r2);
    if (j2 && j2.ok === true && !sansCompte(j2)) {
      memo[email] = { email: autres[i], at: Date.now() };
      return r2;
    }
  }
  return r;
}

/* L'e-mail du compte retenu au dernier appel pour cette fiche, s'il diffère de
   celui de la fiche ; '' sinon. Sert à le dire à l'écran. */
function emailRetenu(email) {
  const m = memo[lower(email)];
  return m && Date.now() - m.at < MEMO_MS ? m.email : '';
}

module.exports = { fetchPont, autresEmails, sansCompte, emailRetenu };
