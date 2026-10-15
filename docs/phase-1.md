# Phase 1 : mettre les fondations en ligne

Le code de la phase 1 est prêt (PR #8) : application, image Docker, configuration Cloudflare, scripts de la VM, CI. Il reste à créer la VM et à brancher les comptes. Ce guide vous dit quoi faire, dans l'ordre. Cody fait la plupart des étapes avec les prompts en fin de page. Coût : 0 €.

## Avant de commencer

- Étapes 0 à 6 de `docs/phase-0.md` faites, et `infra/targets.json` rempli (Cloudflare, Oracle, Firebase).
- PR #8 fusionnée dans `main`, et dossier du dépôt à jour (`git pull` sur `main`), Node 24 ou plus récent.
- **Créez la VM (étape 5) dans les 30 jours qui suivent votre inscription chez Oracle** : un compte gratuit inactif peut être suspendu.
- Les clés et jetons vont dans `.env.local`, sous les noms de `.env.example`, jamais dans le dépôt ni dans le chat. Cody les lit sans les afficher.

## 1. Outils et clés SSH (prompt E)

Cody installe `cloudflared`, `gcloud` et OpenSSH s'ils manquent. Il crée ensuite 3 clés SSH sur votre machine :
- `joutiya_admin` : votre accès administrateur (utilisateur `ubuntu`) ;
- `joutiya_deploy_prod` : la promotion en production, qui ne quitte jamais votre machine ;
- `joutiya_deploy_staging` : la clé de la CI, qui ira dans GitHub.

Donnez une phrase de passe aux deux premières et rangez-la dans votre gestionnaire de mots de passe. Elle est demandée à la première connexion, puis gardée par l'agent SSH jusqu'à la fin de la session.

## 2. Cloudflare : les 3 Tunnels

Zero Trust → **Networks** → **Tunnels** → **Create a tunnel** → **Cloudflared**. Créez-en 3, avec ces noms exacts :
- `joutiya-ssh-tunnel`
- `joutiya-prod-tunnel`
- `joutiya-staging-tunnel`

Pour chacun :
1. Copiez le jeton affiché (la longue chaîne après `--token` dans la commande d'installation) dans `.env.local` : `JOUTIYA_SSH_TUNNEL_TOKEN`, `JOUTIYA_PROD_TUNNEL_TOKEN`, `JOUTIYA_STAGING_TUNNEL_TOKEN`.
2. N'installez rien et n'ajoutez aucun nom d'hôte public : le script s'en charge (étape 4). Si l'assistant insiste, quittez-le après la création.
3. Notez l'**ID** du Tunnel (colonne *Tunnel ID*).

## 3. Cloudflare : Access, connexion Google et jetons d'API

**Jetons de service** : Zero Trust → **Access** → **Service credentials** → **Service Tokens** → **Create**, deux fois.
- `joutiya-ci` (durée : 1 an). Le Client ID et le Client Secret vont dans GitHub à l'étape 10. Ne les copiez nulle part ailleurs.
- `joutiya-probe` (durée : 1 an). Ses deux valeurs vont dans le Worker à l'étape 9.
- Le secret ne s'affiche qu'une fois. Gardez cette page ouverte jusqu'aux étapes 9 et 10, ou rangez-le dans votre gestionnaire de mots de passe.
- Dans `.env.local`, notez l'**ID** de chaque jeton (pas le Client ID) : `ACCESS_CI_TOKEN_ID`, `ACCESS_PROBE_TOKEN_ID`. Ajoutez votre Gmail : `ACCESS_OWNER_EMAIL`.

**Connexion Google** : vous, et plus tard le personnel, entrez sur les pages protégées avec un compte Google (§6).
1. Vérifiez que la validation en deux étapes est active sur votre compte Google : myaccount.google.com → **Sécurité**.
2. Google Cloud console → projet Firebase de production (`environments.prod.firebase.projectId` dans `infra/targets.json`) → **Google Auth Platform** (anciennement *OAuth consent screen*) :
   - **Branding** : nom « Joutiya », e-mail d'assistance = votre Gmail ;
   - **Audience** : *External*, et ajoutez votre Gmail dans **Test users**.
3. **Clients** → **Create client** → *Web application*, nom `cloudflare-access` :
   - *Authorized JavaScript origins* : `https://<équipe>.cloudflareaccess.com`, où `<équipe>.cloudflareaccess.com` est `shared.cloudflare.accessTeamDomain` dans `infra/targets.json` ;
   - *Authorized redirect URIs* : `https://<équipe>.cloudflareaccess.com/cdn-cgi/access/callback`.
   - Gardez la fenêtre avec l'ID client et le secret ouverte.
4. Zero Trust → **Settings** → **Authentication** → **Login methods** → **Add new** → **Google** : collez l'ID client et le secret, **Save**, puis **Test** : la connexion doit réussir. Ne créez qu'une seule méthode Google : le script la retrouve seul.

**Jetons d'API** : My Profile → **API Tokens** → **Create Token** → **Custom token**, deux fois.

1. `joutiya-edge`, pour le script de configuration (votre machine, et l'environnement cloud Claude global si Claude doit appliquer la configuration lui-même) :
   - Compte (Account resources : votre compte) : **Cloudflare Tunnel : Edit**, **Access: Apps and Policies : Edit** et **Access: Organizations, Identity Providers, and Groups : Read**.
   - Zone (Zone resources : **Specific zone** → `joutiya.ma`) : **Zone : Read**, **Zone Settings : Edit**, **Zone WAF : Edit**, **Transform Rules : Edit**, **Cache Rules : Edit**, **Single Redirect : Edit** et **DNS : Edit**.
   - Durée : 30 jours.
   - Rangez-le dans `.env.local` sous `JOUTIYA_CLOUDFLARE_API_TOKEN`.
2. `joutiya-purge`, pour vider le cache à chaque mise en production :
   - Une seule permission : Zone `joutiya.ma` → **Cache Purge : Purge**.
   - Sans date d'expiration.
   - Rangez-le dans `.env.local` sous `JOUTIYA_CF_PURGE_TOKEN`. Il ira sur la VM.

## 4. Appliquer la configuration Cloudflare (prompt F)

Cody inscrit les 3 ID de Tunnel dans `infra/targets.json`. Il lance ensuite `scripts/cloudflare.ts` en simulation et vous montre ce qui va changer : réglages SSL, WAF, limitation de débit, cache, redirection `www`, Tunnels, enregistrements DNS et applications Access. Il n'applique qu'après votre accord.

Le script refuse de remplacer un enregistrement DNS existant. Si une ancienne page d'attente Hostinger occupe encore `joutiya.ma` ou `www`, Cody vous la montre, et vous décidez.

À la fin, il inscrit dans `infra/targets.json` le tag **AUD** des applications `admin.joutiya.ma` (prod) et `admin-staging.joutiya.ma` (staging), puis ouvre une PR « Record phase 1 identifiers ». Fusionnez-la (ou demandez-le à Claude dans le projet) avant l'étape 10 : l'image de l'application embarque `infra/targets.json`, et sans ces identifiants elle refuse de démarrer.

## 5. Oracle : créer la VM

1. Préparez le script de démarrage (prompt E, dernière partie) : Cody crée `infra/vm/bootstrap.local.sh` avec le jeton du Tunnel SSH. Git ignore ce fichier.
2. Oracle → **Networking** → **Virtual Cloud Networks** → **Start VCN Wizard** → *Create VCN with Internet Connectivity* → nom `joutiya-vcn` → Create.
3. Ouvrez `joutiya-vcn` → **Security Lists** → *Default Security List* → **supprimez toutes les règles d'entrée** (Ingress Rules), y compris SSH (port 22) et ICMP. Gardez la règle de sortie. Faites de même dans *Security List for Private Subnet-joutiya-vcn*, créée par l'assistant. La liste cible est décrite dans `infra/vm/oci-security-list.json`.
4. **Compute** → **Instances** → **Create instance** :
   - Nom `joutiya-vm`.
   - Image **Canonical Ubuntu 24.04** (pas *Minimal*).
   - Shape **Ampere** → `VM.Standard.A1.Flex`, **2 OCPU, 12 Go**. Le badge *Always Free* doit être visible.
   - Réseau `joutiya-vcn`, sous-réseau public, adresse IPv4 publique : elle sert à sortir vers Internet, aucune entrée n'est ouverte.
   - Clé SSH : **Paste public key** → contenu de `~/.ssh/joutiya_admin.pub`.
   - Disque de démarrage : 100 Go (le quota gratuit est de 200 Go).
   - **Show advanced options** → **Management** → **Paste cloud-init script** → tout le contenu de `bootstrap.local.sh`.
   - Create.
5. Attendez 10 minutes. Le Tunnel `joutiya-ssh-tunnel` passe à **Healthy** dans Cloudflare.
6. Supprimez `bootstrap.local.sh` : le jeton reste chez Cloudflare, et la VM le garde.

Oracle reprend une VM gratuite inactive 7 jours de suite (processeur, réseau et mémoire sous 20 %). Le staging qui tourne dès l'étape 10 et la sonde réduisent ce risque. Ne passez pas en *Pay As You Go* sans en parler dans le projet.

## 6. Premier accès et fichiers de la VM (prompt G)

1. Dans un terminal : `ssh joutiya`. Votre navigateur s'ouvre pour la connexion Access avec Google, puis la session SSH démarre.
2. Cody vérifie que le démarrage s'est bien terminé. Il installe ensuite les fichiers du dépôt sur la VM (`node scripts/deploy-prod.ts vm-sync`) : utilisateurs de déploiement, SSH, sudo, Compose, pare-feu des conteneurs.
3. Il écrit les secrets dans `/etc/joutiya/staging/` et `/etc/joutiya/prod/`. Ceux qui manquent (mots de passe Valkey, `HASH_PEPPER`, `ALERT_RELAY_SECRET`) sont générés sur place.
4. Il relève l'empreinte SSH de la VM pour GitHub (étape 10).

## 7. Google : accès sans clé de la VM à Firestore (prompt H)

La VM s'authentifie auprès de Google par un certificat (fédération d'identité X.509), sans fichier de clé.

Cody fait, dans `joutiya-staging` puis `joutiya-prod` :
- les comptes de service `joutiya-web` et `joutiya-worker`, avec les seuls rôles prévus ;
- le pool d'identités `joutiya-vm` ;
- un certificat par conteneur, signé par une autorité créée sur votre machine.

La clé de cette autorité reste sur votre machine : rangez-la dans votre gestionnaire de mots de passe. Les certificats durent un an ; un rappel suivra.

Si Google exige un compte de facturation pour ces API sur Spark, Cody s'arrête. Prévenez Claude dans le projet : la solution de repli est une clé par conteneur, renouvelée tous les 90 jours, et elle demande votre accord.

## 8. Mentions légales de la production (prompt I)

La production refuse de démarrer tant qu'une mention obligatoire manque (hébergeur, adresse et téléphone des hébergeurs de données).
1. Relevez dans le contrat Oracle accepté à l'inscription l'entité, son adresse et son téléphone.
2. Faites de même pour l'entité Google du contrat Firebase (Google Cloud EMEA ou Google Ireland).
3. Cody écrit `config/legal` dans Firestore (prod, puis staging), après vous avoir montré le résultat.

## 9. Sonde de disponibilité et alertes e-mail (prompt J)

Cody déploie le Worker `joutiya-uptime-probe` dans votre compte Cloudflare. Il vérifie `https://joutiya.ma` et le staging toutes les 5 minutes. Il prévient sur Telegram et par e-mail après 2 échecs de suite, puis au rétablissement. Il relaie aussi les alertes e-mail du site.

Prérequis : Email Routing actif (phase 0, étape 2) et votre Gmail vérifié comme destination.

## 10. GitHub : déploiement automatique du staging

Prérequis : la PR « Record phase 1 identifiers » de l'étape 4 est fusionnée.

GitHub → dépôt `joutiya` → **Settings** → **Secrets and variables** → **Actions**.
- Onglet **Secrets** :
  - `STAGING_DEPLOY_SSH_KEY` : contenu de `~/.ssh/joutiya_deploy_staging`, la clé privée sans `.pub`. Cody peut l'envoyer avec `gh` sans l'afficher.
  - `STAGING_ACCESS_CLIENT_ID` et `STAGING_ACCESS_CLIENT_SECRET` : jeton `joutiya-ci`.
- Onglet **Variables** :
  - `VM_SSH_KNOWN_HOSTS` : la ligne donnée par Cody à l'étape 6.
  - `STAGING_DEPLOY_ENABLED` = `true`, en dernier.
- Le déploiement des règles Firestore du staging par la CI (`FIREBASE_STAGING_WIF_PROVIDER`, `FIREBASE_STAGING_DEPLOYER`) peut attendre. Les règles actuelles refusent tout, et Cody les déploie depuis votre machine.

Lancez ensuite le premier déploiement : onglet **Actions** → *Deploy staging* → **Run workflow** sur `main`. Après, chaque fusion sur `main` construit l'image et la déploie en staging toute seule.

## 11. Mise en production et contrôles (prompt K)

1. Ouvrez `https://staging.joutiya.ma` (connexion Access) : la page d'accueil et les pages légales s'affichent.
2. `node scripts/deploy-prod.ts promote` : le script montre la version du staging et demande de taper ses 7 premiers caractères.
3. Contrôles de fin de phase, faits par Cody :
   - `https://joutiya.ma/api/health` répond `ok` ;
   - un balayage de tous les ports de l'IP publique de la VM n'en trouve aucun ouvert ;
   - securityheaders.com donne au moins la note A ;
   - `https://admin.joutiya.ma` demande la connexion Google d'Access.

## 12. Tester la reconstruction de la VM

La VM ne doit garder aucune donnée unique : on le vérifie une fois, avant le lancement, tant que personne n'utilise le site. Comptez une heure.
1. Oracle → **Compute** → **Instances** → `joutiya-vm` → **Terminate**, en cochant la suppression du disque de démarrage.
2. Suivez `infra/redeploy.md`, partie « Reconstruire », avec Cody (prompts E point 4, G et H).
3. Refaites les contrôles de l'étape 11 et notez la durée totale.

Si Oracle répond *Out of capacity* à la création, réessayez plus tard ou à une autre heure : rien n'est encore public.

**Fin de la phase 1 :**
- `main` se déploie seul en staging ;
- la production tourne ;
- aucun port n'est ouvert ;
- la note est A ;
- la reconstruction de la VM est testée ;
- la CI est au vert.

Donnez le résultat des contrôles à Claude dans le projet.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour.

**E. Outils, clés SSH et script de démarrage** (étapes 1 et 5.1)

```text
Prépare mon poste pour la phase 1 de Joutiya (docs/phase-1.md). 1) Installe s'ils manquent cloudflared, la CLI gcloud et le client OpenSSH, depuis les sources officielles. 2) Crée dans ~/.ssh trois clés ed25519 : joutiya_admin et joutiya_deploy_prod (je tape moi-même leur phrase de passe), et joutiya_deploy_staging sans phrase de passe (elle ira dans GitHub). N'écrase aucune clé existante. 3) Ajoute à ~/.ssh/config deux hôtes, sans toucher aux autres : « joutiya » (HostName ssh.joutiya.ma, User ubuntu, IdentityFile ~/.ssh/joutiya_admin) et « joutiya-deploy-prod » (HostName ssh.joutiya.ma, User deploy-prod, IdentityFile ~/.ssh/joutiya_deploy_prod), tous deux avec IdentitiesOnly yes, AddKeysToAgent yes et ProxyCommand cloudflared access ssh --hostname %h. Vérifie qu'un agent SSH tourne sur ma machine (sinon, active-le). 4) Quand j'aurai mis JOUTIYA_SSH_TUNNEL_TOKEN dans .env.local : copie infra/vm/bootstrap.sh en infra/vm/bootstrap.local.sh en remplaçant __JOUTIYA_SSH_TUNNEL_TOKEN__ par ce jeton, sans jamais l'afficher, et vérifie avec git status que le fichier est ignoré. Ne commite rien.
```

**F. Configuration Cloudflare** (étape 4)

```text
Applique la configuration Cloudflare de Joutiya (docs/phase-1.md, étape 4). Crée une branche phase-1-identifiers depuis main à jour. Inscris dans infra/targets.json les ID de Tunnel que je te donne : shared.cloudflare.sshTunnelId, environments.prod.cloudflare.tunnelId et environments.staging.cloudflare.tunnelId. Lance node --env-file=.env.local scripts/assert-target.ts jusqu'au vert : il vérifie aussi que chaque jeton de Tunnel de .env.local correspond au bon Tunnel et au bon compte. Lance ensuite `node --env-file=.env.local scripts/cloudflare.ts zone tunnel:ssh tunnel:prod tunnel:staging access` (simulation) et résume-moi en français ce qui va changer. N'ajoute --apply qu'après mon accord, et --replace-dns seulement si je l'accepte pour les enregistrements précis que tu m'as montrés. N'affiche jamais un jeton. Inscris les tags AUD rendus par le script : celui d'admin.joutiya.ma dans environments.prod.cloudflare.accessAud, celui d'admin-staging.joutiya.ma dans environments.staging.cloudflare.accessAud. Relance assert-target, puis pousse la branche et ouvre une PR « Record phase 1 identifiers ».
```

**G. Fichiers et secrets de la VM** (étape 6)

```text
Configure la VM de Joutiya (docs/phase-1.md, étape 6). Ne lis ni n'affiche aucune valeur secrète. Fais passer les secrets par des fichiers ou des tubes, jamais par la ligne de commande. 1) `ssh joutiya 'sudo tail -n 5 /var/log/joutiya-bootstrap.log'` doit finir par « bootstrap: done ». Sinon, montre-moi l'erreur et arrête-toi. 2) Lance node scripts/deploy-prod.ts vm-sync et confirme. 3) Pour staging puis prod, écris sur la VM des fichiers root 0600, en envoyant leur contenu sur l'entrée standard de `ssh joutiya "sudo sh -c 'umask 077 && cat > <fichier>'"` (jamais sudo tee, qui le renvoie à l'écran) :
- /etc/joutiya/<env>/valkey-queue.env et valkey-ratelimit.env : VALKEY_PASSWORD, générés sur la VM avec openssl rand -hex 32.
- /etc/joutiya/<env>/tunnel.env : TUNNEL_TOKEN = JOUTIYA_STAGING_TUNNEL_TOKEN ou JOUTIYA_PROD_TUNNEL_TOKEN de mon .env.local.
- /etc/joutiya/<env>/app.env avec :
  - NEXT_PUBLIC_SITE_URL : https://staging.joutiya.ma ou https://joutiya.ma ;
  - ADMIN_HOST : admin-staging.joutiya.ma ou admin.joutiya.ma ;
  - QUEUE_REDIS_URL=redis://:<mot de passe>@valkey-queue:6379 et RATE_LIMIT_REDIS_URL=redis://:<mot de passe>@valkey-ratelimit:6379 ;
  - TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID de .env.local ;
  - HASH_PEPPER généré pour chaque environnement (openssl rand -hex 32) ;
  - ALERT_RELAY_SECRET généré une seule fois (openssl rand -hex 32) et identique dans les deux environnements : le Worker de sonde n'en a qu'un ;
  - ALERT_RELAY_URL vide jusqu'au prompt J (l'application ne démarre pas sans, et elle ne démarre qu'à l'étape 10) ;
  - NEXT_PUBLIC_FIREBASE_PROJECT_ID depuis infra/targets.json ;
  - CF_ACCESS_TEAM_DOMAIN depuis infra/targets.json, et CF_ACCESS_AUD avec le tag AUD de l'environnement ;
  - LOG_LEVEL=info ;
  - pour le staging seulement, CSP_REPORT_ONLY=true : la CSP y est d'abord en mode rapport (§6), les violations arrivent dans les journaux sans rien bloquer.
- Pour la prod seulement, /etc/joutiya/prod/deploy.env : CF_ZONE_ID depuis infra/targets.json, CF_PURGE_TOKEN = JOUTIYA_CF_PURGE_TOKEN.
4) Donne-moi la ligne à mettre dans la variable GitHub VM_SSH_KNOWN_HOSTS : « ssh.joutiya.ma » suivi du contenu de /etc/ssh/ssh_host_ed25519_key.pub sans le commentaire final.
```

**H. Accès Google de la VM** (étape 7)

```text
Mets en place la fédération d'identité X.509 de Joutiya (architecture §9 ; docs/phase-1.md, étape 7). Je me connecte moi-même avec `gcloud auth login`. Ne touche qu'aux projets de environments.staging et environments.prod dans infra/targets.json. Ne crée aucune clé JSON de compte de service et n'active aucune facturation. 1) Sur ma machine, dans ~/.joutiya-ca (droits 0700) : une autorité de certification ECDSA P-256 valable 5 ans (CA:TRUE, keyCertSign). Sa clé privée est chiffrée par une phrase de passe que je tape. 2) Pour chaque projet : active les API iam, iamcredentials, sts et cloudresourcemanager. Si l'activation exige la facturation, arrête-toi et dis-le-moi. Crée les comptes de service joutiya-web (roles/datastore.user et roles/firebaseauth.admin ; roles/iam.serviceAccountTokenCreator sur lui-même) et joutiya-worker (roles/datastore.user et roles/firebaseauth.admin). Crée le pool joutiya-vm et un fournisseur X.509 x509 avec gcloud iam workload-identity-pools providers create-x509 : magasin de confiance = mon autorité, attribute-mapping google.subject=assertion.subject.dn.cn. 3) Pour chaque environnement et chaque conteneur (web, worker) : une clé ECDSA P-256 et un certificat feuille de 365 jours (CN joutiya-<env>-<conteneur>, CA:FALSE, keyUsage digitalSignature). Donne au principal principal://iam.googleapis.com/projects/<numéro>/locations/global/workloadIdentityPools/joutiya-vm/subject/joutiya-<env>-<conteneur> le rôle roles/iam.workloadIdentityUser sur le compte de service du conteneur. Génère la config avec gcloud iam workload-identity-pools create-cred-config, avec --service-account=joutiya-<conteneur>@<projet>.iam.gserviceaccount.com (sans lui, l'application ne sait pas à quel projet appartient l'accès et refuse de démarrer), puis réécris les chemins des deux fichiers JSON pour qu'ils pointent vers /etc/joutiya/<env>/gcp/<conteneur>/ (cert.pem, key.pem, certificate_config.json, credentials.json). Copie ces 4 fichiers sur la VM par l'entrée standard de `ssh joutiya "sudo sh -c 'umask 077 && cat > <fichier>'"` (jamais sudo tee), puis relance node scripts/deploy-prod.ts vm-sync pour fixer les droits. Supprime les copies locales des clés feuilles. Ne touche jamais à la clé de l'autorité.
```

**I. Mentions légales** (étape 8)

```text
Prépare config/legal pour Joutiya (docs/phase-1.md, étape 8). Crée hors du dépôt un fichier legal.prod.json. Il ne contient que : host = l'entité Oracle que je te donne (nom, adresse, téléphone) ; dataHosts = les 3 entrées de DEFAULT_LEGAL dans src/config/legal.ts, la première complétée avec l'entité Google que je te donne. Lance `gcloud auth application-default login` (je valide), puis `node scripts/legal-config.ts prod legal.prod.json` et montre-moi le résultat. N'ajoute --apply qu'après mon accord. Fais de même pour staging avec le même fichier.
```

**J. Sonde et alertes** (étape 9)

```text
Déploie le Worker de sonde de Joutiya (workers/uptime-probe ; docs/phase-1.md, étape 9) avec npx wrangler@4.144.0, depuis le dossier workers/uptime-probe. Connecte-toi par `npx wrangler@4.144.0 login` (je valide) et vérifie avec whoami le compte où se trouve joutiya.ma. Crée le namespace KV joutiya-uptime-state et inscris son id dans wrangler.jsonc. Mets ensuite les secrets avec wrangler secret put, en les lisant depuis mon .env.local ou la VM, sans les afficher :
- TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID ;
- ALERT_EMAIL_TO = mon Gmail vérifié dans Email Routing ;
- ALERT_RELAY_SECRET = celui de /etc/joutiya/prod/app.env ;
- ACCESS_CLIENT_ID et ACCESS_CLIENT_SECRET = jeton joutiya-probe, que je te colle.
Déploie, puis inscris l'URL du Worker suivie de /alert dans ALERT_RELAY_URL des deux app.env de la VM. Envoie une alerte de test signée (voir src/lib/alert/relay.ts) et vérifie que je la reçois par e-mail. Pousse la modification de wrangler.jsonc dans une PR.
```

**K. Mise en production et contrôles** (étape 11)

```text
Mets Joutiya en production (docs/phase-1.md, étape 11). 1) Vérifie que le dernier « Deploy staging » de GitHub Actions est vert et que node scripts/deploy-prod.ts status montre la même version en staging. 2) Lance node scripts/deploy-prod.ts promote ; c'est moi qui tape la confirmation. 3) Contrôles :
- curl https://joutiya.ma/api/health doit répondre ok ;
- nmap -Pn -p- sur l'IP publique de joutiya-vm (console Oracle) ne doit trouver aucun port ouvert ;
- securityheaders.com sur https://joutiya.ma doit donner au moins A ;
- https://admin.joutiya.ma doit demander la connexion Access.
Donne-moi un résumé en français que je collerai dans le projet.
```
