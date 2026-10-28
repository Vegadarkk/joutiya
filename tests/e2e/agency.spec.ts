import { expect, test, type Page } from "@playwright/test";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { BLURHASH, PASSWORD, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Agence pack (design §3) against the production build and the Firebase emulators: a verified
// shop becomes a real-estate agency from /fr/pro (sector and fee schedule), its storefront shows
// the agency header and the fee schedule, and an apartment it published shows the mandate and
// fees under the price, the "Demander une visite" button and the real-estate safety tips to a
// visitor. The
// shop and the listing are written straight into the emulator (pro.spec covers the application).
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const FEES = "Vente : 2,5 % du prix à la charge de l'acquéreur.\nLocation : un mois de loyer.";

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

/** A verified shop on the launch offer for the member, and an exclusive apartment it published. */
async function seedAgency(email: string, shopName: string): Promise<{ segment: string; slugId: string }> {
  const app = firebase();
  const auth = getAuth(app);
  const firestore = getFirestore(app);
  const { uid } = await auth.getUserByEmail(email);
  const proId = randomId(8);
  const slug = `${shopName.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-casablanca`;
  const now = new Date();
  await firestore.collection("proProfiles").doc(proId).set({
    ownerUid: uid,
    members: { [uid]: "owner" },
    name: shopName,
    slug,
    description: "Appartements et villas à Casablanca.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: { activeListings: 50, listingsPerDay: 20, photosPerListing: 15 },
    createdAt: now,
    updatedAt: now,
  });
  const user = firestore.collection("users").doc(uid);
  await user.update({ proId, type: "pro", "badges.phoneVerified": true, updatedAt: now });
  const { publicId, displayName } = (await user.get()).data() as { publicId: string; displayName: string };
  await auth.setCustomUserClaims(uid, { role: "pro", proId, proRole: "owner", v: 2 });
  await auth.revokeRefreshTokens(uid);

  const id = randomId(8);
  const slugId = `appartement-maarif-casablanca-${id}`;
  const photoId = `e2ephotoa${randomId(6)}`;
  await firestore
    .collection("listings")
    .doc(id)
    .set({
      ownerUid: uid,
      proId,
      sellerType: "pro",
      sellerName: displayName,
      sellerPublicId: publicId,
      status: "published",
      slugId,
      title: "Appartement 3 chambres au Maârif",
      description: "Appartement lumineux de 120 m², 3 chambres, ascenseur et parking.\n\nVisite sur rendez-vous.",
      categoryId: "immobilier",
      subcategoryId: "vente",
      attributes: { "property-type": "appartement", surface: 120, rooms: 5, bedrooms: 3, "property-title": "titre-foncier", mandate: "exclusif", "agency-reference": "CASA-118", "agency-fees": "en-sus", "agency-fees-amount": 25000 },
      price: 1850000,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.63 } },
      photos: [{ id: photoId, ...(await storePhoto(id, photoId, { r: 214, g: 196, b: 160 })), blurhash: BLURHASH }],
      contact: { messaging: true, showPhone: false, whatsapp: false },
      boosts: {},
      sortAt: now,
      sortSource: "publish",
      moderation: { state: "auto_ok", score: 5, flags: [], openReports: 0 },
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
      legalHold: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
    });
  return { segment: `${slug}-${proId}`, slugId };
}

test.describe("real-estate agency", () => {
  test("a shop becomes an agency: sector, fee schedule, storefront, property listing", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const email = `agence-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Nadia Agence");
    const shopName = `Atlas Immobilier ${randomId(4)}`;
    const { segment, slugId } = await seedAgency(email, shopName);

    // The claims changed and the sessions were revoked: sign in again.
    await page.goto("/fr/pro");
    if (page.url().includes("/connexion")) {
      await page.getByLabel("Adresse e-mail").fill(email);
      await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
      await waitForTurnstile(page);
      await page.getByRole("button", { name: "Se connecter" }).click();
    }
    const settings = page.getByTestId("agency-settings");
    await expect(settings).toBeVisible({ timeout: 15_000 });
    await settings.getByRole("radio", { name: /Agence immobilière/ }).check();
    await settings.getByLabel("Barème des honoraires").fill("Appelez le 06 12 34 56 78");
    await expect(settings.getByText(/Retirez le numéro de téléphone/)).toBeVisible();
    await expect(settings.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
    await settings.getByLabel("Barème des honoraires").fill(FEES);
    await settings.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Secteur enregistré. Votre vitrine est mise à jour.")).toBeVisible();
    await page.screenshot({ path: "test-results/agency-settings.png", fullPage: true });

    await page.goto(`/fr/boutique/${segment}`);
    const header = page.getByTestId("storefront-header");
    await expect(header.getByText("Agence immobilière", { exact: true })).toBeVisible();
    await expect(header.getByText("Agence vérifiée")).toBeVisible();
    const fees = page.getByTestId("agency-fees");
    await expect(fees.getByRole("heading", { name: "Barème des honoraires" })).toBeVisible();
    await expect(fees).toContainText("2,5 % du prix à la charge de l'acquéreur");
    await page.screenshot({ path: "test-results/agency-storefront.png", fullPage: true });

    // A visitor (the owner's own page has no contact bar) sees the terms under the price.
    const visitor = await (await browser.newContext()).newPage();
    await visitor.goto(`/fr/annonce/${slugId}`);
    const terms = visitor.getByTestId("property-terms");
    await expect(terms).toContainText("Exclusivité");
    await expect(terms).toContainText("CASA-118");
    await expect(terms).toContainText(/25\s000\sDH en plus du prix, à la charge du client/);
    await expect(visitor.getByTestId("visit-button").first()).toBeVisible();
    await expect(visitor.getByText(/Ne versez jamais d'acompte/)).toBeVisible();
    await visitor.screenshot({ path: "test-results/agency-listing.png", fullPage: true });
    await visitor.context().close();
  });
});
