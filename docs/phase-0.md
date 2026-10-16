# Phase 0 : ouvrir les comptes gratuits de Joutiya

Ce qui reste à faire pour clore la phase 0 (architecture v3, §9 et §10). Tout est gratuit : Oracle, R2 et Zero Trust demandent une carte, sans rien débiter. L'état au jour le jour est dans le fichier du projet `joutiya/phase-0/suivi-phase-0.md`, tenu par le fil « Phase 0 du MVP ».

## Qui fait quoi (règle n°1, votre consigne du 15 octobre)

- **Claude** (les sessions du projet claude.ai) agit par API. Pour chaque service qui en a une, il reçoit un jeton dédié, à la portée la plus petite possible, rangé dans votre environnement cloud Claude sous un nom commençant par `JOUTIYA_`.
- **Nav** (Claude dans votre navigateur, sur PC2, fil « Consoles via ton navigateur ») fait tout ce qui n'a pas d'API : ouverture des comptes, réglages dans les consoles, préparation de chaque jeton jusqu'à l'écran qui le crée. Le coordinateur lui envoie les étapes de ce guide dans l'ordre de la file ci-dessous. Nav ne voit, ne tape et ne photographie jamais la valeur d'un secret.
- **Vous** : mots de passe, codes de double authentification, CAPTCHA, cartes bancaires, pièces d'identité, et le clic qui révèle un secret, suivi de son rangement ; plus une autorisation écrite dans le fil de Nav avant qu'il crée quoi que ce soit (sa session l'exige ; une phrase de vous couvre toute la file : donnée le 15 octobre pour la politique Oracle, le jeton `joutiya-edge` et les étapes N1 à N10). Ces moments sont signalés par **Vous :** dans ce guide ; rien d'autre ne vous est demandé.
- **Cody** (votre Claude Code local, PC1) : le bot Telegram (prompt C) et, si vous le souhaitez, l'encodage de la clé Oracle (prompt O).

## Règles pour chaque compte

- **Comptes dédiés** (votre choix du 12 octobre) : chaque service reçoit un compte, un projet ou une organisation neuve, réservée à Joutiya. Rien d'existant n'est modifié ni supprimé.
- **Votre identité actuelle** là où une même personne peut créer plusieurs ressources : Google (nouveaux projets Firebase), Meta (nouveau portefeuille depuis votre profil Facebook : un seul profil par personne), Stripe (nouveau compte sous votre connexion), Telegram (bot créé depuis votre compte), Cloudflare (zone et buckets dans votre compte actuel). Oracle n'admet qu'un compte gratuit par personne.
- **Resend, Brevo et Console Claude** : inscription avec votre Gmail. Si cette adresse y a déjà un compte, prenez l'alias `votre.adresse+joutiya@gmail.com` : Gmail le reçoit sans réglage. `contact@joutiya.ma` ne sert jamais d'identifiant : elle est publique et dépend du domaine.
- Si un service refuse (quota atteint, compte unique déjà pris, alias refusé), Nav s'arrête et le rapporte ; Claude propose une solution dans le projet.
- Double authentification partout : elle reste à vous.
- **Adresse** : quand un service demande l'adresse de l'entreprise, uniquement la domiciliation, 6 rue d'Armaillé, 75017 Paris.
- **Identifiants** (identifiant de projet ou de compte, nom de bucket, OCID) : Nav les rapporte, Claude les consigne dans `infra/targets.json` par une PR (étape 12). Ce ne sont pas des secrets.
- **Clés secrètes** : créées seulement à la phase qui s'en sert. Deux maisons : votre fichier local `.env.local`, sous le nom prévu par `.env.example`, pour les clés du site et du déploiement (lues par Cody) ; votre environnement cloud Claude pour les accès propres à Claude. Cet environnement est partagé avec vos autres projets : d'où le préfixe `JOUTIYA_`, qui évite d'écraser la variable d'un autre projet, et l'interdiction pour une session Joutiya d'utiliser une clé sans ce préfixe. Une variable ajoutée n'est visible que des sessions démarrées ensuite : après chaque rangement, prévenez Claude, un nouveau fil vérifie l'accès par une simple lecture. L'éditeur de l'environnement prend une ligne `NOM=valeur` par variable : un secret sur plusieurs lignes (une clé privée) y passe encodé en base64 sur une ligne. Jamais de clé dans le dépôt ni dans le chat.
- Si vous avez un `.env` dans le dossier du dépôt, renommez-le en `.env.local` et alignez-le sur `.env.example` : des noms ont changé (par exemple `CF_ACCOUNT_ID`). N'y gardez que des clés propres à Joutiya ; une clé qui ouvre tout un compte (Global API Key Cloudflare, clé d'un autre projet Google) n'a rien à y faire.
- **Réseau de Claude** : la politique réseau de votre environnement cloud doit laisser passer les hôtes des API. Vérifié le 15 octobre depuis l'environnement actuel : `*.oraclecloud.com`, `api.cloudflare.com`, `api.resend.com`, `api.brevo.com`, `api.hostinger.com`, `api.stripe.com`, `graph.facebook.com`, `sentry.io`, `de.sentry.io`, `api.telegram.org` et `*.googleapis.com` passent tous, rien à ajouter. Si un fil signale un jour un hôte bloqué, ajoutez-le dans les réglages de l'environnement (domaines autorisés) : ce réglage est à vous seul, et seules les sessions démarrées ensuite en profitent.

**Ordre.** File de Nav au 15 octobre : accès limité Oracle (étape 4), pièces .MA (0), zone Cloudflare et jeton `joutiya-edge` (1), puis N1 Firebase (5), N2 Zero Trust (3), N3 boîtes (2), N4 jeton mail (2), N5 Resend (7), N6 Brevo (7), N7 buckets R2 (3), N8 Meta (9), N9 Console Claude (8), N10 Stripe (10). Les étapes 0 à 7 bloquent la phase 1 (ses alertes partent par Resend et Telegram) ; les étapes 8 à 10 servent aux phases 2 à 7 ; l'étape 11 attend l'avant-lancement ; l'étape 12 suit au fil de l'eau.

## 0. Le domaine `joutiya.ma` (fil « Documents du domaine .MA »)

Le registre .MA valide chaque domaine sur pièces, envoyées dans les 14 jours suivant l'achat : pour `joutiya.ma`, acheté le 5 octobre 2026, au plus tard le **19 octobre 2026** selon cette règle (échéance en cours de confirmation auprès de Hostinger). L'examen prend 2 à 4 semaines. Sans pièces, le domaine est suspendu, puis peut être supprimé, sans remboursement ([aide Hostinger](https://www.hostinger.com/support/requirements-to-register-a-ma-domain/)). « Actif » dans hPanel ne prouve pas la validation.
1. Nav remplit le formulaire officiel de vérification .MA de Hostinger (description de l'usage du site comprise), puis suit le dossier avec le Customer Success par le chat de hPanel ; chaque réponse exacte est rapportée au fil.
2. **Vous :** les pièces que le registre demande selon l'inscription du titulaire (passeport pour une personne, certificat d'immatriculation pour une organisation : Hostinger a inscrit le titulaire comme organisation « Adark Prime », le fil .MA vous dit laquelle fournir), et le contact administratif, personne physique résidant au Maroc, de nationalité marocaine selon certains registraires (nom, adresse, téléphone). Le nom du titulaire doit correspondre à la pièce : le corriger plus tard impose un transfert payant. Pas de protection WHOIS sur un .MA.
3. Validation confirmée par écrit : Nav change alors les nameservers vers Cloudflare (étape 1, point 4). Les étapes 1 à 7 avancent en attendant.

## 1. Cloudflare : la zone `joutiya.ma` (fil « Ajouter joutiya.ma à Cloudflare »)

1. Nav, dans votre compte Cloudflare : **Add a domain** → `joutiya.ma` → offre **Free**. Cloudflare importe les enregistrements actuels : ceux de la page d'attente Hostinger sont retirés (le site arrive en phase 1), ceux du courrier (MX, SPF, DKIM, `autodiscover`, `autoconfig`) gardés en « DNS only » (nuage gris). Nav rapporte les 2 nameservers, l'**Account ID** et le **Zone ID**.
2. Nav prépare le jeton API personnalisé `joutiya-edge` (permissions de `docs/phase-1.md`, étape 3 : compte → Tunnel et Access ; zone `joutiya.ma` seulement → zone, réglages, WAF, règles, DNS ; durée 30 jours) jusqu'à l'écran de résumé. Un jeton limité à une zone ne peut pas la créer : c'est pourquoi Nav ajoute la zone lui-même.
3. **Vous :** cliquez **Create Token**, rangez la valeur sous `JOUTIYA_CLOUDFLARE_API_TOKEN` dans l'environnement cloud, puis prévenez Claude : un nouveau fil vérifie le jeton, règle la zone (`scripts/cloudflare.ts`) et consigne `accountId` et `zoneId`.
4. Nameservers : après la validation .MA (étape 0), Nav les change dans hPanel (**Domaines** → **Portefeuille de domaines** → **Gérer** → **DNS / Nameservers**), DNSSEC désactivé 24 h avant s'il est actif, verrou de transfert et renouvellement automatique gardés. Cloudflare supprime une zone restée en attente 28 jours : si la validation .MA tarde, Nav ajoute la zone de nouveau.

## 2. Courrier @joutiya.ma : les boîtes Hostinger (Z12, choix du 13 octobre)

Le courrier arrive dans les boîtes Hostinger de l'offre gratuite liée à votre hébergement : 1 Go par boîte, 100 e-mails reçus et 100 envoyés par jour, jusqu'au 24 janvier 2029. Cloudflare Email Routing n'est pas utilisé : un domaine n'a qu'une destination de courrier.
1. Claude (jeton `joutiya-edge`) vérifie dans la zone les enregistrements attendus par Hostinger, en « DNS only » : MX `@` vers `mx1.hostinger.com` (priorité 5) et `mx2.hostinger.com` (10), sans autre MX ; un seul SPF, `v=spf1 include:_spf.mail.hostinger.com ~all` ; les 3 CNAME DKIM `hostingermail-a`, `-b`, `-c` `._domainkey` ; `autodiscover` et `autoconfig` ; le TXT de vérification ; et il ajoute le DMARC, TXT `_dmarc` = `v=DMARC1; p=none;`. Nav relance ensuite la vérification dans hPanel (**Emails** → `joutiya.ma` → **Paramètres du nom de domaine**).
2. Nav (N3) crée les boîtes `dsa@`, `abuse@` et `dpo@` (`contact@` existe ; un alias par boîte au plus, boîtes gratuites). **Vous :** leurs mots de passe, tapés par vous et gardés dans votre gestionnaire.
3. Nav (N4) prépare dans **Agentic Mail** → **Accès API** un jeton `joutiya-claude-mail` (l'interface impose les deux permissions, actions SMTP/IMAP et webhooks). Le jeton créé le 15 octobre couvre toutes les boîtes de `joutiya.ma`, actuelles et futures (hPanel ne modifie pas un jeton, il ne sait que le supprimer) ; il est conservé tel quel, toutes les boîtes du domaine étant celles de Joutiya. **Vous :** le clic qui le crée, rangement sous `JOUTIYA_HOSTINGER_MAIL_API_TOKEN`, puis prévenez Claude : un nouveau fil lit `contact@` pour vérifier. Nav a vérifié le 15 octobre que la section Agentic Mail (« Boîte mail IA », bêta) est bien présente pour cette offre, sans paiement demandé.
4. Pas de jeton API Hostinger complet pour Claude (carte du 15 octobre, recommandation « Nav seulement », appliquée sauf avis contraire de votre part) : ces jetons n'ont aucune portée (facturation, moyens de paiement, codes de transfert du domaine). Les quelques actions hPanel restantes sont faites par Nav.
5. **Z11, à la fin seulement** : quand tout fonctionne, Nav révoque dans hPanel l'ancien jeton mail en clair et le jeton API à tous droits ; **Vous :** supprimez le fichier « Cody Joutiya API.txt », corbeille comprise. Rien n'est révoqué avant.

## 3. Cloudflare : R2 et Zero Trust

- **R2** est activé sur votre compte : les 10 Go gratuits sont partagés avec `punkrecords.fr`, qui en occupe déjà 4,14 Go (relevé de Nav du 15 octobre), soit environ 5,8 Go pour Joutiya ; le garde-fou R2 de la phase 3 lira l'usage du compte entier, pas seulement celui de Joutiya. Nav (N7) crée 9 buckets en juridiction **European Union (EU)**, non modifiable ensuite : `joutiya-dev-quarantine`, `joutiya-dev-media`, `joutiya-dev-private`, puis les mêmes avec `staging` et `prod`. Pourquoi Nav : la permission qui crée des buckets couvre tous les buckets du compte, un jeton ne peut pas être limité à des noms. Les clés S3 du site (phase 3) seront limitées aux buckets Joutiya. Nav rapporte les noms exacts.
- **Zero Trust** : Nav (N2) → nom d'équipe `joutiya` (ou `joutiya-ma` s'il est pris) → offre **Free**. **Vous :** la carte bancaire (0 €). Nav a vérifié le 15 octobre que Zero Trust n'est pas encore activé sur ce compte. Les applications Access arrivent en phase 1. Nav rapporte le domaine d'équipe `<équipe>.cloudflareaccess.com`.

## 4. Oracle Cloud (Z1)

Compte Always Free ouvert le 13 octobre 2026, région d'origine `eu-paris-1` (définitive : la VM gratuite ne se crée qu'à Paris), compartiment `joutiya` sous la racine. Un seul compte gratuit par personne. Restez en offre gratuite : jamais **Pay As You Go** sans en parler dans le projet. Claude crée la VM en phase 1, **avant le 12 novembre 2026** (un compte inactif 30 jours peut être suspendu ; une VM gratuite inactive 7 jours peut être reprise). **Vous :** la double authentification du compte, et une copie du contrat accepté à l'inscription (entité Oracle, adresse, téléphone : pour `config/legal`, via `scripts/legal-config.ts`).

**Accès limité de Claude** (votre choix du 13 octobre), créé par Nav le 15 octobre : groupe `joutiya-automation` ; utilisateur `joutiya-claude`, capacité **API keys** seulement (ni console ni mot de passe) ; quota `joutiya-free-tier` à la racine :
```text
zero compute-core quotas in compartment joutiya
set compute-core quota standard-a1-core-count to 2 in compartment joutiya
zero compute-memory quotas in compartment joutiya
set compute-memory quota standard-a1-memory-count to 12 in compartment joutiya
set block-storage quota total-storage-gb to 200 in compartment joutiya
set block-storage quota backup-count to 0 in compartment joutiya
set vcn quota reserved-public-ip-count to 0 in compartment joutiya
```
Dans `joutiya`, il ne peut exister qu'une VM Ampere de 2 OCPU et 12 Go au plus, avec 200 Go de disque : le niveau gratuit. Claude ne peut pas passer le compte en payant (réservé aux administrateurs) ; votre accès administrateur reste à vous seul.
1. Politique `joutiya-automation-policy` (à la racine, modifiable par vous seul), préparée par Nav :
   ```text
   Allow group joutiya-automation to manage instance-family in compartment joutiya
   Allow group joutiya-automation to manage virtual-network-family in compartment joutiya
   Allow group joutiya-automation to manage volume-family in compartment joutiya
   Allow group joutiya-automation to inspect compartments in tenancy
   ```
   **Vous :** la session de Nav exige votre accord écrit pour une attribution de droits : écrivez « oui » dans le fil « Consoles via ton navigateur ». Oracle peut réécrire le groupe en `'Default'/'joutiya-automation'` : c'est équivalent.
2. Clé API de `joutiya-claude` : Nav prépare **Add API key** → **Generate API key pair** ; **Vous :** **Download private key** puis **Add** (fait le 15 octobre). L'aperçu de configuration affiche `user`, `fingerprint`, `tenancy` et `region` : Nav les relève, ce ne sont pas des secrets.
3. Rangement dans l'environnement cloud, noms définitifs : `JOUTIYA_OCI_TENANCY`, `JOUTIYA_OCI_USER`, `JOUTIYA_OCI_COMPARTMENT`, `JOUTIYA_OCI_REGION` (`eu-paris-1`), `JOUTIYA_OCI_FINGERPRINT`, et `JOUTIYA_OCI_KEY_B64` pour la clé privée encodée en base64 sur une ligne (prompt O : Cody la met dans votre presse-papiers sans l'afficher ; collez, videz le presse-papiers et son historique, supprimez le fichier `.pem`). Fait le 15 octobre pour les 6 variables. `node scripts/assert-target.ts` compare `JOUTIYA_OCI_TENANCY`, `_USER`, `_COMPARTMENT` et `_REGION` à `infra/targets.json`, où ils sont consignés.
4. Vérification faite le 15 octobre par le fil « Accès Oracle par API » : format, empreinte et authentification corrects ; l'autorisation suivra la politique du point 1. Au plus 3 clés par utilisateur ; les suivantes peuvent être ajoutées par API.
5. **Rotation finale** (votre consigne du 15 octobre) : quand tout est en place, Nav prépare une nouvelle clé sur `joutiya-claude` ; **Vous :** Download + Add, puis la nouvelle valeur remplace `JOUTIYA_OCI_KEY_B64` (et `JOUTIYA_OCI_FINGERPRINT`) hors du chat ; Nav supprime ensuite l'ancienne clé dans la console, et un nouveau fil vérifie.

## 5. Firebase : 3 projets Spark (Z2)

Nav (N1), connecté à votre compte Google sur console.firebase.google.com :
1. **Créer un projet** `joutiya-dev` → si l'identifiant proposé porte un suffixe, il est gardé tel quel → **Google Analytics désactivé** → Créer. De même `joutiya-staging` et `joutiya-prod`.
2. Dans chaque projet : **Firestore Database** → **Créer une base de données** → édition **Standard** → emplacement **europe-west9 (Paris)** → mode production. **Irréversible** : la région ne change plus. Si Paris est refusé, Nav s'arrête et le rapporte avant toute autre région.
3. Rien d'autre : offre **Spark** toujours (jamais Blaze, jamais « Upgrade » vers Identity Platform, qui plafonne à 3 000 utilisateurs actifs par jour sur Spark). Authentication s'active en phase 2 : son client OAuth Google n'existe que dans la console, Nav le fera alors.
4. **Vous :** le mot de passe Google ou un code si demandé.

Pourquoi Nav : un compte de service ne peut pas créer de projet hors d'une organisation Google. Un identifiant de projet est définitif et jamais réutilisable, même supprimé (la suppression compte encore 30 jours dans le quota). Le quota de projets d'un compte sans facturation est d'environ 5 à 10 : en cas de refus, demander une hausse gratuite plutôt que supprimer. Les comptes de service de Claude (`joutiya-claude`, rôles minimaux) et l'accès de la VM (fédération d'identité X.509) arrivent en phases 1 et 2, dans leurs fils.

Nav rapporte : les 3 identifiants, le numéro de chaque projet (**Paramètres du projet**) et la région de chaque base.

## 6. Bot Telegram (alertes) : vous et Cody

Pas d'API : seul @BotFather crée un bot, et il affiche le jeton dans la conversation.
1. Telegram → **@BotFather** → `/newbot` → nom « Joutiya Alertes » → identifiant finissant par `bot`, par exemple `joutiya_alertes_bot`.
2. Copiez le jeton dans `.env.local` : `TELEGRAM_BOT_TOKEN=…` (`/token` chez BotFather le régénère en cas de doute).
3. Ouvrez votre bot, envoyez-lui `/start`, puis lancez le prompt C dans les 24 h : Telegram ne garde les messages que 24 h. Cody rend votre identifiant de conversation : `TELEGRAM_CHAT_ID=…` dans `.env.local`.

## 7. E-mail : Resend et Brevo (après l'étape 1)

**Resend** (e-mails du site)
1. Nav (N5) : inscription sur resend.com avec votre Gmail (ou l'alias), offre Free, sans carte ; équipe « Joutiya » ; puis **API Keys** → clé `joutiya-claude`, permission **Full access** (seul niveau au-dessus de « Sending access », nécessaire pour les domaines, leur vérification, les webhooks et la création des clés d'envoi), préparée jusqu'au clic. **Vous :** mot de passe, code reçu par e-mail, le clic qui crée la clé, rangement sous `JOUTIYA_RESEND_API_KEY`, puis prévenez Claude.
2. Claude, par API : domaine `notif.joutiya.ma` en région **eu-west-1 (Irlande)** (irréversible), ses enregistrements dans la zone Cloudflare en « DNS only », un unique DMARC, TXT `_dmarc.notif` = `v=DMARC1; p=none;`, puis la vérification (après le changement de nameservers). Les clés d'envoi du site et du Worker sont créées par API par le fil de déploiement et rangées directement, jamais affichées. Offre Free : 3 000 e-mails par mois, 100 par jour.

**Brevo** (secours, pour les seuls e-mails de sécurité)
1. Nav (N6) : inscription sur brevo.com (Gmail ou alias), offre Free, sans carte ; **SMTP & API** → clé API v3 `joutiya-claude`, expiration 1 an (ces clés couvrent tout le compte, d'où le compte dédié). **Vous :** mot de passe, code de vérification de l'appareil, le clic qui crée la clé, rangement sous `JOUTIYA_BREVO_API_KEY`. « Bloquer les adresses IP inconnues » reste désactivé : les sessions cloud changent d'adresse.
2. Claude, par API : authentification du domaine `notif.joutiya.ma` (après le changement de nameservers).

## 8. Console Claude : organisation « Joutiya » (Z4)

Nav (N9) sur platform.claude.com (anciennement console.anthropic.com), avec votre Gmail ; si ce Gmail a déjà une organisation et que le sélecteur n'en propose pas de nouvelle, inscription avec l'alias `+joutiya`. Cette organisation sert au site seulement : Cody n'utilise aucune de ses clés, sinon il consomme les 5 $.
1. Organisation **Joutiya** (**Settings** → **Organization**).
2. **Settings** → **Workspaces** : `joutiya-prod` et `joutiya-staging`.
3. **Billing** → **Spend limits** → **Set limit** : 5 $ par mois pour l'organisation ; puis page **Workspaces** → `joutiya-staging` → **Spend limits** : 2 $ (au plus la limite de l'organisation ; impossible sur le Default Workspace). Si ces réglages n'apparaissent qu'après un achat de crédits, ils seront faits à l'achat.
4. Pas de crédits maintenant : l'IA arrive en phase 5 et les crédits expirent au bout d'un an ; à l'achat, recharge automatique désactivée. **Vous :** mot de passe et code.
5. Clés en phase 5 : la clé d'administration (**Settings** → **Admin keys**, préfixe `sk-ant-admin01-`, sans portée possible, affichée une fois, avec une date d'expiration) va sous `JOUTIYA_ANTHROPIC_ADMIN_KEY`, pour la lecture de l'usage et des coûts et la gestion des espaces ; elle ne peut pas créer de clés API : celles du site sont créées dans la Console, par espace de travail (**Vous :** le clic), pour `.env.local` et la VM.

Nav rapporte : l'**Organization ID** (Settings → Organization).

## 9. WhatsApp de Meta (Z3)

Nav (N8), depuis votre profil Facebook :
1. business.facebook.com → portefeuille business **Joutiya**.
2. developers.facebook.com → **Créer une app** → cas d'usage WhatsApp (« Connect with customers through WhatsApp » ou équivalent) → nom **Joutiya**, rattachée au portefeuille Joutiya → produit WhatsApp : Meta fournit un numéro de test, qui servira en dev et en staging.
3. Rien d'autre maintenant : pas de numéro, pas de moyen de paiement (Joutiya ne fait que recevoir, et la réception est gratuite), pas de vérification de l'entreprise, pas d'utilisateur système ni de jeton. **Vous :** mot de passe Facebook et code.

En phase 2, par API : ajout du vrai numéro (carte SIM prépayée marocaine jamais inscrite sur WhatsApp, qui ne pourra plus servir dans l'application ; **Vous :** le code reçu par SMS ou appel), enregistrement avec un PIN à 6 chiffres, utilisateur système `joutiya-claude` et son jeton (`whatsapp_business_management`, `whatsapp_business_messaging` ; **Vous :** le clic qui le révèle, rangement sous `JOUTIYA_META_SYSTEM_TOKEN`). Le webhook de l'app se règle dans le tableau de bord (Nav). Le nom affiché n'est examiné par Meta qu'après la vérification de l'entreprise (pièces : **Vous**).

Nav rapporte : Business ID, App ID, le **WhatsApp Business Account ID** et le **Phone number ID** du numéro de test (dev et staging) ; ceux du vrai numéro suivront en phase 2 (prod : le garde-fou exige qu'il diffère).

## 10. Stripe : nouveau compte « Joutiya » (Z7)

Nav (N10) sur dashboard.stripe.com, sous votre connexion : sélecteur de compte (en haut à gauche) → **Nouveau compte** → nom **Joutiya**, pays France. Il n'est pas activé : mode test jusqu'à la phase 7. Pas de clé maintenant ; en phase 7, des clés restreintes (`rk_test_`, puis `rk_live_`, permissions par ressource) créées dans le tableau de bord avec la double authentification, la clé live n'étant affichée qu'une fois (**Vous :** le clic). **Vous :** mot de passe et code.

Nav rapporte : l'identifiant du compte, au format `acct_…`.

## 11. Démarches administratives (gratuites, avant le lancement)

Reportée à l'avant-lancement (15 octobre) : une formalité officielle sur votre entreprise, avec un éventuel transfert d'adresse, se fait à votre initiative, et rien ne l'exige avant le lancement ; ce n'est pas un critère de fin de phase 0. Guichet unique (formalites.entreprises.gouv.fr), avant tout revenu, AdSense compris. **Vous :** la connexion FranceConnect dans le navigateur de Nav, la signature et toute pièce d'identité. Nav remplit la modification de l'entreprise : ajout de l'activité de plateforme de petites annonces en ligne et de régie publicitaire ; transfert d'établissement vers la domiciliation du 6 rue d'Armaillé, 75017 Paris, dans la même formalité, car l'avis de situation INSEE (public, lu par Nav le 16 octobre) montre le siège encore à votre adresse personnelle et un code APE 16.29Z (objets en bois) qui ne couvre pas une plateforme d'annonces. Points vérifiés par Nav (note `adark-prime-transfert-siege-domiciliation.md` dans les fichiers du projet) : formalité gratuite pour un micro-entrepreneur ; connexion FranceConnect+ et signature par vous ; le SIREN ne change pas mais le SIRET change (nouveau NIC), à répercuter dans `config/legal` et les identifiants ; l'INSEE met de une à quatre semaines. Le fil « Documents du domaine .MA » pilote cette formalité, parce que la vérification du domaine .ma dépend de l'adresse du siège. Le nom exact inscrit au registre va dans `config/legal` (`scripts/legal-config.ts`), pas dans `infra/targets.json` ; Nav ne relève aucune autre donnée personnelle.

## 12. Consigner les identifiants

Claude consigne dans `infra/targets.json`, par PR, les identifiants rapportés par Nav : Cloudflare (`accountId`, `zoneId`, domaine d'équipe Zero Trust, buckets), Oracle (fait : tenancy, compartiment, utilisateur, région), Firebase (identifiants et numéros de projet), Meta et Stripe. `node scripts/assert-target.ts` et ses tests passent en CI. RevenueCat reste vide jusqu'à la phase 7 ; les identifiants de Tunnel et les audiences Access (`sshTunnelId`, `tunnelId`, `accessAud`) sont remplis en phase 1.

Pour la phase 2, Sentry (organisation en région UE, choisie à l'inscription par Nav ; jeton d'intégration interne pour Claude : `project:write`, `event:read`, `event:write`, `org:ci`) suit le même modèle.

**Fin de la phase 0 :** `infra/targets.json` rempli et garde-fou au vert en CI ; chaque jeton rangé (`JOUTIYA_CLOUDFLARE_API_TOKEN`, `JOUTIYA_HOSTINGER_MAIL_API_TOKEN`, `JOUTIYA_RESEND_API_KEY`, `JOUTIYA_BREVO_API_KEY`, `JOUTIYA_OCI_*`) vérifié par un nouveau fil ; clé Oracle tournée (nouvelle `JOUTIYA_OCI_KEY_B64`, ancienne clé supprimée dans la console) ; Z11 : anciens jetons Hostinger révoqués et fichier « Cody Joutiya API.txt » supprimé ; aucune clé dans le dépôt ni dans le chat.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour (`git pull`). Node 24 ou plus récent (`node --version`). Les anciens prompts A (buckets R2), B (projets Firebase) et D (identifiants) ne servent plus : Nav crée les buckets et les projets, Claude consigne les identifiants.

**C. Identifiant de conversation Telegram** (étape 6)

```text
J'ai mis TELEGRAM_BOT_TOKEN dans .env.local et envoyé /start à mon bot. Vérifie d'abord que TELEGRAM_BOT_TOKEN et TELEGRAM_CHAT_ID ne sont pas déjà définis dans le shell (une variable du shell l'emporte sur .env.local) ; si c'est le cas, arrête-toi et dis-le-moi. Appelle la méthode getUpdates de l'API Telegram en lisant le jeton depuis .env.local (par exemple avec `node --env-file=.env.local`), sans jamais afficher le jeton, et donne-moi seulement le chat id. Envoie ensuite le message « Joutiya : alertes OK » à ce chat avec sendMessage.
```

**O. Clé Oracle de Claude** (étape 4, points 3 et 5)

```text
La clé privée de l'utilisateur Oracle joutiya-claude est dans <chemin du fichier .pem téléchargé>. Encode-la en base64 sur une seule ligne, sans retour à la ligne, et copie le résultat dans mon presse-papiers avec l'outil de mon système. Ne l'affiche jamais et ne l'écris dans aucun fichier ni dans le dépôt. Vérifie seulement que le contenu copié, une fois décodé, commence par « -----BEGIN », et dis-moi si c'est le cas. Ne fais rien d'autre.
```
