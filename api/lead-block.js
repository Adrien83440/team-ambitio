// ============================================================================
// api/lead-block.js
// ----------------------------------------------------------------------------
// LISTE DE BLOCAGE — faux numéros / emails bidon.
//
// « 06 00 00 00 00 », « test@test.fr », le même mail poubelle qui revient
// dix fois : une fois repéré depuis Leads Live, on bloque le contact et il
// ne redescend PLUS JAMAIS dans le CRM.
//
// URL  : POST https://team.alteore.com/api/lead-block
// Auth : Bearer ID token Firebase (membre d'équipe connecté).
// Body : { leadId, action:'block'|'unblock', reason? }
//
// Réponses
//   200 { ok:true, action, blocked:[clés], lead:{email,phone} }
//   400 { ok:false, error }
//   401/403 (helper d'auth)
//   404 { ok:false, error:'lead_not_found' }
//
// ─── POURQUOI UN ENDPOINT PLUTÔT QU'UNE ÉCRITURE CLIENT ────────────────
// Écrire blocked_contacts depuis le navigateur imposerait un nouveau bloc
// de rules Firestore — donc un déploiement manuel en console, et une
// fonctionnalité muette tant qu'il n'est pas fait (leçon des snapshots du
// funnel). Ici l'Admin SDK écrit, aucune rule à toucher : la fonction
// marche dès le déploiement du code.
//
// ─── FORME DES CLÉS ────────────────────────────────────────────────────
// blocked_contacts/{clé} avec clé déterministe :
//   email:<email en minuscules>      ex. email:test@test.fr
//   phone:<9 derniers chiffres>      ex. phone:600000000
// Un ID déterministe rend le blocage idempotent (re-bloquer n'empile pas)
// et surtout la vérification à l'ingestion est un simple get() par ID :
// aucune requête, aucun index, coût constant.
// ============================================================================

const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { requireAuth } = require('./_verifyFirebaseAuth');

/* 9 derniers chiffres — MÊME normalisation que api/lead-optin.js,
   api/alteoform-submit.js et sales-leads.html. Toute divergence ici
   laisserait passer un numéro pourtant bloqué. */
function phoneNormalized(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length < 6) return null;
  if (d.length >= 9) return d.slice(-9);
  return d;
}

/* Un ID de document Firestore ne peut pas contenir « / ». Les emails et les
   chiffres n'en contiennent pas, mais on ne fait pas confiance à la donnée
   entrante pour ça. */
function safeKey(prefix, value) {
  const v = String(value || '').trim().replace(/\//g, '_');
  if (!v) return null;
  return prefix + ':' + v;
}

function blockKeys(email, phone) {
  const keys = [];
  const em = String(email || '').trim().toLowerCase();
  if (em) { const k = safeKey('email', em); if (k) keys.push({ key: k, type: 'email', value: em }); }
  const ph = phoneNormalized(phone);
  if (ph) { const k = safeKey('phone', ph); if (k) keys.push({ key: k, type: 'phone', value: ph }); }
  return keys;
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');

  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return;                     // le helper a déjà répondu 401/403

  let body;
  try { body = await parseBody(req); } catch (e) { body = null; }
  const leadId = body && typeof body.leadId === 'string' ? body.leadId.trim() : '';
  const action = body && body.action === 'unblock' ? 'unblock' : 'block';
  const reason = body && typeof body.reason === 'string' ? body.reason.slice(0, 300) : null;

  if (!leadId) {
    res.status(400).json({ ok: false, error: 'leadId_required' });
    return;
  }

  try {
    const snap = await db.collection('leads').doc(leadId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'lead_not_found' });
      return;
    }
    const lead = snap.data() || {};
    const keys = blockKeys(lead.email, lead.telephone || lead.phone);

    if (!keys.length) {
      res.status(400).json({ ok: false, error: 'no_contact_to_block' });
      return;
    }

    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();

    keys.forEach((k) => {
      const ref = db.collection('blocked_contacts').doc(k.key);
      if (action === 'block') {
        batch.set(ref, {
          type: k.type,
          value: k.value,
          reason: reason || null,
          leadId,
          leadName: lead.nom || null,
          by: auth.uid || null,
          byEmail: auth.email || null,
          at: now,
        });
      } else {
        batch.delete(ref);
      }
    });

    /* Marquage de la fiche — jamais de suppression : l'historique reste, et
       le funnel garde une trace de ce qui est entré puis a été écarté. */
    const leadPatch = {
      blocked: action === 'block',
      blockedAt: action === 'block' ? now : admin.firestore.FieldValue.delete(),
      blockedBy: action === 'block' ? (auth.email || auth.uid || null) : admin.firestore.FieldValue.delete(),
      blockedReason: action === 'block' ? (reason || null) : admin.firestore.FieldValue.delete(),
      updatedAt: now,
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: (action === 'block' ? '🚫 Contact bloqué' : '✅ Blocage levé')
            + (reason ? ' — ' + reason : '')
            + (auth.email ? ' (par ' + auth.email + ')' : ''),
        date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
        color: action === 'block' ? '#ef4444' : '#34d399',
      }),
    };
    /* Bloquer sort le lead des files de travail ; débloquer ne devine pas
       un statut, il laisse celui en place (à l'équipe de le requalifier). */
    if (action === 'block') { leadPatch.status = 'poubelle'; leadPatch.stage = 'poubelle'; }
    batch.update(db.collection('leads').doc(leadId), leadPatch);

    await batch.commit();

    /* Trace d'audit — best-effort, ne doit jamais faire échouer l'action. */
    try {
      await db.collection('audit_log').add({
        type: 'lead_block',
        action,
        leadId,
        keys: keys.map((k) => k.key),
        reason: reason || null,
        actorUid: auth.uid || null,
        actorEmail: auth.email || null,
        at: now,
      });
    } catch (e) {
      console.warn('[lead-block] audit_log:', e && e.message);
    }

    res.status(200).json({
      ok: true,
      action,
      blocked: keys.map((k) => k.key),
      lead: { email: lead.email || null, phone: phoneNormalized(lead.telephone || lead.phone) },
    });
  } catch (e) {
    console.error('[lead-block]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
