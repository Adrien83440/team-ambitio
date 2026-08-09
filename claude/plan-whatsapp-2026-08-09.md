# Plan — WhatsApp : rappels clients, notification coach, groupe de suivi

*09/08/2026 — demande d'Adrien : rappels WhatsApp aux clients, notification au
coach quand il est assigné, et un groupe automatique par client (closeuse,
Marine, Emily, Adrien, coach) avec les deux premiers messages envoyés seuls.*

> **DÉCISION D'ADRIEN, 09/08/2026 — actée.**
> WhatsApp passe par **l'API Meta en direct**, comme un **canal entièrement
> séparé**. **Twilio n'est pas touché** : il continue à faire exactement ce
> qu'il fait aujourd'hui (SMS, voix, Ringover). Aucun fichier `twilio-*` ni
> `_twilio*` n'est modifié par ce chantier.

---

## 1. Ce à quoi on ne touche pas

Twilio est déjà branché de bout en bout dans ce repo — `_twilioClient.js`,
`_twilioSignature.js`, `twilio-sms-send/-inbound/-status.js`, la dépendance npm,
les identifiants dans `_config/telco_credentials`. **Tout cela reste tel quel.**

Deux canaux distincts, qui ne se croisent jamais :

| | Twilio | WhatsApp |
|---|---|---|
| Sert à | SMS, voix, Ringover | rappels, notifications, groupe |
| Client | `api/_twilioClient.js` | `api/_whatsappClient.js` *(nouveau)* |
| Identifiants | `_config/telco_credentials` | `_config/whatsapp_credentials` *(nouveau doc)* |
| Webhook | `api/twilio-*-inbound.js` | `api/whatsapp-webhook.js` *(nouveau)* |
| Dépendance npm | `twilio` | **aucune** — appels HTTP directs |

Ce qu'on reprend de Twilio, c'est **la méthode, pas le canal** : identifiants en
base plutôt qu'en variables d'environnement, cache au niveau module, signature
vérifiée sur tout ce qui entre. Un document Firestore séparé, pour que la
séparation soit réelle et pas seulement de façade.

**Conséquence : aucune nouvelle dépendance npm, aucune nouvelle variable
d'environnement.** Rien à valider de ce côté-là.

---

## 2. Les trois contraintes que Meta impose sur le groupe

Ce sont elles qui dessinent le calendrier — autant les avoir en tête avant de
commencer.

1. **On ne peut ajouter personne d'office.** L'API crée le groupe et fournit un
   lien d'invitation ; chaque participant clique. À chaque signature, six
   personnes cliquent une fois. C'est verrouillé par Meta. Les bibliothèques non
   officielles qui contournent ça font bannir le numéro — on n'y touche pas.
2. **Huit participants maximum.** Ton groupe en compte six (closeuse, Marine,
   Emily, toi, le coach, le client). Deux places de marge.
3. **Le groupe exige un Official Business Account**, un statut que Meta accorde
   au cas par cas. **Les messages en tête-à-tête, eux, ne l'exigent pas** — d'où
   le découpage en vagues ci-dessous : on livre les rappels pendant que le
   dossier avance, au lieu d'attendre.

---

## 3. Ce que TU fais chez Meta — dans cet ordre

Rien de tout ça ne se code, et c'est ce qui prend le plus de temps. **C'est le
chemin critique du projet.**

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
Business doit en être détaché et perd son historique. Prends un numéro neuf —
et surtout pas un numéro Twilio existant, les deux canaux doivent rester
indépendants.

**Pendant les étapes 1 à 3**, Meta fournit un numéro de test qui envoie à
quelques destinataires déclarés. Il me suffit pour développer et à toi pour
valider, sans attendre la vérification. C'est ce qui permet d'avancer en
parallèle des démarches.

**Ce dont j'ai besoin à l'arrivée**, à déposer dans `_config/whatsapp_credentials` :
le token permanent, l'identifiant du numéro (*phone number ID*), l'identifiant
du WABA, et un jeton de vérification de webhook que tu inventes toi-même.

---

## 4. Ce que JE code — par vagues

Chaque vague : une branche, une préversion, ton GO. Les vagues 1 et 2 ne
dépendent **pas** de l'Official Business Account.

### Vague 1 — le socle et la notification coach
- `api/_whatsappClient.js` : identifiants lus dans `_config/whatsapp_credentials`,
  cache au niveau module, appels HTTP directs.
- `api/whatsapp-webhook.js` : accusés de réception et réponses entrantes, avec
  vérification de signature. Meta l'exige pour valider le numéro, et c'est lui
  qui dira si un message est réellement passé.
- **Notification au coach à l'attribution** : quand tu choisis le coach dans le
  plan d'action, il reçoit « Tu es le coach référent de X ». Le point d'accroche
  existe déjà — on l'a construit hier avec le sélecteur de coach.
- Journal des envois dans Firestore. Sans lui, « le client dit qu'il n'a rien
  reçu » reste sans réponse.

### Vague 2 — les rappels de RDV
- Un quatrième cron quotidien, sur le modèle des trois existants dans
  `vercel.json`. Il lit la collection `bookings` (déjà utilisée par
  `booking-check-coaching-quota.js`) et envoie **J−1** puis **H−2**.
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

C'est un budget distinct de celui de Twilio : deux canaux, deux factures.

---

## 7. Décisions — toutes prises

| Question | Décision | Date |
|---|---|---|
| Meta en direct ou intermédiaire ? | **Meta en direct** | 09/08/2026 |
| WhatsApp greffé sur Twilio ou canal séparé ? | **Canal séparé, Twilio intact** | 09/08/2026 |
| Où vont les identifiants ? | `_config/whatsapp_credentials`, document propre | 09/08/2026 |
| Les six clics d'invitation sont-ils acceptables ? | **Oui** — le repli en tête-à-tête est abandonné | 09/08/2026 |

Plus rien n'est en attente d'arbitrage. Le projet n'attend que les démarches
Meta du §3.

Je n'écris pas de code avant que le numéro de test réponde : sans identifiants
rien ne serait testable, et on ne construit pas en spéculatif. En revanche les
modèles de messages, eux, ne dépendent d'aucun identifiant et prennent des jours
à se faire approuver — ils sont rédigés en annexe, prêts à soumettre.

---

## 8. Deux points à ne pas perdre de vue

**Le client est DANS le groupe.** Tout ce que l'équipe y écrit, il le lit. Ce
groupe ne peut pas servir à la coordination interne — il en faut un autre.

**RGPD.** Le numéro de chaque participant devient visible des autres membres :
c'est une donnée personnelle partagée avec des tiers. À mentionner dans les
conditions, et il faut pouvoir sortir quelqu'un d'un groupe sur demande.

---

## 9. Annexe — les modèles, prêts à soumettre

À déposer dans le gestionnaire de modèles de Meta dès que le WABA existe
(étape 3 du §3). **Aucun identifiant n'est nécessaire pour ça** : c'est le
travail à faire en parallèle des démarches, et c'est ce qui évite d'attendre
une semaine de plus après coup.

Trois règles de Meta à respecter, sinon c'est refusé sans explication utile :
- le corps ne peut **ni commencer ni finir par une variable**, et deux variables
  ne peuvent pas se toucher ;
- chaque variable doit être **accompagnée d'un exemple** au moment de la
  soumission — un modèle sans exemples est rejeté ;
- catégorie **Utilitaire** (*Utility*) pour tout ce qui suit. Basculer en
  *Marketing* coûterait plus cher et exigerait un consentement distinct.

Langue : `fr`. **Tutoiement pour tout le monde**, clients compris — décision
d'Adrien du 09/08/2026. C'est un écart assumé à la règle « emails clients :
vouvoiement » du CLAUDE.md : elle vaut pour Alteore, le SaaS. Ici on est dans
l'accompagnement Ambitio, où le tutoiement est la norme entre coach et coaché.
Ne pas « corriger » ces textes vers le vouvoiement.

### `coach_assigne` — vers le coach *(vague 1)*
> Bonjour {{1}}, tu es désormais le coach référent de {{2}} ({{3}}). Sa fiche
> coaching est à jour dans Alteore : tu y retrouves son plan d'action, ses
> jalons et ses échéances. Bon accompagnement !

`{{1}}` prénom du coach · `{{2}}` nom du client · `{{3}}` entreprise

### `rappel_rdv_j1` — vers le client *(vague 2)*
> Salut {{1}}, petit rappel : ta séance de coaching avec {{2}} a lieu demain
> {{3}} à {{4}}. Si tu ne peux pas être là, préviens-nous au plus tôt, on la
> replacera.

`{{1}}` prénom du client · `{{2}}` prénom du coach · `{{3}}` date · `{{4}}` heure

### `rappel_rdv_h2` — vers le client *(vague 2)*
> Salut {{1}}, ta séance avec {{2}} commence dans deux heures, à {{3}}.
> À tout à l'heure !

`{{1}}` prénom du client · `{{2}}` prénom du coach · `{{3}}` heure

### `invitation_groupe` — vers l'équipe et le client *(vague 3)*
> Salut {{1}}, le groupe de suivi de {{2}} vient d'être créé. Rejoins-le pour
> recevoir les points d'étape et échanger directement avec l'équipe.

`{{1}}` prénom du destinataire · `{{2}}` nom du client

**Avec un bouton « Rejoindre le groupe »**, en URL dynamique : base fixe
`https://chat.whatsapp.com/`, suffixe variable. C'est important — un lien
d'invitation collé dans le corps du message passe beaucoup moins bien la
validation qu'un bouton dont la base est fixe.

### `bienvenue_groupe_1` — dans le groupe *(vague 3)*
> Bienvenue dans le groupe de suivi de {{1}} ! Tu y retrouves {{2}}, ton coach
> référent, ainsi que l'équipe qui t'accompagne. C'est ici qu'on partagera les
> points d'étape et les rappels de séance.

`{{1}}` nom du client · `{{2}}` prénom du coach

### `bienvenue_groupe_2` — dans le groupe *(vague 3)*
> Première étape : ta séance de cadrage avec {{1}}. Tu peux la réserver dès
> maintenant depuis ton espace Academy. Une question d'ici là ? Pose-la
> directement ici, on te répond.

`{{1}}` prénom du coach

### `rappel_coaching_groupe` — dans le groupe *(vague 4)*
> Point d'étape sur le parcours de {{1}} : le jalon « {{2}} » est prévu pour le
> {{3}}. On fait le point ensemble à la prochaine séance.

`{{1}}` nom du client · `{{2}}` intitulé du jalon · `{{3}}` date

⚠️ Meta exige des modèles **dédiés aux groupes** : `bienvenue_groupe_1/2` et
`rappel_coaching_groupe` ne peuvent pas être réutilisés en tête-à-tête, et
inversement. C'est pour ça qu'ils sont nommés séparément.
