import { randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Browser, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import { ownClientIp } from "./helpers";

// Pro path of phase 7 lot 1 against the production build and the Firebase emulators (npm run
// test:e2e). A fresh member is refused until the number is verified (the WhatsApp check is
// configured here: the number is seeded straight into the emulator, as scripts/dev-verify-phone.ts
// does; the moderator's call is covered by tests/api/pro), applies from /fr/pro, a moderator
// validates the shop on admin.localhost, then the member signs in again, sees the dashboard and
// opens the storefront.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const admin = "http://admin.localhost:3100";
const STAFF_EMAIL = "moderator.pro.e2e@joutiya.test";
const STAFF_PASSWORD = ["Porte", "Ouverte", "2026"].join("-");
const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
const MINIMAL_PDF = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n");

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

async function seedModerator(): Promise<void> {
  const app = firebase();
  const auth = getAuth(app);
  const uid = await auth
    .createUser({ email: STAFF_EMAIL, password: STAFF_PASSWORD, emailVerified: true, displayName: "Modération e2e" })
    .then((record) => record.uid)
    .catch(async (error: { code?: string }) => {
      if (error.code !== "auth/email-already-exists") throw error;
      return (await auth.getUserByEmail(STAFF_EMAIL)).uid;
    });
  await auth.setCustomUserClaims(uid, { role: "moderator", v: 2 });
  await getFirestore(app).collection("staff").doc(uid).set({ email: STAFF_EMAIL, displayName: "Modération e2e", role: "moderator", invitedBy: "script", createdAt: new Date() });
}

/** The verified number the WhatsApp check would have set (one account per number: a random one). */
async function seedVerifiedPhone(email: string): Promise<void> {
  const app = firebase();
  const { uid } = await getAuth(app).getUserByEmail(email);
  const user = getFirestore(app).collection("users").doc(uid);
  const digits = Array.from(randomBytes(8), (byte) => String(byte % 10)).join("");
  await user.collection("private").doc("account").update({ phoneE164: `+2126${digits}`, phoneVerifiedAt: new Date() });
  await user.update({ "badges.phoneVerified": true, updatedAt: new Date() });
}

async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

async function waitForMail(request: APIRequestContext, to: string, template: string): Promise<{ data: { actionUrl?: string } }> {
  let found: { template: string; data: { actionUrl?: string } } | undefined;
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/dev/mailbox?to=${encodeURIComponent(to)}`);
        if (!response.ok()) return false;
        const { mails } = (await response.json()) as { mails: { template: string; data: { actionUrl?: string } }[] };
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
  await waitForTurnstile(page);
  await page.getByLabel("Nom affiché").fill("Salma Test");
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

/** Uncaught page errors and CSP violations (console noise aside: the live stream answers 503 without Valkey here, Turnstile's frame logs permission policies). */
async function watchErrors(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.exposeFunction("__cspViolation", (detail: string) => errors.push(`CSP ${detail}`));
  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      (window as unknown as { __cspViolation: (detail: string) => void }).__cspViolation(`${event.violatedDirective} ${event.blockedURI}`);
    });
  });
  return errors;
}

async function moderate(browser: Browser, shopName: string): Promise<void> {
  const context = await browser.newContext({ extraHTTPHeaders: { "x-dev-access-email": STAFF_EMAIL } });
  const page = await context.newPage();
  await page.goto(`${admin}/connexion`);
  await page.getByLabel("Mot de passe", { exact: true }).fill(STAFF_PASSWORD);
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(`${admin}/`);

  await page.goto(`${admin}/pros`);
  await page.getByRole("link", { name: new RegExp(shopName) }).click();
  await expect(page.getByRole("heading", { name: shopName, level: 1 })).toBeVisible();
  await page.screenshot({ path: "test-results/pro-admin-review.png", fullPage: true });

  await expect(page.getByText("Justificatif 1")).toBeVisible();
  await expect(page.getByRole("link", { name: "Ouvrir" })).toHaveAttribute("href", /^\/kybc\//);
  await page.getByLabel("Registre consulté").selectOption("ompic");
  await page.getByRole("button", { name: "Valider la boutique" }).click();
  await expect(page).toHaveURL(`${admin}/pros`, { timeout: 15_000 });
  await context.close();
}

test.describe("Pro accounts", () => {
  test.beforeAll(seedModerator);

  test("a member applies, a moderator validates, the shop opens its storefront", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const errors = await watchErrors(page);
    const email = `pro-${randomId(10)}@joutiya.test`;
    const shopName = `Atelier ${randomId(6)}`;
    await signUpAndIn(page, request, email);

    await page.goto("/fr/pro");
    await expect(page.getByRole("heading", { name: "Ouvrir une boutique Pro sur Aalan" })).toBeVisible();
    await expect(page.getByRole("link", { name: "Vérifier mon numéro" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Envoyer ma demande" })).toHaveCount(0);
    await seedVerifiedPhone(email);
    await page.reload();
    await expect(page.getByText("Votre compte remplit les conditions pour demander un compte Pro.")).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "test-results/pro-intro.png", fullPage: true });

    // Nothing filled: each field says what it needs, nothing is sent.
    await page.getByRole("button", { name: "Envoyer ma demande" }).click();
    await expect(page.getByText("Choisissez la ville de la boutique.")).toBeVisible();
    await expect(page.getByText("Ajoutez au moins un justificatif.")).toBeVisible();
    await page.screenshot({ path: "test-results/pro-form-errors.png", fullPage: true });

    await page.getByLabel("Nom de la boutique").fill(shopName);
    await page.getByLabel("Présentation").fill("Céramique et zellige faits main.");
    await page.getByRole("combobox", { name: /Ville/ }).fill("Casab");
    await page.getByRole("option", { name: "Casablanca", exact: true }).click();
    await page.getByRole("radio", { name: /Société/ }).check();
    await page.getByRole("textbox", { name: "ICE", exact: true }).fill("001 234 567 000 089");
    await page.getByLabel("Numéro de registre du commerce (RC)").fill("12345");
    await page.getByLabel("Identifiant fiscal (IF)").fill("4567890");
    await page.locator('input[type="file"]').setInputFiles({ name: "extrait-rc.pdf", mimeType: "application/pdf", buffer: MINIMAL_PDF });
    await expect(page.getByText("Document reçu")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("checkbox", { name: /Je certifie que ces informations sont exactes/ }).check();
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Envoyer ma demande" }).click();
    await expect(page.getByRole("heading", { name: "Demande en cours de vérification" })).toBeVisible({ timeout: 15_000 });
    await page.screenshot({ path: "test-results/pro-pending.png", fullPage: true });

    await moderate(browser, shopName);

    // The verification revokes the sessions: the member signs in again and publishes as Pro.
    await page.goto("/fr/pro");
    if (page.url().includes("/connexion")) {
      await page.getByLabel("Adresse e-mail").fill(email);
      await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
      await waitForTurnstile(page);
      await page.getByRole("button", { name: "Se connecter" }).click();
    }
    await expect(page.getByRole("heading", { name: shopName, level: 2 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Boutique vérifiée")).toBeVisible();
    await expect(page.getByText("Essentiel", { exact: true })).toBeVisible();
    await expect(page.getByRole("meter", { name: "Annonces en ligne" })).toBeVisible();
    await page.screenshot({ path: "test-results/pro-dashboard.png", fullPage: true });

    await page.getByRole("link", { name: "Voir ma vitrine" }).click();
    await expect(page.getByRole("heading", { name: shopName, level: 1 })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Aalan n'est pas partie à la vente/)).toBeVisible();
    await page.screenshot({ path: "test-results/pro-storefront-fr.png", fullPage: true });
    const storefront = new URL(page.url()).pathname;
    expect(storefront).toMatch(/^\/fr\/boutique\/[a-z0-9-]+-[a-hj-km-np-z2-9]{8}$/);

    // Arabic, right to left; an outdated slug redirects to the current one.
    const segment = storefront.split("/").pop()!;
    const response = await page.goto(`/ar/boutique/ancien-nom-${segment.slice(-8)}`);
    expect(response?.status()).toBe(200);
    await expect(page).toHaveURL(`/ar/boutique/${segment}`);
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await page.screenshot({ path: "test-results/pro-storefront-ar.png", fullPage: true });

    expect((await page.goto("/fr/boutique/inconnue-abcd2345"))?.status()).toBe(404);
    expect(errors).toEqual([]);
  });
});
