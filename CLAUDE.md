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

**team.alteore.com** — plateforme SaaS interne de SAS Ambitio Corp (marque Alteore ;
SARL transformée en SAS en novembre 2026 : Emily Ughetto Présidente, Adrien François Directeur général),
entreprise de coaching et de formation. Couvre : CRM, pipeline commercial, coaching,
facturation, réservation, formulaires, signatures électroniques, paiements, téléphonie.

- **Projet Firebase** : `ambitio-team`
- **Repo** : `Adrien83440/team-ambitio` → déploiement automatique Vercel sur push
- **Interlocuteur unique** : Adrien, fondateur et seul développeur du projet

## Contrats des indépendants de l'équipe (24/11/2026)

Sept modèles GÉNÉRÉS dans `signature_templates` (audience admin, `roleSignataire: 'prestataire'` → le bloc de
signature dit « La SOCIÉTÉ / Le PRESTATAIRE »), copies dans `scripts/data/contrats-atelier/` : `full-cycle`
(5ji06Vk86eXGcLdkXQ5b), `full-cycle-canada`, `csm-coach-expert` (modèle « Marine », TiSsuFgNni218AC9n1bd),
`setting-telephonique`, `setting-ecrit`, `coach-elite-phenix`, `coach-business-phenix`. Refondus après une relecture
« requalification en salariat » (demande d'Adrien) — à ne JAMAIS réintroduire dans un contrat d'indépendant :
heures ou volume horaire minimum, forfait proportionnel au temps, compte rendu quotidien, objectifs ou cadence
« définis par » un responsable, « évaluation », réunions obligatoires, planning établi par la société, « période
d'essai » (dire « phase de démarrage »), barème révisable par la société seule. Le forfait du setting rémunère la
prise en charge de prospects (capacité et délai convenus par écrit), pas un temps. Pas d'annexe opérationnelle
(retirée à la demande d'Adrien) : seule l'annexe 1 (barème) reste. Les anciens PDF importés (« envois rapides »,
`isAdhoc`, cachés de la grille) restent en base. Rédaction de l'agent, pas un avis d'avocat. Non traité : le suivi
du temps de connexion (`api/user-activity.js`) et l'EOD quotidien (`sales-eod.html`) s'appliquent encore aux
indépendants.

## L'équipe (pour comprendre les rôles dans le code)

> Photo au 09/10/2026. La source de vérité est `_meta/team_members` (Admin → Utilisateurs) : ne jamais coder une liste de noms en dur, la lire.

| Personne | Rôle |
|---|---|
| Adrien, Emily | admin |
| Vincent | Head of Sales / admin — **pas** setter, hors rotation dialer |
| Élodie Vidotto Siarri | setter + closer — utilisatrice principale du dialer |
| Marine | CSM **et aussi coach** (double casquette `alsoCoach`, voir plus bas) |
| Steven, Valentin | setters (Steven : setting écrit) |
| Edouard, Flore, Thomas, Farah | coachs — **jamais** concernés par le module Dialer |
| Guillaume Bilcke | **parti** — exclu en dur (`DEPARTED`) de tous les affichages, historique conservé en base |

**Double casquette « Aussi coach » (23/11/2026)** : un compte n'a qu'UN rôle. Pour qu'un membre
garde son rôle (Marine : `csm`) et coache aussi, case « 🎓 Aussi coach » d'Admin → Utilisateurs →
`users/{uid}.alsoCoach` + même drapeau sur sa fiche `_meta/team_members`. Ne JAMAIS changer son rôle
en `coach` (elle perdrait cockpit CSM, Mes notes, signatures, e-mails de démarrage). Effets : listes de
coachs (`getCoachOptions`, règle unique `window.isCoachMember`), actes Academy des coachs
(`estCoach(auth)` de `_verifyFirebaseAuth.js` : jalons, validations, devoirs), bloc de règles autonome
« AUSSI COACH » (créer une fiche client, Communication coaching, alarmes ; publiable par
`rules-lecteur-funnel.js?bloc=aussi_coach`). Volontairement exclu : le choix du coach référent au close
(`close-wizard.js`, pilote) reste `role === 'coach'`. RDV : une fiche expert SÉPARÉE « 🎯 Coach » dans
Booking, reliée au compte coaching@ (sinon l'enregistrement Meet n'arrive pas dans le Drive lu par la
synchro des coachings) ; la fiche CSM reste sur son propre agenda.

**Fiche coach automatique (23/11/2026)** : `api/coach-provision.js` fait ce qui se faisait à la main dans
Booking, pour un compte de rôle `coach` ou « Aussi coach » : fiche « 🎯 Coach » (SÉPARÉE de la fiche
d'origine pour une double casquette, créée si absente), consultations coaching de la MAJORITÉ des coachs
déjà réglés (double casquette : seulement les `coaching_*`, pas les RDV d'accueil / d'audit du coach
référent), tampons / délais / plafonds des coachs en place, connexion du compte coaching partagé RECOPIÉE
d'une fiche coach (`calendar_tokens`, champ `copieDe`), sous-agenda au prénom du coach (repris s'il existe,
sinon créé), agendas de la fiche d'origine recopiés en agendas supplémentaires. Ne remplit que ce qui
MANQUE, n'écrase rien ; les horaires ne sont jamais recopiés (personnels). Le nouveau sous-agenda est
ajouté DÉCOCHÉ aux autres fiches du compte : sinon `fetchAndStoreBusy` le coche d'office et ses RDV
bloquent tous les coachs. Créer un agenda exige le droit Google « gérer les agendas », donné UNE fois
(Booking → fiche coach → « ⚡ Mise en place automatique » → `calendar_master_tokens/coaching`, Admin SDK
seul) ; les jetons des fiches n'ont que lecture + événements. Déclenché par `admin-users.html` (création
d'un coach, passage en coach, case « Aussi coach ») et par le bouton ⚡. À blanc par défaut (`apply`),
trace `coach_provision_log`. Réglages facultatifs `_config/coach_provision` (`types`, `typesAussiCoach`,
`nomSousAgenda`). Accès manuel : clé Vercel temporaire `COACH_PROVISION_KEY` (`action=audit|provision`).

Rôles techniques : `admin`, `sales` (setter / closer / closer_setter), `coach`, `csm`,
`funnel_viewer` (utilisateur technique d'un lien d'accès en lecture au Stats funnel — voir plus bas).

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
  **Deuxième exception** (validée par Adrien le 20/11/2026) : `meta_ip/{event_id}` (IP +
  navigateur d'un visiteur pour l'API Conversions, `api/meta-ip.js`), effacé après 8 jours
  (`expireAt`, purge dans `api/meta-capi-cron.js`) — Meta refuse tout événement de plus de 7 jours.
- Téléphone canonique des leads : champ **`telephone`**, format E.164 strict `+33XXXXXXXXX`.
  Le champ legacy `phone` n'est plus utilisé.
- Les documents portant `_merged: true` doivent être ignorés dans toute recherche de lead
  (motif `pickAlive()`).
- Date effective d'un lead = la plus ancienne parmi `dateWebinaire`, `importedCreatedAt`,
  `createdAt`.
- La séance coaching 72h (`type === 'rdv72h'` ou `numero === 0`) est **toujours** exclue des
  quotas mensuels.
- Numérotation de facture : jamais de retour en arrière. Un 409 signifie « existe déjà ».

### Dualité EI / SAS
L'activité a démarré en entreprise individuelle avant la création de la société (SARL,
devenue SAS en novembre 2026 — la valeur technique `billingScope: 'sarl'` est conservée,
seuls les libellés disent « SAS » ; factures et contrats émis avant restent en SARL).
Bascule des données faite le 23/11/2026 (route temporaire retirée, visible dans l'historique git) :
émetteur `_config/billing` en SAS, CGV de facturation version 1.1 (la 1.0 archivée), 7 modèles de
contrat en nouvelle version (« Emily Ughetto, Présidente, et Adrien François, Directeur général »),
`_config/ai_context` ; valeurs d'avant dans `sas_migration_log`. Cachet des contrats refait en
« SAS AMBITIO CORP » (`api/_sign-brand.js`). Un nouveau contrat ne dit jamais « SARL » ni « gérant »
pour Ambitio Corp. Certains
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
- **Prélèvements rejetés → factures impayées (24/11/2026)** : `api/invoice-rejets.js`. Avant, seule la Cloud Function
  sur `paid_out` créait une facture : un rejet ne laissait aucune pièce pour le cabinet de recouvrement. Chaque prélèvement
  GoCardless `failed` / `customer_approval_denied` / `charged_back` (sans facture existante) crée un BROUILLON
  `_pendingValidation` portant `_rejetGc` (`etat`, `gcStatus`, `chargeDate`, `cause`, `motif` FR, `reasonCode`, `historique`),
  rangé dans « À valider » → « ❌ Prélèvements rejetés » ; « 🧾 Valider (impayée) » = `invoice-validate` seul (numéro + PDF
  à la date du prélèvement), JAMAIS `invoice-mark-paid`. Exclus : facture déjà sur ce `gcPaymentId`, client EI, rejet RATTRAPÉ
  par un autre prélèvement PONCTUEL encaissé (hors abonnement / échéancier : la mensualité suivante n'est pas un
  rattrapage) du même mandat et même montant (sa facture naît de celui-là). Prélèvement encaissé PUIS
  rejeté (échec tardif, contestation) : son brouillon « Paiement reçu » est CONVERTI en brouillon de rejet
  (`_rejetGc.convertiDepuisEncaissement`, ancienne mention gardée dans `_notesPublicAvantRejet`) ; déjà émis → signalé seulement
  (`facture_emise_rejet`). Rapprochement à chaque passage
  (`_rejetGc.etat === 'actif'`) : même prélèvement finalement `paid_out` → brouillon redevenu encaissement normal
  (`encaisse_apres_rejet`) ou facture émise à marquer encaissée (`encaisse_apres_validation`, liste « 💶 Rejets finalement
  encaissés ») ; compteurs `payments.paidCount/paymentsHistory` et `subscriptions.installmentsPaidOnGC` posés ici car la Cloud
  Function s'arrête dès qu'une facture porte le `gcPaymentId`. Rattrapé par un autre prélèvement → brouillon archivé
  (`_archived`, motif) ou `rattrape_apres_validation` (risque de double facture, signalé). Cron quotidien 05:25 UTC, n'écrit que si
  `_config/billing.rejetsAuto === true` (bouton de l'onglet Synchro, 60 derniers jours) ; trace `_config/billing.rejetsDernierPassage`
  + `audit_log` type `gocardless_rejets`. Aperçu / création manuels dans Synchro (à blanc d'abord). Accès manuel temporaire :
  clé Vercel `REJETS_KEY` (`GET ?key=…[&apply=1]`). Filtre « ❌ Prélèvement rejeté » + badge dans la liste des factures.
  Non couverts : mandats en échec SANS aucun prélèvement (rien à rejeter chez GoCardless) → facture manuelle.
- **Relances d'offres (26/11/2026, réglages du 27/11/2026)** : `sales-relances-offres.html` + `api/_offerRelances.js` (actions
  `offers` / `offer_draft` / `offer_set` / `offer_send` de `api/ai-followup.js`) : RDV non closés et offres sans retour, un e-mail et un
  SMS rédigés par l'IA à la demande, envoyés au clic seulement (`_config/offer_relances.sendEnabled`). Demandes d'Adrien du 27/11 :
  **jamais avant 10 jours** après le RDV, offre comme non closé (`minDays` ne descend pas sous 10) ; l'IA doit citer au moins deux
  éléments du dossier (frein repéré après le RDV, réponse au questionnaire, note, analyse du closing) ; l'e-mail part MIS EN FORME
  (`htmlRelance` : bandeau `media/relances-offres/bandeau.jpg`, texte relu par le closer, lien remplacé par un bouton « Réserver mon
  créneau ») ; le SMS dit « vous pouvez réserver un créneau ici : {lien} ou retrouver ce que je vous ai partagé dans votre boîte mail »
  (le prospect ne peut pas répondre à un SMS) ; **lien court de prise de RDV** `https://team.alteore.com/o/{code}` (6 caractères,
  `lienDeReservation`, code gardé sur la carte `lienCode` et dans `offer_liens/{code}`, Admin SDK seul) ouvert par `api/offre-lien.js`
  (page relais, clic compté par le navigateur, seule une adresse `https://team.alteore.com/…` est ouverte). Un brouillon d'avant garde
  l'adresse longue dans son texte : elle est remplacée à l'envoi.
  **Rédaction (27/11/2026, 2e demande d'Adrien)** : le but est que le prospect REVIENNE sur sa décision, même après un non. Le prompt porte
  les outils des meilleurs négociateurs (nommer ce qu'il ressent, question à laquelle il répond non, question ouverte, ses propres mots, prix
  de ne rien faire) et une réponse par objection (trop cher, pas le temps, bilan / début d'année, associé, « je réfléchis »…), sans rien
  inventer. **Jamais de prix** (on ne sait pas s'il a été annoncé) : garde-fou `RE_PRIX` de `contenuInterdit` (un montant collé à un mot de
  prix est refusé, les chiffres du prospect restent permis). Lien des témoignages (`lienTemoignages`, par défaut le mur public
  `temoignages-public.html`) donné dans l'e-mail seulement, si le prospect demande des preuves ou doute ; dans `htmlRelance`, seul le lien
  de réservation devient le bouton, un autre lien reste un lien.
  **Envoi automatique (27/11/2026, demande d'Adrien)** : `api/_offerRelancesAuto.js`, cron `api/offer-relances-auto.js` (2 passages par
  heure, 9 h – 19 h Paris, hors dimanche et fériés). Il réutilise `listOffers` / `draftOffer` / `sendOffer` (tous leurs refus valent).
  Décisions d'Adrien : partent seuls les CAS NETS (« À relancer », note présente, ni sensible, ni reclassé par l'IA, ni message signalé, ni
  dossier trop mince) — le reste est noté `auto.etat: 'a_la_main'` + motif et reste au closer ; jamais pendant la séquence d'après-RDV
  (offre : J+10 ; non closé : à la fin de sa séquence) ; 2e relance sans réponse à 30 jours du RDV et 20 jours au moins après la 1re, jamais
  de 3e ; une relance faite à la main compte ; stock lissé (`plafondJour` 10, du RDV le plus récent au plus ancien, 3 par passage). Réglages
  `_config/offer_relances.auto` (`actif` faux par défaut, `modeTest` VRAI par défaut = À BLANC : l'automate rédige et note `a_blanc`, rien ne
  part, le texte relu partira tel quel en réel ; réel = « PRODUCTION »). L'automate ne dépend pas de `sendEnabled` (interrupteur des envois
  manuels) ; `me._auto` n'est posé que côté serveur. Traces : `offer_relances/{id}.auto`, `sends[].auto`, compteur
  `offer_relances_auto/{AAAA-MM-JJ}` (Admin SDK seul). Réglage et simulation par la route (`?dry=1`, `action=reglage`, admin ou clé du chantier).
  **Page en deux colonnes (27/11/2026, demande d'Adrien)** : liste des prospects à gauche (pictogramme d'état `etat(x)` : ✓ envoyé, ▲ à vous
  de décider / SMS non remis, ✎ brouillon prêt, ○ à rédiger, 💬 a réagi ; filtres Tous / À faire / Envoyés, recherche), dossier ouvert à droite
  (dossier + « Suivi des envois » d'un côté, message de l'autre ; onglet « 👁 Aperçu de l'e-mail » = action `offer_preview`, même `htmlRelance`
  que l'envoi, rien d'écrit ; résumé et transcription de l'appel lus à la demande par `replay-closing?action=get`). Suivi (`completerSuivi`) :
  SMS remis ou non (`sms_delivery/{sid}`, le SMS part désormais avec `statusCallback`), lien ouvert (`offer_liens.clics`) ; pour l'e-mail on
  sait qu'il est parti, jamais s'il a été lu (Gmail ne donne aucun accusé). Catégorie d'affichage « Ont réagi » (`ont_reagi`, jamais écrite) :
  réponse ou RDV repris APRÈS une relance partie du module — sans relance de notre part, le prospect sort de la liste comme avant.
- **Setting écrit Instagram / Facebook (27/11/2026, demande d'Adrien)** : `admin-setting-social.html` (Marketing → 📲, admin seul)
  + `api/setting-journal.js`. Le setting écrit est mené par un agent Claude dans Meta Business Suite (navigateur), PAS par l'API
  Graph : la synchro `ig_*` / `fb_*` ne voit pas de façon fiable ce qui est envoyé. L'agent tient un journal (une ligne par
  événement : `at`, `passage`, `canal`, `type`, `personne`, `publication`, `texte`, `etape`, `note`, `auteur`) et le dépose à la
  fin de chaque passage (8 h 30, 12 h 15, 19 h 30) par la page elle-même, `window.SettingJournal.importer(lignes, passage)`,
  avec la session admin du navigateur : aucune clé. Données Admin SDK seul, aucune règle : `setting_journal/{empreinte}` (AJOUT
  SEUL, redéposer une ligne ne crée pas de doublon, rien n'est réécrit) et `setting_journal_depots` (trace). Onglet Échanges
  (conversation = personne + canal, + publication pour un commentaire ; états À voir par toi / Lien de RDV envoyé / Réponse à
  faire / En cours / Repris par toi / Laissé sans réponse) et onglet Reporting (par jour, par passage, par canal). « RDV
  réservés par le lien » = `bookings.landing.attribution.utm_medium == 'setting_ecrit'` (le lien du setting porte ce
  paramètre), comptés le jour de la réservation. Lecture seule : rien ne part de cette page vers Meta.
  **Réponse dès l'arrivée d'un message (27/11/2026, demande d'Adrien)** : `api/_settingReveil.js` + `api/setting-reveil.js`. Sur un
  message privé ENTRANT (jamais un écho) journalisé par `instagram-webhook` / `facebook-webhook`, Team appelle l'adresse d'appel d'une
  tâche Claude sans horaire (`…/v1/claude_code/routines/{tâche}/fire`, jeton en variable Vercel `SETTING_REVEIL_TOKEN`, tâche par défaut
  dans le code, remplaçable par `SETTING_REVEIL_ROUTINE`). L'appel part SANS contenu : rien du prospect ne sort de Team. Cet appel ouvre
  une session Claude à part, sans navigateur : elle écrit une ligne « ⚡ Signal de Team » dans le chat du projet Claude, et c'est le
  coordinateur du projet qui demande le passage léger au fil du setting. `_config/setting_reveil.actif` FAUX par défaut (bouton en haut de
  `admin-setting-social.html`) ; au plus un appel toutes les `intervalleMin` minutes (5, jamais moins de 2 : la tâche accepte 30 appels
  par heure) ; `heureDebut` – `heureFin` (9 h – 22 h Paris) ; `plafondJour` (120). Un message arrivé pendant l'intervalle est noté
  `enAttente` dans `setting_reveil_etat/courant` (Admin SDK seul) et pris par le cron (*/5), qui ne fait rien sans message en attente.
  Un appel en échec ne fait jamais échouer le webhook. Chaque réveil consomme de l'abonnement Claude d'Adrien.
- **Dialer** : `sales-dialer.html/.css/.js`, `dialer-bridge.js`, `api/dialer-*.js` —
  visible **uniquement** pour les rôles `sales` et `admin`, **jamais** pour `coach`
- **AlteoForms** : `alteoforms.html` (builder), `alteoforms-render.html` (rendu public),
  collection `alteo_forms`
- **Coaching** : `coaching*.html` — SDK modulaire, style ES6
  **Fiche client (20/11/2026)** : le bloc Séances est TOUJOURS affiché, SOUS la section ouverte (`data-fc-pinned`,
  hors du jeu des tuiles ; la tuile Séances y fait défiler) : une tuile ouvre sa section AU-DESSUS des coachings. **CSM = accès complet à la fiche** : bloc autonome
  « CSM COACHING » de `firestore.rules` (lecture / ajout des documents du plan `clients/{id}/plans`, fichiers
  de séance `clients/{id}/files`, lecture des réponses de questionnaire `alteo_forms/{id}/responses`) ;
  côté page `window._canManage` (admin + csm) : ajouter un plan, « Proposer pour tous », liaison des
  questionnaires. Supprimer un document de plan reste admin. Les blocs de règles autonomes se publient par
  `api/rules-lecteur-funnel.js?bloc=…` (copies dans `api/_rulesLecteurFunnelBlock.js`, clé Vercel temporaire).
- **E-mail du compte Academy (23/11/2026)** : le compte vit sous l'e-mail du SIGNATAIRE du contrat
  (`academy-grant`), la fiche coaching garde souvent celui du lead (opt-in). Tout appel au pont qui porte
  un e-mail passe par `fetchPont` de `api/_academyCompte.js` (même signature que `fetch`) : si l'Academy
  répond « aucun élève à cet e-mail », l'appel est rejoué avec l'e-mail du signataire des contrats signés
  du même client (par `clientEmail`, par le lead, par `clients._leadId`). Rien d'écrit, aucun coût quand
  les e-mails concordent. Une nouvelle route vers le pont utilise `fetchPont`, jamais `fetch` nu. Sens
  inverse : `academy-client-info` retrouve la fiche par le contrat. La fiche affiche l'e-mail du compte
  quand il diffère. Non concernés : `academy-grant`, `_accesPaiement`, `signature-cancel` (partent déjà
  du contrat).
- **Envoyer ses accès Academy (23/11/2026)** : rien n'envoie l'e-mail « Crée ton mot de passe » tout seul
  (ni la signature, ni l'ouverture au paiement) ; avant, seul le back-office Academy le pouvait. Tuile
  Academy de la fiche coaching, sous l'avancement (`acadAcces` de `coaching.html`) : état (jamais connecté /
  déjà connecté / désactivé, date du dernier envoi, lien expiré), « 📧 Envoyer ses accès » et « 🔗 Copier le
  lien » (WhatsApp). `api/academy-access.js` actions `invite-etat` / `invite` / `invite-lien`, ouvertes aux
  admins, CSM ET coachs (`estCoach`, « Aussi coach » compris) — les autres actions de la route restent
  admin / CSM. Pont Academy `POST /api/bridge/send-access` (repo `ae-academy`, `mode` etat / envoyer / lien) :
  lien 3 jours à usage unique, un nouveau lien annule le précédent ; ne crée aucune fiche, n'ouvre aucune
  formation, refuse un compte désactivé. Trace `clients.academyAccessHistory`.
- **Fiche coaching en tuiles (20/11/2026)** : `openDetail` de `coaching.html` range la fiche en six
  sections ouvertes par des tuiles (`FC_PANES` : Synthèse · Plan d'action · Séances · Academy ·
  Quota & RDV · Dossier), chaque tuile portant son chiffre (`data-fc-sub`, mis à jour par
  `fcSetSub` quand l'Academy ou les fichiers du plan finissent de charger). Les blocs gardent leurs
  identifiants et leurs fonctions : un nouveau bloc se pose dans le `data-fc-pane` qui convient, jamais
  hors section. La section ouverte est conservée quand la même fiche se redessine (`_fcPane`). Clics
  par délégation (`data-fc-tile`, `data-fc-go`, `data-fc-fix="edit"`). « 🧩 À compléter » =
  `fcManques(c)` (fiche + plan + comptes rendus) ; l'onglet « Fiches incomplètes » de la liste et le
  repère des cartes n'utilisent que `fcManquesFiche(c)` (e-mail, téléphone, nom complet, activité,
  date d'entrée), calculé à l'affichage, rien d'écrit.
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
- **Synchro automatique des coachings 1:1 (16/11/2026)** : `api/coaching-auto-sync.js` (moteur
  `api/_coachingAutoSync.js`), cron 6 h et 19 h Paris (4 entrées UTC 4/5/17/18 h, la route ne travaille
  qu'à 6 h / 19 h Paris), derrière `_config/coaching_auto_sync.enabled` (`?activer=1|0`, `?dry=1`,
  `?apply=1`, `?days=` ≤ 90 ; clé manuelle Vercel `COACHING_AUTO_SYNC_KEY` ou `CRON_SECRET`). Fait seul ce
  que fait le bouton « 🔍 Chercher les résumés » de `coaching.html`. Source : Drive de coaching@
  (`email_tokens/drive_coaching`) — TOUS les coachings 1:1 y sont enregistrés, jamais le compte d'un coach.
  L'heure et le coach viennent de la RÉSERVATION Booking (`isCoaching`, même jour, heure du titre Meet ±90 min,
  nom ressemblant) ; à défaut, nom du titre unique parmi les clients actifs, sinon rien (ambigu → rapport).
  Séance cible : même jour → ±2 j → première séance planifiée sans date de la dernière année (72 h pour
  « RDV urgent / post inscription »). Séance « planifiée » + enregistrement = passée en **« fait »** (décision
  Adrien), trace `s.autoSync`, `s.heure`, `s.bookingId`. Contenu : RÉSUMÉ + DÉTAILS (+ étapes suivantes) des
  notes Gemini dans `driveSummary`, jamais la transcription — règle partagée navigateur ↔ serveur
  `coaching-gemini-core.js` (le bouton manuel l'utilise aussi). Vidéo seule liée après 24 h. Aval par appel
  INTERNE des mêmes routes que la page (`api/_internalCall.js` → `req._internalAuth`, reconnu par
  `_verifyFirebaseAuth`, impossible à poser depuis le réseau) : `academy-seance`, `coaching-send-replay`
  (auto, registre anti-doublon), puis pour une nouvelle synthèse `academy-path` (proposition en attente) et
  `academy-workbook`. Allumée, elle remplace la livraison coaching de `meet-recordings-sync` (un seul email).
  Traces Admin SDK seul : `coaching_autosync/{fileId}` (sert aussi à reposer un lien effacé par une
  sauvegarde de la page), `bookings/{id}.coachingSync` (`lie` / `aucun_enregistrement` après 14 j /
  `deja_dans_la_fiche`), badge dans « RDV coaching du mois ». `_config/coaching_auto_sync.partageVideo:
  'lien'` rend une vidéo non partagée lisible par lien (choisi par Adrien le 16/11/2026 ; `?partageVideo=`).
  Pas d'email client pour une séance de plus de `mailMaxJours` (14) jours : le rattrapage remplit la fiche seule.
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
  **Supprimer = archiver** (boutons 🗑, 14/11/2026) : `archiveeA` / `archiveePar` sur la campagne ou le
  segment, masqués de la page, rien effacé. Refusé pour une campagne en cours / en pause (l'arrêter
  d'abord) et pour un segment utilisé par une campagne visible.
  **Vidéo d'en-tête (14/11/2026)** : par l'API, Meta exige le média à CHAQUE envoi d'un modèle vidéo
  (le Gestionnaire WhatsApp le fait seul). `R.mediaEntete` reprend d'office la vidéo d'EXEMPLE du modèle
  validé (`components HEADER example.header_handle[0]`), la téléverse une fois (`/{phoneNumberId}/media`),
  garde l'identifiant 25 j dans `relance_medias/{modèle}` ; une URL saisie sur l'étape prime. Vidéo
  indisponible → campagne en pause `video_indisponible`, AUCUN SMS de repli (problème de config, pas du lead).
  Vidéo > 16 Mo (limite WhatsApp par l'API) : refus avant envoi, taille affichée. Modèle repassé en relecture chez
  Meta pendant une campagne → pause `modele_non_approuve` (`detailPause` affiché), jamais de bascule SMS ;
  liste des modèles illisible → passage sauté. Bouton « 📲 M'envoyer ce message maintenant » (`testerEtape` +
  `statutTest`, champ `codeMeta` — jamais `code`, lu comme statut HTTP par le routeur).
  **`{{lien_video}}` (SMS de repli seulement, 14/11/2026)** : lien court `type: 'video'` → page servie par
  `relance-lien.js` (prénom, vidéo, « Réserver mon appel », « Plus intéressé »). Vidéo = URL de la 1re étape
  WhatsApp, sinon `DEFAUTS.videoPage` = `media/relances/RET_DEJA_VU_whatsapp.mp4` (compressée 13,8 Mo, servie
  en statique). Clics et vues comptés par un POST du NAVIGATEUR (`action=clic|vue`), jamais à la lecture du lien :
  iMessage / WhatsApp / antivirus ouvrent les liens pour l'aperçu. Le lien de réservation passe donc par une
  page relais (plus de 302 direct). La page vidéo intègre le calendrier (`booking.html?…&embed=1`, hauteur par le message
  `bk_height`, redirection de toute la page à la confirmation) : à côté de la vidéo sur ordinateur, dessous sur téléphone.

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
    RdvHonore, Vente (contracté HT), et (19/11/2026, demande média buyeuse) **LeadLQS3plus / LeadLQS4plus /
    LeadLQS5** = note LQS ≥ 3 / ≥ 4 / = 5, CUMULATIFS (un 5 envoie les trois), `custom_data.lqs` ; note calculée
    côté serveur par `lqs-core.js` + `_config/lqs_grid` au passage qui suit l'opt-in, jamais renvoyée si le barème
    change, jamais écrite sur la fiche ; téléphone plausible exigé comme LeadQualifie. « Prospect qualifié » de la
    média buyeuse = `LeadLQS3plus`. **LeadDisqualifie** (19/11/2026) = réponse ÉLIMINATOIRE (⛔, `sc.ko`) du barème
    SEULEMENT, jamais une note 1-2 par cumul (le lead peut évoluer) → audiences d'exclusion. `user_data` porte aussi
    prénom / nom hachés (`fn` / `ln` : champ `prenom` sinon premier mot de `nom`) ; pas de ville (jamais demandée).
    **IP du visiteur (20/11/2026, diagnostic Meta « IP manquante »)** : quiz via Make et RDV n'avaient que le
    navigateur. Le navigateur appelle `POST /api/meta-ip {e: event_id}` (quiz : injecté par `_quizMetaIds.js` à
    l'envoi ; `booking.html` : dans `bkPixelSchedule`, id du RDV) seulement si le pixel est autorisé →
    `meta_ip/{event_id}` (premier appel fait foi, Admin SDK seul, 8 jours) ; `Capi.attachNet` joint IP ET
    navigateur du même appel (toujours en paire) aux événements de la fiche / du RDV. Exclus : faux numéro / poubelle, contact bloqué, YouTube, pixel non
    autorisé, organique sans metaIds, téléphone invalide (LeadQualifie). Réglages `_config/meta_capi`
    (`enabled`, `testMode` VRAI par défaut, `testEventCode`, `testSince` / `productionSince` — jamais de
    rattrapage du passé ; réel = « PRODUCTION » tapé). Jeton : variable Vercel `META_CAPI_TOKEN`. Journal
    `meta_capi_events` (Admin SDK seul, lu par `api/meta-capi.js`, aucune donnée personnelle en clair) ;
    bouton « 🧪 10 événements de test » = contact fictif, code de test obligatoire.
  - **Paramètres d'URL des pubs** (média buyeuse) : `utm_source={{site_source_name}}&utm_medium={{placement}}&utm_campaign={{campaign.name}}&utm_content={{ad.name}}&Audience={{adset.name}}&campaign_id={{campaign.id}}&adset_id={{adset.id}}&ad_id={{ad.id}}`.

- **Lieu et appareil du prospect (23/11/2026, demande Adrien)** : bloc `leads/{id}.visiteur` (et
  `bookings/{id}.visiteur`) `{ city, region, country, device, os, browser, app, via, at }`. Lieu = en-têtes de
  géolocalisation Vercel (`x-vercel-ip-*`), juste UNIQUEMENT quand le navigateur du prospect appelle Team (jamais
  Make) ; **aucune adresse IP conservée**. Premier relevé = fait foi, jamais écrasé. Captes : `tunnel-optin`
  (direct), quiz → beacon `POST /api/visiteur {e: event_id}` injecté par `_quizMetaIds.js` → `lead_visiteur/{event_id}`
  (Admin SDK seul) relu par `lead-optin` à l'arrivée de Make (sinon cron horaire `?job=rattrapage`), RDV pris par le
  prospect lui-même (`booking.html` `bkVisiteurBeacon`, `{b: id}` ; jamais setter / agent / coaching). Pour TOUS les
  visiteurs, pixel autorisé ou non (rien ne part chez Meta). Règles partagées dans `funnel-core.js` : `uaDevice`
  (appli Facebook / Instagram / Messenger / TikTok détectée), régions FR (codes ISO, anciens codes, départements,
  outre-mer), `visiteurOf(lead, blocRdv)` (bloc lead → RDV → appareil déduit de `metaIds.ua` à l'affichage, leads
  depuis le 12/11/2026, rien d'écrit), axes `device` / `region` de `leadAxisKey` → Qualité leads (MQS), Qualité par
  pub (sans colonnes de coût : Meta ne donne pas la dépense par appareil / région ; lien média buyeuse compris),
  onglet 👥 Leads (colonnes + CSV), dossiers nominatifs. Lecteur funnel : région seulement, jamais la ville sur une
  fiche nominative. Rattrapage des CLIENTS : `GET /api/visiteur?job=signatures` (lieu de la signature,
  `via: 'signature'`, à blanc par défaut, `&apply=1`, trace `visiteur_backfill_log`, clé Vercel temporaire
  `VISITEUR_KEY` ou `CRON_SECRET`). Avant le 12/11/2026 : rien de récupérable (aucun navigateur ni lieu enregistré).
- **Accès lecture au Stats funnel — liens par personne (19/11/2026, média buyeuse)** : Stats funnel →
  « 👁 Accès lecture » (admin) : un lien par personne, durée 24 h / 7 / 30 / 90 j / date (≤ 1 an),
  prolonger, désactiver / réactiver, journal des connexions (une session par ouverture de page : date,
  durée via signe de vie 5 min, ville Vercel, appareil). API `api/funnel-acces.js` ; données Admin SDK
  seul, AUCUNE règle : `funnel_links/{id}` (secret, échéance, historique des actions, rien supprimé) et
  `funnel_links/{id}/sessions`. Lien `funnel-acces.html#t=<id>.<secret>` (secret dans le fragment) →
  `login` → jeton personnalisé (`createCustomToken`) pour l'utilisateur technique `fl_<id>`, doc
  `users/fl_<id>` { role `funnel_viewer`, status, expiresAt, funnelLink } (masqué d'Admin → Utilisateurs,
  le rôle n'y est plus proposé ni dans `user-invite`). Mêmes vues que l'admin dans `sales-funnel.html`
  (tous les onglets, noms des leads, questionnaires, export PDF), **lecture seule**. La barrière, ce sont les
  règles : bloc autonome « LECTEUR FUNNEL » à la fin de `firestore.rules` (lecture seule des collections
  du module, aucune écriture ; status `disabled` ou `expiresAt` passé → plus rien, page ouverte comprise).
  Exclus : `commissions/*` (coût de setting agrégé par `api/funnel-lecture.js`, montants seuls, via
  `FunnelCore.loadSettingDeals` → `window.FUNNEL_READONLY`), transcriptions / résumés / analyses IA des
  visios (`lqs-dossier.js` ; `replay-closing` reste admin), les `_config` hors des 6 documents du module.
  API ouvertes au lecteur par `requireFunnelReader` (`_verifyFirebaseAuth.js`, contrôle aussi l'échéance) :
  `GET /api/meta-capi`, `meta-capi-cron?dry=1`, `funnel-lecture`, `funnel-acces` open / ping.
  `nav.js` : une seule entrée de menu, toute autre page renvoie au funnel, aucun widget d'équipe. Ouvrir un
  lien dans un navigateur déjà connecté à l'équipe déconnecte ce compte (la page prévient avant).
  Limite connue : `bookings.replay.summary/analysis` sont des champs du RDV, masqués à l'écran mais lisibles
  par le SDK (les règles ne filtrent pas les champs).

- **Chiffres commerciaux : UN référentiel pour tous les écrans (25/11/2026, demande d'Adrien après les retours de Vincent)** :
  audit de 1 026 chiffres sur tous les écrans → 264 écarts (le même mot calculé de dix façons). Désormais **un mot = un calcul**,
  et ce calcul vit à UN endroit. Tout ce qui suit PRIME sur les entrées plus anciennes ci-dessous (dont « les deux règles de close restent »).
  - **`stats-core.js`** (navigateur ↔ serveur, `require('../stats-core.js')`, chargé AVANT `alteore-flow.js` / `funnel-core.js` sur toute
    page qui les charge) : classe d'un RDV (`classifyBooking` : self / setter / `admin` = « Manuel » / excluded), **état unique** d'un RDV
    (`etat` : doublon, replanifié, annulé, no-show, présent, à statuer, à venir — le résultat saisi fait foi, le statut n'est qu'un repli ;
    « passé » = fin du créneau, heure de Paris), agrégat `compter` aux identités garanties, `showUp`, `tauxClose`, `fmtPct`, `fmtEuro`,
    `estDecroche`, `setterDuRdv`, `closerDuRdv`, `rangPersonne` (onglet / « Non attribué » : inconnu, « Anciens membres », « Prénom (hors
    onglets) », « Prénom (avant son arrivée) »), `estParti` + `PARTIS_HISTORIQUES` (LA seule liste de prénoms de membres partis), temps de
    Paris (`jourParis`, `dateParis`, `debutJourParis`…), et le **GLOSSAIRE** + le petit **« i »** (`StatsCore.info('cle')`, précision locale
    en 2e argument, `infoLibre` pour une note hors glossaire). **Aucune page ne recode un de ces prédicats ni ne réécrit la définition d'un
    terme** : un nouveau terme s'ajoute au glossaire de stats-core.js.
  - **Règles** : RDV (à leur date) = annulés + no-show + présents + à statuer + à venir, replanifiés et doublons hors compte (le remplaçant
    compte à sa date) ; RDV = SB + NB + Manuels ; **Kept = RDV − annulés** (no-show dedans, règle Vincent du 14/07) ; **Show-up = présents ÷
    (Kept − à venir)** ; Présents = disqua. + pitchés + sans détail ; « RDV pris » / « Sets » = à la CRÉATION, hors remplaçants, **un set = un
    RDV du setting réellement créé** (les statuts « Set » sans RDV sont listés à part) ; RDV manuels jamais dans RDV pris / Sets / LTB.
  - **UN close = UN client gagné, compté une fois, le jour où il est gagné** (`leads.clientSince`, décision d'Adrien du 25/11 : plus de
    « RDV closé à la date du RDV » sur les pages équipe). **Liste unique** : `FunnelCore.buildCloses` / `loadCloses` / `sumCloses` — funnel,
    Qualité leads, Set NB, Close SB, Global closing, Dashboard, Projections, assistant lisent CETTE liste. Fiche gagnée = clientSince dans la
    période + non fusionnée + un signal de vente (étape closed_won_*, RDV close, paiement, contrat signé ; `closedData` seul ne suffit pas) ;
    + RDV closés sans fiche + paiements sans fiche gagnée. Canal d'un close = classe du RDV porteur, sinon réponse du closer, sinon étape
    (`canalEcart` signale un désaccord : la commission suit la réponse du closer). Closer / setter d'un close : une chaîne. Close annulé
    (verdict `revClient`) retiré partout. Contracté = Σ `rv.con`, Collecté = Σ `rv.paid` (à ce jour), Reste à encaisser = contracté −
    collecté, « 1ers prélèvements en attente » = Σ `rv.pending`, Panier moyen = contracté ÷ closes (le mot AOV disparaît), « Prélevé sur la
    période » = `FunnelCore.cashInPeriod` (autre chiffre, autre mot). Taux de close = closes ÷ pitchés de la période (« — » si > 100 %).
  - **Vocabulaire unique** : Contracté (pas Signé), Collecté (pas Encaissé / Cash), Présents (pas Live / Honorés / Tenus), Pitchés (pas
    Offres ; « Offre en attente » = le seul résultat offre), Closes (pas Ventes), Kept, Sets, « de la période » (pas « du mois »). Un chiffre
    tapé à la main porte « déclaré » ; l'ancienne saisie hebdomadaire (arrêtée en juillet 2026) porte « ancienne saisie ».
  - **Personnes** : onglet Équipe = somme des onglets + ligne « Non attribué » (`rangPersonne`) ; plus de raccourci « le seul closer / setter
    reçoit tout » ; **membres partis** : plus d'onglet ni de nom, mais leur activité passée RESTE dans les totaux (« Anciens membres »).
    **Corrections ✎** : plus appliquées aux colonnes tirées des RDV et des paiements (on corrige le résultat du RDV ou le paiement) ; gardées
    pour téléphone, messages et actions de fiche ; les anciennes restent en base, affichées en repère.
  - **Dashboard** rebranché sur ces calculs à partir de juillet 2026 (avant : ancienne saisie étiquetée) ; montants nominatifs réservés aux
    admins et à la personne elle-même. **Lien Agence** : `api/agency-funnel.js` envoie une liste BLANCHE de champs (plus aucun champ
    nominatif ou interne ne peut sortir) — tout nouveau champ lu par la page Agence doit y être ajouté. Qualité par pub : « Pitchés »,
    « Closes », « RDV pris » (aucun chiffre ne bouge ; les événements Meta ne sont pas touchés).
  - **Rien de muet** : plafond de lecture atteint, lecture en échec, repli sur un montant déclaré → message à l'écran (`k.erreursLecture`,
    `_erreur` / `_tronque` des chargeurs d'AlteoreFlow, `res.erreur` de loadCloses).
  - **Auteur d'un appel : UNE règle** — `FunnelCore.callerOf` (compte relié `userId`, sinon prénom Ringover ; à prénom égal un membre en
    place prime sur un ancien membre) et `FunnelCore.perimetreAppel` (`sales` / `sans_auteur` compté en « Non attribué » / `hors` = coach,
    CSM, jamais dans les Appels, parti ou non). Set NB (onglet Équipe ET onglet d'un membre), Dashboard (tableau ET filtre par personne),
    Pilotage (`callMember`), assistant et funnel passent par elle : ne jamais refiltrer un appel par `c.userId === uid` côté admin. Seule
    limite : un compte sales ne lit que ses appels `userId == uid` (règles Firestore) — dit dans le « i » (terme `appels_sous_ton_compte`).
    Ligne d'un appel dans une vue par personne = `FunnelCore.ligneAppel(who, jour)` : un appel daté d'AVANT l'arrivée du membre
    (`startDate`) va en « Non attribué », précision « Prénom (avant son arrivée) », sur tous les écrans. À prénom égal, l'auteur est le
    même partout (membre en place, puis plus petit `order`, puis clé).
  - **Hôte d'un RDV : UNE règle (27/11/2026)** — `StatsCore.resoudreHote(persons, team)` (fiche d'agenda `booking_config/{personId}`
    → membre) : le COMPTE RELIÉ à la fiche (`firebaseUid`) d'abord (à compte égal, membre en place > ancien membre > plus petit
    `order` > slug), puis `personId == slug`, sinon null ; roster COMPLET (anciens membres compris). Cas réel : `booking_config/elodie`
    est reprise par Anthony depuis le 10/10/2026 → ses RDV sans closer vont à Anthony ; ceux qui portent `expertSlug: 'elodie'`
    restent « Anciens membres ». Close SB, Global closing, Set NB, Dashboard, Stats funnel, Qualité leads, Pilotage et l'assistant
    l'appellent, Projections aussi (`FunnelCore.resoudreAvec` / `resoudrePersonneDe` délèguent) : ne jamais la recoder dans une page.
    Avant, sept copies ne suivaient pas le même ordre : 81 RDV d'Anthony (45 d'octobre, 36 de novembre 2026) tombaient en « Anciens
    membres » sur Close SB, Global closing, Qualité leads, Dashboard, Stats funnel et l'assistant (mesuré sur la base réelle).
    Qualité leads ne montre que les closes de la période AFFICHÉE : `sales-funnel.html` ne transmet K (closes, KPI) que s'il a été
    calculé pour cette période (`K._periode`, `kPret()`, aussi pour les onglets Funnel, Leads, Qualité par pub) ; `lqs-tab.js`
    reconstruit le modèle quand les closes fournis changent ; un changement de période pendant un chargement s'annonce tout de
    suite (`annoncerPeriode`) et le résultat de l'ancienne période n'est jamais affiché sous le libellé de la nouvelle.
    27/11/2026 : chaque chargement travaille sur une COPIE FIGÉE de la période (`figerPeriode`, `DATA._P`, jamais `P`) et note sa génération
    (`_genPeriode`, `S.gen` de `lqs-tab.js`) : tout changement de période pendant le chargement, même un aller-retour, invalide son résultat.
  - **Contrôle de cohérence du funnel** : l'égalité « RDV closés ↔ Closes » est une PARTITION calculée UNE fois dans le moteur
    (`k.coh.egalite`, listes `rdvDeClosesAnnules`, `rdvEnTrop`, `rdvClosesHorsListe`, `closesSansRdv`, `closesRdvHorsPeriode`) ; la page
    l'affiche sans la recalculer. `coh.annules` et `coh.doublonsRdv` ne sont que des listes d'information, jamais des termes de l'égalité.
  - **Seule écriture modifiée** : `clientSince` n'est plus jamais réécrit s'il existe ; clés de jour / mois écrites à l'heure de Paris ; un
    close est refusé (rien n'est écrit) si l'équipe n'est pas encore chargée (`window.TEAM_MEMBERS_LIST` vide : la lecture est relancée),
    au lieu de partir sans commission. L'EOD garde le jour de l'APPAREIL (la date est la clé du document `eod/{uid}/jours/{date}`).
  - **Preuve** : banc d'essai croisé (même jeu de données chargé sur tous les écrans, 2 fuseaux, ~2 900 égalités, dont l'égalité du
    contrôle de cohérence sur chaque jour et chaque semaine) + contrôle sur les données réelles de septembre à novembre 2026 (novembre :
    69 RDV, 6 closes, 40 000 € contracté, 23 000 € collecté, identiques partout).
  - **Non traité, à connaître** : `Functions/index.js` et `firestore.rules` non touchés (`Functions/index.js` repose encore `clientSince`
    quand `isClient` est faux alors qu'une date existe : à corriger au prochain déploiement des functions) ; `pipeline-etapes.js`,
    `rdv-outcome.js`, `close-wizard.js` gardent leurs règles d'écriture ; second contrat d'un client déjà gagné (son montant rejoint le
    premier close) ; un close corrigé puis refait plus tard garde sa première date.
  - **Date de gain : toujours un Timestamp, lue par UNE règle (reprise du 25/11/2026)**. D'anciennes pages CSM écrivaient
    `leads.clientSince` en TEXTE (`'AAAA-MM-JJ'`, la date d'entrée de la fiche coaching) : fiche invisible des requêtes par date, close
    compté par son paiement seul. Désormais : (1) la lecture d'une date écrite en texte vit à UN endroit, `StatsCore.dateTexteMs`
    (jour seul ou `JJ/MM/AAAA` → midi UTC+1 de ce jour ; date-heure ISO → l'instant, sans fuseau = heure de Paris ; le reste → null),
    avec `StatsCore.instantMs` (toute forme → ms) et `StatsCore.jourDe` (toute forme → jour de Paris) ; `csm-clients.html`,
    `csm-diagnostic.html`, `clients-dedup.html`, `sales-clients.html` chargent `stats-core.js` pour cela — ne jamais recoder cette
    lecture dans une page. (2) Toute écriture de `clientSince` pose un Timestamp et ne réécrit JAMAIS une date existante : pages CSM
    (`clientSinceDepuisDateEntree`, transaction de `csmMarkLeadAsClient`), Pipeline (`majLeadClient` de `sales-crm-app.js`), fiche
    contact (`svClient`), fusion de doublons (`clientSinceFusion` : la date de la fiche principale n'est jamais remplacée par celle
    d'un doublon). Sans `stats-core.js` (script bloqué), l'écriture est refusée (« recharge la page »), jamais repliée en silence.
    (3) Une date reprise garde sa valeur d'origine sur la fiche : `clientSinceTexte` (texte) ou `clientSinceAvant` (map
    `{seconds, nanoseconds}` laissée par l'ancienne fusion) + `clientSinceConvertiLe` ; trace `reprise_client_since_log` (Admin SDK
    seul). Ne jamais effacer ces champs. Reprise FAITE le 26/11/2026 sur la base réelle (contrôle à blanc validé par Adrien, écriture
    après la mise en production) : 4 fiches converties (1 d'avril, 3 de mai 2026), trace
    `reprise_client_since_log/cs_20261126T061329Z_09a285`, aucune map. Effet, relu après écriture avec le vrai moteur : nombre de
    closes inchangé dans tous les mois ; avril 2026 + 14 400 € de contracté et de collecté (le second paiement d'une cliente,
    compté nulle part jusque-là, rejoint son close) ; mai 2026 mêmes totaux, 3 closes datés du jour de leur fiche. Reste une fiche
    fusionnée à la date illisible (`wb_1096`, non cliente, ignorée partout), laissée telle quelle. La route temporaire
    `api/reprise-donnees.js` est dans l'historique git (commit 6798824), pas sur `main` ; sa clé Vercel `REPRISE_KEY` est neutralisée.
  - **Plus de données nominatives dans le code (25/11/2026)**. Une page statique est servie à tout le monde, SANS connexion : aucun
    nom, e-mail ou téléphone de client ou de prospect ne s'écrit dans un fichier servi, même en commentaire ou en exemple (exemples :
    `prenom@exemple.com`, `+33600000000`). Retirés : les lignes de commission en dur de `sales-commissions.html` (les 33 lignes des
    deux anciens membres sont en base, `commissions/{uid}/mois/{AAAA-MM}`, vérifié sur la base réelle) et le fichier mort
    `sales-data.js`. Plus déployés (`.vercelignore`, fichiers gardés dans le dépôt) : `import-bigin.html`, `migrate-clients.html`,
    `retargeting-migrate.html`, `retargeting-data.js` (import déjà joué : `_meta/retargeting_migrated` existe) et l'ancienne page
    hors menu `sales-suivi-client.html`. Restent à l'appréciation d'Adrien : les téléphones de l'équipe dans les pages
    `process-onboarding-*`, et les anciens déploiements Vercel (ils contiennent encore les anciens fichiers ; la protection Vercel
    du projet ne couvre que les previews).

- **Chiffres cliquables Set NB / Close SB / Funnel (21/11/2026, demande Vincent)** : `stats-drill.js`
  (partagé, lecture seule, aucune requête : la page fournit les lignes déjà chargées ; styles injectés par
  variables de thème, rien à régénérer). `sales-setting.html` et `sales-closing.html` gardent les lignes
  derrière chaque chiffre (`lists[jour][colonne]`) ; clic sur une cellule, une semaine, le total ou une
  carte → liste nominative (setter, closer, lien fiche), Collecté / Contracté → montants par client
  (verdict `FunnelCore.revClient`, jamais recalculé). Une journée corrigée à la main (✎) est signalée
  dans la liste (« N affiché, M en base »). **Set NB** : onglet « Équipe » = somme des onglets
  (corrections comprises) + ligne « Non attribué » (RDV du setting sans setter identifiable, décision
  Adrien) ; colonnes « RDV NB » (RDV qui ONT LIEU, replanifiés déduits — ≠ « Sets » = RDV POSÉS) et
  « Pitchés » (`AF.isPitched`). **Funnel** : ligne 2 du héro cliquable (`k.drill`, `k.closeRows`) et
  « Contrôle de cohérence » (`k.coh`) : les deux règles de close restent (pages équipe = RDV au résultat
  « close » à la date du RDV ; funnel = fiche gagnée sur la période), chaque écart est NOMMÉ. Ces trois
  champs de K sont nominatifs : ils figurent dans `AGENCY_EXCLUDE` (`api/agency-funnel.js`).
  « 1ers prélèvements en attente » (`rv.pending`) n'est qu'une partie du « reste à encaisser »
  (contracté − collecté) : ne plus jamais leur donner le même nom.
  **Retour Vincent (21/11/2026)** : Set NB affiche le pont « Sets ↔ RDV NB » (`bridgeHtml` : RDV posés sur la
  période / avant / de remplacement ; sets dont le RDV a lieu sur la période / après / replanifiés / sans RDV),
  chaque ligne de liste dit quand le RDV a été posé et par qui si ce n'est pas le setter retenu. Un onglet de
  setter = les RDV dont IL est le setter, jamais ceux qu'il reçoit comme closer. **Qualité leads** :
  `loadMissingLeads` charge aussi les fiches gagnées dans la période (`clientSince`, même requête que le
  funnel) et celles d'un paiement CRÉÉ dans la période même sans prélèvement passé (un close à 0 € encaissé
  manquait : 5 closes / 34 000 € contre 6 / 40 000 € au funnel) ; date du close = RDV « close », sinon date
  client, sinon création du paiement. Carte « Rapprochement avec le Stats funnel » (`funnelCheckHtml`,
  `ctx.funnelCloses` = `K.closeRows`) : chaque écart nommé. Dossiers : closer, setter et date du RDV visibles
  sans déplier (`whoHtml`, `row.setterName`).
  **Vérifié sur novembre 2026 (22/11/2026, contrôle temporaire retiré)** : Qualité leads suit PAR DÉFAUT les
  leads ENTRÉS sur la période (`cashMode: 'cohorte'`) — un lead entré en octobre et signé en novembre n'y est
  pas, d'où 5 closes / 34 000 € contre 6 / 40 000 € au funnel ; les cartes Closes et Signé affichent donc aussi
  le chiffre « sur la période » et celui du Stats funnel (`twoLens`, `funnelTot`). Set NB : onglets libellés
  « Setting » ; sous chaque « RDV NB », « dont N posés avant la période, N de remplacement » (`rdvOrigin`) —
  ex. réel : 4 sets et 6 RDV NB = 4 + 1 posé en octobre + 1 RDV de remplacement.
  **23/11/2026 (3e retour Vincent, re-vérifié sur les données réelles : calcul juste, 6 closes / 40 000 € des deux
  côtés)** : les cartes Closes / Signé / Encaissé de Qualité leads affichent TOUJOURS les closes SIGNÉS sur la
  période (`monthHead` = `periodSigned`), donc les mêmes chiffres que Closes / Contracté / Collecté du funnel ;
  le chiffre « leads entrés sur la période » passe en sous-ligne, le tableau par note reste sur les leads entrés
  et le dit. Ne plus jamais mettre en tête un chiffre de cohorte à côté d'un funnel qui compte la période.
  `stats-drill.js` : fenêtre OPAQUE en thème clair (`--bg2` y est translucide). Set NB : « reporté à une nouvelle
  date » remplace « de remplacement ».
  **4e retour Vincent (23/11/2026)** : (1) Funnel — sous chaque carte des deux lignes du héro, la part Self
  Booking et Setting (`split3` ; `k.ocDueSB` / `k.ocDueNB`, `k.keptSB` / `k.keptNB`) ; LTB SB + LTB NB = LTB global.
  (2) Qualité leads — cartes Closes / Signé / Encaissé cliquables (`drillV`, kind `signed`). (3) Set NB — colonnes
  « Contracté » (`contracteNb`) et « Reçus » (`recus` : leads ENTRÉS sur la période via `FunnelCore.loadLeads`, sans
  RDV Self Booking, rangés chez `setterSlug || assignedTo`, sinon « Non attribué » en Équipe) ; « pas encore
  travaillé » = fiche sans `firstActionAt`. Les leads TRAVAILLÉS ne sont pas un sous-ensemble des reçus (première
  action du setter, quelle que soit la date d'entrée). (4) **Global closing** = `sales-closing.html?vue=global`
  (entrée de menu `sales-global`, `nav.js` distingue les deux adresses) : par closer, Self Booking + RDV du
  setting ; pas de corrections ✎ dans cette vue (elles restent propres à Close SB et Set NB).
  **27/11/2026 (choix « 2a » d'Adrien, constat : « Leads présents » 8 sous filtre closer quand Global closing disait 18
  présents)** : Vue d'ensemble de Qualité leads, 2e rangée = la période : cartes **RDV / Présents / Pitchés = RDV DATÉS
  dans la période** (`M.rdvPeriode` de `lqs-core.js`, même fabrique `rdvDatesEntre` que `M.rdvRows`, agrégée par
  `LqsCore.byCloser(M.rdvPeriode, slug)` ; ne dépend JAMAIS de la plage de la vue Closers), mêmes chiffres que Global closing
  (filtre closer = son onglet) et le Stats funnel ; puis Closes / Contracté / Collecté. Cliquables : une ligne par RDV
  (`rdvRowOf` de `lqs-tab.js`, identifiant = le RDV, `ficheId` pour le lien). « Leads avec RDV », « Leads présents »,
  « Leads pitchés » (leads entrés) passent en sous-ligne sous leur propre nom. Contrôle à l'écran (carte « Contrôle : mêmes
  closes… ») : RDV / présents / pitchés ici = `K.tenue` du funnel, seulement sans filtre tunnel / source. Règle : **ne plus
  jamais mettre en tête un chiffre de cohorte**.

- **Parcours RDV des prospects (24/11/2026, plan « Offres ouvertes et no-show »)** : entre la réservation d'un
  Audit (self-booking OU posé par un setter) et le RDV, UN parcours, un message par moment. Moteur
  `api/_parcoursRdv.js`, cron `api/parcours-rdv.js` (*/5) : ① e-mail de confirmation soigné (rien à préparer)
  ② SMS court ③ e-mail de valeur si le RDV est à > 36 h ④ WhatsApp `rappel_rdv_closing` la veille 18 h–21 h
  (variables prénom, prénom du CLOSER, heure ; « OUI » → `presenceConfirmed` + `rdv_confirmations` automatiques,
  « déplacer » / réponse ambiguë → alerte setter, `whatsapp-webhook.js` → `surReponseWhatsapp`) ⑤ SMS + lien
  COURT (`https://team.alteore.com/m/{code}`, 6 caractères, demande d'Adrien du 27/11/2026 : `lienCourt` de `_parcoursRdv.js`, code gardé dans `meet_codes/{code}` et `bookings.parcoursRdv.lienCourt`, ouvert par `api/meet-link.js` ; les e-mails gardent le lien suivi long)
  1 h avant ⑥ rattrapage +5 à +15 min si l'API Meet dit le prospect ABSENT (illisible → rien), SMS + alerte closer
  (cloche `inbox_notifications`). Consultations concernées : `booking_config/_types[].notifications.parcoursRdv`
  — le même drapeau efface les rappels de l'agenda dans les Cloud Functions (`_abParcoursRdvPrend` : confirmation
  e-mail/SMS, J-1, H-1), SEULEMENT pour les RDV que le parcours prend vraiment. Réglages `_config/parcours_rdv`
  (`actif` faux par défaut, `modeTest` vrai par défaut = seuls les RDV au téléphone / e-mail de test de
  `_config/relances.testTelephone/testEmail` ou `testMembres`, `depuis` = 1re activation, jamais de rattrapage du
  passé ; réel = « PRODUCTION » tapé). Traces : `bookings/{id}.parcoursRdv.etapes.*` (réservation transactionnelle,
  jamais rejoué), fiche lead `communications` (`source: 'parcours_rdv'`). ActiveCampaign EN DIRECT
  (`api/_activeCampaign.js`, variables Vercel `ACTIVECAMPAIGN_API_URL` / `ACTIVECAMPAIGN_API_KEY`, tags désignés par
  leur NOM ; plus de Make, demande d'Adrien du 24/11/2026 — le scénario Make « Parcours RDV (Team) → ActiveCampaign »
  10226515 est éteint, pas supprimé) : `rdv_pris` → tag `rdv_a_venir` + sortie des nurturing 35 / 26 / 32 ;
  `rdv_libere` (no-show, annulé sans report) → `rdv_a_venir` retiré + `rdv_manque` (séquence « rendez-vous manqué ») — SAUF si le même prospect (e-mail / téléphone) a déjà un autre RDV non annulé à venir (`autreRdvAVenir`, il a déplacé lui-même) ; `rdv_pris` retire aussi `rdv_manque` et sort des séquences d'après-RDV 43-49 (`activeCampaign.apresRdv`) ;
  `nurturing_stop` (offre / close / disqualifié) → `stop_autom` ; `frein` → tag `frein_*` + `stop_autom`. **Durcissement du 24/11/2026 (relecture complète avant le passage en réel)** : le passage lit TOUS les RDV à venir + 14 jours en
  arrière (confirmation immédiate même à J+10, issue saisie tard prise en compte), un `try/catch` par RDV et un budget de 45 s ;
  l'e-mail de confirmation part à toute heure et quel que soit le délai (le SMS : en journée, à plus de 75 min), après le lien de visio
  (attendu 3 min au plus) ; WhatsApp de la veille non remis (échec immédiat, statut `failed` dans `whatsapp_messages`, modèle
  inutilisable) → SMS `sms_veille` ; une réponse n'est lue qu'ENTRE le rappel et l'heure du RDV, et ne confirme que si elle est courte
  et sans le moindre doute (négation, « mais », question → alerte setter) ; rattrapage : SMS seulement si l'équipe est dans la visio et
  pas le prospect, visio non ouverte → alerte closer seule ; étapes `ac_*` rejouées en cas d'échec (`reserver` `rejouable`, 6 essais) ;
  aucune séquence d'après-RDV si un autre RDV du parcours est à venir, 45 min de grâce après une annulation, annulation par l'équipe
  (`cancellation.origin: 'equipe'`) → `rdv_equipe` (tag retiré, pas de « rendez-vous manqué ») ; `depuis` est REPOSÉ à chaque
  réactivation et au passage en réel (un RDV pris avant garde les rappels de l'agenda : jamais de doublon). Exception (25/11/2026, constat d'Adrien le lendemain de la bascule : aucun WhatsApp la veille) : un RDV pris AVANT reçoit quand même du parcours ce que l'agenda ne fait pas — le WhatsApp de la veille et le rattrapage d'un prospect absent (SMS + alerte closer) — et RIEN d'autre (`ancien` dans `traiterRdv`, coupé par `veilleAnciens: false`) — pas de confirmation, pas de SMS, pas d'étiquette ActiveCampaign, donc pas de séquence d'après-RDV. Après un `non_close` : `api/parcours-frein.js` (cron du matin) lit l'appel (`replay`, sinon note
  du closer après J+3, sinon « général »), écrit `parcoursRdv.frein` et `leads.freinPrincipal` (jamais écrasé si
  `corrigePar`), puis séquence ActiveCampaign du frein (automatisations 36-41, textes
  `docs/parcours-rdv/sequences-freins.md`). **Séquences d'après-RDV envoyées par TEAM (24/11/2026, décision d'Adrien)** : `api/_parcoursSuite.js`, cron `api/parcours-suite.js`
  (*/15), page publique des liens `api/parcours-clic.js`. Les automatisations ActiveCampaign 43-49 restent ÉTEINTES (les 36-42, vides,
  sont à supprimer à la main) ; ActiveCampaign ne garde que le nurturing d'avant RDV, la newsletter et des étiquettes d'information
  (`frein_*`, `douleur_*`, `rdv_a_venir`, `rdv_manque`, `stop_autom`). Une suite = `parcours_suites/{bookingId}` (Admin SDK seul), créée
  par `parcours-frein.js` (non_close → 5 e-mails J+1/4/8/14/21) ou par le passage du parcours (`rdv_libere` → 3 e-mails J+1/3/7), envoyés
  depuis strategie@, 9 h 30 – 19 h hors dimanche, jamais deux à moins de 40 h, plafond `suites.plafondJour`. **Douleur** = réponse du
  prospect à « Qu'est-ce qui vous pèse le plus ? » du questionnaire (`profilDe`, règles fixes, jamais d'IA) : avec une histoire, 6 e-mails (J+1/4/8/12/16/21) :
  e-mail 1 du frein, e-mails 2 à 5 = un RÉCIT en quatre épisodes, e-mail 6 du frein. Forme voulue par Adrien (24/11/2026, après deux
  versions refusées : un sommaire de chapitres, puis des questions posées au lecteur « qui ressemblaient au questionnaire ») : on suit un
  PERSONNAGE (« Marc est chef d'entreprise, comme vous » — jamais de métier précis ; `Héros :` Marc, Sophie, Julien, Claire, Antoine),
  inventé et dit comme tel une fois, sans aucun résultat chiffré. Épisode 1 (`C1`) : la scène de départ ; épisodes 2 (`C2A/B/C`) et 3
  (`C3A/B/C`) : ce qui lui arrive avec la décision choisie et pourquoi cela ne suffit pas, puis le déclic (« Je vais réfléchir ») ;
  dénouement (`C4`, début `{{fin}}` selon la dernière décision : `C4A/B/C`, `C4N` sans clic) : un an plus tard, puis « Marc n'existe pas.
  Franck, si. » (vrai client, ses mots, ses chiffres, sa vidéo), puis « Et votre histoire ? » et le bouton pour reprendre un audit. Les
  trois boutons de chaque épisode sont TOUJOURS des décisions du personnage (`*Bouton :*`, sous `*Question :*` « À la place de Marc, que
  feriez-vous ? »), jamais une question sur le lecteur ; la décision cliquée choisit l'épisode suivant (`choixSuivant`, graphe `suite` /
  `defaut` de `_parcoursChoixData.json`), sans clic la première (`{{ouverture}}` = « À la place de Marc, vous avez choisi… » ou « Marc a
  choisi… »). Textes : `docs/parcours-rdv/sequences-choix.md` → `api/_parcoursChoixData.json` par `python3 scripts/build-parcours-choix.py`,
  images `media/parcours/` (bandeaux `recit-*.jpg`). Chaque étape garde `chapitre`, `choisi`, `options` (les décisions affichées). Phrases miroir (`MIROIRS`) = réponses À CHOIX reprises mot pour mot, la ligne disparaît si la réponse
  manque. Sans douleur connue (dont l'ancien formulaire « principal défi ») : la séquence du frein telle quelle (`_acSequencesData.json`,
  reconstruit par `python3 scripts/build-sequences-freins.py`). Avec douleur, les e-mails 1 et 5 du frein sont ceux de la section
  « 0. Freins avec histoire » (ils citent sa réponse et n'annoncent pas les e-mails du frein). **Garde-fous (relecture du 24/11/2026)** :
  une seule suite active par prospect, et seulement pour son DERNIER RDV (`rdvPlusRecent`) ; issue corrigée (manqué ↔ « non ») → la
  bonne séquence remplace l'autre ; aucune suite créée moteur éteint, premier e-mail abandonné après 5 jours de retard (`trop_tard`) ;
  e-mail en échec rejoué 3 fois, réservation restée sans suite jamais rejouée (signalée dans le module admin) ; ActiveCampaign rejoué
  tant que ce n'est pas fait (`acEnAttente`) ; à la fin, `stop_autom` est retirée avant l'entrée newsletter. Un clic n'est compté que par le POST du
  navigateur (jamais à la lecture du lien) ; deux réponses différentes cliquées en 2 min = robot, ignoré ; un clic ne vaut que depuis le dernier e-mail parti ; la désinscription demande un vrai clic →
  `leads.emailDesinscrit`, `stop_autom` et désinscription de toutes les listes ActiveCampaign. Avant CHAQUE e-mail la suite s'arrête si
  le prospect a repris un RDV, est devenu client, s'est désinscrit ou si l'issue du RDV a changé. Fin (3 jours après le dernier
  e-mail) → entrée dans l'automatisation « Newsletter 2k26 » (`suites.newsletterAutomation` = 29), sauf désinscription. **Le closer
  n'est pas sonné** : clics et arrêts = une ligne d'historique + `leads.suiteApresRdv` (résumé) ; « non / plus tard » = arrêt silencieux et « stop / désinscription » = désinscription complète, MAIS seulement si la réponse est
  courte et faite à un e-mail de la séquence (même objet) ; toute autre réponse sonne comme avant, avec un résumé d'une ligne (tâche
  IA `parcours_reponse`, qui ne fait jamais taire une cloche) ; les clics de la veille = une puce du brief du matin (`prospectsChaudsApresRdv`). Réglages
  `_config/parcours_rdv.suites` (`actif` faux par défaut ; mode test = celui du parcours). **Module admin « Séquences »** (Marketing → 📬, admin
  seul) : `admin-sequences.html` + `api/parcours-suite-admin.js` — vue d'ensemble (allumer / éteindre, plafond, chiffres), prospects
  (étape, prochain e-mail, clics ; pause / reprendre / arrêter / « envoyer le suivant » = `forcer`), arbre des e-mails (aperçu, test à
  l'admin connecté, désactiver une séquence / une histoire / un e-mail : `suites.off` — séquence désactivée = plus de création ni
  d'envoi, histoire désactivée = séquence simple du frein, e-mail désactivé = étape sautée). Éditeur de textes et de branches : 2e
  livraison, pas encore faite (les textes se modifient dans les deux fichiers `.md` puis par les scripts de construction). Clé temporaire du chantier `PARCOURS_AUDIT_KEY` (preview de la branche,
  `api/parcours-audit.js` lecture seule) : à retirer à la fin.

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
