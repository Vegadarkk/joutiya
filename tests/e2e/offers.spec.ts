import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { BLURHASH, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// « Prix repère » and « Faire une offre » (Carte vivante lot 5) against the production build and
// the emulators. The guide: ten comparable children's bikes in Chefchaouen are indexed by the dev
// rebuild route, the listing page shows their typical range with the listing's price on it. The
// offer: the buyer offers from the listing page, the seller counters from the thread, the buyer
// accepts; both see the accepted card and the steps. No Valkey: the threads poll.
// OFFER_SCREENSHOTS=<dir> also saves the review screenshots (FR and AR, light and dark, desktop and
// phone).
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

interface Member {
  uid: string;
  publicId: string;
  displayName: string;
}

async function session(page: Page): Promise<Member> {
  const me = (await (await page.request.get("/api/auth/me")).json()) as { session: Member | null };
  expect(me.session?.uid).toBeTruthy();
  return me.session!;
}

interface Seed {
  title: string;
  price: number;
  citySlug: string;
  regionCode: string;
  photo?: boolean;
}

async function seedBike(owner: Member, seed: Seed): Promise<{ id: string; slugId: string }> {
  const now = new Date();
  const id = randomId(8);
  const slugId = `velo-enfant-${seed.citySlug}-${id}`;
  const photos = [];
  if (seed.photo) {
    const photoId = `e2ephoto${randomId(8)}`;
    photos.push({ id: photoId, ...(await storePhoto(id, photoId, { r: 30, g: 110, b: 98 })), blurhash: BLURHASH });
  }
  await getFirestore(firebase())
    .collection("listings")
    .doc(id)
    .set({
      ownerUid: owner.uid,
      sellerType: "individual",
      sellerName: owner.displayName,
      sellerPublicId: owner.publicId,
      categoryId: "vehicules",
      subcategoryId: "velos",
      attributes: { "bike-type": "bmx" },
      condition: "good",
      price: seed.price,
      priceNegotiable: true,
      isDonation: false,
      location: { regionCode: seed.regionCode, citySlug: seed.citySlug, geo: { lat: 35.17, lng: -5.27 } },
      contact: { messaging: true, showPhone: false, whatsapp: false },
      boosts: {},
      sortAt: now,
      sortSource: "publish",
      moderation: { state: "auto_ok", score: 5, flags: [], openReports: 0 },
      legalHold: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: "published",
      slugId,
      title: seed.title,
      description: "Vélo BMX en bon état, freins révisés, pneus récents. À voir sur place.",
      photos,
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  return { id, slugId };
}

const shots = process.env.OFFER_SCREENSHOTS;
const VIEWPORTS = { desktop: { width: 1280, height: 800 }, mobile: { width: 390, height: 844 } } as const;

/** Desktop and phone, light and dark, of what `page` shows (`prepare` brings the state back after a resize). */
async function shoot(page: Page, name: string, prepare?: () => Promise<void>): Promise<void> {
  if (!shots) return;
  const original = page.viewportSize();
  for (const [device, size] of Object.entries(VIEWPORTS)) {
    for (const scheme of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      // The theme is read once at load (data-theme on <html>): set it as the theme switch does.
      await page.evaluate((theme) => document.documentElement.setAttribute("data-theme", theme), scheme);
      await page.setViewportSize(size);
      if (prepare) await prepare();
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${shots}/${name}-${device}-${scheme}.png` });
    }
  }
  await page.emulateMedia({ colorScheme: "light" });
  await page.evaluate(() => document.documentElement.setAttribute("data-theme", "light"));
  if (original) await page.setViewportSize(original);
}

test.describe("price guide and offers", () => {
  test.describe.configure({ mode: "serial" });
  test.setTimeout(240_000);

  test("the listing page shows the price guide of its comparables, the buyer offers, the seller counters, the buyer accepts", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const buyerPage = await buyerContext.newPage();
    const errors: string[] = [];
    for (const page of [sellerPage, buyerPage]) page.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-offer-seller-${stamp}@test.joutiya.ma`, "Salma Vendeuse");
    await signUpAndIn(buyerPage, request, `e2e-offer-buyer-${stamp}@test.joutiya.ma`, "Youssef Acheteur");
    const seller = await session(sellerPage);

    // Ten comparables in the city (BMX bikes), one outlier type elsewhere, then the listing itself.
    const place = { citySlug: "chefchaouen", regionCode: "01" };
    for (const price of [900, 1000, 1100, 1200, 1250, 1300, 1400, 1500, 1600, 1800]) await seedBike(seller, { title: `BMX ${price} ${stamp}`, price, ...place });
    const listing = await seedBike(seller, { title: `Vélo BMX 20 pouces ${stamp}`, price: 1350, ...place, photo: true });
    await expect.poll(async () => (await request.post("/api/dev/search/rebuild")).ok(), { timeout: 20_000, message: "listings indexed" }).toBe(true);

    await buyerPage.goto(`/fr/annonce/${listing.slugId}`);
    const guide = buyerPage.getByTestId("price-guide");
    await expect(guide).toBeVisible();
    await expect(guide).toHaveAttribute("data-scope", "city");
    await expect(guide.getByTestId("price-guide-count")).toHaveText("10 annonces comparables à Chefchaouen");
    await expect(guide.getByTestId("price-guide-range")).toContainText("–");
    await expect(guide.getByTestId("price-guide-marker")).toBeVisible();
    await expect(guide).toContainText("Indication calculée sur les annonces publiées, sans garantie.");
    await shoot(buyerPage, "1-annonce-prix-repere-fr", async () => {
      await guide.scrollIntoViewIfNeeded();
    });

    // « Faire une offre » from the listing page: the amount, the drafted message, the notice.
    const offerButton = buyerPage.getByTestId("offer-button");
    await offerButton.click();
    const dialog = buyerPage.getByTestId("message-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toContainText("Faire une offre à");
    await expect(dialog.getByTestId("offer-notice")).toContainText("Une offre acceptée ne réserve pas l'article et n'engage ni à vendre ni à acheter");
    const amount = dialog.getByLabel("Votre offre");
    await amount.fill("300");
    await dialog.getByRole("button", { name: "Envoyer l'offre" }).click();
    await expect(dialog.getByText(/L'offre ne peut pas être inférieure à/)).toBeVisible();
    await amount.fill("1200");
    await expect(dialog.getByLabel("Votre message")).toHaveValue(/je vous propose 1\s200/);
    await expect(dialog.locator("[data-turnstile]")).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
    await shoot(buyerPage, "2-dialogue-offre-fr");
    await dialog.getByRole("button", { name: "Envoyer l'offre" }).click();
    await expect(buyerPage).toHaveURL(/\/fr\/messages\/[A-Za-z0-9_-]{22}$/, { timeout: 20_000 });
    const cid = new URL(buyerPage.url()).pathname.split("/").at(-1)!;
    const buyerCard = buyerPage.getByTestId("offer-card");
    await expect(buyerCard).toHaveAttribute("data-status", "open", { timeout: 15_000 });
    await expect(buyerCard).toHaveAttribute("data-role", "buyer");
    await expect(buyerPage.getByTestId("offer-event").first()).toContainText("Vous avez proposé");

    // The seller counters from the thread.
    await sellerPage.goto(`/fr/messages/${cid}`);
    const sellerCard = sellerPage.getByTestId("offer-card");
    await expect(sellerCard).toHaveAttribute("data-status", "open", { timeout: 15_000 });
    await expect(sellerCard).toContainText("vous propose");
    await shoot(sellerPage, "3-offre-recue-vendeur-fr");
    await sellerCard.getByTestId("offer-counter").click();
    const counter = sellerPage.getByTestId("offer-dialog");
    await expect(counter).toBeVisible();
    await counter.getByLabel("Votre contre-offre").fill("1300");
    await counter.getByLabel(/Un mot pour accompagner/).fill("Je peux descendre à 1 300, il est comme neuf.");
    await shoot(sellerPage, "4-contre-offre-fr");
    await counter.getByTestId("offer-submit").click();
    await expect(counter).toBeHidden({ timeout: 15_000 });
    await expect(sellerCard).toHaveCount(1);
    await expect(sellerCard).toHaveAttribute("data-status", "countered");

    // The buyer's open thread follows (polling) and accepts the counter-offer.
    await expect(buyerCard).toHaveAttribute("data-status", "countered", { timeout: 40_000 });
    await expect(buyerPage.getByTestId("thread").getByText("Je peux descendre à 1 300, il est comme neuf.")).toBeVisible();
    await shoot(buyerPage, "5-contre-offre-recue-acheteur-fr");
    await buyerCard.getByTestId("offer-accept").click();
    await expect(buyerCard).toHaveAttribute("data-status", "accepted", { timeout: 15_000 });
    await expect(buyerCard).toContainText("Offre acceptée");
    await expect(buyerPage.getByTestId("offer-event").filter({ hasText: "Vous avez accepté le prix de" })).toBeVisible();
    await shoot(buyerPage, "6-offre-acceptee-acheteur-fr");
    await expect(sellerCard).toHaveAttribute("data-status", "accepted", { timeout: 40_000 });
    await expect(sellerPage.getByTestId("offer-event").filter({ hasText: "a accepté le prix de" })).toBeVisible();

    if (shots) {
      // Arabic: the listing page, the thread, and the offer dialog of the thread (a new offer is possible once accepted).
      await buyerPage.goto(`/ar/annonce/${listing.slugId}`);
      await expect(buyerPage.getByTestId("price-guide")).toBeVisible();
      await shoot(buyerPage, "1-annonce-prix-repere-ar", async () => {
        await buyerPage.getByTestId("price-guide").scrollIntoViewIfNeeded();
      });
      await sellerPage.goto(`/ar/messages/${cid}`);
      await expect(sellerPage.getByTestId("offer-card")).toHaveAttribute("data-status", "accepted", { timeout: 15_000 });
      await shoot(sellerPage, "6-offre-acceptee-vendeur-ar");
      await buyerPage.goto(`/ar/messages/${cid}?offre=1`);
      await expect(buyerPage.getByTestId("offer-dialog")).toBeVisible({ timeout: 15_000 });
      await buyerPage.getByTestId("offer-dialog").getByRole("textbox").first().fill("1250");
      await shoot(buyerPage, "2-dialogue-offre-ar");
    }

    await buyerPage.setViewportSize({ width: 360, height: 780 });
    await buyerPage.goto(`/fr/messages/${cid}`);
    await expect(buyerPage.getByTestId("offer-card")).toBeVisible({ timeout: 15_000 });
    expect(await buyerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    expect(errors).toEqual([]);
    await sellerContext.close();
    await buyerContext.close();
  });
});
