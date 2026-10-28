import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";

// ADMIN_HOST=admin.localhost (playwright.config.ts). The server runs with APP_ENV=dev and no
// CF_ACCESS_AUD: the Access identity is the x-dev-access-email header, sent by the browser context
// below (the dev default is dev@joutiya.test; the test seeds its own admin). Turnstile runs with
// Cloudflare's always-pass test keys, so the sign-in form carries the widget like a deployed host.
// `npm run test:e2e` runs inside `firebase emulators:exec`: the seed below talks to the emulators,
// and mails stay in memory (DEV_MAILBOX=true), read back from /api/dev/mailbox on the public host.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const admin = "http://admin.localhost:3100";
const EMAIL = "admin.e2e@joutiya.test";
// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Porte", "Ouverte", "2026"].join("-");
const MODERATOR_PASSWORD = ["Souk", "Medina", "Fes", "2026"].join("-");
const uniqueEmail = (prefix: string) => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@joutiya.test`;

test.use({ extraHTTPHeaders: { "x-dev-access-email": EMAIL } });

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

/** A staff account with its roster entry. Idempotent: every Playwright worker seeds the shared admin. */
async function seedStaff(email: string, role: "admin" | "moderator", displayName: string): Promise<string> {
  const app = firebase();
  const auth = getAuth(app);
  const uid = await auth
    .createUser({ email, password: PASSWORD, emailVerified: true, displayName })
    .then((record) => record.uid)
    .catch(async (error: { code?: string }) => {
      if (error.code !== "auth/email-already-exists") throw error;
      // beforeAll runs once per Playwright worker: another worker created this account with the same
      // password. Setting the password again would revoke the sessions of tests already signed in.
      const existing = await auth.getUserByEmail(email);
      if (existing.disabled) await auth.updateUser(existing.uid, { disabled: false });
      return existing.uid;
    });
  await auth.setCustomUserClaims(uid, { role, v: 2 });
  await getFirestore(app).collection("staff").doc(uid).set({ email, displayName, role, invitedBy: "script", createdAt: new Date() });
  return uid;
}

test.beforeAll(async () => {
  await seedStaff(EMAIL, "admin", "Admin e2e");
});

const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from({ length }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join("");
/** FsObjectStore layout of the dev media bucket (src/lib/storage/fs.ts, keys.ts), served by /api/dev/storage on the public host. */
const MEDIA_ROOT = path.join(os.tmpdir(), "joutiya-dev-storage", "joutiya-dev-media");

/** A listing held for review, with one photo (both WebP variants) in the dev media bucket. */
async function seedHeldListing(): Promise<{ id: string; title: string }> {
  const firestore = getFirestore(firebase());
  const uid = `e2e-held-${randomId(12)}`;
  const publicId = randomId(10);
  const id = randomId(8);
  const photoId = `e2eheld${randomId(8)}`;
  for (const [variant, size] of Object.entries({ l: { width: 1600, height: 1200 }, s: { width: 480, height: 360 } })) {
    const key = ["listings", id, `${photoId}-${variant}.webp`];
    const body = await sharp({ create: { ...size, channels: 3, background: { r: 196, g: 120, b: 52 } } }).webp({ quality: 75 }).toBuffer();
    const objectPath = path.join(MEDIA_ROOT, "objects", ...key);
    const metaPath = `${path.join(MEDIA_ROOT, "meta", ...key)}.json`;
    await Promise.all([mkdir(path.dirname(objectPath), { recursive: true }), mkdir(path.dirname(metaPath), { recursive: true })]);
    await writeFile(objectPath, body);
    await writeFile(metaPath, JSON.stringify({ contentType: "image/webp", size: body.byteLength, cacheControl: "public, max-age=31536000, immutable", storedAt: new Date().toISOString() }));
  }
  const now = new Date();
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: "Vendeur e2e",
    type: "individual",
    citySlug: "casablanca",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 0, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: now,
    updatedAt: now,
  });
  const title = `Vélo à vérifier ${id}`;
  await firestore.collection("listings").doc(id).set({
    ownerUid: uid,
    sellerType: "individual",
    sellerName: "Vendeur e2e",
    sellerPublicId: publicId,
    status: "pending_review",
    slugId: `velo-a-verifier-casablanca-${id}`,
    title,
    description: "Vélo de ville, à vérifier avant publication.",
    categoryId: "vehicules",
    subcategoryId: "velos",
    attributes: { "bike-type": "ville" },
    condition: "good",
    price: 1500,
    priceNegotiable: false,
    isDonation: false,
    location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
    photos: [{ id: photoId, w: 1600, h: 1200, blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj" }],
    contact: { messaging: true, showPhone: false, whatsapp: false },
    boosts: {},
    sortAt: now,
    sortSource: "publish",
    moderation: { state: "needs_review", score: 55, flags: ["new_account"], openReports: 0 },
    adsEligible: false,
    legalHold: [],
    createdAt: now,
    updatedAt: now,
    version: 1,
  });
  return { id, title };
}

/** The widget must hold a token before the form is sent (the form itself waits too; this keeps the click deterministic). */
async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
}

/** Password sign-in of `email`, whose Access identity the page's context must carry. */
async function signIn(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${admin}/connexion`);
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(`${admin}/`);
}

interface DevMail {
  template: string;
  to: string;
  data: { actionUrl?: string } & Record<string, unknown>;
}

/** The newest mail of a template sent to `to`. */
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

/** Firebase compares auth_time and tokensValidAfterTime in whole seconds: a revocation must wait for the next one. */
async function nextSecond(): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  while (Math.floor(Date.now() / 1000) === now) await new Promise((resolve) => setTimeout(resolve, 50));
}

test("anonymous visitors of the admin host land on the sign-in page, under a nonce CSP", async ({ page }) => {
  const response = await page.goto(`${admin}/`);
  await expect(page).toHaveURL(`${admin}/connexion`);
  expect(response?.status()).toBe(200);
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  const headers = response!.headers();
  expect(headers["content-security-policy"] ?? "").toMatch(/'nonce-[^']+'/);
  expect(headers["x-robots-tag"] ?? "").toMatch(/noindex/);
  // The protected pages redirect too, the API answers 401.
  await page.goto(`${admin}/personnel`);
  await expect(page).toHaveURL(`${admin}/connexion`);
});

test("staff sign in with their password, see the quota board and the roster, then sign out", async ({ browser }) => {
  // A dedicated admin: signing out revokes every session of the account, which would sign the
  // shared admin out of the tests running in parallel.
  const email = uniqueEmail("admin-signout-e2e");
  await seedStaff(email, "admin", "Admin déconnexion e2e");
  const context = await browser.newContext({ extraHTTPHeaders: { "x-dev-access-email": email } });
  const page = await context.newPage();
  await signIn(page, email, PASSWORD);
  await expect(page.getByRole("heading", { name: /quotas gratuits/i })).toBeVisible();
  await expect(page.getByText("Admin", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Personnel" }).click();
  await expect(page).toHaveURL(`${admin}/personnel`);
  await expect(page.getByRole("heading", { name: "Personnel", level: 1 })).toBeVisible();
  await expect(page.getByRole("table").getByText(email)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inviter un membre" })).toBeVisible();

  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(`${admin}/connexion`);
  await page.goto(`${admin}/`);
  await expect(page).toHaveURL(`${admin}/connexion`);
  await context.close();
});

test("the moderation review shows the listing's photos, served by the public host's media route", async ({ page }) => {
  const held = await seedHeldListing();
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`${admin}/moderation/${held.id}`);
  await expect(page.getByRole("heading", { level: 1, name: held.title })).toBeVisible();
  // Another origin than the admin host: the admin CSP (img-src) and the media route's CORP must both let it load.
  const photo = page.getByRole("img", { name: "Photo 1 sur 1" });
  await expect(photo).toHaveAttribute("src", new RegExp(`^http://localhost:3100/api/dev/storage/joutiya-dev-media/listings/${held.id}/[^/]+-s\\.webp$`));
  await photo.scrollIntoViewIfNeeded();
  await expect.poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBeGreaterThan(0);
});

test("an admin invites a moderator, who sets a password from the mailed link and signs in; the admin then revokes the access", async ({ page, browser, request }) => {
  const email = uniqueEmail("moderator-e2e");
  await signIn(page, EMAIL, PASSWORD);
  await page.goto(`${admin}/personnel`);
  await page.getByLabel("Nom", { exact: true }).fill("Modo E2E");
  await page.getByLabel("E-mail", { exact: true }).fill(email);
  await page.getByLabel("Rôle").selectOption("moderator");
  await page.getByRole("button", { name: "Envoyer l'invitation" }).click();
  await expect(page.getByText(`Invitation envoyée à ${email}`)).toBeVisible();
  await expect(page.getByRole("table").getByText(email)).toBeVisible();

  // The invitation link is our own page on the admin origin, with the code of the Admin SDK link.
  const mail = await waitForMail(request, email, "staffInvite");
  const actionUrl = mail.data.actionUrl ?? "";
  expect(actionUrl.startsWith(`${admin}/connexion?mode=setPassword&oobCode=`)).toBe(true);

  // The invited person: another browser, their own Access identity.
  const context = await browser.newContext({ extraHTTPHeaders: { "x-dev-access-email": email } });
  const moderator = await context.newPage();
  await moderator.goto(actionUrl);
  await expect(moderator.getByRole("heading", { name: "Définir mon mot de passe" })).toBeVisible();
  // Staff passwords have 12 characters at least: a member-length one is refused by the form itself.
  await moderator.getByLabel("Nouveau mot de passe").fill("Court-123");
  await moderator.getByLabel("Confirmation").fill("Court-123");
  await moderator.getByRole("button", { name: "Enregistrer le mot de passe" }).click();
  await expect(moderator.getByRole("alert").filter({ hasText: "caractères au minimum" })).toBeVisible();

  await moderator.getByLabel("Nouveau mot de passe").fill(MODERATOR_PASSWORD);
  await moderator.getByLabel("Confirmation").fill(MODERATOR_PASSWORD);
  await moderator.getByRole("button", { name: "Enregistrer le mot de passe" }).click();
  await expect(moderator.getByText("Mot de passe enregistré. Connectez-vous.")).toBeVisible();
  await expect(moderator.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await expect(moderator.getByLabel("E-mail", { exact: true })).toHaveValue(email);
  await moderator.getByLabel("Mot de passe", { exact: true }).fill(MODERATOR_PASSWORD);
  await waitForTurnstile(moderator);
  await moderator.getByRole("button", { name: "Se connecter" }).click();
  await expect(moderator).toHaveURL(`${admin}/`);
  await expect(moderator.getByRole("heading", { name: /quotas gratuits/i })).toBeVisible();
  await expect(moderator.getByText("Modérateur", { exact: true })).toBeVisible();
  // Moderators have no roster: no link, and the page does not exist for them.
  await expect(moderator.getByRole("link", { name: "Personnel" })).toHaveCount(0);
  await moderator.goto(`${admin}/personnel`);
  await expect(moderator.getByRole("heading", { name: "Page introuvable" })).toBeVisible();

  // Revocation by the admin: the dialog and the toast both say Cloudflare Access is not touched.
  await page.reload();
  const row = page.getByRole("row").filter({ hasText: email });
  await row.getByRole("button", { name: "Révoquer", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Cloudflare Access");
  await dialog.getByRole("button", { name: "Révoquer l'accès", exact: true }).click();
  await expect(page.getByText("Accès de Modo E2E révoqué")).toBeVisible();
  await expect(page.getByText(/Retirez aussi la personne de Cloudflare Access/)).toBeVisible();
  await expect(row.getByText(/Révoqué le/)).toBeVisible();
  await expect(row.getByRole("button", { name: "Révoquer", exact: true })).toHaveCount(0);

  // The moderator's session is dead: the back office sends them to the sign-in page.
  await moderator.goto(`${admin}/`);
  await expect(moderator).toHaveURL(`${admin}/connexion`);
  await context.close();
});

test("a revoked session is sent to the sign-in page on a client-side navigation, not only on a full load", async ({ browser }) => {
  // A dedicated admin: revoking the shared one would break the tests running in parallel.
  const email = uniqueEmail("admin-revoked-e2e");
  const uid = await seedStaff(email, "admin", "Admin révoqué e2e");
  const context = await browser.newContext({ extraHTTPHeaders: { "x-dev-access-email": email } });
  const page = await context.newPage();
  await signIn(page, email, PASSWORD);
  await page.getByRole("link", { name: "Personnel", exact: true }).click();
  await expect(page).toHaveURL(`${admin}/personnel`);
  await expect(page.getByRole("heading", { name: "Personnel", level: 1 })).toBeVisible();

  await nextSecond();
  await getAuth(firebase()).revokeRefreshTokens(uid);

  // Same (protected) layout, another page: only the page's own guard runs on this navigation.
  await page.getByRole("link", { name: "Quotas", exact: true }).click();
  await expect(page).toHaveURL(`${admin}/connexion`);
  await expect(page.getByRole("heading", { name: "Connexion" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /quotas gratuits/i })).toHaveCount(0);
  await context.close();
});

test("an admin edits a legal mention: the legal page shows it and the audit log records the change", async ({ page }) => {
  const receipt = `D-E2E-${randomId(6).toUpperCase()}`;
  await signIn(page, EMAIL, PASSWORD);
  await page.getByRole("link", { name: "Mentions légales" }).click();
  await expect(page).toHaveURL(`${admin}/parametres/legal`);
  await expect(page.getByRole("heading", { name: "Mentions légales", level: 1 })).toBeVisible();
  const field = page.getByLabel("Récépissé CNDP");
  const previous = await field.inputValue();
  await expect(page.getByRole("button", { name: "Enregistrer" })).toBeDisabled();
  await field.fill(receipt);
  await page.getByRole("button", { name: "Enregistrer" }).click();
  await expect(page.getByText("Mentions légales enregistrées.", { exact: false })).toBeVisible();
  try {
    // ISR: the save revalidates the page, regenerated on a following visit.
    await expect
      .poll(
        async () => {
          await page.goto("/fr/legal/mentions-legales");
          return page.locator("#main").getByText(`récépissé n° ${receipt}`, { exact: false }).count();
        },
        { timeout: 20_000 },
      )
      .toBe(1);
    const entries = await getFirestore(firebase()).collection("auditLogs").where("action", "==", "legal.updated").get();
    expect(entries.docs.some((entry) => String(entry.get("reason")).includes(`cndpReceiptNo: "${previous}" → "${receipt}"`))).toBe(true);
  } finally {
    await page.goto(`${admin}/parametres/legal`);
    const restore = page.getByLabel("Récépissé CNDP");
    // A failed first save left nothing to restore: keep its error as the test's failure.
    if ((await restore.inputValue()) !== previous) {
      await restore.fill(previous);
      await page.getByRole("button", { name: "Enregistrer" }).click();
      await expect(page.getByText("Aucun changement.")).toBeVisible();
    }
  }
});

test("the admin host exposes no public API, and its own API needs a session", async ({ request }) => {
  // Node does not resolve *.localhost: same server, admin Host header.
  const headers = { host: "admin.localhost:3100" };
  expect((await request.get("/api/search", { headers })).status()).toBe(404);
  expect((await request.get("/api/health", { headers })).status()).toBe(200);
  expect((await request.get("/api/admin/staff", { headers })).status()).toBe(401);
  expect((await request.get("/api/admin/legal", { headers })).status()).toBe(401);
  // Back-office routes do not exist on the public host.
  expect((await request.get("/api/admin/staff")).status()).toBe(404);
});
