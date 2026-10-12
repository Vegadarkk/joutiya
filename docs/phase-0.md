# Phase 0 : ouvrir les comptes gratuits de Joutiya

Ce qui reste à faire de votre côté pour clore la phase 0 (architecture v3, §9 et §10). Tout est gratuit : Oracle, R2 et Zero Trust demandent une carte, sans rien débiter.

## Règles pour chaque compte

- Inscrivez-vous avec votre Gmail : les adresses `@joutiya.ma` ne reçoivent rien avant l'étape 2.
- Activez la double authentification partout.
- Ne créez que des ressources neuves pour Joutiya ; ne modifiez ni ne supprimez rien d'existant.
- **Identifiants** (identifiant de projet ou de compte, nom de bucket) : notez-les au fil des étapes, ils vont dans `infra/targets.json` à l'étape 12. Ce ne sont pas des secrets.
- **Clés secrètes** : créez-les seulement à la phase qui s'en sert, puis rangez-les dans votre `.env` local sous le nom prévu par `.env.example`. Jamais dans le dépôt ni dans le chat.
- Alignez votre `.env` actuel sur le nouveau `.env.example` : des noms ont changé (par exemple `CF_ACCOUNT_ID`). N'y gardez que des clés propres à Joutiya ; une clé qui ouvre tout un compte (Global API Key Cloudflare, clé d'un autre projet Google) n'a rien à y faire. Les jetons Hostinger attendent votre décision Z11.

**Ordre conseillé.** L'étape 0 d'abord. Les étapes 1 à 6 bloquent la phase 1 : faites-les ensuite. Les étapes 7 à 11 servent aux phases 2 à 7. L'étape 12 clôt la phase 0.

## 0. D'abord : le domaine `joutiya.ma` est-il validé ?

Un .MA n'est actif qu'après vérification d'une pièce d'identité par le registre (2 à 4 semaines). Sans pièce envoyée dans les 14 jours suivant l'achat, le domaine est suspendu, puis peut être libéré ([aide Hostinger](https://www.hostinger.com/support/requirements-to-register-a-ma-domain/)).
1. hPanel → **Domaines** → `joutiya.ma` : vérifiez qu'il est actif, sans bandeau de vérification ni de suspension.
2. Sinon, envoyez tout de suite la pièce demandée (passeport pour un titulaire étranger) et prévenez-moi : les étapes 1, 2 et 7 attendent la validation.

## 1. Cloudflare : la zone `joutiya.ma`

Faites-la une fois le domaine actif : Cloudflare supprime une zone restée en attente 28 jours.
1. Dans votre compte Cloudflare existant : **Add a domain** → `joutiya.ma` → offre **Free**.
2. Cloudflare importe les enregistrements DNS actuels. Supprimez ceux de l'ancienne boîte Hostinger (MX, SPF Hostinger, DKIM, `autodiscover`, `autoconfig`) et ceux de la page d'attente Hostinger : la boîte n'existe plus et le site arrive en phase 1.
3. Notez les 2 nameservers donnés par Cloudflare.
4. Si DNSSEC est actif sur le domaine chez Hostinger, désactivez-le d'abord, puis attendez 24 h.
5. hPanel : **Domaines** → **Portefeuille de domaines** → **Gérer** (`joutiya.ma`) → **DNS / Nameservers** (ou « Serveurs de noms ») → **Changer les nameservers** → saisissez les 2 nameservers Cloudflare → Enregistrer. Gardez chez Hostinger le verrou de transfert et le renouvellement automatique.
6. Attendez l'e-mail de Cloudflare annonçant que la zone est active (de quelques minutes à 24 h, parfois plusieurs jours pour un .MA).

À noter : **Account ID** et **Zone ID** (page d'accueil de la zone, colonne de droite).

## 2. Cloudflare : Email Routing (Z12)

Une fois la zone active :
1. Zone `joutiya.ma` → **Email Routing** (menu *Email*, ou *Compute* → *Email Service* selon la version du tableau de bord) → **Get started**.
2. Destination : votre Gmail ; cliquez le lien de vérification reçu.
3. Créez `contact@`, `dsa@`, `abuse@` et `dpo@`, chacune vers votre Gmail.
4. **Add records and enable** : Cloudflare ajoute ses MX, un SPF et une clé DKIM. Aucun autre MX ne doit rester, et un seul SPF.
5. Testez en écrivant à `contact@joutiya.ma` depuis une autre adresse.

Répondre en tant que `contact@` : pas maintenant. Google supprime en janvier 2027 l'envoi depuis une adresse externe dans Gmail ; la méthode de remplacement sera fixée avant le lancement.

## 3. Cloudflare : R2 et Zero Trust

**R2**
1. **R2 Object Storage** → activez l'offre gratuite (carte demandée ; rien n'est débité sous 10 Go).
2. Créez 9 buckets en juridiction **European Union (EU)**, non modifiable ensuite : `joutiya-dev-quarantine`, `joutiya-dev-media`, `joutiya-dev-private`, puis les mêmes avec `staging` et `prod`. Cody peut le faire (prompt A).
3. Aucune clé R2 maintenant : elles arrivent en phase 3.

**Zero Trust**
1. **Zero Trust** → nom d'équipe `joutiya` (ou `joutiya-ma` s'il est pris) → offre **Free** (carte demandée, 0 €).
2. Rien d'autre : les applications Access arrivent en phase 1.

À noter : le domaine d'équipe `<équipe>.cloudflareaccess.com` et les noms exacts des 9 buckets.

## 4. Oracle Cloud (Z1)

1. oracle.com/cloud/free → **Start for free** → pays France, votre Gmail.
2. **Home Region : France Central (Paris)**. **Irréversible** : la VM gratuite ne pourra être créée que dans cette région.
3. Vérification de la carte : une petite somme est bloquée, puis rendue.
4. Activez la double authentification du compte.
5. Ne créez pas encore la VM : la phase 1 donne ses réglages exacts, et Oracle peut récupérer une VM gratuite inactive pendant 7 jours.
6. Mentions légales (hébergeur) : relevez dans le contrat accepté à l'inscription l'entité Oracle, son adresse et son téléphone. Pour la France, c'est a priori Oracle France S.A.S., 15 boulevard Charles de Gaulle, 92715 Colombes Cedex : vérifiez-le sur votre contrat.

À noter : la région d'origine (`eu-paris-1`).

## 5. Firebase : 3 projets Spark (Z2)

Cody peut faire les points 1 à 3 (prompt B).
1. console.firebase.google.com → **Créer un projet** `joutiya-dev` → si l'identifiant proposé porte un suffixe, notez-le tel quel → **désactivez Google Analytics** → Créer.
2. Recommencez pour `joutiya-staging` et `joutiya-prod`.
3. Dans chaque projet : **Firestore Database** → **Créer une base de données** → édition **Standard** → emplacement **europe-west9 (Paris)** → mode production. **Irréversible** : la région ne change plus. Si Paris est refusé, arrêtez-vous et dites-le-moi avant de prendre `europe-west1`.
4. Restez sur l'offre **Spark** : ne passez jamais à Blaze, et ne cliquez pas « Upgrade » vers Identity Platform dans Authentication (sur Spark, cela plafonne à 3 000 utilisateurs actifs par jour). Authentication s'active en phase 2.

Un identifiant de projet est définitif et jamais réutilisable, même après suppression.

À noter : les 3 identifiants de projet et la région de chaque base.

## 6. Bot Telegram (alertes)

1. Telegram → **@BotFather** → `/newbot` → nom « Joutiya Alertes » → identifiant finissant par `bot`, par exemple `joutiya_alertes_bot`.
2. Copiez le jeton dans `.env` : `TELEGRAM_BOT_TOKEN=…`
3. Ouvrez votre bot, envoyez-lui `/start`, puis lancez le prompt C dans les 24 h : Telegram ne garde les messages que 24 h.
4. Cody récupère votre identifiant de conversation (prompt C) ; ajoutez-le dans `.env` : `TELEGRAM_CHAT_ID=…`

## 7. E-mail : Resend et Brevo (après l'étape 1)

**Resend** (e-mails du site)
1. resend.com → inscription avec votre Gmail, offre Free, sans carte.
2. **Domains** → **Add domain** → `notif.joutiya.ma`, région **eu-west-1 (Irlande)**. **Irréversible** : changer de région impose de recréer le domaine.
3. Ajoutez dans Cloudflare les enregistrements affichés, en « DNS only » (nuage gris), puis **Verify**.
4. Pas de clé API avant la phase 2.

**Brevo** (secours, pour les seuls e-mails de sécurité)
1. brevo.com → inscription, offre Free, sans carte.
2. Authentifiez le domaine `notif.joutiya.ma` avec les enregistrements affichés (dans Cloudflare, « DNS only »).
3. Pas de clé API avant la phase 2.

## 8. Claude Console : organisation « Joutiya » (Z4)

1. console.anthropic.com → connexion avec votre Gmail → créez l'organisation **Joutiya**. Une adresse ne peut créer qu'une organisation : si votre Gmail en a déjà une, inscrivez-vous avec `contact@joutiya.ma` (reçue dans Gmail grâce à l'étape 2).
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

Donnez les identifiants notés à Cody (prompt D), ou collez-les dans le fil du projet. RevenueCat reste vide jusqu'à la phase 7.

**Fin de la phase 0 :** `infra/targets.json` rempli, `node scripts/assert-target.ts` au vert, aucune clé dans le dépôt.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour (`git pull`).

**A. Buckets R2** (après l'activation de R2, étape 3)

```text
Crée les buckets R2 de Joutiya avec Wrangler. Lance `npx wrangler login` (je valide dans le navigateur), puis `npx wrangler whoami` : vérifie que c'est le compte où la zone joutiya.ma a été ajoutée et donne-moi son Account ID. Crée ensuite en juridiction UE, avec `npx wrangler r2 bucket create <nom> --jurisdiction eu`, les 9 buckets joutiya-dev-quarantine, joutiya-dev-media, joutiya-dev-private, joutiya-staging-quarantine, joutiya-staging-media, joutiya-staging-private, joutiya-prod-quarantine, joutiya-prod-media et joutiya-prod-private. Ne modifie et ne supprime aucune ressource existante ; si un nom est refusé, arrête-toi et dis-le-moi. Vérifie la liste des buckets UE, inscris l'Account ID et les noms exacts dans infra/targets.json, puis lance `node scripts/assert-target.ts`.
```

**B. Projets Firebase** (étape 5)

```text
Crée les 3 projets Firebase de Joutiya avec firebase-tools. Lance `npx firebase-tools login` (je valide dans le navigateur). Crée joutiya-dev, joutiya-staging et joutiya-prod avec `npx firebase-tools projects:create <id> --display-name "Joutiya <env>"` ; si un identifiant est pris, ajoute un suffixe de 4 chiffres et dis-le-moi. Ne touche à aucun autre projet et n'active aucune facturation (offre Spark). Pour chaque projet, crée la base Firestore avec `npx firebase-tools firestore:databases:create "(default)" --location europe-west9 --project <id>`, en ajoutant `--delete-protection ENABLED` pour la prod ; si europe-west9 est refusé, arrête-toi et demande-moi. Inscris les identifiants exacts et la région dans infra/targets.json, puis lance `node scripts/assert-target.ts`.
```

**C. Identifiant de conversation Telegram** (étape 6)

```text
J'ai mis TELEGRAM_BOT_TOKEN dans .env et envoyé /start à mon bot. Appelle la méthode getUpdates de l'API Telegram en lisant le jeton depuis .env (par exemple avec `node --env-file=.env`), sans jamais afficher le jeton, et donne-moi seulement le chat id. Envoie ensuite le message « Joutiya : alertes OK » à ce chat avec sendMessage.
```

**D. Consigner les identifiants** (étape 12)

```text
Depuis main à jour, inscris dans infra/targets.json les identifiants ci-dessous (ce ne sont pas des secrets ; laisse null ce qui manque). Lance `node scripts/assert-target.ts` et `node --test scripts/assert-target.test.ts` jusqu'au vert, puis pousse une branche phase-0-targets et ouvre une PR vers main intitulée « Record phase 0 identifiers ». Aucune clé ni aucun secret dans le commit.
<collez ici les identifiants notés>
```
