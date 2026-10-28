import { findContacts } from "@/lib/moderation/contacts";
import { findPhoneNumbers } from "@/lib/moderation/phones";
import { containsProhibited } from "@/lib/moderation/prohibited";
import { detectSensitive } from "@/lib/moderation/sensitive";

// Screen of a short free text that is not a listing (storefront bio, review, review reply): the
// listing rules of steps 2-3 (§7) on one field. Client-safe, so forms flag a problem as it is
// typed; the API runs it again before storing.

export const FREE_TEXT_ISSUES = ["phone_in_text", "email_in_text", "url_in_text", "prohibited", "sensitive"] as const;
export type FreeTextIssue = (typeof FREE_TEXT_ISSUES)[number];

export interface FreeTextScreen {
  /** Refused as typed: a contact detail (messaging is the only channel) or a hard prohibited word. */
  blockers: FreeTextIssue[];
  /** Sensitive personal data (Russmedia): refused for a bio, held for a human for a review. */
  sensitive: boolean;
}

export function screenFreeText(text: string): FreeTextScreen {
  const blockers = new Set<FreeTextIssue>();
  if (findPhoneNumbers(text).length > 0) blockers.add("phone_in_text");
  for (const contact of findContacts(text)) blockers.add(contact.kind === "email" ? "email_in_text" : "url_in_text");
  if (containsProhibited(text).hard.length > 0) blockers.add("prohibited");
  return { blockers: FREE_TEXT_ISSUES.filter((issue) => blockers.has(issue)), sensitive: detectSensitive(text).length > 0 };
}

/** First issue of a text where sensitive data is refused too (a bio): null when it may be stored. */
export function firstStrictIssue(text: string): FreeTextIssue | null {
  const screen = screenFreeText(text);
  return screen.blockers[0] ?? (screen.sensitive ? "sensitive" : null);
}
