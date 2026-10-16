import "server-only";
import { findContacts } from "@/lib/moderation/contacts";
import { findPhoneNumbers } from "@/lib/moderation/phones";

// PII masking before any provider call (architecture §7 "masquer téléphones, e-mails, noms avant
// tout appel", design D19). Phones (libphonenumber + Moroccan shapes, src/lib/moderation/phones.ts),
// e-mails and links (src/lib/moderation/contacts.ts) and the known names of the people involved
// (seller, buyer, reporter, affected user) become neutral placeholders. Pure.

export const MASKS = { phone: "[téléphone]", email: "[e-mail]", url: "[lien]", name: "[nom]" } as const;

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Names shorter than this are not masked on their own (initials, "Ali" inside words is guarded by boundaries). */
const NAME_MIN = 2;

function replaceAllLiteral(text: string, needle: string, replacement: string): string {
  return needle ? text.split(needle).join(replacement) : text;
}

/** Replaces each known name (whole word, any case) by `[nom]`; longer names first. */
export function maskNames(text: string, names: readonly (string | null | undefined)[]): string {
  const unique = [...new Set(names.map((name) => (name ?? "").trim()).filter((name) => name.length >= NAME_MIN))].sort((a, b) => b.length - a.length);
  let out = text;
  for (const name of unique) {
    // Unicode-aware word boundaries: a name is not masked inside a longer word.
    const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, "giu");
    out = out.replace(pattern, MASKS.name);
    // Each part of a multi-word name too ("Karim Benali" -> "Karim", "Benali").
    for (const part of name.split(/\s+/)) {
      if (part.length < 3 || part === name) continue;
      out = out.replace(new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(part)}(?![\\p{L}\\p{N}])`, "giu"), MASKS.name);
    }
  }
  return out;
}

/** Text with phones, e-mails, links and the given names masked. */
export function maskPii(text: string, names: readonly (string | null | undefined)[] = []): string {
  if (!text) return "";
  let out = text;
  // E-mails and links first: a phone number inside a URL is masked with the URL.
  for (const contact of findContacts(out)) out = replaceAllLiteral(out, contact.raw, contact.kind === "email" ? MASKS.email : MASKS.url);
  for (const phone of findPhoneNumbers(out)) out = replaceAllLiteral(out, phone.raw, MASKS.phone);
  return maskNames(out, names);
}
