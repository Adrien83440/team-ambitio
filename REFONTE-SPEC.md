# Refonte Setting / Closing / Booking / Tunnel — Spec validée (14/07/2026)

Décisions validées avec Adrien : périmètre UI = les 6 écrans du flux · rapports journaliers
automatiques avec correction manuelle par jour · Close = formulaire complet + commissions
auto (COMM_RULES actuelles) · échelle CPR → CPR KEPT → CPR Live → CPR Offre confirmée ·
annulation SB ⇒ le lead retombe dans le périmètre Setting (alimente le taux de récupération).

## 1. Principe directeur

**La fiche prospect (Leads Live) est la racine.** Quatre sources de vérité, zéro double
saisie — les rapports sont des vues calculées :

| Source | Contenu | Écrite par |
|---|---|---|
| `leads/{id}` | fiche, statut/stage, setter attribué | Leads Live, fiche CRM, CRM |
| `lead_actions/{slug}/items/{id}` **(nouveau)** | journal immuable des actions setting (NRP1, SET…) | AlteoreFlow (toutes les pages) |
| `bookings/{id}` + **`outcome`** (nouveau champ) | RDV + résultat commercial + closeData | RdvOutcome (RDV, fiche, booking-admin), booking.html |
| `call_logs` | appels Ringover (durée, décroché ≥5 s, agent) | serveur (existant) |

Complément : `rapport_overrides/{slug}/jours/{YYYY-MM-DD}` = corrections manuelles par jour ;
`commissions/{slug}/mois/{YYYY-MM}` reçoit les deals auto au Close ; `ads_insights` = dépenses.

## 2. Résultats d'appel sur le RDV (`bookings.outcome`)

`annule` · `no_show` · `replanifie` · `disqualifie` · `offre` · `close` · `non_close`

- Champs : `outcomeAt/By/ByName`, `outcomeNote`, `outcomeHistory[]`, `closeData{offre, subtype,
  contracte, collecte, paiement, closerSlug, setterSlug}`, `rescheduledFromId/ToId`.
- Le `status` legacy reste synchronisé (annule→cancelled, no_show→no_show, replanifie→cancelled
  +rescheduled, le reste→completed) : l'existant (funnel « Tenue », sales-rdv) continue de marcher.
- Dérivés : **présent (live)** = disqualifie|offre|close|non_close · **pitché** = offre|close|non_close
  · **kept** = non annulé (replanifié exclu, le nouveau RDV le remplace).
- Propagation lead à chaque outcome : stage/status + timeline + `isClient` au close.
  Annulation/no-show ⇒ status `follow_up_pm` (retour périmètre Setting, à récupérer).
- Replanifié : booking.html en mode `?reschedule={id}` — nouveau RDV **copiant source/leadId**
  (préserve SB/NB), lien croisé, ancien RDV passé `replanifie`.
- `setterSlug/Uid/Name` posés sur le booking à la création quand RDV posé par un setter.

## 3. Journal d'actions Setting (`lead_actions`)

À chaque changement de statut depuis la fiche (Leads Live ou fiche CRM) et à chaque RDV posé :
`{leadId, leadName, uid, slug, day, month, action, prevStatus, origin, firstTouch,
firstTouchMember, createdAt}`. Premier contact par lead ET par membre via transaction
(`leads.firstActionAt`, `firstActionAtBy.{slug}`) → **Total leads du jour = leads touchés pour
la 1ʳᵉ fois ce jour** (une 2ᵉ action ne recompte jamais, même les jours suivants).

## 4. Rapports journaliers automatiques

**Setting (Set NB)** — par setter, jour par jour : temps d'appel, calls passés, décrochés (≥5 s)
→ Ringover ; total leads, NRP1/2/3, messagerie, follow-up, pas intéressé/disqua → lead_actions ;
sets (statuts set/rdv_pose + RDV setter posés, uniques par lead/jour), annulés NB, no-show NB,
présents NB, closes NB (+ collecté) → bookings/outcomes. Correction manuelle par jour (override).

**Closing (Close SB)** — par closer, jour par jour, RDV **self-booking uniquement** :
RDV SB, annulés, no-show, présents (live), disqua, offres, closes, non closes, replanifiés,
contracté €, collecté € (closeData). Ancienne saisie hebdo consultable pour les mois passés.

## 5. Commissions auto au Close

Formulaire Close : offre (BP 6/BP 12/Elite/Titan), PIF/mensualisé, contracté, collecté,
paiement (carte, virement…), closer + setter (pré-remplis, modifiables). Génère (idempotent
par `dealKey = bookingId_type`) : deal **Closing** pour le closer (comm + bonus PIF) et deal
**Setting** pour le setter — `noBooking` si RDV setter (NB), `selfBooking` si self-booking (SB).
`ok:false` (validé à l'encaissement), badge AUTO, modifiable ensuite.

## 6. Tunnel — nouvelle section SETTING / CLOSING + KPIs

- **LTB (SB)** = RDV self-booking / leads · **Taux récupération** = sets NB / (leads − leads SB)
- **CPR** = dépenses / RDV SB (annulés inclus) · **CPR KEPT** = dép. / RDV SB non annulés
- **CPR Live** = dép. / RDV SB présents (disqua et sans offre inclus) · **CPR Offre** = dép. / RDV SB pitchés
- **CPA** = dépenses / clients acquis (closes) · **AOV** = collecté / nb clients
- Annulations ventilées SB vs NB. Bloc Setting (leads travaillés, sets NB, closes NB) +
  bloc Closing SB (RDV, live, offres, closes, collecté) agrégés depuis les outcomes.

## 7. Fichiers

Nouveaux : `alteore-flow.js` (moteur de propagation), `rdv-outcome.js` (modal résultat RDV,
partagée), `alteore-ui.css` (design system refonte). Réécrits : `sales-setting.html`,
`sales-closing.html`. Modifiés : `sales-rdv.html`, `sales-leads.html`, `sales-contact.html`,
`booking.html`, `booking-admin.html`, `sales-funnel.html`, `sales-commissions.html`,
`firestore.rules` (+ `lead_actions`, `rapport_overrides`).

Compat : `sales-saisie.html`, `sales-eod.html`, dashboard inchangés (lecture des anciens mois
préservée). Les rapports auto démarrent à la mise en ligne ; appels et RDV passés remontent
automatiquement (recalcul à la volée), les compteurs d'actions (NRP/jour) démarrent vides.

## 7sexies. Funnel v2 — retours head of sales (14/07, vocal)

- **Héro = la totalité, une ligne** : Leads · RDV pris (LTB) · Kept · Closes · Collecté (résultats
  RDV auto, repli saisies). Le **ROAS descend dans Publicité**.
- **Prise de RDV = deux lignes** : ligne **Self Booking** (leads total, RDV SB + LTB SB, kept SB,
  live SB, pitchés SB, closes SB, collecté SB + échelle **CPR / KEPT / Live / Offre**) et ligne
  **No Booking** (leads à travailler = cohorte − self-bookés, leads travaillés (journal), RDV NB,
  taux de récupération, kept/live/closes NB + **coût / RDV NB** et rappel **CPL**). L'ancienne
  section SETTING/CLOSING est supprimée (doublon) — ses infos uniques ont migré ici.
- **Leads** : répartition par tunnel enrichie du **nombre de RDV pris Élite / Business** ;
  carte « pixel Meta » expliquée (attribution, doublons, ré-optins).
- **Rentabilité** allégée : CPL · **CAC Market Only** (ex-CPA, renommé pour ne pas confondre avec
  le CPA Meta) · **AOV** (repli saisies quand pas de résultats RDV). Section saisies retitrée
  « Saisies manuelles (héritage — comparaison) ».
- **Booking** : bouton 🎯 Résultat + lien 👤 fiche prospect directement sur chaque ligne
  Setting & Sales de la liste.
- Close SB : note explicite quand les offres/closes d'une période vivent dans l'ancienne
  saisie manuelle (📜) et non dans les statuts RDV.

## 7quinquies. Journal d'actions — chaque clic compte + zéros honnêtes (retours test 14/07)

- **Chaque clic de statut compte une action** (NRP1 re-cliqué à la 2ᵉ tentative = un NRP1 ce
  jour-là), plus seulement les changements de statut. Anti double-clic 5 s par lead+statut.
  « Total Leads » reste au premier contact unique par lead (jamais recompté).
- **Le passé du journal n'existe pas** : les clics d'avant la mise en ligne (14/07/2026)
  n'ont laissé aucune trace datée — non reconstituable, contrairement aux appels Ringover et
  aux RDV (recalculés sur tout le passé). Le rapport Set NB l'affiche désormais explicitement :
  bannière (journal vide → procédure de test + rappel du deploy des rules ; sinon « actif
  depuis le JJ/MM ») et « — » dans les colonnes d'actions pour les jours antérieurs au journal,
  au lieu de zéros trompeurs.

## 7quater. Vues Jour / 3 jours / 7 jours / Mois sur Set NB & Close SB (retours test 14/07)

Les deux rapports ont un sélecteur de période **Jour · 3 jours · 7 jours · Mois** : tous les
KPIs (cartes, funnel, tableau) se calculent sur la fenêtre choisie. Jour = une journée
naviguable ‹ › ; 3/7 jours = fenêtre glissante se terminant au jour de référence (‹ › déplace
la fenêtre de sa propre taille) ; Mois = comportement d'origine avec lignes Semaine.
L'ancienne saisie hebdo et sa consultation restent liées à la vue Mois. Le mode et la date
sont mémorisés par poste. Noms exacts entérinés : **Set NB** et **Close SB** (nav, titres,
lignes du Funnel). Close SB : l'onglet « Équipe » n'apparaît qu'à partir de 2 closers — avec
Élodie seule, sa vue couvre d'office tout le périmètre Self Booking (aucun RDV perdu faute
de mapping expert→membre).

## 7ter. Périmètre équipe + renommage + cohérence Funnel (retours test 14/07)

- **Équipe sales uniquement** dans SET NB / Close SB / Commissions et dans les sélecteurs
  closer/setter : rôles setter/closer/closer_setter actifs — jamais d'admin, de coach ni de
  CSM. Source unique `AlteoreFlow.salesMembers()`. **Guillaume (parti) est exclu en dur**
  (`DEPARTED`) partout, y compris du dashboard Commissions (historique conservé en données,
  masqué à l'affichage) et du sélecteur Gestionnaire de la fiche CRM (leads encore attribués
  à lui : visible « inactif », plus proposable).
- **Renommage** : les modules s'appellent désormais **SET NB** (ex-Setting) et **Close SB**
  (ex-Closing) — nav, titres de pages et lignes du Funnel alignés.
- **Funnel · Tenue des RDV — chiffres cohérents** : les replanifiés sortent des annulés
  (carte dédiée), kept = planifiés − annulés − no-show − replanifiés, et la répartition
  « par personne » (qui affichait l'opérateur du clic, ex. la CSM) est remplacée par la
  ventilation métier **SB / NB** sur chaque carte (annulés, no-show, replanifiés) — mêmes
  prédicats que la section SETTING/CLOSING, donc totaux toujours égaux.
- **Funnel · vue par jour** : nouveau mode « Jour » (‹ › + sélecteur de date) — tout le
  funnel se calcule sur la journée choisie, mêmes sources. Les sections basées sur les
  saisies mensuelles (Closing saisies, CAC saisies) restent réservées à la maille mois.

## 7bis. Séparation Setting/Sales vs Coaching dans Booking (ajout 14/07)

Un RDV est « coaching/clients » si `isCoaching` (sur le doc OU sur le type de consultation),
`source csm_manual`, `skipLeadCreation` ou `clientId`. Partout ailleurs c'est du Setting & Sales.

- **booking-admin** : filtre de périmètre en tête de liste (🎯 Setting & Sales — défaut pour
  sales/admin · 🎓 Coaching & Clients · Tous — défaut pour la CSM, mémorisé par poste) ;
  badge 🎓 COACHING ou SB/NB sur chaque ligne + chip résultat ; les stats suivent le filtre.
- **Résultat d'appel réservé au périmètre Setting & Sales** : le bouton 🎯 n'apparaît jamais
  sur un RDV coaching, et la modale RdvOutcome refuse elle-même tout RDV hors périmètre
  (double garde-fou, y compris quand le coaching n'est détectable que via le type).
- **Replanification universelle et sûre** : booking.html copie désormais AUSSI `isCoaching`,
  `clientId`, `clientNom`, `skipLeadCreation` — un coaching reporté reste un coaching, et le
  quota coaching mensuel n'est pas re-décompté lors d'un simple report.
- Rappel : rapports Setting/Closing, Tunnel, fiches et Mes RDV excluaient déjà le coaching
  via la même classification (`classifyBooking`) — la règle est identique partout.

## 8. Déploiement

1. **Frontend** : commit + push → Vercel déploie (aucune dépendance ajoutée, aucun build).
2. **Rules** : `firebase deploy --only firestore:rules` (nouveaux blocs `lead_actions`
   et `rapport_overrides`). Sans ce déploiement, le journal d'actions et les corrections
   par jour seront refusés (permission denied) — le reste fonctionne quand même.
3. **Aucun index composite requis** : toutes les nouvelles requêtes sont single-field
   (plages sur `day`, égalités sur `leadId`/`userId`). Les collections se créent seules.
4. Vérif post-déploiement (5 min) : changer un statut dans Leads Live → doc dans
   `lead_actions/{slug}/items` ; statuer un RDV passé en Close → `bookings.outcome`
   + stage fiche + deal AUTO dans Commissions ; ouvrir Setting/Closing → rapports du jour.

## 9. Corrections issues de la revue adversariale (intégrées)

Écrasement concurrent des deals AUTO sur la page Commissions (transaction de fusion par
`dealKey`) · replanifications exclues des compteurs « RDV pris » / « sets » (LTB, CPR,
createdSb) · RDV setter historiques sans `bookedBySlug` attribués via `leads.assignedTo` ·
membres Commissions construits depuis le roster (deals AUTO d'un nouveau membre visibles) ·
échec de création de commission (rules CSM, offline) remonté explicitement dans le toast ·
slug email de secours jamais utilisé comme clé de données (roster obligatoire) ·
sélecteurs closer/setter reconstruits à l'arrivée du roster · SB/NB fiable dans
booking-admin (typeMap auto-chargé) · héro du Tunnel : priorité résultats RDV sur saisies.

## 10. Collecté / contracté multi-sources (fix 14/07 — build 14.07-e)

Constat Adrien : « j'ai les 2 closes dans les 7 jours mais pas le collecté ». Les closes
sont comptés depuis les fiches (`clientSince`, tous chemins), mais le montant n'existait
que si la modale Close du RDV avait été utilisée → collecté 0 €, AOV faux.

**Règle (funnel)** — pour CHAQUE client gagné de la période, le montant vient de,
dans l'ordre, sans jamais doubler :
1. **Modale Close du RDV** (`bookings.closeData.collecte/contracte`) — prioritaire ;
2. **Deal Commissions type Closing** daté dans la période (`collecteHT/contracteHT`),
   rattaché par `leadId` puis par email (si deux deals pour le même client, celui
   encaissé > 0 € gagne) ;
3. sinon compté « **close sans montant** » : alerte 💶 dans Prise de RDV, ⚠ dans le héro
   et sur l'AOV (« sous-estimé ») — jamais un 0 silencieux qui fausse les chiffres.

Ventilation SB/NB par le stage de la fiche (`closed_won_self` = SB). Le ROAS résultats
suit ce collecté consolidé. Diagnostic (vue « Tous ») : deals Closing de la période sans
client gagné correspondant (email de fiche différent, fiche jamais passée en Won).

**Capture à la source (fiche CRM)** : passer une fiche en Won ouvre automatiquement la
modale Résultat pré-réglée sur **Close** s'il existe un RDV sales non statué (montants +
commissions saisis au bon moment) ; sinon rappel toast — on n'écrase jamais un résultat
déjà saisi. Le chemin recommandé reste : statuer le RDV en Close via 🎯 Résultat.

## 11. Cartes du Close + croisement module Paiements (14/07 — build 14.07-f)

**Les CARTES du Close** (`close-wizard.js`, validé Adrien) — passer un lead en
« Closing » (Leads Live · pipeline CRM · fiche) ou choisir Close sur un RDV
enchaîne 4 cartes cliquables + un récap :
① Contrat signé : **Elite / Business** · ② **PIF / MENS** · ③ **Self Booking /
No Booking** (suggestion auto, mais c'est LA réponse qui fait foi — elle prime
sur la classification du RDV) · ④ **Encaissé à la signature (HT)** — chips aux
tarifs officiels : Elite PIF 12 000 · Elite MENS 13 000 (≤ 4×, chips 3 250/6 500) ·
Business PIF 5 000 · Business MENS 6 000 (≤ 10×, chips 600/1 000/1 500) + saisie
libre. PAS de carte récap (retiré 14/07) : chaque réponse est déjà une validation
manuelle — la carte Encaissé fait office de signature, avec le fil d'Ariane ✎
(Elite · PIF · SB recliquables) et le bouton **Confirmer** directement dessus.

À la confirmation : résultat « close » posé sur le RDV du lead s'il en reste un
à statuer (sinon close direct sur la fiche), stage interne `closed_won_self/
setting` selon la carte ③, timeline, `closedData` copié sur la fiche, et
**commissions auto** (closer/setter résolus automatiquement — Business = BP 12).
Bouton « 💳 Créer le paiement GoCardless » → `payments.html?leadId=` prérempli.
Anti-doublon : dealKey par RDV (`<bookingId>_…`) ou par fiche (`lead_<id>_…`),
mois du deal = mois du PREMIER close, re-close d'une fiche déjà cliente = mise à
jour sans nouvelle commission ni réécriture de `clientSince`.

**Statut unique « Closing »** — Closed Won Setting / Closed Won Self disparaissent
des choix visibles (Leads Live : le bouton 🏆 s'appelle « Closing » ; CRM : une
seule colonne/pastille ; fiche : une seule pastille). Les stages internes restent
en base et s'affichent « Closing ». Aucun chemin n'écrit un stage `closing`
littéral ; le close en masse est bloqué (un close = un contrat).

**Collecté / contracté = MODULE PAIEMENTS (HT)** — le funnel croise, par client
gagné de la période : collecté = `paidAmount` GoCardless du client (TTC → HT
÷ 1,2, rattaché par leadId puis email, anti double compte) → sinon l'encaissé
déclaré à la carte ④ → sinon « close sans montant » affiché. Contracté =
`totalAmount` (hors annulés/brouillons) → sinon tarif officiel de la carte.
Diagnostics croisés : clients sans paiement GoCardless créé, paiements de la
période sans client gagné correspondant. La modale RDV ne demande plus aucun
montant. L'ancienne source « deals Commissions » est abandonnée (le collecté
n'a rien à voir avec les commissions).
