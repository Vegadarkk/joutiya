# Phase 1 : mettre les fondations en ligne

Règle n° 1 : Claude fait la mise en ligne par API, avec des jetons dédiés et limités ; Nav (Claude dans votre navigateur) fait ce qui n'a pas d'API. Vous ne gardez que les mots de passe, la double authentification, les paiements, les pièces d'identité, et le clic qui affiche un jeton suivi de son enregistrement dans l'environnement. Coût : 0 €.

Le code de la phase 1 est dans `main` (PR #8). Ce guide dit qui fait quoi, dans l'ordre, et où on en est.

## Où on en est (16 octobre 2026)

| # | Étape | Qui | État |
|---|---|---|---|
| 1 | Tunnels Cloudflare | Claude (API) | Fait |
| 2 | DNS de `joutiya.ma` | Claude (API) | `joutiya.ma` et `www` faits ; les noms protégés attendent l'étape 6 |
| 3 | Réseau et VM Oracle | Claude (API), Nav pour le quota | Réseau fait, quota corrigé par Nav ; VM en création |
| 4 | Accès de Claude à la VM | Nav, sur votre phrase | Fait ; vérifié sur la VM dès sa création |
| 5 | Connexion Google d'Access | Nav, puis vous | Fait le 16 octobre, vérifié |
| 6 | Applications Access et jetons de service | Claude (API), Nav | Après les étapes 5 et 7 (Access exige une zone active) |
| 7 | Serveurs DNS chez Cloudflare | Nav (Hostinger) | Après la validation du .MA, avant le 12 novembre |
| 8 | Déploiement automatique du staging | Claude (API), vous pour un jeton | Après les étapes 6 et 7 |
| 9 | Accès sans clé de la VM à Firestore | Claude (outil), Nav sur le PC2 pour la partie Google | Prompt P lancé le 16 octobre ; certificats de la VM dès qu'elle existe |
| 10 | Mentions légales de la production | Claude | Après Firebase |
| 11 | Alertes | Claude (API), Nav pour un filtre Gmail | Code en phase 2 ; après l'étape 7 (domaine Resend) |
| 12 | Mise en production et contrôles | Claude | Après l'étape 8 |
| 13 | Test de reconstruction de la VM | Claude | Avant le lancement |
| 14 | Réglages des buckets R2 | Nav, sur votre « J'accepte » ; Claude vérifie | Fait le 16 octobre, vérifié |
| 15 | Domaines des médias | Nav | À l'activation de la zone (étape 7) |
| 16 | Variables de la VM | Claude (Run Command), Cody pour vos clés | Outil prêt ; dès que la VM existe |

## Ce qui reste à vous

- **Étape 8** : sur la page de jeton GitHub préparée par Nav, cliquer sur **Generate token**, puis l'enregistrer dans l'environnement cloud sous `JOUTIYA_GITHUB_ACTIONS_TOKEN`.
- **Étape 9** : Nav lance le prompt P sur le PC2 ; vous choisissez dans le navigateur le compte Google de vos projets Firebase.
- **Étape 16**, quand la VM existera : lancer le prompt O dans Cody, qui envoie les clés de votre `.env.local` sur la VM.

Rien d'autre : ni clé SSH, ni commande, ni console.

## 1. Tunnels Cloudflare (fait)

Trois tunnels gérés par Cloudflare, créés par API le 16 octobre avec le jeton `joutiya-edge` :
- `joutiya-ssh-tunnel` : SSH seulement, servi par cloudflared sur la VM elle-même ;
- `joutiya-prod-tunnel` et `joutiya-staging-tunnel` : le site, servis dans Compose.

Leurs ID sont dans `infra/targets.json`, leurs règles dans `infra/cloudflare/tunnel.*.json`, appliquées par `node scripts/cloudflare.ts tunnel:ssh tunnel:staging tunnel:prod --apply`. Leurs jetons ne sortent jamais de l'API : `scripts/oracle-vm.ts` les lit en mémoire et les place dans le démarrage de la VM.

## 2. DNS

- Fait : `joutiya.ma` et `www.joutiya.ma` pointent vers le tunnel de production. Avant, ils pointaient vers la page d'attente Hostinger (`2.57.91.91`).
- `ssh`, `staging`, `admin-staging` et `admin` reçoivent leur enregistrement seulement une fois leur application Access créée (étape 6). Le script refuse de publier un nom protégé sans sa protection.
- Les enregistrements du courrier Hostinger restent en DNS seul. L'Email Routing de Cloudflare reste éteint.
- Tant que les serveurs DNS restent chez Hostinger (étape 7), rien de tout cela n'est visible sur Internet.

## 3. Réseau et VM Oracle

Claude lance `node scripts/oracle-vm.ts create --apply --retry-minutes=4800 --small-fallback` depuis son environnement cloud (variables `JOUTIYA_OCI_*` et `JOUTIYA_CLOUDFLARE_API_TOKEN`) :
- réseau `joutiya-vcn` sans aucune règle d'entrée, ni SSH ni ICMP (`infra/vm/oci-security-list.json`), passerelle `joutiya-igw` pour la sortie, sous-réseau `joutiya-public` ;
- VM `joutiya-vm` : `VM.Standard.A1.Flex`, 2 OCPU, 12 Go, Ubuntu 24.04 aarch64, disque de 100 Go, service de métadonnées v2 seulement, aucune clé SSH ;
- démarrage (`infra/vm/bootstrap.sh`, rempli en mémoire) : agent Oracle, tunnel SSH, Docker, mémoire d'échange, mises à jour automatiques, puis les fichiers du dépôt (`infra/vm/install.sh`) et les jetons des tunnels Compose ;
- si Oracle manque de capacité A1, le script réessaie chaque minute, en demandant une fois sur deux 1 OCPU et 6 Go (la même forme gratuite, plus facile à placer). Une VM créée ainsi suffit au staging et à la production avant le lancement ; elle passe à 2 OCPU et 12 Go avant le lancement (un redémarrage). Jamais de forme payante, jamais de seconde VM ;
- chaque étape du démarrage peut être rejouée : si l'une échoue, tout le démarrage repart au redémarrage suivant (`node scripts/oracle-vm.ts reboot --apply`), sans perdre la VM. À la fin, il vérifie lui-même qu'aucun jeton n'est lisible par un autre utilisateur que root.

`node scripts/oracle-vm.ts status` montre l'état de la VM, les connexions du tunnel SSH et la progression du démarrage, lue sur la console série. Aucun secret n'y est écrit.

État au 16 octobre : réseau créé. La première création de la VM a été refusée par le quota `joutiya-free-tier` : ses lignes `zero` mettaient à 0 les quotas A1 régionaux, que ses lignes `set` ne relevaient pas. Nav a ajouté les deux lignes régionales (2 OCPU, 12 Go) à 01:31 UTC ; Claude relance la création. Depuis 01:47 UTC, Oracle n'a plus de place A1 libre à Paris et le paiement à l'usage est exclu (16 octobre) : Claude réessaie chaque minute, en alternant 2 OCPU / 12 Go et 1 OCPU / 6 Go depuis 13:13 UTC.

Oracle peut reprendre une VM gratuite inactive 7 jours de suite (processeur, réseau et mémoire sous 20 %). Le staging et la sonde réduisent ce risque. Ne passez pas en *Pay As You Go* sans en parler dans le projet.

## 4. Accès de Claude à la VM

Claude administre la VM par OCI Run Command : il envoie un script par l'API Oracle avec sa clé `joutiya-claude`, et l'agent Oracle l'exécute en root. Aucun port ouvert, aucune clé SSH à garder, et cela marche avant la bascule DNS. Il s'en sert pour mettre à jour les fichiers de la VM, y déposer les secrets et faire les mises en production.

Fait le 16 octobre par Nav, sur votre phrase écrite dans son fil (01:44 UTC) ; leurs ID sont dans `infra/targets.json` :
- le groupe dynamique `joutiya-vm`, qui regroupe les instances du compartiment `joutiya` ;
- la politique `joutiya-run-command-policy`, en 3 lignes : le groupe `joutiya-automation` gère les commandes et lit l'état de l'agent dans `joutiya`, et la VM exécute ses propres commandes.

Limites : script de 4 Ko et sortie de 1 Ko par commande. Oracle garde le contenu 7 jours, lisible seulement par les administrateurs du compte et `joutiya-claude`. Sur la VM, `infra/vm/sudoers.oracle-run-command` rend root l'utilisateur `ocarun` de l'agent.

Commandes de Claude (`scripts/oracle-vm.ts`) :
- `agent` : les dernières commandes et l'état des modules de l'agent sur la VM ;
- `run <script> --apply` : un script en root, sa sortie revient ; `run infra/vm/check.sh --apply` contrôle le démarrage (agent, tunnels, droits des jetons, chaîne `JOUTIYA-IMDS`, sans afficher de secret) ;
- `sync --apply` : installe `infra/vm` et `docker/` sur la VM (`infra/vm/install.sh`), en plusieurs commandes vérifiées par empreinte SHA-256.

## 5. Connexion Google d'Access (fiche Nav N15)

Vous, et plus tard le personnel, entrez sur les pages protégées avec un compte Google (§6). Les projets Firebase existent depuis le 16 octobre ; cette étape n'attend ni la VM ni la zone.

Le client OAuth d'Access vit dans le projet de staging (`environments.staging.firebase.projectId`), pas en production. Sa redirection oblige à inscrire `cloudflareaccess.com` dans les domaines autorisés du projet ([Google](https://support.google.com/cloud/answer/15549049)), et la validation de la marque exige d'être propriétaire de chacun d'eux ([Google](https://support.google.com/cloud/answer/13464321)) : en production, il bloquerait celle de la connexion Google du site. Le staging, réservé aux testeurs, n'en a jamais besoin.

1. Nav, dans Google Cloud, projet `joutiya-staging`, **Google Auth Platform** : les réglages de `docs/phase-2.md` §2 (nom « Joutiya », e-mail d'assistance = votre Gmail, audience *External*, statut *Testing*, votre Gmail en utilisateur test), plus `cloudflareaccess.com` dans **Branding** → **Authorized domains**.
2. Nav ouvre dans un autre onglet Zero Trust → **Integrations** → **Identity providers** (ancien chemin : **Settings** → **Authentication** → **Login methods**) → **Add new** → **Google** : nom « Google », **PKCE** activé, ID et secret laissés vides.
3. Nav prépare **Clients** → **Create client** → *Web application* `cloudflare-access` : origine `https://joutiya.cloudflareaccess.com`, redirection `https://joutiya.cloudflareaccess.com/cdn-cgi/access/callback`. Il s'arrête avant **Create** : Google n'affiche le secret qu'une fois, à la création ([Google](https://support.google.com/cloud/answer/15549257)).
4. Vous cliquez sur **Create**, collez l'ID du client dans **App ID** et le secret dans **Client secret** du formulaire Zero Trust, puis cliquez sur **Save**. Fenêtre fermée trop tôt : **Clients** → `cloudflare-access` → **Add secret**, même copie.
5. Nav lance **Test** : la connexion doit réussir avec votre Gmail.

Fait le 16 octobre à 12:20 UTC : client `cloudflare-access` créé dans `joutiya-staging` (Google a accepté `cloudflareaccess.com`), test de Nav réussi avec votre Gmail. Claude a vérifié par API : une seule méthode Google, nommée « Google », PKCE activé, ID du client conforme ; l'autre méthode du compte, celle que Cloudflare crée par défaut, n'est admise par aucune application Joutiya.

Une seule méthode Google dans le compte : le script la retrouve seul, et Claude vérifie par API qu'il n'y en a qu'une. Un futur membre du personnel entre dans la règle Access (étape 6) et, si Google le refuse en *Testing*, dans les utilisateurs test du projet de staging (100 au plus).

## 6. Applications Access et jetons de service

Cloudflare n'accepte une application Access que sur une zone active ([doc](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)) : cette étape suit la bascule des serveurs DNS (étape 7).

1. Nav ajoute au jeton `joutiya-edge`, sans changer sa valeur, deux permissions : **Access: Service Tokens : Edit** (compte) et **Cache Purge : Purge** (zone `joutiya.ma`).
2. Claude crée par API les jetons de service `joutiya-ci` (déploiement du staging, étape 8) et `joutiya-probe` (la sonde ; son secret sera renouvelé par API quand la sonde sera déployée). Un secret va directement de l'API à sa destination, jamais dans un fichier ni dans le chat.
3. Claude lance `node scripts/cloudflare.ts access --apply`, avec `ACCESS_OWNER_EMAIL` (votre Gmail), `ACCESS_CI_TOKEN_ID` et `ACCESS_PROBE_TOKEN_ID` : `admin`, `staging` et `admin-staging` n'acceptent que votre compte Google (plus le jeton de la sonde pour `staging`), et `ssh` seulement le jeton de la CI. Seul `staging.joutiya.ma/api/webhooks/*` laisse passer sans Access les webhooks de Resend et de Meta, qui ne peuvent pas se connecter : le site vérifie la signature de chaque envoi.
4. Claude relance les parties `tunnel:*` : les noms protégés reçoivent leur enregistrement DNS.
5. Claude inscrit par PR les tags AUD de `admin.joutiya.ma` et `admin-staging.joutiya.ma` dans `infra/targets.json`. L'image de l'application embarque ce fichier.

## 7. Serveurs DNS chez Cloudflare

Après la validation du .MA par le registre, et avant le 12 novembre (Cloudflare supprime une zone en attente après 28 jours), Nav remplace chez Hostinger les serveurs DNS par `gloria.ns.cloudflare.com` et `rob.ns.cloudflare.com`. Le coordinateur fixe le moment. Cloudflare active alors la zone et émet le certificat. `joutiya.ma` sert le tunnel de production ; les noms protégés passent par Access dès l'étape 6, que Claude enchaîne.

## 8. Déploiement automatique du staging

1. Nav prépare un jeton GitHub à grain fin `joutiya-claude-actions` : dépôt `joutiya` seul, permissions **Secrets** et **Variables** en lecture et écriture, 90 jours. Vous cliquez sur **Generate token** et l'enregistrez dans l'environnement cloud sous `JOUTIYA_GITHUB_ACTIONS_TOKEN`.
2. Claude, dans une nouvelle session :
   - crée la clé de `deploy-staging` : la clé privée va dans le secret GitHub `STAGING_DEPLOY_SSH_KEY`, la clé publique sur la VM (`oracle-vm.ts sync --deploy-staging-key`) ;
   - met `STAGING_ACCESS_CLIENT_ID` et `STAGING_ACCESS_CLIENT_SECRET` (jeton `joutiya-ci`) ;
   - met la variable `VM_SSH_KNOWN_HOSTS`, avec la clé d'hôte lue sur la console série ;
   - puis met `STAGING_DEPLOY_ENABLED` à `true`.
3. Claude lance *Deploy staging* sur `main`. Ensuite, chaque fusion sur `main` construit l'image et la déploie en staging toute seule.

Les variables `FIREBASE_STAGING_WIF_PROVIDER` et `FIREBASE_STAGING_DEPLOYER` (rien de secret, les valeurs que `setup staging` affiche) sont posées depuis le 16 octobre (Nav). Le déploiement des règles Firestore du staging par la CI attend encore l'étape 9 : sans le fournisseur et le compte qu'elle crée, son job échouerait.

## 9. Accès sans clé de la VM à Firestore

Fédération d'identité X.509 (§9) : web et worker prouvent qui ils sont par un certificat, sans clé JSON. `scripts/google-wif.ts` tourne sur la machine de l'autorité : votre PC2, par Nav (16 octobre). L'autorité qui signe les certificats y reste (`~/.joutiya/wif-ca`), et gcloud s'y connecte dans une configuration à part (`~/.joutiya/gcloud`), sans toucher à celle de vos autres projets. Ce dossier `~/.joutiya` ne doit pas se perdre : sans lui, il faut une nouvelle autorité et refaire `setup`.

1. `ca` crée l'autorité (EC P-256, 10 ans), une seule fois.
2. `login` ouvre la connexion Google. **Vous :** choisir le compte de vos projets Firebase et accepter.
3. `setup staging` puis `setup prod`, en simulation puis avec `--apply`, dans le projet Firebase consigné pour l'environnement : API IAM, IAM Credentials, STS et Resource Manager ; comptes `joutiya-web` (Cloud Datastore User, Firebase Authentication Admin, signature de ses propres custom tokens) et `joutiya-worker` (Cloud Datastore User, Firebase Authentication Admin) ; pool `joutiya-vm` et son fournisseur `x509`, qui ne croit que l'autorité et n'accepte que `joutiya-<env>-web` et `joutiya-<env>-worker`. En staging, aussi `joutiya-deployer` (Firebase Rules Admin, Cloud Datastore Index Admin, et Service Usage Consumer, qu'exige `firebase deploy`) et le pool `github`, réservé à `deploy-staging.yml` sur `main` de ce dépôt (identifiant numérique dans `infra/targets.json`). L'outil ajoute ce qui manque et ne retire jamais rien.
4. `test staging` puis `test prod` : des certificats d'un jour signés sur votre PC prouvent toute la chaîne (lecture Firestore et custom token pour web, lecture Firestore et Firebase Auth pour worker), puis leurs clés sont effacées. IAM met quelques minutes à appliquer les droits : l'outil réessaie seul.
5. Quand la VM existe, après ses variables et avant le premier déploiement : Claude lance `node scripts/oracle-vm.ts wif <env> --apply`, qui crée sur la VM une clé par conteneur (elle n'en sort jamais) et affiche leurs demandes de certificat, publiques. Nav les signe sur le PC2 (`node scripts/google-wif.ts sign <fichier>`) et renvoie les lignes `certificate` ; Claude les pose (`wif <env> --certificates=<fichier> --apply`) et relance web et worker. Ni clé Oracle ni `.env.local` sur le PC2. Sans ces fichiers, web et worker refusent de démarrer.

Le certificat d'un conteneur vaut un an : les mêmes étapes le renouvellent, et Claude programme un rappel. Si Google exige la facturation pour ces API, `setup` s'arrête avant toute création : la solution de repli (une clé JSON par conteneur, renouvelée tous les 90 jours) demande votre accord. Nouvelle autorité (fin de projet, fuite) : `ca --new`, puis `setup` et `wif` pour les deux environnements.

**P. Accès Google sans clé** (prompt pour l'agent de la machine de l'autorité : Nav, sur le PC2)

```text
Prépare l'accès sans clé de Joutiya à Google (docs/phase-1.md, étape 9), depuis Git Bash, à la racine du dépôt à jour (git pull). Ces commandes n'ont pas besoin de .env.local : ne le lis pas. 1) Si node_modules manque : npm ci --ignore-scripts. 2) node scripts/google-wif.ts ca. 3) node scripts/google-wif.ts login ; si gcloud manque, dis-moi d'installer Google Cloud CLI et arrête-toi ; sinon je choisis dans le navigateur le compte de mes projets Firebase. 4) Pour staging puis prod : node scripts/google-wif.ts setup <env>, simulation qui liste ce qui sera créé ; sans erreur, relance-la avec --apply ; si Google demande la facturation, arrête-toi et montre-moi le message. 5) node scripts/google-wif.ts test staging, puis test prod. Résume-moi seulement ce qui a été créé et si les deux tests passent. N'affiche jamais une clé ni un jeton.
```

## 10. Mentions légales de la production

La production refuse de démarrer tant qu'une mention obligatoire manque : hébergeur, adresse et téléphone des hébergeurs de données. Claude relève les entités Oracle et Google dans leurs contrats publics, puis écrit `config/legal` dans Firestore avec `scripts/legal-config.ts`, en production puis en staging.

## 11. Alertes

Les alertes partent par e-mail (Resend) et par Telegram (`@Joutiyabot`). Le Worker de sonde `joutiya-uptime-probe` vérifie `https://joutiya.ma` et le staging toutes les 5 minutes, et relaie les alertes de l'application (`/mnt/project-files/joutiya/phase-1/alertes-resend-spec.md`). L'Email Routing de Cloudflare n'est pas utilisé.

Prérequis : le domaine `notif.joutiya.ma` vérifié chez Resend, après la bascule DNS (étape 7).

1. Claude crée par l'API Resend une clé d'envoi limitée à `notif.joutiya.ma`, réservée au Worker, et la place directement dans son secret `RESEND_API_KEY` : elle n'est ni sur la VM, ni dans l'environnement cloud, ni dans le chat.
2. Claude déploie le Worker et pose ses secrets par l'API Cloudflare : `RESEND_API_KEY`, `ALERT_EMAIL_TO` (votre Gmail), `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ALERT_RELAY_SECRET`, `ACCESS_CLIENT_ID` et `ACCESS_CLIENT_SECRET` (jeton `joutiya-probe`). L'expéditeur, `Joutiya alertes <alertes@notif.joutiya.ma>`, est dans `workers/uptime-probe/wrangler.jsonc`.
3. Test : une alerte signée arrive dans votre Gmail depuis `alertes@notif.joutiya.ma`, avec SPF, DKIM et DMARC à PASS (« Afficher l'original ») ; Nav ajoute un filtre Gmail « Ne jamais envoyer dans le spam » pour cet expéditeur.

Garde-fous : au plus 20 e-mails relayés par jour UTC (au-delà, l'application reçoit une erreur 429 et la note dans ses journaux), et un seul avis Telegram par jour quand le quota Resend du jour est épuisé. Sans `ALERT_EMAIL_TO` ni `RESEND_API_KEY`, le Worker n'envoie aucun e-mail et l'écrit dans ses journaux ; avec un seul des deux, il signale une erreur.

## 12. Mise en production et contrôles

1. Claude vérifie que le dernier *Deploy staging* est vert, et que `https://staging.joutiya.ma` affiche l'accueil et les pages légales.
2. Claude promeut la version du staging par Run Command (`node scripts/oracle-vm.ts promote --apply`, qui vide ensuite le cache Cloudflare) : seules les images déjà en service en staging peuvent passer, désignées par leur identifiant exact, et seulement un commit de `main`. Retour arrière : `rollback --apply`. La production n'a aucun accès SSH : seul le staging en garde un, pour la CI. Un déploiement, en staging comme en production, n'attend que web et worker : une recherche en panne répond 503 sans faire revenir la version précédente.
3. Contrôles de fin de phase :
   - `https://joutiya.ma/api/health` répond `ok` ;
   - un balayage de tous les ports de l'IP publique de la VM n'en trouve aucun ouvert ;
   - securityheaders.com donne au moins la note A ;
   - `https://admin.joutiya.ma` demande la connexion Google d'Access.

## 13. Tester la reconstruction de la VM

La VM ne doit garder aucune donnée unique. On le vérifie une fois, avant le lancement, tant que personne n'utilise le site : Claude supprime `joutiya-vm` (disque compris) et la reconstruit selon `infra/redeploy.md`, refait les contrôles de l'étape 12 et note la durée totale.

## 14. Réglages des buckets R2 (fiche Nav N16)

La quarantaine reçoit les photos envoyées directement par le navigateur ; les médias servent la carte (PMTiles) par plages d'octets. Régler les buckets par API exigerait la permission **Workers R2 Storage : Edit** sur tout le compte, donc sur vos autres buckets ([doc](https://developers.cloudflare.com/r2/platform/troubleshooting/)) : Nav le fait dans le tableau de bord. L'état voulu est dans `infra/cloudflare/r2-buckets.json`.

Phrase de votre « J'accepte » : « Nav règle le CORS et les règles de cycle de vie des buckets R2 joutiya (dev, staging, prod) dans le tableau de bord Cloudflare. »

Cloudflare → **R2** (buckets EU) → bucket → **Settings**. Seulement ces buckets `joutiya-*` ; la règle par défaut d'abandon des envois multipart reste.
1. **CORS Policy** → **Add CORS policy** → onglet **JSON**, coller exactement, puis **Save** :
   - `joutiya-prod-quarantine` : `[{"AllowedOrigins":["https://joutiya.ma","https://www.joutiya.ma"],"AllowedMethods":["PUT"],"AllowedHeaders":["Content-Type"],"MaxAgeSeconds":3600}]`
   - `joutiya-staging-quarantine` : le même avec `"AllowedOrigins":["https://staging.joutiya.ma"]`
   - `joutiya-prod-media` : `[{"AllowedOrigins":["https://joutiya.ma","https://www.joutiya.ma"],"AllowedMethods":["GET","HEAD"],"AllowedHeaders":["Range"],"ExposeHeaders":["ETag","Content-Range","Content-Length"],"MaxAgeSeconds":3600}]`
   - `joutiya-staging-media` : le même avec `"AllowedOrigins":["https://staging.joutiya.ma"]`
2. **Object lifecycle rules** → **Add rule** :
   - `joutiya-dev-quarantine`, `joutiya-staging-quarantine`, `joutiya-prod-quarantine` : nom `delete-after-1-day`, tous les objets, suppression des objets envoyés après 1 jour ;
   - `joutiya-dev-private`, `joutiya-staging-private`, `joutiya-prod-private` : nom `delete-backups-after-98-days`, préfixe `backups/`, suppression après 98 jours.

   Le dev reçoit les règles de cycle de vie, comme les autres, mais pas de CORS : en local, l'application garde ses fichiers sur le disque.
3. Nav rapporte, pour chaque bucket, le JSON du CORS et la liste des règles de cycle de vie, tels que le tableau de bord les affiche.

Hors champ : aucun changement de jeton, ni accès public, ni `r2.dev`, ni domaine personnalisé (étape 15), ni autre bucket.

Ensuite, Claude vérifie le CORS par des requêtes préliminaires, sans jeton (`node scripts/cloudflare.ts r2`) : chaque origine du site doit passer, une origine étrangère doit être refusée. Il compare les règles de cycle de vie rapportées par Nav à `r2-buckets.json`.

Fait le 16 octobre : Nav a appliqué la fiche à 11:35 UTC, sur votre « J'accepte » de 10:47. Toutes les requêtes préliminaires passent (R2 répond 204) et les origines étrangères sont refusées ; les règles relues par Nav sont celles du fichier, plus la règle par défaut de Cloudflare qui abandonne après 7 jours les envois multipart inachevés, présente sur chaque bucket.

## 15. Domaines des médias

À l'activation de la zone (étape 7), Nav relie chaque bucket de médias à son domaine, pour la même raison qu'à l'étape 14 : Cloudflare → **R2** → bucket → **Settings** → **Custom Domains** → **Add**.
- `joutiya-prod-media` : `media.joutiya.ma` ;
- `joutiya-staging-media` : `media-staging.joutiya.ma`.

Puis, pour chacun, version TLS minimale **1.2**, comme le reste de la zone. Cloudflare crée lui-même l'enregistrement DNS. Hors champ : `r2.dev`, tout autre bucket. Les deux noms restent au premier niveau (`media-staging`, pas `media.staging`) : le certificat universel ne couvre que ce niveau. Claude vérifie ensuite chaque domaine (TLS et CORS).

## 16. Variables de la VM

Chaque environnement lit `/etc/joutiya/<env>/app.env` (root, 0600) et deux mots de passe Valkey. Claude les écrit par Run Command avec `node scripts/oracle-vm.ts env <staging|prod>`, qui fusionne les noms envoyés avec ceux déjà présents et ne montre jamais une valeur : seulement les noms, leur provenance et ce qui manque encore.
- **Registre** `infra/targets.json` : adresses du site et du back-office, projet et application web Firebase, compte de service `joutiya-web`, client Google de connexion, clé de site Turnstile, DSN Sentry, compte et buckets R2, Access.
- **VM** : `CSRF_SECRET`, les mots de passe Valkey et la clé maîtresse de Meilisearch (`meilisearch.env`, phase 4), générés une fois sur place ; ils n'en sortent jamais et une VM reconstruite en reçoit de nouveaux. Les deux clés de recherche de l'application en dérivent : `node scripts/oracle-vm.ts search-setup <env> --apply` crée l'index et les écrit dans `app.env`, puis recrée web et worker, une fois qu'une version avec Meilisearch tourne.
- **Votre `.env.local`**, lu sur votre PC par Cody (prompt O) : les clés secrètes. Le fichier sert aussi à un autre produit : l'outil ne fait que le lire, ne prend que des noms de `.env.example` et seulement sous deux formes : `NOM_STAGING=…` ou `NOM_PROD=…`, ou la paire rangée par Nav le 16 octobre (ligne de production active, ligne du staging en commentaire juste dessous) pour `FIREBASE_SERVER_API_KEY`, `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` et `MAIL_FALLBACK_API_KEY`. Toute autre ligne est ignorée : valeur de développement ou de l'autre produit. Une clé de site Turnstile différente du registre arrête tout : la paire aurait été mal lue.
- **Google** : `GOOGLE_CLOUD_PROJECT`, égal au projet Firebase, évite à la bibliothèque de Google de chercher le projet avant chaque premier jeton. Les certificats de web et worker ne sont pas dans `app.env` : ils sont posés ensuite dans `/etc/joutiya/<env>/gcp` (étape 9, point 5).
- **Claude, au fil des étapes** : `CF_ACCESS_AUD` (étape 6), `ALERT_RELAY_URL` et `ALERT_RELAY_SECRET` (Worker, étape 11), `MAIL_API_KEY` et `MAIL_WEBHOOK_SECRET` (Resend, après la bascule DNS), `MAP_PMTILES_URL` (phase 3). Puis il relance web et worker.

`HASH_PEPPER` sert aux empreintes des e-mails, des téléphones et des désabonnements dans Firestore : il ne doit jamais changer. Cody le génère dans votre `.env.local` (`HASH_PEPPER_STAGING`, `HASH_PEPPER_PROD`), qui en garde la copie ; **Vous :** rangez-la aussi dans votre gestionnaire de mots de passe. Les réglages R2 ne s'écrivent qu'avec les deux clés `R2_ACCESS_KEY_ID` et `R2_SECRET_ACCESS_KEY` de l'environnement : un jeu partiel empêche l'application de démarrer.

Pour l'envoi, Cody a besoin dans votre `.env.local` des six lignes `JOUTIYA_OCI_*` de votre environnement cloud (mêmes noms, mêmes valeurs : la clé de `joutiya-claude`). Oracle garde le texte des commandes 7 jours, lisible seulement par les administrateurs du compte et `joutiya-claude`, qui lisent déjà ces fichiers en root.

**O. Variables de la VM** (prompt Cody)

```text
Envoie les clés de mon .env.local sur la VM de Joutiya (docs/phase-1.md, étape 16). Ce fichier sert aussi à un autre produit : ne le lis pas toi-même (ni cat, head, tail, sed, ni grep sans -q), ne l'affiche pas, ne le réécris pas et ne change ni l'ordre ni le texte de ses lignes ; seuls les deux scripts ci-dessous le lisent. 1) `node scripts/vm-env.ts pepper .env.local` : ajoute HASH_PEPPER_STAGING et HASH_PEPPER_PROD à la fin du fichier s'ils manquent, sans montrer de valeur ; dis-moi alors de les copier dans mon gestionnaire de mots de passe. 2) Pour staging puis prod : `node --env-file=.env.local scripts/oracle-vm.ts env <env> --from=.env.local`, simulation qui liste les noms, leurs lignes et ce qui manque. Sans erreur, relance la même commande avec --apply ; sinon montre-moi les erreurs et arrête. S'il manque des variables JOUTIYA_OCI_*, dis-moi lesquelles ajouter, sans valeur. Ne me donne aucune valeur, seulement des noms.
```

## Renouvellements

Toutes les échéances du projet sont dans `joutiya/echeances.md`, dans les fichiers du projet. Celles de cette phase :

- **Certificats Google de la VM** (web et worker, staging et production) : 365 jours à partir de leur pose. Oubliés, web et worker n'obtiennent plus d'accès Google : Firestore et Firebase Auth échouent, et le site ne fonctionne plus. Le renouvellement prend une dizaine de minutes ; web et worker redémarrent en quelques secondes :
  1. Claude : `node scripts/oracle-vm.ts wif staging --apply`, puis `wif prod --apply` : nouvelles clés sur la VM, demandes de certificat affichées ;
  2. Nav, sur le PC2 : `node scripts/google-wif.ts sign <fichier des demandes>`, qui rend les lignes `certificate` ;
  3. Claude : `node scripts/oracle-vm.ts wif <env> --certificates=<fichier> --apply` pour chacun, puis contrôle des journaux.

  Un rappel part 30 jours avant l'échéance : Claude le pose avec les certificats.
- **Autorité des certificats** (PC2, `~/.joutiya/wif-ca`) : 10 ans, jusqu'au 13 octobre 2036. Gardez le dossier `~/.joutiya` du PC2 (autorité et connexion gcloud). S'il est perdu ou si l'autorité expire, Nav en crée une nouvelle (`ca --new`) et refait `setup staging --apply` et `setup prod --apply`, puis Claude refait les certificats de la VM comme ci-dessus.
- **Jeton Cloudflare `joutiya-edge`** : jusqu'au 15 novembre 2026. Oublié, Claude ne peut plus régler Cloudflare par API (DNS, tunnels, cache) ; le site continue de tourner. Nav prépare un jeton aux mêmes droits, vous le rangez sous `JOUTIYA_CLOUDFLARE_API_TOKEN`.
- **Jeton GitHub `joutiya-claude-actions`** (étape 8) : 90 jours à partir de sa création. Oublié, Claude ne peut plus changer les secrets et variables de la CI ; les déploiements continuent.

## Fin de la phase 1

- `main` se déploie seul en staging ;
- la production tourne ;
- aucun port n'est ouvert ;
- la note est A ;
- la reconstruction de la VM est testée ;
- la CI est au vert.
