import type { ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import { loadRevealChallenge, loadRevealError, RevealFeedbackFallback } from "@/components/listing/contact-bar";
import { loadLightboxView } from "@/components/listing/gallery";

// On-demand chunks of the listing page (reveal feedback, lightbox): a chunk that cannot be
// downloaded (a tab opened before a redeploy, a dropped mobile connection) resolves to a stand-in
// that retries the download once mounted, instead of throwing into the page's error view. The
// retry itself runs in an effect: tests/e2e/listing.spec.ts covers it in a browser.

vi.mock("@/components/listing/contact-feedback", () => {
  throw new Error("Loading chunk contact-feedback failed");
});
vi.mock("@/components/listing/lightbox", () => {
  throw new Error("Loading chunk lightbox failed");
});

const escape = (value: string) => value.replace(/'/g, "&#x27;");

describe("loadWithRetry", () => {
  it("resolves to the component when its chunk loads", async () => {
    const Loaded: ComponentType<{ name: string }> = ({ name }) => <p>{name}</p>;
    const Fallback: ComponentType<{ name: string }> = () => <p>fallback</p>;
    expect(await loadWithRetry(async () => Loaded, Fallback)()).toBe(Loaded);
  });

  it("resolves to a stand-in, never rejects, when the chunk cannot be downloaded; it renders nothing before its retry", async () => {
    const Fallback: ComponentType<{ name: string }> = () => <p>fallback</p>;
    const Standin = await loadWithRetry<{ name: string }>(() => Promise.reject(new Error("ChunkLoadError")), Fallback)();
    expect(Standin).not.toBe(Fallback);
    expect(renderToStaticMarkup(<Standin name="a" />)).toBe("");
  });
});

describe("listing page chunks that fail to download", () => {
  it("resolve the reveal feedback and the lightbox to stand-ins", async () => {
    for (const load of [loadRevealError, loadRevealChallenge, loadLightboxView] as const) await expect(load()).resolves.toBeTypeOf("function");
  });

  it("ask the visitor to reload the page, in French and in Arabic", () => {
    for (const [locale, messages] of [
      ["fr", fr],
      ["ar", ar],
    ] as const) {
      const html = renderToStaticMarkup(
        <NextIntlClientProvider locale={locale} messages={messages} timeZone="Africa/Casablanca">
          <RevealFeedbackFallback />
        </NextIntlClientProvider>,
      );
      expect(html).toContain('role="alert"');
      expect(html).toContain(escape(messages.ListingPage.contact.errors.outdated));
      expect(html).toMatch(new RegExp(`<button[^>]*type="button"[^>]*>(?:(?!</button>).)*${messages.ListingPage.contact.reload}</button>`));
    }
  });
});
