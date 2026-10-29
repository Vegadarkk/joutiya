import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { hasLocale } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { routing } from "@/i18n/routing";
import { localeParams } from "@/i18n/params";
import { legalPage, type LegalSlug } from "@/config/legal-pages";
import { archivedVersion, archiveSegment, legalDay, LEGAL_ARCHIVE } from "@/config/legal-versions";
import { LegalPage } from "@/components/legal/legal-page";
import { getFlags } from "@/lib/config/runtime";
import { getLegalConfig } from "@/lib/legal/config";
import { parseMarkdown } from "@/lib/legal/markdown";
import { archivedLegalSource } from "@/lib/legal/sources";
import { renderTemplate } from "@/lib/legal/template";
import { legalScope } from "@/lib/legal/values";
import { archivedVersionNote } from "@/lib/legal/versions";
import { isPhoneVerificationConfigured } from "@/lib/phone-verify/config";

// Earlier versions of a legal page kept online (CGU §22.1 and §22.4, LEGAL_ARCHIVE): the text in
// force for members until the new version applies to them, then the record of what applied when.
// Filled like the current page; not indexed, the current text is the reference.
export const revalidate = 300;
export const dynamicParams = false;

export function generateStaticParams() {
  return localeParams(
    (Object.entries(LEGAL_ARCHIVE) as [LegalSlug, NonNullable<(typeof LEGAL_ARCHIVE)[LegalSlug]>][]).flatMap(([page, versions]) => versions.map((entry) => ({ page, version: archiveSegment(entry.version) }))),
  );
}

type Params = Promise<{ locale: string; page: string; version: string }>;

export async function generateMetadata({ params }: { params: Params }): Promise<Metadata> {
  const { locale, page: slug, version } = await params;
  const page = legalPage(slug);
  const entry = page ? archivedVersion(page.slug, version) : undefined;
  if (!page || !entry || !hasLocale(routing.locales, locale)) return {};
  const t = await getTranslations({ locale, namespace: "Footer.links" });
  return { title: `${t(page.key)} (${entry.version})`, robots: { index: false } };
}

export default async function ArchivedLegalRoute({ params }: { params: Params }) {
  const { locale, page: slug, version } = await params;
  const page = legalPage(slug);
  const entry = page ? archivedVersion(page.slug, version) : undefined;
  if (!page || !entry || !hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  // Archived pages are all translated (only pages with an Arabic text are versioned after launch).
  const language = locale === "ar" ? "ar" : "fr";
  const [config, flags] = await Promise.all([getLegalConfig(), getFlags()]);
  const scope = legalScope(config, { whatsapp: isPhoneVerificationConfigured(), ads: flags.adsMode !== "off", adsCmpEea: flags.adsCmpEea }, entry, language);
  const { text } = renderTemplate(archivedLegalSource(page.slug, entry.version, language), scope, { isolate: language === "ar" });
  return (
    <LegalPage
      blocks={parseMarkdown(text)}
      language={language}
      translated={language === "ar"}
      frenchOnly={locale !== "fr" && language === "fr"}
      archived={archivedVersionNote(page.slug, entry, language, legalDay(new Date()))}
    />
  );
}
