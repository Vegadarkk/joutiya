import { expect, test, type Page } from "@playwright/test";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { PASSWORD, firebase, randomId, signUpAndIn } from "./helpers";

// Social links of a Pro shop against the production build and the Firebase emulators: from
// /fr/pro the owner types its Instagram handle and pastes its WhatsApp Business short link (a
// shortener and a wa.me number are refused as typed), saves, and a visitor finds the links on the
// storefront, each to the network's own page with rel="nofollow ugc noopener noreferrer".
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

/** A verified shop on the launch offer for the member. */
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
    description: "Huile d'argan de coopérative, pressée à froid.",
    whatsapp: false,
    regionCode: "09",
    citySlug: "agadir",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
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

test("a shop adds its social links and a visitor finds them on its storefront", async ({ page, request, browser }) => {
  test.setTimeout(120_000);
  const email = `reseaux-${randomId(10)}@joutiya.test`;
  await signUpAndIn(page, request, email, "Nadia Argan");
  const segment = await seedShop(email, `Dar Argan ${randomId(4)}`);

  await page.context().clearCookies();
  await page.goto("/fr/pro");
  await expect(page).toHaveURL(/\/connexion/);
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Se connecter" }).click();
  const settings = page.getByTestId("social-settings");
  await expect(settings).toBeVisible({ timeout: 15_000 });

  const instagram = settings.locator('input[data-network="instagram"]');
  const whatsapp = settings.locator('input[data-network="whatsapp"]');
  await instagram.fill("https://bit.ly/dar-argan");
  await expect(settings.getByText(/n'est pas sur le site du réseau/)).toBeVisible();
  await expect(settings.getByRole("button", { name: "Enregistrer les réseaux" })).toBeDisabled();
  await instagram.fill("@Dar.Argan");
  await expect(settings.getByText("www.instagram.com/dar.argan/")).toBeVisible();
  await whatsapp.fill("https://wa.me/212612345678");
  await expect(settings.getByText(/Pas de numéro de téléphone/)).toBeVisible();
  await whatsapp.fill("https://wa.me/message/ABCDEFGHIJ2K1");
  await settings.getByRole("button", { name: "Enregistrer les réseaux" }).click();
  await expect(page.getByText("Réseaux sociaux enregistrés. Votre vitrine est mise à jour.")).toBeVisible();
  await settings.screenshot({ path: "test-results/social-settings.png" });

  const visitor = await (await browser.newContext()).newPage();
  await visitor.goto(`/fr/boutique/${segment}`);
  const block = visitor.getByTestId("storefront-social");
  await expect(block.getByRole("heading", { name: "Retrouvez la boutique" })).toBeVisible();
  const link = block.getByRole("link", { name: /Instagram/ });
  await expect(link).toHaveAttribute("href", "https://www.instagram.com/dar.argan/");
  await expect(link).toHaveAttribute("rel", "nofollow ugc noopener noreferrer");
  await expect(link).toHaveAttribute("target", "_blank");
  await expect(block.getByRole("link", { name: /WhatsApp Business/ })).toHaveAttribute("href", "https://wa.me/message/ABCDEFGHIJ2K1");
  await expect(block).not.toContainText("212612345678");
  await visitor.screenshot({ path: "test-results/social-storefront.png", fullPage: true });
  await visitor.setViewportSize({ width: 390, height: 844 });
  await block.scrollIntoViewIfNeeded();
  await visitor.screenshot({ path: "test-results/social-storefront-mobile.png", fullPage: true });
});
