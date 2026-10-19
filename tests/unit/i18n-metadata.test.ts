import { describe, expect, it, vi } from "vitest";
import type { Locale } from "@/config/site";
import { openGraphLocale, rootMetadata } from "@/lib/i18n/metadata";

// Root metadata of the localized pages (src/lib/i18n/metadata.ts): og:locale per locale, Tarifit
// indexed but without a valid Open Graph locale.

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const fr = (await import("../../messages/fr.json")).default;
  return {
    getTranslations: async ({ locale, namespace }: { locale: Locale; namespace?: string }) => createTranslator({ locale, messages: fr, namespace: namespace as never }),
  };
});

describe("Open Graph locale", () => {
  it("is language_TERRITORY for fr and ar, absent for Tarifit (rif-Latn has no valid og:locale)", () => {
    expect(openGraphLocale("fr")).toEqual({ locale: "fr_MA" });
    expect(openGraphLocale("ar")).toEqual({ locale: "ar_MA" });
    expect(openGraphLocale("rif")).toEqual({});
  });

  it("is set by the root metadata of fr and ar pages, left out of Tarifit pages", async () => {
    expect((await rootMetadata("fr")).openGraph).toEqual({ siteName: "Joutiya", locale: "fr_MA", type: "website" });
    expect((await rootMetadata("ar")).openGraph).toEqual({ siteName: "Joutiya", locale: "ar_MA", type: "website" });
    const rif = await rootMetadata("rif");
    expect(rif.openGraph).toEqual({ siteName: "Joutiya", type: "website" });
    expect(rif.openGraph).not.toHaveProperty("locale");
    // Still indexed: self-canonical, no robots rule, outside the hreflang cluster.
    expect(rif.alternates).toEqual({ canonical: "/rif" });
    expect(rif.robots).toBeUndefined();
  });
});
