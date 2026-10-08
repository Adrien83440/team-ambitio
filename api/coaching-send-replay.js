// ============================================================================
// api/coaching-send-replay.js
// ----------------------------------------------------------------------------
// Envoi du replay + résumé d'une séance au client, depuis la fiche coaching
// (coaching.html). Deux déclencheurs, un seul endpoint :
//
//   • AUTOMATIQUE (body.auto === true) — dès qu'une séance individuelle est
//     enregistrée « faite » dans la fiche avec un lien (replay et/ou synthèse),
//     coaching.html appelle cette route sans intervention humaine. Le client
//     reçoit sa séance par email dans la foulée, et la retrouve dans son
//     espace Academy (le lien de l'espace est ajouté à l'email quand la fiche
//     a déjà synchronisé au moins une séance vers l'Academy).
//     Garde-fous du mode auto (tous répondent 200 { ok:true, skipped }) :
//       - client inactif / ancien client → 'client_inactive'
//       - pas d'email sur la fiche       → 'no_email'
//       - aucun lien sur la séance       → 'no_links'
//       - déjà envoyé avec ces liens     → 'already_sent'
//       - envoi en cours (double clic)   → 'in_progress'
//     Un lien NOUVEAU (la synthèse arrive après le replay, ou l'inverse)
//     déclenche un nouvel envoi : le client reçoit ce qu'il n'a pas encore.
//
//   • MANUEL (bouton "✉️ Envoyer au client" / "Renvoyer") — pas de garde
//     at-most-once : l'action est humaine et derrière un confirm(). Sert aux
//     renvois (client qui a perdu le mail) et aux cas hors auto.
//
// REGISTRE ANTI-DOUBLON : clients/{clientId}/replay_emails/{clé}
//   clé = 'y<indexAnnée>-n<numero>' (fiche par années) ou 'legacy-n<numero>'.
//   Sous-collection, et pas un champ du document client : coaching.html
//   réécrit la fiche ENTIÈRE (setDoc) depuis une copie locale chargée à
//   l'ouverture — un marqueur posé sur la séance par le serveur peut donc
//   être écrasé par la sauvegarde suivante. Le registre, lui, survit.
//   Écrit uniquement par l'Admin SDK : aucune règle Firestore à ajouter.
//   Champs : sentAt, to, by ('auto' | email de l'agent | 'cron' reporté),
//            videoUrl, notesUrl, mode, attemptAt (envoi en cours), error.
//   Un marqueur historique replaySentAt sur la séance (cron, ancien bouton)
//   est reporté dans le registre au premier passage auto : pas de renvoi.
//
// URL  : POST /api/coaching-send-replay
// Auth : Bearer Firebase ID token — rôles admin / coach / csm.
// Body : { clientId, sessionNumero, yearIndex?, sessionDate?, auto? }
//
// Le serveur relit la fiche clients/{clientId} (source de vérité) : il ne
// fait jamais confiance à des URLs venues du navigateur. La séance est
// retrouvée par (yearIndex + numero) puis par (numero + date) dans toutes
// les années, puis dans le tableau legacy c.sessions[]. Liens envoyés :
// s.visioUrl (replay) et s.driveUrl || s.resumeUrl (résumé) — au moins un
// requis. Même template email que le cron (api/_replayEmail.js), expédié
// depuis la boîte 'coaching' (email_tokens — admin-email-auth.html).
// Après envoi : replaySentAt / replaySentTo / replaySentBy posés sur la
// séance (affichage fiche, best-effort) + registre mis à jour.
//
// Réponse 200 : { ok:true, to, sentAt }  ou  { ok:true, skipped:'…' } (auto)
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
const LEDGER = 'replay_emails';
const IN_PROGRESS_MS = 2 * 60000; // un 2e appel auto identique dans la fenêtre = ignoré
const ACADEMY_URL = (process.env.ACADEMY_BRIDGE_URL || 'https://academy.adrienemily.com').replace(/\/$/, '');

// Retrouve la séance dans la fiche : { s, container:'years'|'sessions', yi }
function findSession(c, sessionNumero, sessionDate, yearIndex) {
  const matchIn = (list) => {
    if (!Array.isArray(list)) return null;
    // numero + date d'abord (le plus précis), puis numero seul
    let found = list.find((x) => x && x.numero === sessionNumero && sessionDate && x.date === sessionDate);
    if (!found) found = list.find((x) => x && x.numero === sessionNumero);
    return found || null;
  };
  if (Array.isArray(c.years) && c.years.length) {
    if (yearIndex != null && c.years[yearIndex]) {
      const s = matchIn(c.years[yearIndex].sessions);
      if (s) return { s, container: 'years', yi: yearIndex };
    }
    for (let i = 0; i < c.years.length; i++) {
      const s = matchIn(c.years[i] && c.years[i].sessions);
      if (s) return { s, container: 'years', yi: i };
    }
  }
  if (Array.isArray(c.sessions)) {
    const s = matchIn(c.sessions);
    if (s) return { s, container: 'sessions', yi: null };
  }
  return null;
}

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
  const auto = body.auto === true;
  const by = auto ? 'auto' : (auth.email || auth.uid);

  if (!clientId || sessionNumero == null) {
    res.status(400).json({ ok: false, error: 'missing_params' });
    return;
  }

  // En mode auto, un cas « rien à faire » n'est pas une erreur : 200 + skipped.
  const skip = (reason, extra) => {
    if (auto) { res.status(200).json(Object.assign({ ok: true, skipped: reason }, extra || {})); return; }
    res.status(extra && extra.status ? extra.status : 400).json({ ok: false, error: reason });
  };

  try {
    // ── 1. Fiche client (source de vérité) ─────────────────────────────
    const clientRef = db.collection('clients').doc(clientId);
    const snap = await clientRef.get();
    if (!snap.exists) {
      res.status(404).json({ ok: false, error: 'client_not_found' });
      return;
    }
    const c = snap.data() || {};

    // Fin d'accompagnement : plus d'envoi automatique. Le renvoi manuel
    // reste possible (geste délibéré d'un coach / CSM).
    if (auto && (c.ancienClient === true || c.statut === 'inactif')) {
      skip('client_inactive');
      return;
    }

    const to = (c.email || '').trim();
    if (!to) {
      if (auto) { skip('no_email'); return; }
      res.status(400).json({ ok: false, error: 'client_no_email' });
      return;
    }

    // ── 2. Retrouver la séance ──────────────────────────────────────────
    const found = findSession(c, sessionNumero, sessionDate, yearIndex);
    if (!found) {
      res.status(404).json({ ok: false, error: 'session_not_found' });
      return;
    }
    const s = found.s;
    const container = found.container;

    // ── 3. Liens à envoyer ──────────────────────────────────────────────
    const videoUrl = (s.visioUrl || '').trim() || null;
    const notesUrl = (s.driveUrl || s.resumeUrl || '').trim() || null;
    if (!videoUrl && !notesUrl) {
      skip('no_links');
      return;
    }

    // ── 4. Registre anti-doublon ────────────────────────────────────────
    const ledgerKey = (container === 'years' ? 'y' + found.yi : 'legacy') + '-n' + String(sessionNumero);
    const ledgerRef = clientRef.collection(LEDGER).doc(ledgerKey);
    const now = Date.now();
    const attempt = {
      attemptAt: now,
      attemptVideoUrl: videoUrl,
      attemptNotesUrl: notesUrl,
      attemptBy: by,
      error: null,
      sessionNumero: sessionNumero,
      yearIndex: found.yi,
      sessionDate: s.date || null,
      mode: auto ? 'auto' : 'manual',
    };

    if (auto) {
      const decision = await db.runTransaction(async (tx) => {
        const lSnap = await tx.get(ledgerRef);
        const L = lSnap.exists ? (lSnap.data() || {}) : {};
        if (L.sentAt) {
          const newVideo = !!videoUrl && videoUrl !== (L.videoUrl || null);
          const newNotes = !!notesUrl && notesUrl !== (L.notesUrl || null);
          if (!newVideo && !newNotes) return { skipped: 'already_sent' };
        } else if (s.replaySentAt) {
          // Marqueur historique (cron / bouton avant le registre) : reporté
          // dans le registre, et on n'envoie pas — le bouton « Renvoyer »
          // reste là pour un complément volontaire.
          tx.set(ledgerRef, {
            sentAt: s.replaySentAt,
            to: s.replaySentTo || to,
            by: s.replaySentBy || 'legacy',
            videoUrl: videoUrl,
            notesUrl: notesUrl,
            mode: 'backfill',
            backfilledAt: now,
            sessionNumero: sessionNumero,
            yearIndex: found.yi,
            sessionDate: s.date || null,
          }, { merge: true });
          return { skipped: 'already_sent', backfilled: true };
        }
        if (L.attemptAt && (now - L.attemptAt) < IN_PROGRESS_MS &&
            (L.attemptVideoUrl || null) === videoUrl && (L.attemptNotesUrl || null) === notesUrl) {
          return { skipped: 'in_progress' };
        }
        tx.set(ledgerRef, attempt, { merge: true });
        return { send: true };
      });
      if (decision.skipped) {
        console.log('[send-replay] auto skip', clientId, ledgerKey, decision.skipped);
        skip(decision.skipped, decision.backfilled ? { backfilled: true } : null);
        return;
      }
    } else {
      await ledgerRef.set(attempt, { merge: true });
    }

    // ── 5. Email (même template que le cron) ────────────────────────────
    const prenom = String(c.nom || '').trim().split(/\s+/)[0] || '';
    const hasAcademy = Array.isArray(c.academySeanceHistory) && c.academySeanceHistory.length > 0;
    const mail = buildClientEmail({
      prenom,
      dateFr: s.date ? frLongDate(s.date) : '',
      coachName: s.coach || null,
      videoUrl,
      notesUrl,
      academyUrl: hasAcademy ? ACADEMY_URL + '/parcours' : '',
    });

    try {
      await sendEmailFromAccount({
        accountKey: EMAIL_ACCOUNT,
        to,
        subject: mail.subject,
        bodyHtml: mail.bodyHtml,
        bodyText: mail.bodyText,
      });
    } catch (e) {
      console.error('[send-replay] email', clientId, ledgerKey, e.message);
      try { await ledgerRef.set({ error: e.message, attemptAt: null }, { merge: true }); } catch (_) { /* noop */ }
      res.status(auto ? 200 : 500).json({ ok: false, error: e.message });
      return;
    }

    // ── 6. Registre + marqueurs sur la séance (affichés dans la fiche) ──
    const sentAt = new Date().toISOString();
    try {
      await ledgerRef.set({
        sentAt: sentAt,
        to: to,
        by: by,
        videoUrl: videoUrl,
        notesUrl: notesUrl,
        mode: auto ? 'auto' : 'manual',
        attemptAt: null,
        error: null,
      }, { merge: true });
    } catch (e) {
      console.warn('[send-replay] registre', clientId, ledgerKey, e.message);
    }

    s.replaySentAt = sentAt;
    s.replaySentTo = to;
    s.replaySentBy = by;
    const patch = {};
    patch[container] = c[container];
    try {
      await clientRef.update(patch);
    } catch (e) {
      // L'email est parti : on ne fait pas échouer la requête pour un
      // marqueur — on log et on répond ok avec un warning.
      console.warn('[send-replay] marqueur session', clientId, e.message);
      res.status(200).json({ ok: true, to, sentAt, warning: 'marker_not_saved: ' + e.message });
      return;
    }

    console.log('[send-replay]', auto ? 'auto' : 'manuel', clientId, ledgerKey, '→', to, 'par', by);
    res.status(200).json({ ok: true, to, sentAt });
  } catch (e) {
    console.error('[send-replay]', e);
    res.status(500).json({ ok: false, error: e.message });
  }
};
