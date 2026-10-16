import { existsSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Visual regression of the static map (design D10, §6): the SVG is server-rendered and deterministic
// for a given city and listing id (the seed of the approximate marker), so the screenshot baseline
// catches any change of the regions, the highlight, the marker or the attribution. The fixture has a
// fixed id and is written straight into the Firestore emulator (npm run test:e2e), idempotently.
//
// The baseline (static-map.spec.ts-snapshots/) is generated on the CI Linux image, never in a
// container with other fonts: `npx playwright test tests/e2e/visual --update-snapshots`. Until it
// is committed the test is skipped rather than failing every run.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const LISTING_ID = "vsmap234";
const SLUG_ID = `appartement-casablanca-${LISTING_ID}`;
const SCREENSHOT = "static-map.png";
// Public ids use the publicId alphabet (no i, l, o, 0, 1): the strict schemas refuse anything else.
const SELLER_PUBLIC_ID = "vsmapsef23";

async function seedFixture(): Promise<void> {
  const app = getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
  const firestore = getFirestore(app);
  const uid = "e2e-visual-seller";
  const at = new Date("2026-10-01T09:00:00.000Z");
  await firestore.collection("users").doc(uid).set({
    publicId: SELLER_PUBLIC_ID,
    displayName: "Vendeur Visuel",
    type: "individual",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: at,
    updatedAt: at,
  });
  await firestore.collection("listings").doc(LISTING_ID).set({
    ownerUid: uid,
    sellerType: "individual",
    sellerName: "Vendeur Visuel",
    sellerPublicId: SELLER_PUBLIC_ID,
    status: "published",
    slugId: SLUG_ID,
    title: "Appartement lumineux",
    description: "Appartement de trois pièces, lumineux, proche du tramway.",
    categoryId: "immobilier",
    subcategoryId: "location",
    attributes: { "property-type": "appartement", surface: 85, furnished: false },
    price: 6500,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: at,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 0, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: at,
    // Far ahead: the nightly expiry job must never end the fixture.
    expiresAt: new Date("2099-01-01T00:00:00.000Z"),
    legalHold: [],
    createdAt: at,
    updatedAt: at,
    version: 1,
  });
}

test.describe("static regions map", () => {
  test("matches the baseline on a listing page", async ({ page }, testInfo) => {
    const updating = testInfo.config.updateSnapshots === "all" || testInfo.config.updateSnapshots === "changed";
    test.skip(!updating && !existsSync(testInfo.snapshotPath(SCREENSHOT, { kind: "screenshot" })), "no baseline yet: generate it on the CI Linux image");
    await seedFixture();
    await page.setViewportSize({ width: 1280, height: 900 });
    const response = await page.goto(`/fr/annonce/${SLUG_ID}`);
    expect(response?.status()).toBe(200);
    const map = page.getByTestId("static-map");
    await map.scrollIntoViewIfNeeded();
    await expect(map).toBeVisible();
    await expect(map).toContainText("Casablanca");
    await expect(map).toHaveScreenshot(SCREENSHOT, { maxDiffPixelRatio: 0.01, animations: "disabled" });
  });
});
