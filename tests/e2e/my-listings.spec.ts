import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";
import { isolate } from "../../src/lib/i18n/bidi";
import { stubGoogleScript } from "./gsi-stub";

// The sign-up page renders the Google button (stub client id): never the real script.
test.beforeEach(({ page }) => stubGoogleScript(page));

// "Mes annonces" (phase 3 lot C) against the production build and the Firebase emulators
// (npm run test:e2e): a fresh individual signs up through the UI; a published listing (with its
// photo in the dev media store) and a draft are written straight into the emulator for that
// account (the wizard spec covers the real publish). The owner pauses, resumes and deletes the
// listing from the list: menu, inline action, confirmation dialog, toasts, tabs.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
const BLURHASH = "LEHV6nWB2yk8pyo0adR*.7kCMdnj";
/** FsObjectStore layout of the dev media bucket (src/lib/storage/fs.ts, keys.ts). */
const MEDIA_ROOT = path.join(os.tmpdir(), "joutiya-dev-storage", "joutiya-dev-media");

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

interface DevMail {
  template: string;
  data: { actionUrl?: string } & Record<string, unknown>;
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
  // Hydrated first: a consent ticked earlier is unticked when the form registers its fields.
  await page.goto("/fr/inscription", { waitUntil: "networkidle" });
  await page.getByLabel("Nom affiché").fill("Youssef Test");
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

async function storePhoto(listingId: string, photoId: string): Promise<{ w: number; h: number }> {
  const variants = { l: { width: 1600, height: 1200 }, s: { width: 480, height: 360 } } as const;
  for (const [variant, size] of Object.entries(variants)) {
    const key = ["listings", listingId, `${photoId}-${variant}.webp`];
    const body = await sharp({ create: { ...size, channels: 3, background: { r: 34, g: 94, b: 74 } } })
      .webp({ quality: 75 })
      .toBuffer();
    const objectPath = path.join(MEDIA_ROOT, "objects", ...key);
    const metaPath = `${path.join(MEDIA_ROOT, "meta", ...key)}.json`;
    await Promise.all([mkdir(path.dirname(objectPath), { recursive: true }), mkdir(path.dirname(metaPath), { recursive: true })]);
    await writeFile(objectPath, body);
    await writeFile(metaPath, JSON.stringify({ contentType: "image/webp", size: body.byteLength, cacheControl: "public, max-age=31536000, immutable", storedAt: new Date().toISOString() }));
  }
  return { w: variants.l.width, h: variants.l.height };
}

interface Owner {
  uid: string;
  publicId: string;
  displayName: string;
}

/** A published listing (one photo, 60 days left) and an untitled-free draft for the signed-in owner. */
async function seedListings(owner: Owner): Promise<{ published: { id: string; title: string }; draft: { id: string; title: string } }> {
  const firestore = getFirestore(firebase());
  const now = new Date();
  const base = {
    ownerUid: owner.uid,
    sellerType: "individual",
    sellerName: owner.displayName,
    sellerPublicId: owner.publicId,
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "very_good",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
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

  const publishedId = randomId(8);
  const published = { id: publishedId, title: `Vélo de ville ${publishedId}` };
  const photoId = `e2ephoto${randomId(8)}`;
  const size = await storePhoto(publishedId, photoId);
  await firestore
    .collection("listings")
    .doc(publishedId)
    .set({
      ...base,
      status: "published",
      slugId: `velo-de-ville-casablanca-${publishedId}`,
      title: published.title,
      description: "Vélo de ville révisé, pneus neufs, freins réglés. Idéal pour la ville.",
      photos: [{ id: photoId, ...size, blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });

  const draftId = randomId(8);
  const draft = { id: draftId, title: `Casque vélo ${draftId}` };
  await firestore
    .collection("listings")
    .doc(draftId)
    .set({ ...base, status: "draft", title: draft.title, description: "", photos: [], adsEligible: false, updatedAt: new Date(now.getTime() - 60_000) });
  return { published, draft };
}

test.describe("my listings", () => {
  test.setTimeout(120_000);

  test("pauses, resumes and deletes a listing, with toasts, a confirmation and keyboard tabs", async ({ page, request }) => {
    const email = `e2e-mine-${Date.now().toString(36)}${randomId(4)}@test.joutiya.ma`;
    await signUpAndIn(page, request, email);
    const me = (await (await page.request.get("/api/auth/me")).json()) as { session: Owner | null };
    expect(me.session?.uid).toBeTruthy();
    const { published, draft } = await seedListings(me.session!);

    await page.goto("/fr/mes-annonces");
    await expect(page.getByRole("heading", { level: 1, name: "Mes annonces" })).toBeVisible();
    await expect(page.getByRole("tab", { name: /En ligne/ })).toHaveAttribute("aria-selected", "true");
    const row = page.getByRole("listitem").filter({ has: page.getByRole("link", { name: published.title }) });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText("En ligne", { exact: true })).toBeVisible();

    // Pause from the row menu: the toast confirms, the row shows the new status at once.
    await page.getByRole("button", { name: `Actions pour « ${isolate(published.title)} »` }).click();
    await page.getByRole("menuitem", { name: "Mettre en pause" }).click();
    await expect(page.getByText("Annonce mise en pause")).toBeVisible();
    await expect(row.getByText("En pause", { exact: true })).toBeVisible();

    // Resume with the row's own button (a paused listing puts it forward).
    await row.getByRole("button", { name: `Remettre en ligne « ${isolate(published.title)} »` }).click();
    await expect(page.getByText("Annonce remise en ligne")).toBeVisible();
    await expect(row.getByText("En ligne", { exact: true })).toBeVisible();

    // Delete: a confirmation dialog first; cancelling keeps the listing.
    await page.getByRole("button", { name: `Actions pour « ${isolate(published.title)} »` }).click();
    await page.getByRole("menuitem", { name: "Supprimer" }).click();
    const dialog = page.getByRole("alertdialog", { name: "Supprimer cette annonce ?" }).or(page.getByRole("dialog", { name: "Supprimer cette annonce ?" }));
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Annuler" }).click();
    await expect(dialog).toBeHidden();
    await expect(row).toBeVisible();

    await page.getByRole("button", { name: `Actions pour « ${isolate(published.title)} »` }).click();
    await page.getByRole("menuitem", { name: "Supprimer" }).click();
    await dialog.getByRole("button", { name: "Supprimer l'annonce" }).click();
    await expect(page.getByText("Annonce supprimée")).toBeVisible();
    await expect(row).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Aucune annonce en ligne" })).toBeVisible();

    // Tabs follow the arrow keys; a deleted listing does not come back under "Terminées".
    await page.getByRole("tab", { name: /En ligne/ }).focus();
    await page.keyboard.press("ArrowRight");
    await expect(page.getByRole("tab", { name: /En vérification/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab", { name: /En vérification/ })).toBeFocused();
    await page.keyboard.press("End");
    await expect(page.getByRole("tab", { name: /Terminées/ })).toHaveAttribute("aria-selected", "true");
    await expect(page).toHaveURL(/onglet=ended/);
    await expect(page.getByRole("heading", { name: "Aucune annonce terminée" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(published.title)).toHaveCount(0);

    // The draft waits under "Brouillons" with its "Reprendre" button into the wizard.
    await page.getByRole("tab", { name: /Brouillons/ }).click();
    await expect(page.getByText("1 brouillon sur 5 possibles")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("link", { name: `Reprendre « ${isolate(draft.title)} »` })).toHaveAttribute("href", `/fr/deposer/${draft.id}`);

    // The server agrees: the deleted listing is no longer the owner's to edit.
    const gone = await page.request.get(`/api/listings/${published.id}`);
    expect([200, 404]).toContain(gone.status());
    if (gone.status() === 200) expect(((await gone.json()) as { listing: { status: string } }).listing.status).toBe("removed");
  });
});

test.describe("my listings on a phone", { tag: "@mobile" }, () => {
  test.setTimeout(120_000);
  // Mobile project only, at the narrowest common width (Pixel 7 is 412 px wide).
  test.skip(({ isMobile }) => !isMobile, "phone layout");
  test.use({ viewport: { width: 360, height: 780 } });

  test("never scrolls sideways, and a link to the last tab shows it in full", async ({ page, request }) => {
    const email = `e2e-mine-phone-${Date.now().toString(36)}${randomId(4)}@test.joutiya.ma`;
    await signUpAndIn(page, request, email);
    const me = (await (await page.request.get("/api/auth/me")).json()) as { session: Owner | null };
    expect(me.session?.uid).toBeTruthy();
    const { draft } = await seedListings(me.session!);

    await page.goto("/fr/mes-annonces?onglet=ended");
    const ended = page.getByRole("tab", { name: /Terminées/ });
    await expect(ended).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("heading", { name: "Aucune annonce terminée" })).toBeVisible({ timeout: 15_000 });
    // Measured once the strip has settled (a late font swap widens the tabs, then the tab is revealed again).
    await expect(async () => {
      const strip = (await page.getByRole("tablist").boundingBox())!;
      const tab = (await ended.boundingBox())!;
      expect(tab.x).toBeGreaterThanOrEqual(strip.x);
      expect(tab.x + tab.width).toBeLessThanOrEqual(strip.x + strip.width);
    }).toPass({ timeout: 5_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.getByRole("tab", { name: /Brouillons/ }).click();
    await expect(page.getByRole("link", { name: `Reprendre « ${isolate(draft.title)} »` })).toBeVisible({ timeout: 15_000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
