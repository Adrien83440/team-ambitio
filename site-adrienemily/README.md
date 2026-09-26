# Site vitrine adrienemily.com — refonte (remplace Systeme.io)

Refonte complète du site www.adrienemily.com (actuellement sur Systeme.io), au
format **pages de tunnel** : chaque fichier est une page HTML complète et
autonome, à déposer via `admin-tunnels.html`. Le runtime Alteore (pixel Meta,
mesure des visites/CTA, provenance, traitement des formulaires) est injecté
automatiquement à la publication — **rien à coller dans les pages**.

Identité visuelle alignée sur les tunnels Phénix : navy profond, Sora + Inter,
dégradé cyan→bleu, CTA orange. Animations au scroll, compteurs animés, FAQ
accordéon, témoignages Vimeo au clic, menu mobile, 100 % responsive, ES5.

## Les 4 pages

| Fichier | Étape (slug) | URL cible | Contenu |
|---|---|---|---|
| `index.html` | `accueil` — cocher **« Page d'accueil du domaine »** | `/` | Hero, chiffres animés, 3 bénéfices, méthode 3 étapes, différenciation, témoignages vidéo, citation, FAQ, CTA |
| `about.html` | `about` | `/about` | Portraits Adrien & Emily, histoire, citation, convictions, chiffres, CTA |
| `product.html` | `product` | `/product` | **Nouvelle** page Programmes : Business / Elite / Titan Phénix, les 9 piliers, aide au choix |
| `contacts-page.html` | `contacts-page` | `/contacts-page` | Formulaire `data-alteo-optin` (prenom, nom, email, téléphone, message → fiche Leads Live), email direct, CTA diagnostic |

Les slugs `about`, `product` et `contacts-page` reprennent **exactement** les
URLs du site Systeme.io actuel : aucun lien externe (Facebook, Google, emails)
ne casse à la migration.

## Mise en ligne

1. `admin-tunnels.html` → créer un tunnel **« Site adrienemily.com »**
   (type de lead au choix, ex. `business`).
2. Créer les 4 étapes avec les slugs du tableau ; sur `accueil`, cocher
   « Page d'accueil du domaine (répond sur /) ».
3. Sur chaque étape : « 📄 Déposer un .html » avec le fichier correspondant.
4. Déposer un favicon dans les réglages (l'actuel vit sur le CDN Systeme.io
   et disparaîtra avec lui).
5. Aperçu : `team.alteore.com/t/<chemin>?v=a` (desktop + mobile), tester le
   formulaire de contact (la fiche doit apparaître dans Leads Live).
6. Passer le tunnel **live**. Les pages répondent déjà sur
   `go.adrienemily.com` ; le jour de la migration, pointer `www` (CNAME →
   `cname.vercel-dns.com`) et l'apex (A → `76.76.21.21`) vers Vercel et
   ajouter les deux domaines au projet — `vercel.json` les route déjà.

## Contenu éditable sans toucher au code

Les pages s'hydratent au chargement depuis `GET /api/site-config` (public,
cache edge 60 s). Tout se modifie dans **team.alteore.com → Funnel & Site →
Site & pages** (`admin-site.html`, admin uniquement) :

- chiffres clés (dirigeants, marge, heures, années d'expérience) ;
- note Trustpilot (et affichage on/off) ;
- URL du CTA « Réserver mon diagnostic gratuit » (tous les boutons) ;
- secteurs du bandeau défilant ;
- les 5 photos (hero, histoire, portraits, groupe) ;
- les témoignages vidéo Vimeo (ajout, retrait, ordre, format).

Mécanique : les éléments portent des marqueurs `data-site-*`
(`data-site-count`, `data-site-chip`, `data-site-photo`, `data-site-cta`,
`data-site-tp`, `#mqIn`, `#vtGrid`) et le JS partagé applique la config.
Les valeurs en dur dans le HTML restent le **repli** si l'appel échoue —
elles doivent rester alignées sur les défauts de `api/site-config.js`.
L'écriture passe par `POST /api/site-config` (Bearer admin, collection
Firestore `site_config`, Admin SDK : aucune règle à déployer).

## Corrigé par rapport au site actuel

- Logo « YOURLOGO » placeholder → monogramme AE + « Adrien & Emily ».
- `/product` affichait le contenu « À propos » → vraie page Programmes.
- Lorem ipsum résiduel sur `/about` → supprimé.
- Formulaire de contact en anglais, non relié → français + fiche Leads Live.
- Logo servi par le CDN Systeme.io (mourra avec la résiliation) → plus aucune
  dépendance à Systeme.io ; photos sur le Drive (celles du quiz) + postimg.

## ⚠️ À valider par Adrien

- **Textes de la page Programmes** : les descriptifs d'Elite Phénix et Titan
  Phénix ont été rédigés d'après le quiz (4 piliers) et le positionnement en
  3 niveaux — seul Business Phénix (12 mois, 9 piliers) vient du site actuel.
- CTA « diagnostic gratuit » : garde l'AlteoForm actuel
  (`MIdcp9T5fczESwm6zUEE`) partout, comme sur le site Systeme.io.
- La photo « coaching de groupe » (accueil) vient de postimg.cc comme sur le
  site actuel — à rapatrier un jour dans les Médias du tunnel.
