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
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.FunnelCore = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ── Constantes métier (déplacées depuis sales-funnel.html) ── */
  var LEADS_QUERY_LIMIT = 6000;
  var CALLS_QUERY_LIMIT = 5000;
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
  function ringingSecOf(c) {
    if (!c) return null;
    var r = Number(c.ringingDurationSec);
    if (isFinite(r) && r >= 0) return r;          // 1. posé au sync (depuis le 17/08)

    var ansMs = parseFlexMs(c.answeredAt);        // 2. horodatages du webhook
    var iniMs = parseFlexMs(c.initiatedAt);
    if (ansMs != null && iniMs != null && ansMs >= iniMs) {
      return Math.round((ansMs - iniMs) / 1000);
    }

    var tot = Number(c.totalDurationSec);         // 3. déduction totale − conversation
    var talk = Number(c.durationSec) || 0;
    if (!isFinite(tot) || tot <= 0) return null;  // inconnue → aucune exclusion
    var diff = tot - talk;
    return diff > 0 ? diff : 0;
  }

  function isAnsweredCall(c) {
    var talk = Number(c && c.durationSec) || 0;
    if (talk < ANSWERED_MIN_SEC) return false;
    var ring = ringingSecOf(c);
    if (ring == null) return true;                // sonnerie inconnue : on garde
    if (ring >= VOICEMAIL_MIN_RING_SEC && talk < VOICEMAIL_MAX_TALK_SEC) return false;
    return true;
  }

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

  function leadAxisKey(l, axis, IDX) {
    var ax = axis || 'creative';
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
    var legacyKind = classifyLegacyLabel(l && l.utm).kind;
    var estPub = !!leadAttribution(l) ||
                 legacyKind === 'ad_id' || legacyKind === 'creative' || legacyKind === 'adset';
    if (estPub) {
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
      var d = new Date(+iso[1], +iso[2] - 1, +iso[3], +(iso[4] || 0), +(iso[5] || 0), +(iso[6] || 0));
      return isNaN(d.getTime()) ? null : d.getTime();
    }
    var fr = s.match(/(\d{1,2})\s+([A-Za-zàâäéèêëïîôöûüç]+)\.?\s+(\d{4})/);
    if (fr) {
      var table = [['janv',0],['févr',1],['fevr',1],['mars',2],['avri',3],['mai',4],['juin',5],['juil',6],['aout',7],['août',7],['sept',8],['octo',9],['nove',10],['déce',11],['dece',11]];
      var mn = fr[2].toLowerCase(); var idx = -1;
      for (var i = 0; i < table.length; i++) { if (mn.indexOf(table[i][0]) === 0) { idx = table[i][1]; break; } }
      if (idx >= 0) { var d2 = new Date(+fr[3], idx, +fr[1]); return isNaN(d2.getTime()) ? null : d2.getTime(); }
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

  /* ── Formats ── */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function isoDate(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

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
  function leadTunnel(l) {
    var t = (String(l.type || '') + ' ' + String(l.utm || '') + ' ' + String(l.sourceDetail || '')).toLowerCase();
    if (t.indexOf('business') >= 0) return 'business';
    return 'elite';
  }

  /* Date FR 'DD/MM/YYYY' → ms (deals Commissions). */
  function frDateMs(v) {
    var m = String(v || '').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!m) return parseFlexMs(v);
    var d = new Date(+m[3], +m[2] - 1, +m[1], 12, 0, 0, 0);
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
  function classifyBooking(b, TYPE_MAP) {
    var t = TYPE_MAP[b.type] || {};
    if (b.isCoaching === true || t.isCoaching === true) return 'excluded';
    if (b.source === 'csm_manual' || b.skipLeadCreation === true || b.clientId) return 'excluded';
    if (b.source === 'admin_manual') return 'admin';
    if (b.source === 'setter_booking') return 'setter';
    if (t.isSetterOnly === true) return 'setter';   // type setter = NB, quel que soit le source
    if (b.source === 'self_booking') return 'self';
    return 'self';
  }


  function loadAds(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('ads_insights').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.ads = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.ads.push(d); });
    }).catch(function (e) { console.warn('[funnel] ads', e.message); DATA.ads = []; });
  }

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
      }).catch(function (e) { console.warn('[funnel] adsByAd', e.message); DATA.adsByAd = []; });
  }

  /* Référentiel créatives — ads_creatives/{ad_id} : { ad_id, ad_name,
     adset_id, adset_name, campaign_id, campaign_name }. Sert à rendre
     lisibles les UTM qui ne portent qu'un identifiant numérique (template
     Meta réglé sur {{ad.id}}). Petite collection → chargée en entier. */
  function loadCreatives(db, DATA) {
    return db.collection('ads_creatives').get().then(function (snap) {
      DATA.creatives = [];
      snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; if (!d.ad_id) d.ad_id = doc.id; DATA.creatives.push(d); });
    }).catch(function (e) { console.warn('[funnel] creatives', e.message); DATA.creatives = []; });
  }

  function loadViews(db, P, DATA) {
    var sIso = isoDate(P.start), eIso = isoDate(P.end);
    return db.collection('page_views_daily').where('date', '>=', sIso).where('date', '<=', eIso).get().then(function (snap) {
      DATA.views = [];
      snap.forEach(function (doc) { DATA.views.push(doc.data()); });
    }).catch(function (e) { console.warn('[funnel] views', e.message); DATA.views = []; });
  }

  /* Leads "entrés" dans la période = realEntry ∈ [start,end].
     realEntry ≤ createdAt toujours → on requête createdAt ≥ start.
     Borne haute createdAt = end + 45 j (attrape les imports tardifs)
     puis filtrage client-side sur realEntry. _merged exclus. */
  function loadLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var capMs = Math.min(P.end.getTime() + 45 * 86400000, Date.now() + 60000);
    var capTs = tsOf(new Date(capMs));
    var q = db.collection('leads')
      .where('createdAt', '>=', startTs)
      .where('createdAt', '<=', capTs)
      .limit(LEADS_QUERY_LIMIT);
    var pLeads = q.get().then(function (snap) {
      DATA.leadsTruncated = snap.size >= LEADS_QUERY_LIMIT;
      var out = [];
      snap.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        if (d._merged === true) return;
        var re = realEntryMs(d);
        if (re == null || re < P.start.getTime() || re > P.end.getTime()) return;
        d._entry = re;
        d._tunnel = leadTunnel(d);
        d._p9 = phone9(d.telephone || d.phone);
        out.push(d);
      });
      DATA.leads = out;
    });
    var startTs2 = tsOf(P.start);
    var endTs2 = tsOf(P.end);
    var pReopt = db.collection('leads')
      .where('lastOptinAt', '>=', startTs2)
      .where('lastOptinAt', '<=', endTs2)
      .limit(2000)
      .get().then(function (snap) {
        var out = [];
        snap.forEach(function (doc) {
          var d = doc.data(); d._id = doc.id;
          if (d._merged === true) return;
          var re = realEntryMs(d);
          if (re != null && re >= P.start.getTime()) return; // déjà dans la cohorte "nouveaux"
          d._entry = re;
          d._tunnel = leadTunnel(d);
          d._p9 = phone9(d.telephone || d.phone);
          out.push(d);
        });
        DATA.reoptins = out;
      }).catch(function (e) { console.warn('[funnel] reoptins', e.message); DATA.reoptins = []; });
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
    }).catch(function (e) { console.warn('[funnel] bookings', e.message); DATA.bookings = []; DATA.bookingsTtb = []; });
  }

  /* Leads devenus CLIENTS dans la période (clientSince) — source de vérité
     des closes QUEL QUE SOIT le chemin : résultat RDV, fiche CRM (stage Won),
     pipeline. Un close fait depuis la fiche, même sans outcome sur le RDV,
     apparaît ici. SB/NB via closed_won_self / closed_won_setting. */
  function loadClosedLeads(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endTs = tsOf(P.end);
    return db.collection('leads')
      .where('clientSince', '>=', startTs)
      .where('clientSince', '<=', endTs)
      .limit(500)
      .get().then(function (snap) {
        DATA.closedLeads = [];
        snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.closedLeads.push(d); });
      }).catch(function (e) { console.warn('[funnel] closedLeads', e.message); DATA.closedLeads = []; });
  }

  /* MODULE PAIEMENTS (collection payments — GoCardless) : LA vérité du cash
     (validé Adrien 14/07). Chaque doc : totalAmount (contrat TTC),
     paidAmount (encaissé réel à date), paymentsHistory[] (chaque
     prélèvement daté), leadId / leadEmail, closerSlug, status.
     Croisement par client gagné : collecté = paidAmount du client (→ HT),
     repli sur l'encaissé déclaré aux cartes du Close. La collection est
     petite (dizaines de docs) → chargée en entier, croisée côté client. */
  function loadPayments(db, DATA) {
    DATA.payments = [];
    return db.collection('payments').get().then(function (snap) {
      snap.forEach(function (doc) {
        var d = doc.data(); d._id = doc.id;
        DATA.payments.push(d);
      });
    }).catch(function (e) { console.warn('[funnel] payments', e.message); DATA.payments = []; });
  }

  /* Appels : requête étendue jusqu'au lookahead (fin de fenêtre + 14 j,
     plafonné à maintenant) pour que le 1er contact d'un lead entré dans la
     période soit trouvé même s'il a lieu après (fix censure 15/07).
     _inPeriod sépare l'activité de la période (cartes appels / décrochés /
     par closer) du parcours par lead (TTC, joignabilité, tentatives). */
  function loadCalls(db, P, DATA) {
    var startTs = tsOf(P.start);
    var endMs = P.end.getTime();
    var endTs = tsOf(new Date(lookaheadEndMsFor(P)));
    return db.collection('call_logs')
      .where('initiatedAt', '>=', startTs)
      .where('initiatedAt', '<=', endTs)
      .orderBy('initiatedAt', 'asc')
      .limit(CALLS_QUERY_LIMIT)
      .get().then(function (snap) {
        DATA.callsTruncated = snap.size >= CALLS_QUERY_LIMIT;
        var out = [];
        snap.forEach(function (doc) {
          var d = doc.data();
          d._ms = parseFlexMs(d.initiatedAt) || parseFlexMs(d.startTime);
          d._inPeriod = d._ms == null || d._ms <= endMs;
          d._p9 = phone9(d.direction === 'inbound' ? d.fromNumber : d.toNumber);
          out.push(d);
        });
        DATA.calls = out;
      }).catch(function (e) { console.warn('[funnel] calls', e.message); DATA.calls = []; });
  }

  /* Coûts setting RÉELS — _config/funnel_costs : { months: { 'YYYY-MM':
     { fixe, outils } } }. Une valeur vaut pour son mois ET les suivants
     (report automatique) tant qu'aucune valeur plus récente n'existe.
     Zéro invention : sans entrée couvrant la période → « — » à l'écran. */
  function loadFunnelCosts(db, DATA) {
    return db.collection('_config').doc('funnel_costs').get().then(function (snap) {
      DATA.costs = (snap.exists && snap.data().months) || {};
    }).catch(function (e) { console.warn('[funnel] costs', e.message); DATA.costs = null; });
  }

  /* Commissions Setting RÉELLES — deals du module Commissions
     (commissions/{slug}/mois/{YYYY-MM} → deals[] de type 'Setting') datés
     dans la fenêtre. Comm + bonus ; deals validés (ok) comme en attente
     d'encaissement — la commission est due dès le close. Membres partis
     inclus (l'historique reste un coût réel). */
  function loadSettingDeals(db, P, DATA, TEAM) {
    DATA.settingDeals = [];
    return Promise.resolve().then(function () {
      var slugs = { elodie: 1, guillaume: 1 };
      TEAM.forEach(function (m) {
        if (m && m.slug && (m.role === 'setter' || m.role === 'closer' || m.role === 'closer_setter')) slugs[m.slug] = 1;
      });
      /* ⚠ Fenêtre ÉLARGIE d'un mois de chaque côté (26/07/2026) — depuis le
         décalage des commissions Setting, le deal d'un close de juillet est
         stocké dans le document d'AOÛT (versement M+1), et peut avoir été
         déplacé à la main vers juin. Le filtre qui compte reste `dl.date`
         ∈ période : élargir le balayage ne fait qu'aller CHERCHER le deal là
         où il dort, sans jamais en compter un hors période.
         Sans ça, commSetting — donc le coût setting et le coût / RDV NB —
         serait silencieusement sous-évalué. */
      var mks = {};
      var d = new Date(P.start.getFullYear(), P.start.getMonth() - 1, 1);
      var lastMk = new Date(P.end.getFullYear(), P.end.getMonth() + 1, 1);
      while (d.getTime() <= lastMk.getTime()) {
        mks[d.getFullYear() + '-' + pad2(d.getMonth() + 1)] = 1;
        d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
      }
      var proms = [];
      Object.keys(slugs).forEach(function (slug) {
        Object.keys(mks).forEach(function (mk) {
          proms.push(db.collection('commissions').doc(slug).collection('mois').doc(mk).get().then(function (snap) {
            if (!snap.exists) return;
            (snap.data().deals || []).forEach(function (dl) {
              if (!dl || dl.type !== 'Setting') return;
              var ms = frDateMs(dl.date);
              if (ms == null || ms < P.start.getTime() || ms > P.end.getTime()) return;
              DATA.settingDeals.push({ slug: slug, comm: (Number(dl.comm) || 0) + (Number(dl.bonus) || 0), ok: dl.ok === true, client: dl.client || '' });
            });
          }).catch(function () {}));
        });
      });
      return Promise.all(proms);
    });
  }

  /* Chaînes de replanification — un RDV replanifié pointe vers son
     remplaçant (rescheduledToId). Pour statuer une chaîne créée dans la
     période il faut son RDV TERMINAL, qui peut avoir été créé après la fin
     de la période (absent des 2 requêtes bookings) → on va chercher les
     chaînons manquants un par un (rarissime : quelques docs max). Ils vont
     dans bookingsById UNIQUEMENT (jamais dans les compteurs pris/tenue). */
  function resolveChains(db, DATA, TYPE_MAP) {
    function missingTargets() {
      var ids = [];
      Object.keys(DATA.bookingsById).forEach(function (bid) {
        var cur = DATA.bookingsById[bid], guard = 0;
        while (cur && cur.rescheduledToId && guard++ < 10) {
          var nxt = DATA.bookingsById[cur.rescheduledToId];
          if (!nxt) { if (ids.indexOf(cur.rescheduledToId) < 0) ids.push(cur.rescheduledToId); break; }
          cur = nxt;
        }
      });
      return ids;
    }
    function fetchRound(depth) {
      var ids = missingTargets();
      if (!ids.length || depth > 4) return Promise.resolve();
      var proms = ids.slice(0, 20).map(function (id) {
        return db.collection('bookings').doc(id).get().then(function (snap) {
          if (!snap.exists) return;
          var d = snap.data(); d._id = snap.id; d._inCreated = false; d._inDue = false;
          d._class = classifyBooking(d, TYPE_MAP);
          d._p9 = phone9(d.prospect && (d.prospect.telephone || d.prospect.phone));
          d._createdMs = parseFlexMs(d.createdAt);
          DATA.bookingsById[d._id] = d;
        }).catch(function () {});
      });
      return Promise.all(proms).then(function () { return fetchRound(depth + 1); });
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
          var d = snap.data(); d._id = snap.id; return [d];
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
          p._payClose = { kind: 'count', name: l.nom || name, sb: l.stage === 'closed_won_self', tunnel: leadTunnel(l), noLead: false };
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

  /* Journal d'actions setting (lead_actions/{slug}/items — refonte 07/2026).
     Une requête par membre — ÉQUIPE SALES uniquement (setter/closer/
     closer_setter actifs, membres partis exclus — validé Adrien 14/07). */
  function loadActionsAll(db, P, DATA, TEAM) {
    DATA.actions = [];
    return Promise.resolve().then(function () {
      var members = TEAM.filter(function (m) {
        return m && m.slug && m.slug !== 'guillaume' && m.active !== false
          && (m.role === 'setter' || m.role === 'closer' || m.role === 'closer_setter');
      });
      if (!members.length) members = [{ slug: 'elodie' }];
      var sIso = isoDate(P.start), eIso = isoDate(P.end);
      var proms = members.map(function (m) {
        return db.collection('lead_actions').doc(m.slug).collection('items')
          .where('day', '>=', sIso).where('day', '<=', eIso).get()
          .then(function (snap) {
            snap.forEach(function (doc) { var d = doc.data(); d._id = doc.id; DATA.actions.push(d); });
          }).catch(function () {});
      });
      return Promise.all(proms);
    });
  }


  /* ════════════════════════════════════════════════════════════════
     COMPUTE — agrège tout selon le filtre tunnel
     ════════════════════════════════════════════════════════════════ */
  function computeKpis(ctx) {
    var DATA = ctx.DATA, P = ctx.P, tunnelFilter = ctx.tunnelFilter;
    var TEAM = ctx.teamMembers || [];
    function tunnelMatch(t) { return tunnelFilter === 'all' || t === tunnelFilter; }
    function lookaheadEndMs() { return lookaheadEndMsFor(P); }

    var k = {};
    var todayIso = isoDate(new Date());
    var laEnd = lookaheadEndMsFor(P); // borne des parcours par lead (TTC/TTB/SMS/joignabilité)

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

    var cohort = DATA.leads.filter(function (l) { return tunnelMatch(l._tunnel); });
    var reopt  = DATA.reoptins.filter(function (l) { return tunnelMatch(l._tunnel); });

    k.leads = cohort.length;
    k.reoptins = reopt.length;
    k.leadsByTunnel = { elite: 0, business: 0 };
    DATA.leads.forEach(function (l) { k.leadsByTunnel[l._tunnel]++; });

    /* ── Ads ── */
    var ads = DATA.ads.filter(function (a) { return tunnelMatch(a.tunnel === 'business' ? 'business' : 'elite'); });
    k.spend = 0; k.impressions = 0; k.clicks = 0; k.leadsFb = 0; k.adsDays = 0;
    ads.forEach(function (a) {
      k.spend += Number(a.spend) || 0;
      k.impressions += Number(a.impressions) || 0;
      k.clicks += Number(a.clicks) || 0;
      k.leadsFb += Number(a.leads) || 0;
      if ((Number(a.spend) || 0) > 0 || (Number(a.impressions) || 0) > 0) k.adsDays++;
    });
    k.hasAds = k.spend > 0 || k.impressions > 0 || k.clicks > 0;
    k.cpm = k.impressions > 0 ? k.spend / k.impressions * 1000 : null;
    k.ctr = k.impressions > 0 ? k.clicks / k.impressions * 100 : null;
    k.cpc = k.clicks > 0 ? k.spend / k.clicks : null;
    k.cpl = k.leads > 0 && k.spend > 0 ? k.spend / k.leads : null;

    /* ── Vues opt-in (beacon) ── */
    var views = DATA.views.filter(function (v) {
      var t = v.page === 'business' ? 'business' : 'elite';
      return tunnelMatch(t);
    });
    k.views = 0;
    views.forEach(function (v) { k.views += Number(v.views) || 0; });
    k.optinReal = k.views > 0 ? k.leads / k.views * 100 : null;
    k.optinClicks = k.clicks > 0 ? k.leads / k.clicks * 100 : null;

    /* A/B tests opt-in — agrégation par page × variante (docs beacon
       page_views_daily avec champ variant). Affiché si ≥ 2 variantes. */
    var abByPage = {};
    DATA.views.forEach(function (v) {
      if (!v.variant) return;
      var t = v.page === 'business' ? 'business' : 'elite';
      if (!tunnelMatch(t)) return;
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
      if (tunnelFilter === 'all') return true;
      var l = bookingLead(b);
      return !!(l && l._tunnel === tunnelFilter);
    }

    var created = DATA.bookings.filter(function (b) { return b._inCreated && b._class !== 'excluded' && bookingMatches(b); });
    var createdFunnelAll = created.filter(function (b) { return b._class === 'self' || b._class === 'setter'; });
    /* Replanifications exclues des « pris » : le RDV de remplacement porte
       rescheduledFromId — le compter regonflerait LTB/CPR à chaque report
       (refonte 07/2026). Il reste compté dans la tenue (date due). */
    var createdFunnel = createdFunnelAll.filter(function (b) { return !b.rescheduledFromId; });
    k.booked = createdFunnel.length;
    k.bookedSelf = createdFunnel.filter(function (b) { return b._class === 'self'; }).length;
    k.bookedSetter = k.booked - k.bookedSelf;
    k.bookedAdmin = created.filter(function (b) { return b._class === 'admin'; }).length;
    k.rescheduledCreated = createdFunnelAll.length - createdFunnel.length;
    /* RDV pris par tunnel Élite / Business (demande head of sales 14/07) —
       calculé sur TOUS les tunnels comme leadsByTunnel, via le lead du RDV. */
    k.bookedByTunnel = { elite: 0, business: 0 };
    DATA.bookings.forEach(function (b) {
      if (!b._inCreated || b.rescheduledFromId) return;
      if (b._class !== 'self' && b._class !== 'setter') return;
      var lbt = bookingLead(b);
      if (lbt && k.bookedByTunnel[lbt._tunnel] != null) k.bookedByTunnel[lbt._tunnel]++;
    });
    k.selfShare = k.booked > 0 ? k.bookedSelf / k.booked * 100 : null;
    k.setterShare = k.booked > 0 ? k.bookedSetter / k.booked * 100 : null;
    k.ltb = k.leads > 0 ? k.booked / k.leads * 100 : null;
    k.cpr = k.spend > 0 && k.booked > 0 ? k.spend / k.booked : null;

    /* Récupération setting — cohorte : leads période avec RDV setter /
       (leads période − leads période avec self-booking). */
    var selfLeadIds = {}, setterLeadIds = {};
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
      l._bk.push(b);
    }
    /* Récupération / TTB : dédupliqué par lead → on garde TOUS les RDV créés
       (replanifications incluses) pour ne pas perdre le marquage SB/NB du lead. */
    createdFunnelAll.forEach(function (b) {
      var l = bookingLead(b);
      if (!l) { unknownLeadBookings++; return; }
      if (!l._inCohort) { if (b._class === 'setter') setterOld++; return; }
      if (b._class === 'self') selfLeadIds[l._id] = 1;
      else setterLeadIds[l._id] = 1;
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
        if (b._class !== 'self' && b._class !== 'setter') return;
        if (!bookingMatches(b)) return;
        applyTtb(b);
      });
    var cohortSelf = 0, cohortSetter = 0;
    cohort.forEach(function (l) {
      if (selfLeadIds[l._id]) cohortSelf++;
      else if (setterLeadIds[l._id]) cohortSetter++;
    });
    k.cohortSelf = cohortSelf;
    k.cohortSetter = cohortSetter;
    k.recovery = (k.leads - cohortSelf) > 0 ? cohortSetter / (k.leads - cohortSelf) * 100 : null;
    k.setterOldLeads = setterOld;
    k.unknownLeadBookings = unknownLeadBookings;

    /* ── Tenue — RDV dont la date tombe dans la période ──
       Cohérence 14/07/2026 : les REPLANIFIÉS sont sortis des annulés (le RDV
       de remplacement les remplace), et la ventilation se fait par nature
       SB / NB — plus jamais « par personne » (le nom de l'opérateur qui
       clique Annuler, ex. la CSM, n'est pas une donnée métier setting). */
    var due = DATA.bookings.filter(function (b) { return b._inDue && (b._class === 'self' || b._class === 'setter') && bookingMatches(b); });
    function dueRescheduledF(b) { return b.outcome === 'replanifie' || (b.status === 'cancelled' && b.rescheduled === true); }
    function dueCancelledF(b) { return !dueRescheduledF(b) && (b.outcome === 'annule' || b.status === 'cancelled'); }
    k.due = due.length;
    k.dueRescheduled = due.filter(dueRescheduledF).length;
    k.dueCancelled = due.filter(dueCancelledF).length;
    k.dueNoShow = due.filter(function (b) { return b.status === 'no_show'; }).length;
    k.dueCompleted = due.filter(function (b) { return b.status === 'completed'; }).length;
    k.dueToStatus = due.filter(function (b) { return (b.status === 'confirmed' || b.status === 'pending') && b.date < todayIso; }).length;
    k.dueUpcoming = due.filter(function (b) { return (b.status === 'confirmed' || b.status === 'pending') && b.date >= todayIso; }).length;
    k.kept = k.due - k.dueCancelled - k.dueNoShow - k.dueRescheduled;
    k.keptPct = k.due > 0 ? k.kept / k.due * 100 : null;
    k.cancelRate = k.due > 0 ? (k.dueCancelled + k.dueNoShow) / k.due * 100 : null;
    /* Ventilation SB / NB (demande Adrien : « combien annulation SB et
       combien annulé du NB ») — mêmes prédicats, sous-ensembles du même due. */
    var dueSelf = due.filter(function (b) { return b._class === 'self'; });
    var dueSetter = due.filter(function (b) { return b._class === 'setter'; });
    k.dueSB = dueSelf.length;
    k.dueNB = dueSetter.length;
    k.cancSB = dueSelf.filter(dueCancelledF).length;
    k.cancNB = dueSetter.filter(dueCancelledF).length;
    k.noshowSB = dueSelf.filter(function (b) { return b.status === 'no_show'; }).length;
    k.noshowNB = dueSetter.filter(function (b) { return b.status === 'no_show'; }).length;
    k.reschedSB = dueSelf.filter(dueRescheduledF).length;
    k.reschedNB = dueSetter.filter(dueRescheduledF).length;

    /* ══ RÉSULTATS D'APPEL — helpers outcome (refonte 07/2026) ══
       présent (live) = offre|close|non_close|disqualifie (repli : status
       completed pour les RDV d'avant la refonte) · pitché = offre|close|
       non_close · replanifié = remplacé par un autre RDV (chaîne). */
    function ocOf(b) { return b.outcome || null; }
    function ocCancelled(b) { var o = ocOf(b); return o === 'annule' || (!o && b.status === 'cancelled' && b.rescheduled !== true); }
    function ocNoShow(b) { var o = ocOf(b); return o === 'no_show' || (!o && b.status === 'no_show'); }
    function ocPresent(b) { var o = ocOf(b); return o ? (o === 'offre' || o === 'close' || o === 'non_close' || o === 'disqualifie') : b.status === 'completed'; }
    function ocPitched(b) { var o = ocOf(b); return o === 'offre' || o === 'close' || o === 'non_close'; }

    /* Fin de chaîne : un RDV replanifié est représenté par son remplaçant —
       le résultat d'une chaîne créée dans la période compte dans la période,
       même si le RDV final se tient plus tard (axe « RDV créés »). */
    function chainTerminal(b) {
      var cur = b, guard = 0;
      while (cur && cur.rescheduledToId && guard++ < 10) {
        var nxt = DATA.bookingsById[cur.rescheduledToId];
        if (!nxt) break;
        cur = nxt;
      }
      return cur;
    }

    /* Agrégat sur l'axe « RDV créés » : une entrée = une chaîne (RDV initial
       créé dans la période), statuée par son RDV terminal.
       KEPT (lignes) = pris − annulés — règle Vincent 14/07 : le no-show
       reste DANS le kept (le RDV était maintenu), affiché à part. */
    function chainAgg(list) {
      var a = { n: 0, cancelled: 0, noshow: 0, resched: 0, present: 0, disqua: 0, pitched: 0, closesOc: 0, nonCloses: 0, aStatuer: 0, aVenir: 0, sansDetail: 0 };
      list.forEach(function (b0) {
        var b = chainTerminal(b0);
        a.n++;
        if (b !== b0) a.resched++;
        if (ocCancelled(b)) { a.cancelled++; return; }
        if (ocNoShow(b)) a.noshow++;
        if (ocPresent(b)) a.present++;
        if (ocOf(b) === 'disqualifie') a.disqua++;
        if (ocPitched(b)) a.pitched++;
        if (ocOf(b) === 'close') a.closesOc++;
        if (ocOf(b) === 'non_close') a.nonCloses++;
        if (!ocOf(b)) {
          if ((b.status === 'confirmed' || b.status === 'pending') && b.date >= todayIso) a.aVenir++;
          else if (b.status === 'completed') a.sansDetail++;          // tenu, mais offre/close inconnus (avant refonte)
          else if (b.status === 'confirmed' || b.status === 'pending') a.aStatuer++;
        }
      });
      a.kept = a.n - a.cancelled;
      return a;
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
       la période ») — chiffres exacts, affichés, plus jamais implicites :
       · dueCreatedBefore = RDV du mois posés AVANT le début de période
       · createdDueLater  = chaînes créées ce mois dont le RDV terminal se
         tient APRÈS la fin de période. */
    var endIsoStr = isoDate(P.end);
    k.dueCreatedBefore = due.filter(function (b) { return b._createdMs != null && b._createdMs < P.start.getTime(); }).length;
    k.createdDueLater = 0;
    createdFunnel.forEach(function (b) {
      var t = chainTerminal(b);
      if ((t.date || '') > endIsoStr) k.createdDueLater++;
    });

    /* Résultats sur l'axe « date de RDV » — le mois en totalité (héro L2,
       Tenue, show-up, taux de close). */
    function dueAgg(list) {
      var a = { n: 0, present: 0, disqua: 0, pitched: 0, closesOc: 0, nonCloses: 0, aStatuer: 0, sansDetail: 0 };
      list.forEach(function (b) {
        a.n++;
        if (ocPresent(b)) a.present++;
        if (ocOf(b) === 'disqualifie') a.disqua++;
        if (ocPitched(b)) a.pitched++;
        if (ocOf(b) === 'close') a.closesOc++;
        if (ocOf(b) === 'non_close') a.nonCloses++;
        if (!ocOf(b)) {
          if ((b.status === 'confirmed' || b.status === 'pending') && b.date < todayIso) a.aStatuer++;
          else if (b.status === 'completed') a.sansDetail++;
        }
      });
      return a;
    }
    k.ocDue = dueAgg(due);
    k.ocHasData = due.length > 0 && (k.ocDue.present + k.ocDue.pitched + k.ocDue.closesOc + k.dueCancelled + k.dueNoShow) > 0;

    /* Échelle CPR — MÊME AXE que la carte « RDV pris SB » (RDV SB créés
       dans la période, chaînes dédupliquées, résultat de fin de chaîne) :
       plus jamais deux dénominateurs différents entre la carte et l'échelle. */
    k.ltbSB = k.leads > 0 ? k.bookedSelf / k.leads * 100 : null;
    k.cprSB    = k.spend > 0 && k.chSB.n > 0 ? k.spend / k.chSB.n : null;
    k.cprKept  = k.spend > 0 && k.chSB.kept > 0 ? k.spend / k.chSB.kept : null;
    k.cprLive  = k.spend > 0 && k.chSB.present > 0 ? k.spend / k.chSB.present : null;
    k.cprOffre = k.spend > 0 && k.chSB.pitched > 0 ? k.spend / k.chSB.pitched : null;

    /* Journal d'actions setting (lead_actions) — décomposition honnête :
       le journal compte le 1er contact de la période sur TOUS les leads
       (anciens, ré-optins et self-bookés inclus) → ventilation affichée pour
       que « travaillés > cohorte » soit lisible, jamais suspect.
       Avant la mise en ligne du journal (14/07/2026) : « — », le passé
       n'existe pas et ne sera pas inventé. */
    var acts = DATA.actions || [];
    k.actLeadsWorked = 0; k.actWorkedReopt = 0; k.actWorkedOld = 0; k.actWorkedSelf = 0;
    var setKeys = {};
    acts.forEach(function (a) {
      if (a.firstTouch) {
        k.actLeadsWorked++;
        var la = a.leadId ? leadsById[a.leadId] : null;
        if (la && la._inCohort) { if (selfLeadIds[la._id]) k.actWorkedSelf++; }
        else if (la) k.actWorkedReopt++;
        else k.actWorkedOld++;
      }
      if (a.action === 'set' || a.action === 'set_booking' || a.action === 'rdv_pose') {
        setKeys[(a.leadId || a._id) + '_' + a.day] = 1;
      }
    });
    k.actSets = Object.keys(setKeys).length;
    k.journalLive = isoDate(P.end) >= JOURNAL_GOLIVE;

    /* ── Téléphonie (call_logs) ── */
    function callMatches(c) {
      if (tunnelFilter === 'all') return true;
      var l = c._p9 ? leadsByP9[c._p9] : null;
      return !!(l && l._tunnel === tunnelFilter);
    }
    /* Activité de la PÉRIODE (cartes appels sortants / décrochés / durée /
       par closer) : strictement bornée à [start, end] — les appels chargés
       en lookahead pour le TTC ne comptent jamais ici. */
    var callsOut = DATA.calls.filter(function (c) { return c.direction === 'outbound' && c._inPeriod && callMatches(c); });
    k.callsOut = callsOut.length;
    k.callsAnswered = callsOut.filter(isAnsweredCall).length;
    k.answerRate = k.callsOut > 0 ? k.callsAnswered / k.callsOut * 100 : null;
    /* Appels sans aucune information de sonnerie : la règle « messagerie »
       ne peut pas s'y appliquer, ils sont comptés décrochés par défaut et
       gonflent le taux. C'est le cas des appels du JOUR — le sync Ringover
       tourne à 3 h 30, ils ne sont enrichis que la nuit suivante. Sans ce
       compteur, la journée en cours affiche un taux faux sans rien dire :
       81,8 % au lieu de ~60 %, constaté le 17/08. */
    k.callsNoRingData = callsOut.filter(function (c) { return ringingSecOf(c) == null; }).length;

    /* time-to-first-contact — premier appel sortant vers chaque lead de la
       cohorte, cherché jusqu'au lookahead (fix censure 15/07 : avant, un
       lead appelé après la fin de fenêtre sortait de la médiane → chiffre
       structurellement flatteur, plafonné à la taille de la fenêtre). */
    var callsByP9 = {};
    DATA.calls.forEach(function (c) {
      if (c.direction !== 'outbound' || !c._p9 || c._ms == null) return;
      if (!callsByP9[c._p9]) callsByP9[c._p9] = [];
      callsByP9[c._p9].push({ ms: c._ms, ans: isAnsweredCall(c) });
    });
    var ttcArr = [], ttbArr = [], ttbSelfArr = [], ttbSetArr = [];
    cohort.forEach(function (l) {
      l._nbCalls = 0; l._ttc = null;
      l._nbAnswered = 0;
      if (l._p9 && callsByP9[l._p9]) {
        var arr = callsByP9[l._p9];
        l._nbCalls = arr.length;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i].ans) l._nbAnswered++;
          if (l._entry != null && arr[i].ms >= l._entry) {
            if (l._ttc == null || arr[i].ms - l._entry < l._ttc) l._ttc = arr[i].ms - l._entry;
          }
        }
      }
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
    k.ttcMedian = median(ttcArr);
    k.ttcCount = ttcArr.length;
    k.ttbMedian = median(ttbArr);
    k.ttbCount = ttbArr.length;
    k.ttbSelfMedian = median(ttbSelfArr); k.ttbSelfCount = ttbSelfArr.length;
    k.ttbSetMedian  = median(ttbSetArr);  k.ttbSetCount  = ttbSetArr.length;
    /* Zéros honnêtes : les médianes ne portent que sur les leads DÉJÀ
       appelés / bookés. Provisoire tant que le lookahead est tronqué par
       « maintenant » — des 1ers contacts peuvent encore arriver et
       ALLONGER les médianes (jamais les raccourcir). */
    k.ttxProvisional = P.end.getTime() + TTX_LOOKAHEAD_MS > Date.now();

    /* Joignabilité & tentatives — parcours par lead de la cohorte : appels
       comptés jusqu'au lookahead (un lead appelé le lendemain de la fenêtre
       compte « appelé »), cohérent avec le TTC. */
    var leadsCalled = 0, leadsReached = 0, attemptsSum = 0;
    cohort.forEach(function (l) {
      if ((l._nbCalls || 0) > 0) {
        leadsCalled++;
        attemptsSum += l._nbCalls;
        if ((l._nbAnswered || 0) > 0) leadsReached++;
      }
    });
    k.leadsCalled = leadsCalled;
    k.leadsReached = leadsReached;
    k.leadsNeverCalled = k.leads - leadsCalled; // jamais appelés à ce jour (téléphone absent inclus)
    k.reachRate = leadsCalled > 0 ? leadsReached / leadsCalled * 100 : null;
    k.attemptsAvg = leadsCalled > 0 ? attemptsSum / leadsCalled : null;

    /* Durée moyenne des appels décrochés (tous appels sortants période) */
    var ansDurSum = 0, ansDurN = 0;
    callsOut.forEach(function (c) {
      var dSec = Number(c.durationSec) || 0;
      if (isAnsweredCall(c)) { ansDurSum += dSec; ansDurN++; }
    });
    k.avgAnsweredDurSec = ansDurN > 0 ? ansDurSum / ansDurN : null;

    /* Répartition par closer (userId du call_log → nom d'équipe) */
    var byUser = {};
    callsOut.forEach(function (c) {
      var uid = c.userId || c.ringoverUserId || 'unknown';
      if (!byUser[uid]) byUser[uid] = { name: null, out: 0, ans: 0, rawName: c.userName || c.ringoverUserName || null };
      byUser[uid].out++;
      if (isAnsweredCall(c)) byUser[uid].ans++;
      if (!byUser[uid].rawName && (c.userName || c.ringoverUserName)) byUser[uid].rawName = c.userName || c.ringoverUserName;
    });
    var tmList = TEAM;
    Object.keys(byUser).forEach(function (uid) {
      var nm = null;
      for (var i2 = 0; i2 < tmList.length; i2++) {
        if (tmList[i2].firebaseUid === uid) { nm = tmList[i2].shortName || tmList[i2].displayName; break; }
      }
      byUser[uid].name = nm || byUser[uid].rawName || (uid === 'unknown' ? 'Non attribué' : uid.slice(0, 8) + '…');
    });
    k.callsByUser = Object.keys(byUser).map(function (uid) { return byUser[uid]; }).sort(function (a, b) { return b.out - a.out; });

    /* ── Show-up RÉEL : présents du mois (résultats RDV) / kept — plus
       aucune saisie manuelle nulle part (décision Adrien 14/07). ── */
    k.showup = (k.kept > 0 && k.ocHasData) ? k.ocDue.present / k.kept * 100 : null;

    /* ── Closes « clients gagnés » — 100 % logiciel, trois chemins :
       ① fiches passées clientes dans la période (clientSince — posé par le
          résultat RDV, les cartes du Close, la fiche CRM) ;
       ② closes RDV sans fiche liée ;
       ③ paiements créés dans la période sans client gagné correspondant
          (règle Adrien 14/07 : un paiement = un close commercial, sauf
          rattrapage d'un client gagné dans une autre période — résolu au
          chargement par resolvePaymentLeads). ── */
    var closedLeads = (DATA.closedLeads || []).filter(function (l) { return tunnelMatch(leadTunnel(l)); });
    var closesNoLeadSB = 0, closesNoLeadNB = 0;
    due.forEach(function (b) {
      if (b.outcome !== 'close' || b.leadId) return;
      if (b._class === 'self') closesNoLeadSB++; else closesNoLeadNB++;
    });
    var wonSelfLeads = closedLeads.filter(function (l) { return l.stage === 'closed_won_self'; }).length;

    /* ── Montants — MODULE PAIEMENTS d'abord (règle Adrien 14/07) :
       collecté  = ① prélèvements passés (paidAmount) s'il y en a
                   ② sinon, dès que le paiement existe (hors annulé /
                     brouillon) : 1 mensualité pour un fractionné (« la
                     mensualité correspond à l'encaissé »), la totalité pour
                     un intégral — suivi « à prélever (mandat) »
                   ③ sinon l'encaissé DÉCLARÉ aux cartes du Close
                   ④ sinon « close sans montant » — alerte nominative, jamais
                     un zéro muet
       contracté = totalAmount (hors annulés/brouillons), sinon tarif des
                   cartes. TTC → HT ÷ 1,2 (sauf vatType 'ht').
       Rattachement paiement → client : leadId → email → téléphone.
       Un paiement déjà rattaché ne compte JAMAIS deux fois (_matched). ── */
    function payHT(p, amount) {
      var a = Number(amount) || 0;
      return p && p.vatType === 'ht' ? a : a / 1.2; // module Paiements = TTC par défaut
    }
    var declByLead = {};   // encaissé/contracté déclarés aux cartes (closeData des RDV)
    (DATA.bookings || []).forEach(function (b) {
      if (b.outcome !== 'close' || !b.closeData || !b.leadId) return;
      declByLead[b.leadId] = { col: Number(b.closeData.collecte) || 0, con: Number(b.closeData.contracte) || 0 };
    });
    var paysByLead = {}, paysByEmail = {}, paysByP9 = {};
    (DATA.payments || []).forEach(function (p) {
      if (!p) return;
      p._matched = false;
      if (p.leadId) { (paysByLead[p.leadId] = paysByLead[p.leadId] || []).push(p); }
      var pem = (p.leadEmail || '').toLowerCase().trim();
      if (pem) { (paysByEmail[pem] = paysByEmail[pem] || []).push(p); }
      var pp9 = phone9(p.leadPhone);
      if (pp9) { (paysByP9[pp9] = paysByP9[pp9] || []).push(p); }
    });
    /* Contribution d'UN paiement : {col, con, mandat}. */
    function payMoney(p) {
      var out = { col: 0, con: 0, mandat: 0 };
      var active = p.status !== 'cancelled' && p.status !== 'draft';
      var paid = payHT(p, p.paidAmount);
      if (paid > 0) out.col = paid;
      else if (active) {
        var due1 = p.type === 'installments' ? (Number(p.installmentAmount) || 0) : (Number(p.totalAmount) || 0);
        out.col = payHT(p, due1);
        out.mandat = out.col;
      }
      if (active) out.con = payHT(p, p.totalAmount);
      return out;
    }
    function payForClient(leadId, email, p9) {
      var seen = {}, list = [];
      function add(arr) { (arr || []).forEach(function (p) { if (!seen[p._id] && !p._matched) { seen[p._id] = 1; list.push(p); } }); }
      add(paysByLead[leadId]);
      if (email) add(paysByEmail[email]);
      if (p9) add(paysByP9[p9]);
      var col = 0, con = 0, mandat = 0;
      list.forEach(function (p) {
        p._matched = true;
        var m = payMoney(p);
        col += m.col; con += m.con; mandat += m.mandat;
      });
      return { n: list.length, col: Math.round(col * 100) / 100, con: Math.round(con * 100) / 100, mandat: Math.round(mandat * 100) / 100 };
    }
    var wonColSB = 0, wonConSB = 0, wonColNB = 0, wonConNB = 0;
    var colMissing = 0, noPayCount = 0, mandatSum = 0, colMissingNames = [];
    closedLeads.forEach(function (l) {
      var sb2 = l.stage === 'closed_won_self';
      var lem = (l.email || '').toLowerCase().trim();
      var pay = payForClient(l._id, lem, phone9(l.telephone || l.phone));
      var decl = declByLead[l._id] || (l.closedData ? { col: Number(l.closedData.collecte) || 0, con: Number(l.closedData.contracte) || 0 } : null);
      if (!pay.n) noPayCount++;
      var col = null, con = 0;
      if (pay.n && pay.col > 0) { col = pay.col; mandatSum += pay.mandat; }
      else if (decl && decl.col > 0) col = decl.col;
      if (pay.con > 0) con = pay.con;
      else if (decl) con = decl.con;
      if (col == null) { colMissing++; colMissingNames.push(l.nom || lem || l._id); }
      l._wonCol = (col || 0);   /* collecté consolidé par fiche — réutilisé par la section « par créative » */
      if (sb2) { wonColSB += (col || 0); wonConSB += con; } else { wonColNB += (col || 0); wonConNB += con; }
    });
    /* Closes RDV sans fiche liée : Paiements par email/téléphone, repli cartes. */
    due.forEach(function (b) {
      if (b.outcome !== 'close' || b.leadId) return;
      var bem = (b.prospect && b.prospect.email || '').toLowerCase().trim();
      var pay3 = payForClient('__none__', bem, phone9(b.prospect && (b.prospect.telephone || b.prospect.phone)));
      var col3 = null, con3 = 0;
      if (pay3.n && pay3.col > 0) { col3 = pay3.col; mandatSum += pay3.mandat; }
      else if (b.closeData && Number(b.closeData.collecte) > 0) col3 = Number(b.closeData.collecte);
      if (pay3.con > 0) con3 = pay3.con;
      else if (b.closeData) con3 = Number(b.closeData.contracte) || 0;
      if (col3 == null) { colMissing++; colMissingNames.push((b.prospect && b.prospect.nom) || bem || b._id); }
      if (b._class === 'self') { wonColSB += (col3 || 0); wonConSB += con3; } else { wonColNB += (col3 || 0); wonConNB += con3; }
    });
    /* ③ Closes détectés via Paiements (fiche jamais gagnée / introuvable). */
    k.payCloseNames = []; k.payCloseOther = [];
    var payClosesSB = 0, payClosesNB = 0;
    (DATA.payments || []).forEach(function (p) {
      if (!p || !p._payClose || p._matched) return;
      var pc = p._payClose;
      if (pc.kind === 'other') { if (tunnelFilter === 'all') k.payCloseOther.push(pc.name); return; }
      if (pc.tunnel && !tunnelMatch(pc.tunnel)) return;
      if (!pc.tunnel && tunnelFilter !== 'all') return;
      p._matched = true;
      var m3 = payMoney(p);
      mandatSum += m3.mandat;
      if (pc.sb) { payClosesSB++; wonColSB += m3.col; wonConSB += m3.con; }
      else { payClosesNB++; wonColNB += m3.col; wonConNB += m3.con; }
      k.payCloseNames.push(pc.name + (pc.noLead ? ' (aucune fiche trouvée)' : ''));
    });

    k.wonSelf = wonSelfLeads + closesNoLeadSB + payClosesSB;
    k.wonSetting = (closedLeads.length - wonSelfLeads) + closesNoLeadNB + payClosesNB;
    k.closesWonTotal = k.wonSelf + k.wonSetting;
    k.wonCollecteSB = Math.round(wonColSB * 100) / 100; k.wonCollecteNB = Math.round(wonColNB * 100) / 100;
    k.wonContracteSB = Math.round(wonConSB * 100) / 100; k.wonContracteNB = Math.round(wonConNB * 100) / 100;
    k.wonCollecte = Math.round((wonColSB + wonColNB) * 100) / 100;
    k.wonContracte = Math.round((wonConSB + wonConNB) * 100) / 100;
    k.collecteMandat = Math.round(mandatSum * 100) / 100;
    k.collecteMissing = colMissing;
    k.collecteMissingNames = colMissingNames;
    k.closesNoPayment = noPayCount;

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
       consolidé (_wonCol — Paiements, repli cartes). Qualifiés = leadScore
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
    var adDates = {};
    (DATA.adsByAd || []).forEach(function (a) { if (a && a.date) adDates[a.date] = 1; });
    var covEnd = Math.min(P.end.getTime(), Date.now());
    var expected = 0, coveredDays = 0;
    var dCov = new Date(P.start.getFullYear(), P.start.getMonth(), P.start.getDate());
    while (dCov.getTime() <= covEnd) {
      expected++;
      if (adDates[isoDate(dCov)]) coveredDays++;
      dCov = new Date(dCov.getFullYear(), dCov.getMonth(), dCov.getDate() + 1);
    }
    k.adSpendDaysExpected = expected;
    k.adSpendDaysCovered = coveredDays;
    k.adSpendCoverage = expected > 0 ? coveredDays / expected * 100 : null;
    /* « Complet » se juge sur les jours attendus, pas sur un pourcentage
       arrondi : 16 jours sur 17 n'est pas complet. */
    k.adSpendComplete = expected > 0 && coveredDays >= expected;

    /* 4 axes. « Canal » n'est PAS de la publicité : il répond à « d'où
       viennent mes leads » (VSL, webinaire, Skool, bio Instagram…), la
       question que 2 741 des 8 051 fiches savent réellement documenter.
       Le mélanger aux créatives ferait passer une page pour une pub. */
    var AXES = ['creative', 'adset', 'campaign', 'channel'];
    var maps = { creative: {}, adset: {}, campaign: {}, channel: {} };
    var unattr = {
      creative: { booked: 0, cancelled: 0, noshow: 0, closes: 0 },
      adset:    { booked: 0, cancelled: 0, noshow: 0, closes: 0 },
      campaign: { booked: 0, cancelled: 0, noshow: 0, closes: 0 },
      channel:  { booked: 0, cancelled: 0, noshow: 0, closes: 0 }
    };

    function rowOf(axis, l) {
      var kk = leadAxisKey(l, axis, CRE_IDX);
      var m = maps[axis];
      if (!m[kk.group]) {
        m[kk.group] = { key: kk.label, group: kk.group, legacy: kk.legacy,
          outOfAds: !!kk.outOfAds, adIds: {},
          leads: 0, scoreSum: 0, scoreN: 0, qual: 0,
          booked: 0, cancelled: 0, noshow: 0, closes: 0, col: 0,
          spend: 0, impressions: 0, clicks: 0, hasSpend: false };
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
      });
      createdFunnel.forEach(function (b) {
        var ul = bookingLead(b);
        if (ul) rowOf(axis, ul).booked++; else unattr[axis].booked++;
      });
      due.forEach(function (b) {
        var isCancel = dueCancelledF(b);
        var isNoShow = b.status === 'no_show';
        if (!isCancel && !isNoShow) return;
        var ul2 = bookingLead(b);
        if (!ul2) { if (isCancel) unattr[axis].cancelled++; else unattr[axis].noshow++; return; }
        var r2 = rowOf(axis, ul2);
        if (isCancel) r2.cancelled++; else r2.noshow++;
      });
      closedLeads.forEach(function (l) {
        var r3 = rowOf(axis, l);
        r3.closes++;
        r3.col += (l._wonCol || 0);
      });
      unattr[axis].closes = closesNoLeadSB + closesNoLeadNB + payClosesSB + payClosesNB;
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
        r.cpr  = (r.hasSpend && r.booked > 0) ? r.spend / r.booked : null;
        r.roas = (r.hasSpend && r.spend > 0 && r.col > 0) ? r.col / r.spend : null;
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
      channel:  sortRows(maps.channel)
    };
    k.utmUnattrByAxis = unattr;
    /* Compat : api/agency-funnel.js et l'export lisent encore ces deux clés. */
    k.utmRows = k.utmRowsByAxis.creative;
    k.utmUnattr = unattr.creative;
    /* Part de la cohorte réellement attribuée — c'est CE chiffre qui dit
       si le tableau est exploitable, pas le nombre de lignes. */
    var attributed = 0;
    cohort.forEach(function (l) { if (leadAttribution(l)) attributed++; });
    k.attributedLeads = attributed;
    k.attributedPct = cohort.length > 0 ? attributed / cohort.length * 100 : null;

    /* ROAS résultats = collecté réel (HT) / dépense — rien d'autre. */
    k.roasOutcome = (k.spend > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.spend : null;

    /* ── Taux de close du mois (bandeau héro — demande Vincent 14/07) :
       dénominateurs = le mois en totalité (axe date de RDV, replanifiés
       remplacés déduits), numérateur = clients gagnés de la période. ── */
    k.rdvMois = Math.max(0, k.due - k.dueRescheduled);
    k.closeRateRdv   = k.rdvMois > 0 ? k.closesWonTotal / k.rdvMois * 100 : null;
    k.closeRateLive  = k.ocDue.present > 0 ? k.closesWonTotal / k.ocDue.present * 100 : null;
    k.closeRateOffre = k.ocDue.pitched > 0 ? k.closesWonTotal / k.ocDue.pitched * 100 : null;

    /* ── Rentabilité — 100 % réel ── */
    k.cacMarketOnly = (k.spend > 0 && k.closesWonTotal > 0) ? k.spend / k.closesWonTotal : null;
    k.aovAll = (k.closesWonTotal > 0 && k.wonCollecte > 0) ? k.wonCollecte / k.closesWonTotal : null;

    /* ── Coût setting RÉEL (remplace « dépense pub / RDV NB » — décision
       Vincent + Adrien 14/07) : (fixe + commissions Setting + outils)
       ÷ RDV NB créés.
       · fixe & outils : _config/funnel_costs, proratisés au nombre de jours
         de la fenêtre (report auto du dernier mois saisi)
       · commissions : deals Setting RÉELS du module Commissions datés dans
         la fenêtre (comm + bonus, validés ou en attente)
       Coûts non renseignés → « — », jamais un chiffre inventé. ── */
    k.commSetting = 0; k.commSettingN = 0;
    (DATA.settingDeals || []).forEach(function (dl) { k.commSetting += dl.comm; k.commSettingN++; });
    k.commSetting = Math.round(k.commSetting * 100) / 100;
    var fixeSum = 0, outilsSum = 0, daysMissing = 0, costSrc = null;
    if (DATA.costs) {
      var dIt = new Date(P.start.getFullYear(), P.start.getMonth(), P.start.getDate());
      while (dIt.getTime() <= P.end.getTime()) {
        var mk2 = dIt.getFullYear() + '-' + pad2(dIt.getMonth() + 1);
        var eff = effectiveCosts(DATA.costs, mk2);
        if (!eff) daysMissing++;
        else {
          var dim = new Date(dIt.getFullYear(), dIt.getMonth() + 1, 0).getDate();
          fixeSum += eff.fixe / dim;
          outilsSum += eff.outils / dim;
          costSrc = eff.src;
        }
        dIt = new Date(dIt.getFullYear(), dIt.getMonth(), dIt.getDate() + 1);
      }
    } else daysMissing = 1;
    k.costFixe = Math.round(fixeSum * 100) / 100;
    k.costOutils = Math.round(outilsSum * 100) / 100;
    k.costConfigured = daysMissing === 0 && DATA.costs && Object.keys(DATA.costs).length > 0;
    k.costSrcMonth = costSrc;
    /* Le mois affiché a-t-il sa PROPRE entrée ? (les outils sont variables :
       une valeur reportée d'un mois précédent doit être signalée, pas subie) */
    var mkStart = P.start.getFullYear() + '-' + pad2(P.start.getMonth() + 1);
    k.costOwnEntry = !!(DATA.costs && DATA.costs[mkStart]);
    k.costSetting = k.costConfigured ? Math.round((k.costFixe + k.costOutils + k.commSetting) * 100) / 100 : null;
    k.costPerRdvNB = (k.costSetting != null && k.chNB.n > 0) ? k.costSetting / k.chNB.n : null;

    /* Leads restants côté setting = cohorte − leads ayant self-booké. */
    k.leadsNoSB = Math.max(0, k.leads - k.cohortSelf);

    return k;
  }

  /* ══════════════════════════════════════════════════════════════════
     PÉRIODES — un P = { mode, start, end } (end inclusif, 23:59:59.999)
     ══════════════════════════════════════════════════════════════════ */
  function periodMonth(y, m) {
    return { mode: 'month', y: y, m: m,
      start: new Date(y, m, 1, 0, 0, 0, 0),
      end:   new Date(y, m + 1, 0, 23, 59, 59, 999) };
  }
  function periodDay(iso) {
    var p = String(iso).split('-');
    return { mode: 'day', day: iso,
      start: new Date(+p[0], +p[1] - 1, +p[2], 0, 0, 0, 0),
      end:   new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59, 999) };
  }
  function periodPreset(days) {
    var now = new Date();
    var end = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
    var s = new Date(end.getTime() - (days - 1) * 86400000);
    return { mode: days + 'd',
      start: new Date(s.getFullYear(), s.getMonth(), s.getDate(), 0, 0, 0, 0), end: end };
  }
  function periodCustom(aIso, bIso) {
    var a = String(aIso).split('-'), b = String(bIso).split('-');
    return { mode: 'custom',
      start: new Date(+a[0], +a[1] - 1, +a[2], 0, 0, 0, 0),
      end:   new Date(+b[0], +b[1] - 1, +b[2], 23, 59, 59, 999) };
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
  function loadTypeMap(db) {
    return db.collection('booking_config').doc('_types').get().then(function (snap) {
      return buildTypeMap((snap.exists && snap.data().list) || []);
    }).catch(function (e) { console.warn('[funnel-core] types', e.message); return {}; });
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
    }).catch(function (e) { console.warn('[funnel-core] team', e.message); return []; });
  }

  /* ══════════════════════════════════════════════════════════════════
     CHARGEMENT COMPLET — même pipeline que refresh() dans sales-funnel.html
     ══════════════════════════════════════════════════════════════════ */
  function emptyData() {
    return { ads: [], adsByAd: [], creatives: [], views: [], leads: [], reoptins: [],
      bookings: [], bookingsById: {},
      bookingsTtb: [], calls: [], costs: null, settingDeals: [], journalPeriod: [],
      actions: [], closedLeads: [], payments: [],
      leadsTruncated: false, callsTruncated: false };
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
    if (!TEAM)     pre.push(loadTeamMembers(db).then(function (l) { TEAM = l; }));

    return Promise.all(pre).then(function () {
      return Promise.all([
        loadAds(db, P, DATA), loadAdsByAd(db, P, DATA), loadCreatives(db, DATA),
        loadViews(db, P, DATA), loadLeads(db, P, DATA),
        loadBookings(db, P, DATA, TYPE_MAP), loadCalls(db, P, DATA),
        loadFunnelCosts(db, DATA), loadSettingDeals(db, P, DATA, TEAM),
        loadJournalPeriod(db, P, DATA), loadActionsAll(db, P, DATA, TEAM),
        loadClosedLeads(db, P, DATA), loadPayments(db, DATA)
      ]);
    })
    .then(function () { return resolveChains(db, DATA, TYPE_MAP); })
    .then(function () { return resolvePaymentLeads(db, P, DATA); })
    .then(function () { return { DATA: DATA, typeMap: TYPE_MAP, teamMembers: TEAM }; });
  }

  return {
    /* Constantes */
    ANSWERED_MIN_SEC: ANSWERED_MIN_SEC,
    isAnsweredCall: isAnsweredCall, ringingSecOf: ringingSecOf,
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
    classifyLegacyLabel: classifyLegacyLabel,
    realEntryMs: realEntryMs, pad2: pad2, isoDate: isoDate, median: median,
    phone9: phone9, leadTunnel: leadTunnel, frDateMs: frDateMs,
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
    loadViews: loadViews, loadLeads: loadLeads,
    loadBookings: loadBookings, loadClosedLeads: loadClosedLeads,
    loadPayments: loadPayments, loadCalls: loadCalls,
    loadFunnelCosts: loadFunnelCosts, loadSettingDeals: loadSettingDeals,
    loadJournalPeriod: loadJournalPeriod, loadActionsAll: loadActionsAll,
    resolveChains: resolveChains, resolvePaymentLeads: resolvePaymentLeads
  };
}));
