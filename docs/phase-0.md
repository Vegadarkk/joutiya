# Phase 0 : ouvrir les comptes gratuits de Joutiya

Ce qui reste à faire de votre côté pour clore la phase 0 (architecture v3, §9 et §10). Tout est gratuit : Oracle, R2 et Zero Trust demandent une carte, sans rien débiter.

Dans ce guide, « Claude » désigne les sessions du projet claude.ai, qui agissent par API ou depuis votre navigateur quand vous l'autorisez ; « Cody » est votre Claude Code local, qui lit `.env.local`.

## Règles pour chaque compte

- **Comptes dédiés** (votre choix du 12 octobre) : chaque service reçoit un compte, un projet ou une organisation neuve, réservée à Joutiya. Ne modifiez ni ne supprimez rien d'existant.
- **Gardez votre identité actuelle** là où une même personne peut créer plusieurs ressources : Google (nouveaux projets Firebase), Meta (nouveau portefeuille depuis votre profil Facebook : un seul profil par personne), Stripe (nouveau compte sous votre connexion actuelle), Telegram (bot créé depuis votre compte), Cloudflare (zone et buckets dans votre compte actuel). Oracle n'admet qu'un compte gratuit par personne.
- **Resend, Brevo et console Claude** : inscrivez-vous avec votre Gmail. Si vous y avez déjà un compte à cette adresse, prenez un alias Gmail, `votre.adresse+joutiya@gmail.com` : Gmail le reçoit sans réglage. N'utilisez pas `contact@joutiya.ma` pour vous connecter : elle est publique et dépend du domaine.
- Si un service refuse (quota atteint, compte unique déjà pris, alias refusé), ne réutilisez rien : prévenez Claude dans le projet, il vous proposera une solution.
- Activez la double authentification partout.
- **Adresse** : quand un service demande l'adresse de l'entreprise, donnez uniquement la domiciliation, 6 rue d'Armaillé, 75017 Paris.
- **Identifiants** (identifiant de projet ou de compte, nom de bucket) : notez-les au fil des étapes, ils vont dans `infra/targets.json` à l'étape 12. Ce ne sont pas des secrets.
- **Clés secrètes** : créez-les seulement à la phase qui s'en sert. Elles ont deux maisons : le fichier local `.env.local`, sous le nom prévu par `.env.example`, pour les clés du site et du déploiement (lues par Cody) ; votre environnement cloud Claude, partagé avec vos autres projets, pour les accès propres à Claude (`HOSTINGER_MAIL_API_TOKEN`, `JOUTIYA_OCI_*`). Jamais dans le dépôt ni dans le chat.
- Si vous avez un `.env` dans le dossier du dépôt, renommez-le en `.env.local` et alignez-le sur le nouveau `.env.example` : des noms ont changé (par exemple `CF_ACCOUNT_ID`). N'y gardez que des clés propres à Joutiya ; une clé qui ouvre tout un compte (Global API Key Cloudflare, clé d'un autre projet Google) n'a rien à y faire. Les jetons Hostinger se règlent à l'étape 2 (points 4 et 6).

**Ordre conseillé.** L'étape 0 d'abord. Les étapes 1 à 6 et la partie Resend de l'étape 7 bloquent la phase 1 (ses alertes e-mail partent par Resend) : faites-les ensuite. Les étapes 8 à 11 servent aux phases 2 à 7. L'étape 12 clôt la phase 0.

## 0. D'abord : le domaine `joutiya.ma` est-il validé ?

Le registre .MA valide chaque domaine sur pièces, envoyées dans les 14 jours suivant l'achat : pour `joutiya.ma`, acheté le 5 octobre 2026, **avant le 19 octobre 2026**. L'examen prend 2 à 4 semaines. Sans pièces, le domaine est suspendu, puis peut être supprimé, sans remboursement ([aide Hostinger](https://www.hostinger.com/support/requirements-to-register-a-ma-domain/)). « Actif » dans hPanel ne prouve pas la validation.
1. Envoyez au support Hostinger, par leur formulaire de vérification : votre passeport, une courte description de l'usage du site, et un contact administratif. Ce contact doit être une personne physique résidant au Maroc selon Hostinger, de nationalité marocaine selon d'autres registraires : faites-leur préciser.
2. Le nom du titulaire dans hPanel doit être exactement celui de la pièce : le corriger plus tard impose un transfert payant.
3. Demandez au support une confirmation écrite de la validation, puis prévenez Claude. Les étapes 1 et 2 peuvent avancer en attendant ; si hPanel refuse le changement de nameservers, prévenez Claude.

## 1. Cloudflare : la zone `joutiya.ma`

Cloudflare supprime une zone restée en attente 28 jours : changez les nameservers (point 5) dans la foulée.
1. Dans votre compte Cloudflare existant : **Add a domain** → `joutiya.ma` → offre **Free**.
2. Cloudflare importe les enregistrements DNS actuels. Supprimez ceux de la page d'attente Hostinger : le site arrive en phase 1. Gardez ceux du courrier (MX, SPF, DKIM, `autodiscover`, `autoconfig`) : l'étape 2 les règle.
3. Notez les 2 nameservers donnés par Cloudflare.
4. Si DNSSEC est actif sur le domaine chez Hostinger, désactivez-le d'abord, puis attendez 24 h.
5. hPanel : **Domaines** → **Portefeuille de domaines** → **Gérer** (`joutiya.ma`) → **DNS / Nameservers** (ou « Serveurs de noms ») → **Changer les nameservers** → saisissez les 2 nameservers Cloudflare → Enregistrer. Gardez chez Hostinger le verrou de transfert et le renouvellement automatique.
6. Attendez l'e-mail de Cloudflare annonçant que la zone est active (de quelques minutes à 24 h, parfois plusieurs jours pour un .MA).

À noter : **Account ID** et **Zone ID** (page d'accueil de la zone, colonne de droite).

## 2. Courrier @joutiya.ma : la boîte Hostinger (Z12, choix du 13 octobre)

Le courrier arrive dans les boîtes Hostinger de l'offre gratuite liée à votre hébergement : 1 Go par boîte, 100 e-mails reçus et 100 envoyés par jour, jusqu'au 24 janvier 2029. Cloudflare Email Routing n'est pas utilisé : un domaine n'a qu'une destination de courrier.

Une fois la zone active :
1. hPanel → **Emails** → `joutiya.ma` → **Paramètres du nom de domaine** : Hostinger affiche les enregistrements attendus. Dans Cloudflare (**DNS** → **Records**), vérifiez qu'ils y sont tous, en « DNS only » (nuage gris), puis relancez la vérification dans hPanel :
   - MX `@` : `mx1.hostinger.com` (priorité 5) et `mx2.hostinger.com` (priorité 10), sans autre MX ;
   - un seul SPF sur `@` : `v=spf1 include:_spf.mail.hostinger.com ~all` ;
   - DKIM : 3 CNAME, `hostingermail-a._domainkey` vers `hostingermail-a.dkim.mail.hostinger.com`, puis de même avec `b` et `c` ;
   - CNAME `autodiscover` vers `autodiscover.mail.hostinger.com` et `autoconfig` vers `autoconfig.mail.hostinger.com` ;
   - le TXT de vérification affiché par hPanel.
2. Ajoutez un DMARC : TXT `_dmarc`, valeur `v=DMARC1; p=none;`.
3. `contact@` existe déjà ; créez les boîtes `dsa@`, `abuse@` et `dpo@` : l'offre n'accepte qu'un alias par boîte, et les boîtes sont gratuites.
4. **Agentic Mail** → **Accès API** : révoquez l'ancien jeton (celui du fichier « Cody Joutiya API.txt »), puis supprimez ce fichier, corbeille comprise. Créez ensuite un jeton limité à ces 4 boîtes, avec les seules actions SMTP/IMAP (pas la gestion des webhooks). Rangez-le dans votre environnement cloud Claude sous `HOSTINGER_MAIL_API_TOKEN`, jamais dans le chat : Claude gère alors ces boîtes. Si Agentic Mail n'apparaît pas pour l'offre gratuite héritée, arrêtez-vous et prévenez Claude.
5. Testez en écrivant à `contact@joutiya.ma` depuis une autre adresse.
6. **Z11** : dans hPanel, révoquez aussi le jeton API Hostinger à tous droits (page des jetons API) : rien dans le projet n'en a besoin. Si vous préférez le garder, dites-le à Claude et pourquoi.

## 3. Cloudflare : R2 et Zero Trust

**R2**
1. **R2 Object Storage** → activez l'offre gratuite (carte demandée ; rien n'est débité sous 10 Go).
2. Créez 9 buckets en juridiction **European Union (EU)**, non modifiable ensuite : `joutiya-dev-quarantine`, `joutiya-dev-media`, `joutiya-dev-private`, puis les mêmes avec `staging` et `prod`. Cody peut le faire (prompt A).
3. Aucune clé R2 maintenant : elles arrivent en phase 3.

**Zero Trust**
1. **Zero Trust** → nom d'équipe `joutiya` (ou `joutiya-ma` s'il est pris) → offre **Free** (carte demandée, 0 €). Si Zero Trust est déjà activé sur ce compte, ne changez rien et prévenez Claude.
2. Rien d'autre : les applications Access arrivent en phase 1.

À noter : le domaine d'équipe `<équipe>.cloudflareaccess.com` et les noms exacts des 9 buckets.

## 4. Oracle Cloud (Z1)

Compte Always Free ouvert le 13 octobre 2026, région d'origine `eu-paris-1` (définitive : la VM gratuite ne peut être créée qu'à Paris). Oracle n'autorise qu'un compte gratuit par personne : n'en créez pas d'autre. Il reste :
1. Activez la double authentification du compte. Restez en offre gratuite : ne passez pas en **Pay As You Go**, même si Oracle le propose, sans en parler d'abord dans le projet.
2. Ne créez pas la VM vous-même : Claude la crée en phase 1 avec l'accès limité ci-dessous, **avant le 12 novembre 2026** (un compte gratuit inactif 30 jours peut être suspendu ; une VM gratuite inactive 7 jours peut être reprise).
3. Mentions légales (hébergeur) : gardez une copie du contrat accepté à l'inscription et relevez-y l'entité Oracle, son adresse et son téléphone (Oracle France ou Oracle America selon le contrat) : à donner à Claude pour `config/legal` (`scripts/legal-config.ts`), pas pour `infra/targets.json`.

À noter : la région `eu-paris-1`, l'OCID de la tenancy et celui du compartiment `joutiya` (accès limité, point 1).

**Accès limité pour Claude** (votre choix du 13 octobre)

Claude reçoit un utilisateur à lui, sans accès à la console, qui n'agit que dans un compartiment `joutiya` plafonné au niveau gratuit. Il ne peut pas passer le compte en payant : c'est réservé aux administrateurs. Votre accès administrateur reste à vous seul, et Claude ne crée rien sans votre accord. Tout se fait depuis le menu ☰ de la console Oracle, par vous ou par Claude dans votre navigateur :
1. **Identity & Security** → **Compartments** → ouvrez `joutiya` (créé le 13 octobre sous la racine ; ne le recréez pas) → copiez son OCID. Celui de la tenancy est dans le menu profil → **Tenancy**.
2. **Identity & Security** → **Domains** → `Default` → **User management** :
   - **Groups** → **Create group** : nom `joutiya-automation`, sans cocher « User can request access » → créez.
   - **Users** → **Create** : prénom `Joutiya`, nom `Claude`, décochez « Use the email address as the username », identifiant `joutiya-claude`, e-mail `votre.adresse+joutiya@gmail.com`, cochez le groupe `joutiya-automation` → créez. Ignorez l'e-mail d'activation s'il arrive.
   - Ouvrez `joutiya-claude` → **Edit user capabilities** : ne laissez cochée que **API keys** (décochez notamment *Local password*, ce qui ferme la console à cet utilisateur) → **Save changes**.
3. **Identity & Security** → **Policies** → *List scope* : la racine → **Create Policy** : nom `joutiya-automation-policy`, compartiment : la racine → **Show manual editor** → collez ces 4 lignes, puis validez :
   ```text
   Allow group joutiya-automation to manage instance-family in compartment joutiya
   Allow group joutiya-automation to manage virtual-network-family in compartment joutiya
   Allow group joutiya-automation to manage volume-family in compartment joutiya
   Allow group joutiya-automation to inspect compartments in tenancy
   ```
   La dernière ligne ne donne que les noms des compartiments, utiles pour lister les zones de disponibilité. Placée à la racine, cette règle n'est modifiable que par vous. Oracle peut réécrire le groupe en `'Default'/'joutiya-automation'` : c'est équivalent.
4. **Governance & Administration** → **Tenancy Management** → **Quota policies** → **Create quota** : nom `joutiya-free-tier`, compartiment : la racine, puis collez ces lignes dans cet ordre (les lignes `zero` d'abord) et créez :
   ```text
   zero compute-core quotas in compartment joutiya
   set compute-core quota standard-a1-core-count to 2 in compartment joutiya
   zero compute-memory quotas in compartment joutiya
   set compute-memory quota standard-a1-memory-count to 12 in compartment joutiya
   set block-storage quota total-storage-gb to 200 in compartment joutiya
   set block-storage quota backup-count to 0 in compartment joutiya
   set vcn quota reserved-public-ip-count to 0 in compartment joutiya
   ```
   Dans `joutiya`, il ne peut alors exister qu'une VM Ampere de 2 OCPU et 12 Go au plus, avec 200 Go de disque : le niveau gratuit. Comptez 10 minutes avant l'effet.
5. **Domains** → `Default` → **Users** → `joutiya-claude` → **API keys** → **Add API key** → **Generate API key pair** → **Download private key** → **Add**. La fenêtre *Configuration file preview* affiche `user`, `fingerprint`, `tenancy` et `region` : notez-les, ce ne sont pas des secrets. Seuls `tenancy` et l'OCID du compartiment vont dans `infra/targets.json` (étape 12) ; `user` et `fingerprint` ne vont que dans l'environnement cloud, point 6.
6. Rangez dans votre environnement cloud Claude (celui du projet, partagé avec vos autres projets), comme `HOSTINGER_MAIL_API_TOKEN`, et jamais dans le chat :
   - `JOUTIYA_OCI_USER`, `JOUTIYA_OCI_TENANCY`, `JOUTIYA_OCI_FINGERPRINT`, `JOUTIYA_OCI_REGION` (`eu-paris-1`) et `JOUTIYA_OCI_COMPARTMENT` (l'OCID du point 1) ;
   - `JOUTIYA_OCI_KEY_B64` : la clé privée téléchargée, encodée sur une ligne ; Cody la met dans votre presse-papiers sans l'afficher (prompt O). Collez-la, videz le presse-papiers (et son historique), puis supprimez le fichier `.pem` : en cas de perte, vous en générerez une autre.
7. Prévenez Claude dans le projet : une nouvelle session vérifie l'accès par une simple lecture, et `node scripts/assert-target.ts` compare `JOUTIYA_OCI_TENANCY`, `JOUTIYA_OCI_COMPARTMENT` et `JOUTIYA_OCI_REGION` à `infra/targets.json`.

## 5. Firebase : 3 projets Spark (Z2)

Cody peut faire les points 1 à 3 (prompt B), une fois que vous avez lancé vous-même `npx firebase-tools login` dans un terminal : cette connexion demande un terminal interactif.
1. console.firebase.google.com → **Créer un projet** `joutiya-dev` → si l'identifiant proposé porte un suffixe, notez-le tel quel → **désactivez Google Analytics** → Créer.
2. Recommencez pour `joutiya-staging` et `joutiya-prod`.
3. Dans chaque projet : **Firestore Database** → **Créer une base de données** → édition **Standard** → emplacement **europe-west9 (Paris)** → mode production. **Irréversible** : la région ne change plus. Si Paris est refusé, arrêtez-vous et prévenez Claude avant de prendre `europe-west1`.
4. Restez sur l'offre **Spark** : ne passez jamais à Blaze, et ne cliquez pas « Upgrade » vers Identity Platform dans Authentication (sur Spark, cela plafonne à 3 000 utilisateurs actifs par jour). Authentication s'active en phase 2.

Un identifiant de projet est définitif et jamais réutilisable, même après suppression. Le quota de projets d'un compte Google sans facturation est faible et varie selon le compte (projets Google Cloud compris) : si la création est refusée, demandez une hausse de quota (gratuite) plutôt que de supprimer un projet existant.

À noter : les 3 identifiants de projet, le numéro de chaque projet (**Paramètres du projet**, ou `npx firebase-tools projects:list`) et la région de chaque base.

## 6. Bot Telegram (alertes)

1. Telegram → **@BotFather** → `/newbot` → nom « Joutiya Alertes » → identifiant finissant par `bot`, par exemple `joutiya_alertes_bot`.
2. Copiez le jeton dans `.env.local` : `TELEGRAM_BOT_TOKEN=…`
3. Ouvrez votre bot, envoyez-lui `/start`, puis lancez le prompt C dans les 24 h : Telegram ne garde les messages que 24 h.
4. Cody récupère votre identifiant de conversation (prompt C) ; ajoutez-le dans `.env.local` : `TELEGRAM_CHAT_ID=…`

## 7. E-mail : Resend et Brevo (après l'étape 1)

**Resend** (e-mails du site)
1. resend.com → inscription avec votre Gmail, offre Free, sans carte.
2. **Domains** → **Add domain** → `notif.joutiya.ma`, région **eu-west-1 (Irlande)**. **Irréversible** : changer de région impose de recréer le domaine.
3. Ajoutez dans Cloudflare les enregistrements affichés, en « DNS only » (nuage gris), puis **Verify**.
4. Ajoutez un enregistrement DMARC pour ce sous-domaine : type TXT, nom `_dmarc.notif`, valeur `v=DMARC1; p=none;`. Un seul : si Resend ou Brevo en propose un autre, gardez un unique enregistrement `_dmarc.notif`.
5. Pas de clé API maintenant : elles arrivent avec les alertes de la phase 1, puis en phase 2.

**Brevo** (secours, pour les seuls e-mails de sécurité)
1. brevo.com → inscription, offre Free, sans carte.
2. Authentifiez le domaine `notif.joutiya.ma` avec les enregistrements affichés (dans Cloudflare, « DNS only »).
3. Pas de clé API avant la phase 2.

## 8. Claude Console : organisation « Joutiya » (Z4)

1. console.anthropic.com → connexion avec votre Gmail → créez l'organisation **Joutiya**. Si votre Gmail a déjà une organisation et que le sélecteur d'organisation ne permet pas d'en créer une autre, prenez l'alias `+joutiya` (voir les règles). Cette organisation sert au site seulement : Cody n'utilise aucune de ses clés, sinon il consomme les 5 $.
2. **Settings** → **Workspaces** : créez `joutiya-prod` et `joutiya-staging`.
3. **Billing** → **Spend limits** → **Set limit** : limite mensuelle de l'organisation à **5 $** ; puis **Workspaces** → `joutiya-staging` → **Limits** → **Change limit**, plus basse. Si la page ne le propose pas encore, faites-le à l'achat des crédits.
4. N'achetez pas de crédits maintenant : l'IA arrive en phase 5 et les crédits expirent au bout d'un an. À l'achat, laissez la recharge automatique désactivée.

À noter : l'**Organization ID** (Settings → Organization).

## 9. WhatsApp de Meta (Z3)

Prérequis : une carte SIM prépayée marocaine, jamais inscrite sur WhatsApp, qui peut recevoir un SMS ou un appel au moment de l'ajout. Ce numéro ne pourra plus servir dans l'application WhatsApp.
1. business.facebook.com → créez le portefeuille business **Joutiya**.
2. developers.facebook.com → **Créer une app** → cas d'usage « Connect with customers through WhatsApp » → nom **Joutiya**, rattachée au portefeuille Joutiya. Meta fournit un numéro de test : il servira en dev et en staging.
3. WhatsApp → **API Setup** → **Add phone number** → nom affiché « Joutiya » → validez par SMS ou appel. Le nom affiché passe en revue chez Meta. L'enregistrement final du numéro (code PIN à 6 chiffres) et la mise en ligne de l'app se font en phase 2.
4. N'ajoutez pas de moyen de paiement : Joutiya ne fait que recevoir.
5. Pas de jeton ni de secret d'app maintenant : ils arrivent en phase 2.

À noter : Business ID, App ID, puis le **WhatsApp Business Account ID** et le **Phone number ID** du numéro de test (dev et staging, mêmes valeurs) et du vrai numéro (prod : le garde-fou exige qu'il diffère).

## 10. Stripe : nouveau compte « Joutiya » (Z7)

1. dashboard.stripe.com → sélecteur de compte (en haut à gauche) → **Nouveau compte** → nom **Joutiya**, pays France.
2. Ne l'activez pas : il sert en mode test jusqu'à la phase 7.

À noter : l'identifiant du compte, au format `acct_…`.

## 11. Démarches administratives (gratuites)

- Guichet unique (formalites.entreprises.gouv.fr) → modification de l'entreprise → ajoutez l'activité de plateforme de petites annonces en ligne et de régie publicitaire, avant tout revenu, AdSense compris.
- Vérifiez au registre (RNE) que l'adresse est la domiciliation du 6 rue d'Armaillé, 75017 Paris ; sinon, déclarez le transfert. Relevez le nom exact inscrit au registre (le mémento fiscal indique « DARKAOUI ADIL ») : à donner à Claude pour `config/legal`, pas pour `infra/targets.json`.

## 12. Consigner les identifiants

Donnez les identifiants notés, y compris ceux rendus par les prompts A et B, à Cody (prompt D), ou collez-les dans le fil du projet. Le prompt D peut être lancé deux fois : après les étapes 1 à 6, pour débloquer la phase 1, puis à la fin. RevenueCat reste vide jusqu'à la phase 7 ; les identifiants de Tunnel et les audiences Access (`sshTunnelId`, `tunnelId`, `accessAud`) sont remplis par Cody en phase 1.

**Fin de la phase 0 :** jeton Hostinger à tous droits révoqué (Z11) ou décision motivée, `infra/targets.json` rempli, `node scripts/assert-target.ts` au vert, aucune clé dans le dépôt.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour (`git pull`). Node 24 ou plus récent est nécessaire (`node --version`).

**A. Buckets R2** (après l'activation de R2, étape 3)

```text
Crée les buckets R2 de Joutiya avec Wrangler. Travaille depuis un dossier temporaire vide, hors du dépôt, pour que Wrangler ne lise aucun fichier .env. Lance `npx wrangler login` (je valide dans le navigateur), puis `npx wrangler whoami` : vérifie qu'il annonce une connexion OAuth, et non un jeton d'API ou une clé, sur le compte où la zone joutiya.ma a été ajoutée, et donne-moi son Account ID. Si whoami annonce un API Token (un CLOUDFLARE_API_TOKEN d'un autre projet est défini dans le shell), arrête-toi et dis-le-moi. Si Wrangler demande de choisir un compte, préfixe chaque commande par CLOUDFLARE_ACCOUNT_ID=<cet Account ID>. Crée ensuite en juridiction UE, avec `npx wrangler r2 bucket create <nom> --jurisdiction eu`, les 9 buckets joutiya-dev-quarantine, joutiya-dev-media, joutiya-dev-private, joutiya-staging-quarantine, joutiya-staging-media, joutiya-staging-private, joutiya-prod-quarantine, joutiya-prod-media et joutiya-prod-private. Ne modifie et ne supprime aucune ressource existante ; si un nom est refusé, arrête-toi et dis-le-moi. Vérifie la liste des buckets UE, donne-moi l'Account ID et les noms exacts sans rien écrire dans le dépôt, puis lance `npx wrangler logout`.
```

**B. Projets Firebase** (étape 5)

```text
Crée les 3 projets Firebase de Joutiya avec firebase-tools. Je me suis connecté moi-même avec `npx firebase-tools login`. Travaille depuis un dossier temporaire vide, hors du dépôt. Crée joutiya-dev, joutiya-staging et joutiya-prod avec `npx firebase-tools projects:create <id> --display-name "Joutiya <env>"` ; si un identifiant est pris, ajoute un suffixe de 4 chiffres et dis-le-moi. Ne touche à aucun autre projet et n'active aucune facturation (offre Spark). Pour chaque projet, crée la base Firestore avec `npx firebase-tools firestore:databases:create "(default)" --location europe-west9 --edition standard --project <id>`, en ajoutant `--delete-protection ENABLED` pour la prod ; si europe-west9 est refusé, arrête-toi et demande-moi. Donne-moi les identifiants exacts, le numéro de chaque projet (`npx firebase-tools projects:list`) et la région de chaque base sans rien écrire dans le dépôt, puis lance `npx firebase-tools logout`.
```

**C. Identifiant de conversation Telegram** (étape 6)

```text
J'ai mis TELEGRAM_BOT_TOKEN dans .env.local et envoyé /start à mon bot. Vérifie d'abord que TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID ne sont pas déjà définis dans le shell (une variable du shell l'emporte sur .env.local) ; si c'est le cas, arrête-toi et dis-le-moi. Appelle la méthode getUpdates de l'API Telegram en lisant le jeton depuis .env.local (par exemple avec `node --env-file=.env.local`), sans jamais afficher le jeton, et donne-moi seulement le chat id. Envoie ensuite le message « Joutiya : alertes OK » à ce chat avec sendMessage.
```

**O. Clé Oracle de Claude** (étape 4, accès limité, point 6)

```text
La clé privée de l'utilisateur Oracle joutiya-claude est dans <chemin du fichier .pem téléchargé>. Encode-la en base64 sur une seule ligne, sans retour à la ligne, et copie le résultat dans mon presse-papiers avec l'outil de mon système. Ne l'affiche jamais et ne l'écris dans aucun fichier ni dans le dépôt. Vérifie seulement que le contenu copié, une fois décodé, commence par « -----BEGIN », et dis-moi si c'est le cas. Ne fais rien d'autre.
```

**D. Consigner les identifiants** (étape 12)

```text
Depuis main à jour, inscris dans infra/targets.json les identifiants ci-dessous (ce ne sont pas des secrets ; laisse null ce qui manque, y compris les OCID Oracle et les numéros de projet Firebase si je ne les donne pas). Lance `node scripts/assert-target.ts` et `node --test scripts/assert-target.test.ts` jusqu'au vert, puis pousse une branche phase-0-targets et ouvre une PR vers main intitulée « Record phase 0 identifiers ». Aucune clé ni aucun secret dans le commit.
<collez ici les identifiants notés>
```
