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

Claude prépare tout depuis le cloud, Nav n'envoie que les secrets GitHub (le proxy du cloud refuse
l'API Actions). Le jeton sert aussi au scan de sécurité.

1. **Nav** (PC2) : `node scripts/github-ci.ts public-key` donne la clé publique Actions du dépôt
   (publique).
2. **Claude** : `NODE_USE_ENV_PROXY=1 node scripts/github-ci.ts seal-scan --public-key=<fichier>
   --age-recipient=<age1…> --out=<fichier> --apply` crée (ou renouvelle) le jeton Access
   `joutiya-scan`, tire un `LOADTEST_BYPASS_SECRET` et scelle pour GitHub les secrets
   `STAGING_SCAN_ACCESS_TOKEN` (JSON `cf-access-client-id` / `cf-access-client-secret`) et
   `LOADTEST_BYPASS_SECRET`, avec les variables `ACCESS_TOKEN_HEADER=x-joutiya-access-token`,
   `SCAN_REPORT_AGE_RECIPIENT`, `SECURITY_SCAN_ENABLED=true` et `LOAD_TEST_ENABLED=true`. Il affiche
   l'identifiant du jeton (`ACCESS_SCAN_TOKEN_ID`).
3. **Claude** : `node scripts/cloudflare.ts access --apply` avec `ACCESS_SCAN_TOKEN_ID` : le staging
   accepte ce jeton, y compris dans l'en-tête unique `x-joutiya-access-token`.
4. **Claude** : `LOADTEST_BYPASS_SECRET` scellé pour la VM (`seal-env.ts app staging --only=…`),
   posé par `oracle-vm.ts env staging --sealed=…`, puis web et worker redémarrés. L'application
   refuse cette variable en production. La règle Cloudflare lit le même secret dans
   `<fichier>.cloudflare.env` (`JOUTIYA_LOADTEST_BYPASS_SECRET`).
5. **Nav** (PC2) : `node scripts/github-ci.ts apply <fichier> --apply`.

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
   `NODE_USE_ENV_PROXY=1 node --env-file=<fichier>.cloudflare.env scripts/cloudflare.ts loadtest --on --apply`
4. Mesure CPU, lancée juste avant le test (elle démarre quand l'agent Oracle prend la commande) :
   `NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts cpu --minutes=9`
5. Lancer le workflow **Load test** (Actions > Load test > Run workflow). Sept minutes de charge.
6. Défaire, même si le test a échoué :
   ```
   NODE_USE_ENV_PROXY=1 node scripts/cloudflare.ts loadtest --off --apply
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
