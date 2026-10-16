import { expect, test } from "@playwright/test";

// Visual regression of the static map (design D10, §6): the SVG is server-rendered and deterministic, so
// the screenshot baseline (tests/e2e/visual/static-map.spec.ts-snapshots/, generated on the CI Linux
// image, never in a container with other fonts) catches any change of the regions, the highlight, the
// marker or the attribution. The listing page is built by another lot: this spec needs a published
// listing fixture (seeded through the emulators) to open /fr/annonce/<slugId>.

test.describe("static regions map", () => {
  // enable when the listing page fixture exists (integration stage)
  test.fixme("matches the baseline on a listing page", async ({ page }) => {
    const slugId = "appartement-casablanca-abcd2345"; // replace with the seeded fixture's slugId
    await page.goto(`/fr/annonce/${slugId}`);
    const map = page.getByTestId("static-map");
    await expect(map).toBeVisible();
    await expect(map).toHaveScreenshot({ maxDiffPixelRatio: 0.01 });
  });
});
