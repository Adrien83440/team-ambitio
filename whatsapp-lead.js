/* ============================================================================
   whatsapp-lead.js — CANAL WHATSAPP DANS LA FICHE D'UN LEAD
   ----------------------------------------------------------------------------
   window.WhatsAppLead.attach(mount, leadId, telephone)
   window.WhatsAppLead.detach(leadId)

   Se greffe dans le segment « Échange » de Leads Live, à côté du SMS et des
   vocaux, et lit la MÊME source que la boîte partagée (whatsapp.html) :
   whatsapp_conversations/{numero}. Un message envoyé d'ici apparaît là-bas, et
   inversement. Deux écrans, une seule conversation.

   LA FENÊTRE DE 24 H COMMANDE TOUT
   --------------------------------
   WhatsApp n'autorise un message libre que dans les 24 h suivant le dernier
   message du contact. C'est une différence de nature avec le SMS, qui part
   quand on veut : ici, écrire à un prospect qui n'a jamais répondu est
   IMPOSSIBLE sans un modèle approuvé par Meta.
   L'écran ne propose donc jamais un champ de saisie qui échouerait — il montre
   l'état de la fenêtre, et bascule seul entre saisie libre et choix d'un
   modèle. Le serveur revérifie de son côté (api/whatsapp-send.js).

   SDK compat, ES5 — comme toutes les pages sales.
   ========================================================================== */
(function () {
  'use strict';

  var ETATS = {};   /* leadId → { numero, offConv, offFil, conv, msgs, modeles, modeleActif, vals } */

  /* ── Styles, injectés une seule fois ─────────────────────────────────── */
  function ensureCss() {
    if (document.getElementById('wal-css')) return;
    var s = document.createElement('style');
    s.id = 'wal-css';
    s.textContent = [
      '.wal{margin:14px 0 0;padding:10px 12px;background:rgba(0,168,132,.05);',
      'border:1px solid rgba(0,168,132,.3);border-radius:12px}',
      '.wal-h{display:flex;align-items:center;gap:8px;margin-bottom:8px}',
      '.wal-t{font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.7px;color:#4fd1b0;flex:1}',
      '.wal-f{font-size:10px;font-weight:700;padding:3px 8px;border-radius:10px;white-space:nowrap}',
      '.wal-f.on{background:rgba(0,168,132,.16);color:#4fd1b0}',
      '.wal-f.off{background:rgba(251,191,36,.12);color:#fbbf24}',
      /* Hauteur relative à la fenêtre plutôt que 260 px figés : sur un grand
         écran le fil respirait à peine, et sur un portable il mangeait toute
         la fiche. `min()` garde une borne haute pour ne pas repousser le
         composeur hors de vue. */
      '.wal-fil{max-height:min(46vh,340px);overflow-y:auto;display:flex;flex-direction:column;gap:3px;',
      'padding:8px 4px;margin-bottom:8px;scrollbar-width:thin;',
      'scrollbar-color:rgba(255,255,255,.28) transparent}',
      /* macOS masque les barres de défilement au repos : un fil tronqué net
         passait pour un affichage cassé. Le pouce est assez contrasté pour
         qu'on comprenne qu'il reste du contenu. */
      '.wal-fil::-webkit-scrollbar{width:7px}',
      '.wal-fil::-webkit-scrollbar-thumb{background:rgba(255,255,255,.24);border-radius:4px}',
      '.wal-fil::-webkit-scrollbar-thumb:hover{background:rgba(255,255,255,.4)}',
      '.wal-b{max-width:82%;padding:6px 10px;border-radius:9px;font-size:12.5px;line-height:1.45;',
      'white-space:pre-wrap;word-break:break-word}',
      '.wal-b.in{align-self:flex-start;background:rgba(255,255,255,.06)}',
      '.wal-b.out{align-self:flex-end;background:rgba(0,168,132,.18)}',
      '.wal-m{font-size:9.5px;opacity:.6;margin-top:3px;text-align:right}',
      '.wal-m.ko{color:#f87171;opacity:1;font-weight:700}',
      /* Pièces jointes reçues : la source est Firebase Storage, où le webhook
         a archivé le fichier — l'URL de Meta expire en 5 min. */
      '.wal-media{display:block;margin:1px 0 4px}',
      '.wal-media img,.wal-media video{display:block;max-width:100%;max-height:220px;border-radius:6px}',
      '.wal-media img{cursor:zoom-in}',
      '.wal-media audio{display:block;width:100%;max-width:230px;margin:3px 0 1px}',
      '.wal-fichier{display:inline-flex;align-items:center;gap:6px;padding:6px 9px;border-radius:7px;',
      'background:rgba(255,255,255,.08);color:inherit;text-decoration:none;font-size:12px;max-width:100%}',
      '.wal-fichier span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.wal-media-ko{font-size:11.5px;font-style:italic;opacity:.6}',
      '.wal-motif{display:block;margin-top:3px;font-size:10.5px;font-weight:700;color:#f87171}',
      '.wal-vide{text-align:center;font-size:11.5px;color:rgba(255,255,255,.35);padding:14px 6px;line-height:1.6}',
      '.wal textarea{width:100%;min-height:56px;padding:8px 10px;border-radius:9px;',
      'border:1px solid rgba(255,255,255,.1);background:rgba(0,0,0,.25);color:#f5f5f5;',
      'font-family:inherit;font-size:12.5px;line-height:1.5;resize:vertical;outline:none}',
      '.wal-foot{display:flex;align-items:center;gap:8px;margin-top:8px}',
      '.wal-file{flex:1;font-size:10.5px;color:rgba(255,255,255,.45)}',
      '.wal-file input{display:none}',
      '.wal-clip{cursor:pointer;padding:5px 9px;border-radius:8px;border:1px solid rgba(255,255,255,.12);',
      'font-size:11px;color:rgba(255,255,255,.6);display:inline-block}',
      '.wal-clip:hover{color:#f5f5f5}',
      '.wal-btn{border:0;border-radius:9px;padding:8px 14px;font-family:inherit;font-size:11.5px;',
      'font-weight:800;cursor:pointer;background:#00a884;color:#062}',
      '.wal-btn:disabled{opacity:.45;cursor:default}',
      '.wal-btn.ghost{background:transparent;color:rgba(255,255,255,.55);',
      'box-shadow:inset 0 0 0 1px rgba(255,255,255,.12)}',
      '.wal-bloc{padding:9px 11px;background:rgba(251,191,36,.07);border:1px dashed rgba(251,191,36,.4);',
      'border-radius:10px;color:#fbbf24;font-size:11.5px;line-height:1.55}',
      '.wal-err{font-size:11px;color:#f87171;margin-top:6px;line-height:1.5}',
      '.wal-tpl{display:flex;flex-direction:column;gap:6px;margin-top:8px}',
      '.wal-tpl button{text-align:left;background:rgba(0,0,0,.25);border:0;border-radius:9px;',
      'padding:8px 11px;cursor:pointer;color:#f5f5f5;font-family:inherit}',
      '.wal-tpl button:hover{background:rgba(255,255,255,.06)}',
      '.wal-tpl-n{font-size:11px;font-weight:800;color:#4fd1b0;margin-bottom:2px}',
      '.wal-tpl-c{font-size:11.5px;color:rgba(255,255,255,.5);line-height:1.45}',
      '.wal-var{display:flex;align-items:center;gap:8px;margin-top:6px}',
      '.wal-var label{font-size:10.5px;color:rgba(255,255,255,.45);width:38px;flex-shrink:0}',
      '.wal-var input{flex:1;background:rgba(0,0,0,.25);border:1px solid rgba(255,255,255,.1);',
      'border-radius:7px;color:#f5f5f5;font-family:inherit;font-size:12px;padding:6px 9px;outline:none}',
      '.wal-ap{background:rgba(0,168,132,.18);border-radius:9px;padding:8px 11px;margin-top:8px;',
      'font-size:12.5px;line-height:1.45;white-space:pre-wrap}',
      /* Sur grand écran, la fiche est une colonne qui se prolonge : une
         deuxième barre de défilement à l'intérieur d'une page déjà longue est
         exactement ce qu'on cherche à éviter. Le fil s'étale, la page défile.
         Sur mobile la fiche redevient une modale à hauteur fixe, et le
         plafond reprend tout son sens. */
      '@media (min-width:980px){.wal-fil{max-height:none;overflow-y:visible}}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ── Outils ──────────────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /* Même normalisation que le serveur : chiffres nus, indicatif compris. */
  function numeroDe(tel) {
    if (!tel) return null;
    var n = String(tel).replace(/[\s\-().]/g, '');
    var e = null;
    if (n.charAt(0) === '+') e = n;
    else if (n.indexOf('00') === 0) e = '+' + n.slice(2);
    else if (n.charAt(0) === '0' && n.length === 10) e = '+33' + n.slice(1);
    else if (n.indexOf('33') === 0 && n.length >= 11) e = '+' + n;
    else return null;
    var c = e.replace(/[^0-9]/g, '');
    return c.length >= 10 ? c : null;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function heure(ts) { var d = new Date(ts); return pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }

  function coches(st) {
    if (st === 'read') return '✓✓';
    if (st === 'delivered') return '✓✓';
    if (st === 'sent') return '✓';
    if (st === 'failed' || st === 'echec') return '⚠';
    return '🕐';
  }

  /* Ce que Meta reproche, en français. Le webhook recopie `erreurMeta` sur le
     message du fil : sans cette table, la bulle ne portait qu'un ⚠ muet.
     Même liste que whatsapp.html — volontairement, les deux écrans lisent la
     même donnée et doivent en dire la même chose. */
  var MOTIFS_META = {
    131042: 'Paiement WhatsApp non configuré',
    131047: 'Fenêtre de 24 h fermée',
    131049: 'Bloqué par Meta (écosystème)',
    130472: 'Bloqué par Meta (expérience marketing)',
    131026: 'Destinataire injoignable sur WhatsApp',
    131051: 'Type de message non pris en charge',
    132000: 'Modèle : variables incorrectes',
    132001: 'Modèle introuvable dans cette langue',
    132015: 'Modèle suspendu par Meta'
  };

  function motifMeta(e) {
    if (!e) return '';
    var code = e.code != null ? Number(e.code) : null;
    var lib = (code != null && MOTIFS_META[code])
      ? MOTIFS_META[code]
      : (e.titre || e.detail || 'Échec de distribution');
    return lib + (code != null ? ' (' + code + ')' : '');
  }

  var MOTIFS_MEDIA = {
    media_trop_lourd: 'fichier de plus de 8 Mo',
    media_introuvable: 'fichier expiré chez Meta',
    media_id_absent: 'identifiant absent'
  };

  /* La pièce jointe d'un message reçu. */
  function blocMedia(m) {
    var nom = m.nomFichier || m.libelleMedia || 'Pièce jointe';
    if (!m.mediaUrl) {
      return '<div class="wal-media-ko">' + esc(m.libelleMedia || 'Pièce jointe')
           + ' — ' + esc(MOTIFS_MEDIA[m.mediaErreur] || 'téléchargement impossible') + '</div>';
    }
    var url = esc(m.mediaUrl);
    if (m.media === 'image' || m.media === 'sticker') {
      return '<div class="wal-media"><a href="' + url + '" target="_blank" rel="noopener">'
           + '<img src="' + url + '" alt="' + esc(nom) + '" loading="lazy"></a></div>';
    }
    if (m.media === 'video') {
      return '<div class="wal-media"><video src="' + url + '" controls preload="metadata"></video></div>';
    }
    if (m.media === 'audio') {
      return '<div class="wal-media"><audio src="' + url + '" controls preload="metadata"></audio></div>';
    }
    return '<div class="wal-media"><a class="wal-fichier" href="' + url + '" target="_blank" rel="noopener">'
         + '📎 <span>' + esc(nom) + '</span></a></div>';
  }

  function fenetreOuverte(conv) {
    return !!(conv && conv.fenetreExpireA && conv.fenetreExpireA > Date.now());
  }

  function resteFenetre(conv) {
    if (!fenetreOuverte(conv)) return '';
    var r = conv.fenetreExpireA - Date.now();
    var h = Math.floor(r / 3600000), m = Math.floor((r % 3600000) / 60000);
    return h > 0 ? h + ' h ' + pad2(m) : m + ' min';
  }

  async function jeton() {
    var a = window._auth || (window.firebase && firebase.auth());
    if (!a || !a.currentUser) throw new Error('non connecté');
    return a.currentUser.getIdToken();
  }

  async function poster(corps) {
    var t = await jeton();
    var r = await fetch('/api/whatsapp-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
      body: JSON.stringify(corps)
    });
    var d = null;
    try { d = await r.json(); } catch (e) { d = null; }
    return d || { ok: false, erreur: 'reponse_illisible' };
  }

  /* ── Rendu ───────────────────────────────────────────────────────────── */

  function rendre(id) {
    var E = ETATS[id];
    if (!E || !E.mount) return;
    var ouverte = fenetreOuverte(E.conv);

    var h = '<div class="wal"><div class="wal-h">'
          + '<div class="wal-t">🟢 WhatsApp</div>'
          + '<div class="wal-f ' + (ouverte ? 'on' : 'off') + '">'
          +   (ouverte ? 'Réponse libre · ' + resteFenetre(E.conv) : 'Fenêtre fermée')
          + '</div></div>';

    /* Le fil : sans lui on écrirait à l'aveugle. */
    h += '<div class="wal-fil" data-wal-fil="' + id + '">';
    if (!E.msgs || !E.msgs.length) {
      h += '<div class="wal-vide">Aucun échange WhatsApp.<br>'
         + (ouverte ? 'Tu peux écrire librement.' : 'Ce lead n\'a jamais écrit : seul un modèle approuvé peut ouvrir la conversation.')
         + '</div>';
    } else {
      E.msgs.forEach(function (m) {
        var out = m.sens === 'out';
        var ko = m.statut === 'failed' || m.statut === 'echec';
        var corps = m.texte || '';
        if (out && m.modele) corps = '[' + m.modele + '] ' + ((m.params || []).join(' · '));

        /* Une pièce jointe remplace le corps : `texte` porte alors l'étiquette
           du média (« 📷 Photo »), qui ferait doublon sous l'image. */
        /* Uniquement ce qui a été archivé, ou reçu : un média sortant n'a pas
           d'URL et afficherait un faux échec. Son `texte` dit déjà l'essentiel. */
        var media = '';
        if (m.media && (m.mediaUrl || m.sens === 'in')) {
          media = blocMedia(m);
          corps = m.legende || '';
        }

        var motif = (ko && m.erreurMeta)
          ? '<span class="wal-motif">⚠ ' + esc(motifMeta(m.erreurMeta)) + '</span>'
          : '';

        h += '<div class="wal-b ' + (out ? 'out' : 'in') + '">' + media + esc(corps) + motif
           +   '<div class="wal-m' + (ko ? ' ko' : '') + '">' + heure(m.at)
           +     (out ? ' ' + coches(m.statut) : '') + '</div>'
           + '</div>';
      });
    }
    h += '</div>';

    h += rendreComposeur(id, E, ouverte);
    h += '<div class="wal-err" data-wal-err="' + id + '" style="display:none"></div></div>';

    E.mount.innerHTML = h;
    var fil = E.mount.querySelector('[data-wal-fil="' + id + '"]');
    if (fil) fil.scrollTop = fil.scrollHeight;
  }

  function rendreComposeur(id, E, ouverte) {
    /* Un modèle est en cours de remplissage. */
    if (E.modeleActif && E.modeleActif !== true) {
      var m = E.modeleActif, vals = E.vals || [], ap = m.corps, pret = true;
      for (var i = 0; i < m.variables; i++) {
        var v = (vals[i] || '').trim();
        if (!v) pret = false;
        ap = ap.split('{{' + (i + 1) + '}}').join(v || '{{' + (i + 1) + '}}');
      }
      var f = '<div class="wal-tpl-n">' + esc(m.nom) + '</div>';
      for (var k = 0; k < m.variables; k++) {
        f += '<div class="wal-var"><label>{{' + (k + 1) + '}}</label>'
           + '<input type="text" data-wal-var="' + k + '" data-id="' + id + '" value="' + esc(vals[k] || '') + '"></div>';
      }
      f += '<div class="wal-ap" data-wal-ap="' + id + '">' + esc(ap) + '</div>'
         + '<div class="wal-foot"><div class="wal-file"></div>'
         +   '<button class="wal-btn ghost" data-wal="tpl-retour" data-id="' + id + '">← Modèles</button>'
         +   '<button class="wal-btn" data-wal="tpl-envoyer" data-id="' + id + '"' + (pret ? '' : ' disabled') + '>Envoyer</button>'
         + '</div>';
      return f;
    }

    /* La liste des modèles. */
    if (E.modeleActif === true) {
      var l = (E.modeles || []).filter(function (x) { return !x.boutons; });
      var t = '<div class="wal-tpl">';
      if (E.modeles === null) t += '<div class="wal-vide">Chargement des modèles…</div>';
      else if (!l.length) {
        t += '<div class="wal-bloc">Aucun modèle approuvé pour l\'instant. '
           + 'Tes modèles sont en examen chez Meta — dès qu\'ils passent, ils apparaissent ici.</div>';
      } else {
        l.forEach(function (x) {
          t += '<button data-wal="tpl-choisir" data-id="' + id + '" data-nom="' + esc(x.nom) + '">'
             +   '<div class="wal-tpl-n">' + esc(x.nom) + '</div>'
             +   '<div class="wal-tpl-c">' + esc(x.corps) + '</div>'
             + '</button>';
        });
      }
      t += '</div><div class="wal-foot"><div class="wal-file"></div>'
         + '<button class="wal-btn ghost" data-wal="tpl-annuler" data-id="' + id + '">Annuler</button></div>';
      return t;
    }

    /* Fenêtre fermée : pas de champ libre, un chemin qui marche à la place. */
    if (!ouverte) {
      return '<div class="wal-bloc">Ce contact n\'a pas écrit depuis plus de 24 h. '
           + 'WhatsApp n\'autorise plus qu\'un <strong>modèle approuvé</strong> — sa réponse rouvrira la fenêtre.</div>'
           + '<div class="wal-foot"><div class="wal-file"></div>'
           + '<button class="wal-btn" data-wal="modeles" data-id="' + id + '">Choisir un modèle</button></div>';
    }

    /* Fenêtre ouverte : saisie libre et pièce jointe. */
    return '<textarea data-wal-txt="' + id + '" placeholder="Message WhatsApp…"></textarea>'
         + '<div class="wal-foot">'
         +   '<label class="wal-clip">📎 Fichier'
         +     '<input type="file" data-wal-file="' + id + '" accept="image/jpeg,image/png,image/webp,application/pdf">'
         +   '</label>'
         +   '<div class="wal-file" data-wal-nom="' + id + '"></div>'
         +   '<button class="wal-btn" data-wal="envoyer" data-id="' + id + '">Envoyer</button>'
         + '</div>';
  }

  function erreur(id, msg) {
    var E = ETATS[id];
    if (!E || !E.mount) return;
    var el = E.mount.querySelector('[data-wal-err="' + id + '"]');
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
  }

  /* ── Actions ─────────────────────────────────────────────────────────── */

  function lireFichier(f) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () {
        var s = String(r.result || '');
        var i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      r.onerror = function () { reject(new Error('lecture impossible')); };
      r.readAsDataURL(f);
    });
  }

  async function envoyer(id) {
    var E = ETATS[id];
    if (!E || E.envoi) return;
    var ta = E.mount.querySelector('[data-wal-txt="' + id + '"]');
    var fi = E.mount.querySelector('[data-wal-file="' + id + '"]');
    var txt = ta ? ta.value.trim() : '';
    var f = (fi && fi.files && fi.files[0]) ? fi.files[0] : null;
    if (!txt && !f) return;

    E.envoi = true;
    var btn = E.mount.querySelector('[data-wal="envoyer"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }
    erreur(id, '');
    var el = E.mount.querySelector('[data-wal-err="' + id + '"]');
    if (el) el.style.display = 'none';

    var corps = { numero: E.numero, texte: txt };
    try {
      if (f) {
        if (f.size > 3500000) throw new Error('Fichier trop lourd — 3,5 Mo maximum.');
        corps.mediaBase64 = await lireFichier(f);
        corps.mime = f.type;
        corps.nom = f.name;
      }
    } catch (e) {
      E.envoi = false;
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer'; }
      erreur(id, (e && e.message) || 'Fichier illisible');
      return;
    }

    var d = await poster(corps);
    E.envoi = false;

    if (d.ok) {
      /* Le message arrivera par l'écouteur temps réel, comme les autres. */
      if (ta) ta.value = '';
      if (fi) fi.value = '';
      var nom = E.mount.querySelector('[data-wal-nom="' + id + '"]');
      if (nom) nom.textContent = '';
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer'; }
    } else {
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer'; }
      erreur(id, d.erreur === 'fenetre_fermee'
        ? 'La fenêtre de 24 h vient de se fermer. Passe par un modèle approuvé.'
        : ('Envoi refusé : ' + (d.detail || d.erreur || 'erreur inconnue')));
      if (d.erreur === 'fenetre_fermee') rendre(id);
    }
  }

  async function envoyerModele(id) {
    var E = ETATS[id];
    if (!E || E.envoi) return;
    var m = E.modeleActif;
    if (!m || m === true) return;

    E.envoi = true;
    var btn = E.mount.querySelector('[data-wal="tpl-envoyer"]');
    if (btn) { btn.disabled = true; btn.textContent = 'Envoi…'; }

    var d = await poster({
      numero: E.numero, template: m.nom, langue: m.langue,
      params: (E.vals || []).slice(0, m.variables)
    });
    E.envoi = false;

    if (d.ok) { E.modeleActif = null; E.vals = []; rendre(id); }
    else {
      if (btn) { btn.disabled = false; btn.textContent = 'Envoyer'; }
      erreur(id, 'Envoi refusé : ' + (d.detail || d.erreur || 'erreur inconnue'));
    }
  }

  async function chargerModeles(id) {
    var E = ETATS[id];
    if (!E || E.modeles !== null) return;
    try {
      var t = await jeton();
      var r = await fetch('/api/whatsapp-templates', { headers: { Authorization: 'Bearer ' + t } });
      var d = await r.json();
      E.modeles = (d && d.ok && d.modeles) ? d.modeles : [];
    } catch (e) { E.modeles = []; }
  }

  /* ── Délégation d'évènements, posée une seule fois ───────────────────── */

  function brancher() {
    if (window.__walBranche) return;
    window.__walBranche = true;

    document.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-wal]') : null;
      if (!b) return;
      var id = b.getAttribute('data-id');
      var E = ETATS[id];
      if (!E) return;
      var quoi = b.getAttribute('data-wal');

      if (quoi === 'envoyer') { envoyer(id); return; }
      if (quoi === 'tpl-envoyer') { envoyerModele(id); return; }
      if (quoi === 'modeles') {
        E.modeleActif = true; E.vals = []; rendre(id);
        chargerModeles(id).then(function () { if (E.modeleActif === true) rendre(id); });
        return;
      }
      if (quoi === 'tpl-annuler') { E.modeleActif = null; E.vals = []; rendre(id); return; }
      if (quoi === 'tpl-retour') { E.modeleActif = true; E.vals = []; rendre(id); return; }
      if (quoi === 'tpl-choisir') {
        var nom = b.getAttribute('data-nom');
        (E.modeles || []).forEach(function (x) { if (x.nom === nom) E.modeleActif = x; });
        E.vals = []; rendre(id);
      }
    });

    /* Saisie des variables : on met à jour l'aperçu SANS repeindre, sinon le
       curseur saute au bout d'un caractère. */
    document.addEventListener('input', function (ev) {
      var el = ev.target;
      if (!el || !el.getAttribute) return;

      var i = el.getAttribute('data-wal-var');
      if (i !== null) {
        var id = el.getAttribute('data-id'), E = ETATS[id];
        if (!E || !E.modeleActif || E.modeleActif === true) return;
        E.vals = E.vals || [];
        E.vals[Number(i)] = el.value;
        var m = E.modeleActif, ap = m.corps, pret = true;
        for (var k = 0; k < m.variables; k++) {
          var v = (E.vals[k] || '').trim();
          if (!v) pret = false;
          ap = ap.split('{{' + (k + 1) + '}}').join(v || '{{' + (k + 1) + '}}');
        }
        var apEl = E.mount.querySelector('[data-wal-ap="' + id + '"]');
        if (apEl) apEl.textContent = ap;
        var btn = E.mount.querySelector('[data-wal="tpl-envoyer"]');
        if (btn) btn.disabled = !pret;
        return;
      }

      var fid = el.getAttribute('data-wal-file');
      if (fid) {
        var Ef = ETATS[fid];
        if (!Ef) return;
        var nomEl = Ef.mount.querySelector('[data-wal-nom="' + fid + '"]');
        var f = el.files && el.files[0];
        if (nomEl) nomEl.textContent = f ? (f.name + ' · ' + Math.round(f.size / 1024) + ' ko') : '';
      }
    });
  }

  /* ── API publique ────────────────────────────────────────────────────── */

  function attach(mount, leadId, telephone) {
    if (!mount || !leadId) return;
    ensureCss();
    brancher();
    detach(leadId);

    var numero = numeroDe(telephone);
    if (!numero) {
      mount.innerHTML = '<div class="wal"><div class="wal-h"><div class="wal-t">🟢 WhatsApp</div></div>'
        + '<div class="wal-bloc">Aucun téléphone exploitable sur cette fiche.</div></div>';
      return;
    }

    var E = { numero: numero, mount: mount, conv: null, msgs: [], modeles: null,
              modeleActif: null, vals: [], envoi: false };
    ETATS[leadId] = E;
    rendre(leadId);

    if (!window.firebase || !firebase.firestore) return;
    var db = firebase.firestore();

    E.offConv = db.collection('whatsapp_conversations').doc(numero)
      .onSnapshot(function (s) {
        E.conv = s.exists ? (s.data() || {}) : null;
        rendre(leadId);
      }, function (e) {
        if (window.console) console.warn('[wal] conversation', e && e.message);
      });

    E.offFil = db.collection('whatsapp_conversations').doc(numero)
      .collection('messages').orderBy('at').limitToLast(80)
      .onSnapshot(function (s) {
        var l = [];
        s.forEach(function (d) { l.push(d.data() || {}); });
        E.msgs = l;
        rendre(leadId);
      }, function (e) {
        if (window.console) console.warn('[wal] fil', e && e.message);
      });
  }

  function detach(leadId) {
    var E = ETATS[leadId];
    if (!E) return;
    if (E.offConv) { try { E.offConv(); } catch (e) {} }
    if (E.offFil) { try { E.offFil(); } catch (e) {} }
    delete ETATS[leadId];
  }

  window.WhatsAppLead = { attach: attach, detach: detach };
})();
