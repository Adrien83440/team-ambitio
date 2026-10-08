// ============================================================================
// api/_replayEmail.js
// ----------------------------------------------------------------------------
// Helper interne (NON exposé comme endpoint) : construit l'email "replay +
// résumé de séance" envoyé aux clients coaching. Partagé entre :
//   - meet-recordings-sync.js  (envoi automatique par le cron quotidien)
//   - coaching-send-replay.js  (envoi AUTOMATIQUE à l'enregistrement d'une
//     séance dans la fiche, et envoi/renvoi MANUEL par le bouton
//     "✉️ Envoyer au client" — CSM / coachs / admins)
// Un seul template = un seul rendu, quel que soit le déclencheur.
//
// buildClientEmail({ prenom, dateFr, coachName, videoUrl, notesUrl, academyUrl })
//   → { subject, bodyHtml, bodyText }
// videoUrl et notesUrl sont optionnels (au moins un attendu par l'appelant) ;
// le sujet et les boutons s'adaptent à ce qui est disponible.
// academyUrl est optionnel : quand le client a un espace Academy, on lui
// rappelle qu'il y retrouve TOUTES ses séances (replays + synthèses), pas
// seulement celle-ci — l'email n'est plus le seul endroit où le lien vit.
// ============================================================================

function frLongDate(isoDate) {
  try {
    return new Date(isoDate + 'T12:00:00').toLocaleDateString('fr-FR', {
      weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
    });
  } catch (_) { return isoDate; }
}

function buildClientEmail(opts) {
  const prenom = opts.prenom || '';
  const dateFr = opts.dateFr || '';
  const coach = opts.coachName || 'ton coach';
  const hasVideo = !!opts.videoUrl;
  const hasNotes = !!opts.notesUrl;
  const academyUrl = opts.academyUrl || '';

  const duDate = dateFr ? ' du ' + dateFr : '';
  const subject = hasVideo
    ? '🎥 Ton replay de séance' + duDate
    : '📝 Ton résumé de séance' + duDate;

  const btn = (url, label, bg) =>
    '<a href="' + url + '" target="_blank" style="display:inline-block;padding:12px 22px;margin:6px 8px 6px 0;' +
    'background:' + bg + ';color:#ffffff;text-decoration:none;border-radius:10px;font-weight:700;font-size:14px">' +
    label + '</a>';

  const bodyHtml =
    '<div style="font-family:Arial,Helvetica,sans-serif;max-width:560px;margin:0 auto;color:#1f2340;font-size:14px;line-height:1.7">' +
    '<p>Bonjour' + (prenom ? ' ' + prenom : '') + ' 👋</p>' +
    '<p>Ta séance' + (dateFr ? ' du <strong>' + dateFr + '</strong>' : '') + ' avec ' + coach + ' est disponible :</p>' +
    '<div style="margin:18px 0">' +
    (hasVideo ? btn(opts.videoUrl, '▶️ Regarder le replay', '#4f46e5') : '') +
    (hasNotes ? btn(opts.notesUrl, '📝 Lire le résumé de la séance', '#059669') : '') +
    '</div>' +
    (academyUrl
      ? '<p style="font-size:13px;color:#3b3f5c;margin:0 0 14px">Tu retrouves <strong>toutes tes séances</strong> — replays et synthèses — à tout moment dans ton espace : ' +
        '<a href="' + academyUrl + '" target="_blank" style="color:#4f46e5;font-weight:700">ouvrir mon espace</a>.</p>'
      : '') +
    '<p style="font-size:12.5px;color:#6b7194">Garde ces liens précieusement : ils restent accessibles à tout moment pour revoir les points clés et avancer entre deux séances.</p>' +
    '<p>À très vite,<br><strong>L\'équipe Alteore</strong></p>' +
    '</div>';

  const bodyText =
    'Bonjour' + (prenom ? ' ' + prenom : '') + ',\n\n' +
    'Ta séance' + (dateFr ? ' du ' + dateFr : '') + ' avec ' + coach + ' est disponible :\n\n' +
    (hasVideo ? '▶️ Replay : ' + opts.videoUrl + '\n' : '') +
    (hasNotes ? '📝 Résumé : ' + opts.notesUrl + '\n' : '') +
    (academyUrl ? '\nToutes tes séances (replays et synthèses) sont dans ton espace : ' + academyUrl + '\n' : '') +
    '\nÀ très vite,\nL\'équipe Alteore';

  return { subject, bodyHtml, bodyText };
}

module.exports = { buildClientEmail, frLongDate };
