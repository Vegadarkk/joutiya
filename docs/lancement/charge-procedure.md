# Test de charge : procédure (D17)

Le test mesure ce que la VM tient avant le lancement : **40 pages/s hors cache** (p95 < 500 ms) et
**50 recherches/s** (p95 < 300 ms), 3 minutes chacun après 1 minute de chauffe, CPU de la VM
< 70 % sur les deux OCPU. Il vise le staging, avec les limites CPU et mémoire de la production.
Le résultat va dans `docs/lancement/charge.md` (créé seulement avec un vrai résultat : le contrôle
de lancement le cherche) et fixe le seuil de passage à un VPS.

Outils : `load/k6.js` (k6 v2.3.0), `.github/workflows/load-test.yml` (lancement manuel),
`scripts/seed-loadtest.ts` (jeu de données), `scripts/cloudflare.ts loadtest` (règle temporaire),
`scripts/oracle-vm.ts cpu` (mesure CPU), `load/staging-limits-*.sh` (limites du staging), `load/seed*.sh` (jeu de données sur la VM).

## Une fois

1. **Jeton Access** `joutiya-scan` (Zero Trust > Access > Service Auth), en mode *single header*,
   autorisé sur l'application `staging.joutiya.ma` (policy *Service Auth*, comme la sonde). Il sert
   aussi au scan de sécurité.
2. **GitHub** (variables et secrets du dépôt) :
   - variable `ACCESS_TOKEN_HEADER` : le nom de l'en-tête choisi pour le mode single header ;
   - secret `STAGING_SCAN_ACCESS_TOKEN` : `{"cf-access-client-id":"…","cf-access-client-secret":"…"}` ;
   - secret `LOADTEST_BYPASS_SECRET` : 32 à 128 lettres et chiffres, tirés au hasard ;
   - variable `LOAD_TEST_ENABLED=true` (le workflow ne fait rien sans elle).
3. **Staging** : `LOADTEST_BYPASS_SECRET` (même valeur) dans l'app.env du staging (scellé, comme les
   autres secrets), puis redémarrage. L'application refuse cette variable en production.
4. **PC2** : `JOUTIYA_LOADTEST_BYPASS_SECRET` (même valeur) dans `.env.local`, pour la règle Cloudflare.

## Le jour du test

Entre **10 h et 22 h (heure de Paris)**, tout le même jour : les tâches de nuit liraient le jeu de
données (sauvegarde 03:30 UTC, réconciliation de la recherche 04:20 UTC, qui prendrait les 45 000
documents absents de Firestore pour des écarts et les relirait un par un, alertes de recherches
enregistrées 07:00 UTC). Au plus deux passages par jour (lectures Firestore des pages hors cache).

1. Jeu de données, écrit depuis le conteneur worker du staging :
   `NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run load/seed.sh --apply`
   5 001 documents Firestore (un quart des écritures du jour), 50 000 documents dans l'index.
2. Limites de production sur le staging :
   `NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run load/staging-limits-prod.sh --apply`
3. Règle Cloudflare (le secret n'est jamais affiché) :
   `node --env-file=.env.local scripts/cloudflare.ts loadtest --on --apply`
4. Mesure CPU, lancée juste avant le test (elle démarre quand l'agent Oracle prend la commande) :
   `NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts cpu --minutes=9`
5. Lancer le workflow **Load test** (Actions > Load test > Run workflow). Sept minutes de charge.
6. Défaire, même si le test a échoué :
   ```
   node --env-file=.env.local scripts/cloudflare.ts loadtest --off --apply
   NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run load/staging-limits-reset.sh --apply
   NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts run load/seed-remove.sh --apply
   ```
   `cloudflare.ts zone --check` signale la règle tant qu'elle est en place (la routine du lundi
   aussi).

## Lire le résultat

- Artefact `k6-summary` du workflow : p95 et taux d'échec par scénario, seuils tenus ou non
  (code de sortie 99 si un seuil échoue), itérations perdues (`droppedIterations` : la charge
  demandée n'a pas pu partir, signe de saturation côté serveur ou runner).
- Sortie de `cpu` : moyenne et pic de chaque CPU et de la VM.
- Réussi si les quatre seuils tiennent et que le pic CPU reste sous 70 %.

`docs/lancement/charge.md` reprend : date, commit du staging, chiffres k6 et CPU, verdict, et le
seuil de trafic au-delà duquel passer à un VPS.

## Écarts avec le design

- Les limites de production sont posées par `docker update` sur les conteneurs du staging, sans
  recréation : le tas Node du web reste celui du staging (576 Mo au lieu de 1 152 Mo).
- Le scénario de recherche appelle `/api/search`, ce que fait la page de recherche à chaque filtre.
