// ============================================================================
// api/coaching-send-replay.js
// ----------------------------------------------------------------------------
// Envoi MANUEL du replay + résumé d'une séance au client, depuis la fiche
// coaching (bouton "✉️ Envoyer au client" sur chaque séance — coaching.html).
// Complète le cron meet-recordings-sync (envoi automatique) pour les cas :
//   - la CSM veut contrôler / déclencher elle-même l'envoi,
//   - renvoi (client qui a perdu le mail) — pas de garde at-most-once ici,
//     l'action est humaine et derrière un confirm(),
//   - séances anciennes hors fenêtre du cron, RDV pris hors système
//     (pas de calendarEventId), liens saisis à la main par le coach.
//
// URL  : POST /api/coaching-send-replay
// Auth : Bearer Firebase ID token — rôles admin / coach / csm.
// Body : { clientId, sessionNumero, yearIndex?, sessionDate? }
//
// Le serveur relit la fiche clients/{clientId} (source de vérité) : il ne
// fait jamais confiance à des URLs venues du navigateur. La séance est
// retrouvée par (yearIndex + numero) puis par (numero + date) dans toutes
// les années, puis dans le tableau legacy c.sessions[]. Liens envoyés :
// s.visioUrl (replay) et s.driveUrl || s.resumeUrl (résumé) — au moins un
// requis. Même template email que le cron (api/_replayEmail.js), expédié
// depuis la boîte 'coaching' (email_tokens — admin-email-auth.html).
// Après envoi : replaySentAt / replaySentTo / replaySentBy posés sur la
// séance (affichés dans la fiche, le bouton devient "Renvoyer").
//
// Réponse 200 : { ok:true, to, sentAt }
// Erreurs     : { ok:false, error: 'forbidden' | 'missing_params' |
//                'client_not_found' | 'client_no_email' |
//                'session_not_found' | 'no_links' | <message envoi> }
// ============================================================================

const { requireAuth } = require('./_verifyFirebaseAuth');
const { db } = require('./_firebaseAdmin');
const { sendEmailFromAccount } = require('./_gmailSend');
const { buildClientEmail, frLongDate } = require('./_replayEmail');
const parseBody = require('./_parseBody');

const ROLES = ['admin', 'coach', 'csm'];
const EMAIL_ACCOUNT = 'coaching';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'method_not_allowed' });
    return;
  }

  const auth = await requireAuth(req, res);
  if (!auth) return; // 401 déjà répondu
  if (ROLES.indexOf(auth.role) < 0) {
    res.status(403).json({ ok: false, error: 'forbidden' });
    return;
  }

  const body = parseBody(req) || {};
  const clientId = body.clientId ? String(body.clientId) : null;
  const sessionNumero = body.sessionNumero;
  const yearIndex = Number.isInteger(body.yearIndex) ? body.yearIndex : null;
  const sessionDate = body.sessionDate ? String(body.sessionDate) : null;

  if (!clientId || sessionNumero == null) {
    res.status(400).json({ ok: false, error: 'missing_params' });
    return;
  }

  try {
    // ── 1. Fiche client (source de vérité) ─────────────────────────────
    const snap = await db.collection('clients').doc(clientId).get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'client_not_found' });
      return;
    }
    const c = snap.data() || {};
    const to = (c.email || '').trim();
    if (!to) {
      res.status(400).json({ ok: false, error: 'client_no_email' });
      return;
    }

    // ── 2. Retrouver la séance ──────────────────────────────────────────
    const matchIn = (list) => {
      if (!Array.isArray(list)) return null;
      // numero + date d'abord (le plus précis), puis numero seul
      let found = list.find((x) => x && x.numero === sessionNumero && sessionDate && x.date === sessionDate);
      if (!found) found = list.find((x) => x && x.numero === sessionNumero);
      return found || null;
    };

    let s = null;
    let container = null; // 'years' | 'sessions'
    if (Array.isArray(c.years) && c.years.length) {
      if (yearIndex != null && c.years[yearIndex]) {
        s = matchIn(c.years[yearIndex].sessions);
      }
      if (!s) {
        for (const y of c.years) {
          s = matchIn(y && y.sessions);
          if (s) break;
        }
      }
      if (s) container = 'years';
    }
    if (!s && Array.isArray(c.sessions)) {
      s = matchIn(c.sessions);
      if (s) container = 'sessions';
    }
    if (!s) {
      res.status(404).json({ ok: false, error: 'session_not_found' });
      return;
    }

    // ── 3. Liens à envoyer ──────────────────────────────────────────────
    const videoUrl = s.visioUrl || null;
    const notesUrl = s.driveUrl || s.resumeUrl || null;
    if (!videoUrl && !notesUrl) {
      res.status(400).json({ ok: false, error: 'no_links' });
      return;
    }

    // ── 4. Email (même template que le cron) ────────────────────────────
    const prenom = String(c.nom || '').trim().split(/\s+/)[0] || '';
    const mail = buildClientEmail({
      prenom,
      dateFr: s.date ? frLongDate(s.date) : '',
      coachName: s.coach || null,
      videoUrl,
      notesUrl,
    });

    await sendEmailFromAccount({
      accountKey: EMAIL_ACCOUNT,
      to,
      subject: mail.subject,
      bodyHtml: mail.bodyHtml,
      bodyText: mail.bodyText,
    });

    // ── 5. Marqueurs sur la séance (affichés dans la fiche) ─────────────
    const sentAt = new Date().toISOString();
    s.replaySentAt = sentAt;
    s.replaySentTo = to;
    s.replaySentBy = auth.email || auth.uid;
    const patch = {};
    patch[container] = c[container];
    try {
      await db.collection('clients').doc(clientId).update(patch);
    } catch (e) {
      // L'email est parti : on ne fait pas échouer la requête pour un
      // marqueur — on log et on répond ok avec un warning.
      console.warn('[send-replay] marqueur session', clientId, e.message);
      res.status(200).json({ ok: true, to, sentAt, warning: 'marker_not_saved: ' + e.message });
      return;
    }

    console.log('[send-replay]', clientId, 'session', sessionNumero, '→', to, 'par', auth.email || auth.uid);
    res.status(200).json({ ok: true, to, sentAt });
  } catch (e) {
    console.error('[send-replay]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
