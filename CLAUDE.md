# CLAUDE.md — team-ambitio

Contexte permanent pour Claude Code. À lire intégralement avant toute action sur ce repo.

---

## ⛔ DANGER IMMÉDIAT — À LIRE EN PREMIER

### 1. Cloud Functions : rapatriement VÉRIFIÉ le 26/09/2026 — déploiement débloqué

L'ancien blocage (« repo 573 lignes vs prod 2 000+ ») est **périmé**. Le 26/09/2026,
`~/index.js` de Cloud Shell (4 544 lignes) a été téléchargé et diffé contre
`Functions/index.js` du repo : **le repo contient tout ce que la prod a, plus des
correctifs pas encore déployés** (garde-fou `seriesManaged` des séries coaching,
`clientType: 'company'` par défaut, `pickAliveLead` dans `findLead`/`onNewLead`).

Le déploiement depuis le repo est donc autorisé, avec les précautions de la règle 2
ci-dessous. `node-fetch@^2` a été ajouté à `Functions/package.json` le même jour
(requis par index.js, présent seulement dans les node_modules de Cloud Shell avant ça).
Après un déploiement réussi, la copie `~/index.js` de Cloud Shell devient obsolète :
le repo est la source de vérité.

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

> Photo au 09/10/2026. La source de vérité est `_meta/team_members` (Admin → Utilisateurs) : ne jamais coder une liste de noms en dur, la lire.

| Personne | Rôle |
|---|---|
| Adrien, Emily | admin |
| Vincent | Head of Sales / admin — **pas** setter, hors rotation dialer |
| Élodie Vidotto Siarri | setter + closer — utilisatrice principale du dialer |
| Marine | CSM |
| Steven, Valentin | setters (Steven : setting écrit) |
| Edouard, Flore, Thomas, Farah | coachs — **jamais** concernés par le module Dialer |
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
- Pages **coaching / admin** → SDK **modulaire v10**, via `window._db`, `window._getDoc`, etc.
- Pages **CSM** → **compat v9.23.0** (`csm-cockpit`, `csm-notes`, `csm-clients`, `csm-diagnostic`,
  `csm-import`), ES5 ; seule exception, `csm-dashboard.html` (ancienne vue) en compat v8
  — toujours vérifier le `<script src>` de la page avant d'écrire du code Firebase.

### Backend — deux runtimes, une raison

| | Vercel Functions (`api/*.js`) | Cloud Functions (`Functions/index.js`) |
|---|---|---|
| Usage | **tous** les endpoints HTTP appelables | uniquement triggers Firestore et jobs planifiés |
| Pourquoi | la policy GCP `iam.allowedPolicyMemberDomains` bloque `allUsers` / `allAuthenticatedUsers` sur les callables Cloud Functions | — |
| Runtime | Node 24 (depuis le 09/09/2026 — Vercel refusait les builds Node 20 à partir du 01/10/2026) | Node 22 (depuis le 26/09/2026 — Node 20 décommissionné par GCP le 30/10/2026) |

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
  trace d'audit. **Seule exception** (validée par Adrien le 10/11/2026) : le journal
  anonyme par visite `tunnel_visits` (mesure des tunnels, aucune personne derrière),
  conservé 90 jours (`expireAt`) et purgé par le cron `api/tunnel-visits-purge.js`.
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
clients restent facturés sur l'EI, **depuis un autre outil** : BERNARD Mireille,
BERTOLINO Laure, COMBES Alexandre, JANVIER Delphine, NAVES Anne-Lise, PRAX Aurore.

Ils **ont** une fiche `invoice_clients` — créée pour simplifier le suivi — mais aucune
facture ne doit sortir d'Alteore pour eux. Le marqueur est le champ
**`billingScope: 'ei'`** sur la fiche client :

- `api/invoice-validate.js` refuse la validation (409) ;
- `api/invoice-qonto-sync.js` refuse la synchronisation, donc l'envoi réseau ;
- ils sont exclus du panneau « prêt pour la facturation électronique ».

Le blocage lit la **fiche client**, jamais le `clientSnapshot` : un draft ancien peut
dater d'avant le marquage. En revanche, l'absence de `subscriptions` et de `payments`
sur ces clients est volontaire — **ne pas tenter de la réparer.**

### 100 % B2B
Aucun client particulier. Une fiche `invoice_clients` portant `clientType: 'individual'`
est une erreur de saisie, pas un cas métier. Depuis le 08/09/2026, le type n'a plus
d'effet nulle part : `mapClientToQonto` envoie toujours `kind: 'company'` (raison
sociale, ou nom du contact à défaut), `sendByEinvoice` ne conditionne la transmission
qu'au SIRET, et `invoice-validate` reconstruit le `clientSnapshot` depuis la fiche en
`'company'` avant la numérotation (l'ancien snapshot est gardé dans
`_clientSnapshotAtDraft`). Avant cela, une fiche mal typée partait chez Qonto en
particulier sans nom → client refusé → facture numérotée **sans PDF ni transmission**
(F2026-00099). Le sélecteur de type a été retiré du formulaire client.

---

## Thème clair « liquid glass »

Bascule ☀️/🌙 dans la sidebar (`localStorage.ambitio_theme`, classe
`body.light-theme`, attribut `body[data-al-page]` posé par nav.js). Deux feuilles,
chargées par nav.js sur toutes les pages internes, inertes en sombre :

- `theme-light.css` — écrit à la main : tokens clairs (superset des variables de
  toutes les pages), atmosphère, sidebar, topbar, modale profil, formulaires.
- `theme-light-pages.css` — **GÉNÉRÉ**, ne jamais l'éditer : surcharges des
  couleurs codées en dur (`rgba(255,255,255,.x)`, `#0f0f1a`, pastels…) page par
  page, scopées par `data-al-page`.

**Après toute modification de CSS dans une page ou un fichier partagé :**

```bash
python3 scripts/build-theme-light.py           # régénère theme-light-pages.css
python3 scripts/build-theme-light.py --check   # vérifie qu'il est à jour
```

Règle : 100 % peinture, jamais de layout. Un nouveau token de page se déclare
aussi dans `theme-light.css` §1 avec sa valeur claire.

## Bac à sable closer (Outils → 🧪, sales + admin)

`sandbox-closer.html` : entraînement sur faux leads, **miroir vivant** du réel.
Les vraies pages `sign.html`, `sales-signatures.html`, `payments.html` tournent
dans `sandbox-frame.html` (pare-feu réseau + Firebase remplacé par la base
locale `sandbox-db.js`) ; le vrai code `api/*` de la signature et des paiements
tourne dans le navigateur via `sandbox-server.js` — **GÉNÉRÉ**, ne jamais
l'éditer. Seul accès réel : la **lecture** de `signature_templates`.

**Après toute modification d'un fichier `api/` utilisé par la signature ou les
paiements (sign-session, signature-*, gocardless-*, payments-send-mandate-*,
`_sign-*`, `_contract-render`, `_companyLookup`…) :**

```bash
node scripts/build-sandbox-server.js           # régénère sandbox-server.js
node scripts/build-sandbox-server.js --check   # vérifie qu'il est à jour
```

Une nouvelle dépendance Node (`require` d'un paquet) dans ces fichiers doit
recevoir son remplaçant dans `scripts/sandbox/shim-*.js`, sinon le build échoue ;
un nouvel appel `fetch` vers un service externe est refusé à l'exécution tant
qu'il n'est pas simulé dans `shim-services.js`. C'est voulu : rien de réel ne
doit pouvoir partir du bac à sable.

## Démarrage différé (30/10/2026)

Le client signe et paie aujourd'hui, mais démarre plus tard. **Le démarrage se
décale, jamais le paiement** : close, commissions, prélèvements et factures ne
bougent pas. Règles : `demarrage-core.js` (partagé navigateur ↔ serveur) ;
écritures : `api/_demarrage.js` ; page + cron horaire : `api/client-demarrage.js`.

- **Source de vérité : `leads/{id}.demarrageDiffere`** (`statut` attente / demarre
  / annule, `date`, `demarreLe`, `historique`, `rappels`). `clients/{id}` et
  `persons/{id}` n'en ont qu'une copie résumée : `coaching.html` réécrit la fiche
  entière, tout ce qui décide côté serveur repasse donc par le lead
  (`attenteDuClient`, `_clientHealth.demarrageDe`), et le cron repose la copie.
- **« Payé »** = premier prélèvement déclenché ou paiement intégral fait, à la
  date du jour : `paiementOk`, un seul endroit.
- **Academy** : champ `users/{email}.demarrageAttendu`, écrit par `bridge/grant-access`
  (date connue à la signature) ou `bridge/manage-access` action `demarrage` (après
  coup). Il ne s'efface jamais seul : le jour J, Team vérifie les conditions avant
  de le retirer. Déployer l'Academy AVANT Team si le pont change.
- **Droits** : le closer pose la date tant que le pilote n'est pas validé ; ensuite
  admin et CSM uniquement ; seul un admin passe outre les conditions (`force`, tracé).
- Panneau partagé : `<div data-demarrage data-client-id="…">` + `demarrage-widget.js`.
  Encart de rappel : `alteore-demarrages.js`, injecté par nav.js.
- Clause de contrat : `scripts/contrats-clause-demarrage.js` (à blanc par défaut).

**Ouverture au paiement (tous les nouveaux clients, 30/10/2026)** : l'Academy ne
s'ouvre plus à la signature mais au prélèvement déclenché (`api/_accesPaiement.js`,
état `leads/{id}.accesPaiement`, côté Academy `users/{email}.paiementAttendu`).
`gocardless-payment` ouvre aussitôt, le cron rattrape le reste et referme si le
PREMIER prélèvement est rejeté (lu dans `lastPaymentFailure`, écrit par la Cloud
Function). Non concernés : client qui a déjà une formation ouverte, contrat de plus
de 30 jours rattrapé depuis Signatures. `paiementOk` tolère 10 jours : GoCardless
repousse le premier prélèvement d'un nouveau mandat (préavis SEPA).

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
- **Pilote de closing** : `close-pilot.js` (cartes deal → contrat → paiement →
  close/coach → RDV 72 h → WhatsApp → checklist → annonce), dans Leads Live
  derrière `_config/sales_close_pilot.enabled` ; partagé avec le bac à sable.
  Avancement sur `leads/{id}.closePilot`. Le close passe par `CloseWizard.commit`.
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
- **Replays des coachings de groupe (12/11/2026)** : `api/coaching-replays-groupe.js`, cron du
  matin, derrière `_config/replays_groupe.enabled`. Lit « Meet Recordings » du Drive de
  coaching@ (`email_tokens/drive_coaching`, entrée « Drive Coaching » d'admin-email-auth), lit
  le coach dans le NOM du fichier (doit correspondre à UN sous-module du module Academy
  « Replay Coaching GR » `f-elite/n58`, et porter la marque groupe `_config/replays_groupe.marqueur`
  — jamais un coaching individuel), déplace la vidéo dans le dossier partagé par lien (déduit des
  leçons déjà rangées), puis l'ajoute par le pont Academy `POST /api/bridge/replay-groupe`
  (repo `ae-academy`, fonctions pures `src/lib/ep/replays.js`) : à la fin du sous-module, publiée,
  titre Google, jamais de doublon, cours Business 6 mois (`f-bp-6m`) recopié aussitôt ET cours
  Business Phénix historique (`f-bp`, module « Replay Coaching GR (<année>) », sous-module du même coach).
  Source : TOUT le Drive de coaching@ (plus « Meet Recordings » depuis août 2026). Trace `replays_groupe/{fileId}`,
  récap email. Accès manuel : clé Vercel `REPLAYS_GROUPE_KEY`, `?dry=1` d'abord.
- **Scoring sociétés (30/10/2026)** : `admin-scoring.html` (admin : solvabilité, tout le
  catalogue Societe.com en boutons, documents officiels), `alteore-scoring.js` (bouton sur
  la fiche en phase de closing, pop-ups), `api/scoring.js`, client `api/_societeCom.js`
  (jeton `SOCIETE_API_TOKEN`, Vercel). Les closers n'ont que la solvabilité, sur demande
  validée par un admin. Le feu est NOTRE règle (`api/_scoringVerdict.js`) : le score
  Societe.com n'y entre pas, échelle non documentée. Données hors règles Firestore
  (`scoring_*`, Admin SDK seul) ; ce qui a été payé est gardé (étude 30 jours).
- **Étapes du Pipeline (29/10/2026)** : `pipeline-etapes.js` est la SEULE règle de
  classement (colonnes Lead · NRP 1-3 · All NRP · Faux numéro/Poubelle · Disqualification ·
  FU · SET NB · Self booking · No show/Annulé/Closed Lost · Closing, et leurs sous-filtres).
  Elle sert au nouveau Pipeline (`pipeline-v2.js` + hôte Firebase `pipeline-v2-host.js`) et à
  la liste déroulante unique de Leads Live (`leads-live-etapes.js`, derrière `?v2=1` /
  `_config/crm_v2`). `stage` est la source de vérité ; `status` reste écrit en parallèle
  (`STATUS_OF`). NB/SB des annulations et Closed Lost = déduit du RDV. « Non honoré
  équipe » = `bookings.cancellation.kind: 'non_honore'` (origine équipe, stage
  `rdv_annules_equipe`). Les Labos Pipeline et Leads Live partagent la même fausse base
  (`sandbox-leads-live-db.js`, faux leads de `sandbox-pipeline-data.js`) ; après toute
  modification de `sales-leads.html` : `node scripts/build-sandbox-leads-live.js`.

- **Qualité leads — LQS / MQS (06/11/2026, demande Vincent)** : onglet « ⭐ Qualité leads »
  de `sales-funnel.html` (admin seul ; la note n'est montrée **nulle part** ailleurs, les closers
  ne la voient pas). Calcul `lqs-core.js` (s'appuie sur `funnel-core.js` : attribution, cash
  `revClient`), rendu `lqs-tab.js`. **LQS** = note 1-5 d'un lead calculée UNIQUEMENT depuis ses
  réponses (`leads.quiz`, `formAnswers`) avec le barème `_config/lqs_grid` (points par réponse,
  réponses éliminatoires, seuils) ; calculée à l'affichage, **jamais écrite sur les leads**.
  **MQS** = note d'une campagne / adset / créa / canal = 60 % LQS moyen + 40 % cash par lead vs
  moyenne. Montants (08/11/2026) : partout **signé** (contrat HT du close, `con`) ET **encaissé**
  (prélèvements passés, `cash`) ; le signé sert aux parts, « / lead », MQS, ROAS et suggestions du barème.
  Un paiement rattaché à une fiche (`leadId`) ne compte plus sur ses doublons même email / téléphone.
  Abandon question par question du quiz : `ALTEO.quiz()` (`tunnel-runtime.js`) →
  `api/tunnel-event.js` (événement `quiz`) → `quiz_funnel_daily`. La MESURE est ajoutée à la
  volée par `api/tunnel-render.js` (module partagé `api/_quizTracking.js`, aucune écriture
  Storage) ; l'écran prix « CA mensuel ≤ 20 k€ → investissement > 6 000 € » n'existe que si la
  page est republiée par `scripts/quiz-tracking-patch.js --apply` (dry-run par défaut).
  Parcours (08/11/2026) : « commencé » = a CLIQUÉ une réponse à Q1 (`starts`), « a vu Q1 » = vue de page
  (`shown`) ; « ont répondu » est déduit de la question suivante quand la page ne le comptait pas ; les
  questions à branches (intitulé qui change selon Q1, même identifiant mesuré) sont réunies en une ligne.
  Lecture unique : arrivés → ont répondu → partis ici (= arrivés ici − arrivés à la suivante) → quiz rempli
  → leads (ce dernier compte limité à la période mesurée) ; les RÉSULTATS (leads, closes, signé) couvrent
  toujours toute la période choisie — ne jamais retirer un lead parce qu'il précède la mesure. Choix multiples
  découpés par option, réponses groupées par version de question, détail par variante (A / D).
  Depuis le 07/11/2026 : `quiz_funnel_daily` a un document par **version publiée** de la page
  (`…--{variante}@{html.version}`) — l'onglet montre par défaut la dernière publication, jamais
  deux versions mélangées ; « Tous les quiz » ne fusionne jamais deux tunnels (Élite ≠
  Présidentielles). Visites internes : `?test_claude`, `?apercu` (session) ou `?alteo_interne=1`
  (appareil) → `x: 1`, ignorées par `api/tunnel-event.js`.
  **Chiffres justes (10/11/2026, audit T0 : chaque compteur rapproché du pixel et de Make, au jour
  près).** Référence = `page_views_daily` (views = arrivés, ctas = ont répondu Q1 via
  `trkStart`, optins = formulaires = exécutions Make). En tête de l'onglet Quiz : « chiffres de
  référence » par quiz × variante (`LqsCore.quizOverview`), « Contrôle de cohérence »
  (`quizChecks` : clics ↔ réponses Q1, formulaires ↔ fiches ; alerte > 20 % un jour de > 30 arrivés,
  reprise dans le brief du matin), « Qualité des leads par page d'entrée » (`qualityByPage`).
  Parcours : période COMPARABLE = publications réunies tant que les questions ne changent pas ; la
  mesure injectée corrigée (Q1 de type `first`, réponse envoyée en QUITTANT la question) porte
  `mv: 2` → champ `measure`, suffixe `m2`, jamais additionnée à l'ancienne. Journal anonyme par
  visite `tunnel_visits` (`vid` de session). Une même campagne Meta peut mener à deux quiz : ne
  jamais attribuer une campagne à une page sans les utm de `tunnel_stats_daily.sources`.

  **Dossiers par prospect + export PDF (13/11/2026)** : `lqs-dossier.js`. Dans la vue d'ensemble, les
  chiffres Leads / RDV pris / Présents / Closes (par note et total) sont cliquables → liste NOMINATIVE,
  chaque nom se déplie : questionnaire complet (`LqsCore.questionnaireOf`), points LQS, issue (closé,
  offre, signé, encaissé), appels de vente (`row.calls`) avec résumé, analyse IA et transcription de la
  visio Meet, lue à la demande par `GET /api/replay-closing?action=get` (admin ; `replay_transcript`
  n'a pas de règle navigateur). Un appel sans replay importé est signalé, jamais remplacé. Bouton
  « 📄 Export PDF complet » : tous les onglets dépliés (`S.exporting`) + un dossier par lead de la
  période. Le document s'ouvre dans un NOUVEL ONGLET autonome qui s'imprime lui-même (`#lqPrint`, CSS
  `@media print` de `sales-funnel.html` recopié, A4 paysage) : sous Safari, `window.print()` reste en
  attente sur une page qui garde une connexion Firestore ouverte — ne jamais imprimer depuis la page.
  Admin seul, aucune écriture.

- **Relances (12/11/2026)** : `admin-relances.html` (admin seul, Marketing → 🔁), segment de leads →
  séquence WhatsApp / SMS / e-mail → réponses, RDV, ventes. Règles partagées `relances-core.js`
  (filtres, exclusions NON désactivables, plage 9 h – 19 h Paris sans dimanche ni férié, détecteur de
  prix : aucun texte avec un tarif ne part). Serveur `api/_relances.js`, page `api/relances.js`, envois
  `api/relances-cron.js` (*/10, lissés, plafond de NOUVEAUX leads/jour par campagne, 80 % du palier Meta,
  pause auto si qualité WhatsApp ROUGE), réponses `api/_relances-hooks.js` (appelé par whatsapp-webhook,
  twilio-sms-inbound, ringover-sms-inbound, gmail-inbound-sync), liens courts `/r/{jeton}` →
  `api/relance-lien.js` (lien du setter assigné, type `attributedSetterSlug`, jamais le lien public ;
  « Plus intéressé » exige un clic sur la page à cause des pré-chargements). Fournisseurs inchangés :
  `envoyerModele` accepte désormais `entete` (vidéo par lien) et `boutons` (URL dynamique, quick reply
  `RLC_STOP:{inscription}`). **`_config/relances.modeTest` vrai par défaut** : le cron n'envoie rien,
  le lancement est refusé ; production = bascule tapée « PRODUCTION ». Lancement = test réussi sur
  l'empreinte exacte de la séquence + nombre de leads retapé. Données Admin SDK seul (aucune règle) :
  `relance_segments`, `relance_campagnes`, `relance_inscriptions/{camp}_{lead}`, `relance_verrous/{lead}`
  (une séquence à la fois), `relance_exclusions/{lead}` (définitif), `relance_envois`, `relance_liens`,
  `relance_compteurs`. Sur le lead : AJOUTS seulement (`communications` `auto:true` source `relance`,
  `timeline_history`, `relanceRepondu` → badge Leads Live) ; seul « Plus intéressé » change l'étape
  (`disqualification` + `pas_interesse`). STOP : les deux champs historiques `smsOptedOut` (Twilio) et
  `smsOptOut` (Ringover) sont lus.
  **Précision des segments (14/11/2026)** : par défaut (`_config/relances`, 0 dans un segment = désactivé)
  ancienneté ≥ 21 j (`ancienneteMinJours`) et aucun contact RÉEL depuis 10 j (`silenceMinJours`) — contact
  réel = `Core.contactReel` : SMS / WhatsApp / e-mail dans les deux sens ou appel DÉCROCHÉ ; un appel
  sans réponse ne compte pas, `lastContactAt` n'est pas utilisé (posé aussi par les appels manqués).
  Exclusions ajoutées : rappel `followUps` à venir, ré-opt-in < 21 j. Avant CHAQUE envoi : RDV
  (`leadId`, `lastBookingAt`, ou `bookings.prospect.telephone/email`), contact décroché par l'équipe
  (`contact_equipe`), rappel programmé entre-temps. **Lien de réservation PUBLIC par défaut**
  (`lienRdv: 'public'`, type `_config/relances.typePublic` = `call_strat_phenix_all` → Self Booking, pas
  de commission de setting — choix d'Adrien) ; `lienRdv: 'setter'` possible. Modèles à bouton lien FIXE
  acceptés. Première campagne = **un seul message** (pas de relance de relance). Vague sans jours refusée.
  **Campagne de suivi (14/11/2026)** : à la fin d'une campagne (plus aucune inscription active NI accusé
  WhatsApp en attente), `R.creerSuivi` crée d'office en BROUILLON `{camp}_suivi` + segment
  `seg_suivi_{camp}` (`filtres.campagneSource`) = inscriptions terminées sans réponse, sans clic, sans RDV
  depuis le 1er envoi ; « Plus intéressé » / STOP exclus par `relance_exclusions`. Recalculé au lancement ;
  modèle WhatsApp à choisir. Bouton manuel « Créer la campagne de suivi ». Après la fin d'une séquence, une
  réponse reçue sous 14 j est encore rattachée (`reponse` sur l'inscription, sans changer son état), comme
  « Plus intéressé » (`plusInteresseA`) et STOP (`stopA`). Échec WhatsApp tardif : `aVerifierActif` suit
  aussi les séquences terminées, fenêtre 72 h (couvre le dimanche).

- **Qualité par pub + API Conversions Meta (12/11/2026, brief « Outil 2 »)** :
  - **Capture** : à chaque opt-in, bloc `leads/{id}.metaIds` (eventId du Lead navigateur, `fbp`/`fbc`,
    fbclid, user-agent, IP si appel direct, ad/adset/campaign id, `allowed` = pixel autorisé chez ce
    visiteur, jamais pour YouTube) — `api/_metaIds.js`, écrit par `lead-optin` (champ `meta` relayé par
    Make « Leads QUIZ ÉLITE ») et `tunnel-optin` (`tunnel-runtime.js` envoie `meta`, expose `ALTEO.meta()`).
    Pages quiz : `api/_quizMetaIds.js` ajoute à la volée (tunnel-render, aucune écriture Storage) les
    champs au payload Make et l'`eventID` au Lead navigateur. Anciens leads : pas de metaIds, rien reconstruit.
  - **Tableau** : onglet « 🎯 Qualité par pub » de `sales-funnel.html` (`ads-quality-tab.js`), lignes =
    `K.utmRowsByAxis` de `funnel-core.js` (nouvelles colonnes : `qualCa` = CA déclaré ≥ 20 k€ via
    `FunnelCore.caQualifOf`, `faux`, `disq`, `neverReached` = aucun appel décroché ni RDV après 48 h,
    `honored` = issue close / non close / offre, `con`, `cpq` / `cph` / `cpv`). Coûts masqués si la dépense
    Make manque plus d'un jour. Média buyeuse : `ads-quality.html?t=…` → `api/ads-quality-share.js`
    (liste blanche de champs, jeton `_config/ads_quality_access`, distinct du lien Agence, audit_log).
  - **API Conversions** : `api/meta-capi-cron.js` (*/10) + règles `api/_metaCapi.js` → pixel
    `1341581597802071` : Lead et Schedule (jumeaux, même event_id que le navigateur), LeadQualifie, RdvPose,
    RdvHonore, Vente (contracté HT). Exclus : faux numéro / poubelle, contact bloqué, YouTube, pixel non
    autorisé, organique sans metaIds, téléphone invalide (LeadQualifie). Réglages `_config/meta_capi`
    (`enabled`, `testMode` VRAI par défaut, `testEventCode`, `testSince` / `productionSince` — jamais de
    rattrapage du passé ; réel = « PRODUCTION » tapé). Jeton : variable Vercel `META_CAPI_TOKEN`. Journal
    `meta_capi_events` (Admin SDK seul, lu par `api/meta-capi.js`, aucune donnée personnelle en clair) ;
    bouton « 🧪 6 événements de test » = contact fictif, code de test obligatoire.
  - **Paramètres d'URL des pubs** (média buyeuse) : `utm_source={{site_source_name}}&utm_medium={{placement}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&Audience={{adset.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`.

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
7. **Autonomie totale, autorisation à chaque fois (consigne d'Adrien, 10/11/2026).**
   Adrien ne veut **aucune action à faire lui-même** : l'agent pousse, déploie, lance
   les scripts, pose les variables Vercel, ouvre les accès réseau de sa session, lit
   et (après dry-run validé) écrit Firestore, vérifie en ligne. Il ne lui demande que
   son **autorisation**, une fois par action sortante (fusion sur `main` = mise en
   production, écriture Firestore, déploiement de règles ou de functions, variable
   Vercel), en disant précisément ce qui va se passer. Les recommandations sont
   validées d'office si elles respectent ces consignes et servent la finalité
   (des données fiables) ; ne demander que ce qui est vraiment une décision d'Adrien.
   Ce qui exige un outil absent de la session (commande Firebase interactive, Console
   GCP) : le dire, proposer la voie qui ne lui demande rien, et ne lui laisser que
   l'autorisation.
8. **Accès aux données de production sans clé de service dans la session.** Lecture :
   endpoints Vercel en lecture seule protégés par une clé posée dans les variables
   Vercel (ex. `api/quiz-audit.js`, `QUIZ_AUDIT_KEY`, limitée à la preview de la branche),
   jamais dans le dépôt ; la supprimer coupe l'accès. Aucune donnée personnelle en
   sortie. Écriture : même principe, toujours dry-run d'abord, `--apply` après accord.

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
sans validation explicite (Node 24 fournit `fetch` et `FormData` nativement).

### Règles Firestore
```bash
firebase deploy --only firestore:rules --project ambitio-team
```
Après vérification de l'écart avec la Console par Adrien.

### Cloud Functions
Débloqué depuis le 26/09/2026 (rapatriement vérifié, voir « Danger immédiat »).
`firebase deploy --only functions --project ambitio-team`, réponse **No** à la
suppression des fonctions orphelines. Commande interactive : c'est Adrien qui la
lance dans son terminal, jamais un agent en mode non interactif.

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
