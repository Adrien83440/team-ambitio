// ============================================================================
// api/parcours-clic.js — LIENS DES E-MAILS D'APRÈS-RDV (24/11/2026)
// ----------------------------------------------------------------------------
// Page PUBLIQUE ouverte par le prospect depuis un e-mail de sa séquence
// (api/_parcoursSuite.js). Lien : /api/parcours-clic?j=<jeton>&a=<action>&e=<étape>
//   a = a | b   → il choisit la suite de son histoire
//   a = rdv     → il veut réserver (page relais puis calendrier)
//   a = stop    → il veut se désinscrire (bouton de confirmation)
//
// La LECTURE du lien (GET) n'enregistre RIEN : messageries et antivirus
// ouvrent les liens pour l'aperçu. C'est la page, dans le navigateur, qui
// envoie le clic (POST). La désinscription demande en plus un vrai clic.
// Aucune donnée du prospect n'est affichée, à part son prénom.
// ============================================================================
'use strict';

const parseBody = require('./_parseBody');
const S = require('./_parcoursSuite');

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function page(titre, corps, script) {
  return '<!DOCTYPE html><html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex,nofollow"><title>' + esc(titre) + '</title>'
    + '<style>body{margin:0;background:#f3f4f8;font-family:Helvetica,Arial,sans-serif;color:#1f2937;line-height:1.6}'
    + '.c{max-width:560px;margin:0 auto;padding:36px 18px}.h{background:linear-gradient(135deg,#1e3a8a,#3b82f6);border-radius:18px 18px 0 0;padding:20px 30px;color:#c7d2fe;font-size:12px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase}'
    + '.b{background:#fff;border:1px solid #e5e7eb;border-top:none;border-radius:0 0 18px 18px;padding:30px}h1{font-size:22px;margin:0 0 14px;color:#111827}p{margin:0 0 16px;font-size:16px}'
    + '.q{background:#eff4ff;border-left:4px solid #2563eb;border-radius:0 10px 10px 0;padding:12px 16px;font-weight:600;color:#1e3a8a;margin:0 0 18px}'
    + '.btn{display:inline-block;background:#2563eb;color:#fff;border:0;border-radius:10px;padding:14px 24px;font-size:16px;font-weight:700;text-decoration:none;cursor:pointer;font-family:inherit}'
    + '.btn.g{background:#fff;color:#6b7280;border:1.5px solid #d1d5db}.s{font-size:13px;color:#9ca3af;margin-top:22px}</style></head>'
    + '<body><div class="c"><div class="h">Adrien &amp; Emily</div><div class="b">' + corps + '</div></div>'
    + (script ? '<script>' + script + '</script>' : '') + '</body></html>';
}

/* Envoie le clic depuis le navigateur. `suite` : fonction appelée après. */
function scriptClic(jeton, action, etape, apres) {
  return '(function(){var fait=false;function go(){if(fait)return;fait=true;' + (apres || '') + '}'
    + 'try{var x=new XMLHttpRequest();x.open("POST","/api/parcours-clic",true);x.setRequestHeader("Content-Type","application/json");'
    + 'x.onloadend=go;x.send(JSON.stringify({j:' + JSON.stringify(jeton) + ',a:' + JSON.stringify(action) + ',e:' + (Number(etape) || 0) + '}));}catch(e){go();}'
    + 'setTimeout(go,2500);})();';
}

module.exports = async function (req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Robots-Tag', 'noindex, nofollow');
  try {
    if (req.method === 'POST') {
      const body = (await parseBody(req)) || {};
      const a = String(body.a || '');
      if (['a', 'b', 'rdv', 'stop'].indexOf(a) < 0) { res.status(400).json({ ok: false }); return; }
      const r = await S.enregistrerClic(body.j, a, body.e);
      res.status(r.ok ? 200 : 404).json({ ok: !!r.ok });
      return;
    }
    if (req.method !== 'GET') { res.status(405).end(); return; }
    const q = req.query || {};
    const jeton = String(q.j || '');
    const a = String(q.a || '');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    const x = await S.parJeton(jeton);
    if (!x || ['a', 'b', 'rdv', 'stop'].indexOf(a) < 0) {
      res.status(404).send(page('Lien expiré', '<h1>Ce lien n\'est plus valable</h1><p>Vous pouvez nous écrire directement en répondant à l\'un de nos e-mails.</p>'));
      return;
    }
    const s = x.data;
    const prenom = esc(s.prenom || '');
    const rdv = S.lienRdvDirect(s.sequence);

    if (a === 'rdv') {
      res.status(200).send(page('Réserver votre audit',
        '<h1>Un instant' + (prenom ? ', ' + prenom : '') + '…</h1><p>Nous ouvrons le calendrier.</p><p><a class="btn" href="' + esc(rdv) + '">Ouvrir le calendrier</a></p>',
        scriptClic(jeton, 'rdv', q.e, 'location.replace(' + JSON.stringify(rdv) + ');')));
      return;
    }
    if (a === 'stop') {
      res.status(200).send(page('Se désinscrire',
        '<div id="av"><h1>Ne plus recevoir nos e-mails ?</h1><p>Un clic suffit. Vous ne recevrez plus aucun e-mail de notre part.</p>'
        + '<p><button class="btn" id="ok" type="button">Me désinscrire</button></p></div>'
        + '<div id="ap" style="display:none"><h1>C\'est fait</h1><p>Vous ne recevrez plus nos e-mails. Merci pour le temps que vous nous avez accordé.</p></div>',
        'document.getElementById("ok").addEventListener("click",function(){var b=this;b.disabled=true;'
        + 'var x=new XMLHttpRequest();x.open("POST","/api/parcours-clic",true);x.setRequestHeader("Content-Type","application/json");'
        + 'x.onloadend=function(){document.getElementById("av").style.display="none";document.getElementById("ap").style.display="block";};'
        + 'x.send(JSON.stringify({j:' + JSON.stringify(jeton) + ',a:"stop"}));});'));
      return;
    }
    // Choix de la suite.
    const titre = S.titreChoix(s, a);
    if (!titre) { res.status(404).send(page('Lien expiré', '<h1>Ce lien n\'est plus valable</h1>')); return; }
    const dejaPartie = !!s.choixFige || !!(s.etapes || {}).e3;
    const corps = dejaPartie
      ? '<h1>La suite est déjà partie' + (prenom ? ', ' + prenom : '') + '</h1><p>Elle se trouve dans votre boîte e-mail. Si vous préférez en parler directement, choisissez un créneau :</p>'
      : '<h1>Bien noté' + (prenom ? ', ' + prenom : '') + '.</h1><p>Vous recevrez la suite que vous avez choisie :</p><div class="q">' + esc(titre) + '</div>'
        + '<p>Elle arrive dans votre boîte e-mail dans les prochains jours. Rien d\'autre à faire.</p><p>Et si vous préférez ne pas attendre :</p>';
    res.status(200).send(page('Bien noté', corps + '<p><a class="btn" href="' + esc(S.lienRdvDirect(s.sequence)) + '">Réserver mon audit</a></p><p class="s">Vous pouvez fermer cette page.</p>',
      dejaPartie ? null : scriptClic(jeton, a, q.e, '')));
  } catch (e) {
    console.error('[parcours-clic]', e && e.stack ? e.stack : e);
    res.status(500).send(page('Erreur', '<h1>Un souci de notre côté</h1><p>Réessayez dans un instant, ou répondez à notre e-mail.</p>'));
  }
};
