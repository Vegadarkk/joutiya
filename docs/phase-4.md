# Phase 4 : recherche et découverte

Le code de la phase 4 est sur la branche `claude/mvp-phase-4-recherche-npqs2s` (PR vers la branche de la phase 3, puis vers `main` après la PR #40) : moteur de recherche Meilisearch auto-hébergé sur la VM, page **Recherche** (texte, filtres, tri, rayon autour d'une ville, synonymes darija et arabizi), annonces « À la Une » en tête des résultats et sur l'accueil, pages SEO catégorie × ville (`/fr/c/vehicules/casablanca`), sitemaps réservés aux robots vérifiés, limites de pages contre l'aspiration du site (avec page anti-robot Turnstile), favoris, recherches sauvegardées (10 au plus) avec alerte e-mail quotidienne. Ce guide dit quoi brancher, dans l'ordre, et qui le fait. Coût : 0 €.

## Avant de commencer

- Phase 1 : VM, tunnels et Access en place pour l'environnement visé ; règles Cloudflare de la phase 1 appliquées (en-tête `X-Verified-Bot`, sitemaps réservés aux robots vérifiés).
- Phase 3 : annonces publiées dans Firestore (le moteur indexe les annonces publiées seulement).
- Sans Meilisearch, le site reste en ligne : la page Recherche affiche un message honnête (« recherche indisponible ») et l'accueil garde ses rubriques ; rien d'autre ne casse.

## Qui fait quoi (règle n°1)

- **Claude** fait tout par OCI Run Command (fil « Mise en ligne phase 1 ») : clé maître Meilisearch générée sur la VM, index, clés de l'application, réindexation, index Firestore du staging (CI).
- **Nav** : rien en phase 4.
- **Vous :** un seul geste, le déploiement des index Firestore de production avec le prompt O de Cody, au moment de la mise en production.

## Les clés et réglages de la phase 4

| Service | Clé ou réglage | Portée | Où il va | Qui |
|---|---|---|---|---|
| Meilisearch | `MEILI_MASTER_KEY` (32 octets aléatoires) | Administration seulement, jamais dans l'application | `/etc/joutiya/<env>/meilisearch.env` (0600) | Claude, générée sur la VM, jamais affichée |
| Meilisearch | `MEILI_SEARCH_KEY` | `search` et `documents.get` sur `listings_*` | `app.env` (site) | Claude, `search-setup` |
| Meilisearch | `MEILI_INDEX_KEY` | Documents, index, réglages, tâches et statistiques sur `listings_*` | `app.env` (worker) | Claude, `search-setup` |
| Meilisearch | `MEILI_URL` | `http://meilisearch:7700` (réseau Docker interne, aucun port ouvert) | `app.env` | Claude |
| Firestore | Index de `firestore.indexes.json` (favoris, recherches sauvegardées, À la Une, réconciliation) | Staging : CI ; production : `scripts/deploy-prod.ts firestore` | Projet Firebase | Claude (staging), **Vous :** prompt O (production) |

Les deux clés de l'application dérivent de la clé maître et d'un identifiant fixe : relancer `search-setup` redonne les mêmes valeurs, et aucune valeur n'est jamais affichée.

## 1. Meilisearch sur la VM (Claude, Run Command)

1. Avant le premier démarrage : Claude crée `/etc/joutiya/<env>/meilisearch.env` (mode 0600) avec `MEILI_MASTER_KEY` tirée au hasard sur la VM.
2. Une fois Meilisearch en bonne santé : Claude lance `node dist/worker/search-setup.mjs --url http://meilisearch:7700 --write-env <app.env> --apply` dans un conteneur worker ponctuel. Le script crée l'index `listings_v1`, ses réglages (synonymes darija, mots vides, tri, filtres) et les deux clés, puis les écrit dans `app.env` ; il ajoute `MEILI_URL`. Redémarrage du site et du worker.
3. Premier remplissage, ou après la perte du volume ou un changement de réglage : `docker compose exec worker node dist/worker/reindex-search.mjs --apply --max-reads <budget>`. Sans `--apply`, il compte seulement les annonces (1 lecture Firestore) et affiche le plan. Il construit un nouvel index à côté, bascule d'un coup, puis rattrape les annonces modifiées pendant la construction : la recherche ne s'interrompt pas.

Ensuite tout est automatique : chaque publication, modification, mise en pause ou suppression d'annonce part vers le moteur en quelques secondes (voie rapide), un relevé toutes les 60 s rattrape ce qui a pu manquer, et une réconciliation complète tourne chaque nuit à 04:20 UTC. Si l'indexation prend plus de 5 minutes de retard, une alerte P1 part (Telegram et e-mail).

## 2. Tâches de nuit ajoutées

| Heure (UTC) | Tâche | Rôle |
|---|---|---|
| 04:05 | `expire-boosts` | Retire « À la Une » des annonces dont l'option est échue |
| 04:20 | `reconcile-search` | Compare Firestore et l'index, corrige tout écart, enregistre le rapport |
| 07:00 | `saved-search-alerts` | Envoie un e-mail par recherche sauvegardée qui a de nouvelles annonces (lien de désinscription en un clic) |

## 3. Index Firestore

- Staging : déployés par la CI à chaque mise en staging (`deploy-staging.yml`).
- Production : **Vous :** prompt O de Cody, une fois, avant la mise en production de la phase 4 (puis à chaque changement de `firestore.indexes.json`). Les nouveaux index servent aussi aux sauvegardes incrémentales des favoris et des recherches sauvegardées.

## 4. Contrôles

- Dépôt : `npm run check`, `npm run test:search` (moteur réel en Docker), `npm run test:api`, `npm run test:rules`, `npm run build` puis `npm run test:e2e`.
- Critères de sortie qui exigent le staging en ligne, notés dans `tests-differes.md` par le fil « Mise en ligne phase 1 » : p95 de `/api/search` sous 300 ms sur la VM (environ 50 ms mesurés en CI sur 20 000 annonces), zéro écart au deuxième passage de la réconciliation, alerte de retard d'indexation déclenchée en arrêtant le worker, limites de pages vérifiées (page anti-robot puis 429) et Googlebot exempté, sitemaps servis aux robots vérifiés seulement, alerte e-mail d'une recherche sauvegardée reçue.

## Prompts Cody

**O. Index Firestore de production** (étape 3)

```text
Dans le dépôt Joutiya à jour (branche main), déploie les règles et les index Firestore de production : lance `node scripts/deploy-prod.ts firestore`. Si Firebase demande une connexion, lance `npx firebase login` et laisse-moi me connecter avec le compte Google du projet joutiya-prod. Confirme quand le script le demande, puis montre-moi seulement la dernière ligne du résultat. Ne modifie aucun autre projet Firebase.
```
