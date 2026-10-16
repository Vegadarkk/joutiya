import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { displayMoroccanPhone, phoneArgument } from "@/components/auth/phone-display";
import { PendingCode } from "@/components/auth/verifications-view";
import type { Locale } from "@/config/site";
import { displayPhone } from "@/lib/phone/normalize";

const LRI = "\u2066";
const PDI = "\u2069";
const NBSP = "\u00a0";
/** The person's number inside a sentence: isolated, with no-break spaces. */
const inSentence = (national: string) => `${LRI}${national.replace(/ /g, NBSP)}${PDI}`;
const noop = () => undefined;

describe("displayMoroccanPhone", () => {
  it("gives the national form whatever the person typed", () => {
    for (const typed of ["0618925871", "06 18 92 58 71", "06.18.92.58.71", "+212618925871", "+212 6 18 92 58 71", "00212 618925871", "+212 (0)6 18 92 58 71", "618925871"]) {
      expect(displayMoroccanPhone(typed), typed).toBe("06 18 92 58 71");
    }
    // Joutiya's number comes as international digits.
    expect(displayMoroccanPhone("212600000000")).toBe("06 00 00 00 00");
  });

  it("matches the API's display form (src/lib/phone/normalize.ts)", () => {
    for (const e164 of ["+212612345678", "+212712345678", "+212618925871", "+212600000000"]) {
      expect(displayMoroccanPhone(e164)).toBe(displayPhone(e164));
      expect(displayMoroccanPhone(displayPhone(e164))).toBe(displayPhone(e164));
    }
  });

  it("leaves anything that is not a Moroccan number as given", () => {
    expect(displayMoroccanPhone("+33612345678")).toBe("+33612345678");
    expect(displayMoroccanPhone(" 12345 ")).toBe("12345");
    expect(displayMoroccanPhone("")).toBe("");
  });

  it("isolates the number for ICU arguments and keeps it on one line", () => {
    expect(phoneArgument("0618925871")).toBe(`${LRI}06${NBSP}18${NBSP}92${NBSP}58${NBSP}71${PDI}`);
    expect(phoneArgument(null)).toBe("");
  });
});

describe("PendingCode", () => {
  const state = { kind: "pending", phone: "0618925871", code: "576761", waLink: "https://wa.me/212600000000?text=JOUTIYA%20576761", number: "212600000000", expiresAt: Date.now() + 600_000 } as const;
  const render = (locale: Locale) =>
    renderToStaticMarkup(
      <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
        <PendingCode state={state} onExpired={noop} onVerified={noop} onReset={noop} />
      </NextIntlClientProvider>,
    );

  it("shows both numbers in the national form, the person's kept left to right in Arabic", () => {
    const arHtml = render("ar");
    expect(arHtml).toContain(ar.Auth.verifications.codeBody.replace("{phone}", inSentence("06 18 92 58 71")));
    expect(arHtml).toMatch(/<span dir="ltr" class="whitespace-nowrap[^"]*">06 00 00 00 00<\/span>/);
    const frHtml = render("fr");
    expect(frHtml).toContain(`Depuis le WhatsApp du ${inSentence("06 18 92 58 71")},`);
    expect(frHtml).not.toContain("0618925871");
    expect(frHtml).not.toContain(">212600000000<");
  });

  it("gives the copy button a 44 px target", () => {
    const button = /<button[^>]*>(?:(?!<\/button>)[\s\S])*?Copier le code<\/button>/.exec(render("fr"))?.[0] ?? "";
    expect(button).toMatch(/class="[^"]*\bh-11\b/);
    expect(button).not.toMatch(/class="[^"]*\bh-9\b/);
  });
});

describe("verification messages", () => {
  it("keeps the example numbers of the Arabic hint left to right", () => {
    const hint = ar.Auth.verifications.phoneHint;
    expect(hint).toContain(`${LRI}06 12 34 56 78${PDI}`);
    expect(hint).toContain(`${LRI}+212 6 12 34 56 78${PDI}`);
  });
});
