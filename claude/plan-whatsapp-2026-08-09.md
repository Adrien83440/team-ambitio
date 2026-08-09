# Plan — WhatsApp : rappels clients, notification coach, groupe de suivi

*09/08/2026 — demande d'Adrien : rappels WhatsApp aux clients, notification au
coach quand il est assigné, et un groupe automatique par client (closeuse,
Marine, Emily, Adrien, coach) avec les deux premiers messages envoyés seuls.
Rien n'existe côté WhatsApp aujourd'hui. En revanche, une bonne partie de la
plomberie existe déjà — c'est le point le plus important de ce plan.*

---

## 1. La bonne nouvelle : la moitié du travail est déjà faite

Twilio est **déjà branché de bout en bout** dans ce repo :

| Ce qui existe | Fichier |
|---|---|
| Le client Twilio partagé, avec cache | `api/_twilioClient.js` |
| Les identifiants, **rangés dans Firestore** (`_config/telco_credentials`) | idem |
| La vérification de signature des webhooks entrants | `api/_twilioSignature.js` |
| L'envoi de SMS, la réception, le suivi de statut | `api/twilio-sms-send.js`, `-inbound.js`, `-status.js` |
| La dépendance npm `twilio` | `package.json` |
| Trois crons quotidiens qui tournent déjà | `vercel.json` |

Conséquence directe : **si on passe par Twilio, il n'y a ni nouvelle dépendance
npm, ni nouvelle variable d'environnement.** Les identifiants WhatsApp iraient
dans le document Firestore qui contient déjà ceux de Twilio. C'est la voie la
plus courte, et de loin.

---

## 2. Le point qui décide de tout : le groupe

Il y a deux façons d'envoyer sur WhatsApp, et elles ne se valent pas sur ce
point précis.

### Voie A — Twilio (Conversations)

Twilio propose des « groupes ». **Ce ne sont pas de vrais groupes WhatsApp.**
Chaque participant reste dans sa conversation en tête-à-tête avec le numéro de
l'entreprise, et Twilio recopie les messages des uns chez les autres. Marine ne
verrait pas « le groupe Client X » dans son WhatsApp : elle verrait un fil avec
un numéro d'entreprise où défilent des messages relayés.

Pour toi, c'est disqualifiant. Ce que tu décris — l'équipe et le client dans un
même fil, où chacun répond naturellement — n'est pas ce que ça produit.

### Voie B — l'API Meta en direct (Cloud API)

C'est la seule qui crée un **vrai groupe WhatsApp**. Avec deux limites dures :

1. **On ne peut ajouter personne d'office.** L'API crée le groupe et fournit un
   lien d'invitation ; chaque participant clique. À chaque signature, six
   personnes cliquent une fois. C'est verrouillé par Meta. Les bibliothèques
   non officielles qui contournent ça font bannir le numéro — on ne les touche pas.
2. **Huit participants maximum.** Ton groupe en compte six (closeuse, Marine,
   Emily, toi, le coach, le client). Deux places de marge.

Et une condition d'entrée : les groupes exigent un **Official Business Account**,
un statut que Meta accorde au cas par cas. Les messages en tête-à-tête, eux, ne
l'exigent pas.

### ⚠️ Un numéro ne peut pas faire les deux

Un numéro WhatsApp appartient soit à Twilio, soit à ton compte Meta. Basculer
plus tard, c'est refaire l'enregistrement et perdre l'historique. **C'est donc
une décision à prendre maintenant, pas en cours de route.**

**Ma recommandation : la voie B, Meta en direct.** Le groupe est le cœur de ta
demande, et c'est le seul chemin qui y mène. La voie A ferait gagner une semaine
sur les rappels, puis nous bloquerait sur l'essentiel.

---

## 3. Ce que TU fais chez Meta — dans cet ordre

Rien de tout ça ne se code, et c'est ce qui prend le plus de temps. **C'est le
chemin critique.**

| # | Étape | Bloque quoi | Délai |
|---|---|---|---|
| 1 | Compte **Meta Business** au nom de la société | tout | immédiat |
| 2 | **Application Meta**, cas d'usage « Connect with customers through WhatsApp » | tout | immédiat |
| 3 | **WhatsApp Business Account (WABA)** rattaché à l'app | tout | immédiat |
| 4 | **Numéro dédié**, qui n'est PAS déjà sur l'app WhatsApp Business | la production | immédiat |
| 5 | **Utilisateur système + token permanent** (droits `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management`) | tout le code | immédiat |
| 6 | **Vérification d'entreprise** (Kbis, justificatifs) | la production | quelques jours |
| 7 | **Official Business Account** | **le groupe uniquement** | variable, pas garanti |

⚠️ **Le numéro est définitif.** Un numéro déjà utilisé dans l'app WhatsApp
Business doit en être détaché et perd son historique. Prends un numéro neuf.

**Pendant les étapes 1 à 3**, Meta fournit un numéro de test qui envoie à
quelques destinataires déclarés. Il me suffit pour développer et à toi pour
valider — sans attendre la vérification. C'est ce qui permet d'avancer en
parallèle des démarches.

---

## 4. Ce que JE code — par vagues

Chaque vague : une branche, une préversion, ton GO. Les vagues 1 et 2 ne
dépendent **pas** de l'Official Business Account : on livre pendant que le
dossier avance.

### Vague 1 — le socle et la notification coach
- `api/_whatsappClient.js`, calqué sur `_twilioClient.js` : identifiants lus
  dans `_config/telco_credentials` (même document, nouveau bloc), cache module.
  Aucune dépendance npm, un simple appel HTTP.
- `api/whatsapp-webhook.js` : accusés de réception et réponses entrantes, avec
  vérification de signature — le pendant de `_twilioSignature.js`. Meta l'exige
  pour valider le numéro, et c'est lui qui dira si un message est bien passé.
- **Notification au coach à l'attribution** : quand tu choisis le coach dans le
  plan d'action, il reçoit « Tu es le coach référent de X ». Le point d'accroche
  existe déjà — on l'a construit hier avec le sélecteur de coach.
- Journal des envois dans Firestore. Sans lui, « le client dit qu'il n'a rien
  reçu » reste sans réponse.

### Vague 2 — les rappels de RDV
- Un quatrième cron quotidien, sur le modèle des trois existants. Il lit la
  collection `bookings` (déjà utilisée par `booking-check-coaching-quota.js`)
  et envoie **J−1** puis **H−2**.
- Anti-doublon par identifiant de RDV : un rappel envoyé deux fois, c'est un
  client qui se désabonne.
- RDV annulé ou déplacé → rappel annulé. C'est le piège classique de ce genre
  de cron, et il n'échoue jamais bruyamment.

### Vague 3 — le groupe *(dépend de l'Official Business Account)*
- À la signature : création du groupe, nom normalisé, lien d'invitation envoyé
  à chacun en tête-à-tête.
- Écran de suivi dans la fiche client : qui a rejoint, qui manque, relance en
  un clic. **Sans cet écran, tu ne sauras jamais pourquoi un groupe est vide.**
- Les deux premiers messages partent **quand le client a rejoint**, pas à la
  création — sinon ils s'affichent dans le vide.

### Vague 4 — les rappels de coaching dans le groupe
Une fois le groupe vivant, on y bascule les rappels de coaching.

---

## 5. Les modèles de messages à faire approuver

Tout message envoyé hors de la fenêtre de 24 h passe par un modèle validé par
Meta. Compte quelques jours par modèle : **c'est le second chemin critique**,
à lancer tôt.

| Modèle | Pour qui | Vague |
|---|---|---|
| `coach_assigne` | coach | 1 |
| `rappel_rdv_j1` | client | 2 |
| `rappel_rdv_h2` | client | 2 |
| `invitation_groupe` | équipe + client | 3 |
| `bienvenue_groupe_1` et `_2` | groupe | 3 |
| `rappel_coaching_groupe` | groupe | 4 |

Meta demande des modèles **dédiés aux groupes**, distincts de ceux du
tête-à-tête : on ne réutilise pas les mêmes.

---

## 6. Ce que ça coûte, et ce qui change bientôt

Facturation **au message**, selon le pays du destinataire et la catégorie. Tes
rappels sont des messages « utilitaires ».

⚠️ **Au 1ᵉʳ octobre 2026, Meta remet à payant les messages utilitaires envoyés
dans la fenêtre de 24 h**, aujourd'hui gratuits. Un volume de rappels qui
paraît gratuit maintenant deviendra une ligne de coût — à chiffrer avant de
généraliser, pas après.

---

## 7. Ce que j'attends de toi pour démarrer

1. **Valide la voie B** (Meta en direct) — ou dis-moi si tu préfères la voie A
   en renonçant au vrai groupe.
2. **Lance les étapes 1 à 5 du §3** et le dossier Official Business Account.
   Ce sont les délais qui commandent, pas le code.
3. **Confirme que le clic d'invitation est acceptable.** Si non, le repli
   raisonnable : les rappels partent en tête-à-tête à chaque membre — moins
   convivial, mais réellement automatique et sans Official Business Account.
4. **Confirme le rangement des identifiants** dans `_config/telco_credentials`,
   comme pour Twilio. Si tu préfères des variables d'environnement Vercel, il
   m'en faut quatre et il me faut ton accord explicite.

Dès que le numéro de test répond, je livre la vague 1.

---

## 8. Deux points à ne pas perdre de vue

**Le client est DANS le groupe.** Tout ce que l'équipe y écrit, il le lit. Ce
groupe ne peut pas servir à la coordination interne — il en faut un autre.

**RGPD.** Le numéro de chaque participant devient visible des autres membres :
c'est une donnée personnelle partagée avec des tiers. À mentionner dans les
conditions, et il faut pouvoir sortir quelqu'un d'un groupe sur demande.
