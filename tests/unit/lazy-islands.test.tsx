import type { ComponentType, ReactNode } from "react";
import { Suspense } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { prerender } from "react-dom/static";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { AccountMenu } from "@/components/auth/account-menu";
import { lazyIsland } from "@/components/layout/lazy-island";
import { LocaleLinks } from "@/components/layout/locale-switcher";
import { InitialSessionContext } from "@/lib/auth/client";
import type { SessionSummary } from "@/lib/contracts/auth";

// Lazy islands of the root layouts: a chunk that fails to download (stale tab after a redeploy,
// flaky network) renders a plain fallback instead of throwing into global-error.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/fr/annonce/velo-abcd2345",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));
// The account menu's chunk is gone (404 after a redeploy).
vi.mock("@/components/auth/account-dropdown", () => {
  throw new Error("Loading chunk account-dropdown failed");
});

/** Server rendering that waits for every lazy component (Suspense resolved), like the client does. */
async function settled(node: ReactNode): Promise<string> {
  const { prelude } = await prerender(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
  return new Response(prelude).text();
}

const session: SessionSummary = {
  uid: "uid-1",
  email: "salma@test.joutiya.ma",
  emailVerified: true,
  role: "individual",
  suspended: false,
  displayName: "Salma Benali",
  publicId: "abcdefghjk",
  phoneVerified: false,
  locale: "fr",
  providers: ["password"],
  cguUpdate: null,
};

describe("lazyIsland", () => {
  it("renders the chunk once loaded, and the fallback when the download fails", async () => {
    const Loaded: ComponentType<{ name: string }> = ({ name }) => <p>{`menu ${name}`}</p>;
    const Fallback: ComponentType<{ name: string }> = ({ name }) => <p>{`links ${name}`}</p>;
    const Ok = lazyIsland(async () => ({ default: Loaded }), Fallback);
    const Broken = lazyIsland<{ name: string }>(() => Promise.reject(new Error("ChunkLoadError")), Fallback);
    const html = await settled(
      <Suspense fallback={<p>trigger</p>}>
        <Ok name="a" />
        <Broken name="b" />
      </Suspense>,
    );
    expect(html).toContain("<p>menu a</p>");
    expect(html).toContain("<p>links b</p>");
  });
});

describe("AccountMenu without its chunk", () => {
  it("turns the signed-in trigger into a link to the account settings", async () => {
    const html = await settled(
      <InitialSessionContext.Provider value={session}>
        <AccountMenu />
      </InitialSessionContext.Provider>,
    );
    const link = /<a [^>]*href="\/fr\/parametres"[^>]*>([\s\S]*?)<\/a>/.exec(html);
    expect(link?.[0]).toContain("min-w-11");
    expect(link?.[1]).toContain(`<span class="sr-only">${fr.Auth.menu.account}</span>`);
    expect(link?.[1]).toContain("Salma Benali");
  });
});

describe("LocaleLinks (the language menu without its chunk)", () => {
  it("opens on the three languages of this page, the current one marked", () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
        <LocaleLinks triggerClassName="trigger" label="FR, Langue">
          FR
        </LocaleLinks>
      </NextIntlClientProvider>,
    );
    expect(html).toMatch(/<button type="button" aria-expanded="true" aria-controls="[^"]+" aria-label="FR, Langue" data-state="open" class="trigger">FR<\/button>/);
    const links = [...html.matchAll(/<a [^>]*>/g)].map((match) => match[0]);
    expect(links).toHaveLength(3);
    expect(links.map((link) => /href="([^"]+)"/.exec(link)?.[1])).toEqual(["/fr/annonce/velo-abcd2345", "/ar/annonce/velo-abcd2345", "/rif/annonce/velo-abcd2345"]);
    expect(links[0]).toContain('aria-current="true"');
    expect(links[2]).toContain('lang="rif-Latn"');
    expect(html).toContain(fr.Locale.names.ar);
  });
});
