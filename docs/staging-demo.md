# Annonces exemple

Le site peut afficher un jeu d'annonces exemple réalistes : environ 185 annonces dans toutes les
sous-catégories et les 12 régions, dont les marques qui parlent aux visiteurs (iPhone, Tesla,
Mercedes, BMW, Volkswagen, Audi, Range Rover, MacBook, PS5…), de 19 particuliers et 12
professionnels fictifs, en français, en arabe et quelques-unes en tarifit.

Emploi : des offres de chaque type de contrat (CDI, CDD, stage, alternance, freelance, saisonnier ;
pas d'intérim, réservé aux agences autorisées), sur place, en hybride et en télétravail, et des
demandes d'emploi. Elles suivent les CGU §7.12 : salaire indiqué et au moins égal au minimum légal,
aucun frais pour le candidat, aucune condition d'âge, de sexe ou d'apparence, rien à l'étranger.
Pas de photo : une offre d'emploi n'en a pas besoin.

Elles restent en ligne (décision du 28 octobre 2026) pour montrer à quoi ressemble une bonne annonce
de chaque type. Chacune porte `example: true` :

- badge « Exemple » sur la carte et bandeau « Annonce exemple » sur la fiche, qui explique que le
  vendeur et l'article sont fictifs ;
- aucun moyen de contact : ni message, ni téléphone, ni rendez-vous, ni paiement, ni favori (l'API
  refuse aussi, `acceptsContact`) ;
- ni « À la Une », ni publicité, ni plan du site, ni données Product pour les moteurs (`noindex`) ;
- pas d'expiration à 60 jours : une nouvelle pose renouvelle la date.

Chaque visiteur peut les masquer sur son appareil : « Masquer les annonces exemples » dans les
paramètres du compte, ou le même bouton dans le bandeau d'une fiche exemple. Le choix
est un cookie `examples=hidden` (400 jours, préférence d'affichage, sans consentement) : la recherche
les filtre côté serveur, l'accueil, les pages catégorie et la carte les cachent avant affichage. Une
boutique exemple garde ses propres annonces (on y est venu pour la voir).

Les vendeurs professionnels fictifs ont aussi une boutique exemple (`proProfiles`, `example: true`),
pour voir la vitrine d'un pro, d'une agence immobilière et d'un loueur de voitures : badge « Boutique
exemple » au lieu de « vérifiée », bandeau qui dit qu'elle est fictive, `noindex`. Rien n'y est
vérifié : pas de badge « Certifié » ni « téléphone vérifié », identifiants factices (ICE à zéros,
« EXEMPLE »), KYBC « none ».

Le bandeau doit rester visible : une annonce fictive présentée comme réelle serait une pratique
commerciale trompeuse. Le contenu est dans `src/lib/demo/catalog.ts`, le script dans
`scripts/seed-demo.ts`.

- **Photos** : photos Pexels (licence Pexels : usage libre, sans attribution), choisies pour
  correspondre à l'annonce et sans visage reconnaissable. Le script les télécharge depuis
  `images.pexels.com`, les passe par le traitement des photos d'annonce (métadonnées retirées,
  variantes WebP) et les range comme celles d'un membre.
- **Repérage** : identifiants d'annonce en `zx…`, vendeurs `demo-…`, photos `demo…`. Les vendeurs
  n'ont pas de compte de connexion. Rien ne contient de numéro, d'e-mail ni d'adresse.
- **Environnements** : staging par défaut ; production seulement avec `--production`, sur feu vert
  du propriétaire. Le script refuse tout autre environnement.

## Commandes

Depuis l'environnement cloud de Claude, par Run Command sur la VM (conteneur worker du staging) :

```
NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run infra/demo/seed.sh --apply      # pose ou remet à jour
NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run infra/demo/seed-log.sh --apply  # suivi de la pose
NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run infra/demo/remove.sh --apply    # retire tout
```

Sans `--apply` dans le conteneur (`node dist/worker/seed-demo.mjs`), le script affiche seulement ce
qu'il ferait.

La pose dure plus longtemps que Run Command (coupé vers 9 minutes) : `seed.sh` la lance en
arrière-plan dans le worker et `seed-log.sh` affiche la fin de son journal (`exit 0` une fois finie).

Une deuxième pose remplace la première (mêmes identifiants, dates recalculées). Écritures Firestore :
environ 230 documents par pose ou retrait. Les nouvelles annonces s'ajoutent à la fin de
`DEMO_ENTRIES` : les identifiants sont tirés de la position.

## Production

Poser les exemples en production (`node dist/worker/seed-demo.mjs --production --apply` dans le
worker de production) attend le feu vert du propriétaire ; la liste de contrôle de lancement le
rappelle (`scripts/launch-check.ts`, `docs/lancement/mise-en-production.md`).
