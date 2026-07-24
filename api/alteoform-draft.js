// ============================================================================
// api/alteoform-draft.js
// ----------------------------------------------------------------------------
// « Finir plus tard » — brouillons AlteoForm : sauvegarde de la progression
// d'un répondant, lien magique de reprise par email, chargement, renvoi du
// lien, consommation à la soumission.
//
// URL  : POST https://team.alteore.com/api/alteoform-draft
// Auth : aucune — endpoint public (visiteur anonyme du formulaire)
// CORS : ouvert (cohérent avec api/alteoform-submit.js)
//
// Body (JSON) — champ `action` obligatoire :
//
//   save    { action:'save', formId, email, answers:{fld:val}, draftId? }
//           → { ok:true, draftId, emailSent, emailReason? }
//           Crée ou met à jour le brouillon (dédupliqué par email au sein
//           du formulaire), pose expiresAt = +60 j, envoie le lien magique
//           par Gmail (compte 'contact'). Cooldown email : 60 s.
//
//   load    { action:'load', formId, draftId }
//           → { ok:true, answers, email, progress, updatedAt }
//           → { ok:false, error:'not_found'|'expired' }
//
//   resend  { action:'resend', formId, email }
//           → { ok:true } TOUJOURS (réponse neutre, anti-énumération
//           d'emails : impossible de savoir si une sauvegarde existe).
//
//   consume { action:'consume', formId, draftId }
//           → { ok:true } — supprime le brouillon (appelé à la soumission,
//           fire & forget côté renderer). Idempotent.
//
// SÉCURITÉ
// --------
// - Le draftId EST le secret : token aléatoire 24 octets (base64url,
//   ~32 chars, généré serveur). Il n'est transmis QUE dans l'email du
//   répondant. Même modèle de capacité que signature_requests (reqId
//   secret dans l'URL), mais ici la collection n'est PAS lisible côté
//   client anonyme : tout passe par cet endpoint (Admin SDK).
// - Jamais de chargement des réponses par email seul : taper un email ne
//   fait que RENVOYER le lien à cette adresse (action resend, neutre).
// - Sanitisation des answers : ≤ 200 clés, valeurs string ≤ 5000 chars.
// - `settings.allowDraft === false` sur le formulaire → save/resend
//   refusés (le toggle du builder fait foi côté serveur aussi).
//
// STOCKAGE : alteo_forms/{formId}/drafts/{draftId}
//   { formId, formTitle, email, answers, progress, fieldCount,
//     status:'draft', createdAt, updatedAt, expiresAt, lastEmailSentAt,
//     userAgent }
//   Rules : read/delete admin (onglet Réponses du builder), write client
//   interdit — seul cet endpoint écrit. Aucun index composite requis
//   (where('email','==',…) = single-field).
// ============================================================================

const crypto = require('crypto');
const { db, admin } = require('./_firebaseAdmin');
const parseBody = require('./_parseBody');
const { sendEmailFromAccount } = require('./_gmailSend');

const BASE_URL = 'https://team.alteore.com';
const ACCOUNT_KEY = 'contact';           // email_tokens/contact (Gmail OAuth)
const DRAFT_TTL_DAYS = 60;
const EMAIL_COOLDOWN_MS = 60 * 1000;     // 1 email / minute / brouillon
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function genToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function sanitizeAnswers(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const keys = Object.keys(raw).slice(0, 200);
  for (const k of keys) {
    if (typeof k !== 'string' || !k || k.length > 80) continue;
    let v = raw[k];
    if (v === null || v === undefined) continue;
    if (typeof v === 'number' || typeof v === 'boolean') v = String(v);
    if (typeof v !== 'string') continue;
    v = v.slice(0, 5000);
    if (v === '') continue;
    out[k] = v;
  }
  return out;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Email de reprise — même gabarit maison que payments-send-mandate-email.
function buildDraftEmail({ formTitle, resumeUrl, progress, fieldCount }) {
  const safeTitle = escHtml(formTitle || 'votre formulaire');
  const safeUrl = escHtml(resumeUrl);
  const progLine = (progress && fieldCount)
    ? `Votre progression est enregistrée : <strong>${progress} réponse${progress > 1 ? 's' : ''} sur ${fieldCount}</strong>.`
    : 'Votre progression est enregistrée.';

  const subject = 'Reprenez votre formulaire — ' + (formTitle || 'Ambitio');

  const bodyHtml = `<!DOCTYPE html>
<html lang="fr">
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#1a1a1a">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f4f7;padding:32px 16px">
    <tr>
      <td align="center">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.06)">
          <tr>
            <td style="padding:32px 36px 8px;font-size:16px;line-height:1.55;color:#1a1a1a">
              <p style="margin:0 0 16px">Bonjour,</p>
              <p style="margin:0 0 16px">Vous avez demandé à finir plus tard le formulaire <strong>« ${safeTitle} »</strong>. ${progLine}</p>
              <p style="margin:0 0 8px">Cliquez ci-dessous pour reprendre exactement où vous en étiez, depuis n'importe quel appareil :</p>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 36px 24px">
              <a href="${safeUrl}" style="display:inline-block;background:#f59e0b;color:#000000;text-decoration:none;font-weight:700;font-size:15px;padding:14px 28px;border-radius:8px">Reprendre mon formulaire</a>
            </td>
          </tr>
          <tr>
            <td style="padding:0 36px 24px;font-size:13px;line-height:1.55;color:#555">
              <p style="margin:0 0 12px">Ou copiez ce lien dans votre navigateur :</p>
              <p style="margin:0 0 20px;word-break:break-all;font-family:Menlo,Monaco,monospace;font-size:12px;color:#333">${safeUrl}</p>
              <p style="margin:0 0 12px;font-size:12px;color:#777">Ce lien est personnel — ne le partagez pas. Il reste valable ${DRAFT_TTL_DAYS} jours et ouvre toujours la dernière version de vos réponses.</p>
              <p style="margin:16px 0 0;font-size:13px;color:#1a1a1a">À très vite,<br/><strong>L'équipe Ambitio</strong></p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;

  const bodyText = `Bonjour,

Vous avez demandé à finir plus tard le formulaire « ${formTitle || ''} ».
Reprenez exactement où vous en étiez via ce lien (valable ${DRAFT_TTL_DAYS} jours, personnel) :

${resumeUrl}

À très vite,
L'équipe Ambitio`;

  return { subject, bodyHtml, bodyText };
}

// Envoie le lien magique en respectant le cooldown. Retourne
// { emailSent:boolean, emailReason?:'cooldown'|'send_failed' } et pose
// lastEmailSentAt sur le doc en cas de succès. N'échoue jamais (le brouillon
// est déjà sauvegardé — l'email est secondaire).
async function sendMagicLink(ref, existingData, formId, formTitle, email, progress, fieldCount) {
  const lastSent = (existingData && existingData.lastEmailSentAt && existingData.lastEmailSentAt.toMillis)
    ? existingData.lastEmailSentAt.toMillis() : 0;
  if (Date.now() - lastSent < EMAIL_COOLDOWN_MS) {
    return { emailSent: false, emailReason: 'cooldown' };
  }

  const resumeUrl = BASE_URL + '/alteoforms-render.html?id=' + encodeURIComponent(formId)
    + '&draft=' + encodeURIComponent(ref.id);
  const { subject, bodyHtml, bodyText } = buildDraftEmail({ formTitle, resumeUrl, progress, fieldCount });

  try {
    const out = await sendEmailFromAccount({
      accountKey: ACCOUNT_KEY,
      to: email,
      subject,
      bodyHtml,
      bodyText,
    });
    if (!out || out.ok !== true) {
      console.error('[alteoform-draft] gmail send failed:', out && out.error);
      return { emailSent: false, emailReason: 'send_failed' };
    }
    await ref.set({ lastEmailSentAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
    return { emailSent: true };
  } catch (e) {
    console.error('[alteoform-draft] gmail send error:', e && e.message);
    return { emailSent: false, emailReason: 'send_failed' };
  }
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed' });
    return;
  }

  const body = parseBody(req);
  const action = body.action;
  const formId = body.formId;

  if (!formId || typeof formId !== 'string' || formId.length > 80) {
    res.status(400).json({ error: 'formId_required' });
    return;
  }
  if (['save', 'load', 'resend', 'consume'].indexOf(action) < 0) {
    res.status(400).json({ error: 'unknown_action' });
    return;
  }

  const draftsCol = db.collection('alteo_forms').doc(formId).collection('drafts');

  try {
    // ── CONSUME — suppression à la soumission (idempotent) ───────────────
    if (action === 'consume') {
      const draftId = body.draftId;
      if (!draftId || typeof draftId !== 'string' || draftId.length > 80) {
        res.status(400).json({ error: 'draftId_required' });
        return;
      }
      await draftsCol.doc(draftId).delete();
      res.status(200).json({ ok: true });
      return;
    }

    // ── LOAD — restauration par token ────────────────────────────────────
    if (action === 'load') {
      const draftId = body.draftId;
      if (!draftId || typeof draftId !== 'string' || draftId.length > 80) {
        res.status(400).json({ error: 'draftId_required' });
        return;
      }
      const snap = await draftsCol.doc(draftId).get();
      if (!snap.exists) {
        res.status(200).json({ ok: false, error: 'not_found' });
        return;
      }
      const d = snap.data() || {};
      if (d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now()) {
        res.status(200).json({ ok: false, error: 'expired' });
        return;
      }
      res.status(200).json({
        ok: true,
        answers: d.answers || {},
        email: d.email || '',
        progress: d.progress || 0,
        updatedAt: (d.updatedAt && d.updatedAt.toMillis) ? d.updatedAt.toMillis() : null,
      });
      return;
    }

    // ── SAVE / RESEND : email requis + formulaire chargé ─────────────────
    const email = String(body.email || '').trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 200) {
      res.status(400).json({ error: 'email_invalid' });
      return;
    }

    const formDoc = await db.collection('alteo_forms').doc(formId).get();
    if (!formDoc.exists) {
      res.status(404).json({ error: 'form_not_found' });
      return;
    }
    const formData = formDoc.data() || {};
    const settings = formData.settings || {};
    const formTitle = formData.title || '';
    const allowDraft = settings.allowDraft !== false;

    // ── RESEND — réponse TOUJOURS neutre ─────────────────────────────────
    if (action === 'resend') {
      if (allowDraft) {
        const q = await draftsCol.where('email', '==', email).limit(1).get();
        if (!q.empty) {
          const ref = q.docs[0].ref;
          const d = q.docs[0].data() || {};
          const expired = d.expiresAt && d.expiresAt.toMillis && d.expiresAt.toMillis() < Date.now();
          if (!expired) {
            await sendMagicLink(ref, d, formId, formTitle, email, d.progress || 0, d.fieldCount || 0);
          }
        }
      }
      res.status(200).json({ ok: true });
      return;
    }

    // ── SAVE ─────────────────────────────────────────────────────────────
    if (!allowDraft) {
      res.status(403).json({ ok: false, error: 'draft_disabled' });
      return;
    }
    const answers = sanitizeAnswers(body.answers);
    const progress = Object.keys(answers).length;
    if (!progress) {
      res.status(400).json({ error: 'answers_empty' });
      return;
    }
    // Nombre de champs répondables (même filtre que FIELDS côté renderer,
    // hors cartes info) — pour l'affichage « X / Y » (email + builder).
    const fieldCount = (formData.fields || []).filter(function (f) {
      return f && f.id && f.type !== 'info' && f.label;
    }).length;

    // Résolution du brouillon : draftId fourni (re-save) → sinon dédup par
    // email au sein du formulaire → sinon création avec token neuf.
    let ref = null;
    let existing = null;
    if (body.draftId && typeof body.draftId === 'string' && body.draftId.length <= 80) {
      const snap = await draftsCol.doc(body.draftId).get();
      if (snap.exists) { ref = snap.ref; existing = snap.data(); }
    }
    if (!ref) {
      const q = await draftsCol.where('email', '==', email).limit(1).get();
      if (!q.empty) { ref = q.docs[0].ref; existing = q.docs[0].data(); }
    }
    if (!ref) ref = draftsCol.doc(genToken());

    const docData = {
      formId,
      formTitle,
      email,
      answers,
      progress,
      fieldCount,
      status: 'draft',
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      // Chaque sauvegarde repousse l'expiration de 60 jours.
      expiresAt: admin.firestore.Timestamp.fromMillis(Date.now() + DRAFT_TTL_DAYS * 86400000),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
    };
    if (!existing) docData.createdAt = admin.firestore.FieldValue.serverTimestamp();
    await ref.set(docData, { merge: true });

    const mail = await sendMagicLink(ref, existing, formId, formTitle, email, progress, fieldCount);

    res.status(200).json({
      ok: true,
      draftId: ref.id,
      emailSent: mail.emailSent,
      emailReason: mail.emailReason || null,
    });
  } catch (e) {
    console.error('[alteoform-draft] error:', e);
    res.status(500).json({ error: 'internal_error' });
  }
};
