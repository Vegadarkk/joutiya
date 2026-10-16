# Phase 3 : annonces et médias

Le code de la phase 3 est sur la branche `claude/mvp-phase-3-fable-8j3rv0` (PR #40) : dépôt d'annonce en 9 étapes avec sauvegarde automatique, photos envoyées directement vers R2 puis traitées par le worker (WebP, EXIF et GPS supprimés, contrôle nudité et visages par modèles locaux), modération automatique avant publication, page annonce, page profil public, « Mes annonces », carte (SVG statique puis carte interactive MapLibre sur fond Protomaps sans frontières), expiration à 60 jours avec rappel, file de modération du back-office, sauvegardes Firestore chiffrées chaque nuit. Ce guide dit quoi brancher, dans l'ordre, et qui le fait. Coût : 0 €.

## Avant de commencer

- Phase 1 : VM, tunnels et Access en place pour l'environnement visé ; la zone `joutiya.ma` active chez Cloudflare (bascule des serveurs de noms après la validation du .MA) pour le domaine des médias.
- Phase 2 : variables de la VM posées (étape 7 de `docs/phase-2.md`).
- Les 9 buckets R2 `joutiya-{dev,staging,prod}-{quarantine,media,private}` existent déjà (phase 0).
- Sans R2, le site fonctionne en développement avec un stockage local (`os.tmpdir()/joutiya-dev-storage`) et refuse les envois de photos en staging et en production (réponse 503) : rien ne casse, la fonction attend.

## Qui fait quoi (règle n°1)

- **Claude** agit par API avec `JOUTIYA_CLOUDFLARE_API_TOKEN` : CORS et règles de cycle de vie des buckets, domaine `media.joutiya.ma`, envoi de la carte PMTiles, variables de la VM par OCI Run Command (fil « Mise en ligne phase 1 »).
- **Nav** (Claude dans votre navigateur) prépare les jetons qui ne se créent qu'en console : jeton S3 R2 par environnement, jeton Sentry des versions.
- **Vous :** le clic qui révèle chaque secret et son rangement, la paire de clés des sauvegardes (la clé privée ne quitte jamais votre PC). Ces moments sont signalés par **Vous :**.
- **Cody** : le prompt N en fin de page (paire de clés des sauvegardes).

## Les jetons et réglages de la phase 3

| Service | Jeton ou réglage | Portée minimale | Où il va | Qui |
|---|---|---|---|---|
| Cloudflare R2 | `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (jeton `joutiya-r2-<env>`) | *Object Read & Write*, limité aux 3 buckets de l'environnement | `app.env` de l'environnement | Nav prépare, **Vous :** révélez et rangez |
| Cloudflare R2 | `R2_S3_ENDPOINT` | `https://<account id>.eu.r2.cloudflarestorage.com` (juridiction UE) | `app.env` | Claude |
| Cloudflare R2 | `R2_BUCKET_QUARANTINE`, `R2_BUCKET_MEDIA`, `R2_BUCKET_PRIVATE` | Noms exacts de `infra/targets.json`, vérifiés par `scripts/assert-target.ts` | `app.env` | Claude |
| Cloudflare R2 | CORS du bucket quarantaine | `PUT` avec `Content-Type` depuis les origines du site de l'environnement | Bucket | Claude par API |
| Cloudflare R2 | Cycle de vie | Quarantaine : suppression après 1 jour ; privé `backups/` : 98 jours | Buckets | Claude par API |
| Cloudflare R2 | Domaine `media.joutiya.ma` (prod), `media-staging.joutiya.ma` (staging) | Domaine personnalisé du bucket médias, après activation de la zone | `MEDIA_BASE_URL` | Claude par API |
| Protomaps | Carte `maps/morocco.pmtiles` (~63 Mo, extrait Maroc z0-12) | Bucket médias, `Cache-Control: public, max-age=31536000, immutable`, CORS `GET`/`HEAD` + `Range` | `MAP_PMTILES_URL` | Claude (`scripts/geo/pmtiles-extract.sh` puis envoi S3) |
| Sentry | `SENTRY_AUTH_TOKEN` | Jeton d'organisation `joutiya`, droits *project:releases* et *org:read* | Secret GitHub du dépôt | Nav prépare, **Vous :** révélez et rangez dans GitHub |
| age | `BACKUP_AGE_RECIPIENT` (clé publique `age1…`) | Clé publique seulement ; la clé privée reste hors ligne chez vous | `app.env` | **Vous :** prompt N, puis Claude |

## 1. Stockage des photos (R2)

1. Nav ouvre Cloudflare → R2 → *Manage API tokens* → *Create Account API token*, nom `joutiya-r2-staging`, permission *Object Read & Write*, buckets `joutiya-staging-quarantine`, `joutiya-staging-media`, `joutiya-staging-private` uniquement, sans expiration ni filtrage IP. **Vous :** cliquez *Create*, puis rangez l'*Access Key ID* et la *Secret Access Key* dans `.env.local` sous `R2_ACCESS_KEY_ID_STAGING` et `R2_SECRET_ACCESS_KEY_STAGING`. Même chose pour `joutiya-r2-prod` avec les buckets `joutiya-prod-*`.
2. Claude pose par API le CORS du bucket quarantaine (envoi direct depuis le navigateur) et les règles de cycle de vie, puis écrit les variables R2 dans `app.env` par Run Command (les secrets passent de votre `.env.local` à la VM sans être affichés).
3. Quand la zone est active : Claude rattache `media.joutiya.ma` au bucket `joutiya-prod-media` (et `media-staging.joutiya.ma` au staging), puis pose `MEDIA_BASE_URL`.

## 2. Carte interactive

Claude relance l'extrait Maroc (`scripts/geo/pmtiles-extract.sh`, build Protomaps du jour), l'envoie en `maps/morocco.pmtiles` sur le bucket médias et pose `MAP_PMTILES_URL`. Sans cette variable, la page annonce affiche la carte SVG statique (régions et zone approximative), déjà complète. Le style maison supprime toutes les frontières de la carte de fond et dessine les 12 régions du Maroc (provinces du Sud incluses) depuis nos données.

## 3. Sauvegardes chiffrées

Chaque nuit à 03:30 UTC, le worker exporte Firestore (incrémental + rotation complète), compresse et chiffre chaque fichier avec votre clé publique age, puis le dépose dans le bucket privé sous `backups/<date>/`. Personne d'autre que vous ne peut les relire : la clé privée n'est ni sur la VM, ni dans le dépôt, ni dans le chat.

1. **Vous :** prompt N dans Cody : il génère la paire de clés sur votre PC, vous montre la clé publique et vous dit où ranger la clé privée (gestionnaire de mots de passe + copie hors ligne).
2. Collez la clé publique (`age1…`) dans le fil : elle est publique par conception. Claude la pose en `BACKUP_AGE_RECIPIENT` sur la VM.
3. Restauration (en cas de besoin) : `node scripts/restore-firestore.ts --identity <fichier de clé privée> --from <dossier> --project <projet>` (simulation par défaut, `--apply` pour écrire ; voir `docs/backups.md`).

Sans `BACKUP_AGE_RECIPIENT`, le travail de nuit ne sauvegarde rien et envoie une alerte : rien n'est jamais écrit en clair.

## 4. Variables de la VM (Claude, Run Command)

Pour le staging puis la production, dans `/etc/joutiya/<env>/app.env`, en plus des phases 1 et 2 : `R2_S3_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET_QUARANTINE`, `R2_BUCKET_MEDIA`, `R2_BUCKET_PRIVATE`, `MEDIA_BASE_URL`, `MAP_PMTILES_URL`, `BACKUP_AGE_RECIPIENT`, et `R2_STORAGE_BASELINE_BYTES` si l'usage R2 de l'autre projet du compte change (4,14 Go par défaut). Le worker a besoin d'environ 1 Go de mémoire (sharp + modèles ONNX) : réglage du fichier Compose par le fil « Mise en ligne phase 1 ».

## 5. Contrôles

- Dépôt : `npm run check`, `npm run test:api`, `npm run test:rules`, `npm run build` puis `npm run test:e2e`.
- Staging : déposer une annonce avec 3 photos depuis un téléphone (dont une photo HEIC d'iPhone), vérifier la page annonce, la suppression de l'EXIF (`exiftool` sur la photo publiée : aucune position GPS), « Mes annonces » (pause, reprise, vendue, suppression), la file **Modération** du back-office avec une annonce signalée, la carte interactive.
- Critères de sortie qui exigent le staging en ligne, notés en attente tant qu'il n'existe pas : Lighthouse mobile ≥ 90 sur la page annonce, dépôt complet en moins de 3 minutes sur un Android bridé, test de restauration sur de vraies données (le test de restauration contre l'émulateur est fait et passe).

## Prompts Cody

**N. Paire de clés des sauvegardes** (étape 3)

```text
Génère la paire de clés age des sauvegardes de Joutiya sur ce PC (docs/phase-3.md, étape 3). Installe age si besoin (winget install FiloSottile.age, ou le binaire officiel de github.com/FiloSottile/age), puis lance `age-keygen -o joutiya-backup-key.txt` dans un dossier hors de tout dépôt Git. N'affiche jamais le contenu du fichier : montre-moi seulement la clé publique (`age-keygen -y joutiya-backup-key.txt`, une ligne qui commence par age1). Dis-moi ensuite de ranger le fichier dans mon gestionnaire de mots de passe et d'en garder une copie hors ligne, puis de le supprimer du disque quand c'est fait. Ne copie le fichier nulle part ailleurs, ne l'envoie à aucun service.
```
