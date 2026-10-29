import { expect, test, type Page } from "@playwright/test";

// Welcome threshold of the home page (design C7, phase-3/DESIGN-C7.md): a first visit on this
// device gets the welcome screen, decided before paint by a hash-pinned script; deep links,
// crawlers and visitors from another site never see it; "Découvrir sans compte" (or Escape)
// opens the door onto the page, which then takes the focus. A sign-in landing on home plays the
// door once per device. The config's default device has gone through already: these tests start
// from an empty one.

const ORIGIN = "http://localhost:3100";
const empty = { cookies: [], origins: [] };

/** Collects CSP violations reported by the page itself. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__cspViolation", (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolation: (detail: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

const welcome = (page: Page) => page.getByRole("dialog", { name: /une porte ouverte sur le monde|باب مفتوح على العالم/i });

test.describe("welcome threshold", () => {
  test.use({ storageState: empty });

  test("first visit: the welcome screen, keyboard inside it, then the door onto the page", async ({ page }) => {
    const violations = await watchCsp(page);
    await page.goto("/fr");
    await expect(page.locator("html")).toHaveAttribute("data-welcome", "screen");
    const dialog = welcome(page);
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog.getByRole("link", { name: "Créer un compte" })).toHaveAttribute("href", "/fr/inscription?next=%2Ffr");
    await expect(dialog.getByRole("link", { name: "Se connecter" })).toHaveAttribute("href", "/fr/connexion?next=%2Ffr");
    // The page underneath is laid out but hidden: nothing of it is reachable.
    await expect(page.getByRole("heading", { level: 1 })).toBeHidden();

    // Tab stays among the three actions.
    await page.waitForLoadState("networkidle");
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("link", { name: "Créer un compte" })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    await expect(dialog.getByRole("link", { name: "Découvrir sans compte" })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog.getByRole("link", { name: "Créer un compte" })).toBeFocused();

    await dialog.getByRole("link", { name: "Découvrir sans compte" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-welcome", /open/);
    await expect(dialog).toHaveCount(0, { timeout: 5_000 });
    await expect(page.locator("html")).not.toHaveAttribute("data-welcome", /.*/);
    await expect(page.locator("#main")).toBeFocused();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    // The address stays the home page.
    await expect(page).toHaveURL(/\/fr$/);

    // Once per device.
    await page.reload();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-welcome", /.*/);
    await expect(welcome(page)).toHaveCount(0);
    expect(violations).toEqual([]);
  });

  test("Escape opens the door; reduced motion crossfades", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/fr");
    await expect(welcome(page)).toBeVisible();
    await page.waitForLoadState("networkidle");
    // What Escape starts, read in the same task: one 200 ms crossfade, no swing or push. The key
    // listener is a passive effect that can land after networkidle on a loaded runner: press again
    // until the door opens (a press it missed starts nothing), then never again, since a second
    // Escape would skip the opening. The animations of the press that opened it are kept.
    await expect
      .poll(() =>
        page.evaluate(() => {
          const seen = window as unknown as { __opening?: unknown };
          if (seen.__opening !== undefined) return seen.__opening;
          document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
          if (!document.documentElement.getAttribute("data-welcome")?.includes("open")) return null;
          seen.__opening = document
            .querySelector(".welcome")
            ?.getAnimations({ subtree: true })
            .map((animation) => ({ target: (animation.effect as KeyframeEffect).target?.className, duration: animation.effect?.getTiming().duration }));
          return seen.__opening;
        }),
      )
      .toEqual([{ target: "welcome", duration: 200 }]);
    await expect(welcome(page)).toHaveCount(0, { timeout: 1_500 });
    await expect(page.locator("#main")).toBeFocused();
  });

  test("Arabic: right to left, the same screen in Arabic", async ({ page }) => {
    await page.goto("/ar");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    const dialog = welcome(page);
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("باب مفتوح على العالم.")).toBeVisible();
    // The leaf's hinge is on the start side: mirrored from French.
    const origin = await page.locator(".welcome-leaf").evaluate((leaf) => getComputedStyle(leaf).transformOrigin);
    // The Arabic visit used up this device's first visit: start the French one from an empty device.
    await page.evaluate(() => localStorage.clear());
    await page.goto("/fr");
    await expect(welcome(page)).toBeVisible();
    const french = await page.locator(".welcome-leaf").evaluate((leaf) => getComputedStyle(leaf).transformOrigin);
    expect(origin).not.toEqual(french);
  });

  test("never for a deep link, a crawler or a visitor from another site", async ({ page, browser }) => {
    await page.goto("/fr/legal/mentions-legales");
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(page.locator("html")).not.toHaveAttribute("data-welcome", /.*/);
    // The deep link did not use up the device's first visit... but the home page was not seen either.
    expect(await page.evaluate(() => localStorage.getItem("welcome"))).toBeNull();

    await page.goto("/fr", { referer: "https://www.google.com/" });
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(welcome(page)).toHaveCount(0);

    const bot = await browser.newContext({ storageState: empty, userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)" });
    const crawler = await bot.newPage();
    await crawler.goto(`${ORIGIN}/fr`);
    await expect(crawler.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(crawler.locator(".welcome")).toHaveCount(0);
    await bot.close();
  });

  test.describe("after a sign-in that lands on home", () => {
    test.use({ storageState: { cookies: [], origins: [{ origin: ORIGIN, localStorage: [{ name: "welcome", value: "seen" }, { name: "door", value: "queued" }] }] } });

    test("the door opens once, without the welcome screen", async ({ page }) => {
      await page.goto("/fr", { waitUntil: "domcontentloaded" });
      // Read once, before the door is through: the screen's texts and actions never show.
      const copy = await page.evaluate(() => {
        const element = document.querySelector(".welcome-copy");
        return { state: document.documentElement.getAttribute("data-welcome"), visibility: element && getComputedStyle(element).visibility };
      });
      expect(copy).toEqual({ state: expect.stringMatching(/^door/), visibility: "hidden" });
      await expect(welcome(page)).toHaveCount(0, { timeout: 5_000 });
      await expect(page.locator("#main")).toBeFocused();
      expect(await page.evaluate(() => localStorage.getItem("door"))).toBe("opened");
      await page.reload();
      await expect(page.locator("html")).not.toHaveAttribute("data-welcome", /.*/);
    });

    test("a client-side arrival on home plays it too", async ({ page }) => {
      await page.goto("/fr/legal/mentions-legales");
      await page.waitForLoadState("networkidle");
      await page.getByRole("link", { name: "Accueil Joutiya" }).click();
      await expect(page).toHaveURL(/\/fr$/);
      await expect(page.locator(".welcome")).toHaveCount(0, { timeout: 5_000 });
      expect(await page.evaluate(() => localStorage.getItem("door"))).toBe("opened");
      await expect(page.locator("#main")).toBeFocused();
    });
  });
});
