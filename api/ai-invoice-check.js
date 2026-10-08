// ============================================================================
// api/ai-invoice-check.js — CONTRÔLE AVANT VALIDATION DE FACTURE (Lot 5)
// ----------------------------------------------------------------------------
// Appelé par admin-invoice-edit.html juste avant la confirmation « Valider
// définitivement ». Purement CONSULTATIF : les avertissements s'affichent dans
// la confirmation, l'admin décide. N'écrit rien ; ne remplace aucune règle de
// api/invoice-validate.js (qui reste le seul juge, ex. 409 billingScope 'ei').
//
// Règles déterministes + relecture Haiku des lignes (cohérence libellés /
// montants / période). POST Bearer <ID token admin> { invoiceId }
//   → { ok, warnings:[string] }
// ============================================================================

const { requireAdmin } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');
const { db } = require('./_firebaseAdmin');
const { callClaude, cap, tsToMs } = require('./_ai');

function eur(n) { return (Math.round((Number(n) || 0) * 100) / 100).toLocaleString('fr-FR') + ' €'; }

module.exports = async function (req, res) {
  if (req.method !== 'POST') { res.status(405).json({ ok: false, error: 'method_not_allowed' }); return; }
  const auth = await requireAdmin(req, res);
  if (!auth) return;
  const body = parseBody(req);
  try {
    const s = await db.collection('invoices').doc(String(body.invoiceId || '')).get();
    if (!s.exists) { res.status(404).json({ ok: false, error: 'invoice_not_found' }); return; }
    const inv = s.data() || {};
    const w = [];
    let client = null;
    if (inv.clientId) {
      const c = await db.collection('invoice_clients').doc(inv.clientId).get();
      if (c.exists) client = c.data() || {};
    }
    if (client) {
      if (client.billingScope === 'ei') w.push('Client facturé sur l\'EI (billingScope « ei ») : aucune facture ne doit sortir d\'Alteore — la validation sera refusée.');
      if (!String(client.siret || '').replace(/\s+/g, '')) w.push('SIRET manquant sur la fiche client : pas de transmission en facturation électronique.');
      if (client.clientStatus === 'procedure') w.push('Client en procédure / recouvrement : facturer quand même ?');
      if (client.clientStatus === 'stopped' || client.clientStatus === 'completed') w.push('Client au statut « ' + client.clientStatus + ' » : facture encore due ?');
    }
    const lines = inv.lines || [];
    lines.forEach(function (l, i) {
      if (l.vatRate != null && Number(l.vatRate) !== 20 && Number(l.vatRate) !== 0) w.push('Ligne ' + (i + 1) + ' : TVA à ' + l.vatRate + ' % (inhabituel).');
      if (Number(l.vatRate) === 0 && !/exon|autoliquid|293 B|art\.? ?2[0-9]{2}/i.test(String(inv.notesPublic || '') + ' ' + String(l.description || ''))) w.push('Ligne ' + (i + 1) + ' : TVA à 0 % sans mention d\'exonération.');
      if (Number(l.qty) % 1 !== 0) w.push('Ligne ' + (i + 1) + ' : quantité non entière (' + l.qty + ').');
      if (Number(l.discountPct) >= 50) w.push('Ligne ' + (i + 1) + ' : remise de ' + l.discountPct + ' %.');
    });
    // Doublon probable : même client, même montant TTC, sur les 40 derniers jours.
    if (inv.clientId) {
      const others = await db.collection('invoices').where('clientId', '==', inv.clientId).get();
      others.forEach(function (d) {
        if (d.id === s.id) return;
        const o = d.data() || {};
        if (o.status === 'cancelled' || o.status === 'draft') return;
        const when = tsToMs(o.issueDate) || tsToMs(o.validatedAt) || 0;
        if (Math.abs((Number(o.totalTtc) || 0) - (Number(inv.totalTtc) || 0)) < 0.01 && when && Date.now() - when < 40 * 86400000) {
          w.push('Doublon possible : ' + (o.number || d.id) + ' du ' + new Date(when).toLocaleDateString('fr-FR') + ', même client, même montant (' + eur(o.totalTtc) + ').');
        }
      });
    }
    if (inv.linkedSubscriptionId) {
      const sub = await db.collection('subscriptions').doc(inv.linkedSubscriptionId).get();
      if (sub.exists) {
        const amt = Number(sub.data().installmentAmount) || 0;
        if (amt && Math.abs(amt - (Number(inv.totalTtc) || 0)) > 0.01 && Math.abs(amt - (Number(inv.totalHt) || 0)) > 0.01) {
          w.push('Montant (' + eur(inv.totalTtc) + ' TTC) différent de l\'échéance de l\'abonnement lié (' + eur(amt) + ').');
        }
      }
    }

    // Relecture IA des libellés (cohérence, période, fautes) — courte, non bloquante.
    if (lines.length) {
      const today = new Date().toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', month: 'long', year: 'numeric' });
      const r = await callClaude({
        task: 'invoice_check',
        noContext: true,
        system: 'Tu relis une facture B2B avant émission. Signale UNIQUEMENT de vraies anomalies : libellé incohérent avec le montant, période facturée qui ne correspond pas au mois en cours (' + today + '), faute qui serait gênante pour le client, ligne en double. Si tout est cohérent, renvoie une liste vide. Pas de remarque de style.',
        prompt: 'Client : ' + cap((client && (client.companyName || ((client.contactFirstName || '') + ' ' + (client.contactLastName || '')))) || '?', 120) + '\n' +
          lines.map(function (l, i) { return (i + 1) + '. ' + cap(l.description || l.productName || '', 300) + ' — ' + (l.qty || 1) + ' × ' + eur(l.unitPriceHt) + ' HT, TVA ' + (l.vatRate != null ? l.vatRate : 20) + ' %'; }).join('\n') +
          '\nTotal TTC : ' + eur(inv.totalTtc) + (inv.notesPublic ? '\nMentions : ' + cap(inv.notesPublic, 400) : ''),
        schema: { type: 'object', additionalProperties: false, required: ['anomalies'], properties: { anomalies: { type: 'array', items: { type: 'string' } } } },
        uid: auth.uid,
        ref: 'invoice:' + s.id,
      });
      if (r.ok) (r.json.anomalies || []).slice(0, 4).forEach(function (a) { w.push('🤖 ' + a); });
    }
    res.status(200).json({ ok: true, warnings: w });
  } catch (e) {
    console.error('[ai-invoice-check]', e);
    res.status(200).json({ ok: false, error: e && e.message ? e.message : String(e) });
  }
};
