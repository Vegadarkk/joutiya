# Reconstruire la VM

La VM ne garde aucune donnée unique (§2) : Firestore, R2, les secrets (votre gestionnaire de mots de passe et `.env.local`) et le code (GitHub) vivent ailleurs. Si elle est perdue, récupérée par Oracle ou compromise, on en crée une neuve. Comptez une heure.

Ce qui se perd : les files BullMQ et les compteurs de quotas du jour (`valkey-queue`), qui se reconstituent seuls, et les journaux des conteneurs.

## Si la VM est compromise

1. Oracle → Compute → Instances → `joutiya-vm` → **Stop**, sans supprimer le disque : il peut servir d'indice.
2. Cloudflare → Zero Trust → Networks → Tunnels : pour chacun des 3 Tunnels (`joutiya-ssh-tunnel`, `joutiya-prod-tunnel`, `joutiya-staging-tunnel`), **Rotate token**, puis supprimez ses connexions actives.
3. Remplacez tout ce qui était sur la VM : mots de passe Valkey, `HASH_PEPPER`, `ALERT_RELAY_SECRET` (et le secret du même nom dans le Worker), jeton de purge du cache, certificats Google (révoquez-les dans le magasin de confiance du pool WIF), jeton Telegram (@BotFather → `/revoke`).
4. Remplacez la clé `deploy-staging` (GitHub) et le jeton de service Access `joutiya-ci`.
5. Puis reconstruisez comme ci-dessous.

## Reconstruire

Suivez `docs/phase-1.md`, étapes 5 à 7, avec ces différences :

1. **VM** (étape 5) : même réglage. Recréez `bootstrap.local.sh` (prompt E, point 4), avec le nouveau jeton du Tunnel SSH s'il a changé.
2. **Empreinte SSH** (étape 6) : la nouvelle VM a une nouvelle clé d'hôte. Retirez l'ancienne ligne `ssh.joutiya.ma` de `~/.ssh/known_hosts`, puis mettez à jour la variable GitHub `VM_SSH_KNOWN_HOSTS`.
3. **Fichiers et secrets** (étape 6) : `node scripts/deploy-prod.ts vm-sync`, puis les fichiers `/etc/joutiya/<env>/*.env`. Si `ALERT_RELAY_SECRET` change, mettez le même dans le Worker de sonde (`wrangler secret put`).
4. **Certificats Google** (étape 7) : un nouveau certificat par conteneur, signé par votre autorité ; le pool et les comptes de service restent.
5. **Staging** : relancez le dernier déploiement (GitHub → Actions → Deploy staging → **Run workflow** sur `main`).
6. **Production** : `node scripts/deploy-prod.ts promote`.
7. **Contrôle** : `https://joutiya.ma/api/health` répond `ok`, la sonde Telegram annonce « rétabli ».

## Entretien courant

- Les mises à jour de sécurité (Ubuntu, Docker, cloudflared) s'installent seules chaque nuit. Si un redémarrage est nécessaire, il a lieu à 03:30 UTC, et les conteneurs repartent seuls.
- Une fois par mois : `ssh joutiya 'df -h / && sudo docker system df'`. Les anciennes images sont supprimées à chaque déploiement : on garde les 4 dernières versions.
- Images de base (Node, Valkey, cloudflared) : Dependabot ouvre une PR, et la CI la vérifie.
- Oracle reprend une VM gratuite inactive sur 7 jours (processeur, réseau et mémoire sous 20 %). Le trafic du site suffit après le lancement. Avant, gardez un œil sur les e-mails d'Oracle.
