# Topo de reprise — 09/08/2026

*Point d'étape pour reprendre le travail dans une autre session. Deux repos
sont concernés : `team-ambitio` (Alteore/coaching, HTML-JS vanilla + Vercel
serverless) et `ae-academy` (l'espace client, Next.js).*

---

## 1. Chantier en cours : WhatsApp

**Le plan complet est dans `claude/plan-whatsapp-2026-08-09.md`**, branche
`plan/whatsapp-groupe-client` (3 commits, poussée, non mergée — c'est un
document, aucun code touché).

### Ce qu'Adrien veut
Des rappels WhatsApp aux clients, une notification au coach quand il est
assigné, et **à chaque signature un groupe WhatsApp automatique** réunissant la
closeuse, Marine, Emily, Adrien, le coach et le client — avec les deux premiers
messages envoyés seuls, puis les rappels de RDV et de coaching dans ce groupe.

### Décisions prises — ne pas les rouvrir

| Décision | Pourquoi |
|---|---|
| **API Meta en direct** | seule voie vers un vrai groupe WhatsApp |
| **Canal séparé de Twilio, Twilio n'est pas touché** | demande explicite d'Adrien |
| Identifiants dans **`_config/whatsapp_credentials`** | document Firestore propre, pas celui de Twilio |
| **Tutoiement partout, clients compris** | écart assumé au CLAUDE.md, voir §9 du plan |
| Les **six clics d'invitation sont acceptés** | Meta interdit d'ajouter quelqu'un d'office |

### Pourquoi pas Twilio, alors qu'il est déjà câblé
Twilio est complet dans ce repo (`_twilioClient.js`, `_twilioSignature.js`,
`twilio-sms-*`, dépendance npm, identifiants dans `_config/telco_credentials`).
Mais ses « groupes » ne sont pas de vrais groupes WhatsApp : chacun reste en
tête-à-tête avec le numéro de l'entreprise et Twilio relaie. Et **un numéro
appartient soit à Twilio, soit à Meta** — pas aux deux.

### Ce qui bloque
**Rien n'existe côté Meta.** Adrien doit faire les étapes 1 à 5 du §3 du plan :
compte Meta Business → application → WABA → numéro dédié (neuf, jamais un
numéro Twilio) → utilisateur système + token permanent. Dès l'étape 3, un numéro
de test permet de développer et valider sans attendre la vérification
d'entreprise. L'*Official Business Account* (étape 7) ne bloque **que** le
groupe, pas les rappels.

### Ce qui a été fait pendant ce temps
Les **sept modèles de messages sont rédigés** (annexe §9 du plan), prêts à
soumettre dès que le WABA existe. Ils ne dépendent d'aucun identifiant et
prennent plusieurs jours à se faire approuver : c'est le second chemin critique.

### La suite, dans l'ordre
1. Adrien fournit `_config/whatsapp_credentials` (token, phone number ID, WABA
   ID, jeton de vérification du webhook).
2. **Vague 1** — `_whatsappClient.js`, `whatsapp-webhook.js`, notification au
   coach à l'attribution, journal des envois.
3. **Vague 2** — 4ᵉ cron quotidien, lit `bookings`, rappels J−1 et H−2.
4. **Vague 3** *(attend l'Official Business Account)* — création du groupe,
   liens d'invitation, écran de suivi des arrivées, deux premiers messages.
5. **Vague 4** — rappels de coaching dans le groupe.

⚠️ Aucun code n'est écrit avant que le numéro de test réponde. Sans
identifiants rien n'est testable, et on ne construit pas en spéculatif.

---

## 2. Ce qui reste ouvert des vagues précédentes

**Le constat de jalon est toujours du mauvais côté.** Adrien a décidé qu'il se
fasse dans la fiche coaching d'Alteore, « beaucoup plus facile pour le coach
d'avoir tout à un seul endroit ». Il vit encore dans l'Academy
(`/api/ep/jalon`). À déplacer, et l'écran coach de l'Academy doit devenir
lecture seule. **Pas commencé.**

**Quatre branches de documentation jamais mergées, dans `ae-academy`** :
`docs/vague-programme-v2`, `docs/cartes-accueil-parcours`,
`docs/alignement-academy-alteore`, `plan/elite-phenix-v2.2`. À merger ou à
abandonner — décision d'Adrien.

**Trois commits partis directement sur `main` de `team-ambitio`** (dont
`051fe8f` et `becdce2`), ce qu'interdit le CLAUDE.md. Signalé deux fois à
Adrien, sans réponse. Proposition toujours ouverte : les rejouer proprement via
une branche, ou acter qu'on les laisse tels quels.

---

## 3. Repères utiles pour une session fraîche

- **`main` = production** dans les deux repos. Jamais de commit direct dessus :
  une branche, une préversion Vercel, le « GO merge » explicite d'Adrien.
- Adrien est fondateur solo, **pas développeur** : il valide en testant sur la
  préversion, pas en relisant les diffs. Expliquer en français simple,
  tutoiement.
- **Les préversions parlent à la vraie base et au vrai Stripe.**
- `team-ambitio` : HTML/CSS/JS vanilla, aucun build. `/api/*.js` autonomes, pas
  d'import relatif entre eux, helpers dupliqués volontairement.
- Le pont Academy ↔ Alteore existe déjà : `api/academy-plan.js` et
  `api/academy-etat.js` côté Alteore, `bridge/plan` et `bridge/etat-parcours`
  côté Academy, secret partagé `ACADEMY_BRIDGE_KEY`.
- Le plan d'action (`coaching-plan.js`, `api/coaching-plan-suggest.js`) a été
  retravaillé par Adrien lui-même début août : **ne pas y toucher sans raison
  explicite**, il en est satisfait.
