# Séquences d'après-RDV à choix : une histoire par douleur

*Version du 24/11/2026 (soir) : histoires en quatre étapes, choix différents à chaque e-mail (demande d'Adrien). Textes à valider.*

## Principe

- Les réponses de l'ancien formulaire (« Quel est votre principal défi ? ») n'ouvrent pas d'histoire : les textes citent la question et les mots du nouveau questionnaire.
- La **douleur** vient de la première question du questionnaire (« Qu'est-ce qui vous pèse le plus dans votre entreprise aujourd'hui ? »). Cinq réponses, cinq histoires : `rentabilite`, `operationnel`, `vie`, `equipe`, `plafond`.
- Le **frein** (trésorerie, timing, décision, preuves, priorité, général) ouvre et ferme la séquence. Quand le prospect suit une histoire, ses e-mails 1 et 5 sont ceux de la section « 0. Freins avec histoire » : ils citent sa réponse et n'annoncent pas les e-mails du frein, qui ne partiront pas.
- Chaque histoire avance en **quatre étapes** (e-mails 2 à 5), et chaque étape pose une question nouvelle, avec trois réponses écrites à la première personne :
  1. **Le constat** (`C1`) : « chez vous, ça ressemble plutôt à quoi ? » → trois situations.
  2. **La cause** (`C2A`, `C2B`, `C2C`, selon sa réponse) : pourquoi cela arrive → « qu'est-ce qui vous a empêché de vous y attaquer ? ».
  3. **Le prix** (`C3A`, `C3B`, `C3C`, selon sa réponse) : ce que coûte ce frein, avec un témoignage → « et aujourd'hui, où en êtes-vous ? ».
  4. **La prise de conscience** (`C4`) : son histoire résumée avec ses propres réponses, ce qu'elle raconte mise bout à bout, puis un seul bouton : reprendre un audit. Le paragraphe `{{fin}}` dépend de sa dernière réponse (`C4A`, `C4B`, `C4C`) ; sans réponse, c'est `C4N`.
- Sans clic, l'histoire continue avec la première des trois réponses, présentée comme « ce que les dirigeants dans votre situation nous disent le plus souvent » : on ne prête jamais au prospect une phrase qu'il n'a pas choisie. Le résumé de l'étape 4 ne reprend que les réponses réellement cliquées.
- Les questions ne reprennent jamais celles du questionnaire (ce qu'il a déjà tenté, comment il vit son rythme, ce qu'il veut dans douze mois…).
- `*Bouton : …*` = la réponse qui mène à ce texte ; `*Question : …*` = la question posée au-dessus des trois boutons de ce texte.
- Chaque e-mail dit **ce qui se passe** et **pourquoi**, jamais **comment** le régler. Le comment, c'est l'audit.
- Vouvoiement, aucun prix, aucune garantie, témoignages réels avec leurs propres mots.

Syntaxe : `>> phrase` = encadré ; `[ Libellé ]` = bouton de réservation (ou lien entre parenthèses) ; `[[ Libellé ]]` = lien discret ; `{{choix}}` = la question et ses trois réponses (ou le bouton de réservation à l'étape 4) ; `{{ouverture}}` = « Vous nous avez répondu : … » après un clic, « Ce que les dirigeants dans votre situation nous disent le plus souvent : … » sinon ; `{{recap}}` = sa réponse au questionnaire puis ses réponses cliquées ; `{{fin}}` = le paragraphe de sa dernière réponse ; `![texte](image)` = image ; `{{m_…}}` = phrase miroir, tirée d'une réponse à choix du prospect (la ligne disparaît si la réponse manque).

## Phrases miroir

| Clé | Question du questionnaire | Réponse | Phrase |
|---|---|---|---|
| `m_marge` | Savez-vous précisément quelle marge vous gagnez sur chacune de vos offres ? | Non | Vous nous avez dit ne pas connaître précisément la marge de chacune de vos offres. |
| `m_sommeil` | « Il m'arrive de mal dormir en pensant à la trésorerie » | 4/5, 5/5 | Vous nous avez aussi dit qu'il vous arrive de mal dormir en pensant à la trésorerie des semaines à venir. |
| `m_2semaines` | Deux semaines sans téléphone : l'entreprise tournerait-elle ? | Non | Vous nous avez dit que votre entreprise ne tournerait pas deux semaines sans vous. |
| `m_autonome` | Un nouveau salarié peut-il devenir autonome sans que vous le formiez vous-même ? | Non | Vous nous avez dit qu'un nouveau salarié ne devient pas autonome sans que vous le formiez vous-même. |
| `m_consignes` | « J'ai l'impression de répéter les mêmes consignes encore et encore » | 4/5, 5/5 | Vous nous avez dit avoir l'impression de répéter les mêmes consignes, encore et encore. |
| `m_charge` | « Chaque fois que l'activité augmente, c'est moi qui absorbe la charge en plus » | 4/5, 5/5 | Vous nous avez dit que, chaque fois que l'activité augmente, c'est vous qui absorbez la charge en plus. |
| `m_levier` | Sauriez-vous exactement quel levier actionner pour augmenter votre chiffre le mois prochain ? | Non | Vous nous avez dit ne pas savoir exactement quel levier actionner pour augmenter votre chiffre d'affaires. |
| `m_heures` | Heures travaillées par semaine | 50 à 60 h | Vous travaillez entre 50 et 60 heures par semaine. |
| | | Plus de 60 h | Vous travaillez plus de 60 heures par semaine. |
| `m_rythme` | Honnêtement, comment vivez-vous ce rythme ? | Je suis à bout | Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « Je suis à bout. » |
| | | C'est tendu, mais je tiens | Et quand nous vous avons demandé comment vous viviez ce rythme, vous avez répondu : « C'est tendu, mais je tiens. » |
| `m_duree` | Depuis combien de temps… ? | Plus de 3 ans | Cela dure depuis plus de trois ans. |
| | | Entre 1 et 3 ans | Cela dure depuis plus d'un an. |
| | | Entre 6 mois et 1 an | Cela dure depuis plusieurs mois. |
| `m_tente` | Qu'avez-vous déjà tenté ? | Embaucher quelqu'un pour me soulager | Vous avez déjà essayé d'embaucher quelqu'un pour vous soulager. |
| | | Commencer plus tôt, finir plus tard | Vous avez déjà essayé de commencer plus tôt et de finir plus tard pour « vous avancer ». |
| | | Bloquer du temps dans mon agenda… | Vous avez déjà essayé de bloquer du temps dans votre agenda, et il a fini par sauter. |
| | | De nouveaux outils | Vous avez déjà essayé de nouveaux outils. |
| | | Augmenter mes prix | Vous avez déjà essayé d'augmenter vos prix. |
| | | Réduire mes charges | Vous avez déjà essayé de réduire vos charges. |
| | | Faire plus de volume | Vous avez déjà essayé de faire plus de volume. |
| | | En parler avec mon expert-comptable | Vous en avez déjà parlé avec votre expert-comptable. |
| | | Déléguer… puis finir par tout reprendre moi-même | Vous avez déjà essayé de déléguer, avant de tout reprendre vous-même. |
| | | Écrire des procédures ou des fiches de poste | Vous avez déjà écrit des procédures ou des fiches de poste. |
| | | Recruter un responsable ou un bras droit | Vous avez déjà recruté un responsable ou un bras droit. |
| | | Faire des réunions d'équipe régulières | Vous avez déjà mis en place des réunions d'équipe régulières. |
| `m_temps` | Si votre entreprise tournait sans vous, que feriez-vous en premier ? | Souffler, tout simplement | Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : souffler, tout simplement. |
| | | Partir en vacances avec mes proches, téléphone éteint | Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : partir en vacances avec vos proches, téléphone éteint. |
| | | Prendre de la hauteur pour préparer la suite | Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : prendre de la hauteur pour préparer la suite. |
| | | Avancer enfin sur le projet que je repousse | Vous nous avez dit ce que vous feriez en premier si votre entreprise tournait sans vous : avancer enfin sur le projet que vous repoussez depuis des mois. |
| `m_12mois` | Dans 12 mois, quel résultat changerait tout pour vous ? | Une rentabilité solide, et enfin me payer correctement | Dans douze mois, ce qui changerait tout pour vous : une rentabilité solide, et enfin vous payer correctement. |
| | | Une entreprise qui tourne sans moi au quotidien | Dans douze mois, ce qui changerait tout pour vous : une entreprise qui tourne sans vous au quotidien. |
| | | Travailler moins sans perdre de chiffre d'affaires | Dans douze mois, ce qui changerait tout pour vous : travailler moins sans perdre de chiffre d'affaires. |
| | | Une équipe autonome qui décide sans tout me remonter | Dans douze mois, ce qui changerait tout pour vous : une équipe autonome, qui décide sans tout vous remonter. |

---

## 0. Freins avec histoire (`freins`)

E-mails 1 et 5 de chaque frein quand le prospect suit une histoire. `{{douleur_citation}}` = sa réponse, mot pour mot.

**[frein_tresorerie] E1 : Merci pour votre franchise**
*Pré-en-tête : La trésorerie, c'est le sujet de tous les dirigeants. Vraiment.*

> Bonjour %FIRSTNAME%,
>
> « Ce n'est pas le moment, la trésorerie est trop juste. » Vous nous l'avez dit sans détour lors de notre échange, et merci pour ça : la plupart des dirigeants le pensent sans oser le dire.
>
> Nous n'allons pas essayer de vous faire changer d'avis. Nous voulons revenir sur autre chose, que vous nous aviez écrit avant même de nous parler. À la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> Cette phrase et votre trésorerie sont rarement deux sujets séparés. Le plus souvent, l'une explique l'autre.
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent de cette phrase : ce qui se passe réellement derrière, et pourquoi. Rien à acheter, juste de quoi y voir plus clair.
>
> Adrien & Emily
>
> P.S. Le premier arrive dans trois jours, et il commence par votre réponse.

**[frein_tresorerie] E5 : On en reparle ?**
*Pré-en-tête : Si le sujet est toujours d'actualité, notre porte est ouverte.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé depuis notre échange. Ces derniers jours, nous sommes partis d'une phrase, la vôtre :
>
> >> « {{douleur_citation}}. »
>
> Si elle est toujours vraie aujourd'hui, et si la trésorerie vous occupe encore l'esprit, nous vous proposons de refaire le point, 45 minutes, avec vos chiffres :
>
> - ce qui a bougé depuis notre échange ;
> - ce qui reste bloqué ;
> - les deux ou trois actions qui auraient le plus d'effet maintenant.
>
> Vous repartez avec ces priorités, que nous travaillions ensemble ou non.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily
>
> P.S. Ce n'est plus d'actualité ? Répondez simplement « plus tard » : nous lisons toutes les réponses.

**[frein_timing] E1 : Bien noté pour le timing**
*Pré-en-tête : Le bon moment ne se présente presque jamais tout seul.*

> Bonjour %FIRSTNAME%,
>
> Vous nous avez dit, lors de notre échange, que ce n'était pas le bon moment. C'est noté, et nous le respectons : personne ne connaît votre agenda mieux que vous.
>
> Nous n'allons pas vous relancer pour vous faire changer d'avis. Nous voulons revenir sur autre chose, que vous nous aviez écrit avant même de nous parler. À la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> C'est souvent cette phrase-là qui fait qu'il n'y a jamais de bon moment.
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent d'elle : ce qui se passe réellement derrière, et pourquoi. Ils se lisent en deux minutes, même en pleine période chargée.
>
> Adrien & Emily
>
> P.S. Le premier arrive dans trois jours, et il commence par votre réponse.

**[frein_timing] E5 : Et si on fixait la date maintenant ?**
*Pré-en-tête : Même pour plus tard, autant la bloquer dès aujourd'hui.*

> Bonjour %FIRSTNAME%,
>
> Vous nous aviez dit que ce n'était pas le bon moment. Quelques semaines plus tard, il n'est peut-être toujours pas venu. C'est normal : il ne vient pas tout seul.
>
> Et pendant ce temps, votre phrase est sans doute toujours vraie :
>
> >> « {{douleur_citation}}. »
>
> Voici donc une façon simple de ne plus y penser : **choisissez la date vous-même.** Dans deux semaines, dans un mois, après votre saison : le calendrier est ouvert.
>
> Le créneau sera dans votre agenda. D'ici là, vous n'avez rien à faire ni à préparer.
>
> [ Choisir un créneau ]
>
> Adrien & Emily
>
> P.S. Une date posée, même lointaine, c'est déjà une décision. Et si elle ne convient plus le moment venu, il suffira de nous le dire.

**[frein_decision] E1 : Pour en parler à deux**
*Pré-en-tête : Une décision qui engage l'entreprise se prend rarement seul.*

> Bonjour %FIRSTNAME%,
>
> Vous souhaitez en parler avant de décider. C'est sain : une décision qui engage votre entreprise ne se prend pas seul, sur un coin de table.
>
> Pour vous aider à en parler, le plus simple est de repartir de ce que vous nous aviez écrit avant notre échange. À la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> C'est le vrai point de départ, bien plus que notre accompagnement. Et c'est une phrase que la personne à qui vous en parlerez reconnaîtra sans doute.
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent d'elle : ce qui se passe réellement derrière, et pourquoi. Vous pourrez les transférer tels quels.
>
> Adrien & Emily
>
> P.S. La personne concernée a déjà une question précise ? Répondez à cet e-mail : nous vous aidons à y répondre.

**[frein_decision] E5 : Où en êtes-vous ?**
*Pré-en-tête : Juste pour savoir si vous avez pu en parler.*

> Bonjour %FIRSTNAME%,
>
> Avez-vous pu en parler ?
>
> Quelle que soit votre décision, nous serions contents de la connaître. Vraiment : un « non » clair nous aide autant qu'un « oui ».
>
> **Répondez à cet e-mail, même en un mot**
>
> - « oui » : nous revenons vers vous pour la suite ;
> - « pas encore » : nous vous laissons le temps ;
> - « non » : c'est noté, sans rancune.
>
> Et si votre phrase est toujours d'actualité, « {{douleur_citation}} », le plus simple est peut-être d'en parler de vive voix, seul ou à deux :
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

**[frein_preuves] E1 : Vous avez raison de vouloir des preuves**
*Pré-en-tête : Ne vous engagez jamais sur une promesse.*

> Bonjour %FIRSTNAME%,
>
> Vous voulez voir du concret avant de vous engager. Vous avez raison, et nous vous dirions la même chose à votre place : ne vous engagez jamais sur une promesse.
>
> Alors plutôt que de vous parler de nous, nous allons repartir de vous. Avant notre échange, à la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent de cette phrase : ce qui se passe réellement derrière, pourquoi, et l'histoire de dirigeants qui disaient la même chose. En vidéo, avec leurs mots à eux, pas les nôtres.
>
> Adrien & Emily
>
> P.S. Vous avez un secteur ou une situation en tête ? Répondez à cet e-mail : si nous avons accompagné un dirigeant proche de votre cas, nous vous le dirons.

**[frein_preuves] E5 : Voir par vous-même**
*Pré-en-tête : La meilleure preuve reste celle qui vous concerne.*

> Bonjour %FIRSTNAME%,
>
> Les histoires des autres donnent une idée. Mais la seule preuve qui compte vraiment, c'est ce que cela donnerait **pour votre entreprise**, à partir de votre phrase :
>
> >> « {{douleur_citation}}. »
>
> C'est ce que nous vous proposons de regarder ensemble, 45 minutes, avec vos chiffres d'aujourd'hui :
>
> 1. ce qui se passe réellement derrière cette phrase, chez vous ;
> 2. ce qui pèse le plus ;
> 3. les deux ou trois actions qui auraient le plus d'effet.
>
> Vous repartez avec ces priorités, que nous travaillions ensemble ou non. Et si nous pensons ne pas pouvoir vous aider, nous vous le dirons.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

**[frein_priorite] E1 : Merci pour notre échange**
*Pré-en-tête : Une phrase à garder en tête cette semaine.*

> Bonjour %FIRSTNAME%,
>
> Merci pour le temps que vous nous avez accordé. Vous préférez avancer par vous-même pour l'instant : c'est tout à fait légitime, et beaucoup de dirigeants solides fonctionnent ainsi.
>
> Nous vous laissons seulement une phrase. Elle n'est pas de nous : c'est la vôtre. Avant notre échange, à la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> La question pour la semaine : sera-t-elle encore vraie dans un an, si rien ne change ?
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent de cette phrase : ce qui se passe réellement derrière, et pourquoi. Gardez-les, même si nous ne travaillons jamais ensemble.
>
> Adrien & Emily

**[frein_priorite] E5 : Où en êtes-vous ?**
*Pré-en-tête : Si vous voulez faire le point, c'est par ici.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé. Vous vouliez avancer par vous-même : où en êtes-vous ?
>
> Reprenez votre phrase :
>
> >> « {{douleur_citation}}. »
>
> Si elle est moins vraie qu'avant, bravo : c'est le plus difficile, et vous l'avez fait seul.
>
> Si elle l'est toujours autant, nous pouvons refaire le point, 45 minutes :
>
> - ce qui se passe réellement derrière, chez vous ;
> - ce qu'il vaut mieux traiter en premier ;
> - deux ou trois actions concrètes pour les semaines qui viennent.
>
> Vous repartez avec, que nous travaillions ensemble ou non.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily
>
> P.S. Tout roule de votre côté ? Dites-le-nous d'un mot : cela nous fera plaisir de le savoir.

**[frein_general] E1 : Merci pour notre échange**
*Pré-en-tête : Une phrase à garder en tête cette semaine.*

> Bonjour %FIRSTNAME%,
>
> Merci pour le temps que vous nous avez accordé.
>
> Quelle que soit la suite, nous ne voulons pas que cet échange reste sans rien pour vous. Alors nous allons repartir de ce que vous nous aviez écrit avant même de nous parler. À la question « Qu'est-ce qui vous pèse le plus dans votre entreprise ? », vous aviez répondu :
>
> >> « {{douleur_citation}}. »
>
> Dans les prochains jours, nous vous envoyons quelques e-mails courts qui partent de cette phrase : ce qui se passe réellement derrière, et pourquoi. Rien à acheter, rien à préparer.
>
> Adrien & Emily
>
> P.S. Une question vous est venue après notre échange ? Répondez à cet e-mail : nous lisons tout.

**[frein_general] E5 : Où en êtes-vous ?**
*Pré-en-tête : Si vous voulez faire le point, c'est par ici.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé depuis notre échange. Où en êtes-vous ?
>
> Reprenez votre phrase :
>
> >> « {{douleur_citation}}. »
>
> Si elle est toujours vraie, nous pouvons refaire le point ensemble, 45 minutes :
>
> - ce qui se passe réellement derrière, chez vous ;
> - ce qu'il vaut mieux traiter en premier ;
> - deux ou trois actions concrètes pour les semaines qui viennent.
>
> Vous repartez avec, que nous travaillions ensemble ou non.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 1. Rentabilité (`rentabilite`)

Citation : « Je fais du chiffre, mais il ne me reste presque rien à la fin du mois »

**C1 : Vous faites du chiffre. Alors où part l'argent ?**
*Pré-en-tête : Ce n'est presque jamais un problème de chiffre d'affaires.*
*Question : Chez vous, ça ressemble plutôt à quoi ?*

> ![Le chiffre d'affaires monte, ce qui reste ne suit pas](rentabilite.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, nous vous avions demandé ce qui vous pèse le plus dans votre entreprise. Votre réponse :
>
> >> « Je fais du chiffre, mais il ne me reste presque rien à la fin du mois. »
>
> C'est la réponse la plus fréquente : plus d'un dirigeant sur quatre nous dit exactement la même chose.
>
> {{m_sommeil}}
>
> Ce qui frappe, c'est que ces dirigeants ne manquent ni de clients ni de travail. Ils en ont souvent trop. Le chiffre d'affaires est là, parfois en hausse. Et pourtant, le compte ne suit pas.
>
> **Le réflexe : vendre plus**
>
> C'est ce que presque tout le monde tente en premier. Et c'est souvent ce qui aggrave la situation : plus de volume, plus de charges, plus de fatigue, pour le même reste à la fin du mois.
>
> Parce que le problème n'est pas l'argent qui entre. C'est celui qui s'échappe en route.
>
> Et il ne s'échappe pas de la même façon partout. Chez les dirigeants qui nous font votre réponse, trois situations reviennent. Une seule vous ressemblera vraiment.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Plus de travail, même résultat : ce que ça dit de votre entreprise**
*Pré-en-tête : Le volume n'est pas le remède. C'est souvent le problème.*
*Bouton : Je travaille plus qu'avant pour gagner pareil*
*Question : Qu'est-ce qui vous a empêché de regarder ça de près jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est la situation la plus déroutante : le carnet est plein, les journées aussi, et le compte ne bouge pas. On en conclut qu'il faut encore accélérer.
>
> **Ce qui se passe réellement**
>
> Quand une entreprise grandit en volume, tout ne grandit pas au même rythme. Une partie de ce que vous vendez rapporte bien. Une autre vous coûte plus qu'elle ne rapporte, une fois tout compté : votre temps, les reprises, les petits gestes commerciaux. Noyée dans le reste, elle ne se voit pas.
>
> >> Chaque vente en plus de cette partie-là vous fait travailler davantage pour gagner moins.
>
> C'est souvent l'activité dont on est le plus fier, ou le client le plus ancien. C'est pour cela que personne ne la soupçonne.
>
> {{m_marge}}
>
> Vous savez maintenant pourquoi accélérer ne change rien. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Tout a augmenté, sauf vos prix : l'érosion que personne ne voit**
*Pré-en-tête : Aucune hausse ne justifie à elle seule de tout revoir. C'est le piège.*
*Bouton : Tout a augmenté, sauf mes prix*
*Question : Qu'est-ce qui vous a empêché de regarder ça de près jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Matières, énergie, salaires, abonnements, loyer : chaque hausse, prise seule, est supportable. Aucune ne justifie de revoir ses tarifs, d'affronter ses clients, de refaire tous ses calculs. Alors on absorbe.
>
> **Ce qui se passe réellement**
>
> Additionnées sur deux ou trois ans, ces petites hausses ont parfois avalé toute la marge. Sans bruit : le chiffre d'affaires, lui, n'a pas bougé, donc rien n'alerte.
>
> >> Vous n'avez pas perdu de clients. Vous avez perdu, sur chaque vente, un peu de ce qui vous revenait.
>
> Et le plus trompeur : le jour où l'on s'en aperçoit, on pense qu'il suffit d'augmenter ses prix. Ce n'est jamais partout pareil. Certaines de vos offres supportent très bien la hausse des coûts. D'autres ne la supportent plus du tout, et ce ne sont pas celles que l'on croit.
>
> {{m_marge}}
>
> Vous savez maintenant d'où vient l'érosion. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Ce qui vous rapporte vraiment : presque personne ne le sait**
*Pré-en-tête : Le chiffre d'affaires dit ce qui entre. Pas ce qui reste.*
*Bouton : Je ne sais pas ce qui me rapporte vraiment*
*Question : Qu'est-ce qui vous a empêché de regarder ça de près jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est la plus honnête des trois réponses, et la plus courante. Un dirigeant connaît son chiffre d'affaires au jour près. Ce qui reste sur chacune de ses activités, presque personne ne le sait.
>
> **Pourquoi c'est si répandu**
>
> Parce que les comptes ne sont pas faits pour ça. Le bilan arrive une fois par an, des mois après, et il additionne tout. Il dit si l'année a été bonne. Il ne dit pas quelle activité a gagné de l'argent, ni laquelle en a perdu.
>
> >> On pilote alors à l'intuition. Et l'intuition favorise ce qui fait du volume, pas ce qui laisse de la marge.
>
> Résultat : on pousse parfois, de bonne foi, ce qui rapporte le moins.
>
> {{m_marge}}
>
> Vous savez maintenant pourquoi le chiffre d'affaires ne vous dit rien de ce qui vous reste. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Seule de 9 h à 19 h : quand regarder ses chiffres ?**
*Pré-en-tête : « J'ai économisé 15 000 euros sur l'année. »*
*Bouton : Je n'ai pas le temps de me pencher sur mes chiffres*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est la raison la plus légitime qui soit. Quand on produit toute la journée, les chiffres passent après : le soir, le dimanche, ou jamais.
>
> Mais regardez la boucle. On ne regarde pas ses chiffres parce qu'on manque de temps. Et on manque de temps parce qu'il faut travailler toujours plus pour compenser ce que les chiffres auraient montré.
>
> **Delphine était dans cette boucle**
>
> Esthéticienne depuis vingt-cinq ans, seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h. Et chaque mois revenait ce qu'elle appelle « l'angoisse de la tréso permanente ».
>
> Puis elle a posé à plat ce qu'elle n'avait jamais regardé d'ensemble : ses charges, ses contrats, le calcul de ses prestations, l'organisation de ses tâches.
>
> >> « J'ai économisé 15 000 euros sur l'année. »
>
> Et elle termine désormais vers 18 h.
>
> ![Delphine, institut de beauté : voir son témoignage](temoignage-delphine.jpg)(https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais retenez l'ordre des choses : elle n'a pas attendu d'avoir du temps pour regarder. C'est d'avoir regardé qui lui a rendu du temps.
>
> {{choix}}
>
> Adrien & Emily

**C3B : « Avant, j'étais inconscient et j'avais peur »**
*Pré-en-tête : Ne pas savoir par où commencer n'est pas un manque de compétence.*
*Bouton : Je ne sais pas par où commencer*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Ne pas savoir par où commencer, ce n'est pas un manque de compétence. Vous connaissez votre métier mieux que personne. Mais personne ne vous a appris à lire une entreprise, et il y a mille choses que l'on pourrait regarder.
>
> **Ce que ça coûte**
>
> Quand on ne sait pas par où commencer, on fait un peu de tout : on rogne une charge ici, on tente une hausse de prix là, on relance les ventes. Beaucoup d'efforts, dispersés, et le reste à la fin du mois ne change pas.
>
> Franck, boulanger, en était là. Son bilan était dans le rouge, et voici comment il décrit cette période :
>
> >> « Avant, j'étais inconscient et j'avais peur. »
>
> La peur ne venait pas seulement de la situation. Elle venait de ne pas la voir.
>
> ![Franck, boulanger : voir son témoignage](temoignage-franck.jpg)(https://vimeo.com/1204547163)
>
> Cinq mois plus tard, Franck était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois. Et la fin de sa phrase a changé :
>
> >> « Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais ce qui a changé en premier chez lui n'est pas un chiffre : c'est de savoir où regarder.
>
> {{choix}}
>
> Adrien & Emily

**C3C : Le prochain mois sera meilleur. Et s'il ne l'était pas ?**
*Pré-en-tête : Un calcul de deux minutes, à faire au calme.*
*Bouton : Je me dis que le prochain mois sera meilleur*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> On se le dit tous. Après la saison. Après le bilan. Quand ce gros client aura payé. Et parfois, c'est vrai : un bon mois arrive.
>
> Puis le suivant ressemble aux précédents. Parce qu'un bon mois ne change rien à l'endroit par où l'argent s'échappe.
>
> **Le calcul que personne ne fait**
>
> Prenez ce que vous estimez devoir vous verser chaque mois pour le travail que vous fournissez. Retirez ce que vous vous versez vraiment. La différence, multipliée par douze, c'est ce que vous coûte une année de plus dans la même situation.
>
> >> Ce chiffre ne figure dans aucun bilan. C'est pourtant le plus important de votre entreprise.
>
> Et il y a ce qui ne se chiffre pas : les décisions repoussées faute de marge, l'investissement qu'on n'ose pas faire, et la fatigue de travailler autant pour si peu de reste.
>
> Attendre n'est pas neutre. C'est une décision, et elle a un prix.
>
> {{choix}}
>
> Adrien & Emily

**C4 : Ce que votre histoire raconte, mise bout à bout**
*Pré-en-tête : Le problème n'a jamais été votre chiffre d'affaires.*

> Bonjour %FIRSTNAME%,
>
> Depuis quelques jours, nous déroulons une histoire avec vous. La voici en entier.
>
> {{recap}}
>
> **Ce que cela raconte, mis bout à bout**
>
> Prises une par une, ces phrases ressemblent aux tracas ordinaires d'un dirigeant. Ensemble, elles racontent autre chose : une entreprise qui gagne de l'argent, et un dirigeant qui n'a aucun moyen de voir par où il repart.
>
> >> Le problème n'a jamais été votre chiffre d'affaires, ni votre travail. C'est que vous pilotez sans voir ce qui reste.
>
> Cela ne se règle ni en vendant plus, ni en travaillant plus : vous l'avez déjà fait.
>
> {{m_12mois}}
>
> {{fin}}
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Je veux voir clair, chiffres en main*

> Voir clair, chiffres en main : c'est exactement l'objet de 45 minutes d'audit. Nous partons de vos chiffres réels, pas de généralités, pour trouver l'endroit précis par où l'argent s'en va. Vous n'avez rien à préparer.

**C4B**
*Bouton : Je me demande si ça vaut pour mon métier*

> Vous vous demandez si cela vaut pour votre métier, et la question est saine. Boulanger, esthéticienne, boucher, restauratrice : les dirigeants que nous accompagnons n'ont pas le même métier, et la question de ce qui reste s'est posée pour chacun. Si votre cas est différent, 45 minutes d'audit suffisent pour le voir, et nous vous le dirons.

**C4C**
*Bouton : Je sais qu'il faut bouger, mais je repousse*

> Savoir qu'il faut bouger et repousser, c'est la position la plus courante, et elle se comprend. Mais relisez les phrases ci-dessus : rien de ce qu'elles décrivent ne s'arrange en attendant. La seule chose qui change avec le temps, c'est le montant. 45 minutes d'audit suffisent pour savoir par où commencer.

**C4N**

> Si cette histoire ressemble à la vôtre, reprenons 45 minutes ensemble. Nous partons de vos chiffres réels, et vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.

---

## 2. Opérationnel (`operationnel`)

Citation : « Je suis noyé dans l'opérationnel, je n'ai plus une minute pour piloter »

**C1 : Plus une minute pour piloter. Ce n'est pas une question de temps.**
*Pré-en-tête : Tout ce que vous avez tenté a ajouté du travail au lieu d'en enlever.*
*Question : Chez vous, ça ressemble plutôt à quoi ?*

> ![Des journées pleines, et aucune place pour piloter](operationnel.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, nous vous avions demandé ce qui vous pèse le plus dans votre entreprise. Votre réponse :
>
> >> « Je suis noyé dans l'opérationnel, je n'ai plus une minute pour piloter. »
>
> {{m_heures}}
>
> {{m_duree}}
>
> {{m_tente}}
>
> Si vous regardez tout ce que vous avez tenté pour vous en sortir, vous verrez un point commun : chaque solution a ajouté quelque chose. Une personne à former, un outil à apprendre, des heures en plus.
>
> **Le piège**
>
> On croit manquer de temps. Alors on cherche du temps : on se lève plus tôt, on finit plus tard, on embauche. Et quelques mois après, les journées sont de nouveau pleines.
>
> Parce que le temps n'est pas la cause. C'est le symptôme.
>
> Et ce symptôme ne prend pas la même forme partout. Chez les dirigeants qui nous font votre réponse, trois situations reviennent. Une seule vous ressemblera vraiment.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Pourquoi tout arrive sur votre bureau**
*Pré-en-tête : Le travail va vers celui qui sait.*
*Bouton : Je passe mes journées à répondre aux questions et aux urgences*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Vous arrivez le matin avec un plan. À 9 h 30, il n'en reste rien : un client, un salarié, un fournisseur, un imprévu. Le soir, vous avez beaucoup fait, et rien avancé.
>
> **Ce qui se passe réellement**
>
> Dans une entreprise, les questions vont vers celui qui sait, et les décisions vers celui qui peut trancher. Quand c'est la même personne pour presque tout, cette personne devient le passage obligé de tout ce qui bouge.
>
> >> Vous n'êtes pas interrompu parce que votre équipe est faible. Vous l'êtes parce que le savoir et les décisions sont rangés dans une seule tête.
>
> C'est aussi pour cela que bloquer du temps dans l'agenda ne tient pas : le créneau existe, mais vous restez le seul à pouvoir répondre.
>
> {{m_2semaines}}
>
> Vous savez maintenant pourquoi vos journées vous échappent. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2B : « Ça ira plus vite si je le fais moi-même »**
*Pré-en-tête : C'est vrai aujourd'hui. C'est ce qui vous coûte demain.*
*Bouton : Je fais moi-même ce que je devrais confier*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Expliquer prend vingt minutes. Faire prend dix. Alors vous faites. Et ce jour-là, vous avez raison.
>
> **Ce qui se passe réellement**
>
> Chaque fois que vous faites à la place de quelqu'un, deux choses arrivent. Vous gagnez dix minutes. Et la tâche vous appartient un peu plus : la prochaine fois, c'est encore vers vous qu'elle reviendra, parce que personne d'autre n'a appris.
>
> >> Ce n'est pas un manque de confiance en votre équipe. C'est un calcul juste à la journée, et faux à l'année.
>
> Voilà pourquoi une embauche soulage si peu : la nouvelle personne arrive dans une entreprise où tout ce qui compte passe déjà par vos mains.
>
> {{m_autonome}}
>
> {{m_charge}}
>
> Vous savez maintenant pourquoi la liste de ce que vous faites vous-même ne raccourcit jamais. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Votre vrai travail commence quand les autres partent**
*Pré-en-tête : Le soir ne sert pas à travailler plus.*
*Bouton : Mon vrai travail commence quand tout le monde est parti*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> La journée appartient aux autres : clients, équipe, téléphone. Les devis, les commandes, les chiffres, la réflexion, tout ce qui demande du calme attend 19 heures, ou le dimanche.
>
> **Ce qui se passe réellement**
>
> Le soir ne vous sert pas à travailler plus. Il sert à faire ce que l'organisation de la journée n'a pas permis. Tant que la journée reste la même, vos soirées sont prises d'avance.
>
> >> Et ce qui passe en dernier, c'est toujours le pilotage : regarder les chiffres, préparer la suite, décider. Le travail que vous seul pouvez faire.
>
> Commencer plus tôt ou finir plus tard n'y change rien : la journée s'étend, puis se remplit à nouveau.
>
> {{m_heures}}
>
> Vous savez maintenant pourquoi le pilotage passe toujours après. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Pas le temps de réorganiser ? Regardez ce qu'a fait Margaux**
*Pré-en-tête : « Je peux enfin déléguer. »*
*Bouton : Je n'ai pas le temps de réorganiser quoi que ce soit*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est le piège parfait : il faudrait du temps pour s'organiser, et c'est justement faute d'organisation qu'il n'y en a pas. Alors on remet. Et chaque mois de plus rend l'entreprise un peu plus dépendante de vous.
>
> **Margaux en est sortie**
>
> Elle a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Deux activités, une équipe, et elle se sentait seule face à toutes les décisions.
>
> Elle n'a pas travaillé plus. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Trois mois plus tard, avec ses mots :
>
> >> « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Et la phrase qui compte le plus, pour quelqu'un qui n'a plus une minute :
>
> >> « Je peux enfin déléguer. »
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais remarquez d'où il vient : pas d'heures en plus. D'une autre façon de répartir le travail.
>
> {{choix}}
>
> Adrien & Emily

**C3B : Par où commencer ? Une boulangère a regardé là où on ne regarde pas**
*Pré-en-tête : « J'avais une équipe de vente qui me bouffait littéralement. »*
*Bouton : Je ne sais pas par où commencer*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Quand on est noyé, tout paraît urgent, donc rien ne paraît premier. On essaie un outil, une réunion, une embauche. Chaque tentative ajoute du travail avant d'en enlever, et la plupart s'arrêtent en route.
>
> **Ce que ça coûte**
>
> Des efforts dépensés au mauvais endroit. Et, peu à peu, l'idée que « chez moi, ça ne marche pas ».
>
> Une boulangère que nous accompagnons en était là. Ouverte sept jours sur sept, elle décrivait son quotidien ainsi :
>
> >> « J'avais une équipe de vente qui me bouffait littéralement. »
>
> Le problème n'était ni elle, ni vraiment son équipe : c'était la façon dont le travail était organisé entre eux. Une fois ce point trouvé, le reste a suivi : une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés.
>
> Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés.
>
> ![Une boulangère ouverte 7 jours sur 7 : voir son témoignage](temoignage-boulangere.jpg)(https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais retenez ceci : elle n'a pas tout changé d'un coup. Elle a trouvé par quoi commencer.
>
> {{choix}}
>
> Adrien & Emily

**C3C : « Ça ira mieux après cette période »**
*Pré-en-tête : Il y a toujours une période après la période.*
*Bouton : Je me dis que ça ira mieux après cette période*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Après la saison. Après le chantier. Quand le nouveau sera formé. Il y a toujours une bonne raison, et elle est vraie à chaque fois.
>
> Puis une autre période commence.
>
> {{m_duree}}
>
> **Ce qui n'est pas fait pendant ce temps**
>
> Pendant que vous produisez, dépannez et rattrapez, personne ne regarde les chiffres, ne prépare la suite, ne remarque le client qui s'éloigne ou le salarié qui décroche. Ce sont les tâches que vous seul pouvez faire, et ce sont les premières sacrifiées.
>
> **Ce qui s'installe**
>
> Chaque mois de plus rend l'entreprise un peu plus dépendante de vous. Ce qui se réorganise facilement aujourd'hui sera plus lourd à changer dans un an.
>
> >> Une entreprise qui ne tient que par son dirigeant ne grandit pas : elle s'use à sa vitesse.
>
> Attendre n'est pas neutre. C'est une décision, et elle a un prix.
>
> {{choix}}
>
> Adrien & Emily

**C4 : Ce que votre histoire raconte, mise bout à bout**
*Pré-en-tête : Et pourquoi rien de ce que vous avez tenté n'a tenu.*

> Bonjour %FIRSTNAME%,
>
> Depuis quelques jours, nous déroulons une histoire avec vous. La voici en entier.
>
> {{recap}}
>
> **Ce que cela raconte, mis bout à bout**
>
> Prises une par une, ces phrases ressemblent aux tracas ordinaires d'un dirigeant. Ensemble, elles racontent autre chose : une entreprise qui s'est organisée, année après année, autour d'une seule personne. Vous.
>
> >> Vous ne manquez pas de temps. Vous occupez, seul, une place que toute l'organisation devrait se partager.
>
> C'est pour cela que ni les heures en plus, ni les outils, ni les embauches n'ont suffi. Et c'est une bonne nouvelle : une organisation, ça se redessine.
>
> {{m_temps}}
>
> {{fin}}
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Je veux savoir par quoi commencer chez moi*

> Par quoi commencer chez vous : c'est exactement la question à laquelle répondent 45 minutes d'audit. Nous partons de votre semaine réelle, pas d'une méthode toute faite, pour trouver ce qui libérerait la première heure. Vous n'avez rien à préparer.

**C4B**
*Bouton : Je me demande si c'est possible dans mon métier*

> Vous vous demandez si c'est possible dans votre métier, et la question est saine. Une épicerie avec restaurant, une boulangerie ouverte sept jours sur sept, un institut de beauté tenu par une seule personne : tous étaient pris dans leur quotidien. Si votre cas est différent, 45 minutes d'audit suffisent pour le voir, et nous vous le dirons.

**C4C**
*Bouton : Je sais qu'il faut bouger, mais je repousse*

> Savoir qu'il faut bouger et repousser, c'est la position la plus courante, et elle se comprend : quand on est noyé, il n'y a jamais de bon moment. C'est précisément pour cela qu'il ne viendra pas tout seul. 45 minutes d'audit suffisent pour savoir par quoi commencer.

**C4N**

> Si cette histoire ressemble à la vôtre, reprenons 45 minutes ensemble. Nous partons de votre semaine réelle, et vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.

---

## 3. Vie avalée (`vie`)

Citation : « Mon entreprise a avalé ma vie : soirées, week-ends et vacances y passent »

**C1 : Soirées, week-ends, vacances : votre entreprise a tout pris**
*Pré-en-tête : Travailler plus n'a jamais rendu une seule soirée.*
*Question : Votre dernière soirée passée au travail, c'était plutôt…*

> ![Il est tard, et la lumière du bureau est encore allumée](vie.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, nous vous avions demandé ce qui vous pèse le plus dans votre entreprise. Votre réponse :
>
> >> « Mon entreprise a avalé ma vie : soirées, week-ends et vacances y passent. »
>
> {{m_duree}}
>
> {{m_rythme}}
>
> Personne ne monte son entreprise pour ça. On la monte pour être libre, pour décider, pour mieux vivre. Et un jour on s'aperçoit que c'est elle qui décide : de l'heure du dîner, du week-end, de la date des vacances.
>
> **Le réflexe : tenir**
>
> Encore ce mois-ci, encore cette saison, « après, ça ira mieux ». Sauf que chaque heure donnée en plus devient la norme du mois suivant. L'entreprise s'habitue à votre présence comme à une ressource gratuite.
>
> Ce qui vous retient le soir n'est presque jamais ce que vous croyez : ni la charge, ni les clients, ni la conscience professionnelle.
>
> Faites le test. Repensez à votre dernière soirée passée au travail. Que faisiez-vous, précisément ?
>
> {{choix}}
>
> Adrien & Emily

**C2A : Ce que vous seul savez faire : la vraie raison de vos soirées**
*Pré-en-tête : Tant que c'est dans votre tête, c'est dans vos soirées.*
*Bouton : Je faisais ce que je suis seul à savoir faire*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Les devis, la paie, les commandes, ce dossier délicat. Personne d'autre ne sait, donc cela attend le soir, quand vous êtes enfin tranquille.
>
> **Ce qui se passe réellement**
>
> Ce savoir, vous l'avez construit en années. Il n'est écrit nulle part, parce que vous n'en avez jamais eu besoin : vous, vous savez. Mais ce qui n'existe que dans une tête ne peut être fait que par cette tête.
>
> >> Vos soirées ne sont pas prises par le travail. Elles sont prises par tout ce que vous êtes le seul à pouvoir faire.
>
> Et plus l'entreprise grandit, plus cette liste s'allonge. C'est pour cela que tenir ne règle rien.
>
> {{m_2semaines}}
>
> Vous savez maintenant ce qui remplit vos soirées. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2B : La journée appartient aux autres. Le soir, c'est votre tour.**
*Pré-en-tête : Votre vrai travail commence quand ils partent.*
*Bouton : Je faisais ce que la journée ne m'a pas laissé faire*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Dans la journée, vous êtes à tout le monde : clients, équipe, téléphone, imprévus. Votre propre travail attend que le calme revienne. Il revient vers 19 heures.
>
> **Ce qui se passe réellement**
>
> Le soir ne vous sert pas à travailler plus. Il sert à faire ce que l'organisation de la journée n'a pas permis.
>
> >> Tant que la journée reste la même, le soir est pris d'avance. Et le week-end sert à finir la semaine.
>
> Travailler plus vite n'y change rien : chaque minute gagnée dans la journée est aussitôt remplie par une question de plus.
>
> {{m_heures}}
>
> Vous savez maintenant pourquoi vos soirées sont prises avant même de commencer. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Rattraper : le travail qu'aucun client ne paie**
*Pré-en-tête : Chaque soirée de rattrapage a une cause, dans la journée.*
*Bouton : Je rattrapais : une erreur, un retard, un client*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> L'erreur à corriger, la commande à refaire, le client à rassurer, le retard à combler. Du travail que personne ne vous paie, fait aux heures où vous devriez être ailleurs.
>
> **Ce qui se passe réellement**
>
> Une erreur isolée, c'est la vie d'une entreprise. Des soirées entières de rattrapage, c'est autre chose : le signe que quelque chose, dans la journée, fabrique ces erreurs. Une consigne floue, un contrôle qui n'existe pas, une tâche confiée sans que personne sache précisément ce qui est attendu.
>
> >> Vous ne rattrapez pas vos salariés. Vous rattrapez une organisation qui ne leur dit pas comment bien faire sans vous.
>
> C'est pour cela que tenir ne règle rien : ce que vous réparez ce soir se reproduira la semaine prochaine.
>
> {{m_consignes}}
>
> Vous savez maintenant d'où viennent vos soirées de rattrapage. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C3A : « J'ai fait plaisir à tout le monde, sauf à moi-même »**
*Pré-en-tête : Alexandre avait la tête dans le guidon. Il passe à table à 19 h 30.*
*Bouton : Je n'ai pas le temps de m'en occuper*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Quand l'entreprise prend toutes les heures, il n'en reste aucune pour se demander comment faire autrement. C'est le cercle le plus solide qui soit.
>
> **Alexandre y était**
>
> Boucher-charcutier-traiteur, son chiffre d'affaires montait. De l'extérieur, tout allait bien. De l'intérieur, il avait, selon ses mots, « la tête dans le guidon ».
>
> Un soir, une fois tout le monde payé, il a fait ce constat :
>
> >> « J'ai fait plaisir à tout le monde, sauf à moi-même. »
>
> ![Alexandre, boucher-charcutier-traiteur : voir son témoignage](temoignage-alexandre.jpg)(https://drive.google.com/file/d/1tPEoSaGRAGXZmo_h0x16eb8gWfl3aDBK/view)
>
> Aujourd'hui, ses marges sont reprises, ses fiches de production sont calées, et à 19 h 30 il passe à table avec toute sa famille.
>
> Son parcours n'est pas une promesse pour le vôtre. Mais ses soirées ne sont pas revenues parce qu'il a levé le pied : elles sont revenues parce que l'entreprise a été organisée autrement.
>
> Son conseil à ceux qui hésitent : demandez-vous plutôt combien vous allez perdre à attendre.
>
> {{choix}}
>
> Adrien & Emily

**C3B : « Dans mon métier, c'est comme ça » : Delphine l'a cru vingt-cinq ans**
*Pré-en-tête : Elle termine désormais à 18 h.*
*Bouton : Je ne vois pas comment faire autrement dans mon métier*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est l'une des phrases que nous entendons le plus. Commerce, artisanat, restauration, soin : dans chaque métier, on apprend que les horaires sans fin font partie du prix à payer quand on est à son compte.
>
> Et tant qu'on le croit, on ne cherche pas.
>
> **Delphine l'a cru pendant vingt-cinq ans**
>
> Esthéticienne, seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h. Et par-dessus les heures, il y avait ce qu'elle appelle « l'angoisse de la tréso permanente ».
>
> Les deux vont souvent ensemble : on travaille tard parce que l'argent inquiète, et l'argent inquiète parce qu'on n'a jamais le temps de le regarder en face.
>
> Elle a posé à plat ses charges, ses contrats, le calcul de ses prestations, l'organisation de ses tâches.
>
> >> « J'ai économisé 15 000 euros sur l'année. »
>
> Et elle termine désormais vers 18 h.
>
> ![Delphine, institut de beauté : voir son témoignage](temoignage-delphine.jpg)(https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Une heure par jour, cela paraît peu. Sur une année, c'est plus d'un mois de soirées retrouvées.
>
> Son résultat lui appartient, et ce n'est pas une promesse pour vous. Mais son métier n'a pas changé : c'est la façon de l'exercer qui a bougé.
>
> {{choix}}
>
> Adrien & Emily

**C3C : « Après cette saison, ça ira mieux »**
*Pré-en-tête : Certaines choses ne se rattrapent pas.*
*Bouton : Je me dis que ça ira mieux après cette saison*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Les soirées, les week-ends, les vacances : on se dit qu'on se rattrapera. Quand l'entreprise ira mieux. Quand l'équipe sera en place. L'an prochain.
>
> Le problème, c'est que ce temps-là ne se met pas de côté.
>
> **Ce qui s'use**
>
> La forme, d'abord : on tient, jusqu'au jour où l'on ne tient plus. La lucidité, ensuite : les meilleures décisions ne se prennent pas à 22 heures, après quatorze heures de travail.
>
> **Ce qui ne revient pas**
>
> Un dîner manqué se rattrape. Une année de dîners manqués, non.
>
> >> Votre entreprise peut attendre une semaine. Certaines choses, autour de vous, n'attendent pas.
>
> Et il y a un paradoxe : plus vous donnez d'heures, plus l'entreprise s'organise autour de votre présence. Attendre ne rapproche pas du moment où elle pourra s'en passer. Cela l'éloigne.
>
> {{choix}}
>
> Adrien & Emily

**C4 : Ce que votre histoire raconte, mise bout à bout**
*Pré-en-tête : Vous ne travaillez pas trop. C'est autre chose.*

> Bonjour %FIRSTNAME%,
>
> Depuis quelques jours, nous déroulons une histoire avec vous. La voici en entier.
>
> {{recap}}
>
> **Ce que cela raconte, mis bout à bout**
>
> Prises une par une, ces phrases ressemblent à la vie normale d'un dirigeant. Ensemble, elles racontent autre chose : une entreprise qui s'est habituée à votre présence comme à une ressource gratuite, et qui en demande un peu plus chaque année.
>
> >> Vous ne travaillez pas trop par manque de volonté ou d'efficacité. Votre entreprise est organisée de telle façon qu'elle a besoin de toutes vos heures.
>
> Tenir ne changera donc rien. Mais une organisation, ça se redessine. Les années, non.
>
> {{m_temps}}
>
> {{fin}}
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Je veux savoir ce qui me rendrait du temps, concrètement*

> Concrètement : c'est le mot juste. Pendant 45 minutes d'audit, nous partons de vos journées réelles pour trouver ce qui vous rendrait la première soirée. Vous n'avez rien à préparer.

**C4B**
*Bouton : J'ai peur que tout s'écroule si je lève le pied*

> Vous craignez que tout s'écroule si vous levez le pied, et vous avez raison : lever le pied sans rien changer, cela ne marche pas. Il ne s'agit pas de travailler moins du jour au lendemain, mais d'organiser autrement, pour que votre absence ne se voie plus. Par où commencer sans rien mettre en danger : c'est ce que nous regardons ensemble pendant 45 minutes d'audit.

**C4C**
*Bouton : Je sais qu'il faut bouger, mais je repousse*

> Savoir qu'il faut bouger et repousser, c'est la position la plus courante, et elle se comprend. Mais ce temps-là ne se met pas de côté. 45 minutes d'audit suffisent pour savoir par quoi commencer, et c'est sans doute moins que ce que l'entreprise vous a pris hier soir.

**C4N**

> Si cette histoire ressemble à la vôtre, reprenons 45 minutes ensemble. Nous partons de vos journées réelles, et vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.

---

## 4. Équipe (`equipe`)

Citation : « Mes salariés viennent me voir pour tout : rien n'avance sans moi »

**C1 : Rien n'avance sans vous. Et ce n'est pas la faute de votre équipe.**
*Pré-en-tête : Une équipe qui remonte tout n'est pas une équipe incapable.*
*Question : Chez vous, ça ressemble plutôt à quoi ?*

> ![Toutes les questions arrivent au même endroit](equipe.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, nous vous avions demandé ce qui vous pèse le plus dans votre entreprise. Votre réponse :
>
> >> « Mes salariés viennent me voir pour tout : rien n'avance sans moi. »
>
> {{m_consignes}}
>
> {{m_tente}}
>
> À ce stade, la conclusion paraît évidente : il faudrait une meilleure équipe. Des gens plus autonomes, plus impliqués, qui réfléchissent avant de venir vous voir.
>
> **Sauf que le même scénario se répète avec chaque recrue**
>
> Les premières semaines, elle prend des initiatives. Puis elle se trompe une fois, vous rattrapez, et elle comprend la règle : ici, mieux vaut demander.
>
> Une équipe qui remonte tout n'est pas une équipe incapable. C'est une équipe à qui il manque quelque chose de précis pour décider seule. Et ce quelque chose n'est ni la compétence, ni la motivation.
>
> Ce qui manque n'est pas la même chose partout. Chez les dirigeants qui nous font votre réponse, trois situations reviennent. Une seule vous ressemblera vraiment.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Pourquoi votre équipe attend votre feu vert**
*Pré-en-tête : Pour un salarié, la décision la plus prudente est de ne pas en prendre.*
*Bouton : On attend mon feu vert pour la moindre décision*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Un geste commercial, une commande urgente, un client mécontent : la question arrive chez vous, même quand la réponse est évidente.
>
> **Ce qui se passe réellement**
>
> Votre équipe sait souvent quoi faire. Ce qu'elle ne sait pas, c'est si elle a le droit de le décider. Jusqu'où peut-elle aller seule ? Personne ne l'a jamais dit clairement, parce que jusqu'ici vous étiez toujours là pour trancher.
>
> >> Sans limite claire, la décision la plus prudente pour un salarié est de ne pas en prendre.
>
> Ce n'est pas un manque d'initiative. De leur point de vue, c'est du bon sens.
>
> {{m_autonome}}
>
> Vous savez maintenant pourquoi tout attend votre feu vert. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Rarement fait comme vous le voulez : ce que votre équipe ne peut pas deviner**
*Pré-en-tête : Le résultat attendu n'existe que dans votre tête.*
*Bouton : Je repasse derrière : c'est rarement fait comme je veux*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Vous confiez, on fait, vous regardez : ce n'est pas ça. Alors vous corrigez, ou vous refaites. Et la fois suivante, vous hésitez à confier.
>
> **Ce qui se passe réellement**
>
> « Bien faire », pour vous, c'est une image très précise, construite en années de métier. Pour votre équipe, c'est une devinette. Tant que le résultat attendu n'existe que dans votre tête, il n'y a que deux façons de le connaître : vous le demander, ou se tromper.
>
> >> Et chaque « laisse, je vais le faire » enseigne la même leçon : le patron préfère faire lui-même.
>
> C'est aussi pour cela que répéter ne change rien : une consigne dit quoi faire aujourd'hui, pas comment décider demain.
>
> {{m_autonome}}
>
> Vous savez maintenant pourquoi vous repassez derrière. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Dès qu'il y a un imprévu, c'est pour vous**
*Pré-en-tête : Votre équipe sait suivre la route. Pas quoi faire quand elle dévie.*
*Bouton : Dès qu'il y a un imprévu, c'est pour moi*
*Question : Qu'est-ce qui vous a empêché de changer ça jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Tant que tout se passe comme prévu, l'équipe tourne. Un fournisseur en retard, un client qui conteste, une machine en panne, un collègue absent : tout s'arrête, et tout le monde vous regarde.
>
> **Ce qui se passe réellement**
>
> Votre équipe a appris les gestes du quotidien. Les imprévus, c'est vous qui les avez toujours réglés : vite, bien, et seul. Personne n'a donc jamais vu comment vous raisonnez dans ces moments-là.
>
> >> Ce que votre équipe ne sait pas faire, c'est exactement ce qu'elle ne vous a jamais vu expliquer.
>
> Et comme il y a un imprévu presque chaque jour, vos journées leur appartiennent.
>
> {{m_2semaines}}
>
> Vous savez maintenant pourquoi les imprévus finissent tous chez vous. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Pas le temps d'expliquer ? Faites le compte, une seule fois**
*Pré-en-tête : Ce temps-là, vous le payez deux fois.*
*Bouton : Je n'ai pas le temps de former ni d'expliquer*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Expliquer prend du temps, et vous n'en avez pas. C'est vrai. Mais faites le compte, une seule fois.
>
> **Le compte**
>
> Combien de fois par jour êtes-vous interrompu pour une question, une validation, un « je fais comment ? ». Multipliez par le temps qu'il vous faut pour répondre, puis pour retrouver le fil de ce que vous faisiez.
>
> >> Ce temps-là, vous le payez deux fois : le vôtre, et celui du salarié qui attend votre réponse.
>
> Autrement dit : le temps que vous n'avez pas pour expliquer, vous le dépensez déjà, chaque jour, à répondre.
>
> **Margaux connaissait cette situation**
>
> Elle a ouvert sa première entreprise en 2023, une épicerie fine avec un restaurant italien, et elle se sentait seule face à toutes les décisions. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> >> « Je peux enfin déléguer. »
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Trois mois plus tard, avec ses mots : « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais il dit une chose : une équipe qui décide, c'est un dirigeant qui retrouve du temps.
>
> {{choix}}
>
> Adrien & Emily

**C3B : Par où commencer avec une équipe ? Ce qu'a fait une boulangère**
*Pré-en-tête : « J'avais une équipe de vente qui me bouffait littéralement. »*
*Bouton : Je ne sais pas par où commencer*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avec une équipe, tout paraît lié : les personnes, les plannings, les habitudes, votre propre façon de faire. On ne sait pas quel fil tirer, alors on répète les consignes un peu plus fort.
>
> **Ce que ça coûte**
>
> De l'énergie, surtout. La vôtre, dépensée à redire. Et celle de l'équipe, qui sent bien que quelque chose ne va pas sans savoir quoi changer.
>
> Une boulangère que nous accompagnons en était là. Ouverte sept jours sur sept, voici comment elle décrivait son équipe :
>
> >> « J'avais une équipe de vente qui me bouffait littéralement. »
>
> Le mot est fort. Il dit bien ce que vivent beaucoup de dirigeants : une équipe censée soulager, et qui prend toute l'énergie.
>
> Ce qu'elle a changé : une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés. Pas seulement les personnes, donc, mais la façon dont le travail est réparti entre elles.
>
> ![Une boulangère ouverte 7 jours sur 7 : voir son témoignage](temoignage-boulangere.jpg)(https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés. Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais elle n'a pas tiré tous les fils à la fois : elle a trouvé le premier.
>
> {{choix}}
>
> Adrien & Emily

**C3C : De meilleures recrues ? Ce que coûte cette idée**
*Pré-en-tête : Ce n'est pas une question de personnes.*
*Bouton : Je me dis qu'il me faudrait surtout de meilleures recrues*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est la conclusion la plus naturelle : avec des gens plus autonomes, tout irait mieux. Et il arrive, bien sûr, qu'un recrutement soit une erreur.
>
> **Ce que coûte cette idée**
>
> Un recrutement, ce sont des mois : chercher, intégrer, former. Si la nouvelle personne arrive dans la même organisation, elle prend les mêmes habitudes que les autres. Vous repartez de zéro, avec une déception de plus.
>
> **Ce qui s'installe pendant ce temps**
>
> Vos meilleurs éléments finissent par se lasser de demander la permission. Les autres s'habituent à ne plus décider. Et le jour où vous êtes absent, tout s'arrête.
>
> >> Les mêmes personnes se comportent tout autrement dès qu'elles savent ce qu'on attend d'elles et jusqu'où elles peuvent décider.
>
> Ce n'est pas une question de personnes. C'est une question de cadre. Et chaque mois de plus ancre un peu plus l'habitude, chez eux comme chez vous.
>
> {{choix}}
>
> Adrien & Emily

**C4 : Ce que votre histoire raconte, mise bout à bout**
*Pré-en-tête : Votre équipe ne manque ni de compétence, ni de bonne volonté.*

> Bonjour %FIRSTNAME%,
>
> Depuis quelques jours, nous déroulons une histoire avec vous. La voici en entier.
>
> {{recap}}
>
> **Ce que cela raconte, mis bout à bout**
>
> Prises une par une, ces phrases ressemblent aux tracas ordinaires d'un patron. Ensemble, elles racontent autre chose : une équipe qui a appris, année après année, que la meilleure façon de bien faire était de passer par vous.
>
> >> Votre équipe ne manque ni de compétence, ni de bonne volonté. Il lui manque un cadre pour décider sans vous.
>
> Répéter les consignes, recruter, surveiller de plus près : rien de tout cela ne construit ce cadre. C'est pour cela que rien n'a changé.
>
> {{m_12mois}}
>
> {{fin}}
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Je veux savoir ce qui manque à mon équipe pour décider*

> Ce qui manque précisément à votre équipe : en 45 minutes d'audit, cela se voit. Nous partons des questions qu'on vous pose dans une journée ordinaire, et de ce qui se passe quand vous n'êtes pas là. Vous n'avez rien à préparer.

**C4B**
*Bouton : Et si le problème venait vraiment de mes salariés ?*

> Et si le problème venait vraiment de vos salariés ? C'est possible, et nous vous le dirons si c'est le cas. Mais on ne peut le savoir qu'après avoir regardé le cadre dans lequel ils travaillent. C'est par là que commencent 45 minutes d'audit.

**C4C**
*Bouton : Je sais qu'il faut bouger, mais je repousse*

> Savoir qu'il faut bouger et repousser, c'est la position la plus courante, et elle se comprend. Mais une habitude d'équipe ne s'efface pas en attendant : elle s'ancre. Ce qui se change simplement aujourd'hui sera plus lourd dans un an. 45 minutes d'audit suffisent pour savoir par quoi commencer.

**C4N**

> Si cette histoire ressemble à la vôtre, reprenons 45 minutes ensemble. Nous partons de ce que vous vivez avec votre équipe, et vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.

---

## 5. Plafond (`plafond`)

Citation : « Mon chiffre d'affaires plafonne, malgré tous mes efforts »

**C1 : Vous faites tout ce qu'il faut, et le chiffre ne bouge plus**
*Pré-en-tête : Un plafond vient rarement des ventes.*
*Question : Avec 30 % de commandes en plus, chez vous…*

> ![Le chiffre d'affaires bute sur un plafond](plafond.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, nous vous avions demandé ce qui vous pèse le plus dans votre entreprise. Votre réponse :
>
> >> « Mon chiffre d'affaires plafonne, malgré tous mes efforts. »
>
> {{m_levier}}
>
> « Malgré tous mes efforts » : tout est dans ces mots. Vous ne restez pas les bras croisés. Vous prospectez, vous communiquez, vous relancez. Et le chiffre reste, à peu de chose près, où il était.
>
> **Le réflexe : pousser plus fort**
>
> Plus de publicité, plus de démarchage, une nouvelle offre. Chaque effort donne un petit sursaut, puis le chiffre retombe à son niveau habituel. Comme s'il existait un plafond invisible.
>
> Il existe. Et il est rarement là où on le cherche.
>
> Pour le trouver, une question suffit. Imaginez que vous receviez, dès demain, 30 % de commandes en plus. Que se passerait-il ?
>
> {{choix}}
>
> Adrien & Emily

**C2A : Votre entreprise vend ce qu'elle peut absorber**
*Pré-en-tête : Le plafond n'est pas du côté des ventes.*
*Bouton : On ne pourrait pas suivre : retards, erreurs, équipe débordée*
*Question : Qu'est-ce qui vous a empêché de vous y attaquer jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Des retards, des erreurs, une équipe débordée, et vous au milieu pour tout rattraper. Vous connaissez la scène : vous l'avez sans doute déjà vécue, lors d'un pic d'activité.
>
> **Ce qui se passe réellement**
>
> >> Une entreprise ne vend pas ce que le marché peut acheter. Elle vend ce qu'elle est capable d'absorber.
>
> Quand la limite approche, vous levez le pied sur le commercial, sans même y penser, jusqu'à ce que le calme revienne. Le chiffre retombe à son niveau habituel. Ce niveau n'est pas un hasard : c'est exactement ce que votre organisation actuelle sait produire correctement.
>
> Voilà pourquoi pousser plus fort sur les ventes ne change rien : on remplit un verre déjà plein.
>
> {{m_charge}}
>
> Vous savez maintenant où se trouve votre plafond : pas chez vos clients. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Plus de chiffre, pas plus de résultat : l'autre plafond**
*Pré-en-tête : Faire grandir ce qui entre n'est pas toujours la bonne bataille.*
*Bouton : Je travaillerais beaucoup plus, sans gagner beaucoup plus*
*Question : Qu'est-ce qui vous a empêché de vous y attaquer jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Vous pourriez vendre plus, au prix de semaines encore plus lourdes. Et au bout, pas grand-chose de plus pour vous.
>
> **Ce qui se passe réellement**
>
> Votre plafond n'est pas seulement sur le chiffre d'affaires. Il est sur ce qui reste. Quand chaque vente supplémentaire demande presque autant de travail et de charges qu'elle rapporte, grandir ne sert qu'à s'épuiser.
>
> >> Un chiffre d'affaires qui monterait sans que le résultat suive, c'est un plafond déguisé.
>
> Dans ce cas, s'acharner sur les ventes est la bataille la plus coûteuse. Faire grandir ce qui reste est parfois plus rapide que faire grandir ce qui entre.
>
> {{m_charge}}
>
> Vous savez maintenant que votre plafond n'est pas là où vous poussez. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Ce sont les clients qui manquent. Vraiment ?**
*Pré-en-tête : Chaque effort donne un sursaut, puis le chiffre retombe.*
*Bouton : On suivrait sans problème : ce sont les clients qui manquent*
*Question : Qu'est-ce qui vous a empêché de vous y attaquer jusqu'ici ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est possible : il arrive que le plafond soit bien du côté des ventes. Mais un détail mérite votre attention.
>
> Vous n'êtes pas resté les bras croisés. Publicité, démarchage, nouvelle offre : chaque effort a donné un sursaut. Puis le chiffre est revenu à son niveau habituel.
>
> **Ce qui se passe réellement**
>
> Si le problème était seulement le manque de clients, vos efforts auraient laissé une trace durable. Un chiffre qui retombe toujours au même endroit dit autre chose : les clients arrivent, puis quelque chose ne suit pas. Le suivi, la relance, la fidélité, le temps que vous pouvez consacrer à chacun.
>
> >> Quand le dirigeant fait à la fois la vente et tout le reste, le commercial s'arrête chaque fois que le reste déborde.
>
> Le plafond n'est alors pas dans le marché. Il est dans la place que la vente peut prendre dans vos semaines.
>
> Vous savez maintenant pourquoi vos efforts retombent. Reste une question, plus importante qu'il n'y paraît.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Pas le temps ? C'est peut-être là qu'est votre plafond**
*Pré-en-tête : « Mon chiffre d'affaires a augmenté de 20 %. »*
*Bouton : Je n'ai pas le temps de m'y pencher*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Si vous n'avez pas le temps de vous pencher sur votre plafond, c'est peut-être que vous venez de le trouver. Quand tout repose sur le dirigeant, la limite de l'entreprise a un nom : ses journées.
>
> **Margaux en était là**
>
> Elle a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Elle se sentait seule face à toutes les décisions.
>
> Elle aurait pu faire comme tout le monde : plus de communication, plus d'offres, plus d'heures. Elle a fait autre chose. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Trois mois plus tard, avec ses mots :
>
> >> « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Ce qui nous frappe dans son parcours : rien de cela n'est venu d'un effort commercial de plus. Tout est venu de l'organisation.
>
> >> « Je peux enfin déléguer. »
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais chaque mois sans temps pour regarder est un mois de plus sous le même plafond.
>
> {{choix}}
>
> Adrien & Emily

**C3B : Tout essayé du côté des ventes ? Franck a regardé ailleurs**
*Pré-en-tête : « Aujourd'hui, je suis conscient et je n'ai plus peur. »*
*Bouton : J'ai déjà tout essayé, je ne vois pas quoi faire d'autre*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Si vous avez tout essayé et que rien n'a tenu, ce n'est pas que vous vous y prenez mal. C'est sans doute que la réponse n'est pas là où vous cherchez.
>
> **Ce que ça coûte**
>
> Chaque tentative coûte du temps et de l'argent, pour un sursaut qui retombe. Et à force, c'est l'envie qui s'érode : la vôtre, et celle de l'équipe. Rien n'use autant que de donner beaucoup sans voir bouger le résultat.
>
> Quand le chiffre plafonne, on regarde le haut de la colonne : les ventes. Franck, boulanger, a regardé le bas : ce qui reste. Son bilan était dans le rouge, et voici comment il décrit cette période :
>
> >> « Avant, j'étais inconscient et j'avais peur. »
>
> ![Franck, boulanger : voir son témoignage](temoignage-franck.jpg)(https://vimeo.com/1204547163)
>
> Cinq mois plus tard, il était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois.
>
> >> « Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais il rappelle une chose : quand on a tout essayé au même endroit, il reste à regarder ailleurs.
>
> {{choix}}
>
> Adrien & Emily

**C3C : « Ça repartira avec la conjoncture »**
*Pré-en-tête : Stagner n'est jamais vraiment stable.*
*Bouton : Je me dis que ça repartira avec la conjoncture*
*Question : Et aujourd'hui, où en êtes-vous ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> C'est possible. La conjoncture pèse, et personne ne la commande. Mais en attendant, un chiffre d'affaires qui plafonne ressemble à de la stabilité : on ne perd rien, on ne gagne rien, on tient.
>
> Sauf que rien, autour, ne reste immobile.
>
> **Ce qui monte pendant que vous stagnez**
>
> Les charges, les salaires, les matières, les loyers. Avec un chiffre qui ne bouge pas, chaque hausse se prend sur ce qui vous reste.
>
> >> Un chiffre d'affaires qui stagne, c'est un résultat qui recule.
>
> **Ce que coûte l'attente**
>
> Une année de plus, c'est une année d'efforts de plus contre le même mur. Et si le plafond vient de l'intérieur de l'entreprise, la conjoncture peut repartir sans que votre chiffre la suive.
>
> Attendre n'est pas neutre. C'est une décision, et elle a un prix.
>
> {{choix}}
>
> Adrien & Emily

**C4 : Ce que votre histoire raconte, mise bout à bout**
*Pré-en-tête : Votre plafond n'est pas un manque de clients.*

> Bonjour %FIRSTNAME%,
>
> Depuis quelques jours, nous déroulons une histoire avec vous. La voici en entier.
>
> {{recap}}
>
> **Ce que cela raconte, mis bout à bout**
>
> Prises une par une, ces phrases ressemblent à un passage à vide. Ensemble, elles racontent autre chose : une entreprise qui a atteint la limite de ce que son organisation actuelle peut porter.
>
> >> Votre plafond n'est ni un manque de clients, ni un manque d'efforts. C'est la taille exacte de votre organisation d'aujourd'hui.
>
> Pousser plus fort ne le déplacera pas : vous l'avez déjà fait. Savoir précisément où il se trouve, si.
>
> {{m_12mois}}
>
> {{fin}}
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Je veux savoir où se trouve mon plafond*

> Savoir où se trouve votre plafond : c'est exactement l'objet de 45 minutes d'audit. La production, l'équipe, vos propres heures ou ce qui reste sur chaque vente : nous partons de votre situation réelle pour le situer. Vous n'avez rien à préparer.

**C4B**
*Bouton : Je me demande si ça vaut pour mon métier*

> Vous vous demandez si cela vaut pour votre métier, et la question est saine. Une épicerie avec restaurant, une boulangerie, une boucherie : aucun de ces dirigeants n'avait le même marché, et pour chacun la réponse se trouvait dans l'organisation ou dans les chiffres, pas dans un effort commercial de plus. Si votre plafond est vraiment du côté des ventes, 45 minutes d'audit suffisent pour le voir, et nous vous le dirons.

**C4C**
*Bouton : Je sais qu'il faut bouger, mais je repousse*

> Savoir qu'il faut bouger et repousser, c'est la position la plus courante, et elle se comprend. Mais un chiffre qui stagne n'attend pas avec vous : pendant ce temps, vos charges montent. 45 minutes d'audit suffisent pour savoir où se trouve le plafond, et par quoi commencer.

**C4N**

> Si cette histoire ressemble à la vôtre, reprenons 45 minutes ensemble. Nous partons de votre situation réelle, et vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
