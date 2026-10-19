# Sauvegardes Firestore (procédure d'incident)

Export chiffré de Firestore chaque nuit (DESIGN D17). Code : `src/lib/backup/`, tâche
`src/worker/jobs/backup-firestore.ts`, restauration `scripts/restore-firestore.ts`.

## Tâche de nuit

- `backup-firestore`, à 03:30 UTC sur la file `system` du worker, une seule tentative. Lectures par le SDK
  Admin, comptées dans `firestore.reads`.
- Passe 1, incrémentale : pour chaque collection qui a un champ de date (`updatedAt`, sinon `createdAt`),
  les documents à partir du curseur de la collection, dans l'ordre (date, chemin), jusqu'à 20 000 par nuit.
  Un parcours coupé reprend strictement après le dernier (date, chemin) exporté : des documents qui
  partagent la même date ne sont jamais sautés. La passe suivante commence par la collection coupée
  (tourniquet).
- Passe 2, rotation complète : jusqu'à 10 000 documents par nuit dans l'ordre des chemins, reprise
  collection par collection ; un cycle couvre toutes les collections de la table de sauvegarde
  (`export.ts`, `TABLE`). Elle reçoit ce que l'incrémentale a laissé de la limite par nuit ci-dessous.
- Une nuit lit au plus 20 000 documents (40 % du quota Spark de lectures du jour) pour les deux passes, et
  les parcours s'arrêtent quand le quota de lectures du jour atteint 75 % ; les curseurs gardent
  l'avancement.
- Les curseurs sont dans `system/backup` et n'avancent qu'une fois le manifeste déposé : une nuit en échec
  est refaite la nuit suivante. Une seule exécution par date UTC (une deuxième, ou un manifeste déjà
  présent, est ignorée).
- Alertes : P1 si `BACKUP_AGE_RECIPIENT` est absent ou invalide, ou si R2 n'est pas configuré (une fois par
  jour, rien n'est écrit), et à tout échec ; P2 si le quota de lectures a arrêté la nuit, ou si un cycle
  de rotation complète n'est toujours pas fini après 60 jours (au-delà des 98 jours de rétention, des
  documents n'auraient plus de copie). Le résultat (nombres, parties, octets, lectures, durée) est journalisé
  sous `backup-firestore`.

### Jauge du stockage Firestore

Spark offre 1 Go de stockage Firestore, sans remise à zéro. Aucune API gratuite ne donne ce chiffre :
la sauvegarde l'estime sans aucune lecture de plus. Elle additionne les octets NDJSON (avant compression)
de la rotation complète ; un cycle complet contient chaque document une fois. Firestore compte aussi les
entrées d'index (deux par champ indexé, croissant et décroissant) : l'estimation vaut 2 fois ces octets
(`FIRESTORE_STORAGE_FACTOR`, justifié dans `export.ts`).

- C'est un plancher : le vrai chiffre est plus élevé (petits documents très indexés, collections hors
  sauvegarde comme `quotaDaily` et `system`). Le chiffre réel est dans la console Firebase → Firestore →
  *Usage*.
- La jauge `firestore.storage` (back-office, page Quotas) prend la valeur du dernier cycle complet après
  chaque nuit réussie. Elle reste « Inconnu » tant qu'aucun cycle n'a été additionné du début à la fin.
- Alerte P2 à 70 % (700 Mo, le seuil du §2 pour décider du passage à Blaze), P1 à 100 %. La période est le
  mois : chaque alerte part au plus une fois par mois, pas chaque nuit. La jauge ne bloque rien.
- Quand l'alerte part : comparez avec la console, puis décidez (Blaze, ou purge des journaux).

## Fichiers

Bucket privé (`R2_BUCKET_PRIVATE`) :

```
backups/<YYYY-MM-DD>/incremental/<collection>[-<n>].ndjson.gz.age
backups/<YYYY-MM-DD>/full/<collection>[-<n>].ndjson.gz.age
backups/<YYYY-MM-DD>/manifest.json.age
```

Une partie est du NDJSON (une ligne par document : `{"p": chemin, "d": données, "u": updateTime}`, les types
Firestore en objets étiquetés) -> gzip -> age, au plus 20 000 documents ou 16 Mio de NDJSON. Le manifeste
(age seulement) liste chaque partie avec son nombre de documents, sa taille et son SHA-256, plus les
curseurs. Rien n'est jamais écrit en clair, ni sur la VM ni dans le bucket.

Rétention : 98 jours, par une règle de cycle de vie R2 sur le préfixe `backups/` de chaque bucket privé
(réglage d'infrastructure, DESIGN section 7 ; pas posé par ce code) :
`{"rules":[{"id":"backups-98d","enabled":true,"conditions":{"prefix":"backups/"},"deleteObjectsTransition":{"condition":{"type":"Age","maxAge":8467200}}}]}`.

## Clés

- Vous générez la paire hors ligne : `age-keygen -o joutiya-backup.key` (age v1.3 ou plus). La clé publique
  affichée (`age1...`, 62 caractères) va dans `BACKUP_AGE_RECIPIENT`, dans le `app.env` du worker.
- Le fichier de clé (`AGE-SECRET-KEY-1...`) reste hors ligne chez vous (gestionnaire de mots de passe et une
  copie hors ligne) : jamais sur la VM, dans le dépôt, dans la CI ni dans un chat. Sans lui, aucune
  sauvegarde n'est lisible.
- Rotation : nouvelle paire, nouveau `BACKUP_AGE_RECIPIENT` ; gardez l'ancien fichier de clé 98 jours pour
  les sauvegardes plus anciennes.
- Lecture à la main : `age -d -i joutiya-backup.key manifest.json.age`, ou
  `age -d -i joutiya-backup.key users.ndjson.gz.age | gunzip | head`.

## Restauration

Depuis votre PC (le fichier de clé ne le quitte jamais), avec Node 24 :

```
# 1. Simulation : déchiffre et vérifie chaque partie en mémoire, n'affiche que des nombres.
node scripts/restore-firestore.ts --identity joutiya-backup.key --from ./backups --project <project-id>
# Directement depuis le bucket au lieu d'une copie téléchargée (variables R2_* dans .env.local) :
node --env-file=.env.local scripts/restore-firestore.ts --identity joutiya-backup.key --from-bucket --project <project-id>
# 2. Écriture.
node scripts/restore-firestore.ts ... --apply
```

- Cible : avec `FIRESTORE_EMULATOR_HOST`, l'émulateur local (n'importe quel identifiant de projet). Sinon un
  projet enregistré dans `infra/targets.json` ; celui de production demande en plus `--allow-production`.
  Identifiants : Application Default Credentials (`gcloud auth application-default login` ; voir les points
  ouverts plus bas).
- Options : `--collections users,listings` (identifiants de la table de sauvegarde, `private` =
  `users/{uid}/private/*`), `--until YYYY-MM-DD` (l'état de cette nuit-là, par exemple avant un mauvais
  déploiement).
- Chaque document reçoit sa version capturée la plus récente (la plus haute date de mise à jour, toutes
  dates et passes confondues), écrite avec `set()` par lots de 500. Une partie qui ne correspond pas à son
  manifeste arrête la restauration ; les jours sans aucune sauvegarde sont signalés.
- Une date sans manifeste (nuit qui n'a pas fini, ou nuit en cours à 03:30 UTC) est refusée : ses parties
  n'ont ni nombre de documents ni SHA-256 à vérifier. Le message liste les parties et propose
  `--until <la veille>` pour s'arrêter avant. `--allow-unverified` les restaure quand même, sans
  vérification, en les listant.
- `set()` remplace des documents entiers : restaurer dans une base en service annule ce qui a changé depuis
  la sauvegarde. Préférez un projet vide, ou réduisez avec `--collections`.

### Plus de 20 000 documents (Spark)

Spark accepte 20 000 écritures par jour, celles de l'application comprises ; au-delà, toute écriture
échoue jusqu'à la remise à zéro (minuit heure du Pacifique, entre 7 h et 9 h au Maroc). Avec `--apply`,
le script refuse donc d'écrire plus de 20 000 documents dans un vrai projet (l'émulateur n'a pas de
limite) ; la simulation l'annonce déjà.

1. Lancez la simulation : elle donne le nombre de documents par collection.
2. Regroupez les collections en lots de moins de 20 000 documents (gardez de la marge pour l'application
   si le projet est en service), un lot par jour, après la remise à zéro.
3. Chaque jour : `node scripts/restore-firestore.ts ... --collections <lot du jour> --until <même date pour
   tous les lots> --apply`. Le même `--until` garde un état cohérent d'un jour à l'autre.
4. Une seule collection de plus de 20 000 documents (par exemple `connectionLogs`, gardé un an) ne se
   découpe pas : il faut passer le projet cible à Blaze le temps de la restauration (votre décision : compte
   de facturation, les écritures au-delà du gratuit sont payantes), puis ajouter `--allow-over-quota`.

Après une restauration :

1. Les suppressions ne sont pas dans les sauvegardes : les documents supprimés après une sauvegarde
   reviennent. Une annonce purgée revient sous forme de pierre tombale (elle porte `updatedAt`) dès que
   l'incrémentale qui a suivi la purge est restaurée ; avant cela, son texte complet revient. Lancez
   `retention-purge` et `purge-unactivated`, et vérifiez les conservations légales, avant de rouvrir.
2. Hors sauvegarde : les comptes Firebase Auth (à exporter à part), `config/legal`
   (`scripts/legal-config.ts`), `quotaDaily`, les curseurs `system/*` (reconstruits), les objets R2
   (photos).
3. Reconstruisez l'index de recherche depuis Firestore (phase 4).

## Répétition de la restauration

Le test contre l'émulateur (`tests/api/backup/restore.test.ts`) passe. La chaîne réelle ne l'est pas
encore : identifiants du worker -> bucket privé -> cycle de vie -> clé age hors ligne ->
`restore-firestore.ts --apply` sur un vrai projet. Elle se répète deux fois :

- **A, critère de sortie de la phase 3**, dès que le staging tourne et a au moins deux nuits de sauvegarde
  dont un cycle complet (jauge `firestore.storage` connue au back-office) : sauvegardes du staging vers le
  projet `joutiya-dev`.
- **B, avant le lancement (porte de la phase 6)** : sauvegardes de la production vers le staging. Avant le
  lancement, la production ne contient pas encore de données de vrais utilisateurs ; après, ne copiez plus
  la production vers le staging.

Prérequis : le fichier de clé age sur votre PC ; les deux points ouverts plus bas réglés ; le projet cible
vide ou jetable.

1. Cody note l'heure, puis lance la simulation depuis le bucket de la source (`--from-bucket`,
   `--project joutiya-dev` pour A, `--project joutiya-staging` pour B). Notez la plage de dates, le nombre
   de parties, les dates vérifiées et les documents par collection. Toute alerte (jour manquant, partie
   ignorée, date sans manifeste) est un résultat à noter, pas à contourner.
2. Si la simulation dépasse 20 000 documents, découpez comme ci-dessus.
3. Même commande avec `--apply` ; notez l'heure de fin et le nombre de documents écrits. Il doit égaler le
   total de la simulation.
4. Dans la console Firebase du projet cible, comparez trois documents avec la source : une annonce, un
   utilisateur, son document `private/account` (dates, position, références intactes).
5. Remplissez une ligne du tableau. Pour B, gardez le staging tel quel (données d'avant le lancement) ou
   videz-le ; pour A, `joutiya-dev` peut rester tel quel.

| Date | Répétition | Source -> cible | Nuits (de … à …) | Parties | Documents (simulation) | Documents écrits | Durée simulation | Durée écriture | Écarts, remarques |
|---|---|---|---|---|---|---|---|---|---|
| | A | staging -> `joutiya-dev` | | | | | | | |
| | B | prod -> `joutiya-staging` | | | | | | | |

### Points ouverts avant la répétition

- Identifiants Google : le script prend les Application Default Credentials. `gcloud auth
  application-default login` remplace celles de vos autres projets sur ce PC ; le reste de Joutiya passe
  par la configuration à part `~/.joutiya/gcloud` (`scripts/google-wif.ts login`, `scripts/legal-config.ts`).
  À aligner avant la répétition.
- `--from-bucket` lit `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` et `R2_BUCKET_PRIVATE`
  sans suffixe, alors que votre `.env.local` range les clés sous `R2_ACCESS_KEY_ID_STAGING`,
  `R2_ACCESS_KEY_ID_PROD`, etc. À aligner aussi (sinon : télécharger `backups/` et utiliser `--from`).

## Limites connues

- Une modification d'un document sans `updatedAt` (journaux, `listingStats`, `searchOutbox`, `private`) ou
  avec `createdAt` seulement (`emailIndex`, `staff`, `moderationDecisions`) n'arrive dans les sauvegardes
  que par la rotation complète : dans un cycle (documents / 10 000 nuits).
- La première incrémentale d'une collection couvre ses dernières 24 h ; les documents plus anciens arrivent
  avec la rotation complète.
- Les fichiers age sont chiffrés, pas signés : quiconque a la clé publique et un droit d'écriture sur le
  bucket pourrait y déposer une partie, voire un manifeste. Ne restaurez que depuis le bucket privé de
  l'environnement (jeton R2 limité à ses buckets), et n'utilisez `--allow-unverified` qu'en connaissant
  l'origine des parties listées.
- La restauration sur de vraies données reste à faire (répétitions A et B ci-dessus).
