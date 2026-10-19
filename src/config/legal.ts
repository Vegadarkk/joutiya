// Dynamic legal variables (architecture §7). Live values: Firestore `config/legal`, edited by an
// admin and journaled; this file holds the schema and the defaults. Legal form, capital and VAT
// are data, never hardcoded in pages. The only address ever displayed is the Paris domiciliation.

import { z } from "@/lib/zod";

const text = z.string().trim();

export const LEGAL_FORMS = ["EI", "EURL", "SASU", "SAS", "SARL", "SA"] as const;

const hostSchema = z.object({
  name: text,
  address: text,
  phone: text,
});

const dataHostSchema = hostSchema.extend({ region: text });

export const legalConfigSchema = z.object({
  /** "EI" (micro-entrepreneur today); a company form switches the rendering of the mentions. */
  legalForm: z.enum(LEGAL_FORMS),
  /** EI: trade name. Company: corporate name. */
  companyName: text.min(1),
  /** EI only: exact name as written in the register. */
  entrepreneurName: text,
  /** Company only, in euros. */
  shareCapital: text,
  hqAddress: text.min(1),
  siren: text.regex(/^\d{9}$/),
  siret: text.regex(/^(\d{14})?$/),
  /** "RNE" until the platform activity is declared, then "RCS". */
  registry: z.enum(["RNE", "RCS"]),
  rcsCity: text,
  vatNumber: text.regex(/^(FR[0-9A-Z]{2}\d{9})?$/),
  /** "franchise": "TVA non applicable, article 293 B du CGI". */
  vatRegime: z.enum(["franchise", "assujetti"]),
  phone: text,
  email: z.email(),
  publicationDirector: text,
  host: hostSchema,
  dataHosts: z.array(dataHostSchema),
  dsaContactEmail: z.email(),
  dsaContactLanguages: z.array(z.enum(["fr", "ar", "en"])).min(1),
  abuseEmail: z.email(),
  dpoContact: text,
  /** CNDP declaration deferred (Z10): filled after filing. */
  cndpReceiptNo: text,
  /** Required before the sales gate, not for launch. */
  consumerMediator: z.object({ name: text, url: text }),
  listingTtlDays: z.number().int().min(1).max(365),
  listingPurgeMonths: z.number().int().min(1).max(36),
});

export type LegalConfig = z.infer<typeof legalConfigSchema>;

export const DEFAULT_LEGAL: LegalConfig = {
  legalForm: "EI",
  companyName: "Adark Prime",
  // To align with the exact name in the register (the memento reads "DARKAOUI ADIL").
  entrepreneurName: "Adil DARKAOUI DAHMANI",
  shareCapital: "",
  hqAddress: "6 rue d'Armaillé, 75017 Paris",
  siren: "947788303",
  siret: "94778830300016",
  registry: "RNE",
  rcsCity: "",
  vatNumber: "FR41947788303",
  vatRegime: "franchise",
  phone: "+33 7 62 66 71 49",
  email: "contact@joutiya.ma",
  publicationDirector: "Adil DARKAOUI DAHMANI",
  // Oracle signup maps a French account to the "Oracle Cloud Services Agreement" of Oracle France
  // SAS (cloud_csa_online_v062223_fr_eng.pdf); head office per SIRENE 335 092 318 since 2026-04-13;
  // phone of Oracle's Paris office (oracle.com/fr/corporate/contact/field-offices). Checked 2026-10-16.
  host: { name: "Oracle France SAS", address: "6 avenue de Messine, 75008 Paris", phone: "+33 1 57 60 20 20" },
  dataHosts: [
    // Firestore and Firebase Authentication fall under the Google Cloud terms (firebase.google.com/terms),
    // whose entity for a French customer is Google Cloud France SARL (cloud.google.com/terms/google-entity;
    // Spark has no billing address). Google publishes no phone for it: Google Paris switchboard.
    {
      name: "Google Cloud France SARL (Firestore)",
      region: "europe-west9, Paris",
      address: "8 rue de Londres, 75009 Paris",
      phone: "+33 1 42 68 53 00",
    },
    {
      name: "Google Cloud France SARL (Firebase Authentication)",
      region: "États-Unis",
      address: "8 rue de Londres, 75009 Paris",
      phone: "+33 1 42 68 53 00",
    },
    {
      name: "Cloudflare, Inc. (R2, CDN)",
      region: "R2 : UE ; CDN : mondial",
      address: "101 Townsend St, San Francisco, CA 94107, États-Unis",
      phone: "+1 650 319 8930",
    },
  ],
  dsaContactEmail: "dsa@joutiya.ma",
  dsaContactLanguages: ["fr", "ar", "en"],
  abuseEmail: "abuse@joutiya.ma",
  dpoContact: "dpo@joutiya.ma",
  cndpReceiptNo: "",
  consumerMediator: { name: "", url: "" },
  listingTtlDays: 60,
  listingPurgeMonths: 12,
};

const COMPANY_FORMS: ReadonlySet<string> = new Set(LEGAL_FORMS.filter((form) => form !== "EI"));

/**
 * Mentions required by art. 1-1 LCEN (law 2004-575). Production refuses to start while one is
 * missing (§7): publisher identity, registration, address, phone, VAT status, publication
 * director, host, data hosts and the DSA point of contact.
 */
export function missingLegalMentions(config: LegalConfig): string[] {
  const missing: string[] = [];
  const need = (ok: boolean, field: string) => {
    if (!ok) missing.push(field);
  };
  if (config.legalForm === "EI") {
    need(config.entrepreneurName !== "", "entrepreneurName");
  } else {
    need(config.shareCapital !== "", "shareCapital");
  }
  if (config.registry === "RCS" || COMPANY_FORMS.has(config.legalForm)) need(config.rcsCity !== "", "rcsCity");
  need(config.phone !== "", "phone");
  need(config.publicationDirector !== "", "publicationDirector");
  need(config.vatRegime === "franchise" || config.vatNumber !== "", "vatNumber");
  need(config.host.name !== "", "host.name");
  need(config.host.address !== "", "host.address");
  need(config.host.phone !== "", "host.phone");
  config.dataHosts.forEach((dataHost, index) => {
    need(dataHost.address !== "", `dataHosts[${index}].address`);
    need(dataHost.phone !== "", `dataHosts[${index}].phone`);
  });
  return missing;
}

/** Firestore value over the defaults; unknown or invalid fields are reported, never displayed. */
export function resolveLegalConfig(stored: unknown): { config: LegalConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_LEGAL, errors: [] };
  const merged = { ...DEFAULT_LEGAL, ...(typeof stored === "object" ? stored : {}) };
  const parsed = legalConfigSchema.strict().safeParse(merged);
  if (parsed.success) return { config: parsed.data, errors: [] };
  return {
    config: DEFAULT_LEGAL,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "config/legal"}: ${issue.message}`),
  };
}

/** Identity line of the publisher, by legal form (§7 "Rendu des mentions"). */
export function publisherIdentity(config: LegalConfig): string {
  if (config.legalForm === "EI") {
    return `${config.entrepreneurName}, entrepreneur individuel (EI), nom commercial ${config.companyName}`;
  }
  const capital = config.shareCapital ? ` au capital de ${config.shareCapital} €` : "";
  const rcs = config.rcsCity ? `, RCS ${config.rcsCity} ${config.siren}` : "";
  return `${config.companyName}, ${config.legalForm}${capital}${rcs}`;
}

export function vatMention(config: LegalConfig): string {
  return config.vatRegime === "franchise"
    ? "TVA non applicable, article 293 B du CGI"
    : `TVA intracommunautaire : ${config.vatNumber}`;
}
