# Séquences après un « non » : une par frein

*Version 2 du 24/11/2026 (demande d'Adrien : plus agréable à lire, pensée pour rattraper un prospect). Mise en page et envoi vers ActiveCampaign : `api/_acSequencesData.json`.*

Syntaxe : `>> phrase` = encadré mis en avant ; `[ Libellé ]` = bouton (réservation par défaut, ou lien entre parenthèses) ; `[[ Libellé ]]` = lien de réservation discret ; `P.S.` après la signature.

## Comment ça marche

1. Le lendemain du rendez-vous, l'IA lit l'appel et choisit **un** frein. Team l'envoie directement à ActiveCampaign, qui :
   - pose le tag du frein (`frein_tresorerie`, `frein_timing`, `frein_decision`, `frein_preuves`, `frein_priorite` ou `frein_general`) ;
   - pose `stop_autom`, ce qui arrête le nurturing généraliste ;
   - retire le tag `rdv_a_venir`.
2. Chaque tag de frein déclenche sa propre automatisation : 5 e-mails, envoyés à **J+1, J+4, J+8, J+14 et J+21** après le rendez-vous, à 9 h 30.
3. **Sortie immédiate** de la séquence si le prospect reprend rendez-vous (tag `rdv_a_venir`) ou s'il devient client (tag `[vente] elite phenix`).

Règles appliquées partout :
- vouvoiement ;
- aucun prix ni fourchette de prix ;
- aucune garantie ;
- Alteore (le logiciel) jamais présenté comme inclus ;
- ni adresse postale ni téléphone ;
- signature « Adrien & Emily ».

`%FIRSTNAME%` est le prénom, rempli par ActiveCampaign.

Bouton de reprise de rendez-vous, sur le lien public (Self Booking) :
`https://team.alteore.com/booking.html?type=call_strat_phenix_all&utm_source=activecampaign&utm_campaign=<tag du frein>`

Témoignages : uniquement des clients réels, avec leurs propres mots, tirés de leurs vidéos (Drive et adrienemily.com).

---

## 1. Trésorerie / budget (`frein_tresorerie`)

**E1 (J+1) : Merci pour votre franchise**
*Pré-en-tête : La trésorerie, c'est le sujet de tous les dirigeants. Vraiment.*

> Bonjour %FIRSTNAME%,
>
> « Ce n'est pas le moment, la trésorerie est trop juste. » Vous nous l'avez dit sans détour lors de notre échange, et merci pour ça : la plupart des dirigeants le pensent sans oser le dire.
>
> C'est aussi la phrase que nous entendons le plus. Presque toujours de la part de dirigeants qui travaillent beaucoup, qui facturent, et qui ne comprennent pas pourquoi il reste si peu sur le compte à la fin du mois.
>
> >> La trésorerie n'est pas un chiffre. C'est un résultat.
>
> Elle découle de trois choses que vous avez déjà entre les mains :
>
> - **votre marge** : ce qui reste vraiment sur chaque vente ;
> - **le moment où vous encaissez** ;
> - **le moment où vous payez**.
>
> Dans les prochains jours, nous vous envoyons une piste concrète sur chacun de ces trois leviers. Rien à acheter : de quoi y voir plus clair, que nous travaillions ensemble ou non.
>
> Adrien & Emily
>
> P.S. Une question en attendant : savez-vous, à la semaine près, à quel moment du mois votre compte est au plus bas ? Si la réponse est « à peu près », le premier levier est là.

**E2 (J+4) : La marge qui disparaît sans bruit**
*Pré-en-tête : Le chiffre d'affaires monte, la trésorerie ne suit pas. Pourquoi ?*

> Bonjour %FIRSTNAME%,
>
> « Je travaille plus, je facture plus, et il ne reste rien. »
>
> Si cette phrase pourrait être la vôtre, le problème ne vient probablement pas de votre chiffre d'affaires. Il vient de ce qui s'échappe entre la facture et le compte en banque.
>
> Une prestation vendue un peu trop bas. Un fournisseur qui a augmenté sans que vos devis suivent. Du temps passé et jamais facturé. Pris un par un, c'est peu. Mis bout à bout, c'est souvent exactement ce qui manque en fin de mois.
>
> **L'exercice de la semaine (10 minutes)**
>
> Prenez vos trois derniers gros dossiers, chantiers ou clients. Pour chacun, comptez tout : les achats, les heures de l'équipe et **vos** heures. Puis classez-les du plus rentable au moins rentable.
>
> >> Le dossier dont on est le plus fier est rarement celui qui rapporte le plus.
>
> Si le classement vous surprend, vous venez de trouver votre premier chantier.
>
> [[ Envie d'en parler avec vos chiffres ? Reprenez un créneau ici ]]
>
> Adrien & Emily

**E3 (J+8) : Encaisser plus tôt, payer au bon moment**
*Pré-en-tête : Deux leviers que vous pouvez actionner dès lundi.*

> Bonjour %FIRSTNAME%,
>
> Deux entreprises, même activité, même chiffre d'affaires. Dans l'une, le dirigeant dort bien. Dans l'autre, il regarde son compte tous les matins. La différence tient rarement au talent : elle tient au calendrier.
>
> **Encaisser plus tôt**
>
> - un acompte à la commande, systématique ;
> - la facture envoyée le jour où le travail est terminé, pas à la fin du mois ;
> - une relance dès le lendemain de l'échéance, sans attendre « de voir ».
>
> **Payer au bon moment**
>
> - négocier vos délais fournisseurs avec le même sérieux que vos délais clients ;
> - étaler ce qui peut l'être, plutôt que tout régler d'un coup.
>
> Rien de spectaculaire. Mais appliqué avec rigueur pendant deux mois, c'est souvent plusieurs semaines d'air retrouvées, sans vendre davantage.
>
> >> À faire dès lundi : choisissez une seule de ces cinq lignes, et appliquez-la à tous vos dossiers en cours.
>
> Adrien & Emily
>
> P.S. La semaine prochaine : l'histoire de Franck, boulanger, parti d'un bilan dans le rouge.

**E4 (J+14) : Ce que coûte le fait d'attendre**
*Pré-en-tête : Une question honnête, à vous poser au calme.*

> Bonjour %FIRSTNAME%,
>
> Quand la trésorerie se tend, le réflexe est de tout geler. Y compris ce qui pourrait la débloquer. C'est humain, et c'est le piège dans lequel beaucoup de dirigeants restent coincés pendant des années.
>
> La question utile n'est pas « ai-je le budget aujourd'hui ? ». C'est celle-ci :
>
> >> Combien me coûte chaque mois où rien ne change ?
>
> Franck est boulanger. Quand il a commencé avec nous, son bilan était dans le rouge. Cinq mois plus tard, il était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois.
>
> Ce qu'il en dit :
>
> >> « Avant, j'étais inconscient et j'avais peur. Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> [ Voir le témoignage de Franck ](https://vimeo.com/1204547163)
>
> Son résultat lui appartient, et ce n'est pas une promesse pour votre entreprise. Mais son point de départ ressemble peut-être au vôtre.
>
> [[ Refaire le point avec vos chiffres d'aujourd'hui ]]
>
> Adrien & Emily

**E5 (J+21) : On en reparle ?**
*Pré-en-tête : Si le sujet est toujours d'actualité, notre porte est ouverte.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé depuis notre échange.
>
> Peut-être avez-vous testé une ou deux pistes de ces e-mails. Peut-être que le quotidien a repris le dessus : c'est le cas le plus fréquent, et il n'y a rien à se reprocher.
>
> Si la trésorerie vous occupe toujours l'esprit, nous vous proposons de refaire le point, 45 minutes, avec vos chiffres d'aujourd'hui :
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

---

## 2. Pas le bon moment (`frein_timing`)

**E1 (J+1) : Bien noté pour le timing**
*Pré-en-tête : Le bon moment ne se présente presque jamais tout seul.*

> Bonjour %FIRSTNAME%,
>
> Vous nous avez dit, lors de notre échange, que ce n'était pas le bon moment. C'est noté, et nous le respectons : personne ne connaît votre agenda mieux que vous.
>
> Nous vous laissons seulement une observation, tirée de ce que nous voyons chaque semaine.
>
> >> Le bon moment ne se présente presque jamais tout seul.
>
> Il y a toujours une saison chargée, un salarié à remplacer, un projet à finir. Les dirigeants qui avancent n'ont pas plus de temps que les autres : ils ont décidé d'un moment, au lieu de l'attendre.
>
> Nous n'allons pas vous relancer pour vous faire changer d'avis. Dans les prochaines semaines, nous vous envoyons simplement quelques idées courtes, utilisables tout de suite, même en pleine période chargée.
>
> Adrien & Emily
>
> P.S. Première idée dans trois jours : comment reconnaître une « période chargée » qui n'en est pas une.

**E2 (J+4) : Le piège de la période chargée**
*Pré-en-tête : Plus on est débordé, plus on a besoin de lever la tête.*

> Bonjour %FIRSTNAME%,
>
> « Je verrai quand ça se calmera. »
>
> Nous l'avons tous dit. Le souci, c'est que dans une entreprise qui tourne, ça ne se calme jamais vraiment : chaque période chargée en cache une autre.
>
> Pour faire la différence entre un vrai pic d'activité et un problème d'organisation, posez-vous trois questions :
>
> 1. Les mêmes urgences reviennent-elles à chaque saison haute ?
> 2. Est-ce toujours vous qui rattrapez les retards, le soir ou le week-end ?
> 3. Vous êtes-vous déjà dit « l'an prochain, on s'organisera autrement »… l'an dernier ?
>
> >> Trois « oui » : ce n'est pas le calendrier. C'est l'organisation.
>
> Et une organisation, ça se revoit. Pas forcément en grand : deux ou trois décisions suffisent souvent à changer une saison entière.
>
> [[ En parler 45 minutes, au moment qui vous arrange ]]
>
> Adrien & Emily

**E3 (J+8) : 15 minutes par semaine**
*Pré-en-tête : Un rituel simple pour reprendre la main, même en pleine saison.*

> Bonjour %FIRSTNAME%,
>
> Pas le temps de prendre du recul ? Voici un rituel qui tient en 15 minutes, et que beaucoup de dirigeants gardent même après notre accompagnement.
>
> **Le vendredi, avant de fermer, trois questions**
>
> 1. **Qu'est-ce qui m'a pris le plus de temps cette semaine**, et qu'un autre aurait pu faire ?
> 2. **Quelle décision ai-je repoussée ?**
> 3. **Quel chiffre dois-je regarder lundi matin ?**
>
> Notez vos réponses, toujours au même endroit. C'est tout.
>
> Au bout d'un mois, relisez vos quatre vendredis. Si la même tâche ou la même décision revient à chaque fois, vous tenez votre priorité.
>
> >> On ne reprend pas la main sur son entreprise en un grand soir. On la reprend un vendredi après l'autre.
>
> Adrien & Emily
>
> P.S. Essayez dès cette semaine, et dites-nous ce qui en est ressorti : répondez à cet e-mail, nous lisons tout.

**E4 (J+14) : Ce qui se passe quand on attend**
*Pré-en-tête : Le statu quo a un coût, même quand il ne se voit pas.*

> Bonjour %FIRSTNAME%,
>
> Attendre a l'air neutre. Ça ne l'est pas : chaque mois où rien ne change prolonge les mêmes soirées trop longues, la même marge qui s'effrite, la même fatigue.
>
> Alexandre est boucher-charcutier-traiteur. Son chiffre d'affaires montait et il avait, selon ses mots, « la tête dans le guidon ». Un soir, une fois tout le monde payé, il a fait ce constat :
>
> >> « J'ai fait plaisir à tout le monde, sauf à moi-même. »
>
> Aujourd'hui, ses marges sont reprises, ses fiches de production sont calées, et à 19 h 30 il passe à table avec toute sa famille.
>
> Son conseil à ceux qui hésitent : demandez-vous plutôt combien vous allez perdre à attendre.
>
> [ Voir le témoignage d'Alexandre ](https://drive.google.com/file/d/1tPEoSaGRAGXZmo_h0x16eb8gWfl3aDBK/view)
>
> Son parcours n'est pas une promesse pour le vôtre. Mais sa situation de départ, beaucoup de dirigeants la reconnaissent.
>
> Adrien & Emily

**E5 (J+21) : Et si on fixait la date maintenant ?**
*Pré-en-tête : Même pour plus tard, autant la bloquer dès aujourd'hui.*

> Bonjour %FIRSTNAME%,
>
> Vous nous aviez dit que ce n'était pas le bon moment. Quelques semaines plus tard, il n'est peut-être toujours pas venu. C'est normal : il ne vient pas tout seul.
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

---

## 3. Doit en parler à quelqu'un (`frein_decision`)

**E1 (J+1) : Pour en parler à deux**
*Pré-en-tête : Une décision qui engage l'entreprise se prend rarement seul.*

> Bonjour %FIRSTNAME%,
>
> Vous souhaitez en parler avant de décider. C'est sain : une décision qui engage votre entreprise ne se prend pas seul, sur un coin de table.
>
> Seulement, vous l'avez sans doute déjà vécu : raconter un échange à quelqu'un qui n'y était pas, c'est compliqué. On oublie la moitié, l'autre pose une question à laquelle on n'a pas la réponse, et la discussion tourne court.
>
> Nous allons donc vous faciliter la tâche. Dans les prochains jours, vous recevrez :
>
> - **notre démarche en trois phrases**, à reprendre telles quelles ;
> - **les réponses aux questions** que se posent le plus souvent un associé ou un conjoint ;
> - **une façon simple d'en parler à deux**, directement avec nous.
>
> Vous pourrez transférer ces e-mails tels quels.
>
> Adrien & Emily
>
> P.S. La personne concernée a déjà une question précise ? Répondez à cet e-mail : nous vous aidons à y répondre.

**E2 (J+4) : L'accompagnement en trois phrases**
*Pré-en-tête : De quoi le présenter simplement, sans jargon.*

> Bonjour %FIRSTNAME%,
>
> Comment expliquer notre démarche à votre associé ou à votre conjoint, sans jargon et sans y passer la soirée ? Voici trois phrases, à reprendre telles quelles.
>
> 1. **« On part de la situation réelle de l'entreprise. »** Les chiffres, l'organisation, ce qui bloque aujourd'hui. Pas une méthode plaquée de l'extérieur.
> 2. **« On choisit peu de priorités. »** Deux ou trois chantiers, ceux qui ont le plus d'effet, plutôt qu'une liste de quarante bonnes idées.
> 3. **« On est accompagnés dans la durée. »** Pour que les changements tiennent, au lieu de s'essouffler au bout de trois semaines.
>
> >> Le plus simple : transférez-lui cet e-mail.
>
> Et si une question revient après votre discussion, notez-la. Nous répondons aux plus fréquentes dans le prochain e-mail, et à la vôtre si vous nous l'écrivez.
>
> Adrien & Emily

**E3 (J+8) : Les questions qu'on nous pose le plus**
*Pré-en-tête : Celles que votre associé ou votre conjoint se pose peut-être aussi.*

> Bonjour %FIRSTNAME%,
>
> Quand un dirigeant parle de notre accompagnement autour de lui, trois questions reviennent presque à chaque fois. Les voici, avec nos réponses.
>
> **« Combien de temps ça demande ? »**
>
> Un rythme régulier, calé sur votre activité. Le but est de vous rendre du temps, pas de vous en prendre.
>
> **« Est-ce adapté à une entreprise comme la nôtre ? »**
>
> Nous accompagnons des TPE et des PME de tous secteurs : boulangerie, boucherie, restauration, institut de beauté… Chaque accompagnement part de la situation de l'entreprise, jamais d'un modèle tout fait.
>
> **« Et si ça ne marche pas pour nous ? »**
>
> C'est précisément ce que l'audit sert à vérifier, avant tout engagement. S'il n'y a pas de quoi avancer ensemble, nous vous le disons.
>
> Une autre question ? Répondez à cet e-mail.
>
> [[ Ou venez la poser à deux, de vive voix ]]
>
> Adrien & Emily

**E4 (J+14) : Et si vous veniez à deux ?**
*Pré-en-tête : Le plus simple est souvent d'en parler tous ensemble.*

> Bonjour %FIRSTNAME%,
>
> Vous avez peut-être essayé d'en parler. Et vous avez peut-être constaté que résumer 45 minutes d'échange en cinq minutes au dîner, ça ne marche pas très bien.
>
> C'est pour cela que beaucoup de dirigeants choisissent de refaire un échange **à deux**, avec leur associé ou leur conjoint :
>
> - chacun pose ses propres questions ;
> - personne n'a à « défendre » le projet devant l'autre ;
> - la décision se prend ensemble, en connaissance de cause, dans un sens ou dans l'autre.
>
> Choisissez simplement un créneau où vous êtes disponibles tous les deux.
>
> [ Réserver un échange à deux ]
>
> Adrien & Emily
>
> P.S. Un « non » décidé à deux vaut mieux qu'une décision qui traîne : au moins, le sujet est réglé.

**E5 (J+21) : Où en êtes-vous ?**
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
> Et si vous préférez refaire le point de vive voix, seul ou à deux :
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 4. Besoin de preuves (`frein_preuves`)

**E1 (J+1) : Vous avez raison de vouloir des preuves**
*Pré-en-tête : Ne vous engagez jamais sur une promesse.*

> Bonjour %FIRSTNAME%,
>
> Vous voulez voir du concret avant de vous engager. Vous avez raison, et nous vous dirions la même chose à votre place :
>
> >> Ne vous engagez jamais sur une promesse.
>
> Dans notre métier, les belles promesses ne manquent pas. Ce qui compte, ce sont des dirigeants réels, avec un point de départ, des décisions, et un résultat qu'ils racontent eux-mêmes.
>
> C'est ce que nous allons vous montrer dans les prochains jours :
>
> - **Margaux**, épicerie fine et restaurant ;
> - **Delphine**, esthéticienne depuis 25 ans ;
> - et, entre les deux, **ce que nous ne promettons pas**. Autant être clairs.
>
> Chaque témoignage est en vidéo, avec leurs mots à eux, pas les nôtres.
>
> Adrien & Emily
>
> P.S. Vous avez un secteur ou une situation en tête ? Répondez à cet e-mail : si nous avons accompagné un dirigeant proche de votre cas, nous vous le dirons.

**E2 (J+4) : Margaux, épicerie fine et restaurant**
*Pré-en-tête : Trois mois plus tard : +20 % de chiffre d'affaires, +8 % de marge.*

> Bonjour %FIRSTNAME%,
>
> Margaux a ouvert sa première entreprise en 2023 : une épicerie fine avec un restaurant italien.
>
> **Son point de départ.** Elle se sentait seule face à toutes les décisions.
>
> **Ce qu'elle a fait.** Elle a restructuré son équipe, recruté et appris à déléguer.
>
> **Trois mois plus tard**, avec ses mots :
>
> >> « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. »
>
> Et surtout : « Je peux enfin déléguer. »
>
> [ Voir le témoignage de Margaux ](https://vimeo.com/1204547192)
>
> Ce qui nous frappe dans son parcours : rien de tout cela n'est venu d'un effort commercial de plus. Tout est venu de l'organisation.
>
> Son résultat lui appartient, et nous ne vous promettons pas le même. Mais si vous vous sentez seul face aux décisions, son histoire mérite d'être regardée.
>
> Adrien & Emily

**E3 (J+8) : Ce que nous ne promettons pas**
*Pré-en-tête : Autant être clair dès le départ.*

> Bonjour %FIRSTNAME%,
>
> Vous avez peut-être déjà été déçu par un prestataire, un consultant ou une formation. Alors autant être clairs, avant d'aller plus loin.
>
> **Ce que nous ne faisons pas**
>
> - promettre un miracle en trois semaines ;
> - faire le travail à votre place ;
> - vous vendre une méthode toute faite, qui ignore votre entreprise.
>
> **Ce que nous faisons**
>
> - partir de vos chiffres et de votre organisation ;
> - vous aider à prendre les bonnes décisions, dans le bon ordre ;
> - vous accompagner pour les tenir dans la durée.
>
> Une boulangère que nous accompagnons nous a dit un jour :
>
> >> « Vous ne m'avez pas vendu du rêve. »
>
> C'est le compliment qui nous fait le plus plaisir.
>
> [[ Voir ce que cela donnerait pour votre entreprise ]]
>
> Adrien & Emily

**E4 (J+14) : Delphine, institut de beauté**
*Pré-en-tête : 25 ans de métier, et pourtant l'angoisse de la trésorerie chaque mois.*

> Bonjour %FIRSTNAME%,
>
> Delphine est esthéticienne depuis 25 ans. Vingt-cinq ans de métier, et pourtant, chaque mois, ce qu'elle appelle « l'angoisse de la tréso permanente ».
>
> **Son point de départ.** Seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h.
>
> **Ce qu'elle a fait.** Elle a revu ses charges, renégocié ses contrats, recalculé ses prestations et organisé ses tâches.
>
> **Le résultat**, selon ses mots :
>
> >> « J'ai économisé 15 000 euros sur l'année. »
>
> Et elle termine désormais vers 18 h.
>
> Elle avait, elle aussi, un doute au départ : celui de « l'arnaque ». Il n'a pas tenu longtemps.
>
> [ Voir le témoignage de Delphine ](https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Adrien & Emily

**E5 (J+21) : Voir par vous-même**
*Pré-en-tête : La meilleure preuve reste celle qui vous concerne.*

> Bonjour %FIRSTNAME%,
>
> Margaux, Delphine : leurs histoires donnent une idée. Mais la seule preuve qui compte vraiment, c'est ce que cela donnerait **pour votre entreprise**.
>
> C'est ce que nous vous proposons de regarder ensemble, 45 minutes, avec vos chiffres d'aujourd'hui :
>
> 1. où part réellement votre marge ;
> 2. ce qui vous prend le plus de temps ;
> 3. les deux ou trois actions qui auraient le plus d'effet chez vous.
>
> Vous repartez avec ces priorités, que nous travaillions ensemble ou non. Et si nous pensons ne pas pouvoir vous aider, nous vous le dirons.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 5. Pas prioritaire / pas convaincu (`frein_priorite`)

**E1 (J+1) : Merci pour notre échange**
*Pré-en-tête : Une question à garder en tête cette semaine.*

> Bonjour %FIRSTNAME%,
>
> Merci pour le temps que vous nous avez accordé. Vous préférez avancer par vous-même pour l'instant : c'est tout à fait légitime, et beaucoup de dirigeants solides fonctionnent ainsi.
>
> Nous vous laissons une seule question pour la semaine :
>
> >> Qu'est-ce qui vous prend le plus d'énergie aujourd'hui, et qui sera encore là dans un an si rien ne change ?
>
> Ne répondez pas trop vite. La première réponse est souvent « le manque de temps ». La vraie se trouve en général juste derrière.
>
> Dans les prochains e-mails, nous partageons trois outils simples pour avancer seul :
>
> - un test pour savoir si l'entreprise dépend trop de vous ;
> - les trois chiffres à suivre chaque mois ;
> - ce que font différemment les dirigeants qui avancent.
>
> Gardez-les, même si nous ne travaillons jamais ensemble.
>
> Adrien & Emily

**E2 (J+4) : Le dirigeant goulot d'étranglement**
*Pré-en-tête : Si tout remonte à vous, ce n'est pas un problème de motivation.*

> Bonjour %FIRSTNAME%,
>
> Imaginez : vous partez deux semaines, sans téléphone.
>
> Qu'est-ce qui s'arrête ? Les devis ? Les commandes ? Les décisions du quotidien ? Les réponses aux questions de l'équipe ?
>
> >> Tout ce qui s'arrêterait sans vous, c'est ce qui vous empêche aujourd'hui de souffler.
>
> Dans beaucoup d'entreprises, tout finit par remonter au dirigeant. Au début, c'est normal : c'est même ce qui fait décoller l'activité. Au bout de quelques années, c'est ce qui bloque l'entreprise, et ce qui épuise celui qui la porte.
>
> Ce n'est pas un problème de motivation, ni de compétence de l'équipe. C'est une question d'organisation : qui décide quoi, avec quelles consignes, sans passer par vous.
>
> **L'exercice de la semaine**
>
> Pendant trois jours, notez chaque question qu'on vous pose. Vendredi, entourez celles auxquelles quelqu'un d'autre aurait pu répondre avec une consigne claire.
>
> Adrien & Emily
>
> P.S. La liste est presque toujours plus longue qu'on ne le pensait.

**E3 (J+8) : Trois chiffres à suivre chaque mois**
*Pré-en-tête : Pas besoin d'un tableau de bord compliqué.*

> Bonjour %FIRSTNAME%,
>
> Un tableau de bord de quarante lignes, personne ne le regarde. Trois chiffres, notés une fois par mois, suffisent souvent pour piloter.
>
> 1. **Votre marge.** Pas le chiffre d'affaires : ce qui reste une fois vos coûts payés.
> 2. **Votre trésorerie disponible en fin de mois.** Le chiffre qui dit si vous dormez bien.
> 3. **Votre temps.** La part de vos semaines passée dans l'opérationnel, comparée à celle passée à développer l'entreprise.
>
> **Comment faire**
>
> Le premier de chaque mois, notez ces trois chiffres au même endroit. Dix minutes, pas plus.
>
> >> Au bout de trois mois, vous ne verrez plus des chiffres : vous verrez une tendance. Et vous saurez où agir.
>
> Adrien & Emily
>
> P.S. Le troisième chiffre est celui que presque personne ne suit. C'est souvent lui qui explique les deux autres.

**E4 (J+14) : Ce que nous voyons chez les dirigeants qui avancent**
*Pré-en-tête : Ce n'est pas une question de talent.*

> Bonjour %FIRSTNAME%,
>
> Les dirigeants qui progressent le plus vite ont rarement plus de talent que les autres. Ils ont fait deux choses : arrêter de tout porter seuls, et se donner un cadre pour décider.
>
> Une boulangère que nous accompagnons, ouverte sept jours sur sept, le raconte mieux que nous :
>
> >> « J'avais une équipe de vente qui me bouffait littéralement. »
>
> **Ce qu'elle a changé.** Une nouvelle équipe, des plannings revus, des horaires d'ouverture repensés.
>
> **Ce que ça a donné.** Plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés.
>
> Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> [ Voir son témoignage ](https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Son résultat n'est pas une promesse pour votre entreprise. Mais si votre équipe vous prend plus d'énergie qu'elle ne vous en rend, son histoire vous parlera.
>
> Adrien & Emily

**E5 (J+21) : Où en êtes-vous ?**
*Pré-en-tête : Si vous voulez faire le point, c'est par ici.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé. Vous vouliez avancer par vous-même : où en êtes-vous ?
>
> Si vous avez essayé le test des deux semaines sans téléphone ou les trois chiffres du mois, vous avez peut-être déjà repéré ce qui coince. C'est le plus difficile, et vous l'avez fait seul.
>
> Pour aller plus vite sur la suite, nous pouvons refaire le point, 45 minutes :
>
> - ce que vous avez repéré ;
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

---

## 6. Général : rien d'exploitable dans l'appel (`frein_general`)

Quatre e-mails seulement, à J+1, J+5, J+12 et J+21.

**E1 (J+1) : Merci pour notre échange**
*Pré-en-tête : Trois idées utiles, sans rien vous demander.*

> Bonjour %FIRSTNAME%,
>
> Merci pour le temps que vous nous avez accordé.
>
> Quelle que soit la suite, nous ne voulons pas que cet échange reste sans rien pour vous. Dans les prochaines semaines, nous vous envoyons donc trois idées courtes, utilisables tout de suite :
>
> - un test pour savoir si votre entreprise dépend trop de vous ;
> - les trois chiffres à suivre chaque mois ;
> - puis un point d'étape, si vous le souhaitez.
>
> Rien à acheter, rien à préparer.
>
> Adrien & Emily
>
> P.S. Une question vous est venue après notre échange ? Répondez à cet e-mail : nous lisons tout.

**E2 (J+5)** reprend **E2 « Le dirigeant goulot d'étranglement »** de la séquence 5.

**E3 (J+12)** reprend **E3 « Trois chiffres à suivre chaque mois »** de la séquence 5.

**E4 (J+21) : Où en êtes-vous ?**
*Pré-en-tête : Si vous voulez faire le point, c'est par ici.*

> Bonjour %FIRSTNAME%,
>
> Quelques semaines ont passé depuis notre échange. Où en êtes-vous ?
>
> Si le test des deux semaines sans téléphone ou les trois chiffres du mois vous ont fait repérer quelque chose, c'est le bon moment pour en faire une action.
>
> Nous pouvons refaire le point ensemble, 45 minutes :
>
> - ce que vous avez repéré ;
> - ce qu'il vaut mieux traiter en premier ;
> - deux ou trois actions concrètes pour les semaines qui viennent.
>
> Vous repartez avec, que nous travaillions ensemble ou non.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 7. Rendez-vous manqué : no-show, ou annulé sans report (`rdv_manque`)

Le prospect quitte le nurturing dès sa réservation. Si le rendez-vous n'a pas lieu, il ne reprend donc pas le nurturing général : il reçoit cette courte séquence. Elle s'ajoute au SMS de rattrapage et à l'appel du closer, qui partent le jour même.

- E1 : le lendemain à 9 h 30 ; E2 : 3 jours après ; E3 : 7 jours après.
- Sortie automatique s'il reprend rendez-vous (`rdv_a_venir`) ou devient client.

**E1 (J+1) : Votre rendez-vous n'a pas pu avoir lieu**
*Pré-en-tête : Ça arrive. On vous garde une place.*

> Bonjour %FIRSTNAME%,
>
> Notre rendez-vous n'a pas pu avoir lieu.
>
> Un client qui débarque, un salarié absent, une journée qui déborde : c'est le quotidien d'un dirigeant, et vous n'avez rien à justifier.
>
> Mais ce qui vous avait poussé à réserver est sans doute toujours là. Alors plutôt que de laisser filer, reprenez simplement un créneau, au moment qui vous arrange vraiment :
>
> [ Choisir un nouveau créneau ]
>
> Cela prend une minute, et vous n'avez toujours rien à préparer.
>
> Adrien & Emily
>
> P.S. Un conseil : choisissez un moment où vous êtes sûr d'être au calme, tôt le matin ou en fin de journée. C'est là que l'échange est le plus utile.

**E2 (J+3) : Ce que vous auriez retiré de l'audit**
*Pré-en-tête : 45 minutes pour y voir clair sur votre entreprise.*

> Bonjour %FIRSTNAME%,
>
> Vous aviez réservé un audit, et il n'a pas eu lieu. Voici concrètement ce qui s'y passe en 45 minutes, pour que vous sachiez ce que vous y gagnez.
>
> 1. **On commence par vous.** Ce qui vous prend le plus de temps et d'énergie aujourd'hui, avec vos mots.
> 2. **On met le doigt sur ce qui bloque.** Le plus souvent la marge ou l'organisation, bien plus que le commercial.
> 3. **Vous repartez avec vos priorités.** Deux ou trois actions concrètes, que nous travaillions ensemble ou non.
>
> Franck, boulanger, résume ce que cela change d'y voir clair :
>
> >> « Avant, j'étais inconscient et j'avais peur. Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> Vous n'avez rien à préparer.
>
> [ Réserver mon audit ]
>
> Adrien & Emily

**E3 (J+7) : On garde le contact ?**
*Pré-en-tête : Un mot suffit.*

> Bonjour %FIRSTNAME%,
>
> Nous ne voulons pas vous encombrer. Voici donc notre dernier message sur ce sujet, avec deux options.
>
> **C'est toujours d'actualité ?** Votre créneau vous attend :
>
> [ Choisir un créneau ]
>
> **Ce n'est plus le moment ?** Répondez simplement « plus tard » à cet e-mail. C'est noté, et nous n'insistons pas.
>
> Dans les deux cas, merci de vous être intéressé à notre travail.
>
> Adrien & Emily
>
> P.S. Quelque chose vous a retenu, une question, un doute ? Dites-le-nous en une ligne : nous préférons le savoir.
