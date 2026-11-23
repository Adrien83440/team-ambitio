// ============================================================================
// api/academy-email-audit.js — FICHES DONT L'E-MAIL N'EST PAS CELUI DU CONTRAT
// (23/11/2026, LECTURE SEULE, route TEMPORAIRE)
// ----------------------------------------------------------------------------
// Le compte Academy vit sous l'e-mail du signataire du contrat ; la fiche
// coaching peut garder celui du lead. Cette route compte les fiches dans ce
// cas et dit, pour chacune, sous quel e-mail le compte existe réellement.
//
// N'ÉCRIT RIEN. Aucune donnée personnelle en sortie : identifiant de la fiche,
// initiales, e-mails masqués (première et dernière lettre, domaine).
//
// Accès : en-tête `x-audit-key` (ou ?key=) égal à la variable Vercel
// ACADEMY_EMAIL_AUDIT_KEY. Variable absente ou clé fausse → 404. La clé est
// posée dans Vercel, jamais dans le dépôt ; la retirer coupe l'accès.
//
//   GET /api/academy-email-audit            → fiches en écart
//   GET /api/academy-email-audit?sonde=1    → + état du compte Academy sous
//                                             chaque e-mail (pont, lecture)
// ============================================================================
'use strict';

const crypto = require('crypto');
const { db } = require('./_firebaseAdmin');

const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

function keyOk(req) {
  const want = String(process.env.ACADEMY_EMAIL_AUDIT_KEY || '');
  const got = String((req.headers && req.headers['x-audit-key']) || (req.query && req.query.key) || '');
  if (want.length < 24 || got.length !== want.length) return false;
  return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}
function lower(s) { return String(s || '').trim().toLowerCase(); }
function ms(v) {
  if (!v) return 0;
  if (typeof v.toMillis === 'function') return v.toMillis();
  if (v._seconds != null) return v._seconds * 1000;
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}
function jour(t) { return t ? new Date(t).toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }) : null; }
function masque(e) {
  e = lower(e);
  const i = e.indexOf('@');
  if (i < 1) return e ? '***' : '';
  const l = e.slice(0, i);
  return l.charAt(0) + '***' + (l.length > 1 ? l.charAt(l.length - 1) : '') + e.slice(i);
}
function initiales(n) {
  return String(n || '').trim().split(/\s+/).filter(Boolean).slice(0, 3).map(function (m) { return m.charAt(0).toUpperCase(); }).join('');
}

async function etatCompte(email, key) {
  try {
    const r = await fetch(ACADEMY_URL + '/api/bridge/manage-access', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-bridge-key': key },
      body: JSON.stringify({ action: 'status', email: email }),
    });
    const j = await r.json().catch(function () { return null; });
    if (!j || j.ok !== true) return { erreur: (j && j.error) || 'academy_unreachable' };
    if (!j.found) return { compte: false };
    return {
      compte: true,
      connexion: !!(j.auth && j.auth.exists), desactive: !!(j.auth && j.auth.disabled),
      formations: Array.isArray(j.access) ? j.access.length : (j.access && typeof j.access === 'object' ? Object.keys(j.access).length : null),
      paiementAttendu: !!j.paiementAttendu, demarrageAttendu: j.demarrageAttendu || null,
    };
  } catch (e) { return { erreur: 'academy_unreachable' }; }
}

module.exports = async (req, res) => {
  if (!keyOk(req)) { res.status(404).json({ error: 'not_found' }); return; }
  if (req.method !== 'GET') { res.status(405).json({ error: 'method_not_allowed' }); return; }

  try {
    const lus = await Promise.all([
      db.collection('clients').get(),
      db.collection('signature_requests').where('status', '==', 'signed').get(),
    ]);
    const contrats = [];
    lus[1].forEach(function (d) {
      const r = d.data() || {};
      const emails = [];
      [Array.isArray(r.signers) && r.signers[0] && r.signers[0].email, r.clientEmail].forEach(function (e) {
        e = lower(e); if (e && emails.indexOf(e) < 0) emails.push(e);
      });
      contrats.push({ leadId: String(r.leadId || ''), emails: emails, signe: ms(r.signedAt), modele: String(r.templateName || '') });
    });

    /* E-mail du lead de chaque contrat : le lien fiche ↔ contrat quand la fiche
       n'a pas de _leadId. */
    const leadEmail = {};
    const ids = [];
    contrats.forEach(function (c) { if (c.leadId && ids.indexOf(c.leadId) < 0) ids.push(c.leadId); });
    for (let i = 0; i < ids.length; i += 300) {
      const refs = ids.slice(i, i + 300).map(function (id) { return db.collection('leads').doc(id); });
      const snaps = await db.getAll.apply(db, refs);
      snaps.forEach(function (s) { if (s.exists) leadEmail[s.id] = lower((s.data() || {}).email); });
    }

    const ecarts = [];
    let fiches = 0, sansEmail = 0, sansContrat = 0, concordent = 0;
    lus[0].forEach(function (d) {
      const c = d.data() || {};
      fiches++;
      const e = lower(c.email);
      if (!e) { sansEmail++; return; }
      const lid = String(c._leadId || '');
      const lies = contrats.filter(function (k) {
        return k.emails.indexOf(e) >= 0 || (lid && k.leadId === lid) || (k.leadId && leadEmail[k.leadId] === e);
      });
      if (!lies.length) { sansContrat++; return; }
      if (lies.some(function (k) { return k.emails.indexOf(e) >= 0; })) { concordent++; return; }
      lies.sort(function (a, b) { return b.signe - a.signe; });
      const autres = [];
      lies.forEach(function (k) { k.emails.forEach(function (x) { if (autres.indexOf(x) < 0) autres.push(x); }); });
      ecarts.push({
        _fiche: e, _contrat: autres,
        clientId: d.id, initiales: initiales(c.nom || c.name), statut: c.statut || null, programme: c.programme || null,
        emailFiche: masque(e), emailsContrat: autres.map(masque),
        dernierContrat: { signeLe: jour(lies[0].signe), modele: lies[0].modele },
      });
    });

    const sonde = String((req.query && req.query.sonde) || '') === '1';
    const key = process.env.ACADEMY_BRIDGE_KEY || '';
    const bilan = {};
    if (sonde && key) {
      for (let i = 0; i < ecarts.length; i++) {
        const x = ecarts[i];
        x.compteFiche = await etatCompte(x._fiche, key);
        x.comptesContrat = [];
        for (let k = 0; k < x._contrat.length; k++) x.comptesContrat.push(await etatCompte(x._contrat[k], key));
        const f = x.compteFiche.compte === true;
        const ct = x.comptesContrat.some(function (s) { return s.compte === true; });
        x.verdict = f && ct ? 'deux_comptes' : (f ? 'compte_sous_fiche' : (ct ? 'compte_sous_contrat' : 'aucun_compte'));
        bilan[x.verdict] = (bilan[x.verdict] || 0) + 1;
      }
    }
    ecarts.forEach(function (x) { delete x._fiche; delete x._contrat; });

    res.status(200).json({
      ok: true,
      fiches: fiches, sansEmail: sansEmail, sansContratSigne: sansContrat, concordent: concordent,
      enEcart: ecarts.length, sonde: sonde && !!key, bilan: bilan, ecarts: ecarts,
    });
  } catch (e) {
    console.error('[academy-email-audit]', e && e.message);
    res.status(500).json({ ok: false, error: 'internal' });
  }
};
