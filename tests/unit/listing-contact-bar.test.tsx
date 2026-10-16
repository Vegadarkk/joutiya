import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { ContactBar, isWhatsappUrl, REVEAL_ERROR_KEYS, revealFailure, type ContactBarProps } from "@/components/listing/contact-bar";
import { ApiError, InitialSessionContext, type ApiErrorCode } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";

// The contact island of the listing page (design §5): server HTML (shared by every visitor, so no
// number and no per-viewer state in it) and the mapping of the reveal API's refusals.

const base: ContactBarProps = { listingId: "abcd2345", slugId: "velo-de-ville-casablanca-abcd2345", sellerPublicId: "abcdefghjk", showPhone: true, whatsapp: true };

function render(props: Partial<ContactBarProps> = {}, session?: SessionSummary | null) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr}>
      <InitialSessionContext.Provider value={session}>
        <ContactBar {...base} {...props} />
      </InitialSessionContext.Provider>
    </NextIntlClientProvider>,
  );
}

const escape = (value: string) => value.replace(/'/g, "&#x27;");
const error = (code: ApiErrorCode, status = 403) => new ApiError(status, code);

describe("revealFailure", () => {
  it("sends an expired session to sign-in", () => {
    expect(revealFailure(error("unauthenticated", 401))).toBe("signin");
  });

  it("gives the reveal refusals their own message", () => {
    for (const key of REVEAL_ERROR_KEYS) {
      if (key === "turnstile_failed") continue;
      expect(revealFailure(error(key)), key).toBe(key);
    }
    // No challenge can run under the public hash CSP: a failed one reads like a required one.
    expect(revealFailure(error("turnstile_failed"))).toBe("turnstile_required");
  });

  it("falls back to the generic API message for anything else", () => {
    expect(revealFailure(error("forbidden"))).toBeNull();
    expect(revealFailure(error("internal", 500))).toBeNull();
    expect(revealFailure(new Error("boom"))).toBeNull();
  });

  it("has a French message for every reveal refusal", () => {
    for (const key of REVEAL_ERROR_KEYS) expect(fr.ListingPage.contact.errors[key], key).toBeTruthy();
  });
});

describe("isWhatsappUrl", () => {
  it("accepts only the wa.me links the reveal API builds", () => {
    expect(isWhatsappUrl("https://wa.me/212612345678")).toBe(true);
    for (const url of ["javascript:alert(1)", "http://wa.me/212612345678", "https://wa.me.evil.test/212612345678", "https://wa.me/212612345678?text=x", "https://wa.me/"]) expect(isWhatsappUrl(url), url).toBe(false);
  });
});

describe("ContactBar", () => {
  it("never puts a number in the shared HTML: a reveal button and the disabled message button", () => {
    const html = render();
    expect(html).toContain(fr.ListingPage.contact.showPhone);
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("wa.me");
    expect(html).not.toMatch(/\+212|0[67]\d{8}/);
    expect(html).toContain(fr.ListingPage.contact.message);
    expect(html).toContain(fr.ListingPage.contact.soon);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*aria-describedby="([^"]+)"/);
    const describedBy = /aria-describedby="([^"]+)"/.exec(html)?.[1];
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain(escape(fr.ListingPage.contact.messagingSoon));
  });

  it("offers WhatsApp when the seller shows no phone number", () => {
    const html = render({ showPhone: false });
    expect(html).toContain(fr.ListingPage.contact.showWhatsapp);
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
  });

  it("keeps only the message placeholder when the seller offers neither", () => {
    const html = render({ showPhone: false, whatsapp: false });
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
    expect(html).not.toContain(fr.ListingPage.contact.showWhatsapp);
    expect(html).toContain(fr.ListingPage.contact.messagingSoonOnly);
    expect(html).not.toContain("fixed inset-x-0");
  });

  it("puts the actions in a bar fixed to the bottom of phone screens, with a safe-area inset", () => {
    const html = render();
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("shows the seller their own listing's management link instead of the actions", () => {
    const own = { uid: "u1", publicId: "abcdefghjk", displayName: "Salma", role: "individual" } as unknown as SessionSummary;
    const html = render({}, own);
    expect(html).toContain(escape(fr.ListingPage.contact.own));
    expect(html).toContain('href="/fr/mes-annonces"');
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
    const other = { ...own, publicId: "zzzzzzzzzz" } as SessionSummary;
    expect(render({}, other)).toContain(fr.ListingPage.contact.showPhone);
  });
});
