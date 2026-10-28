import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Ad slots (phase 6, D4-D7, D19) against the production build. Ads are off here and no publisher
// id is configured, so the browser gets the "ads on" configuration from a route, the visitor's
// region from a stubbed /cdn-cgi/trace and AdSense from a stub that fills each unit 1.5 s late.
// The search page (nonce + 'strict-dynamic') runs the stub; the hash-CSP pages carry no ad host
// in this environment, so their loader is blocked and the house promotion must come back.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const LETTERS = "abcdefghjkmnpqrstuvwxyz";
const ALPHABET = `${LETTERS}23456789`;
const randomFrom = (alphabet: string, length: number) => Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
/** A word only this run's listings contain. */
const WORD = `zq${randomFrom(LETTERS, 8)}`;
const RESULTS = 8;

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

let listingSlug = "";

async function seed(): Promise<void> {
  const firestore = getFirestore(firebase());
  const uid = `e2e-ads-${randomFrom(ALPHABET, 12)}`;
  const publicId = randomFrom(ALPHABET, 10);
  const now = Date.now();
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: "Karim Test",
    type: "individual",
    citySlug: "rabat",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: RESULTS, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: new Date(now),
  });
  for (let index = 0; index < RESULTS; index += 1) {
    const id = randomFrom(ALPHABET, 8);
    const slugId = `velo-${WORD}-${index}-${id}`;
    const at = new Date(now - (index + 1) * 60_000);
    await firestore
      .collection("listings")
      .doc(id)
      .set({
        ownerUid: uid,
        sellerType: "individual",
        sellerName: "Karim Test",
        sellerPublicId: publicId,
        status: "published",
        slugId,
        title: `Vélo ${WORD} numéro ${index + 1}`,
        description: `Annonce de test ${WORD}, en bon état.`,
        categoryId: "vehicules",
        subcategoryId: "velos",
        attributes: { "bike-type": "ville" },
        condition: "good",
        price: 1000 + index * 100,
        priceNegotiable: false,
        isDonation: false,
        location: { regionCode: "04", citySlug: "rabat", geo: { lat: 34.0211, lng: -6.8414 } },
        photos: [],
        contact: { messaging: true, showPhone: false, whatsapp: false },
        boosts: {},
        sortAt: at,
        sortSource: "publish",
        moderation: { state: "auto_ok", score: 5, flags: [], openReports: 0 },
        adsEligible: true,
        publishedAt: at,
        expiresAt: new Date(now + 60 * 86_400_000),
        legalHold: [],
        createdAt: at,
        updatedAt: at,
        version: 1,
      });
    if (index === 0) listingSlug = slugId;
  }
}

test.beforeAll(async ({ request }) => {
  await seed();
  const rebuilt = await request.post("/api/dev/search/rebuild");
  expect(rebuilt.ok()).toBe(true);
});

/** AdSense stand-in: fills every waiting unit with a slot-sized frame after 1.5 s. */
const ADSENSE_STUB = `(function () {
  var queued = window.adsbygoogle || [];
  function fill() {
    setTimeout(function () {
      document.querySelectorAll("ins.adsbygoogle:not([data-ad-status])").forEach(function (ins) {
        var frame = document.createElement("iframe");
        frame.title = "Ad";
        frame.style.cssText = "border:0;display:block;width:" + ins.style.width + ";height:" + ins.style.height;
        ins.appendChild(frame);
        ins.setAttribute("data-ad-status", "filled");
      });
    }, 1500);
  }
  window.adsbygoogle = { push: fill, pauseAdRequests: queued.pauseAdRequests, requestNonPersonalizedAds: queued.requestNonPersonalizedAds };
  for (var i = 0; i < queued.length; i += 1) fill();
})();`;

interface AdsSetup {
  country: string;
  choice: { ads: boolean; perso: boolean } | null;
}

/** Ads on in test mode, the visitor's country and stored choice; returns the AdSense requests seen. */
async function adsOn(page: Page, baseURL: string, { country, choice }: AdsSetup): Promise<string[]> {
  const requests: string[] = [];
  await page.route("**/api/config", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    const units = { leaderboard: "1000000001", halfpage: "1000000002", rectangle: "1000000003", banner: "1000000004" };
    await route.fulfill({ response, json: { ...body, ads: { mode: "test", cmpEea: false, client: "ca-pub-0000000000000001", units } } });
  });
  await page.route("**/cdn-cgi/trace", (route) => route.fulfill({ contentType: "text/plain", body: `fl=1\nloc=${country}\n` }));
  await page.route("https://pagead2.googlesyndication.com/**", (route) => {
    requests.push(route.request().url());
    return route.fulfill({ contentType: "application/javascript", headers: { "Access-Control-Allow-Origin": "*" }, body: ADSENSE_STUB });
  });
  if (choice) {
    const value = `1.${Buffer.from(JSON.stringify({ v: 1, t: Math.floor(Date.now() / 1000), ...choice })).toString("base64url")}`;
    await page.context().addCookies([{ name: "jt_consent", value, url: baseURL }]);
  }
  // Cumulative layout shift of the page, every shift summed (stricter than the session windows of CLS).
  await page.addInitScript(() => {
    const w = window as unknown as { __cls: number };
    w.__cls = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries() as (PerformanceEntry & { value: number; hadRecentInput: boolean })[]) {
        if (!entry.hadRecentInput) w.__cls += entry.value;
      }
    }).observe({ type: "layout-shift", buffered: true });
  });
  return requests;
}

const cls = (page: Page) => page.evaluate(() => (window as unknown as { __cls: number }).__cls);

test.describe("ad slots", () => {
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  test("search: a consenting visitor outside the EEA gets the in-feed ad after the 6th card, filled late without a shift", { tag: "@mobile" }, async ({ page, baseURL }) => {
    const requests = await adsOn(page, baseURL!, { country: "MA", choice: { ads: true, perso: false } });
    await page.goto(`/fr/recherche?q=${WORD}`);
    const grid = page.getByRole("region", { name: "Résultats" }).getByTestId("results-grid");
    await expect(grid.locator(":scope > li")).toHaveCount(RESULTS + 1);
    const infeed = grid.locator('[data-ad-slot="search-infeed"]');
    await expect(infeed).toHaveCount(1);
    // The 7th item of the grid: after the 6th card.
    await expect(grid.locator(":scope > li").nth(6).locator('[data-ad-slot="search-infeed"]')).toHaveCount(1);
    await expect(infeed).toHaveAttribute("data-ad-state", "filled", { timeout: 8000 });
    await expect(infeed).toHaveAttribute("aria-label", "Publicité");
    await expect(infeed.locator("ins.adsbygoogle")).toHaveAttribute("data-adtest", "on");
    expect(requests.length).toBe(1);
    expect(new URL(requests[0]!).searchParams.get("client")).toBe("ca-pub-0000000000000001");
    expect(await page.evaluate(() => (window as unknown as { adsbygoogle: { requestNonPersonalizedAds?: number } }).adsbygoogle.requestNonPersonalizedAds)).toBe(1);
    const box = await infeed.boundingBox();
    expect(box?.height).toBe(270);
    await page.waitForTimeout(500);
    expect(await cls(page)).toBeLessThan(0.1);
  });

  test("search: a refusal or an EEA visitor sends no AdSense request and keeps the house promotions", async ({ page, baseURL }) => {
    const requests = await adsOn(page, baseURL!, { country: "MA", choice: { ads: false, perso: false } });
    await page.goto(`/fr/recherche?q=${WORD}`);
    const infeed = page.locator('[data-ad-slot="search-infeed"]');
    await expect(infeed).toHaveAttribute("data-ad-state", "promo");
    await expect(infeed).toHaveAttribute("aria-label", "À découvrir sur Joutiya");
    await page.waitForLoadState("networkidle");
    expect(requests).toEqual([]);

    const eea = await page.context().newPage();
    const eeaRequests = await adsOn(eea, baseURL!, { country: "FR", choice: { ads: true, perso: true } });
    await eea.goto(`/fr/recherche?q=${WORD}`);
    await expect(eea.locator('[data-ad-slot="search-infeed"]')).toHaveAttribute("data-ad-state", "promo");
    await eea.waitForLoadState("networkidle");
    expect(eeaRequests).toEqual([]);
  });

  test("listing: a blocked loader gives the slot back to the house promotion, at the same height", { tag: "@mobile" }, async ({ page, baseURL }) => {
    await adsOn(page, baseURL!, { country: "MA", choice: { ads: true, perso: true } });
    await page.goto(`/fr/annonce/${listingSlug}`);
    const slot = page.locator('[data-ad-slot="listing-bottom"]');
    await expect(slot).toHaveAttribute("data-ad-eligible", "true");
    await slot.scrollIntoViewIfNeeded();
    await expect(slot).toHaveAttribute("data-ad-state", "promo", { timeout: 8000 });
    await expect(slot.getByRole("link")).toBeVisible();
    expect((await slot.boundingBox())?.height).toBe(270);
    expect(await cls(page)).toBeLessThan(0.1);
  });

  test("home: the leaderboard shows on desktop only, and Tarifit pages never ask for an ad", async ({ page, baseURL }) => {
    const requests = await adsOn(page, baseURL!, { country: "MA", choice: { ads: true, perso: true } });
    await page.goto(`/rif/recherche?q=${WORD}`);
    await expect(page.locator('[data-ad-slot="search-infeed"]')).toHaveAttribute("data-ad-state", "promo");
    await page.waitForLoadState("networkidle");
    expect(requests).toEqual([]);

    await page.goto("/fr");
    const leaderboard = page.locator('[data-ad-slot="home-leaderboard"]');
    await expect(leaderboard).toBeVisible();
    expect((await leaderboard.boundingBox())?.height).toBe(110);
    await page.setViewportSize({ width: 412, height: 915 });
    await expect(leaderboard).toBeHidden();
  });
});
