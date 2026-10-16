import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { NumberInput } from "@/components/post/criteria-fields";

// Price, km and m² fields (wizard, filters sheet): in Arabic pages the unit must not cover the digits.
describe("NumberInput", () => {
  it("lays the digits and the unit out left to right whatever the page direction", () => {
    const html = renderToStaticMarkup(
      <div dir="rtl">
        <NumberInput value={1200} unit="DH" onChange={() => undefined} />
      </div>,
    );
    expect(html).toMatch(/<div class="relative" dir="ltr"><input[^>]*dir="ltr"/);
    expect(html).toContain("DH");
  });
});
