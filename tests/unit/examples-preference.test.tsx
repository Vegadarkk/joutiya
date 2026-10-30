import { readFileSync } from "node:fs";
import type * as NextNavigation from "next/navigation";
import type { ReactNode } from "react";
import { renderToStaticMarkup, renderToString } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it, vi } from "vitest";
import fr from "../../messages/fr.json";
import { ExamplesHiddenNotice, ExamplesSwitch } from "@/components/examples/examples-controls";
import { ExamplesScript } from "@/components/examples/examples-script";
import { ExampleBanner } from "@/components/listing/example-banner";
import { EXAMPLES_SCRIPT, examplesHiddenIn } from "@/lib/examples/script";
import { inlineScripts, PINNED_SCRIPT_HASHES } from "@/lib/security/inline-hashes";

// « Masquer les annonces exemples » (owner, 2026-10-30): a device cookie the server reads for the
// search, mirrored on html[data-examples] before paint for the pages rendered once for everyone.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr",
}));

function render(node: ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

/** Runs the pre-paint script against a document with `cookie`; the attributes it set. */
function prePaint(cookie: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  const document = { cookie, documentElement: { setAttribute: (name: string, value: string) => (attributes[name] = value) } };
  new Function("document", EXAMPLES_SCRIPT)(document);
  return attributes;
}

describe("examples preference", () => {
  it("reads the choice from the cookie, on the server and before paint", () => {
    for (const cookie of ["examples=hidden", "theme=dark; examples=hidden", "examples=hidden; NEXT_LOCALE=ar", "a=1;examples=hidden"]) {
      expect(examplesHiddenIn(cookie), cookie).toBe(true);
      expect(prePaint(cookie), cookie).toEqual({ "data-examples": "hidden" });
    }
    for (const cookie of ["", "examples=", "examples=shown", "myexamples=hidden", "examples=hiddenx", "x=examples=hidden"]) {
      expect(examplesHiddenIn(cookie), cookie).toBe(false);
      expect(prePaint(cookie), cookie).toEqual({});
    }
    expect(examplesHiddenIn(null)).toBe(false);
  });

  it("runs as a pinned inline script, allowed by hash on the shared pages", () => {
    const { hashes, untrusted } = inlineScripts(renderToString(<ExamplesScript />));
    expect(untrusted).toBe(0);
    expect(hashes).toHaveLength(1);
    expect(PINNED_SCRIPT_HASHES.has(hashes[0] ?? "")).toBe(true);
  });

  it("hides the example cards and map rows with the attribute, except on an example shop", () => {
    const css = readFileSync("src/styles/globals.css", "utf8");
    expect(css).toContain('html[data-examples="hidden"] body:not(:has([data-example-page])) :is([data-example], li:has(> [data-example]))');
  });
});

describe("examples controls", () => {
  it("offers the switch on the settings page, off by default", () => {
    const html = render(<ExamplesSwitch />);
    expect(html).toContain(fr.Examples.label);
    expect(html).toContain(fr.Examples.hint.replace(/'/g, "&#x27;"));
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="false"');
  });

  it("says nothing on the server: the notice only shows once the browser knows the choice", () => {
    expect(render(<ExamplesHiddenNotice />)).toBe("");
  });

  it("lets a visitor hide the examples from an example's banner, and keeps an example shop's own listings", () => {
    const listing = render(<ExampleBanner />);
    expect(listing).toContain('data-testid="examples-toggle"');
    expect(listing).toContain(fr.Examples.hide);
    expect(listing).not.toContain("data-example-page");
    expect(render(<ExampleBanner scope="shop" />)).toContain('data-example-page=""');
  });
});
