# Joutiya

Plateforme web de petites annonces et de seconde main au Maroc (C2C / B2C), domaine `joutiya.ma`.

Éditeur : Adark Prime, 6 rue d'Armaillé, 75017 Paris.

## État du projet

Architecture v3 validée le 12 octobre 2026. Phase 0 en cours : ouverture des comptes gratuits dédiés à Joutiya, pas à pas dans [`docs/phase-0.md`](docs/phase-0.md).

## Sécurité du dépôt

- Aucun secret ne doit être commité. Les variables nécessaires sont décrites dans [`.env.example`](.env.example) ; copiez-le en `.env.local` (ignoré par Git) et renseignez les valeurs.
- Le [`.gitignore`](.gitignore) exclut les fichiers d'environnement, clés, comptes de service, artefacts de build et dossiers de dépendances.
- Chaque push et pull request est analysé par [Gitleaks](https://github.com/gitleaks/gitleaks) (`.github/workflows/secret-scan.yml`). En cas de fuite détectée, révoquez immédiatement la clé concernée chez le fournisseur : la supprimer de Git ne suffit pas.
- Chaque service tiers utilise une ressource neuve dédiée à Joutiya, avec des jetons à portée minimale. Leurs identifiants exacts sont consignés dans [`infra/targets.json`](infra/targets.json) ; `scripts/assert-target.ts` arrête l'application et la CI au moindre identifiant différent.

Pour signaler une faille, voir [SECURITY.md](SECURITY.md).
