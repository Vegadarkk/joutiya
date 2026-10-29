# Mentions légales

Version {version} — en vigueur le {effectiveDate}

<!-- Rendu : valeurs entre accolades tirées de config/legal (src/lib/legal/values.ts), marqueurs if/each décrits dans src/lib/legal/template.ts. Une valeur vide n'est jamais remplacée par un texte inventé : chaque section a sa variante « Renseigné avant l'ouverture du site. ». En production, le serveur refuse de démarrer si une mention obligatoire manque (missingLegalMentions). -->

Informations d'identification de l'éditeur, de l'hébergeur et des hébergeurs de données d'{brand}, mises à disposition du public conformément à l'article 1-1 de la loi n° 2004-575 du 21 juin 2004 pour la confiance dans l'économie numérique (LCEN).

## 1. Éditeur du site {#editeur}

### 1.1 Identité {#editeur-1}

<!--if:legalForm=EI-->
{entrepreneurName}, entrepreneur individuel (EI), nom commercial {companyName}.
<!--endif-->
<!--if:legalForm!=EI-->
{companyName}, {legalForm}<!--if:shareCapital--> au capital de {shareCapital} €<!--endif-->.
<!--endif-->

### 1.2 Immatriculation {#editeur-2}

<!--if:registry=RNE-->
SIREN {siren}, immatriculé au Registre national des entreprises (RNE).
<!--endif-->
<!--if:registry=RCS-->
RCS {rcsCity} {siren}.
<!--endif-->
<!--if:siret-->
SIRET {siret}.
<!--endif-->

### 1.3 Adresse et contact {#editeur-3}

- Adresse : {address}
- Téléphone : {phone}
- E-mail : {email}

### 1.4 TVA {#editeur-4}

<!--if:vatRegime=franchise-->
TVA non applicable, article 293 B du CGI.
<!--endif-->
<!--if:vatRegime=assujetti-->
Numéro de TVA intracommunautaire : {vatNumber}.
<!--endif-->

## 2. Directeur de la publication {#directeur}

<!--if:publicationDirector-->
Directeur de la publication : {publicationDirector}.
<!--endif-->
<!--if:!publicationDirector-->
Renseigné avant l'ouverture du site.
<!--endif-->

## 3. Hébergeur {#hebergeur}

<!--if:hostComplete-->
{hostName} : {hostAddress}, téléphone {hostPhone}.
<!--endif-->
<!--if:hostPartial-->
{hostName} : coordonnées renseignées avant l'ouverture du site.
<!--endif-->
<!--if:hostMissing-->
Renseigné avant l'ouverture du site.
<!--endif-->

## 4. Hébergement des données {#donnees}

Les données traitées directement par l'éditeur (comptes, annonces, messages, photos) sont stockées par les prestataires ci-dessous, même à titre gratuit. Cette liste est mise à jour quand un prestataire change. La liste complète des sous-traitants, de leur rôle et des transferts de données figure dans la [politique de confidentialité](/legal/confidentialite).

<!--each:dataHosts-->
<!--if:entry.complete-->
- {entry.label} : {entry.address}, téléphone {entry.phone}
<!--endif-->
<!--if:entry.partial-->
- {entry.label} : coordonnées renseignées avant l'ouverture du site.
<!--endif-->
<!--if:entry.noName-->
- Renseigné avant l'ouverture du site.
<!--endif-->
<!--endeach-->
<!--if:!dataHosts-->
Renseigné avant l'ouverture du site.
<!--endif-->

## 5. Contacts {#contacts}

- Point de contact unique pour les autorités et les utilisateurs (règlement (UE) 2022/2065, « DSA ») : {dsaContactEmail}, langues acceptées : {dsaContactLanguages}. Voir [Contact autorités (DSA)](/legal/contact-autorites).
- Abus techniques (hameçonnage, piratage, faille de sécurité) : {abuseEmail}.
- Données personnelles : {dpoContact}.
- Contact général : {email}.
<!--if:consumerMediator.name-->
- Médiateur de la consommation : {consumerMediator.name} ({consumerMediator.url}).
<!--endif-->

<!--if:cndpReceiptNo-->
Les traitements qui concernent les personnes situées au Maroc ont fait l'objet d'une déclaration auprès de la Commission nationale de contrôle de la protection des données à caractère personnel (CNDP), récépissé n° {cndpReceiptNo}.
<!--endif-->

## 6. Rôle d'{brand} {#role}

### 6.1 Un service d'hébergement d'annonces {#role-1}

{brand} héberge les annonces publiées par ses utilisateurs. Elle n'est ni vendeur, ni acheteur, ni mandataire, et elle n'est pas partie aux contrats conclus entre utilisateurs. Elle n'encaisse aucun paiement entre utilisateurs. L'annonceur est toujours indiqué et reste seul responsable de son annonce et de la transaction qui s'ensuit (voir les [CGU](/legal/cgu#role)).

### 6.2 Responsabilité {#role-2}

Pour les contenus fournis par les utilisateurs, {brand} relève du régime des hébergeurs : elle n'exerce pas de surveillance générale des contenus (art. 8 du DSA) et agit promptement pour retirer un contenu illicite dont elle a effectivement connaissance. Ce régime ne couvre pas ses obligations propres, notamment en matière de données personnelles. {brand} répond de ses propres obligations et de la bonne exécution des options qu'elle vend (voir les [CGU](/legal/cgu#responsabilite)).

Rien dans les présentes ne limite la responsabilité d'{brand} en cas de faute lourde, de dol ou de dommage corporel, ni les droits que la loi accorde au consommateur.
