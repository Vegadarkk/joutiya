# Mise en production d'une version (D21)

Une version de production est un **tag de release annoté** (`vX.Y.Z`, ou `vX.Y.Z-rc.N` pour une
candidate) posé sur un commit de `main` que la CI a déjà construit et envoyé au staging. Rien ne part
en production sans tag. Pousser un tag et promouvoir la production attendent ton feu vert.

## Étapes

1. **Version** : `package.json` porte le numéro de la version (`1.0.0` pour le lancement). Un
   changement de numéro passe par une PR, comme le reste. Pour le lancement, la même PR remet les
   textes légaux à zéro (spec §10) : dans `src/config/legal-versions.ts`, chaque page (sauf les CGV
   provisoires) en version `1.0`, en vigueur le jour de l'ouverture, sans `replaces` ni résumé, et
   `LEGAL_TEXTS_FROZEN = true` ; puis `node scripts/legal-hash.ts --apply` enregistre les empreintes
   des textes. Ensuite, tout changement d'un texte demande une nouvelle version (CGU §22 : annonce
   `announced`, résumé FR/AR, 30 jours de préavis, texte sortant copié dans
   `src/content/legal/{fr,ar}/archive/` et listé dans `LEGAL_ARCHIVE`, qui le garde en ligne), ou
   `--form-only` pour une simple correction de forme.
2. **Staging** : le commit à publier tourne en staging (*Deploy staging* vert, contrôle « Release
   images » présent sur le commit) et a été vérifié dans le staging.
3. **Tag** (après ton feu vert) :
   ```
   git tag -a v1.0.0 <commit> -m "Joutiya 1.0.0"
   git push origin v1.0.0
   ```
   Le workflow *Release* (`.github/workflows/release.yml`) vérifie que le tag est annoté, au bon
   format, sur un commit de `main`, que `package.json` porte le même numéro, et que ce commit a bien
   été envoyé au staging par la CI. Il publie alors une *GitHub Release* (notes générées, empreinte de
   l'archive des images). Un tag refusé se supprime (`git push origin :refs/tags/v1.0.0`) et se recrée.
4. **Production** (après ton feu vert) :
   ```
   NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts promote --tag=v1.0.0          # simulation
   NODE_USE_ENV_PROXY=1 node scripts/oracle-vm.ts promote --tag=v1.0.0 --apply
   ```
   Refusé si le staging ne tourne pas sur le commit du tag, si ses images ne viennent pas de l'archive
   enregistrée par la CI, ou si le commit n'est pas sur `main`. Retour arrière : `rollback --apply`.
5. **Contrôle de lancement** (lecture seule, sans clé) :
   ```
   NODE_USE_ENV_PROXY=1 node scripts/launch-check.ts --tag=v1.0.0
   ```
   Contrôles automatiques (code de sortie 1 si l'un échoue) :
   - `/api/health` répond `ok` avec la version du tag. La production démarre seulement si ses
     contrôles de démarrage passent (mentions légales complètes, cibles, environnement) : une réponse
     `ok` les prouve ;
   - `/api/config` : production, publicité `off` jusqu'à l'ouverture d'AdSense (`--ads=test|live`
     ensuite), Turnstile, connexion Google et Firebase configurés ;
   - la page d'accueil applique sa CSP (pas en `report-only`) et HSTS ;
   - note A ou A+ à l'HTTP Observatory de MDN (un balayage public, au plus un par minute) ;
   - répétition B de la restauration notée dans `docs/backups.md`, test de charge
     (`docs/lancement/charge.md`) et audit de sécurité (`docs/lancement/audit-securite.md`) présents ;
   - textes légaux remis à zéro : versions `1.0` en vigueur le jour de l'ouverture (aujourd'hui, ou
     `--opening=AAAA-MM-JJ`), textes figés et empreintes à jour.

   Il liste ensuite ce qu'aucune adresse publique ne montre, à confirmer à la main : application
   OAuth de production publiée dans Google Auth Platform, `salesEnabled=false` et offre de lancement
   Pro au back-office, aucune alerte « Sauvegarde Firestore trop ancienne », seuils anti-abus et
   listes de modération changés, tarifit relu par un locuteur natif, annonces exemple posées en
   production seulement sur feu vert du propriétaire (`docs/staging-demo.md`), règles Firestore de production déployées, dépôt
   repassé en privé le jour de l'ouverture, contournement du test de charge retiré
   (`docs/lancement/charge-procedure.md` : règle Cloudflare `loadtest` désactivée et `zone --check`
   propre, `LOADTEST_BYPASS_SECRET` retiré de l'`app.env` du staging, secret GitHub
   `LOADTEST_BYPASS_SECRET` supprimé et variable `LOAD_TEST_ENABLED` retirée).
6. **Ouverture** : quand tout est vert et coché.

## Écarts avec le design

- Le workflow ne lit pas `/api/health` du staging : le staging est derrière Cloudflare Access, et le
  jeton de la CI n'ouvre que `ssh.joutiya.ma`. Le contrôle « Release images » prouve que la CI a
  envoyé ce commit au staging, et `promote --tag` vérifie sur la VM que le staging tourne bien dessus.
- La note de l'HTTP Observatory est vérifiée par `launch-check.ts`, après la promotion, et non par le
  workflow : au moment du tag, la production tourne encore sur l'ancienne version, ou sur rien avant
  le lancement.
