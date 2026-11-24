# Séquences d'après-RDV à choix : une histoire par douleur

*Version du 24/11/2026 (soir) : récits en quatre épisodes autour d'un personnage (demande d'Adrien). Textes à valider.*

## Principe

- Les réponses de l'ancien formulaire (« Quel est votre principal défi ? ») n'ouvrent pas d'histoire : les textes citent la question et les mots du nouveau questionnaire.
- La **douleur** vient de la première question du questionnaire (« Qu'est-ce qui vous pèse le plus dans votre entreprise aujourd'hui ? »). Cinq réponses, cinq histoires : `rentabilite`, `operationnel`, `vie`, `equipe`, `plafond`.
- Le **frein** (trésorerie, timing, décision, preuves, priorité, général) ouvre et ferme la séquence. Quand le prospect suit une histoire, ses e-mails 1 et 5 sont ceux de la section « 0. Freins avec histoire » : ils citent sa réponse et n'annoncent pas les e-mails du frein, qui ne partiront pas.
- Chaque histoire est un **récit en quatre épisodes** (e-mails 2 à 5), autour d'un personnage : « Marc est chef d'entreprise, comme vous » (jamais de métier précis). Le personnage est inventé et on le dit une fois, à l'épisode 1 ; aucun résultat chiffré ne lui est attribué.
  1. **Épisode 1** (`C1`) : la scène de départ, puis « À la place de Marc, que feriez-vous ? » → trois décisions.
  2. **Épisode 2** (`C2A`, `C2B`, `C2C`, selon la décision) : ce qui arrive à Marc, et pourquoi cela ne suffit pas (« ce que Marc ne voit pas encore ») → « Et maintenant, que fait Marc ? ».
  3. **Épisode 3** (`C3A`, `C3B`, `C3C`) : la deuxième tentative, puis le déclic : un échange avec un regard extérieur, et « Je vais réfléchir » → « Et là, que fait Marc ? ».
  4. **Dénouement** (`C4`) : `{{fin}}` = comment Marc finit par rappeler, selon la dernière décision (`C4A`, `C4B`, `C4C` ; sans clic `C4N`), puis un an plus tard, puis « Marc n'existe pas. Franck, si. » (vrai client, ses mots, ses chiffres, sa vidéo), puis « Et votre histoire ? » et le bouton pour reprendre un audit.
- Les choix sont toujours les décisions du personnage, jamais des questions posées au lecteur. Sans clic, l'histoire continue avec la première décision (« Marc a choisi : … »).
- `Héros : …` = le prénom du personnage ; `*Bouton : …*` = la décision qui mène à ce texte ; `*Question : …*` = la question posée au-dessus des trois boutons de ce texte.
- Chaque e-mail dit **ce qui se passe** et **pourquoi**, jamais **comment** le régler. Le comment, c'est l'audit.
- Vouvoiement, aucun prix, aucune garantie, témoignages réels avec leurs propres mots.

Syntaxe : `>> phrase` = encadré ; `[ Libellé ]` = bouton de réservation (ou lien entre parenthèses) ; `[[ Libellé ]]` = lien discret ; `{{choix}}` = la question et ses trois réponses (ou le bouton de réservation à l'étape 4) ; `{{ouverture}}` = « À la place de Marc, vous avez choisi : … » après un clic, « Marc a choisi : … » sinon ; `{{fin}}` = le paragraphe de la dernière décision ; `![texte](image)` = image ; `{{m_…}}` = phrase miroir, tirée d'une réponse à choix du prospect (la ligne disparaît si la réponse manque).

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
Héros : Marc

**C1 : L'histoire de Marc (1/4) : le meilleur mois de l'année**
*Pré-en-tête : Il vient de faire son meilleur mois. Et il ne peut pas se payer.*
*Question : À la place de Marc, que feriez-vous ?*

> ![L'histoire de Marc, épisode 1](recit-rentabilite.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, vous nous aviez dit :
>
> >> « Je fais du chiffre, mais il ne me reste presque rien à la fin du mois. »
>
> Laissez-nous vous raconter l'histoire de Marc. Il disait exactement la même chose.
>
> Marc est chef d'entreprise, comme vous. Il n'existe pas tout à fait : son histoire est faite de celles des dirigeants que nous accompagnons. Vous allez sans doute vous y reconnaître.
>
> **Un vendredi soir**
>
> Le carnet de commandes est plein. L'équipe est partie. Marc ouvre le compte de l'entreprise pour régler un fournisseur.
>
> Il le referme aussitôt.
>
> Il vient de faire son meilleur mois de l'année. Et il ne peut pas se verser son salaire.
>
> Ce soir-là, sur le chemin du retour, Marc se dit que ça ne peut plus durer. Trois idées lui viennent.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Marc (2/4) : le gros contrat**
*Pré-en-tête : Trois mois de travail en plus. Et le compte, à la fin ?*
*Bouton : Accepter le gros contrat qu'il hésitait à prendre*
*Question : Et maintenant, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Le lundi, il signe. C'est le plus gros contrat que l'entreprise ait jamais eu.
>
> Suivent trois mois comme il n'en a jamais connu. Des heures supplémentaires, un renfort pris en urgence, et Marc sur le terrain presque tous les soirs. Le chiffre d'affaires bat tous les records.
>
> À la fin du trimestre, il rouvre son compte.
>
> Il y a un peu moins qu'avant.
>
> **Ce que Marc ne voit pas encore**
>
> Pour décrocher ce contrat, il a serré son prix. Pour le tenir, il a payé du renfort et donné ses propres soirées. Tout compté, chaque jour passé dessus lui a coûté de l'argent.
>
> >> Le contrat dont il était le plus fier était celui qui lui rapportait le moins.
>
> Vendre plus de ce qui ne laisse rien ne laisse toujours rien. Marc, lui, retient seulement ceci : travailler plus n'a rien changé. Et il ne sait toujours pas où part son argent.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Marc (2/4) : la hausse des prix**
*Pré-en-tête : Dix pour cent sur tout. Trois mois plus tard, il n'en reste rien.*
*Bouton : Augmenter tous ses prix*
*Question : Et maintenant, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il lui faut deux semaines pour oser. Puis il le fait : dix pour cent, sur tout.
>
> Deux clients protestent. Un s'en va. Les autres ne disent rien, et Marc se demande pourquoi il a attendu si longtemps.
>
> Le premier mois, le compte respire. Le deuxième, un fournisseur augmente ses tarifs. Le troisième, les charges suivent. À la fin du trimestre, Marc rouvre son compte.
>
> Il est revenu au même point.
>
> **Ce que Marc ne voit pas encore**
>
> Il a augmenté tous ses prix de la même façon. Or certaines de ses ventes auraient supporté bien davantage. Et d'autres lui faisaient perdre de l'argent avant la hausse, et lui en font encore perdre après.
>
> >> Augmenter tous ses prix sans savoir ce que laisse chaque vente, c'est soigner sans avoir cherché ce qu'on soigne.
>
> Marc, lui, retient seulement ceci : même en vendant plus cher, il ne reste rien. Et il ne sait toujours pas où part son argent.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Marc (2/4) : la chasse aux dépenses**
*Pré-en-tête : Il a tout épluché. La vraie fuite n'était sur aucun relevé.*
*Bouton : Faire la chasse aux dépenses*
*Question : Et maintenant, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il y passe deux soirées entières. Les abonnements, l'assurance, le téléphone, le contrat d'entretien. Il résilie, il renégocie, il fait jouer la concurrence.
>
> Il est assez fier du résultat : quelques centaines d'euros par mois.
>
> Trois mois plus tard, Marc rouvre son compte.
>
> Rien n'a changé.
>
> **Ce que Marc ne voit pas encore**
>
> Il a regardé ce qui se voit : les lignes d'un relevé. Mais ce qui pèse vraiment dans son entreprise n'a pas de ligne. Ses propres heures. Le travail refait. Les ventes qui, une fois tout compté, coûtent plus qu'elles ne rapportent.
>
> >> Marc a fermé les petites fuites. La grande n'apparaît sur aucun relevé.
>
> Lui retient seulement ceci : même en dépensant moins, il ne reste rien. Et il ne sait toujours pas où part son argent.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Marc (3/4) : les dimanches**
*Pré-en-tête : Des chiffres plein l'écran, et toujours pas de réponse.*
*Bouton : Il s'y plonge seul, le dimanche*
*Question : Et là, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Le premier dimanche, il sort tout : relevés, factures, un grand tableau. Le deuxième, il additionne. Le troisième, il obtient des totaux.
>
> Ce sont des totaux qu'il connaissait déjà.
>
> >> Ses comptes lui disent combien. Ils ne lui disent pas où.
>
> Marc connaît son métier mieux que personne. Mais personne ne lui a appris à lire une entreprise, et il y a mille choses que l'on pourrait regarder. À la maison, plus personne ne lui demande s'il vient déjeuner.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Marc hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre l'endroit précis par où son argent s'en va. Ce n'est pas du tout celui qu'il soupçonnait.
>
> Marc est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3B : Marc (3/4) : l'expert-comptable**
*Pré-en-tête : « Une année correcte. » Alors pourquoi ne peut-il pas se payer ?*
*Bouton : Il appelle son expert-comptable*
*Question : Et là, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Le rendez-vous est pris pour le jeudi. Son expert-comptable est sérieux : les bilans sont justes, les déclarations partent à l'heure.
>
> Il regarde les chiffres et annonce une année « correcte ».
>
> Marc pose alors la seule question qui l'intéresse : pourquoi ne peut-il pas se payer ?
>
> Un silence. Puis : « Il faudrait regarder dans le détail. »
>
> >> Son comptable lui dit si l'année a été bonne. Personne ne lui dit pourquoi il ne reste rien.
>
> Ce n'est la faute de personne. Un bilan regarde l'année passée, d'un seul bloc. Ce que laisse chaque activité, aujourd'hui, n'est le travail de personne. Donc personne ne le fait.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Marc hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre l'endroit précis par où son argent s'en va. Ce n'est pas du tout celui qu'il soupçonnait.
>
> Marc est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3C : Marc (3/4) : serrer les dents**
*Pré-en-tête : Six mois à attendre le bilan. Il ne lui a rien appris.*
*Bouton : Il serre les dents jusqu'au bilan*
*Question : Et là, que fait Marc ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il se dit que le bilan tranchera. D'ici là, il tient.
>
> Il repousse l'achat du véhicule dont l'entreprise a besoin. Il annule une semaine de vacances. Il dort mal les fins de mois.
>
> Six mois plus tard, le bilan arrive. Le résultat est « correct ». Sur le compte, rien de plus.
>
> >> Attendre lui a coûté six mois. Et le bilan ne lui a rien appris qu'il ne savait déjà.
>
> Parce qu'un bilan dit si l'année a été bonne. Il ne dit pas par où l'argent est reparti.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Marc hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre l'endroit précis par où son argent s'en va. Ce n'est pas du tout celui qu'il soupçonnait.
>
> Marc est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C4 : Marc (4/4) : un an plus tard**
*Pré-en-tête : Le même vendredi soir. Cette fois, il ne referme pas son compte.*

> Bonjour %FIRSTNAME%,
>
> Voici la fin de l'histoire de Marc.
>
> {{fin}}
>
> Il s'est fait accompagner. Pas pour vendre plus : pour voir clair, puis pour agir là où cela comptait.
>
> **Un an plus tard, un vendredi soir**
>
> L'équipe est partie. Marc ouvre le compte de l'entreprise.
>
> Il ne le referme pas. Il sait déjà ce qu'il va y trouver.
>
> Son salaire est versé le 5 du mois, sans calcul. Il a acheté le véhicule qu'il repoussait. Et le mois dernier, pour la première fois, il a refusé un gros contrat : il savait exactement ce qu'il lui aurait coûté.
>
> >> Marc ne travaille pas plus qu'avant. Il sait ce que lui laisse chaque vente.
>
> **Marc n'existe pas. Franck, si.**
>
> Franck est boulanger. Quand il a commencé avec nous, son bilan était dans le rouge. Il le dit lui-même : « Avant, j'étais inconscient et j'avais peur. »
>
> Cinq mois plus tard, il était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois. « Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> ![Franck, boulanger : voir son témoignage](temoignage-franck.jpg)(https://vimeo.com/1204547163)
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise.
>
> **Et votre histoire ?**
>
> Elle en est à l'épisode où Marc dit « je vais réfléchir ». La suite, c'est vous qui l'écrivez.
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Il rappelle dans la semaine*

> Marc a rappelé le jeudi. Pas par certitude : il avait fait le compte de ce que lui coûtait chaque mois passé à réfléchir.

**C4B**
*Bouton : Il laisse passer la saison*

> Marc a laissé passer la saison. Puis une autre. Rien n'a bougé, sauf la fatigue. C'est un vendredi soir, devant le même compte, qu'il a fini par rappeler.

**C4C**
*Bouton : Il essaie de régler ça seul*

> Marc a essayé seul. Il savait maintenant où regarder, et il a tenu six semaines. Puis une urgence, puis une autre : le quotidien a tout repris. Savoir où est le problème ne suffit pas quand on est seul face à lui. Il a rappelé.

**C4N**

> Marc a hésité. Longtemps. Puis il a rappelé.

---

## 2. Opérationnel (`operationnel`)

Citation : « Je suis noyé dans l'opérationnel, je n'ai plus une minute pour piloter »
Héros : Sophie

**C1 : L'histoire de Sophie (1/4) : la liste de 21 heures**
*Pré-en-tête : Quatorze lignes ce matin. Ce soir, aucune n'est barrée.*
*Question : À la place de Sophie, que feriez-vous ?*

> ![L'histoire de Sophie, épisode 1](recit-operationnel.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, vous nous aviez dit :
>
> >> « Je suis noyé dans l'opérationnel, je n'ai plus une minute pour piloter. »
>
> Laissez-nous vous raconter l'histoire de Sophie. Elle disait exactement la même chose.
>
> Sophie est cheffe d'entreprise, comme vous. Elle n'existe pas tout à fait : son histoire est faite de celles des dirigeants que nous accompagnons. Vous allez sans doute vous y reconnaître.
>
> **Un mardi, 21 heures**
>
> Les bureaux sont vides. Sophie retrouve la liste qu'elle a écrite le matin : quatorze lignes. En haut, soulignée deux fois, la seule qui compte vraiment pour l'avenir de l'entreprise.
>
> Aucune n'est barrée.
>
> Elle n'a pourtant pas arrêté de la journée. Des questions, des urgences, un client, un fournisseur, une panne. Elle a tout réglé. Et rien avancé.
>
> Ce soir-là, Sophie se dit que ça ne peut plus durer. Trois idées lui viennent.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Sophie (2/4) : la nouvelle recrue**
*Pré-en-tête : Une paire de bras en plus. Et une source de questions en plus.*
*Bouton : Embaucher quelqu'un pour la soulager*
*Question : Et maintenant, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Le recrutement prend six semaines. La personne est bien : motivée, sérieuse, pleine de bonne volonté.
>
> Seulement, elle ne sait pas encore. Alors elle demande. Où trouver ceci, comment traiter cela, que répondre à ce client. Et c'est Sophie qui répond, parce que c'est Sophie qui sait.
>
> Trois mois plus tard, sa liste du matin compte seize lignes.
>
> **Ce que Sophie ne voit pas encore**
>
> Dans une entreprise, le travail va vers celui qui sait. Elle a ajouté une personne, mais tout ce qui compte passe toujours par la même tête : la sienne.
>
> >> Elle a une paire de bras en plus. Et une source de questions en plus.
>
> Sophie, elle, retient seulement ceci : même avec de l'aide, ses journées ne lui appartiennent pas. Et elle commence à penser que le problème n'est pas le temps.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Sophie (2/4) : la porte fermée**
*Pré-en-tête : Ses matinées étaient bloquées. Elles ont tenu quatre jours.*
*Bouton : Bloquer ses matinées, porte fermée*
*Question : Et maintenant, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle prévient tout le monde : le matin, de 9 heures à midi, la porte est fermée. Sauf urgence.
>
> Le lundi, c'est un bonheur. Le mardi aussi.
>
> Le jeudi, on frappe. Un client important menace de partir, et il faut décider tout de suite d'un geste commercial. Personne d'autre ne peut trancher.
>
> La semaine suivante, « sauf urgence » revient trois fois. Au bout d'un mois, la porte reste ouverte.
>
> **Ce que Sophie ne voit pas encore**
>
> Le créneau existait bien. Mais elle restait la seule à pouvoir répondre. Fermer une porte ne change pas l'endroit où arrivent les décisions.
>
> >> On ne se protège pas d'une organisation dont on est le centre.
>
> Sophie, elle, retient seulement ceci : même en se protégeant, ses journées ne lui appartiennent pas. Et elle commence à penser que le problème n'est pas le temps.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Sophie (2/4) : le nouvel outil**
*Pré-en-tête : Tout est mieux rangé. Tout est toujours pour elle.*
*Bouton : S'équiper d'un nouvel outil*
*Question : Et maintenant, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle y passe un week-end entier. Des colonnes, des couleurs, des rappels, une application sur le téléphone. Le lundi, toute l'entreprise est dedans.
>
> C'est beau. C'est clair. Chaque tâche a sa place.
>
> Trois mois plus tard, Sophie regarde l'écran. Tout est parfaitement rangé. Et presque toutes les cartes portent son nom.
>
> **Ce que Sophie ne voit pas encore**
>
> Un outil range le travail. Il ne dit à personne quoi décider à sa place. Elle voit mieux ce qu'elle a à faire, et elle a toujours autant à faire.
>
> >> Elle a mis de l'ordre dans le problème. Le problème est resté.
>
> Sophie, elle, retient seulement ceci : même bien organisée, ses journées ne lui appartiennent pas. Et elle commence à penser que le problème n'est pas le temps.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Sophie (3/4) : le classeur**
*Pré-en-tête : Trois semaines de soirées à tout écrire. Personne ne l'a ouvert.*
*Bouton : Elle écrit tout : une procédure pour chaque tâche*
*Question : Et là, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle y consacre trois semaines de soirées. Chaque tâche, étape par étape, dans un classeur qu'elle pose bien en vue.
>
> Un mois plus tard, le classeur n'a pas bougé. Et on continue de venir la voir.
>
> >> Une procédure dit comment faire. Elle ne dit pas qui a le droit de décider.
>
> Dès qu'un cas sort un peu du cadre, et c'est le cas presque tous les jours, la question revient vers elle.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Sophie hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre pourquoi tout revient vers elle. Ce n'est ni son équipe, ni son agenda : c'est la façon dont l'entreprise s'est construite autour d'elle.
>
> Sophie est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. Là, je n'ai vraiment pas le temps. »
>
> {{choix}}
>
> Adrien & Emily

**C3B : Sophie (3/4) : « Tiens, c'est pour toi »**
*Pré-en-tête : Elle a tout confié d'un coup. Elle a tout repris en dix jours.*
*Bouton : Elle confie d'un coup un gros dossier à quelqu'un*
*Question : Et là, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle choisit la personne en qui elle a le plus confiance, et lui confie tout un pan de l'activité. « À partir de maintenant, c'est toi. »
>
> La première semaine se passe bien. La deuxième, une erreur. Pas grave, mais visible : un client appelle.
>
> Sophie rattrape. Puis elle reprend le dossier. « Laisse, c'est plus simple si je le fais. »
>
> >> Confier sans cadre, c'est abandonner. Puis reprendre.
>
> Et la personne a retenu la leçon : la prochaine fois, elle demandera avant de faire.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Sophie hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre pourquoi tout revient vers elle. Ce n'est ni son équipe, ni son agenda : c'est la façon dont l'entreprise s'est construite autour d'elle.
>
> Sophie est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. Là, je n'ai vraiment pas le temps. »
>
> {{choix}}
>
> Adrien & Emily

**C3C : Sophie (3/4) : les vacances**
*Pré-en-tête : Dix appels par jour, les pieds dans l'eau.*
*Bouton : Elle tient jusqu'aux vacances*
*Question : Et là, que fait Sophie ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle se dit qu'après une vraie coupure, elle y verra plus clair. Elle tient donc, deux mois de plus.
>
> Les vacances arrivent. Le premier jour, le téléphone sonne quatre fois. Le troisième, dix. Elle répond les pieds dans l'eau, valide un devis depuis la terrasse, règle un litige pendant le dîner.
>
> Au retour, trois semaines de retard l'attendent.
>
> >> Sophie n'était pas en vacances. Elle travaillait d'ailleurs.
>
> Et elle comprend une chose qu'elle n'osait pas regarder : son entreprise ne tient pas une semaine sans elle.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Sophie hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre pourquoi tout revient vers elle. Ce n'est ni son équipe, ni son agenda : c'est la façon dont l'entreprise s'est construite autour d'elle.
>
> Sophie est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. Là, je n'ai vraiment pas le temps. »
>
> {{choix}}
>
> Adrien & Emily

**C4 : Sophie (4/4) : un an plus tard**
*Pré-en-tête : Un mardi, 9 heures. La ligne soulignée deux fois est barrée.*

> Bonjour %FIRSTNAME%,
>
> Voici la fin de l'histoire de Sophie.
>
> {{fin}}
>
> Elle s'est fait accompagner. Pas pour travailler plus vite : pour que l'entreprise cesse de passer par elle pour tout.
>
> **Un an plus tard, un mardi**
>
> Il est 9 heures. Sophie a devant elle une liste de quatre lignes. À 11 heures, celle qui compte vraiment est barrée.
>
> La semaine dernière, un client mécontent a appelé. L'équipe a réglé le problème. Sophie l'a appris le lendemain, dans un message qui commençait par « pour information ».
>
> Et en août, elle est partie dix jours. Le téléphone est resté dans le sac.
>
> >> Sophie ne travaille pas moins. Elle fait enfin le travail qu'elle seule peut faire.
>
> **Sophie n'existe pas. Margaux, si.**
>
> Margaux a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Elle se sentait seule face à toutes les décisions. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> Trois mois plus tard, avec ses mots : « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. » Et surtout : « Je peux enfin déléguer. »
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Son résultat lui appartient, et nous ne vous promettons pas le même.
>
> **Et votre histoire ?**
>
> Elle en est à l'épisode où Sophie dit « je vais réfléchir ». La suite, c'est vous qui l'écrivez.
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Elle rappelle dans la semaine*

> Sophie a rappelé le jeudi. Elle n'avait pas plus de temps que la veille : elle avait compris qu'elle n'en aurait jamais davantage en attendant.

**C4B**
*Bouton : Elle attend une période plus calme*

> Sophie a attendu une période plus calme. Elle n'est jamais venue. C'est un mardi soir, devant une liste de dix-huit lignes, qu'elle a fini par rappeler.

**C4C**
*Bouton : Elle essaie de régler ça seule*

> Sophie a essayé seule. Elle savait maintenant d'où venait le problème, et elle a tenu un mois. Puis une urgence, puis une autre : le quotidien a tout repris. On ne redessine pas une organisation depuis son centre. Elle a rappelé.

**C4N**

> Sophie a hésité. Longtemps. Puis elle a rappelé.

---

## 3. Vie avalée (`vie`)

Citation : « Mon entreprise a avalé ma vie : soirées, week-ends et vacances y passent »
Héros : Julien

**C1 : L'histoire de Julien (1/4) : le gâteau d'anniversaire**
*Pré-en-tête : Sa fille a dix ans ce soir. Il arrive pour le dessert.*
*Question : À la place de Julien, que feriez-vous ?*

> ![L'histoire de Julien, épisode 1](recit-vie.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, vous nous aviez dit :
>
> >> « Mon entreprise a avalé ma vie : soirées, week-ends et vacances y passent. »
>
> Laissez-nous vous raconter l'histoire de Julien. Il disait exactement la même chose.
>
> Julien est chef d'entreprise, comme vous. Il n'existe pas tout à fait : son histoire est faite de celles des dirigeants que nous accompagnons. Vous allez sans doute vous y reconnaître.
>
> **Un jeudi soir**
>
> Sa fille a dix ans aujourd'hui. Julien avait promis d'être là à 19 heures.
>
> À 19 heures, il termine un devis que lui seul peut chiffrer. À 20 heures, il règle un problème de livraison. Il pousse la porte de la maison à 21 h 10.
>
> Les bougies sont soufflées. On lui a gardé une part de gâteau.
>
> Personne ne lui fait de reproche. C'est peut-être le plus difficile.
>
> Ce soir-là, Julien se dit que ça ne peut plus durer. Trois idées lui viennent.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Julien (2/4) : 18 h 30**
*Pré-en-tête : Il s'était promis de partir à l'heure. Il a tenu deux soirs.*
*Bouton : Se promettre de partir à 18 h 30, tous les soirs*
*Question : Et maintenant, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il met une alarme sur son téléphone. Le lundi, il part à 18 h 30, un peu coupable. Le mardi aussi.
>
> Le mercredi, à 18 h 20, il reste un devis à envoyer avant le lendemain. Personne d'autre ne sait le chiffrer. Julien coupe l'alarme.
>
> À la fin du mois, elle sonne encore tous les soirs. Il ne l'entend même plus.
>
> **Ce que Julien ne voit pas encore**
>
> Ce n'est pas la volonté qui lui manque. Ce qui le retient le soir, c'est tout ce qu'il est le seul à savoir faire. Et cela ne disparaît pas parce qu'on a décidé de partir plus tôt.
>
> >> Une bonne résolution ne pèse rien face à une entreprise qui a besoin de toutes vos heures.
>
> Julien, lui, retient seulement ceci : il n'a pas tenu. Et il commence à se demander si le problème vient vraiment de lui.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Julien (2/4) : le dimanche matin**
*Pré-en-tête : Il voulait libérer ses soirées. Il a perdu ses dimanches.*
*Bouton : Travailler le dimanche matin pour libérer ses soirées*
*Question : Et maintenant, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> L'idée paraît raisonnable : trois heures au calme le dimanche matin, et des soirées enfin libres.
>
> Le premier dimanche, il avance bien. Le deuxième, il déborde jusqu'à 14 heures. Au bout d'un mois, le dimanche matin est devenu le dimanche.
>
> Et ses soirées ? Elles sont toujours prises.
>
> **Ce que Julien ne voit pas encore**
>
> Il a donné des heures en plus, et l'entreprise les a prises. Aussitôt, elle s'est organisée autour. Ce qui était un effort exceptionnel est devenu la règle.
>
> >> Chaque heure offerte à l'entreprise devient la norme du mois suivant.
>
> Julien, lui, retient seulement ceci : plus il donne, plus on lui prend. Et il commence à se demander si le problème vient vraiment de lui.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Julien (2/4) : après la saison**
*Pré-en-tête : La saison s'est terminée. Une autre a commencé.*
*Bouton : Tenir jusqu'à la fin de la saison*
*Question : Et maintenant, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il se dit que c'est une question de semaines. Après la saison, il lèvera le pied. Il le promet à la maison, et il le pense.
>
> La saison se termine. Vient l'inventaire. Puis un salarié en arrêt. Puis un gros client à ne surtout pas perdre.
>
> Trois mois plus tard, Julien s'aperçoit qu'il a dit « après » toute l'année.
>
> **Ce que Julien ne voit pas encore**
>
> Il n'y a pas de période calme qui attend au bout. Tant que l'entreprise repose sur sa présence, chaque creux se remplit de ce qui était en retard.
>
> >> « Après » n'est pas une date. C'est une façon de ne pas regarder.
>
> Julien, lui, retient seulement ceci : le calme ne viendra pas tout seul. Et il commence à se demander si le problème vient vraiment de lui.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Julien (3/4) : le renfort**
*Pré-en-tête : Il a embauché pour souffler. Il forme le soir.*
*Bouton : Il embauche pour se décharger*
*Question : Et là, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> La nouvelle recrue arrive un lundi. Elle est volontaire, et elle a tout à apprendre.
>
> La journée, Julien n'a pas une minute pour lui montrer. Alors il lui explique le soir, après la fermeture. Puis il fait son propre travail, encore après.
>
> Il rentre plus tard qu'avant.
>
> >> Il a embauché pour retrouver ses soirées. Ce sont ses soirées qui servent à former.
>
> Tout ce qui compte dans l'entreprise est dans sa tête. Tant que c'est le cas, chaque personne en plus commence par lui prendre du temps.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Julien hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui remplit vraiment ses soirées. Ce n'est ni la charge de travail, ni ses clients : c'est la façon dont l'entreprise s'est organisée autour de sa présence.
>
> Julien est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3B : Julien (3/4) : l'ordinateur sur la table**
*Pré-en-tête : Il est rentré à l'heure. Il n'était pas là pour autant.*
*Bouton : Il rapporte le travail à la maison, pour être là*
*Question : Et là, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il rentre à 19 heures, comme promis. Il dîne avec tout le monde. Puis il ouvre l'ordinateur sur la table du salon.
>
> Les premiers soirs, il en est presque content. Il est là.
>
> Un soir, sa fille lui raconte sa journée. Il répond « oui, oui » en finissant un devis. Elle s'arrête au milieu de sa phrase, et monte dans sa chambre.
>
> >> Julien avait déplacé son travail. Il ne l'avait pas réduit d'une minute.
>
> Être dans la même pièce n'est pas être là. Il le sait. Elle aussi.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Julien hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui remplit vraiment ses soirées. Ce n'est ni la charge de travail, ni ses clients : c'est la façon dont l'entreprise s'est organisée autour de sa présence.
>
> Julien est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3C : Julien (3/4) : l'erreur**
*Pré-en-tête : Une erreur bête. De celles qu'il ne faisait jamais.*
*Bouton : Il n'en parle à personne et continue*
*Question : Et là, que fait Julien ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il continue, donc. Il se lève plus tôt. Il se couche plus tard. Il ne se plaint pas.
>
> Un matin, un client l'appelle : il y a une erreur dans le devis. Une erreur bête, de celles que Julien ne faisait jamais. Elle lui coûte le client.
>
> Le soir, il relit le document. Il l'avait rédigé à 23 heures, après quatorze heures de travail.
>
> >> La fatigue ne prévient pas. Elle envoie la facture.
>
> Julien pensait protéger son entreprise en lui donnant tout. Il vient de voir ce que cela lui coûte.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Julien hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui remplit vraiment ses soirées. Ce n'est ni la charge de travail, ni ses clients : c'est la façon dont l'entreprise s'est organisée autour de sa présence.
>
> Julien est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C4 : Julien (4/4) : un an plus tard**
*Pré-en-tête : Sa fille a onze ans ce soir. Devinez qui apporte le gâteau.*

> Bonjour %FIRSTNAME%,
>
> Voici la fin de l'histoire de Julien.
>
> {{fin}}
>
> Il s'est fait accompagner. Pas pour apprendre à lever le pied : pour que l'entreprise cesse d'avoir besoin de toutes ses heures.
>
> **Un an plus tard, un jeudi soir**
>
> Sa fille a onze ans aujourd'hui. À 18 h 15, Julien ferme son bureau. Le devis du jour est parti à 16 heures, et ce n'est pas lui qui l'a chiffré.
>
> Il passe chercher le gâteau. C'est lui qui allume les bougies.
>
> Son téléphone est resté dans la voiture. Il ne s'en aperçoit qu'en allant se coucher.
>
> >> Julien n'a pas levé le pied. Son entreprise a appris à tourner sans lui le soir.
>
> **Julien n'existe pas. Alexandre, si.**
>
> Alexandre est boucher-charcutier-traiteur. Son chiffre d'affaires montait, et il avait, selon ses mots, « la tête dans le guidon ». Un soir, une fois tout le monde payé, il a fait ce constat : « J'ai fait plaisir à tout le monde, sauf à moi-même. »
>
> Aujourd'hui, ses marges sont reprises, ses fiches de production sont calées, et à 19 h 30 il passe à table avec toute sa famille.
>
> ![Alexandre, boucher-charcutier-traiteur : voir son témoignage](temoignage-alexandre.jpg)(https://drive.google.com/file/d/1tPEoSaGRAGXZmo_h0x16eb8gWfl3aDBK/view)
>
> Son parcours n'est pas une promesse pour le vôtre. Son conseil à ceux qui hésitent : demandez-vous plutôt combien vous allez perdre à attendre.
>
> **Et votre histoire ?**
>
> Elle en est à l'épisode où Julien dit « je vais réfléchir ». La suite, c'est vous qui l'écrivez.
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Il rappelle dans la semaine*

> Julien a rappelé le jeudi. Il avait regardé le calendrier : le prochain anniversaire était dans onze mois, et il ne voulait pas arriver pour le dessert.

**C4B**
*Bouton : Il attend la fin de la saison*

> Julien a attendu la fin de la saison. Puis la suivante. C'est en voyant passer un deuxième été sans vacances qu'il a fini par rappeler.

**C4C**
*Bouton : Il essaie de régler ça seul*

> Julien a essayé seul. Il savait maintenant d'où venait le problème, et il a tenu un mois. Puis une urgence, puis une autre : le quotidien a tout repris. On ne réorganise pas une entreprise entre 22 heures et minuit. Il a rappelé.

**C4N**

> Julien a hésité. Longtemps. Puis il a rappelé.

---

## 4. Équipe (`equipe`)

Citation : « Mes salariés viennent me voir pour tout : rien n'avance sans moi »
Héros : Claire

**C1 : L'histoire de Claire (1/4) : deux jours d'absence**
*Pré-en-tête : Vingt-trois messages, six décisions en attente, un client perdu.*
*Question : À la place de Claire, que feriez-vous ?*

> ![L'histoire de Claire, épisode 1](recit-equipe.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, vous nous aviez dit :
>
> >> « Mes salariés viennent me voir pour tout : rien n'avance sans moi. »
>
> Laissez-nous vous raconter l'histoire de Claire. Elle disait exactement la même chose.
>
> Claire est cheffe d'entreprise, comme vous. Elle n'existe pas tout à fait : son histoire est faite de celles des dirigeants que nous accompagnons. Vous allez sans doute vous y reconnaître.
>
> **Un mercredi matin**
>
> Claire rentre de deux jours de salon. Deux jours seulement.
>
> Sur son téléphone, vingt-trois messages. Sur son bureau, six décisions qui l'attendent, dont aucune n'était difficile. Et un client parti chez un concurrent, faute de réponse à temps.
>
> Son équipe est là, de bonne humeur, soulagée de la revoir. « On a préféré vous attendre. »
>
> Ce matin-là, Claire se dit que ça ne peut plus durer. Trois idées lui viennent.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Claire (2/4) : la réunion**
*Pré-en-tête : Tout le monde a hoché la tête. Dix jours plus tard, rien n'avait changé.*
*Bouton : Réunir l'équipe et remettre les choses au clair*
*Question : Et maintenant, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle les réunit le vendredi. Elle explique, calmement : elle veut des initiatives, elle leur fait confiance, ils n'ont pas besoin d'elle pour tout.
>
> Tout le monde hoche la tête. La semaine suivante, c'est mieux.
>
> Dix jours plus tard, on frappe à sa porte : « Je préfère vous demander, on ne sait jamais. »
>
> **Ce que Claire ne voit pas encore**
>
> Elle a demandé des initiatives. Elle n'a pas dit jusqu'où chacun pouvait aller sans elle. Alors, dans le doute, chacun a fait ce qui est le plus prudent : demander.
>
> >> Une consigne dit quoi faire aujourd'hui. Elle ne dit pas comment décider demain.
>
> Claire, elle, retient seulement ceci : elle a été claire, et rien n'a changé. Elle commence à se demander si le problème vient vraiment de son équipe.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Claire (2/4) : le responsable**
*Pré-en-tête : Elle a recruté un bras droit. Maintenant, c'est lui qui vient la voir.*
*Bouton : Recruter un responsable pour faire tampon*
*Question : Et maintenant, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle prend son temps et recrute quelqu'un de solide, avec de l'expérience. L'équipe passera par lui, et elle pourra enfin souffler.
>
> Le premier mois, l'équipe va le voir. Puis il vient voir Claire.
>
> Les mêmes questions arrivent sur son bureau, simplement une personne plus tard. Et avec un salaire de plus.
>
> **Ce que Claire ne voit pas encore**
>
> Son responsable est compétent. Mais il ne sait pas plus que les autres jusqu'où il a le droit de décider. Alors il fait comme eux : il demande.
>
> >> Elle n'a pas supprimé la file d'attente devant son bureau. Elle y a ajouté un étage.
>
> Claire, elle, retient seulement ceci : même une bonne recrue vient tout lui demander. Elle commence à se demander si le problème vient vraiment de son équipe.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Claire (2/4) : tout valider**
*Pré-en-tête : Plus une seule erreur. Et plus rien qui avance.*
*Bouton : Tout valider elle-même, pour être sûre*
*Question : Et maintenant, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Puisque tout remonte, autant l'organiser : désormais, rien ne sort sans son accord. Devis, commandes, réponses aux clients.
>
> Les erreurs disparaissent. Claire est rassurée.
>
> Puis les dossiers s'empilent. Tout attend sa signature. Ses journées passent à relire le travail des autres. Et plus personne ne propose rien.
>
> **Ce que Claire ne voit pas encore**
>
> Elle a obtenu ce qu'elle demandait : une équipe qui ne décide plus de rien. Chacun fait sa part, puis attend.
>
> >> À force de vérifier tout ce qui sort, elle est devenue le seul endroit par où tout passe.
>
> Claire, elle, retient seulement ceci : plus elle contrôle, moins ils décident. Elle commence à se demander si le problème vient vraiment de son équipe.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Claire (3/4) : le remplaçant**
*Pré-en-tête : Trois semaines d'initiatives. Puis la même phrase qu'avant.*
*Bouton : Elle remplace ceux qui ne suivent pas*
*Question : Et là, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle se sépare du salarié qui demandait le plus, et recrute quelqu'un de plus autonome. Du moins, c'est ce que dit l'entretien.
>
> Les trois premières semaines lui donnent raison : il prend des initiatives.
>
> Puis il se trompe, une fois. Claire rattrape, vite et bien, comme toujours. Le lendemain, il passe la tête par la porte : « Je préfère vous demander. »
>
> >> Elle a changé la personne. Elle n'a pas changé ce que la personne apprend en arrivant.
>
> Ici, la règle n'est écrite nulle part, et tout le monde la connaît : mieux vaut demander.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Claire hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui manque à son équipe pour décider seule. Ce n'est ni la compétence, ni la motivation.
>
> Claire est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3B : Claire (3/4) : laisser faire**
*Pré-en-tête : Elle a décidé de ne plus répondre. Cela a duré jusqu'à la première erreur.*
*Bouton : Elle laisse faire, pour voir ce qui se passe*
*Question : Et là, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle se fait violence. À chaque question, la même réponse : « Décidez, je vous fais confiance. »
>
> Pendant deux semaines, l'équipe décide. Maladroitement, mais elle décide.
>
> Puis un salarié accorde à un client une remise que Claire n'aurait jamais acceptée. La somme est sérieuse.
>
> Elle reprend tout en main le jour même. Plus serré qu'avant.
>
> >> Elle leur a donné la liberté de décider. Elle ne leur avait pas donné de limites.
>
> Et l'équipe a retenu la leçon : quand on décide seul ici, cela finit mal.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Claire hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui manque à son équipe pour décider seule. Ce n'est ni la compétence, ni la motivation.
>
> Claire est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3C : Claire (3/4) : les fiches de poste**
*Pré-en-tête : Tout était écrit. Sauf ce qui comptait.*
*Bouton : Elle écrit une fiche de poste pour chacun*
*Question : Et là, que fait Claire ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Elle y passe ses soirées pendant deux semaines. Une fiche par personne, avec les missions, les tâches, les horaires. Elle les remet en main propre.
>
> L'équipe lit, signe, range.
>
> Le lundi suivant : « Le client demande un délai, je fais quoi ? »
>
> Claire regarde la fiche. Tout y est. Sauf la réponse à cette question.
>
> >> Ses fiches disaient qui fait quoi. Elles ne disaient pas qui décide quoi.
>
> Et c'est exactement ce que son équipe vient lui demander, dix fois par jour.
>
> **Le déclic**
>
> C'est une autre dirigeante qui lui en parle, presque par hasard : elle a fait regarder son entreprise par quelqu'un de l'extérieur. Claire hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre ce qui manque à son équipe pour décider seule. Ce n'est ni la compétence, ni la motivation.
>
> Claire est soulagée. Et un peu sonnée. À la fin, elle dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C4 : Claire (4/4) : un an plus tard**
*Pré-en-tête : Trois jours de salon. Deux messages, tous les deux « pour information ».*

> Bonjour %FIRSTNAME%,
>
> Voici la fin de l'histoire de Claire.
>
> {{fin}}
>
> Elle s'est fait accompagner. Pas pour changer d'équipe : pour lui donner ce qui lui manquait pour décider sans elle.
>
> **Un an plus tard, un jeudi matin**
>
> Claire rentre de trois jours de salon. Trois jours, cette fois.
>
> Sur son téléphone, deux messages. Les deux commencent par « pour information ».
>
> Pendant son absence, l'équipe a pris quatre décisions. Trois sont celles qu'elle aurait prises. La quatrième, elle l'aurait prise autrement. Elle a très bien fonctionné.
>
> >> L'équipe est la même. Elle sait maintenant ce qu'elle a le droit de décider.
>
> **Claire n'existe pas. Cette boulangère, si.**
>
> Sa boulangerie est ouverte sept jours sur sept. Voici comment elle décrivait son équipe : « J'avais une équipe de vente qui me bouffait littéralement. »
>
> Ce qui a changé : une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés. Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés. Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> ![Une boulangère ouverte 7 jours sur 7 : voir son témoignage](temoignage-boulangere.jpg)(https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise.
>
> **Et votre histoire ?**
>
> Elle en est à l'épisode où Claire dit « je vais réfléchir ». La suite, c'est vous qui l'écrivez.
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Elle rappelle dans la semaine*

> Claire a rappelé le jeudi. Elle avait un autre salon dans deux mois, et elle ne voulait pas rentrer une deuxième fois devant vingt-trois messages.

**C4B**
*Bouton : Elle attend une période plus calme*

> Claire a attendu une période plus calme. Entre-temps, son meilleur élément a donné sa démission : il en avait assez de demander la permission. C'est ce jour-là qu'elle a rappelé.

**C4C**
*Bouton : Elle essaie de régler ça seule*

> Claire a essayé seule. Elle savait maintenant ce qui manquait, et elle a tenu un mois. Puis une urgence, puis une autre : le quotidien a tout repris. On ne change pas les habitudes d'une équipe en étant soi-même celle qui répond à tout. Elle a rappelé.

**C4N**

> Claire a hésité. Longtemps. Puis elle a rappelé.

---

## 5. Plafond (`plafond`)

Citation : « Mon chiffre d'affaires plafonne, malgré tous mes efforts »
Héros : Antoine

**C1 : L'histoire d'Antoine (1/4) : la même ligne qu'il y a trois ans**
*Pré-en-tête : Il n'a jamais autant travaillé. Son chiffre n'a pas bougé.*
*Question : À la place d'Antoine, que feriez-vous ?*

> ![L'histoire d'Antoine, épisode 1](recit-plafond.jpg)
>
> Bonjour %FIRSTNAME%,
>
> Avant notre échange, vous nous aviez dit :
>
> >> « Mon chiffre d'affaires plafonne, malgré tous mes efforts. »
>
> Laissez-nous vous raconter l'histoire d'Antoine. Il disait exactement la même chose.
>
> Antoine est chef d'entreprise, comme vous. Il n'existe pas tout à fait : son histoire est faite de celles des dirigeants que nous accompagnons. Vous allez sans doute vous y reconnaître.
>
> **Un soir de janvier**
>
> Antoine prépare sa nouvelle année. Par curiosité, il ressort ses chiffres d'il y a trois ans et les pose à côté de ceux de l'année qui s'achève.
>
> Les deux lignes se superposent presque.
>
> Il n'a pourtant jamais autant travaillé. Il a prospecté, communiqué, relancé. Chaque effort a donné un sursaut. Puis le chiffre est revenu se poser au même endroit, comme sous un plafond.
>
> Ce soir-là, Antoine se dit qu'il faut frapper plus fort. Trois idées lui viennent.
>
> {{choix}}
>
> Adrien & Emily

**C2A : Antoine (2/4) : la publicité**
*Pré-en-tête : Les demandes ont afflué. Il a coupé la publicité lui-même.*
*Bouton : Investir dans la publicité*
*Question : Et maintenant, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il met un vrai budget. Et cela fonctionne : en trois semaines, les demandes affluent.
>
> La quatrième semaine, les délais s'allongent. La cinquième, deux erreurs partent chez des clients. La sixième, un avis sévère apparaît en ligne, et l'équipe est à bout.
>
> Antoine coupe la publicité lui-même. Deux mois plus tard, le chiffre est revenu à son niveau habituel.
>
> **Ce qu'Antoine ne voit pas encore**
>
> Les clients étaient là. C'est l'entreprise qui n'a pas pu les servir correctement. Et sans y penser, il a lui-même refermé le robinet.
>
> >> Une entreprise ne vend pas ce que le marché peut acheter. Elle vend ce qu'elle est capable d'absorber.
>
> Antoine, lui, retient seulement ceci : il a trouvé des clients, et il a dû les refuser. Il commence à se demander si son plafond est vraiment du côté des ventes.
>
> {{choix}}
>
> Adrien & Emily

**C2B : Antoine (2/4) : la nouvelle offre**
*Pré-en-tête : Elle s'est bien vendue. Le total n'a pas bougé.*
*Bouton : Lancer une nouvelle offre*
*Question : Et maintenant, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il la prépare pendant deux mois, le soir. L'offre est bonne, et les clients l'accueillent bien.
>
> Seulement, c'est lui qui la porte. Chaque heure passée dessus est une heure prise ailleurs : un devis en retard, une relance oubliée, un client historique un peu délaissé.
>
> À la fin de l'année, la nouvelle offre a bien marché. Et le chiffre d'affaires total est le même.
>
> **Ce qu'Antoine ne voit pas encore**
>
> Il n'a pas ajouté une activité. Il a déplacé ses heures de l'une vers l'autre. Et ses heures, il n'en a pas une de plus.
>
> >> Quand tout repose sur une seule personne, une nouveauté ne s'ajoute pas : elle remplace.
>
> Antoine, lui, retient seulement ceci : même avec une offre qui se vend, le total ne bouge pas. Il commence à se demander si son plafond est vraiment du côté des ventes.
>
> {{choix}}
>
> Adrien & Emily

**C2C : Antoine (2/4) : la prospection**
*Pré-en-tête : Un mois il signe, le mois suivant il produit. Et ainsi de suite.*
*Bouton : Prospecter lui-même, tous les matins*
*Question : Et maintenant, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Tous les matins, de 8 heures à 10 heures, il appelle. Il est bon : en un mois, il signe trois nouveaux clients.
>
> Le mois suivant, il faut les servir. Les matinées de prospection sautent une à une. Deux mois plus tard, le carnet se vide, et Antoine reprend le téléphone.
>
> Sur l'année, son chiffre monte, descend, remonte. La moyenne est celle d'avant.
>
> **Ce qu'Antoine ne voit pas encore**
>
> Il fait à la fois la vente et tout le reste. Dès que le reste déborde, la vente s'arrête. Il ne peut pas pousser l'une sans lâcher l'autre.
>
> >> Son chiffre ne plafonne pas faute de clients. Il plafonne à la taille de ses propres journées.
>
> Antoine, lui, retient seulement ceci : il sait trouver des clients, et cela ne change rien. Il commence à se demander si son plafond est vraiment du côté des ventes.
>
> {{choix}}
>
> Adrien & Emily

**C3A : Antoine (3/4) : l'embauche**
*Pré-en-tête : Les charges ont monté tout de suite. La capacité, non.*
*Bouton : Il embauche pour produire plus*
*Question : Et là, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Le raisonnement est simple : s'il manque des bras, il faut des bras. Il recrute.
>
> Le salaire part dès le premier mois. La capacité, elle, n'arrive pas : il faut former, montrer, contrôler. Et c'est Antoine qui forme, montre et contrôle.
>
> Six mois plus tard, l'entreprise produit à peine plus. Ses charges, elles, ont bien augmenté.
>
> >> Il a ajouté des bras. Tout passe encore par les siens.
>
> Tant que chaque dossier doit repasser par lui, une personne de plus ne fait qu'allonger la file d'attente devant son bureau.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Antoine hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre où se trouve son plafond. Il n'est pas chez ses clients : il est à l'intérieur de l'entreprise, à un endroit précis.
>
> Antoine est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3B : Antoine (3/4) : la baisse des prix**
*Pré-en-tête : Plus de clients, plus de travail. Et moins à la fin.*
*Bouton : Il baisse ses prix pour faire du volume*
*Question : Et là, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il se dit qu'en étant moins cher, il prendra des parts aux concurrents. Il a raison : les commandes augmentent.
>
> Le travail aussi. L'équipe fait des heures, Antoine aussi. Le chiffre d'affaires dépasse enfin celui des années précédentes.
>
> À la fin de l'année, il regarde ce qui reste. C'est moins qu'avant.
>
> >> Il a enfin crevé son plafond de chiffre d'affaires. En passant par-dessous.
>
> Il a vendu davantage de ce qui, à ce prix-là, ne lui laisse presque plus rien.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Antoine hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre où se trouve son plafond. Il n'est pas chez ses clients : il est à l'intérieur de l'entreprise, à un endroit précis.
>
> Antoine est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C3C : Antoine (3/4) : attendre que ça reparte**
*Pré-en-tête : Son chiffre n'a pas bougé. Tout le reste, si.*
*Bouton : Il attend que le marché reparte*
*Question : Et là, que fait Antoine ?*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il se dit que la période est difficile pour tout le monde, et qu'il suffit de tenir. Il arrête de s'agiter.
>
> Son chiffre d'affaires ne bouge pas. C'est presque rassurant.
>
> Mais autour, tout bouge. Le loyer, l'énergie, les salaires, les fournisseurs. À la fin de l'année, avec le même chiffre, il lui reste nettement moins.
>
> >> Un chiffre d'affaires qui stagne, c'est un résultat qui recule.
>
> Et un concurrent, lui, n'a pas attendu.
>
> **Le déclic**
>
> C'est un autre dirigeant qui lui en parle, presque par hasard : il a fait regarder son entreprise par quelqu'un de l'extérieur. Antoine hésite, puis prend rendez-vous.
>
> Une heure d'échange. Pour la première fois, quelqu'un lui montre où se trouve son plafond. Il n'est pas chez ses clients : il est à l'intérieur de l'entreprise, à un endroit précis.
>
> Antoine est soulagé. Et un peu sonné. À la fin, il dit ce que tout le monde dit :
>
> >> « Je vais réfléchir. »
>
> {{choix}}
>
> Adrien & Emily

**C4 : Antoine (4/4) : un an plus tard**
*Pré-en-tête : Il ressort ses chiffres. Cette fois, les deux lignes ne se superposent plus.*

> Bonjour %FIRSTNAME%,
>
> Voici la fin de l'histoire d'Antoine.
>
> {{fin}}
>
> Il s'est fait accompagner. Pas pour vendre plus fort : pour déplacer le plafond là où il se trouvait vraiment.
>
> **Un an plus tard, un soir de janvier**
>
> Antoine ressort ses chiffres, comme chaque année. Il pose la nouvelle ligne à côté des anciennes.
>
> Pour la première fois depuis quatre ans, elle ne se superpose pas aux autres.
>
> Ce qui l'étonne le plus n'est pas là. Il n'a pas fait une campagne de plus, ni une heure de plus. Et quand les demandes arrivent, l'entreprise suit.
>
> >> Antoine n'a pas poussé plus fort. Il a relevé ce qui retenait tout le reste.
>
> **Antoine n'existe pas. Margaux, si.**
>
> Margaux a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Elle aurait pu faire comme tout le monde : plus de communication, plus d'offres, plus d'heures. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> Trois mois plus tard, avec ses mots : « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Son résultat lui appartient, et nous ne vous promettons pas le même.
>
> **Et votre histoire ?**
>
> Elle en est à l'épisode où Antoine dit « je vais réfléchir ». La suite, c'est vous qui l'écrivez.
>
> {{choix}}
>
> Adrien & Emily

**C4A**
*Bouton : Il rappelle dans la semaine*

> Antoine a rappelé le jeudi. Il avait refait le calcul : chaque année sous le même plafond lui coûtait un peu plus que la précédente.

**C4B**
*Bouton : Il attend la fin de l'année*

> Antoine a attendu la fin de l'année. En janvier, il a ressorti ses chiffres : une quatrième ligne s'est posée sur les trois autres. Il a rappelé le lendemain.

**C4C**
*Bouton : Il essaie de régler ça seul*

> Antoine a essayé seul. Il savait maintenant où se trouvait son plafond, et il a tenu un mois. Puis une urgence, puis une autre : le quotidien a tout repris. Savoir où est le problème ne suffit pas quand on est seul face à lui. Il a rappelé.

**C4N**

> Antoine a hésité. Longtemps. Puis il a rappelé.
