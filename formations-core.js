/* ═══════════════════════════════════════════════════════════════════════════
   formations-core.js — LOGIQUE PURE du module « Formations internes »
   ─────────────────────────────────────────────────────────────────────────
   Setting LAB / Closing LAB / Coach LAB, rapatriés depuis AE Academy.
   Aucune dépendance Firebase : ce fichier ne fait que transformer des
   objets. Il est chargé par formations.html et formations-admin.html
   (window.FormationsCore) et testable en Node (module.exports).

   MODÈLE — identique à celui d'AE Academy (courses/{id}), pour que la
   migration soit un simple copier :
     formations/{id} = { name, type, team:true, status, order, modules:[…] }
     module  = { id, title, status:'draft'|'published', children:[…] }
     child   = sub    { kind:'sub',    id, title, lessons:[lesson|binder] }
             | lesson { kind:'lesson', id, title, status, video, image,
                        audio, body, duration, thumbnail, resources:[{title,url}] }
             | binder { kind:'binder', id, title, status, intro,
                        sections:[{ id, title, files:[{id,title,url,note}] }] }
   Un sous-module n'a pas de statut : il disparaît quand toutes ses leçons
   sont en brouillon. Jamais de sous-module dans un sous-module.

   ES5 strict (var, pas d'arrow, pas de template literal) — convention repo.
   ═══════════════════════════════════════════════════════════════════════ */
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.FormationsCore = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* Les trois espaces d'équipe connus. L'id est fixe : c'est lui que porte
     users/{uid}.formationsAccess et que cible le script de migration. */
  var KNOWN = [
    { id: 'setting-lab', name: 'Setting LAB', icon: '📞', color: '#a78bfa', hint: 'Pôle Setteur' },
    { id: 'closing-lab', name: 'Closing LAB', icon: '🎯', color: '#fbbf24', hint: 'Pôle Closeur' },
    { id: 'coach-lab',   name: 'Coach LAB',   icon: '🎓', color: '#2dd4bf', hint: 'Pôle Coach' }
  ];

  /* Préréglages d'accès par métier (boutons dans admin-users.html). */
  var PRESETS = {
    sales: ['setting-lab', 'closing-lab'],
    coach: ['coach-lab']
  };

  var _c = 0;
  function uid() {
    _c += 1;
    return 'n' + Date.now().toString(36) + _c.toString(36) + Math.random().toString(36).slice(2, 6);
  }

  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function assign(target) {
    for (var i = 1; i < arguments.length; i++) {
      var src = arguments[i];
      if (!src) continue;
      for (var k in src) if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

  /* « Closing LAB » → « closing-lab ». Sert aux formations créées à la main. */
  function slugify(name) {
    return String(name || '')
      .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'formation';
  }

  function knownById(id) {
    for (var i = 0; i < KNOWN.length; i++) if (KNOWN[i].id === id) return KNOWN[i];
    return null;
  }

  /* ─── Normalisation ─────────────────────────────────────────────────── */
  function normalizeResource(r) {
    return { title: (r && r.title) || '', url: (r && r.url) || '' };
  }

  function normalizeLesson(l) {
    var x = assign({}, l);
    x.kind = 'lesson';
    x.id = x.id || uid();
    x.title = x.title || '';
    x.status = x.status || 'draft';
    x.video = x.video || '';
    x.image = x.image || '';
    x.audio = x.audio || '';
    x.body = x.body || '';
    x.duration = x.duration || '';
    x.thumbnail = x.thumbnail || '';
    x.resources = (x.resources || []).map(normalizeResource);
    return x;
  }

  function normalizeBinder(b) {
    var x = assign({}, b);
    x.kind = 'binder';
    x.id = x.id || uid();
    x.title = x.title || '';
    x.status = x.status || 'draft';
    x.intro = x.intro || '';
    x.sections = (x.sections || []).map(function (s) {
      return {
        id: s.id || uid(),
        title: s.title || '',
        files: (s.files || []).map(function (f) {
          return { id: f.id || uid(), title: f.title || '', url: f.url || '', note: f.note || '' };
        })
      };
    });
    return x;
  }

  function normalizeChild(c) {
    if (!c) return null;
    if (c.kind === 'sub') {
      var s = assign({}, c);
      s.kind = 'sub';
      s.id = s.id || uid();
      s.title = s.title || '';
      s.lessons = (s.lessons || []).map(function (l) {
        return l && l.kind === 'binder' ? normalizeBinder(l) : normalizeLesson(l || {});
      });
      return s;
    }
    if (c.kind === 'binder') return normalizeBinder(c);
    return normalizeLesson(c);
  }

  function normalizeModules(modules) {
    return (modules || []).map(function (m) {
      var x = assign({}, m);
      x.id = x.id || uid();
      x.title = x.title || '';
      x.status = x.status || 'draft';
      x.children = (x.children || []).map(normalizeChild).filter(Boolean);
      return x;
    });
  }

  function emptyLesson(title) {
    return normalizeLesson({ title: title || 'Nouvelle leçon' });
  }
  function emptyBinder(title) {
    return normalizeBinder({ title: title || 'Nouveau classeur', sections: [{ title: 'Fichiers', files: [] }] });
  }
  function emptySub(title) {
    return normalizeChild({ kind: 'sub', title: title || 'Nouveau sous-module', lessons: [] });
  }
  function emptyModule(title) {
    return normalizeModules([{ title: title || 'Nouveau module', status: 'draft', children: [] }])[0];
  }

  /* ─── Parcours de l'arbre ───────────────────────────────────────────── */
  // Leçons uniquement (pas les classeurs) : ce sont elles qui comptent pour
  // la progression et la navigation précédente / suivante.
  function flattenLessons(formation, publishedOnly) {
    var out = [];
    ((formation && formation.modules) || []).forEach(function (m) {
      if (publishedOnly && m.status === 'draft') return;
      (m.children || []).forEach(function (c) {
        if (c.kind === 'binder') return;
        if (c.kind === 'sub') {
          (c.lessons || []).forEach(function (l) {
            if (l.kind === 'binder') return;
            if (publishedOnly && l.status === 'draft') return;
            out.push(assign({}, l, { moduleId: m.id, moduleTitle: m.title, subId: c.id, subTitle: c.title }));
          });
        } else {
          if (publishedOnly && c.status === 'draft') return;
          out.push(assign({}, c, { moduleId: m.id, moduleTitle: m.title, subId: null, subTitle: null }));
        }
      });
    });
    return out;
  }

  function findLesson(formation, lessonId, publishedOnly) {
    var flat = flattenLessons(formation, publishedOnly);
    var idx = -1;
    for (var i = 0; i < flat.length; i++) if (flat[i].id === lessonId) { idx = i; break; }
    if (idx < 0) return { lesson: null, prev: null, next: null, index: -1, total: flat.length };
    return {
      lesson: flat[idx],
      prev: idx > 0 ? flat[idx - 1] : null,
      next: idx < flat.length - 1 ? flat[idx + 1] : null,
      index: idx,
      total: flat.length
    };
  }

  function findBinder(formation, binderId) {
    var mods = (formation && formation.modules) || [];
    for (var i = 0; i < mods.length; i++) {
      var m = mods[i];
      var kids = m.children || [];
      for (var j = 0; j < kids.length; j++) {
        var c = kids[j];
        if (c.kind === 'binder' && c.id === binderId) return { binder: c, moduleId: m.id, moduleTitle: m.title || '', subId: null, subTitle: null };
        if (c.kind === 'sub') {
          var ls = c.lessons || [];
          for (var k = 0; k < ls.length; k++) {
            if (ls[k].kind === 'binder' && ls[k].id === binderId) return { binder: ls[k], moduleId: m.id, moduleTitle: m.title || '', subId: c.id, subTitle: c.title || '' };
          }
        }
      }
    }
    return { binder: null, moduleId: null, moduleTitle: '', subId: null, subTitle: null };
  }

  // Retrouve n'importe quel nœud (module, sous-module, leçon, classeur) et
  // sa liste parente — pour l'éditeur.
  function locate(modules, nodeId) {
    var mods = modules || [];
    for (var i = 0; i < mods.length; i++) {
      if (mods[i].id === nodeId) return { node: mods[i], list: mods, index: i, kind: 'module', moduleId: mods[i].id, subId: null };
      var kids = mods[i].children || [];
      for (var j = 0; j < kids.length; j++) {
        if (kids[j].id === nodeId) return { node: kids[j], list: kids, index: j, kind: kids[j].kind, moduleId: mods[i].id, subId: null };
        if (kids[j].kind === 'sub') {
          var ls = kids[j].lessons || [];
          for (var k = 0; k < ls.length; k++) {
            if (ls[k].id === nodeId) return { node: ls[k], list: ls, index: k, kind: ls[k].kind, moduleId: mods[i].id, subId: kids[j].id };
          }
        }
      }
    }
    return null;
  }

  // Modules publiés seulement, chacun réduit à ses leçons publiées (les
  // brouillons sont invisibles pour l'équipe). Un sous-module sans leçon
  // publiée disparaît ; un module publié reste visible même vide.
  function studentModules(formation) {
    return ((formation && formation.modules) || [])
      .filter(function (m) { return m.status !== 'draft'; })
      .map(function (m) {
        var x = assign({}, m);
        x.children = (m.children || []).map(function (c) {
          if (c.kind === 'sub') {
            return assign({}, c, { lessons: (c.lessons || []).filter(function (l) { return l.status !== 'draft'; }) });
          }
          return c;
        }).filter(function (c) {
          if (c.kind === 'sub') return c.lessons.length > 0;
          return c.status !== 'draft';
        });
        return x;
      });
  }

  function progressStats(formation, doneIds) {
    var done = doneIds || [];
    var flat = flattenLessons({ modules: studentModules(formation) }, true);
    var complete = 0;
    flat.forEach(function (l) { if (done.indexOf(l.id) >= 0) complete += 1; });
    return { total: flat.length, complete: complete, pct: flat.length ? Math.round(complete / flat.length * 100) : 0 };
  }

  // La barre latérale du lecteur ne montre que le niveau courant : les
  // leçons du sous-module si la leçon en a un, sinon les enfants directs
  // du module. Classeurs inclus (ils s'ouvrent, ils ne se « terminent » pas).
  function panelScope(studentMods, lesson) {
    if (!lesson) return { title: '', items: [] };
    for (var i = 0; i < studentMods.length; i++) {
      var m = studentMods[i];
      if (m.id !== lesson.moduleId) continue;
      if (lesson.subId) {
        for (var j = 0; j < (m.children || []).length; j++) {
          var c = m.children[j];
          if (c.kind === 'sub' && c.id === lesson.subId) return { title: c.title || '', items: c.lessons || [] };
        }
      }
      return { title: m.title || '', items: (m.children || []).filter(function (c) { return c.kind !== 'sub'; }) };
    }
    return { title: '', items: [] };
  }

  function countTree(modules) {
    var n = { modules: 0, subs: 0, lessons: 0, binders: 0, published: 0 };
    (modules || []).forEach(function (m) {
      n.modules += 1;
      (m.children || []).forEach(function (c) {
        if (c.kind === 'sub') {
          n.subs += 1;
          (c.lessons || []).forEach(function (l) {
            if (l.kind === 'binder') n.binders += 1; else { n.lessons += 1; if (l.status !== 'draft') n.published += 1; }
          });
        } else if (c.kind === 'binder') n.binders += 1;
        else { n.lessons += 1; if (c.status !== 'draft') n.published += 1; }
      });
    });
    return n;
  }

  /* ─── Déplacements ──────────────────────────────────────────────────── */
  // Déplace le nœud `nodeId` à la position `index` du conteneur `containerId`
  // ('root' = liste des modules, id d'un module = ses children, id d'un
  // sous-module = ses lessons). En place. Un module ne va qu'à la racine,
  // rien d'autre n'y va, jamais de sous-module dans un sous-module. Renvoie
  // false si le déplacement est invalide — un nœud n'est JAMAIS perdu.
  function moveNodeInTree(modules, nodeId, containerId, index) {
    var destList = null, destKind = null;
    if (containerId === 'root') { destList = modules; destKind = 'root'; }
    else {
      (modules || []).forEach(function (m) {
        if (m.id === containerId) { m.children = m.children || []; destList = m.children; destKind = 'module'; }
        (m.children || []).forEach(function (ch) {
          if (ch.kind === 'sub' && ch.id === containerId) { ch.lessons = ch.lessons || []; destList = ch.lessons; destKind = 'sub'; }
        });
      });
    }
    if (!destList) return false;

    var srcList = null, srcIndex = -1, node = null;
    function scan(list) {
      if (node) return;
      for (var i = 0; i < (list || []).length; i++) {
        if (list[i] && list[i].id === nodeId) { srcList = list; srcIndex = i; node = list[i]; return; }
      }
    }
    scan(modules);
    var isModule = !!node;
    (modules || []).forEach(function (m) {
      scan(m.children);
      (m.children || []).forEach(function (ch) { if (ch.kind === 'sub') scan(ch.lessons); });
    });
    if (!node) return false;

    if (destKind === 'root' && !isModule) return false;
    if (destKind !== 'root' && isModule) return false;
    if (destKind === 'sub' && node.kind === 'sub') return false;

    srcList.splice(srcIndex, 1);
    var at = index;
    if (srcList === destList && srcIndex < index) at = index - 1;
    if (at < 0) at = 0;
    if (at > destList.length) at = destList.length;
    destList.splice(at, 0, node);
    return true;
  }

  function moveInList(list, idx, dir) {
    var j = idx + dir;
    if (j < 0 || j >= list.length) return false;
    var tmp = list[idx]; list[idx] = list[j]; list[j] = tmp;
    return true;
  }

  // Duplication d'un sous-arbre avec des ids neufs (pour « dupliquer »).
  function regenIds(node) {
    var x = clone(node);
    function walk(n) {
      n.id = uid();
      (n.children || []).forEach(walk);
      (n.lessons || []).forEach(walk);
      (n.sections || []).forEach(function (s) { s.id = uid(); (s.files || []).forEach(function (f) { f.id = uid(); }); });
    }
    walk(x);
    return x;
  }

  /* ─── Médias ────────────────────────────────────────────────────────── */
  function toEmbed(url) {
    if (!url) return null;
    var u = String(url).trim();
    var m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (m) return 'https://www.youtube.com/embed/' + m[1];
    m = u.match(/vimeo\.com\/(?:video\/)?(\d+)/);
    if (m) return 'https://player.vimeo.com/video/' + m[1];
    m = u.match(/loom\.com\/(?:share|embed)\/([0-9a-fA-F]{20,})/);
    if (m) return 'https://www.loom.com/embed/' + m[1];
    m = u.match(/tella\.tv\/video\/([A-Za-z0-9_-]+)/);
    if (m) return 'https://www.tella.tv/video/' + m[1] + '/embed';
    m = u.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
    if (m) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    m = u.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (m && /drive\.google\.com/.test(u)) return 'https://drive.google.com/file/d/' + m[1] + '/preview';
    return null;
  }

  // Fichier vidéo direct (Storage, .mp4…) → balise <video> plutôt qu'iframe.
  function isDirectVideo(url) {
    return /\.(mp4|webm|m4v|ogv)(\?|#|$)/i.test(String(url || ''));
  }

  function driveFileId(url) {
    var u = String(url || '');
    var m = u.match(/drive\.google\.com\/file\/d\/([A-Za-z0-9_-]+)/);
    if (m) return m[1];
    m = u.match(/[?&]id=([A-Za-z0-9_-]+)/);
    if (m && /drive\.google\.com/.test(u)) return m[1];
    return null;
  }

  function lessonThumbUrl(lesson) {
    if (lesson && lesson.thumbnail) return lesson.thumbnail;
    var u = String((lesson && lesson.video) || '').trim();
    if (!u) return (lesson && lesson.image) ? lesson.image : null;
    var m = u.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([A-Za-z0-9_-]{11})/);
    if (m) return 'https://img.youtube.com/vi/' + m[1] + '/mqdefault.jpg';
    m = u.match(/loom\.com\/(?:share|embed)\/([0-9a-fA-F]{20,})/);
    if (m) return 'https://cdn.loom.com/sessions/thumbnails/' + m[1] + '-00001.jpg';
    var d = driveFileId(u);
    if (d) return 'https://drive.google.com/thumbnail?id=' + d + '&sz=w400';
    return null;
  }

  function driveFileUrl(id) { return 'https://drive.google.com/file/d/' + id + '/view'; }

  // Type d'un fichier de classeur d'après l'URL / le titre (affichage).
  function fileKind(url, title) {
    var s = (String(url || '') + ' ' + String(title || '')).toLowerCase();
    if (/\.pdf(\?|#|$| )/.test(s)) return 'PDF';
    if (/\.(png|jpe?g|gif|webp|avif)(\?|#|$| )/.test(s)) return 'Image';
    if (/\.(docx?|odt)(\?|#|$| )|docs\.google\.com\/document/.test(s)) return 'DOC';
    if (/\.(xlsx?|ods|csv)(\?|#|$| )|docs\.google\.com\/spreadsheets/.test(s)) return 'XLS';
    if (/\.(pptx?|odp)(\?|#|$| )|docs\.google\.com\/presentation/.test(s)) return 'PPT';
    if (/\.zip(\?|#|$| )/.test(s)) return 'ZIP';
    if (/drive\.google\.com/.test(s)) return 'Drive';
    return 'Lien';
  }

  /* ─── Corps de leçon ────────────────────────────────────────────────── */
  function looksLikeHtml(s) { return /<[a-z!\/][\s\S]*>/i.test(s || ''); }

  // Ancien corps en texte brut (pré-éditeur riche) → HTML. Gère les liens
  // [libellé](url) et les retours à la ligne, comme AE Academy.
  function plainToHtml(s) {
    if (!s) return '';
    if (looksLikeHtml(s)) return s;
    return String(s).split(/\n{2,}/).map(function (p) {
      var h = esc(p).replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, function (_, label, url) {
        return '<a href="' + url + '" target="_blank" rel="noopener">' + label + '</a>';
      });
      return '<p>' + h.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  // Nettoyage minimal du HTML avant affichage : on retire scripts, iframes
  // et gestionnaires inline. Le contenu vient d'un admin, mais un corps
  // migré d'Academy a pu passer par un copier-coller quelconque.
  function sanitizeHtml(html) {
    return String(html || '')
      .replace(/<\s*(script|style|iframe|object|embed)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, '')
      .replace(/<\s*(script|iframe|object|embed)[^>]*\/?>/gi, '')
      .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
      .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1=$2#$2');
  }

  /* ─── Import Drive : arbre scanné → contenu ─────────────────────────── */
  // node = { id, name, folders:[node], videos:[{id,name}], docs:[{id,name}] }
  // Tout arrive en brouillon. toVideoUrl est injecté (driveFileUrl par défaut).
  function lessonFromFile(f, toVideoUrl) {
    return normalizeLesson({ title: cleanFileTitle(f.name), status: 'draft', video: (toVideoUrl || driveFileUrl)(f.id) });
  }

  // « Coaching 25.06.mp4 » → « Coaching 25.06 » : on ne retire QUE les
  // extensions média connues, jamais un « .06 » de date.
  var MEDIA_EXT = /\.(mp4|mov|m4v|webm|avi|mkv|mpg|mpeg|m4a|mp3|wav|aac|ogg|oga|opus|flac)$/i;
  function cleanFileTitle(name) { return String(name || '').replace(MEDIA_EXT, '').trim(); }

  function driveCollectVideos(node, toVideoUrl, out) {
    (node.videos || []).forEach(function (v) { out.push(lessonFromFile(v, toVideoUrl)); });
    (node.folders || []).forEach(function (f) { driveCollectVideos(f, toVideoUrl, out); });
  }

  function driveNodeToLessons(node, toVideoUrl) {
    var out = [];
    driveCollectVideos(node, toVideoUrl, out);
    return out;
  }

  function driveNodeToModule(node, toVideoUrl) {
    var children = [];
    (node.videos || []).forEach(function (v) { children.push(lessonFromFile(v, toVideoUrl)); });
    (node.folders || []).forEach(function (sub) {
      children.push(normalizeChild({ kind: 'sub', title: sub.name, lessons: driveNodeToLessons(sub, toVideoUrl) }));
    });
    return normalizeModules([{ title: node.name, status: 'draft', children: children }])[0];
  }

  // 'single'   : le dossier choisi devient UN module (sous-dossiers → sous-modules)
  // 'multiple' : chaque sous-dossier direct devient SON PROPRE module
  function driveNodeToModules(node, mode, toVideoUrl) {
    if (mode === 'multiple' && (node.folders || []).length > 0) {
      return node.folders.map(function (f) { return driveNodeToModule(f, toVideoUrl); });
    }
    return [driveNodeToModule(node, toVideoUrl)];
  }

  // Dans un module existant :
  // 'sub'   : le dossier devient UN sous-module (vidéos aplaties dedans)
  // 'multi' : chaque sous-dossier direct → un sous-module, vidéos racine → leçons
  // 'flat'  : toutes les vidéos → leçons directes du module
  function driveNodeToChildren(node, mode, toVideoUrl) {
    if (mode === 'flat') return driveNodeToLessons(node, toVideoUrl);
    if (mode === 'multi' && (node.folders || []).length > 0) {
      var children = [];
      (node.videos || []).forEach(function (v) { children.push(lessonFromFile(v, toVideoUrl)); });
      (node.folders || []).forEach(function (f) {
        children.push(normalizeChild({ kind: 'sub', title: f.name, lessons: driveNodeToLessons(f, toVideoUrl) }));
      });
      return children;
    }
    return [normalizeChild({ kind: 'sub', title: node.name, lessons: driveNodeToLessons(node, toVideoUrl) })];
  }

  function driveTreeStats(node) {
    var n = { folders: 0, videos: 0, docs: 0 };
    function walk(x) {
      n.videos += (x.videos || []).length;
      n.docs += (x.docs || []).length;
      (x.folders || []).forEach(function (f) { n.folders += 1; walk(f); });
    }
    walk(node);
    return n;
  }

  // Ids des fichiers Drive référencés par une liste de nœuds (pour le
  // partage automatique après import).
  function collectDriveIds(nodes) {
    var ids = [];
    function push(url) { var d = driveFileId(url); if (d && ids.indexOf(d) < 0) ids.push(d); }
    function walk(n) {
      if (!n) return;
      if (n.video) push(n.video);
      (n.children || []).forEach(walk);
      (n.lessons || []).forEach(walk);
    }
    (nodes || []).forEach(walk);
    return ids;
  }

  /* ─── Accès ─────────────────────────────────────────────────────────── */
  // users/{uid}.formationsAccess = { 'setting-lab': true, … }
  function accessibleIds(userData) {
    var map = (userData && userData.formationsAccess) || {};
    var out = [];
    for (var k in map) if (Object.prototype.hasOwnProperty.call(map, k) && map[k] === true) out.push(k);
    return out;
  }
  function canEdit(userData) {
    return !!userData && (userData.role === 'admin' || userData.formationsEditor === true);
  }

  function fmtDuration(d) { return d ? String(d) : ''; }

  return {
    KNOWN: KNOWN, PRESETS: PRESETS, knownById: knownById,
    uid: uid, esc: esc, assign: assign, clone: clone, slugify: slugify,
    normalizeModules: normalizeModules, normalizeChild: normalizeChild, normalizeLesson: normalizeLesson, normalizeBinder: normalizeBinder,
    emptyLesson: emptyLesson, emptyBinder: emptyBinder, emptySub: emptySub, emptyModule: emptyModule,
    flattenLessons: flattenLessons, findLesson: findLesson, findBinder: findBinder, locate: locate,
    studentModules: studentModules, progressStats: progressStats, panelScope: panelScope, countTree: countTree,
    moveNodeInTree: moveNodeInTree, moveInList: moveInList, regenIds: regenIds,
    toEmbed: toEmbed, isDirectVideo: isDirectVideo, driveFileId: driveFileId, lessonThumbUrl: lessonThumbUrl,
    driveFileUrl: driveFileUrl, fileKind: fileKind,
    plainToHtml: plainToHtml, sanitizeHtml: sanitizeHtml, looksLikeHtml: looksLikeHtml,
    cleanFileTitle: cleanFileTitle, driveNodeToModules: driveNodeToModules, driveNodeToChildren: driveNodeToChildren,
    driveNodeToLessons: driveNodeToLessons, driveTreeStats: driveTreeStats, collectDriveIds: collectDriveIds,
    accessibleIds: accessibleIds, canEdit: canEdit, fmtDuration: fmtDuration
  };
});
