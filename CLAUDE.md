# CLAUDE.md — team-ambitio

Contexte permanent pour Claude Code. À lire intégralement avant toute action sur ce repo.

---

## ⛔ DANGER IMMÉDIAT — À LIRE EN PREMIER

### 1. Ne JAMAIS déployer les Cloud Functions depuis ce repo en l'état

`Functions/index.js` dans ce repo fait **573 lignes**. La version réellement déployée en
production fait **plus de 2 000 lignes** et vit dans `~/index.js` sur Cloud Shell.
**Le repo est en retard, pas la production.**

Lancer `firebase deploy --only functions` aujourd'hui **écraserait la production** et
détruirait tout le code non rapatrié.

→ Tant qu'Adrien n'a pas confirmé le rapatriement de `~/index.js` dans le repo :
**aucun déploiement de Cloud Functions, sous aucun prétexte.**

### 2. Ne JAMAIS utiliser `--force` sur un déploiement Firebase

Le déploiement des functions propose systématiquement de supprimer **9 fonctions
orphelines** (Twilio voice, dialer, signatures, sync GoCardless). La réponse est
**toujours No**. `--force` répond Yes automatiquement et les supprime en production.

```bash
firebase deploy --only functions          # ✅ interactif, on répond No
firebase deploy --only functions --force  # ⛔ JAMAIS
```

### 3. Aucune écriture Firestore en production sans dry-run validé

Tout script de migration ou de correction s'écrit en deux temps : un mode lecture seule
qui affiche ce qui serait modifié, validé par Adrien, **puis seulement** l'exécution.

### 4. Aucun secret dans le repo

Pas de clé de service account, pas de token, pas de mot de passe — ni dans un fichier,
ni dans un commentaire, ni dans un exemple. Trois secrets sont déjà en attente de rotation
dans le backlog ; n'en ajoute pas un quatrième.

---

## Le projet

**team.alteore.com** — plateforme SaaS interne de SARL Ambitio Corp (marque Alteore),
entreprise de coaching et de formation. Couvre : CRM, pipeline commercial, coaching,
facturation, réservation, formulaires, signatures électroniques, paiements, téléphonie.

- **Projet Firebase** : `ambitio-team`
- **Repo** : `Adrien83440/team-ambitio` → déploiement automatique Vercel sur push
- **Interlocuteur unique** : Adrien, fondateur et seul développeur du projet

## L'équipe (pour comprendre les rôles dans le code)

| Personne | Rôle |
|---|---|
| Adrien, Emily | admin |
| Vincent | Head of Sales / admin — **pas** setter, hors rotation dialer |
| Élodie Vidotto Siarri | setter + closer — utilisatrice principale du dialer |
| Marine | CSM |
| Mickael, Edouard, Thomas | coachs — **jamais** concernés par le module Dialer |
| Guillaume Bilcke | **parti** — exclu en dur (`DEPARTED`) de tous les affichages, historique conservé en base |

Rôles techniques : `admin`, `sales` (setter / closer / closer_setter), `coach`, `csm`.

---

## Architecture

### Frontend
HTML / CSS / JavaScript **vanilla**, aucun build, aucun bundler. Chaque page est un fichier
`.html` autonome à la racine, avec ses `<script>` inline, complété par des `.js` partagés
(`nav.js`, `alteore-flow.js`, `sales-crm-app.js`, `dialer-bridge.js`, `close-wizard.js`…).

**Deux SDK Firebase coexistent — ne jamais les mélanger dans une même page :**
- Pages **sales** → SDK **compat v9.23.0**, objet global `firebase`
- Pages **coaching / admin / CSM** → SDK **modulaire v10**, via `window._db`, `window._getDoc`, etc.

### Backend — deux runtimes, une raison

| | Vercel Functions (`api/*.js`) | Cloud Functions (`Functions/index.js`) |
|---|---|---|
| Usage | **tous** les endpoints HTTP appelables | uniquement triggers Firestore et jobs planifiés |
| Pourquoi | la policy GCP `iam.allowedPolicyMemberDomains` bloque `allUsers` / `allAuthenticatedUsers` sur les callables Cloud Functions | — |
| Runtime | Node 20 | Node 20 |

**Conséquence : tout nouvel endpoint HTTP va dans `api/`, jamais dans Cloud Functions.**

Dans `api/`, les fichiers préfixés `_` sont des helpers partagés et sont exclus du routing
Vercel : `_firebaseAdmin.js`, `_verifyFirebaseAuth.js`, `_parseBody.js`, `_gmailSend.js`,
`_billing-helpers.js`, `_billing-pdf.js`, `_ringoverClient.js`, `_twilioClient.js`…

### Services externes
Ringover (voix, SMS entrants via Make) · Twilio (SMS sortants `+33939240397`, Voice SDK
navigateur) · GoCardless (prélèvement SEPA) · Qonto (banque unique, Plateforme Agréée
e-invoicing PA-0025) · Google Workspace `adrienemily.com` (Gmail API, Calendar) ·
Make (écrit dans `webhook_inbox` via le module natif Firestore).

**Pattern webhook** : le service externe écrit un document dans `webhook_inbox` → la Cloud
Function `onWebhookInbox` se déclenche → traite → supprime le document.

---

## Conventions de code — non négociables

### ES5 strict partout
- **Pas d'arrow functions** → `function(x) { ... }`
- **Pas de template literals** (backticks) → concaténation avec `+`
- **Pas de `const`/`let` dans les fichiers historiques** — suivre le style du fichier édité
- Seule exception : `coaching.html`, écrit en ES6 moderne

Raison : cohérence, et Safari sur d'anciens appareils utilisés par l'équipe.

### innerHTML et gestionnaires d'événements
Pas de `onclick` inline avec des quotes imbriquées. Utiliser des attributs `data-*` et une
délégation d'événements.

### Validation avant toute livraison
- `node --check` sur chaque fichier `.js` modifié
- `new Function(code)` sur chaque bloc `<script>` inline extrait d'un `.html`
- Pour les scripts de patch Python : assertion `s.count(OLD) == n` avant chaque `replace()`,
  plus un garde-fou d'idempotence qui vérifie la présence d'une chaîne unique du nouveau code

### Livraison
**Fichiers complets, production-ready.** Jamais de diff, jamais de patch à appliquer à la
main. Si un fichier est trop gros pour être réécrit entièrement, le dire et proposer une
autre découpe — ne pas livrer un demi-fichier.

---

## Firestore

### Règles de sécurité
`firestore.rules` est dans le repo, mais **la Console Firebase est la source de vérité** :
le fichier peut être en retard. Ne rien déployer sans qu'Adrien ait comparé.

**Les règles ne cascadent JAMAIS du parent vers les sous-collections.** Chaque
sous-collection a besoin de son propre bloc `match`. Un oubli a déjà cassé la page Édition
facture en production (incident du 22/07/2026 sur `_config/billing/cgv`).

### Pièges
- `experimentalAutoDetectLongPolling: true` doit rester dans les réglages Firestore côté
  frontend — sans lui, WebChannel se bloque sur Safari.
- Index composites obligatoires pour les requêtes multi-champs. Le lien de création apparaît
  dans le message d'erreur navigateur.
- Limite de **1 Mo par document** — d'où le chunking base64 des PDF de factures
  (700 000 caractères par chunk, sous-collection `pdf/`).
- Les identifiants externes vivent dans les documents `_config/*` en Firestore, sauf pour
  les Vercel Functions qui utilisent les variables d'environnement Vercel.
- Vercel tue la fonction avant les écritures Firestore asynchrones → **toujours écrire avant
  `res.end()`**, et utiliser `preferRest: true` dans `_firebaseAdmin.js` pour éviter les
  `DEADLINE_EXCEEDED` gRPC au démarrage à froid.

### Règles métier sur les données
- **Rien n'est jamais supprimé** — on archive, on met à jour, ou on soft-delete avec une
  trace d'audit.
- Téléphone canonique des leads : champ **`telephone`**, format E.164 strict `+33XXXXXXXXX`.
  Le champ legacy `phone` n'est plus utilisé.
- Les documents portant `_merged: true` doivent être ignorés dans toute recherche de lead
  (motif `pickAlive()`).
- Date effective d'un lead = la plus ancienne parmi `dateWebinaire`, `importedCreatedAt`,
  `createdAt`.
- La séance coaching 72h (`type === 'rdv72h'` ou `numero === 0`) est **toujours** exclue des
  quotas mensuels.
- Numérotation de facture : jamais de retour en arrière. Un 409 signifie « existe déjà ».

### Dualité EI / SARL
L'activité a démarré en entreprise individuelle avant la création de la SARL. Certains
clients restent facturés sur l'EI et **n'ont volontairement aucun** document
`invoice_clients`, `subscriptions` ou `payments` : BERNARD Mireille, BERTOLINO Laure,
COMBES Alexandre, JANVIER Delphine, NAVES Anne-Lise, PRAX Aurore.
**Ce n'est pas un bug. Ne pas tenter de les réparer.**

---

## `nav.js` — trois variables globales

Ce ne sont **pas** des fonctions :

```js
window.TEAM_MEMBERS         // objet { slug: membre }
window.TEAM_MEMBERS_LIST    // tableau trié
window.TEAM_MEMBERS_ACTIVE  // membres actifs uniquement
```

L'événement `team-members-loaded` est émis quand les données sont prêtes.

`_meta/team_members.email` est la **boîte professionnelle**, pas l'identifiant Firebase Auth.
Pour relier un membre à un compte Auth, utiliser le champ `firebaseUid`.

---

## Modules principaux

- **CRM & Leads** : `sales-leads.html` (Leads Live), `sales-crm.html` + `sales-crm-app.js`
  (pipeline kanban), `sales-contact.html`, `sales-retargeting.html`
- **Setting / Closing** : `sales-setting.html` (**SET NB**), `sales-closing.html`
  (**Close SB**), moteur `alteore-flow.js`, modale résultat `rdv-outcome.js`,
  parcours de close `close-wizard.js`
- **Booking** : `booking.html` (public), `booking-admin.html` — la séparation
  Setting&Sales / Coaching passe par `classifyBooking`
- **Facturation** : `admin-facturation.html`, `admin-invoice-edit.html`,
  `api/invoice-*.js`, `api/subscription-generate-invoice.js`,
  helpers `api/_billing-*.js` — **admin uniquement**
- **Paiements** : `payments.html`, `api/gocardless-*.js`
- **Dialer** : `sales-dialer.html/.css/.js`, `dialer-bridge.js`, `api/dialer-*.js` —
  visible **uniquement** pour les rôles `sales` et `admin`, **jamais** pour `coach`
- **AlteoForms** : `alteoforms.html` (builder), `alteoforms-render.html` (rendu public),
  collection `alteo_forms`
- **Coaching** : `coaching*.html` — SDK modulaire, style ES6

Spécification de référence du flux commercial : `REFONTE-SPEC.md`.

---

## Comment travailler avec Adrien

1. **Lire le code réel avant de proposer.** Vérifier les noms de champs et de fonctions dans
   les fichiers concernés. Ne jamais inventer un nom de champ ni supposer une signature.
2. **Un seul tour de questions groupées** avant d'écrire du code, jamais d'itérations en
   cours de route. Présenter les points ouverts en **numéroté, en français, avec une
   recommandation explicite** pour chacun, puis attendre une confirmation unique.
3. Adrien répond de façon très concise (« ok go », « tes recos », « 1a 2 oui 3b »).
   C'est une validation, pas un manque d'attention.
4. **Communication en français.**
5. Toujours donner la **séquence de déploiement ordonnée** en fin de livraison
   (rules d'abord, puis frontend, etc.).
6. Signaler les régressions possibles et les chemins non testés plutôt que de les taire.

---

## Déploiement

### Isolation projet — obligatoire

Adrien travaille sur plusieurs projets en parallèle, une fenêtre VS Code par projet.
**Ce repo ne cible QUE le projet Firebase `ambitio-team`.**

- **Toujours `--only`** : jamais de `firebase deploy` nu, qui déploie tout
  (rules + functions + hosting) d'un coup.
- **Toujours `--project ambitio-team`** sur les commandes de déploiement : c'est la
  ceinture de sécurité si le dossier courant n'est pas celui attendu.
- **Vérifier `firebase use`** avant tout déploiement, pour confirmer le projet actif.
- Toute commande visant un autre projet Firebase est une erreur : s'arrêter et prévenir
  Adrien plutôt que de continuer.

```bash
firebase use                                                    # vérifier où on est
firebase deploy --only firestore:rules --project ambitio-team   # forme correcte
firebase deploy                                                 # ⛔ jamais
```

### Frontend
Commit + push → Vercel déploie automatiquement. Aucun build, aucune dépendance ajoutée
sans validation explicite (Node 20 fournit `fetch` et `FormData` nativement).

### Règles Firestore
```bash
firebase deploy --only firestore:rules --project ambitio-team
```
Après vérification de l'écart avec la Console par Adrien.

### Cloud Functions
**Bloqué** jusqu'au rapatriement de `~/index.js` (voir « Danger immédiat »).
Une fois débloqué : `firebase deploy --only functions --project ambitio-team`, réponse
**No** à la suppression des fonctions orphelines.

### Ordre général
Règles Firestore → variables d'environnement → frontend → activation des flags de
configuration. Les bascules fonctionnelles se font par un flag dans `_config/*`, pas par un
déploiement.

---

## Environnement local

- `.firebaserc` doit exister à la racine (attention : le repo contient un fichier
  `firebaserc` **sans point**, que le CLI Firebase ignore — à corriger).
- `firebase use ambitio-team` pour sélectionner le projet.
- Les émulateurs (`firebase emulators:start`) sont la façon correcte de tester tout ce qui
  touche Firestore ou les règles. La production n'est pas un environnement de test.
- Pour les scripts Node avec l'Admin SDK : la clé de service account reste **hors du repo**
  (`~/.secrets/`), référencée par variable d'environnement.

---

## Historique utile

- Les identifiants sont dans `_config/*` en Firestore, sauf côté Vercel (variables
  d'environnement).
- `PUBLIC_ACTIONS` dans `onWebhookInbox` liste les actions publiques qui contournent la
  validation de clé API (OTP de signature, etc.).
- Changer l'email d'un compte Firebase Auth ne demande **aucune** migration de données :
  l'UID reste stable. Mettre à jour la Console Auth et `users/{uid}.email`, c'est tout.
- Génération PDF : `pdf-lib` + `@pdf-lib/fontkit`. `sanitizeForPdf()` retire les `\u202F`
  (espace fine insécable produite par `toLocaleString`) avant `widthOfTextAtSize()`.
