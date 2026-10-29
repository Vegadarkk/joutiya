import type { GuideLocaleContent } from "./catalog";

// Admin procedures guide, French (design guide-demarches G1). Says where a procedure is done and in
// what order, never a fee, a delay or a list of pieces the administration may change: the official
// page linked below each procedure states them.

export const GUIDE_FR: GuideLocaleContent = {
  rubrics: {
    etudiant: {
      title: "Étudiants",
      summary: "Bourses, logement universitaire, couverture médicale et suivi de scolarité.",
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
      summary: "CNIE, passeport, acte de naissance, casier judiciaire, nationalité.",
      intro: "Au Maroc, la CNIE et le passeport relèvent de la DGSN et l'acte de naissance du bureau d'état civil de la commune d'inscription. À l'étranger, le consulat s'en charge.",
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
  },
};
