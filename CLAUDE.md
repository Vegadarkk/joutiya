# Joutiya — instructions pour Claude Code

Marketplace de petites annonces C2C/B2C au Maroc, sur le modèle de Leboncoin.fr
(recherche multicritères, annonces multi-photos, messagerie, comptes pro, options
payantes, abonnements Pro RevenueCat, emplacements Google Ads, modération).

## Réponses

- Français. La réponse d'abord, sans préambule ni récapitulatif. Pas de long
  rapport sauf demande explicite.
- Neutre et factuel : ne pas aller dans le sens du owner par défaut. Si une
  décision est discutable, le dire, faits à l'appui, et recommander l'option la
  plus solide.
- Pas d'avertissement du type « je ne suis pas avocat/médecin ».

## État du projet (2026-10-05)

- Aucun code applicatif. L'architecture (stack exacte, arborescence, schémas BDD,
  roadmap MVP) doit être **validée par le owner avant toute génération de code**.
- Le logo est choisi par le owner parmi plusieurs concepts avant intégration.
- Section « Architecture » ci-dessous : à compléter après validation.

## Architecture

_Non validée. Ne pas inventer de stack ni de structure de dossiers._
Services prévus (non configurés) : Firestore (Auth + BDD), Cloudflare (CDN +
médias), RevenueCat, Google Ads, Hostinger (déploiement, domaine joutiya.ma).

## Règles impératives

- **Services tiers** : n'utiliser que des projets dédiés « Joutiya » créés pour
  l'occasion. Ne jamais écrire dans un projet existant de ces comptes.
- **Secrets** : jamais de clé, token ou `.env` dans Git, les PR, les logs ou le
  chat. Seul `.env.example` (sans valeurs) est versionné.
- **Légal** : éditeur Adark Prime ; seule adresse affichable : 6 rue d'Armaillé,
  75017 Paris. Ne jamais utiliser ni demander d'adresse personnelle. Forme
  juridique, capital et TVA = variables de config, jamais en dur. La plateforme
  est un hébergeur neutre (clauses de non-responsabilité entre acheteurs et
  vendeurs).
- **Sécurité** : OWASP dès la conception (XSS, CSRF, injections Firestore, CORS
  strict, uploads assainis), rate limiting (recherche, inscription, messagerie,
  dépôt d'annonce), rôles étanches visiteur / particulier / pro / admin.

## Économie de contexte

- Lire seulement les fichiers nécessaires ; s'appuyer sur ce fichier plutôt que
  re-scanner le dépôt.
- Ne pas lire `node_modules/`, `.next/`, `dist/`, `build/`, `coverage/`, ni les
  lockfiles sauf besoin précis.
- Déléguer les sorties volumineuses (tests, logs, docs web) à un sous-agent qui
  ne renvoie qu'un résumé.
- Garder ce fichier sous 200 lignes ; une procédure spécialisée va dans un Skill
  (`.claude/skills/`), pas ici.

# Compact instructions

Conserver : décisions du owner, fichiers modifiés, erreurs non résolues,
prochaine étape. Abandonner les sorties d'outils déjà exploitées.
