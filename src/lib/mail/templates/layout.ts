import type { Locale } from "@/config/site";
import { LOCALE_TAGS } from "@/config/site";
import { DEFAULT_LEGAL, type LegalConfig } from "@/config/legal";

// Shared e-mail layout: table-based HTML, inline styles only, no remote image, no tracking pixel.
// Brand tokens mirror src/styles/globals.css (ochre primary, cream surfaces, deep green text).

/** Copy exists in French and Arabic; Tarifit falls back to French until a native review. */
export type MailLocale = "fr" | "ar";

export function mailLocale(locale: Locale): MailLocale {
  return locale === "ar" ? "ar" : "fr";
}

export interface TemplateContext {
  /** Locale of the copy (rif → fr). */
  lang: MailLocale;
  /** Locale of the recipient's pages (URLs keep the real locale, rif included). */
  locale: Locale;
  siteUrl: string;
  /** Publisher of the footer; defaults to the one set by setMailPublisher(). */
  publisher?: MailPublisher;
}

/** Publisher line of the footer: `config/legal` values, never a hardcoded identity. */
export interface MailPublisher {
  name: string;
  address: string;
  /** Contact address offered by the security mails ("if this was not you"); the legal default when absent. */
  email?: string;
}

/** The only postal address ever displayed (domiciliation): the fallback when the config has none. */
export const PUBLISHER_ADDRESS = "6 rue d'Armaillé, 75017 Paris";

export function mailPublisher(legal?: Partial<Pick<LegalConfig, "companyName" | "hqAddress" | "email">>): MailPublisher {
  return {
    name: legal?.companyName?.trim() || DEFAULT_LEGAL.companyName,
    address: legal?.hqAddress?.trim() || PUBLISHER_ADDRESS,
    email: legal?.email?.trim() || DEFAULT_LEGAL.email,
  };
}

let currentPublisher: MailPublisher = mailPublisher();

/**
 * Refreshes the publisher shown in every footer. renderMail() is synchronous, so deliverMail()
 * calls this with the cached legal config right before rendering; without a call, the defaults.
 */
export function setMailPublisher(legal?: Partial<Pick<LegalConfig, "companyName" | "hqAddress" | "email">>): void {
  currentPublisher = mailPublisher(legal);
}

/** Contact address of the current publisher (config/legal `email`, else the default). */
export function mailContact(): string {
  return currentPublisher.email ?? DEFAULT_LEGAL.email;
}

export interface BuiltMail {
  subject: string;
  html: string;
  text: string;
  /** Where a reply goes (statement mails: the DSA contact address). */
  replyTo?: string;
}

export interface LayoutInput {
  lang: MailLocale;
  siteUrl: string;
  subject: string;
  /** Heading of the card. */
  title: string;
  greeting: string;
  paragraphs: string[];
  /** The single primary button; its raw URL is repeated below it. */
  action?: { label: string; url: string };
  /** Secondary links, as labelled raw URLs (signupExisting: reset link). */
  links?: { label: string; url: string }[];
  /** Paragraphs after the button (security sentence last). */
  closing?: string[];
  /** Footer identity; the current publisher (setMailPublisher) when omitted. */
  publisher?: MailPublisher;
  /** Reply-To of the mail (a reply then reaches a person instead of the no-reply sender). */
  replyTo?: string;
}

const COLORS = {
  page: "#f7f1e6", // cream-100
  card: "#ffffff",
  cardBorder: "#e6d8bd", // cream-300
  text: "#0b1e1f", // bab-950
  muted: "#4a5a5b", // foreground-muted
  primary: "#a94b26", // ochre-600
  primaryText: "#ffffff",
  heading: "#0d4b4d", // bab-700
  link: "#135a5b", // bab-600
  rule: "#d2a24c", // gold-400
  footerBorder: "#dde4e2", // border
} as const;

const FONT = "-apple-system, 'Segoe UI', Roboto, Helvetica, Arial, Tahoma, sans-serif";

const FOOTER: Record<MailLocale, { auto: string; publisher: (who: MailPublisher) => string; site: string }> = {
  fr: {
    auto: "E-mail automatique, merci de ne pas répondre.",
    publisher: (who) => `Édité par ${who.name} · ${who.address}`,
    site: "Aller sur Joutiya",
  },
  ar: {
    auto: "بريد إلكتروني آلي، يرجى عدم الرد عليه.",
    publisher: (who) => `الناشر: ${who.name} · ${who.address}`,
    site: "الذهاب إلى Joutiya",
  },
};

/** Security sentence closing every security mail. */
export const NOT_YOU: Record<MailLocale, string> = {
  fr: "Si tu n'es pas à l'origine de cette demande, ignore cet e-mail.",
  ar: "إذا لم تكن أنت من قام بهذا الطلب، فتجاهل هذا البريد الإلكتروني.",
};

export const GREETING: Record<MailLocale, (name: string) => string> = {
  fr: (name) => `Bonjour ${name},`,
  ar: (name) => `مرحبًا ${name}،`,
};

/** Escapes every interpolated value for HTML text and double-quoted attribute contexts. */
export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Formats an ISO date for the recipient (Morocco time); a non-date string is returned unchanged. */
export function formatDate(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  // Tarifit has no Intl data: the copy is French, so is the date.
  const tag = LOCALE_TAGS[locale === "rif" ? "fr" : locale];
  return new Intl.DateTimeFormat(tag, { dateStyle: "long", timeStyle: "short", timeZone: "Africa/Casablanca" }).format(date);
}

/** Formats an ISO date as a day (no time) for the recipient (Morocco time). */
export function formatDay(value: string, locale: Locale): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const tag = LOCALE_TAGS[locale === "rif" ? "fr" : locale];
  return new Intl.DateTimeFormat(tag, { dateStyle: "long", timeZone: "Africa/Casablanca" }).format(date);
}

export function pageUrl(ctx: TemplateContext, segment: string): string {
  return `${ctx.siteUrl.replace(/\/$/, "")}/${ctx.locale}/${segment}`;
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function paragraph(text: string, color: string = COLORS.text, size = 16): string {
  return `<p style="margin:0 0 16px;font-size:${size}px;line-height:1.55;color:${color};">${escapeHtml(text)}</p>`;
}

function rawLink(url: string): string {
  const safe = escapeHtml(url);
  return `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${COLORS.muted};word-break:break-all;"><a href="${safe}" style="color:${COLORS.link};text-decoration:underline;">${safe}</a></p>`;
}

export function renderLayout(input: LayoutInput): BuiltMail {
  const rtl = input.lang === "ar";
  const dir = rtl ? "rtl" : "ltr";
  const align = rtl ? "right" : "left";
  const footer = FOOTER[input.lang];
  const publisher = footer.publisher(input.publisher ?? currentPublisher);
  const siteHost = hostOf(input.siteUrl);
  const body: string[] = [];

  body.push(`<h1 style="margin:0 0 20px;font-size:22px;line-height:1.3;font-weight:700;color:${COLORS.heading};">${escapeHtml(input.title)}</h1>`);
  body.push(paragraph(input.greeting));
  for (const text of input.paragraphs) body.push(paragraph(text));
  if (input.action) {
    const url = escapeHtml(input.action.url);
    body.push(
      `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 12px;"><tr><td style="border-radius:10px;background:${COLORS.primary};">` +
        `<a href="${url}" style="display:inline-block;padding:13px 26px;font-family:${FONT};font-size:16px;font-weight:600;line-height:1.2;color:${COLORS.primaryText};text-decoration:none;border-radius:10px;">${escapeHtml(input.action.label)}</a>` +
        `</td></tr></table>`,
    );
    body.push(rawLink(input.action.url));
  }
  for (const link of input.links ?? []) {
    body.push(`<p style="margin:0 0 4px;font-size:14px;line-height:1.5;color:${COLORS.text};">${escapeHtml(link.label)}</p>`);
    body.push(rawLink(link.url));
  }
  for (const text of input.closing ?? []) body.push(paragraph(text, COLORS.muted, 14));

  const html =
    `<!DOCTYPE html>` +
    `<html lang="${input.lang}" dir="${dir}">` +
    `<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light">` +
    `<title>${escapeHtml(input.subject)}</title></head>` +
    `<body style="margin:0;padding:0;background:${COLORS.page};font-family:${FONT};" dir="${dir}">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${COLORS.page};"><tr><td align="center" style="padding:32px 16px;">` +
    `<table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;" dir="${dir}">` +
    // Wordmark
    `<tr><td style="padding:0 8px 20px;text-align:${align};">` +
    `<span style="font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:700;letter-spacing:0.5px;color:${COLORS.primary};">Joutiya</span>` +
    `<div style="width:48px;height:3px;margin-top:8px;background:${COLORS.rule};border-radius:2px;${rtl ? "margin-left:auto;" : ""}"></div>` +
    `</td></tr>` +
    // Card
    `<tr><td style="padding:32px 28px;background:${COLORS.card};border:1px solid ${COLORS.cardBorder};border-radius:16px;text-align:${align};">${body.join("")}</td></tr>` +
    // Footer
    `<tr><td style="padding:24px 8px 0;text-align:${align};">` +
    `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(publisher)}</p>` +
    `<p style="margin:0 0 6px;font-size:12px;line-height:1.5;color:${COLORS.muted};"><a href="${escapeHtml(input.siteUrl)}" style="color:${COLORS.link};text-decoration:underline;">${escapeHtml(footer.site)}</a> · ${escapeHtml(siteHost)}</p>` +
    `<p style="margin:0;font-size:12px;line-height:1.5;color:${COLORS.muted};">${escapeHtml(footer.auto)}</p>` +
    `</td></tr>` +
    `</table></td></tr></table></body></html>`;

  const lines: string[] = [input.title, "", input.greeting, "", ...input.paragraphs.flatMap((text) => [text, ""])];
  if (input.action) lines.push(`${input.action.label} : ${input.action.url}`, "");
  for (const link of input.links ?? []) lines.push(`${link.label} ${link.url}`, "");
  for (const text of input.closing ?? []) lines.push(text, "");
  lines.push("—", publisher, `${footer.site} : ${input.siteUrl}`, footer.auto);
  const text = lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();

  return { subject: input.subject, html, text, ...(input.replyTo ? { replyTo: input.replyTo } : {}) };
}
