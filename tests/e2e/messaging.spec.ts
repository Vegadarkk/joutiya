import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";
import { isolate } from "../../src/lib/i18n/bidi";

// Messaging (phase 5 lot U1) against the production build and the Firebase emulators
// (npm run test:e2e): two fresh accounts sign up through the UI; a published listing is written
// straight into the emulator for the seller. The buyer writes from the listing page (dialog,
// Turnstile test key) and lands in the thread; the seller finds it in /messages and answers; the
// buyer's open thread shows the answer without a reload. No Valkey here, so the live stream answers
// 503 and the thread falls back to polling (POLL_MS): the stream itself is covered by unit tests.
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

async function signUpAndIn(page: Page, request: APIRequestContext, email: string, name: string): Promise<void> {
  await page.goto("/fr/inscription");
  await page.getByLabel("Nom affiché").fill(name);
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
    const body = await sharp({ create: { ...size, channels: 3, background: { r: 192, g: 88, b: 44 } } })
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

interface Member {
  uid: string;
  publicId: string;
  displayName: string;
}

/** A published listing of `owner` (one photo, messaging only: no phone, no WhatsApp). */
async function seedListing(owner: Member, overrides: Record<string, unknown> = {}): Promise<{ id: string; slugId: string; title: string }> {
  const now = new Date();
  const id = randomId(8);
  const title = `Tapis berbère ${id}`;
  const slugId = `tapis-berbere-casablanca-${id}`;
  const photoId = `e2ephoto${randomId(8)}`;
  const size = await storePhoto(id, photoId);
  await getFirestore(firebase())
    .collection("listings")
    .doc(id)
    .set({
      ownerUid: owner.uid,
      sellerType: "individual",
      sellerName: owner.displayName,
      sellerPublicId: owner.publicId,
      categoryId: "maison-jardin",
      subcategoryId: "decoration-artisanat",
      attributes: { "decor-type": "tapis" },
      condition: "very_good",
      price: 2400,
      priceNegotiable: true,
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
      status: "published",
      slugId,
      title,
      description: "Tapis berbère tissé main, laine naturelle, 2 m sur 3 m. Très bon état.",
      photos: [{ id: photoId, ...size, blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
      ...overrides,
    });
  return { id, slugId, title };
}

async function session(page: Page): Promise<Member> {
  const me = (await (await page.request.get("/api/auth/me")).json()) as { session: Member | null };
  expect(me.session?.uid).toBeTruthy();
  return me.session!;
}

test.describe("messaging", () => {
  test.setTimeout(180_000);

  test("the buyer writes from the listing, the seller answers from /messages, the buyer sees it without reloading", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const buyerPage = await buyerContext.newPage();
    const errors: string[] = [];
    for (const page of [sellerPage, buyerPage]) page.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-seller-${stamp}@test.joutiya.ma`, "Salma Vendeuse");
    await signUpAndIn(buyerPage, request, `e2e-buyer-${stamp}@test.joutiya.ma`, "Youssef Acheteur");
    const seller = await session(sellerPage);
    const listing = await seedListing(seller);

    // Buyer: the message button opens the first-message dialog (no phone actions on this listing).
    await buyerPage.goto(`/fr/annonce/${listing.slugId}`);
    const contact = buyerPage.getByTestId("contact-bar");
    await expect(contact.getByRole("button", { name: "Voir le numéro" })).toHaveCount(0);
    await contact.getByRole("button", { name: "Envoyer un message" }).click();
    const dialog = buyerPage.getByRole("dialog", { name: `Écrire à ${isolate(seller.displayName)}` });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    const first = `Bonjour, le tapis est-il toujours disponible ? ${stamp}`;
    await dialog.getByLabel("Votre message").fill(first);
    await expect(dialog.locator("[data-turnstile]")).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
    await dialog.getByRole("button", { name: "Envoyer le message" }).click();

    // The buyer lands in the new conversation.
    await expect(buyerPage).toHaveURL(/\/fr\/messages\/[A-Za-z0-9_-]{22}$/, { timeout: 20_000 });
    const cid = new URL(buyerPage.url()).pathname.split("/").at(-1)!;
    await expect(buyerPage.getByTestId("thread-counterpart")).toHaveText(seller.displayName);
    await expect(buyerPage.getByTestId("thread").getByText(first)).toBeVisible();

    // Seller: the conversation is in the inbox, unread, with the badge in the header.
    await sellerPage.goto("/fr/messages");
    await expect(sellerPage.getByRole("heading", { level: 1, name: "Messages" })).toBeVisible();
    const row = sellerPage.getByTestId("conversation-row").filter({ hasText: "Youssef Acheteur" });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-unread", "1");
    await expect(row).toContainText(listing.title);
    await expect(row).toContainText(first);
    await expect(sellerPage.getByTestId("messages-link")).toHaveAttribute("data-unread", "1", { timeout: 15_000 });

    // Opening it reads it: the row and the badge go back to zero.
    await row.click();
    await expect(sellerPage).toHaveURL(new RegExp(`/fr/messages/${cid}$`));
    await expect(sellerPage.getByTestId("thread").getByText(first)).toBeVisible({ timeout: 15_000 });
    await expect(row).toHaveAttribute("data-unread", "0", { timeout: 15_000 });
    await expect(sellerPage.getByTestId("messages-link")).toHaveAttribute("data-unread", "0", { timeout: 15_000 });

    // The seller answers.
    const reply = `Oui, il est disponible. Vous pouvez passer samedi. ${stamp}`;
    await sellerPage.getByTestId("composer").getByLabel("Votre message").fill(reply);
    await sellerPage.getByTestId("composer").getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(sellerPage.getByTestId("thread").getByText(reply)).toBeVisible({ timeout: 15_000 });
    await expect(sellerPage.getByTestId("composer").getByLabel("Votre message")).toHaveValue("");

    // The buyer's open thread shows the answer, with no reload.
    await expect(buyerPage.getByTestId("thread").getByText(reply)).toBeVisible({ timeout: 40_000 });
    const incoming = buyerPage.getByTestId("message").filter({ hasText: reply });
    await expect(incoming).toHaveAttribute("data-mine", "false");

    // On a phone the list fills the screen without scrolling sideways; a thread shows alone.
    await sellerPage.setViewportSize({ width: 360, height: 780 });
    await sellerPage.goto("/fr/messages");
    await expect(row).toBeVisible({ timeout: 15_000 });
    const box = (await row.boundingBox())!;
    expect(box.x + box.width).toBeLessThanOrEqual(360);
    expect(await sellerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await row.click();
    await expect(sellerPage.getByTestId("thread-view")).toBeVisible({ timeout: 15_000 });
    await expect(row).toBeHidden();
    await sellerPage.getByRole("link", { name: "Toutes les conversations" }).click();
    await expect(row).toBeVisible();

    expect(errors).toEqual([]);
    await sellerContext.close();
    await buyerContext.close();
  });

  test("an adults-only listing shows its 18+ notice and asks the buyer's confirmation before the first message", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const buyerPage = await buyerContext.newPage();
    const errors: string[] = [];
    buyerPage.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-artisan-${stamp}@test.joutiya.ma`, "Hassan Artisan");
    await signUpAndIn(buyerPage, request, `e2e-adult-${stamp}@test.joutiya.ma`, "Karim Acheteur");
    const seller = await session(sellerPage);
    const listing = await seedListing(seller, {
      subcategoryId: "koumiyas-decoratives",
      attributes: { material: "cuivre", handmade: true },
      description: "Koumiya de décoration faite à la main par un artisan de Fès, fourreau en cuivre ciselé.",
      moderation: { state: "needs_review", score: 0, flags: ["restricted_category"], openReports: 0, reviewedBy: "admin", reviewedAt: new Date() },
    });

    await buyerPage.goto(`/fr/annonce/${listing.slugId}`);
    await expect(buyerPage.getByTestId("adults-only-notice")).toContainText("Réservé aux personnes majeures.");
    await buyerPage.getByTestId("contact-bar").getByRole("button", { name: "Envoyer un message" }).click();
    const dialog = buyerPage.getByRole("dialog", { name: `Écrire à ${isolate(seller.displayName)}` });
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByLabel("Votre message").fill(`Salam, la koumiya est-elle toujours disponible ? ${stamp}`);
    await expect(dialog.locator("[data-turnstile]")).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
    await dialog.getByRole("button", { name: "Envoyer le message" }).click();
    await expect(dialog.getByText("Confirmez avoir 18 ans ou plus pour écrire au vendeur.")).toBeVisible();
    await expect(buyerPage).toHaveURL(new RegExp(`/fr/annonce/${listing.slugId}$`));

    await dialog.getByRole("checkbox", { name: "Je confirme avoir 18 ans ou plus." }).check();
    await dialog.getByRole("button", { name: "Envoyer le message" }).click();
    await expect(buyerPage).toHaveURL(/\/fr\/messages\/[A-Za-z0-9_-]{22}$/, { timeout: 20_000 });

    expect(errors).toEqual([]);
    await sellerContext.close();
    await buyerContext.close();
  });
});
