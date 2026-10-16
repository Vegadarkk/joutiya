import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { radioKeyTarget } from "@/components/post/controls/chips";
import { SaveIndicator } from "@/components/post/wizard-shell";
import { ApiError } from "@/lib/auth/client";
import type { AutosaveState } from "@/lib/listings/client/autosave";
import type { SaveMode } from "@/lib/listings/client/store";

// The wizard's save line: a draft says it saved itself, a live listing says what is not saved yet
// and offers its Save button, a failure says whether the browser keeps trying.

const noop = () => undefined;

function render(state: AutosaveState, options: { error?: unknown; mode?: SaveMode; held?: boolean } = {}) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr}>
      <SaveIndicator state={state} error={options.error} mode={options.mode} held={options.held} onRetry={noop} onSave={noop} />
    </NextIntlClientProvider>,
  );
}

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ").trim();

describe("SaveIndicator", () => {
  it("a draft saves by itself", () => {
    expect(text(render("saved"))).toBe(fr.Listing.wizard.saved);
    expect(text(render("pending"))).toBe(fr.Listing.wizard.pending);
    expect(render("idle")).not.toContain('role="status"');
  });

  it("never says saved while a typed field is too short to be sent", () => {
    expect(text(render("saved", { held: true }))).toBe(fr.Listing.wizard.held);
    expect(text(render("idle", { held: true }))).toBe(fr.Listing.wizard.held);
    expect(text(render("saving", { held: true }))).toBe(fr.Listing.wizard.saving);
  });

  it("a live listing shows its unsaved changes with a Save button", () => {
    const html = render("pending", { mode: "manual" });
    expect(text(html)).toContain(fr.Listing.wizard.unsaved);
    expect(text(html)).toContain(fr.Listing.wizard.saveNow);
    expect(text(render("saved", { mode: "manual" }))).toBe(fr.Listing.wizard.savedLive);
  });

  it("says when the browser retries by itself, and offers a retry", () => {
    const html = render("error", { error: new ApiError(0, "network") });
    expect(text(html)).toContain(fr.Listing.wizard.saveError);
    expect(text(html)).toContain(fr.Listing.wizard.retrySave);
  });

  it("a refusal stops with its reason; blockers send the person to the flagged points", () => {
    expect(text(render("error", { error: new ApiError(409, "photo_limit") }))).toContain(`${fr.Listing.wizard.saveStopped} ${fr.Listing.errors.photo_limit}`);
    const blocked = text(render("error", { error: new ApiError(422, "invalid_listing"), mode: "manual" }));
    expect(blocked).toContain(fr.Listing.wizard.saveBlocked);
    expect(blocked).not.toContain(fr.Listing.wizard.retrySave);
  });
});

describe("radioKeyTarget", () => {
  it("moves along the reading direction with wrap-around", () => {
    expect(radioKeyTarget("ArrowRight", 2, 3, false)).toBe(0);
    expect(radioKeyTarget("ArrowLeft", 0, 3, false)).toBe(2);
    expect(radioKeyTarget("ArrowLeft", 0, 3, true)).toBe(1);
    expect(radioKeyTarget("ArrowDown", 1, 3, true)).toBe(2);
    expect(radioKeyTarget("ArrowUp", 0, 3, false)).toBe(2);
    expect(radioKeyTarget("End", 0, 3, false)).toBe(2);
    expect(radioKeyTarget(" ", 0, 3, false)).toBeNull();
  });
});
