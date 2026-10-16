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
| 5 | Connexion Google d'Access | Nav, puis vous | Attend le projet Firebase de production |
| 6 | Applications Access et jetons de service | Claude (API), Nav | Après l'étape 5 |
| 7 | Serveurs DNS chez Cloudflare | Nav (Hostinger) | Après la validation du .MA, avant le 12 novembre |
| 8 | Déploiement automatique du staging | Claude (API), vous pour un jeton | Après les étapes 6 et 7 |
| 9 | Accès sans clé de la VM à Firestore | Claude | Avec la phase 2 |
| 10 | Mentions légales de la production | Claude | Après Firebase |
| 11 | Alertes | Claude | Phase 2 |
| 12 | Mise en production et contrôles | Claude | Après l'étape 8 |
| 13 | Test de reconstruction de la VM | Claude | Avant le lancement |

## Ce qui reste à vous

- **Étape 5** : afficher le secret du client Google créé par Nav et le coller dans le formulaire Zero Trust que Nav a ouvert. Vérifier que la validation en deux étapes de votre compte Google est active.
- **Étape 8** : sur la page de jeton GitHub préparée par Nav, cliquer sur **Generate token**, puis l'enregistrer dans l'environnement cloud sous `JOUTIYA_GITHUB_ACTIONS_TOKEN`.

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

Claude lance `node scripts/oracle-vm.ts create --apply --retry-minutes=120` depuis son environnement cloud (variables `JOUTIYA_OCI_*` et `JOUTIYA_CLOUDFLARE_API_TOKEN`) :
- réseau `joutiya-vcn` sans aucune règle d'entrée, ni SSH ni ICMP (`infra/vm/oci-security-list.json`), passerelle `joutiya-igw` pour la sortie, sous-réseau `joutiya-public` ;
- VM `joutiya-vm` : `VM.Standard.A1.Flex`, 2 OCPU, 12 Go, Ubuntu 24.04 aarch64, disque de 100 Go, service de métadonnées v2 seulement, aucune clé SSH ;
- démarrage (`infra/vm/bootstrap.sh`, rempli en mémoire) : agent Oracle, tunnel SSH, Docker, mémoire d'échange, mises à jour automatiques, puis les fichiers du dépôt (`infra/vm/install.sh`) et les jetons des tunnels Compose ;
- si Oracle manque de capacité A1, le script réessaie chaque minute. Jamais de forme payante ;
- chaque étape du démarrage peut être rejouée : si l'une échoue, tout le démarrage repart au redémarrage suivant (`node scripts/oracle-vm.ts reboot --apply`), sans perdre la VM. À la fin, il vérifie lui-même qu'aucun jeton n'est lisible par un autre utilisateur que root.

`node scripts/oracle-vm.ts status` montre l'état de la VM, les connexions du tunnel SSH et la progression du démarrage, lue sur la console série. Aucun secret n'y est écrit.

État au 16 octobre : réseau créé. La première création de la VM a été refusée par le quota `joutiya-free-tier` : ses lignes `zero` mettaient à 0 les quotas A1 régionaux, que ses lignes `set` ne relevaient pas. Nav a ajouté les deux lignes régionales (2 OCPU, 12 Go) à 01:31 UTC ; Claude relance la création.

Oracle peut reprendre une VM gratuite inactive 7 jours de suite (processeur, réseau et mémoire sous 20 %). Le staging et la sonde réduisent ce risque. Ne passez pas en *Pay As You Go* sans en parler dans le projet.

## 4. Accès de Claude à la VM

Claude administre la VM par OCI Run Command : il envoie un script par l'API Oracle avec sa clé `joutiya-claude`, et l'agent Oracle l'exécute en root. Aucun port ouvert, aucune clé SSH à garder, et cela marche avant la bascule DNS. Il s'en sert pour mettre à jour les fichiers de la VM, y déposer les secrets et faire les mises en production.

Fait le 16 octobre par Nav, sur votre phrase écrite dans son fil (01:44 UTC) ; leurs ID sont dans `infra/targets.json` :
- le groupe dynamique `joutiya-vm`, qui regroupe les instances du compartiment `joutiya` ;
- la politique `joutiya-run-command-policy`, en 3 lignes : le groupe `joutiya-automation` gère les commandes et lit l'état de l'agent dans `joutiya`, et la VM exécute ses propres commandes.

Limites : script de 4 Ko et sortie de 1 Ko par commande. Oracle garde le contenu 7 jours, lisible seulement par les administrateurs du compte et `joutiya-claude`. Sur la VM, `infra/vm/sudoers.oracle-run-command` rend root l'utilisateur `ocarun` de l'agent.

Commandes de Claude (`scripts/oracle-vm.ts`) :
- `agent` : les dernières commandes et l'état des modules de l'agent sur la VM ;
- `run <script> --apply` : un script en root, sa sortie revient ;
- `sync --apply` : installe `infra/vm` et `docker/` sur la VM (`infra/vm/install.sh`), en plusieurs commandes vérifiées par empreinte SHA-256.

## 5. Connexion Google d'Access

Vous, et plus tard le personnel, entrez sur les pages protégées avec un compte Google (§6). Prérequis : le projet Firebase de production existe (phase 0, réponse de Google attendue).

1. Nav, dans Google Cloud, projet de production (`environments.prod.firebase.projectId`), **Google Auth Platform** : nom « Joutiya », e-mail d'assistance = votre Gmail, audience *External* avec votre Gmail en utilisateur test. Puis **Clients** → *Web application* `cloudflare-access`, origine `https://joutiya.cloudflareaccess.com`, redirection `https://joutiya.cloudflareaccess.com/cdn-cgi/access/callback`.
2. Nav ouvre Zero Trust → **Settings** → **Authentication** → **Login methods** → **Add new** → **Google**.
3. Vous affichez l'ID et le secret du client, les collez dans ce formulaire et cliquez sur **Save**. Nav lance **Test** : la connexion doit réussir.

Une seule méthode Google : le script la retrouve seul.

## 6. Applications Access et jetons de service

1. Nav ajoute au jeton `joutiya-edge`, sans changer sa valeur, deux permissions : **Access: Service Tokens : Edit** (compte) et **Cache Purge : Purge** (zone `joutiya.ma`).
2. Claude crée par API les jetons de service `joutiya-ci` (déploiement du staging, étape 8) et `joutiya-probe` (la sonde ; son secret sera renouvelé par API quand la sonde sera déployée). Un secret va directement de l'API à sa destination, jamais dans un fichier ni dans le chat.
3. Claude lance `node scripts/cloudflare.ts access --apply`, avec `ACCESS_OWNER_EMAIL` (votre Gmail), `ACCESS_CI_TOKEN_ID` et `ACCESS_PROBE_TOKEN_ID` : `admin`, `ssh`, `staging` et `admin-staging` n'acceptent que votre compte Google, plus le jeton de la CI pour `ssh` et celui de la sonde pour `staging`.
4. Claude relance les parties `tunnel:*` : les noms protégés reçoivent leur enregistrement DNS.
5. Claude inscrit par PR les tags AUD de `admin.joutiya.ma` et `admin-staging.joutiya.ma` dans `infra/targets.json`. L'image de l'application embarque ce fichier.

## 7. Serveurs DNS chez Cloudflare

Après la validation du .MA par le registre, et avant le 12 novembre (Cloudflare supprime une zone en attente après 28 jours), Nav remplace chez Hostinger les serveurs DNS par `gloria.ns.cloudflare.com` et `rob.ns.cloudflare.com`. Le coordinateur fixe le moment. Cloudflare active alors la zone et émet le certificat. `joutiya.ma` sert le tunnel de production, et les noms protégés passent par Access.

## 8. Déploiement automatique du staging

1. Nav prépare un jeton GitHub à grain fin `joutiya-claude-actions` : dépôt `joutiya` seul, permissions **Secrets** et **Variables** en lecture et écriture, 90 jours. Vous cliquez sur **Generate token** et l'enregistrez dans l'environnement cloud sous `JOUTIYA_GITHUB_ACTIONS_TOKEN`.
2. Claude, dans une nouvelle session :
   - crée la clé de `deploy-staging` : la clé privée va dans le secret GitHub `STAGING_DEPLOY_SSH_KEY`, la clé publique sur la VM ;
   - met `STAGING_ACCESS_CLIENT_ID` et `STAGING_ACCESS_CLIENT_SECRET` (jeton `joutiya-ci`) ;
   - met la variable `VM_SSH_KNOWN_HOSTS`, avec la clé d'hôte lue sur la console série ;
   - puis met `STAGING_DEPLOY_ENABLED` à `true`.
3. Claude lance *Deploy staging* sur `main`. Ensuite, chaque fusion sur `main` construit l'image et la déploie en staging toute seule.

Le déploiement des règles Firestore du staging par la CI (`FIREBASE_STAGING_WIF_PROVIDER`, `FIREBASE_STAGING_DEPLOYER`) attend la phase 2.

## 9. Accès sans clé de la VM à Firestore

Fédération d'identité X.509 (§9) : comptes de service `joutiya-web` et `joutiya-worker`, pool `joutiya-vm`, un certificat par conteneur. Claude la met en place avec la phase 2, une fois les projets Firebase créés. Si Google exige la facturation, la solution de repli (une clé par conteneur, renouvelée tous les 90 jours) demande votre accord.

## 10. Mentions légales de la production

La production refuse de démarrer tant qu'une mention obligatoire manque : hébergeur, adresse et téléphone des hébergeurs de données. Claude relève les entités Oracle et Google dans leurs contrats publics, puis écrit `config/legal` dans Firestore avec `scripts/legal-config.ts`, en production puis en staging.

## 11. Alertes

Les alertes du site partent par Resend (phase 2, `/mnt/project-files/joutiya/phase-1/alertes-resend-spec.md`), puis aussi par Telegram quand le bot existera. Le Worker de sonde `joutiya-uptime-probe` vérifie `https://joutiya.ma` et le staging toutes les 5 minutes ; il est déployé avec les alertes. L'Email Routing de Cloudflare n'est pas utilisé.

## 12. Mise en production et contrôles

1. Claude vérifie que le dernier *Deploy staging* est vert, et que `https://staging.joutiya.ma` affiche l'accueil et les pages légales.
2. Claude promeut la version du staging par Run Command (`joutiya-deploy prod promote`) : seules les images déjà en service en staging peuvent passer, désignées par leur identifiant exact. Il vide ensuite le cache Cloudflare par API.
3. Contrôles de fin de phase :
   - `https://joutiya.ma/api/health` répond `ok` ;
   - un balayage de tous les ports de l'IP publique de la VM n'en trouve aucun ouvert ;
   - securityheaders.com donne au moins la note A ;
   - `https://admin.joutiya.ma` demande la connexion Google d'Access.

## 13. Tester la reconstruction de la VM

La VM ne doit garder aucune donnée unique. On le vérifie une fois, avant le lancement, tant que personne n'utilise le site : Claude supprime `joutiya-vm` (disque compris) et la reconstruit selon `infra/redeploy.md`, refait les contrôles de l'étape 12 et note la durée totale.

**Fin de la phase 1 :**
- `main` se déploie seul en staging ;
- la production tourne ;
- aucun port n'est ouvert ;
- la note est A ;
- la reconstruction de la VM est testée ;
- la CI est au vert.
