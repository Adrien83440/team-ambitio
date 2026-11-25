// ============================================================================
// funnel-core.js — CŒUR DU FUNNEL SALES, PARTAGÉ NAVIGATEUR ↔ SERVEUR
// ----------------------------------------------------------------------------
// Une seule implémentation des KPIs du tunnel, utilisée par :
//   · sales-funnel.html      (SDK Firebase compat, rôle admin)
//   · api/agency-funnel.js   (Admin SDK, accès agence en lecture seule)
//
// POURQUOI CE FICHIER EXISTE
// --------------------------
// L'agence doit pouvoir choisir sa période (jour, 7 j, 30 j, plage libre) et
// son tunnel comme le fait l'équipe en interne. Un instantané pré-publié ne
// peut pas couvrir des fenêtres glissantes ni des plages arbitraires : il faut
// calculer à la demande côté serveur. Dupliquer compute() aurait garanti une
// dérive entre les deux vues — d'où l'extraction telle quelle, ici.
//
// ⚠ RÈGLE ABSOLUE : ce fichier est la SOURCE UNIQUE des chiffres du funnel.
// Toute correction de KPI se fait ICI, jamais dans une page. Les deux vues
// affichent alors mécaniquement la même chose.
//
// COMPATIBILITÉ DES DEUX SDK
// --------------------------
// Les API utilisées ici sont communes au SDK compat (navigateur) et à l'Admin
// SDK (Node) : collection() / doc() / where() / orderBy() / limit() / get(),
// snap.forEach / snap.size / snap.exists / doc.id / doc.data(). Les bornes de
// dates sont passées en Date natif — les deux SDK les convertissent en
// Timestamp (d'où tsOf, identité documentée plutôt que Timestamp.fromDate qui,
// lui, n'existe pas au même endroit dans les deux SDK).
//
// AUCUNE dépendance : ni Firebase, ni DOM, ni window. Le SDK est toujours
// reçu en paramètre (`db`).
// ============================================================================
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./stats-core.js'));
  else root.FunnelCore = factory(root.StatsCore);
}(typeof self !== 'undefined' ? self : this, function (SC) {
  'use strict';

  /* RÈGLES UNIQUES (audit de cohérence du 25/11/2026) : la classe d'un RDV,
     son état (annulé, no-show, présent…), Kept, Show-up et le glossaire
     vivent dans stats-core.js. Ce fichier n'en recode aucune. */
  if (!SC) throw new Error('funnel-core.js : stats-core.js doit être chargé avant ce fichier');

  /* ── Constantes métier (déplacées depuis sales-funnel.html) ── */
  /* Plafonds de lecture (audit du 25/11/2026, étape 2) : leads, ré-optins et
     appels sont lus PAR PAGES (lirePages) jusqu'à épuisement ; ces plafonds ne
     sont plus qu'un garde-fou de mémoire. Atteints, ils sont DITS à l'écran
     (k.erreursLecture, k.partiel), jamais tus. */
  var LEADS_QUERY_LIMIT = 30000;
  var REOPTINS_QUERY_LIMIT = 30000;
  var CLOSED_LEADS_LIMIT = 2000;   /* fiches gagnées sur une période — au-delà : « liste tronquée » affiché */
  var CALLS_QUERY_LIMIT = 30000;
  var PAGE_SIZE = 2000;            /* taille d'une page de lecture */
  /* Rôles de l'« équipe sales » pour la téléphonie : setters, closers et
     admins (le head of sales est admin). CSM et coachs = « hors équipe sales ». */
  var SALES_CALL_ROLES = { setter: 1, setter_ecrit: 1, closer: 1, closer_setter: 1, admin: 1 };
  /* Rôles dont le module Commissions porte des deals de setting. */
  var SALES_ROLES = { setter: 1, setter_ecrit: 1, closer: 1, closer_setter: 1 };
  /* Fenêtre du parcours d'un lead (Lead to speech, appelé, joint) : les
     14 jours qui suivent son entrée — même plafond que Pilotage. */
  var CONTACT_WINDOW_MS = 14 * 86400000;
  var ANSWERED_MIN_SEC  = 5;                  // même seuil que le Dashboard Sales
  /* Signature du répondeur (mesurée sur les appels réels le 17/08/2026) :
     une sonnerie longue suivie d'une conversation courte. Voir isAnsweredCall. */
  var VOICEMAIL_MIN_RING_SEC = 15;
  var VOICEMAIL_MAX_TALK_SEC = 15;
  var JOURNAL_GOLIVE    = '2026-07-14';       // mise en ligne du journal d'actions
  var TTX_LOOKAHEAD_MS  = 14 * 86400000;      // TTC/TTB cherchés jusqu'à 14 j après la fenêtre

  /* Les deux SDK acceptent un Date natif comme borne de requête et le
     convertissent en Timestamp. tsOf documente ce choix et garde le code des
     loaders identique à celui d'origine. */
  function tsOf(d) { return d; }

  /* Lecture PAR PAGES d'une requête triée (orderBy sur le champ de la plage) :
     page après page (startAfter le dernier document lu) jusqu'à épuisement,
     ou jusqu'au plafond. API commune aux deux SDK.
     → Promise de { docs: [DocumentSnapshot…], truncated: bool }.
     La promesse est REJETÉE si une page échoue : l'appelant décide (erreur
     dite à l'écran, jamais un zéro muet). */
  function lirePages(query, plafond, taille) {
    var size = taille || PAGE_SIZE;
    var docs = [];
    function next(after) {
      var q = after ? query.startAfter(after) : query;
      return q.limit(size).get().then(function (snap) {
        var last = null;
        snap.forEach(function (doc) { docs.push(doc); last = doc; });
        if (!last || snap.size < size) return { docs: docs, truncated: false };
        if (docs.length >= plafond) return { docs: docs, truncated: true };
        return next(last);
      });
    }
    return next(null);
  }

  /* ══ ÉQUIPE — qui est parti, qui est « sales » (décision D10) ══
     Un membre parti n'a plus de nom à l'écran, mais son activité passée RESTE
     dans les totaux (ligne « Anciens membres »). Source : sa fiche
     _meta/team_members (departed === true, ou fiche archivée : active ===
     false), OU liste historique StatsCore.PARTIS_HISTORIQUES (membres partis
     avant que la fiche porte le drapeau) : la règle est SC.estParti, la même
     dans le navigateur ET sur le serveur (revue D09 : côté Vercel, l'assistant
     et le brief du matin nommaient encore un ancien membre). Dans le
     navigateur, la règle de nav.js (window.isDepartedMember) est consultée en
     plus. Aucune liste de prénoms ici. m = fiche du membre, ou un slug. */
  function isDeparted(m) {
    if (!m) return false;
    if (typeof m === 'string') return SC.estParti(null, m);
    if (SC.estParti(m, m.slug)) return true;
    if (typeof window !== 'undefined' && window && typeof window.isDepartedMember === 'function') {
      try { if (window.isDepartedMember(m)) return true; } catch (e) { /* règle indisponible */ }
    }
    return false;
  }
  /* Réunit deux listes du roster par slug (la première prime, les drapeaux
     de départ de l'une ou l'autre sont gardés). Les pages passent souvent la
     liste SANS les partis (TEAM_MEMBERS_LIST) : loadAll relit le roster
     complet pour ne perdre l'activité d'aucun ancien membre. */
  function mergeTeam(a, b) {
    var out = [], bySlug = {};
    (a || []).concat(b || []).forEach(function (m) {
      if (!m || typeof m !== 'object') return;
      var key = m.slug || m.firebaseUid;
      if (!key) return;
      var cur = bySlug[key];
      if (!cur) { cur = {}; Object.keys(m).forEach(function (f) { cur[f] = m[f]; }); bySlug[key] = cur; out.push(cur); return; }
      Object.keys(m).forEach(function (f) { if (cur[f] == null) cur[f] = m[f]; });
      if (m.departed === true) cur.departed = true;
    });
    return out;
  }

  /* Fin de recherche du 1er contact / 1er RDV : fenêtre + lookahead, jamais
     dans le futur. Un lead entré le 30 et appelé le 2 a un time-to-contact —
     sans ça il disparaît de la médiane (censure de fenêtre) et la médiane ne
     peut mécaniquement pas dépasser la taille de la fenêtre. */
  function lookaheadEndMsFor(P) {
    return Math.min(P.end.getTime() + TTX_LOOKAHEAD_MS, Date.now());
  }


  /* ══════════════════════════════════════════════════════════════════
     DÉCROCHÉ RÉEL — un répondeur n'est pas une conversation (17/08/2026)
     ------------------------------------------------------------------
     Le funnel annonçait 81,4 % de décrochés là où Élodie constatait
     l'inverse. Le prédicat était « conversation ≥ 5 s », et une annonce de
     messagerie le franchit sans peine.

     CE QUI A ÉTÉ ÉCARTÉ, MESURES À L'APPUI — endpoint de diagnostic
     temporaire, retiré depuis (97 appels sortants sur 7 jours) :
       · `last_state`  — 96 appels sur 97 en « ANSWERED »
       · `is_answered` — 99 %, pire que le funnel
       · `voicemail`   — null sur la totalité des appels
       · `amd`         — n'attrape que 8 des 36 suspects, ET étiquette
                         « machine » des conversations de 42 à 148 s. Faux
                         négatifs ET faux positifs : inutilisable seul.

     CE QUI MARCHE : la durée de SONNERIE. Douze appels sonnaient entre
     23,1 et 23,9 s avant d'être « décrochés » puis de durer exactement 5 s.
     Un humain ne décroche pas douze fois à la même demi-seconde — c'est le
     délai fixe de bascule vers la messagerie de l'opérateur. Le répondeur
     décroche, le setter reconnaît l'annonce et raccroche.

     RÈGLE : conversation ≥ 5 s, SAUF sonnerie ≥ 15 s suivie de moins de
     15 s de conversation. Elle préserve les vrais décrochés tardifs —
     3 appels décrochés après ~23 s de sonnerie ont duré 45 s à 2 min, ils
     restent comptés, ce qu'un simple seuil relevé aurait perdu.

     LIMITE ASSUMÉE : 11 appels sonnent 2-5 s puis durent 5-9 s. Ce peut
     être un humain qui raccroche aussitôt (décroché) ou un téléphone
     éteint basculant instantanément sur la messagerie (pas un décroché).
     Aucun champ Ringover ne les sépare. On les COMPTE — mieux vaut
     surestimer de peu que jeter de vraies conversations. Le taux réel est
     donc entre 44 % et 57 %, et on retient la borne haute.

     Sur l'historique, la sonnerie se déduit de totalDurationSec −
     durationSec (vérifié sur les exemples Ringover). Les appels dont la
     durée totale n'a jamais été stockée gardent l'ancien comportement :
     sans sonnerie connue, on ne peut RIEN exclure, et inventer serait pire.
     ══════════════════════════════════════════════════════════════════ */
  /* Trois sources, de la plus sûre à la plus indirecte. Les appels du JOUR
     arrivent par le webhook temps réel et non par le sync nocturne : ils
     n'ont pas toujours de durée totale, d'où la 2ᵉ source — le webhook, lui,
     horodate initiatedAt et answeredAt, dont l'écart EST la sonnerie.
     Sans ces trois-là, on renvoie null et rien n'est exclu : mieux vaut un
     décroché de trop qu'une conversation jetée sur une supposition. */
  function ringingSecOf(c) { return SC.sonnerieSec(c); }

  /* Règle unique du « décroché » : stats-core.js (audit du 25/11/2026). */
  function isAnsweredCall(c) { return SC.estDecroche(c); }

  /* ── Décodage UTM défensif (identique sales-leads.html) ── */
  function decodeUtm(v) {
    if (v == null) return v;
    var s = String(v);
    if (s.indexOf('%') === -1) return s;
    try { return decodeURIComponent(s); }
    catch (e) {
      return s.replace(/(?:%[0-9A-Fa-f]{2})+/g, function (m) {
        try { return decodeURIComponent(m); } catch (_) { return m; }
      });
    }
  }

  /* ── Clé « créative » d'un lead (section UTM — validé Adrien 22/07) ──
     Le lead porte UN champ utm (string posée par l'opt-in / Make, parfois
     %-encodée, parfois querystring complète). Règle : utm décodé tel quel ;
     si la valeur contient utm_content= (= la créative chez Meta), on extrait
     ce paramètre. Vide → « — » (bucket « sans UTM »). */
  function utmKeyOf(l) {
    var rawStr = (l && l.utm) == null ? '' : String(l.utm).trim();
    if (!rawStr) return '—';
    /* ⚠ L'extraction se fait sur la chaîne BRUTE, avant décodage : décoder
       d'abord transformait « Pub%20A&… » en « Pub A&… », et [^&\s]+
       s'arrêtait sur l'espace — la créative « Pub A » remontait « Pub »
       (corrigé 17/08/2026). Le groupe capturé, lui, est décodé ensuite. */
    var m = rawStr.match(/(?:^|[?&\s])utm_content=([^&\s]*)/i);
    if (m && m[1]) return decodeUtm(m[1]).replace(/\+/g, ' ').trim();
    var dec = decodeUtm(rawStr);
    return dec == null ? '—' : String(dec).trim() || '—';
  }

  /* ══════════════════════════════════════════════════════════════════
     ATTRIBUTION — parsing, normalisation, axes (chantier UTM 17/08/2026)
     ------------------------------------------------------------------
     POURQUOI : le champ `utm` est UN texte libre écrasé à chaque
     ré-engagement (opt-in, AlteoForm, booking, saisie manuelle). Il ne
     peut donc pas servir d'axe créative : un lead venu d'une pub puis
     passé par un AlteoForm portait « AlteoForm - <titre> », et toute sa
     performance était volée à la créative qui l'avait amené.

     Les endpoints d'entrée écrivent maintenant DEUX blocs structurés :
       attributionFirst — posé au PREMIER touch, jamais réécrit
       attributionLast  — rafraîchi à chaque engagement porteur d'UTM
     Le champ `utm` legacy continue d'être écrit (Leads Live, CRM, export).

     Ce bloc est la source UNIQUE du parsing : les Vercel Functions le
     consomment via require('../funnel-core.js'), exactement comme
     api/agency-funnel.js consomme computeKpis. Une seule implémentation
     entre ce qui est écrit en base et ce qui est lu par le funnel.
     ══════════════════════════════════════════════════════════════════ */
  var ATTR_FIELDS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content',
                     'utm_term', 'ad_id', 'adset_id', 'campaign_id', 'fbclid'];

  /* Alias tolérés à la capture. Volontairement restreints aux clés NON
     ambiguës : pas de `source` ni `campaign` nus, qui entreraient en
     collision avec les champs métier du body d'api/lead-optin.js. */
  /* `audience` : l'agence nomme l'adset dans un paramètre MAISON plutôt que
     dans utm_term — son template est
       utm_source={{site_source_name}}&utm_medium={{placement}}
       &utm_campaign={{campaign.name}}&utm_content={{ad.name}}
       &Audience={{adset.name}}
     Sans cet alias, l'adset arrivait dans l'URL et repartait à la poubelle :
     l'axe Adset serait resté vide alors que la donnée était là (17/08/2026).
     Les clés sont comparées en minuscules, « Audience » passe donc. */
  var ATTR_ALIASES = {
    utm_campaign: ['campaign_name'],
    utm_content:  ['ad_name'],
    utm_term:     ['adset_name', 'audience'],
    ad_id:        ['adid'],
    adset_id:     ['adsetid'],
    campaign_id:  ['campaignid']
  };

  /* Décodage d'une valeur. Gère le double encodage, fréquent quand Make
     relaie une landing page (%2520) : on repasse une fois, jamais plus —
     une valeur légitime « 100%25 » ne doit pas boucler.

     ⚠ NE convertit PAS '+' en espace. Cette règle n'existe QUE dans une
     querystring (voir parseQueryPairs) : l'appliquer partout amputait les
     noms venus du référentiel ou saisis à la main — « BROAD - ADV+ »
     devenait « BROAD - ADV », et la créative « Ads++ » devenait « Ads ». */
  function attrDecodeValue(v) {
    if (v == null) return '';
    var s = String(v);
    for (var i = 0; i < 2 && s.indexOf('%') !== -1; i++) {
      var before = s;
      s = decodeUtm(s);
      if (s === before) break;
    }
    return s.replace(/\s+/g, ' ').trim();
  }

  /* Valeur issue d'une QUERYSTRING : là, et seulement là, '+' vaut espace —
     decodeURIComponent ne le fait pas, d'où des créatives « Nom+De+Pub ». */
  function attrDecodeQueryValue(v) {
    return attrDecodeValue(v == null ? '' : String(v).replace(/\+/g, ' '));
  }

  /* Macro Meta non substituée ({{ad.name}}), placeholder ou vide : c'est
     une ABSENCE d'information, pas une créative nommée « {{ad.name}} ».
     La ligne parasite de ta capture vient exactement de là. */
  function attrIsPlaceholder(v) {
    var s = String(v == null ? '' : v).trim();
    if (!s) return true;
    if (s.charAt(0) === '{' || s.indexOf('{{') >= 0) return true;
    if (s.indexOf('%7B%7B') === 0 || s.indexOf('%7b%7b') === 0) return true;
    var low = s.toLowerCase();
    return low === 'null' || low === 'undefined' || low === 'none' ||
           low === '(not set)' || low === 'n/a' || low === '-';
  }

  /* Paires clé=valeur d'une querystring, d'une URL complète ou d'un
     fragment : '?a=1&b=2', 'https://x.fr/p?a=1', 'a=1&b=2'. */
  function parseQueryPairs(raw) {
    var out = {};
    var s = String(raw == null ? '' : raw);
    var q = s.indexOf('?');
    if (q >= 0) s = s.slice(q + 1);
    var h = s.indexOf('#');
    if (h >= 0) s = s.slice(0, h);
    if (s.indexOf('=') === -1) return out;
    var parts = s.split(/[&;]/);
    for (var i = 0; i < parts.length; i++) {
      var eq = parts[i].indexOf('=');
      if (eq <= 0) continue;
      var k = attrDecodeQueryValue(parts[i].slice(0, eq)).toLowerCase();
      var v = attrDecodeQueryValue(parts[i].slice(eq + 1));
      if (k && out[k] == null) out[k] = v;
    }
    return out;
  }

  /* input = objet de paramètres (renderer AlteoForm, body Make) OU chaîne
     (champ utm legacy, querystring, URL de landing).
     Retourne un objet ne portant QUE les champs réellement renseignés, ou
     null si rien d'exploitable — on ne pose jamais un bloc vide en base. */
  function parseAttribution(input) {
    var src = {};
    if (input && typeof input === 'object') {
      Object.keys(input).forEach(function (kk) { src[String(kk).toLowerCase()] = input[kk]; });
    } else {
      src = parseQueryPairs(input);
    }
    var out = {}, got = false;
    for (var i = 0; i < ATTR_FIELDS.length; i++) {
      var f = ATTR_FIELDS[i];
      var v = src[f];
      var al = ATTR_ALIASES[f] || [];
      for (var j = 0; v == null && j < al.length; j++) v = src[al[j]];
      v = attrDecodeValue(v);
      if (attrIsPlaceholder(v)) continue;
      if (v.length > 300) v = v.slice(0, 300);
      out[f] = v; got = true;
    }
    return got ? out : null;
  }

  /* Un bloc d'attribution porte-t-il un signal publicitaire exploitable ?
     (capturedAt / via / landingPage seuls ne comptent pas.) */
  function attrHasSignal(a) {
    if (!a || typeof a !== 'object') return false;
    for (var i = 0; i < ATTR_FIELDS.length; i++) {
      if (a[ATTR_FIELDS[i]]) return true;
    }
    return false;
  }

  /* Bloc d'attribution retenu pour un lead : premier touch d'abord (la
     vérité publicitaire), dernier touch en repli. */
  function leadAttribution(l) {
    if (!l) return null;
    if (attrHasSignal(l.attributionFirst)) return l.attributionFirst;
    if (attrHasSignal(l.attributionLast)) return l.attributionLast;
    return null;
  }

  /* Ce lead vient-il de la PUBLICITÉ PAYANTE ?
     Vrai s'il porte une attribution publicitaire structurée, ou si son
     libellé legacy désigne une pub, un adset ou un identifiant Meta.
     Faux pour un canal (Instagram organique, lien partagé, setting
     téléphonique) et pour une fiche sans origine.
     Sert au ROAS isolé ET au classement du tableau — une seule définition,
     pour que les deux ne puissent pas diverger. */
  function isAdvertisingLead(l) {
    if (leadAttribution(l)) return true;
    var k = classifyLegacyLabel(l && l.utm).kind;
    return k === 'ad_id' || k === 'creative' || k === 'adset';
  }

  /* Normalisation d'un libellé de créative / adset / campagne :
     décodage, espaces, et surtout fusion des duplications Meta
     (« …-Copie », « … - Copy 2 ») qui produisaient DEUX lignes pour la
     même pub — « 6)NEW-été-Vision » et « 6)NEW-été-Vision-Copie » dans
     la capture du 17/08. */
  function normalizeCreative(v) {
    var s = attrDecodeValue(v);
    s = s.replace(/[\s_-]*\(?\b(copie|copy)\b\s*\d*\)?\s*$/i, '');
    return s.trim();
  }

  /* Clé de regroupement : insensible à la casse et aux accents, pour que
     « ADV_BROAD » et « adv_broad » ne fassent pas deux lignes. Le libellé
     affiché reste la première graphie rencontrée. */
  function creativeGroupKey(label) {
    var s = String(label == null ? '' : label);
    if (typeof s.normalize === 'function') {
      try { s = s.normalize('NFD').replace(/[\u0300-\u036F]/g, ''); } catch (e) { /* vieux Safari */ }
    }
    return s.toLowerCase().replace(/[\s_-]+/g, ' ').trim();
  }

  /* Clé de RAPPROCHEMENT d'un nom de créative avec le référentiel Meta.
     Plus agressive que creativeGroupKey : elle supprime TOUTE ponctuation
     et tout espace. Raison : Meta retire les espaces quand il substitue
     {{ad.name}} dans une URL, si bien que la même publicité arrive
     « 6)NEW-été-Vision » côté lead et « 6) NEW - été - Vision » côté API.

        6)NEW-été-Vision       → 6newetevision
        6) NEW - été - Vision  → 6newetevision   ✅ même publicité

     Réservée au JOIN contre un référentiel fini et connu. Jamais utilisée
     pour regrouper des lignes entre elles — à ce niveau d'agressivité, deux
     créatives réellement distinctes pourraient se confondre. */
  function creativeMatchKey(s) {
    var v = attrDecodeValue(s);
    if (typeof v.normalize === 'function') {
      try { v = v.normalize('NFD').replace(/[\u0300-\u036F]/g, ''); } catch (e) { /* vieux Safari */ }
    }
    return v.toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  /* Référentiel créatives : ads_creatives/{ad_id} → noms lisibles.
     Indexé par ad_id, adset_id, campaign_id ET par nom normalisé — c'est
     ce dernier index qui permet de rattacher les leads dont l'UTM ne
     portait qu'un nom de pub (le gros du volume historique) à leur adset
     et à leur campagne. */
  function buildCreativeIndex(list) {
    var idx = { ad: {}, adset: {}, campaign: {}, byName: {} };
    (list || []).forEach(function (c) {
      if (!c) return;
      if (c.ad_id) idx.ad[String(c.ad_id)] = c;
      if (c.adset_id && !idx.adset[String(c.adset_id)]) idx.adset[String(c.adset_id)] = c;
      if (c.campaign_id && !idx.campaign[String(c.campaign_id)]) idx.campaign[String(c.campaign_id)] = c;
      if (c.ad_name) {
        var mk = creativeMatchKey(c.ad_name);
        /* Collision de noms : on ne devine pas. La première publicité
           indexée gagne, et on marque la clé pour ne pas s'y fier. */
        if (mk) {
          if (idx.byName[mk] && idx.byName[mk].ad_id !== c.ad_id) idx.byName[mk]._ambiguous = true;
          else if (!idx.byName[mk]) idx.byName[mk] = c;
        }
      }
    });
    return idx;
  }

  /* Publicité du référentiel correspondant à un bloc d'attribution.
     Par identifiant d'abord (certain), par nom ensuite (déduit mais sûr
     sur un référentiel de quelques dizaines de pubs aux noms distincts). */
  function refAdOf(a, IDX) {
    if (!a || !IDX) return null;
    var adId = a.ad_id || '';
    if (!adId && a.utm_content && /^\d{6,}$/.test(a.utm_content)) adId = a.utm_content;
    if (adId && IDX.ad[String(adId)]) return IDX.ad[String(adId)];
    if (a.utm_content) {
      var mk = creativeMatchKey(a.utm_content);
      var byName = mk ? IDX.byName[mk] : null;
      if (byName && !byName._ambiguous) return byName;
    }
    return null;
  }

  var AXIS_NAME_FIELD = { creative: 'ad_name', adset: 'adset_name', campaign: 'campaign_name' };

  /* Valeur d'axe d'un bloc d'attribution.
     Retourne { label, adId, resolved } ou null.

     LE RÉFÉRENTIEL PASSE EN PREMIER, et c'est tout l'enjeu de fidélité :
     une même publicité arrivait jusqu'ici sur DEUX lignes — l'une nommée
     « 6)NEW-été-Vision » (leads dont l'UTM portait le nom), l'autre
     « ID 120246655604620308 » (leads dont l'UTM portait l'identifiant).
     Mêmes créatives, notes ⭐ et closes éparpillés. Résolues contre le
     référentiel, les deux prennent le nom canonique Meta « 6) NEW - été -
     Vision » et fusionnent — et récupèrent au passage leur adset et leur
     campagne, que le champ UTM n'a jamais transportés.

     Ordre : identifiant de pub (certain) → nom de pub (déduit, cf.
     creativeMatchKey) → identifiant propre à l'axe → valeur brute. */
  function axisValueOf(a, axis, IDX) {
    if (!a) return null;
    var nameField = axis === 'campaign' ? 'utm_campaign' : (axis === 'adset' ? 'utm_term' : 'utm_content');
    var idField   = axis === 'campaign' ? 'campaign_id'  : (axis === 'adset' ? 'adset_id' : 'ad_id');
    var name = a[nameField] || '';
    var id   = a[idField] || '';
    var adId = a.ad_id || '';
    var refField = AXIS_NAME_FIELD[axis] || 'ad_name';

    /* Un nom numérique long est un identifiant déguisé. */
    if (name && /^\d{6,}$/.test(name)) { if (!id) id = name; name = ''; }

    if (IDX) {
      /* Publicité connue → ses noms font foi sur les trois axes, même si
         l'UTM portait déjà un libellé : celui de Meta est le bon. */
      var ref = refAdOf(a, IDX);
      if (!ref && id) ref = (axis === 'creative' ? IDX.ad : IDX[axis]) ? (axis === 'creative' ? IDX.ad : IDX[axis])[String(id)] : null;
      if (ref && ref[refField]) {
        return { label: normalizeCreative(ref[refField]), adId: ref.ad_id || adId || '', resolved: true };
      }
    }
    if (name) return { label: normalizeCreative(name), adId: adId || '', resolved: false };
    if (id)   return { label: 'ID ' + id, adId: adId || (axis === 'creative' ? id : ''), resolved: false };
    return null;
  }

  /* ── CLASSIFICATION DES LIBELLÉS LEGACY (taxonomie validée Adrien
        17/08/2026, sur les 8 051 fiches de la base) ──────────────────
     Le champ `utm` historique ne contient presque jamais une créative.
     Relevé réel :
       ·    71 vraies créatives  « 6)NEW-été-Vision », « 15)VSLElite__… »
       ·    96 identifiants Meta « 120246656447370308 »
       ·   158 famille Ads*      « AdsProche|New », « Ads++ »   → CRÉATIVES
       ·   267 audiences         « adv_broad », « interet1 », « LaL » → ADSETS
       · 2 741 canaux / pages    « VSL » (1274), « ACFLIX » (545),
                                 « Webinaire Dimanche » (475), « Lead Skool »…
     Écrire « VSL » dans utm_content ferait passer une page pour une pub :
     1 274 leads sur une ligne « créative » qui n'en est pas une. D'où
     cette classification, appliquée AUSSI BIEN au backfill (ce qu'on
     écrit en base) qu'à l'affichage (ce qu'on lit) — un lead non encore
     backfillé se range donc déjà au bon endroit.

     ⚠ Le défaut est « canal », jamais « créative ». Un libellé inconnu ne
     doit pas être promu en attribution publicitaire : les vraies pubs
     arrivent désormais par le template d'URL Meta, en utm_content propre.
     Retourne { kind: 'ad_id'|'creative'|'adset'|'channel'|'none', value }. */
  /* ⚠ Testés sur la forme REPLIÉE (creativeGroupKey : minuscules, sans
     accents, séparateurs unifiés en espace). L'équipe écrit « interet1 »
     et « intéret2 » — l'accent ne tombe pas au même endroit d'une saisie à
     l'autre, un motif accentué en dur en rate systématiquement une.

     `canon` fusionne les graphies d'une MÊME audience sous un seul libellé.
     Le regroupement par défaut normalise les séparateurs mais ne peut pas
     deviner que « ADVbroad » et « adv_broad » sont la même chose — sans
     canon, deux lignes pour 255 leads. À l'inverse `interet1` / `interet2`
     et `LaL` / `LaL1` sont des audiences DISTINCTES : pas de canon, elles
     doivent rester séparées. */
  var ADSET_PATTERNS = [
    { re: /^adv ?broad/,    canon: 'adv_broad' },  // Advantage+ audience large
    { re: /^interets?\d*$/  },                     // intérêt : interet1, intéret2
    { re: /^lal\d*$/        },                     // lookalike : LaL, LaL1
    { re: /^cbo /           }                      // CBO_chauds
  ];

  function classifyLegacyLabel(raw) {
    var s = normalizeCreative(decodeUtm(raw == null ? '' : raw));
    if (!s || attrIsPlaceholder(s)) return { kind: 'none', value: '' };
    /* Artefacts posés par la plateforme sur elle-même : ils ne disent rien
       de l'origine du lead, seulement de son dernier passage interne.
       ⚠ `DIRECT` n'en fait PAS partie — vérifié avec Adrien le 17/08 : c'est
       le lien de la page Instagram, donc un canal d'acquisition réel, au
       même titre que `link_in_bio` et `insta`. Les trois restent distincts,
       ce sont trois portes d'entrée différentes. */
    var low = s.toLowerCase();
    if (low.indexOf('alteoform') === 0 || low.indexOf('form ') === 0 ||
        low.indexOf('vsl business') === 0 || low.indexOf('vsl élite') === 0 ||
        low.indexOf('vsl elite') === 0 || low.indexOf('booking') === 0 ||
        low === 'test' || low === 'webhook' ||
        low === 'manuel' || low === 'orphan_recovery' || low === 'prospects') {
      return { kind: 'none', value: '' };
    }
    if (/^\d{6,}$/.test(s)) return { kind: 'ad_id', value: s };
    /* « 6)NEW-été-Vision », « 15)VSLElite__Pain-délégation… » : la
       numérotation en tête est la convention de nommage des créatives. Ce
       test passe AVANT tout le reste — « 10)VSL__Gagnerplus… » est une
       créative, pas le canal « VSL ». */
    if (/^\d{1,3}\s*\)/.test(s)) return { kind: 'creative', value: s };
    if (/^ads/i.test(s)) return { kind: 'creative', value: s };   // validé Adrien
    var folded = creativeGroupKey(s);
    for (var i = 0; i < ADSET_PATTERNS.length; i++) {
      if (ADSET_PATTERNS[i].re.test(folded)) {
        return { kind: 'adset', value: ADSET_PATTERNS[i].canon || s };
      }
    }
    return { kind: 'channel', value: s };
  }

  /* Clé d'axe d'un LEAD. Ordre : attribution structurée → querystring
     éventuellement présente dans le champ `utm` → classification du
     libellé legacy.
     `legacy: true` signale une ligne qui repose encore sur le champ `utm`
     (donc potentiellement volée par un titre de formulaire) : le rendu
     l'affiche avec un marqueur plutôt que de la faire passer pour une
     attribution propre.
     Retourne { label, group, adId, legacy }. */
  var UNATTRIB_LABEL = '— non attribué';

  /* Kind attendu par chaque axe. « campaign » se mappe sur lui-même, un kind
     que classifyLegacyLabel n'émet JAMAIS — et c'est voulu : aucune campagne
     n'a jamais transité par le champ `utm`. La version du 17/08 renvoyait
     'creative' ici, et l'axe Campagne affichait donc des publicités
     (« 6)NEW-été-Vision » présenté comme une campagne, alors que les vraies
     campagnes du BM sont « Acquisition | Audiences froides | ELITE » et
     consorts). Un axe vide est honnête ; un axe rempli de la mauvaise chose
     ne l'est pas. */
  function axisKind(ax) {
    if (ax === 'adset') return 'adset';
    if (ax === 'channel') return 'channel';
    if (ax === 'campaign') return 'campaign';
    return 'creative';
  }

  /* ── VISITEUR : lieu et appareil du prospect (23/11/2026) ───────────────
     Bloc `leads/{id}.visiteur` (et `bookings/{id}.visiteur`) :
       { city, region, country, device, os, browser, app, via, at }
     city / region / country : géolocalisation APPROXIMATIVE de Vercel
       (en-têtes x-vercel-ip-*), lue au moment où le NAVIGATEUR du prospect
       appelle Team — aucune adresse IP n'est conservée ;
     device : 'mobile' | 'tablette' | 'ordinateur' ; app : navigateur intégré
       d'une appli ('facebook' | 'instagram' | 'messenger' | 'tiktok' |
       'linkedin' | 'snapchat') ;
     via : 'quiz' | 'tunnel' | 'rdv' | 'signature' (lieu repris de la
       signature du contrat, rattrapage des clients).
     Le premier relevé fait foi : jamais écrasé.
     Lecture : visiteurOf(lead, blocRdv). Sans bloc, l'APPAREIL est déduit du
     navigateur capté à l'opt-in (metaIds.ua, leads depuis le 12/11/2026) —
     calculé à l'affichage, rien d'écrit. Partagé navigateur ↔ serveur
     (api/_visiteur.js). */
  function uaDevice(ua) {
    var u = String(ua || '');
    var out = { device: '', os: '', browser: '', app: '' };
    if (!u) return out;
    if (/Instagram/i.test(u)) out.app = 'instagram';
    else if (/FBAN\/Messenger|MessengerForiOS|FB_IAB\/MESSENGER|MessengerLite/i.test(u)) out.app = 'messenger';
    else if (/FBAN|FBAV|FB_IAB|FBIOS|FB4A/i.test(u)) out.app = 'facebook';
    else if (/musical_ly|BytedanceWebview|TikTok|trill_/i.test(u)) out.app = 'tiktok';
    else if (/LinkedInApp/i.test(u)) out.app = 'linkedin';
    else if (/Snapchat/i.test(u)) out.app = 'snapchat';
    if (/iPad/i.test(u)) { out.os = 'iOS'; out.device = 'tablette'; }
    else if (/iPhone|iPod/i.test(u)) { out.os = 'iOS'; out.device = 'mobile'; }
    else if (/Android/i.test(u)) { out.os = 'Android'; out.device = /Mobile/i.test(u) || out.app ? 'mobile' : 'tablette'; }
    else if (/CrOS/i.test(u)) { out.os = 'ChromeOS'; out.device = 'ordinateur'; }
    else if (/Windows Phone/i.test(u)) { out.os = 'Windows Phone'; out.device = 'mobile'; }
    else if (/Windows/i.test(u)) { out.os = 'Windows'; out.device = 'ordinateur'; }
    else if (/Macintosh|Mac OS X/i.test(u)) { out.os = 'macOS'; out.device = 'ordinateur'; }
    else if (/Linux/i.test(u)) { out.os = 'Linux'; out.device = 'ordinateur'; }
    if (!out.device && /Mobile/i.test(u)) out.device = 'mobile';
    if (out.app) out.browser = '';
    else if (/SamsungBrowser/i.test(u)) out.browser = 'Samsung Internet';
    else if (/Edg(e|A|iOS)?\//i.test(u)) out.browser = 'Edge';
    else if (/OPR\/|Opera/i.test(u)) out.browser = 'Opera';
    else if (/Firefox|FxiOS/i.test(u)) out.browser = 'Firefox';
    else if (/Chrome|CriOS/i.test(u)) out.browser = 'Chrome';
    else if (/Safari/i.test(u)) out.browser = 'Safari';
    return out;
  }

  /* Régions françaises : codes ISO 3166-2 actuels, anciens codes lettres
     (avant 2016) et numéros de département → région. */
  var FR_REGIONS = {
    ARA: 'Auvergne-Rhône-Alpes', BFC: 'Bourgogne-Franche-Comté', BRE: 'Bretagne',
    CVL: 'Centre-Val de Loire', COR: 'Corse', GES: 'Grand Est', HDF: 'Hauts-de-France',
    IDF: 'Île-de-France', NOR: 'Normandie', NAQ: 'Nouvelle-Aquitaine', OCC: 'Occitanie',
    PDL: 'Pays de la Loire', PAC: 'Provence-Alpes-Côte d\'Azur',
    GUA: 'Guadeloupe', MTQ: 'Martinique', GUF: 'Guyane', LRE: 'La Réunion', MAY: 'Mayotte'
  };
  var FR_OLD = { A: 'GES', G: 'GES', M: 'GES', B: 'NAQ', L: 'NAQ', T: 'NAQ', C: 'ARA', V: 'ARA',
    P: 'NOR', Q: 'NOR', D: 'BFC', I: 'BFC', E: 'BRE', F: 'CVL', H: 'COR', J: 'IDF',
    K: 'OCC', N: 'OCC', O: 'HDF', S: 'HDF', R: 'PDL', U: 'PAC', '20R': 'COR', '6AE': 'GES' };
  var FR_DEPTS = {
    ARA: '01 03 07 15 26 38 42 43 63 69 73 74', BFC: '21 25 39 58 70 71 89 90',
    BRE: '22 29 35 56', CVL: '18 28 36 37 41 45', COR: '2A 2B 20', GES: '08 10 51 52 54 55 57 67 68 88',
    HDF: '02 59 60 62 80', IDF: '75 77 78 91 92 93 94 95', NOR: '14 27 50 61 76',
    NAQ: '16 17 19 23 24 33 40 47 64 79 86 87', OCC: '09 11 12 30 31 32 34 46 48 65 66 81 82',
    PDL: '44 49 53 72 85', PAC: '04 05 06 13 83 84',
    GUA: '971', MTQ: '972', GUF: '973', LRE: '974', MAY: '976'
  };
  var DEPT_REGION = (function () {
    var m = {};
    Object.keys(FR_DEPTS).forEach(function (r) { FR_DEPTS[r].split(' ').forEach(function (d) { m[d] = r; }); });
    return m;
  }());
  /* Outre-mer : MaxMind / Vercel les donnent souvent comme PAYS (GP, RE…). */
  var DOM_COUNTRY = { GP: 'GUA', MQ: 'MTQ', GF: 'GUF', RE: 'LRE', YT: 'MAY' };
  var COUNTRIES = {
    FR: 'France', BE: 'Belgique', CH: 'Suisse', LU: 'Luxembourg', MC: 'Monaco', CA: 'Canada',
    MA: 'Maroc', TN: 'Tunisie', DZ: 'Algérie', SN: 'Sénégal', CI: 'Côte d\'Ivoire', CM: 'Cameroun',
    ES: 'Espagne', PT: 'Portugal', IT: 'Italie', DE: 'Allemagne', GB: 'Royaume-Uni', IE: 'Irlande',
    NL: 'Pays-Bas', US: 'États-Unis', AE: 'Émirats arabes unis', IL: 'Israël', MU: 'Maurice',
    PF: 'Polynésie française', NC: 'Nouvelle-Calédonie', PM: 'Saint-Pierre-et-Miquelon',
    BL: 'Saint-Barthélemy', MF: 'Saint-Martin', TH: 'Thaïlande', AD: 'Andorre'
  };
  function countryName(c) { var k = String(c || '').toUpperCase(); return COUNTRIES[k] || k || ''; }
  /* Code région → { code, name } (France), sinon null. */
  function frRegion(country, region) {
    var c = String(country || '').toUpperCase();
    if (DOM_COUNTRY[c]) return { code: DOM_COUNTRY[c], name: FR_REGIONS[DOM_COUNTRY[c]] };
    if (c && c !== 'FR') return null;
    var r = String(region || '').toUpperCase().replace(/^FR-/, '');
    if (!r) return null;
    var code = FR_REGIONS[r] ? r : (FR_OLD[r] || DEPT_REGION[r] || DEPT_REGION[('0' + r).slice(-2)] || '');
    return code ? { code: code, name: FR_REGIONS[code] } : { code: r, name: r };
  }
  /* « Région » lisible d'un bloc : région française, sinon pays. */
  function zoneOf(v) {
    if (!v || !v.country) return '';
    var fr = frRegion(v.country, v.region);
    if (fr) return fr.name;
    var c = String(v.country).toUpperCase();
    return c === 'FR' ? 'France (région inconnue)' : countryName(c);
  }
  function hasGeo(v) { return !!(v && (v.city || v.country)); }
  function hasDevice(v) { return !!(v && v.device); }

  function visiteurOf(l, bkVis) {
    var lv = (l && l.visiteur && typeof l.visiteur === 'object') ? l.visiteur : null;
    var bv = (bkVis && typeof bkVis === 'object') ? bkVis : ((l && l._bkVis) || null);
    var out = { city: '', region: '', country: '', zone: '', device: '', os: '', browser: '', app: '', geoVia: '', deviceVia: '' };
    var g = hasGeo(lv) ? lv : (hasGeo(bv) ? bv : null);
    if (g) {
      out.city = g.city || ''; out.region = g.region || ''; out.country = String(g.country || '').toUpperCase();
      out.zone = zoneOf(g); out.geoVia = g.geoVia || g.via || '';
    }
    var d = hasDevice(lv) ? lv : null;
    if (!d) {
      var ua = l && l.metaIds && l.metaIds.ua;
      if (ua) { d = uaDevice(ua); d.via = 'optin'; if (!d.device) d = null; }
    }
    if (!d && hasDevice(bv)) d = bv;
    if (d) { out.device = d.device || ''; out.os = d.os || ''; out.browser = d.browser || ''; out.app = d.app || ''; out.deviceVia = d.via || ''; }
    return out;
  }
  var APP_LBL = { facebook: 'appli Facebook', instagram: 'appli Instagram', messenger: 'appli Messenger',
    tiktok: 'appli TikTok', linkedin: 'appli LinkedIn', snapchat: 'appli Snapchat' };
  var DEVICE_LBL = { mobile: 'Téléphone', tablette: 'Tablette', ordinateur: 'Ordinateur' };
  /* Libellé court : « Téléphone · iOS · appli Instagram ». */
  function deviceLabel(v) {
    if (!v || !v.device) return '';
    var p = [DEVICE_LBL[v.device] || v.device];
    if (v.os) p.push(v.os);
    if (v.app) p.push(APP_LBL[v.app] || v.app); else if (v.browser) p.push(v.browser);
    return p.join(' · ');
  }
  function placeLabel(v) {
    if (!v || !(v.city || v.country)) return '';
    var z = v.zone || zoneOf(v);
    return [v.city, z].filter(Boolean).join(', ');
  }
  /* Clé des axes « Appareil » et « Région » (Qualité leads, Qualité par pub).
     L'appli intégrée (Facebook / Instagram…) forme sa propre ligne. */
  function visiteurAxisKey(l, ax) {
    var v = visiteurOf(l);
    if (ax === 'device') {
      if (!v.device) return { label: 'Appareil inconnu', group: 'dev:inconnu', adId: '', legacy: false, outOfAds: true };
      var lbl = DEVICE_LBL[v.device] || v.device;
      if (v.app) lbl += ' — ' + (APP_LBL[v.app] || v.app);
      else if (v.device === 'mobile') lbl += ' — navigateur';
      return { label: lbl, group: 'dev:' + v.device + ':' + (v.app || (v.device === 'mobile' ? 'nav' : '')), adId: '', legacy: false };
    }
    if (!v.zone) return { label: 'Lieu inconnu', group: 'geo:inconnu', adId: '', legacy: false, outOfAds: true };
    return { label: v.zone, group: 'geo:' + v.zone.toLowerCase(), adId: '', legacy: false };
  }

  function leadAxisKey(l, axis, IDX) {
    var ax = axis || 'creative';
    if (ax === 'device' || ax === 'region') return visiteurAxisKey(l, ax);
    function mk(label, isLegacy, adId) {
      return { label: label, group: creativeGroupKey(label), adId: adId || '', legacy: !!isLegacy };
    }

    /* 1. Attribution structurée. Le canal a son propre champ : ce n'est pas
       une donnée publicitaire, il n'entre pas dans attrHasSignal. */
    var blk = (l && l.attributionFirst) || (l && l.attributionLast) || null;
    if (ax === 'channel') {
      if (blk && blk.channel) return mk(normalizeCreative(blk.channel), false);
      /* Repli sur utm_source : c'est LE champ qui désigne le canal dans une
         URL taguée. Sans ce repli, un lien partagé à la main
         (?utm_source=messenger) capturait bien son origine mais ne
         s'affichait nulle part — cas d'Aymeric, close du 17/08 venu d'un
         lien Messenger envoyé par Adrien. */
      var aSrc = leadAttribution(l);
      if (aSrc && aSrc.utm_source) return mk(normalizeCreative(aSrc.utm_source), false);
    } else {
      var a = leadAttribution(l);
      var v = a ? axisValueOf(a, ax, IDX) : null;
      if (v && v.label) return mk(v.label, false, v.adId);
    }

    /* 2. Querystring complète stockée dans le champ `utm` : vraie capture. */
    var legacyAttr = parseAttribution(l && l.utm);
    if (legacyAttr && ax !== 'channel') {
      var v2 = axisValueOf(legacyAttr, ax, IDX);
      if (v2 && v2.label) return mk(v2.label, true, v2.adId);
    }

    /* 3. Libellé libre, classé selon la taxonomie. Un libellé ne remonte
       que sur SON axe : « VSL » n'apparaît plus dans les créatives, et
       « adv_broad » plus que dans les adsets. */
    var cl = classifyLegacyLabel(l && l.utm);

    /* 3a. Le libellé désigne-t-il une publicité que le référentiel connaît ?
       Par identifiant, ou par NOM — Meta ayant retiré les espaces en posant
       {{ad.name}} dans l'URL, « 6)NEW-été-Vision » et « 6) NEW - été -
       Vision » sont la même pub. C'est ce rapprochement qui fait remonter
       adset et campagne pour le gros du volume historique, et qui réunit
       sur UNE ligne les leads arrivés par nom et ceux arrivés par
       identifiant. Résolue contre Meta, la ligne n'est plus « legacy ». */
    /* ⚠ Jamais sur l'axe Canal : une publicité n'est pas un canal
       d'acquisition. Sans ce garde, « 6) NEW - été - Vision » remontait
       dans la colonne Canal — la même erreur que l'axe Campagne affichant
       des publicités. Chaque axe ne reçoit que ce qui lui correspond. */
    if ((cl.kind === 'ad_id' || cl.kind === 'creative') && ax !== 'channel') {
      var probe = cl.kind === 'ad_id' ? { ad_id: cl.value } : { utm_content: cl.value };
      var ref = refAdOf(probe, IDX);
      if (ref) {
        var nm = ax === 'adset' ? ref.adset_name
               : (ax === 'campaign' ? ref.campaign_name : ref.ad_name);
        if (nm) return mk(normalizeCreative(nm), false, ref.ad_id || '');
      }
      /* Publicité inconnue du référentiel : un identifiant reste lisible en
         tant que tel sur l'axe créative, mais ne dit rien des deux autres. */
      if (cl.kind === 'ad_id' && ax === 'creative') return mk('ID ' + cl.value, true, cl.value);
    }

    if (cl.kind === axisKind(ax) && cl.kind !== 'channel') {
      return mk(cl.value, true, '');
    }
    if (cl.kind === 'channel' && ax === 'channel') {
      return mk(cl.value, true, '');
    }

    /* Sur l'axe Canal, « — » veut vraiment dire « on ne sait pas ». */
    if (ax === 'channel') return mk('—', true);

    /* Sur les axes publicitaires, en revanche, « — » était trompeur : il
       mettait dans le même seau muet un lead venu d'Instagram, un RDV posé
       par le setting et une fiche réellement vide. Or ces leads n'ont pas
       une créative INCONNUE — ils n'en ont PAS, et c'est une réponse, pas
       une lacune. La ligne porte donc son canal, et se range en bas du
       tableau (outOfAds) pour ne pas concurrencer le classement des pubs. */
    /* ⚠ D'ABORD : ce lead vient-il quand même de la publicité ?
       Un lead peut porter une attribution d'ADSET (« adv_broad ») sans
       jamais avoir eu de créative — l'UTM ne transportait que l'audience.
       La version du 17/08 le rangeait en « Hors pub · réseaux direct » :
       faux sur les deux mots. Sur juillet, cela mettait ~107 leads
       publicitaires dans le seau du direct réseaux, alors que le bandeau
       annonçait 86 % d'attribution publicitaire — la contradiction était à
       l'écran, dans le même tableau.
       Ces leads sont publicitaires ; c'est la créative qui manque, pas la
       pub. Ils restent en bas du tableau (outOfAds) puisqu'ils ne peuvent
       pas concourir au classement des créatives, mais sous leur vrai nom.
       L'axe Adset, lui, les affiche normalement. */
    var lbl;
    /* Publicitaire par l'attribution structurée, OU par le libellé legacy
       (un « adv_broad » jamais backfillé vit encore dans le seul champ utm
       et n'a pas d'attributionFirst — il n'en vient pas moins d'une pub). */
    if (isAdvertisingLead(l)) {
      lbl = ax === 'adset' ? 'Pub · adset non transmis'
          : (ax === 'campaign' ? 'Pub · campagne non transmise'
          : 'Pub · créative non transmise');
    } else {
      var chan = leadAxisKey(l, 'channel', IDX);
      /* Libellé du seau résiduel validé par Adrien le 17/08 : ces leads
         sont en pratique du direct réseaux (message privé, lien de page
         Instagram) — sa lecture métier, confirmée sur les fiches examinées.
         ⚠ Ce n'est pas une mesure : une capture d'UTM qui échouerait demain
         atterrirait ici aussi, sous ce même nom. */
      lbl = (chan && chan.label && chan.label !== '—')
        ? 'Hors pub · ' + chan.label
        : 'Hors pub · réseaux direct';
    }
    return { label: lbl, group: creativeGroupKey(lbl), adId: '', legacy: true, outOfAds: true };
  }

  /* ══ QUALITÉ PAR PUB (12/11/2026, brief « Outil 2 ») ══════════════════
     Qualifié = chiffre d'affaires DÉCLARÉ au quiz ≥ 20 000 €/mois.
     Source, dans l'ordre : quiz.ca_mensuel (quiz Élite via Make → lead-
     optin), réponse « ca » d'un tunnel hébergé (formAnswers / champ ca).
     Renvoie true / false, ou null quand le lead n'a rien déclaré (VSL,
     formulaire sans CA) : il sort alors du dénominateur, jamais compté
     « non qualifié » par défaut. Même règle côté serveur (API Conversions,
     événement LeadQualifie) : api/_metaCapi.js appelle CETTE fonction. */
  var CA_QUALIF_SEUIL = 20000;
  function caAmountsOf(txt) {
    var s = String(txt == null ? '' : txt).toLowerCase()
      .replace(/[\u00a0\u202f]/g, ' ')
      .replace(/(\d)[ .](?=\d{3}\b)/g, '$1');          // 20 000 / 20.000 → 20000
    var out = [], re = /(\d+(?:,\d+)?)\s*(k|m€|m\b|million)?/g, m;
    while ((m = re.exec(s))) {
      var n = parseFloat(m[1].replace(',', '.'));
      if (!isFinite(n)) continue;
      if (m[2] === 'k') n *= 1000;
      else if (m[2]) n *= 1000000;
      out.push(n);
    }
    return { s: s, nums: out };
  }
  function caQualifOfText(txt) {
    var a = caAmountsOf(txt);
    if (!a.s.trim() || !a.nums.length) return null;
    if (/moins|inf[ée]rieur|<|jusqu/.test(a.s)) {
      return Math.max.apply(null, a.nums) <= CA_QUALIF_SEUIL ? false : null;
    }
    return a.nums[0] >= CA_QUALIF_SEUIL;
  }
  function caDeclaredOf(l) {
    if (!l) return '';
    if (l.quiz && l.quiz.ca_mensuel) return String(l.quiz.ca_mensuel);
    var fa = Array.isArray(l.formAnswers) ? l.formAnswers : [];
    for (var i = 0; i < fa.length; i++) {
      var f = fa[i] || {};
      var id = String(f.fieldId || '').toLowerCase();
      var lb = String(f.label || '').toLowerCase();
      if (id === 'ca' || id === 'ca_mensuel' || /chiffre d.?affaires|\bca\b/.test(lb)) {
        if (f.value != null && String(f.value).trim()) return String(f.value);
      }
    }
    return l.ca ? String(l.ca) : '';
  }
  function caQualifOf(l) {
    var t = caDeclaredOf(l);
    return t ? caQualifOfText(t) : null;
  }
  /* Faux numéro / poubelle et disqualifiés : étape du Pipeline (stage). */
  function isFauxNumeroLead(l) { var st = l && l.stage; return st === 'faux_numero' || st === 'poubelle'; }
  function isDisqualifiedLead(l) { var st = l && l.stage; return st === 'disqualification' || st === 'disqualifie_closing'; }
  /* « Jamais joint » : délai laissé au setting avant de conclure. */
  var NEVER_REACHED_MIN_AGE_MS = 48 * 3600000;

  /* ── Dates "réelles" lead — portage ES5 de api/_leadDates.js ── */
  function parseFlexMs(v) {
    if (v == null) return null;
    if (typeof v === 'object') {
      if (typeof v.toMillis === 'function') { try { return v.toMillis(); } catch (e) { return null; } }
      if (typeof v.seconds === 'number') return v.seconds * 1000 + (v.nanoseconds ? Math.floor(v.nanoseconds / 1e6) : 0);
      if (typeof v._seconds === 'number') return v._seconds * 1000 + (v._nanoseconds ? Math.floor(v._nanoseconds / 1e6) : 0);
      /* Date natif — ajouté le 17/08. Les trois formes ci-dessus couvrent
         les Timestamp des deux SDK, mais un Date brut retombait à null : la
         fonction rendait « date inconnue » pour la forme la plus banale du
         langage. Sans conséquence connue en production, où Firestore ne
         renvoie que des Timestamp, mais tout appelant passant un Date se
         serait fait silencieusement ignorer. */
      if (typeof v.getTime === 'function') {
        var t = v.getTime();
        return isNaN(t) ? null : t;
      }
      return null;
    }
    if (typeof v === 'number' && isFinite(v)) return v < 1e12 ? v * 1000 : v;
    if (typeof v !== 'string') return null;
    var s = v.trim();
    if (!s) return null;
    var iso = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/);
    if (iso) {
      /* Fuseau écrit dans le texte (« …Z », « …+02:00 ») : l'instant est donné,
         on le lit tel quel. Avant le 25/11/2026 le « Z » était ignoré et la
         date lue comme une heure locale (1 à 2 h de décalage). */
      if (iso[4] != null && /(?:Z|[+-]\d{2}:?\d{2})$/i.test(s)) {
        var pz = Date.parse(s);
        if (!isNaN(pz)) return pz;
      }
      /* Sans fuseau : c'est une heure de PARIS (import Bigin, date d'un
         prélèvement…), quel que soit le fuseau de l'appareil ou du serveur. */
      var d = SC.dateParis(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0), 0);
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    var fr = s.match(/(\d{1,2})\s+([A-Za-zàâäéèêëïîôöûüç]+)\.?\s+(\d{4})/);
    if (fr) {
      var table = [['janv',0],['févr',1],['fevr',1],['mars',2],['avri',3],['mai',4],['juin',5],['juil',6],['aout',7],['août',7],['sept',8],['octo',9],['nove',10],['déce',11],['dece',11]];
      var mn = fr[2].toLowerCase(); var idx = -1;
      for (var i = 0; i < table.length; i++) { if (mn.indexOf(table[i][0]) === 0) { idx = table[i][1]; break; } }
      if (idx >= 0) { var d2 = SC.dateParis(+fr[3], idx, +fr[1], 0, 0, 0, 0); return isNaN(d2.getTime()) ? null : d2.getTime(); }
    }
    var p = Date.parse(s);
    return isNaN(p) ? null : p;
  }

  function minDef() {
    var best = null;
    for (var i = 0; i < arguments.length; i++) { var m = arguments[i]; if (m != null && (best == null || m < best)) best = m; }
    return best;
  }

  function realEntryMs(d) {
    if (!d) return null;
    return minDef(parseFlexMs(d.dateWebinaire), parseFlexMs(d.importedCreatedAt), parseFlexMs(d.createdAt));
  }

  /* ══ LEADS — quelle fiche compte (audit du 25/11/2026, étape 2) ══
     Une fiche compte comme lead si elle n'est ni fusionnée (_merged : le
     doublon absorbé) ni marquée « fiche de test » (interne === true, posé à
     l'opt-in d'une visite interne). Même test pour les nouveaux leads, les
     ré-optins et tout écran qui compte des leads. */
  function isCountedLead(d) { return !!d && d._merged !== true && d.interne !== true; }
  function isClientLead(l) {
    return !!l && (l.isClient === true || l.stage === 'closed_won_setting' || l.stage === 'closed_won_self');
  }
  /* VRAI ré-optin (règle de Leads Live, déplacée ici pour être la seule) :
     moments (ms) où la personne a réellement rempli un formulaire, hors de sa
     première entrée — engagementHistory[] (archivedFor 'optin' / 'form') et
     lastOptinAt quand il vient d'un vrai formulaire. Ne comptent pas : un
     message entrant, une fiche remontée à la main, une réparation de
     visibilité. Un client qui se réinscrit n'est pas un ré-optin. */
  function optinVrai(l, lo, hist) {
    var i;
    for (i = 0; i < hist.length; i++) if (Math.abs(hist[i] - lo) < 300000) return true;
    function pres(v) { var m = parseFlexMs(v); return m != null && Math.abs(m - lo) < 60000; }
    if (pres(l.lastInboundAt)) return false;                                  // message entrant
    if (pres(l.visibilityResurrectedAt)) return !!l.resurrectedFromMergedTwin; // ré-optin sur un doublon : vrai ; réparation : non
    var src = String(l.lastOptinSource || '');
    if (src === 'manual' || src.indexOf('Remonté') === 0) return false;     // remonté à la main
    return true;
  }
  function trueOptinTimes(l) {
    var out = [];
    if (!l || isClientLead(l)) return out;
    var h = Array.isArray(l.engagementHistory) ? l.engagementHistory : [];
    for (var i = 0; i < h.length; i++) {
      var e = h[i];
      if (!e || (e.archivedFor !== 'optin' && e.archivedFor !== 'form')) continue;
      var m = parseFlexMs(e.archivedAt);
      if (m != null) out.push(m);
    }
    var lo = parseFlexMs(l.lastOptinAt);
    if (lo != null && optinVrai(l, lo, out)) out.push(lo);
    return out;
  }

  /* ── Formats ── */
  function pad2(n) { return SC.pad2(n); }

  /* Clé de jour 'AAAA-MM-JJ' — TOUJOURS à l'heure de Paris (référentiel §7).
     Avant le 25/11/2026 : jour de l'appareil (ou du serveur, en UTC), ce qui
     rangeait un événement de 00 h 30 dans la veille côté serveur. Accepte un
     Date, des millisecondes ou un Timestamp. */
  function isoDate(d) { return SC.jourParis(d); }
  /* Calendrier pur (aucun fuseau) : jour suivant d'une clé 'AAAA-MM-JJ',
     nombre de jours d'un mois (m1 de 1 à 12), liste des jours d'une plage. */
  function jourSuivant(iso) {
    var p = String(iso).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] + 1)).toISOString().slice(0, 10);
  }
  function joursDuMois(y, m1) { return new Date(Date.UTC(y, m1, 0)).getUTCDate(); }
  function joursEntre(aIso, bIso) {
    var out = [], cur = String(aIso), guard = 0;
    while (cur <= bIso && guard++ < 4000) { out.push(cur); cur = jourSuivant(cur); }
    return out;
  }
  function frJour(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[2] + '/' + p[1] + '/' + p[0] : String(iso || '');
  }

  function median(arr) {
    if (!arr || !arr.length) return null;
    var a = arr.slice().sort(function (x, y) { return x - y; });
    var mid = Math.floor(a.length / 2);
    return a.length % 2 ? a[mid] : (a[mid - 1] + a[mid]) / 2;
  }

  function phone9(raw) {
    if (!raw) return null;
    var d = String(raw).replace(/[^\d]/g, '');
    if (d.length < 6) return null;
    return d.length >= 9 ? d.slice(-9) : d;
  }

  /* Tunnel binaire (règle Adrien 07/2026) : il n'existe que DEUX tunnels.
     Un lead est Business si « business » apparaît dans son type, son utm ou
     son sourceDetail — sinon il est Élite. Aucune catégorie « Autres ». */
  /* Pages du beacon page_views_daily : `elite` / `business` = pages d'opt-in
     historiques ; `vsl_elite` / `vsl_business` = VSL à prise de RDV directe
     (23/09/2026). Les secondes ne portent pas d'opt-in : leur conversion est
     le RDV, lu dans bookings.landing (posé par booking.html). */
  /* Pages des tunnels hébergés (admin-tunnels.html, 09/2026) : clé
     `<tunnel>__<etape>`. Elles se mesurent comme une VSL system.io — vues et
     clics par le beacon, RDV par bookings.landing. */
  /* Funnel quiz system.io (28/09/2026) : clé `quiz_elite` / `quiz_business`.
     Questionnaire d'opt-in (lead créé par api/lead-optin.js, qui pose
     landingFirst / landingLast avec via 'optin') puis prise de RDV. Se mesure
     dans la même étape : vues et clics par le beacon, leads par la provenance
     de la fiche, RDV par bookings.landing ou, à défaut, par la fiche du lead. */
  function isVslPage(p) {
    var s = String(p || '');
    return s.indexOf('vsl_') === 0 || s.indexOf('quiz_') === 0 || /^[a-z0-9-]+__[a-z0-9-]+$/.test(s);
  }
  function pageTunnel(p) { return String(p || '').indexOf('business') >= 0 ? 'business' : 'elite'; }

  function leadTunnel(l) {
    var t = (String(l.type || '') + ' ' + String(l.utm || '') + ' ' + String(l.sourceDetail || '')).toLowerCase();
    if (t.indexOf('business') >= 0) return 'business';
    return 'elite';
  }

  /* ── Source de trafic : YouTube vs le reste (10/2026) ──
     Les tunnels réglés « YouTube » (liens placés dans les vidéos) posent
     utm_source=youtube sur toute la chaîne : runtime → RDV → AlteoForms →
     fiche. Lecture d'une fiche, dans l'ordre : attribution premier touch,
     dernier touch, champ utm legacy, canal déclaré, puis la page d'entrée
     (réglage du tunnel, DATA.tunnelsMeta). Tout ce qui n'est pas YouTube
     vaut 'other' (pub Meta, organique, setting…). */
  function isYoutubeSource(v) {
    var s = String(v == null ? '' : v).toLowerCase();
    return s.indexOf('youtube') >= 0 || s === 'yt';
  }
  /* Clé de page de tunnel → 'youtube' | 'other' ; '' si tunnel inconnu. */
  function pageSource(page, meta) {
    var m = String(page || '').match(/^([a-z0-9-]+)__([a-z0-9-]+)$/);
    if (!m || !meta || !meta[m[1]]) return '';
    var t = meta[m[1]], st = t.steps ? t.steps[m[2]] : null;
    return ((st && st.source) || t.source || '') === 'youtube' ? 'youtube' : 'other';
  }
  function attrSourceOf(a) {
    if (!a || typeof a !== 'object') return '';
    if (attrHasSignal(a)) return isYoutubeSource(a.utm_source) ? 'youtube' : 'other';
    if (a.channel) return isYoutubeSource(a.channel) ? 'youtube' : 'other';
    return '';
  }
  function leadSource(l, meta) {
    if (!l) return 'other';
    var s = attrSourceOf(l.attributionFirst) || attrSourceOf(l.attributionLast)
      || attrSourceOf(parseAttribution(l.utm || ''));
    if (s) return s;
    var LF = l.landingFirst;
    return (LF && pageSource(LF.page, meta)) || 'other';
  }
  /* RDV sans fiche rattachable : provenance posée par booking.html. */
  function bookingSource(b, meta) {
    var L = b && b.landing;
    if (!L) return 'other';
    return attrSourceOf(L.attribution) || pageSource(L.page, meta) || 'other';
  }

  /* Date FR 'DD/MM/YYYY' → ms (deals Commissions). */
  function frDateMs(v) {
    var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return parseFlexMs(v);
    var d = SC.dateParis(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0);   /* midi à Paris, quel que soit l'appareil */
    return isNaN(d.getTime()) ? null : d.getTime();
  }


  function effectiveCosts(costs, mKey) {
    var months = costs || {};
    var best = null, bestKey = null;
    Object.keys(months).forEach(function (mk) {
      if (mk <= mKey && (bestKey == null || mk > bestKey)) { bestKey = mk; best = months[mk]; }
    });
    return best ? { fixe: Number(best.fixe) || 0, outils: Number(best.outils) || 0, src: bestKey } : null;
  }


  /* ── Classification d'un booking — règle « deux liens » (Adrien 15/07) :
     Self Booking = le lead prend RDV seul via le lien PUBLIC
       (booking.html?type=call_strat_phenix_all)
     No Booking   = RDV posé par le setting via le lien SETTER
       (booking.html?type=call_strat_phenix_elodie — type marqué
        « RDV setter » / isSetterOnly dans Booking admin)
     → le TYPE prime sur un vieux source 'self_booking' : un RDV historique
       pris sur le lien setter avant que booking.html ne pose le bon source
       est quand même NB. Même règle dans alteore-flow.js (toute la plateforme).
     'excluded' → coaching / csm_manual / clientId / skipLeadCreation
     'admin'    → admin_manual (compté à part, hors LTB)               */
  function classifyBooking(b, TYPE_MAP) { return SC.classifyBooking(b, TYPE_MAP); }


  function loadAds(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    DATA.adsError = null;
    return db.collection('ads_insights').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.ads = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.ads.push(d); });
    }).catch(function (e) { console.warn('[funnel] ads', e.message); DATA.ads = []; DATA.adsError = e.message || 'lecture impossible'; });
  }
  /* Tunnel d'une ligne de dépense ads_insights : 'business', sinon Élite
     (règle UNIQUE : Stats funnel, onglet Données Ads, Qualité leads). Une
     ligne d'un autre tunnel est comptée en Élite — k.adsDocsAutreTunnel le dit. */
  function adsTunnelOf(a) { return a && a.tunnel === 'business' ? 'business' : 'elite'; }

  /* Insights AD-LEVEL — ads_insights_ad/{date}_{ad_id}, alimentés par
     api/ads-metrics-ingest.js quand Make envoie le breakdown par pub.
     C'est la SEULE source possible d'un coût par créative : ads_insights
     est agrégé date × tunnel et ne peut mécaniquement pas ventiler.
     Collection absente / vide → colonnes coût masquées, jamais inventées. */
  function loadAdsByAd(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('ads_insights_ad').where('date', '>=', sIso).where('date', '<=', eIso).get()
      .then(function (snap) {
        DATA.adsByAd = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.adsByAd.push(d); });
      }).catch(function (e) { console.warn('[funnel] adsByAd', e.message); DATA.adsByAd = []; DATA.adsByAdError = e.message || 'lecture impossible'; });
  }

  /* Référentiel créatives — ads_creatives/{ad_id} : { ad_id, ad_name,
     adset_id, adset_name, campaign_id, campaign_name }. Sert à rendre
     lisibles les UTM qui ne portent qu'un identifiant numérique (template
     Meta réglé sur {{ad.id}}). Petite collection → chargée en entier. */
  function loadCreatives(db, DATA) {
    return db.collection('ads_creatives').get().then(function (snap) {
      DATA.creatives = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; if (!d.ad_id) d.ad_id = doc.id; DATA.creatives.push(d); });
    }).catch(function (e) { console.warn('[funnel] creatives', e.message); DATA.creatives = []; DATA.creativesError = e.message || 'lecture impossible'; });
  }

  function loadViews(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('page_views_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.views = [];
      snap.forEach(function (doc) { DATA.views.push(doc.data()); });
    }).catch(function (e) { console.warn('[funnel] views', e.message); DATA.views = []; DATA.viewsError = e.message || 'lecture impossible'; });
  }

  /* Leads "entrés" dans la période = realEntry ∈ [start,end].
     realEntry ≤ createdAt toujours → on requête createdAt ≥ start.
     Borne haute createdAt = end + 45 j (attrape les imports tardifs)
     puis filtrage client-side sur realEntry. Fiches fusionnées et fiches de
     test exclues (isCountedLead).
     Lecture PAR PAGES (audit 25/11/2026) : plus de plafond muet à 6 000 ;
     garde-fou LEADS_QUERY_LIMIT, atteint → DATA.leadsTruncated (dit à
     l'écran). Échec de la lecture des leads : DATA.leadsError est posé PUIS
     la promesse est rejetée (Set NB, Qualité leads s'appuient sur ce rejet) ;
     loadAll, lui, l'attrape pour l'afficher (k.erreursLecture).
     Ré-optins : fiches DÉJÀ connues (entrées avant la période) qui ont
     réellement rempli un formulaire pendant la période — UNE fois par fiche,
     vrai moment d'opt-in exigé (trueOptinTimes : ni message entrant, ni fiche
     remontée à la main), clients exclus. Échec → DATA.reoptinsError. */
  function loadLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var capMs = Math.min(P.end.getTime() + 45 * 86400000, Date.now() + 60000);
    var capTs = tsOf(new Date(capMs));
    var ps = P.start.getTime(), pe = P.end.getTime();
    DATA.leadsTruncated = false; DATA.leadsError = null; DATA.leadsTest = 0;
    DATA.reoptinsTruncated = false; DATA.reoptinsError = null; DATA.reoptinsEcartes = 0;
    var q = db.collection('leads')
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', capTs)
      .orderBy('createdAt', 'asc');
    var pLeads = lirePages(q, LEADS_QUERY_LIMIT).then(function (res) {
      DATA.leadsTruncated = res.truncated;
      var out = [], test = 0;
      res.docs.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        if (d._merged === true) return;
        var re = realEntryMs(d);
        if (re == null || re < ps || re > pe) return;
        if (!isCountedLead(d)) { test++; return; }
        d._entry = re;
        d._tunnel = leadTunnel(d);
        d._p9 = phone9(d.telephone || d.phone);
        out.push(d);
      });
      DATA.leads = out;
      DATA.leadsTest = test;
    }, function (e) {
      console.warn('[funnel] leads', e && e.message);
      DATA.leads = [];
      DATA.leadsError = (e && e.message) || 'lecture impossible';
      throw e;
    });
    var pReopt = lirePages(db.collection('leads')
      .where('lastOptinAt', '>=', tsOf(P.start))
      .where('lastOptinAt', '<=', tsOf(P.end))
      .orderBy('lastOptinAt', 'asc'), REOPTINS_QUERY_LIMIT).then(function (res) {
        DATA.reoptinsTruncated = res.truncated;
        var out = [], ecartes = 0;
        res.docs.forEach(function (doc) {
          var d = doc.data(); d._id = doc.id;
          if (!isCountedLead(d)) return;
          var re = realEntryMs(d);
          if (re != null && re >= ps) return; // déjà dans la cohorte "nouveaux"
          /* Un vrai formulaire rempli pendant la période, sinon ce n'est pas
             un ré-optin (message entrant, remontée à la main, client). */
          var vrai = trueOptinTimes(d).some(function (t) { return t >= ps && t <= pe; });
          if (!vrai) { ecartes++; return; }
          d._entry = re;
          d._tunnel = leadTunnel(d);
          d._p9 = phone9(d.telephone || d.phone);
          out.push(d);
        });
        DATA.reoptins = out;
        DATA.reoptinsEcartes = ecartes;
      }).catch(function (e) {
        console.warn('[funnel] reoptins', e && e.message);
        DATA.reoptins = [];
        DATA.reoptinsError = (e && e.message) || 'lecture impossible';
      });
    return Promise.all([pLeads, pReopt]);
  }

  /* Bookings : 3 requêtes —
     A) créés dans la période (createdAt)  → prise de RDV / LTB / CPR
     B) dont le RDV tombe dans la période (date string) → tenue (kept/annulé/no-show)
     C) créés APRÈS la fenêtre, jusqu'au lookahead → UNIQUEMENT le
        time-to-book des leads de la cohorte (fix censure 15/07). Gardés HORS
        de DATA.bookings/bookingsById : zéro contamination des compteurs
        (LTB, CPR, tenue) ni des chaînes de replanification de la période. */
  function loadBookings(db, P, DATA, TYPE_MAP) {
    var startTs = tsOf(P.start);
    var endTs = tsOf(P.end);
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    var byId = {};
    DATA.bookingsError = null;
    var qA = db.collection('bookings').where('createdAt', '>=', startTs).where('createdAt', '<=', endTs).get();
    var qB = db.collection('bookings').where('date', '>=', sIso).where('date', '<=', eIso).get();
    var laMs = lookaheadEndMsFor(P);
    var qC = laMs > P.end.getTime()
      ? db.collection('bookings').where('createdAt', '>', endTs).where('createdAt', '<=', tsOf(new Date(laMs))).get()
      : Promise.resolve(null);
    return Promise.all([qA, qB, qC]).then(function (res) {
      [res[0], res[1]].forEach(function (snap, idx) {
        snap.forEach(function (doc) {
          var d = byId[doc.id];
          if (!d) { d = doc.data(); d._id = doc.id; d._inCreated = false; d._inDue = false; byId[doc.id] = d; }
          if (idx === 0) d._inCreated = true; else d._inDue = true;
        });
      });
      DATA.bookingsById = {};
      DATA.bookings = Object.keys(byId).map(function (k) {
        var b = byId[k];
        b._class = classifyBooking(b, TYPE_MAP);
        b._p9 = phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
        b._createdMs = parseFlexMs(b.createdAt);
        DATA.bookingsById[b._id] = b;
        return b;
      });
      /* C — RDV post-fenêtre pour le TTB seul. Un RDV déjà chargé par B
         (date dans la période) reste dans DATA.bookings : le passage TTB
         de compute() le rattrape via son _createdMs post-fenêtre. */
      DATA.bookingsTtb = [];
      if (res[2]) res[2].forEach(function (doc) {
        if (byId[doc.id]) return;
        var d = doc.data(); d._id = doc.id;
        d._class = classifyBooking(d, TYPE_MAP);
        d._p9 = phone9(d.prospect && (d.prospect.telephone || d.prospect.phone));
        d._createdMs = parseFlexMs(d.createdAt);
        DATA.bookingsTtb.push(d);
      });
    }).catch(function (e) {
      console.warn('[funnel] bookings', e.message);
      DATA.bookings = []; DATA.bookingsById = {}; DATA.bookingsTtb = [];
      /* Lecture des RDV en échec : dit à l'écran (k.erreursLecture), jamais
         des zéros muets (audit 25/11/2026). */
      DATA.bookingsError = e.message || 'lecture impossible';
    });
  }

  /* Leads devenus CLIENTS dans la période (clientSince) — source de vérité
     des closes QUEL QUE SOIT le chemin : résultat RDV, fiche CRM (stage Won),
     pipeline. Un close fait depuis la fiche, même sans outcome sur le RDV,
     apparaît ici. SB/NB via closed_won_self / closed_won_setting. */
  function loadClosedLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endTs = tsOf(P.end);
    DATA.closedLeadsTruncated = false;
    DATA.closedLeadsError = null;
    return db.collection('leads')
      .where('clientSince', '>=', startTs)
      .where('clientSince', '<=', endTs)
      .limit(CLOSED_LEADS_LIMIT)
      .get().then(function (snap) {
        DATA.closedLeads = [];
        /* Une fiche fusionnée n'est jamais un client : la fiche gardée porte la vente. */
        snap.forEach(function (doc) { var d = doc.data(); if (d._merged === true) return; d._id = doc.id; DATA.closedLeads.push(d); });
        /* Plafond de lecture atteint : dit à l'écran, jamais tu (audit 25/11/2026). */
        DATA.closedLeadsTruncated = snap.size >= CLOSED_LEADS_LIMIT;
      }).catch(function (e) { console.warn('[funnel] closedLeads', e.message); DATA.closedLeads = []; DATA.closedLeadsError = e.message || 'lecture impossible'; });
  }

  /* RDV au résultat « close » des fiches gagnées — le RDV PORTEUR d'un close
     peut être daté hors de la période (RDV du 28/10, close validé le 05/11) :
     il n'est alors pas dans DATA.bookings. On le lit par fiche (quelques
     dizaines de lectures au plus) pour connaître le canal (Self Booking /
     Setting), le closer et le setter du close par la même règle partout.
     → DATA.closeBookings = { leadId: [RDV close…] }

     Correctif du 25/11/2026 : la lecture se fait pour TOUTES les fiches
     gagnées, y compris celles qui ont déjà un RDV « close » dans la période
     chargée. Avant, une fiche à deux RDV closés (28/10 Self Booking, 05/11
     setting) prenait pour porteur celui que la période affichée contenait :
     son canal, son closer et son setter changeaient avec la période choisie.
     Le porteur est désormais le PREMIER RDV closé de la fiche, toujours le
     même. Une lecture en échec est dite (DATA.closeBookingsError). */
  function loadCloseBookings(db, DATA, TYPE_MAP) {
    DATA.closeBookings = {};
    DATA.closeBookingsError = null;
    var ids = {};
    (DATA.closedLeads || []).forEach(function (l) { if (l && l._id) ids[l._id] = 1; });
    (DATA.payments || []).forEach(function (p) {
      var l = p && p._payClose && p._payClose.lead;
      if (l && l._id) ids[l._id] = 1;
    });
    var list = Object.keys(ids);
    if (!list.length) return Promise.resolve();
    return Promise.all(list.map(function (id) {
      return db.collection('bookings').where('leadId', '==', id).get().then(function (snap) {
        snap.forEach(function (doc) {
          var d = doc.data();
          if (d.outcome !== 'close') return;
          d._id = doc.id;
          d._class = classifyBooking(d, TYPE_MAP || {});
          (DATA.closeBookings[id] = DATA.closeBookings[id] || []).push(d);
        });
      }).catch(function (e) {
        console.warn('[funnel] RDV porteur', e.message);
        DATA.closeBookingsError = e.message || 'lecture impossible';
      });
    }));
  }

  /* ══ REVENUE — close annulé, encaissé réel (validé Adrien 13/10/2026) ══
     Règles COMMUNES au Funnel, à SET NB, à Close SB et aux Projections —
     ne jamais les recopier dans une page, appeler FunnelCore.revClient & co.
     · ENCAISSÉ = prélèvements réellement passés : paymentsHistory (statuts
       paid_out / confirmed / paid), daté du jour du prélèvement. Un mandat
       signé sans prélèvement n'est PAS de l'encaissé : il va en
       « à encaisser » (pending).
     · CLOSE ANNULÉ = 0 € encaissé ET (tous les paiements du client annulés
       OU fiche client stoppée — clientStatus 'stopped'). Il sort de tous les
       compteurs (closes, contracté) et s'affiche à part. Un client qui
       arrête après avoir payé reste un close de son mois.
       Fiche stoppée SANS aucun paiement GoCardless : annulé seulement si
       l'arrêt suit le close de moins de 60 jours (formerClientAt) — les
       anciens clients importés, payés hors GoCardless, restent des closes.
     · CONTRACTÉ = totalAmount des paiements non annulés, sinon tarif
       déclaré aux cartes du close (déjà HT).
     Module Paiements en TTC : ÷ 1,2 sauf vatType 'ht'. */
  var REV_PAID_STATUSES = { paid_out: 1, confirmed: 1, paid: 1 };
  var REV_STOP_WINDOW_MS = 60 * 86400000;

  function revHT(p, amount) {
    var a = Number(amount) || 0;
    return p && p.vatType === 'ht' ? a : a / 1.2;
  }

  /* Index des paiements utilisables (brouillons exclus) par fiche / email /
     téléphone. */
  function revIndex(payments) {
    var idx = { byLead: {}, byEmail: {}, byP9: {} };
    (payments || []).forEach(function (p) {
      if (!p || p.status === 'draft') return;
      if (p.leadId) (idx.byLead[p.leadId] = idx.byLead[p.leadId] || []).push(p);
      var em = (p.leadEmail || '').toLowerCase().trim();
      if (em) (idx.byEmail[em] = idx.byEmail[em] || []).push(p);
      var p9 = phone9(p.leadPhone);
      if (p9) (idx.byP9[p9] = idx.byP9[p9] || []).push(p);
    });
    return idx;
  }

  function revPaymentsFor(idx, leadId, email, phone) {
    var seen = {}, out = [];
    function add(arr) {
      (arr || []).forEach(function (p) {
        var key = p._id || p.gcPaymentId || p;
        if (seen[key]) return;
        seen[key] = 1; out.push(p);
      });
    }
    if (leadId) add(idx.byLead[leadId]);
    var em = (email || '').toLowerCase().trim();
    if (em) add(idx.byEmail[em]);
    var p9 = phone9(phone);
    if (p9) add(idx.byP9[p9]);
    return out;
  }

  /* Prélèvements réellement passés d'un paiement : [{ ms, ht }]. Un
     paidAmount supérieur à l'historique (anciens docs) donne un reliquat
     daté du dernier recalage GoCardless (undated: true). */
  function revPaidEntries(p) {
    var out = [], sum = 0;
    var hist = (p && Array.isArray(p.paymentsHistory)) ? p.paymentsHistory : [];
    hist.forEach(function (h) {
      if (!h || (h.status && !REV_PAID_STATUSES[h.status])) return;
      var amt = Number(h.amount) || 0;
      if (amt <= 0) return;
      sum += amt;
      out.push({ ms: parseFlexMs(h.date || h.eventAt), ht: revHT(p, amt) });
    });
    var paid = Number(p && p.paidAmount) || 0;
    if (paid - sum > 0.5) {
      out.push({ ms: parseFlexMs(p.gcLastSyncAt || p.updatedAt || p.createdAt), ht: revHT(p, paid - sum), undated: true });
    }
    return out;
  }

  function revPaidHT(p) {
    var t = 0;
    revPaidEntries(p).forEach(function (e) { t += e.ht; });
    return t;
  }

  /* « PRÉLEVÉ SUR LA PÉRIODE » (glossaire `preleve_periode`) — l'argent
     réellement rentré pendant la période : tous les prélèvements passés dont
     la DATE tombe entre startMs et endMs, TOUS clients (anciens compris),
     hors taxes, brouillons exclus. Ce n'est PAS le « Collecté », qui suit les
     clients gagnés pendant la période, jusqu'à aujourd'hui. Une seule
     fonction pour Qualité leads, Projections et le funnel.
     → { total, lignes: [{ p (le paiement), ht }] } — une ligne par paiement
     ayant au moins un prélèvement dans la période. */
  function cashInPeriod(payments, startMs, endMs) {
    var total = 0, lignes = [];
    (payments || []).forEach(function (p) {
      if (!p || p.status === 'draft') return;
      var amt = 0;
      revPaidEntries(p).forEach(function (e) { if (e.ms != null && e.ms >= startMs && e.ms <= endMs) amt += e.ht; });
      if (amt <= 0.005) return;
      amt = Math.round(amt * 100) / 100;
      total += amt;
      lignes.push({ p: p, ht: amt });
    });
    return { total: Math.round(total * 100) / 100, lignes: lignes };
  }

  /* Bilan d'UN client à partir de SES paiements (déjà rattachés).
     lead = fiche CRM (ou null) · decl = { contracte, collecte } des cartes.
     → { cancelled, reason, paid, con, pending, hasPay, declCol } — HT. */
  function revClient(pays, lead, decl) {
    pays = pays || [];
    var paid = 0, con = 0, pending = 0, nActive = 0;
    pays.forEach(function (p) {
      var ph = revPaidHT(p);
      paid += ph;
      if (p.status === 'cancelled') return;
      nActive++;
      con += revHT(p, p.totalAmount);
      if (ph <= 0) {
        var due1 = p.type === 'installments' ? (Number(p.installmentAmount) || 0) : (Number(p.totalAmount) || 0);
        pending += revHT(p, due1);
      }
    });
    var declCon = decl ? (Number(decl.contracte) || 0) : 0;
    var declCol = decl ? (Number(decl.collecte) || 0) : 0;
    var allCancelled = pays.length > 0 && nActive === 0;
    var stopped = !!lead && lead.clientStatus === 'stopped';
    if (stopped && !pays.length) {
      var sinceMs = parseFlexMs(lead.clientSince), stopMs = parseFlexMs(lead.formerClientAt);
      stopped = sinceMs != null && stopMs != null && stopMs - sinceMs <= REV_STOP_WINDOW_MS;
    }
    if (paid <= 0.005 && (allCancelled || stopped)) {
      return { cancelled: true, reason: allCancelled ? 'paiement annulé' : 'client stoppé', paid: 0, con: 0, pending: 0, hasPay: pays.length > 0, declCol: declCol };
    }
    if (!nActive) con = pays.length ? paid : declCon;   // paiements tous annulés après encaissement : on garde ce qui a été payé
    var r2 = function (n) { return Math.round(n * 100) / 100; };
    return { cancelled: false, reason: null, paid: r2(paid), con: r2(con), pending: r2(pending), hasPay: pays.length > 0, declCol: declCol };
  }

  /* ══ CLOSES — LA LISTE UNIQUE (audit de cohérence du 25/11/2026) ══════════
     Avant : dix règles sous le mot « close » (RDV closé à la date du RDV sur
     les pages équipe, fiche gagnée au funnel, un mélange dans Qualité leads…).
     Désormais TOUS les écrans — Stats funnel, Qualité leads, Set NB, Close SB,
     Global closing, Projections, Dashboard — comptent Closes, Contracté et
     Collecté à partir de CETTE liste. Décision d'Adrien du 25/11/2026 :

       UN CLOSE = UN CLIENT GAGNÉ, compté UNE fois, le JOUR OÙ IL EST GAGNÉ
       (leads.clientSince : signature du contrat ou validation du close).

     Entrent dans la liste :
       ① les fiches dont clientSince tombe dans la période, non fusionnées,
          AVEC un signal de vente : étape closed_won_*, RDV de la fiche au
          résultat close, paiement non annulé rattaché, ou contrat signé.
          closedData seul n'est PAS un signal (il survit à un close corrigé
          en « non close »). Une fiche cliente sans aucun signal n'est pas un
          close : elle sort dans `sansSignal`, nommée à l'écran.
       ② les RDV au résultat close SANS fiche, datés dans la période, dont ni
          l'e-mail ni le téléphone ne sont ceux d'une fiche de ① ;
       ③ les paiements créés dans la période sans fiche gagnée (résolus par
          resolvePaymentLeads), regroupés par client.
     Un paiement n'est rattaché qu'UNE fois ; un paiement qui porte le leadId
     d'une fiche gagnée de la période ne sert jamais une autre fiche (si sa
     fiche n'est pas une fiche gagnée de la période, il suit le client par
     e-mail / téléphone). Les closes annulés (verdict revClient) sortent dans
     `annules`.

     Canal d'un close (Self Booking / Setting) : classe du RDV porteur ; à
     défaut la réponse du closer (closedData.sb) ; à défaut l'étape de la
     fiche ; sinon Setting « canal inconnu ». Closer et setter d'un close :
     une seule chaîne (voir closeurDe / setterDe).

     o = { closedLeads, bookings, closeBookings, payments, typeMap, start, end,
           leadOk(lead), rdvOk(rdv), payCloseOk(pc, paiement),
           resoudrePersonne(personId, rdv) }
     → { rows, annules, sansSignal, ecartsCanal, autres, toutes }
     Une ligne : { key, leadId, name, ms, day, src, signal, sb, canal,
       canalSrc, canalEcart, closer, setter, bookingId, rdvDate, rv, lead } */
  function lowerTrim(v) { return String(v || '').toLowerCase().trim(); }
  function declOfClose(cd) { return cd ? { contracte: Number(cd.contracte) || 0, collecte: Number(cd.collecte) || 0 } : null; }
  function rdvKey(b) { return (b.date || '') + ' ' + (b.time || ''); }

  function buildCloses(o) {
    o = o || {};
    var typeMap = o.typeMap || {};
    var startMs = o.start.getTime(), endMs = o.end.getTime();
    var sIso = SC.jourParis(o.start), eIso = SC.jourParis(o.end);
    var payments = o.payments || [];
    var idx = revIndex(payments);
    payments.forEach(function (p) { if (p) p._matched = false; });

    function clsOf(b) { return b._class || SC.classifyBooking(b, typeMap); }
    /* Fiches gagnées de la période (filtre de l'écran ou non) : chacune
       réclame elle-même les paiements qui portent son identifiant. */
    var ficheGagnee = {};
    (o.closedLeads || []).forEach(function (l) {
      if (!l || l._merged === true || !l._id) return;
      var ms0 = parseFlexMs(l.clientSince);
      if (ms0 == null || ms0 < startMs || ms0 > endMs) return;
      ficheGagnee[l._id] = 1;
    });
    function payListFor(leadId, email, phone) {
      var list = revPaymentsFor(idx, leadId, email, phone).filter(function (p) {
        if (p._matched) return false;
        /* Un paiement rattaché à une AUTRE fiche gagnée de la période lui
           revient : même e-mail ou même téléphone ne suffit pas (deux clients
           qui partagent un numéro ne se prennent pas leurs contrats).
           Correctif du 25/11/2026 : si la fiche du paiement n'est PAS une
           fiche gagnée de la période (doublon jamais passé client, fiche
           fusionnée, RDV closé sans fiche liée), le rapprochement par
           e-mail / téléphone s'applique — c'est la règle de Qualité leads
           (08/11/2026). Sans ce repli, ce paiement n'était compté nulle part
           et le close sortait « sans paiement » alors que le paiement existe. */
        if (p.leadId && p.leadId !== leadId && ficheGagnee[p.leadId]) return false;
        return true;
      });
      list.forEach(function (p) { p._matched = true; });
      return list;
    }
    function release(list) { (list || []).forEach(function (p) { p._matched = false; }); }

    /* RDV au résultat close, par fiche (période + RDV porteurs hors période). */
    var closeRdvByLead = {}, seenRdv = {};
    function addRdv(b) {
      if (!b || b.outcome !== 'close' || !b.leadId) return;
      var id = b._id || b.id;
      if (id) { if (seenRdv[id]) return; seenRdv[id] = 1; }
      (closeRdvByLead[b.leadId] = closeRdvByLead[b.leadId] || []).push(b);
    }
    (o.bookings || []).forEach(addRdv);
    var extra = o.closeBookings || {};
    Object.keys(extra).forEach(function (id) { (extra[id] || []).forEach(addRdv); });
    function carrierOf(leadId) {
      var list = (closeRdvByLead[leadId] || []).filter(function (b) { return clsOf(b) !== 'excluded'; });
      if (!list.length) return null;
      list.sort(function (a, b) { var ka = rdvKey(a), kb = rdvKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
      return list[0];
    }
    function canalDe(carrier, lead, fallbackSb) {
      var cdL = (lead && lead.closedData) || {}, cdB = (carrier && carrier.closeData) || {};
      var declSb = typeof cdL.sb === 'boolean' ? cdL.sb : (typeof cdB.sb === 'boolean' ? cdB.sb : null);
      var cc = carrier ? clsOf(carrier) : null;
      var stage = String((lead && lead.stage) || '');
      var canal, src;
      if (cc === 'self' || cc === 'setter') { canal = cc; src = 'rdv'; }
      else if (declSb !== null) { canal = declSb ? 'self' : 'setter'; src = 'declare'; }
      else if (stage === 'closed_won_self') { canal = 'self'; src = 'etape'; }
      else if (stage === 'closed_won_setting') { canal = 'setter'; src = 'etape'; }
      else if (typeof fallbackSb === 'boolean') { canal = fallbackSb ? 'self' : 'setter'; src = 'etape'; }
      else { canal = 'setter'; src = 'inconnu'; }
      return { canal: canal, src: src, ecart: src === 'rdv' && declSb !== null && declSb !== (canal === 'self') };
    }
    function closeurDe(carrier, lead, pays) {
      var cdL = (lead && lead.closedData) || {}, cdB = (carrier && carrier.closeData) || {};
      if (cdL.closerSlug) return cdL.closerSlug;
      if (cdB.closerSlug) return cdB.closerSlug;
      var host = carrier ? SC.closerDuRdv(carrier, o.resoudrePersonne) : null;
      if (host) return host;
      for (var i = 0; i < (pays || []).length; i++) if (pays[i] && pays[i].closerSlug) return pays[i].closerSlug;
      return null;
    }
    function setterDe(carrier, lead) {
      var cdL = (lead && lead.closedData) || {}, cdB = (carrier && carrier.closeData) || {};
      return cdL.setterSlug || cdB.setterSlug || (lead && lead.setterSlug) || (carrier && carrier.bookedBySlug) || null;
    }

    var rows = [], annules = [], sansSignal = [], ecartsCanal = [], autres = [];
    var seenKey = {}, wonEmail = {}, wonP9 = {};
    function push(row) {
      if (row.rv && row.rv.cancelled) { annules.push(row); return; }
      rows.push(row);
      if (row.canalEcart) ecartsCanal.push(row);
    }

    /* ① Fiches gagnées */
    (o.closedLeads || []).forEach(function (l) {
      if (!l || l._merged === true) return;
      var ms = parseFlexMs(l.clientSince);
      if (ms == null || ms < startMs || ms > endMs) return;
      if (o.leadOk && !o.leadOk(l)) return;
      var key = 'l:' + l._id;
      if (seenKey[key]) return;
      var em = lowerTrim(l.email), tel = l.telephone || l.phone, p9 = phone9(tel);
      var name = l.nom || em || l._id;
      var carrier = carrierOf(l._id);
      var stage = String(l.stage || '');
      var pays = payListFor(l._id, em, tel);
      var activePay = false;
      pays.forEach(function (p) { if (p.status !== 'cancelled') activePay = true; });
      var signal = (stage === 'closed_won_self' || stage === 'closed_won_setting') ? 'etape'
        : carrier ? 'rdv_close'
        : activePay ? 'paiement'
        : l.clientFromSignature === true ? 'signature'
        : (pays.length ? 'paiement' : null);   /* paiements tous annulés : la vente a existé, revClient tranche */
      if (!signal) {
        release(pays);
        sansSignal.push({ key: key, leadId: l._id, name: name, ms: ms, day: SC.jourParis(ms), stage: stage, lead: l });
        return;
      }
      seenKey[key] = 1;
      if (em) wonEmail[em] = 1;
      if (p9) wonP9[p9] = 1;
      var decl = declOfClose(l.closedData) || declOfClose(carrier && carrier.closeData);
      var rv = revClient(pays, l, decl);
      if (!rv.cancelled && l.isClient === false && rv.paid <= 0.005) {
        rv = { cancelled: true, reason: 'retiré des clients', paid: 0, con: 0, pending: 0, hasPay: pays.length > 0, declCol: rv.declCol };
      }
      var cn = canalDe(carrier, l, null);
      push({
        key: key, leadId: l._id, name: name, ms: ms, day: SC.jourParis(ms), src: 'fiche', signal: signal,
        sb: cn.canal === 'self', canal: cn.canal, canalSrc: cn.src, canalEcart: cn.ecart,
        closer: closeurDe(carrier, l, pays), setter: setterDe(carrier, l),
        bookingId: carrier ? (carrier._id || carrier.id || null) : null, rdvDate: carrier ? (carrier.date || '') : '',
        rv: rv, lead: l
      });
    });

    /* ② RDV closés sans fiche */
    (o.bookings || []).forEach(function (b) {
      if (!b || b.outcome !== 'close' || b.leadId) return;
      var cls = clsOf(b);
      if (!SC.estRdvVente(cls)) return;
      if (!b.date || b.date < sIso || b.date > eIso) return;
      if (o.rdvOk && !o.rdvOk(b)) return;
      var bem = lowerTrim(b.prospect && b.prospect.email);
      var btel = b.prospect && (b.prospect.telephone || b.prospect.phone);
      var bp9 = phone9(btel);
      if ((bem && wonEmail[bem]) || (bp9 && wonP9[bp9])) return;      /* déjà compté par sa fiche */
      var key = bem ? 'e:' + bem : bp9 ? 't:' + bp9 : 'b:' + (b._id || b.id);
      if (seenKey[key]) return;
      seenKey[key] = 1;
      if (bem) wonEmail[bem] = 1;
      if (bp9) wonP9[bp9] = 1;
      var pays = payListFor(null, bem, btel);
      var rv = revClient(pays, null, declOfClose(b.closeData));
      var ms = SC.debutMs(b);
      if (isNaN(ms)) ms = SC.debutJourParis(b.date).getTime();
      var cn = canalDe(b, null, null);
      push({
        key: key, leadId: null, name: (b.prospect && b.prospect.nom) || bem || (b._id || b.id), ms: ms, day: b.date, src: 'rdv', signal: 'rdv_close',
        sb: cn.canal === 'self', canal: cn.canal, canalSrc: cn.src, canalEcart: cn.ecart,
        closer: closeurDe(b, null, pays), setter: setterDe(b, null),
        bookingId: b._id || b.id || null, rdvDate: b.date || '', rv: rv, lead: null
      });
    });

    /* ③ Paiements sans fiche gagnée, regroupés par client */
    var groups = {}, order = [];
    payments.forEach(function (p) {
      if (!p || !p._payClose || p._matched) return;
      var pc = p._payClose;
      if (pc.kind === 'other') { autres.push({ name: pc.name, paymentId: p._id || null }); return; }
      if (o.payCloseOk && !o.payCloseOk(pc, p)) return;
      var em = lowerTrim(p.leadEmail), p9 = phone9(p.leadPhone);
      var key = (pc.lead && pc.lead._id) ? 'l:' + pc.lead._id : em ? 'e:' + em : p9 ? 't:' + p9 : 'p:' + (p._id || order.length);
      if (seenKey[key] || (em && wonEmail[em]) || (p9 && wonP9[p9])) return;
      if (!groups[key]) { groups[key] = { key: key, pc: pc, list: [] }; order.push(key); }
      groups[key].list.push(p);
      p._matched = true;
    });
    order.forEach(function (key) {
      var g = groups[key], pc = g.pc, lead = pc.lead || null;
      seenKey[key] = 1;
      var ms = null;
      g.list.forEach(function (p) { var c = parseFlexMs(p.createdAt); if (c != null && (ms == null || c < ms)) ms = c; });
      if (ms == null) ms = startMs;
      var carrier = lead ? carrierOf(lead._id) : null;
      var rv = revClient(g.list, lead, null);
      /* Correctif du 25/11/2026 : pc.sb ne dit rien de plus que l'étape de la
         fiche (déjà lue par canalDe). Le passer en repli faisait écrire
         « canal lu sur l'étape » pour une fiche qui n'est à aucune étape
         gagnée : c'est un canal INCONNU, et il doit le rester. */
      var cn = canalDe(carrier, lead, null);
      push({
        key: key, leadId: lead ? lead._id : null, name: pc.name, ms: ms, day: SC.jourParis(ms), src: 'paiement', signal: 'paiement',
        sb: cn.canal === 'self', canal: cn.canal, canalSrc: cn.src, canalEcart: cn.ecart,
        closer: closeurDe(carrier, lead, g.list), setter: setterDe(carrier, lead),
        bookingId: carrier ? (carrier._id || carrier.id || null) : null, rdvDate: carrier ? (carrier.date || '') : '',
        rv: rv, lead: lead, noLead: !!pc.noLead
      });
    });

    function byDay(a, b) { return a.ms - b.ms; }
    rows.sort(byDay); annules.sort(byDay);
    return { rows: rows, annules: annules, sansSignal: sansSignal, ecartsCanal: ecartsCanal, autres: autres, toutes: rows.concat(annules) };
  }

  /* Totaux d'une liste de lignes de closes (déjà filtrée par l'écran). */
  function sumCloses(rows) {
    var t = { closes: 0, con: 0, paid: 0, pending: 0, sansPaiement: 0 };
    (rows || []).forEach(function (r) {
      if (!r || !r.rv || r.rv.cancelled) return;
      t.closes++; t.con += r.rv.con; t.paid += r.rv.paid; t.pending += r.rv.pending;
      if (!r.rv.hasPay) t.sansPaiement++;
    });
    t.con = Math.round(t.con * 100) / 100; t.paid = Math.round(t.paid * 100) / 100; t.pending = Math.round(t.pending * 100) / 100;
    t.reste = Math.max(0, Math.round((t.con - t.paid) * 100) / 100);
    t.panier = t.closes > 0 ? t.con / t.closes : null;
    t.collecteParClose = t.closes > 0 ? t.paid / t.closes : null;
    return t;
  }

  /* Charge et construit la liste des closes d'une période pour un écran qui
     n'a pas le DATA du funnel (Set NB, Close SB, Global closing, Dashboard…).
     o = { start, end, typeMap, bookings (RDV de la période déjà chargés par la
           page ; lus ici s'ils manquent), resoudrePersonne }
     → Promise de { rows, annules, sansSignal, ecartsCanal, autres, toutes,
                    tronque, erreur } — jamais rejetée : `erreur` dit ce qui a
     manqué (à AFFICHER : un zéro muet n'est pas une réponse). */
  function loadCloses(db, o) {
    o = o || {};
    var P = { start: o.start, end: o.end };
    var D = { bookings: o.bookings || null, payments: [], closedLeads: [], closeBookings: {} };
    var erreurs = [];
    var pBookings = D.bookings ? Promise.resolve() : db.collection('bookings')
      .where('date', '>=', SC.jourParis(o.start)).where('date', '<=', SC.jourParis(o.end)).get()
      .then(function (snap) {
        D.bookings = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; D.bookings.push(d); });
      }).catch(function (e) { D.bookings = []; erreurs.push('RDV : ' + (e.message || 'lecture impossible')); });
    return Promise.all([pBookings, loadClosedLeads(db, P, D), loadPayments(db, D)])
      .then(function () {
        if (D.closedLeadsError) erreurs.push('fiches gagnées : ' + D.closedLeadsError);
        if (D.paymentsError) erreurs.push('paiements : ' + D.paymentsError);
        return resolvePaymentLeads(db, P, D);
      })
      .then(function () { return loadCloseBookings(db, D, o.typeMap || {}); })
      .then(function () {
        if (D.closeBookingsError) erreurs.push('RDV porteurs des closes (canal, closer et setter peuvent manquer) : ' + D.closeBookingsError);
        var res = buildCloses({
          closedLeads: D.closedLeads, bookings: D.bookings, closeBookings: D.closeBookings, payments: D.payments,
          typeMap: o.typeMap || {}, start: o.start, end: o.end, leadOk: o.leadOk, rdvOk: o.rdvOk, payCloseOk: o.payCloseOk,
          resoudrePersonne: o.resoudrePersonne
        });
        res.tronque = !!D.closedLeadsTruncated;
        res.erreur = erreurs.length ? erreurs.join(' · ') : null;
        res.payments = D.payments;
        return res;
      })
      .catch(function (e) {
        return { rows: [], annules: [], sansSignal: [], ecartsCanal: [], autres: [], toutes: [], tronque: false, erreur: (e && e.message) || 'lecture impossible', payments: [] };
      });
  }

  /* MODULE PAIEMENTS (collection payments — GoCardless) : LA vérité du cash
     (validé Adrien 14/07). Chaque doc : totalAmount (contrat TTC),
     paidAmount (encaissé réel à date), paymentsHistory[] (chaque
     prélèvement daté), leadId / leadEmail, closerSlug, status.
     Croisement par client gagné : collecté = prélèvements réellement passés
     (→ HT). Le « collecté déclaré » aux cartes du Close n'y entre JAMAIS
     (règle du 13/10/2026) : un close sans paiement a un collecté à 0 et il
     est signalé « sans paiement ». La collection est petite (dizaines de
     docs) → chargée en entier, croisée côté client. Lecture en échec :
     DATA.paymentsError, dit à l'écran. */
  function loadPayments(db, DATA) {
    DATA.payments = [];
    DATA.paymentsError = null;
    return db.collection('payments').get().then(function (snap) {
      snap.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        DATA.payments.push(d);
      });
    }).catch(function (e) { console.warn('[funnel] payments', e.message); DATA.payments = []; DATA.paymentsError = e.message || 'lecture impossible'; });
  }

  /* Appels : requête étendue jusqu'au lookahead (fin de fenêtre + 14 j,
     plafonné à maintenant) pour que le 1er contact d'un lead entré dans la
     période soit trouvé même s'il a lieu après (fix censure 15/07).
     _inPeriod sépare l'activité de la période (cartes appels / décrochés /
     par closer) du parcours par lead (TTC, joignabilité, tentatives). */
  /* Lecture PAR PAGES (audit 25/11/2026) : la fenêtre va jusqu'à fin + 14 j
     et consommait l'ancien plafond de 5 000 sans le dire. Garde-fou
     CALLS_QUERY_LIMIT atteint → DATA.callsTruncated ; échec → DATA.callsError
     (jamais « zéro appel »). */
  function loadCalls(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endMs = P.end.getTime();
    var endTs = tsOf(new Date(lookaheadEndMsFor(P)));
    DATA.callsTruncated = false;
    DATA.callsError = null;
    return lirePages(db.collection('call_logs')
      .where('initiatedAt', '>=', startTs)
      .where('initiatedAt', '<=', endTs)
      .orderBy('initiatedAt', 'asc'), CALLS_QUERY_LIMIT).then(function (res) {
        DATA.callsTruncated = res.truncated;
        var out = [];
        res.docs.forEach(function (doc) {
          var d = doc.data();
          d._ms = parseFlexMs(d.initiatedAt) || parseFlexMs(d.startTime);
          d._inPeriod = d._ms == null || d._ms <= endMs;
          d._p9 = phone9(d.direction === 'inbound' ? d.fromNumber : d.toNumber);
          out.push(d);
        });
        DATA.calls = out;
      }).catch(function (e) { console.warn('[funnel] calls', e && e.message); DATA.calls = []; DATA.callsError = (e && e.message) || 'lecture impossible'; });
  }

  /* Coûts setting RÉELS — _config/funnel_costs : { months: { 'YYYY-MM':
     { fixe, outils } } }. Une valeur vaut pour son mois ET les suivants
     (report automatique) tant qu'aucune valeur plus récente n'existe.
     Zéro invention : sans entrée couvrant la période → « — » à l'écran. */
  function loadFunnelCosts(db, DATA) {
    return db.collection('_config').doc('funnel_costs').get().then(function (snap) {
      DATA.costs = (snap.exists && snap.data().months) || {};
    }).catch(function (e) { console.warn('[funnel] costs', e.message); DATA.costs = null; DATA.costsError = e.message || 'lecture impossible'; });
  }

  /* Commissions Setting RÉELLES — deals du module Commissions
     (commissions/{slug}/mois/{YYYY-MM} → deals[] de type 'Setting') datés
     dans la fenêtre. Comm + bonus ; deals validés (ok) comme en attente
     d'encaissement — la commission est due dès le close. Membres partis
     inclus (l'historique reste un coût réel). */
  /* LECTEUR FUNNEL (19/11/2026) : le rôle funnel_viewer n'a pas accès aux
     documents commissions/* (paie de chaque membre). Il reçoit les seuls
     montants des deals Setting de la période, calculés côté serveur par CE
     MÊME code (api/funnel-lecture.js). Échec → coût de setting marqué
     indisponible (DATA.settingDealsUnavailable), jamais un 0 silencieux. */
  function loadSettingDealsReader(P, DATA) {
    var u = window.firebase && firebase.auth && firebase.auth().currentUser;
    if (!u) { DATA.settingDealsUnavailable = true; DATA.settingDealsError = 'session absente'; return Promise.resolve(); }
    return u.getIdToken().then(function (tok) {
      return fetch('/api/funnel-lecture?part=setting&start=' + P.start.getTime() + '&end=' + P.end.getTime(),
        { headers: { Authorization: 'Bearer ' + tok } });
    }).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
        /* sb : vrai si le deal paie le setting d'un close Self Booking
           (sous-type 'selfBooking') ; null si la route ne le transmet pas
           encore (compté côté Setting, signalé par k.commSettingSbInconnu). */
        (j.deals || []).forEach(function (d) { DATA.settingDeals.push({ slug: null, comm: Number(d.comm) || 0, ok: d.ok === true, client: '', sb: typeof d.sb === 'boolean' ? d.sb : null }); });
      });
    }).catch(function (e) {
      console.warn('[funnel-core] coût setting (lecteur)', e && e.message);
      DATA.settingDealsUnavailable = true;
      DATA.settingDealsError = (e && e.message) || 'lecture impossible';
    });
  }

  /* Membres lus : tout le roster de rôle sales (setter, setter écrit, closer,
     closer-setter) ET tout ancien membre, quel que soit son rôle — plus de
     prénoms en dur (audit 25/11/2026, décision D10 : la commission d'un
     ancien membre reste un coût réel de sa période). Une lecture en échec
     n'est plus avalée : DATA.settingDealsUnavailable + settingDealsError. */
  function loadSettingDeals(db, P, DATA, TEAM) {
    DATA.settingDeals = [];
    DATA.settingDealsUnavailable = false;
    DATA.settingDealsError = null;
    if (typeof window !== 'undefined' && window.FUNNEL_READONLY === true) return loadSettingDealsReader(P, DATA);
    return Promise.resolve().then(function () {
      var slugs = {};
      (TEAM || []).forEach(function (m) {
        if (m && m.slug && (SALES_ROLES[m.role] || isDeparted(m))) slugs[m.slug] = 1;
      });
      /* ⚠ Fenêtre ÉLARGIE d'un mois de chaque côté (26/07/2026) — depuis le
         décalage des commissions Setting, le deal d'un close de juillet est
         stocké dans le document d'AOÛT (versement M+1), et peut avoir été
         déplacé à la main vers juin. Le filtre qui compte reste `dl.date`
         ∈ période : élargir le balayage ne fait qu'aller CHERCHER le deal là
         où il dort, sans jamais en compter un hors période.
         Sans ça, commSetting — donc le coût setting et le coût / RDV pris NB —
         serait silencieusement sous-évalué. */
      var mks = {};
      /* Mois de Paris (référentiel §7), du mois précédant le début au mois
         suivant la fin. */
      var mkA = SC.moisParis(P.start).split('-'), mkB = SC.moisParis(P.end).split('-');
      var iA = (+mkA[0]) * 12 + (+mkA[1] - 1) - 1, iB = (+mkB[0]) * 12 + (+mkB[1] - 1) + 1;
      for (var iM = iA; iM <= iB; iM++) mks[Math.floor(iM / 12) + '-' + pad2(iM % 12 + 1)] = 1;
      var proms = [];
      Object.keys(slugs).forEach(function (slug) {
        Object.keys(mks).forEach(function (mk) {
          proms.push(db.collection('commissions').doc(slug).collection('mois').doc(mk).get().then(function (snap) {
            if (!snap.exists) return;
            (snap.data().deals || []).forEach(function (dl) {
              if (!dl || dl.type !== 'Setting') return;
              var ms = frDateMs(dl.date);
              if (ms == null || ms < P.start.getTime() || ms > P.end.getTime()) return;
              DATA.settingDeals.push({ slug: slug, comm: (Number(dl.comm) || 0) + (Number(dl.bonus) || 0), ok: dl.ok === true,
                client: dl.client || '', sb: dl.subtype === 'selfBooking' });
            });
          }).catch(function (e) {
            DATA.settingDealsUnavailable = true;
            DATA.settingDealsError = (e && e.message) || 'lecture impossible';
          }));
        });
      });
      return Promise.all(proms);
    });
  }

  /* Chaînes de replanification — un RDV déplacé pointe vers son remplaçant :
     rescheduledToId (report) ou transferredTo (transfert à un autre expert,
     traité comme un report — décision D7). Une seule lecture du lien :
     StatsCore.suivantId. Pour statuer une chaîne créée dans la période il
     faut son RDV TERMINAL, qui peut avoir été créé après la fin de la période
     (absent des 2 requêtes bookings) → on va chercher les chaînons manquants
     un par un (rarissime : quelques docs max). Ils vont dans bookingsById
     UNIQUEMENT (jamais dans les compteurs pris/tenue). */
  /* RDV terminal d'une chaîne : on suit les remplaçants connus (byId) tant
     qu'il y en a. Exporté (FunnelCore.rdvTerminal) : une liste nominative
     doit afficher le résultat du DERNIER RDV de la chaîne, pas le statut du
     premier. */
  function rdvTerminal(b, byId) {
    var cur = b, guard = 0;
    while (cur && guard++ < 10) {
      var nid = SC.suivantId(cur);
      if (!nid) break;
      var nxt = (byId || {})[nid];
      if (!nxt || nxt === cur) break;
      cur = nxt;
    }
    return cur;
  }
  /* Origine d'un RDV compté à sa date : 'reporte' (nouveau créneau d'un RDV
     déplacé ou transféré), 'avant' (posé avant le début de la période),
     'periode', ou 'inconnu' (date de pose absente — jamais rangé « avant »). */
  function origineRdv(b, startMs) {
    if (SC.estRemplacant(b)) return 'reporte';
    var c = (b && b._createdMs != null) ? b._createdMs : parseFlexMs(b && b.createdAt);
    if (c == null) return 'inconnu';
    return c < startMs ? 'avant' : 'periode';
  }

  function resolveChains(db, DATA, TYPE_MAP) {
    function missingTargets() {
      var ids = [];
      Object.keys(DATA.bookingsById).forEach(function (bid) {
        var cur = DATA.bookingsById[bid], guard = 0;
        while (cur && guard++ < 10) {
          var nid = SC.suivantId(cur);
          if (!nid) break;
          var nxt = DATA.bookingsById[nid];
          if (!nxt) { if (ids.indexOf(nid) < 0) ids.push(nid); break; }
          if (nxt === cur) break;
          cur = nxt;
        }
      });
      return ids;
    }
    /* Plus de plafond muet à 20 chaînons par tour (audit 25/11/2026) : tous
       les chaînons manquants sont lus, par lots de 50 ; au-delà de 5 tours
       (chaîne de plus de 5 reports), DATA.chainsTruncated le dit. */
    DATA.chainsTruncated = false;
    function fetchRound(depth) {
      var ids = missingTargets();
      if (!ids.length) return Promise.resolve();
      if (depth > 4) { DATA.chainsTruncated = true; return Promise.resolve(); }
      var lots = [];
      for (var iL = 0; iL < ids.length; iL += 50) lots.push(ids.slice(iL, iL + 50));
      return lots.reduce(function (pr, lot) { return pr.then(function () { return fetchLot(lot); }); }, Promise.resolve())
        .then(function () { return fetchRound(depth + 1); });
    }
    function fetchLot(lot) {
      var proms = lot.map(function (id) {
        return db.collection('bookings').doc(id).get().then(function (snap) {
          if (!snap.exists) return;
          var d = snap.data(); d._id = snap.id; d._inCreated = false; d._inDue = false;
          d._class = classifyBooking(d, TYPE_MAP);
          d._p9 = phone9(d.prospect && (d.prospect.telephone || d.prospect.phone));
          d._createdMs = parseFlexMs(d.createdAt);
          DATA.bookingsById[d._id] = d;
        }).catch(function () {});
      });
      return Promise.all(proms);
    }
    return fetchRound(0);
  }

  /* Paiements de la période SANS client gagné correspondant — règle Adrien
     14/07 : un paiement créé dans la période EST un close commercial, sauf
     s'il rattrape un client déjà gagné dans une autre période. On résout la
     fiche (leadId → email → téléphone) AVANT le calcul :
       · fiche gagnée dans la période      → matchée normalement (rien à faire)
       · fiche gagnée dans une AUTRE période → paiement tardif (diagnostic)
       · fiche jamais gagnée, ou introuvable → close compté via Paiements. */
  function resolvePaymentLeads(db, P, DATA) {
    var ps = P.start.getTime(), pe = P.end.getTime();
    var wonById = {}, wonByEmail = {}, wonByP9 = {};
    (DATA.closedLeads || []).forEach(function (l) {
      wonById[l._id] = 1;
      var em = (l.email || '').toLowerCase().trim();
      if (em) wonByEmail[em] = 1;
      var p9 = phone9(l.telephone || l.phone);
      if (p9) wonByP9[p9] = 1;
    });
    var todo = [];
    (DATA.payments || []).forEach(function (p) {
      p._payClose = null;
      if (!p || p.status === 'cancelled' || p.status === 'draft') return;
      var cms = parseFlexMs(p.createdAt);
      if (cms == null || cms < ps || cms > pe) return;
      var em = (p.leadEmail || '').toLowerCase().trim();
      var p9 = phone9(p.leadPhone);
      if ((p.leadId && wonById[p.leadId]) || (em && wonByEmail[em]) || (p9 && wonByP9[p9])) return;
      todo.push(p);
    });
    if (!todo.length) return Promise.resolve();
    function leadFromSnap(snap) {
      var out = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; if (d._merged !== true) out.push(d); });
      return out;
    }
    function resolveOne(p) {
      var em = (p.leadEmail || '').toLowerCase().trim();
      var p9 = phone9(p.leadPhone);
      var pr;
      if (p.leadId) {
        pr = db.collection('leads').doc(p.leadId).get().then(function (snap) {
          if (!snap.exists) return [];
          var d = snap.data(); d._id = snap.id;
          /* Fiche fusionnée : ce n'est plus un client — on cherche la fiche
             gardée par e-mail puis téléphone (audit 25/11/2026). */
          if (d._merged === true) return [];
          return [d];
        }).catch(function () { return []; });
      } else pr = Promise.resolve([]);
      return pr.then(function (list) {
        if (list.length || !em) return list;
        return db.collection('leads').where('email', '==', em).limit(3).get().then(leadFromSnap).catch(function () { return []; });
      }).then(function (list) {
        if (list.length || !p9) return list;
        return db.collection('leads').where('phoneNormalized', '==', p9).limit(3).get().then(leadFromSnap).catch(function () { return []; });
      }).then(function (list) {
        var name = p.leadName || em || '—';
        if (!list.length) { p._payClose = { kind: 'count', name: name, sb: false, tunnel: null, noLead: true }; return; }
        var l = list[0];
        var since = parseFlexMs(l.clientSince);
        var isWon = l.isClient === true || since != null || String(l.stage || '').indexOf('closed_won') === 0;
        if (isWon && (since == null || since < ps || since > pe)) {
          p._payClose = { kind: 'other', name: l.nom || name };
        } else {
          p._payClose = { kind: 'count', name: l.nom || name, sb: l.stage === 'closed_won_self', tunnel: leadTunnel(l), noLead: false, lead: l };
        }
      }).catch(function () { p._payClose = null; });
    }
    return Promise.all(todo.map(resolveOne));
  }

  function loadJournalPeriod(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('marketing_journal').where('date', '>=', sIso).where('date', '<=', eIso).orderBy('date', 'desc').limit(120).get().then(function (snap) {
      DATA.journalPeriod = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.journalPeriod.push(d); });
    }).catch(function (e) { console.warn('[funnel] journal periode', e.message); DATA.journalPeriod = []; });
  }

  /* Journal d'actions (lead_actions/{slug}/items — refonte 07/2026).
     Une requête par membre du roster, ANCIENS MEMBRES ET ADMINS COMPRIS
     (audit 25/11/2026, décisions D10 / D14) : « Leads travaillés » de
     l'équipe = fiches distinctes, quelle que soit la personne ; l'activité
     d'un ancien membre reste dans le total. Plus aucun prénom en dur. Chaque
     action porte `_slug` (le membre dont c'est le journal). Une lecture en
     échec est dite (DATA.actionsError), jamais un zéro muet. */
  /* JOUR D'UNE ACTION du journal (revue D08) — la règle de Set NB, reprise
     telle quelle : jour de PARIS de son horodatage serveur (createdAt) ; repli
     sur le champ `day` stocké si createdAt manque. Les actions écrites avant
     le 25/11/2026 portent dans `day` le jour de l'APPAREIL (une action posée
     depuis Montréal le 31/10 à 20 h 30 est le 01/11 à Paris), et `day` vient
     de l'horloge du navigateur. Set NB, le Stats funnel, Qualité leads et
     Pilotage rangent donc une action au même jour. */
  function jourAction(a) {
    if (!a) return '';
    var v = a.createdAt, ms = null;
    if (v) {
      if (typeof v.toMillis === 'function') ms = v.toMillis();
      else { var t = SC.toDate(v).getTime(); ms = isNaN(t) ? null : t; }
    }
    return ms != null ? SC.jourParis(ms) : (a.day || '');
  }
  function jourPrecedent(iso) {
    var p = String(iso).split('-');
    return new Date(Date.UTC(+p[0], +p[1] - 1, +p[2] - 1)).toISOString().slice(0, 10);
  }
  function loadActionsAll(db, P, DATA, TEAM) {
    DATA.actions = [];
    DATA.actionsError = null;
    return Promise.resolve().then(function () {
      var seen = {};
      var members = (TEAM || []).filter(function (m) {
        if (!m || !m.slug || seen[m.slug]) return false;
        seen[m.slug] = 1;
        return true;
      });
      var sIso = isoDate(P.start), eIso = isoDate(P.end);
      /* Lu de J−1 à J+1 (le `day` stocké peut différer d'un jour du jour de
         Paris), puis rangé au jour de Paris de chaque action (jourAction) :
         rien de perdu, rien de compté hors période. */
      var qFrom = jourPrecedent(sIso), qTo = jourSuivant(eIso);
      var proms = members.map(function (m) {
        return db.collection('lead_actions').doc(m.slug).collection('items')
          .where('day', '>=', qFrom).where('day', '<=', qTo).get()
          .then(function (snap) {
            snap.forEach(function (doc) {
              var d = doc.data(); d._id = doc.id; d._slug = m.slug;
              d._jour = jourAction(d);
              if (d._jour < sIso || d._jour > eIso) return;
              DATA.actions.push(d);
            });
          }).catch(function (e) { DATA.actionsError = (e && e.message) || 'lecture impossible'; });
      });
      return Promise.all(proms);
    });
  }

  /* Leads travaillés (journal d'actions) — décomposition unique, la même
     pour Set NB et le Stats funnel :
       team    = fiches DISTINCTES contactées pour la première fois sur la
                 période (firstTouch : 1ʳᵉ action de toute l'équipe)
       bySlug  = { slug: fiches dont c'est la 1ʳᵉ action de CE membre
                   (firstTouchMember) } — l'onglet d'un setter
       sommeOnglets = Σ bySlug ; reprisParUnAutre = sommeOnglets − team
                 (fiches déjà contactées par un autre membre, avant ou
                 pendant la période)
     keep(a) facultatif : ne garder que certaines actions (filtre tunnel). */
  function leadsWorked(actions, keep) {
    var teamIds = {}, team = 0, bySlug = {}, memberIds = {}, somme = 0;
    (actions || []).forEach(function (a) {
      if (!a || (keep && !keep(a))) return;
      var id = a.leadId || a._id;
      if (a.firstTouch && !teamIds[id]) { teamIds[id] = 1; team++; }
      if (a.firstTouchMember && a._slug) {
        var k2 = a._slug + '|' + id;
        if (!memberIds[k2]) { memberIds[k2] = 1; bySlug[a._slug] = (bySlug[a._slug] || 0) + 1; somme++; }
      }
    });
    return { team: team, bySlug: bySlug, sommeOnglets: somme, reprisParUnAutre: Math.max(0, somme - team), leadIds: teamIds };
  }

  /* Leads NB reçus — UNE règle (Set NB, Stats funnel) : leads entrés sur la
     période qui n'ont AUCUN RDV Self Booking parmi les RDV fournis
     (rattachement fiche → téléphone → e-mail), rangés chez le setter de la
     fiche (setterSlug, sinon assignedTo, sinon null = « Non attribué »).
     → [{ lead, self, setter, jour, travaille, parSonSetter, rdvSetter }]
     pour TOUS les leads fournis : recus = ceux dont self est faux.
     travaille = une action enregistrée sur la fiche (firstActionAt) ;
     parSonSetter = son setter y a agi (firstActionAtBy[setter]) ;
     rdvSetter = un RDV du setting (classe 'setter') existe pour la fiche. */
  function leadsNbRecus(leads, bookings, typeMap) {
    var sbId = {}, sbP9 = {}, sbEm = {}, stId = {}, stP9 = {}, stEm = {};
    (bookings || []).forEach(function (b) {
      if (!b) return;
      var cls = b._class || SC.classifyBooking(b, typeMap || {});
      if (cls !== 'self' && cls !== 'setter') return;
      var p9 = b._p9 || phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
      var em = lowerTrim(b.prospect && b.prospect.email);
      var I = cls === 'self' ? [sbId, sbP9, sbEm] : [stId, stP9, stEm];
      if (b.leadId) I[0][b.leadId] = 1;
      if (p9) I[1][p9] = 1;
      if (em) I[2][em] = 1;
    });
    return (leads || []).map(function (l) {
      var p9 = l._p9 || phone9(l.telephone || l.phone), em = lowerTrim(l.email);
      var self = !!(sbId[l._id] || (p9 && sbP9[p9]) || (em && sbEm[em]));
      var setter = l.setterSlug || l.assignedTo || null;
      var by = l.firstActionAtBy || {};
      return { lead: l, self: self, setter: setter, jour: l._entry != null ? isoDate(l._entry) : null,
        travaille: !!l.firstActionAt, parSonSetter: !!(setter && by[setter]),
        rdvSetter: !!(stId[l._id] || (p9 && stP9[p9]) || (em && stEm[em])) };
    });
  }

  /* Statistiques d'appels — UNE définition des compteurs et des durées
     (Set NB, Stats funnel, Pilotage, assistant) :
       out = sortants · answered = sortants décrochés (StatsCore.estDecroche)
       talkSec = Σ durée de conversation des sortants décrochés
       inbound / inboundAnswered / inboundTalkSec = la même chose en entrant. */
  function callStats(calls) {
    var o = { out: 0, answered: 0, talkSec: 0, inbound: 0, inboundAnswered: 0, inboundTalkSec: 0 };
    (calls || []).forEach(function (c) {
      if (!c) return;
      var ans = isAnsweredCall(c), sec = Number(c.durationSec) || 0;
      if (c.direction === 'outbound') { o.out++; if (ans) { o.answered++; o.talkSec += sec; } }
      else if (c.direction === 'inbound') { o.inbound++; if (ans) { o.inboundAnswered++; o.inboundTalkSec += sec; } }
    });
    return o;
  }

  /* Auteur d'un appel — UNE règle : userId du call_log → membre du roster
     (firebaseUid), sinon prénom du nom Ringover. → { key, slug, name, sales,
     departed } ou null (« appel sans auteur »). sales = rôle de l'équipe sales
     (setters, closers, admins) ; un ancien membre garde son rôle (son
     activité passée reste dans l'équipe) mais departed est vrai : jamais de
     nom affiché pour lui. L'index est calculé une fois par liste. */
  function firstTok(s) {
    var v = String(s || '');
    try { v = v.normalize('NFD').replace(/[\u0300-\u036F]/g, ''); } catch (e) { /* vieux Safari */ }
    return v.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').trim().split(' ')[0];
  }
  function callerIndex(TEAM) {
    var byUid = {}, byFirst = {};
    (TEAM || []).forEach(function (m) {
      if (!m) return;
      var who = { key: m.slug || m.firebaseUid, slug: m.slug || null,
        name: m.shortName || m.displayName || m.fullName || m.slug,
        sales: !!SALES_CALL_ROLES[m.role], departed: isDeparted(m) };
      if (m.firebaseUid) byUid[m.firebaseUid] = who;
      var f = firstTok(m.shortName || m.displayName || m.fullName);
      if (f && !byFirst[f]) byFirst[f] = who;
    });
    return { byUid: byUid, byFirst: byFirst };
  }
  function callerOf(c, TEAMorIdx) {
    var idx = (TEAMorIdx && TEAMorIdx.byUid) ? TEAMorIdx : callerIndex(TEAMorIdx);
    if (!c) return null;
    if (c.userId && idx.byUid[c.userId]) return idx.byUid[c.userId];
    var f = firstTok(c.userName || c.ringoverUserName);
    return (f && idx.byFirst[f]) || null;
  }
  /* PÉRIMÈTRE « ÉQUIPE SALES » D'UN APPEL — LE prédicat du Stats funnel
     (revue D17), à utiliser tel quel par Set NB (onglet Équipe), le
     Dashboard, Pilotage et l'assistant :
       'sales'       auteur de l'équipe sales (setters, closers, admins —
                     anciens membres compris : leur activité passée reste)
       'sans_auteur' poste relié à aucun compte (ni userId connu, ni prénom
                     Ringover reconnu) : COMPTÉ, ligne « Non attribué »
       'hors'        auteur d'un autre rôle (CSM, coach) : hors des Appels et
                     des Décrochés, affiché à part (« Hors équipe sales »)
     Auteur = callerOf (userId → firebaseUid, sinon prénom Ringover).
     TEAMouIndex = roster COMPLET (anciens membres compris) ou callerIndex(). */
  function perimetreAppel(c, TEAMouIndex) {
    var who = callerOf(c, TEAMouIndex);
    return !who ? 'sans_auteur' : (who.sales ? 'sales' : 'hors');
  }
  /* Vrai si l'appel compte dans les chiffres d'appels de l'équipe (Appels,
     Décrochés, temps d'appel) : 'sales' ou 'sans_auteur'. */
  function appelEquipeSales(c, TEAMouIndex) { return perimetreAppel(c, TEAMouIndex) !== 'hors'; }

  /* Parcours de contact d'un lead — UNE règle (funnel, Qualité par pub,
     onglet Leads) : appels SORTANTS de l'équipe vers son numéro, passés
     entre son entrée et 14 jours après (même plafond que Pilotage).
     appels = [{ ms, ans, who }] → { appele, joint, nbAppels, nbDecroches,
     delai (ms jusqu'au 1er appel, ou null), auteur (who du 1er appel) }. */
  function leadContact(l, appels) {
    var o = { appele: false, joint: false, nbAppels: 0, nbDecroches: 0, delai: null, auteur: null };
    if (!l || l._entry == null) return o;
    var fin = l._entry + CONTACT_WINDOW_MS;
    (appels || []).forEach(function (a) {
      if (!a || a.ms == null || a.ms < l._entry || a.ms > fin) return;
      o.nbAppels++;
      if (a.ans) o.nbDecroches++;
      var d = a.ms - l._entry;
      if (o.delai == null || d < o.delai) { o.delai = d; o.auteur = a.who || null; }
    });
    o.appele = o.nbAppels > 0;
    o.joint = o.nbDecroches > 0;
    return o;
  }

  /* ════════════════════════════════════════════════════════════════
     COMPUTE — agrège tout selon le filtre tunnel
     ════════════════════════════════════════════════════════════════ */
  function computeKpis(ctx) {
    var DATA = ctx.DATA, P = ctx.P, tunnelFilter = ctx.tunnelFilter;
    /* Roster : celui de la page + le roster COMPLET relu par loadAll (anciens
       membres compris, décision D10). */
    var TEAM = mergeTeam(ctx.teamMembers || [], DATA.teamFull || []);
    /* Hôte d'un RDV → membre (closer d'un close par son RDV porteur) : le
       résolveur de la page s'il est fourni, sinon celui du chargement
       (fiches d'agenda + roster, revue D13) — le même que Close SB, Global
       closing, Qualité leads et l'assistant. */
    var resoudreHote = typeof ctx.resoudrePersonne === 'function' ? ctx.resoudrePersonne : resoudreAvec(DATA.persons || {}, TEAM);
    function tunnelMatch(t) { return tunnelFilter === 'all' || t === tunnelFilter; }
    /* Filtre Source (10/2026) : 'all' | 'youtube' | 'other' — se cumule au
       filtre tunnel partout où celui-ci s'applique. Absent (API agence) =
       'all' : calcul strictement inchangé. La dépense Ads est de la pub
       Meta : elle n'entre jamais dans la vue YouTube. */
    var sourceFilter = (ctx.sourceFilter === 'youtube' || ctx.sourceFilter === 'other') ? ctx.sourceFilter : 'all';
    var TMETA = DATA.tunnelsMeta || {};
    function srcMatch(s) { return sourceFilter === 'all' || (sourceFilter === 'youtube' ? s === 'youtube' : s !== 'youtube'); }
    function leadSrc(l) { if (l._source == null) l._source = leadSource(l, TMETA); return l._source; }
    function leadMatch(l) { return tunnelMatch(l._tunnel) && srcMatch(leadSrc(l)); }
    function pageMatch(p) { return tunnelMatch(pageTunnel(p)) && srcMatch(pageSource(p, TMETA) || 'other'); }
    var adsInSource = sourceFilter !== 'youtube';
    function lookaheadEndMs() { return lookaheadEndMsFor(P); }

    var k = {};
    /* « Maintenant » : UN instant pour tout le calcul — c'est lui qui sépare
       « à statuer » (créneau terminé) de « à venir ». ctx.now (millisecondes)
       permet de rejouer un calcul à heure fixe (tests). */
    var NOW = (typeof ctx.now === 'number' && isFinite(ctx.now)) ? ctx.now : Date.now();
    /* Exposé (revue D27) : une liste cliquable ouverte plus tard relit l'état
       d'un RDV (SC.libelle / etat) avec CE « maintenant », pas Date.now() —
       sinon un RDV compté « À venir » s'afficherait « À statuer ». */
    k.now = NOW;
    var laEnd = lookaheadEndMsFor(P); // borne des parcours par lead (TTC/TTB/SMS/joignabilité)

    /* Lectures en échec ou tronquées : dites à l'écran, jamais un zéro muet
       (référentiel P7). La page affiche chaque texte tel quel. */
    k.closedLeadsTruncated = !!DATA.closedLeadsTruncated;
    k.erreursLecture = [];
    if (DATA.bookingsError) k.erreursLecture.push('Lecture des RDV impossible (' + DATA.bookingsError + ') : RDV, Présents, Pitchés et RDV pris sont à zéro ou incomplets.');
    if (DATA.closedLeadsError) k.erreursLecture.push('Lecture des fiches gagnées impossible (' + DATA.closedLeadsError + ') : Closes, Contracté et Collecté sont incomplets.');
    if (DATA.paymentsError) k.erreursLecture.push('Lecture du module Paiements impossible (' + DATA.paymentsError + ') : le Contracté affiché est le tarif déclaré au close, le Collecté est à 0 et les closes repérés par le seul paiement manquent.');
    if (DATA.chainsTruncated) k.erreursLecture.push('Certaines chaînes de reports ont plus de 5 RDV successifs : le résultat de leur dernier RDV peut manquer (RDV pris).');
    if (DATA.personsError && typeof ctx.resoudrePersonne !== 'function') k.erreursLecture.push('Lecture des fiches d’agenda impossible (' + DATA.personsError + ') : le closer d’un RDV ou d’un close sans closer validé peut manquer (« Non attribué »).');
    if (DATA.closeBookingsError) k.erreursLecture.push('Lecture des RDV porteurs des closes impossible (' + DATA.closeBookingsError + ') : le canal (Self Booking / Setting), le closer ou le setter de certains closes peuvent manquer.');
    if (k.closedLeadsTruncated) k.erreursLecture.push('Liste des clients gagnés tronquée : la période contient plus de ' + CLOSED_LEADS_LIMIT + ' fiches gagnées. Réduis la période pour un total exact.');
    /* Étape 2 : leads, ré-optins, appels, dépense, équipe, journal, coûts. */
    k.leadsTruncated = !!DATA.leadsTruncated;
    k.reoptinsTruncated = !!DATA.reoptinsTruncated;
    k.callsTruncated = !!DATA.callsTruncated;
    k.partiel = { leads: k.leadsTruncated || !!DATA.leadsError, reoptins: k.reoptinsTruncated || !!DATA.reoptinsError,
      calls: k.callsTruncated || !!DATA.callsError, closed: k.closedLeadsTruncated || !!DATA.closedLeadsError,
      ads: !!DATA.adsError, team: !!DATA.teamError, actions: !!DATA.actionsError,
      commissions: !!(DATA.settingDealsUnavailable || DATA.settingDealsError) };
    if (DATA.leadsError) k.erreursLecture.push('Lecture des leads impossible (' + DATA.leadsError + ') : Leads, LTB, CPL et tout ce qui se calcule par lead sont à zéro ou incomplets.');
    if (k.leadsTruncated) k.erreursLecture.push('Liste des leads tronquée à ' + LEADS_QUERY_LIMIT + ' fiches : Leads, LTB et CPL sont sous-estimés. Réduis la période.');
    if (DATA.reoptinsError) k.erreursLecture.push('Lecture des ré-optins impossible (' + DATA.reoptinsError + ') : Ré-optins à zéro.');
    if (k.reoptinsTruncated) k.erreursLecture.push('Liste des ré-optins tronquée à ' + REOPTINS_QUERY_LIMIT + ' fiches : Ré-optins sous-estimés. Réduis la période.');
    if (DATA.callsError) k.erreursLecture.push('Lecture des appels impossible (' + DATA.callsError + ') : Appels, Décrochés et Lead to speech ne sont pas affichables.');
    if (k.callsTruncated) k.erreursLecture.push('Liste des appels tronquée à ' + CALLS_QUERY_LIMIT + ' appels : Appels et Décrochés sont sous-estimés. Réduis la période.');
    if (DATA.adsError) k.erreursLecture.push('Lecture de la dépense pub impossible (' + DATA.adsError + ') : Dépense, CPL, CPR, CAC et ROAS pub ne sont pas fiables.');
    if (DATA.adsByAdError) k.erreursLecture.push('Lecture de la dépense par pub impossible (' + DATA.adsByAdError + ') : coûts par créative masqués.');
    if (DATA.viewsError) k.erreursLecture.push('Lecture des visites des pages impossible (' + DATA.viewsError + ') : Vues et taux d’opt-in à zéro.');
    if (DATA.creativesError) k.erreursLecture.push('Lecture du référentiel des pubs impossible (' + DATA.creativesError + ') : certaines pubs restent affichées par leur identifiant.');
    if (DATA.costsError) k.erreursLecture.push('Lecture des coûts du setting impossible (' + DATA.costsError + ') : Coût setting et Coût / RDV pris NB non affichables.');
    if (DATA.settingDealsError) k.erreursLecture.push('Lecture des commissions de setting impossible (' + DATA.settingDealsError + ') : le coût du setting est incomplet.');
    if (DATA.actionsError) k.erreursLecture.push('Lecture du journal d’actions impossible pour au moins un membre (' + DATA.actionsError + ') : Leads travaillés et statuts Set incomplets.');
    if (DATA.teamError && !(ctx.teamMembers && ctx.teamMembers.length)) k.erreursLecture.push('Lecture de l’équipe impossible (' + DATA.teamError + ') : appels et Lead to speech ne sont pas rangés par personne.');

    /* ── Index leads (cohorte + ré-optins) ── */
    var leadsById = {}, leadsByP9 = {}, leadsByEmail = {};
    function idxLead(l, inCohort) {
      l._inCohort = inCohort;
      leadsById[l._id] = l;
      if (l._p9 && !leadsByP9[l._p9]) leadsByP9[l._p9] = l;
      var em = (l.email || '').toLowerCase().trim();
      if (em && !leadsByEmail[em]) leadsByEmail[em] = l;
    }
    DATA.leads.forEach(function (l) { idxLead(l, true); });
    DATA.reoptins.forEach(function (l) { idxLead(l, false); });

    var cohort = DATA.leads.filter(function (l) { return leadMatch(l); });
    var reopt  = DATA.reoptins.filter(function (l) { return leadMatch(l); });

    /* Leads = fiches entrées (fusionnées et fiches de test exclues) ;
       ré-optins = fiches déjà connues réinscrites par un VRAI formulaire,
       une fois par fiche (loadLeads). Les deux restent séparés. */
    k.leads = cohort.length;
    k.reoptins = reopt.length;
    k.leadsTest = DATA.leadsTest || 0;              /* fiches de test écartées (interne === true) */
    k.reoptinsEcartes = DATA.reoptinsEcartes || 0;  /* lastOptinAt sans vrai formulaire (message, remontée à la main, client) */
    k.leadsByTunnel = { elite: 0, business: 0 };
    DATA.leads.forEach(function (l) { if (srcMatch(leadSrc(l))) k.leadsByTunnel[l._tunnel]++; });
    /* Leads venus de la PUBLICITÉ (attribution du premier contact) — base du
       « CPL pub » : la dépense pub n'achète que ceux-là. */
    k.leadsAds = cohort.filter(function (l) { return isAdvertisingLead(l); }).length;

    /* ── Ads (ads_insights : LA source de la « Dépense pub ») ── */
    var ads = DATA.ads.filter(function (a) { return adsInSource && tunnelMatch(adsTunnelOf(a)); });
    k.spend = 0; k.impressions = 0; k.clicks = 0; k.leadsFb = 0;
    /* Couverture en JOURS DISTINCTS (une ligne = un jour × un tunnel : la
       compter comme un jour gonflait « N jour(s) de data »). Attendus : du
       début de la période jusqu'à HIER (la dépense d'un jour n'arrive que le
       lendemain), heure de Paris. */
    var adsDates = {}, adsDatesAttendus = 0, adsDatesCouverts = 0;
    k.adsDocsAutreTunnel = 0;
    ads.forEach(function (a) {
      k.spend += Number(a.spend) || 0;
      k.impressions += Number(a.impressions) || 0;
      k.clicks += Number(a.clicks) || 0;
      k.leadsFb += Number(a.leads) || 0;
      if (a.tunnel && a.tunnel !== 'business' && a.tunnel !== 'elite') k.adsDocsAutreTunnel++;
      if (a.date && ((Number(a.spend) || 0) > 0 || (Number(a.impressions) || 0) > 0)) adsDates[a.date] = 1;
    });
    k.adsDays = Object.keys(adsDates).length;
    var hierIso = isoDate(NOW - 86400000);
    var finAttenduIso = isoDate(P.end) < hierIso ? isoDate(P.end) : hierIso;
    if (isoDate(P.start) <= finAttenduIso) {
      joursEntre(isoDate(P.start), finAttenduIso).forEach(function (j) { adsDatesAttendus++; if (adsDates[j]) adsDatesCouverts++; });
    }
    k.adsDaysExpected = adsDatesAttendus;      /* jours attendus (jusqu'à hier) */
    k.adsDaysCovered = adsDatesCouverts;       /* dont jours reçus */
    /* Dépense complète : tous les jours attendus reçus ; période d'aujourd'hui
       seulement → complète s'il y a de la donnée. */
    k.adsSpendOk = adsDatesAttendus > 0 ? adsDatesCouverts >= adsDatesAttendus : k.adsDays > 0;
    k.hasAds = k.spend > 0 || k.impressions > 0 || k.clicks > 0;
    k.cpm = k.impressions > 0 ? k.spend / k.impressions * 1000 : null;
    k.ctr = k.impressions > 0 ? k.clicks / k.impressions * 100 : null;
    k.cpc = k.clicks > 0 ? k.spend / k.clicks : null;
    /* CPL pub = dépense pub ÷ leads venus de la pub (k.leadsAds) — LE coût
       par lead. k.cpl (dépense ÷ TOUS les leads, organiques compris) reste
       pour la sous-ligne « en comptant aussi les leads hors pub ». */
    k.cplAds = k.leadsAds > 0 && k.spend > 0 ? k.spend / k.leadsAds : null;
    k.cpl = k.leads > 0 && k.spend > 0 ? k.spend / k.leads : null;

    /* ── Vues opt-in (beacon) ── */
    var views = DATA.views.filter(function (v) {
      if (isVslPage(v.page)) return false;   // VSL : étape dédiée, pas d'opt-in
      return pageMatch(v.page);
    });
    k.views = 0;
    var pagesVues = {};
    views.forEach(function (v) { k.views += Number(v.views) || 0; if (v.page) pagesVues[v.page] = 1; });
    /* Taux d'opt-in réel = leads entrés PAR une des pages comptées dans les
       vues ÷ ces vues (même périmètre en haut et en bas : plus jamais un taux
       au-dessus de 100 % parce que des leads venus d'ailleurs s'y ajoutent). */
    k.optinLeads = cohort.filter(function (l) { var L = l.landingFirst; return !!(L && L.page && pagesVues[L.page]); }).length;
    k.optinReal = k.views > 0 ? k.optinLeads / k.views * 100 : null;
    /* Leads ÷ clics Meta (toutes pages, tous leads) — un autre ratio. */
    k.optinClicks = k.clicks > 0 ? k.leads / k.clicks * 100 : null;

    /* A/B tests opt-in — agrégation par page × variante (docs beacon
       page_views_daily avec champ variant). Affiché si ≥ 2 variantes. */
    var abByPage = {};
    DATA.views.forEach(function (v) {
      if (!v.variant || isVslPage(v.page)) return;
      if (!pageMatch(v.page)) return;
      var pg = v.page || 'other';
      if (!abByPage[pg]) abByPage[pg] = {};
      if (!abByPage[pg][v.variant]) abByPage[pg][v.variant] = { variant: v.variant, views: 0, optins: 0 };
      abByPage[pg][v.variant].views += Number(v.views) || 0;
      abByPage[pg][v.variant].optins += Number(v.optins) || 0;
    });
    k.abTests = [];
    Object.keys(abByPage).forEach(function (pg) {
      var vars = Object.keys(abByPage[pg]).map(function (kk) { return abByPage[pg][kk]; });
      if (vars.length < 2) return;
      vars.sort(function (a, b) { return a.variant < b.variant ? -1 : 1; });
      k.abTests.push({ page: pg, variants: vars });
    });

    /* ── Bookings — tunnel via lead (leadId → phone → email) ── */
    function bookingLead(b) {
      if (b.leadId && leadsById[b.leadId]) return leadsById[b.leadId];
      if (b._p9 && leadsByP9[b._p9]) return leadsByP9[b._p9];
      var em = (b.prospect && b.prospect.email || '').toLowerCase().trim();
      if (em && leadsByEmail[em]) return leadsByEmail[em];
      return null;
    }
    function bookingMatches(b) {
      if (tunnelFilter === 'all' && sourceFilter === 'all') return true;
      var l = bookingLead(b);
      if (l) return leadMatch(l);
      /* RDV sans fiche rattachable : exclu par le filtre tunnel (inchangé) ;
         le filtre Source lit la provenance posée sur le RDV lui-même. */
      if (tunnelFilter !== 'all') return false;
      return srcMatch(bookingSource(b, TMETA));
    }

    /* ══ CLOSES — LA LISTE UNIQUE (FunnelCore.buildCloses, décision D1) ══
       Construite ICI, une fois, avec les filtres de l'écran : tout ce qui
       parle de closes plus bas (héro, montants, créatives, taux, contrôle de
       cohérence, tableau des pages) lit cette liste — aucun autre compte. */
    var CL = buildCloses({
      closedLeads: DATA.closedLeads || [], bookings: DATA.bookings || [], closeBookings: DATA.closeBookings || {},
      payments: DATA.payments || [], typeMap: ctx.typeMap || {}, start: P.start, end: P.end,
      leadOk: function (l) { return tunnelMatch(leadTunnel(l)) && srcMatch(leadSource(l, TMETA)); },
      rdvOk: bookingMatches,
      payCloseOk: function (pc) {
        if (pc.tunnel && !tunnelMatch(pc.tunnel)) return false;
        if (!pc.tunnel && tunnelFilter !== 'all') return false;
        return srcMatch(pc.lead ? leadSource(pc.lead, TMETA) : 'other');
      },
      resoudrePersonne: resoudreHote
    });
    /* Closes annulés, par fiche et par RDV porteur : un RDV closé dont le
       close est annulé ne compte nulle part comme une vente. */
    var annuleParFiche = {}, annuleParRdv = {};
    CL.annules.forEach(function (r) {
      if (r.leadId) annuleParFiche[r.leadId] = 1;
      if (r.bookingId) annuleParRdv[r.bookingId] = 1;
    });
    function closeAnnuleDe(b) { return !!(b && ((b.leadId && annuleParFiche[b.leadId]) || annuleParRdv[b._id || b.id])); }

    /* ══ AXE « CRÉATION » — RDV pris pendant la période (référentiel §2) ══
       Population : Self Booking + Setting (StatsCore.estRdvPris) — un RDV créé
       à la main dans l'Agenda n'est ni pris par le prospect ni posé par un
       setter. Tête de chaîne : ni remplaçant (report OU transfert d'expert :
       la prise a été comptée à la création du premier RDV), ni doublon
       supprimé (compté nulle part). */
    function teteDeChaine(b) { return !SC.estRemplacant(b) && !SC.estDoublon(b); }
    function chainTerminal(b) { return rdvTerminal(b, DATA.bookingsById); }
    var created = DATA.bookings.filter(function (b) { return b._inCreated && b._class !== 'excluded' && bookingMatches(b); });
    var createdFunnelAll = created.filter(function (b) { return SC.estRdvPris(b._class); });
    var createdFunnel = createdFunnelAll.filter(teteDeChaine);
    k.booked = createdFunnel.length;
    k.bookedSelf = createdFunnel.filter(function (b) { return b._class === 'self'; }).length;
    k.bookedSetter = k.booked - k.bookedSelf;
    k.bookedAdmin = created.filter(function (b) { return b._class === 'admin' && teteDeChaine(b); }).length;
    k.rescheduledCreated = createdFunnelAll.filter(function (b) { return SC.estRemplacant(b) && !SC.estDoublon(b); }).length;
    k.duplicatesCreated = createdFunnelAll.filter(function (b) { return SC.estDoublon(b); }).length;
    /* RDV pris par tunnel Élite / Business (demande head of sales 14/07) —
       calculé sur TOUS les tunnels comme leadsByTunnel, via le lead du RDV.
       k.bookedNoTunnel : RDV pris dont la fiche n'est pas dans les leads
       chargés (lead plus ancien, ou RDV sans fiche) — sans filtre de tunnel,
       Élite + Business + sans tunnel = RDV pris. */
    k.bookedByTunnel = { elite: 0, business: 0 };
    k.bookedNoTunnel = 0;
    DATA.bookings.forEach(function (b) {
      if (!b._inCreated || !SC.estRdvPris(b._class) || !teteDeChaine(b)) return;
      var lbt = bookingLead(b);
      if (lbt) { if (k.bookedByTunnel[lbt._tunnel] != null && srcMatch(leadSrc(lbt))) k.bookedByTunnel[lbt._tunnel]++; }
      else if (srcMatch(bookingSource(b, TMETA))) k.bookedNoTunnel++;
    });
    /* ── VSL à prise de RDV directe (23/09/2026) ──
       Vues et clics « Réserver » : beacon (page_views_daily, pages vsl_*).
       RDV : bookings.landing posé par booking.html — même périmètre que
       « RDV pris » (créés sur la période, self + setter, replanifications
       exclues). Ventilé par page × variante pour l'A/B test. Un RDV sans
       bloc landing n'est compté nulle part ici : plancher, jamais estimé. */
    k.vslViews = 0; k.vslCtas = 0; k.vslBookings = 0; k.vslLeads = 0;
    var vslByPage = {};
    /* Libellés lisibles des pages de tunnel (pageLabel posé par le beacon). */
    k.vslLabels = {};
    k.vslVarLabels = {};
    function vslCell(pg, vr) {
      if (!vslByPage[pg]) vslByPage[pg] = {};
      if (!vslByPage[pg][vr]) vslByPage[pg][vr] = { variant: vr, views: 0, ctas: 0, leads: 0, present: 0, rdvCloses: 0, bookings: 0, closes: 0, con: 0, col: 0 };
      return vslByPage[pg][vr];
    }
    /* Provenance d'un RDV : le bloc landing posé par booking.html (paramètre
       lp). À défaut, la page d'entrée de la fiche du lead quand elle a été
       posée à l'opt-in (via 'optin' — funnel quiz) : le lead existait avant
       le RDV, sa provenance est un fait, pas une estimation. Un RDV pris par
       le setter ou depuis l'e-mail reste ainsi rattaché au tunnel qui a
       produit le lead. Une provenance posée au RDV (via 'booking') n'est
       jamais réutilisée : elle appartient à un autre RDV. */
    function bookingLanding(b) {
      if (b.landing && b.landing.page) return b.landing;
      var l = bookingLead(b);
      var LF = l && l.landingFirst;
      if (LF && LF.page && LF.via === 'optin') return LF;
      return null;
    }
    /* Leads entrés par une page à conversion RDV directe — seul le funnel
       quiz en produit (la VSL n'a pas d'opt-in). Nouveaux : page d'entrée ;
       ré-opt-ins : dernière page. */
    function countVslLead(L) {
      if (!L || !L.page || L.via !== 'optin') return;
      if (!isVslPage(L.page) || !pageMatch(L.page)) return;
      vslCell(L.page, L.variant || '_').leads++;
      k.vslLeads++;
    }
    cohort.forEach(function (l) { countVslLead(l.landingFirst); });
    reopt.forEach(function (l) { countVslLead(l.landingLast); });
    DATA.views.forEach(function (v) {
      if (!isVslPage(v.page) || !pageMatch(v.page)) return;
      var c = vslCell(v.page, v.variant || '_');
      if (v.pageLabel && !k.vslLabels[v.page]) k.vslLabels[v.page] = String(v.pageLabel);
      if (v.variant && v.variantLabel) { if (!k.vslVarLabels[v.page]) k.vslVarLabels[v.page] = {}; k.vslVarLabels[v.page][String(v.variant)] = String(v.variantLabel); }
      c.views += Number(v.views) || 0;
      c.ctas += Number(v.ctas) || 0;
      k.vslViews += Number(v.views) || 0;
      k.vslCtas += Number(v.ctas) || 0;
    });
    DATA.bookings.forEach(function (b) {
      if (!b._inCreated || !SC.estRdvPris(b._class) || !teteDeChaine(b)) return;
      var L = bookingLanding(b);
      if (!L || !isVslPage(L.page) || !pageMatch(L.page)) return;
      var cell = vslCell(L.page, L.variant || '_');
      cell.bookings++;
      k.vslBookings++;
      /* Tenue : statuée par le RDV terminal de la chaîne (un report ne compte
         ni deux RDV, ni un RDV perdu) — règles StatsCore. `rdvCloses` = RDV
         closés de ces RDV pris (un RDV closé dont le close est annulé n'y est
         pas compté) : ce n'est PAS « Closes ». */
      var term = chainTerminal(b);
      if (SC.estPresent(term)) cell.present++;
      if (SC.detail(term) === 'close' && !closeAnnuleDe(term)) cell.rdvCloses++;
    });
    /* Closes / Contracté / Collecté par page = LA LISTE UNIQUE (audit
       25/11/2026, étape 2) : chaque client gagné sur la période est rangé sur
       la page d'où il vient — page du RDV porteur (bloc landing posé par
       booking.html), sinon page d'entrée de sa fiche à l'opt-in. Un close
       sans page connue n'est rangé nulle part : k.vslClosesNonRattaches.
       Pages + non rattachés = Closes. */
    var closeBkById = {};
    Object.keys(DATA.closeBookings || {}).forEach(function (lid) {
      (DATA.closeBookings[lid] || []).forEach(function (cb) { if (cb && cb._id) closeBkById[cb._id] = cb; });
    });
    function pageDuClose(r) {
      var b = r.bookingId ? ((DATA.bookingsById || {})[r.bookingId] || closeBkById[r.bookingId] || null) : null;
      if (b && b.landing && b.landing.page) return b.landing;
      var LF = r.lead && r.lead.landingFirst;
      if (LF && LF.page && LF.via === 'optin') return LF;
      return null;
    }
    k.vslClosesNonRattaches = 0;
    CL.rows.forEach(function (r) {
      var L = pageDuClose(r);
      if (!L || !isVslPage(L.page) || !pageMatch(L.page)) { k.vslClosesNonRattaches++; return; }
      var cell = vslCell(L.page, L.variant || '_');
      cell.closes++;
      cell.con += (r.rv && r.rv.con) || 0;
      cell.col += (r.rv && r.rv.paid) || 0;
    });
    /* ── Lecture par tunnel › page › variante (28/09/2026) ──
       Seules les pages hébergées (clé tunnel__etape) entrent dans la vue
       générale et les totaux. Les clés System.io (vsl_*, quiz_*) sont
       rangées à part dans k.vslLegacy : historique, affiché sur demande. */
    var META = DATA.tunnelsMeta || {};
    function isTunnelKey(pg) { return /^[a-z0-9-]+__[a-z0-9-]+$/.test(String(pg || '')); }
    var ZERO = ['views', 'ctas', 'leads', 'bookings', 'present', 'rdvCloses', 'closes', 'con', 'col'];
    function zero(o) { ZERO.forEach(function (f) { o[f] = 0; }); return o; }
    function addTo(o, c) { ZERO.forEach(function (f) { o[f] += c[f] || 0; }); }
    var byFunnel = {};
    k.vslLegacy = []; k.vslPages = []; k.vslTests = [];
    Object.keys(vslByPage).sort().forEach(function (pg) {
      var vars = Object.keys(vslByPage[pg]).map(function (kk) { return vslByPage[pg][kk]; });
      vars.sort(function (a, b) { return a.variant < b.variant ? -1 : 1; });
      var tot = zero({ page: pg });
      vars.forEach(function (c) { addTo(tot, c); });
      if (!isTunnelKey(pg)) { tot.label = k.vslLabels[pg] || ''; k.vslLegacy.push(tot); return; }
      k.vslPages.push(tot);
      var parts = pg.split('__'), tslug = parts[0], sslug = parts[1];
      var m = META[tslug] || null, ms = m && m.steps ? m.steps[sslug] : null;
      /* Site vitrine et pages communes : hébergés pareil, mais pas des tunnels
         de conversion — hors de cette étape et de ses totaux. */
      if (m && m.kind && m.kind !== 'funnel') return;
      var lbl = String(k.vslLabels[pg] || ''), lblParts = lbl.split(' · ');
      if (!byFunnel[tslug]) byFunnel[tslug] = zero({ slug: tslug, name: (m && m.name) || lblParts[0] || tslug, kind: m ? m.kind : 'funnel', steps: [] });
      var f = byFunnel[tslug];
      /* order : rang de la page dans le parcours (Admin → Tunnels) ;
         orphan : adresse absente du tunnel (page renommée ou supprimée) —
         ses leads et RDV restent comptés, la page les range à part. */
      var step = zero({ page: pg, slug: sslug, name: (ms && ms.name) || lblParts[1] || sslug, type: ms ? ms.type : '', variants: [],
        order: ms && ms.order != null ? ms.order : 9999, orphan: !!m && !ms });
      addTo(step, tot);
      vars.forEach(function (c) {
        var mv = ms && ms.variants ? ms.variants[c.variant] : null;
        var vl = (mv && mv.label) || (k.vslVarLabels[pg] && k.vslVarLabels[pg][c.variant]) || '';
        var row = zero({ id: c.variant, label: vl, weight: mv ? mv.weight : null, status: mv ? mv.status : '' });
        addTo(row, c);
        step.variants.push(row);
      });
      f.steps.push(step);
      addTo(f, tot);
      var named = step.variants.filter(function (c) { return c.id !== '_'; });
      if (named.length >= 2) k.vslTests.push({ page: pg, variants: named });
    });
    k.vslFunnels = Object.keys(byFunnel).map(function (kk) { return byFunnel[kk]; });
    k.vslFunnels.forEach(function (f) {
      f.steps.sort(function (a, b) { return (a.order - b.order) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0); });
    });
    k.vslFunnels.sort(function (a, b) { return a.name < b.name ? -1 : 1; });
    var all = zero({});
    k.vslFunnels.forEach(function (f) { addTo(all, f); });
    k.vslViews = all.views; k.vslCtas = all.ctas; k.vslLeads = all.leads; k.vslBookings = all.bookings;
    k.vslPresent = all.present;
    k.vslCloses = all.closes;          /* closes de la liste unique rangés sur une page de tunnel */
    k.vslRdvCloses = all.rdvCloses;    /* RDV closés des RDV pris depuis ces pages */
    k.vslContracte = Math.round(all.con * 100) / 100;
    k.vslCollecte = Math.round(all.col * 100) / 100;
    /* Closes rangés sur une page hors des tunnels de conversion (anciennes
       pages System.io, site vitrine) : Pages des tunnels + autres pages +
       non rattachés = Closes. */
    k.vslClosesAutresPages = Math.max(0, CL.rows.length - k.vslClosesNonRattaches - all.closes);
    var legacyAll = zero({});
    k.vslLegacy.forEach(function (c) { addTo(legacyAll, c); });
    k.vslLegacyTotals = legacyAll;
    k.vslActive = k.vslViews > 0 || k.vslBookings > 0 || k.vslLeads > 0 || k.vslLegacy.length > 0;
    k.vslCtaRate = k.vslViews > 0 ? k.vslCtas / k.vslViews * 100 : null;
    k.vslBookRate = k.vslViews > 0 ? k.vslBookings / k.vslViews * 100 : null;
    k.vslCpr = k.spend > 0 && k.vslBookings > 0 ? k.spend / k.vslBookings : null;

    k.selfShare = k.booked > 0 ? k.bookedSelf / k.booked * 100 : null;
    k.setterShare = k.booked > 0 ? k.bookedSetter / k.booked * 100 : null;
    k.ltb = k.leads > 0 ? k.booked / k.leads * 100 : null;
    /* (k.cpr — dépense ÷ RDV pris — retiré le 25/11/2026 : aucun écran ne
       l'affichait, et un calcul sans écran finit réutilisé sous un mauvais
       nom. Les « CPR » affichés sont k.cprSB / cprKept / cprLive / cprOffre.) */

    var setterOld = 0, unknownLeadBookings = 0;
    /* TTB — 1er RDV de chaque lead cohorte depuis son entrée (min par lead).
       TTB séparés self / setting (audit 14/07 : la médiane globale était
       écrasée par les self-bookings pris en quelques minutes). */
    function applyTtb(b) {
      var l = bookingLead(b);
      if (!l || !l._inCohort) return;
      var ms = b._createdMs;
      if (ms != null && l._entry != null && ms >= l._entry) {
        if (l._ttb == null || ms - l._entry < l._ttb) l._ttb = ms - l._entry;
        if (b._class === 'self') { if (l._ttbSelf == null || ms - l._entry < l._ttbSelf) l._ttbSelf = ms - l._entry; }
        else if (l._ttbSet == null || ms - l._entry < l._ttbSet) l._ttbSet = ms - l._entry;
      }
      l._bk = l._bk || [];
      /* computeKpis est relancé à chaque changement de filtre sur le même DATA :
         ne jamais empiler deux fois le même RDV. */
      if (l._bk.indexOf(b) < 0) l._bk.push(b);
    }
    /* Récupération / TTB : dédupliqué par lead → on garde TOUS les RDV créés
       (replanifications incluses) pour ne pas perdre le marquage SB/NB du lead. */
    createdFunnelAll.forEach(function (b) {
      var l = bookingLead(b);
      /* Compté sur les têtes de chaîne seulement : le chiffre égale alors
         orgSB.old + orgNB.old (« leads plus anciens »), plus jamais un RDV de
         report en trop. */
      if (!l) { if (teteDeChaine(b)) unknownLeadBookings++; return; }
      if (!l._inCohort) { if (b._class === 'setter') setterOld++; return; }
      applyTtb(b);
    });
    /* RDV créés APRÈS la fenêtre (≤ lookahead) — fix censure 15/07 : un lead
       entré en fin de fenêtre qui booke le lendemain a un time-to-book.
       Ne touche QUE _ttb/_ttbSelf/_ttbSet et la colonne RDV du détail leads —
       récupération, LTB, CPR et tenue restent strictement sur la période. */
    (DATA.bookingsTtb || [])
      .concat(DATA.bookings.filter(function (b) {
        return !b._inCreated && b._createdMs != null && b._createdMs > P.end.getTime() && b._createdMs <= laEnd;
      }))
      .forEach(function (b) {
        if (!SC.estRdvPris(b._class)) return;
        if (!bookingMatches(b)) return;
        applyTtb(b);
      });
    /* Leads NB reçus — LA règle de Set NB (FunnelCore.leadsNbRecus) : lead
       entré sans RDV Self Booking parmi les RDV chargés (créés OU datés sur
       la période), rattachement fiche → téléphone → e-mail. Taux de
       récupération = leads NB reçus ayant un RDV du setting ÷ leads NB reçus. */
    var NBR = leadsNbRecus(cohort, DATA.bookings || [], ctx.typeMap || {});
    var nbrSelf = {};
    var cohortSelf = 0, cohortSetter = 0, nbTrav = 0;
    NBR.forEach(function (x) {
      if (x.self) { cohortSelf++; nbrSelf[x.lead._id] = 1; return; }
      if (x.rdvSetter) cohortSetter++;
      if (x.travaille) nbTrav++;
    });
    k.cohortSelf = cohortSelf;                  /* leads entrés ayant un RDV Self Booking */
    k.cohortSetter = cohortSetter;              /* leads NB reçus ayant un RDV du setting */
    k.leadsNbRecus = k.leads - cohortSelf;      /* = colonne « Leads NB reçus » de Set NB, onglet Équipe */
    k.leadsNbRecusTravailles = nbTrav;
    k.leadsNbRecusNonTravailles = k.leadsNbRecus - nbTrav;
    k.recovery = k.leadsNbRecus > 0 ? cohortSetter / k.leadsNbRecus * 100 : null;
    k.setterOldLeads = setterOld;
    k.unknownLeadBookings = unknownLeadBookings;

    /* ══ TENUE — RDV dont la DATE tombe dans la période (référentiel §2) ══
       Population : RDV de vente (StatsCore.estRdvVente) — Self Booking,
       Setting ET RDV créés à la main dans l'Agenda (« Manuels », décision
       D12). Un RDV n'a qu'UN état (StatsCore.etat : le résultat saisi fait
       foi, le statut ne sert que de repli), donc les colonnes s'additionnent :
         RDV = annulés + no-show + présents + à statuer + à venir
         (replanifiés et doublons supprimés hors RDV)
         Kept = RDV − annulés (le no-show reste dedans)
         Show-up = présents ÷ (Kept − à venir)
       Aucun prédicat local : tout vient de StatsCore.compter. La ventilation
       se fait par nature (SB / NB / Manuels), jamais « par personne ». */
    var due = DATA.bookings.filter(function (b) { return b._inDue && SC.estRdvVente(b._class) && bookingMatches(b); });
    var dueSelf = due.filter(function (b) { return b._class === 'self'; });
    var dueSetter = due.filter(function (b) { return b._class === 'setter'; });
    var dueAdmin = due.filter(function (b) { return b._class === 'admin'; });
    k.tenue = SC.compter(due, NOW);
    k.tenueSB = SC.compter(dueSelf, NOW);
    k.tenueNB = SC.compter(dueSetter, NOW);
    k.tenueMan = SC.compter(dueAdmin, NOW);

    /* Listes nominatives des MÊMES états (même fonction, même instant). */
    function listesTenue(list) {
      var L = { rdv: [], replan: [], doublons: [], annules: [], kept: [], noshow: [], presents: [], pitches: [],
        disqua: [], sansDetail: [], offres: [], nonCloses: [], rdvCloses: [], aStatuer: [], aVenir: [] };
      list.forEach(function (b) {
        var e = SC.etat(b, NOW);
        if (e === 'doublon') { L.doublons.push(b); return; }
        if (e === 'replanifie') { L.replan.push(b); return; }
        L.rdv.push(b);
        if (e === 'annule') { L.annules.push(b); return; }
        L.kept.push(b);
        if (e === 'no_show') L.noshow.push(b);
        else if (e === 'a_statuer') L.aStatuer.push(b);
        else if (e === 'a_venir') L.aVenir.push(b);
        else {
          L.presents.push(b);
          var d = SC.detail(b);
          if (d === 'disqualifie') L.disqua.push(b);
          else if (d === 'sans_detail') L.sansDetail.push(b);
          else {
            L.pitches.push(b);
            if (d === 'offre') L.offres.push(b);
            else if (d === 'non_close') L.nonCloses.push(b);
            else L.rdvCloses.push(b);
          }
        }
      });
      return L;
    }
    var TL = listesTenue(due);

    /* Anciens champs, ALIMENTÉS par l'agrégat (les pages les lisent encore) —
       sémantique du référentiel, voir le contrat de K :
         rdvMois = RDV · due = RDV + replanifiés (doublons hors compte)
         kept = RDV − annulés (no-show DEDANS) · keptPct = kept ÷ RDV
         cancelRate = annulés ÷ RDV (sans les no-show) */
    k.rdvMois = k.tenue.rdv;
    k.due = k.tenue.rdv + k.tenue.replan;
    k.dueRescheduled = k.tenue.replan;
    k.dueDoublons = k.tenue.doublons;
    k.dueCancelled = k.tenue.annules;
    k.dueNoShow = k.tenue.noshow;
    k.dueCompleted = k.tenue.presents;          /* « présents » : le résultat fait foi, plus le seul statut « terminé » */
    k.dueToStatus = k.tenue.aStatuer;           /* créneau TERMINÉ (heure de Paris) sans résultat */
    k.dueUpcoming = k.tenue.aVenir;
    k.kept = k.tenue.kept;
    k.keptPct = k.tenue.keptPct;
    k.cancelRate = k.tenue.tauxAnnul;
    k.noShowRate = k.tenue.tauxNoShow;          /* no-show ÷ (Kept − à venir) */
    k.showUp = k.tenue.showUp;                  /* présents ÷ (Kept − à venir) */
    /* Par nature — SB + NB + Manuels = total, pour chaque champ. */
    k.rdvSB = k.tenueSB.rdv; k.rdvNB = k.tenueNB.rdv; k.rdvMan = k.tenueMan.rdv;
    k.dueSB = k.tenueSB.rdv + k.tenueSB.replan;
    k.dueNB = k.tenueNB.rdv + k.tenueNB.replan;
    k.dueMan = k.tenueMan.rdv + k.tenueMan.replan;
    k.cancSB = k.tenueSB.annules; k.cancNB = k.tenueNB.annules; k.cancMan = k.tenueMan.annules;
    k.noshowSB = k.tenueSB.noshow; k.noshowNB = k.tenueNB.noshow; k.noshowMan = k.tenueMan.noshow;
    k.reschedSB = k.tenueSB.replan; k.reschedNB = k.tenueNB.replan; k.reschedMan = k.tenueMan.replan;
    k.keptSB = k.tenueSB.kept; k.keptNB = k.tenueNB.kept; k.keptMan = k.tenueMan.kept;
    k.showUpSB = k.tenueSB.showUp; k.showUpNB = k.tenueNB.showUp; k.showUpMan = k.tenueMan.showUp;

    /* Origine des annulations (28/09/2026) : bloc `cancellation` posé par tous
       les chemins d'annulation ; repli sur cancelledOrigin (modale résultat
       d'avant) et cancelledReason (API : transfert coach, client désactivé).
       « inconnu » = annulé avant la traçabilité, jamais estimé. Calculée sur
       les annulés du MÊME agrégat : la somme des quatre origines = Annulés. */
    function cancOrigin(b) {
      var c = b.cancellation || null;
      var o = (c && c.origin) || b.cancelledOrigin || null;
      if (!o && b.cancelledReason) o = 'systeme';
      return (o === 'prospect' || o === 'equipe' || o === 'systeme') ? o : 'inconnu';
    }
    k.cancByOrigin = { prospect: 0, equipe: 0, systeme: 0, inconnu: 0 };
    TL.annules.forEach(function (b) { k.cancByOrigin[cancOrigin(b)]++; });

    /* ══ AXE « CRÉATION » — résultat de chaque RDV pris, lu sur le RDV
       TERMINAL de sa chaîne (report ou transfert suivis par
       StatsCore.suivantId), par les mêmes règles d'état que la Tenue :
         n (RDV pris) = annulés + no-show + présents + à statuer + à venir
                        + sansSuite
         kept = n − annulés − sansSuite · show-up = présents ÷ (kept − à venir)
       sansSuite : RDV pris puis déplacé dont le nouveau créneau n'est pas
       connu (lien de report absent) — ni annulé, ni maintenu : compté à part,
       jamais dans le Kept ni dans le dénominateur du show-up. Presque
       toujours 0. */
    function chainAgg(list) {
      var terms = [], resched = 0;
      list.forEach(function (b0) {
        var t = chainTerminal(b0);
        if (t !== b0) resched++;
        terms.push(t);
      });
      var t = SC.compter(terms, NOW);
      return {
        n: t.total, resched: resched, sansSuite: t.replan + t.doublons, rdv: t.rdv,
        cancelled: t.annules, noshow: t.noshow, present: t.presents, disqua: t.disqua, pitched: t.pitches,
        offres: t.offres, closesOc: t.rdvCloses, nonCloses: t.nonCloses, sansDetail: t.sansDetail,
        aStatuer: t.aStatuer, aVenir: t.aVenir, kept: t.kept, keptEchus: t.keptEchus,
        keptPct: t.keptPct, showUp: t.showUp, tauxPitch: t.tauxPitch, tauxAnnul: t.tauxAnnul, tauxNoShow: t.tauxNoShow
      };
    }
    k.chSB  = chainAgg(createdFunnel.filter(function (b) { return b._class === 'self'; }));
    k.chNB  = chainAgg(createdFunnel.filter(function (b) { return b._class === 'setter'; }));
    k.chAll = chainAgg(createdFunnel);

    /* Origine du lead de chaque RDV créé (têtes de chaîne) — pont de
       cohérence : « 9 RDV pris SB » vs « 7 self-bookés » s'explique par les
       ré-optins et les leads plus anciens qui prennent AUSSI rendez-vous. */
    function rdvOrigin(list) {
      var o = { cohort: 0, reopt: 0, old: 0 };
      list.forEach(function (b) {
        var l = bookingLead(b);
        if (l && l._inCohort) o.cohort++;
        else if (l) o.reopt++;
        else o.old++;
      });
      return o;
    }
    k.orgSB = rdvOrigin(createdFunnel.filter(function (b) { return b._class === 'self'; }));
    k.orgNB = rdvOrigin(createdFunnel.filter(function (b) { return b._class === 'setter'; }));

    /* Réconciliation des DEUX axes (« créés sur la période » vs « date dans
       la période ») — chiffres exacts, affichés, plus jamais implicites.
       Comptés sur les RDV NETS (ceux du chiffre « RDV », replanifiés et
       doublons déduits), les RDV de report à part :
       · rdvOrigine = { periode, avant, reporte, inconnu } — leur somme = RDV
       · dueCreatedBefore = posés AVANT le début de la période
       · dueReplacement   = nouveau créneau d'un RDV déplacé ou transféré
       · dueUnknownOrigin = date de pose absente (jamais rangé « avant »)
       · createdDueLater  = RDV pris sur la période dont le RDV terminal se
         tient APRÈS la fin de la période. */
    var startMsP = P.start.getTime();
    function originesDe(list) {
      var o = { periode: 0, avant: 0, reporte: 0, inconnu: 0 };
      list.forEach(function (b) { o[origineRdv(b, startMsP)]++; });
      return o;
    }
    k.rdvOrigine = originesDe(TL.rdv);
    k.rdvOrigineSB = originesDe(TL.rdv.filter(function (b) { return b._class === 'self'; }));
    k.rdvOrigineNB = originesDe(TL.rdv.filter(function (b) { return b._class === 'setter'; }));
    k.rdvOrigineMan = originesDe(TL.rdv.filter(function (b) { return b._class === 'admin'; }));
    k.dueCreatedBefore = k.rdvOrigine.avant;
    k.dueReplacement = k.rdvOrigine.reporte;
    k.dueUnknownOrigin = k.rdvOrigine.inconnu;
    var endIsoStr = isoDate(P.end);
    k.createdDueLater = 0;
    createdFunnel.forEach(function (b) {
      var t = chainTerminal(b);
      if ((t.date || '') > endIsoStr) k.createdDueLater++;
    });

    /* Résultats sur l'axe « date de RDV » (héro L2, Tenue, show-up, taux de
       close) — reconstruits depuis les MÊMES agrégats, anciens noms de champs :
       n = RDV · present = présents · pitched = pitchés · closesOc = RDV closés
       (à la date du RDV : ce n'est PAS « Closes »). Identités : present =
       disqua + pitched + sansDetail ; pitched = offres + nonCloses + closesOc. */
    function ocDe(t) {
      return { n: t.rdv, present: t.presents, disqua: t.disqua, pitched: t.pitches, closesOc: t.rdvCloses,
        nonCloses: t.nonCloses, offres: t.offres, aStatuer: t.aStatuer, aVenir: t.aVenir, sansDetail: t.sansDetail };
    }
    k.ocDue = ocDe(k.tenue);
    /* Même lecture par nature (23/11/2026, demande Vincent : Global / Self
       Booking / Setting sous chaque carte du héro) + part « Manuels ». */
    k.ocDueSB = ocDe(k.tenueSB);
    k.ocDueNB = ocDe(k.tenueNB);
    k.ocDueMan = ocDe(k.tenueMan);
    k.ocHasData = k.tenue.rdv > 0 && (k.tenue.presents + k.tenue.annules + k.tenue.noshow) > 0;

    /* Échelle CPR — MÊME AXE que la carte « RDV pris SB » (RDV SB créés
       dans la période, chaînes dédupliquées, résultat de fin de chaîne) :
       plus jamais deux dénominateurs différents entre la carte et l'échelle. */
    k.ltbSB = k.leads > 0 ? k.bookedSelf / k.leads * 100 : null;
    k.cprSB    = k.spend > 0 && k.chSB.n > 0 ? k.spend / k.chSB.n : null;
    k.cprKept  = k.spend > 0 && k.chSB.kept > 0 ? k.spend / k.chSB.kept : null;
    k.cprLive  = k.spend > 0 && k.chSB.present > 0 ? k.spend / k.chSB.present : null;
    k.cprOffre = k.spend > 0 && k.chSB.pitched > 0 ? k.spend / k.chSB.pitched : null;

    /* ══ JOURNAL D'ACTIONS (lead_actions) — audit 25/11/2026, étape 2 ══
       Journaux de TOUT le roster (anciens membres et admins compris).
       · Leads travaillés (équipe) = fiches DISTINCTES contactées pour la
         première fois sur la période (FunnelCore.leadsWorked : un lead repris
         par un 2e setter ne compte qu'une fois). Décomposition affichable :
         Σ des onglets (k.actWorkedSommeOnglets) − repris par un autre membre
         (k.actWorkedReprisParUnAutre) = k.actLeadsWorked.
         Ventilation « travaillés > cohorte » : ré-optins, leads plus anciens,
         self-bookés.
       · Filtre tunnel / source : seules les fiches CHARGÉES (cohorte,
         ré-optins) qui passent le filtre sont comptées ; les autres ne
         peuvent pas être classées → k.actWorkedNonVentiles, dit à l'écran.
       · Sets : UN set = UN RDV du setting créé (k.bookedSetter, décision
         D13). Les statuts « Set » cliqués sur une fiche SANS aucun RDV du
         setting créé sur la période ne sont PAS des sets : listés à part
         (k.statutsSetSansRdv, k.statutsSetSansRdvListe — nominatif).
       Avant la mise en ligne du journal (14/07/2026) : « — ». */
    var acts = DATA.actions || [];
    var filtreActif = tunnelFilter !== 'all' || sourceFilter !== 'all';
    var actNonVentiles = {};
    function actionGardee(a) {
      if (!filtreActif) return true;
      var la = a.leadId ? leadsById[a.leadId] : null;
      if (!la) { if (a.firstTouch) actNonVentiles[a.leadId || a._id] = 1; return false; }
      return leadMatch(la);
    }
    var LW = leadsWorked(acts, actionGardee);
    k.actLeadsWorked = LW.team;
    k.actWorkedBySlug = LW.bySlug;                 /* nominatif interne (slug → fiches) */
    k.actWorkedSommeOnglets = LW.sommeOnglets;
    k.actWorkedReprisParUnAutre = LW.reprisParUnAutre;
    k.actWorkedNonVentiles = Object.keys(actNonVentiles).length;
    k.actWorkedReopt = 0; k.actWorkedOld = 0; k.actWorkedSelf = 0;
    Object.keys(LW.leadIds).forEach(function (id) {
      var la = leadsById[id] || null;
      if (la && la._inCohort) { if (nbrSelf[la._id]) k.actWorkedSelf++; }
      else if (la) k.actWorkedReopt++;
      else k.actWorkedOld++;
    });
    /* Statuts « Set » sans RDV : fiche passée au statut Set (journal) sans
       aucun RDV du setting créé sur la période pour elle. */
    var setRdvLead = {}, setRdvP9 = {};
    createdFunnelAll.forEach(function (b) {
      if (b._class !== 'setter') return;
      var lb = bookingLead(b);
      if (b.leadId) setRdvLead[b.leadId] = 1;
      if (lb) setRdvLead[lb._id] = 1;
      if (b._p9) setRdvP9[b._p9] = 1;
    });
    var ssr = {};
    acts.forEach(function (a) {
      if (!(a.action === 'set' || a.action === 'set_booking' || a.action === 'rdv_pose')) return;
      if (!actionGardee(a)) return;
      var id = a.leadId || a._id;
      if (ssr[id] || setRdvLead[id]) return;
      var la = a.leadId ? leadsById[a.leadId] : null;
      if (la && la._p9 && setRdvP9[la._p9]) return;
      ssr[id] = { leadId: a.leadId || null, name: a.leadName || (la && la.nom) || a.leadId || '', day: a._jour || jourAction(a), slug: a._slug || null };
    });
    k.statutsSetSansRdvListe = Object.keys(ssr).map(function (id) { return ssr[id]; });
    k.statutsSetSansRdv = k.statutsSetSansRdvListe.length;
    /* Alias de TRANSITION — l'ancien « sets du journal » comptait les clics de
       statut, en double avec les RDV. Il vaut désormais les Sets (= RDV pris
       NB). Ne plus le lire : k.bookedSetter / k.chNB.n. */
    k.actSets = k.bookedSetter;
    k.journalLive = isoDate(P.end) >= JOURNAL_GOLIVE;

    /* ══ TÉLÉPHONIE (call_logs) — audit 25/11/2026, étape 2 ══
       Appels = SORTANTS. Périmètre = ÉQUIPE SALES (setters, closers, admins —
       anciens membres compris, leur activité passée reste) + appels SANS
       AUTEUR (poste Ringover relié à aucun compte : très majoritairement du
       setting, ligne « Non attribué »). Les sortants des autres rôles (CSM,
       coachs) sont comptés À PART : k.callsOutHorsSales — ligne « Hors
       équipe sales ». Décroché = StatsCore.estDecroche (≥ 5 s, répondeurs
       écartés), partout. Durées : FunnelCore.callStats. */
    function callMatches(c) {
      if (tunnelFilter === 'all' && sourceFilter === 'all') return true;
      var l = c._p9 ? leadsByP9[c._p9] : null;
      return !!(l && leadMatch(l));
    }
    var CIDX = callerIndex(TEAM);
    /* 'sales' | 'sans_auteur' | 'hors' — mémorisé sur l'appel (_who, _perim). */
    function perimetre(c) {
      if (c._perimIdx === CIDX) return c._perim;
      c._perimIdx = CIDX;
      c._who = callerOf(c, CIDX);
      c._perim = perimetreAppel(c, CIDX);   /* LA règle exportée (revue D17) */
      return c._perim;
    }
    function dansEquipe(c) { return perimetre(c) !== 'hors'; }
    /* Activité de la PÉRIODE (cartes appels sortants / décrochés / durée /
       par personne) : strictement bornée à [start, end] — les appels chargés
       en lookahead pour le Lead to speech ne comptent jamais ici. */
    var callsOutTous = DATA.calls.filter(function (c) { return c.direction === 'outbound' && c._inPeriod && callMatches(c); });
    var callsOut = callsOutTous.filter(dansEquipe);
    var callsHors = callsOutTous.filter(function (c) { return !dansEquipe(c); });
    var CS = callStats(callsOut), CSH = callStats(callsHors);
    k.callsOut = CS.out;                         /* équipe sales + sans auteur */
    k.callsAnswered = CS.answered;
    k.answerRate = k.callsOut > 0 ? k.callsAnswered / k.callsOut * 100 : null;
    k.talkSec = CS.talkSec;                      /* temps d'appel : conversation des sortants décrochés */
    k.callsSansAuteur = callsOut.filter(function (c) { return perimetre(c) === 'sans_auteur'; }).length;
    k.callsOutHorsSales = CSH.out;               /* sortants CSM / coachs : hors des chiffres ci-dessus */
    k.callsAnsweredHorsSales = CSH.answered;
    k.callsOutTous = callsOutTous.length;        /* = callsOut + callsOutHorsSales */
    /* Appels reçus de la période (équipe), à part : jamais dans « Appels ». */
    var callsInEq = DATA.calls.filter(function (c) { return c.direction === 'inbound' && c._inPeriod && callMatches(c) && dansEquipe(c); });
    var CSI = callStats(callsInEq);
    k.callsIn = CSI.inbound; k.callsInAnswered = CSI.inboundAnswered; k.talkSecIn = CSI.inboundTalkSec;
    /* Appels sans aucune information de sonnerie : la règle « messagerie »
       ne peut pas s'y appliquer, ils sont comptés décrochés par défaut et
       gonflent le taux. C'est le cas des appels du JOUR — le sync Ringover
       tourne à 3 h 30, ils ne sont enrichis que la nuit suivante. Sans ce
       compteur, la journée en cours affiche un taux faux sans rien dire :
       81,8 % au lieu de ~60 %, constaté le 17/08. */
    k.callsNoRingData = callsOut.filter(function (c) { return ringingSecOf(c) == null; }).length;

    /* ── Parcours de contact des leads de la cohorte (FunnelCore.leadContact) :
       appels SORTANTS de l'équipe (même périmètre) vers le numéro du lead,
       entre son entrée et 14 jours après (même plafond que Pilotage ; les
       appels passés AVANT son entrée ne comptent plus). Un lead « appelé »
       a donc toujours un Lead to speech : k.ttcCount = k.leadsCalled. ── */
    function nomAffiche(who) {
      if (!who) return { key: '_none', name: 'Non attribué', unassigned: true, anciens: false };
      /* « Hors équipe sales » d'abord : une ancienne CSM n'est pas une ancienne
         de l'équipe sales — ses appels ne sont pas dans les appels sortants de l'équipe. */
      if (!who.sales) return { key: '_hors', name: 'Hors équipe sales', unassigned: false, anciens: false, hors: true };
      if (who.departed) return { key: '_anciens', name: SC.mot('anciens_membres') || 'Anciens membres', unassigned: false, anciens: true };
      return { key: who.key, name: who.name, unassigned: false, anciens: false };
    }
    var callsByP9 = {};
    DATA.calls.forEach(function (c) {
      if (c.direction !== 'outbound' || !c._p9 || c._ms == null || !dansEquipe(c)) return;
      if (!callsByP9[c._p9]) callsByP9[c._p9] = [];
      callsByP9[c._p9].push({ ms: c._ms, ans: isAnsweredCall(c), who: c._who || null });
    });
    var ttcArr = [], ttbArr = [], ttbSelfArr = [], ttbSetArr = [];
    var leadsCalled = 0, leadsReached = 0, attemptsSum = 0;
    cohort.forEach(function (l) {
      var LC = leadContact(l, l._p9 ? callsByP9[l._p9] : null);
      l._nbCalls = LC.nbAppels;
      l._nbAnswered = LC.nbDecroches;
      l._ttc = LC.delai;
      l._ttcBy = LC.auteur ? nomAffiche(LC.auteur) : null;
      if (LC.appele) { leadsCalled++; attemptsSum += LC.nbAppels; if (LC.joint) leadsReached++; }
      /* SMS sortants depuis l'entrée du lead (communications[]) */
      l._nbSms = 0;
      var comms = l.communications || [];
      for (var j = 0; j < comms.length; j++) {
        var cm = comms[j];
        if (!cm || cm.type !== 'sms' || cm.direction !== 'outbound') continue;
        var ms = parseFlexMs(cm.date || cm.createdAt);
        if (ms != null && l._entry != null && ms >= l._entry && ms <= laEnd) l._nbSms++;
      }
      if (l._ttc != null) ttcArr.push(l._ttc);
      if (l._ttb != null) ttbArr.push(l._ttb);
      if (l._ttbSelf != null) ttbSelfArr.push(l._ttbSelf);
      if (l._ttbSet != null) ttbSetArr.push(l._ttbSet);
    });
    k.contactWindowDays = CONTACT_WINDOW_MS / 86400000;
    k.ttcMedian = median(ttcArr);
    k.ttcCount = ttcArr.length;
    /* Lead to speech par personne : chaque lead appelé de la cohorte compte
       UNE fois, pour l'auteur de son 1er appel. Anciens membres réunis sur une
       ligne sans nom ; tri du plus rapide au plus lent (médiane), « Anciens
       membres » puis « Non attribué » en dernier. */
    var ltsBy = {};
    cohort.forEach(function (l) {
      if (l._ttc == null) return;
      var who = l._ttcBy || nomAffiche(null);
      if (!ltsBy[who.key]) ltsBy[who.key] = { key: who.key, name: who.name, unassigned: !!who.unassigned, anciens: !!who.anciens, delays: [] };
      ltsBy[who.key].delays.push(l._ttc);
    });
    function rangFin(u) { return u.unassigned ? 2 : (u.anciens ? 1 : 0); }
    k.ltsByUser = Object.keys(ltsBy).map(function (key) {
      var u = ltsBy[key], d = u.delays;
      var u5 = 0, u60 = 0;
      d.forEach(function (ms) { if (ms <= 5 * 60000) u5++; if (ms <= 3600000) u60++; });
      return { key: u.key, name: u.name, unassigned: u.unassigned, anciens: u.anciens, n: d.length, median: median(d),
        under5: u5, under60: u60, under5Pct: u5 / d.length * 100, under60Pct: u60 / d.length * 100 };
    }).sort(function (a, b) {
      if (rangFin(a) !== rangFin(b)) return rangFin(a) - rangFin(b);
      return a.median - b.median || b.n - a.n;
    });
    k.ttbMedian = median(ttbArr);
    k.ttbCount = ttbArr.length;
    k.ttbSelfMedian = median(ttbSelfArr); k.ttbSelfCount = ttbSelfArr.length;
    k.ttbSetMedian  = median(ttbSetArr);  k.ttbSetCount  = ttbSetArr.length;
    /* Zéros honnêtes : les médianes ne portent que sur les leads DÉJÀ
       appelés / bookés. Provisoire tant que le lookahead est tronqué par
       « maintenant » — des 1ers contacts peuvent encore arriver et
       ALLONGER les médianes (jamais les raccourcir). */
    k.ttxProvisional = P.end.getTime() + TTX_LOOKAHEAD_MS > Date.now();

    /* Joignabilité & tentatives — même fenêtre que le Lead to speech. */
    k.leadsCalled = leadsCalled;
    k.leadsReached = leadsReached;
    k.leadsNeverCalled = k.leads - leadsCalled; // jamais appelés dans leurs 14 premiers jours (téléphone absent inclus)
    k.reachRate = leadsCalled > 0 ? leadsReached / leadsCalled * 100 : null;
    k.attemptsAvg = leadsCalled > 0 ? attemptsSum / leadsCalled : null;

    /* Durée moyenne d'un appel décroché = temps d'appel ÷ décrochés. */
    k.avgAnsweredDurSec = CS.answered > 0 ? CS.talkSec / CS.answered : null;

    /* Appels par personne : une ligne par membre de l'équipe sales, puis
       « Anciens membres » (sans nom), « Non attribué » (appels sans auteur),
       « Hors équipe sales » (CSM, coachs — HORS du total k.callsOut).
       Lignes hors « Hors équipe sales » : Σ out = k.callsOut. */
    var byUser = {};
    callsOutTous.forEach(function (c) {
      perimetre(c);
      var who = nomAffiche(c._who);
      if (!byUser[who.key]) byUser[who.key] = { key: who.key, name: who.name, out: 0, ans: 0, talkSec: 0, rawName: null,
        unassigned: !!who.unassigned, anciens: !!who.anciens, horsEquipe: !!who.hors };
      var u = byUser[who.key];
      u.out++;
      if (isAnsweredCall(c)) { u.ans++; u.talkSec += Number(c.durationSec) || 0; }
    });
    function rangAppel(u) { return u.horsEquipe ? 3 : (u.unassigned ? 2 : (u.anciens ? 1 : 0)); }
    k.callsByUser = Object.keys(byUser).map(function (kk) { return byUser[kk]; }).sort(function (a, b) {
      if (rangAppel(a) !== rangAppel(b)) return rangAppel(a) - rangAppel(b);
      return b.out - a.out;
    });

    /* ── Show-up : présents ÷ (Kept − à venir), règle unique StatsCore (D4).
       Le no-show reste au dénominateur : il fait baisser le taux. k.showup
       (ancien nom) et k.showUp portent la même valeur. ── */
    k.showup = k.showUp;

    /* ══ CLOSES — dérivés de LA LISTE UNIQUE (CL, construite plus haut) ══
       Un close = un client gagné, compté une fois, le jour où il est gagné
       (clientSince) — voir FunnelCore.buildCloses. Trois origines de ligne :
       ① fiche gagnée avec un signal de vente ; ② RDV closé sans fiche ;
       ③ paiement de la période sans fiche gagnée (resolvePaymentLeads).
       Canal (Self Booking / Setting) : classe du RDV porteur, à défaut la
       réponse du closer, à défaut l'étape de la fiche (décision D2) — plus
       l'étape seule. Closes SB + Closes NB = Closes ; idem pour les montants.

       Montants — règles REVENUE (validées Adrien 13/10/2026, voir revClient),
       toujours HT, toujours lus dans le verdict `rv` de la ligne :
       · collecté  = prélèvements RÉELLEMENT passés à ce jour (paymentsHistory).
         Le « collecté déclaré » par le closer n'y entre JAMAIS ; un mandat
         signé sans prélèvement va dans k.collecteMandat (1ers prélèvements en
         attente), qui n'est qu'une PARTIE du reste à encaisser.
       · contracté = totalAmount des paiements non annulés ; close sans
         paiement → tarif déclaré au close, signalé (k.collecteMissingNames).
       · CLOSE ANNULÉ (0 € encaissé + paiements annulés, fiche stoppée ou
         retirée des clients) : retiré des closes, du contracté et du
         collecté, listé à part (k.closesCancelledNames, k.coh.annules).
       Un paiement n'est jamais compté deux fois (marquage dans buildCloses). ── */
    var closeRowsOk = CL.rows;
    k.closeRows = CL.toutes;                    /* comptés + annulés (rv.cancelled) — listes cliquables */
    k.closes = sumCloses(closeRowsOk);
    k.closesSB = sumCloses(closeRowsOk.filter(function (r) { return r.sb; }));
    k.closesNB = sumCloses(closeRowsOk.filter(function (r) { return !r.sb; }));
    k.wonSelf = k.closesSB.closes;
    k.wonSetting = k.closesNB.closes;
    k.closesWonTotal = k.closes.closes;
    k.wonCollecteSB = k.closesSB.paid; k.wonCollecteNB = k.closesNB.paid;
    k.wonContracteSB = k.closesSB.con; k.wonContracteNB = k.closesNB.con;
    k.wonCollecte = k.closes.paid;
    k.wonContracte = k.closes.con;
    k.collecteMandat = k.closes.pending;        /* Σ rv.pending : 1ers prélèvements en attente */
    k.resteAEncaisser = k.closes.reste;         /* contracté − collecté */
    k.panierMoyen = k.closes.panier;            /* contracté ÷ closes */
    k.collecteParClose = k.closes.collecteParClose;   /* collecté ÷ closes (l'ancien « AOV ») */
    k.collecteMissing = k.closes.sansPaiement;
    k.closesNoPayment = k.closes.sansPaiement;
    /* « Prélevé sur la période » (argent rentré pendant la période, tous
       clients) n'est PAS posé dans K : K part tel quel vers le lien Agence
       (liste d'exclusion dans api/agency-funnel.js), et ce chiffre-là — tout
       l'argent rentré, anciens clients compris — n'a pas à sortir de la
       maison. Une page interne l'obtient par
       FunnelCore.cashInPeriod(DATA.payments, début, fin). */
    k.collecteMissingNames = [];
    k.payCloseNames = [];
    /* Canal du close : d'où vient l'information (RDV, réponse du closer,
       étape, inconnu) — « inconnu » est compté en Setting et signalé. */
    k.closesCanalSrc = { rdv: 0, declare: 0, etape: 0, inconnu: 0 };

    /* Fiches gagnées NON annulées, utilisées en aval (section créatives) ;
       ventilation publicité / hors publicité sur ces seules fiches : un close
       sans fiche gagnée (RDV sans fiche, paiement seul) reste « non rattaché »
       — on ne crédite pas la pub d'un chiffre dont on ignore l'origine. */
    var closedLeads = [];
    var wonColAds = 0, wonConAds = 0, closesAds = 0;
    var wonColHorsPub = 0, closesHorsPub = 0;
    closeRowsOk.forEach(function (r) {
      var rv = r.rv;
      if (k.closesCanalSrc[r.canalSrc] != null) k.closesCanalSrc[r.canalSrc]++;
      if (!rv.hasPay) k.collecteMissingNames.push(r.name + (rv.declCol > 0 ? ' — collecté déclaré ' + Math.round(rv.declCol) + ' €, non compté' : ''));
      if (r.src === 'paiement') k.payCloseNames.push(r.name + (r.noLead ? ' (aucune fiche trouvée)' : ''));
      if (r.src !== 'fiche' || !r.lead) return;
      var l = r.lead;
      closedLeads.push(l);
      l._wonCol = rv.paid;   /* collecté consolidé par fiche — réutilisé par la section « par créative » */
      l._wonCon = rv.con;    /* contracté HT — colonne « Contracté » de Qualité par pub */
      /* Ventilation pub / hors pub — le ROAS global divisait TOUT le
         collecté par la dépense publicitaire, créditant donc les pubs du
         chiffre venu d'Instagram organique, du setting téléphonique et des
         liens partagés à la main. Sur août : 8 600 € au numérateur dont
         5 650 € hors publicité. */
      if (isAdvertisingLead(l)) { wonColAds += rv.paid; wonConAds += rv.con; closesAds++; }
      else { wonColHorsPub += rv.paid; closesHorsPub++; }
    });
    var closesSansFiche = closeRowsOk.length - closedLeads.length;   /* RDV sans fiche + paiements seuls */
    k.closesCancelledNames = CL.annules.map(function (r) { return r.name + ' (' + ((r.rv && r.rv.reason) || 'annulé') + ')'; });
    k.closesCancelled = CL.annules.length;
    /* Paiements de la période rattachés à un client gagné à une AUTRE date
       (diagnostic, sans filtre seulement — ils n'ont pas de tunnel). */
    k.payCloseOther = (tunnelFilter === 'all' && sourceFilter === 'all') ? CL.autres.map(function (x) { return x.name; }) : [];

    /* ── Listes derrière les chiffres (héro, Tenue) : les MÊMES ensembles que
       les compteurs de k.tenue, un RDV dans UN seul état. ──
       rdvMois = RDV · kept = RDV − annulés (no-show dedans) · live = présents
       · pitched = pitchés. Champs nominatifs : hors du lien Agence. */
    k.drill = {
      rdvMois: TL.rdv, kept: TL.kept, live: TL.presents, pitched: TL.pitches,
      annules: TL.annules, noshow: TL.noshow, aStatuer: TL.aStatuer, aVenir: TL.aVenir, replan: TL.replan,
      disqua: TL.disqua, sansDetail: TL.sansDetail, offres: TL.offres, nonCloses: TL.nonCloses, rdvCloses: TL.rdvCloses,
      manuels: TL.rdv.filter(function (b) { return b._class === 'admin'; }),
      doublons: TL.doublons
    };

    /* ══ CONTRÔLE DE COHÉRENCE (décision D1 du 25/11/2026) ══
       Il ne compare PLUS deux règles de close : tous les écrans lisent la même
       liste. Il NOMME ce qui explique l'écart entre « Closes » (clients gagnés,
       à la date de la vente) et « RDV closés » (RDV au résultat close, à la
       date du RDV), et ce qui mérite une vérification :
         closesSansRdv      closes sans RDV au résultat close (vente validée
                            sur la fiche, ou repérée par le paiement)
         ecartsCanal        RDV porteur et réponse du closer divergent (la
                            commission suit la réponse du closer)
         sansSignal         fiches marquées clientes sans vente enregistrée
                            (NON comptées dans Closes)
         annules            closes annulés (retirés partout)
         rdvClosesHorsListe RDV closés de la période dont le client n'est pas
                            une ligne de la période (gagné à une autre date,
                            ou fiche jamais passée cliente)
         doublonsRdv        clients ayant deux RDV au résultat close (un seul
                            close compté)
         closesRdvHorsPeriode closes de la période dont le RDV closé (porteur)
                            n'est pas parmi les « RDV closés » de la période :
                            RDV daté avant (ou après) la période — typique d'un
                            début de mois (RDV du 28/10 closé le 05/11) — ou
                            RDV hors du filtre affiché. COMPTÉS dans Closes,
                            absents de RDV closés (revue D07).
       Chaque entrée : { name, leadId, date, why } en français simple
       (+ con / paid / sb / rdvDate / bookingId quand ils existent). */
    (function () {
      function canalMot(sb) { return sb ? 'Self Booking' : 'Setting (NB)'; }
      function entree(r, why, date) {
        var rv = r.rv || {};
        return { name: r.name, leadId: r.leadId || null, date: date != null ? date : (r.day || ''), why: why,
          sb: !!r.sb, con: rv.cancelled ? 0 : (rv.con || 0), paid: rv.cancelled ? 0 : (rv.paid || 0),
          rdvDate: r.rdvDate || '', bookingId: r.bookingId || null };
      }
      var coh = { closesSansRdv: [], ecartsCanal: [], sansSignal: [], annules: [], rdvClosesHorsListe: [], doublonsRdv: [],
        closesRdvHorsPeriode: [] };
      /* RDV closés de la période (ceux du compteur « RDV closés »). */
      var rdvClosPeriode = {};
      TL.rdvCloses.forEach(function (b) { var id = b._id || b.id; if (id) rdvClosPeriode[id] = 1; });
      var sIsoCoh = isoDate(P.start), eIsoCoh = isoDate(P.end);

      closeRowsOk.forEach(function (r) {
        if (r.bookingId) return;
        var why = r.src === 'paiement'
          ? 'Vente repérée par le module Paiements' + (r.noLead ? ' (aucune fiche trouvée)' : '') + ' : aucun RDV au résultat « Close ». Comptée dans Closes, datée du premier paiement.'
          : 'Vente validée sur la fiche (' + ({ etape: 'étape « gagné »', paiement: 'paiement rattaché', signature: 'contrat signé' }[r.signal] || 'fiche') + ') : aucun RDV au résultat « Close » n’est rattaché à cette fiche. Comptée dans Closes.';
        coh.closesSansRdv.push(entree(r, why));
      });
      /* Closes dont le RDV porteur n'est pas compté dans les RDV closés de la
         période (revue D07) : sans eux, « Closes ↔ RDV closés » ne se refait
         pas à la main. */
      closeRowsOk.forEach(function (r) {
        if (!r.bookingId || rdvClosPeriode[r.bookingId]) return;
        var horsDates = !r.rdvDate || r.rdvDate < sIsoCoh || r.rdvDate > eIsoCoh;
        var why = horsDates
          ? 'Client gagné le ' + frJour(r.day) + ', RDV closé le ' + (r.rdvDate ? frJour(r.rdvDate) : '(date inconnue)') + ' (hors période) : compté dans Closes, pas dans RDV closés.'
          : 'Client gagné le ' + frJour(r.day) + ', RDV closé le ' + frJour(r.rdvDate) + ' non retenu dans RDV closés (hors du filtre affiché, ou RDV remplacé / en double) : compté dans Closes, pas dans RDV closés.';
        coh.closesRdvHorsPeriode.push(entree(r, why));
      });
      CL.ecartsCanal.forEach(function (r) {
        coh.ecartsCanal.push(entree(r, 'RDV ' + canalMot(r.sb) + ', mais le closer a répondu « ' + canalMot(!r.sb) + ' » au close. Le close est compté ' + canalMot(r.sb) + ' (canal du RDV) ; la commission suit la réponse du closer.'));
      });
      CL.sansSignal.forEach(function (x) {
        coh.sansSignal.push({ name: x.name, leadId: x.leadId || null, date: x.day || '',
          why: 'Fiche marquée cliente le ' + frJour(x.day) + ' sans vente enregistrée (ni étape « gagné », ni RDV au résultat « Close », ni paiement, ni contrat signé)' + (x.stage ? ' — étape actuelle : ' + x.stage : '') + '. Non comptée dans Closes : à vérifier sur la fiche.',
          sb: false, con: 0, paid: 0, rdvDate: '', bookingId: null });
      });
      CL.annules.forEach(function (r) {
        coh.annules.push(entree(r, 'Close annulé (' + ((r.rv && r.rv.reason) || 'annulé') + ') : retiré de Closes, du Contracté et du Collecté.'));
      });

      /* Le client d'un RDV est-il une ligne de la période (comptée ou annulée) ? */
      var ligneParFiche = {}, ligneParRdv = {}, ligneParEmail = {}, ligneParP9 = {};
      CL.toutes.forEach(function (r) {
        if (r.leadId) ligneParFiche[r.leadId] = r;
        if (r.bookingId) ligneParRdv[r.bookingId] = r;
        var em = '', p9 = null;
        if (r.lead) { em = lowerTrim(r.lead.email); p9 = phone9(r.lead.telephone || r.lead.phone); }
        else {
          /* Ligne sans fiche : e-mail / téléphone du RDV porteur, sinon ceux de la clé. */
          var bk = r.bookingId ? (DATA.bookingsById || {})[r.bookingId] : null;
          var pr = (bk && bk.prospect) || {};
          em = lowerTrim(pr.email) || (r.key.indexOf('e:') === 0 ? r.key.slice(2) : '');
          p9 = phone9(pr.telephone || pr.phone) || (r.key.indexOf('t:') === 0 ? r.key.slice(2) : null);
        }
        if (em && !ligneParEmail[em]) ligneParEmail[em] = r;
        if (p9 && !ligneParP9[p9]) ligneParP9[p9] = r;
      });
      function nomRdv(b) { return (b.prospect && b.prospect.nom) || b.leadName || (b.prospect && b.prospect.email) || b._id || b.id || '—'; }
      function ligneDuRdv(b) {
        if (b.leadId) return ligneParFiche[b.leadId] || null;
        var id = b._id || b.id;
        if (id && ligneParRdv[id]) return ligneParRdv[id];
        var em = lowerTrim(b.prospect && b.prospect.email);
        if (em && ligneParEmail[em]) return ligneParEmail[em];
        var p9 = phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
        return (p9 && ligneParP9[p9]) || null;
      }
      var ficheConnue = {};
      (DATA.closedLeads || []).forEach(function (l) { if (l && l._id) ficheConnue[l._id] = l; });
      var ps = P.start.getTime(), pe = P.end.getTime();
      TL.rdvCloses.forEach(function (b) {
        if (ligneDuRdv(b)) return;
        var why;
        var l = b.leadId ? (ficheConnue[b.leadId] || leadsById[b.leadId] || null) : null;
        var since = l ? parseFlexMs(l.clientSince) : null;
        if (!b.leadId) why = 'RDV au résultat « Close » sans fiche liée, non retenu comme close sur cette période : à rattacher à la fiche du client.';
        else if (l && since != null && (since < ps || since > pe)) why = 'Client gagné le ' + frJour(SC.jourParis(since)) + ' : son close est compté à cette date, pas sur cette période.';
        else if (l && since == null) why = 'RDV au résultat « Close », mais la fiche n’a pas de date de vente (jamais passée cliente) : aucun close compté. À vérifier sur la fiche.';
        else if (l) why = 'RDV au résultat « Close », mais la fiche n’est pas retenue comme close sur cette période (fiche fusionnée, ou hors du filtre affiché).';
        else why = 'RDV au résultat « Close », mais la fiche n’est pas gagnée sur cette période (gagnée à une autre date, ou jamais passée cliente) : aucun close compté ici.';
        coh.rdvClosesHorsListe.push({ name: nomRdv(b), leadId: b.leadId || null, date: b.date || '', why: why,
          sb: b._class === 'self', con: 0, paid: 0, rdvDate: b.date || '', bookingId: b._id || b.id || null });
      });

      /* Clients à deux RDV closés : tous les RDV closés connus (période +
         RDV porteurs lus par fiche), une fois chacun. */
      var parClient = {}, ordre = [], vu = {};
      function ajouteRdvClose(b) {
        if (!b || SC.detail(b) !== 'close') return;
        var cls = b._class || SC.classifyBooking(b, ctx.typeMap || {});
        if (!SC.estRdvVente(cls)) return;
        var id = b._id || b.id;
        if (id) { if (vu[id]) return; vu[id] = 1; }
        /* Clé du client : la fiche ; sinon la ligne de close déjà reconnue pour
           ce RDV (même e-mail / téléphone qu'un client compté) ; sinon son
           e-mail ou son téléphone. */
        var key = null;
        if (b.leadId) key = 'l:' + b.leadId;
        else {
          var lg = ligneDuRdv(b);
          var em = lowerTrim(b.prospect && b.prospect.email);
          var p9 = phone9(b.prospect && (b.prospect.telephone || b.prospect.phone));
          key = lg ? lg.key : (em ? 'e:' + em : p9 ? 't:' + p9 : null);
        }
        if (!key) return;
        if (!parClient[key]) { parClient[key] = []; ordre.push(key); }
        parClient[key].push(b);
      }
      (DATA.bookings || []).forEach(ajouteRdvClose);
      Object.keys(DATA.closeBookings || {}).forEach(function (id) { (DATA.closeBookings[id] || []).forEach(ajouteRdvClose); });
      var dansPeriode = {};
      TL.rdvCloses.forEach(function (b) { dansPeriode[b._id || b.id] = 1; });
      ordre.forEach(function (key) {
        var list = parClient[key];
        if (list.length < 2) return;
        list.sort(function (a, b) { var ka = rdvKey(a), kb = rdvKey(b); return ka < kb ? -1 : ka > kb ? 1 : 0; });
        var ligne = ligneDuRdv(list[0]);
        var concerne = !!ligne;
        list.forEach(function (b) { if (dansPeriode[b._id || b.id]) concerne = true; });
        if (!concerne) return;
        var dates = list.map(function (b) { return frJour(b.date); });
        coh.doublonsRdv.push({ name: nomRdv(list[0]), leadId: list[0].leadId || null, date: list[list.length - 1].date || '',
          why: list.length + ' RDV au résultat « Close » pour le même client (' + dates.join(', ') + ') : un seul close est compté' + (ligne ? ', le ' + frJour(ligne.day) : '') + '. Le canal, le closer et le setter sont ceux du premier RDV.',
          sb: list[0]._class === 'self', con: 0, paid: 0, rdvDate: list[0].date || '', bookingId: list[0]._id || list[0].id || null });
      });

      /* Repères chiffrés du bloc : Closes (liste) et RDV closés (date du RDV). */
      coh.closes = k.closes.closes;
      coh.rdvCloses = k.tenue.rdvCloses;
      /* Alias de TRANSITION (ancien bloc « funnel ↔ pages équipe ») : à ne plus
         lire — gardés pour qu'une page pas encore mise à jour ne casse pas. */
      coh.onlyFunnel = coh.closesSansRdv;
      coh.onlyPages = coh.rdvClosesHorsListe;
      coh.split = coh.ecartsCanal;
      coh.dup = coh.doublonsRdv;
      coh.pagesCloses = k.closes.closes; coh.pagesSB = k.closesSB.closes; coh.pagesNB = k.closesNB.closes;
      k.coh = coh;
    })();

    /* ── 🎨 Performance par créative — refonte attribution 17/08/2026 ──
       AXE : plus le champ `utm` (texte libre écrasé par le dernier
       engagement — c'est lui qui faisait remonter « AlteoForm - … » avec
       tous les closes des vraies créatives), mais le bloc attributionFirst
       du lead, normalisé et regroupé (voir leadAxisKey plus haut).
       TROIS axes calculés d'un coup — créative / adset / campagne : le
       sélecteur de la page bascule sans recharger ni recalculer.

       Chaque métrique garde l'axe temporel de SA section (décision 3a du
       22/07) : leads = entrés période (cohorte) · RDV pris = créés période
       (replanifs dédupliquées, comme Prise de RDV) · annulés / no-show =
       RDV ayant lieu dans la période (prédicats de la Tenue, replanifiés
       exclus) · closes = fiches gagnées clientSince période + collecté
       consolidé (_wonCol — prélèvements réellement passés, liste unique des
       closes ; jamais le collecté déclaré aux cartes). Qualifiés = leadScore
       4-5 (curseur Leads Live) ; non notés hors moyenne.

       ⚠ Le ratio RDV/leads N'EST PAS un LTB : son numérateur accepte les
       RDV de leads ré-optinés entrés avant la période (d'où les 106 % de
       la capture du 17/08). Les deux compteurs restent exposés bruts, mais
       le rendu ne les divise plus l'un par l'autre — le LTB fiable est
       celui de la section « Prise de RDV ».

       Les événements dont le lead n'est pas rattachable partent dans
       utmUnattr — affichés en note, jamais un zéro muet. */
    var CRE_IDX = buildCreativeIndex(DATA.creatives || []);
    k.creativeIndexSize = Object.keys(CRE_IDX.ad).length;

    /* Dépense ad-level de la période, sommée par ad_id (vide si Make
       n'envoie pas encore le breakdown → colonnes coût masquées). */
    var spendByAd = {}, adLevelSpend = 0;
    (DATA.adsByAd || []).forEach(function (a) {
      if (!a || !a.ad_id) return;
      /* tunnel absent = Make n'a pas su le déduire : on garde la dépense
         plutôt que de la ranger d'office en Élite (ce qui la ferait
         disparaître du filtre Business et gonfler l'Élite). */
      if (!adsInSource) return;
      if (a.tunnel && !tunnelMatch(a.tunnel === 'business' ? 'business' : 'elite')) return;
      var id = String(a.ad_id);
      if (!spendByAd[id]) spendByAd[id] = { spend: 0, impressions: 0, clicks: 0 };
      spendByAd[id].spend += Number(a.spend) || 0;
      spendByAd[id].impressions += Number(a.impressions) || 0;
      spendByAd[id].clicks += Number(a.clicks) || 0;
      adLevelSpend += Number(a.spend) || 0;
    });
    k.adLevelSpend = Math.round(adLevelSpend * 100) / 100;
    k.hasAdLevelSpend = adLevelSpend > 0;

    /* ── COUVERTURE de la dépense ad-level — garde-fou (17/08/2026) ──
       Piège constaté en production : Make n'avait ingéré QU'UNE journée,
       la colonne Dépense sommait donc un jour pendant que la colonne Leads
       comptait tout le mois. Résultat affiché : CPL 2,46 € là où Meta
       annonçait 20,19 €. Un CPL huit fois trop beau invite à augmenter un
       budget — c'est le genre de chiffre qui coûte de l'argent.
       On mesure donc combien de jours de la période ont réellement de la
       donnée, et le rendu masque les ratios tant que ce n'est pas complet.
       Borne haute = aujourd'hui : un mois en cours ne peut pas avoir de
       dépense pour ses jours à venir, ce n'est pas un trou. */
    /* Jours couverts = dates DISTINCTES des lignes ad-level qui passent les
       MÊMES filtres que la dépense (tunnel, source) ; jours attendus = du
       début de la période jusqu'à HIER (même borne que k.adsDaysExpected :
       la dépense d'un jour n'arrive que le lendemain). Période d'aujourd'hui
       seulement : complète s'il y a de la donnée. */
    var adDates = {};
    (DATA.adsByAd || []).forEach(function (a) {
      if (!a || !a.date || !adsInSource) return;
      if (a.tunnel && !tunnelMatch(a.tunnel === 'business' ? 'business' : 'elite')) return;
      adDates[a.date] = 1;
    });
    var expected = 0, coveredDays = 0;
    if (isoDate(P.start) <= finAttenduIso) {
      joursEntre(isoDate(P.start), finAttenduIso).forEach(function (jour) {
        expected++;
        if (adDates[jour]) coveredDays++;
      });
    }
    k.adSpendDaysExpected = expected;
    k.adSpendDaysCovered = coveredDays;
    k.adSpendCoverage = expected > 0 ? coveredDays / expected * 100 : null;
    /* « Complet » se juge sur les jours attendus, pas sur un pourcentage
       arrondi : 16 jours sur 17 n'est pas complet. */
    k.adSpendComplete = expected > 0 ? coveredDays >= expected : adLevelSpend > 0;
    k.adSpendOk = k.adSpendComplete;

    /* 4 axes. « Canal » n'est PAS de la publicité : il répond à « d'où
       viennent mes leads » (VSL, webinaire, Skool, bio Instagram…), la
       question que 2 741 des 8 051 fiches savent réellement documenter.
       Le mélanger aux créatives ferait passer une page pour une pub. */
    /* Qualité par pub — drapeaux par lead, calculés une fois pour les 4 axes.
       Jamais joint = aucun appel décroché (règle isAnsweredCall, répondeurs
       exclus — entrant ou sortant) ET aucun RDV, pour un lead entré depuis
       plus de 48 h (sinon le setting n'a pas eu sa chance). Faux numéros,
       disqualifiés et clients sortent de ce compte. */
    var reachedP9 = {}, bookedP9 = {}, bookedLead = {};
    (DATA.calls || []).forEach(function (c) { if (c._p9 && isAnsweredCall(c)) reachedP9[c._p9] = 1; });
    (DATA.bookings || []).concat(DATA.bookingsTtb || []).forEach(function (b) {
      if (b._class === 'excluded') return;
      if (b.leadId) bookedLead[b.leadId] = 1;
      if (b._p9) bookedP9[b._p9] = 1;
    });
    var neverRefMs = Math.min(Date.now(), lookaheadEndMs());
    cohort.forEach(function (l) {
      l._caQualif = caQualifOf(l);
      l._faux = isFauxNumeroLead(l);
      l._disq = isDisqualifiedLead(l);
      var isCli = l.isClient === true || l.stage === 'closed_won_setting' || l.stage === 'closed_won_self';
      l._neverEligible = !l._faux && !l._disq && !isCli && l._entry != null && (neverRefMs - l._entry) >= NEVER_REACHED_MIN_AGE_MS;
      l._neverReached = l._neverEligible && !(l._p9 && reachedP9[l._p9]) && !bookedLead[l._id] && !(l._p9 && bookedP9[l._p9]);
    });

    /* Appareil / Région (23/11/2026) : repli sur le bloc visiteur du premier
       RDV pris par le prospect lui-même (Self Booking sans quiz). */
    DATA.bookings.forEach(function (b) {
      if (!b || !b.visiteur || (!b.visiteur.country && !b.visiteur.device)) return;
      var vl = bookingLead(b);
      if (vl && !vl._bkVis) vl._bkVis = b.visiteur;
    });
    var AXES = ['creative', 'adset', 'campaign', 'channel', 'device', 'region'];
    var maps = { creative: {}, adset: {}, campaign: {}, channel: {}, device: {}, region: {} };
    var unattr = {};
    ['creative', 'adset', 'campaign', 'channel', 'device', 'region'].forEach(function (ax) {
      unattr[ax] = { booked: 0, cancelled: 0, noshow: 0, pitched: 0, closes: 0 };
    });

    function rowOf(axis, l) {
      var kk = leadAxisKey(l, axis, CRE_IDX);
      var m = maps[axis];
      if (!m[kk.group]) {
        m[kk.group] = { key: kk.label, group: kk.group, legacy: kk.legacy,
          outOfAds: !!kk.outOfAds, adIds: {},
          leads: 0, scoreSum: 0, scoreN: 0, qual: 0,
          booked: 0, cancelled: 0, noshow: 0, closes: 0, col: 0,
          spend: 0, impressions: 0, clicks: 0, hasSpend: false,
          /* Qualité par pub (12/11/2026) */
          caKnown: 0, qualCa: 0, faux: 0, disq: 0, neverReached: 0, neverEligible: 0,
          /* pitched = RDV pitchés (offre · close · non close) ; honored = même
             valeur, ancien nom gardé tant que ads-quality-tab.js et
             api/ads-quality-share.js le lisent. */
          pitched: 0, honored: 0, con: 0 };
      }
      var r = m[kk.group];
      /* Une ligne redevient « propre » dès qu'un seul lead y arrive avec
         une attribution structurée : le marqueur ⚠ ne survit pas à une
         fusion legacy + attribué sur le même libellé. */
      if (!kk.legacy) r.legacy = false;
      if (kk.adId) r.adIds[String(kk.adId)] = 1;
      return r;
    }

    AXES.forEach(function (axis) {
      cohort.forEach(function (l) {
        var r = rowOf(axis, l);
        r.leads++;
        if (l.leadScore >= 1 && l.leadScore <= 5) {
          r.scoreSum += l.leadScore; r.scoreN++;
          if (l.leadScore >= 4) r.qual++;
        }
        var cq = l._caQualif;
        if (cq !== null) { r.caKnown++; if (cq) r.qualCa++; }
        if (l._faux) r.faux++;
        else if (l._disq) r.disq++;
        if (l._neverEligible) { r.neverEligible++; if (l._neverReached) r.neverReached++; }
      });
      createdFunnel.forEach(function (b) {
        var ul = bookingLead(b);
        if (ul) rowOf(axis, ul).booked++; else unattr[axis].booked++;
      });
      /* Annulés / no-show / pitchés : les listes de la Tenue (StatsCore.etat),
         plus aucun prédicat local. */
      TL.annules.forEach(function (b) {
        var ul2 = bookingLead(b);
        if (ul2) rowOf(axis, ul2).cancelled++; else unattr[axis].cancelled++;
      });
      TL.noshow.forEach(function (b) {
        var ul3 = bookingLead(b);
        if (ul3) rowOf(axis, ul3).noshow++; else unattr[axis].noshow++;
      });
      TL.pitches.forEach(function (b) {          // pitched (alias honored) = PITCHÉS (offre · close · non close)
        var ul4 = bookingLead(b);
        if (ul4) { var r4 = rowOf(axis, ul4); r4.pitched++; r4.honored++; }
        else unattr[axis].pitched++;
      });
      closedLeads.forEach(function (l) {
        var r3 = rowOf(axis, l);
        r3.closes++;
        r3.col += (l._wonCol || 0);
        r3.con += (l._wonCon || 0);
      });
      unattr[axis].closes = closesSansFiche;
    });

    /* Dépense par ligne : somme des ad_id rattachés à la ligne.
       ⚠ Un même ad_id PEUT se retrouver sur deux lignes d'un même axe —
       une pub renommée entre deux leads produit deux libellés. Sans garde,
       sa dépense serait comptée deux fois et le total des colonnes
       dépasserait la dépense réelle. On l'attribue donc à UNE seule ligne :
       la plus grosse en volume de leads (rows parcourues dans cet ordre).
       Si AUCUN ad_id n'est connu pour la ligne, hasSpend reste false et le
       rendu affiche « — » plutôt qu'un 0 € qui se lirait « pub gratuite ». */
    AXES.forEach(function (axis) {
      var claimed = {};
      var ordered = Object.keys(maps[axis]).sort(function (ga, gb) {
        return maps[axis][gb].leads - maps[axis][ga].leads;
      });
      ordered.forEach(function (g) {
        var r = maps[axis][g];
        Object.keys(r.adIds).forEach(function (id) {
          var s = spendByAd[id];
          if (!s || claimed[id]) return;
          claimed[id] = 1;
          r.spend += s.spend; r.impressions += s.impressions; r.clicks += s.clicks;
          r.hasSpend = true;
        });
        r.spend = Math.round(r.spend * 100) / 100;
        r.col = Math.round(r.col * 100) / 100;
        r.cpl  = (r.hasSpend && r.leads > 0)  ? r.spend / r.leads  : null;
        r.roas = (r.hasSpend && r.spend > 0 && r.col > 0) ? r.col / r.spend : null;
        r.con = Math.round(r.con * 100) / 100;
        /* Les trois coûts mis en avant (Qualité par pub). Sans dépense connue
           → null (« — »), jamais un 0 € qui se lirait « pub gratuite ». */
        r.cpq = (r.hasSpend && r.qualCa > 0) ? r.spend / r.qualCa : null;
        r.cph = (r.hasSpend && r.pitched > 0) ? r.spend / r.pitched : null;   /* coût par RDV pitché */
        r.cpv = (r.hasSpend && r.closes > 0) ? r.spend / r.closes : null;
        r.smallSample = r.leads < 10;
        r.adIdList = Object.keys(r.adIds);
        delete r.adIds;
      });
    });

    /* Les lignes « hors pub » descendent en bas quel que soit leur volume :
       sur un axe publicitaire, 30 leads Instagram ne doivent pas coiffer le
       classement des créatives. Elles restent comptées, simplement rangées
       après ce que l'axe est censé mesurer. */
    function sortRows(m) {
      return Object.keys(m).map(function (g) { return m[g]; })
        .sort(function (a, b) {
          if (!!a.outOfAds !== !!b.outOfAds) return a.outOfAds ? 1 : -1;
          return (b.leads - a.leads) || (b.closes - a.closes) ||
                 (a.key < b.key ? -1 : (a.key > b.key ? 1 : 0));
        });
    }
    k.utmRowsByAxis = {
      creative: sortRows(maps.creative),
      adset:    sortRows(maps.adset),
      campaign: sortRows(maps.campaign),
      channel:  sortRows(maps.channel),
      device:   sortRows(maps.device),
      region:   sortRows(maps.region)
    };
    k.utmUnattrByAxis = unattr;
    /* Dépense pub « rattachée à une ligne » par axe (Σ des lignes) — la
       Dépense pub du compte (k.spend) moins ce montant = dépense non rattachée
       (pub sans lead, jour non reçu au niveau pub, saisie manuelle). */
    k.utmSpendRattacheByAxis = {};
    AXES.forEach(function (axis) {
      var t = 0;
      Object.keys(maps[axis]).forEach(function (g) { t += maps[axis][g].spend || 0; });
      k.utmSpendRattacheByAxis[axis] = Math.round(t * 100) / 100;
    });
    /* Compat : api/agency-funnel.js et l'export lisent encore ces deux clés. */
    k.utmRows = k.utmRowsByAxis.creative;
    k.utmUnattr = unattr.creative;
    /* Part de la cohorte réellement attribuée — c'est CE chiffre qui dit
       si le tableau est exploitable, pas le nombre de lignes. */
    var attributed = 0;
    cohort.forEach(function (l) { if (leadAttribution(l)) attributed++; });
    k.attributedLeads = attributed;
    k.attributedPct = cohort.length > 0 ? attributed / cohort.length * 100 : null;

    /* ── ROAS ────────────────────────────────────────────────────────
       roasAds est le vrai : collecté des clients VENUS DE LA PUB ÷ dépense
       pub. L'ancien roasOutcome divisait TOUT le collecté par la dépense
       publicitaire — il créditait donc les pubs des ventes issues
       d'Instagram organique, du setting téléphonique et des liens partagés
       à la main. Sur août, 8 600 € au numérateur dont 5 650 € hors pub :
       le ROAS était presque trois fois trop beau.
       Les closes non rattachables à une fiche (détectés via Paiements,
       close sans lead) restent HORS du numérateur publicitaire : on ne
       crédite pas la pub d'un chiffre dont on ignore l'origine. */
    k.wonCollecteAds = Math.round(wonColAds * 100) / 100;
    k.wonContracteAds = Math.round(wonConAds * 100) / 100;
    k.closesWonAds = closesAds;
    k.wonCollecteHorsPub = Math.round(wonColHorsPub * 100) / 100;
    k.closesWonHorsPub = closesHorsPub;
    /* Non rattachable : ni pub, ni hors pub — aucune fiche à interroger. */
    k.wonCollecteNonRattache = Math.round((k.wonCollecte - wonColAds - wonColHorsPub) * 100) / 100;

    k.roasAds = (k.spend > 0 && wonColAds > 0) ? wonColAds / k.spend : null;
    /* Un ROAS « organique » a été écarté (Adrien, 17/08) : l'organique n'a
       pas de budget média propre, le rapporter à la dépense publicitaire
       n'aurait mesuré l'efficacité de rien. Le collecté hors pub reste
       exposé en euros — k.wonCollecteHorsPub — pour que l'écart avec le
       total soit lisible sans être déguisé en ratio.
       Le second ROAS est calculé plus bas, une fois les coûts connus. */
    k.cacAds  = (k.spend > 0 && closesAds > 0) ? k.spend / closesAds : null;
    /* k.aovAds = « Collecté / close » des clients venus de la pub (le mot
       « AOV » disparaît) ; leur panier moyen (contracté ÷ closes) est à part. */
    k.aovAds  = (closesAds > 0 && wonColAds > 0) ? wonColAds / closesAds : null;
    k.panierMoyenAds = closesAds > 0 ? wonConAds / closesAds : null;

    /* « ROAS pub » = k.roasAds, et LUI SEUL porte le mot ROAS (audit
       25/11/2026). Le rapport de TOUT le collecté (pub, organique, setting) à
       la seule dépense pub n'est PAS un ROAS : il s'appelle « Collecté total ÷
       dépense pub » (k.collecteSurDepense). k.roasOutcome = même valeur, ancien
       nom gardé pour le lien Agence — à ne plus afficher sous le mot ROAS. */
    k.collecteSurDepense = (k.spend > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.spend : null;
    k.roasOutcome = k.collecteSurDepense;

    /* ── Taux de close (décision D3) — UNE formule, StatsCore.tauxClose :
       numérateur = « Closes », le chiffre affiché (liste unique, date de la
       vente) ; dénominateur = RDV, Présents ou Pitchés de la MÊME période et
       du MÊME périmètre (axe date du RDV). Un close est daté du jour de la
       vente, un RDV du jour où il a lieu : si les closes dépassent la base
       (période courte), le taux n'a pas de sens → null (« — »), jamais un
       pourcentage au-dessus de 100. ── */
    function tauxCloseDe(closes, t) {
      return { rdv: SC.tauxClose(closes, t.rdv), presents: SC.tauxClose(closes, t.presents), pitches: SC.tauxClose(closes, t.pitches) };
    }
    k.tauxClose = tauxCloseDe(k.closes.closes, k.tenue);
    k.tauxCloseSB = tauxCloseDe(k.closesSB.closes, k.tenueSB);
    k.tauxCloseNB = tauxCloseDe(k.closesNB.closes, k.tenueNB);
    /* Anciens noms (pages, lien Agence) : mêmes valeurs. */
    k.closeRateRdv   = k.tauxClose.rdv;
    k.closeRateLive  = k.tauxClose.presents;
    k.closeRateOffre = k.tauxClose.pitches;

    /* ── Rentabilité — 100 % réel ── */
    k.cacMarketOnly = (k.spend > 0 && k.closesWonTotal > 0) ? k.spend / k.closesWonTotal : null;
    /* k.aovAll / k.aov = « Collecté / close » (collecté à ce jour ÷ closes) :
       le mot « AOV » disparaît des écrans. Le panier moyen (contracté ÷
       closes) est k.panierMoyen. */
    k.aovAll = (k.closesWonTotal > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.closesWonTotal : null;
    k.aov = k.aovAll;

    /* ── Coût du setting (décision Vincent + Adrien 14/07, revu le 25/11) ──
       Coût setting = fixe + outils + commissions de setting de la période.
       · fixe & outils : _config/funnel_costs, proratisés JOUR PAR JOUR (jours
         de Paris) ; sur une période EN COURS, arrêtés à AUJOURD'HUI — comme
         la dépense, les RDV et le collecté auxquels on les compare
         (k.costDaysDone sur k.costDaysTotal). Rien ne change sur une période
         passée.
       · commissions : deals 'Setting' du module Commissions datés dans la
         période (comm + bonus), DUES (validées ou non — k.commSettingOk =
         part validée). k.commSettingSB = commissions de setting de closes
         Self Booking, k.commSettingNB = le reste.
       Coût / RDV pris NB = (fixe + outils + commissions NB) ÷ RDV pris NB
       (= Sets, k.chNB.n — dénominateur k.costPerRdvNBBase). Les commissions
       d'un close Self Booking n'achètent pas un RDV du setting.
       Filtre tunnel / source actif (k.costFiltered) : les coûts du setting ne
       se ventilent pas → les ratios qui les mélangent à des chiffres filtrés
       sont null (« — »).
       Coûts non renseignés → « — », jamais un chiffre inventé. ── */
    k.costFiltered = tunnelFilter !== 'all' || sourceFilter !== 'all';
    k.commSetting = 0; k.commSettingN = 0; k.commSettingSB = 0; k.commSettingNB = 0; k.commSettingOk = 0;
    k.commSettingSbInconnu = 0;
    (DATA.settingDeals || []).forEach(function (dl) {
      var c = Number(dl.comm) || 0;
      k.commSetting += c; k.commSettingN++;
      if (dl.ok === true) k.commSettingOk += c;
      if (dl.sb === true) k.commSettingSB += c;
      else { k.commSettingNB += c; if (dl.sb == null) k.commSettingSbInconnu++; }
    });
    k.commSetting = Math.round(k.commSetting * 100) / 100;
    k.commSettingSB = Math.round(k.commSettingSB * 100) / 100;
    k.commSettingNB = Math.round(k.commSettingNB * 100) / 100;
    k.commSettingOk = Math.round(k.commSettingOk * 100) / 100;
    var fixeSum = 0, outilsSum = 0, daysMissing = 0, costSrc = null;
    var costFinIso = isoDate(Math.min(P.end.getTime(), NOW));
    var joursCout = isoDate(P.start) <= costFinIso ? joursEntre(isoDate(P.start), costFinIso) : [];
    k.costDaysTotal = joursEntre(isoDate(P.start), isoDate(P.end)).length;
    k.costDaysDone = joursCout.length;
    k.costDaysElapsed = k.costDaysDone;          /* même valeur, autre nom (fiches d'audit) */
    if (DATA.costs) {
      /* Un jour de Paris à la fois (référentiel §7) : le mois d'un jour et le
         nombre de jours de ce mois se lisent sur sa clé 'AAAA-MM-JJ'. */
      joursCout.forEach(function (jour) {
        var mk2 = jour.slice(0, 7);
        var eff = effectiveCosts(DATA.costs, mk2);
        if (!eff) { daysMissing++; return; }
        var dim = joursDuMois(+jour.slice(0, 4), +jour.slice(5, 7));
        fixeSum += eff.fixe / dim;
        outilsSum += eff.outils / dim;
        costSrc = eff.src;
      });
    } else daysMissing = 1;
    k.costFixe = Math.round(fixeSum * 100) / 100;
    k.costOutils = Math.round(outilsSum * 100) / 100;
    k.costConfigured = daysMissing === 0 && !!DATA.costs && Object.keys(DATA.costs).length > 0;
    k.costSrcMonth = costSrc;
    /* Le mois affiché a-t-il sa PROPRE entrée ? (les outils sont variables :
       une valeur reportée d'un mois précédent doit être signalée, pas subie) */
    var mkStart = SC.moisParis(P.start);
    k.costOwnEntry = !!(DATA.costs && DATA.costs[mkStart]);
    k.costSetting = k.costConfigured ? Math.round((k.costFixe + k.costOutils + k.commSetting) * 100) / 100 : null;
    k.costPerRdvNBBase = k.chNB.n;               /* RDV pris NB = Sets */
    k.costPerRdvNB = (k.costConfigured && !k.costFiltered && k.chNB.n > 0)
      ? (k.costFixe + k.costOutils + k.commSettingNB) / k.chNB.n : null;

    /* ── ROAS pub + setting — tout le collecté ÷ (dépense pub + coût setting).
       Ce n'est PAS « tous les coûts » : ni les commissions de closing, ni le
       fixe des closers n'y sont. D'où son nom (k.roasPubSetting) et celui de
       la marge (k.margeAvantClosing). k.roasGlobal / k.margeGlobale : mêmes
       valeurs, anciens noms — à ne plus afficher sous « ROAS global ».
       Sans coûts renseignés, ou sous filtre tunnel / source → null : jamais
       un ratio sur un dénominateur amputé, flatteur donc pire qu'une case
       vide. */
    k.coutTotal = (k.costSetting != null && !k.costFiltered) ? Math.round((k.spend + k.costSetting) * 100) / 100 : null;
    k.roasPubSetting = (k.coutTotal > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.coutTotal : null;
    k.margeAvantClosing = k.coutTotal != null ? Math.round((k.wonCollecte - k.coutTotal) * 100) / 100 : null;
    k.roasGlobal = k.roasPubSetting;
    k.margeGlobale = k.margeAvantClosing;

    /* Leads restants côté setting = Leads NB reçus (même règle que Set NB). */
    k.leadsNoSB = k.leadsNbRecus;

    return k;
  }

  /* ══════════════════════════════════════════════════════════════════
     PÉRIODES — un P = { mode, start, end } (end inclusif, 23:59:59.999)
     ------------------------------------------------------------------
     Bornes TOUJOURS à l'heure de PARIS (référentiel §7), quel que soit le
     fuseau de l'appareil ou du serveur : « novembre » commence le 01/11 à
     00:00 à Paris pour l'équipe, pour une média buyeuse à l'étranger et pour
     une Vercel Function (qui tourne en UTC). Avant le 25/11/2026 les bornes
     étaient à l'heure de l'appareil.
     ══════════════════════════════════════════════════════════════════ */
  function periodMonth(y, m) {
    return { mode: 'month', y: y, m: m,
      start: SC.dateParis(y, m, 1, 0, 0, 0, 0),
      end:   SC.dateParis(y, m + 1, 0, 23, 59, 59, 999) };
  }
  function periodDay(iso) {
    return { mode: 'day', day: iso, start: SC.debutJourParis(iso), end: SC.finJourParis(iso) };
  }
  /* Les N derniers jours, aujourd'hui (jour de Paris) compris. */
  function periodPreset(days) {
    var today = SC.jourParis(Date.now());
    var p = today.split('-');
    return { mode: days + 'd',
      start: SC.dateParis(+p[0], +p[1] - 1, +p[2] - (days - 1), 0, 0, 0, 0),
      end:   SC.finJourParis(today) };
  }
  function periodCustom(aIso, bIso) {
    return { mode: 'custom', start: SC.debutJourParis(aIso), end: SC.finJourParis(bIso) };
  }
  function periodLabelParts(P) {
    return { startIso: isoDate(P.start), endIso: isoDate(P.end), mode: P.mode };
  }

  /* ══════════════════════════════════════════════════════════════════
     RÉFÉRENTIELS — types de RDV et équipe (nécessaires aux loaders)
     ══════════════════════════════════════════════════════════════════ */
  function buildTypeMap(list) {
    var TYPE_MAP = {};
    (list || []).forEach(function (t) {
      if (t && t.id) TYPE_MAP[t.id] = {
        isSetterOnly: t.isSetterOnly === true,
        isCoaching: t.isCoaching === true,
        label: t.label || t.id
      };
    });
    return TYPE_MAP;
  }
  /* Métadonnées des tunnels hébergés — noms de tunnel, d'étape et de variante
     pour la lecture par tunnel › page › variante du Funnel Sales. Lecture
     réservée aux admins (firestore.rules) : à défaut, libellés du beacon. */
  function loadTunnelsMeta(db, DATA) {
    DATA.tunnelsMeta = {};
    return db.collection('tunnels').get().then(function (snap) {
      snap.forEach(function (doc) {
        var t = doc.data() || {};
        if (t.archived === true || !t.slug) return;
        var steps = {};
        (t.steps || []).forEach(function (s, si) {
          if (!s || !s.slug || s.archived === true) return;
          var vars = {};
          (s.variants || []).forEach(function (v) {
            if (v && v.id) vars[String(v.id)] = { label: v.label || '', weight: Number(v.weight) || 0, status: v.status || '' };
          });
          steps[String(s.slug)] = { name: s.name || s.slug, type: s.type || 'page', variants: vars, source: s.trackingSource || '', order: si };
        });
        DATA.tunnelsMeta[String(t.slug)] = { name: t.name || t.slug, kind: t.kind || 'funnel', steps: steps,
          source: (t.settings && t.settings.trackingSource) || '' };
      });
    }).catch(function () { DATA.tunnelsMeta = {}; });
  }

  function loadTypeMap(db) {
    return db.collection('booking_config').doc('_types').get().then(function (snap) {
      return buildTypeMap((snap.exists && snap.data().list) || []);
    }).catch(function (e) { console.warn('[funnel-core] types', e.message); return {}; });
  }
  /* FICHES D'AGENDA (booking_config, __type === 'person') → DATA.persons
     { personId: { firebaseUid, name } }. Sert à trouver l'HÔTE d'un RDV
     (closer d'un RDV et d'un close) quand le RDV ne porte pas de closer
     validé : expertSlug n'est presque jamais posé, l'hôte n'est connu que par
     personId. Lecture en échec : DATA.personsError, dit à l'écran (sinon les
     RDV de cet hôte tomberaient en « Non attribué » sans explication). */
  function loadPersons(db, DATA) {
    DATA.persons = {};
    DATA.personsError = null;
    return db.collection('booking_config').get().then(function (snap) {
      snap.forEach(function (doc) {
        var d = doc.data() || {};
        if (d.__type === 'person') DATA.persons[doc.id] = { firebaseUid: d.firebaseUid || null, name: d.name || doc.id };
      });
    }).catch(function (e) { DATA.personsError = (e && e.message) || 'lecture impossible'; });
  }
  /* RÉSOLVEUR D'HÔTE (revue D13) — la règle de Close SB / Global closing
     (sales-closing.html), d'AlteoreFlow.loadPersonsMap et de Qualité leads
     (lqs-core.js, resoudreLocal) : personId d'une fiche d'agenda → membre du
     roster dont le slug est ce personId, sinon dont le firebaseUid est celui
     de la fiche d'agenda. null = inconnu (« Non attribué »). Aucun repli
     « même prénom ».
     persons = { personId: { firebaseUid } } ; team = roster (tableau, ou
     objet { slug: membre }), anciens membres compris : un ancien membre est
     résolu (son activité reste dans les totaux), c'est l'écran qui le
     range en « Anciens membres ».
     → function (personId) → slug | null, à passer à StatsCore.closerDuRdv. */
  function resoudreAvec(persons, team) {
    var bySlug = {}, byUid = {};
    var list = Array.isArray(team) ? team : Object.keys(team || {}).map(function (k) {
      var m = team[k]; if (m && typeof m === 'object' && !m.slug) { var c = {}; Object.keys(m).forEach(function (f) { c[f] = m[f]; }); c.slug = k; return c; } return m;
    });
    list.forEach(function (m) {
      if (!m || !m.slug) return;
      bySlug[m.slug] = m;
      if (m.firebaseUid && !byUid[m.firebaseUid]) byUid[m.firebaseUid] = m;
    });
    var P = persons || {};
    return function (personId) {
      if (!personId) return null;
      if (bySlug[personId]) return personId;
      var p = P[personId];
      var m = p && p.firebaseUid ? byUid[p.firebaseUid] : null;
      return m ? m.slug : null;
    };
  }
  /* Le résolveur PAR DÉFAUT d'un chargement loadAll : fiches d'agenda lues
     (DATA.persons) + roster complet (DATA.teamFull) réuni à `team` (liste
     de la page, facultative). C'est celui qu'utilise computeKpis quand la
     page n'en passe pas ; sales-funnel.html l'utilise pour ses listes
     (closer d'un RDV : SC.closerDuRdv(b, FC.resoudrePersonneDe(DATA))). */
  function resoudrePersonneDe(DATA, team) {
    DATA = DATA || {};
    return resoudreAvec(DATA.persons || {}, mergeTeam(team || [], DATA.teamFull || []));
  }

  /* Équipe — même source de vérité que nav.js (_meta/team_members), qui
     accepte `members` en objet OU en tableau (Firestore array-ifie parfois). */
  function loadTeamMembers(db) {
    return db.collection('_meta').doc('team_members').get().then(function (snap) {
      if (!snap.exists) return [];
      var raw = (snap.data() || {}).members;
      var list = [];
      if (Array.isArray(raw)) {
        raw.forEach(function (e, i) {
          if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || ('m' + i) }, e));
        });
      } else if (raw && typeof raw === 'object') {
        Object.keys(raw).forEach(function (slug) {
          var e = raw[slug];
          if (e && typeof e === 'object') list.push(Object.assign({ slug: e.slug || slug }, e));
        });
      }
      list.sort(function (a, b) { return (a.order || 999) - (b.order || 999); });
      return list;
    }).catch(function (e) {
      console.warn('[funnel-core] team', e.message);
      /* Toujours un tableau (les appelants l'énumèrent), mais l'échec est
         porté par une propriété non énumérable : loadAll le dit à l'écran. */
      var vide = [];
      try { Object.defineProperty(vide, '_erreur', { value: e.message || 'lecture impossible', enumerable: false }); } catch (x) { /* rien */ }
      return vide;
    });
  }

  /* ══════════════════════════════════════════════════════════════════
     CHARGEMENT COMPLET — même pipeline que refresh() dans sales-funnel.html
     ══════════════════════════════════════════════════════════════════ */
  function emptyData() {
    return { ads: [], adsByAd: [], creatives: [], views: [], leads: [], reoptins: [],
      bookings: [], bookingsById: {},
      bookingsTtb: [], calls: [], costs: null, settingDeals: [], journalPeriod: [],
      actions: [], closedLeads: [], payments: [],
      /* RDV porteurs des closes, lus par fiche (loadCloseBookings). */
      closeBookings: {},
      leadsTruncated: false, callsTruncated: false,
      /* Lectures tronquées ou en échec : remontées dans K (k.erreursLecture). */
      closedLeadsTruncated: false, closedLeadsError: null, paymentsError: null,
      bookingsError: null, closeBookingsError: null,
      /* Fiches d'agenda (hôte d'un RDV → membre), lues par loadPersons. */
      persons: {}, personsError: null,
      leadsError: null, leadsTest: 0, reoptinsTruncated: false, reoptinsError: null, reoptinsEcartes: 0,
      callsError: null, adsError: null, adsByAdError: null, viewsError: null, creativesError: null,
      costsError: null, settingDealsError: null, actionsError: null, teamError: null,
      /* Roster COMPLET (anciens membres compris), relu par loadAll. */
      teamFull: [] };
  }

  /* opts = { P, typeMap, teamMembers } — typeMap/teamMembers sont chargés
     ici s'ils ne sont pas fournis (cas serveur). */
  function loadAll(db, opts) {
    var P = opts.P;
    var DATA = emptyData();
    var pre = [];
    var TYPE_MAP = opts.typeMap;
    var TEAM = opts.teamMembers;
    if (!TYPE_MAP) pre.push(loadTypeMap(db).then(function (m) { TYPE_MAP = m; }));
    /* Roster COMPLET, toujours relu (une lecture) : les pages passent souvent
       la liste SANS les anciens membres, et leur journal, leurs commissions et
       leurs appels doivent rester dans les totaux (décision D10). */
    pre.push(loadTeamMembers(db).then(function (l) {
      DATA.teamFull = l || [];
      if (l && l._erreur) DATA.teamError = l._erreur;
      TEAM = mergeTeam(TEAM || [], DATA.teamFull);
    }));

    return Promise.all(pre).then(function () {
      return Promise.all([
        loadAds(db, P, DATA), loadAdsByAd(db, P, DATA), loadCreatives(db, DATA),
        loadViews(db, P, DATA),
        /* Leads : la lecture rejette en cas d'échec (contrat des autres
           appelants) — ici l'échec est gardé pour être DIT (k.erreursLecture). */
        loadLeads(db, P, DATA).catch(function () { DATA.leads = DATA.leads || []; DATA.reoptins = DATA.reoptins || []; }),
        loadBookings(db, P, DATA, TYPE_MAP), loadCalls(db, P, DATA),
        loadFunnelCosts(db, DATA), loadSettingDeals(db, P, DATA, TEAM),
        loadJournalPeriod(db, P, DATA), loadActionsAll(db, P, DATA, TEAM),
        loadClosedLeads(db, P, DATA), loadPayments(db, DATA), loadTunnelsMeta(db, DATA),
        loadPersons(db, DATA)
      ]);
    })
    .then(function () { return resolveChains(db, DATA, TYPE_MAP); })
    .then(function () { return resolvePaymentLeads(db, P, DATA); })
    /* RDV porteurs des closes (canal, closer, setter) : APRÈS
       resolvePaymentLeads, qui dit quelles fiches portent un close repéré par
       le paiement. Sans cette lecture, un close dont le RDV est daté hors de
       la période n'aurait pas de RDV porteur. */
    .then(function () { return loadCloseBookings(db, DATA, TYPE_MAP); })
    .then(function () { return { DATA: DATA, typeMap: TYPE_MAP, teamMembers: TEAM }; });
  }

  return {
    /* Constantes */
    ANSWERED_MIN_SEC: ANSWERED_MIN_SEC,
    isAnsweredCall: isAnsweredCall, ringingSecOf: ringingSecOf,
    isAdvertisingLead: isAdvertisingLead,
    /* Qualité par pub / API Conversions (12/11/2026) */
    CA_QUALIF_SEUIL: CA_QUALIF_SEUIL, caQualifOf: caQualifOf, caQualifOfText: caQualifOfText,
    caDeclaredOf: caDeclaredOf, isFauxNumeroLead: isFauxNumeroLead, isDisqualifiedLead: isDisqualifiedLead,
    JOURNAL_GOLIVE: JOURNAL_GOLIVE,
    TTX_LOOKAHEAD_MS: TTX_LOOKAHEAD_MS,
    LEADS_QUERY_LIMIT: LEADS_QUERY_LIMIT,
    CALLS_QUERY_LIMIT: CALLS_QUERY_LIMIT,
    /* Helpers réutilisés par les pages (rendu, tri, export) */
    decodeUtm: decodeUtm, utmKeyOf: utmKeyOf, parseFlexMs: parseFlexMs,
    /* Attribution — consommé par les Vercel Functions d'entrée
       (api/lead-optin.js, api/alteoform-submit.js) ET par le rendu. */
    ATTR_FIELDS: ATTR_FIELDS, parseAttribution: parseAttribution,
    attrHasSignal: attrHasSignal, attrDecodeValue: attrDecodeValue,
    attrIsPlaceholder: attrIsPlaceholder, parseQueryPairs: parseQueryPairs,
    leadAttribution: leadAttribution, normalizeCreative: normalizeCreative,
    creativeGroupKey: creativeGroupKey, creativeMatchKey: creativeMatchKey,
    buildCreativeIndex: buildCreativeIndex, refAdOf: refAdOf,
    axisValueOf: axisValueOf, leadAxisKey: leadAxisKey,
    /* Visiteur : lieu et appareil (23/11/2026) */
    uaDevice: uaDevice, visiteurOf: visiteurOf, deviceLabel: deviceLabel, placeLabel: placeLabel,
    zoneOf: zoneOf, frRegion: frRegion, countryName: countryName, visiteurAxisKey: visiteurAxisKey,
    classifyLegacyLabel: classifyLegacyLabel,
    realEntryMs: realEntryMs, pad2: pad2, isoDate: isoDate, median: median,
    phone9: phone9, leadTunnel: leadTunnel, frDateMs: frDateMs,
    /* REVENUE — close annulé / encaissé réel (SET NB, Close SB, Projections) */
    revHT: revHT, revIndex: revIndex, revPaymentsFor: revPaymentsFor,
    revPaidEntries: revPaidEntries, revPaidHT: revPaidHT, revClient: revClient,
    /* « Prélevé sur la période » : prélèvements datés dans la période, tous clients. */
    cashInPeriod: cashInPeriod,
    /* CLOSES — la liste unique (25/11/2026) */
    buildCloses: buildCloses, sumCloses: sumCloses, loadCloses: loadCloses, loadCloseBookings: loadCloseBookings,
    CLOSED_LEADS_LIMIT: CLOSED_LEADS_LIMIT,
    /* RDV : terminal d'une chaîne (report / transfert) et origine d'un RDV
       compté à sa date ('periode' | 'avant' | 'reporte' | 'inconnu'). */
    rdvTerminal: rdvTerminal, origineRdv: origineRdv,
    /* Calendrier pur : jours d'une plage 'AAAA-MM-JJ', jour suivant. */
    joursEntre: joursEntre, jourSuivant: jourSuivant,
    isYoutubeSource: isYoutubeSource, leadSource: leadSource,
    bookingSource: bookingSource, pageSource: pageSource,
    effectiveCosts: effectiveCosts, classifyBooking: classifyBooking,
    /* Périodes */
    periodMonth: periodMonth, periodDay: periodDay, periodPreset: periodPreset,
    periodCustom: periodCustom, periodLabelParts: periodLabelParts,
    /* Référentiels + chargement + calcul */
    buildTypeMap: buildTypeMap, loadTypeMap: loadTypeMap, loadTeamMembers: loadTeamMembers,
    emptyData: emptyData, loadAll: loadAll, computeKpis: computeKpis,
    /* Loaders unitaires — sales-funnel.html en rappelle certains seuls après
       une sauvegarde (grille Ads, coûts, journal) sans tout recharger. */
    loadAds: loadAds, loadAdsByAd: loadAdsByAd, loadCreatives: loadCreatives,
    isVslPage: isVslPage, pageTunnel: pageTunnel,
    loadViews: loadViews, loadLeads: loadLeads,
    loadBookings: loadBookings, loadClosedLeads: loadClosedLeads,
    loadPayments: loadPayments, loadCalls: loadCalls,
    loadFunnelCosts: loadFunnelCosts, loadSettingDeals: loadSettingDeals,
    loadJournalPeriod: loadJournalPeriod, loadActionsAll: loadActionsAll,
    resolveChains: resolveChains, resolvePaymentLeads: resolvePaymentLeads,
    /* Étape 2 de l'audit (25/11/2026) — règles uniques leads / appels / équipe */
    REOPTINS_QUERY_LIMIT: REOPTINS_QUERY_LIMIT, PAGE_SIZE: PAGE_SIZE, CONTACT_WINDOW_MS: CONTACT_WINDOW_MS,
    lirePages: lirePages,
    isDeparted: isDeparted, mergeTeam: mergeTeam,
    isCountedLead: isCountedLead, isClientLead: isClientLead, trueOptinTimes: trueOptinTimes,
    leadsWorked: leadsWorked, leadsNbRecus: leadsNbRecus,
    callStats: callStats, callerIndex: callerIndex, callerOf: callerOf, leadContact: leadContact,
    /* Revue contradictoire (25/11/2026) */
    perimetreAppel: perimetreAppel, appelEquipeSales: appelEquipeSales, SALES_CALL_ROLES: SALES_CALL_ROLES,
    jourAction: jourAction, resoudreAvec: resoudreAvec, resoudrePersonneDe: resoudrePersonneDe, loadPersons: loadPersons,
    adsTunnelOf: adsTunnelOf
  };
}));
