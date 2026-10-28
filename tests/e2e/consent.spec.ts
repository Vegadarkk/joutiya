import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

// Cookie consent (phase 6, D1-D5) against the production build. Ads are off in this environment,
// so the banner must stay away; the "ads on" cases answer /api/config in the browser instead of
// changing config/flags, which the server caches and every other spec shares.

async function adsOn(page: Page, mode: "test" | "live" = "test"): Promise<void> {
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, ads: { mode, cmpEea: false, client: null } } });
  });
}

async function storedChoice(page: Page): Promise<{ ads: boolean; perso: boolean } | null> {
  const cookie = (await page.context().cookies()).find((entry) => entry.name === "jt_consent");
  if (!cookie) return null;
  const json = JSON.parse(Buffer.from(cookie.value.slice(2), "base64url").toString("utf8")) as { ads: boolean; perso: boolean };
  return { ads: json.ads, perso: json.perso };
}

test.describe("cookie consent", { tag: "@mobile" }, () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("no banner without any tracker; the footer link says so and lists the necessary cookies", async ({ page }) => {
    await page.goto("/fr");
    await expect(page.getByTestId("home-categories")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
    await page.getByRole("button", { name: "Gérer mes cookies" }).click();
    const panel = page.getByRole("dialog", { name: "Gérer mes cookies" });
    await expect(panel).toContainText("aucun cookie publicitaire");
    await expect(panel.getByRole("switch")).toHaveCount(0);
    await expect(panel.getByRole("link", { name: "Voir la liste des cookies" })).toHaveAttribute("href", "/fr/legal/cookies");
    await panel.getByRole("button", { name: "Fermer" }).last().click();
    await expect(panel).toHaveCount(0);
    expect(await storedChoice(page)).toBeNull();
  });

  test("with ads on, refusing is one click, stored, and the banner does not come back", async ({ page }) => {
    await adsOn(page);
    await page.goto("/fr");
    const banner = page.getByTestId("consent-banner");
    await expect(banner).toBeVisible();
    expect((await new AxeBuilder({ page }).include('[data-testid="consent-banner"]').withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze()).violations).toEqual([]);
    await banner.getByRole("button", { name: "Tout refuser" }).click();
    await expect(banner).toHaveCount(0);
    expect(await storedChoice(page)).toEqual({ ads: false, perso: false });
    await page.reload();
    await expect(page.getByTestId("home-categories")).toBeVisible();
    await page.waitForLoadState("networkidle");
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
  });

  test("customising starts with nothing ticked, personalisation needs ads, and the choice reopens as saved", async ({ page }) => {
    await adsOn(page);
    await page.goto("/ar");
    await page.getByTestId("consent-banner").getByRole("button", { name: "تخصيص" }).click();
    const panel = page.getByRole("dialog", { name: "إدارة ملفات تعريف الارتباط" });
    const ads = panel.getByRole("switch", { name: "الإعلانات", exact: true });
    const perso = panel.getByRole("switch", { name: "الإعلانات المخصّصة" });
    await expect(ads).not.toBeChecked();
    await expect(perso).toBeDisabled();
    await ads.click();
    await expect(perso).toBeEnabled();
    await expect(perso).not.toBeChecked();
    await panel.getByRole("button", { name: "حفظ اختياراتي" }).click();
    await expect(panel).toHaveCount(0);
    await expect(page.getByTestId("consent-banner")).toHaveCount(0);
    expect(await storedChoice(page)).toEqual({ ads: true, perso: false });
    await page.getByRole("button", { name: "إدارة ملفات تعريف الارتباط" }).click();
    await expect(panel.getByRole("switch", { name: "الإعلانات", exact: true })).toBeChecked();
    await expect(panel.getByRole("switch", { name: "الإعلانات المخصّصة" })).not.toBeChecked();
  });
});
