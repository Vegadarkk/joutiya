# Joutiya

Plateforme web de petites annonces et de seconde main au Maroc (C2C / B2C), domaine `joutiya.ma`.

Éditeur : Adark Prime, 6 rue d'Armaillé, 75017 Paris.

## État du projet

Initialisation. L'architecture du MVP (stack, arborescence, schémas de données, feuille de route) est en cours de validation avant toute génération de code applicatif.

## Sécurité du dépôt

- Aucun secret ne doit être commité. Les variables nécessaires sont décrites dans [`.env.example`](.env.example) ; copiez-le en `.env.local` (ignoré par Git) et renseignez les valeurs.
- Le [`.gitignore`](.gitignore) exclut les fichiers d'environnement, clés, comptes de service, artefacts de build et dossiers de dépendances.
- Chaque push et pull request est analysé par [Gitleaks](https://github.com/gitleaks/gitleaks) (`.github/workflows/secret-scan.yml`). En cas de fuite détectée, révoquez immédiatement la clé concernée chez le fournisseur : la supprimer de Git ne suffit pas.
- Chaque service tiers (Firebase/GCP, Cloudflare, RevenueCat, Google, Hostinger) utilise un projet ou un espace dédié « Joutiya », avec des jetons à portée minimale.

Pour signaler une faille, voir [SECURITY.md](SECURITY.md).
