import { isolateLtr } from "@/lib/i18n/bidi";

// Phone numbers on /verifications, in the national form the API answers with ("06 12 34 56 78",
// displayPhone in src/lib/phone/normalize.ts), whether the value is what the person typed, the
// status answer or Joutiya's number (international digits). Kept apart from normalize.ts so the
// browser bundle does not carry libphonenumber's metadata;
// tests/unit/auth-verifications-phone.test.tsx checks both give the same text.

/** "0612345678", "+212 6 12 34 56 78", "00212612345678", "212600000000" -> "06 12 34 56 78"; any other value as given. */
export function displayMoroccanPhone(value: string): string {
  const national = /^(?:00212|212)?0?(\d{9})$/.exec(value.replace(/\D/g, ""))?.[1];
  if (!national) return value.trim();
  return `0${national}`.replace(/(\d{2})(?=\d)/g, "$1 ");
}

/**
 * A phone number as an ICU argument: national form, kept left to right inside Arabic text, and on
 * one line (no-break spaces: a number split over two lines reads as two numbers).
 */
export function phoneArgument(value: string | null | undefined): string {
  return isolateLtr(displayMoroccanPhone(value ?? "").replace(/ /g, "\u00a0"));
}
