/* ═══════════════════════════════════════════════════════════════════════════
   alteore-scoring.js — SOLVABILITÉ : FICHE ET POP-UPS (30/10/2026)
   ─────────────────────────────────────────────────────────────────────────
   Injecté par nav.js sur les pages internes, et chargé par sales-leads.html.

   Sur la fiche, en phase de closing : la page pose un conteneur, ce script le
   remplit.
     <div data-scoring data-lead-id="…" data-lead-nom="…"></div>
   Closer : bouton « Demander une étude de solvabilité », un admin valide.
   Admin  : même bouton, mais l'étude part tout de suite.

   Pop-ups (vérification toutes les 30 s, onglet visible) :
     · admin  : une demande à valider ou refuser, jusqu'à ce qu'elle soit traitée ;
     · closer : la réponse, jusqu'à ce qu'il clique OK.

   Tout passe par /api/scoring : les droits viennent du serveur. Le jeton
   Societe.com ne quitte jamais le serveur. Aucun SDK Firebase (compat et
   modulaire coexistent selon les pages). Inactif dans les bacs à sable, où rien
   de réel ne doit partir. ES5 strict.
   ═══════════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';
  if (window.ScoringWidget) return;

  var API = '/api/scoring';
  var POLL_MS = 30000;
  var PLUS_TARD_MS = 10 * 60 * 1000;
  var LS_PLUS_TARD = 'alteo_scoring_plus_tard';
  var FEU = { rouge: '🔴', orange: '🟠', vert: '🟢', gris: '⚪' };
  var ERREURS = {
    credits_epuises: 'Plus de crédits Societe.com : recharge le compte.',
    non_configure: 'La clé Societe.com n\'est pas configurée.',
    deja_traitee: 'Un autre admin a déjà répondu.',
    siren_invalide: 'Ce numéro n\'est pas valide.',
    forbidden: 'Tu n\'as pas accès à cette action.',
    indisponible: 'Societe.com ne répond pas. Réessaie dans un instant.'
  };

  var sandbox = !!window.__SBX || /sandbox/.test(location.pathname);
  var etat = { signature: '', refus: {}, enCours: false };

  function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function user() {
    try { if (typeof firebase !== 'undefined' && firebase.auth && firebase.auth().currentUser) return firebase.auth().currentUser; } catch (e) {}
    try { if (window._auth && window._auth.currentUser) return window._auth.currentUser; } catch (e) {}
    return null;
  }
  function jeton() {
    return new Promise(function (ok, ko) {
      var t0 = Date.now();
      (function essai() {
        var u = user();
        if (u) { u.getIdToken().then(ok, ko); return; }
        if (Date.now() - t0 > 40000) { ko(new Error('non connecté')); return; }
        setTimeout(essai, 400);
      })();
    });
  }
  function appel(query, corps) {
    return jeton().then(function (t) {
      var o = { headers: { 'Authorization': 'Bearer ' + t } };
      if (corps) { o.method = 'POST'; o.headers['Content-Type'] = 'application/json'; o.body = JSON.stringify(corps); }
      return fetch(API + (query || ''), o);
    }).then(function (r) { return r.json().catch(function () { return { ok: false, error: 'server_error' }; }); });
  }
  function messageErreur(j) { return (j && (j.detail || ERREURS[j.error])) || 'Une erreur est survenue. Réessaie.'; }
  function euros(n) {
    if (n === null || n === undefined || n === '') return '—';
    return String(Math.round(Number(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
  }
  function jour(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR');
  }

  function ensureStyles() {
    if (document.getElementById('scoStyles')) return;
    var css = ''
      + '.sco-box{margin:10px 0;padding:12px;border-radius:14px;border:1px solid rgba(109,94,252,.3);background:rgba(109,94,252,.07);font-size:13px;line-height:1.45}'
      + '.sco-box .h{font-weight:800;margin-bottom:8px}'
      + '.sco-box small{display:block;opacity:.72;font-size:11.5px;margin-top:3px}'
      + '.sco-go{width:100%;border:1px solid rgba(109,94,252,.5);border-radius:10px;padding:10px 12px;background:rgba(109,94,252,.16);color:inherit;font:inherit;font-weight:800;cursor:pointer}'
      + '.sco-go:hover{filter:brightness(1.12)}'
      + '.sco-go:disabled{opacity:.55;cursor:default}'
      + '.sco-go.ok{background:#16a34a;border-color:#16a34a;color:#fff}'
      + '.sco-go.ko{background:rgba(239,68,68,.14);border-color:rgba(239,68,68,.5)}'
      + '.sco-lien{background:none;border:none;color:inherit;opacity:.72;font:inherit;font-size:12px;font-weight:600;cursor:pointer;text-decoration:underline;padding:6px 0 0}'
      + '.sco-res .feu{display:flex;align-items:center;gap:8px;font-weight:800;font-size:14.5px;margin-bottom:6px}'
      + '.sco-res ul{margin:0 0 8px;padding-left:18px}'
      + '.sco-res li{margin-bottom:3px}'
      + '.sco-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:6px;margin:8px 0}'
      + '.sco-grid div{padding:6px 8px;border-radius:8px;border:1px solid rgba(128,128,128,.22)}'
      + '.sco-grid span{display:block;font-size:10.5px;opacity:.68}'
      + '.sco-grid b{font-size:13px}'
      + '.sco-note{font-size:11px;opacity:.68;margin-top:6px}'
      + '.sco-ov{position:fixed;inset:0;z-index:100000;background:rgba(0,0,0,.55);display:flex;align-items:center;justify-content:center;padding:16px}'
      + '.sco-mod{width:480px;max-width:100%;max-height:calc(100vh - 32px);overflow:auto;padding:18px;border-radius:16px;background:#14141f;color:#f8fafc;border:1px solid rgba(255,255,255,.14);font-size:13px;line-height:1.45}'
      + 'body.light-theme .sco-mod{background:#fff;color:#1f2937;border-color:rgba(0,0,0,.12)}'
      + '.sco-mod h3{margin:0 0 4px;font-size:16px}'
      + '.sco-mod p{margin:0 0 10px;opacity:.75}'
      + '.sco-in{width:100%;box-sizing:border-box;padding:9px 11px;border-radius:9px;border:1.5px solid rgba(128,128,128,.35);background:transparent;color:inherit;font:inherit;outline:0;margin-bottom:8px}'
      + '.sco-in:focus{border-color:#6d5efc}'
      + '.sco-opt{display:block;width:100%;text-align:left;padding:8px 10px;margin-bottom:6px;border-radius:9px;border:1px solid rgba(128,128,128,.25);background:transparent;color:inherit;font:inherit;cursor:pointer}'
      + '.sco-opt:hover,.sco-opt.on{border-color:#6d5efc;background:rgba(109,94,252,.12)}'
      + '.sco-opt small{display:block;opacity:.7;font-size:11.5px}'
      + '.sco-rang{display:flex;gap:8px;margin-top:10px}'
      + '.sco-rang>*{flex:1}'
      + '.sco-err{color:#ef4444;font-size:12px;font-weight:700;margin:6px 0}'
      + '#alteoScoring{position:fixed;top:14px;right:14px;z-index:99990;width:350px;max-width:calc(100vw - 28px);max-height:calc(100vh - 28px);overflow:auto;display:flex;flex-direction:column;gap:10px}'
      + '.sco-pop{padding:14px;border-radius:14px;border:1px solid rgba(109,94,252,.5);box-shadow:0 18px 50px rgba(0,0,0,.35);background:#16142a;color:#f8fafc;font-size:13px;line-height:1.45}'
      + 'body.light-theme .sco-pop{background:#f5f3ff;color:#1f2937}'
      + '.sco-pop .h{font-size:14px;font-weight:800;margin-bottom:6px}';
    var st = document.createElement('style');
    st.id = 'scoStyles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* ── Le résultat, identique partout ───────────────────────────────── */
  function resultatHTML(e) {
    if (!e) return '';
    var c = e.chiffres || {};
    var h = '<div class="sco-res"><div class="feu"><span>' + (FEU[e.niveau] || '⚪') + '</span><span>' + esc(e.titre) + '</span></div>';
    if (e.motifs && e.motifs.length) {
      h += '<ul>';
      e.motifs.forEach(function (m) { h += '<li>' + esc(m) + '</li>'; });
      h += '</ul>';
    }
    var cases = [];
    if (c.annee) {
      cases.push(['CA ' + c.annee, euros(c.ca)]);
      cases.push(['Résultat net', euros(c.resultat)]);
      cases.push(['Capitaux propres', euros(c.capitaux)]);
    }
    cases.push(['Procédures', c.procedureEnCours ? 'En cours' : String(c.nbProcedures || 0)]);
    if (c.scoreFinancier !== null && c.scoreFinancier !== undefined) cases.push(['Score financier ' + (c.scoreAnnee || ''), String(c.scoreFinancier)]);
    if (c.creation) cases.push(['Créée le', c.creation.split('-').reverse().join('/')]);
    h += '<div class="sco-grid">';
    cases.forEach(function (x) { h += '<div><span>' + esc(x[0]) + '</span><b>' + esc(x[1]) + '</b></div>'; });
    h += '</div><div class="sco-note">Étude du ' + esc(jour(e.at)) + ', sur les données publiques. C\'est une indication, pas une garantie de paiement.</div></div>';
    return h;
  }

  /* ── La fiche ─────────────────────────────────────────────────────── */
  function peindre(el) {
    if (sandbox || !el) return;
    var leadId = el.getAttribute('data-lead-id');
    if (!leadId) return;
    ensureStyles();
    appel('?action=lead&leadId=' + encodeURIComponent(leadId)).then(function (j) {
      if (!j || !j.ok || !j.peut) { el.innerHTML = ''; return; }
      el._sco = j;
      var d = j.demande;
      var h = '<div class="sco-box"><div class="h">🔎 Solvabilité de la société</div>';
      if (d && (d.statut === 'attente' || d.statut === 'en_cours')) {
        h += '⏳ Demande envoyée par ' + esc(d.demandeurNom) + ' pour <b>' + esc(d.nom) + '</b>.<small>Un admin doit la valider. Tu recevras la réponse en pop-up.</small>';
      } else if (d && d.statut === 'acceptee' && d.resultat) {
        h += '<div style="margin-bottom:6px"><b>' + esc(d.nom) + '</b></div>' + resultatHTML(d.resultat);
        h += '<button class="sco-lien" data-sco="ouvrir" type="button">Étudier une autre société</button>';
      } else {
        if (d && d.statut === 'refusee') {
          h += '<div style="margin-bottom:8px">❌ Demande refusée par ' + esc(d.decideurNom) + (d.motif ? ' : ' + esc(d.motif) : '') + '</div>';
        }
        h += '<button class="sco-go" data-sco="ouvrir" type="button">' + (j.admin ? '🔎 Lancer une étude de solvabilité' : '🔎 Demander une étude de solvabilité') + '</button>';
        h += '<small>' + (j.admin ? 'Environ 4,7 crédits, gratuit si la société a été étudiée il y a moins de 30 jours.' : 'Un doute sur la société ? Un admin valide, et le résultat s\'affiche ici.') + '</small>';
      }
      el.innerHTML = h + '</div>';
    }).catch(function (e) { console.warn('[scoring]', e && e.message); });
  }

  function repeindreTout() {
    var l = document.querySelectorAll('[data-scoring]');
    for (var i = 0; i < l.length; i++) peindre(l[i]);
  }

  /* ── Choisir la société ───────────────────────────────────────────── */
  var mod = null;

  function fermerModale() {
    if (mod && mod.ov && mod.ov.parentNode) mod.ov.parentNode.removeChild(mod.ov);
    mod = null;
  }

  function dessinerModale() {
    if (!mod) return;
    var estAdmin = mod.admin;
    var h = '<h3>🔎 Solvabilité</h3>';
    if (!mod.choix) {
      h += '<p>Cherche la société par son nom ou son SIRET.</p>'
        + '<input class="sco-in" data-sco-q placeholder="Nom, SIREN ou SIRET" value="' + esc(mod.q) + '">'
        + '<button class="sco-go" data-sco="chercher" type="button">Chercher</button>';
      if (mod.erreur) h += '<div class="sco-err">' + esc(mod.erreur) + '</div>';
      if (mod.resultats) {
        h += '<div style="margin-top:10px">';
        if (!mod.resultats.length) h += '<p>Aucune société trouvée.</p>';
        mod.resultats.forEach(function (r, i) {
          h += '<button class="sco-opt" data-sco="choisir" data-i="' + i + '" type="button"><b>' + esc(r.name || r.siren) + '</b>'
            + '<small>SIREN ' + esc(r.siren) + ' · ' + esc((r.address && r.address.city) || '') + ' · ' + esc(r.legalFormLabel || '') + (r.closed ? ' · cessée' : '') + '</small></button>';
        });
        h += '</div>';
      }
    } else {
      h += '<p>Société choisie : <b>' + esc(mod.choix.name || mod.choix.siren) + '</b> (SIREN ' + esc(mod.choix.siren) + ')</p>';
      if (!estAdmin) h += '<textarea class="sco-in" data-sco-note rows="3" placeholder="Ton doute, en une phrase (facultatif)"></textarea>';
      if (mod.erreur) h += '<div class="sco-err">' + esc(mod.erreur) + '</div>';
      h += '<div class="sco-rang"><button class="sco-go" data-sco="retour" type="button">Changer</button>'
        + '<button class="sco-go ok" data-sco="envoyer" type="button"' + (mod.occupe ? ' disabled' : '') + '>' + (mod.occupe ? 'Patiente…' : (estAdmin ? 'Lancer l\'étude' : 'Envoyer la demande')) + '</button></div>';
    }
    h += '<div style="text-align:center"><button class="sco-lien" data-sco="fermer" type="button">Annuler</button></div>';
    mod.box.innerHTML = h;
    var q = mod.box.querySelector('[data-sco-q]');
    if (q) q.focus();
  }

  function chercher(q) {
    mod.q = q;
    if (String(q).trim().length < 3) { mod.erreur = 'Saisis au moins 3 caractères.'; dessinerModale(); return; }
    mod.erreur = '';
    appel('', { action: 'recherche', q: q }).then(function (j) {
      if (!mod) return;
      if (!j.ok) { mod.erreur = messageErreur(j); mod.resultats = null; } else { mod.resultats = j.results || []; }
      dessinerModale();
    });
  }

  function ouvrirModale(el) {
    var j = el._sco || {};
    var ov = document.createElement('div');
    ov.className = 'sco-ov';
    var box = document.createElement('div');
    box.className = 'sco-mod';
    ov.appendChild(box);
    document.body.appendChild(ov);
    mod = { ov: ov, box: box, el: el, admin: !!j.admin, q: '', resultats: null, choix: null, erreur: '', occupe: false };
    if (j.suggestion && j.suggestion.siren) { mod.q = j.suggestion.siren; dessinerModale(); chercher(j.suggestion.siren); }
    else dessinerModale();
  }

  function envoyer() {
    var el = mod.el;
    var note = mod.box.querySelector('[data-sco-note]');
    var corps = {
      action: mod.admin ? 'solvabilite' : 'demander',
      leadId: el.getAttribute('data-lead-id'), leadNom: el.getAttribute('data-lead-nom') || '',
      siren: mod.choix.siren, nom: mod.choix.name || '', note: note ? note.value : ''
    };
    mod.occupe = true; mod.erreur = ''; dessinerModale();
    appel('', corps).then(function (j) {
      if (!mod) return;
      if (!j.ok) { mod.occupe = false; mod.erreur = messageErreur(j); dessinerModale(); return; }
      fermerModale();
      peindre(el);
    });
  }

  /* ── Pop-ups ──────────────────────────────────────────────────────── */
  function plusTard() {
    try { return JSON.parse(localStorage.getItem(LS_PLUS_TARD) || '{}') || {}; } catch (e) { return {}; }
  }
  function zone() {
    var z = document.getElementById('alteoScoring');
    if (!z) { z = document.createElement('div'); z.id = 'alteoScoring'; z.setAttribute('role', 'status'); document.body.appendChild(z); }
    return z;
  }

  function carteDemande(d) {
    var h = '<div class="sco-pop" data-demande="' + esc(d.id) + '"><div class="h">🔎 Solvabilité à valider</div>'
      + '<b>' + esc(d.nom) + '</b> · SIREN ' + esc(d.siren)
      + '<div>Demandée par ' + esc(d.demandeurNom) + (d.leadNom ? ', pour ' + esc(d.leadNom) : '') + '</div>';
    if (d.note) h += '<div style="margin-top:4px">« ' + esc(d.note) + ' »</div>';
    h += '<small style="display:block;opacity:.72;margin-top:4px">' + (d.gratuit ? 'Déjà étudiée récemment : 0 crédit.' : 'Environ 4,7 crédits.') + '</small>';
    if (d.erreur) h += '<div class="sco-err">Dernier essai : ' + esc(d.erreur) + '</div>';
    if (etat.refus[d.id]) {
      h += '<input class="sco-in" data-sco-motif placeholder="Motif du refus (facultatif)" style="margin-top:8px">'
        + '<div class="sco-rang"><button class="sco-go" data-sco="annuler-refus" type="button">Retour</button><button class="sco-go ko" data-sco="refuser" type="button">Confirmer le refus</button></div>';
    } else {
      h += '<div class="sco-rang"><button class="sco-go ko" data-sco="demander-refus" type="button">❌ Refuser</button><button class="sco-go ok" data-sco="valider" type="button">✅ Valider</button></div>'
        + '<div style="text-align:center"><button class="sco-lien" data-sco="plus-tard" type="button">Plus tard</button></div>';
    }
    return h + '</div>';
  }

  function carteReponse(d) {
    var h = '<div class="sco-pop" data-reponse="' + esc(d.id) + '">';
    if (d.statut === 'acceptee') {
      h += '<div class="h">Solvabilité de ' + esc(d.nom) + '</div>' + resultatHTML(d.resultat);
    } else {
      h += '<div class="h">❌ Demande refusée</div><b>' + esc(d.nom) + '</b>'
        + '<div>Par ' + esc(d.decideurNom) + (d.motif ? ' : ' + esc(d.motif) : '') + '</div>';
    }
    return h + '<div class="sco-rang"><button class="sco-go" data-sco="vu" type="button">OK</button></div></div>';
  }

  var dernier = { attente: [], reponses: [] };

  function dessinerPopups() {
    var pt = plusTard(), t = Date.now();
    var attente = dernier.attente.filter(function (d) { return !(pt[d.id] && pt[d.id] > t); });
    var h = '';
    attente.forEach(function (d) { h += carteDemande(d); });
    dernier.reponses.forEach(function (d) { h += carteReponse(d); });
    var z = zone();
    z.innerHTML = h;
    z.style.display = h ? 'flex' : 'none';
  }

  function verifier() {
    if (sandbox || document.hidden || etat.enCours) return;
    appel('?action=notifs').then(function (j) {
      if (!j || !j.ok) return;
      dernier = { attente: j.attente || [], reponses: j.reponses || [] };
      var sig = JSON.stringify([dernier.attente.map(function (d) { return [d.id, d.erreur]; }), dernier.reponses.map(function (d) { return d.id; })]);
      if (sig === etat.signature) return;
      var change = !!etat.signature;
      etat.signature = sig;
      ensureStyles();
      dessinerPopups();
      if (change) { repeindreTout(); signaler(); }
    }).catch(function (e) { console.warn('[scoring]', e && e.message); });
  }

  function signaler() {
    try { document.dispatchEvent(new CustomEvent('scoring-change')); } catch (e) {}
  }

  function decider(id, accord, motif, carte) {
    etat.enCours = true;
    var boutons = carte.querySelectorAll('button');
    for (var i = 0; i < boutons.length; i++) boutons[i].disabled = true;
    appel('', { action: 'decider', id: id, accord: accord, motif: motif || '' }).then(function (j) {
      etat.enCours = false;
      if (!j.ok && j.error !== 'deja_traitee') {
        alert(messageErreur(j));
        etat.signature = '';
        verifier();
        return;
      }
      delete etat.refus[id];
      dernier.attente = dernier.attente.filter(function (d) { return d.id !== id; });
      dessinerPopups();
      etat.signature = '';
      repeindreTout();
      signaler();
      verifier();
    });
  }

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-sco]') : null;
    if (!b) return;
    var a = b.getAttribute('data-sco');
    if (a === 'ouvrir') {
      var el = b.closest('[data-scoring]');
      if (el) ouvrirModale(el);
      return;
    }
    if (a === 'fermer') { fermerModale(); return; }
    if (a === 'chercher') { var q = mod.box.querySelector('[data-sco-q]'); chercher(q ? q.value : ''); return; }
    if (a === 'choisir') { mod.choix = mod.resultats[Number(b.getAttribute('data-i'))]; mod.erreur = ''; dessinerModale(); return; }
    if (a === 'retour') { mod.choix = null; mod.erreur = ''; dessinerModale(); return; }
    if (a === 'envoyer') { envoyer(); return; }

    var carte = b.closest('.sco-pop');
    if (!carte) return;
    var id = carte.getAttribute('data-demande') || carte.getAttribute('data-reponse');
    if (a === 'valider') { decider(id, true, '', carte); return; }
    if (a === 'demander-refus') { etat.refus[id] = true; dessinerPopups(); return; }
    if (a === 'annuler-refus') { delete etat.refus[id]; dessinerPopups(); return; }
    if (a === 'refuser') { var m = carte.querySelector('[data-sco-motif]'); decider(id, false, m ? m.value : '', carte); return; }
    if (a === 'plus-tard') {
      var pt = plusTard(); pt[id] = Date.now() + PLUS_TARD_MS;
      try { localStorage.setItem(LS_PLUS_TARD, JSON.stringify(pt)); } catch (err) {}
      dessinerPopups();
      return;
    }
    if (a === 'vu') {
      appel('', { action: 'vu', id: id });
      dernier.reponses = dernier.reponses.filter(function (d) { return d.id !== id; });
      dessinerPopups();
      return;
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && mod && e.target && e.target.hasAttribute && e.target.hasAttribute('data-sco-q')) chercher(e.target.value);
  });

  window.ScoringWidget = { paint: peindre, resultatHTML: resultatHTML, verifier: verifier, styles: ensureStyles };

  function boot() {
    if (sandbox) return;
    var role = localStorage.getItem('ambitio_role');
    repeindreTout();
    if (role !== 'admin' && role !== 'sales') return;
    verifier();
    setInterval(verifier, POLL_MS);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) verifier(); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
