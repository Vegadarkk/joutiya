import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { BLURHASH, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Automated accessibility scan (audit C3-05) against the production build and the Firebase
// emulators (npm run test:e2e): axe-core with the WCAG 2.0 / 2.1 A and AA rules on the key pages, in
// French and in Arabic (RTL), on desktop and on a phone (@mobile). A listing is written straight
// into the emulator, then indexed by the dev rebuild route for the results page.

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
const LOCALES = ["fr", "ar"] as const;
const LETTERS = "abcdefghjkmnpqrstuvwxyz";
/** A word no other listing contains (letters only: one search token). */
const WORD = `zx${Array.from({ length: 8 }, () => LETTERS[Math.floor(Math.random() * LETTERS.length)]).join("")}`;

/**
 * Last-resort exclusions: one rule on one exact axe target, with the reason. Every entry must be a
 * defect outside the app's control (third-party markup), never a way to silence a real failure.
 */
const EXCLUSIONS: { rule: string; target: string; reason: string }[] = [];

type Violation = Awaited<ReturnType<AxeBuilder["analyze"]>>["violations"][number];

const targetOf = (node: Violation["nodes"][number]) => node.target.flat().join(" >>> ");

/** One line per violation: rule id, impact, help text and the offending selectors. */
function summarize(violations: Violation[]): string[] {
  return violations.flatMap((violation) => {
    const nodes = violation.nodes.filter((node) => !EXCLUSIONS.some((entry) => entry.rule === violation.id && entry.target === targetOf(node)));
    if (nodes.length === 0) return [];
    return [`${violation.id} [${violation.impact ?? "n/a"}] ${violation.help}: ${nodes.map(targetOf).join(" | ")}`];
  });
}

async function expectAccessible(page: Page, url: string, ready: (page: Page) => Locator, { networkIdle = true } = {}): Promise<void> {
  const response = await page.goto(url);
  expect(response?.status(), url).toBe(200);
  await expect(ready(page)).toBeVisible({ timeout: 20_000 });
  // Hydrated and settled (fonts, client islands) before the rules read the final styles.
  if (networkIdle) await page.waitForLoadState("networkidle");
  const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  expect(summarize(results.violations), `axe violations on ${url}`).toEqual([]);
}

let listing: { slugId: string; title: string };

async function seed(): Promise<{ slugId: string; title: string }> {
  const firestore = getFirestore(firebase());
  const uid = `e2e-a11y-${randomId(12)}`;
  const publicId = randomId(10);
  const now = new Date();
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: "Salma Test",
    type: "individual",
    citySlug: "casablanca",
    badges: { emailVerified: true, phoneVerified: true, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: now,
  });
  const id = randomId(8);
  const slugId = `velo-de-ville-casablanca-${id}`;
  const title = `Vélo de ville ${WORD}`;
  const photos = [];
  for (const [index, color] of [{ r: 196, g: 120, b: 52 }, { r: 34, g: 94, b: 74 }].entries()) {
    const photoId = `e2ea11y${index}${randomId(6)}`;
    photos.push({ id: photoId, ...(await storePhoto(id, photoId, color)), blurhash: BLURHASH });
  }
  await firestore.collection("listings").doc(id).set({
    ownerUid: uid,
    sellerType: "individual",
    sellerName: "Salma Test",
    sellerPublicId: publicId,
    status: "published",
    slugId,
    title,
    description: "Vélo de ville révisé, pneus neufs.\n\nÀ voir à Casablanca, quartier Maârif.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "very_good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos,
    contact: { messaging: true, showPhone: true, whatsapp: true },
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
  return { slugId, title };
}

test.beforeAll(async ({ request }) => {
  listing = await seed();
  // Indexed for the results page (the rebuild keeps what other projects index meanwhile).
  await expect
    .poll(
      async () => {
        if (!(await request.post("/api/dev/search/rebuild")).ok()) return -1;
        const body = (await (await request.get(`/api/search?q=${WORD}`)).json()) as { hits: unknown[] };
        return body.hits.length;
      },
      { timeout: 20_000, message: "seeded listing indexed" },
    )
    .toBe(1);
});

test.describe("accessibility (axe, WCAG 2.1 A and AA)", { tag: "@mobile" }, () => {
  // Final styles at once: an entrance transition would be read mid-way by the contrast rule.
  test.use({ contextOptions: { reducedMotion: "reduce" } });

  for (const locale of LOCALES) {
    test.describe(`/${locale}`, () => {
      test("home", async ({ page }) => {
        await expectAccessible(page, `/${locale}`, (p) => p.getByTestId("home-categories"));
      });

      test("listing page", async ({ page }) => {
        await expectAccessible(page, `/${locale}/annonce/${listing.slugId}`, (p) => p.getByRole("heading", { level: 1, name: listing.title }));
      });

      test("search results", async ({ page }) => {
        await expectAccessible(page, `/${locale}/recherche?q=${WORD}`, (p) => p.locator("#main").getByTestId("results-grid").getByRole("link", { name: new RegExp(WORD) }).first());
      });

      test("sign-up", async ({ page }) => {
        // The Turnstile widget never lets the network go idle: settled once it holds its token.
        await expectAccessible(page, `/${locale}/inscription`, (p) => p.locator('[data-turnstile="ready"]'), { networkIdle: false });
      });

      test("legal page", async ({ page }) => {
        await expectAccessible(page, `/${locale}/legal/mentions-legales`, (p) => p.getByRole("heading", { level: 1 }));
      });

      test("posting wizard, step 1", async ({ page, request }) => {
        test.setTimeout(90_000);
        await signUpAndIn(page, request, `e2e-a11y-${locale}-${Date.now().toString(36)}${randomId(4)}@test.joutiya.ma`);
        await expectAccessible(page, `/${locale}/deposer`, (p) => p.getByRole("radio").first());
      });
    });
  }
});
