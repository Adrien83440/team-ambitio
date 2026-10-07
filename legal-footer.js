/* ============================================================================
   legal-footer.js — LIGNE LÉGALE DES PAGES PUBLIQUES DE team.alteore.com (10/2026)
   ----------------------------------------------------------------------------
   Mentions légales · CGV · Politique de confidentialité, avec les URL réglées
   une seule fois dans Site & pages → Contenu → « Liens légaux » (lues via
   GET /api/site-config, même source que les pages de www.adrienemily.com,
   voir api/_legal.js).

   Utilisé par booking.html et alteoforms-render.html, qui décident quand
   l'afficher (jamais en iframe, jamais pour un client en coaching) :

     AlteoLegalFooter.mount({ bottomPad: 90 });   // affiche
     AlteoLegalFooter.hide();                      // masque
   ============================================================================ */
(function () {
  var LABELS = [['mentions', 'Mentions légales'], ['cgv', 'CGV'], ['confidentialite', 'Politique de confidentialité']];
  var _legal = null, _promise = null, _el = null, _wanted = false, _opts = {};

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function load() {
    if (_promise) return _promise;
    _promise = fetch('/api/site-config').then(function (r) { return r.json(); }).then(function (d) {
      _legal = (d && d.config && d.config.legal) || {};
      return _legal;
    })['catch'](function () { _legal = {}; return _legal; });
    return _promise;
  }
  function render() {
    if (!_wanted || !_legal || !document.body) return;
    var h = '';
    for (var i = 0; i < LABELS.length; i++) {
      var u = _legal[LABELS[i][0]];
      if (!/^https:\/\//i.test(String(u || ''))) continue;
      h += '<a data-legal="' + LABELS[i][0] + '" href="' + esc(u) + '" target="_blank" rel="noopener" style="color:inherit;text-decoration:underline;margin:0 8px;white-space:nowrap">' + esc(LABELS[i][1]) + '</a>';
    }
    if (!h) return;
    if (!_el) {
      _el = document.createElement('div');
      _el.setAttribute('data-alteo-legal', '');
      document.body.appendChild(_el);
    }
    _el.style.cssText = 'display:block;box-sizing:border-box;width:100%;clear:both;margin:0;padding:18px 16px ' + (22 + (Number(_opts.bottomPad) || 0)) + 'px;'
      + 'text-align:center;font:12px/1.8 -apple-system,BlinkMacSystemFont,\'Segoe UI\',Roboto,sans-serif;color:#8a8f9c;background:transparent;position:relative;z-index:1';
    _el.innerHTML = h;
  }
  window.AlteoLegalFooter = {
    mount: function (opts) {
      _wanted = true; _opts = opts || {};
      if (_legal) render(); else load().then(render);
    },
    hide: function () {
      _wanted = false;
      if (_el) _el.style.display = 'none';
    }
  };
})();
