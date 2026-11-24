# Séquences d'après-RDV à choix : une histoire par douleur

*Version du 24/11/2026, arbre validé par Adrien (`arbre-sequences-choix.html`). Textes à valider.*

## Principe

- Les réponses de l'ancien formulaire (« Quel est votre principal défi ? ») n'ouvrent pas d'histoire : les textes citent la question et les mots du nouveau questionnaire.
- La **douleur** vient de la première question du questionnaire (« Qu'est-ce qui vous pèse le plus dans votre entreprise aujourd'hui ? »). Cinq réponses, cinq histoires : `rentabilite`, `operationnel`, `vie`, `equipe`, `plafond`.
- Le **frein** (trésorerie, timing, décision, preuves, priorité, général) ouvre et ferme la séquence. Quand le prospect suit une histoire, ses e-mails 1 et 5 sont ceux de la section « 0. Freins avec histoire » : ils citent sa réponse et n'annoncent pas les e-mails du frein, qui ne partiront pas.
- Chaque histoire a **sept chapitres** (C1 à C7). L'e-mail 2 est toujours le chapitre 1. À la fin de chaque chapitre, trois boutons proposent trois chapitres pas encore lus ; celui que le prospect choisit est son e-mail suivant (sans clic : le premier des trois). Il lit quatre chapitres (e-mails 2 à 5) ; le quatrième ne propose plus que la prise de RDV. L'e-mail 6 est celui du frein.
- `*Bouton : …*` = le libellé du chapitre sur les boutons et sur la fiche du prospect.
- Chaque e-mail dit **ce qui se passe** et **pourquoi**, jamais **comment** le régler. Le comment, c'est l'audit.
- Vouvoiement, aucun prix, aucune garantie, témoignages réels avec leurs propres mots.

Syntaxe : `>> phrase` = encadré ; `[ Libellé ]` = bouton de réservation (ou lien entre parenthèses) ; `[[ Libellé ]]` = lien discret ; `{{choix}}` = les boutons des chapitres suivants (ou le bouton de réservation au dernier chapitre) ; `{{ouverture}}` = « Vous avez choisi… » après un clic, « Voici la suite… » sinon ; `![texte](image)` = image ; `{{m_…}}` = phrase miroir, tirée d'une réponse à choix du prospect (la ligne disparaît si la réponse manque).

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
*Bouton : Où part l'argent ?*

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
> {{m_marge}}
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
> Il s'échappe par trois endroits. Dans la plupart des entreprises, un seul fait presque tout le dégât. Et c'est rarement celui que le dirigeant soupçonne.
>
> {{choix}}
>
> Adrien & Emily

**C2 : Les trois endroits où l'argent s'échappe**
*Pré-en-tête : Un seul fait presque tout le dégât. Lequel, chez vous ?*
*Bouton : Les trois endroits où l'argent s'échappe*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> L'argent d'une entreprise s'échappe par trois endroits. Lisez-les en pensant à vos trois derniers mois.
>
> **1. Ce que vous vendez à perte sans le savoir**
>
> Dans presque chaque entreprise, une partie de l'activité coûte plus qu'elle ne rapporte, une fois tout compté. Noyée dans le reste, elle ne se voit pas. C'est souvent le produit dont on est le plus fier, ou le client le plus ancien.
>
> **2. Ce qui a augmenté sans que vos prix suivent**
>
> Matières, énergie, salaires, abonnements : chaque hausse est petite, et aucune ne justifie à elle seule de tout revoir. Additionnées sur deux ans, elles ont parfois avalé toute la marge.
>
> **3. Votre temps, que personne ne paie**
>
> Les heures passées à rattraper, à refaire, à dépanner. Elles ne figurent sur aucune facture. Ce sont pourtant le premier coût caché d'une entreprise qui repose sur son dirigeant.
>
> >> Un seul de ces trois endroits explique en général l'essentiel du problème.
>
> Lequel, chez vous ? Vos chiffres le disent en moins d'une heure, à condition de savoir où regarder. C'est ce que nous faisons pendant un audit : nous ne vous dirons pas de vendre plus, nous vous montrerons par où l'argent s'en va.
>
> [[ Voir par où il s'en va chez moi ]]
>
> {{choix}}
>
> Adrien & Emily

**C3 : Comment Franck est sorti du rouge**
*Pré-en-tête : « Avant, j'étais inconscient et j'avais peur. »*
*Bouton : Comment Franck est sorti du rouge*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Franck est boulanger. Quand il a commencé avec nous, son bilan était dans le rouge. Et quand il raconte cette période, il ne parle ni de ses clients ni de ses fournisseurs. Il parle de lui :
>
> >> « Avant, j'étais inconscient et j'avais peur. »
>
> Relisez la phrase. La peur ne venait pas seulement de la situation. Elle venait de ne pas la voir : avancer sans savoir où l'on en est, ouvrir son compte en retenant son souffle.
>
> ![Franck, boulanger : voir son témoignage](temoignage-franck.jpg)(https://vimeo.com/1204547163)
>
> Cinq mois plus tard, Franck était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois. Et la fin de sa phrase a changé :
>
> >> « Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais son point de départ vous dira peut-être quelque chose.
>
> {{m_marge}}
>
> [[ Voir clair sur mes chiffres ]]
>
> {{choix}}
>
> Adrien & Emily

**C4 : Delphine : 25 ans de métier, et l'angoisse chaque fin de mois**
*Pré-en-tête : « J'ai économisé 15 000 euros sur l'année. »*
*Bouton : Delphine : 15 000 euros économisés en un an*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> On pourrait croire qu'avec l'expérience, la question de l'argent finit par se régler toute seule. Delphine prouve que non.
>
> Elle est esthéticienne depuis vingt-cinq ans. Seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h. Et chaque mois revenait ce qu'elle appelle « l'angoisse de la tréso permanente ».
>
> {{m_sommeil}}
>
> **Ce qu'elle a regardé en face**
>
> Ses charges, ses contrats, le calcul de ses prestations, l'organisation de ses tâches. Rien d'héroïque : simplement ce qu'elle n'avait jamais eu le temps de poser à plat.
>
> >> « J'ai économisé 15 000 euros sur l'année. »
>
> Et elle termine désormais vers 18 h.
>
> ![Delphine, institut de beauté : voir son témoignage](temoignage-delphine.jpg)(https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Elle avait un doute au départ, celui de « l'arnaque ». Il n'a pas tenu longtemps.
>
> {{m_12mois}}
>
> [[ En parler avec nous, chiffres en main ]]
>
> {{choix}}
>
> Adrien & Emily

**C5 : Ce que coûte une année de plus comme ça**
*Pré-en-tête : Un calcul simple, à faire au calme.*
*Bouton : Ce que coûte une année de plus comme ça*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Quand il ne reste presque rien à la fin du mois, on se dit qu'on verra plus tard. Le mois prochain sera meilleur. Après la saison. Après le bilan.
>
> Sauf qu'attendre n'est pas gratuit. Voici un calcul que personne ne fait, et qui prend deux minutes.
>
> **Le calcul**
>
> Prenez ce que vous estimez devoir vous verser chaque mois pour le travail que vous fournissez. Retirez ce que vous vous versez vraiment. La différence, multipliée par douze, c'est ce que vous coûte une année de plus dans la même situation.
>
> >> Ce chiffre ne figure dans aucun bilan. C'est pourtant le plus important de votre entreprise.
>
> {{m_12mois}}
>
> Et il y a ce qui ne se chiffre pas : les décisions repoussées faute de marge, l'investissement qu'on n'ose pas faire, et la fatigue de travailler autant pour si peu de reste.
>
> La bonne nouvelle, c'est que ce coût n'est pas une fatalité : il vient d'endroits précis, que l'on peut trouver.
>
> [[ Trouver d'où il vient chez vous ]]
>
> {{choix}}
>
> Adrien & Emily

**C6 : Ce qu'on regarderait dans vos chiffres**
*Pré-en-tête : 45 minutes, trois regards, aucun jargon.*
*Bouton : Ce qu'on regarderait dans vos chiffres*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> « Un audit », cela peut vouloir tout dire. Voici donc, très concrètement, ce que nous regarderions avec vous si vous nous disiez à nouveau : « Je fais du chiffre, mais il ne me reste presque rien. »
>
> **1. Ce qui vous rapporte vraiment**
>
> Pas votre chiffre d'affaires : ce qui reste sur chacune de vos activités, une fois tout compté. C'est souvent là qu'arrive la première surprise.
>
> {{m_marge}}
>
> **2. Ce qui a bougé sans que vous le décidiez**
>
> Les charges qui ont monté, les prix qui n'ont pas suivi, les habitudes qui coûtent. Rien de spectaculaire pris un par un.
>
> **3. Ce que vous faites, vous**
>
> Votre temps est le premier coût de l'entreprise. Où il passe en dit long sur l'endroit où part l'argent.
>
> >> Vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
>
> Vous n'avez rien à préparer : nous partons de ce que vous savez déjà.
>
> [[ Réserver ces 45 minutes ]]
>
> {{choix}}
>
> Adrien & Emily

**C7 : Les questions qu'on nous pose avant de se lancer**
*Pré-en-tête : Les trois que presque tout le monde se pose.*
*Bouton : Les questions qu'on nous pose avant de se lancer*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avant de se lancer, presque tous les dirigeants nous posent les mêmes questions. Les voici, avec nos réponses.
>
> **« Je n'ai pas de trésorerie, comment faire ? »**
>
> C'est la question la plus fréquente, et elle est légitime. C'est aussi la raison pour laquelle l'audit commence par là : savoir d'où vient le manque avant de décider quoi que ce soit.
>
> **« Combien de temps ça me prendra ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre : si l'accompagnement devient une charge de plus, c'est qu'il est mal réglé, et on le règle.
>
> **« Et si ça ne marche pas pour moi ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. Nous regardons votre situation réelle. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail : nous lisons tout, et nous répondons.
>
> [[ Ou posez-la de vive voix, pendant un audit ]]
>
> {{choix}}
>
> Adrien & Emily

---

## 2. Opérationnel (`operationnel`)

Citation : « Je suis noyé dans l'opérationnel, je n'ai plus une minute pour piloter »

**C1 : Plus une minute pour piloter. Ce n'est pas une question de temps.**
*Pré-en-tête : Tout ce que vous avez tenté a ajouté du travail au lieu d'en enlever.*
*Bouton : Plus une minute pour piloter*

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
> Il y a une raison précise pour laquelle rien n'a tenu, et elle est la même dans presque toutes les entreprises que nous rencontrons.
>
> {{choix}}
>
> Adrien & Emily

**C2 : Pourquoi rien de ce que vous avez tenté n'a tenu**
*Pré-en-tête : Le travail revient toujours vers la même personne.*
*Bouton : Pourquoi rien de ce que vous avez tenté n'a tenu*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Pourquoi rien de ce que vous avez tenté n'a tenu ? Voici ce que nous voyons, presque à chaque fois.
>
> Dans une entreprise, le travail va vers celui qui sait. Et celui qui sait, c'est vous.
>
> **Ce qui se passe quand vous embauchez**
>
> La nouvelle personne ne sait pas encore. Alors elle demande, et vous répondez. Vous avez une paire de bras en plus, et une source de questions en plus.
>
> **Ce qui se passe quand vous bloquez du temps**
>
> Le créneau est dans l'agenda. Puis un client appelle, un salarié hésite, un problème surgit. Vous seul pouvez trancher, donc le créneau saute.
>
> **Ce qui se passe quand vous changez d'outil**
>
> L'outil range mieux les tâches. Il ne dit à personne quoi décider à votre place.
>
> >> Tant que le savoir et les décisions restent dans une seule tête, tout ce qu'on ajoute autour finit par revenir vers elle.
>
> {{m_2semaines}}
>
> Ce n'est pas un défaut de votre équipe, ni un manque de volonté de votre part. C'est une organisation qui s'est construite toute seule, au fil des années, autour de vous.
>
> La bonne nouvelle : une organisation, ça se redessine. Par où commencer chez vous, c'est ce qu'un audit permet de voir en 45 minutes.
>
> [[ Voir par où commencer chez moi ]]
>
> {{choix}}
>
> Adrien & Emily

**C3 : Ce qui a changé chez Margaux en trois mois**
*Pré-en-tête : « Je peux enfin déléguer. »*
*Bouton : Ce qui a changé chez Margaux en trois mois*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Margaux a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Deux activités, une équipe, et une impression qu'elle décrit simplement : elle se sentait seule face à toutes les décisions.
>
> Tout passait par elle. Comme chez vous, peut-être.
>
> {{m_charge}}
>
> **Ce qu'elle a changé**
>
> Elle n'a pas travaillé plus. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Trois mois plus tard, avec ses mots :
>
> >> « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Et la phrase qui compte le plus, pour quelqu'un qui n'avait plus une minute :
>
> >> « Je peux enfin déléguer. »
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais remarquez d'où il vient : pas d'un effort de plus. D'une autre façon de répartir le travail.
>
> [[ Voir ce que ça donnerait chez moi ]]
>
> {{choix}}
>
> Adrien & Emily

**C4 : « J'avais une équipe qui me bouffait littéralement »**
*Pré-en-tête : Ouverte sept jours sur sept. Voici ce qu'elle a changé.*
*Bouton : La boulangère que son équipe « bouffait »*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Quand on est noyé dans l'opérationnel, on pense d'abord à soi : mes heures, mon agenda, ma fatigue. Une boulangère que nous accompagnons a regardé ailleurs.
>
> Sa boulangerie est ouverte sept jours sur sept. Et voici comment elle décrivait son quotidien :
>
> >> « J'avais une équipe de vente qui me bouffait littéralement. »
>
> Ce n'était pas elle le problème. Ni vraiment son équipe. C'était la façon dont le travail était organisé entre eux.
>
> **Ce qu'elle a changé**
>
> Une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés.
>
> **Ce que ça a donné**
>
> Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés.
>
> ![Une boulangère ouverte 7 jours sur 7 : voir son témoignage](temoignage-boulangere.jpg)(https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> {{m_temps}}
>
> [[ Regarder ensemble ce qui vous retient dans l'opérationnel ]]
>
> {{choix}}
>
> Adrien & Emily

**C5 : Ce que coûte une année de plus dans l'opérationnel**
*Pré-en-tête : Le prix ne se voit pas dans les comptes.*
*Bouton : Ce que coûte une année de plus dans l'opérationnel*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Être noyé dans l'opérationnel, on s'y habitue. L'entreprise tourne, les clients sont servis, les salaires sont payés. Alors pourquoi changer ?
>
> Parce que le prix existe, même s'il n'apparaît dans aucun compte.
>
> **Ce qui n'est pas fait**
>
> Pendant que vous produisez, dépannez et rattrapez, personne ne regarde les chiffres, ne prépare la suite, ne remarque le client qui s'éloigne ou le salarié qui décroche. Ce sont les tâches que vous seul pouvez faire, et ce sont les premières sacrifiées.
>
> **Ce qui s'installe**
>
> Chaque mois de plus rend l'entreprise un peu plus dépendante de vous. Ce qui se réorganise facilement aujourd'hui sera plus lourd à changer dans un an.
>
> {{m_duree}}
>
> >> Une entreprise qui ne tient que par son dirigeant ne grandit pas : elle s'use à sa vitesse.
>
> {{m_temps}}
>
> Ce n'est pas une question de courage. C'est une question d'ordre : par quoi commencer pour que la première heure libérée en libère d'autres.
>
> [[ Voir par où commencer chez vous ]]
>
> {{choix}}
>
> Adrien & Emily

**C6 : Ce qu'on regarderait dans vos semaines**
*Pré-en-tête : 45 minutes, trois regards, aucun jargon.*
*Bouton : Ce qu'on regarderait dans vos semaines*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> « Un audit », cela peut vouloir tout dire. Voici donc, très concrètement, ce que nous regarderions avec vous si vous nous disiez à nouveau : « Je n'ai plus une minute pour piloter. »
>
> **1. Où passent vos heures**
>
> Pas un emploi du temps idéal : votre semaine réelle. Ce que vous faites, ce que vous seul savez faire, et ce que vous faites parce que personne d'autre ne s'en charge.
>
> {{m_heures}}
>
> **2. Ce qui revient vers vous**
>
> Les questions, les validations, les urgences. D'où elles viennent, et pourquoi elles n'ont pas d'autre destination que votre bureau.
>
> **3. Ce qui pourrait tourner sans vous**
>
> Presque toujours plus qu'on ne le croit. Encore faut-il savoir par quoi commencer, pour que cela tienne.
>
> >> Vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
>
> Vous n'avez rien à préparer : nous partons de ce que vous vivez.
>
> [[ Réserver ces 45 minutes ]]
>
> {{choix}}
>
> Adrien & Emily

**C7 : Les questions qu'on nous pose avant de se lancer**
*Pré-en-tête : Les trois que presque tout le monde se pose.*
*Bouton : Les questions qu'on nous pose avant de se lancer*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avant de se lancer, presque tous les dirigeants nous posent les mêmes questions. Les voici, avec nos réponses.
>
> **« Je n'ai déjà pas le temps, comment en trouver pour ça ? »**
>
> C'est la question que posent tous ceux qui sont noyés, et c'est normal. Le premier travail consiste justement à vous rendre des heures, pas à en demander. On commence par ce qui libère le plus vite.
>
> **« Combien de temps ça me prendra ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre : si l'accompagnement devient une charge de plus, c'est qu'il est mal réglé, et on le règle.
>
> **« Et si ça ne marche pas pour moi ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. Nous regardons votre situation réelle. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail : nous lisons tout, et nous répondons.
>
> [[ Ou posez-la de vive voix, pendant un audit ]]
>
> {{choix}}
>
> Adrien & Emily

---

## 3. Vie avalée (`vie`)

Citation : « Mon entreprise a avalé ma vie : soirées, week-ends et vacances y passent »

**C1 : Soirées, week-ends, vacances : votre entreprise a tout pris**
*Pré-en-tête : Travailler plus n'a jamais rendu une seule soirée.*
*Bouton : Votre entreprise a tout pris*

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
> Ce qui vous retient au travail le soir n'est presque jamais ce que vous croyez. Ce n'est ni la charge, ni les clients, ni la conscience professionnelle.
>
> {{choix}}
>
> Adrien & Emily

**C2 : Ce qui vous retient vraiment le soir**
*Pré-en-tête : Ce n'est ni la charge, ni les clients.*
*Bouton : Ce qui vous retient vraiment le soir*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Qu'est-ce qui vous retient vraiment au travail le soir ? Faites le test : repensez à votre dernière soirée passée au travail. Que faisiez-vous, précisément ?
>
> Dans presque tous les cas, la réponse tombe dans l'une de ces trois cases.
>
> **1. Ce que vous seul savez faire**
>
> Les devis, la paie, les commandes, ce dossier délicat. Personne d'autre ne sait, donc cela attend le soir, quand vous êtes enfin tranquille.
>
> **2. Ce que la journée ne vous a pas laissé faire**
>
> Votre vrai travail commence quand les autres partent, parce que la journée a été mangée par les questions, les urgences et les imprévus.
>
> **3. Ce que vous rattrapez**
>
> L'erreur à corriger, le travail à refaire, le client à rassurer.
>
> >> Dans les trois cas, le soir ne sert pas à travailler plus. Il sert à faire ce que l'organisation de la journée n'a pas permis.
>
> C'est pour cela que tenir ne règle rien : tant que la journée reste la même, le soir est déjà pris d'avance.
>
> {{m_temps}}
>
> Laquelle de ces trois cases pèse le plus chez vous ? C'est la première chose que nous regardons pendant un audit, parce que la réponse désigne ce qu'il faut changer en premier.
>
> [[ Regarder ce qui me retient ]]
>
> {{choix}}
>
> Adrien & Emily

**C3 : Comment Alexandre passe à table à 19 h 30**
*Pré-en-tête : « J'ai fait plaisir à tout le monde, sauf à moi-même. »*
*Bouton : Comment Alexandre passe à table à 19 h 30*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Alexandre est boucher-charcutier-traiteur. Son chiffre d'affaires montait. De l'extérieur, tout allait bien. De l'intérieur, il avait, selon ses mots, « la tête dans le guidon ».
>
> Un soir, une fois tout le monde payé, il a fait un constat :
>
> >> « J'ai fait plaisir à tout le monde, sauf à moi-même. »
>
> Cette phrase, beaucoup de dirigeants pourraient la signer. On donne à l'entreprise, à l'équipe, aux clients. Et ce qui reste pour soi, en temps comme en argent, c'est ce que les autres ont laissé.
>
> ![Alexandre, boucher-charcutier-traiteur : voir son témoignage](temoignage-alexandre.jpg)(https://drive.google.com/file/d/1tPEoSaGRAGXZmo_h0x16eb8gWfl3aDBK/view)
>
> Aujourd'hui, ses marges sont reprises, ses fiches de production sont calées, et à 19 h 30 il passe à table avec toute sa famille.
>
> Son conseil à ceux qui hésitent : demandez-vous plutôt combien vous allez perdre à attendre.
>
> Son parcours n'est pas une promesse pour le vôtre. Mais il montre une chose : ses soirées ne sont pas revenues parce qu'il a levé le pied. Elles sont revenues parce que l'entreprise a été organisée autrement.
>
> [[ Voir ce qui me rendrait mes soirées ]]
>
> {{choix}}
>
> Adrien & Emily

**C4 : Delphine : de 9 h à 19 h, seule, depuis 25 ans**
*Pré-en-tête : Elle termine désormais à 18 h.*
*Bouton : Delphine : une heure gagnée chaque jour*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> On se dit parfois que les horaires sans fin sont le prix à payer quand on est à son compte. Delphine l'a cru pendant vingt-cinq ans.
>
> Esthéticienne, seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h. Et par-dessus les heures, il y avait ce qu'elle appelle « l'angoisse de la tréso permanente ».
>
> Les deux vont souvent ensemble : on travaille tard parce que l'argent inquiète, et l'argent inquiète parce qu'on n'a jamais le temps de le regarder en face.
>
> **Ce qu'elle a posé à plat**
>
> Ses charges, ses contrats, le calcul de ses prestations, l'organisation de ses tâches.
>
> >> « J'ai économisé 15 000 euros sur l'année. »
>
> Et elle termine désormais vers 18 h.
>
> ![Delphine, institut de beauté : voir son témoignage](temoignage-delphine.jpg)(https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Une heure par jour, cela paraît peu. Sur une année, c'est plus d'un mois de soirées retrouvées.
>
> {{m_temps}}
>
> [[ Parler de ce qui vous rendrait du temps ]]
>
> {{choix}}
>
> Adrien & Emily

**C5 : Ce que coûte une année de plus à ce rythme**
*Pré-en-tête : Certaines choses ne se rattrapent pas.*
*Bouton : Ce que coûte une année de plus à ce rythme*

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
> {{m_rythme}}
>
> **Ce qui ne revient pas**
>
> Un dîner manqué se rattrape. Une année de dîners manqués, non.
>
> >> Votre entreprise peut attendre une semaine. Certaines choses, autour de vous, n'attendent pas.
>
> {{m_temps}}
>
> Et il y a un paradoxe : plus vous donnez d'heures, plus l'entreprise s'organise autour de votre présence. Attendre ne rapproche pas du moment où elle pourra s'en passer. Cela l'éloigne.
>
> [[ Regarder ce qui pourrait changer, dès maintenant ]]
>
> {{choix}}
>
> Adrien & Emily

**C6 : Ce qu'on regarderait dans vos journées**
*Pré-en-tête : 45 minutes, trois regards, aucun jargon.*
*Bouton : Ce qu'on regarderait dans vos journées*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> « Un audit », cela peut vouloir tout dire. Voici donc, très concrètement, ce que nous regarderions avec vous si vous nous disiez à nouveau : « Mon entreprise a avalé ma vie. »
>
> **1. Ce qui remplit vos soirées**
>
> Ce que vous faites après la fermeture, précisément. C'est le meilleur indice de ce que la journée ne vous laisse pas faire.
>
> **2. Ce qui repose sur vous seul**
>
> Les tâches que personne d'autre ne sait faire, et celles que tout le monde vous laisse par habitude.
>
> {{m_2semaines}}
>
> **3. Ce que vous voulez retrouver**
>
> Pas un objectif d'entreprise : le vôtre. Une heure de fermeture, un jour dans la semaine, des vacances sans téléphone. C'est lui qui fixe l'ordre des priorités.
>
> >> Vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
>
> Vous n'avez rien à préparer : nous partons de ce que vous vivez.
>
> [[ Réserver ces 45 minutes ]]
>
> {{choix}}
>
> Adrien & Emily

**C7 : Les questions qu'on nous pose avant de se lancer**
*Pré-en-tête : Les trois que presque tout le monde se pose.*
*Bouton : Les questions qu'on nous pose avant de se lancer*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avant de se lancer, presque tous les dirigeants nous posent les mêmes questions. Les voici, avec nos réponses.
>
> **« Si je lève le pied, est-ce que tout ne va pas s'écrouler ? »**
>
> C'est la crainte de tous ceux dont l'entreprise repose sur eux, et elle est fondée : lever le pied sans rien changer, cela ne marche pas. Il s'agit d'organiser autrement, pour que votre absence ne se voie plus.
>
> **« Combien de temps ça me prendra ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre : si l'accompagnement devient une charge de plus, c'est qu'il est mal réglé, et on le règle.
>
> **« Et si ça ne marche pas pour moi ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. Nous regardons votre situation réelle. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail : nous lisons tout, et nous répondons.
>
> [[ Ou posez-la de vive voix, pendant un audit ]]
>
> {{choix}}
>
> Adrien & Emily

---

## 4. Équipe (`equipe`)

Citation : « Mes salariés viennent me voir pour tout : rien n'avance sans moi »

**C1 : Rien n'avance sans vous. Et ce n'est pas la faute de votre équipe.**
*Pré-en-tête : Une équipe qui remonte tout n'est pas une équipe incapable.*
*Bouton : Rien n'avance sans vous*

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
> {{m_autonome}}
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
> {{choix}}
>
> Adrien & Emily

**C2 : Pourquoi tout remonte jusqu'à vous**
*Pré-en-tête : Il manque trois choses à votre équipe, et aucune n'est la compétence.*
*Bouton : Pourquoi tout remonte jusqu'à vous*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Pourquoi tout remonte-t-il jusqu'à vous ? Voici ce qui manque à une équipe qui demande tout. Trois choses, et aucune n'est la compétence.
>
> **1. Savoir ce qui est attendu**
>
> Pas « bien faire son travail » : le résultat précis, celui qui vous fait dire que c'est bon. Tant qu'il n'existe que dans votre tête, la seule façon de le connaître est de vous le demander.
>
> **2. Savoir jusqu'où décider**
>
> Un geste commercial, une commande urgente, un client mécontent : qui a le droit de trancher, et jusqu'à quel point ? Sans limite claire, la décision la plus prudente pour un salarié est de ne pas en prendre.
>
> **3. Savoir ce qui se passe en cas d'erreur**
>
> Si chaque erreur finit par « laisse, je vais le faire », l'équipe retient une seule leçon : le patron préfère faire lui-même.
>
> >> Votre équipe ne manque pas d'initiative. Elle manque de cadre pour en prendre sans risque.
>
> {{m_2semaines}}
>
> C'est aussi pour cela que répéter les consignes ne change rien : une consigne dit quoi faire aujourd'hui, pas comment décider demain.
>
> Lequel de ces trois manques pèse le plus chez vous ? En 45 minutes d'audit, cela se voit, et c'est par là qu'il faut commencer.
>
> [[ Voir ce qui manque à mon équipe ]]
>
> {{choix}}
>
> Adrien & Emily

**C3 : Ce qu'une boulangère a changé dans son équipe**
*Pré-en-tête : « J'avais une équipe de vente qui me bouffait littéralement. »*
*Bouton : Ce qu'une boulangère a changé dans son équipe*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Sa boulangerie est ouverte sept jours sur sept. Sept jours où il faut du monde derrière le comptoir, des plannings qui tiennent, des absences à remplacer. Et voici comment elle décrivait son équipe :
>
> >> « J'avais une équipe de vente qui me bouffait littéralement. »
>
> Le mot est fort. Il dit bien ce que vivent beaucoup de dirigeants : une équipe censée soulager, et qui prend toute l'énergie.
>
> **Ce qu'elle a changé**
>
> Une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés. Autrement dit : pas seulement les personnes, mais la façon dont le travail est réparti entre elles.
>
> ![Une boulangère ouverte 7 jours sur 7 : voir son témoignage](temoignage-boulangere.jpg)(https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> **Ce que ça a donné**
>
> Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés.
>
> Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais si votre équipe vous prend plus d'énergie qu'elle ne vous en rend, son histoire vous parlera.
>
> [[ Regarder mon équipe avec un œil extérieur ]]
>
> {{choix}}
>
> Adrien & Emily

**C4 : Margaux : « Je peux enfin déléguer »**
*Pré-en-tête : Elle se sentait seule face à toutes les décisions.*
*Bouton : Margaux : « Je peux enfin déléguer »*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Il y a une solitude particulière chez le dirigeant dont l'équipe demande tout : on est entouré toute la journée, et seul devant chaque décision.
>
> Margaux la connaissait. Elle a ouvert sa première entreprise en 2023, une épicerie fine avec un restaurant italien, et elle se sentait seule face à toutes les décisions.
>
> **Ce qu'elle a fait**
>
> Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> >> « Je peux enfin déléguer. »
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Et ce qui est arrivé ensuite n'était pas le but, mais la conséquence. Trois mois plus tard : « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Une équipe qui décide, c'est un dirigeant qui retrouve du temps. Et ce temps, il finit toujours par se voir dans les chiffres.
>
> {{m_12mois}}
>
> [[ Parler de votre équipe avec nous ]]
>
> {{choix}}
>
> Adrien & Emily

**C5 : Ce que coûte une équipe qui attend le patron**
*Pré-en-tête : Le prix se paie chaque jour, sans facture.*
*Bouton : Ce que coûte une équipe qui attend le patron*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Une équipe qui vient vous voir pour tout, on finit par trouver cela normal. On répond, on tranche, on passe à la question suivante. Et la journée est finie.
>
> Faites pourtant le compte, une seule fois.
>
> **Le compte**
>
> Combien de fois par jour êtes-vous interrompu pour une question, une validation, un « je fais comment ? ». Multipliez par le temps qu'il vous faut pour répondre, puis pour retrouver le fil de ce que vous faisiez.
>
> >> Ce temps-là, vous le payez deux fois : le vôtre, et celui du salarié qui attend votre réponse.
>
> {{m_consignes}}
>
> **Ce qui s'installe**
>
> Vos meilleurs éléments finissent par se lasser de demander la permission. Les autres s'habituent à ne plus décider. Et le jour où vous êtes absent, tout s'arrête.
>
> {{m_2semaines}}
>
> Chaque mois de plus ancre un peu plus l'habitude. Ce n'est pas une question de personnes : c'est une question de cadre, et un cadre se construit.
>
> [[ Voir ce qui manque à votre équipe pour décider ]]
>
> {{choix}}
>
> Adrien & Emily

**C6 : Ce qu'on regarderait dans votre équipe**
*Pré-en-tête : 45 minutes, trois regards, aucun jargon.*
*Bouton : Ce qu'on regarderait dans votre équipe*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> « Un audit », cela peut vouloir tout dire. Voici donc, très concrètement, ce que nous regarderions avec vous si vous nous disiez à nouveau : « Rien n'avance sans moi. »
>
> **1. Ce qui remonte, et pourquoi**
>
> Les questions qu'on vous pose dans une journée. Lesquelles demandent vraiment votre avis, et lesquelles arrivent chez vous faute de savoir où aller.
>
> **2. Qui décide de quoi**
>
> Ce que chacun a le droit de trancher seul, dans les faits. C'est rarement écrit, et c'est presque toujours là que tout se joue.
>
> {{m_autonome}}
>
> **3. Ce qui se passe quand vous n'êtes pas là**
>
> Le meilleur test d'une organisation, et le plus honnête.
>
> >> Vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
>
> Vous n'avez rien à préparer : nous partons de ce que vous vivez avec votre équipe.
>
> [[ Réserver ces 45 minutes ]]
>
> {{choix}}
>
> Adrien & Emily

**C7 : Les questions qu'on nous pose avant de se lancer**
*Pré-en-tête : Les trois que presque tout le monde se pose.*
*Bouton : Les questions qu'on nous pose avant de se lancer*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avant de se lancer, presque tous les dirigeants nous posent les mêmes questions. Les voici, avec nos réponses.
>
> **« Et si le problème venait vraiment de mon équipe ? »**
>
> C'est possible, et l'audit le dira. Mais dans la plupart des cas, les mêmes personnes se comportent tout autrement dès qu'elles savent ce qu'on attend d'elles et jusqu'où elles peuvent décider. On commence donc par le cadre.
>
> **« Combien de temps ça me prendra ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre : si l'accompagnement devient une charge de plus, c'est qu'il est mal réglé, et on le règle.
>
> **« Et si ça ne marche pas pour moi ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. Nous regardons votre situation réelle. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail : nous lisons tout, et nous répondons.
>
> [[ Ou posez-la de vive voix, pendant un audit ]]
>
> {{choix}}
>
> Adrien & Emily

---

## 5. Plafond (`plafond`)

Citation : « Mon chiffre d'affaires plafonne, malgré tous mes efforts »

**C1 : Vous faites tout ce qu'il faut, et le chiffre ne bouge plus**
*Pré-en-tête : Un plafond vient rarement des ventes.*
*Bouton : Le chiffre ne bouge plus*

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
> {{m_charge}}
>
> « Malgré tous mes efforts » : tout est dans ces mots. Vous ne restez pas les bras croisés. Vous prospectez, vous communiquez, vous relancez. Et le chiffre reste, à peu de chose près, où il était.
>
> **Le réflexe : pousser plus fort**
>
> Plus de publicité, plus de démarchage, une nouvelle offre. Chaque effort donne un petit sursaut, puis le chiffre retombe à son niveau habituel. Comme s'il existait un plafond invisible.
>
> Il existe. Et il est rarement là où on le cherche : dans la plupart des entreprises, le plafond n'est pas du côté des ventes.
>
> {{choix}}
>
> Adrien & Emily

**C2 : D'où vient vraiment un plafond**
*Pré-en-tête : Votre entreprise vend exactement ce qu'elle peut absorber.*
*Bouton : D'où vient vraiment un plafond*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> D'où vient un plafond ? Voici ce que nous constatons, presque à chaque fois.
>
> >> Une entreprise ne vend pas ce que le marché peut acheter. Elle vend ce qu'elle est capable d'absorber.
>
> Faites le test. Si vous receviez demain 30 % de commandes en plus, que se passerait-il ?
>
> Dans la plupart des cas : des retards, des erreurs, une équipe débordée, et vous au milieu pour tout rattraper. Sans même y penser, vous lèveriez le pied sur le commercial jusqu'à ce que le calme revienne.
>
> **C'est cela, le plafond**
>
> Ce n'est pas un manque de clients. C'est la limite de ce que l'entreprise sait produire correctement avec son organisation actuelle. Et quand tout repose sur le dirigeant, cette limite a un nom : ses journées.
>
> {{m_charge}}
>
> {{m_2semaines}}
>
> C'est pour cela que pousser plus fort sur les ventes ne change rien : on remplit un verre déjà plein.
>
> Où se trouve exactement la limite chez vous ? Dans la production, dans l'équipe, dans vos propres heures ? C'est la première chose qu'un audit fait apparaître, et c'est elle qui dit par où commencer.
>
> [[ Trouver où se situe mon plafond ]]
>
> {{choix}}
>
> Adrien & Emily

**C3 : Margaux : 20 % de plus, sans effort commercial supplémentaire**
*Pré-en-tête : Tout est venu de l'organisation.*
*Bouton : Margaux : 20 % de plus sans effort commercial*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Margaux a ouvert sa première entreprise en 2023 : une épicerie fine, avec un restaurant italien. Elle se sentait seule face à toutes les décisions.
>
> Elle aurait pu faire comme tout le monde : plus de communication, plus d'offres, plus d'heures. Elle a fait autre chose. Elle a restructuré son équipe, recruté, et appris à déléguer.
>
> ![Margaux, épicerie fine et restaurant : voir son témoignage](temoignage-margaux.jpg)(https://vimeo.com/1204547192)
>
> Trois mois plus tard, avec ses mots :
>
> >> « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Ce qui nous frappe dans son parcours : rien de cela n'est venu d'un effort commercial de plus. Tout est venu de l'organisation. En libérant du temps et des décisions, elle a relevé le plafond de ce que son entreprise pouvait absorber.
>
> >> « Je peux enfin déléguer. »
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais si vous poussez depuis des mois sur les ventes sans voir le chiffre bouger, son histoire mérite d'être regardée.
>
> [[ Voir où se situe mon plafond ]]
>
> {{choix}}
>
> Adrien & Emily

**C4 : Franck : du rouge à l'équilibre en cinq mois**
*Pré-en-tête : « Aujourd'hui, je suis conscient et je n'ai plus peur. »*
*Bouton : Franck : du rouge à l'équilibre en cinq mois*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Quand le chiffre plafonne, on regarde le haut de la colonne : les ventes. Franck, lui, a regardé le bas : ce qui reste.
>
> Franck est boulanger. Quand il a commencé avec nous, son bilan était dans le rouge. Et voici comment il décrit cette période :
>
> >> « Avant, j'étais inconscient et j'avais peur. »
>
> Inconscient : il avançait sans savoir précisément où il en était.
>
> ![Franck, boulanger : voir son témoignage](temoignage-franck.jpg)(https://vimeo.com/1204547163)
>
> Cinq mois plus tard, il était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois.
>
> >> « Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> Son histoire rappelle une chose que l'on oublie quand on a les yeux rivés sur le chiffre d'affaires : faire grandir ce qui reste est parfois plus rapide que faire grandir ce qui entre.
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise.
>
> {{m_12mois}}
>
> [[ Regarder vos chiffres avec nous ]]
>
> {{choix}}
>
> Adrien & Emily

**C5 : Ce que coûte une année de plus sous le plafond**
*Pré-en-tête : Stagner n'est jamais vraiment stable.*
*Bouton : Ce que coûte une année de plus sous le plafond*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Un chiffre d'affaires qui plafonne, cela ressemble à de la stabilité. On ne perd rien, on ne gagne rien, on tient.
>
> Sauf que rien, autour, ne reste immobile.
>
> **Ce qui monte pendant que vous stagnez**
>
> Les charges, les salaires, les matières, les loyers. Avec un chiffre qui ne bouge pas, chaque hausse se prend sur ce qui vous reste.
>
> >> Un chiffre d'affaires qui stagne, c'est un résultat qui recule.
>
> **Ce que coûtent les efforts**
>
> Vous poussez : publicité, prospection, nouvelles offres. Chaque tentative coûte du temps et de l'argent, pour un sursaut qui retombe. Une année de plus, c'est une année d'efforts de plus contre le même mur.
>
> {{m_levier}}
>
> **Ce qui s'érode**
>
> L'envie, la vôtre et celle de l'équipe. Rien n'use autant que de donner beaucoup sans voir bouger le résultat.
>
> Tant que l'origine du plafond n'est pas trouvée, pousser plus fort ne change rien. La trouver, en revanche, change tout.
>
> [[ Trouver d'où vient votre plafond ]]
>
> {{choix}}
>
> Adrien & Emily

**C6 : Ce qu'on regarderait pour trouver votre plafond**
*Pré-en-tête : 45 minutes, trois regards, aucun jargon.*
*Bouton : Ce qu'on regarderait pour trouver votre plafond*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> « Un audit », cela peut vouloir tout dire. Voici donc, très concrètement, ce que nous regarderions avec vous si vous nous disiez à nouveau : « Mon chiffre d'affaires plafonne, malgré tous mes efforts. »
>
> **1. Ce que votre entreprise peut absorber**
>
> Que se passerait-il avec un tiers de commandes en plus ? La réponse montre où se trouve la vraie limite : la production, l'équipe, ou vos propres heures.
>
> {{m_charge}}
>
> **2. Ce que vos efforts ont vraiment donné**
>
> Ce que vous avez tenté pour vendre plus, et ce que chaque tentative a rapporté. On y voit vite ce qui mérite d'être poursuivi.
>
> **3. Ce qui reste, plutôt que ce qui entre**
>
> Faire grandir le résultat est parfois plus rapide que faire grandir le chiffre.
>
> >> Vous repartez avec deux ou trois priorités, que nous travaillions ensemble ou non.
>
> Vous n'avez rien à préparer : nous partons de ce que vous savez déjà.
>
> [[ Réserver ces 45 minutes ]]
>
> {{choix}}
>
> Adrien & Emily

**C7 : Les questions qu'on nous pose avant de se lancer**
*Pré-en-tête : Les trois que presque tout le monde se pose.*
*Bouton : Les questions qu'on nous pose avant de se lancer*

> Bonjour %FIRSTNAME%,
>
> {{ouverture}}
>
> Avant de se lancer, presque tous les dirigeants nous posent les mêmes questions. Les voici, avec nos réponses.
>
> **« J'ai déjà tout essayé, qu'est-ce que vous feriez de plus ? »**
>
> Sans doute rien de plus du côté des ventes, justement. Quand un chiffre plafonne malgré les efforts, la réponse se trouve presque toujours ailleurs : dans ce que l'entreprise est capable d'absorber. C'est là que nous regardons.
>
> **« Combien de temps ça me prendra ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre : si l'accompagnement devient une charge de plus, c'est qu'il est mal réglé, et on le règle.
>
> **« Et si ça ne marche pas pour moi ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. Nous regardons votre situation réelle. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail : nous lisons tout, et nous répondons.
>
> [[ Ou posez-la de vive voix, pendant un audit ]]
>
> {{choix}}
>
> Adrien & Emily
