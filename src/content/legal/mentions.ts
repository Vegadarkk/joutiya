// "Mentions légales" (LCEN art. 1-1), built from config/legal at render time (§7): EI or company
// rendering, Paris domiciliation only, no hardcoded legal form, capital or VAT.

import { publisherIdentity, vatMention, type LegalConfig } from "@/config/legal";
import type { LegalSection, LegalText, LegalValues } from "./fr";

const PENDING = "Renseigné avant l'ouverture du site.";
const LANGUAGE_NAMES = { fr: "français", ar: "arabe", en: "anglais" } as const;

function host(entry: { name: string; address: string; phone: string }, region?: string): string {
  if (!entry.name) return PENDING;
  const name = region ? `${entry.name}, ${region}` : entry.name;
  if (!entry.address || !entry.phone) return `${name} : coordonnées renseignées avant l'ouverture du site.`;
  return `${name} : ${entry.address}, téléphone ${entry.phone}`;
}

export function legalValues(config: LegalConfig): LegalValues {
  return {
    publisher: config.companyName,
    address: config.hqAddress,
    email: config.email,
    phone: config.phone,
    dpo: config.dpoContact,
    dsaEmail: config.dsaContactEmail,
    abuseEmail: config.abuseEmail,
    languages: config.dsaContactLanguages.map((code) => LANGUAGE_NAMES[code]).join(", "),
    ttlDays: String(config.listingTtlDays),
    purgeMonths: String(config.listingPurgeMonths),
    // Empty until a receipt exists: the CNDP sentence (an `ifSet` block) is then left out.
    cndp: config.cndpReceiptNo ? `récépissé n° ${config.cndpReceiptNo}` : "",
    vat: vatMention(config),
    mediator: config.consumerMediator.name ? `${config.consumerMediator.name} (${config.consumerMediator.url})` : "désigné avant l'ouverture des ventes",
  };
}

export function mentionsText(config: LegalConfig, updated: string): LegalText {
  const registration =
    config.registry === "RCS" && config.rcsCity
      ? `RCS ${config.rcsCity} ${config.siren}`
      : `SIREN ${config.siren}, immatriculé au Registre national des entreprises (RNE)`;
  const sections: LegalSection[] = [
    {
      id: "editeur",
      heading: "Éditeur du site",
      blocks: [
        {
          list: [
            publisherIdentity(config),
            registration,
            ...(config.siret ? [`SIRET ${config.siret}`] : []),
            `Adresse : ${config.hqAddress}`,
            `Téléphone : ${config.phone}`,
            `E-mail : ${config.email}`,
            vatMention(config),
          ],
        },
      ],
    },
    {
      id: "directeur",
      heading: "Directeur de la publication",
      blocks: [config.publicationDirector || PENDING],
    },
    {
      id: "hebergeur",
      heading: "Hébergeur",
      blocks: [host(config.host)],
    },
    {
      id: "donnees",
      heading: "Hébergement des données",
      blocks: [{ list: config.dataHosts.map((entry) => host(entry, entry.region)) }],
    },
    {
      id: "contacts",
      heading: "Contacts",
      blocks: [
        {
          list: [
            `Point de contact unique (règlement sur les services numériques) : ${config.dsaContactEmail}`,
            `Abus techniques : ${config.abuseEmail}`,
            `Données personnelles : ${config.dpoContact}`,
            ...(config.consumerMediator.name ? [`Médiateur de la consommation : ${config.consumerMediator.name} (${config.consumerMediator.url})`] : []),
          ],
        },
      ],
    },
    {
      id: "role",
      heading: "Rôle de Joutiya",
      blocks: [
        "Joutiya héberge les annonces publiées par ses utilisateurs. Elle n'est ni vendeur, ni acheteur, ni partie aux contrats conclus entre eux.",
      ],
    },
  ];
  return { updated, sections };
}
