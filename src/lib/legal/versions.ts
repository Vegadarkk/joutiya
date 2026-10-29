import { archiveSegment, LEGAL_ARCHIVE, LEGAL_VERSIONS, type ArchivedLegalVersion } from "@/config/legal-versions";
import type { LegalSlug } from "@/config/legal-pages";
import type { LegalPageProps } from "@/components/legal/legal-page";
import { formatLegalDate } from "./values";

// The version notes of a legal page (CGU §22.1 and §22.4): on the current text, the version still
// in force while the new one is announced, or the list of earlier versions; on an archived text,
// until when it applies. `today` is an ISO day in Casablanca (legalDay).

export function archiveHref(slug: LegalSlug, version: string): string {
  return `/legal/${slug}/${archiveSegment(version)}`;
}

export function currentVersionNotes(slug: LegalSlug, language: "fr" | "ar", today: string): Pick<LegalPageProps, "upcoming" | "archive"> {
  const archive = LEGAL_ARCHIVE[slug] ?? [];
  const current = LEGAL_VERSIONS[slug];
  const previous = archive[0];
  return {
    upcoming: previous && current.effective > today ? { date: formatLegalDate(current.effective, language), previous: { version: previous.version, href: archiveHref(slug, previous.version) } } : undefined,
    archive: archive.map((entry) => ({ version: entry.version, from: formatLegalDate(entry.effective, language), replacedOn: formatLegalDate(entry.replacedOn, language), href: archiveHref(slug, entry.version) })),
  };
}

export function archivedVersionNote(slug: LegalSlug, entry: ArchivedLegalVersion, language: "fr" | "ar", today: string): NonNullable<LegalPageProps["archived"]> {
  return { version: entry.version, replacedOn: formatLegalDate(entry.replacedOn, language), inForce: entry.replacedOn > today, currentHref: `/legal/${slug}` };
}
