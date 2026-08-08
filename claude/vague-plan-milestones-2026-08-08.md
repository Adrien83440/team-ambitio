# Vague — Plan d'action : passage aux 5 milestones du parcours 6 mois

**Date** : 08/08/2026 · **Branche** : `vague/plan-cadrage-verrou` · **Merge** : `0fda3d1`
**Demande d'Adrien** : coller le résumé du call des 72 h dans le cadrage · générer un
point A et un point B détaillés à partir de là · un verrou principal avec sa zone
vocale et sans durée · retirer la semaine 1 et les infos collectées · planter une
graine 12 mois / 3 ans · être raccord avec les milestones du nouveau programme.

---

## 1. Le constat qui a motivé la refonte

Adrien a d'abord demandé « les deux, avec une correspondance » entre les 6 jalons
A1→B et les 5 milestones. Après lecture du document définitif
(`Elite_Phenix_Milestones_6mois.pdf`, v2.0 du 31/07/2026), cette correspondance
s'est révélée **non constructible** :

| Écart constaté | Conséquence |
|---|---|
| **M2 « Poser le cap et le cadre »** — vision, valeurs, organigramme, fiches de poste, rituels | **Aucun équivalent** dans A1→B. Un mois entier du programme n'existait pas dans le plan d'action. |
| **A2 « Recrutement / désignation bras droit » à J+20** | Le document définit le poste de relais en M2 (J60) et le recrute en M4 (J150). Le plan d'action le faisait quatre mois trop tôt. |
| Échéances | Aucune ne coïncide, sauf J180. |
| Outils | Le code Academy rattache l'outil 04 au jalon A3 ; le document le livre en M2. |

**Conclusion présentée à Adrien, et validée** : A1→B est une trame *antérieure* au
document. Ce n'était pas une correspondance à écrire, c'était une structure à
remplacer. J'avais initialement recommandé l'inverse en me fondant sur le code de
l'Academy — avec le document, c'est le code de l'Academy qui est en retard.

Deux documents circulaient : une version 9 mois (Mois 8 et 9) et la version 6 mois.
Adrien a lui-même signalé que la 9 mois était périmée avant que je la lise. Le seul
document de référence est désormais **la v2.0, 6 mois, du 31/07/2026**.

---

## 2. Décisions prises

| Sujet | Décision |
|---|---|
| Structure | **Les 5 milestones M1→M5** remplacent les 6 jalons A1→B. |
| Échéances | **Gardées mais discrètes.** Le document les qualifie de « moyennes constatées » ; sa phrase est rappelée sous la feuille de route. |
| Ordre | **Fixe.** « L'ordre n'est pas négociable » ; ce qui varie est la *profondeur* (champ `renforces`). |
| Priorités | Le classement Délivrabilité / Rentabilité / Acquisition remplace le choix d'un organisme unique. **acquisition finit toujours dernière**, forcé côté serveur. |
| Plans existants | **Jamais réécrits.** `etapes(p)` choisit la trame d'après ce que le plan porte réellement. |

---

## 3. Ce qui a été livré

**L'assistant, en 5 étapes** — Cadrage (compte rendu du call des 72 h, collé ou
dicté, + coach référent) · Point A · Point B · Verrou principal (+ « ce qu'on fait
pour le lever », sans aucune durée) · Priorités (classement + milestones renforcés).
Retrait de l'étape « Semaine 1 » et des cases « Infos collectées ».

**Le référentiel** — `MILESTONES` avec période, objectif, livrable de contrôle et
victoire vérifiable, repris mot pour mot du document. Les encadrés « ne pas
présenter au client » n'y figurent pas, et un test le vérifie sur la vue client.

**La génération** — le compte rendu des 72 h devient la matière première du prompt
et entre dans la clé de cache. Point A et point B passent de « une phrase » à 4-8
phrases détaillées. Nouveaux champs produits : `verrouPlan`, `organismes`,
`renforces`, `horizon12`, `horizon36`.

**Interdiction des durées** — dans le prompt (« ni en 2 semaines, ni d'ici la fin
du mois, ni rapidement »), rappelée à l'écran sous le champ.

**Les horizons 12 mois / 3 ans** — en pied du bloc Point A → Point B, petits et
gris. Le document les portait déjà : vision 3-5 ans en M2, plan de croissance
chiffré à 12 mois en M5.

Éditeur manuel, PDF et endpoint de retouche ont suivi la même trame.

---

## 4. Fichiers touchés

| Fichier | Nature |
|---|---|
| `coaching-plan.js` | `MILESTONES` + `JALONS_LEGACY` + `estLegacy()` / `etapes(p)` ; assistant refondu ; rendu (ordre, verrouPlan, horizons, renforcés, règle du programme) ; éditeur ; PDF |
| `api/coaching-plan-suggest.js` | Prompt réécrit autour des 5 milestones et du compte rendu 72 h ; `ordreOrganismes()` ; nouveaux champs nettoyés |
| `api/coaching-plan-revise.js` | Même trame ; anciennes clés A1→B toujours acceptées |

Format du plan : `version: 4`. Nouveaux champs `resume72h`, `verrouPlan`,
`horizon12`, `horizon36`, `organismes`, `renforces`, `prioriteNote`.
**Aucune migration** : `normalize()` pose les champs manquants et reprend
`organisme` (unique) dans `organismes` (classement).

---

## 5. Tests

- `node --check` sur les 3 fichiers ; blocs `<script>` de `coaching.html` et
  `plan-client.html` vérifiés, delta de balises identique.
- `grep` repo-wide sur chaque nouvel identifiant → zéro collision
  (`BONUS_MILESTONES` de `sales-commissions.html` est une autre page, et nos
  symboles vivent dans l'IIFE).
- **Harnais `t-milestones.js`, 25 assertions** : un plan neuf rend M1→M5 avec les
  périodes et livrables du document ; **un plan existant garde ses jalons A1→B,
  ses statuts et ses semaines** ; un plan retouché en milestones bascule ; reprise
  de `organisme` → `organismes` ; classement rendu dans l'ordre saisi ; horizons
  absents quand vides ; **la vue client ne contient aucune note interne**.
- Harnais existants (rendu, fusion serveur, brouillon, feuilles CSS, discriminant
  Elite NEW) tous au vert.

**Un bug attrapé par les tests** : le classement des trois grandes étapes étant
désormais complété automatiquement côté serveur, une retouche IA qui n'en parlait
pas écrasait celui du coach avec l'ordre par défaut. Corrigé — dans l'endpoint de
retouche, un classement absent reste absent.

---

## 6. Reste ouvert

- **L'Academy affiche toujours A1→B**, avec ses dates et ses badges « En retard ».
  Pour un même client, la fiche coaching montre M1→M5 et l'Academy A1→B. La reprise
  est spécifiée dans [`memo-academy-parcours-etapes.md`](memo-academy-parcours-etapes.md) ;
  elle demande le repo Academy en git.
- **`set-path` côté Academy** n'a toujours aucun garde-fou de version (§3 du mémo).
- `collecteBlock()` n'est plus appelée par l'assistant. Conservée : la donnée
  `collecte` existe dans les plans anciens et reste éditable dans l'éditeur.
  Suppression non faite faute d'accord explicite.
- La règle CSS `.soon-tag` de `coaching.html`, morte depuis la livraison du bouton.
- L'historique des retouches IA est enregistré, jamais affiché.
