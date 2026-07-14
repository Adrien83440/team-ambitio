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
