import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { BLURHASH, PASSWORD, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Shop catalogue, lot 4 PR 2 (design phase-7/catalogue-boutique.md §2-3) against the production
// build and the emulators: a verified shop's dress draft (seeded) gets two sizes at the Prix step,
// one with its stock, and the variants survive a reload; then a published dress (seeded with its
// variants) has one size set to 0 from "Mes annonces", which shows it sold out at once.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

/** Auth emulator admin REST (firebase-admin/auth does not load under the Playwright loader here). */
async function authEmulator<T>(action: string, body: unknown): Promise<T> {
  const project = process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya";
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:${action}`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `auth emulator ${action}`).toBe(true);
  return (await response.json()) as T;
}

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

interface Seeded {
  draftId: string;
  published: { id: string; title: string };
}

/** A verified shop for the member, a dress draft ready up to the price, and a published dress in two sizes. */
async function seedShop(email: string): Promise<Seeded> {
  const app = firebase();
  const firestore = getFirestore(app);
  const { users } = await authEmulator<{ users: { localId: string }[] }>("lookup", { email: [email] });
  const uid = users[0]!.localId;
  const proId = randomId(8);
  const now = new Date();
  await firestore.collection("proProfiles").doc(proId).set({
    ownerUid: uid,
    members: { [uid]: "owner" },
    name: "Maison Lalla",
    slug: `maison-lalla-${proId}`,
    description: "Caftans et robes, fabrication à Fès.",
    whatsapp: false,
    regionCode: "03",
    citySlug: "fes",
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
  await authEmulator("update", { localId: uid, customAttributes: JSON.stringify({ role: "pro", proId, proRole: "owner", v: 2 }) });

  const base = {
    ownerUid: uid,
    proId,
    sellerType: "pro",
    sellerName: displayName,
    sellerPublicId: publicId,
    categoryId: "mode",
    subcategoryId: "vetements",
    condition: "new_tagged",
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "03", citySlug: "fes", geo: { lat: 34.03, lng: -5.0 } },
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: now,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 5, flags: [], openReports: 0 },
    legalHold: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  };

  const draftId = randomId(8);
  const draftPhoto = `e2ephotoc${randomId(6)}`;
  await firestore
    .collection("listings")
    .doc(draftId)
    .set({
      ...base,
      status: "draft",
      title: "Robe d'été en lin",
      description: "Robe d'été en lin lavé, coupe droite, cousue dans notre atelier de Fès.",
      attributes: { audience: "femme", "clothing-type": "robe", "clothing-size": "m" },
      price: null,
      photos: [{ id: draftPhoto, ...(await storePhoto(draftId, draftPhoto, { r: 214, g: 196, b: 160 })), blurhash: BLURHASH }],
      adsEligible: false,
    });

  const id = randomId(8);
  const photoId = `e2ephotod${randomId(6)}`;
  const published = { id, title: `Caftan brodé ${id}` };
  await firestore
    .collection("listings")
    .doc(id)
    .set({
      ...base,
      status: "published",
      slugId: `caftan-brode-fes-${id}`,
      title: published.title,
      description: "Caftan brodé main, soie et sfifa, finitions de l'atelier.",
      attributes: { audience: "femme", "clothing-type": "autre" },
      price: 1200,
      variants: { axes: [{ id: "clothing-size", values: ["s", "m"] }], items: [{ key: "s", stock: 2 }, { key: "m", stock: 1 }] },
      priceLog: [{ at: now, price: 1200 }],
      photos: [{ id: photoId, ...(await storePhoto(id, photoId, { r: 120, g: 40, b: 52 })), blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  return { draftId, published };
}

test.describe("shop catalogue", () => {
  test("sizes with their stock at the Prix step, then a size sold out from Mes annonces", async ({ page, request }) => {
    test.setTimeout(120_000);
    const email = `catalogue-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Lalla Atelier");
    const { draftId, published } = await seedShop(email);

    // The claims changed: a fresh session carries the shop.
    await page.context().clearCookies();
    await page.goto(`/fr/deposer/${draftId}/prix`);
    await expect(page).toHaveURL(/\/connexion/);
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(new RegExp(`/fr/deposer/${draftId}/prix$`), { timeout: 15_000 });

    await page.getByRole("textbox", { name: /^Prix/ }).fill("450");
    const catalogue = page.getByRole("region", { name: "Stock et variantes" });
    await catalogue.getByRole("radio", { name: "Plusieurs variantes" }).click();
    const sizes = catalogue.getByRole("group", { name: "Taille" });
    await sizes.getByRole("checkbox", { name: "S", exact: true }).click();
    await sizes.getByRole("checkbox", { name: "M", exact: true }).click();
    await expect(catalogue.getByText("Combinaisons proposées")).toBeVisible();
    await catalogue.getByRole("textbox", { name: "Stock S" }).fill("3");
    await catalogue.getByRole("textbox", { name: /^Prix \(.+\) M$/ }).fill("480");
    await page.screenshot({ path: "test-results/catalogue-variants.png", fullPage: true });

    const saved = page.waitForResponse((response) => response.url().endsWith(`/api/listings/${draftId}`) && response.request().method() === "PATCH");
    await page.getByRole("button", { name: "Continuer" }).click();
    expect((await saved).status()).toBe(200);
    await expect(page).toHaveURL(/\/lieu$/);

    const stored = (await getFirestore(firebase()).collection("listings").doc(draftId).get()).data()!;
    expect(stored.variants).toEqual({ axes: [{ id: "clothing-size", values: ["s", "m"] }], items: [{ key: "s", stock: 3 }, { key: "m", price: 480 }] });
    expect(stored.attributes["clothing-size"]).toBeUndefined();

    await page.goto(`/fr/deposer/${draftId}/prix`);
    await expect(catalogue.getByRole("textbox", { name: "Stock S" })).toHaveValue("3");
    await expect(catalogue.getByRole("radio", { name: "Plusieurs variantes" })).toBeChecked();

    // The criteria step leaves the size to the variants.
    await page.goto(`/fr/deposer/${draftId}/criteres`);
    await expect(page.getByText("Taille : indiqué par les variantes, à l'étape Prix.")).toBeVisible();

    // Mes annonces: the published caftan, M set to 0.
    await page.goto("/fr/mes-annonces");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: published.title }) });
    await expect(row.getByTestId("owner-stock")).toHaveText(/2 combinaisons en vente/, { timeout: 15_000 });
    await row.getByRole("button", { name: /Mettre à jour le stock de/ }).click();
    const dialog = page.getByTestId("stock-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: "Stock de M" }).fill("0");
    await page.screenshot({ path: "test-results/catalogue-stock-dialog.png" });
    await dialog.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Stock mis à jour")).toBeVisible();
    await expect(row.getByTestId("owner-stock")).toHaveText(/2 combinaisons, dont 1 épuisée/);

    const after = (await getFirestore(firebase()).collection("listings").doc(published.id).get()).data()!;
    expect(after.variants.items).toEqual([{ key: "s", stock: 2 }, { key: "m", stock: 0 }]);
  });
});
