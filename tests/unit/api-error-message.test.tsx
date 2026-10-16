import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { FormMessage, type ApiMessageScope } from "@/components/auth/form-message";
import type { Locale } from "@/config/site";
import { ApiError } from "@/lib/auth/client";

// API codes to words (useApiErrorMessage through FormMessage): listing codes from Listing.errors,
// the rest from Auth.errors; quota_exhausted, in both, takes the deposit wording only where the
// caller asks for it (wizard saves and publication), the generic one on account forms.

function render(error: unknown, options: { scope?: ApiMessageScope; locale?: Locale } = {}) {
  const locale = options.locale ?? "fr";
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      <FormMessage error={error} scope={options.scope} />
    </NextIntlClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("useApiErrorMessage", () => {
  const quota = new ApiError(503, "quota_exhausted", { retryAfter: 7_200 });

  it("gives sign-up and Google sign-in the generic quota wording, the deposit its own", () => {
    expect(text(render(quota))).toBe(fr.Auth.errors.quota_exhausted);
    expect(text(render(quota, { scope: "listing" }))).toBe(fr.Listing.errors.quota_exhausted);
    expect(text(render(quota, { locale: "ar" }))).toBe(ar.Auth.errors.quota_exhausted);
    expect(text(render(quota, { scope: "listing", locale: "ar" }))).toBe(ar.Listing.errors.quota_exhausted);
    expect(fr.Auth.errors.quota_exhausted).not.toBe(fr.Auth.errors.unavailable);
  });

  it("keeps listing-only codes in Listing.errors and account codes in Auth.errors, whatever the scope", () => {
    for (const scope of [undefined, "listing"] as const) {
      expect(text(render(new ApiError(409, "photo_limit"), { scope }))).toBe(fr.Listing.errors.photo_limit);
      expect(text(render(new ApiError(503, "unavailable"), { scope }))).toBe(fr.Auth.errors.unavailable);
      expect(text(render(new Error("boom"), { scope }))).toBe(fr.Auth.errors.internal);
    }
  });
});
