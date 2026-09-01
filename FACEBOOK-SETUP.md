# Onglet 📘 Facebook — mise en service, étape par étape

Suite directe de `INSTAGRAM-SETUP.md`. **Deux bonnes nouvelles avant de
commencer :**

- l'application Meta est **déjà en mode Live** — c'est ce qui avait coûté le
  plus cher côté Instagram, et c'est déjà payé ;
- un **jeton de Page n'expire jamais** (contrairement aux 60 jours
  d'Instagram) : aucune panne annoncée à deux mois.

**⚠️ Ce fichier n'est jamais déployé** (`*.md` est dans `.vercelignore`).
**Ne colle jamais un jeton ni un secret dans une conversation.**

---

## ÉTAPE 1 — Récupérer l'identifiant de la Page (2 min)

Sur la Page Facebook → **Paramètres** → **À propos** → tout en bas,
**Identifiant de la Page**. C'est un long nombre.

Ou depuis l'Explorateur d'API Graph : `GET /me/accounts` liste tes Pages avec
leur `id`.

---

## ÉTAPE 2 — Générer un jeton de Page permanent (10 min)

C'est l'étape la plus technique. Elle se fait dans
**developers.facebook.com/tools/explorer**.

**2.1 — Jeton utilisateur avec les bonnes permissions**

- En haut à droite, **Application** : `Alteore Instagram Insights`
- **Utilisateur ou Page** : *Jeton d'accès utilisateur*
- Clique **Ajouter des autorisations** et coche :

| Permission | Sert à |
|---|---|
| `pages_show_list` | lister tes Pages |
| `pages_read_engagement` | publications, réactions, partages |
| `pages_read_user_content` | **les commentaires** — sans elle, zéro GO |
| `read_insights` | portée, impressions, engagements |
| `pages_messaging` | Messenger |

- **Générer un jeton d'accès** → accepte la fenêtre Facebook

**2.2 — Le rendre longue durée**

Colle ceci dans la barre de requête de l'Explorateur (remplace les trois
valeurs), puis **Envoyer** :

```
/oauth/access_token?grant_type=fb_exchange_token&client_id=APP_ID&client_secret=APP_SECRET&fb_exchange_token=LE_JETON_DE_2.1
```

Récupère le `access_token` renvoyé : c'est ton jeton utilisateur longue durée.

**2.3 — En dériver le jeton de Page**

Toujours dans l'Explorateur, colle le jeton de 2.2 dans le champ du haut, puis
appelle :

```
/me/accounts
```

Dans la réponse, trouve ta Page et copie son `access_token`. **Celui-là
n'expire jamais.**

**2.4 — Le vérifier**

Sur **developers.facebook.com/tools/debug/accesstoken/**, colle le jeton de
2.3. Tu dois lire :

- **Expires : Never**
- **Type : Page**
- la liste des permissions, avec `pages_read_user_content` dedans

Si « Expires » affiche une date, c'est que tu as pris le jeton de 2.1 ou 2.2 :
reprends en 2.3.

---

## ÉTAPE 3 — Document Firestore (5 min)

Console Firebase → **Firestore** → collection **`_config`** → **Ajouter un
document** → ID exactement **`facebook_credentials`** :

| Champ | Type | Valeur |
|---|---|---|
| `pageId` | string | l'identifiant de l'étape 1 |
| `token` | string | le jeton de Page de l'étape 2.3 |
| `appId` | string | le même que pour Instagram |
| `appSecret` | string | le même que pour Instagram |
| `verifyToken` | string | `openssl rand -hex 24` (une NOUVELLE chaîne) |
| `apiVersion` | string | `v23.0` |
| `keywords` | array | un élément, string : `go` |
| `syncActif` | boolean | `true` |
| `pageNom` | string | le nom de la Page |

---

## ÉTAPE 4 — Règles Firestore

Six nouvelles collections (`fb_page_daily`, `fb_posts`, `fb_post_daily`,
`fb_comments`, `fb_dm_threads`, `fb_dm_events`). Mets le fichier à jour dans
ton presse-papier :

```bash
cat firestore.rules | pbcopy
```

Console → **Firestore** → **Règles** → `Cmd+A`, `Cmd+V`, **Publier**.

Sans ça, l'onglet s'ouvre sur une erreur rouge « permissions ».

---

## ÉTAPE 5 — Première synchronisation

https://vercel.com/adrien83440s-projects/team-ambitio/settings/cron-jobs →
ligne **`/api/facebook-sync-cron`** → **Run**.

Valeurs par défaut : 30 jours de statistiques de Page, **90 jours de
publications**, **90 jours de conversations Messenger**.

Puis ouvre `sales-funnel.html` → onglet **📘 Facebook** et clique
**🩺 Diagnostic**. Les lignes à lire :

```json
"peutLireCommentaires": true      ← pages_read_user_content bien accordée
"verdict": "commentaires accessibles"
"rattrapagePossible": true        ← Messenger rend bien l'historique
```

---

## ÉTAPE 6 — Webhook (temps réel, optionnel)

Contrairement à Instagram, **Facebook n'en a pas besoin pour que les chiffres
existent** : le cron reconstruit tout depuis l'API, historique compris. Le
webhook sert seulement à ne pas attendre le lendemain matin.

Meta → l'application → **Webhooks** → objet **Page** :

- **URL de rappel** : `https://team.alteore.com/api/facebook-webhook`
- **Jeton de vérification** : le `verifyToken` de l'étape 3
- Champs à cocher : **`feed`** (commentaires) et **`messages`** (Messenger)

Puis abonner la Page :
```
POST /{page-id}/subscribed_apps?subscribed_fields=feed,messages
```

En cas de doute entre les deux sources, **c'est le cron qui fait autorité** :
il recalcule depuis Meta et corrige l'écart laissé par un webhook manqué.

---

## Ce qui diffère d'Instagram

| | Instagram | Facebook |
|---|---|---|
| Jeton | 60 jours, à rafraîchir | **permanent** |
| Historique des messages | ❌ rien avant le branchement | ✅ **rattrapable** |
| Réponses aux commentaires | sous-champ à déplier | à plat (`filter=stream`) |
| Identité des commentateurs | pseudo, souvent absent | nom, **si la personne utilise l'app** |

Ce dernier point est une restriction Meta de 2018 : un commentaire anonyme
reste parfaitement comptable dans les GO, il ne peut simplement pas être
rattaché à une fiche lead. L'onglet indique combien de commentaires sont dans
ce cas plutôt que de laisser croire à un défaut de rattachement.
