// ==========================================================================
// api/gocardless-lookup.js
// --------------------------------------------------------------------------
// Cherche un client dans GoCardless par email,
// récupère ses mandats, abonnements et paiements,
// puis lie les IDs GC au document payment en Firestore.
//
// Body : { leadId, email }
// Auth : Bearer Firebase ID token (rôle sales ou admin)
// ==========================================================================

const { db, admin } = require('./_firebaseAdmin');
const { requireAuth } = require('./_verifyFirebaseAuth');
const parseBody = require('./_parseBody');

const GC_BASE = process.env.GOCARDLESS_ENVIRONMENT === 'sandbox'
  ? 'https://api-sandbox.gocardless.com'
  : 'https://api.gocardless.com';

async function gcGet(path) {
  const token = process.env.GOCARDLESS_ACCESS_TOKEN;
  if (!token) throw new Error('GOCARDLESS_ACCESS_TOKEN not configured');
  const resp = await fetch(`${GC_BASE}${path}`, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'GoCardless-Version': '2015-07-06',
      'Accept': 'application/json'
    }
  });
  if (resp.status === 404) return null;
  const json = await resp.json();
  if (!resp.ok) throw new Error(`GoCardless ${resp.status}: ${JSON.stringify(json.error || json)}`);
  return json;
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const auth = await requireAuth(req, res);
  if (!auth) return;
  if (auth.role !== 'sales' && auth.role !== 'admin') {
    res.status(403).json({ error: 'Rôle sales ou admin requis' }); return;
  }

  try {
    const { leadId, email } = parseBody(req);
    if (!leadId || !email) {
      res.status(400).json({ error: 'leadId et email requis' }); return;
    }

    // 1. Chercher le customer GC par email (GC ne supporte pas le filtre email,
    //    on pagine les customers récents et on filtre côté serveur)
    const emailNorm = email.toLowerCase().trim();
    let customers = [];
    let after = null;
    let pages = 0;
    const MAX_PAGES = 5; // 5 × 200 = 1000 customers max

    while (pages < MAX_PAGES) {
      const url = `/customers?limit=200&sort_field=created_at&sort_direction=desc${after ? `&after=${after}` : ''}`;
      const page = await gcGet(url);
      if (!page || !page.customers || !page.customers.length) break;

      const match = page.customers.find(c =>
        (c.email || '').toLowerCase().trim() === emailNorm
      );
      if (match) { customers = [match]; break; }

      // Pagination cursor
      const meta = page.meta && page.meta.cursors;
      if (!meta || !meta.after) break;
      after = meta.after;
      pages++;
    }

    if (!customers.length) {
      res.status(404).json({ error: `Aucun customer GoCardless trouvé pour ${email}` });
      return;
    }

    // Prendre le customer le plus récent
    const customer = customers.sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at)
    )[0];
    const customerId = customer.id;

    // 2. Récupérer les mandats du customer
    const mandateList = await gcGet(`/mandates?customer=${customerId}`);
    const mandates = (mandateList && mandateList.mandates) || [];

    // 3. Pour chaque mandat, récupérer abonnements + paiements
    const result = {
      customer: {
        id: customer.id,
        email: customer.email,
        givenName: customer.given_name,
        familyName: customer.family_name,
        createdAt: customer.created_at
      },
      mandates: [],
      subscriptions: [],
      payments: []
    };

    for (const mandate of mandates) {
      result.mandates.push({
        id: mandate.id,
        status: mandate.status,
        reference: mandate.reference,
        createdAt: mandate.created_at,
        nextPossibleChargeDate: mandate.next_possible_charge_date
      });

      // Abonnements pour ce mandat
      const subList = await gcGet(`/subscriptions?mandate=${mandate.id}`);
      const subs = (subList && subList.subscriptions) || [];
      for (const sub of subs) {
        result.subscriptions.push({
          id: sub.id,
          mandateId: mandate.id,
          status: sub.status,
          amount: sub.amount / 100,
          currency: sub.currency,
          intervalUnit: sub.interval_unit,
          count: sub.count,
          createdAt: sub.created_at,
          endDate: sub.end_date,
          upcomingPayments: (sub.upcoming_payments || []).map(p => ({
            chargeDate: p.charge_date,
            amount: p.amount / 100
          }))
        });
      }

      // Paiements pour ce mandat
      const pmList = await gcGet(`/payments?mandate=${mandate.id}&sort_field=charge_date&sort_direction=desc`);
      const pms = (pmList && pmList.payments) || [];
      for (const pm of pms) {
        result.payments.push({
          id: pm.id,
          mandateId: mandate.id,
          status: pm.status,
          amount: pm.amount / 100,
          currency: pm.currency,
          chargeDate: pm.charge_date,
          description: pm.description
        });
      }
    }

    // 4. Chercher ou créer le document payment en Firestore pour ce lead
    const activeMandate = mandates.find(m => m.status === 'active') || mandates[0];
    const activeSub = result.subscriptions.find(s => s.status === 'active') || result.subscriptions[0];

    // Chercher un payment existant pour ce lead
    const existingPays = await db.collection('payments')
      .where('leadId', '==', leadId)
      .limit(1).get();

    const paidRaw = result.payments.filter(p =>
      p.status === 'paid_out' || p.status === 'confirmed'
    );
    // Déduplique par id (protection contre double-lookup)
    const seenPay = new Set();
    const paidPayments = paidRaw.filter(p => { if (seenPay.has(p.id)) return false; seenPay.add(p.id); return true; });
    const paidAmount = paidPayments.reduce((s, p) => s + p.amount, 0);

    const gcFields = {
      gcCustomerId: customerId,
      gcMandateId: activeMandate ? activeMandate.id : null,
      gcSubscriptionId: activeSub ? activeSub.id : null,
      status: activeSub
        ? (activeSub.status === 'finished' ? 'completed' : activeSub.status === 'active' ? 'active' : 'mandate_active')
        : (activeMandate ? 'mandate_active' : 'draft'),
      paidCount: paidPayments.length,
      paidAmount: Math.round(paidAmount * 100) / 100,
      paymentsHistory: paidPayments.map(p => ({
        gcPaymentId: p.id,
        amount: p.amount,
        date: p.chargeDate,
        status: p.status
      })),
      gcLastSyncAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    if (!existingPays.empty) {
      // Mettre à jour le payment existant
      await existingPays.docs[0].ref.update(gcFields);
      result.paymentDocId = existingPays.docs[0].id;
    } else {
      // Créer un nouveau document payment lié à ce lead
      const leadSnap = await db.collection('leads').doc(leadId).get();
      const lead = leadSnap.exists ? leadSnap.data() : {};
      const totalAmount = activeSub ? activeSub.amount * (activeSub.count || 1) : (result.payments[0] ? result.payments[0].amount : 0);
      const newPay = {
        leadId,
        leadName: lead.nom || '',
        leadEmail: lead.email || email,
        leadPhone: lead.telephone || '',
        closerId: lead.closeurSlug || '',
        closerName: lead.closeurName || '',
        closerSlug: lead.closeurSlug || '',
        type: activeSub && activeSub.count > 1 ? 'installments' : 'full',
        totalAmount,
        installmentsCount: activeSub ? activeSub.count || 1 : 1,
        installmentAmount: activeSub ? activeSub.amount : totalAmount,
        vatType: 'ht',
        description: lead.formule || 'Programme Business Phénix',
        createdBy: auth.uid,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        ...gcFields
      };
      const ref = await db.collection('payments').add(newPay);
      result.paymentDocId = ref.id;
    }

    // 5. Mettre à jour le lead avec les IDs GC
    if (activeMandate) {
      await db.collection('leads').doc(leadId).update({
        gcCustomerId: customerId,
        gcLinkedAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      });
    }

    res.json(result);

  } catch (e) {
    console.error('[gocardless-lookup]', e.message);
    res.status(500).json({ error: e.message });
  }
};
