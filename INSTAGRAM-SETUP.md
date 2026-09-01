# Onglet 📸 Instagram — mise en service, étape par étape

Tout ce qui suit se fait **une seule fois**. Compte environ 45 minutes.
Aucune étape ne touche la production existante.

**⚠️ Ce fichier n'est jamais déployé** (`*.md` est dans `.vercelignore`).

**Règle de sécurité : ne colle jamais le jeton, l'App Secret ou le Verify
token dans une conversation, un ticket ou un commit.** Ils vont directement du
tableau de bord Meta à la Console Firebase.

---

## ÉTAPE 1 — Vérifier le compte Instagram (2 min)

Sur le téléphone, dans l'app Instagram avec le compte **@adrienemily** :

1. Profil → menu ☰ → **Paramètres et confidentialité**
2. Chercher **Type de compte** (ou « Compte professionnel »)
3. Le compte doit être en **Professionnel** — *Entreprise* ou *Créateur*, peu importe.

**Pourquoi c'est bloquant :** un compte personnel n'expose **aucune** métrique,
quelle que soit la suite. Aucune API, payante ou non, ne contourne ça.

✅ *C'est bon si* tu vois « Outils professionnels » / « Statistiques » dans ton profil.

---

## ÉTAPE 2 — Créer l'application Meta (5 min)

Sur un ordinateur, connecté au compte Facebook d'Adrien :

1. Aller sur **developers.facebook.com/apps**
2. Bouton **Créer une application**
3. **Nom de l'application** : `Alteore Instagram Insights`
   **Email de contact** : celui d'Adrien
4. Écran « Cas d'utilisation » : choisir **Autre** (*Other*)
5. Écran « Type » : choisir **Entreprise** (*Business*)
6. **Créer l'application** (Facebook redemande le mot de passe)

**Pourquoi une application séparée de WhatsApp :** un incident, une revue Meta
en attente ou un secret révoqué côté Instagram ne doit jamais pouvoir emporter
les rappels de RDV WhatsApp. Aucun secret n'est partagé entre les deux.

✅ *C'est bon si* tu arrives sur le tableau de bord de l'application.

---

## ÉTAPE 3 — Ajouter le produit Instagram (2 min)

1. Dans le menu de gauche : **Ajouter des produits** (ou la liste des produits
   en page d'accueil du tableau de bord)
2. Trouver **Instagram** → **Configurer**
3. Le menu de gauche affiche maintenant **Instagram** → clique dessus
4. Choisir le panneau **« API setup with Instagram business login »**
   *(et NON « API setup with Facebook login » — celui-là exige une Page
   Facebook et le Business Manager, trois écrans de plus pour rien)*

Ce panneau contient trois sections numérotées. On va les faire dans l'ordre.

---

## ÉTAPE 4 — Générer le jeton d'accès (5 min)

Section **1. Generate access tokens** :

1. Bouton **Add account** (ou *Ajouter un compte*)
2. Une fenêtre Instagram s'ouvre → se connecter avec **@adrienemily**
3. Écran d'autorisation : **tout accepter**. Les permissions demandées sont
   `instagram_business_basic`, `instagram_business_manage_comments`,
   `instagram_business_manage_messages`, `instagram_business_manage_insights`.
4. De retour sur le tableau de bord, le compte apparaît dans la liste
5. Bouton **Generate token** en face du compte
6. **Copie le jeton immédiatement dans un endroit sûr** — il n'est affiché
   qu'une fois. Il commence par `IGAA…` et fait plusieurs centaines de caractères.
7. Note aussi l'**Instagram user ID** affiché à côté du compte (un nombre long).

✅ *C'est bon si* tu as un jeton `IGAA…` et un identifiant numérique.

⚠️ *Si le bouton « Add account » ne fait rien :* désactive le bloqueur de
publicités, ou refais-le dans une fenêtre de navigation privée.

---

## ÉTAPE 5 — Récupérer l'App Secret (2 min)

Toujours dans le même panneau Instagram, tout en haut :

- **Instagram app ID** — un nombre
- **Instagram app secret** — bouton **Show** / *Afficher*

Copie l'**app secret**. Il sert à vérifier que les webhooks viennent bien de
Meta et pas d'un inconnu qui a deviné l'URL.

---

## ÉTAPE 6 — Fabriquer le Verify token (1 min)

C'est une chaîne **que tu inventes**, que Meta te rejouera pour prouver qu'il
parle bien à ton serveur. Dans un terminal :

```bash
openssl rand -hex 24
```

Copie le résultat. Il servira **deux fois** : à l'étape 7 (Firestore) et à
l'étape 9 (Meta). Les deux doivent être **identiques au caractère près**.

---

## ÉTAPE 7 — Créer le document Firestore (5 min)

Console Firebase → projet **ambitio-team** → **Firestore Database** :

1. Trouver la collection **`_config`** (elle existe déjà)
2. **Ajouter un document**
3. **ID du document** : `instagram_credentials` — exactement ça, sans majuscule
4. Ajouter les champs suivants, en respectant le **type** :

| Champ | Type | Valeur |
|---|---|---|
| `authMode` | string | `instagram` |
| `token` | string | le jeton `IGAA…` de l'étape 4 |
| `tokenExpiresAt` | string | date du jour **+ 60 jours**, ex. `2026-10-31T00:00:00.000Z` |
| `igUserId` | string | l'Instagram user ID de l'étape 4 |
| `appSecret` | string | l'app secret de l'étape 5 |
| `verifyToken` | string | la chaîne de l'étape 6 |
| `apiVersion` | string | `v23.0` |
| `keywords` | array | un élément, string : `go` |
| `syncActif` | boolean | `true` |
| `compteNom` | string | `adrienemily` |

**`tokenExpiresAt` n'est pas décoratif** : c'est lui qui déclenche le
rafraîchissement automatique du jeton. Mal renseigné, le jeton meurt à
60 jours et l'onglet se fige en silence. En mode `instagram`, le
rafraîchissement se fait tout seul, sans secret — mais seulement si cette date
est là.

---

## ÉTAPE 8 — Déployer le code (5 min)

Dans cet ordre, jamais l'inverse :

```bash
# 1. Les règles Firestore d'abord — sans elles, la page ne peut rien lire
firebase use                                                   # doit afficher ambitio-team
firebase deploy --only firestore:rules --project ambitio-team

# 2. Le reste part sur Vercel au push
git add -A && git commit -m "Funnel : onglet Instagram (insights, GO, DM)"
git push
```

Attends que Vercel affiche **Ready** avant l'étape 9 : l'URL du webhook doit
répondre, sinon Meta refusera de l'enregistrer.

---

## ÉTAPE 9 — Brancher le webhook (5 min)

Retour dans Meta → **Instagram** → **API setup with Instagram business login**,
section **2. Configure webhooks** :

1. **Callback URL** : `https://team.alteore.com/api/instagram-webhook`
2. **Verify token** : la chaîne de l'étape 6, **identique** à celle de Firestore
3. Bouton **Verify and save**
4. Une fois validé, cocher les champs :
   - ☑ **comments**
   - ☑ **messages**

✅ *C'est bon si* Meta affiche l'URL en vert / « Complete ».

⚠️ *Si Meta répond « The URL couldn't be validated » :* dans 9 cas sur 10, le
`verifyToken` de Firestore et celui de Meta ne sont pas identiques, ou le
document `_config/instagram_credentials` n'est pas encore créé.

---

## ÉTAPE 10 — Autoriser les outils connectés (2 min)

Sur le téléphone, app Instagram, compte **@adrienemily** :

**Paramètres → Confidentialité des messages → Outils connectés** →
autoriser l'accès.

**C'est l'étape qui décide de tout pour le taux de réponse.** Sans elle, Meta
n'envoie pas les *échos* — c'est-à-dire les DM **envoyés à la main depuis
l'application**. On ne verrait alors que les messages entrants, et le taux de
réponse serait faux par construction. L'onglet affiche une alerte rouge
explicite si ce cas se produit.

---

## ÉTAPE 11 — Lancer le rattrapage (5 min)

Récupère `CRON_SECRET` dans **Vercel → le projet → Settings → Environment
Variables** (il existe déjà, il sert aux autres crons), puis :

```bash
curl -H "x-api-key: COLLE_ICI_LE_CRON_SECRET" \
  "https://team.alteore.com/api/instagram-sync-cron?days=30&mediaDays=60"
```

La réponse est un rapport JSON. Ce qu'il faut y lire :

- `"medias": 23` → 23 publications récupérées
- `"goTotal": 148` → 148 « GO » comptés
- `"joursCompte": 30` → 30 jours de statistiques de compte
- `"tronque": true` → l'exécution a manqué de temps : relance avec
  `mediaDays=20`, puis `mediaDays=60`. C'est rejouable sans risque de doublon.
- `"erreur": "..."` → envoie-moi le message, il dit précisément quoi corriger.

**Pourquoi `days=30` et pas 60 :** les statistiques **jour du compte**
(abonnés, portée, visites de profil) ne remontent pas au-delà d'environ 30
jours chez Meta. Au-delà, c'est perdu définitivement. Les **publications**, en
revanche, se rattrapent sans limite — d'où `mediaDays=60` pour tes deux mois.

Ensuite, le cron tourne seul chaque nuit à **04:40 UTC**.

---

## ÉTAPE 12 — Ouvrir l'onglet

`team.alteore.com/sales-funnel.html` → onglet **📸 Instagram**.

Choisis la période **Mois** ou **30 j** : l'onglet ne charge ses données qu'à
son ouverture, et se recharge à chaque changement de période.

---

## Ce que tu verras, et quand

| Bloc | Disponible |
|---|---|
| Publications, portée, vues, likes, saves, partages | **immédiatement** après l'étape 11 |
| Compteur **GO** par publication, avec le détail des pseudos | **immédiatement** |
| Statistiques du compte (abonnés, visites de profil, clics bio) | 30 derniers jours, puis l'historique se construit nuit après nuit |
| **Taux de réponse aux DM** | **à partir de l'étape 9 seulement** — aucun historique n'existe |

Instagram n'expose aucun historique de messagerie : les chiffres de DM
commencent le jour du branchement du webhook. C'est une limite de la
plateforme, pas de l'outil.

---

## Relier les GO et les DM aux fiches leads

Le champ **Instagram** (pseudo, sans arobase) se saisit :

- à la création d'un lead, dans `sales-leads.html` ;
- sur une fiche existante, dans `sales-contact.html`, section « Informations de base ».

Tant qu'il est vide, les GO et les DM restent des pseudos anonymes : on saura
quelle publication fait commenter, pas laquelle produit des clients. La colonne
**GO ↔ fiche** de l'onglet mesure exactement cet écart.

---

## En cas de blocage

| Symptôme | Cause quasi certaine |
|---|---|
| `_config/instagram_credentials introuvable` | document pas créé, ou ID mal orthographié |
| `Missing permissions` / code 200 | une permission a été refusée à l'étape 4 → refaire *Add account* |
| Code 190 | jeton expiré ou révoqué → regénérer à l'étape 4, remettre à jour Firestore |
| L'onglet dit « permissions » en rouge | les règles Firestore de l'étape 8 ne sont pas déployées |
| Publications à 0 sur toutes les métriques | le compte n'était pas professionnel au moment de la publication |
| Aucun message sortant dans le bloc DM | étape 10 non faite |
