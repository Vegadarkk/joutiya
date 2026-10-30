import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { ContactBar, isWhatsappUrl, messageStep, REVEAL_ERROR_KEYS, revealFailure, threadHref, type ContactBarProps } from "@/components/listing/contact-bar";
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
  it("never puts a number in the shared HTML: a reveal button and the message button", () => {
    const html = render();
    expect(html).toContain(fr.ListingPage.contact.showPhone);
    expect(html).not.toContain("tel:");
    expect(html).not.toContain("wa.me");
    expect(html).not.toMatch(/\+212|0[67]\d{8}/);
    expect(html).toContain(fr.ListingPage.contact.message);
    expect(html).toContain(fr.ListingPage.contact.messageShort);
  });

  it("enables the message button for everyone, described by its hint, with no 'soon' wording", () => {
    for (const session of [undefined, null, { uid: "u2", publicId: "zzzzzzzzzz", role: "individual", phoneVerified: false } as SessionSummary]) {
      const html = render({}, session);
      const buttons = html.match(/<button[^>]*aria-haspopup="dialog"[^>]*>/g) ?? [];
      // One in the seller card (lg), one in the phone bar.
      expect(buttons).toHaveLength(2);
      for (const button of buttons) expect(button).not.toContain(" disabled=\"\"");
      const describedBy = /aria-haspopup="dialog"[^>]*aria-describedby="([^"]+)"|aria-describedby="([^"]+)"[^>]*aria-haspopup="dialog"/.exec(html);
      const id = describedBy?.[1] ?? describedBy?.[2];
      expect(html).toContain(`id="${id}"`);
      expect(html).toContain(escape(fr.ListingPage.contact.messageHint));
      expect(html).not.toMatch(/bientôt/i);
    }
  });

  it("offers WhatsApp when the seller shows no phone number", () => {
    const html = render({ showPhone: false });
    expect(html).toContain(fr.ListingPage.contact.showWhatsapp);
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
  });

  it("keeps only the message button, as the main action, when the seller offers neither", () => {
    const html = render({ showPhone: false, whatsapp: false });
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
    expect(html).not.toContain(fr.ListingPage.contact.showWhatsapp);
    // The phone bar holds the full label (no short one next to a phone button).
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html).not.toContain(`>${fr.ListingPage.contact.messageShort}<`);
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
  });

  it("puts the actions in a bar fixed to the bottom of phone screens, with a safe-area inset", () => {
    const html = render();
    expect(html).toContain("fixed inset-x-0 bottom-0");
    expect(html).toContain("lg:hidden");
    expect(html).toContain("env(safe-area-inset-bottom)");
  });

  it("offers a test drive on a dealer's vehicle only, as a third dialog button with its hint", () => {
    expect(render()).not.toContain(fr.ListingPage.contact.testDrive);
    const html = render({ testDrive: true });
    expect(html).toContain(fr.ListingPage.contact.testDrive);
    expect(html).toContain(escape(fr.ListingPage.contact.testDriveHint));
    // Two message buttons, the block's button and the phone bar's.
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(4);
    const own = { uid: "u1", publicId: "abcdefghjk", role: "pro" } as unknown as SessionSummary;
    expect(render({ testDrive: true }, own)).not.toContain(fr.ListingPage.contact.testDrive);
  });

  it("puts the listing's own action beside the message in the phone bar, the number as an icon", () => {
    expect(render()).not.toContain('data-testid="contact-bar-action"');
    expect(render()).not.toContain(`aria-label="${fr.ListingPage.contact.showPhone}"`);
    const drive = render({ testDrive: true });
    expect(drive).toContain('data-testid="contact-bar-action" data-intent="test_drive"');
    expect(drive).toContain(fr.ListingPage.contact.testDriveShort);
    expect(drive).toContain(`aria-label="${fr.ListingPage.contact.showPhone}"`);
    const offer = render({ offer: { price: 1500 }, showPhone: false, whatsapp: false });
    expect(offer).toContain('data-intent="offer"');
    expect(offer).toContain(fr.Offers.listing.makeShort);
    expect(offer).not.toContain("aria-label=");
    expect(render({ rental: "day" })).toContain(fr.ListingPage.contact.rentalShort);
    expect(render({ rental: "night" })).toContain(fr.ListingPage.contact.home.rentalShort);
    // One action only, the dates before a visit, the visit before an offer.
    const both = render({ visit: true, offer: { price: 1500 } });
    expect(both.match(/data-testid="visit-button"/g)).toHaveLength(2);
    expect(both).not.toContain('data-testid="contact-bar-action"');
    expect(render({ rental: "day", visit: true })).toContain('data-intent="rental"');
  });

  it("shows the seller their own listing's management link instead of the actions", () => {
    const own = { uid: "u1", publicId: "abcdefghjk", displayName: "Salma", role: "individual" } as unknown as SessionSummary;
    const html = render({}, own);
    expect(html).toContain(escape(fr.ListingPage.contact.own));
    expect(html).toContain('href="/fr/mes-annonces"');
    expect(html).not.toContain(fr.ListingPage.contact.showPhone);
    expect(html).not.toContain(fr.ListingPage.contact.message);
    expect(html).not.toContain("aria-haspopup");
    const other = { ...own, publicId: "zzzzzzzzzz" } as SessionSummary;
    expect(render({}, other)).toContain(fr.ListingPage.contact.showPhone);
  });
});

describe("visit request (real estate)", () => {
  it("adds a visit button next to the message one, on desktop and in the phone bar", () => {
    expect(render()).not.toContain('data-testid="visit-button"');
    const html = render({ visit: true });
    expect(html.match(/data-testid="visit-button"/g)).toHaveLength(2);
    expect(html).toContain(fr.ListingPage.contact.visit);
    expect(html).toContain(fr.ListingPage.contact.visitShort);
  });

  it("opens the conversation on the visit slots", () => {
    expect(threadHref("c123", "visit")).toBe("/messages/c123?rdv=visit");
    expect(threadHref("c123", "message")).toBe("/messages/c123");
  });
});

describe("booking request (car rental)", () => {
  it("adds the booking request button and opens the plain thread", () => {
    expect(render()).not.toContain('data-testid="rental-request-button"');
    const html = render({ rental: "day" });
    expect(html).toContain('data-testid="rental-request-button"');
    expect(html).toContain(fr.ListingPage.contact.rental);
    expect(threadHref("c123", "rental")).toBe("/messages/c123");
  });

  it("asks for a stay on a holiday home", () => {
    const html = render({ rental: "night" }).replaceAll("&#x27;", "'");
    expect(html).toContain(fr.ListingPage.contact.home.rental);
    expect(html).toContain(fr.ListingPage.contact.home.rentalHint);
  });
});

describe("messageStep", () => {
  const member = { uid: "u2", publicId: "zzzzzzzzzz", role: "individual", phoneVerified: false } as SessionSummary;
  const deps = (viewer: SessionSummary | null, find: (id: string) => Promise<string | null>) => ({ loadSession: async () => viewer, findListingConversation: find });

  it("asks an anonymous visitor to sign in, without looking for a conversation", async () => {
    let looked = false;
    const step = await messageStep("abcd2345", deps(null, async () => ((looked = true), null)));
    expect(step).toEqual({ kind: "signin" });
    expect(looked).toBe(false);
  });

  it("opens the conversation the buyer already has about the listing", async () => {
    const step = await messageStep("abcd2345", deps(member, async (id) => (id === "abcd2345" ? "C".repeat(22) : null)));
    expect(step).toEqual({ kind: "thread", cid: "C".repeat(22) });
  });

  it("opens the first-message dialog otherwise, phone verified or not, and when the lookup fails", async () => {
    expect(await messageStep("abcd2345", deps(member, async () => null))).toEqual({ kind: "compose" });
    expect(await messageStep("abcd2345", deps({ ...member, phoneVerified: true }, async () => null))).toEqual({ kind: "compose" });
    expect(await messageStep("abcd2345", deps(member, async () => Promise.reject(new ApiError(429, "rate_limited"))))).toEqual({ kind: "compose" });
  });
});
