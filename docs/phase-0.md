# Phase 0 : ouvrir les comptes gratuits de Joutiya

Ce qui reste à faire de votre côté pour clore la phase 0 (architecture v3, §9 et §10). Tout est gratuit : Oracle, R2 et Zero Trust demandent une carte, sans rien débiter.

## Règles pour chaque compte

- **Comptes dédiés** (votre choix du 12 octobre) : chaque service reçoit un compte, un projet ou une organisation neuve, réservée à Joutiya. Ne modifiez ni ne supprimez rien d'existant.
- **Gardez votre identité actuelle** là où une même personne peut créer plusieurs ressources : Google (nouveaux projets Firebase), Meta (nouveau portefeuille depuis votre profil Facebook : un seul profil par personne), Stripe (nouveau compte sous votre connexion actuelle), Telegram (bot créé depuis votre compte), Cloudflare (zone et buckets dans votre compte actuel). Oracle n'admet qu'un compte gratuit par personne.
- **Resend, Brevo et console Claude** : inscrivez-vous avec votre Gmail. Si vous y avez déjà un compte à cette adresse, prenez un alias Gmail, `votre.adresse+joutiya@gmail.com` : Gmail le reçoit sans réglage. N'utilisez pas `contact@joutiya.ma` pour vous connecter : elle est publique et dépend du domaine.
- Si un service refuse (quota atteint, compte unique déjà pris, alias refusé), ne réutilisez rien : prévenez Claude dans le projet, il vous proposera une solution.
- Activez la double authentification partout.
- **Adresse** : quand un service demande l'adresse de l'entreprise, donnez uniquement la domiciliation, 6 rue d'Armaillé, 75017 Paris.
- **Identifiants** (identifiant de projet ou de compte, nom de bucket) : notez-les au fil des étapes, ils vont dans `infra/targets.json` à l'étape 12. Ce ne sont pas des secrets.
- **Clés secrètes** : créez-les seulement à la phase qui s'en sert, puis rangez-les dans le fichier local `.env.local` sous le nom prévu par `.env.example`. Jamais dans le dépôt ni dans le chat.
- Si vous avez un `.env` dans le dossier du dépôt, renommez-le en `.env.local` et alignez-le sur le nouveau `.env.example` : des noms ont changé (par exemple `CF_ACCOUNT_ID`). N'y gardez que des clés propres à Joutiya ; une clé qui ouvre tout un compte (Global API Key Cloudflare, clé d'un autre projet Google) n'a rien à y faire. Les jetons Hostinger attendent votre décision Z11.

**Ordre conseillé.** L'étape 0 d'abord. Les étapes 1 à 6 bloquent la phase 1 : faites-les ensuite. Les étapes 7 à 11 servent aux phases 2 à 7. L'étape 12 clôt la phase 0.

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
3. Créez les boîtes `dsa@`, `abuse@` et `dpo@` : l'offre n'accepte qu'un alias par boîte, et les boîtes sont gratuites.
4. **Agentic Mail** → **Accès API** : révoquez l'ancien jeton (celui du fichier « Cody Joutiya API.txt »), puis créez un jeton limité à ces 4 boîtes, avec la permission SMTP/IMAP. Rangez-le dans l'environnement cloud du projet sous `HOSTINGER_MAIL_API_TOKEN`, jamais dans le chat : Claude gère alors ces boîtes.
5. Testez en écrivant à `contact@joutiya.ma` depuis une autre adresse.

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

1. oracle.com/cloud/free → **Start for free** → pays France, votre Gmail. Oracle n'autorise qu'un compte gratuit par personne : si vous en avez déjà un, n'en créez pas d'autre et prévenez Claude.
2. **Home Region : France Central (Paris)**, sinon France South (Marseille) ; si aucune des deux n'est proposée, arrêtez-vous et prévenez Claude. **Irréversible** : la VM gratuite ne pourra être créée que dans cette région.
3. Vérification par une carte bancaire classique (les cartes prépayées ou virtuelles sont refusées) : une petite somme est bloquée, puis rendue sous quelques jours.
4. Activez la double authentification du compte. Restez en offre gratuite : ne passez pas en **Pay As You Go**, même si Oracle le propose, sans en parler d'abord dans le projet.
5. Ne créez pas encore la VM : la phase 1 donne ses réglages exacts, et Oracle peut récupérer une VM gratuite inactive pendant 7 jours. Un compte gratuit inactif 30 jours peut aussi être suspendu : la VM doit suivre dans ce délai.
6. Mentions légales (hébergeur) : gardez une copie du contrat accepté à l'inscription et relevez-y l'entité Oracle, son adresse et son téléphone (Oracle France ou Oracle America selon le contrat).

À noter : la région d'origine (`eu-paris-1` ou `eu-marseille-1`).

## 5. Firebase : 3 projets Spark (Z2)

Cody peut faire les points 1 à 3 (prompt B), une fois que vous avez lancé vous-même `npx firebase-tools login` dans un terminal : cette connexion demande un terminal interactif.
1. console.firebase.google.com → **Créer un projet** `joutiya-dev` → si l'identifiant proposé porte un suffixe, notez-le tel quel → **désactivez Google Analytics** → Créer.
2. Recommencez pour `joutiya-staging` et `joutiya-prod`.
3. Dans chaque projet : **Firestore Database** → **Créer une base de données** → édition **Standard** → emplacement **europe-west9 (Paris)** → mode production. **Irréversible** : la région ne change plus. Si Paris est refusé, arrêtez-vous et prévenez Claude avant de prendre `europe-west1`.
4. Restez sur l'offre **Spark** : ne passez jamais à Blaze, et ne cliquez pas « Upgrade » vers Identity Platform dans Authentication (sur Spark, cela plafonne à 3 000 utilisateurs actifs par jour). Authentication s'active en phase 2.

Un identifiant de projet est définitif et jamais réutilisable, même après suppression. Un compte Google n'a droit qu'à quelques projets sans facturation (environ 5 à 10, projets Google Cloud compris) : si la création est refusée, demandez une hausse de quota (gratuite) plutôt que de supprimer un projet existant.

À noter : les 3 identifiants de projet et la région de chaque base.

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
5. Pas de clé API avant la phase 2.

**Brevo** (secours, pour les seuls e-mails de sécurité)
1. brevo.com → inscription, offre Free, sans carte.
2. Authentifiez le domaine `notif.joutiya.ma` avec les enregistrements affichés (dans Cloudflare, « DNS only »).
3. Pas de clé API avant la phase 2.

## 8. Claude Console : organisation « Joutiya » (Z4)

1. console.anthropic.com → connexion avec votre Gmail → créez l'organisation **Joutiya**. Une adresse ne peut créer qu'une organisation : si votre Gmail en a déjà une, prenez l'alias `+joutiya` (voir les règles). Cette organisation sert au site seulement : Cody n'utilise aucune de ses clés, sinon il consomme les 5 $.
2. **Settings** → **Workspaces** : créez `joutiya-prod` et `joutiya-staging`.
3. Réglages des limites (*Limits*, ou *Billing* → *Spend limits*) : limite de dépense mensuelle de l'organisation à **5 $**, et une limite plus basse pour `joutiya-staging`. Si la page ne le propose pas encore, faites-le à l'achat des crédits.
4. N'achetez pas de crédits maintenant : l'IA arrive en phase 5 et les crédits expirent au bout d'un an. À l'achat, laissez la recharge automatique désactivée.

À noter : l'**Organization ID** (Settings → Organization).

## 9. WhatsApp de Meta (Z3)

Prérequis : une carte SIM prépayée marocaine, jamais inscrite sur WhatsApp, qui peut recevoir un SMS ou un appel au moment de l'ajout. Ce numéro ne pourra plus servir dans l'application WhatsApp.
1. business.facebook.com → créez le portefeuille business **Joutiya**.
2. developers.facebook.com → **Créer une app** → cas d'usage « Connect with customers through WhatsApp » → nom **Joutiya**, rattachée au portefeuille Joutiya. Meta fournit un numéro de test : il servira en dev et en staging.
3. WhatsApp → **API Setup** → **Add phone number** → nom affiché « Joutiya » → validez par SMS ou appel. Le nom affiché passe en revue chez Meta. L'enregistrement final du numéro (code PIN à 6 chiffres) et la mise en ligne de l'app se font en phase 2.
4. N'ajoutez pas de moyen de paiement : Joutiya ne fait que recevoir.
5. Pas de jeton ni de secret d'app maintenant : ils arrivent en phase 2.

À noter : Business ID, App ID, et pour le numéro de test comme pour le vrai, le **WhatsApp Business Account ID** et le **Phone number ID**.

## 10. Stripe : nouveau compte « Joutiya » (Z7)

1. dashboard.stripe.com → sélecteur de compte (en haut à gauche) → **Nouveau compte** → nom **Joutiya**, pays France.
2. Ne l'activez pas : il sert en mode test jusqu'à la phase 7.

À noter : l'identifiant du compte, au format `acct_…`.

## 11. Démarches administratives (gratuites)

- Guichet unique (formalites.entreprises.gouv.fr) → modification de l'entreprise → ajoutez l'activité de plateforme de petites annonces en ligne et de régie publicitaire, avant tout revenu, AdSense compris.
- Vérifiez au registre (RNE) que l'adresse est la domiciliation du 6 rue d'Armaillé, 75017 Paris ; sinon, déclarez le transfert. Relevez le nom exact inscrit au registre (le mémento fiscal indique « DARKAOUI ADIL »).

## 12. Consigner les identifiants

Donnez les identifiants notés, y compris ceux rendus par les prompts A et B, à Cody (prompt D), ou collez-les dans le fil du projet. RevenueCat reste vide jusqu'à la phase 7.

**Fin de la phase 0 :** décision Z11 prise (jetons Hostinger), `infra/targets.json` rempli, `node scripts/assert-target.ts` au vert, aucune clé dans le dépôt.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour (`git pull`). Node 24 ou plus récent est nécessaire (`node --version`).

**A. Buckets R2** (après l'activation de R2, étape 3)

```text
Crée les buckets R2 de Joutiya avec Wrangler. Travaille depuis un dossier temporaire vide, hors du dépôt, pour que Wrangler ne lise aucun fichier .env. Lance `npx wrangler login` (je valide dans le navigateur), puis `npx wrangler whoami` : vérifie qu'il annonce une connexion OAuth, et non un jeton d'API ou une clé, sur le compte où la zone joutiya.ma a été ajoutée, et donne-moi son Account ID. Si Wrangler demande de choisir un compte, préfixe chaque commande par CLOUDFLARE_ACCOUNT_ID=<cet Account ID>. Crée ensuite en juridiction UE, avec `npx wrangler r2 bucket create <nom> --jurisdiction eu`, les 9 buckets joutiya-dev-quarantine, joutiya-dev-media, joutiya-dev-private, joutiya-staging-quarantine, joutiya-staging-media, joutiya-staging-private, joutiya-prod-quarantine, joutiya-prod-media et joutiya-prod-private. Ne modifie et ne supprime aucune ressource existante ; si un nom est refusé, arrête-toi et dis-le-moi. Vérifie la liste des buckets UE, donne-moi l'Account ID et les noms exacts sans rien écrire dans le dépôt, puis lance `npx wrangler logout`.
```

**B. Projets Firebase** (étape 5)

```text
Crée les 3 projets Firebase de Joutiya avec firebase-tools. Je me suis connecté moi-même avec `npx firebase-tools login`. Travaille depuis un dossier temporaire vide, hors du dépôt. Crée joutiya-dev, joutiya-staging et joutiya-prod avec `npx firebase-tools projects:create <id> --display-name "Joutiya <env>"` ; si un identifiant est pris, ajoute un suffixe de 4 chiffres et dis-le-moi. Ne touche à aucun autre projet et n'active aucune facturation (offre Spark). Pour chaque projet, crée la base Firestore avec `npx firebase-tools firestore:databases:create "(default)" --location europe-west9 --project <id>`, en ajoutant `--delete-protection ENABLED` pour la prod ; si europe-west9 est refusé, arrête-toi et demande-moi. Donne-moi les identifiants exacts et la région de chaque base sans rien écrire dans le dépôt, puis lance `npx firebase-tools logout`.
```

**C. Identifiant de conversation Telegram** (étape 6)

```text
J'ai mis TELEGRAM_BOT_TOKEN dans .env.local et envoyé /start à mon bot. Appelle la méthode getUpdates de l'API Telegram en lisant le jeton depuis .env.local (par exemple avec `node --env-file=.env.local`), sans jamais afficher le jeton, et donne-moi seulement le chat id. Envoie ensuite le message « Joutiya : alertes OK » à ce chat avec sendMessage.
```

**D. Consigner les identifiants** (étape 12)

```text
Depuis main à jour, inscris dans infra/targets.json les identifiants ci-dessous (ce ne sont pas des secrets ; laisse null ce qui manque). Lance `node scripts/assert-target.ts` et `node --test scripts/assert-target.test.ts` jusqu'au vert, puis pousse une branche phase-0-targets et ouvre une PR vers main intitulée « Record phase 0 identifiers ». Aucune clé ni aucun secret dans le commit.
<collez ici les identifiants notés>
```
