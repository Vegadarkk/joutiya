# Test de charge : résultat (D17)

Procédure : `docs/lancement/charge-procedure.md`. Objectif (spec §10, critère de sortie de la
phase 6) : 40 pages/s hors cache avec un p95 sous 500 ms, 50 recherches/s avec un p95 sous 300 ms,
CPU de la VM sous 70 %. Si la VM n'y arrive pas, la marge mesurée fixe la bascule vers un VPS.

## 30 octobre 2026

- Staging au commit `b087a23`, limites CPU et mémoire de la production (web 1,5 cœur, Meilisearch
  1 cœur), 5 001 documents Firestore et 50 166 documents dans l'index (jeu `zz`/`zy` plus les
  annonces du staging).
- Deux passages, workflow **Load test** : n° 1 à 09:44 UTC (run 41035573855), n° 2 à 10:19 UTC
  (run 41039874222), mesure CPU par conteneur pendant le n° 2. Règle Cloudflare, limites et jeu de
  données défaits après coup (index revenu à 166 documents).

| Scénario | Demandé | Envoyé | Réussi | Médiane | p95 | Seuil |
| --- | --- | --- | --- | --- | --- | --- |
| Pages hors cache, n° 1 | 40/s pendant 3 min | 3 681 | 65,2 % | 10,8 s | 60 s (délai k6) | p95 < 500 ms, échecs < 1 % |
| Pages hors cache, n° 2 | 40/s pendant 3 min | 3 667 | 65,4 % | 10,9 s | 60 s (délai k6) | idem |
| Recherches, n° 1 | 50/s pendant 3 min | 8 898 | 98,8 % | 149 ms | 814 ms | p95 < 300 ms, échecs < 1 % |
| Recherches, n° 2 | 50/s pendant 3 min | 8 888 | 98,8 % | 106 ms | 802 ms | idem |
| Accueil en cache (chauffe) | 5/s pendant 1 min | environ 300 | non vérifié | 159 ms | 228 ms | aucun |

Environ 3 600 itérations par passage ne sont pas parties (`droppedIterations`) : les 300 utilisateurs
virtuels attendaient tous une réponse.

CPU pendant le n° 2 (moyenne par minute, `load/sampler-read.sh`) :

| Minute | Phase | VM (2 cœurs) | web | Meilisearch | cloudflared |
| --- | --- | --- | --- | --- | --- |
| 2 | pages | 47 % | 0,73 | 0,05 | 0,06 |
| 3-4 | pages | 73 % | 1,07 | 0,16-0,17 | 0,08-0,09 |
| 5 | pages puis recherches | 65 % | 0,85 | 0,26 | 0,08 |
| 6-7 | recherches | 39 % | 0,30 | 0,29 | 0,07-0,08 |
| pic | | | 1,22 | 0,37 | 0,13 |

**Verdict : échec.** Aucun seuil ne tient.

## Lecture

- Le rendu des pages hors cache sature à environ **13 pages réussies par seconde** (2 400 en
  3 minutes). Au-delà, les requêtes s'empilent et partent en délai dépassé.
- Le goulot est le processus web, pas la VM ni Meilisearch : le web plafonne vers 1 cœur alors que
  sa limite est 1,5, Meilisearch n'utilise que 0,2 à 0,3 cœur sur 1, et la recherche seule répond en
  106 à 149 ms de médiane. Next.js tourne dans un seul processus Node : son fil JavaScript sature
  (déduction : la mesure de retard de la boucle d'événements n'existe pas encore). Les 2 216
  `SearchUnavailableError: meilisearch response interrupted` du web pendant le n° 1 en découlent :
  le délai de 2 s de Meilisearch court aussi pendant que la boucle est occupée.
- Le p95 des recherches dépasse le seuil parce que leur phase commence pendant que les pages en
  retard finissent (jusqu'à 60 s) ; la médiane reste bonne. Un passage de recherche seul n'a pas été
  fait.
- Coût par rendu repéré dans le code : une page d'annonce envoie 3 requêtes de 200 résultats
  (guide des prix, `src/lib/price-guide/service.ts`), mises en cache par annonce seulement ; une page
  catégorie ou ville en envoie 5, refaites pour chacune des trois langues. Avec un seul vendeur, le
  jeu de test n'atteint jamais 5 vendeurs distincts : le guide interroge toujours les 3 zones.
- La règle « CPU sous 70 % » ne suffit pas comme signal : la VM était à 73 % au plus fort, mais le
  web était déjà saturé.

## Seuil de bascule

La production met les pages publiques anonymes en cache chez Cloudflare (`infra/cloudflare/cache-rules.json`,
TTL de l'origine) et en ISR : seuls les premiers passages et les revalidations arrivent au rendu.
Seuil retenu, en attendant un nouveau test : préparer la bascule (ou les améliorations ci-dessous)
quand les pages rendues par l'origine (HTML en `MISS` ou `EXPIRED` dans Cloudflare) dépassent
**8 par seconde** en pointe, environ 60 % de la saturation mesurée. Estimation, à refaire après
chaque changement du rendu.

## Pistes avant un nouveau test

1. Deux processus web (cluster Node ou deux répliques) pour utiliser les deux cœurs : environ deux
   fois la capacité de rendu attendue, à vérifier (cache ISR propre à chaque processus).
2. Guide des prix en cache par comparables et zone, plus seulement par annonce ; pages catégorie et
   ville en cache entre langues.
3. Profiler un rendu (`--cpu-prof` sur le staging) : environ 80 ms de CPU par page à ce débit.
