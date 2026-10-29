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
  proId: string;
  draftId: string;
  published: { id: string; title: string };
  /** A dress in two sizes and two colours, prices from 420 to 450 DH. */
  dress: { slugId: string; title: string };
  /** A jacket online for 40 days: 1 500 DH, then 1 200 DH for the last 10 (struck-out price 1 200). */
  jacket: { id: string; slugId: string; title: string };
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
  const dressId = randomId(8);
  const dressPhoto = `e2ephotoe${randomId(6)}`;
  const dress = { slugId: `robe-lin-fes-${dressId}`, title: `Robe en lin ${dressId}` };
  await firestore
    .collection("listings")
    .doc(dressId)
    .set({
      ...base,
      status: "published",
      slugId: dress.slugId,
      title: dress.title,
      description: "Robe en lin lavé, coupe droite et poches côté, cousue dans notre atelier.",
      attributes: { audience: "femme", "clothing-type": "robe" },
      price: 420,
      variants: {
        axes: [
          { id: "clothing-size", values: ["m", "l"] },
          { id: "color", values: ["beige", "vert"] },
        ],
        items: [{ key: "m|beige", stock: 4 }, { key: "m|vert", stock: 2 }, { key: "l|beige", stock: 0 }, { key: "l|vert", price: 450 }],
      },
      priceLog: [{ at: now, price: 420 }],
      photos: [{ id: dressPhoto, ...(await storePhoto(dressId, dressPhoto, { r: 196, g: 180, b: 140 })), blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  const jacketId = randomId(8);
  const jacketPhoto = `e2ephotof${randomId(6)}`;
  const jacket = { id: jacketId, slugId: `veste-fes-${jacketId}`, title: `Veste en laine ${jacketId}` };
  const daysAgo = (days: number) => new Date(now.getTime() - days * 86_400_000);
  await firestore
    .collection("listings")
    .doc(jacketId)
    .set({
      ...base,
      status: "published",
      slugId: jacket.slugId,
      title: jacket.title,
      description: "Veste en laine tissée main, doublure coton, boutons en corne.",
      attributes: { audience: "homme", "clothing-type": "veste-manteau", "clothing-size": "l" },
      price: 1200,
      priceLog: [
        { at: daysAgo(40), price: 1500 },
        { at: daysAgo(10), price: 1200 },
      ],
      photos: [{ id: jacketPhoto, ...(await storePhoto(jacketId, jacketPhoto, { r: 70, g: 60, b: 48 })), blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: daysAgo(40),
      expiresAt: new Date(now.getTime() + 20 * 86_400_000),
    });
  return { proId, draftId, published, dress, jacket };
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

    // Saved by the coalesced autosave or on the step change, whichever comes first.
    await page.getByRole("button", { name: "Continuer" }).click();
    await expect(page).toHaveURL(/\/lieu$/);
    const stored = async () => (await getFirestore(firebase()).collection("listings").doc(draftId).get()).data()!;
    await expect.poll(async () => (await stored()).variants, { timeout: 15_000 }).toEqual({ axes: [{ id: "clothing-size", values: ["s", "m"] }], items: [{ key: "s", stock: 3 }, { key: "m", price: 480 }] });
    expect((await stored()).attributes["clothing-size"]).toBeUndefined();

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

  test("a buyer picks a size and a colour, sees price and stock, and the first message names them", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const email = `catalogue-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Lalla Atelier");
    const { dress } = await seedShop(email);

    const buyer = await (await browser.newContext()).newPage();
    await signUpAndIn(buyer, request, `acheteuse-${randomId(10)}@joutiya.test`, "Samira Test");
    await buyer.goto(`/fr/annonce/${dress.slugId}`);
    await expect(buyer.getByTestId("price-tag").first()).toContainText(/À partir de\s*420/);

    const picker = buyer.getByTestId("variant-picker");
    await expect(picker.getByText("Choisissez une option pour voir le prix et le stock.")).toBeVisible();
    await picker.getByRole("radiogroup", { name: /Taille/ }).getByRole("radio", { name: "L", exact: true }).click();
    // L beige is sold out: struck through, still choosable.
    await picker.getByRole("radio", { name: "Beige, épuisé" }).click();
    await expect(picker.getByTestId("stock-line")).toHaveText("Épuisé");
    await picker.getByRole("radio", { name: "Vert", exact: true }).click();
    await expect(picker.getByTestId("variant-summary")).toContainText(/L \/ Vert\s*450/);
    await picker.getByRole("radio", { name: "M", exact: true }).click();
    await expect(picker.getByTestId("stock-line")).toHaveText("Plus que 2 en stock");
    await buyer.screenshot({ path: "test-results/catalogue-listing-page.png", fullPage: true });

    await buyer.getByTestId("contact-bar").getByRole("button", { name: "Envoyer un message" }).click();
    const dialog = buyer.getByRole("dialog");
    await expect(dialog.getByLabel("Votre message")).toHaveValue(`Bonjour, « ${dress.title} » en M / Vert est-il toujours disponible ?`, { timeout: 15_000 });
  });

  test("a shop launches a promotion from Mes annonces, and buyers see it with its struck-out price", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const email = `catalogue-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Lalla Atelier");
    const { jacket } = await seedShop(email);

    await page.context().clearCookies();
    await page.goto("/fr/mes-annonces");
    await expect(page).toHaveURL(/\/connexion/);
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/fr\/mes-annonces/, { timeout: 15_000 });

    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: jacket.title }) });
    await row.getByRole("button", { name: /^Promotion : / }).click();
    const dialog = page.getByTestId("promo-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("radio", { name: "Soldes" }).click();
    await dialog.getByRole("textbox", { name: "Réduction (%)" }).fill("20");
    // Joutiya's struck-out price: the lowest of the 30 days (1 200), not the old 1 500.
    const preview = dialog.getByTestId("promo-preview");
    await expect(preview).toContainText(/1\s200/);
    await expect(preview).toContainText(/960/);
    await page.screenshot({ path: "test-results/catalogue-promo-dialog.png" });
    await dialog.getByRole("button", { name: "Lancer la promotion" }).click();
    await expect(page.getByText("Promotion enregistrée.")).toBeVisible();
    await expect(row.getByTestId("owner-promo")).toHaveText(/Soldes en cours jusqu'au/);
    const stored = (await getFirestore(firebase()).collection("listings").doc(jacket.id).get()).data()!;
    expect(stored.promo).toMatchObject({ kind: "soldes", percent: 20, prices: [{ key: "", price: 960, reference: 1200 }] });

    const buyer = await (await browser.newContext()).newPage();
    await buyer.goto(`/fr/annonce/${jacket.slugId}`);
    const notice = buyer.getByTestId("promo-notice");
    await expect(notice).toBeVisible();
    await expect(notice.getByTestId("promo-badge")).toHaveText(/Soldes\s*−20 %/);
    await expect(buyer.getByTestId("price-tag").first()).toContainText(/960/);
    await expect(buyer.getByTestId("price-before").first()).toContainText(/1\s200/);
    await buyer.screenshot({ path: "test-results/catalogue-promo-listing.png", fullPage: true });
  });

  test("a shop files a listing under a section, and its storefront shows the section and promotions as tabs", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const email = `catalogue-${randomId(10)}@joutiya.test`;
    await signUpAndIn(page, request, email, "Lalla Atelier");
    const { proId, published, jacket } = await seedShop(email);
    const now = Date.now();
    await getFirestore(firebase())
      .collection("listings")
      .doc(published.id)
      .update({
        promo: {
          kind: "promo",
          startsAt: new Date(now - 3_600_000),
          endsAt: new Date(now + 48 * 3_600_000),
          percent: 10,
          prices: [
            { key: "s", price: 1080, reference: null },
            { key: "m", price: 1080, reference: null },
          ],
        },
      });

    await page.context().clearCookies();
    await page.goto("/fr/pro");
    await expect(page).toHaveURL(/\/connexion/);
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/fr\/pro/, { timeout: 15_000 });

    const settings = page.getByTestId("sections-settings");
    await settings.getByRole("button", { name: "Ajouter un rayon" }).click();
    await settings.getByRole("textbox", { name: "Nom du rayon 1" }).fill("Hiver");
    await settings.getByRole("button", { name: "Ajouter un rayon" }).click();
    await settings.getByRole("textbox", { name: "Nom du rayon 2" }).fill("hiver");
    await expect(settings.getByText("Ce nom est déjà pris par un autre rayon.")).toBeVisible();
    await settings.getByRole("button", { name: "Supprimer le rayon 2" }).click();
    await settings.getByRole("button", { name: "Enregistrer les rayons" }).click();
    await expect(page.getByText("Rayons enregistrés.")).toBeVisible();
    await settings.screenshot({ path: "test-results/catalogue-sections-settings.png" });

    await page.goto("/fr/mes-annonces");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: jacket.title }) });
    await row.getByTestId("owner-section").selectOption({ label: "Hiver" });
    await expect(page.getByText("Rayon enregistré.")).toBeVisible();
    const stored = (await getFirestore(firebase()).collection("listings").doc(jacket.id).get()).data()!;
    expect(stored.sectionId).toMatch(/^[a-z0-9]{6}$/);

    await expect.poll(async () => (await request.post("/api/dev/search/rebuild")).ok(), { timeout: 20_000, message: "listings indexed" }).toBe(true);
    const buyer = await (await browser.newContext()).newPage();
    await buyer.goto(`/fr/boutique/maison-lalla-${proId}`);
    const tabs = buyer.getByRole("tablist", { name: "Rayons de la boutique" });
    await expect(tabs.getByRole("tab")).toHaveText([/^Tout/, /^Hiver/, /^Promotions/]);
    await tabs.getByRole("tab", { name: /^Hiver/ }).click();
    await expect(buyer).toHaveURL(/#rayon-[a-z0-9]{6}$/);
    const hiver = buyer.getByRole("tabpanel");
    await expect(hiver.getByRole("link", { name: jacket.title })).toBeVisible();
    await expect(hiver.getByRole("link", { name: published.title })).toHaveCount(0);
    await buyer.screenshot({ path: "test-results/catalogue-storefront-section.png", fullPage: true });
    await tabs.getByRole("tab", { name: /^Promotions/ }).click();
    await expect(buyer).toHaveURL(/#promotions$/);
    await expect(buyer.getByRole("tabpanel").getByRole("link", { name: published.title })).toBeVisible();
    await buyer.reload();
    await expect(tabs.getByRole("tab", { name: /^Promotions/ })).toHaveAttribute("aria-selected", "true");
    await buyer.screenshot({ path: "test-results/catalogue-storefront-promotions.png", fullPage: true });
  });
});
