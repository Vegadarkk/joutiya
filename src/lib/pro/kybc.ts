import { z } from "@/lib/zod";

// Basic business verification of a Pro (KYBC, architecture §8 "Vérification", §5 `proProfiles.legal`).
// The identifiers asked depend on the legal form; the ICE (15 digits) is checked for its format
// here, then a moderator checks it by hand on OMPIC or DirectInfo. Other identifiers are only
// normalised and bounded: their exact formats are not checked automatically (no official source
// read yet), the moderator verifies them with the uploaded pieces.

export const LEGAL_FORMS = ["societe", "auto_entrepreneur", "commercant", "cooperative"] as const;
export type LegalForm = (typeof LEGAL_FORMS)[number];

/** Identifier fields required per legal form; `commercant` needs `rc` or `tp` (one of them). */
export const REQUIRED_IDENTIFIERS: Record<LegalForm, readonly string[]> = {
  societe: ["ice", "rc", "if"],
  auto_entrepreneur: ["ice", "aeNumber"],
  commercant: ["ice"],
  // Law 112-12: registered at the local register of cooperatives (tribunal), mirrored by ODCo's central one.
  cooperative: ["ice", "coopNumber"],
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

/** Registry numbers (RC, IF, AE number, taxe professionnelle, cooperative number): letters, digits and "/" only. */
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
  z.object({ form: z.literal("cooperative"), ice, coopNumber: registryNumber }).strict(),
]);
export type ProLegal = z.infer<typeof proLegalSchema>;

export const KYBC_STATUSES = ["none", "submitted", "verified", "rejected"] as const;
export type KybcStatus = (typeof KYBC_STATUSES)[number];

/** Pieces uploaded with an application (private bucket, purpose `kyb`). */
export const KYBC_MIN_PIECES = 1;
export const KYBC_MAX_PIECES = 6;

/** Upload documents an applicant may hold at once (pieces in flight, attached or refused, kept 7 days unless attached). */
export const KYBC_UPLOADS_PER_ACCOUNT = 3 * KYBC_MAX_PIECES;

/** Bytes read to check a piece's real type. */
export const KYBC_SNIFF_BYTES = 16;

/**
 * Real type of a KYBC piece from its first bytes: JPEG, PNG or PDF (`%PDF-` at offset 0, stricter
 * than readers that search the first kilobyte), null otherwise. Never the declared type.
 */
export function sniffKybcType(bytes: Uint8Array): "image/jpeg" | "image/png" | "application/pdf" | null {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length >= png.length && png.every((byte, index) => bytes[index] === byte)) return "image/png";
  const pdf = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (bytes.length >= pdf.length && pdf.every((byte, index) => bytes[index] === byte)) return "application/pdf";
  return null;
}

/** Private bucket key of a piece (never served publicly; staff read it through the admin app). */
export function kybcObjectKey(uid: string, uploadId: string): string {
  return `kyb/${uid}/${uploadId}`;
}

/**
 * Version of the collection notice shown with the pieces (`Pro.form.piecesNotice`: purpose, who
 * sees them, retention, hosting outside Morocco, rights). Stored with the application
 * (`kybc.noticeVersion`, loi 09-08 art. 5); bump it when the text changes in substance.
 */
export const KYBC_NOTICE_VERSION = "2026-10-19";

/**
 * PDF name tokens that run code, open files or embed payloads (`/OpenAction` + `/JavaScript`,
 * `/Launch`, `/EmbeddedFile`, XFA forms...). A piece carrying one is refused at `complete`: staff
 * download the PDFs to a desktop reader. Defence in depth, not a sanitiser: compressed object
 * streams hide names from this scan, so PDFs still open in the sandboxed browser viewer first.
 */
const PDF_ACTIVE_TOKENS = /\/(?:JavaScript|JS|Launch|OpenAction|AA|EmbeddedFiles?|RichMedia|XFA|GoToR|SubmitForm|ImportData)(?![A-Za-z0-9_])/;

export function pdfHasActiveContent(bytes: Uint8Array): boolean {
  // `#xx` escapes in names (`/J#61vaScript`) are decoded before the match.
  const text = new TextDecoder("latin1").decode(bytes).replace(/#([0-9A-Fa-f]{2})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  return PDF_ACTIVE_TOKENS.test(text);
}
