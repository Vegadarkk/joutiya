import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { VerificationSection } from "@/components/auth/settings-view";
import { ContactStep } from "@/components/post/steps/contact-step";
import type { Locale } from "@/config/site";
import { InitialSessionContext } from "@/lib/auth/client";
import { PublicConfigProvider } from "@/lib/config/client";
import type { PublicConfig } from "@/lib/config/public-types";
import type { SessionSummary } from "@/lib/contracts/auth";
import type { OwnerListing } from "@/lib/contracts/listings";
import { WizardProvider } from "@/lib/listings/client/store";

// WhatsApp parked (no phone number id): /api/auth/phone/start answers 503, so no screen may send
// the person there. The runtime config says whether the check is open.

const config = (phoneVerification: boolean): PublicConfig => ({
  env: "staging",
  siteUrl: "https://staging.joutiya.ma",
  firebase: null,
  turnstileSiteKey: null,
  googleClientId: null,
  sentry: null,
  mediaBaseUrl: null,
  upload: { maxBytes: 10 * 1024 * 1024, maxPhotos: 10 },
  map: null,
  phoneVerification,
  ads: { mode: "off", cmpEea: false, client: null, units: { leaderboard: null, halfpage: null, rectangle: null, banner: null } },
});

const session = (phoneVerified: boolean): SessionSummary => ({
  uid: "u1",
  email: "vendeur@example.com",
  emailVerified: true,
  role: "individual",
  suspended: false,
  displayName: "Vendeur",
  publicId: "p1",
  phoneVerified,
  locale: "fr",
  providers: ["password"],
  cguUpdate: null,
});

const listing: OwnerListing = {
  id: "l1",
  slugId: null,
  status: "draft",
  pausedReason: null,
  categoryId: null,
  subcategoryId: null,
  title: "",
  description: "",
  attributes: {},
  condition: null,
  price: null,
  priceNegotiable: false,
  isDonation: false,
  location: null,
  photos: [],
  contact: { showPhone: false, whatsapp: false },
  sensitiveDeclaration: null,
  moderation: { state: "auto_ok", flags: [] },
  version: 1,
  createdAt: "2026-10-19T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
  publishedAt: null,
  expiresAt: null,
};

/** Text as React's static markup escapes it. */
const esc = (text: string) => text.replace(/'/g, "&#x27;");

function render(node: ReactNode, { open, verified, locale = "fr" }: { open: boolean; verified: boolean; locale?: Locale }): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <PublicConfigProvider value={config(open)}>
        <InitialSessionContext.Provider value={session(verified)}>{node}</InitialSessionContext.Provider>
      </PublicConfigProvider>
    </NextIntlClientProvider>,
  );
}

const contactStep = (
  <WizardProvider listing={listing} maxPhotos={10} mediaBaseUrl={null}>
    <ContactStep onNext={() => undefined} />
  </WizardProvider>
);

describe("settings: phone row", () => {
  it("links to /verifications while the check is open", () => {
    const html = render(<VerificationSection session={session(false)} />, { open: true, verified: false });
    expect(html).toContain(">Vérifier mon numéro</a>");
    expect(html).not.toContain(fr.Auth.settings.verification.phoneSoon);
  });

  it("says the check is not open yet instead of a link that ends on a 503", () => {
    const html = render(<VerificationSection session={session(false)} />, { open: false, verified: false });
    expect(html).not.toContain("/verifications");
    expect(html).toContain(fr.Auth.settings.verification.phoneSoon);
    expect(render(<VerificationSection session={session(false)} />, { open: false, verified: false, locale: "ar" })).toContain(ar.Auth.settings.verification.phoneSoon);
  });

  it("keeps a badge earned earlier reachable", () => {
    const html = render(<VerificationSection session={session(true)} />, { open: false, verified: true });
    expect(html).toContain(">Voir la vérification</a>");
  });
});

describe("listing wizard: contact step", () => {
  it("offers the verification link while the check is open", () => {
    const html = render(contactStep, { open: true, verified: false });
    expect(html).toContain(fr.Listing.contact.phoneNotVerified);
    expect(html).toContain(fr.Listing.contact.verifyLink);
    expect(html).not.toContain(esc(fr.Listing.contact.verifySoon));
  });

  it("explains why the switches stay off, without the link or the warning badge, while it is closed", () => {
    const html = render(contactStep, { open: false, verified: false });
    expect(html).not.toContain("/verifications");
    expect(html).not.toContain(fr.Listing.contact.phoneNotVerified);
    expect(html).toContain(esc(fr.Listing.contact.verifySoon));
    // Messaging stays the way to reach the seller.
    expect(html).toContain(fr.Listing.contact.messagesAlways);
  });

  it("shows the verified badge whatever the check's state", () => {
    const html = render(contactStep, { open: false, verified: true });
    expect(html).toContain(fr.Listing.contact.phoneVerified);
    expect(html).not.toContain(esc(fr.Listing.contact.verifySoon));
  });
});
