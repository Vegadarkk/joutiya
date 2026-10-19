import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type * as NextNavigation from "next/navigation";
import type { UseFormRegisterReturn } from "react-hook-form";
import { describe, expect, it, vi } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { ConsentFields, TRANSFER_PROVIDERS, TransfersDetails } from "@/components/auth/consent-fields";
import { TransfersReconsent } from "@/components/auth/transfers-reconsent";
import { RATE_LIMITS } from "@/config/rate-limits";
import { LEGAL_TEXTS } from "@/content/legal/fr";
import { needsTransfersReconsent } from "@/lib/auth/consents";
import { AUTH_API } from "@/lib/contracts/endpoints";
import { TRANSFERS_CONSENT_VERSION, transfersConsentSchema } from "@/lib/contracts/auth";

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  usePathname: () => "/fr/parametres",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

// Transfers consent (art. 44 loi 09-08, design D12, audit C2-04): the text names each provider,
// its role and region; an older stored version gets the blocking re-consent panel.

const field = (name: string): UseFormRegisterReturn => ({ name, onChange: async () => undefined, onBlur: async () => undefined, ref: () => undefined });
const fields = { cgu: field("cgu"), transfers: field("transfers"), marketing: field("marketing") };

function render(node: ReactNode, locale: "fr" | "ar" = "fr"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "ar" ? ar : fr}
      timeZone="Africa/Casablanca"
      // A missing key fails the test instead of rendering its path.
      onError={(error) => {
        throw error;
      }}
    >
      {node}
    </NextIntlClientProvider>,
  );
}

const consent = (version?: string) => ({ consents: { cgu: { version: "2026-10", at: new Date() }, transfers: version === undefined ? undefined : { version, at: new Date() }, marketing: false } }) as never;

describe("needsTransfersReconsent", () => {
  it("asks again for any version other than the current one", () => {
    expect(TRANSFERS_CONSENT_VERSION).toBe("2026-10-19");
    expect(needsTransfersReconsent(consent("2026-10"))).toBe(true);
    expect(needsTransfersReconsent(consent(undefined))).toBe(true);
    expect(needsTransfersReconsent(consent(TRANSFERS_CONSENT_VERSION))).toBe(false);
  });

  it("leaves an account without private document alone (nothing to renew)", () => {
    expect(needsTransfersReconsent(null)).toBe(false);
  });
});

describe("POST /api/auth/consents contract", () => {
  it("accepts only { transfers: true }", () => {
    expect(AUTH_API.consents).toBe("/api/auth/consents");
    expect(transfersConsentSchema.safeParse({ transfers: true }).success).toBe(true);
    for (const body of [{}, { transfers: false }, { transfers: "true" }, { transfers: true, version: "x" }, { transfers: true, cgu: true }]) {
      expect(transfersConsentSchema.safeParse(body).success, JSON.stringify(body)).toBe(false);
    }
  });

  it("is rate limited per account and fails closed", () => {
    expect(RATE_LIMITS["consents.uid"]).toMatchObject({ key: "uid", policy: "closed" });
  });
});

describe("transfers consent text", () => {
  it("names the destinations and points to the list right below", () => {
    expect(fr.Auth.consents.transfers).toContain("vers l'Union européenne et les États-Unis");
    expect(fr.Auth.consents.transfers).toContain("listés ci-dessous");
    expect(fr.Auth.consents.transfers).not.toContain("hébergement");
    expect(ar.Auth.consents.transfers).toContain("الولايات المتحدة");
  });

  it("names every US recipient of the privacy policy", () => {
    const names = TRANSFER_PROVIDERS.us.map(([name]) => name).join(" ");
    const privacy = JSON.stringify(LEGAL_TEXTS.confidentialite.sections.find((section) => section.id === "destinataires"));
    for (const provider of ["Google", "Cloudflare", "Anthropic", "OpenAI", "Meta", "Resend", "Stripe", "RevenueCat"]) {
      expect(names, provider).toContain(provider);
      expect(privacy, provider).toContain(provider);
    }
    for (const provider of ["Oracle Cloud", "Google Firestore", "Cloudflare R2", "Sentry", "Brevo"]) expect(TRANSFER_PROVIDERS.eu.map(([name]) => name)).toContain(provider);
  });

  it("lists each provider with its role, in French and Arabic", () => {
    for (const locale of ["fr", "ar"] as const) {
      const html = render(<TransfersDetails />, locale);
      const messages = locale === "ar" ? ar : fr;
      expect(html).toContain(`<summary`);
      expect(html).not.toMatch(/<details[^>]* open/);
      for (const [name, role] of [...TRANSFER_PROVIDERS.eu, ...TRANSFER_PROVIDERS.us]) {
        expect(html).toContain(`>${name}</dt>`);
        expect(html).toContain(messages.Auth.consents.roles[role].replace(/'/g, "&#x27;"));
      }
    }
  });

  it("sits under the sign-up transfers box, outside its label", () => {
    const html = render(<ConsentFields fields={fields} />);
    const label = html.match(/<label[^>]*>(?:(?!<\/label>).)*listés ci-dessous(?:(?!<\/label>).)*<\/label>/)?.[0] ?? "";
    expect(label).toContain(fr.Auth.consents.transfersRequired);
    expect(label).not.toContain("<details");
    expect(html.indexOf("<details")).toBeGreaterThan(html.indexOf(label));
  });
});

describe("TransfersReconsent", () => {
  it("shows the new text and the open list, an unticked box, and the way out", () => {
    const html = render(<TransfersReconsent dpo="dpo@joutiya.ma" />);
    expect(html).toContain(`<h1 class="text-3xl font-semibold text-balance">${fr.Auth.reconsent.title}</h1>`);
    expect(html).toMatch(/<input[^>]*type="checkbox"/);
    expect(html).not.toMatch(/<input[^>]*checked/);
    expect(html).toMatch(/<details[^>]* open/);
    expect(html).toContain(fr.Auth.reconsent.submit);
    expect(html).toContain(fr.Auth.reconsent.signOut);
    expect(html).toContain('href="mailto:dpo@joutiya.ma"');
    // The sign-up sentence does not apply to an existing account.
    expect(html).not.toContain(fr.Auth.consents.transfersRequired);
  });

  it("renders in Arabic with the address kept left to right", () => {
    const html = render(<TransfersReconsent dpo="dpo@joutiya.ma" />, "ar");
    expect(html).toContain(ar.Auth.reconsent.title);
    expect(html).toMatch(/<a href="mailto:dpo@joutiya.ma" dir="ltr"[^>]*>dpo@joutiya.ma<\/a>/);
  });
});
