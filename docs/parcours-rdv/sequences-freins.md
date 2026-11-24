# Séquences après un « non » : une par frein

*Brouillon du 24/11/2026, à valider par Adrien avant création dans ActiveCampaign.*

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
> Merci pour notre échange d'hier, et merci surtout d'avoir été franc sur la trésorerie. C'est la raison la plus fréquente pour laquelle un dirigeant dit « pas maintenant », et c'est une raison sérieuse.
>
> Je voudrais vous laisser une idée, une seule : la trésorerie n'est pas un chiffre, c'est un résultat. Elle est la conséquence de trois choses que vous pilotez déjà : votre marge, le moment où vous encaissez et le moment où vous payez.
>
> Dans les prochains jours, je vous envoie quelques pistes concrètes sur chacun de ces trois leviers. Rien à acheter, juste de quoi y voir plus clair.
>
> Adrien & Emily

**E2 (J+4) : La marge qui disparaît sans bruit**
*Pré-en-tête : Le chiffre d'affaires monte, la trésorerie ne suit pas. Pourquoi ?*

> Bonjour %FIRSTNAME%,
>
> Beaucoup de dirigeants que nous accompagnons font le même constat : « Je travaille plus, je facture plus, et pourtant il ne reste rien à la fin du mois. »
>
> La réponse se cache presque toujours dans la marge, chantier par chantier, client par client ou produit par produit. Une prestation vendue trop bas, un poste de dépense qui a glissé, du temps non facturé… Pris un par un, c'est peu. Mis bout à bout, c'est souvent ce qui manque en trésorerie.
>
> Un exercice simple pour cette semaine : prenez vos trois derniers gros dossiers et demandez-vous lequel vous a vraiment rapporté de l'argent, une fois tout compté, votre temps compris.
>
> Vous serez peut-être surpris.
>
> Adrien & Emily

**E3 (J+8) : Encaisser plus tôt, payer au bon moment**
*Pré-en-tête : Deux leviers que vous pouvez actionner dès lundi.*

> Bonjour %FIRSTNAME%,
>
> À activité égale, deux entreprises peuvent avoir une trésorerie très différente. La différence tient souvent au calendrier, plus qu'au chiffre d'affaires :
>
> - **Encaisser plus tôt** : acompte à la commande, facturation dès la fin du travail, relance systématique à J+1 de l'échéance.
> - **Payer au bon moment** : négocier ses délais fournisseurs autant que ses délais clients, et étaler ce qui peut l'être.
>
> Rien de spectaculaire, mais appliqué avec rigueur, c'est parfois plusieurs semaines de respiration retrouvées.
>
> Adrien & Emily

**E4 (J+14) : Ce que coûte le fait d'attendre**
*Pré-en-tête : Une question honnête, à vous poser au calme.*

> Bonjour %FIRSTNAME%,
>
> Quand la trésorerie est tendue, le réflexe naturel est de tout geler, y compris ce qui pourrait la débloquer. C'est compréhensible. C'est aussi le piège dans lequel beaucoup de dirigeants restent coincés plusieurs années.
>
> La question n'est donc pas « est-ce que j'ai le budget aujourd'hui ? ». La vraie question, c'est : « combien me coûte chaque mois où rien ne change ? »
>
> Franck, boulanger, a commencé avec un bilan dans le rouge. Cinq mois plus tard, il était revenu à l'équilibre, avec 7 000 euros de bénéfice en plus chaque mois. Ce qu'il en dit : « Avant, j'étais inconscient et j'avais peur. Aujourd'hui, je suis conscient et je n'ai plus peur. »
>
> [ Voir le témoignage de Franck ](https://vimeo.com/1204547163)
>
> Adrien & Emily

**E5 (J+21) : On en reparle ?**
*Pré-en-tête : Si le sujet est toujours d'actualité, notre porte est ouverte.*

> Bonjour %FIRSTNAME%,
>
> Cela fait trois semaines que nous avons échangé. Je ne sais pas où vous en êtes, mais si la question de la trésorerie vous occupe toujours l'esprit, nous pouvons refaire le point ensemble : où vous en êtes aujourd'hui, ce qui a bougé et ce qui reste bloqué.
>
> Il n'y a aucune obligation : juste un échange pour y voir clair.
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 2. Pas le bon moment (`frein_timing`)

**E1 (J+1) : Bien noté pour le timing**
*Pré-en-tête : Le bon moment ne se présente presque jamais tout seul.*

> Bonjour %FIRSTNAME%,
>
> Merci pour notre échange d'hier. Vous m'avez dit que ce n'était pas le bon moment, et je le respecte : vous connaissez votre agenda mieux que personne.
>
> Je vous partage simplement une observation. Chez les dirigeants que nous accompagnons, le « bon moment » arrive rarement de lui-même. Il y a toujours une saison chargée, un projet en cours, une échéance. Ceux qui avancent sont ceux qui décident d'un moment, plutôt que de l'attendre.
>
> D'ici là, je vous envoie quelques idées utiles, sans rien vous demander.
>
> Adrien & Emily

**E2 (J+4) : Le piège de la période chargée**
*Pré-en-tête : Plus on est débordé, plus on a besoin de lever la tête.*

> Bonjour %FIRSTNAME%,
>
> « Je verrai quand ça se calmera. » Nous l'avons tous dit. Le problème, c'est que dans une entreprise qui tourne, ça ne se calme jamais vraiment : chaque période chargée est suivie d'une autre.
>
> Le signe qu'il est temps de s'organiser autrement, ce n'est pas le calme. C'est quand les mêmes problèmes reviennent à chaque saison haute : les mêmes nuits courtes, les mêmes urgences, les mêmes décisions prises dans la précipitation.
>
> Si vous vous reconnaissez là-dedans, ce n'est pas un hasard de calendrier. C'est une organisation à revoir.
>
> Adrien & Emily

**E3 (J+8) : 15 minutes par semaine**
*Pré-en-tête : Un rituel simple pour reprendre la main, même en pleine saison.*

> Bonjour %FIRSTNAME%,
>
> Voici un rituel que beaucoup de nos dirigeants gardent, même après notre accompagnement : 15 minutes, le vendredi, pour répondre à trois questions.
>
> 1. Qu'est-ce qui m'a pris le plus de temps cette semaine, et qui aurait pu être fait par quelqu'un d'autre ?
> 2. Quelle décision ai-je repoussée ?
> 3. Quel chiffre dois-je regarder lundi matin ?
>
> C'est court, mais c'est souvent le début d'une semaine où l'on pilote au lieu de subir.
>
> Adrien & Emily

**E4 (J+14) : Ce qui se passe quand on attend**
*Pré-en-tête : Le statu quo a un coût, même quand il ne se voit pas.*

> Bonjour %FIRSTNAME%,
>
> Attendre a l'air neutre. En réalité, chaque mois où rien ne change prolonge les mêmes difficultés : le même temps passé sur l'opérationnel, la même marge qui s'effrite, la même fatigue.
>
> Alexandre, boucher-charcutier-traiteur, avait un chiffre d'affaires en hausse et « la tête dans le guidon ». Un soir, une fois tout le monde payé, il a fait le constat : « J'ai fait plaisir à tout le monde, sauf à moi-même. » Aujourd'hui, ses marges sont reprises, ses fiches de production calées, et à 19 h 30 il passe à table avec toute sa famille.
>
> Son conseil à ceux qui hésitent : demandez-vous plutôt combien vous allez perdre à attendre.
>
> [ Voir le témoignage d'Alexandre ](https://drive.google.com/file/d/1tPEoSaGRAGXZmo_h0x16eb8gWfl3aDBK/view)
>
> Adrien & Emily

**E5 (J+21) : Et si on fixait la date maintenant ?**
*Pré-en-tête : Même pour plus tard, autant la bloquer dès aujourd'hui.*

> Bonjour %FIRSTNAME%,
>
> Vous m'aviez dit que ce n'était pas le bon moment. Si une période plus calme se profile, le plus simple est de bloquer dès maintenant un créneau pour refaire le point : il sera dans votre agenda, et vous n'aurez pas à y repenser.
>
> [ Choisir un créneau ]
>
> Adrien & Emily

---

## 3. Doit en parler à quelqu'un (`frein_decision`)

**E1 (J+1) : Pour en parler à deux**
*Pré-en-tête : Une décision qui engage l'entreprise se prend rarement seul.*

> Bonjour %FIRSTNAME%,
>
> Merci pour notre échange d'hier. Vous souhaitez en parler avant de décider, et c'est sain : une décision qui engage votre entreprise mérite d'être partagée.
>
> Pour vous faciliter la tâche, je vous envoie dans les prochains jours de quoi présenter simplement notre démarche à la personne concernée : comment se déroule l'accompagnement et ce qu'il change concrètement.
>
> Adrien & Emily

**E2 (J+4) : L'accompagnement en trois phrases**
*Pré-en-tête : De quoi le présenter simplement, sans jargon.*

> Bonjour %FIRSTNAME%,
>
> Si vous deviez résumer notre démarche à votre associé ou à votre conjoint, voici trois phrases que vous pouvez reprendre telles quelles :
>
> 1. **On part de la situation réelle de l'entreprise** : les chiffres, l'organisation, ce qui bloque aujourd'hui.
> 2. **On définit ensemble les priorités** : peu de chantiers, ceux qui ont le plus d'effet.
> 3. **On avance avec un accompagnement dans la durée**, pour que les changements tiennent au lieu de s'essouffler au bout de trois semaines.
>
> N'hésitez pas à lui transférer cet e-mail.
>
> Adrien & Emily

**E3 (J+8) : Les questions qu'on nous pose le plus**
*Pré-en-tête : Celles que votre associé ou votre conjoint se pose peut-être aussi.*

> Bonjour %FIRSTNAME%,
>
> Voici les questions qui reviennent le plus souvent quand un dirigeant en parle autour de lui :
>
> - **« Combien de temps ça demande ? »** Un rythme régulier, calé sur votre activité.
> - **« Est-ce que c'est adapté à une entreprise comme la nôtre ? »** Nous accompagnons des TPE et PME de tous secteurs, et chaque accompagnement part de la situation de l'entreprise.
> - **« Et si ça ne marche pas pour nous ? »** C'est précisément ce que l'audit sert à vérifier avant tout engagement.
>
> Adrien & Emily

**E4 (J+14) : Et si vous veniez à deux ?**
*Pré-en-tête : Le plus simple est souvent d'en parler tous ensemble.*

> Bonjour %FIRSTNAME%,
>
> Expliquer une démarche à quelqu'un qui n'était pas là n'est pas toujours simple. Beaucoup de dirigeants choisissent de refaire un échange **à deux**, avec leur associé ou leur conjoint : chacun pose ses questions, et la décision se prend en connaissance de cause.
>
> Si c'est plus simple pour vous, choisissez un créneau où vous êtes disponibles tous les deux.
>
> [ Réserver un échange à deux ]
>
> Adrien & Emily

**E5 (J+21) : Où en êtes-vous ?**
*Pré-en-tête : Juste pour savoir si vous avez pu en parler.*

> Bonjour %FIRSTNAME%,
>
> Avez-vous pu en parler ? Quelle que soit votre décision, je serais content de la connaître : répondez simplement à cet e-mail, même en un mot.
>
> Et si vous souhaitez refaire le point, le lien est ici :
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
> Merci pour notre échange d'hier. Vous voulez voir des résultats concrets avant de vous engager, et vous avez raison : ne vous engagez jamais sur une promesse.
>
> Dans les prochains jours, je vous partage donc des cas réels de dirigeants que nous avons accompagnés : leur situation de départ, ce qu'ils ont mis en place et où ils en sont.
>
> Adrien & Emily

**E2 (J+4) : Margaux, épicerie fine et restaurant**
*Pré-en-tête : Trois mois plus tard : +20 % de chiffre d'affaires, +8 % de marge.*

> Bonjour %FIRSTNAME%,
>
> Margaux a ouvert sa première entreprise, une épicerie fine avec un restaurant italien, en 2023. Elle se sentait seule face à toutes les décisions.
>
> Avec nous, elle a restructuré son équipe, recruté et appris à déléguer. Trois mois plus tard : « Mon chiffre d'affaires a augmenté de 20 %, mes marges ont augmenté de 8 %. » Et surtout : « Je peux enfin déléguer. »
>
> [ Voir le témoignage de Margaux ](https://vimeo.com/1204547192)
>
> Ce qui nous frappe dans son parcours, c'est que rien de tout ça n'est venu d'un effort commercial de plus : tout est venu de l'organisation.
>
> Adrien & Emily

**E3 (J+8) : Ce que nous ne promettons pas**
*Pré-en-tête : Autant être clair dès le départ.*

> Bonjour %FIRSTNAME%,
>
> Vous avez peut-être déjà été déçu par un prestataire. Alors autant être clair sur ce que nous ne faisons pas :
>
> - nous ne promettons pas de miracle en trois semaines ;
> - nous ne faisons pas le travail à votre place ;
> - nous ne vous vendons pas une méthode toute faite qui ignore votre entreprise.
>
> Ce que nous faisons, c'est vous aider à prendre les bonnes décisions, dans le bon ordre, et à les tenir dans la durée.
>
> Adrien & Emily

**E4 (J+14) : Delphine, institut de beauté**
*Pré-en-tête : 25 ans de métier, et pourtant l'angoisse de la trésorerie chaque mois.*

> Bonjour %FIRSTNAME%,
>
> Delphine est esthéticienne depuis 25 ans. Seule dans son institut, elle faisait tout elle-même, de 9 h à 19 h, avec « l'angoisse de la tréso permanente ».
>
> Ensemble, elle a revu ses charges, renégocié ses contrats, recalculé ses prestations et organisé ses tâches. Résultat, selon ses mots : « J'ai économisé 15 000 euros sur l'année », et elle termine désormais vers 18 h.
>
> Elle avait, elle aussi, un doute au départ, celui de « l'arnaque ». Il n'a pas tenu longtemps.
>
> [ Voir le témoignage de Delphine ](https://drive.google.com/file/d/1_HaqWTqx2SE-x6F7bOHf0LyI3kfpgvbQ/view)
>
> Adrien & Emily

**E5 (J+21) : Voir par vous-même**
*Pré-en-tête : La meilleure preuve reste celle qui vous concerne.*

> Bonjour %FIRSTNAME%,
>
> Les témoignages donnent une idée, mais la seule preuve qui compte vraiment, c'est ce que cela donnerait **pour votre entreprise**.
>
> Si vous voulez refaire le point avec vos chiffres d'aujourd'hui, réservez un créneau :
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
> Merci pour notre échange d'hier. Vous préférez avancer par vous-même pour l'instant, et c'est tout à fait légitime.
>
> Je vous laisse une question pour la semaine : **qu'est-ce qui vous prend le plus d'énergie aujourd'hui, et qui sera encore là dans un an si rien ne change ?**
>
> Dans les prochains e-mails, je partage quelques outils utiles pour avancer seul. Gardez-les, même si nous ne travaillons jamais ensemble.
>
> Adrien & Emily

**E2 (J+4) : Le dirigeant goulot d'étranglement**
*Pré-en-tête : Si tout remonte à vous, ce n'est pas un problème de motivation.*

> Bonjour %FIRSTNAME%,
>
> Dans beaucoup d'entreprises, tout finit par remonter au dirigeant : les décisions, les problèmes, les questions des équipes. Au début, c'est normal. Au bout de quelques années, c'est ce qui empêche l'entreprise de grandir et le dirigeant de souffler.
>
> Un test simple : si vous partiez deux semaines sans téléphone, qu'est-ce qui s'arrêterait ?
>
> La réponse dit beaucoup de ce qu'il reste à organiser.
>
> Adrien & Emily

**E3 (J+8) : Trois chiffres à suivre chaque mois**
*Pré-en-tête : Pas besoin d'un tableau de bord compliqué.*

> Bonjour %FIRSTNAME%,
>
> Pour piloter sans y passer des heures, trois chiffres suffisent souvent :
>
> 1. **la marge**, et pas seulement le chiffre d'affaires ;
> 2. **la trésorerie disponible en fin de mois** ;
> 3. **le temps que vous passez sur l'opérationnel**, comparé à celui que vous passez à développer l'entreprise.
>
> Notez-les le premier de chaque mois. Au bout de trois mois, vous verrez la tendance, et vous saurez où agir.
>
> Adrien & Emily

**E4 (J+14) : Ce que nous voyons chez les dirigeants qui avancent**
*Pré-en-tête : Ce n'est pas une question de talent.*

> Bonjour %FIRSTNAME%,
>
> Chez les dirigeants que nous accompagnons, ceux qui progressent le plus vite ont rarement plus de talent que les autres. Ils ont simplement arrêté de tout porter seuls et se sont donné un cadre pour décider.
>
> Une boulangère que nous accompagnons, ouverte sept jours sur sept, le résume mieux que nous : « J'avais une équipe de vente qui me bouffait littéralement. » Nouvelle équipe, plannings revus, horaires d'ouverture repensés : plus d'arrêts maladie, et des milliers d'euros de masse salariale économisés. Son mot pour nous : « Vous ne m'avez pas vendu du rêve. »
>
> [ Voir son témoignage ](https://drive.google.com/file/d/1cyMcufjFmvVe5VwgXgP1Q0YwN4Y0Xjyh/view)
>
> Adrien & Emily

**E5 (J+21) : Où en êtes-vous ?**
*Pré-en-tête : Si vous voulez faire le point, c'est par ici.*

> Bonjour %FIRSTNAME%,
>
> Trois semaines ont passé depuis notre échange. Avez-vous pu avancer sur ce qui vous occupait ?
>
> Si vous voulez faire un point sur la situation de votre entreprise aujourd'hui, réservez un créneau :
>
> [ Reprendre un rendez-vous ]
>
> Adrien & Emily

---

## 6. Général : rien d'exploitable dans l'appel (`frein_general`)

Quatre e-mails seulement, à J+1, J+5, J+12 et J+21.

**E1 (J+1) : Merci pour notre échange**
> Bonjour %FIRSTNAME%,
>
> Merci pour le temps que vous nous avez accordé. Dans les prochaines semaines, je vous partage quelques idées utiles pour piloter votre entreprise plus sereinement, sans rien vous demander en retour.
>
> Adrien & Emily

**E2 (J+5)** reprend **E2 « Le dirigeant goulot d'étranglement »** de la séquence 5.

**E3 (J+12)** reprend **E3 « Trois chiffres à suivre chaque mois »** de la séquence 5.

**E4 (J+21)** reprend **E5 « Où en êtes-vous ? »** de la séquence 5.

---

## 7. Rendez-vous manqué : no-show, ou annulé sans report (`rdv_manque`)

Le prospect quitte le nurturing dès sa réservation. Si le rendez-vous n'a pas lieu, il ne reprend donc pas le nurturing général : il reçoit cette courte séquence. Elle s'ajoute au SMS de rattrapage et à l'appel du closer, qui partent le jour même.

- E1 : le lendemain à 9 h 30 ; E2 : 3 jours après ; E3 : 7 jours après.
- Sortie automatique s'il reprend rendez-vous (`rdv_a_venir`) ou devient client.

**E1 (J+1) : Votre rendez-vous n'a pas pu avoir lieu**
*Pré-en-tête : Ça arrive. On vous garde une place.*

> Bonjour %FIRSTNAME%,
>
> Notre rendez-vous n'a pas pu avoir lieu. Une urgence, un client, une journée qui déborde : ça arrive à tous les dirigeants, il n'y a rien à justifier.
>
> Si le sujet vous occupe toujours, le plus simple est de choisir un nouveau créneau, au moment qui vous arrange :
>
> [ Choisir un nouveau créneau ]
>
> Adrien & Emily

**E2 (J+3) : Ce que vous auriez retiré de l'audit**
*Pré-en-tête : 45 minutes pour y voir clair sur votre entreprise.*

> Bonjour %FIRSTNAME%,
>
> Pour que vous sachiez ce que vous auriez retiré de notre échange, voici comment se déroule l'audit :
>
> 1. **On commence par vous** : ce qui vous prend le plus de temps et d'énergie aujourd'hui, avec vos mots.
> 2. **On met le doigt sur ce qui bloque** : souvent la marge ou l'organisation, plus que le commercial.
> 3. **Vous repartez avec vos priorités** : deux ou trois actions concrètes, que nous travaillions ensemble ou non.
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
> Je ne veux pas vous encombrer. Si ce n'est plus d'actualité, répondez simplement « plus tard » à cet e-mail et je ne vous relancerai pas sur ce sujet.
>
> Si c'est toujours d'actualité, votre créneau vous attend :
>
> [ Choisir un créneau ]
>
> Adrien & Emily
