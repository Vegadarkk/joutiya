import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { stubGoogleScript } from "./gsi-stub";
import { ownClientIp } from "./helpers";

// The auth pages render the Google button (stub client id): never the real script.
test.beforeEach(({ page }) => stubGoogleScript(page));

// Search and discovery (phase 4) against the production build and the Firebase emulators
// (npm run test:e2e). Listings are written straight into the emulator, then indexed by the dev
// rebuild route (POST /api/dev/search/rebuild: every published listing, other documents dropped).
// The engine is Meilisearch when MEILI_URL and the keys are set (CI service container), else the
// in-memory engine of the web process. Every title carries a random word of this run, so other
// specs' listings never change the counts.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const LETTERS = "abcdefghjkmnpqrstuvwxyz";
const ALPHABET = `${LETTERS}23456789`;
const randomFrom = (alphabet: string, length: number) => Array.from(randomBytes(length), (byte) => alphabet[byte % alphabet.length]).join("");
/** A word no other listing contains (letters only: one Meilisearch token). */
const WORD = `zq${randomFrom(LETTERS, 8)}`;

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

interface Seeded {
  id: string;
  slugId: string;
  title: string;
}

function listingDoc(input: {
  uid: string;
  publicId: string;
  slugId: string;
  title: string;
  categoryId: string;
  subcategoryId: string;
  attributes: Record<string, unknown>;
  condition?: string;
  price: number;
  city: { slug: string; regionCode: string; lat: number; lng: number };
  minutesAgo: number;
}) {
  const now = new Date();
  const at = new Date(now.getTime() - input.minutesAgo * 60_000);
  return {
    ownerUid: input.uid,
    sellerType: "individual",
    sellerName: "Nadia Test",
    sellerPublicId: input.publicId,
    status: "published",
    slugId: input.slugId,
    title: input.title,
    description: `Annonce de test ${WORD}, en bon état.`,
    categoryId: input.categoryId,
    subcategoryId: input.subcategoryId,
    attributes: input.attributes,
    ...(input.condition ? { condition: input.condition } : {}),
    price: input.price,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: input.city.regionCode, citySlug: input.city.slug, geo: { lat: input.city.lat, lng: input.city.lng } },
    photos: [],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: at,
    sortSource: "publish",
    moderation: { state: "auto_ok", score: 5, flags: [], openReports: 0 },
    adsEligible: true,
    publishedAt: at,
    expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    legalHold: [],
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

const CASABLANCA = { slug: "casablanca", regionCode: "06", lat: 33.5992, lng: -7.62 };
const RABAT = { slug: "rabat", regionCode: "04", lat: 34.0211, lng: -6.8414 };

async function seed(): Promise<{ bike: Seeded; car: Seeded; flat: Seeded }> {
  const firestore = getFirestore(firebase());
  const uid = `e2e-search-${randomFrom(ALPHABET, 12)}`;
  const publicId = randomFrom(ALPHABET, 10);
  const now = new Date();
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: "Nadia Test",
    type: "individual",
    citySlug: "casablanca",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 3, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: now,
  });
  const make = async (title: string, rest: Omit<Parameters<typeof listingDoc>[0], "uid" | "publicId" | "slugId" | "title">): Promise<Seeded> => {
    const id = randomFrom(ALPHABET, 8);
    const slugId = `${title.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${id}`;
    await firestore.collection("listings").doc(id).set(listingDoc({ uid, publicId, slugId, title, ...rest }));
    return { id, slugId, title };
  };
  const bike = await make(`Vélo cargo ${WORD}`, {
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "very_good",
    price: 2500,
    city: CASABLANCA,
    minutesAgo: 30,
  });
  const car = await make(`Voiture citadine ${WORD}`, {
    categoryId: "vehicules",
    subcategoryId: "voitures",
    attributes: { "car-brand": "dacia", model: "Sandero", year: 2019, mileage: 85_000, fuel: "diesel", gearbox: "manuelle" },
    price: 98_000,
    city: CASABLANCA,
    minutesAgo: 20,
  });
  const flat = await make(`Appartement lumineux ${WORD}`, {
    categoryId: "immobilier",
    subcategoryId: "vente",
    attributes: { "property-type": "appartement", surface: 85 },
    price: 950_000,
    city: RABAT,
    minutesAgo: 10,
  });
  return { bike, car, flat };
}

/** Collects CSP violations reported by the page itself. */
async function watchCsp(page: Page): Promise<string[]> {
  const violations: string[] = [];
  await page.exposeFunction("__cspViolation", (detail: string) => violations.push(detail));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolation: (detail: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return violations;
}

interface DevMail {
  template: string;
  data: { actionUrl?: string };
}

async function waitForMail(request: APIRequestContext, to: string, template: string): Promise<DevMail> {
  let found: DevMail | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(to)}`);
        if (!response.ok()) return false;
        const { mails } = (await response.json()) as { mails: DevMail[] };
        found = mails.find((mail) => mail.template === template);
        return Boolean(found);
      },
      { timeout: 20_000, message: `mail "${template}" for ${to}` },
    )
    .toBe(true);
  return found!;
}

async function signUpAndIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await ownClientIp(page);
  await page.goto("/fr/inscription");
  // Hydrated first (the widget turns ready client side): a consent ticked earlier is unticked when the form registers its fields.
  await expect(page.locator("[data-turnstile]").first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
  await page.getByLabel("Nom affiché").fill("Karim Test");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox", { name: /conditions générales d'utilisation/i }).check();
  await page.getByRole("checkbox", { name: /transférer mes données personnelles/i }).check();
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page.getByRole("heading", { name: "Vérifiez votre boîte mail" })).toBeVisible({ timeout: 15_000 });
  const mail = await waitForMail(request, email, "verifyEmail");
  await page.goto(mail.data.actionUrl!);
  await expect(page.getByRole("heading", { name: "Adresse confirmée" })).toBeVisible({ timeout: 15_000 });
}

let listings: Awaited<ReturnType<typeof seed>>;

// One index for the whole run: the rebuild drops what it does not find in Firestore.
test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ request }) => {
  listings = await seed();
  const rebuilt = await request.post("/api/dev/search/rebuild");
  expect(rebuilt.status()).toBe(200);
});

/**
 * The results inside #main: React reveals streamed content a moment after the load event, and until
 * then a hidden copy of it waits at the end of <body>.
 */
const results = (page: Page) => page.locator("#main");

test.describe("search page", () => {
  test("finds the run's listings by word under a nonce CSP, without violations", { tag: "@mobile" }, async ({ page }) => {
    const violations = await watchCsp(page);
    const response = await page.goto(`/fr/recherche?q=${WORD}`);
    expect(response?.status()).toBe(200);
    const csp = response?.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    // Streamed per request (never cached): nonce CSP, like private pages ('unsafe-inline' and
    // https: are fallbacks for CSP 1 browsers, ignored next to a nonce and 'strict-dynamic').
    expect(scriptSrc).toContain("'nonce-");
    expect(scriptSrc).toContain("'strict-dynamic'");
    await expect(results(page).getByTestId("search-count")).toHaveText("3 annonces");
    const grid = results(page).getByTestId("results-grid");
    for (const listing of Object.values(listings)) await expect(grid.getByRole("link", { name: new RegExp(listing.title) })).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
    expect(violations).toEqual([]);
  });

  test("filters on category and city from the URL", async ({ page }) => {
    await page.goto(`/fr/recherche?q=${WORD}&categorie=vehicules&ville=casablanca`);
    await expect(results(page).getByTestId("search-count")).toHaveText("2 annonces");
    await expect(results(page).getByTestId("results-grid").getByRole("link", { name: new RegExp(listings.flat.title) })).toHaveCount(0);
  });

  test("sorts by price and keeps the canonical parameters", async ({ request }) => {
    const response = await request.get(`/api/search?q=${WORD}&tri=prix-croissant`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = (await response.json()) as { hits: { id: string; price: number | null }[]; params: { sort?: string } };
    expect(body.hits.map((hit) => hit.id)).toEqual([listings.bike.id, listings.car.id, listings.flat.id]);
  });

  test("understands darija: tomobil finds the car", async ({ request }) => {
    const response = await request.get(`/api/search?q=${encodeURIComponent(`tomobil ${WORD}`)}`);
    const body = (await response.json()) as { hits: { id: string }[] };
    expect(body.hits.map((hit) => hit.id)).toEqual([listings.car.id]);
  });

  test("previews a listing for the map's detail panel from the index, in the asked language", async ({ request }) => {
    const response = await request.get(`/api/listings/${listings.car.id}/preview?locale=fr`);
    expect(response.status()).toBe(200);
    expect(response.headers()["cache-control"]).toContain("no-store");
    const body = (await response.json()) as { criteria: { id: string; value: string }[]; description: string; seller: { type: string } | null };
    expect(body.criteria.find((row) => row.id === "model")?.value).toBe("Sandero");
    expect(body.criteria.find((row) => row.id === "mileage")?.value).toMatch(/^85\s000 km$/);
    expect(body.description).toContain(WORD);
    expect(body.seller?.type).toBe("individual");
    const arabic = (await (await request.get(`/api/listings/${listings.car.id}/preview?locale=ar`)).json()) as { criteria: { id: string; label: string }[] };
    expect(arabic.criteria.find((row) => row.id === "fuel")?.label).toBe("نوع الوقود");
    expect((await request.get("/api/listings/zzzzzzzz/preview?locale=fr")).status()).toBe(404);
  });

  test("finds the Rabat listing within 50 km of Rabat only", async ({ request }) => {
    const response = await request.get(`/api/search?q=${WORD}&ville=rabat&rayon=50`);
    const body = (await response.json()) as { hits: { id: string }[] };
    expect(body.hits.map((hit) => hit.id)).toEqual([listings.flat.id]);
  });

  test("searches a map zone: the circle wins over a city, clamped and rounded", async ({ request }) => {
    const response = await request.get(`/api/search?q=${WORD}&zone=33.59921,-7.62004,19.2&ville=rabat`);
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { hits: { id: string }[]; params: { zone?: unknown; city?: string } };
    expect(body.params.zone).toEqual({ lat: 33.599, lng: -7.62, km: 20 });
    expect(body.params.city).toBeUndefined();
    expect(body.hits.map((hit) => hit.id).sort()).toEqual([listings.bike.id, listings.car.id].sort());
  });

  test("shows a map zone as a removable chip and names it in the title", async ({ page }) => {
    await page.goto(`/fr/recherche?q=${WORD}&zone=33.599,-7.62,20`);
    await expect(results(page).getByTestId("search-count")).toHaveText("2 annonces");
    await expect(results(page).locator("h1")).toContainText("dans la zone de la carte");
    await results(page).getByRole("link", { name: /Zone de la carte · 20 km/ }).click();
    await expect(page).not.toHaveURL(/zone=/);
    await expect(results(page).getByTestId("search-count")).toHaveText("3 annonces");
  });

  test("fills the header pill from the URL and keeps the other filters on a new search", async ({ page }) => {
    await page.goto(`/fr/recherche?q=${WORD}&categorie=vehicules`);
    const pill = page.getByRole("banner").getByRole("search");
    await expect(pill.locator("#header-search")).toHaveValue(WORD);
    await expect(pill.locator('input[type="hidden"][name="categorie"]')).toHaveValue("vehicules");
    // The page has no second search field of its own.
    await expect(results(page).getByRole("search")).toHaveCount(0);
    await pill.locator("#header-search").fill(`tomobil ${WORD}`);
    await pill.locator("#header-search").press("Enter");
    await expect(page).toHaveURL(/categorie=vehicules/);
    await expect(page).toHaveURL(/q=tomobil/);
    await expect(results(page).getByTestId("search-count")).toHaveText("1 annonce");
  });

  test("the place field stays quiet on keyboard focus and opens on a key or a click", async ({ page }) => {
    // The place segment of the pill shows from xl (UX audit, 17: Tab must not open the list).
    await page.setViewportSize({ width: 1366, height: 800 });
    await page.goto(`/fr/recherche?q=${WORD}`);
    const place = page.getByRole("banner").getByRole("combobox");
    await place.focus();
    await expect(place).toBeFocused();
    await expect(place).toHaveAttribute("aria-expanded", "false");
    await place.press("ArrowDown");
    await expect(place).toHaveAttribute("aria-expanded", "true");
    await place.press("Escape");
    await expect(place).toHaveAttribute("aria-expanded", "false");
    await place.click();
    await expect(place).toHaveAttribute("aria-expanded", "true");
  });

  test("reads a sentence typed in the header pill as removable filters", async ({ page }) => {
    await page.goto(`/fr/recherche?q=${WORD}`);
    const pill = page.getByRole("banner").getByRole("search");
    // Under load the first keystrokes can land before hydration resets the field: retry until the search runs.
    await expect(async () => {
      await pill.locator("#header-search").fill(`vélo moins de 3000 dh pas cher à côté ${WORD}`);
      await pill.locator("#header-search").press("Enter");
      await expect(page).toHaveURL(/q=v%C3%A9lo\+moins/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const understood = results(page).getByTestId("understood");
    await expect(understood.getByRole("link", { name: "Retirer « Vélos »" })).toBeVisible();
    await expect(understood.getByRole("link", { name: /Retirer « Jusqu.à 3.000 DH »/ })).toBeVisible();
    await expect(understood.getByRole("link", { name: "Retirer « Les moins chers d'abord »" })).toBeVisible();
    await expect(understood.getByRole("button", { name: "Utiliser ma position" })).toBeVisible();
    // The sentence stays in the URL and the pill; the words left are searched.
    await expect(page).toHaveURL(/q=v%C3%A9lo\+moins/);
    await expect(pill.locator("#header-search")).toHaveValue(`vélo moins de 3000 dh pas cher à côté ${WORD}`);
    await expect(results(page).getByTestId("search-count")).toHaveText("1 annonce");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

    // Removing one: the other filters stay, the words are no longer interpreted.
    await understood.getByRole("link", { name: /Jusqu.à 3.000 DH/ }).click();
    await expect(page).toHaveURL(/brut=1/);
    await expect(page).not.toHaveURL(/prix-max/);
    await expect(page).toHaveURL(/sous-categorie=velos/);
    await expect(results(page).getByTestId("understood")).toHaveCount(0);
    await expect(results(page).getByTestId("search-count")).toHaveText("1 annonce");
  });

  test("turns « à côté » into a small zone around the visitor after a click only", async ({ page, context }) => {
    await context.grantPermissions(["geolocation"]);
    await context.setGeolocation({ latitude: 33.59921, longitude: -7.62004 });
    await page.goto(`/fr/recherche?q=${encodeURIComponent(`vélo à côté ${WORD}`)}`);
    await expect(page).not.toHaveURL(/zone=/);
    // The button acts once hydrated: retry the click until the zone lands in the URL.
    await expect(async () => {
      await results(page).getByTestId("near-me").click();
      await expect(page).toHaveURL(/zone=33\.599%2C-7\.62%2C3/, { timeout: 2_000 });
    }).toPass({ timeout: 15_000 });
    const understood = results(page).getByTestId("understood");
    await expect(understood.getByRole("link", { name: "Retirer « À 3 km de vous »" })).toBeVisible();
    await expect(results(page).getByTestId("search-count")).toHaveText("1 annonce");
    // « Chercher le texte exact »: the whole sentence as words, nothing interpreted.
    await understood.getByTestId("search-exact").click();
    await expect(page).toHaveURL(/brut=1/);
    await expect(results(page).getByTestId("understood")).toHaveCount(0);
  });

  test("reads right to left in Arabic", { tag: "@mobile" }, async ({ page }) => {
    await page.goto(`/ar/recherche?q=${WORD}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    // By role: the copy React streams in a hidden container before swapping it in is not counted.
    await expect(page.getByRole("region", { name: "النتائج" }).getByTestId("results-grid")).toBeVisible();
  });
});

test.describe("category landing pages", () => {
  test("renders /c/vehicules with breadcrumb data, cacheable, without cookies", async ({ page }) => {
    const violations = await watchCsp(page);
    const response = await page.goto("/fr/c/vehicules");
    expect(response?.status()).toBe(200);
    expect(response?.headers()["set-cookie"]).toBeUndefined();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    const blocks = await page.locator('script[type="application/ld+json"]').allTextContents();
    expect(blocks.some((block) => block.includes('"BreadcrumbList"'))).toBe(true);
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", /\/fr\/c\/vehicules$/);
    expect(violations).toEqual([]);
  });

  test("drops query strings with a permanent redirect and answers 404 for unknown segments", async ({ request }) => {
    const redirected = await request.get("/fr/c/vehicules?x=1", { maxRedirects: 0 });
    expect(redirected.status()).toBe(308);
    expect(redirected.headers()["location"]).toMatch(/\/fr\/c\/vehicules$/);
    expect((await request.get("/fr/c/inconnu")).status()).toBe(404);
    expect((await request.get("/fr/c/vehicules/velos/nulle-part")).status()).toBe(404);
  });

  test("links the listing breadcrumb to the landing pages", async ({ page }) => {
    await page.goto(`/fr/annonce/${listings.bike.slugId}`);
    const breadcrumb = page.getByRole("navigation", { name: /fil d'ariane/i });
    await expect(breadcrumb.getByRole("link", { name: "Véhicules" })).toHaveAttribute("href", "/fr/c/vehicules");
  });
});

test.describe("home and crawler files", () => {
  test("shows the category grid and the recent listings", async ({ page }) => {
    await page.goto("/fr");
    await expect(page.getByTestId("home-categories").getByRole("link")).toHaveCount(12);
    await expect(page.getByTestId("home-categories").getByRole("link").first()).toHaveAttribute("href", /\/fr\/c\//);
  });

  test("falls back to the list page without a basemap: no map, no switch, one row of categories", { tag: "@mobile" }, async ({ page }) => {
    await page.goto("/fr");
    await expect(page.locator("[data-search-root]")).toHaveAttribute("data-search-view", "list");
    await expect(page.locator("[data-search-root]")).toHaveAttribute("data-search-enhanced", "");
    await expect(page.getByTestId("search-stage")).toHaveCount(0);
    await expect(page.getByTestId("view-toggle")).toHaveCount(0);
    // The header's chip row steps aside: the page shows the twelve categories itself (lot 3).
    await expect(page.getByTestId("category-chips")).toHaveCount(0);
    await expect(page.getByTestId("home-rent-car")).toBeVisible();
    await expect(page.getByTestId("panel-legal")).toBeHidden();
    await expect(page.getByRole("contentinfo").last()).toBeVisible();
    await page.goto("/fr/c/vehicules");
    await expect(page.getByTestId("category-chips")).toBeVisible();
  });

  test("keeps sitemaps out of development and disallows everything in robots.txt", async ({ request }) => {
    expect((await request.get("/sitemap.xml")).status()).toBe(404);
    expect(await (await request.get("/robots.txt")).text()).toContain("Disallow: /");
  });
});

test.describe("favorites and saved searches", () => {
  test("a visitor is sent to sign in by the heart", async ({ page }) => {
    await page.goto(`/fr/recherche?q=${WORD}`);
    await results(page).getByTestId("results-grid").getByTestId("favorite-button").first().click();
    await expect(page).toHaveURL(/\/fr\/connexion\?next=/);
  });

  test("a member saves a listing and a search, then finds both in the account", async ({ page, request }) => {
    const email = `e2e-search-${randomFrom(ALPHABET, 10)}@joutiya.test`;
    await signUpAndIn(page, request, email);

    await page.goto(`/fr/recherche?q=${WORD}&categorie=vehicules`);
    const card = results(page).getByTestId("results-grid").getByRole("listitem").filter({ hasText: listings.bike.title });
    const heart = card.getByTestId("favorite-button");
    await expect(heart).toHaveAttribute("aria-pressed", "false");
    await heart.click();
    await expect(heart).toHaveAttribute("aria-pressed", "true");

    await page.getByRole("button", { name: "Sauvegarder la recherche" }).click();
    const dialog = page.getByRole("dialog", { name: "Sauvegarder cette recherche" });
    await dialog.getByRole("button", { name: "Sauvegarder" }).click();
    await expect(dialog).toBeHidden();

    await page.goto("/fr/favoris");
    await expect(page.getByRole("heading", { name: "Mes favoris" })).toBeVisible();
    await expect(page.getByRole("link", { name: new RegExp(listings.bike.title) }).first()).toBeVisible();

    await page.goto("/fr/recherches");
    await expect(page.getByRole("heading", { name: "Mes recherches" })).toBeVisible();
    await expect(page.getByText(WORD).first()).toBeVisible();
  });
});
