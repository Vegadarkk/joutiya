import { z } from "@/lib/zod";

// Basic business verification of a Pro (KYBC, architecture §8 "Vérification", §5 `proProfiles.legal`).
// The identifiers asked depend on the legal form; the ICE (15 digits) is checked for its format
// here, then a moderator checks it by hand on OMPIC or DirectInfo. Other identifiers are only
// normalised and bounded: their exact formats are not checked automatically (no official source
// read yet), the moderator verifies them with the uploaded pieces.

export const LEGAL_FORMS = ["societe", "auto_entrepreneur", "commercant"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

/** Identifier fields required per legal form; `commercant` needs `rc` or `tp` (one of them). */
export const REQUIRED_IDENTIFIERS: Record<LegalForm, readonly string[]> = {
  societe: ["ice", "rc", "if"],
  auto_entrepreneur: ["ice", "aeNumber"],
  commercant: ["ice"],
};

/** Removes spaces, dots and dashes users type in identifiers (ICE "001 234 567 000 089"). */
export function normalizeIdentifier(value: string): string {
  return value.replace(/[\s.\-_]/g, "").toUpperCase();
}

export const ICE_LENGTH = 15;

export function iceFormatOk(value: string): boolean {
  return /^\d{15}$/.test(normalizeIdentifier(value));
}

const ice = z
  .string()
  .transform(normalizeIdentifier)
  .refine((value) => /^\d{15}$/.test(value), { message: "ice_format" });

/** Registry numbers (RC, IF, AE number, taxe professionnelle): letters, digits and "/" only. */
const registryNumber = z
  .string()
  .transform((value) => normalizeIdentifier(value))
  .refine((value) => /^[A-Z0-9/]{1,30}$/.test(value), { message: "identifier_format" });

export const proLegalSchema = z.discriminatedUnion("form", [
  z.object({ form: z.literal("societe"), ice, rc: registryNumber, if: registryNumber }).strict(),
  z.object({ form: z.literal("auto_entrepreneur"), ice, aeNumber: registryNumber }).strict(),
  z
    .object({ form: z.literal("commercant"), ice, rc: registryNumber.optional(), tp: registryNumber.optional() })
    .strict()
    .refine((value) => value.rc !== undefined || value.tp !== undefined, { message: "rc_or_tp_required", path: ["rc"] }),
]);
export type ProLegal = z.infer<typeof proLegalSchema>;

export const KYBC_STATUSES = ["none", "submitted", "verified", "rejected"] as const;
export type KybcStatus = (typeof KYBC_STATUSES)[number];

/** Pieces uploaded with an application (private bucket, purpose `kyb`). */
export const KYBC_MIN_PIECES = 1;
export const KYBC_MAX_PIECES = 6;
