import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import type { ReactElement } from "react";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { CategoryPicker } from "@/components/post/category-picker";
import { DoneScreen } from "@/components/post/done-screen";
import { StepProgress } from "@/components/post/progress";
import type { Locale } from "@/config/site";
import { WIZARD_STEPS, type WizardStep } from "@/lib/contracts/listings";
import type { StepState } from "@/lib/listings/client/validation";

const noop = () => undefined;

function render(element: ReactElement, locale: Locale = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr}>
      {element}
    </NextIntlClientProvider>,
  );
}

const openingTags = (html: string, tag: string) => [...html.matchAll(new RegExp(`<${tag}\\b[^>]*>`, "g"))].map((match) => match[0]);
const classOf = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? "").split(/\s+/);

describe("CategoryPicker", () => {
  it("puts the subcategory radios directly in their radiogroup, with no list items in between", () => {
    const html = render(<CategoryPicker categoryId="vehicules" subcategoryId="velos" onCategory={noop} onSubcategory={noop} />);
    expect(html).not.toMatch(/<(?:ul|li)\b/);
    const group = /<div role="radiogroup"[^>]*>([\s\S]*)<\/div>/.exec(html)?.[1] ?? "";
    expect(group).toMatch(/^<button[^>]*role="radio"/);
    expect(html.match(/role="radio"/g)?.length).toBe(7);
    expect(html).toContain('role="radio" aria-checked="true"');
  });
});

describe("StepProgress", () => {
  const states = Object.fromEntries(WIZARD_STEPS.map((step, index) => [step, index < 5 ? "complete" : "empty"])) as Record<WizardStep, StepState>;
  const progress = (locale: Locale = "fr") => render(<StepProgress current="prix" states={states} onSelect={noop} reachable={() => true} />, locale);

  it("folds the phone strip into one 44 px disclosure button instead of nine narrow segments", () => {
    const html = progress();
    const buttons = openingTags(html, "button");
    // One disclosure button plus one row per step: the segments themselves are not targets.
    expect(buttons.length).toBe(1 + WIZARD_STEPS.length);
    const toggle = buttons[0]!;
    expect(toggle).toContain('aria-expanded="false"');
    expect(classOf(toggle)).toEqual(expect.arrayContaining(["min-h-11", "lg:hidden"]));
    const controls = /aria-controls="([^"]+)"/.exec(toggle)?.[1];
    expect(controls).toBeTruthy();
    const list = openingTags(html, "ol")[0]!;
    expect(list).toContain(`id="${controls}"`);
    // Folded on a phone, always shown on wide screens.
    expect(classOf(list)).toEqual(expect.arrayContaining(["hidden", "lg:flex"]));
    expect(html).toContain(fr.Listing.wizard.stepOf.replace("{current}", "6").replace("{total}", "9"));
  });

  it("gives every step row a 44 px target and announces its state", () => {
    const html = progress();
    for (const row of openingTags(html, "button").slice(1)) expect(classOf(row)).toContain("min-h-11");
    expect(html).toContain('aria-current="step"');
    expect(html).toContain(`>${fr.Listing.wizard.stepCurrent}<`);
    expect(html).toContain(`>${fr.Listing.wizard.stepDone}<`);
    expect(progress("ar")).toContain(`>${ar.Listing.wizard.stepCurrent}<`);
  });
});

describe("DoneScreen", () => {
  it("titles the result page with its h1", () => {
    const html = render(<DoneScreen status="published" slugId="velo-de-ville-abc123" listingId="abc123" />);
    expect(html).toMatch(new RegExp(`<h1[^>]*>${fr.Listing.done.publishedTitle}</h1>`));
    expect(html).not.toContain("<h2");
    for (const status of ["pending_review", "rejected", "draft"] as const) {
      expect(render(<DoneScreen status={status} slugId={null} listingId="abc123" />)).toMatch(/<h1[^>]*>[^<]+<\/h1>/);
    }
  });
});
