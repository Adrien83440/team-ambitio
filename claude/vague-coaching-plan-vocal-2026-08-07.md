# Vague — Plan d'action coaching : mode vocal, Opus 5, édition manuelle, retouche IA

**Date** : 07/08/2026 · **Branche** : `vague/coaching-plan-vocal-edition` · **Merge** : `a54e8ba`
**Demande d'Adrien** : pouvoir parler pour remplir les champs · mettre Opus 5 sur la génération ·
indiquer les infos collectées dans les cases · modifier manuellement les étapes · réparer la
semaine 1 illisible · un plan réaliste, beau et lisible · pouvoir dire ce qu'on veut changer
et que ce soit fait.

---

## 1. Décisions

### Reconnaissance vocale native, pas Whisper
La dictée passe par `SpeechRecognition` / `webkitSpeechRecognition` du navigateur, en `fr-FR`.
Écarté : `MediaRecorder` → upload → Whisper, qui aurait imposé une nouvelle variable
d'environnement (la clé OpenAI vit dans `ai_credentials` Firestore, côté Cloud Functions, pas
dans `/api`), un endpoint de transcription, du stockage audio et un coût par minute.
Conséquence assumée : **Firefox ne gère pas cette API**. Le champ reste tapable et un message
l'explique — pas de bouton mort. Un seul micro actif à la fois (deux dictées se voleraient le
flux audio et rempliraient le mauvais champ).

### Opus 5 sur les deux endpoints IA
`claude-opus-5`, `output_config: { effort: 'high' }`. La réflexion est **active par défaut** sur
ce modèle : `max_tokens` couvre réflexion + réponse, d'où les 24 000 (le JSON attendu en fait
~4 000). `maxDuration: 300` dans `vercel.json` — Adrien a confirmé le plan Pro, et le coût Opus
est assumé. Refus modèle (`stop_reason: 'refusal'`) traité explicitement : il revient en HTTP 200
avec un contenu vide, sans ce test on lirait du vide en croyant à une panne.

### La retouche IA fusionne, elle ne substitue pas
`api/coaching-plan-revise.js` renvoie le plan reçu **avec** les modifications par-dessus. Restent
intacts quoi que réponde le modèle : `startDate`, `jalonStatus`, `collecte`, `vocal`,
`historique`, `createdAt`. Les statuts d'action sont réattachés par position **et** par égalité
de texte — si l'IA réécrit une action, son statut repart à `todo` (afficher « fait » sur une
action qui n'existait pas serait pire que de perdre l'info). Une liste vide renvoyée par le
modèle signifie « rien à dire là-dessus », jamais « efface cette section ».

### Un seul chemin d'écriture
`savePlanV2(clientId, plan, msg, full)` dans `coaching.html` sert l'assistant, l'éditeur manuel
et la retouche. Évite trois copies de la même écriture Firestore qui finiraient par diverger.

### CSS injecté par le module
Les nouveaux styles partagés (`.cp-mic`, `.cpv2-*`) sont posés par `coaching-plan.js` au
chargement, donc valables sur `coaching.html` **et** `plan-client.html` sans dupliquer une ligne
dans les deux pages (leurs blocs `.cpv-*` sont déjà des copies qui pourraient diverger).

---

## 2. Cause du bug « semaine 1 illisible »

Les champs de la semaine 1 étaient rendus dans `.cp-act`, **hors** de `.cp-f`. Or tout le style
des inputs de l'assistant était porté par le sélecteur `.cp-f input, .cp-f textarea, .cp-f select`.
Les trois actions s'affichaient donc en champs bruts du navigateur : minuscules, sans bordure
visible, sans placeholder lisible. Corrigé par des règles `.cp-act input` en fin de feuille (elles
gagnent sur les précédentes sans qu'on touche à l'existant). Les 3 emplacements d'action sont
désormais **toujours** affichés : avant, une ligne vidée disparaissait de l'écran et devenait
impossible à re-remplir.

---

## 3. Fichiers touchés

| Fichier | Nature |
|---|---|
| `coaching-plan.js` | +959 lignes. Module VOX (dictée), `normalize()`, `jOf()`/`jalonPreuve()` (décalage et preuve par dossier), cases « Infos collectées », panneau vocal, éditeur manuel complet (`openEditor`), `revise()`, barre d'avancement, barre de retouche, correctifs CSS, PDF aligné sur les étapes réelles |
| `api/coaching-plan-suggest.js` | Opus 5, `notes` du mentor (prioritaires sur le questionnaire), clé de cache incluant les notes, génération possible **sans** questionnaire si des notes existent, `preuve` par jalon, gestion du refus |
| `api/coaching-plan-revise.js` | **Nouveau.** Retouche en langage naturel, fusion prudente, sanitisation complète |
| `coaching.html` | `savePlanV2()`, `openPlanEditor()`, délégation `data-cp-ai` / `data-cp-edit`, bouton « ✏️ Modifier le plan » |
| `vercel.json` | `maxDuration: 300` sur les deux endpoints IA |

Format du plan : `version: 3`. Nouveaux champs `collecte`, `vocal`, `historique`, et
`jalons[k].j` / `jalons[k].preuve`. **Aucune migration** : `normalize()` pose les champs manquants
à l'ouverture, les plans v2 continuent de s'afficher tels quels.

---

## 4. Tests faits

- `node --check` sur les 3 `.js` modifiés/créés.
- Extraction et `node --check` de chaque bloc `<script>` inline de `coaching.html` et
  `plan-client.html` ; delta de balises `<script>`/`</script>` identique avant/après (7/7 et 2/2).
- `grep` repo-wide sur chaque nouvel identifiant (`ceBg`, `ceBody`, `cpv2-`, `cp-mic`,
  `data-cp-ai`, `data-cp-edit`…) → zéro collision. `openEditor` et `progBar` existent ailleurs
  mais les nôtres sont dans l'IIFE, donc locaux.
- **Harnais node sur la fusion serveur** (18 assertions) : point B remplacé / point A intact /
  `startDate` jamais touchée / statuts jalons et actions conservés / notes du coach conservées /
  statut remis à zéro si le texte d'action change / organisme invalide rejeté / clé de jalon
  inconnue ignorée / décalage `0` accepté et `-5` rejeté / date mal formée rejetée / listes vides
  n'effacent rien.
- **Harnais node sur le rendu** avec DOM stubbé (16 assertions) : `normalize` d'un plan v2,
  décalages personnalisés (dont `0`), barre d'avancement, compteur d'actions, et surtout —
  **la vue client ne contient ni `data-cp-ai`, ni `data-cp-edit`, ni `data-cp-jalon`, ni micro** ;
  échappement XSS vérifié sur le texte libre et les repères chiffrés.

Harnais non commités (dossier temporaire), conformément à la règle.

---

## 5. Reste à faire / points ouverts

- **Coût de la retouche** : contrairement à la génération, elle n'est pas mise en cache — chaque
  « Appliquer » est un appel Opus 5 à effort `high`. Passer la retouche en `medium` diviserait la
  facture si l'usage décolle. À décider sur données réelles.
- **Firefox** : pas de dictée. Si un coach est bloqué dessus, il faudra le pipeline Whisper
  (nouvelle env var → validation d'Adrien requise).
- **`historique`** est écrit (20 dernières retouches) mais n'est affiché nulle part. Un bloc
  « historique des retouches » dans l'éditeur serait le prolongement naturel.
- La `semaine1()` pré-remplie reste codée en dur (« Adrien / Emily »). Non touché — hors demande.
