# Mémo pour le repo Academy — exposer l'état du parcours à étapes à Team Alteor

*07/08/2026 — écrit depuis `team-ambitio` après lecture de `ae-academy-main (2).zip`.
Rien n'a été modifié dans le repo Academy : ce mémo décrit ce qu'il y faudrait
pour que la fiche coaching d'Alteor puisse afficher les 5 étapes.*

---

## 1. Le constat qui bloque

Team Alteor **ne peut pas lire l'état du parcours v2 aujourd'hui.**

| Vérification faite | Résultat |
|---|---|
| `/api/bridge/progress` renvoie-t-il quelque chose des collections `ep_*` ? | **Non.** Il renvoie ce que construit `src/lib/dossier.js`, qui ne mentionne ni `ep`, ni `parcours`, ni `etapes`. |
| `versionProgramme()` est-il appelé depuis une route `bridge/` ? | **Non.** Uniquement dans `api/ep/etat`, `api/ep/admin`, `lib/ep/serveur.js`, `lib/ep/programme.js`. |
| `/api/bridge/parcours` peut-il servir à lire ? | **Non.** Son `GET` ne renvoie qu'un ping (`ok`, `service`, `configured`, `etapeFixe`). Le `POST` écrit la personnalisation des étapes 2 à 5. |
| `/api/ep/etat` conviendrait-il ? | Il a exactement les bonnes données, mais il s'authentifie avec un **jeton Firebase d'utilisateur Academy** (`Authorization: Bearer`), pas avec `x-bridge-key`. Alteor n'a pas de compte Academy. |

**Conséquence** : tant que rien n'est ajouté côté Academy, la fiche coaching ne
peut afficher qu'un renvoi vers l'Academy — c'est ce qui a été livré côté
Alteor, volontairement sobre plutôt que faussement précis.

---

## 2. Ce qu'il faudrait ajouter — une seule route

Une route de **lecture seule**, sur le pont existant, sans variable
d'environnement nouvelle (`ACADEMY_BRIDGE_KEY` suffit) :

```
POST /api/bridge/etat-parcours
Auth : x-bridge-key   (le même secret que les 8 ponts existants)
Corps: { "email": "client@exemple.com" }
```

Réponse proposée — le strict nécessaire pour la fiche coaching, rien de plus :

```jsonc
{
  "ok": true,
  "found": true,
  "version": "v2_6mois",          // versionProgramme() — permettrait à Alteor
                                  // de ne plus deviner d'après le libellé
  "etapeCourante": "m3",
  "etapes": [
    { "cle": "m1", "titre": "Libérer le temps du dirigeant", "etat": "validee",
      "valideeLe": "2026-05-12" },
    { "cle": "m2", "titre": "Poser le cap et le cadre",      "etat": "validee",
      "valideeLe": "2026-06-20" },
    { "cle": "m3", "titre": "Déléguer pour de bon",          "etat": "en_cours" },
    { "cle": "m4", "titre": "…", "etat": "verrouillee" },
    { "cle": "m5", "titre": "…", "etat": "verrouillee" }
  ],
  "outils": { "remplis": 4, "total": 6 },   // outils du DIRIGEANT (01→06)
  "derniereActivite": "2026-08-04"
}
```

### Ce que la route ne doit PAS renvoyer

`api/ep/etat` filtre déjà côté serveur, et pour de bonnes raisons — même
politique ici :

- **jamais** les scores 0-3 du coach, ses commentaires, la décision d'étape ;
- **jamais** le contenu des outils (c'est du CSM/coach, pas du CRM) ;
- les états `a_completer` et `bloquante` doivent être traduits en `en_cours`
  si la réponse peut finir sous les yeux d'un dirigeant. Côté Alteor la fiche
  est réservée à l'équipe, donc les états bruts sont acceptables — **mais
  c'est une décision à prendre explicitement, pas par défaut.**

### Réutilisable tel quel

`vueParcours()` de `lib/ep/etats.js`, `etatJalons()` / `jalonCourant()` de
`lib/ep/jalons.js` et `completudeOutil()` de `lib/ep/completude.js` font déjà
tout le calcul. La route serait essentiellement de l'assemblage : ~80 lignes,
sur le modèle exact de `bridge/progress`.

---

## 3. Le bug latent à corriger côté Academy

**`/api/bridge/set-path` n'a aucun garde-fou de version.** Sur un élève
`v2_6mois`, il écrit `users/{email}.path[courseId]` sans broncher — un
réordonnancement de sujets vidéo pour quelqu'un qui n'a pas de vidéos. C'est
silencieux, donc invisible.

Côté Alteor, c'est neutralisé depuis le 07/08 : les quatre chemins qui
menaient à `set-path` (copilote manuel, proposition automatique après sync
Drive, lot « Proposer pour tous », bannière de proposition en attente) ignorent
désormais les clients dont le programme commence par « Elite NEW ».

**Mais la ceinture manque côté Academy.** Trois lignes en tête du `POST` de
`set-path` :

```js
const version = versionProgramme(learner, config);
if (version === "v2_6mois") {
  return NextResponse.json({ ok: false, error: "v2_no_path" }, { status: 409 });
}
```

C'est la vraie protection : elle tient quel que soit l'appelant, aujourd'hui et
dans six mois. Le filtre côté Alteor n'est qu'une bretelle.

---

## 4. Le point de vocabulaire à ne pas rater

Trois choses différentes s'appellent « jalon » ou « milestone » dans les deux
applications. À garder en tête avant d'écrire une ligne :

| Nom | Où | Ce que c'est |
|---|---|---|
| `module.milestone` | Academy v1 | Félicitation à la fin d'un module vidéo |
| étapes `m1`→`m5` | Academy v2 | Les 5 étapes du parcours Elite NEW |
| jalons `A1`→`A5`, `B` | **Alteor**, `planV2.jalons` | Les 6 jalons datés du plan d'action coaching |

**Les 6 jalons du plan d'action d'Alteor et les 5 étapes du parcours Academy ne
sont pas la même chose et ne doivent pas être fusionnés.** Le plan d'action est
l'engagement pris en séance avec le mentor ; les étapes sont le déverrouillage
du contenu et la validation du coach. Un rapprochement est peut-être
souhaitable un jour — c'est une décision produit d'Adrien, pas une évidence
technique.

---

## 5. Ordre de marche proposé

1. **Côté Academy** — le garde-fou `set-path` (§3). Trois lignes, aucun risque,
   protège tout de suite.
2. **Côté Academy** — la route `bridge/etat-parcours` (§2), plus la décision
   sur les états bruts.
3. **Côté Alteor** — remplacer le bloc sobre par le rail des 5 étapes, et
   basculer le discriminant du libellé de programme vers le `version` renvoyé
   par la route (plus fiable que deviner sur une chaîne de caractères).
