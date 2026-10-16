import type { ContactMatch } from "@/lib/moderation/types";

// E-mail addresses and links written in a listing text: contact must go through the platform
// (architecture §7 step 3, design D8). Pure, client-safe.
//
// URLs: explicit scheme, "www.", known messaging / social hosts (WhatsApp, Telegram, Instagram...)
// and bare domains on a short list of TLDs. The TLD list leaves out .me/.co/.tv/.app (words that
// end sentences: "appelez.me") and never matches a dot followed by a space, so "38.5 com" or
// "Peugeot 206. Ma voiture" stay clean.

const EMAIL = /[a-z0-9._%+-]+\s?(?:@|\(at\)|\[at\]|\{at\}|\s+arobase\s+)\s?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi;
const SCHEME_URL = /\b(?:https?:\/\/|www\.)[^\s<>"']+/gi;
const KNOWN_HOSTS = /(?<![a-z0-9.-])(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|whatsapp\.com|t\.me|telegram\.me|instagram\.com|facebook\.com|fb\.com|fb\.me|m\.me|tiktok\.com|youtube\.com|youtu\.be|bit\.ly|linktr\.ee|snapchat\.com|avito\.ma|marocannonces\.com)(?:\/[^\s<>"']*)?/gi;
const BARE_DOMAIN = /(?<![a-z0-9@.-])[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ma|net|org|fr|info|io|shop|store|biz|online|site|xyz|es|be|de|uk|eu)\b(?:\/[^\s<>"']*)?/gi;

interface Span {
  start: number;
  end: number;
}

const overlaps = (a: Span, b: Span) => a.start < b.end && b.start < a.end;

/** E-mails and links found in a text, in text order, without overlaps (an e-mail wins over the domain inside it). */
export function findContacts(text: string): ContactMatch[] {
  if (!text) return [];
  const found: { span: Span; match: ContactMatch }[] = [];
  const add = (kind: ContactMatch["kind"], pattern: RegExp) => {
    for (const match of text.matchAll(pattern)) {
      const raw = match[0].replace(/[.,;:!?)]+$/, "");
      const span = { start: match.index, end: match.index + raw.length };
      if (raw.length === 0 || found.some((entry) => overlaps(entry.span, span))) continue;
      found.push({ span, match: { kind, raw } });
    }
  };
  add("email", EMAIL);
  add("url", SCHEME_URL);
  add("url", KNOWN_HOSTS);
  add("url", BARE_DOMAIN);
  return found.sort((a, b) => a.span.start - b.span.start).map((entry) => entry.match);
}
