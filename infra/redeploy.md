# Reconstruire la VM

La VM ne garde aucune donnée unique (§2) : Firestore, R2, les secrets (Cloudflare, l'environnement cloud de Claude, GitHub) et le code (GitHub) vivent ailleurs. Si elle est perdue, reprise par Oracle ou compromise, Claude en crée une neuve par API (règle n° 1, `docs/phase-1.md`). Comptez une heure.

Ce qui se perd : les files BullMQ et les compteurs de quotas du jour (`valkey-queue`), qui se reconstituent seuls, et les journaux des conteneurs.

## Si la VM est compromise

1. Claude arrête `joutiya-vm` par API, sans supprimer le disque : il peut servir d'indice.
2. Claude renouvelle par API le secret des 3 tunnels (`joutiya-ssh-tunnel`, `joutiya-prod-tunnel`, `joutiya-staging-tunnel`), ce qui coupe leurs connexions.
3. Claude remplace tout ce qui était sur la VM : mots de passe Valkey, `CSRF_SECRET`, `ALERT_RELAY_SECRET` (et le secret du même nom dans le Worker), clés d'envoi de l'application (`MAIL_API_KEY`, `MAIL_FALLBACK_API_KEY`, `MAIL_WEBHOOK_SECRET`), certificats Google (révoqués dans le magasin de confiance du pool WIF). Le jeton Telegram se révoque chez @BotFather (`/revoke`), par vous. La clé Resend du Worker de sonde n'a jamais été sur la VM : elle reste. `HASH_PEPPER` à part : s'il a fuité, les empreintes des téléphones deviennent devinables, mais le changer rend inutilisables toutes les empreintes déjà stockées (e-mails, téléphones, désabonnements) ; cela demande une migration qui les recalcule, à décider avec vous.
4. Claude remplace la clé de `deploy-staging` (secret GitHub) et le jeton de service Access `joutiya-ci`.
5. Puis il reconstruit comme ci-dessous.

## Reconstruire

1. **VM** : `node scripts/oracle-vm.ts create --apply --retry-minutes=120`, une fois l'ancienne VM supprimée. Le démarrage remet l'agent Oracle, les tunnels (jetons relus dans l'API Cloudflare), Docker et les fichiers du dépôt. Suivi : `node scripts/oracle-vm.ts status`. Si une étape échoue, `node scripts/oracle-vm.ts reboot --apply` relance tout le démarrage.
2. **Accès** : Run Command marche sans rien recréer, le groupe dynamique `joutiya-vm` couvrant toute VM du compartiment `joutiya`. Claude vérifie que l'agent répond.
3. **Empreinte SSH** : la nouvelle VM a une nouvelle clé d'hôte, lue par `status` sur la console série. Claude met à jour la variable GitHub `VM_SSH_KNOWN_HOSTS`.
4. **Fichiers et secrets** : Claude réécrit par Run Command la clé publique de `deploy-staging` et, pour le staging puis la prod, `app.env` avec `node scripts/oracle-vm.ts env <env>` (`docs/phase-1.md`, étape 16) : valeurs du registre, `CSRF_SECRET` et mots de passe Valkey neufs générés sur la VM, `ALERT_RELAY_URL` (la sonde existe déjà, et l'application ne démarre pas sans). Cody renvoie les clés de votre `.env.local` (prompt O), dont `HASH_PEPPER`, qui doit rester le même.
5. **Certificats Google** : un nouveau certificat par conteneur, signé par l'autorité ; le pool et les comptes de service restent.
6. **Staging** : Claude relance le dernier déploiement (GitHub → Actions → *Deploy staging* sur `main`).
7. **Production** : Claude promeut la version du staging par Run Command (`node scripts/oracle-vm.ts promote --apply`, qui vide aussi le cache Cloudflare).
8. **Contrôle** : `https://joutiya.ma/api/health` répond `ok`, et la sonde annonce le rétablissement.

## Entretien courant

- Les mises à jour de sécurité (Ubuntu, Docker, cloudflared, agent Oracle) s'installent seules chaque nuit. Si un redémarrage est nécessaire, il a lieu à 03:30 UTC, et les conteneurs repartent seuls.
- Une fois par mois, Claude vérifie le disque par Run Command (`df -h /` et `docker system df`). Les anciennes images sont supprimées à chaque déploiement : on garde les 4 dernières versions.
- Images de base (Node, Valkey, cloudflared) : Dependabot ouvre une PR, et la CI la vérifie.
- Oracle reprend une VM gratuite inactive sur 7 jours (processeur, réseau et mémoire sous 20 %). Le trafic du site suffit après le lancement ; avant, le staging et la sonde réduisent ce risque.
