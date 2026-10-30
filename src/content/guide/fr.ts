import type { GuideLocaleContent } from "./catalog";

// Admin procedures guide, French (design guide-demarches G1). Says where a procedure is done and in
// what order, never a fee, a delay or a list of pieces the administration may change: the official
// page linked below each procedure states them.

export const GUIDE_FR: GuideLocaleContent = {
  rubrics: {
    etudiant: {
      title: "Étudiants",
      summary: "Orientation après le bac, bourses, logement universitaire, couverture médicale, études en France.",
      intro: "Les aides aux étudiants relèvent de l'ONOUSC (bourses, cités universitaires, couverture médicale) et du ministère de l'Enseignement supérieur. Les demandes se font en ligne, pendant des périodes ouvertes chaque année : surveillez les calendriers publiés.",
    },
    "auto-entrepreneur": {
      title: "Auto-entrepreneurs",
      summary: "S'inscrire au statut, déclarer son chiffre d'affaires, sa protection sociale.",
      intro: "Le statut d'auto-entrepreneur permet d'exercer une activité en nom propre avec des formalités allégées : inscription au registre national, déclaration du chiffre d'affaires et paiement de l'impôt, couverture médicale. Si vous vendez sur {brand} dans le cadre d'une activité, ouvrez un compte Pro.",
    },
    vehicule: {
      title: "Vendre ou acheter un véhicule",
      summary: "Mutation de la carte grise, vignette, échange de permis, véhicule d'un MRE.",
      intro: "Une vente de véhicule entre particuliers ne s'arrête pas à la remise des clés : le changement de propriétaire (mutation) se déclare à la NARSA et le droit de timbre se paie à la DGI. Tant que la mutation n'est pas faite, le vendeur reste le propriétaire inscrit.",
    },
    immobilier: {
      title: "Acheter, vendre ou louer un logement",
      summary: "Vérifier un bien titré, signer la vente, taxes locales, bail de location.",
      intro: "Avant d'acheter, vérifiez la situation juridique du bien auprès de la conservation foncière (ANCFCC). La vente se signe chez un notaire, des adouls ou un avocat habilité, puis les droits se paient à la DGI et la vente s'inscrit au titre foncier.",
    },
    mre: {
      title: "Marocains du monde (MRE)",
      summary: "Services consulaires, immatriculation, retour définitif, procuration.",
      intro: "Depuis l'étranger, la plupart des démarches passent par le consulat de votre pays de résidence et par les services en ligne du ministère chargé des Marocains résidant à l'étranger.",
    },
    "pro-cooperative": {
      title: "Sociétés et coopératives",
      summary: "Créer une société ou une coopérative, ICE, obligations fiscales et sociales.",
      intro: "Une société s'immatricule au registre du commerce (OMPIC) et reçoit un identifiant commun de l'entreprise (ICE) ; une coopérative relève de l'ODCO. Ces numéros vous seront demandés pour un compte Pro.",
    },
    identite: {
      title: "Identité et état civil",
      summary: "CNIE, passeport, acte de naissance, casier judiciaire, nationalité, service militaire.",
      intro: "Au Maroc, la CNIE et le passeport relèvent de la DGSN et l'acte de naissance du bureau d'état civil de la commune d'inscription. À l'étranger, le consulat s'en charge.",
    },
    sante: {
      title: "Couverture médicale (AMO)",
      summary: "AMO des salariés et des indépendants, AMO Tadamon (ex-RAMED), fonctionnaires.",
      intro: "Depuis la généralisation de la protection sociale, l'assurance maladie obligatoire (AMO) couvre les salariés, les indépendants et les personnes sans revenus. La CNSS gère la plupart des régimes ; le secteur public relève encore de la CNOPS pendant son transfert vers la CNSS.",
    },
    retraite: {
      title: "Retraite",
      summary: "Pension de la CNSS, de la CMR ou du RCAR, retraite complémentaire.",
      intro: "Votre caisse de retraite dépend de votre employeur : la CNSS pour le secteur privé, la CMR pour les fonctionnaires titulaires et les militaires, le RCAR pour les contractuels et le personnel de nombreux établissements publics. Une retraite complémentaire (CIMR) peut s'y ajouter.",
    },
    "aides-sociales": {
      title: "Aides sociales (RSU)",
      summary: "Inscription au RSU, aide sociale directe, aide au logement.",
      intro: "Les aides de l'État passent par le registre social unifié (RSU) : l'inscription du foyer donne un indice socio-économique qui ouvre, ou non, l'aide sociale directe et l'AMO Tadamon. Méfiez-vous de quiconque demande de l'argent pour vous inscrire : passez uniquement par les portails officiels.",
    },
    "eau-electricite": {
      title: "Eau et électricité",
      summary: "Abonnement, changement de titulaire, résiliation, factures et réclamations.",
      intro: "La distribution de l'eau, de l'électricité et l'assainissement passent, région par région, à des sociétés régionales multiservices (SRM), qui reprennent les services de l'ONEE, des régies et des anciens délégataires comme Lydec. Dans certaines villes, l'ancien distributeur reste votre interlocuteur pendant la transition : le nom de votre distributeur figure sur votre facture.",
    },
    assurances: {
      title: "Assurances",
      summary: "Assurance auto obligatoire, accident, réclamation contre un assureur.",
      intro: "Les compagnies d'assurance sont contrôlées par l'ACAPS. En cas de désaccord avec votre assureur, adressez-lui d'abord une réclamation écrite ; si sa réponse ne vous convient pas, l'ACAPS reçoit les réclamations des assurés.",
    },
  },
  procedures: {
    "bourse-etudes": {
      title: "Demander une bourse d'études supérieures",
      body: ["La demande se dépose en ligne, en général dans les semaines qui suivent le baccalauréat. Les conditions de ressources, le calendrier et la liste des pièces sont publiés chaque année."],
    },
    "bourse-etranger": {
      title: "Bourse pour étudier à l'étranger",
      body: ["Certaines bourses financent des études hors du Maroc, dans le cadre d'accords avec d'autres pays. Les filières, les pays et les dates de dépôt changent d'une année à l'autre."],
    },
    "logement-universitaire": {
      title: "Logement en cité universitaire",
      body: ["Les places en cité universitaire s'attribuent sur demande, selon des critères publiés par l'ONOUSC."],
    },
    "amo-etudiant": {
      title: "Couverture médicale des étudiants",
      body: ["Les étudiants peuvent bénéficier de l'assurance maladie obligatoire (AMO) propre aux étudiants. L'inscription et les conditions sont expliquées sur la page officielle."],
    },
    massar: {
      title: "Suivre sa scolarité sur Massar",
      body: ["Massar est la plateforme du ministère de l'Éducation nationale : notes, résultats, et le code Massar que demandent de nombreuses démarches étudiantes."],
    },
    "ae-inscription": {
      title: "S'inscrire au statut d'auto-entrepreneur",
      body: ["L'inscription au registre national de l'auto-entrepreneur se fait sur le portail officiel du statut. Il présente aussi les activités éligibles et les plafonds de chiffre d'affaires."],
      prepare: ["Votre carte nationale (CNIE)", "La description de votre activité"],
    },
    "ae-impots": {
      title: "Déclarer et payer ses impôts",
      body: ["La DGI regroupe ses services en ligne sur un seul portail : déclarations, paiements, attestations fiscales."],
    },
    "ae-protection-sociale": {
      title: "Couverture médicale et protection sociale",
      body: ["L'assurance maladie des travailleurs non salariés, auto-entrepreneurs compris, est gérée par la CNSS."],
    },
    "ae-services": {
      title: "Toutes les démarches des entreprises",
      body: ["Les portails nationaux recensent les services en ligne destinés aux entreprises et aux professionnels."],
    },
    "vehicule-mutation": {
      title: "Changer le propriétaire (mutation)",
      body: [
        "Après la vente, la mutation inscrit l'acheteur comme nouveau propriétaire du véhicule. La NARSA explique les étapes et les pièces ; le droit de timbre de mutation se paie en ligne sur le portail de la DGI.",
        "Faites légaliser le contrat de vente et gardez-en une copie : il prouve la date à laquelle le véhicule a changé de mains.",
      ],
      prepare: ["Le contrat de vente signé par les deux parties", "La carte grise du véhicule", "Les cartes nationales du vendeur et de l'acheteur"],
    },
    "vehicule-vignette": {
      title: "Payer la vignette",
      body: ["La taxe annuelle sur les véhicules (vignette) se paie en ligne sur le portail de la DGI. Un acheteur peut demander la preuve du paiement de l'année en cours."],
    },
    "vehicule-permis": {
      title: "Échanger un permis de conduire étranger",
      body: ["Un permis obtenu à l'étranger peut s'échanger contre un permis marocain, sous conditions expliquées par la NARSA."],
    },
    "vehicule-mre": {
      title: "Venir au Maroc avec sa voiture (MRE)",
      body: ["Un Marocain résidant à l'étranger peut entrer au Maroc avec son véhicule sous le régime de l'admission temporaire. Un véhicule sous ce régime ne peut pas être vendu au Maroc sans dédouanement."],
    },
    "immo-verifier": {
      title: "Vérifier un bien avant d'acheter",
      body: ["Pour un bien titré, le certificat de propriété délivré par la conservation foncière indique le propriétaire inscrit et les charges (hypothèque, saisie). Demandez-le avant de verser quoi que ce soit."],
    },
    "immo-vente": {
      title: "Signer la vente et payer les droits",
      body: [
        "La vente d'un bien immobilier se conclut par un acte établi par un notaire, des adouls ou un avocat habilité. Les droits d'enregistrement et, pour le vendeur, l'impôt sur le profit immobilier se paient à la DGI.",
        "La vente est ensuite inscrite au titre foncier : c'est cette inscription qui rend l'acheteur propriétaire aux yeux de tous.",
      ],
    },
    "immo-taxes-locales": {
      title: "Taxe d'habitation et taxe de services communaux",
      body: ["Ces taxes locales sont émises par la Trésorerie générale du Royaume, qui permet de consulter et de payer ses avis en ligne."],
    },
    "immo-location-touristique": {
      title: "Louer un logement à des touristes",
      body: [
        "Louer un logement meublé à des touristes, même pour quelques nuits, relève de la loi 80-14 sur l'hébergement touristique : selon le type d'hébergement, une autorisation préalable d'exploitation et une assurance sont exigées. Le ministère du Tourisme publie la loi et ses textes d'application.",
        "L'exploitant vérifie l'identité de chaque client et déclare ses séjours chaque jour aux autorités. Il collecte aussi la taxe de séjour, qu'il reverse à la commune. Renseignez-vous auprès de votre commune avant la première location.",
      ],
    },
    "immo-location": {
      title: "Louer un logement",
      body: [
        "La location d'un logement est encadrée par la loi 67-12 : contrat écrit, état des lieux, dépôt de garantie plafonné. Faites légaliser les signatures du bail et gardez les reçus de loyer.",
        "Ne versez jamais d'argent pour réserver un logement que vous n'avez pas visité : c'est la première arnaque à la location.",
      ],
    },
    "mre-services": {
      title: "Services en ligne pour les MRE",
      body: ["Le ministère chargé des Marocains résidant à l'étranger regroupe les services consulaires, administratifs et judiciaires accessibles à distance."],
    },
    "mre-immatriculation": {
      title: "S'immatriculer au consulat",
      body: ["L'immatriculation consulaire est le point de départ de la plupart des démarches à l'étranger. L'annuaire officiel donne le consulat compétent pour votre adresse."],
    },
    "mre-retour": {
      title: "Retour définitif au Maroc",
      body: ["Un retour définitif ouvre droit à certaines facilités, notamment pour le déménagement et le véhicule, sous conditions détaillées par le consulat."],
    },
    "mre-procuration": {
      title: "Procuration pour vendre ou acheter un bien",
      body: ["Depuis l'étranger, vous pouvez donner procuration à une personne de confiance pour une transaction immobilière au Maroc. Lisez-la avant de signer : elle peut permettre de vendre en votre nom."],
    },
    "pro-societe": {
      title: "Créer une société",
      body: ["Le registre du commerce, tenu par l'OMPIC, immatricule les sociétés et les commerçants. L'OMPIC explique les étapes, de la réservation du nom à l'immatriculation."],
    },
    "pro-ice": {
      title: "Identifiant commun de l'entreprise (ICE)",
      body: ["L'ICE identifie l'entreprise auprès de toutes les administrations. Il figure sur ses factures et vous sera demandé pour un compte Pro."],
    },
    "pro-cooperative": {
      title: "Créer une coopérative",
      body: ["L'ODCO accompagne la création des coopératives, notamment agricoles et artisanales : statuts, cadre juridique, délégations régionales."],
    },
    "pro-obligations": {
      title: "Obligations fiscales et sociales",
      body: ["Une entreprise déclare ses impôts à la DGI et ses salariés à la CNSS, en ligne."],
    },
    "id-cnie": {
      title: "Carte nationale (CNIE)",
      body: ["Au Maroc, la CNIE se demande auprès de la DGSN, avec une prise de rendez-vous en ligne. À l'étranger, la demande passe par le consulat."],
    },
    "id-passeport": {
      title: "Passeport biométrique",
      body: ["Le passeport se demande en ligne auprès de la DGSN au Maroc, ou au consulat à l'étranger."],
    },
    "id-naissance": {
      title: "Acte de naissance",
      body: ["L'extrait ou la copie intégrale de l'acte de naissance se demande au bureau d'état civil de la commune où la naissance est inscrite, et à l'étranger au consulat."],
    },
    "id-livret": {
      title: "Livret de famille",
      body: ["Le livret de famille est délivré par l'état civil après le mariage ; à l'étranger, par le consulat."],
    },
    "id-casier": {
      title: "Extrait de casier judiciaire",
      body: ["L'extrait de casier judiciaire se demande en ligne auprès du ministère de la Justice. Le formulaire se remplit en arabe."],
    },
    "id-nationalite": {
      title: "Certificat de nationalité",
      body: ["Le certificat de nationalité se demande en ligne sur la plateforme du ministère de la Justice (en arabe)."],
    },
    "orientation-postbac": {
      title: "Candidater après le bac (écoles, médecine, classes préparatoires)",
      body: [
        "Les candidatures aux établissements à accès régulé (écoles d'ingénieurs et de commerce, médecine et pharmacie, EST, FST…) se déposent sur la plateforme nationale Cursussup, avec le code Massar. Les facultés à accès ouvert inscrivent directement leurs étudiants.",
        "Les classes préparatoires aux grandes écoles (CPGE) ont leur propre plateforme de candidature. Les calendriers sont publiés chaque année : notez les dates dès leur parution.",
      ],
      prepare: ["Votre code Massar", "Vos relevés de notes"],
    },
    "etudes-france": {
      title: "Étudier en France (Campus France, Parcoursup)",
      body: [
        "La plupart des étudiants marocains qui visent la France passent par Campus France Maroc : le parcours (plateforme Études en France ou Parcoursup) dépend de votre baccalauréat et de la formation visée. Les élèves des lycées français au Maroc candidatent en général sur Parcoursup.",
        "Une fois accepté, la demande de visa étudiant suit la procédure indiquée par Campus France.",
      ],
    },
    "amo-salaries": {
      title: "AMO des salariés et des indépendants",
      body: [
        "Les salariés du secteur privé sont déclarés à la CNSS par leur employeur ; les indépendants, les professions libérales et les auto-entrepreneurs s'immatriculent eux-mêmes et paient leurs cotisations à la CNSS.",
        "Les dossiers maladie se déposent en agence ou en ligne. Vérifiez que vos ayants droit (conjoint, enfants) sont bien déclarés.",
      ],
      prepare: ["Votre CNIE", "Votre numéro d'immatriculation à la CNSS"],
    },
    "amo-tadamon": {
      title: "AMO Tadamon (ex-RAMED)",
      body: [
        "L'AMO Tadamon a remplacé le RAMED : l'État paie la cotisation des personnes qui ne peuvent pas la payer. L'éligibilité dépend de l'indice socio-économique du foyer, calculé après l'inscription au RSU ; la CNSS gère ensuite la couverture.",
        "Si votre indice dépasse le seuil, l'AMO Achamil permet de vous affilier à la CNSS en payant vous-même la cotisation.",
      ],
    },
    "amo-fonctionnaires": {
      title: "AMO des fonctionnaires et agents publics",
      body: [
        "L'assurance maladie des fonctionnaires et agents de l'État relève de la CNOPS et des mutuelles du secteur public. La loi 54-23 transfère cette gestion à la CNSS : jusqu'à la date de transfert fixée par les textes, les dossiers restent traités par la CNOPS. Suivez les annonces officielles.",
      ],
    },
    "retraite-cnss": {
      title: "Retraite des salariés du privé (CNSS)",
      body: [
        "La CNSS verse la pension de vieillesse des salariés du secteur privé ; la demande se dépose auprès d'elle à l'approche de l'âge de départ. Le droit et le montant dépendent des jours déclarés : vérifiez régulièrement que votre employeur vous déclare.",
      ],
      prepare: ["Votre CNIE", "Votre numéro d'immatriculation à la CNSS", "Un relevé d'identité bancaire à votre nom"],
    },
    "retraite-public": {
      title: "Retraite des fonctionnaires et agents publics (CMR, RCAR)",
      body: [
        "Les fonctionnaires titulaires et les militaires cotisent à la Caisse marocaine des retraites (CMR). Les agents contractuels de l'État et des collectivités, ainsi que le personnel de nombreux établissements publics, relèvent du RCAR, géré par la CDG.",
        "Chaque caisse propose un espace en ligne pour suivre sa carrière, demander sa pension ou une pension de réversion.",
      ],
    },
    "retraite-complementaire": {
      title: "Retraite complémentaire (CIMR)",
      body: [
        "Si votre employeur adhère à la CIMR, une pension complémentaire s'ajoute à celle de la CNSS. La CIMR propose aussi une épargne retraite individuelle. La pension se demande auprès d'elle au moment du départ.",
      ],
    },
    "rsu-inscription": {
      title: "S'inscrire au RNP puis au RSU",
      body: [
        "Chaque membre du foyer s'inscrit d'abord au registre national de la population (RNP), qui délivre un identifiant numérique. Le chef de foyer inscrit ensuite le ménage au registre social unifié (RSU), en ligne ou dans un point d'enregistrement de sa commune ou de son caïdat.",
        "Le RSU calcule un indice socio-économique. Déclarez tout changement (naissance, déménagement, revenus) pour qu'il reste exact.",
      ],
      prepare: ["Les CNIE des membres majeurs du foyer", "Le livret de famille ou les actes de naissance des enfants"],
    },
    "aide-sociale-directe": {
      title: "Demander l'aide sociale directe",
      body: [
        "L'aide sociale directe verse une allocation mensuelle aux foyers éligibles selon leur indice RSU : aides liées aux enfants, à leur scolarité et à une naissance, ou montant forfaitaire par foyer. La demande se fait en ligne, une fois le foyer inscrit au RSU.",
      ],
    },
    "aide-logement": {
      title: "Aide directe à l'achat d'un logement",
      body: [
        "Le programme d'aide au logement verse une aide directe aux Marocains, résidents ou MRE, qui ne possèdent pas de logement au Maroc et achètent un logement neuf. La demande se dépose en ligne avant la signature de la vente ; l'aide est versée chez le notaire.",
        "Sur {brand}, vérifiez avec le vendeur que le logement entre dans le programme avant de vous engager.",
      ],
    },
    "energie-abonnement": {
      title: "S'abonner à l'eau et à l'électricité",
      body: [
        "L'abonnement se demande en agence ou sur l'agence en ligne du distributeur de votre ville (SRM, ancien délégataire ou ONEE selon la zone). Un logement neuf demande d'abord un branchement au réseau, à prévoir avant d'emménager.",
      ],
      prepare: ["Votre CNIE", "Le titre de propriété ou le contrat de bail", "Le numéro du compteur, s'il existe"],
    },
    "energie-gestion": {
      title: "Changer de titulaire, résilier, payer, réclamer",
      body: [
        "À un déménagement, une vente ou une location, demandez le changement de titulaire ou la résiliation de l'abonnement et relevez l'index du compteur avec l'autre partie : sinon, les consommations restent à votre nom.",
        "Les factures se consultent et se paient en ligne ; une contestation se dépose par écrit auprès du distributeur, en gardant une copie.",
      ],
    },
    "assurance-auto": {
      title: "Assurance auto : obligation et accident",
      body: [
        "L'assurance responsabilité civile est obligatoire pour tout véhicule qui circule. Après l'achat d'un véhicule sur {brand}, souscrivez votre propre contrat avant de rouler et gardez l'attestation dans le véhicule.",
        "En cas d'accident, remplissez un constat amiable avec l'autre conducteur et déclarez le sinistre à votre assureur dans le délai prévu par votre contrat.",
      ],
    },
    "assurance-reclamation": {
      title: "Réclamer contre un assureur",
      body: [
        "Adressez d'abord une réclamation écrite à votre assureur ou à son intermédiaire, en gardant une preuve d'envoi. Sans réponse ou en cas de désaccord, déposez une réclamation auprès de l'ACAPS sur sa plateforme en ligne.",
      ],
    },
    "id-service-militaire": {
      title: "Service militaire",
      body: [
        "Le service militaire concerne les jeunes de 19 à 25 ans. Lors de chaque campagne de recensement, les personnes concernées remplissent le formulaire en ligne puis reçoivent, le cas échéant, une convocation. Les cas de dispense et de report sont précisés sur le portail officiel.",
      ],
    },
  },
  sources: {
    "idarati-entreprises": "Services en ligne pour les entreprises (Idarati)",
    "idarati-logement": "Services en ligne logement et immobilier (Idarati)",
    "tourisme-hebergement": "Hébergement touristique : loi 80-14 et textes d'application (ministère du Tourisme)",
    "idarati-papiers": "Services en ligne papiers, famille et citoyenneté (Idarati)",
    "maroc-grand-public": "Services numériques pour les citoyens et les MRE",
    "maroc-entreprises": "Services numériques pour les entreprises",
    chikaya: "Réclamation auprès d'une administration",
    "dgi-teleservices": "Services en ligne de la DGI",
    "tgr-taxes-locales": "Taxe d'habitation et de services communaux",
    cnss: "Portail de la CNSS",
    "ae-portail": "Portail officiel de l'auto-entrepreneur",
    "onousc-bourses": "Les bourses de l'ONOUSC",
    "onousc-bourses-maroc": "Bourses de premier cycle au Maroc",
    "onousc-bourses-etranger": "Bourses pour les études à l'étranger",
    "onousc-logement": "Se loger dans une cité universitaire",
    "onousc-amo": "Couverture médicale des étudiants",
    mabourse: "Demande de bourse en ligne",
    massar: "Plateforme Massar",
    "narsa-mutation": "Mutation de véhicules (NARSA)",
    "narsa-permis": "Échange du permis de conduire",
    ancfcc: "Conservation foncière (ANCFCC)",
    "ancfcc-tarifs": "Tarifs de la conservation foncière",
    "mre-accueil": "Ministère des Marocains résidant à l'étranger",
    "mre-consulaire": "Prestations consulaires en ligne",
    "mre-justice": "Services administratifs et judiciaires en ligne",
    "consulat-trouver": "Trouver son consulat",
    "consulat-immatriculation": "Attestation d'immatriculation consulaire",
    "consulat-retour": "Le retour définitif au Maroc",
    "consulat-voiture": "Admission temporaire des voitures",
    "consulat-procuration": "Procuration pour transactions immobilières",
    "consulat-naissance": "Extrait d'acte de naissance (consulat)",
    "consulat-copie-integrale": "Copie intégrale de l'acte de naissance (consulat)",
    "consulat-cnie": "Première CNIE (consulat)",
    "consulat-livret": "Livret de famille (consulat)",
    "consulat-casier": "Casier judiciaire (consulat)",
    casier: "Demande d'extrait de casier judiciaire",
    nationalite: "Demande de certificat de nationalité",
    cnie: "Carte nationale (DGSN)",
    passeport: "Passeport (DGSN)",
    "odco-creer": "Créer votre coopérative",
    "odco-cadre": "Cadre juridique des coopératives",
    "odco-delegations": "Délégations régionales de l'ODCO",
    "ompic-creation": "Création et vie de l'entreprise",
    "ompic-rcc": "Services du registre du commerce",
    "ompic-ice": "Identifiant commun de l'entreprise (ICE)",
    cursussup: "Candidatures post-bac aux établissements à accès régulé (Cursussup)",
    cpge: "Candidature aux classes préparatoires (CPGE)",
    "campusfrance-procedures": "Procédures pour étudier en France (Campus France Maroc)",
    parcoursup: "Plateforme Parcoursup",
    cnops: "Portail de la CNOPS",
    rsu: "Registre social unifié (RSU)",
    rnp: "Registre national de la population (RNP)",
    asd: "Aide sociale directe",
    "daam-sakane": "Aide directe au logement",
    cmr: "Caisse marocaine des retraites (CMR)",
    "rcar-affiliation": "Affiliation et prestations du RCAR",
    "cimr-pension": "Pension de retraite de la CIMR",
    "srm-casablanca": "SRM Casablanca-Settat",
    "redal-particuliers": "Espace clients particuliers de Redal",
    "amendis-abonnement": "Branchement et abonnement (Amendis)",
    "amendis-gestion": "Gestion d'un abonnement (Amendis)",
    onee: "Office national de l'électricité et de l'eau potable (ONEE)",
    acaps: "Autorité de contrôle des assurances et de la prévoyance sociale (ACAPS)",
    "acaps-reclamation": "Déposer une réclamation contre un assureur (ACAPS)",
    tajnid: "Portail du service militaire",
  },
};
