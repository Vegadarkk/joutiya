import { publisherIdentity, vatMention, type LegalConfig } from "@/config/legal";
import type { LegalVersion } from "@/config/legal-versions";
import { SITE_NAME } from "@/config/site";
import type { TemplateScope } from "./template";

// Values of the legal templates (phase 6, D11): config/legal plus the computed conditions the
// sources test (README of the markers in src/lib/legal/template.ts). An empty value is never
// replaced by an invented text: the templates carry their own "to be filled" variants.

const LANGUAGE_NAMES = {
  fr: { fr: "français", ar: "arabe", en: "anglais" },
  ar: { fr: "الفرنسية", ar: "العربية", en: "الإنجليزية" },
} as const;

export interface LegalSwitches {
  /** WhatsApp phone verification is live (isPhoneVerificationConfigured): Meta is named (D24). */
  whatsapp: boolean;
  /** Ads can run (`adsMode` not "off"): the cookie policy lists the AdSense cookies. */
  ads: boolean;
  /** Google's consent message covers EEA/UK/CH visitors (`adsCmpEea`). */
  adsCmpEea: boolean;
}

function hostState(entry: { name: string; address: string; phone: string }) {
  const complete = Boolean(entry.name && entry.address && entry.phone);
  return { complete, partial: Boolean(entry.name) && !complete, noName: !entry.name };
}

/** An ISO day of LEGAL_VERSIONS, written out in the text's language. */
export function formatLegalDate(day: string, language: "fr" | "ar"): string {
  return new Intl.DateTimeFormat(language === "ar" ? "ar-MA" : "fr-MA", { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(new Date(`${day}T12:00:00Z`));
}

/** The languages the DSA point of contact answers in, written out in the text's language. */
export function dsaLanguages(config: Pick<LegalConfig, "dsaContactLanguages">, language: "fr" | "ar"): string {
  return config.dsaContactLanguages.map((code) => LANGUAGE_NAMES[language][code]).join(language === "ar" ? "، " : ", ");
}

export function legalScope(config: LegalConfig, switches: LegalSwitches, version: Pick<LegalVersion, "version" | "effective">, language: "fr" | "ar"): TemplateScope {
  const date = formatLegalDate(version.effective, language);
  const languages = dsaLanguages(config, language);
  const host = hostState(config.host);
  return {
    brand: SITE_NAME,
    version: version.version,
    effectiveDate: date,
    // Publisher.
    publisher: config.companyName,
    publisherIdentity: publisherIdentity(config),
    companyName: config.companyName,
    entrepreneurName: config.entrepreneurName,
    legalForm: config.legalForm,
    shareCapital: config.shareCapital,
    siren: config.siren,
    siret: config.siret,
    registry: config.registry === "RCS" && config.rcsCity ? "RCS" : "RNE",
    rcsCity: config.rcsCity,
    vatRegime: config.vatRegime,
    vatNumber: config.vatNumber,
    vat: vatMention(config),
    address: config.hqAddress,
    phone: config.phone,
    email: config.email,
    publicationDirector: config.publicationDirector,
    // Hosts (LCEN art. 1-1).
    hostName: config.host.name,
    hostAddress: config.host.address,
    hostPhone: config.host.phone,
    hostComplete: host.complete,
    hostPartial: host.partial,
    hostMissing: host.noName,
    dataHosts: config.dataHosts.map((entry) => ({
      ...hostState(entry),
      label: entry.region ? `${entry.name}, ${entry.region}` : entry.name,
      address: entry.address,
      phone: entry.phone,
    })),
    // Contacts (aliases kept from the provisional texts).
    dsaEmail: config.dsaContactEmail,
    dsaContactEmail: config.dsaContactEmail,
    languages,
    dsaContactLanguages: languages,
    abuseEmail: config.abuseEmail,
    dpo: config.dpoContact,
    dpoContact: config.dpoContact,
    consumerMediator: { name: config.consumerMediator.name, url: config.consumerMediator.url },
    mediator: config.consumerMediator.name
      ? `${config.consumerMediator.name} (${config.consumerMediator.url})`
      : language === "ar"
        ? "يُعيَّن قبل فتح المبيعات"
        : "désigné avant l'ouverture des ventes",
    // CNDP (Z10): nothing is printed until a receipt exists.
    cndpReceiptNo: config.cndpReceiptNo,
    cndpCookiesReceiptNo: "",
    // Service.
    ttlDays: String(config.listingTtlDays),
    purgeMonths: String(config.listingPurgeMonths),
    whatsappEnabled: switches.whatsapp,
    ads: switches.ads,
    adsCmpEea: switches.adsCmpEea,
  };
}
