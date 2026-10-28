# Annonces de démonstration du staging

Le staging peut afficher un jeu d'annonces réalistes : environ 140 annonces dans toutes les
sous-catégories et les 12 régions, de 19 particuliers et 8 professionnels fictifs, en français, en
arabe et quelques-unes en tarifit. Le contenu est dans `src/lib/demo/catalog.ts`, le script dans
`scripts/seed-demo.ts`.

- **Photos** : photos Pexels (licence Pexels : usage libre, sans attribution), choisies pour
  correspondre à l'annonce et sans visage reconnaissable. Le script les télécharge depuis
  `images.pexels.com`, les passe par le traitement des photos d'annonce (métadonnées retirées,
  variantes WebP) et les range comme celles d'un membre.
- **Repérage** : identifiants d'annonce en `zx…`, vendeurs `demo-…`, photos `demo…`. Les vendeurs
  n'ont pas de compte de connexion. Rien ne contient de numéro, d'e-mail ni d'adresse.
- **Staging seulement** : le script refuse tout autre environnement.

## Commandes

Depuis l'environnement cloud de Claude, par Run Command sur la VM (conteneur worker du staging) :

```
NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run infra/demo/seed.sh --apply     # pose ou remet à jour
NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run infra/demo/remove.sh --apply   # retire tout
```

Sans `--apply` dans le conteneur (`node dist/worker/seed-demo.mjs`), le script affiche seulement ce
qu'il ferait.

Une deuxième pose remplace la première (mêmes identifiants, dates recalculées). Écritures Firestore :
environ 170 documents par pose ou retrait.

## Avant l'ouverture

Retirer le jeu (`--remove --apply`) fait partie de la liste de contrôle de lancement
(`scripts/launch-check.ts`, `docs/lancement/mise-en-production.md`).
