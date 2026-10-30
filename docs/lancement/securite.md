# Audit de sécurité : procédure (D18)

Trois volets avant le lancement, puis un contrôle passif chaque semaine. Le rapport final va dans
`docs/lancement/audit-securite.md` (créé seulement avec un vrai rapport : le contrôle de lancement
le cherche).

## 1. Scan ZAP (`.github/workflows/security-scan.yml`)

- **Baseline (passif)** du staging chaque lundi à 04:17 UTC et à la demande : ZAP parcourt le site
  et lit les réponses sans rien attaquer (3 minutes d'exploration).
- **Full scan (actif)** du staging, une fois avant v1.0.0, à la demande (mode `full`) : ZAP envoie de
  vraies charges d'attaque (injections, XSS…). Le staging peut recevoir des formulaires remplis de
  charges : à lancer hors des recettes en cours. 10 minutes d'exploration, puis 55 minutes d'attaque
  au plus (5 par règle) : au-delà, le travail de 90 minutes serait coupé sans rapport.
- **Baseline de la production** après le lancement (cible `prod`, passif seulement).

Règles : `.zap/rules.tsv`. Une alerte `FAIL` fait échouer le workflow (en-têtes de sécurité, CSP,
cookies, injections SQL, XSS, injection de commande, traversée de répertoire). `10010` reste en
avertissement (`jt_consent` et `NEXT_LOCALE` sont lus ou écrits par le script de la page, voulu) et `10202` est ignorée
(la protection CSRF passe par un en-tête, pas par un champ de formulaire).
Les réponses de Cloudflare lui-même sont hors du scan : la page de blocage du WAF (qui répond à
`/sitemap*` pour tout ce qui n'est pas un robot vérifié) et ses fichiers `/cdn-cgi/` n'ont pas les
en-têtes de l'application et faisaient échouer chaque scan (30 octobre 2026).

Réglages (une fois) : `scripts/github-ci.ts seal-scan`, avec le test de charge
(`docs/lancement/charge-procedure.md`, « Une fois ») : jeton Access `joutiya-scan` en en-tête unique
`Authorization` (seul nom accepté par Access), variable `ACCESS_TOKEN_HEADER`, secret `STAGING_SCAN_ACCESS_TOKEN`,
`SECURITY_SCAN_ENABLED=true` et `SCAN_REPORT_AGE_RECIPIENT`, la clé publique [age](https://age-encryption.org)
des sauvegardes (`BACKUP_AGE_RECIPIENT`, docs/backups.md) : la clé privée, sur le PC2, ouvre aussi
les rapports.

Le dépôt, ses journaux et ses artefacts sont publics jusqu'au lancement : le journal ne montre que
le nombre d'alertes par niveau ; les rapports (JSON, HTML, sortie console) sont chiffrés pour ta
clé avant l'envoi. Lecture : télécharger l'artefact `zap-…`, puis
`age -d -i <clé privée des sauvegardes> zap-reports.tar.age | tar -x`.

## 2. Revue manuelle

Contre l'architecture §6 : liste OWASP, rôles (visiteur, particulier, pro, admin), limites de débit
(recherche, inscription, messagerie, dépôt), envois de fichiers, webhooks de paiement (phase 7),
CSP des pages publiques et privées, CORS, Access sur `admin` et `staging`. Faite par une revue Opus
du code, ses constats corrigés ou justifiés un par un dans le rapport.

## 3. HTTP Observatory

Note A ou A+ exigée, vérifiée par `scripts/launch-check.ts` sur la production
(`docs/lancement/mise-en-production.md`).

## Rapport `audit-securite.md`

Date et commit, résultats des scans (nombre d'alertes par niveau, alertes FAIL corrigées), constats
de la revue avec leur suite, note Observatory, risques acceptés et pourquoi.
