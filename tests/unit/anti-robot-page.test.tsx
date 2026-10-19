import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";

// /anti-robot (design D14): private page of the page challenge; hands the validated `next` and the
// request nonce to the Turnstile island (stubbed: it needs the browser).

vi.mock("@/components/challenge/page-challenge", () => ({
  PageChallenge: ({ next, nonce }: { next: string; nonce?: string }) => <div data-testid="challenge" data-next={next} data-nonce={nonce} />,
}));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-nonce": "n0nce" }) }));
vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  const messages = { fr: (await import("../../messages/fr.json")).default, ar: (await import("../../messages/ar.json")).default };
  return {
    setRequestLocale: () => undefined,
    getTranslations: async ({ locale, namespace }: { locale: "fr" | "ar"; namespace?: string }) =>
      createTranslator({ locale, messages: messages[locale] ?? messages.fr, namespace: namespace as never }),
  };
});

const { default: ChallengePage, generateMetadata } = await import("@/app/[locale]/(private)/anti-robot/page");

async function render(next: string | string[] | undefined, locale = "fr"): Promise<string> {
  const tree = await ChallengePage({ params: Promise.resolve({ locale }), searchParams: Promise.resolve(next === undefined ? {} : { next }) });
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {tree}
    </NextIntlClientProvider>,
  );
}

describe("anti-robot page", () => {
  it("returns to the interrupted page after the challenge", async () => {
    const html = await render("/fr/annonce/velo-abcd2345?ref=1");
    expect(html).toContain('data-next="/fr/annonce/velo-abcd2345?ref=1"');
    expect(html).toContain('data-nonce="n0nce"');
    expect(html).toMatch(/<h1[^>]*>Une vérification avant de continuer<\/h1>/);
    expect(html).toContain('href="/fr"');
  });

  it("never sends the visitor off-site or into a loop", async () => {
    for (const next of ["https://evil.example", "//evil.example", "/fr/anti-robot", ["/api/x", "/fr"], undefined]) {
      expect(await render(next, "ar"), String(next)).toContain('data-next="/ar"');
    }
  });

  it("has its own title", async () => {
    expect(await generateMetadata({ params: Promise.resolve({ locale: "fr" }), searchParams: Promise.resolve({}) })).toEqual({ title: "Vérification anti-robots" });
  });
});
