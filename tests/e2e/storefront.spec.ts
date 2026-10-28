import { expect, test } from "@playwright/test";
import { stubGoogleScript } from "./gsi-stub";
import { randomId, signUpAndIn } from "./helpers";

// "Ma vitrine" in /parametres (vitrine-avis §1) against the production build and the Firebase
// emulators (npm run test:e2e): a fresh member picks a house banner, writes an "about" text (a
// phone number is refused as it is typed), sets a city, saves, and finds it all on /profil.

test.beforeEach(({ page }) => stubGoogleScript(page));

test("a member sets up their storefront and sees it on their profile", async ({ page, request }) => {
  await signUpAndIn(page, request, `vitrine-${randomId(8)}@joutiya.test`, "Nadia Vitrine");
  await page.goto("/fr/parametres");
  const section = page.locator("section", { has: page.getByRole("heading", { level: 2, name: "Ma vitrine" }) });
  await expect(section.getByRole("radio", { name: "Zellige vert" })).toHaveAttribute("aria-checked", "true");

  await section.getByRole("radio", { name: "Nuit étoilée" }).click();
  const bio = section.getByLabel("Présentation");
  await bio.fill("Livres et jeux, rencontre à Fès. Appelez le 06 12 34 56 78");
  await expect(section.getByText("Retirez le numéro de téléphone")).toBeVisible();
  await expect(section.getByRole("button", { name: "Enregistrer la vitrine" })).toBeDisabled();
  await bio.fill("Livres et jeux de société, rencontre à Fès en semaine.");

  await section.getByRole("combobox").fill("Fès");
  await section.getByRole("option", { name: /Fès/ }).first().click();
  await section.getByRole("button", { name: "Enregistrer la vitrine" }).click();
  await expect(page.getByText("Vitrine enregistrée")).toBeVisible();

  await section.getByRole("link", { name: "Voir ma vitrine" }).click();
  await expect(page).toHaveURL(/\/fr\/profil\/[a-z0-9]{10}$/);
  await expect(page.getByTestId("storefront-banner")).toHaveAttribute("data-banner", "nuit");
  await expect(page.getByText("Livres et jeux de société, rencontre à Fès en semaine.")).toBeVisible();
  await expect(page.getByTestId("profile-header")).toContainText("Fès");
});
