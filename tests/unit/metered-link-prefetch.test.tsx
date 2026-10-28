import type { ComponentProps, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import type { PublicSeller } from "@/lib/listings/public";

// Links to metered pages (/annonce, /c, /profil, /boutique, D14) on the listing page must not
// prefetch: a prefetch counts against the page-view limits like a visit. The static markup does not
// carry the prop, so the localized Link is replaced by an anchor that prints it.

vi.mock("@/i18n/navigation", () => ({
  Link: ({ href, prefetch, children, ...rest }: Omit<ComponentProps<"a">, "href"> & { href: string | { pathname: string }; prefetch?: boolean | null; children?: ReactNode }) => (
    <a href={typeof href === "string" ? href : href.pathname} data-prefetch={String(prefetch)} {...rest}>
      {children}
    </a>
  ),
}));

const { Breadcrumb, landingHref } = await import("@/components/listing/breadcrumb");
const { SellerCard } = await import("@/components/listing/seller-card");

const render = (node: ReactNode) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );

/** `prefetch` of every link, by href. */
const prefetchOf = (html: string) => [...html.matchAll(/<a href="([^"]+)" data-prefetch="([^"]+)"/g)].map((match) => [match[1], match[2]]);

const seller: PublicSeller = {
  publicId: "abcdefghjk",
  displayName: "Salma",
  sellerType: "individual",
  memberSince: "2025-10",
  badges: { emailVerified: true, phoneVerified: true, proCertified: false },
  citySlug: "casablanca",
  publishedCount: 2,
  bio: null,
  bannerKey: "zellige",
};

describe("metered links of the listing page", () => {
  it("never prefetch the seller's profile", () => {
    const links = prefetchOf(render(<SellerCard seller={seller} fallbackName="" fallbackType="individual" locale="fr" />));
    expect(links).toEqual([
      ["/profil/abcdefghjk", "false"],
      ["/profil/abcdefghjk", "false"],
    ]);
  });

  it("never prefetch the category landing pages of the breadcrumb", () => {
    const html = render(
      <Breadcrumb
        current="Vélo"
        items={[
          { label: "Accueil", href: "/" },
          { label: "Véhicules", href: landingHref({ category: "vehicules" }) },
        ]}
      />,
    );
    expect(prefetchOf(html)).toEqual([
      ["/", "false"],
      ["/c/vehicules", "false"],
    ]);
  });
});
