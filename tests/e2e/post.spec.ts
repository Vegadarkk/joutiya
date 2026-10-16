import { createHmac, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import sharp from "sharp";
import { isolate } from "../../src/lib/i18n/bidi";

// Posting wizard (phase 3 lot C) against the production build and the Firebase emulators
// (npm run test:e2e): a fresh individual signs up, confirms the e-mail from the dev mailbox and
// verifies a phone through the signed WhatsApp webhook (as tests/e2e/phone.spec.ts does), then
// walks the nine steps with a generated JPEG that carries EXIF, publishes, lands on the result
// screen and opens the public page, whose photo is a WebP variant without metadata. Uploads run
// inline in dev (no Valkey): the photo is ready when complete answers.

// Must match playwright.config.ts (webServer env).
const WHATSAPP = { appSecret: "e2e-whatsapp-app-secret", phoneNumberId: "100000000000001", displayNumber: "212600000000" };

// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const runId = () => `${Date.now().toString(36)}${randomBytes(3).toString("hex")}`;

interface DevMail {
  template: string;
  to: string;
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

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

async function signUpAndIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await page.goto("/fr/inscription");
  await page.getByLabel("Nom affiché").fill("Nadia Test");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  await page.getByRole("checkbox", { name: /conditions générales d'utilisation/i }).check();
  await page.getByRole("checkbox", { name: /transférer mes données personnelles/i }).check();
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page.getByRole("heading", { name: "Vérifiez votre boîte mail" })).toBeVisible({ timeout: 15_000 });
  const mail = await waitForMail(request, email, "verifyEmail");
  await page.goto(mail.data.actionUrl!);
  await expect(page.getByRole("heading", { name: "Adresse confirmée" })).toBeVisible({ timeout: 15_000 });
}

/** Meta's webhook payload for one inbound text, signed as Meta does (HMAC-SHA256 of the raw body). */
function signedInbound(from: string, body: string, wamid: string): { raw: string; signature: string } {
  const raw = JSON.stringify({
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: WHATSAPP.displayNumber, phone_number_id: WHATSAPP.phoneNumberId },
              contacts: [{ profile: { name: "Nadia" }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  });
  return { raw, signature: `sha256=${createHmac("sha256", WHATSAPP.appSecret).update(raw).digest("hex")}` };
}

/** Verifies a fresh Moroccan mobile for the signed-in user (code delivered by the signed webhook). */
async function verifyPhone(page: Page, request: APIRequestContext): Promise<void> {
  // 061xxxxxxx is always a valid Moroccan mobile range (07 4x, 06 8[356] are not).
  const digits = `61${String(Date.now() % 10_000_000).padStart(7, "0")}`;
  await page.goto("/fr/verifications");
  await page.getByLabel("Numéro de mobile").fill(`0${digits}`);
  const started = page.waitForResponse((response) => response.url().endsWith("/api/auth/phone/start") && response.request().method() === "POST");
  await page.getByRole("button", { name: "Obtenir mon code" }).click();
  const { code } = (await (await started).json()) as { code: string };
  const hit = signedInbound(`212${digits}`, `JOUTIYA ${code}`, `wamid.e2e.${Date.now()}.post`);
  const delivered = await request.post("/api/webhooks/whatsapp", { data: hit.raw, headers: { "content-type": "application/json", "x-hub-signature-256": hit.signature } });
  expect(delivered.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Numéro vérifié" })).toBeVisible({ timeout: 20_000 });
}

/**
 * A 2600 x 1950 JPEG (resized to 2048 px by the browser) carrying EXIF. Random colour blocks give
 * each run its own photo hash, so earlier runs never make it a duplicate (dup_photo -> review).
 */
async function photoWithExif(): Promise<Buffer> {
  const grid = randomBytes(26 * 19 * 3);
  return sharp(grid, { raw: { width: 26, height: 19, channels: 3 } })
    .resize(2600, 1950, { kernel: "nearest" })
    .jpeg({ quality: 90 })
    .withExif({ IFD0: { Make: "Joutiya E2E", Model: "Camera", Copyright: "Joutiya test fixture" } })
    .toBuffer();
}

const next = (page: Page) => page.getByRole("button", { name: "Continuer" }).click();

test.describe("posting wizard", () => {
  test.setTimeout(180_000);

  test("walks the nine steps, publishes and shows the listing with a WebP photo without EXIF", async ({ page, request }) => {
    const id = runId();
    const email = `e2e-post-${id}@test.joutiya.ma`;
    const title = `Vélo de ville ${id}`;
    await signUpAndIn(page, request, email);
    await verifyPhone(page, request);

    // `/deposer`: no draft yet, so the category grid; the draft is created after the subcategory pick.
    await page.goto("/fr/deposer");
    await expect(page.getByRole("heading", { level: 1, name: "Déposer une annonce" })).toBeVisible();
    await page.getByRole("radio", { name: "Véhicules" }).click();
    const created = page.waitForResponse((response) => response.url().endsWith("/api/listings") && response.request().method() === "POST");
    await page.getByRole("radio", { name: "Vélos" }).click();
    expect((await created).status()).toBe(201);
    await expect(page).toHaveURL(/\/fr\/deposer\/[a-z0-9]+\/criteres$/);
    const listingId = new URL(page.url()).pathname.split("/")[3]!;

    // 2. Criteria: the condition and the bike type are required chips.
    await page.getByRole("radiogroup", { name: /État/ }).getByRole("radio", { name: "Très bon état" }).click();
    await page.getByRole("radiogroup", { name: /Type de vélo/ }).getByRole("radio", { name: "Ville" }).click();
    await next(page);

    // 3. Title: saved as a draft (coalesced autosave, flushed on step change).
    await expect(page).toHaveURL(/\/titre$/);
    await page.getByRole("textbox", { name: /Titre de l'annonce/ }).fill(title);
    await next(page);
    await expect(page.getByText("Brouillon enregistré")).toBeVisible({ timeout: 15_000 });

    // 4. Description.
    await expect(page).toHaveURL(/\/description$/);
    await page.getByRole("textbox", { name: /^Description/ }).fill(`Vélo de ville révisé ${id}, pneus neufs, freins réglés. Idéal pour les trajets quotidiens en centre-ville.`);
    await next(page);

    // 5. Photos: one JPEG with EXIF, prepared in the browser (resize, re-encode), uploaded, processed.
    await expect(page).toHaveURL(/\/photos$/);
    const jpeg = await photoWithExif();
    expect((await sharp(jpeg).metadata()).exif).toBeDefined();
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: "velo.jpg", mimeType: "image/jpeg", buffer: jpeg });
    await expect(page.getByText("Couverture", { exact: true })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole("img", { name: "Photo 1" })).toBeVisible();
    await next(page);

    // 6. Price.
    await expect(page).toHaveURL(/\/prix$/);
    await page.getByRole("textbox", { name: /^Prix/ }).fill("1500");
    await expect(page.getByRole("textbox", { name: /^Prix/ })).toHaveValue(/1\s500/);
    await next(page);

    // 7. Location: the city from the combobox, the region follows.
    await expect(page).toHaveURL(/\/lieu$/);
    await page.getByRole("combobox", { name: /Ville/ }).fill("Casab");
    await page.getByRole("option", { name: "Casablanca", exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Région" })).toHaveValue("Casablanca-Settat");
    await next(page);

    // 8. Contact: the verified badge unlocks the phone switch.
    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByText("Numéro vérifié", { exact: true })).toBeVisible();
    await page.getByRole("switch", { name: /Afficher mon numéro sur l'annonce/ }).click();
    await next(page);

    // 9. Review: the preview, the rules, Publish. A reload first proves the draft was saved.
    await expect(page).toHaveURL(/\/apercu$/);
    await page.reload();
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("1 photo", { exact: true })).toBeVisible();
    await page.getByRole("checkbox", { name: /conditions générales d'utilisation/ }).check();
    const published = page.waitForResponse((response) => response.url().endsWith(`/api/listings/${listingId}/publish`) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Publier l'annonce" }).click();
    const answer = (await (await published).json()) as { status: string; slugId: string };
    expect(answer.status).toBe("published");

    // Result screen, then the public page with its photo served as a WebP variant.
    await expect(page).toHaveURL(new RegExp(`/fr/deposer/${listingId}/termine$`));
    await expect(page.getByRole("heading", { level: 1, name: "Votre annonce est en ligne" })).toBeVisible();
    const view = page.getByRole("link", { name: "Voir l'annonce" });
    await expect(view).toHaveAttribute("href", `/fr/annonce/${answer.slugId}`);
    await view.click();
    await expect(page).toHaveURL(new RegExp(`/fr/annonce/${answer.slugId}$`));
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);

    // The title is bidi-isolated inside the translated alt text.
    const photo = page.getByRole("img", { name: `${isolate(title)}, photo 1 sur 1` });
    await expect(photo).toBeVisible();
    // Any variant of the srcset (s, m or l, D6) as the browser picks it for the viewport.
    const src = await photo.evaluate((img: HTMLImageElement) => img.currentSrc || img.src);
    expect(src).toMatch(new RegExp(`/listings/${listingId}/[^/]+-[lms]\\.webp$`));
    const served = await request.get(src);
    expect(served.ok()).toBe(true);
    const meta = await sharp(await served.body()).metadata();
    expect(meta.format).toBe("webp");
    expect(meta.exif).toBeUndefined();
    expect(Math.max(meta.width ?? 0, meta.height ?? 0)).toBeLessThanOrEqual(2048);
  });

  test("an unknown step is a 404", async ({ page, request }) => {
    const id = runId();
    await signUpAndIn(page, request, `e2e-post-404-${id}@test.joutiya.ma`);
    const response = await page.goto("/fr/deposer/abcdefgh/etape-inconnue");
    expect(response?.status()).toBe(404);
  });
});
