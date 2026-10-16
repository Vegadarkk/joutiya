# Phase 2 : comptes, connexion et vérifications

Le code de la phase 2 est dans la PR de la branche `claude/mvp-phase-2-fable-xd8l3k` : inscription par e-mail, connexion, connexion Google, mots de passe oubliés, paramètres du compte, vérification du téléphone par WhatsApp, back-office du personnel, e-mails transactionnels (Resend, secours Brevo), suivi des erreurs (Sentry), alertes e-mail de la sonde par Resend, tests contre les émulateurs Firebase. Ce guide dit quoi brancher, dans l'ordre, et qui le fait. Coût : 0 €.

## Avant de commencer

- Phase 0 : étapes 5 (projets Firebase), 7 (Resend, Brevo) et 9 (app Meta) faites, ou au moins le projet Firebase de l'environnement visé.
- Phase 1 : étapes 1 à 7 faites pour l'environnement visé (VM, tunnels, Access, fédération d'identité X.509 : le compte de service `joutiya-web` existe déjà avec `roles/iam.serviceAccountTokenCreator` sur lui-même, c'est lui qui signe les jetons de session).
- Les clés vont dans `.env.local` sous les noms de `.env.example`, puis dans `/etc/joutiya/<env>/app.env` sur la VM (prompt G de la phase 1, complété par le prompt L ci-dessous). Jamais dans le dépôt ni dans le chat.
- Aucune variable `NEXT_PUBLIC_*` : la configuration du navigateur est servie à l'exécution (`/api/config`). Une image sert le staging et la production. Un nom `NEXT_PUBLIC_*` empêche l'application de démarrer.

## Qui fait quoi (règle n°1)

- **Claude** agit par API avec les jetons `JOUTIYA_*` de votre environnement cloud : clés d'envoi Resend, enregistrement des identifiants dans `infra/targets.json`, mise à jour du guide.
- **Nav** (Claude dans votre navigateur) fait les réglages des consoles : Firebase Authentication, client OAuth Google, widget Turnstile, webhook Resend, webhook et secret Meta, compte Sentry. Il prépare chaque secret jusqu'à l'écran qui le crée et ne le voit jamais.
- **Vous :** mots de passe, codes de double authentification, CAPTCHA, le clic qui révèle un secret, son rangement dans `.env.local` ou sur la VM, et la phrase d'autorisation dans le fil de Nav avant toute création (celle du 15 octobre couvre N1 à N10 ; les étapes N11 à N13 ci-dessous demandent une phrase de plus). Ces moments sont signalés par **Vous :**.
- **Cody** : les prompts en fin de page (variables de la VM, premier administrateur).

## Les jetons de la phase 2, service par service

| Service | Jeton ou identifiant | Portée minimale | Où il va | Qui |
|---|---|---|---|---|
| Firebase | `FIREBASE_API_KEY` (clé navigateur de l'app web) | Restrictions : référents `https://joutiya.ma/*`, `https://www.joutiya.ma/*` (staging : `https://staging.joutiya.ma/*`) ; API Identity Toolkit, Token Service, Cloud Firestore | `.env.local`, `app.env` (publique par conception, mais hors du dépôt) | Nav crée, vous copiez |
| Firebase | `FIREBASE_SERVER_API_KEY` (clé `joutiya-server`, optionnelle) | Sans restriction de référent ; API Identity Toolkit uniquement | `app.env` | Nav crée, **Vous :** copie |
| Firebase | `FIREBASE_APP_ID` | Identifiant public `1:<numéro>:web:<hash>` | `.env.local`, `app.env`, `infra/targets.json` | Nav rapporte, Claude consigne |
| Firebase | `FIREBASE_SERVICE_ACCOUNT` | `joutiya-web@<projet>.iam.gserviceaccount.com` (créé en phase 1, prompt H) | `app.env` | Cody (prompt L) |
| Google | `GOOGLE_OAUTH_CLIENT_ID` (client `joutiya-site`) | Origines JavaScript du site uniquement, aucun secret utilisé | `.env.local`, `app.env`, `infra/targets.json` | Nav rapporte, Claude consigne |
| Cloudflare | `TURNSTILE_SITE_KEY` (publique), `TURNSTILE_SECRET_KEY` | Un widget par environnement, limité à ses noms d'hôte | `.env.local`, `app.env` | Nav crée, **Vous :** la clé secrète |
| Resend | `MAIL_API_KEY` (clé `joutiya-web-<env>`) | *Sending access*, domaine `notif.joutiya.ma` seulement | `app.env` | Claude par API, rangée directement sur la VM par le fil de déploiement |
| Resend | `RESEND_API_KEY` du Worker | *Sending access*, domaine `notif.joutiya.ma` | Secret du Worker `joutiya-uptime-probe`, écrit par l'API Cloudflare sans passer par vous | Claude par API, fil « Mise en ligne phase 1 » |
| Resend | `MAIL_WEBHOOK_SECRET` (`whsec_…`) | Un webhook par environnement, événements `email.bounced` et `email.complained` | `app.env` | Nav crée, **Vous :** le secret |
| Brevo | `MAIL_FALLBACK_API_KEY` (clé v3 `joutiya-web-<env>`) | Les clés Brevo couvrent tout le compte : compte dédié, une clé par environnement pour la révoquer seule | `app.env` | Nav crée, **Vous :** le secret |
| Meta | `WHATSAPP_APP_SECRET` | Secret de l'app, vérifie la signature des webhooks | `app.env` | **Vous :** « Afficher » puis copie |
| Meta | `WHATSAPP_VERIFY_TOKEN` | Chaîne aléatoire d'au moins 32 caractères, la même dans `app.env` et la console Meta (sert seulement à la poignée de main du webhook) | `.env.local`, `app.env`, console Meta | **Vous :** la générez et la collez dans la console ; Cody la copie sur la VM |
| Meta | `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_DISPLAY_NUMBER` | Identifiant public du numéro, numéro en chiffres sans `+` (numéro de test, puis la ligne professionnelle d'Adark Prime en production, `33…`) | `app.env`, `infra/targets.json` | Nav rapporte |
| Sentry | `SENTRY_DSN` | DSN public d'un projet de l'organisation Joutiya, région UE (`*.ingest.de.sentry.io`) | `app.env` | Nav rapporte |
| VM | `CSRF_SECRET` | 32 caractères aléatoires, différent de `HASH_PEPPER`, un par environnement | `app.env` | Cody (prompt L) |

Aucun autre jeton n'est créé en phase 2 : pas de clé JSON de compte de service, pas de jeton Meta (le site ne fait que recevoir), pas de clé Console Claude (phase 5).

## 1. Firebase : Authentication et application web (Nav, N11)

Dans chaque projet (`joutiya-dev`, `joutiya-staging`, `joutiya-prod`), sur console.firebase.google.com :
1. **Authentication** → **Commencer** → onglet **Sign-in method** :
   - **Adresse e-mail/Mot de passe** : activé ; « Lien e-mail (connexion sans mot de passe) » désactivé.
   - **Google** : activé ; nom public du projet « Joutiya » ; e-mail d'assistance = votre Gmail. Cette activation crée le client OAuth du projet ; le site n'utilise pas ce client, voir l'étape 2.
2. **Authentication** → **Settings** → **Authorized domains** : ajouter `joutiya.ma` et `www.joutiya.ma` (prod) ou `staging.joutiya.ma` (staging) ; `localhost` reste pour `joutiya-dev`.
3. **Authentication** → **Settings** → **User actions** : décocher **Enable create (sign-up)** et **Enable delete**, et cocher **Email enumeration protection**. Le serveur crée les comptes avec le SDK Admin ; une clé navigateur volée ne peut alors ni créer ni supprimer un compte, ni savoir si une adresse a un compte.
4. **Authentication** → **Templates** : rien à faire, le site envoie ses propres e-mails par Resend. **Password policy** : rien à faire, le site vérifie lui-même.
5. **Paramètres du projet** → **Général** → **Vos applications** → **Ajouter une application** → **Web** (icône `</>`) → pseudo `joutiya-web`, sans Firebase Hosting → **Enregistrer**. Nav rapporte l'`appId` (`1:<numéro>:web:<hash>`) ; la valeur `apiKey` est la clé navigateur de l'étape 6.
6. console.cloud.google.com → même projet → **API et services** → **Identifiants** :
   - clé **Browser key (auto created by Firebase)** : la renommer `joutiya-browser` ; **Restrictions relatives aux applications** → *Référents HTTP* : `https://joutiya.ma/*`, `https://www.joutiya.ma/*` (staging : `https://staging.joutiya.ma/*` ; dev : `http://localhost:3000/*`) ; **Restrictions relatives aux API** → *Restreindre la clé* : Identity Toolkit API, Token Service API, Cloud Firestore API. C'est `FIREBASE_API_KEY`.
   - **Créer des identifiants** → **Clé API** → nom `joutiya-server` : aucune restriction d'application (le serveur appelle depuis la VM ; une restriction par adresse IP viendra quand l'adresse de sortie sera stable), **Restrictions relatives aux API** : Identity Toolkit API seule. C'est `FIREBASE_SERVER_API_KEY`. **Vous :** copie de la valeur dans `.env.local`, puis `app.env` (prompt L). Si vous ne la créez pas, le serveur utilise `FIREBASE_API_KEY` en envoyant le référent du site ; la clé serveur est recommandée pour garder la clé navigateur restreinte indépendamment.
7. **API et services** → **Bibliothèque** : vérifier que **IAM Service Account Credentials API** et **Identity Toolkit API** sont activées (la phase 1, prompt H, active déjà `iamcredentials`). Sans la première, le serveur ne peut pas signer les jetons de session.
8. **Vous :** le mot de passe Google ou un code si demandé.

Nav rapporte, par projet : l'`appId`, le nom de la clé navigateur (pas sa valeur si elle est restreinte aux référents : elle est publique, mais inutile dans le chat), et confirme les trois réglages Authentication.

Pourquoi : offre Spark, jamais d'« Upgrade » vers Identity Platform. Spark autorise 100 inscriptions par heure et par adresse IP, 10 000 liens de vérification et 1 500 liens de réinitialisation par jour ; le site reste très en dessous par ses propres limites (3 inscriptions par jour et par appareil, 30 par heure et par adresse IP, 3 renvois par heure et par compte, 3 réinitialisations par heure et par adresse, `src/config/rate-limits.ts`). Les compteurs de `src/config/quotas.ts` surveillent Resend, Firestore et les autres services mesurés, pas Firebase Auth.

## 2. Google : client OAuth de la connexion Google du site (Nav, N11)

La connexion Google du site passe par Google Identity Services : le navigateur reçoit un jeton d'identité Google, le serveur le vérifie (émetteur, audience, e-mail vérifié) et ouvre la session lui-même. Il faut donc un client OAuth dont l'audience est connue du serveur. Dans console.cloud.google.com, projet `joutiya-prod` puis `joutiya-staging` :
1. **Google Auth Platform** → **Branding** : nom « Joutiya », e-mail d'assistance = votre Gmail, logo facultatif (`public/brand/`), domaine autorisé `joutiya.ma`, liens Politique de confidentialité `https://joutiya.ma/fr/legal/confidentialite` et Conditions `https://joutiya.ma/fr/legal/cgu` (les adresses exactes sont dans `src/config/legal-pages.ts`).
2. **Audience** : *External*. Statut **Testing** tant que le site n'est pas lancé (vos comptes dans *Test users*), puis **Publish app** avant le lancement : les seules portées utilisées (`openid`, `email`, `profile`) ne demandent aucune vérification Google.
3. **Clients** → **Create client** → *Web application*, nom `joutiya-site` :
   - *Authorized JavaScript origins* : `https://joutiya.ma` et `https://www.joutiya.ma` (staging : `https://staging.joutiya.ma` ; dev : `http://localhost:3000` dans `joutiya-dev`) ;
   - *Authorized redirect URIs* : aucune (le bouton Google Identity Services n'en utilise pas) ;
   - le secret du client n'est pas utilisé par le site : ne le copiez nulle part.
4. Nav rapporte l'**ID client** (`<numéro>-<hash>.apps.googleusercontent.com`) : c'est `GOOGLE_OAUTH_CLIENT_ID`, une valeur publique.

Ne pas confondre avec le client `cloudflare-access` de la phase 1 (étape 3), qui sert à l'accès du personnel au back-office.

## 3. Cloudflare Turnstile : anti-robots (Nav, N12)

dash.cloudflare.com → **Turnstile** → **Add widget**, deux fois :
- `joutiya-prod` : noms d'hôte `joutiya.ma`, `www.joutiya.ma`, `admin.joutiya.ma` ; mode **Managed** ; *pre-clearance* désactivée.
- `joutiya-staging` : `staging.joutiya.ma`, `admin-staging.joutiya.ma`.

Nav rapporte la **Site Key** de chaque widget (publique, `TURNSTILE_SITE_KEY`). **Vous :** le clic qui affiche la **Secret Key**, copie dans `.env.local` sous `TURNSTILE_SECRET_KEY` puis `app.env` (prompt L). Le développement local utilise la paire de test de Cloudflare (`1x00000000000000000000AA` / `1x0000000000000000000000000000000AA`), refusée en production au démarrage.

Le site demande Turnstile à l'inscription, à la demande de réinitialisation, au renvoi de l'e-mail de vérification, à l'inscription par Google, à la connexion à partir du troisième échec sur un compte, et à chaque connexion du personnel au back-office.

## 4. Resend et Brevo : clés d'envoi, webhook, secours

Prérequis : domaine `notif.joutiya.ma` vérifié chez Resend (phase 0, étape 7, après le changement de nameservers).

**Clés d'envoi (Claude, par API, avec `JOUTIYA_RESEND_API_KEY`)** : trois clés *Sending access* limitées au domaine `notif.joutiya.ma` : `joutiya-web-prod` et `joutiya-web-staging` (`MAIL_API_KEY` de chaque environnement) et `joutiya-uptime-probe` (secret `RESEND_API_KEY` du Worker, voir la phase 1, étape 9 : les alertes e-mail de la sonde partent désormais par Resend, plus par Email Routing). Le fil « Mise en ligne phase 1 » les crée au moment d'écrire les fichiers de la VM et le secret du Worker, sans les afficher ; sa documentation (`docs/phase-1.md`, étape 9) est mise à jour par ce fil pour décrire ce passage d'Email Routing à Resend.

**Webhook (Nav, N13)** : resend.com → **Webhooks** → **Add Webhook** : URL `https://joutiya.ma/api/webhooks/mail`, événements **email.bounced** et **email.complained** seulement. Un second webhook pour `https://staging.joutiya.ma/api/webhooks/mail`. **Vous :** le clic qui révèle le **Signing Secret** (`whsec_…`) de chacun, copie sous `MAIL_WEBHOOK_SECRET` dans `.env.local` puis `app.env`. Le site y inscrit les adresses en rebond définitif ou en plainte : plus aucun e-mail non indispensable ne leur part.

**Brevo (Nav, N13)** : app.brevo.com → **SMTP & API** → **Clés API** → `joutiya-web-prod` puis `joutiya-web-staging`, expiration 1 an. **Vous :** le clic qui crée la clé, copie sous `MAIL_FALLBACK_API_KEY`. Brevo ne sert qu'aux e-mails de sécurité (vérification, réinitialisation, mot de passe changé, invitation du personnel, numéro retiré) quand Resend est en panne, refuse sa clé, ou a épuisé son quota du jour ; sans clé Brevo, ces e-mails attendent la période suivante au lieu d'être perdus.

Offre Resend Free : 100 e-mails par jour, 3 000 par mois ; alerte à 70 %, mode dégradé à 90 % (les 10 % restants sont réservés aux e-mails de sécurité) ; les compteurs sont dans le back-office.

## 5. WhatsApp : webhook et secret de l'app (Nav, après N8)

Le site ne fait que recevoir : l'utilisateur envoie un code à 6 chiffres depuis son WhatsApp au numéro de Joutiya, le webhook de Meta le remet au site, qui valide le téléphone. Aucun envoi, aucun coût, aucun jeton Meta côté site. Un numéro ne peut être vérifié que sur un compte à la fois : s'il est prouvé depuis le même téléphone par un autre compte, il change de compte et l'ancien titulaire est prévenu par e-mail.

Ordre : **Vous :** générez d'abord `WHATSAPP_VERIFY_TOKEN` (`openssl rand -hex 32` dans un terminal, ou toute chaîne aléatoire d'au moins 32 caractères) dans `.env.local` ; puis la VM avec `WHATSAPP_VERIFY_TOKEN` et `WHATSAPP_APP_SECRET` dans `app.env` et l'application redémarrée (prompt L) ; ensuite seulement le webhook : Meta appelle l'URL immédiatement pour vérifier le jeton.

Dans developers.facebook.com → app **Joutiya** (phase 0, étape 9) :
1. **Paramètres de l'app** → **Général** → **Clé secrète** → **Afficher**. **Vous :** cette révélation et la copie sous `WHATSAPP_APP_SECRET`.
2. Nav ouvre **WhatsApp** → **Configuration** → **Webhook** → **Modifier** et saisit l'URL de rappel `https://joutiya.ma/api/webhooks/whatsapp` ; **Vous :** collez le jeton de vérification (la valeur de `WHATSAPP_VERIFY_TOKEN` de votre `.env.local`) → **Vérifier et enregistrer**. Puis **Gérer** → champ **messages** → **S'abonner**.
3. **WhatsApp** → **Configuration de l'API** : Nav rapporte le **Phone number ID** et le numéro affiché du numéro de test (`WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_DISPLAY_NUMBER` en chiffres sans `+`). Ce numéro de test ne reçoit que des numéros ajoutés à sa liste de destinataires (5 au plus) : ajoutez-y les téléphones des testeurs du staging.
4. Une app Meta n'a qu'une URL de webhook : le staging a besoin de sa propre app **Joutiya Staging** (même portefeuille, même cas d'usage WhatsApp, numéro de test, URL `https://staging.joutiya.ma/api/webhooks/whatsapp`). La production reçoit, avant le lancement, la ligne professionnelle d'Adark Prime (décision du 16 octobre 2026, à la place d'une carte SIM marocaine) : inscription du numéro sur l'API WhatsApp dans la console Meta (**Vous :** le code SMS). Attention : un numéro inscrit sur l'API peut être retiré de l'application WhatsApp du téléphone ; vérifier les options proposées par Meta à ce moment-là. Le garde-fou exige que le numéro de production diffère du numéro de test.

Le développement local n'a pas besoin de Meta : sans `WHATSAPP_DISPLAY_NUMBER`, le site utilise un numéro factice et le webhook peut être simulé (voir les tests `tests/api/phone`).

## 6. Sentry : suivi des erreurs, région UE (Nav, N14)

sentry.io → **Get started** avec votre Gmail (ou l'alias `+joutiya`) → **Data storage location : European Union** (irréversible, choisi à l'inscription) → organisation `joutiya` → offre **Developer** (gratuite, 5 000 erreurs par mois, sans carte). Puis **Projects** → **Create project** : plateforme **Next.js**, nom `joutiya-web-prod` ; de même `joutiya-web-staging`. Alertes : laisser l'alerte par défaut vers votre e-mail.

Nav rapporte le **DSN** de chaque projet (**Settings** → **Projects** → projet → **Client Keys (DSN)**) : valeur publique, `SENTRY_DSN`, dont l'hôte finit par `.ingest.de.sentry.io` (le site refuse les autres régions). Le serveur web, le worker et le navigateur partagent le projet de leur environnement ; aucune donnée personnelle, adresse IP ni cookie n'est envoyé (nettoyage dans `src/lib/observability/scrub.ts`). Pas de traçage de performance : il consommerait le quota gratuit.

## 7. Variables de la VM et redémarrage (Cody, prompt L)

Pour le staging puis la production, dans `/etc/joutiya/<env>/app.env`, en plus des variables de la phase 1 :
- les anciens noms `NEXT_PUBLIC_SITE_URL` et `NEXT_PUBLIC_FIREBASE_PROJECT_ID`, s'ils y sont encore, renommés `SITE_URL` et `FIREBASE_PROJECT_ID` (le site refuse toute variable `NEXT_PUBLIC_*` hors développement : une seule image sert le staging et la prod, la configuration est lue au démarrage) ;
- `CSRF_SECRET` généré par environnement (`openssl rand -hex 32`), différent de `HASH_PEPPER` ;
- `FIREBASE_API_KEY`, `FIREBASE_SERVER_API_KEY`, `FIREBASE_APP_ID`, `FIREBASE_SERVICE_ACCOUNT=joutiya-web@<projet>.iam.gserviceaccount.com` ;
- `GOOGLE_OAUTH_CLIENT_ID` ;
- `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` ;
- `MAIL_API_KEY` (créée par le fil de déploiement), `MAIL_WEBHOOK_SECRET`, `MAIL_FALLBACK_API_KEY`, `MAIL_FROM="Joutiya <no-reply@notif.joutiya.ma>"` ;
- `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_DISPLAY_NUMBER` ;
- `SENTRY_DSN` ;
- `MEDIA_BASE_URL=https://media.joutiya.ma` (vide tant que la phase 3 n'a pas branché R2).

Sans les variables obligatoires (`src/lib/env.ts`, liste `REQUIRED_DEPLOYED`), l'application refuse de démarrer et le journal nomme la variable manquante ; sans une variable recommandée (WhatsApp, Sentry, Brevo), elle démarre et désactive la fonction correspondante avec un avertissement.

## 8. Premier administrateur (Cody, prompt M)

Le back-office (`admin.joutiya.ma`) exige deux choses : passer Cloudflare Access avec votre compte Google (phase 1) et une session de personnel ouverte avec un mot de passe. Le premier compte administrateur est créé par `scripts/create-admin.ts` ; il invite ensuite les modérateurs depuis la page **Personnel** du back-office (ils reçoivent un e-mail avec un lien pour définir leur mot de passe). L'e-mail du compte administrateur doit être exactement celui de votre connexion Access (votre Gmail). Le compte Google de chaque membre du personnel, le vôtre compris, doit avoir la validation en deux étapes activée (myaccount.google.com → Sécurité) : Access ne l'impose pas, le cahier des charges oui.

1. Cody lance le script en simulation puis avec `--apply` (prompt M) : il crée le compte, lui donne le rôle `admin` et affiche une seule ligne, l'adresse `https://admin.joutiya.ma/connexion?mode=setPassword&oobCode=…`.
2. **Vous :** ouvrez cette adresse dans votre navigateur (connexion Access par Google), choisissez un mot de passe (12 caractères ou plus), puis connectez-vous. Le lien n'est valable qu'une heure et une seule fois.

## 9. Contrôles

- Dépôt : `npm run check`, `npm run test:api` et `npm run test:rules` (Auth + Firestore en émulateur), `npm run build` puis `npm run test:e2e`.
- Staging, après le prompt L : inscription avec une vraie adresse (l'e-mail arrive de `no-reply@notif.joutiya.ma`), lien de vérification, connexion, connexion Google, mot de passe oublié, vérification WhatsApp avec le numéro de test, connexion au back-office, invitation d'un modérateur, page **Quotas**. Sentry reçoit une erreur de test (`/fr/parametres` avec un cookie corrompu renvoie une erreur gérée, sans événement ; un événement se provoque depuis le back-office à la phase 5).
- `infra/targets.json` : Claude consigne par PR l'`appId` Firebase et `GOOGLE_OAUTH_CLIENT_ID` de chaque environnement, et les identifiants Meta (`appId` de chaque app, `wabaId`, `phoneNumberId`) ; Sentry n'a pas d'entrée dans le registre (le DSN est une valeur publique propre à chaque environnement, dans `app.env`). `node scripts/assert-target.ts` reste vert.

## Prompts Cody

À coller dans Cody, depuis le dossier du dépôt à jour (`git pull`), Node 24 ou plus récent.

**L. Variables de la phase 2 sur la VM** (étape 7)

```text
Complète les fichiers de la VM de Joutiya pour la phase 2 (docs/phase-2.md, étape 7). Ne lis ni n'affiche aucune valeur secrète : pour copier une variable de mon .env.local, utilise `grep '^NOM=' .env.local` redirigé vers l'entrée standard de `ssh joutiya "sudo sh -c 'umask 077 && cat >> <fichier>'"` (jamais par la ligne de commande, jamais sudo tee, jamais cat, head, tail ni sed sur .env.local : ta configuration les bloque). Pour le staging puis la prod : 1) dans /etc/joutiya/<env>/app.env, renomme NEXT_PUBLIC_SITE_URL en SITE_URL et NEXT_PUBLIC_FIREBASE_PROJECT_ID en FIREBASE_PROJECT_ID si ces anciens noms y sont encore ; 2) génère CSRF_SECRET (openssl rand -hex 32, différent de HASH_PEPPER) directement dans le fichier ; 3) ajoute les variables listées à l'étape 7 depuis mon .env.local (FIREBASE_API_KEY, FIREBASE_SERVER_API_KEY, FIREBASE_APP_ID, GOOGLE_OAUTH_CLIENT_ID, TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY, MAIL_WEBHOOK_SECRET, MAIL_FALLBACK_API_KEY, WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN, WHATSAPP_DISPLAY_NUMBER, SENTRY_DSN) et FIREBASE_SERVICE_ACCOUNT=joutiya-web@<projectId de infra/targets.json>.iam.gserviceaccount.com ; laisse MAIL_API_KEY telle que le fil de déploiement l'a écrite ; 4) redémarre (`docker compose … up -d web worker`), vérifie dans `docker compose … logs web` la ligne « startup checks passed » (sinon le journal nomme la variable fautive : corrige et recommence) puis `curl -s https://<hôte>/api/health`. Ne me donne aucune valeur, seulement les noms des variables écrites.
```

**M. Premier administrateur** (étape 8)

```text
Crée le premier administrateur du back-office de Joutiya (docs/phase-2.md, étape 8) dans le projet Firebase de production de infra/targets.json. Je me connecte moi-même avec `gcloud auth application-default login` sur ce projet. Lance d'abord `node --env-file=.env.local scripts/create-admin.ts --email <mon Gmail> --name "<mon prénom>"` en simulation et montre-moi ce qu'il ferait ; après mon accord, relance avec --apply. N'affiche que la ligne que le script imprime (l'adresse de définition du mot de passe) ; ne crée aucune clé, ne modifie aucun autre compte. Fais de même pour le staging si je le demande.
```
