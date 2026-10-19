// Provisional legal texts (§7), French (authoritative language). Final texts are written in
// phase 6 from the official models (CNIL, CNDP, European Commission) and reviewed by a lawyer at
// first revenue (Z8). Placeholders in braces are filled from config/legal at render time.
// "mentions-legales" is not here: it is rendered from config/legal directly.

import type { LegalSlug } from "@/config/legal-pages";

/** A paragraph, a list, or a paragraph rendered only when the value `ifSet` names is not empty (an optional mention). */
export type Block = string | { list: string[] } | { text: string; ifSet: keyof LegalValues };

export interface LegalSection {
  id: string;
  heading: string;
  blocks: Block[];
}

export interface LegalText {
  updated: string;
  intro?: string;
  sections: LegalSection[];
}

const SAFEGUARD =
  "Rien dans les présentes ne limite la responsabilité de Joutiya en cas de faute lourde, de dol ou de dommage corporel, ni les droits que la loi accorde au consommateur.";

export const LEGAL_TEXTS: Record<Exclude<LegalSlug, "mentions-legales">, LegalText> = {
  cgu: {
    updated: "2026-10-13",
    intro:
      "Les présentes conditions encadrent l'utilisation de Joutiya, service de petites annonces édité par {publisher} ({address}). En utilisant le site, vous les acceptez.",
    sections: [
      {
        id: "role",
        heading: "Le rôle de Joutiya",
        blocks: [
          "Joutiya met en relation des personnes qui souhaitent vendre, acheter, donner ou échanger des biens et des services. Joutiya héberge les annonces publiées par ses utilisateurs.",
          "Joutiya n'est ni vendeur, ni acheteur, ni mandataire, et n'est pas partie aux contrats conclus entre utilisateurs. Elle n'encaisse aucun paiement entre utilisateurs et ne connaît pas le prix final des ventes.",
        ],
      },
      {
        id: "comptes",
        heading: "Inscription et comptes",
        blocks: [
          "L'inscription est réservée aux personnes majeures. Chaque personne ne détient qu'un compte de particulier. Les informations fournies doivent être exactes et tenues à jour ; vous êtes responsable de la confidentialité de vos identifiants.",
          "Un professionnel (vente habituelle ou à titre lucratif) doit ouvrir un compte Pro et se présenter comme tel. Se présenter faussement comme un particulier est interdit par la loi.",
          "Lors de l'inscription, vous consentez expressément aux transferts de données décrits dans la politique de confidentialité, dont ceux vers les États-Unis.",
        ],
      },
      {
        id: "annonces",
        heading: "Publication des annonces",
        blocks: [
          "L'annonceur est seul responsable du contenu de son annonce et de la transaction qui s'ensuit. Il garantit qu'il a le droit de vendre le bien, que la description, le prix et les photos sont exacts et que les photos sont les siennes.",
          {
            list: [
              "une annonce concerne un seul bien ou service, dans la bonne catégorie et la bonne ville ;",
              "aucune donnée personnelle d'un tiers (photo reconnaissable, nom, numéro) sans son accord ;",
              "aucune donnée sensible : santé, opinions politiques ou religieuses, orientation sexuelle, origine ;",
              "aucun objet ou contenu interdit (voir la page « Objets interdits ») ;",
              "une annonce reste en ligne {ttlDays} jours ; elle peut être renouvelée.",
            ],
          },
        ],
      },
      {
        id: "moderation",
        heading: "Modération",
        blocks: [
          "Avant publication, chaque annonce fait l'objet d'un contrôle automatique (objets interdits, données sensibles, risque d'arnaque, photos), assisté par une intelligence artificielle. Toute sanction contre un compte est décidée par une personne, jamais par l'IA seule.",
          "Joutiya n'exerce pas de surveillance générale des contenus. Elle agit promptement dès qu'un contenu illicite lui est signalé, et motive chacune de ses décisions (retrait, restriction, suspension), avec les voies de recours disponibles.",
        ],
      },
      {
        id: "signalement",
        heading: "Signalement",
        blocks: [
          "Chaque annonce, profil et message comporte un bouton « Signaler ». Le signalement indique le motif, l'emplacement exact du contenu et, sauf pour certaines infractions graves, le nom et l'adresse e-mail de son auteur.",
          "Les signalements manifestement infondés et répétés peuvent entraîner la suspension temporaire du traitement des signalements de leur auteur.",
        ],
      },
      {
        id: "sanctions",
        heading: "Sanctions et recours",
        blocks: [
          "Selon la gravité : retrait de l'annonce, limitation de la visibilité, suspension du compte jusqu'à 30 jours, ou fermeture définitive du compte.",
          "Vous pouvez contester une décision pendant 6 mois depuis votre compte, ou par le lien reçu avec la décision. Le recours est examiné par une autre personne que celle qui a pris la décision. Vous pouvez aussi saisir un organisme de règlement extrajudiciaire des litiges certifié, ou un tribunal.",
        ],
      },
      {
        id: "transactions",
        heading: "Transactions entre utilisateurs",
        blocks: [
          "Les ventes se concluent directement entre utilisateurs, de gré à gré. La qualité, la conformité, la livraison et le paiement relèvent de leur seule relation. Consultez la page « Confiance et sécurité » avant toute transaction.",
        ],
      },
      {
        id: "responsabilite",
        heading: "Responsabilité",
        blocks: [
          "Joutiya met en œuvre les moyens raisonnables pour assurer l'accès au service, sans garantir une disponibilité permanente (obligation de moyens). Elle répond de la bonne exécution des options payantes qu'elle vend.",
          "Joutiya n'étant pas partie aux transactions, elle ne répond pas de l'exécution des contrats conclus entre utilisateurs.",
          SAFEGUARD,
        ],
      },
      {
        id: "modification",
        heading: "Modification des conditions",
        blocks: [
          "Toute modification est notifiée aux utilisateurs inscrits au moins 15 jours avant son entrée en vigueur, sauf obligation légale ou réglementaire immédiate. Vous pouvez fermer votre compte à tout moment.",
        ],
      },
      {
        id: "droit",
        heading: "Droit applicable",
        blocks: [
          "Les présentes conditions sont soumises au droit français. Un consommateur conserve la protection des règles impératives du pays où il réside. Pour toute réclamation : {email}.",
        ],
      },
    ],
  },

  "referencement-et-classement": {
    updated: "2026-10-13",
    intro: "Cette page explique comment les annonces sont classées et l'effet des options payantes sur leur affichage.",
    sections: [
      {
        id: "tri",
        heading: "Ordre d'affichage",
        blocks: [
          {
            list: [
              "par défaut, les annonces les plus récentes d'abord (date de publication ou de dernière remontée) ;",
              "pertinence, quand vous saisissez des mots-clés : correspondance du titre, de la description et des critères ;",
              "distance, quand vous choisissez un lieu et un rayon ;",
              "prix croissant ou décroissant, à votre demande.",
            ],
          },
          "Aucun autre critère n'intervient, et aucun annonceur ne peut payer pour modifier ces règles, hors des options décrites ci-dessous.",
        ],
      },
      {
        id: "options",
        heading: "Effet des options payantes",
        blocks: [
          "« Remontée » : l'annonce reprend la date du moment de l'achat et remonte en tête du tri par date. Elle porte la mention « Remontée », dont l'info-bulle indique : « Cette annonce a été remontée par son auteur, contre paiement. »",
          "« À la Une » : l'annonce apparaît en plus dans des emplacements séparés des résultats, marqués « À la Une · Sponsorisé », dont l'info-bulle indique : « Emplacement payé par l'annonceur. Il ne modifie pas le classement des autres résultats. »",
          "Les options ne sont pas encore en vente.",
        ],
      },
      {
        id: "pro",
        heading: "Particuliers et professionnels",
        blocks: [
          "Les annonces de professionnels portent la mention « Pro ». Le badge « Certifié » signale un professionnel dont Joutiya a vérifié les documents. Particuliers et professionnels sont classés selon les mêmes règles.",
        ],
      },
    ],
  },

  cgv: {
    updated: "2026-10-13",
    intro:
      "Les présentes conditions s'appliqueront aux options payantes et aux offres Pro vendues par {publisher}. Aucune vente n'est ouverte à ce jour : elles seront complétées avant l'ouverture des ventes.",
    sections: [
      {
        id: "offres",
        heading: "Options et offres",
        blocks: [
          "Options pour les annonces (remontée, À la Une) payées en crédits, et abonnements Pro mensuels. Les prix sont affichés toutes taxes comprises pour les particuliers et hors taxes pour les professionnels.",
        ],
      },
      {
        id: "credits",
        heading: "Crédits",
        blocks: [
          "Un crédit vaut 1 dirham toutes taxes comprises. Les crédits achetés restent valables 12 mois. Ils ne sont ni remboursables ni convertibles en argent, sauf disposition légale contraire. Les crédits offerts en bonus sont utilisés en dernier et ne sont jamais remboursés.",
        ],
      },
      {
        id: "abonnements",
        heading: "Durée et renouvellement des abonnements Pro",
        blocks: [
          "Les abonnements se renouvellent chaque mois jusqu'à résiliation, possible à tout moment depuis l'espace Pro, avec effet à la fin de la période en cours.",
        ],
      },
      {
        id: "retractation",
        heading: "Droit de rétractation",
        blocks: [
          "Le consommateur dispose d'un délai de rétractation de 14 jours en France et de 7 jours au Maroc. Lorsqu'il demande l'exécution immédiate d'une option, il renonce expressément à ce droit une fois l'option pleinement exécutée ; à défaut, il est remboursé au prorata de ce qui n'a pas été fourni.",
        ],
      },
      {
        id: "factures",
        heading: "Factures et médiation",
        blocks: [
          "Une facture est émise pour chaque achat et reste disponible dans votre compte. En cas de litige non résolu avec notre service client ({email}), le consommateur peut recourir gratuitement à un médiateur de la consommation, désigné avant l'ouverture des ventes.",
          SAFEGUARD,
        ],
      },
    ],
  },

  confidentialite: {
    updated: "2026-10-19",
    intro:
      "{publisher} ({address}) est responsable du traitement de vos données personnelles, y compris de celles publiées dans les annonces. Contact : {dpo}.",
    sections: [
      {
        id: "donnees",
        heading: "Données traitées et finalités",
        blocks: [
          {
            list: [
              "compte : e-mail, pseudonyme, téléphone vérifié, mot de passe chiffré (exécution du contrat) ;",
              "annonces et messages : contenus, photos, localisation approximative (exécution du contrat) ;",
              "sécurité : adresses IP, journaux de connexion, détection d'arnaques dans les messages (obligation légale et intérêt légitime) ;",
              "modération : signalements, décisions, propositions de l'IA (obligation légale) ;",
              "paiements : historique d'achats et factures, quand les ventes seront ouvertes (obligation légale) ;",
              "publicité : seulement avec votre consentement.",
            ],
          },
          "Le numéro de votre carte nationale (CNIE) n'est jamais collecté.",
        ],
      },
      {
        id: "controle",
        heading: "Contrôle des annonces assisté par une IA",
        blocks: [
          "Avant publication, un contrôle automatique vérifie qu'une annonce ne contient ni objet interdit, ni donnée sensible, ni signe d'arnaque. Une IA (Anthropic) prépare des propositions ; toute sanction est décidée par une personne. Les données personnelles sont masquées autant que possible avant l'envoi à l'IA.",
        ],
      },
      {
        id: "durees",
        heading: "Durées de conservation",
        blocks: [
          {
            list: [
              "annonces : en ligne {ttlDays} jours, puis contenu supprimé {purgeMonths} mois après l'expiration ou le retrait ;",
              "compte : 1 an après sa clôture ; journaux de connexion : 1 an ;",
              "messages : 12 mois après la dernière activité ;",
              "signalements et décisions de modération : 5 ans ;",
              "factures : 10 ans ; sauvegardes chiffrées : 14 semaines ;",
              "un contenu visé par un signalement en cours, un recours ou une demande d'une autorité est conservé jusqu'à sa clôture.",
            ],
          },
        ],
      },
      {
        id: "destinataires",
        heading: "Prestataires et transferts hors de l'Union européenne et du Maroc",
        blocks: [
          "Hébergés dans l'Union européenne : le serveur (Oracle Cloud, Paris), la base de données (Google Firestore, Paris), les photos et les sauvegardes (Cloudflare R2), le suivi des erreurs techniques (Sentry) et l'envoi de secours des e-mails de sécurité (Brevo, France).",
          "Traités aux États-Unis :",
          {
            list: [
              "Google : connexion et gestion des comptes ; publicité AdSense quand elle sera activée, avec un accord séparé ;",
              "Cloudflare : diffusion et protection du site, vérification anti-robot et IA de secours, sur son réseau mondial ;",
              "Anthropic : aide au contrôle des annonces, au tri des signalements et à l'examen des recours, Assistant Joutiya ; OpenAI : contrôle de secours. Les numéros, e-mails et noms sont masqués avant tout envoi à une IA ;",
              "Meta : vérification du téléphone par WhatsApp ;",
              "Resend : envoi des e-mails ;",
              "Stripe et RevenueCat : paiements et abonnements Pro, à l'ouverture des ventes.",
            ],
          },
          "Ces transferts reposent sur le cadre de protection des données UE–États-Unis ou sur les clauses contractuelles types de la Commission européenne, et sur votre consentement exprès, recueilli à l'inscription et redemandé quand cette liste change (loi marocaine 09-08, art. 44).",
        ],
      },
      {
        id: "droits",
        heading: "Vos droits",
        blocks: [
          "Vous disposez des droits d'accès, de rectification, d'effacement, d'opposition, de limitation et de portabilité, et pouvez retirer votre consentement à tout moment. Écrivez à {dpo}. Vous pouvez aussi saisir la CNIL (cnil.fr) ou, au Maroc, la CNDP (cndp.ma).",
          // Shown once a receipt number is in config/legal: no declaration before launch and budget (Z10).
          { text: "Déclaration auprès de la CNDP : {cndp}.", ifSet: "cndp" },
        ],
      },
    ],
  },

  cookies: {
    updated: "2026-10-19",
    intro: "Cette page liste les cookies et traceurs utilisés par Joutiya, par finalité.",
    sections: [
      {
        id: "necessaires",
        heading: "Strictement nécessaires (sans consentement)",
        blocks: [
          {
            list: [
              "__Host-session : vous garder connecté à votre compte (14 jours au plus, 8 heures pour le personnel) ;",
              "__Host-csrf : protéger vos actions contre les requêtes frauduleuses venues d'autres sites (même durée que la session) ;",
              "__Host-did : identifiant aléatoire et signé de l'appareil, pour limiter les abus (400 jours, environ 13 mois) ;",
              "__Host-tsv : mémoriser que vous avez réussi la vérification anti-robot, pour ne pas vous la redemander aussitôt (30 minutes) ;",
              "NEXT_LOCALE : la langue choisie (1 an) ;",
              "theme, dans le stockage local du navigateur : l'apparence choisie, claire ou sombre, jusqu'à ce que vous changiez de réglage ;",
              "pendant le dépôt d'une annonce, le stockage de session du navigateur garde la liste des points à corriger, jusqu'à la fermeture de l'onglet.",
            ],
          },
          "Cloudflare, qui protège le site, peut déposer ses propres cookies de sécurité quand il vérifie qu'un visiteur n'est pas un robot. Google dépose les siens, sur ses domaines, seulement si vous choisissez « Continuer avec Google ».",
        ],
      },
      {
        id: "publicite",
        heading: "Publicité (avec votre consentement)",
        blocks: [
          "Aucun cookie publicitaire n'est déposé aujourd'hui. Quand la publicité Google AdSense sera activée, une bannière vous demandera votre accord avant tout dépôt, et vous pourrez refuser aussi simplement qu'accepter. Les pages en tarifit n'afficheront pas de publicité.",
        ],
      },
      {
        id: "choix",
        heading: "Vos choix",
        blocks: [
          "Quand la publicité sera activée, votre choix sera conservé 6 mois, puis redemandé, et un lien « Gérer mes cookies » en bas de chaque page permettra de le modifier à tout moment. Les traceurs soumis à consentement ne dureront pas plus de 13 mois.",
          "Vous pouvez dès aujourd'hui bloquer ou effacer les cookies dans les réglages de votre navigateur ; la connexion et certaines fonctions risquent alors de ne plus marcher.",
        ],
      },
    ],
  },

  "droits-et-obligations": {
    updated: "2026-10-13",
    intro: "Ce que la loi vous demande quand vous vendez sur Joutiya, en France comme au Maroc.",
    sections: [
      {
        id: "vendeurs",
        heading: "Particulier ou professionnel",
        blocks: [
          "Vendre de temps en temps vos propres affaires reste une activité de particulier. Acheter pour revendre, ou vendre de façon régulière et organisée, fait de vous un professionnel : vous devez alors ouvrir un compte Pro et respecter les obligations du commerce (information, garanties, facturation).",
        ],
      },
      {
        id: "fiscal",
        heading: "Obligations fiscales",
        blocks: [
          "Les revenus tirés de ventes régulières ou professionnelles doivent être déclarés à l'administration fiscale du pays où vous êtes imposable (DGI au Maroc, DGFiP en France).",
          "Joutiya n'encaisse aucun paiement entre utilisateurs et ne connaît pas le prix final des ventes : elle ne transmet donc pas de déclaration de vos revenus aux administrations fiscales.",
        ],
      },
      {
        id: "dsa",
        heading: "Vos droits sur la plateforme",
        blocks: [
          "Vous êtes informé de toute décision qui vous concerne, avec ses motifs, et pouvez la contester pendant 6 mois. Vous pouvez signaler tout contenu illicite et connaître les suites données à votre signalement.",
        ],
      },
    ],
  },

  "avis-utilisateurs": {
    updated: "2026-10-13",
    intro: "Les avis entre utilisateurs ne sont pas encore disponibles. Cette page décrit les règles qui s'appliqueront à leur ouverture.",
    sections: [
      {
        id: "regles",
        heading: "Règles des avis",
        blocks: [
          {
            list: [
              "seul un utilisateur qui a échangé avec le vendeur par la messagerie de Joutiya pourra laisser un avis ;",
              "les avis ne seront pas présentés comme « vérifiés », Joutiya ne pouvant pas confirmer qu'une vente a eu lieu ;",
              "les avis sont affichés du plus récent au plus ancien, sans contrepartie ni tri favorable ;",
              "un avis peut être refusé s'il est injurieux, hors sujet, contient des données personnelles ou émane d'une personne en conflit d'intérêts ; son auteur est alors informé du motif.",
            ],
          },
        ],
      },
    ],
  },

  "confiance-et-securite": {
    updated: "2026-10-13",
    intro: "Joutiya ne vous demandera jamais de paiement. Voici comment repérer et éviter les arnaques.",
    sections: [
      {
        id: "arnaques",
        heading: "Les arnaques les plus courantes",
        blocks: [
          {
            list: [
              "un faux acheteur propose de payer par un service de livraison ou de transfert et vous envoie un lien pour « recevoir l'argent » ;",
              "un vendeur réclame un acompte ou des frais de transport avant toute rencontre ;",
              "un message vous invite à poursuivre la discussion sur WhatsApp pour un paiement en ligne ;",
              "un lien imite la page de connexion de Joutiya ou de votre banque.",
            ],
          },
        ],
      },
      {
        id: "conseils",
        heading: "Les bons réflexes",
        blocks: [
          {
            list: [
              "rencontrez-vous dans un lieu public et vérifiez le bien avant de payer ;",
              "ne communiquez jamais vos codes bancaires ni les codes reçus par SMS ;",
              "restez sur la messagerie de Joutiya tant que la transaction n'est pas conclue ;",
              "méfiez-vous d'un prix très inférieur au marché.",
            ],
          },
        ],
      },
      {
        id: "outils",
        heading: "Vos outils",
        blocks: [
          "Le badge « téléphone vérifié » indique un numéro confirmé par WhatsApp. Le badge « Certifié » signale un professionnel vérifié. Vous pouvez signaler une annonce, un profil ou un message, et bloquer un utilisateur depuis la conversation.",
          "En cas d'escroquerie, portez plainte auprès de la police. En France, signalez aussi les contenus illicites sur internet-signalement.gouv.fr.",
        ],
      },
    ],
  },

  "paiement-en-plusieurs-fois": {
    updated: "2026-10-13",
    intro: "Page d'information.",
    sections: [
      {
        id: "info",
        heading: "Paiement entre utilisateurs",
        blocks: [
          "Joutiya n'intervient pas dans les paiements entre acheteurs et vendeurs et ne propose aucun paiement en plusieurs fois. Les modalités de paiement se décident directement entre utilisateurs.",
          "Si un paiement fractionné est un jour proposé pour les options vendues par Joutiya, ses conditions figureront ici avant toute utilisation.",
        ],
      },
    ],
  },

  "contact-autorites": {
    updated: "2026-10-13",
    intro: "Point de contact unique de Joutiya pour les autorités et pour les utilisateurs (règlement européen sur les services numériques, art. 11 et 12).",
    sections: [
      {
        id: "autorites",
        heading: "Autorités",
        blocks: [
          "Les autorités des États membres, la Commission européenne, le comité européen des services numériques et les autorités marocaines peuvent écrire à {dsaEmail}. Les injonctions et réquisitions judiciaires sont traitées en priorité.",
          "Langues acceptées : {languages}.",
        ],
      },
      {
        id: "utilisateurs",
        heading: "Utilisateurs",
        blocks: [
          "Pour signaler un contenu, utilisez de préférence le bouton « Signaler » de l'annonce, du profil ou du message. Pour toute autre question liée au règlement : {dsaEmail}. Pour un abus technique (hameçonnage, piratage) : {abuseEmail}.",
        ],
      },
    ],
  },

  "objets-interdits": {
    updated: "2026-10-13",
    intro: "Ces biens, services et contenus ne peuvent pas être proposés sur Joutiya. Une annonce qui en contient est refusée ou retirée.",
    sections: [
      {
        id: "liste",
        heading: "Liste",
        blocks: [
          {
            list: [
              "armes, munitions, explosifs et leurs pièces, y compris les répliques susceptibles d'être confondues avec de vraies armes ;",
              "drogues, stupéfiants, médicaments et produits de santé soumis à prescription ;",
              "alcool, tabac et produits du vapotage ;",
              "contrefaçons et copies illégales (logiciels, films, jeux) ;",
              "biens volés ou d'origine douteuse, documents officiels, papiers d'identité, plaques d'immatriculation ;",
              "animaux d'espèces protégées, produits issus de ces espèces ;",
              "organes, sang et produits du corps humain ;",
              "contenus à caractère sexuel, services sexuels, et tout contenu impliquant des mineurs ;",
              "contenus haineux, discriminatoires ou faisant l'apologie de la violence ou du terrorisme ;",
              "données personnelles, comptes et abonnements revendus, moyens de paiement, devises et crypto-actifs ;",
              "jeux d'argent, loteries, chaînes et systèmes pyramidaux ;",
              "offres d'emploi (catégorie prévue ultérieurement) et services financiers non autorisés.",
            ],
          },
          "Cette liste n'est pas exhaustive : tout bien ou service dont la vente est interdite par la loi française ou marocaine est exclu.",
        ],
      },
    ],
  },
};

export interface LegalValues {
  publisher: string;
  address: string;
  email: string;
  dpo: string;
  dsaEmail: string;
  abuseEmail: string;
  languages: string;
  ttlDays: string;
  purgeMonths: string;
  cndp: string;
}

export function fill(text: string, values: LegalValues): string {
  return text.replace(/\{(\w+)\}/g, (match, key: string) => (key in values ? values[key as keyof LegalValues] : match));
}
