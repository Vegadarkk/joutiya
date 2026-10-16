import { describe, expect, it } from "vitest";
import { isolate, isolateLtr } from "@/lib/i18n/bidi";

describe("bidi isolates", () => {
  it("wraps user text in a first-strong isolate and LTR tokens in a left-to-right isolate", () => {
    expect(isolate("Vélo de ville.")).toBe("⁨Vélo de ville.⁩");
    expect(isolateLtr("06 18 92 58 71")).toBe("⁦06 18 92 58 71⁩");
  });

  it("leaves an empty value empty", () => {
    expect(isolate("")).toBe("");
    expect(isolateLtr("")).toBe("");
  });
});
