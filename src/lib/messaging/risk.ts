import { CONTACT_APP_KEYWORDS, PAYMENT_KEYWORDS } from "@/config/payment-keywords";
import { MESSAGE_RISK_FLAGS, URL_MARKER, type MessageRiskFlag } from "@/lib/contracts/messaging";
import { TokenizedText, compileKeywords, type CompiledKeyword } from "@/lib/moderation/keywords";
import { containsPhoneNumber } from "@/lib/moderation/phones";
import { detectSensitiveDetailed } from "@/lib/moderation/sensitive";

// Message risk (architecture §7 step 7, design D5): local rules, never AI. Every URL or bare domain
// except joutiya.ma is replaced by URL_MARKER in the stored text (the original goes to the
// server-only evidence document); flags warn the recipient. A phone number or a WhatsApp mention
// alone is NOT flagged (normal in Morocco): only together with a payment keyword. Pure.
//
// URL shapes follow src/lib/moderation/contacts.ts (scheme or www., known messaging and social
// hosts such as wa.me and t.me, bare domains on a short TLD list), with spans so they can be
// masked; e-mail addresses are neither masked nor flagged (their domain is not a link).

const EMAIL = /[a-z0-9._%+-]+\s?(?:@|\(at\)|\[at\]|\{at\}|\s+arobase\s+)\s?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const SCHEME_URL = /\b(?:https?:\/\/|www\.)[^\s<>"'⟦⟧]+/gi;
const KNOWN_HOSTS =
  /(?<![a-z0-9.-])(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com|t\.me|telegram\.me|telegram\.org|instagram\.com|facebook\.com|fb\.com|fb\.me|m\.me|tiktok\.com|youtube\.com|youtu\.be|bit\.ly|linktr\.ee|snapchat\.com|avito\.ma|marocannonces\.com)(?:\/[^\s<>"'⟦⟧]*)?/gi;
const BARE_DOMAIN = /(?<![a-z0-9@.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ma|net|org|fr|info|io|shop|store|biz|online|site|xyz|es|be|de|uk|eu)\b(?:\/[^\s<>"'⟦⟧]*)?/gi;
/** Trailing punctuation is the sentence's, not the link's. */
const TRAILING_PUNCTUATION = /[.,;:!?)\]}»"']+$/;

/** Links to the platform itself stay readable. */
const OWN_HOST = /^(?:[a-z0-9-]+\.)*joutiya\.ma$/;

interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** Host of a matched link, lower case, without scheme, credentials, port or path. */
export function linkHost(raw: string): string {
  const withoutScheme = raw.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const authority = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  const host = authority.slice(authority.lastIndexOf("@") + 1).replace(/:\d+$/, "");
  return host.toLowerCase();
}

export function isOwnLink(raw: string): boolean {
  return OWN_HOST.test(linkHost(raw));
}

/** External links of a text, in text order, without overlaps. */
export function findLinks(text: string): (Span & { raw: string })[] {
  if (!text) return [];
  const emails: Span[] = [];
  for (const match of text.matchAll(EMAIL)) emails.push({ start: match.index, end: match.index + match[0].length });
  const found: (Span & { raw: string })[] = [];
  for (const pattern of [SCHEME_URL, KNOWN_HOSTS, BARE_DOMAIN]) {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0].replace(TRAILING_PUNCTUATION, "");
      const span = { start: match.index, end: match.index + raw.length };
      if (raw.length === 0 || emails.some((email) => overlaps(email, span)) || found.some((other) => overlaps(other, span))) continue;
      found.push({ ...span, raw });
    }
  }
  return found.filter((link) => !isOwnLink(link.raw)).sort((a, b) => a.start - b.start);
}

/** `text` with every external link replaced by URL_MARKER. */
export function maskLinks(text: string): { text: string; count: number } {
  const links = findLinks(text);
  if (links.length === 0) return { text, count: 0 };
  let out = "";
  let cursor = 0;
  for (const link of links) {
    out += text.slice(cursor, link.start) + URL_MARKER;
    cursor = link.end;
  }
  return { text: out + text.slice(cursor), count: links.length };
}

let paymentKeywords: CompiledKeyword[] | undefined;
let contactKeywords: CompiledKeyword[] | undefined;

function bankDetails(text: string): boolean {
  return detectSensitiveDetailed(text).some((hit) => hit.id === "bank_account" || hit.id === "card_number");
}

export interface MessageAnalysis {
  /** What is stored and shown: external links masked. */
  text: string;
  /** In MESSAGE_RISK_FLAGS order, unique. */
  flags: MessageRiskFlag[];
  /** At least one link was masked: the original text goes to the evidence document. */
  masked: boolean;
}

/** Risk flags and masked text of a message (D5). */
export function analyzeMessage(text: string): MessageAnalysis {
  const masked = maskLinks(text);
  const tokens = new TokenizedText(text);
  paymentKeywords ??= compileKeywords(PAYMENT_KEYWORDS);
  contactKeywords ??= compileKeywords(CONTACT_APP_KEYWORDS);
  const payment = tokens.find(paymentKeywords).length > 0;
  const raised = new Set<MessageRiskFlag>();
  if (masked.count > 0) raised.add("external_url");
  if (bankDetails(text)) raised.add("iban");
  if (payment) {
    raised.add("payment_kw");
    if (containsPhoneNumber(text) || tokens.find(contactKeywords).length > 0) raised.add("contact_with_payment_kw");
  }
  return { text: masked.text, flags: MESSAGE_RISK_FLAGS.filter((flag) => raised.has(flag)), masked: masked.count > 0 };
}

/**
 * One-line preview of a stored text (lastMessage.preview: <= 140 UTF-16 units like the schema,
 * never half a surrogate pair or half a marker).
 */
export function messagePreview(text: string, max = 140): string {
  const line = text.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  let preview = "";
  for (const char of line) {
    if (preview.length + char.length > max - 1) break;
    preview += char;
  }
  const open = preview.lastIndexOf("⟦");
  if (open !== -1 && preview.indexOf("⟧", open) === -1) preview = preview.slice(0, open);
  return `${preview.trimEnd()}…`;
}
