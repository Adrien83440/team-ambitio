/* ============================================================================
   tunnel-runtime.js — runtime injecté dans chaque page de tunnel (09/2026)
   ----------------------------------------------------------------------------
   api/tunnel-render.js insère ce fichier en ligne dans le <head> de la page,
   juste après `window.ALTEO_TUNNEL = {…}` (config posée par le serveur). La
   page HTML écrite à la main reste pure : rien à coller dedans.

   Ce que fait le runtime, dans l'ordre :
     1. capture l'attribution publicitaire de l'URL (utm_*, fbclid, ad_id…)
        et la garde 30 jours (premier touch) ;
     2. envoie les événements de mesure (visite, vue, clic CTA) au beacon
        /api/tunnel-event — une seule fois par session et par page ;
     3. charge le pixel Meta du tunnel (PageView, puis Lead à l'opt-in) —
        jamais pour un visiteur venu de YouTube (tunnel réglé « YouTube » :
        utm_source=youtube posé d'office, cf. §1). Sur le SITE VITRINE
        seulement (C.consent, posé par le serveur), le pixel attend
        « Tout accepter » dans le bandeau cookies (§3 bis) ;
     4. propage la provenance (lp, v, utm_*, leadId) sur tous les liens vers
        le tunnel ou vers team.alteore.com (booking, AlteoForms) et sur les
        iframes qui les embarquent — c'est ce qui relie la page au RDV et à
        la fiche Leads Live ;
     5. intercepte les formulaires `data-alteo-optin` : envoi à
        /api/tunnel-optin (fiche Leads Live), pixel Lead, puis redirection
        vers l'étape suivante.

   Contrat côté page HTML :
     <form data-alteo-optin>            → formulaire d'opt-in (champs par
                                          `name` : prenom, nom, email,
                                          telephone, secteur, ca, defi,
                                          message ; le reste = réponses libres)
     <form data-alteo-optin data-next="/merci">  → cible après envoi (sinon
                                          l'étape suivante du tunnel)
     [data-alteo-error]                 → zone où afficher une erreur (créée
                                          sous le formulaire sinon)
     <a data-alteo-cta href="…">        → compte un clic CTA (les liens vers
                                          booking.html comptent d'office)
     <iframe data-alteo-src="https://team.alteore.com/booking.html?type=…">
                                        → src posé par le runtime AVEC la
                                          provenance (recommandé)
     <input name="website">             → pot de miel anti-spam (rester vide)
     window.ALTEO.next()                → aller à l'étape suivante
     window.ALTEO.track('cta')          → événement manuel

   ES5 strict : Safari ancien. Aucune dépendance.
   ============================================================================ */
(function () {
  'use strict';
  var C = window.ALTEO_TUNNEL;
  if (!C || window.__alteoRuntime) return;
  window.__alteoRuntime = true;

  var ATTR_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
                   'ad_id', 'adset_id', 'campaign_id', 'fbclid'];
  var LS_ATTR = 'alteo_attr_v1';
  var SS_LEAD = 'alteo_lead_id';
  var ATTR_TTL = 30 * 86400000;
  var PROPAGATE_HOSTS = ['team.alteore.com'].concat(C.hosts || []);

  function store(kind) {
    try { return kind === 'local' ? window.localStorage : window.sessionStorage; } catch (e) { return null; }
  }
  function ssGet(k) { var s = store('session'); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function ssSet(k, v) { var s = store('session'); try { if (s) s.setItem(k, v); } catch (e) {} }
  function lsGet(k) { var s = store('local'); try { return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function lsSet(k, v) { var s = store('local'); try { if (s) s.setItem(k, v); } catch (e) {} }

  /* ── 1. Attribution ─────────────────────────────────────────────────── */
  function parseQuery(search) {
    var out = {};
    var q = String(search || '').replace(/^\?/, '');
    if (!q) return out;
    var parts = q.split('&');
    for (var i = 0; i < parts.length; i++) {
      if (!parts[i]) continue;
      var kv = parts[i].split('=');
      var k = kv[0], v = kv.slice(1).join('=');
      try { k = decodeURIComponent(k.replace(/\+/g, ' ')); } catch (e) {}
      try { v = decodeURIComponent(v.replace(/\+/g, ' ')); } catch (e2) {}
      out[k] = v;
    }
    return out;
  }
  var Q = parseQuery(window.location.search);
  function attrFromQuery(q) {
    var a = null;
    for (var i = 0; i < ATTR_KEYS.length; i++) {
      var v = q[ATTR_KEYS[i]];
      if (v == null) continue;
      v = String(v).trim();
      if (!v || v.indexOf('{{') >= 0) continue;   /* macro Meta non substituée */
      if (!a) a = {};
      a[ATTR_KEYS[i]] = v.slice(0, 300);
    }
    return a;
  }
  var attr = attrFromQuery(Q);
  /* Tunnel « YouTube » (liens des descriptions de vidéos, trafic organique) :
     la page n'est atteignable que depuis YouTube, l'arrivée vaut donc un
     touch frais même sans UTM — utm_source=youtube posé d'office (un
     utm_source explicite dans le lien reste prioritaire). Il suit le
     visiteur jusqu'au RDV, à AlteoForms et à la fiche Leads Live. */
  if (C.trackingSource === 'youtube') {
    if (!attr) attr = {};
    if (!attr.utm_source) attr.utm_source = 'youtube';
  }
  if (attr) {
    lsSet(LS_ATTR, JSON.stringify({ at: Date.now(), a: attr }));
  } else {
    try {
      var saved = JSON.parse(lsGet(LS_ATTR) || 'null');
      if (saved && saved.a && Date.now() - (saved.at || 0) < ATTR_TTL) attr = saved.a;
    } catch (e) { attr = null; }
  }
  var leadId = String(Q.leadId || ssGet(SS_LEAD) || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 120);
  if (leadId) ssSet(SS_LEAD, leadId);

  /* ── 2. Beacon ──────────────────────────────────────────────────────── */
  function post(url, payload, keepalive) {
    var json = JSON.stringify(payload);
    /* Blob text/plain : pas de pré-vol CORS, et sendBeacon survit à la
       navigation qui suit un clic. */
    if (keepalive && navigator.sendBeacon) {
      try { if (navigator.sendBeacon(url, new Blob([json], { type: 'text/plain' }))) return; } catch (e) {}
    }
    if (window.fetch) {
      try { window.fetch(url, { method: 'POST', body: json, headers: { 'Content-Type': 'text/plain' }, keepalive: !!keepalive }); return; } catch (e2) {}
    }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.send(json);
    } catch (e3) {}
  }
  function once(key) {
    var k = 'alteo_ev_' + key;
    if (ssGet(k)) return false;
    ssSet(k, '1');
    return true;
  }
  function srcOf() {
    var a = attr || {};
    return { utm_source: a.utm_source || '', utm_campaign: a.utm_campaign || '', utm_content: a.utm_content || '' };
  }
  function track(ev) {
    if (C.preview) return;
    if (ev === 'visit' && !once('visit_' + C.tunnelId)) return;
    if (ev === 'view' && !once('view_' + C.stepId + '_' + C.variant)) return;
    if (ev === 'cta' && !once('cta_' + C.stepId)) return;
    post(C.eventEndpoint, { t: C.tunnelId, s: C.stepId, v: C.variant, e: ev, src: srcOf() }, true);
  }
  track('visit');
  track('view');

  /* ── 3. Pixel Meta ──────────────────────────────────────────────────── */
  /* Visiteur venu de YouTube (tunnel YouTube, ou page commune — merci après
     RDV — atteinte depuis un parcours YouTube) : jamais de pixel Meta, ses
     conversions ne doivent pas nourrir l'optimisation des pubs Facebook. */
  function isYoutubeVisitor() {
    var s = String((attr && attr.utm_source) || '').toLowerCase();
    return s.indexOf('youtube') >= 0 || s === 'yt';
  }
  function pixelInit() {
    if (!C.pixelId || C.preview || isYoutubeVisitor()) return;
    if (C.consent && consentRead() !== 'accepted') return;   // site vitrine : consentement d'abord
    try {
      if (!window.fbq) {
        (function (f, b, e, v, n, t, sc) {
          n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
          if (!f._fbq) f._fbq = n;
          n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
          t = b.createElement(e); t.async = true; t.src = v;
          sc = b.getElementsByTagName(e)[0];
          if (sc && sc.parentNode) sc.parentNode.insertBefore(t, sc); else b.head.appendChild(t);
        })(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
      }
      window.fbq('init', String(C.pixelId));
      window.fbq('track', 'PageView');
      /* Événement supplémentaire au chargement (réglage de l'étape) : un
         événement standard passe par track, tout autre nom par trackCustom. */
      if (C.pixelEvent) {
        var STD = ['ViewContent', 'Lead', 'Schedule', 'Contact', 'CompleteRegistration', 'SubmitApplication',
                   'Purchase', 'InitiateCheckout', 'AddToCart', 'Search', 'StartTrial', 'Subscribe',
                   'CustomizeProduct', 'Donate', 'FindLocation', 'AddPaymentInfo', 'AddToWishlist'];
        window.fbq(STD.indexOf(C.pixelEvent) >= 0 ? 'track' : 'trackCustom', C.pixelEvent, { content_name: C.page });
      }
    } catch (e) {}
  }
  /* ── 3 bis. Bandeau cookies (site vitrine uniquement, 10/2026) ─────────
     Activé par le serveur (C.consent = { privacyUrl }) pour les pages du
     tunnel kind:'site' : les tunnels de vente n'en ont pas (choix Adrien).
     Affiché seulement si un traceur serait chargé (pixel réglé, visiteur
     non YouTube). Choix gardé 6 mois (localStorage `ac_cookie_consent`).
     Refus après acceptation : rechargement, la page repart sans pixel.
     Lien « Gérer mes cookies » : tout élément [data-alteo-cookies] (ajouté
     par le serveur à côté du lien de confidentialité), ou
     window.ambitioCookies.open(). */
  var CONSENT_KEY = 'ac_cookie_consent';
  var CONSENT_TTL = 183 * 86400000;
  function consentRead() {
    try {
      var v = JSON.parse(lsGet(CONSENT_KEY) || 'null');
      if (v && (v.choice === 'accepted' || v.choice === 'refused') && Date.now() - v.date < CONSENT_TTL) return v.choice;
    } catch (e) {}
    return null;
  }
  function consentWanted() { return !!(C.consent && C.pixelId && !isYoutubeVisitor()); }
  var _banner = null;
  function bannerBuild() {
    if (_banner) return _banner;
    var st = document.createElement('style');
    st.textContent = '#ac-cookies{--ac-bg:#0f1b33;--ac-text:#ffffff;--ac-accent:#f28c28;position:fixed;left:16px;right:16px;bottom:16px;z-index:99999;max-width:560px;margin:0 auto;background:var(--ac-bg);color:var(--ac-text);border-radius:12px;padding:18px 20px;box-shadow:0 8px 30px rgba(0,0,0,.35);font:inherit;font-size:14px;line-height:1.5;display:none;box-sizing:border-box;text-align:left}'
      + '#ac-cookies.ac-open{display:block}'
      + '#ac-cookies p{margin:0 0 14px;color:inherit;font:inherit}'
      + '#ac-cookies a{color:inherit;text-decoration:underline}'
      + '#ac-cookies .ac-actions{display:flex;gap:10px;flex-wrap:wrap}'
      + '#ac-cookies button{flex:1 1 140px;padding:10px 14px;border-radius:8px;border:1px solid var(--ac-accent);font:inherit;font-size:14px;font-weight:600;cursor:pointer;background:var(--ac-accent);color:#111}'
      + '#ac-cookies button:focus-visible{outline:2px solid var(--ac-text);outline-offset:2px}';
    (document.head || document.documentElement).appendChild(st);
    var box = document.createElement('div');
    box.id = 'ac-cookies';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-live', 'polite');
    box.setAttribute('aria-label', 'Gestion des cookies');
    var more = /^https:\/\//i.test(String((C.consent && C.consent.privacyUrl) || ''))
      ? ' <a href="' + String(C.consent.privacyUrl).replace(/"/g, '&quot;') + '" target="_blank" rel="noopener">En savoir plus</a>' : '';
    box.innerHTML = '<p>Avec votre accord, nous utilisons des cookies pour mesurer l\'audience de ce site et l\'efficacité de nos publicités (Meta). '
      + 'Vous pouvez changer d\'avis à tout moment via « Gérer mes cookies » en bas de page.' + more + '</p>'
      + '<div class="ac-actions"><button type="button" data-ac="refused">Tout refuser</button><button type="button" data-ac="accepted">Tout accepter</button></div>';
    box.addEventListener('click', function (ev) {
      var b = ev.target && ev.target.closest ? ev.target.closest('[data-ac]') : null;
      if (b) consentChoose(b.getAttribute('data-ac'));
    });
    document.body.appendChild(box);
    _banner = box;
    return box;
  }
  function bannerOpen() {
    if (!C.consent) return;
    if (!document.body) { document.addEventListener('DOMContentLoaded', bannerOpen); return; }
    bannerBuild().className = 'ac-open';
  }
  function consentChoose(choice) {
    var previous = consentRead();
    lsSet(CONSENT_KEY, JSON.stringify({ choice: choice, date: Date.now() }));
    if (_banner) _banner.className = '';
    if (choice === 'accepted') {
      pixelInit();
      try { document.dispatchEvent(new CustomEvent('ambitio:cookies-accepted')); } catch (e) {}
    } else if (previous === 'accepted') {
      window.location.reload();   // retrait du consentement : on repart sans traceurs
    }
  }
  if (C.consent) {
    window.ambitioCookies = { open: bannerOpen };
    document.addEventListener('click', function (ev) {
      var a = ev.target && ev.target.closest ? ev.target.closest('[data-alteo-cookies]') : null;
      if (!a) return;
      ev.preventDefault();
      bannerOpen();
    });
    if (consentWanted() && consentRead() === null) bannerOpen();
  }

  pixelInit();
  function pixelLead() {
    if (!C.pixelId || C.preview || !window.fbq || isYoutubeVisitor()) return;
    try { window.fbq('track', 'Lead', { content_name: C.page }); } catch (e) {}
  }

  /* ── 4. Propagation de la provenance ────────────────────────────────── */
  function params() {
    var p = { lp: C.page, v: C.variant };
    if (attr) for (var i = 0; i < ATTR_KEYS.length; i++) if (attr[ATTR_KEYS[i]]) p[ATTR_KEYS[i]] = attr[ATTR_KEYS[i]];
    if (leadId) p.leadId = leadId;
    return p;
  }
  function hostOf(href) {
    var m = String(href).match(/^https?:\/\/([^\/?#]+)/i);
    return m ? m[1].toLowerCase() : '';
  }
  function shouldDecorate(href) {
    if (!href) return false;
    var h = String(href);
    if (/^(#|mailto:|tel:|sms:|javascript:|data:|blob:)/i.test(h)) return false;
    var host = hostOf(h);
    if (!host) return true;                                   /* lien relatif = même tunnel */
    if (host === window.location.hostname.toLowerCase()) return true;
    for (var i = 0; i < PROPAGATE_HOSTS.length; i++) if (host === String(PROPAGATE_HOSTS[i]).toLowerCase()) return true;
    return false;
  }
  function decorate(href) {
    if (!shouldDecorate(href)) return href;
    var h = String(href);
    var hash = '';
    var hi = h.indexOf('#');
    if (hi >= 0) { hash = h.slice(hi); h = h.slice(0, hi); }
    var qi = h.indexOf('?');
    var base = qi >= 0 ? h.slice(0, qi) : h;
    var existing = qi >= 0 ? parseQuery(h.slice(qi)) : {};
    var p = params();
    var pairs = [];
    var k;
    for (k in existing) if (Object.prototype.hasOwnProperty.call(existing, k)) pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(existing[k]));
    for (k in p) if (Object.prototype.hasOwnProperty.call(p, k) && !Object.prototype.hasOwnProperty.call(existing, k) && p[k]) pairs.push(encodeURIComponent(k) + '=' + encodeURIComponent(p[k]));
    return base + (pairs.length ? '?' + pairs.join('&') : '') + hash;
  }
  function isBookingHref(href) { return /booking\.html/i.test(String(href || '')); }

  document.addEventListener('click', function (ev) {
    var el = ev.target;
    while (el && el !== document && !(el.tagName && el.tagName.toLowerCase() === 'a')) el = el.parentNode;
    if (!el || el === document) return;
    var href = el.getAttribute('href');
    if (el.hasAttribute('data-alteo-cta') || isBookingHref(href)) track('cta');
    if (href && shouldDecorate(href)) {
      var dec = decorate(href);
      if (dec !== href) el.setAttribute('href', dec);
    }
  }, true);

  function decorateFrames() {
    var frames = document.getElementsByTagName('iframe');
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f.__alteoDone) continue;
      var pre = f.getAttribute('data-alteo-src');
      if (pre) { f.__alteoDone = true; f.setAttribute('src', decorate(pre)); continue; }
      var src = f.getAttribute('src');
      if (src && hostOf(src) && shouldDecorate(src) && src.indexOf('lp=') < 0) {
        f.__alteoDone = true;
        var d = decorate(src);
        if (d !== src) f.setAttribute('src', d);
      }
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', decorateFrames);
  else decorateFrames();
  if (window.MutationObserver) {
    try { new MutationObserver(decorateFrames).observe(document.documentElement, { childList: true, subtree: true }); } catch (e) {}
  }

  /* ── 5. Formulaires d'opt-in ────────────────────────────────────────── */
  var FIELD_ALIASES = {
    prenom: ['prenom', 'prénom', 'firstname', 'first_name', 'first-name', 'fname'],
    nom: ['nom', 'lastname', 'last_name', 'last-name', 'lname', 'name', 'surname'],
    email: ['email', 'e-mail', 'mail', 'courriel'],
    telephone: ['telephone', 'téléphone', 'tel', 'phone', 'mobile', 'portable'],
    secteur: ['secteur', 'activite', 'activité', 'sector', 'industry'],
    ca: ['ca', 'chiffre_affaires', 'chiffre-affaires', 'revenue'],
    defi: ['defi', 'défi', 'probleme', 'problème', 'challenge', 'objectif'],
    message: ['message', 'commentaire', 'comment', 'notes'],
    /* Pot de miel : DOIT rester un champ canonique pour arriver dans
       fields.website — en « extra » il finirait affiché dans les réponses
       du lead et le blocage anti-robot ne se déclencherait jamais
       (incident du 28/09/2026 : robot passé par le formulaire de contact). */
    website: ['website']
  };
  function canonicalField(name) {
    var n = String(name || '').toLowerCase().trim();
    for (var k in FIELD_ALIASES) if (Object.prototype.hasOwnProperty.call(FIELD_ALIASES, k)) {
      var al = FIELD_ALIASES[k];
      for (var i = 0; i < al.length; i++) if (al[i] === n) return k;
    }
    return null;
  }
  function collect(form) {
    var fields = {}, extras = [];
    var els = form.elements;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      var name = el.name || el.getAttribute('data-name');
      if (!name || el.disabled) continue;
      var type = (el.type || '').toLowerCase();
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'file') continue;
      if ((type === 'checkbox' || type === 'radio') && !el.checked) continue;
      var val = String(el.value == null ? '' : el.value).trim();
      if (type === 'checkbox' && (val === 'on' || !val)) val = 'oui';
      if (!val) continue;
      var canon = canonicalField(name);
      if (canon) { fields[canon] = fields[canon] ? fields[canon] + ' ' + val : val; continue; }
      var label = el.getAttribute('data-label') || el.getAttribute('placeholder') || name;
      var found = false;
      for (var j = 0; j < extras.length; j++) if (extras[j].name === name) { extras[j].value += ', ' + val; found = true; }
      if (!found) extras.push({ name: name, label: String(label).slice(0, 120), value: val.slice(0, 2000) });
    }
    return { fields: fields, extras: extras };
  }
  function errorBox(form) {
    var box = form.querySelector('[data-alteo-error]');
    if (!box) {
      box = document.createElement('div');
      box.setAttribute('data-alteo-error', '');
      box.style.cssText = 'margin-top:10px;font-size:14px;line-height:1.4;color:#f87171;display:none';
      form.appendChild(box);
    }
    return box;
  }
  function showError(form, msg) {
    var box = errorBox(form);
    box.textContent = msg;
    box.style.display = msg ? '' : 'none';
  }
  function submitButtons(form) {
    var out = [];
    var els = form.querySelectorAll('button, input[type=submit]');
    for (var i = 0; i < els.length; i++) {
      var t = (els[i].type || '').toLowerCase();
      if (els[i].tagName.toLowerCase() === 'input' ? t === 'submit' : (t === 'submit' || !t)) out.push(els[i]);
    }
    return out;
  }
  function setBusy(form, busy) {
    var btns = submitButtons(form);
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (busy) {
        b.__alteoLabel = b.tagName.toLowerCase() === 'input' ? b.value : b.innerHTML;
        var wait = form.getAttribute('data-alteo-wait') || 'Envoi…';
        if (b.tagName.toLowerCase() === 'input') b.value = wait; else b.innerHTML = wait;
        b.disabled = true;
      } else {
        if (b.__alteoLabel != null) { if (b.tagName.toLowerCase() === 'input') b.value = b.__alteoLabel; else b.innerHTML = b.__alteoLabel; }
        b.disabled = false;
      }
    }
  }
  function goNext(form) {
    var target = (form && form.getAttribute('data-next')) || C.nextUrl;
    if (!target) return false;
    window.location.href = decorate(target);
    return true;
  }
  function request(url, payload, cb) {
    var json = JSON.stringify(payload);
    var done = false;
    function finish(ok, data) { if (done) return; done = true; cb(ok, data || {}); }
    if (window.fetch) {
      window.fetch(url, { method: 'POST', body: json, headers: { 'Content-Type': 'text/plain' } }).then(function (r) {
        return r.text().then(function (t) { var d = {}; try { d = JSON.parse(t); } catch (e) {} finish(r.ok && d.ok !== false, d); });
      }, function () { finish(false, { error: 'network' }); });
      return;
    }
    try {
      var x = new XMLHttpRequest();
      x.open('POST', url, true);
      x.setRequestHeader('Content-Type', 'text/plain');
      x.onreadystatechange = function () {
        if (x.readyState !== 4) return;
        var d = {}; try { d = JSON.parse(x.responseText); } catch (e) {}
        finish(x.status >= 200 && x.status < 300 && d.ok !== false, d);
      };
      x.send(json);
    } catch (e2) { finish(false, { error: 'network' }); }
  }
  function submitOptin(form) {
    if (form.__alteoBusy) return;
    var data = collect(form);
    var f = data.fields;
    showError(form, '');
    if (f.website) { /* pot de miel rempli : on fait semblant */ goNext(form); return; }
    /* Champs `required` du HTML : un envoi qui contourne la validation
       native du navigateur (robot, form.submit()) est arrêté ici. */
    var req = form.querySelectorAll('[required]');
    for (var ri = 0; ri < req.length; ri++) {
      if (!String(req[ri].value == null ? '' : req[ri].value).trim()) {
        showError(form, form.getAttribute('data-alteo-invalid') || 'Merci de remplir tous les champs obligatoires.');
        return;
      }
    }
    var emailOk = f.email && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.email);
    var telDigits = String(f.telephone || '').replace(/[^\d]/g, '');
    if (!emailOk && telDigits.length < 9) {
      showError(form, form.getAttribute('data-alteo-invalid') || 'Merci d’indiquer un email valide ou un numéro de téléphone.');
      return;
    }
    if (f.email && !emailOk) { showError(form, 'Cet email ne semble pas valide.'); return; }
    form.__alteoBusy = true;
    setBusy(form, true);
    var payload = {
      t: C.tunnelId, s: C.stepId, v: C.variant,
      fields: f, extras: data.extras,
      attribution: attr, leadId: leadId,
      pageUrl: String(window.location.href).slice(0, 500),
      src: srcOf()
    };
    request(C.optinEndpoint, payload, function (ok, resp) {
      if (!ok) {
        form.__alteoBusy = false;
        setBusy(form, false);
        showError(form, form.getAttribute('data-alteo-failed') || 'Impossible d’envoyer pour le moment. Réessayez dans un instant.');
        return;
      }
      if (resp.leadId) { leadId = resp.leadId; ssSet(SS_LEAD, leadId); }
      pixelLead();
      if (typeof window.alteoOnOptin === 'function') { try { window.alteoOnOptin(resp); } catch (e) {} }
      if (!goNext(form)) {
        setBusy(form, false);
        form.__alteoBusy = false;
        var ok2 = form.getAttribute('data-alteo-success');
        if (ok2) { var box = errorBox(form); box.style.color = '#34d399'; box.textContent = ok2; box.style.display = ''; }
      }
    });
  }
  document.addEventListener('submit', function (ev) {
    var form = ev.target;
    if (!form || !form.hasAttribute || !form.hasAttribute('data-alteo-optin')) return;
    ev.preventDefault();
    submitOptin(form);
  }, true);

  /* ── 6. API publique ────────────────────────────────────────────────── */
  window.ALTEO = {
    config: C,
    attribution: attr,
    leadId: function () { return leadId; },
    next: function () { return goNext(null); },
    track: track,
    decorate: decorate,
    submit: submitOptin
  };
})();
