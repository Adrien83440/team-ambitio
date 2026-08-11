/* ═══════════════════════════════════════════════════════════════════════════
   temoignages-wall.js — RENDU DU MUR + LIGHTBOX (partagé)
   ─────────────────────────────────────────────────────────────────────────
   Utilisé par :
     • temoignages.html         → mur + gestion (admin), opts.admin = true
     • temoignages-public.html  → mur seul, lecture publique

   N'écrit RIEN dans Firestore : la page appelante fournit le tableau
   d'items déjà chargé et gère les actions. Ce fichier ne fait que peindre
   et ouvrir la visionneuse.

   ES5 strict (pas d'arrow, pas de template literal, var uniquement) —
   convention repo.

   ── Forme d'un item ───────────────────────────────────────────────────
     id          string
     kind        'image' | 'video' | 'embed' | 'text' | 'file'
     category    'interview' | 'video' | 'trustpilot' | 'message' | 'autre'
     mediaUrl    URL du fichier (Storage) — image ou vidéo
     embedUrl    URL d'iframe (Drive / YouTube / Loom) pour kind 'embed'
     posterUrl   vignette (vidéos + embeds)
     text        témoignage écrit (kind 'text')
     clientName  nom affiché
     caption     légende courte
     width       px (source)
     height      px (source)
     duration    secondes (vidéos)
     isPublic    bool  — visible sur le mur public
     featured    bool  — épinglé en tête
     archived    bool  — retiré du mur, jamais supprimé
     source      'upload' | 'drive' | 'link' | 'text'
   ═══════════════════════════════════════════════════════════════════════ */

(function () {
  'use strict';

  var CATEGORIES = [
    { key: 'interview',  label: 'Interviews',       icon: '🎙' },
    { key: 'video',      label: 'Vidéos',           icon: '🎬' },
    { key: 'trustpilot', label: 'Avis Trustpilot',  icon: '⭐' },
    { key: 'message',    label: 'Messages clients', icon: '💬' },
    { key: 'autre',      label: 'Autres',           icon: '✨' }
  ];

  /* ─── Utilitaires ─────────────────────────────────────────────────── */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function catLabel(key) {
    for (var i = 0; i < CATEGORIES.length; i++) {
      if (CATEGORIES[i].key === key) return CATEGORIES[i].label;
    }
    return 'Autres';
  }

  function initials(name) {
    var n = String(name || '').trim();
    if (!n) return '★';
    var parts = n.split(/\s+/);
    var s = parts[0].charAt(0);
    if (parts.length > 1) s += parts[parts.length - 1].charAt(0);
    return s.toUpperCase();
  }

  function fmtBytes(n) {
    var b = Number(n) || 0;
    if (b < 1024) return b + ' o';
    if (b < 1048576) return (b / 1024).toFixed(0) + ' Ko';
    if (b < 1073741824) return (b / 1048576).toFixed(1) + ' Mo';
    return (b / 1073741824).toFixed(2) + ' Go';
  }

  function fmtDur(sec) {
    var s = Math.round(Number(sec) || 0);
    if (!s) return '';
    var m = Math.floor(s / 60);
    var r = s % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }

  // Ratio hauteur/largeur en %, borné pour éviter les colonnes absurdes
  // (une capture WhatsApp très longue ne doit pas occuper 4 écrans).
  function ratioPct(item) {
    var w = Number(item.width) || 0;
    var h = Number(item.height) || 0;
    if (!w || !h) return 0;
    var pct = (h / w) * 100;
    if (pct < 30) pct = 30;
    if (pct > 260) pct = 260;
    return pct;
  }

  /* ─── Tri : épinglés d'abord, puis du plus récent au plus ancien ──── */
  function sortItems(items) {
    return items.slice().sort(function (a, b) {
      var fa = a.featured ? 1 : 0;
      var fb = b.featured ? 1 : 0;
      if (fa !== fb) return fb - fa;
      return (Number(b.order) || 0) - (Number(a.order) || 0);
    });
  }

  /* ─── Média d'une carte ───────────────────────────────────────────── */
  function mediaHtml(item, idx) {
    var pct = ratioPct(item);
    var alt = esc(item.clientName || item.caption || 'Témoignage client');
    var open = ' data-lb="' + idx + '"';

    if (item.kind === 'text') {
      return '<div class="tw-quote"' + open + '><p>' + esc(item.text || '') + '</p></div>';
    }

    // Format non affichable dans le navigateur (PDF, HEIC iPhone, .mov HEVC,
    // archive…). Le fichier est bien stocké : la carte devient une fiche
    // cliquable qui l'ouvre dans un onglet plutôt que de casser le mur.
    if (item.kind === 'file') {
      return '<div class="tw-quote"' + open + ' style="cursor:pointer">'
        + '<p><b>' + esc(item.fileName || 'Fichier') + '</b>'
        + (item.bytes ? '<br><span style="color:#8f97b2;font-size:12px">' + esc(fmtBytes(item.bytes)) + '</span>' : '')
        + '<br><span style="color:#8f97b2;font-size:12px">Cliquer pour ouvrir</span></p></div>';
    }

    if (item.kind === 'image') {
      if (!item.mediaUrl) return '';
      var inner = '<img loading="lazy" decoding="async" src="' + esc(item.mediaUrl) + '" alt="' + alt + '">';
      if (pct) {
        return '<div class="tw-media"' + open + '><div class="tw-ratio" style="padding-top:' + pct.toFixed(2) + '%">' + inner + '</div></div>';
      }
      return '<div class="tw-media"' + open + '>' + inner + '</div>';
    }

    // Vidéo (Storage) ou embed (Drive / YouTube / Loom) : on affiche une
    // vignette figée. La lecture se fait dans la lightbox — le mur ne
    // charge jamais plusieurs flux vidéo en même temps.
    var poster = item.posterUrl || '';
    var visual;
    if (poster) {
      visual = '<img loading="lazy" decoding="async" src="' + esc(poster) + '" alt="' + alt + '">';
    } else if (item.kind === 'video' && item.mediaUrl) {
      // Pas de vignette : on laisse le navigateur peindre la 1re frame.
      visual = '<video preload="metadata" muted playsinline src="' + esc(item.mediaUrl) + '#t=0.4"></video>';
    } else {
      visual = '<img loading="lazy" decoding="async" src="data:image/svg+xml;utf8,'
        + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="9"><rect width="16" height="9" fill="%23090b14"/></svg>')
        + '" alt="' + alt + '">';
    }

    var dur = fmtDur(item.duration);
    var box = pct
      ? '<div class="tw-ratio" style="padding-top:' + pct.toFixed(2) + '%">' + visual + '</div>'
      : visual;

    return '<div class="tw-media is-video"' + open + '>'
      + box
      + '<div class="tw-play"></div>'
      + (dur ? '<div class="tw-dur">' + esc(dur) + '</div>' : '')
      + '</div>';
  }

  /* ─── Carte complète ──────────────────────────────────────────────── */
  function cardHtml(item, idx, admin) {
    var cls = 'tw-card';
    if (item.archived) cls += ' is-archived';
    if (item.featured) cls += ' is-featured';

    var badges = '';
    if (admin) {
      badges += '<div class="tw-badges">';
      if (item.featured) badges += '<span class="tw-badge feat">★ Épinglé</span>';
      if (item.isPublic)   badges += '<span class="tw-badge pub">Public</span>';
      if (item.archived) badges += '<span class="tw-badge arch">Archivé</span>';
      if (item.source === 'drive') badges += '<span class="tw-badge drv">Drive</span>';
      badges += '</div>';
    }

    var acts = '';
    if (admin) {
      acts = '<div class="tw-acts">'
        + '<button class="tw-act" type="button" data-act="edit" data-id="' + esc(item.id) + '" title="Modifier">✎</button>'
        + '<button class="tw-act' + (item.featured ? ' on' : '') + '" type="button" data-act="feature" data-id="' + esc(item.id) + '" title="Épingler en tête">★</button>'
        + '<button class="tw-act' + (item.isPublic ? ' on-pub' : '') + '" type="button" data-act="public" data-id="' + esc(item.id) + '" title="' + (item.isPublic ? 'Retirer du mur public' : 'Publier sur le mur public') + '">' + (item.isPublic ? '🌐' : '🔒') + '</button>'
        + (item.archived
            ? '<button class="tw-act" type="button" data-act="restore" data-id="' + esc(item.id) + '" title="Restaurer">↩</button>'
            : '<button class="tw-act" type="button" data-act="archive" data-id="' + esc(item.id) + '" title="Archiver">🗄</button>')
        + '</div>';
    }

    var foot = '';
    var name = item.clientName || '';
    var cap  = item.caption || '';
    if (name || cap || item.category) {
      foot = '<div class="tw-foot">'
        + (name ? '<div class="tw-av">' + esc(initials(name)) + '</div>' : '')
        + '<div class="tw-foot-txt">'
        + (name ? '<div class="tw-name">' + esc(name) + '</div>' : '')
        + (cap  ? '<div class="tw-cap">' + esc(cap) + '</div>' : '')
        + (item.category ? '<span class="tw-tag cat-' + esc(item.category) + '">' + esc(catLabel(item.category)) + '</span>' : '')
        + '</div></div>';
    }

    return '<article class="' + cls + '" data-card="' + esc(item.id) + '">'
      + badges + acts + mediaHtml(item, idx) + foot
      + '</article>';
  }

  /* ─── Rendu du mur ────────────────────────────────────────────────── */
  // container : élément DOM
  // items     : tableau déjà filtré par la page appelante
  // opts      : { admin: bool, emptyTitle: string, emptyText: string }
  function render(container, items, opts) {
    if (!container) return [];
    opts = opts || {};
    var sorted = sortItems(items || []);

    if (!sorted.length) {
      container.style.columns = 'auto';
      container.innerHTML = '<div class="tw-empty"><span class="e">🧱</span>'
        + '<h3>' + esc(opts.emptyTitle || 'Le mur est encore vide') + '</h3>'
        + '<p>' + esc(opts.emptyText || 'Dépose tes premiers témoignages : vidéos, captures, avis, messages clients.') + '</p></div>';
      container._twItems = sorted;
      bindOnce(container);
      return sorted;
    }

    container.style.columns = '';
    var html = '';
    for (var i = 0; i < sorted.length; i++) {
      html += cardHtml(sorted[i], i, !!opts.admin);
    }
    container.innerHTML = html;
    container._twItems = sorted;
    bindOnce(container);
    return sorted;
  }

  // Délégation d'ouverture de la lightbox — posée une seule fois par
  // conteneur (les actions admin restent gérées par la page appelante).
  function bindOnce(container) {
    if (container._twBound) return;
    container._twBound = true;
    container.addEventListener('click', function (e) {
      if (e.target.closest('[data-act]')) return; // action admin : pas la lightbox
      var trigger = e.target.closest('[data-lb]');
      if (!trigger || !container.contains(trigger)) return;
      var idx = parseInt(trigger.getAttribute('data-lb'), 10);
      if (isNaN(idx)) return;
      openLightbox(container._twItems || [], idx);
    });
  }

  /* ─── Lightbox ────────────────────────────────────────────────────── */
  var lb = null, lbItems = [], lbIdx = 0;

  function buildLightbox() {
    if (lb) return lb;
    lb = document.createElement('div');
    lb.className = 'tw-lb';
    lb.innerHTML =
        '<button class="tw-lb-x" type="button" data-lbact="close" aria-label="Fermer">✕</button>'
      + '<a class="tw-lb-dl" data-lbel="dl" href="#" target="_blank" rel="noopener" download>⬇ Télécharger</a>'
      + '<button class="tw-lb-nav prev" type="button" data-lbact="prev" aria-label="Précédent">‹</button>'
      + '<button class="tw-lb-nav next" type="button" data-lbact="next" aria-label="Suivant">›</button>'
      + '<div class="tw-lb-stage" data-lbel="stage"></div>'
      + '<div class="tw-lb-count" data-lbel="count"></div>';
    document.body.appendChild(lb);

    lb.addEventListener('click', function (e) {
      var b = e.target.closest('[data-lbact]');
      if (b) {
        var a = b.getAttribute('data-lbact');
        if (a === 'close') closeLightbox();
        if (a === 'prev')  step(-1);
        if (a === 'next')  step(1);
        return;
      }
      // Clic sur le fond (hors média) → fermeture
      if (e.target === lb) closeLightbox();
    });

    document.addEventListener('keydown', function (e) {
      if (!lb || !lb.classList.contains('open')) return;
      if (e.key === 'Escape')     { closeLightbox(); }
      if (e.key === 'ArrowLeft')  { step(-1); }
      if (e.key === 'ArrowRight') { step(1); }
    });

    return lb;
  }

  function stageHtml(item) {
    var name = item.clientName || '';
    var cap  = item.caption || '';
    var meta = (name || cap)
      ? '<div class="tw-lb-meta">'
        + (name ? '<div class="n">' + esc(name) + '</div>' : '')
        + (cap  ? '<div class="c">' + esc(cap) + '</div>' : '')
        + '</div>'
      : '';

    var body;
    if (item.kind === 'text') {
      body = '<div class="tw-lb-quote">' + esc(item.text || '') + '</div>';
    } else if (item.kind === 'embed' && item.embedUrl) {
      body = '<iframe src="' + esc(item.embedUrl) + '" allow="autoplay; fullscreen; encrypted-media" allowfullscreen loading="lazy"></iframe>';
    } else if (item.kind === 'video' && item.mediaUrl) {
      body = '<video src="' + esc(item.mediaUrl) + '" controls autoplay playsinline preload="metadata"'
           + (item.posterUrl ? ' poster="' + esc(item.posterUrl) + '"' : '') + '></video>';
    } else if (item.mediaUrl) {
      body = '<img src="' + esc(item.mediaUrl) + '" alt="' + esc(name || 'Témoignage') + '">';
    } else {
      body = '<div class="tw-lb-quote">Média indisponible.</div>';
    }
    return body + meta;
  }

  function paint() {
    var item = lbItems[lbIdx];
    if (!item) return;
    var stage = lb.querySelector('[data-lbel="stage"]');
    var count = lb.querySelector('[data-lbel="count"]');
    var dl    = lb.querySelector('[data-lbel="dl"]');

    stage.innerHTML = stageHtml(item);
    count.textContent = (lbIdx + 1) + ' / ' + lbItems.length;

    var many = lbItems.length > 1;
    lb.querySelector('.tw-lb-nav.prev').style.display = many ? '' : 'none';
    lb.querySelector('.tw-lb-nav.next').style.display = many ? '' : 'none';
    count.style.display = many ? '' : 'none';

    // Téléchargement : uniquement pour les fichiers qu'on héberge
    if (item.mediaUrl && item.kind !== 'text') {
      dl.style.display = '';
      dl.setAttribute('href', item.mediaUrl);
    } else {
      dl.style.display = 'none';
    }
  }

  function step(delta) {
    if (!lbItems.length) return;
    lbIdx = (lbIdx + delta + lbItems.length) % lbItems.length;
    paint();
  }

  function openLightbox(items, idx) {
    var all = items || [];
    var target = all[idx || 0];
    // Format non affichable : on ouvre le fichier dans un onglet, la
    // visionneuse n'a rien à en faire.
    if (target && target.kind === 'file') {
      if (target.mediaUrl) window.open(target.mediaUrl, '_blank', 'noopener');
      return;
    }
    lbItems = all.filter(function (it) { return it && it.kind; });
    if (!lbItems.length) return;
    lbIdx = Math.max(0, Math.min(idx || 0, lbItems.length - 1));
    buildLightbox();
    lb.classList.add('open');
    document.documentElement.style.overflow = 'hidden';
    paint();
  }

  function closeLightbox() {
    if (!lb) return;
    lb.classList.remove('open');
    lb.querySelector('[data-lbel="stage"]').innerHTML = ''; // coupe la lecture en cours
    document.documentElement.style.overflow = '';
  }

  /* ─── Squelette de chargement ─────────────────────────────────────── */
  function skeleton(container, n) {
    if (!container) return;
    var heights = [220, 300, 180, 340, 250, 200, 290, 230, 320, 210, 270, 190];
    var html = '';
    for (var i = 0; i < (n || 10); i++) {
      html += '<div class="tw-skel" style="height:' + heights[i % heights.length] + 'px"></div>';
    }
    container.style.columns = '';
    container.innerHTML = html;
  }

  window.TemoWall = {
    CATEGORIES: CATEGORIES,
    catLabel: catLabel,
    initials: initials,
    fmtDur: fmtDur,
    fmtBytes: fmtBytes,
    esc: esc,
    sortItems: sortItems,
    render: render,
    skeleton: skeleton,
    openLightbox: openLightbox,
    closeLightbox: closeLightbox
  };
})();
