import { expect, test } from "@playwright/test";

// Header shortcuts of the UX audit (owner's choice B, 29 Oct 2026): a visitor reaches the two rental
// searches and the Pro offer from any page in two clicks at most, on a wide screen through "Louer"
// and "Espace Pro" beside "Vendre", on a phone through the visitor menu of the account button; the
// public Pro page sends "Créer ma boutique" to the sign-in page, which brings the visitor back to /pro.

const CAR_RENTAL = /\/fr\/recherche\?(?=.*categorie=vehicules)(?=.*sous-categorie=location-voitures)/;
const HOLIDAY_RENTAL = /\/fr\/recherche\?(?=.*categorie=immobilier)(?=.*sous-categorie=location-vacances)/;

test.describe("header shortcuts", () => {
  test("wide screen: 'Louer' opens the two rental searches, 'Espace Pro' the public Pro page", async ({ page }) => {
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto("/fr/c/vehicules");
    const rent = page.getByTestId("header-rent");
    await expect(rent).toBeVisible();
    await expect(rent).toHaveAccessibleName("Louer");
    await rent.click();
    await page.getByRole("menuitem", { name: /Louer une voiture/ }).click();
    await expect(page).toHaveURL(CAR_RENTAL);

    await page.goto("/fr/c/vehicules");
    await page.getByTestId("header-rent").click();
    await page.getByRole("menuitem", { name: /Location de vacances/ }).click();
    await expect(page).toHaveURL(HOLIDAY_RENTAL);

    await page.goto("/fr/c/vehicules");
    const pro = page.getByTestId("header-pro");
    await expect(pro).toHaveAttribute("href", "/fr/professionnels");
    await pro.click();
    await expect(page).toHaveURL(/\/fr\/professionnels$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("Créez votre boutique ou votre agence");
    // Two clicks from the header to the sign-in page, which brings the visitor back to /pro.
    await page.getByRole("link", { name: "Créer ma boutique" }).first().click();
    await expect(page).toHaveURL(/\/fr\/connexion\?next=/);
    expect(decodeURIComponent(new URL(page.url()).searchParams.get("next") ?? "")).toContain("/pro");
  });

  test("phone: the visitor menu of the account button reaches the rentals and the Pro page", { tag: "@mobile" }, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/fr");
    await expect(page.getByTestId("header-rent")).toBeHidden();
    const menu = page.getByTestId("visitor-menu");
    await expect(menu).toHaveAccessibleName("Menu");
    await menu.click();
    await page.getByRole("menuitem", { name: /Louer une voiture/ }).click();
    await expect(page).toHaveURL(CAR_RENTAL);

    await page.goto("/fr/c/vehicules");
    await page.getByTestId("visitor-menu").click();
    await expect(page.getByRole("menuitem", { name: /Se connecter/ })).toHaveAttribute("href", /\/fr\/connexion\?next=/);
    await page.getByRole("menuitem", { name: /Espace Pro/ }).click();
    await expect(page).toHaveURL(/\/fr\/professionnels$/);
  });

  test("the public Pro page is served in Arabic and lists the five storefront kinds", async ({ page }) => {
    await page.goto("/ar/professionnels");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("أنشئ متجرك أو وكالتك");
    await expect(page.getByRole("heading", { level: 3 })).toHaveCount(5);
  });
});
