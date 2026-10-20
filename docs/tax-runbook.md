# Guide fiscal et paiements

Pour l'éditeur (Adark Prime, EI, 6 rue d'Armaillé, 75017 Paris). Ce guide dit quoi déclarer, où, quand, et avec
quel export du back-office. Il s'appuie sur la recherche de la phase 7 (`fiscalite-legal.md`, 16 octobre 2026) :
plusieurs points y restent « à confirmer », repris ici tels quels. La relecture juridique (Z8) reste le filet de
sécurité.

Les ventes sont fermées en production (`salesEnabled=false`). Rien ici n'est dû tant qu'aucune vente n'a eu lieu,
sauf la réception des factures électroniques (section 7).

## 1. Avant d'ouvrir les ventes

Chaque ligne est une condition de la porte « Ouverture des ventes » (spec §10).

- [ ] **DGI Maroc** : inscription gratuite au téléservice « Taxation on digital services » (portail SIMPL), avec
      l'identifiant fiscal obtenu. Poser par écrit les questions de la section 2.
- [ ] **Guichet unique (INPI)** : formalité de « modification » pour ajouter l'activité de plateforme et de
      publicité, dans le mois qui suit son début. Code APE à vérifier avec l'INSEE (6312Z ou 7311Z).
- [ ] **URSSAF** : confirmer la catégorie (BIC prestations de services à 21,2 %, ou BNC) et le rythme de
      déclaration (mensuel ou trimestriel).
- [ ] **Médiateur de la consommation** : adhésion (par exemple CM2C, environ 48 EUR HT pour 3 ans), puis ses
      coordonnées dans les CGV.
- [ ] **CGV** : la version provisoire est en ligne (`/legal/cgv`). Elle doit être relue, puis complétée avec le
      médiateur.
- [ ] **Fonction de rétractation en ligne** : un formulaire, avec un accusé de réception sur support durable. Ce
      n'est pas encore codé : aujourd'hui, le remboursement de crédits se demande par e-mail.
- [ ] **Remboursement partiel** : rembourser les seuls crédits non utilisés d'un pack. Aujourd'hui, un
      remboursement retire le pack entier, à corriger dans le code (débit au prorata du montant remboursé).
- [ ] **Stripe** : accord écrit de Stripe sur la vente de crédits (activité « restreinte », pas interdite),
      activation du mode live, puis les clés de la section 10.
- [ ] **Test réel** avec des cartes de 4 banques marocaines (paiement en MAD).
- [ ] **Plateforme agréée (PA)** choisie pour la réception des factures électroniques (section 7).

L'ouverture peut se faire en deux temps : d'abord les Pros assujettis à la TVA marocaine, puis les packs aux
particuliers une fois l'inscription DGI faite.

## 2. Maroc : TVA sur les services numériques (art. 115 bis CGI)

- **Qui** : un prestataire non résident qui vend un service à distance à un client marocain non assujetti. Cela
  couvre les packs de crédits achetés en dirhams par des particuliers au Maroc.
- **Taux** : 20 %, compris dans le prix des packs en MAD. Il n'y a pas de TVA à déduire.
- **Déclaration** : chaque trimestre, avec le paiement, avant la fin du mois qui suit (fin avril pour T1). Elle
  se fait sur le téléservice DGI.
- **Registre** : chaque vente, ligne à ligne, tenu à disposition de la DGI et conservé 10 ans. Les commandes sont
  gardées 10 ans dans `orders`.
- **Exports** :
  - « Totaux DGI du trimestre » : le chiffre d'affaires HT et la TVA, par segment et par taux. La ligne
    « Total MAD » donne les montants à déclarer.
  - « Registre DGI » : le détail ligne à ligne. Les remboursements y sont des lignes négatives, datées du jour du
    remboursement.
- **À confirmer auprès de la DGI** :
  - Les Pros marocains : l'export compte leurs abonnements en B2B, sans TVA marocaine collectée. Selon une
    lecture, le Pro assujetti autoliquide (art. 115) ; selon une autre, le Pro non assujetti retient à la source
    (art. 117-III).
  - La devise de la déclaration, le jour exact de l'échéance, les pénalités et la TVA sur les crédits prépayés.
  - Si un représentant fiscal est obligatoire (il paraît facultatif).

## 3. France : URSSAF (micro-entreprise)

- **Base** : le chiffre d'affaires encaissé, en euros, du mois ou du trimestre.
- **Export URSSAF** :
  - Les lignes de détail sont les mouvements Stripe de la période : paiements, remboursements, litiges. Les frais
    Stripe et les virements n'y sont pas.
  - Trois lignes de total suivent :
    - l'encaissé ;
    - la TVA marocaine des ventes de la période, convertie au taux moyen de ses encaissements en MAD ;
    - l'encaissé net de cette TVA. Une vente encaissée en dirhams arrive en euros sur Stripe, au taux du jour
      d'encaissement.
- **À confirmer avec l'URSSAF ou le SIE** :
  - Faut-il déclarer l'encaissé net de la TVA marocaine (lecture probable : c'est une taxe collectée pour l'État
    marocain) ?
  - La catégorie BIC ou BNC.
- **Plafond micro-entreprise** : 83 600 EUR de prestations de services par an (2026). On n'en sort qu'après deux
  années de dépassement.

## 4. TVA française : franchise en base

- **Seuils 2026 (services)** :
  - 37 500 EUR : au-delà, la TVA s'applique au 1er janvier suivant.
  - 41 250 EUR : au-delà, la TVA s'applique dès le jour du dépassement.
- **Mention obligatoire** sur chaque facture, tant que la franchise s'applique : « TVA non applicable, article
  293 B du CGI ».
- **Compteur** : la page « Ventes » du back-office montre l'encaissé de l'année. Une alerte part à 70 % puis à
  100 % du seuil.
  - Le compteur prend tout l'encaissé, ventes au Maroc comprises, ce qui est prudent. On ne sait pas encore si
    les ventes situées hors de France comptent (question au SIE).
  - S'il s'avère qu'elles ne comptent pas, le compteur surestime : le chiffre à retenir est alors celui des seules
    ventes situées en France.
- **À 100 %** : voir le comptable avant d'émettre la facture suivante. La fin de la franchise oblige à facturer la
  TVA française sur les ventes situées en France, et à s'inscrire à l'OSS pour les ventes aux particuliers de l'UE.

## 5. Ventes aux particuliers de l'UE : seuil de 10 000 EUR

- **Le seuil** : en dessous de 10 000 EUR HT par année civile de ventes numériques aux particuliers des autres pays
  de l'UE, les règles françaises s'appliquent, donc la franchise. Au-delà, c'est la TVA du pays de l'acheteur, par
  le guichet OSS, et la franchise ne la couvre pas.
- **Compteur** : les packs en euros payés depuis le 1er janvier, recomptés chaque nuit. Les packs remboursés ne
  comptent pas.
- **Alertes** : à 70 %, puis à 100 %.
- **À 100 %** : les packs en euros disparaissent de la grille et leur paiement est refusé, jusqu'au 1er janvier.
  Pour les rouvrir plus tôt, il faut s'inscrire à l'OSS, puis faire un changement de code (TVA par pays).
- **Simplification à connaître** : le compteur prend tous les packs en euros, y compris ceux achetés depuis la
  France, ce qui est prudent. La règle exacte vaut pour l'année en cours et la précédente.

## 6. Factures et reçus

- **Abonnements Pro** : Stripe émet la facture, que le Pro retrouve dans son espace (« Mes factures »). Les
  mentions à faire figurer :
  - côté émetteur : Adark Prime, EI, SIREN, adresse 6 rue d'Armaillé, 75017 Paris ;
  - une numérotation continue, la date d'émission et de prestation, la désignation, les montants HT et TTC ;
  - la mention de franchise de la section 4 ;
  - pour un client marocain : sa raison sociale, son ICE et son IF.
  - Depuis le 1er septembre 2026, s'y ajoutent pour un client français : son SIREN, la catégorie d'opération
    (services) et l'option pour le paiement de la TVA d'après les débits.
- **Packs de crédits** : RevenueCat envoie un reçu par e-mail, en anglais.
- **Avoirs** : un avoir Stripe sur une facture déjà payée n'apparaît pas dans les exports. Il est à reporter à la
  main, en négatif, sur la période de l'avoir. Un remboursement passé par Stripe, lui, apparaît dans l'export
  URSSAF.

## 7. Facturation électronique et e-reporting

- **Depuis le 1er septembre 2026** : pouvoir recevoir des factures électroniques, par une plateforme agréée
  (liste sur impots.gouv.fr).
- **À partir du 1er septembre 2027 (micro-entreprises)** :
  - émission des factures électroniques entre entreprises françaises (peu probable ici) ;
  - e-reporting des ventes aux particuliers (en France et à l'étranger), en chiffre d'affaires par jour et par
    taux ;
  - e-reporting des ventes à des entreprises étrangères.
- **Stripe** n'est pas une plateforme agréée : ses factures restent valables pour les clients étrangers, mais
  l'e-reporting passe par la PA.
- **Export e-reporting** : les ventes par jour (heure de Paris), segment, pays de taxation et taux, prêtes à
  transmettre. Le format exact dépend de la PA retenue.

## 8. Les exports en pratique

- **Où** : back-office, menu « Ventes » (administrateurs seulement). Chaque téléchargement est inscrit au journal
  d'audit.
- **Format** : CSV pour Excel ou LibreOffice, point-virgule entre les cellules, virgule décimale, UTF-8.
- **Périodes** :
  - un trimestre (`2027-T1`) pour les deux fichiers DGI ;
  - un mois (`2027-03`) ou un trimestre pour URSSAF et l'e-reporting.
  - Les bornes sont en heure UTC. Une vente faite juste après minuit, heure de Paris, le 1er du mois, peut donc
    tomber dans le mois précédent. Les colonnes « Date (Maroc) » et « Date (Paris) » donnent la date locale.
- **Ce qu'il faut** :
  - Les abonnements et l'export URSSAF lisent Stripe. Sans clé Stripe, les fichiers DGI ne contiennent que les
    packs, et l'export URSSAF est refusé.
  - Une opération Stripe qui n'est pas réglée en euros arrête l'export, avec une erreur : le compte Stripe doit
    régler en EUR.
- **Calendrier type** :
  - Fin avril, juillet, octobre et janvier : déclaration DGI du trimestre écoulé (Totaux DGI, registre en
    archive).
  - Chaque mois ou trimestre, selon l'option : déclaration URSSAF (export URSSAF).
  - Chaque mois : archiver les quatre fichiers (10 ans pour le registre DGI).

## 9. Tâches de nuit et alertes

Les heures sont en UTC. Les alertes arrivent sur Telegram.

- **04:35, `pro-plans`** : mise à jour des abonnements Pro, fin des délais de grâce, fin de l'offre de lancement.
- **05:05, `reconcile-billing`** : rattrapage de ce que les webhooks ont manqué.
  - Ce qu'il traite :
    - les événements bloqués depuis plus de 3 heures ;
    - les événements Stripe non livrés ;
    - les abonnements Stripe actifs sans copie à jour ;
    - les achats de packs RevenueCat des 7 derniers jours.
  - Ce que disent les alertes :
    - Une alerte P2 signale une réparation : rien à faire, sauf si elle revient chaque nuit.
    - Une alerte P1 signale un problème que la tâche n'a pas pu régler (un achat introuvable, une clé sans le bon
      droit) : à regarder dans la journée.
- **05:20, `billing-thresholds`** : les deux compteurs des sections 4 et 5. Chaque niveau n'alerte qu'une fois par
  an.

## 10. Clés Stripe et RevenueCat

Chaque clé est créée par toi dans le tableau de bord (2FA), une à la fois, et rangée dans `.env.local` sous le nom
indiqué. Le fil qui t'y accompagne donne la ligne exacte. Aucune valeur ne passe dans le chat ni dans Git.

- **Clé d'installation Stripe** (`JOUTIYA_STRIPE_SETUP_KEY`) :
  - C'est une clé restreinte de courte durée : `rk_test_` pour le staging, `rk_live_` pour la prod.
  - Droits en écriture : Products, Prices, Customer portal, Webhook endpoints. Droit en lecture : le compte.
  - Elle sert à `node --env-file=<fichier> scripts/stripe-setup.ts <staging|prod> --apply --secret-file <nouveau
    fichier>`, qui demande ton accord avant de tourner.
  - Le script affiche les identifiants de prix à reporter dans `config/pricing.plans`, et écrit
    `STRIPE_WEBHOOK_SECRET` dans le fichier indiqué.
  - Une fois le script passé, révoque la clé.
- **Clé Stripe de l'application** (`STRIPE_SECRET_KEY`) : une clé restreinte, avec ces droits :
  - écriture : Customers, Checkout Sessions, Customer portal ;
  - lecture : Subscriptions, Invoices, Events, Charges, Disputes, Balance transactions (les intitulés du tableau
    de bord peuvent différer, à vérifier à la création).
- **Clé secrète RevenueCat** (`REVENUECAT_SECRET_API_KEY`), API v2, droits en lecture :
  - `customer_information:purchases:read` et `customer_information:subscriptions:read` ;
  - pour le rattrapage des packs, la lecture des produits (`project_configuration:products:read`, intitulé à
    vérifier). Sans ce droit, les achats manqués sont signalés en P1 au lieu d'être crédités.
- **`config/pricing`** :
  - Le prix des packs et des offres, les identifiants de prix Stripe, la date de fin de l'offre de lancement
    (`launchOffer.endsAt`).
  - Les prix des abonnements sont hors taxes. Ceux des packs en MAD comprennent la TVA marocaine.
  - Changer un prix d'abonnement suppose de relancer `stripe-setup.ts`, qui crée le nouveau prix.
