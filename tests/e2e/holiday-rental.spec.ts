import { expect, test, type Page } from "@playwright/test";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { PASSWORD, firebase, randomId, signUpAndIn } from "./helpers";

// Seasonal rental agencies (conception §1-2) against the production build and the Firebase
// emulators: a verified shop becomes a seasonal rental agency from /fr/pro once it ticks the
// trade's legal commitments (with the guide's tourist-rental procedure linked), its storefront
// says so, and the holiday homes search asks for stay dates (arrival, departure). The shop is
// written straight into the emulator (pro.spec covers the application).
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

/** A verified general shop on the launch offer for the member. */
async function seedShop(email: string, shopName: string): Promise<string> {
  const app = firebase();
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const { uid } = await auth.getUserByEmail(email);
  const proId = randomId(8);
  const slug = `${shopName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-agadir`;
  const now = new Date();
  await firestore.collection("proProfiles").doc(proId).set({
    ownerUid: uid,
    members: { [uid]: "owner" },
    name: shopName,
    slug,
    description: "Appartements meublés en bord de mer.",
    whatsapp: false,
    regionCode: "09",
    citySlug: "agadir",
    legal: { form: "societe", ice: "001234567000089", rc: "54321", if: "7654321" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: { activeListings: 50, listingsPerDay: 20, photosPerListing: 15 },
    createdAt: now,
    updatedAt: now,
  });
  await firestore.collection("users").doc(uid).update({ proId, type: "pro", "badges.phoneVerified": true, updatedAt: now });
  await auth.setCustomUserClaims(uid, { role: "pro", proId, proRole: "owner", v: 2 });
  await auth.revokeRefreshTokens(uid);
  return `${slug}-${proId}`;
}

test.describe("seasonal rental agency", () => {
  test("a shop becomes a seasonal rental agency after its commitments; holiday homes search by stay dates", async ({ page, request }) => {
    test.setTimeout(120_000);
    const email = `saison-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Karim Saison");
    const segment = await seedShop(email, `Souss Séjours ${randomId(4)}`);

    // New claims: sign in again for a token carrying the shop (see agency.spec).
    await page.context().clearCookies();
    await page.goto("/fr/pro");
    await expect(page).toHaveURL(/\/connexion/);
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Se connecter" }).click();
    const settings = page.getByTestId("agency-settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("radio", { name: /Location saisonnière/ }).check();
    await settings.getByRole("button", { name: "Enregistrer" }).click();
    await expect(settings.getByText("Cochez la case pour confirmer vos engagements.")).toBeVisible();
    const commitments = settings.getByTestId("pro-commitments");
    await expect(commitments.getByRole("link", { name: /Louer un logement à des touristes/ })).toHaveAttribute("href", "/fr/demarches/immobilier#procedure-immo-location-touristique");
    await commitments.getByRole("checkbox", { name: /J'accepte ces engagements d'agence de location saisonnière/ }).check();
    await settings.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Secteur enregistré. Votre vitrine est mise à jour.")).toBeVisible();
    await page.screenshot({ path: "test-results/holiday-agency-settings.png", fullPage: true });

    await page.goto(`/fr/boutique/${segment}`);
    const header = page.getByTestId("storefront-header");
    await expect(header.getByText("Agence de location saisonnière", { exact: true })).toBeVisible();
    await expect(header.getByText("Agence vérifiée")).toBeVisible();

    // The guide procedure the commitments link to is on its rubric page.
    await page.goto("/fr/demarches/immobilier#procedure-immo-location-touristique");
    await expect(page.locator("#procedure-immo-location-touristique")).toBeVisible();

    await page.goto("/fr/recherche?sous-categorie=location-vacances");
    const bar = page.locator("#main").getByTestId("rental-dates-bar");
    await expect(bar.getByRole("heading", { name: "Vos dates de séjour" })).toBeVisible();
    await expect(bar.getByLabel("Arrivée")).toBeVisible();
    await expect(bar.getByLabel("Départ")).toBeVisible();
    await expect(bar.getByRole("button", { name: "Voir les logements libres" })).toBeDisabled();
    await page.screenshot({ path: "test-results/holiday-search.png", fullPage: true });
  });
});
