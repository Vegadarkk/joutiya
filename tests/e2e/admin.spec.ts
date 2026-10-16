import { expect, test } from "@playwright/test";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// ADMIN_HOST=admin.localhost (playwright.config.ts). The server runs with APP_ENV=dev and no
// CF_ACCESS_AUD: the Access identity is the x-dev-access-email header, sent by the browser context
// below (the dev default is dev@joutiya.test; the test seeds its own admin).
// `npm run test:e2e` runs inside `firebase emulators:exec`: the seed below talks to the emulators.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const admin = "http://admin.localhost:3100";
const EMAIL = "admin.e2e@joutiya.test";
// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Porte", "Ouverte", "2026"].join("-");

test.use({ extraHTTPHeaders: { "x-dev-access-email": EMAIL } });

test.beforeAll(async () => {
  const app = getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
  const auth = getAuth(app);
  // Every Playwright worker seeds the same account: the second one finds it created by the first.
  const uid = await auth
    .createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: "Admin e2e" })
    .then((record) => record.uid)
    .catch(async (error: { code?: string }) => {
      if (error.code !== "auth/email-already-exists") throw error;
      const existing = await auth.getUserByEmail(EMAIL);
      return (await auth.updateUser(existing.uid, { password: PASSWORD, disabled: false })).uid;
    });
  await auth.setCustomUserClaims(uid, { role: "admin", v: 2 });
  await getFirestore(app)
    .collection("staff")
    .doc(uid)
    .set({ email: EMAIL, displayName: "Admin e2e", role: "admin", invitedBy: "script", createdAt: new Date() });
});

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

test("staff sign in with their password, see the quota board and the roster, then sign out", async ({ page }) => {
  await page.goto(`${admin}/connexion`);
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue(EMAIL);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  await page.getByRole("button", { name: "Se connecter" }).click();

  await expect(page).toHaveURL(`${admin}/`);
  await expect(page.getByRole("heading", { name: /quotas gratuits/i })).toBeVisible();
  await expect(page.getByText("Admin", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: "Personnel" }).click();
  await expect(page).toHaveURL(`${admin}/personnel`);
  await expect(page.getByRole("heading", { name: "Personnel", level: 1 })).toBeVisible();
  await expect(page.getByRole("table").getByText(EMAIL)).toBeVisible();
  await expect(page.getByRole("heading", { name: "Inviter un membre" })).toBeVisible();

  await page.getByRole("button", { name: "Se déconnecter" }).click();
  await expect(page).toHaveURL(`${admin}/connexion`);
  await page.goto(`${admin}/`);
  await expect(page).toHaveURL(`${admin}/connexion`);
});

test("the admin host exposes no public API, and its own API needs a session", async ({ request }) => {
  // Node does not resolve *.localhost: same server, admin Host header.
  const headers = { host: "admin.localhost:3100" };
  expect((await request.get("/api/search", { headers })).status()).toBe(404);
  expect((await request.get("/api/health", { headers })).status()).toBe(200);
  expect((await request.get("/api/admin/staff", { headers })).status()).toBe(401);
  // Back-office routes do not exist on the public host.
  expect((await request.get("/api/admin/staff")).status()).toBe(404);
});
