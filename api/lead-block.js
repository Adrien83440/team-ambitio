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
// Body : { leadId, target:'email'|'phone', action:'block'|'unblock', reason? }
//
// Réponses
//   200 { ok:true, action, target, key }
//   400 { ok:false, error }
//   401/403 (helper d'auth)
//   404 { ok:false, error:'lead_not_found' }
//
// ─── ON BLOQUE UNE VALEUR, PAS UNE PERSONNE ───────────────────────────
// Règle Adrien 30/07 : on blackliste LE mail bidon, ou LE faux numéro —
// celui qui est faux, pas les deux d'office. Si la personne se réinscrit
// avec un autre numéro (ou un autre mail), la nouvelle fiche est CRÉÉE :
// on la garde au cas où. Bloquer les deux ensemble reviendrait à bannir
// l'individu, et ferait perdre un lead peut-être réel.
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

/* La valeur visée par la demande — UNE seule, jamais les deux. */
function targetOf(lead, target) {
  if (target === 'email') {
    const em = String(lead.email || '').trim().toLowerCase();
    if (!em) return null;
    return { key: safeKey('email', em), type: 'email', value: em };
  }
  const ph = phoneNormalized(lead.telephone || lead.phone);
  if (!ph) return null;
  return { key: safeKey('phone', ph), type: 'phone', value: ph };
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
  const target = body && body.target === 'email' ? 'email' : 'phone';
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
    const t = targetOf(lead, target);

    if (!t || !t.key) {
      res.status(400).json({ ok: false, error: target === 'email' ? 'no_email_on_lead' : 'no_phone_on_lead' });
      return;
    }

    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    const ref = db.collection('blocked_contacts').doc(t.key);

    if (action === 'block') {
      batch.set(ref, {
        type: t.type,
        value: t.value,
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

    /* Marquage de la fiche — un drapeau PAR VALEUR, jamais de suppression :
       l'historique reste, et on sait exactement laquelle des deux coordonnées
       est refusée à l'entrée. */
    const DEL = admin.firestore.FieldValue.delete();
    const flag = target === 'email' ? 'blockedEmail' : 'blockedPhone';
    const otherFlag = target === 'email' ? 'blockedPhone' : 'blockedEmail';
    const otherStillBlocked = lead[otherFlag] === true;
    const leadPatch = {
      updatedAt: now,
      timeline_history: admin.firestore.FieldValue.arrayUnion({
        text: (action === 'block' ? '🚫 Blacklist ' : '✅ Blacklist levée ')
            + (target === 'email' ? 'email ' + t.value : 'numéro ' + t.value)
            + (reason ? ' — ' + reason : '')
            + (auth.email ? ' (par ' + auth.email + ')' : ''),
        date: new Date().toLocaleString('fr-FR', { timeZone: 'Europe/Paris' }),
        color: action === 'block' ? '#ef4444' : '#34d399',
      }),
    };
    leadPatch[flag] = action === 'block' ? true : DEL;
    /* `blocked` = au moins une coordonnée blacklistée (sert à l'affichage). */
    leadPatch.blocked = action === 'block' ? true : otherStillBlocked;
    if (action === 'block') {
      leadPatch.blockedAt = now;
      leadPatch.blockedBy = auth.email || auth.uid || null;
      leadPatch.blockedReason = reason || null;
      /* Sort la fiche des files de travail. Débloquer ne devine PAS un
         statut : c'est à l'équipe de la requalifier. */
      leadPatch.status = 'poubelle';
      leadPatch.stage = 'poubelle';
    } else if (!otherStillBlocked) {
      leadPatch.blockedAt = DEL;
      leadPatch.blockedBy = DEL;
      leadPatch.blockedReason = DEL;
    }
    batch.update(db.collection('leads').doc(leadId), leadPatch);

    await batch.commit();

    /* Trace d'audit — best-effort, ne doit jamais faire échouer l'action. */
    try {
      await db.collection('audit_log').add({
        type: 'lead_block',
        action,
        target,
        leadId,
        key: t.key,
        value: t.value,
        reason: reason || null,
        actorUid: auth.uid || null,
        actorEmail: auth.email || null,
        at: now,
      });
    } catch (e) {
      console.warn('[lead-block] audit_log:', e && e.message);
    }

    res.status(200).json({ ok: true, action, target, key: t.key, value: t.value });
  } catch (e) {
    console.error('[lead-block]', e && e.message);
    res.status(500).json({ ok: false, error: 'server_error' });
  }
};
