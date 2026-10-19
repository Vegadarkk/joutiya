import type * as React from "react";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import type { Locale } from "@/config/site";
import type * as AuthClient from "@/lib/auth/client";

// Retry paths of the two Turnstile islands: /anti-robot never resets the widget by itself after a
// refusal (the managed widget would solve again at once and a lasting refusal would post in a
// loop) and offers "Réessayer"; the search challenge's "limited" state offers a way back. No DOM
// here: the island's state is seeded through useState, and the widget is a stub that records its
// props and hands a reset spy as its handle.

const seed = vi.hoisted(() => ({ state: undefined as unknown }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  const isIslandState = (value: unknown) => typeof value === "object" && value !== null && "kind" in value;
  const useState = ((initial: unknown) => actual.useState(seed.state !== undefined && isIslandState(initial) ? seed.state : initial)) as typeof actual.useState;
  return { ...actual, useState, default: { ...actual, useState } };
});

const widget = vi.hoisted(() => ({ onToken: undefined as ((token: string | null) => unknown) | undefined, reset: vi.fn() }));
vi.mock("@/components/auth/turnstile-widget", () => ({
  TurnstileWidget: ({ ref, onToken, className }: { ref?: { current: unknown }; onToken: (token: string | null) => unknown; className?: string }) => {
    widget.onToken = onToken;
    if (ref) ref.current = { reset: widget.reset };
    return <div data-testid="turnstile" className={className} />;
  },
}));
vi.mock("@/lib/auth/client", async (importOriginal) => ({ ...(await importOriginal<typeof AuthClient>()), apiPost: vi.fn() }));
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
  usePathname: () => "/fr/recherche",
}));

const { ApiError, apiPost } = await import("@/lib/auth/client");
const { PageChallenge } = await import("@/components/challenge/page-challenge");
const { SearchChallenge } = await import("@/components/search/search-challenge");

function render(node: ReactNode, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
const button = (label: string) => new RegExp(`<button[^>]*type="button"[^>]*>${label}</button>`);

beforeEach(() => {
  seed.state = undefined;
  widget.onToken = undefined;
  widget.reset.mockClear();
  vi.mocked(apiPost).mockReset();
});

describe("PageChallenge", () => {
  it("does not ask the widget for a new token after a refusal", async () => {
    render(<PageChallenge next="/fr/annonce/velo-abcd2345" />);
    for (const refusal of [new ApiError(429, "rate_limited", { retryAfter: 120 }), new ApiError(403, "turnstile_failed"), new ApiError(503, "unavailable")]) {
      vi.mocked(apiPost).mockRejectedValueOnce(refusal);
      await widget.onToken?.("token");
    }
    expect(apiPost).toHaveBeenCalledTimes(3);
    expect(widget.reset).not.toHaveBeenCalled();
  });

  it("explains a refusal and offers a new check, in French and Arabic", () => {
    seed.state = { kind: "failed", message: "Trop de tentatives. Réessayez dans 2 minutes." };
    const html = render(<PageChallenge next="/fr" />);
    expect(text(html)).toContain(`${fr.Challenge.failedTitle} Trop de tentatives. Réessayez dans 2 minutes.`);
    expect(html).toMatch(button(fr.Challenge.again));
    expect(render(<PageChallenge next="/ar" />, "ar")).toMatch(button(ar.Challenge.again));
  });

  it("waits for the widget, and lets the widget's own alert replace the status line and the empty box", () => {
    const html = render(<PageChallenge next="/fr" />);
    expect(text(html)).toContain(fr.Challenge.waiting);
    expect(html).not.toContain("<button");
    expect(html).toMatch(/data-testid="turnstile" class="peer\/turnstile has-\[\[role=alert\]\]:\[&amp;&gt;\[data-turnstile\]\]:min-h-0"/);
    expect(html).toMatch(/<p role="status"[^>]*class="[^"]*peer-has-\[\[role=alert\]\]\/turnstile:hidden/);
  });
});

describe("SearchChallenge", () => {
  it("offers a new check once limited, in place of a dead end", () => {
    seed.state = { kind: "limited", retryAfter: 90 };
    const html = render(<SearchChallenge params={{ q: "velo" }} />);
    expect(text(html)).toContain(fr.SearchPage.challenge.limited.replace("{wait}", "dans 2 minutes"));
    expect(html).toMatch(button(fr.SearchPage.challenge.again));
    expect(html).not.toContain('data-testid="turnstile"');
    expect(render(<SearchChallenge params={{ q: "velo" }} />, "ar")).toMatch(button(ar.SearchPage.challenge.again));
  });

  it("keeps the widget and the retry for a refused token", () => {
    seed.state = { kind: "failed" };
    const html = render(<SearchChallenge params={{ q: "velo" }} />);
    expect(text(html)).toContain(fr.SearchPage.challenge.failed);
    expect(html).toMatch(button(fr.SearchPage.challenge.again));
    expect(html).toContain('data-testid="turnstile"');
  });
});
