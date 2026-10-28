import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";
import { isolate } from "../../src/lib/i18n/bidi";

// Public listing page and seller profile (phase 3 lot D2) against the production build and the
// Firebase emulators (npm run test:e2e). The fixtures are written straight into the emulator (a
// seller, a published listing with two photos, a sold one) and the photos into the development
// object store the server reads (FsObjectStore, D11: os.tmpdir()/joutiya-dev-storage, media bucket
// served publicly by /api/dev/storage). The wizard spec covers the real upload and publish flow.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from({ length }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
/** Title of the segment error view (messages/fr.json Error.title). */
const ERROR_TITLE = "La page n'a pas pu s'afficher";
/** Valid blurhash (the one from the blurhash README). */
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
/** FsObjectStore layout of the dev media bucket (src/lib/storage/fs.ts, keys.ts). */
const MEDIA_ROOT = path.join(os.tmpdir(), "joutiya-dev-storage", "joutiya-dev-media");

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

interface Fixture {
  publicId: string;
  name: string;
  published: { id: string; slugId: string; title: string };
  sold: { id: string; slugId: string; title: string };
}

/** Writes both WebP variants of a photo where the dev storage route serves them. */
async function storePhoto(listingId: string, photoId: string, color: { r: number; g: number; b: number }): Promise<{ w: number; h: number }> {
  const variants = { l: { width: 1600, height: 1200 }, s: { width: 480, height: 360 } } as const;
  for (const [variant, size] of Object.entries(variants)) {
    const key = ["listings", listingId, `${photoId}-${variant}.webp`];
    const body = await sharp({ create: { ...size, channels: 3, background: color } }).webp({ quality: 75 }).toBuffer();
    const objectPath = path.join(MEDIA_ROOT, "objects", ...key);
    const metaPath = `${path.join(MEDIA_ROOT, "meta", ...key)}.json`;
    await Promise.all([mkdir(path.dirname(objectPath), { recursive: true }), mkdir(path.dirname(metaPath), { recursive: true })]);
    await writeFile(objectPath, body);
    await writeFile(metaPath, JSON.stringify({ contentType: "image/webp", size: body.byteLength, cacheControl: "public, max-age=31536000, immutable", storedAt: new Date().toISOString() }));
  }
  return { w: variants.l.width, h: variants.l.height };
}

function listingDoc(input: { uid: string; publicId: string; name: string; slugId: string; title: string; status: "published" | "sold"; photos: unknown[] }) {
  const now = new Date();
  return {
    ownerUid: input.uid,
    sellerType: "individual",
    sellerName: input.name,
    sellerPublicId: input.publicId,
    status: input.status,
    slugId: input.slugId,
    title: input.title,
    description: "Vélo de ville révisé, pneus neufs.\n\nÀ voir à Casablanca, quartier Maârif.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "very_good",
    price: 1500,
    priceNegotiable: true,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: input.photos,
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
  };
}

async function seed(): Promise<Fixture> {
  const firestore = getFirestore(firebase());
  const uid = `e2e-seller-${randomId(12)}`;
  const publicId = randomId(10);
  const name = "Salma Test";
  const now = new Date();
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: name,
    type: "individual",
    citySlug: "casablanca",
    storefront: { bio: "Vélos révisés et accessoires.\nRencontre à Casablanca le week-end.", bannerKey: "arcades" },
    badges: { emailVerified: true, phoneVerified: true, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: new Date("2025-10-05T12:00:00.000Z"),
    updatedAt: now,
  });

  const publishedId = randomId(8);
  const published = { id: publishedId, slugId: `velo-de-ville-casablanca-${publishedId}`, title: "Vélo de ville" };
  const photos = [];
  for (const [index, color] of [{ r: 196, g: 120, b: 52 }, { r: 34, g: 94, b: 74 }].entries()) {
    const photoId = `e2ephoto${index}${randomId(6)}`;
    photos.push({ id: photoId, ...(await storePhoto(publishedId, photoId, color)), blurhash: BLURHASH });
  }
  await firestore.collection("listings").doc(publishedId).set(listingDoc({ uid, publicId, name, ...published, status: "published", photos }));

  const soldId = randomId(8);
  const sold = { id: soldId, slugId: `casque-velo-casablanca-${soldId}`, title: "Casque vélo" };
  await firestore.collection("listings").doc(soldId).set(listingDoc({ uid, publicId, name, ...sold, status: "sold", photos: [] }));
  return { publicId, name, published, sold };
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

let fixture: Fixture;

test.beforeAll(async () => {
  fixture = await seed();
});

test.describe("listing page", () => {
  test("renders the listing under a hash CSP, without violations, with its photos, criteria, seller and map", { tag: "@mobile" }, async ({ page }) => {
    const violations = await watchCsp(page);
    const { slugId, title } = fixture.published;
    const response = await page.goto(`/fr/annonce/${slugId}`);
    expect(response?.status()).toBe(200);

    const csp = response!.headers()["content-security-policy"] ?? "";
    const scriptSrc = csp.split(";").find((directive) => directive.trim().startsWith("script-src")) ?? "";
    expect(scriptSrc).toContain("'sha256-");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(response!.headers()["set-cookie"]).toBeUndefined();

    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByTestId("price-tag").first()).toHaveText(/1\s500\sDH/);
    await expect(page.getByText("Négociable").first()).toBeVisible();
    await expect(page.getByText("Casablanca, Casablanca-Settat", { exact: true })).toBeVisible();
    await expect(page.getByTestId("criteria-grid")).toContainText("Très bon état");
    await expect(page.getByTestId("listing-description")).toContainText("pneus neufs.");
    await expect(page.getByRole("navigation", { name: "Fil d'Ariane" })).toContainText("Vélos");

    // Gallery: the first photo is the LCP image and actually loads from the media host. The title is
    // bidi-isolated inside the translated alt text.
    const first = page.getByRole("img", { name: `${isolate(title)}, photo 1 sur 2` });
    await expect(first).toHaveAttribute("fetchpriority", "high");
    await expect.poll(() => first.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
    await expect(page.getByRole("img", { name: `${isolate(title)}, photo 2 sur 2` })).toHaveAttribute("loading", "lazy");
    await expect(page.getByTestId("gallery-counter")).toHaveText("1 / 2");

    const seller = page.getByTestId("seller-card");
    await expect(seller).toContainText(fixture.name);
    await expect(seller).toContainText("Membre depuis octobre 2025");
    await expect(seller).toContainText("Téléphone vérifié");
    await expect(seller.getByRole("link", { name: fixture.name })).toHaveAttribute("href", `/fr/profil/${fixture.publicId}`);

    const map = page.getByTestId("static-map");
    await expect(map).toBeVisible();
    await expect(map).toContainText("OpenStreetMap");
    await expect(page.getByTestId("safety-tips")).toBeVisible();
    await expect(page.getByRole("button", { name: "Signaler l'annonce" })).toBeVisible();

    await page.waitForLoadState("networkidle");
    expect(violations).toEqual([]);
  });

  test("publishes Product structured data without any contact data", async ({ page }) => {
    await page.goto(`/fr/annonce/${fixture.published.slugId}`);
    // Product first, then the breadcrumb trail (phase 4).
    const blocks = page.locator('script[type="application/ld+json"]');
    await expect(blocks).toHaveCount(2);
    const block = await blocks.first().textContent();
    const data = JSON.parse(block ?? "{}") as { "@type": string; offers: Record<string, string>; image: string[] };
    expect(JSON.parse((await blocks.nth(1).textContent()) ?? "{}")).toMatchObject({ "@type": "BreadcrumbList" });
    expect(data["@type"]).toBe("Product");
    expect(data.offers).toMatchObject({ price: "1500", priceCurrency: "MAD", availability: "https://schema.org/InStock" });
    expect(data.image).toHaveLength(2);
    expect(block).not.toContain(fixture.name);
    expect(block).not.toContain("+212");
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute("href", `https://joutiya.ma/fr/annonce/${fixture.published.slugId}`);
    await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /-l\.webp$/);
  });

  test("opens the photos full screen, moves with the arrow keys and closes with Escape on the photo shown", async ({ page }) => {
    await page.goto(`/fr/annonce/${fixture.published.slugId}`);
    await page.getByRole("button", { name: "Agrandir la photo" }).first().click();
    const dialog = page.getByRole("dialog", { name: fixture.published.title });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("Photo 1 sur 2");
    // The counter follows the track (its scroll listener attaches once the portal has mounted).
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Photo 2 sur 2");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("Photo 2 sur 2");
    await page.keyboard.press("ArrowLeft");
    await expect(dialog).toContainText("Photo 1 sur 2");
    await page.keyboard.press("End");
    await expect(dialog).toContainText("Photo 2 sur 2");
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    // The page gallery resumes on the photo the lightbox was closed on.
    await expect(page.getByTestId("gallery-counter")).toHaveText("2 / 2");
  });

  test("keeps the listing on screen when the full-screen view cannot be downloaded (tab older than a redeploy, dropped connection)", async ({ page }) => {
    await page.goto(`/fr/annonce/${fixture.published.slugId}`);
    // Hydrated: the client-only spacer of the phone contact bar is in the page.
    await expect(page.getByTestId("contact-bar-spacer")).toBeAttached();
    const chunks: string[] = [];
    await page.route("**/_next/static/chunks/**", (route) => {
      chunks.push(route.request().url());
      return route.abort("internetdisconnected");
    });
    await page.getByRole("button", { name: "Agrandir la photo" }).first().click();
    // The lightbox chunk was asked for (warm-up on hover, loader, the stand-in's retry) and failed:
    // a reload prompt under the gallery instead of the error view.
    await expect(page.getByTestId("lightbox-unavailable")).toContainText("Le plein écran n'a pas pu se charger.", { timeout: 15_000 });
    expect(chunks.length).toBeGreaterThan(0);
    await expect(page.getByTestId("lightbox-unavailable").getByRole("button", { name: "Recharger la page" })).toBeVisible();
    // Still the listing, still interactive: the gallery moves on.
    await page.getByRole("button", { name: "Photo suivante" }).click();
    await expect(page.getByTestId("gallery-counter")).toHaveText("2 / 2");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("heading", { level: 1, name: fixture.published.title })).toBeVisible();
    await expect(page.getByRole("heading", { name: ERROR_TITLE })).toHaveCount(0);
  });

  test("mirrors the arrow keys in Arabic", async ({ page }) => {
    await page.goto(`/ar/annonce/${fixture.published.slugId}`);
    await page.getByRole("button", { name: "تكبير الصورة" }).first().click();
    const dialog = page.getByRole("dialog", { name: fixture.published.title });
    await expect(dialog).toContainText("الصورة 1 من 2");
    // Right to left: the next photo is on the left.
    await page.keyboard.press("ArrowLeft");
    await expect(dialog).toContainText("الصورة 2 من 2");
    await page.keyboard.press("ArrowRight");
    await expect(dialog).toContainText("الصورة 1 من 2");
  });

  test("Tarifit: the French fallback, numbers and plurals formatted in French on the server and in the browser", async ({ page }) => {
    await page.goto(`/rif/annonce/${fixture.published.slugId}`);
    await expect(page.getByRole("heading", { level: 1, name: fixture.published.title })).toBeVisible();
    // Server component (seller card) and client island (gallery), both through useNumbersTranslations.
    await expect(page.getByTestId("seller-card")).toContainText(/\d+ annonces? en ligne/);
    await expect(page.getByTestId("gallery")).toHaveAttribute("aria-label", "Photos de l'annonce, 2 photos");
    await page.getByRole("button", { name: "Agrandir la photo" }).first().click();
    await expect(page.getByRole("dialog", { name: fixture.published.title })).toContainText("Photo 1 sur 2");
    await expect(page.getByRole("heading", { name: ERROR_TITLE })).toHaveCount(0);
  });

  test("sends an anonymous visitor to sign-in before messaging or showing the number, then back here", async ({ page }) => {
    const { slugId } = fixture.published;
    await page.goto(`/fr/annonce/${slugId}`);
    const contact = page.getByTestId("contact-bar");
    const next = `/fr/connexion?next=${encodeURIComponent(`/fr/annonce/${slugId}`)}`;
    await contact.getByRole("button", { name: "Envoyer un message" }).click();
    // The seller card's copy (the phone bar's is hidden at this width).
    await expect(contact.getByText("Connectez-vous pour écrire au vendeur.", { exact: false }).first()).toBeVisible();
    await expect(contact.getByRole("link", { name: "Se connecter" })).toHaveAttribute("href", next);
    await expect(page.getByTestId("message-dialog")).toHaveCount(0);
    await contact.getByRole("button", { name: "Voir le numéro" }).click();
    const signIn = contact.getByRole("link", { name: "Se connecter" });
    await expect(signIn).toBeVisible();
    await expect(signIn).toHaveAttribute("href", next);
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
  });

  test("redirects an outdated slug to the canonical URL permanently", async ({ request }) => {
    const { id, slugId } = fixture.published;
    for (const segment of [`ancien-titre-${id}`, id]) {
      const response = await request.get(`/fr/annonce/${segment}`, { maxRedirects: 0 });
      expect([301, 308]).toContain(response.status());
      expect(new URL(response.headers()["location"] ?? "", "http://localhost").pathname).toBe(`/fr/annonce/${slugId}`);
    }
  });

  test("answers 404 for an unknown or malformed listing", async ({ request }) => {
    expect((await request.get(`/fr/annonce/inconnue-${randomId(8)}`)).status()).toBe(404);
    expect((await request.get("/fr/annonce/pas-une-annonce")).status()).toBe(404);
  });

  test("keeps a sold listing readable, with a banner and no contact action", async ({ page }) => {
    const response = await page.goto(`/fr/annonce/${fixture.sold.slugId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("status").filter({ hasText: "Article vendu" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Voir le numéro" })).toHaveCount(0);
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  });

  test("reads right to left in Arabic with the Arabic currency", { tag: "@mobile" }, async ({ page }) => {
    await page.goto(`/ar/annonce/${fixture.published.slugId}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.getByTestId("price-tag").first()).toContainText("درهم");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(fixture.published.title);
  });
});

test.describe("listing page on a phone", { tag: "@mobile" }, () => {
  // Mobile project only, at the narrowest common width (Pixel 7 is 412 px wide).
  test.skip(({ isMobile }) => !isMobile, "phone layout");
  test.use({ viewport: { width: 360, height: 780 } });

  test("keeps the contact actions in a bar at the bottom and never scrolls sideways", async ({ page }) => {
    await page.goto(`/fr/annonce/${fixture.published.slugId}`);
    const reveal = page.getByTestId("contact-bar").getByRole("button", { name: "Voir le numéro" });
    await expect(reveal).toBeVisible();
    const box = await reveal.boundingBox();
    expect(box!.y + box!.height).toBeGreaterThan(780 - 120);
    expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("seller profile", () => {
  test("shows the seller and their published listings only", async ({ page }) => {
    const response = await page.goto(`/fr/profil/${fixture.publicId}`);
    expect(response?.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1 })).toContainText(fixture.name);
    await expect(page.getByTestId("profile-header")).toContainText("Membre depuis octobre 2025");
    await expect(page.getByRole("heading", { level: 2, name: "1 annonce en ligne" })).toBeVisible();
    // Storefront (vitrine-avis §1): the chosen house banner and the "about" text.
    await expect(page.getByTestId("storefront-banner")).toHaveAttribute("data-banner", "arcades");
    await expect(page.getByRole("heading", { level: 2, name: "À propos" })).toBeVisible();
    await expect(page.getByText("Rencontre à Casablanca le week-end.")).toBeVisible();
    const cards = page.getByTestId("listing-card");
    await expect(cards).toHaveCount(1);
    await expect(page.getByText(fixture.sold.title)).toHaveCount(0);
    await cards.getByRole("link", { name: fixture.published.title }).click();
    await expect(page).toHaveURL(new RegExp(`/fr/annonce/${fixture.published.slugId}$`));
  });

  test("answers 404 for an unknown profile", async ({ request }) => {
    expect((await request.get(`/fr/profil/${randomId(10)}`)).status()).toBe(404);
  });
});
