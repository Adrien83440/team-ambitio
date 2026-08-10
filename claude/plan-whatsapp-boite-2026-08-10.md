# Plan — Boîte WhatsApp partagée, vue admin, ouverture depuis Leads Live

Demande d'Adrien du 10/08/2026. Fait suite aux vagues 1 et 2 (rappels et
notification coach), déjà en production.

---

## 1. Le périmètre, décidé

**Admin et sales uniquement.** Même règle que le Dialer : les coachs et la CSM
n'y ont pas accès, ni au module, ni à l'entrée de menu. Un nouveau module
`whatsapp` s'ajoute dans la grille de permissions existante (`PERM_KEYS`,
`ROLE_DEFAULTS`, `PERM_LABELS` dans `nav.js`), avec les trois niveaux habituels
Aucun / Lecture / Édition, et `none` par défaut pour `coach` et `csm`.

---

## 2. Quatre contraintes qui dessinent tout

**Un seul numéro, donc une seule boîte.** Tout team.alteore partage
`+33 6 52 40 62 40`. Il n'existe pas de ligne par personne : ce qu'on construit
est une **boîte partagée avec attribution**, pas une messagerie individuelle.
Chacun écrit sous le nom de l'entreprise.

**La fenêtre de 24 heures.** Message libre autorisé uniquement dans les 24 h
suivant le DERNIER message entrant du contact. En dehors : modèle approuvé
seulement. C'est la contrainte structurante de l'interface — l'état de la
fenêtre doit être visible en permanence, sinon l'équipe écrira des messages qui
partiront en erreur sans comprendre pourquoi.

**Aucun historique.** L'API ne restitue aucune conversation antérieure à
l'abonnement du webhook. La boîte démarre vide et se remplit à partir de son
allumage. À dire à l'équipe pour éviter « il manque des messages ».

**Le numéro est partagé avec la relation client.** Il porte les rappels de
séance et portera les groupes. Une dégradation de sa note de qualité, causée par
des signalements sur la prospection, emporterait les rappels avec elle. C'est le
risque principal de ce chantier, et il est assumé sous conditions (§6).

---

## 3. Les données

Deux collections existent déjà, écrites par la vague 1 :
- `whatsapp_messages/{wamid}` — journal technique des envois, statuts de remise ;
- `whatsapp_inbound/{wamid}` — messages entrants bruts.

Elles restent inchangées : la vague 2 s'appuie dessus et on n'y touche pas.

**Deux nouvelles, pour l'interface :**

`whatsapp_conversations/{numero}` — l'index, un document par contact, clé =
numéro normalisé (`33XXXXXXXXX`, même règle que `normaliserNumero`) :
- `numero`, `nom` (profil WhatsApp), `leadId`, `clientId`
- `dernierMessage` : `{ texte, sens, at }`
- `fenetreExpireA` — horodatage du dernier entrant + 24 h. **Le champ qui
  commande l'interface.**
- `nonLus`, `attribueA`, `statut` (`ouverte` | `archivee`)

`whatsapp_conversations/{numero}/messages/{wamid}` — le fil, les deux sens
mélangés et ordonnés. Un seul `onSnapshot` suffit à afficher une conversation,
au lieu de fusionner deux collections côté navigateur.

**Un seul point d'écriture** alimente l'index, le fil ET le journal technique :
une fonction unique dans `api/_whatsappClient.js`, pour qu'ils ne puissent pas
diverger.

**Rattachement au lead** par le téléphone canonique `telephone` (E.164 strict),
en ignorant les documents `_merged: true` — motif `pickAlive()`. Une conversation
sans lead reste utilisable, elle affiche juste le numéro.

---

## 4. Les règles Firestore

Trois blocs `match` à écrire, et **les règles ne cascadent pas** : la
sous-collection `messages` a besoin du sien. Lecture et écriture réservées aux
rôles `admin` et `sales`. Un oubli ici a déjà cassé une page en production.

---

## 5. Les vagues

### Vague A — la boîte en lecture
- maintien de `whatsapp_conversations` par le webhook, sans changer son contrat ;
- page `whatsapp.html` : liste des conversations à gauche, fil à droite, temps
  réel ;
- **admin voit tout, un sales voit ce qui lui est attribué** plus les
  conversations sans propriétaire ;
- rattachement au lead, avec lien vers sa fiche ;
- module et entrée de menu réservés admin + sales.

Rien de tout cela ne dépend d'un nouveau modèle Meta : livrable immédiatement.

### Vague B — répondre
- envoi libre **si et seulement si** la fenêtre est ouverte, avec le temps
  restant affiché ;
- hors fenêtre, l'interface propose les modèles approuvés au lieu du champ
  libre — jamais un champ libre qui échouera ;
- attribution manuelle d'une conversation, marquage lu / non lu ;
- accusés de remise visibles sur chaque message envoyé.

### Vague C — engager depuis Leads Live
- bouton sur la carte du lead, visible pour admin et sales ;
- un modèle d'ouverture dédié, à écrire et faire approuver — **délai Meta**, donc
  cette vague ne peut pas être la première ;
- **garde-fou** : proposé uniquement pour les leads dont le numéro vient d'un
  formulaire ou d'une réservation. Jamais une liste importée.

---

## 6. Le risque sur le numéro, et ce qui le contient

Trois mesures, à tenir :
1. jamais de prospection vers un numéro qui n'a pas été donné volontairement ;
2. surveillance de `numero.qualite` dans `/api/whatsapp-diagnostic` — au premier
   passage sous GREEN, on arrête la prospection avant d'aviser ;
3. si la qualité se dégrade malgré tout, la prospection bascule sur un **second
   numéro**, ce qui isole définitivement la relation client.

Prendre un second numéro dès maintenant doublerait la configuration Meta sans
preuve que le risque se matérialise. Mais le jour où il faudra le faire, il
faudra le faire vite.

---

## 7. Ce qui est visible de l'équipe

L'admin voit toutes les conversations, y compris celles de l'équipe avec les
clients. C'est légitime — c'est un compte d'entreprise — mais c'est le genre de
chose qui se dit à l'équipe plutôt qu'elle ne se découvre.

---

## 8. Ce que ce plan ne couvre pas

Les **groupes** restent la vague 3 du plan du 09/08/2026, bloquée par le Compte
professionnel officiel. La vue « tous les groupes créés » demandée par Adrien en
dépend et ne peut pas être livrée avant.
