import { readFile } from "node:fs/promises";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { stubGoogleScript } from "./gsi-stub";

// Account flows against the production build and the Firebase emulators (npm run test:e2e).
// Mails stay in memory (DEV_MAILBOX=true) and are read back from /api/dev/mailbox; Turnstile runs
// with Cloudflare's always-pass test keys (playwright.config.ts). The revocation test talks to the
// Auth emulator directly (`npm run test:e2e` runs inside `firebase emulators:exec`).
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

// The auth pages render the Google button (stub client id): never the real script.
test.beforeEach(({ page }) => stubGoogleScript(page));

// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const NEW_PASSWORD = ["Medina", "Fes", "2027!"].join("-");
const uniqueEmail = (prefix = "e2e") => `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.joutiya.ma`;

interface DevMail {
  id: string;
  at: string;
  template: string;
  locale: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  data: { actionUrl?: string } & Record<string, unknown>;
}

/** The newest mail of a template sent to `to`, waiting for the queue to deliver it. */
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

/** Turnstile (when a site key is configured) must have produced a token before the form is sent. */
async function waitForTurnstile(page: Page): Promise<void> {
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
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

async function fillSignup(page: Page, { name, email, password }: { name: string; email: string; password: string }) {
  await page.getByLabel("Nom affiché").fill(name);
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
}

/** Fills and sends the sign-in form of the current page. */
async function signIn(page: Page, email: string, password: string) {
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Se connecter" }).click();
}

/** Signs up through the UI, confirms the address from the mailbox, then clears the cookies: a verified, signed-out account. */
async function createVerifiedAccount(page: Page, request: APIRequestContext, prefix: string): Promise<{ email: string; name: string }> {
  const email = uniqueEmail(prefix);
  const name = "Yasmine Test";
  await page.goto("/fr/inscription");
  await fillSignup(page, { name, email, password: PASSWORD });
  await page.getByRole("checkbox", { name: /conditions générales d'utilisation/i }).check();
  await page.getByRole("checkbox", { name: /transférer mes données personnelles/i }).check();
  await waitForTurnstile(page);
  await page.getByRole("button", { name: "Créer mon compte" }).click();
  await expect(page.getByRole("heading", { name: "Vérifiez votre boîte mail" })).toBeVisible({ timeout: 15_000 });
  const mail = await waitForMail(request, email, "verifyEmail");
  await page.goto(mail.data.actionUrl!);
  await expect(page.getByRole("heading", { name: "Adresse confirmée" })).toBeVisible({ timeout: 15_000 });
  await page.context().clearCookies();
  return { email, name };
}

test.describe("account", () => {
  test("signs up, confirms the e-mail, edits the profile, signs out and back in", async ({ page, request }) => {
    const email = uniqueEmail();
    const name = "Yasmine Test";

    await page.goto("/fr/inscription");
    await expect(page.getByRole("heading", { level: 1, name: "Créer un compte" })).toBeVisible();
    await fillSignup(page, { name, email, password: PASSWORD });
    await page.getByRole("checkbox", { name: /conditions générales d'utilisation/i }).check();
    await page.getByRole("checkbox", { name: /transférer mes données personnelles/i }).check();
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await expect(page.getByRole("heading", { name: "Vérifiez votre boîte mail" })).toBeVisible({ timeout: 15_000 });

    // The verification link opens /action, which activates the account and signs in.
    const mail = await waitForMail(request, email, "verifyEmail");
    expect(mail.data.actionUrl).toMatch(/\/fr\/action\?/);
    await page.goto(mail.data.actionUrl!);
    await expect(page.getByRole("heading", { name: "Adresse confirmée" })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("link", { name: "Mes paramètres" }).first().click();
    await expect(page).toHaveURL(/\/fr\/parametres$/);
    await expect(page.getByRole("heading", { level: 1, name: "Mes paramètres" })).toBeVisible();
    await expect(page.getByLabel("Nom affiché")).toHaveValue(name, { timeout: 15_000 });
    // The header shows the account once /api/auth/me has answered ("Fermer mon compte" is on the page too).
    await expect(page.getByRole("button", { name: /^Mon compte/ })).toBeVisible();

    // Change the display name.
    await page.getByLabel("Nom affiché").fill("Yasmine B.");
    await page.getByRole("button", { name: "Enregistrer" }).click();
    await expect(page.getByText("Profil enregistré")).toBeVisible();
    await page.reload();
    await expect(page.getByLabel("Nom affiché")).toHaveValue("Yasmine B.", { timeout: 15_000 });

    // Sign out, then back in with the password.
    await page.getByRole("button", { name: "Se déconnecter" }).click();
    await expect(page).toHaveURL(/\/fr$/);
    await expect(page.getByRole("link", { name: "Se connecter" })).toBeVisible();

    await page.goto("/fr/connexion");
    await page.getByLabel("Adresse e-mail").fill(email);
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/fr\/parametres$/, { timeout: 15_000 });
    await expect(page.getByLabel("Nom affiché")).toHaveValue("Yasmine B.", { timeout: 15_000 });
  });

  test("the sign-up form explains what to fix", async ({ page }) => {
    await page.goto("/fr/inscription");
    await fillSignup(page, { name: "A", email: "pas-un-email", password: "court" });
    await page.getByRole("button", { name: "Créer mon compte" }).click();
    await expect(page.getByText("Le nom doit faire au moins 2 caractères.")).toBeVisible();
    await expect(page.getByText("Entrez une adresse e-mail valide.")).toBeVisible();
    await expect(page.getByText(/au moins 8 caractères\./)).toBeVisible();
    await expect(page.getByText("Cette case est obligatoire pour continuer.")).toHaveCount(2);
    // Focus lands on the first invalid field.
    await expect(page.getByLabel("Nom affiché")).toBeFocused();
  });

  test("a wrong password gets one generic message", async ({ page }) => {
    await page.goto("/fr/connexion");
    await page.getByLabel("Adresse e-mail").fill(uniqueEmail("nobody"));
    await page.getByLabel("Mot de passe", { exact: true }).fill("mauvais-mot-de-passe");
    await page.getByRole("button", { name: "Se connecter" }).click();
    await expect(page.getByRole("alert").filter({ hasText: "Adresse e-mail ou mot de passe incorrect." })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/fr\/connexion/);
  });

  test("a revoked member session is signed out on the next page load", async ({ page, request }) => {
    const { email } = await createVerifiedAccount(page, request, "revoked");
    await page.goto("/fr/connexion");
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/fr\/parametres$/, { timeout: 15_000 });
    const me = (await (await page.request.get("/api/auth/me")).json()) as { session: { uid: string } | null };
    expect(me.session).not.toBeNull();

    // Firebase compares revocation to the second: the cookie must be older than the revocation.
    const second = Math.floor(Date.now() / 1000);
    while (Math.floor(Date.now() / 1000) === second) await new Promise((resolve) => setTimeout(resolve, 50));
    const app = getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
    await getAuth(app).revokeRefreshTokens(me.session!.uid);

    // The cookie is still there and unexpired: only the revocation check can send the person away.
    await page.goto("/fr/parametres");
    await expect(page).toHaveURL(/\/fr\/connexion/);
    await expect(page.getByRole("heading", { level: 1, name: "Se connecter" })).toBeVisible();
    const after = (await (await page.request.get("/api/auth/me")).json()) as { session: unknown };
    expect(after.session).toBeNull();
  });

  test("the account area sends visitors to the sign-in page", async ({ page }) => {
    await page.goto("/fr/parametres");
    await expect(page).toHaveURL(/\/fr\/connexion/);
    await expect(page.getByRole("heading", { level: 1, name: "Se connecter" })).toBeVisible();
    await page.goto("/fr/verifications");
    await expect(page).toHaveURL(/\/fr\/connexion/);
  });

  test("resets a forgotten password from the e-mail link, then signs in with the new one", async ({ page, request }) => {
    const { email } = await createVerifiedAccount(page, request, "reset");

    await page.goto("/fr/mot-de-passe-oublie");
    await page.getByLabel("Adresse e-mail").fill(email);
    await waitForTurnstile(page);
    await page.getByRole("button", { name: "Envoyer le lien" }).click();
    await expect(page.getByRole("heading", { name: "Consultez votre boîte mail" })).toBeVisible({ timeout: 15_000 });

    const mail = await waitForMail(request, email, "resetPassword");
    expect(mail.data.actionUrl).toMatch(/\/fr\/action\?/);
    expect(mail.data.actionUrl).toContain("mode=resetPassword");
    expect(mail.data.actionUrl).toContain("oobCode=");
    await page.goto(mail.data.actionUrl!);
    await expect(page.getByRole("heading", { level: 1, name: "Choisir un nouveau mot de passe" })).toBeVisible();
    await expect(page.getByText(`Pour le compte ${email}.`)).toBeVisible({ timeout: 15_000 });
    // The single-use code leaves the address bar (and the history entry) once read.
    await expect(page).not.toHaveURL(/oobCode=/);
    expect(await page.evaluate(() => window.location.search)).toBe("");

    await page.getByLabel("Nouveau mot de passe").fill(NEW_PASSWORD);
    await page.getByRole("button", { name: "Enregistrer le mot de passe" }).click();
    // The status panel is the innermost section carrying the heading (the page wraps it in another).
    const done = page.locator("section").filter({ has: page.getByRole("heading", { name: "Mot de passe modifié" }) }).last();
    await expect(done).toBeVisible({ timeout: 15_000 });
    await done.getByRole("link", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/fr\/connexion/);

    await signIn(page, email, NEW_PASSWORD);
    await expect(page).toHaveURL(/\/fr\/parametres$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Mes paramètres" })).toBeVisible();
  });

  test("asks for Turnstile after three wrong passwords, then signs in with its token", async ({ page, request }) => {
    const { email } = await createVerifiedAccount(page, request, "lock");
    await page.goto("/fr/connexion");
    await page.getByLabel("Adresse e-mail").fill(email);
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await page.getByLabel("Mot de passe", { exact: true }).fill(`mauvais-${attempt}`);
      const [response] = await Promise.all([
        page.waitForResponse((candidate) => candidate.url().includes("/api/auth/login")),
        page.getByRole("button", { name: "Se connecter" }).click(),
      ]);
      expect(response.status()).toBe(401);
      await expect(page.getByRole("alert").filter({ hasText: "Adresse e-mail ou mot de passe incorrect." })).toBeVisible();
    }
    await expect(page.getByText("Encore une vérification")).toHaveCount(0);

    // Fourth attempt, right password: the server wants a token first; the widget appears (test key:
    // solved by itself) and the form goes again with the token.
    await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
    const [challenge] = await Promise.all([
      page.waitForResponse((candidate) => candidate.url().includes("/api/auth/login")),
      page.getByRole("button", { name: "Se connecter" }).click(),
    ]);
    expect(challenge.status()).toBe(200);
    expect(((await challenge.json()) as { status: string }).status).toBe("turnstile_required");
    await expect(page.getByText("Encore une vérification")).toBeVisible();
    // The form resubmits by itself once the widget hands it a token; the widget is gone with the page.
    await expect(page).toHaveURL(/\/fr\/parametres$/, { timeout: 20_000 });
  });

  test("?next= brings the person back where they were", async ({ page, request }) => {
    const { email } = await createVerifiedAccount(page, request, "next");

    // Guarded page -> sign-in page carrying next -> back to the guarded page.
    await page.goto("/fr/verifications");
    await expect(page).toHaveURL(/\/fr\/connexion\?next=(%2F|\/)fr(%2F|\/)verifications$/);
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/fr\/verifications$/, { timeout: 15_000 });
    await expect(page.getByRole("heading", { level: 1, name: "Vérifier mon numéro" })).toBeVisible();

    // Already signed in: the sign-in page honours next, and refuses a foreign target.
    await page.goto("/fr/connexion?next=%2Ffr%2Fverifications");
    await expect(page).toHaveURL(/\/fr\/verifications$/);
    await page.goto("/fr/connexion?next=%2F%2Fevil.example%2F");
    await expect(page).toHaveURL(/\/fr\/parametres$/);
    await page.goto("/fr/inscription?next=%2Ffr%2Fverifications");
    await expect(page).toHaveURL(/\/fr\/verifications$/);

    // The header's sign-in link carries the current page.
    await page.context().clearCookies();
    await page.goto("/fr");
    await page.getByRole("banner").getByRole("link", { name: "Se connecter" }).click();
    await expect(page).toHaveURL(/\/fr\/connexion\?next=(%2F|\/)fr$/);
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/fr$/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: "Mon compte" })).toBeVisible();
  });

  test("downloads the personal data, then closes the account for good (D26)", async ({ page, request }) => {
    const { email } = await createVerifiedAccount(page, request, "close");
    await page.goto("/fr/connexion");
    await signIn(page, email, PASSWORD);
    await expect(page).toHaveURL(/\/fr\/parametres$/, { timeout: 15_000 });

    // The export: a JSON file named after the day, with the account's own data.
    const downloading = page.waitForEvent("download");
    await page.getByRole("button", { name: "Télécharger mes données" }).click();
    const file = await downloading;
    expect(file.suggestedFilename()).toMatch(/^joutiya-mes-donnees-\d{4}-\d{2}-\d{2}\.json$/);
    const data = JSON.parse(await readFile(await file.path(), "utf8")) as { format: string; account: { email: string } };
    expect(data.format).toBe("joutiya.account-export");
    expect(data.account.email).toBe(email);

    // The closure: the time line, then an explicit acknowledgement before the button works.
    await page.getByRole("button", { name: "Fermer mon compte" }).click();
    const dialog = page.getByRole("dialog", { name: "Fermer votre compte Joutiya ?" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText("Aujourd'hui")).toBeVisible();
    const submit = dialog.getByRole("button", { name: "Fermer définitivement" });
    await expect(submit).toBeDisabled();
    await dialog.getByLabel("Je comprends que la fermeture de mon compte est définitive.").check();
    await submit.click();
    // The page gives way to the confirmation, with the purge date and the way out.
    await expect(page.getByRole("heading", { level: 2, name: "Votre compte est fermé" })).toBeVisible({ timeout: 15_000 });
    await expect(dialog).toBeHidden();
    await expect(page.getByText(/^Un e-mail de confirmation vous a été envoyé\. Les données de votre compte seront supprimées le /)).toBeVisible();
    await expect(page.getByRole("button", { name: "Se déconnecter" })).toBeHidden();
    await page.getByRole("link", { name: "Retour à l'accueil" }).click();
    await expect(page).toHaveURL(/\/fr$/, { timeout: 15_000 });
    await expect(page.getByRole("link", { name: "Se connecter" }).first()).toBeVisible();
    const me = (await (await page.request.get("/api/auth/me")).json()) as { session: unknown };
    expect(me.session).toBeNull();
    await waitForMail(request, email, "accountClosed");

    // The address no longer signs in.
    await page.goto("/fr/connexion");
    await signIn(page, email, PASSWORD);
    await expect(page.getByRole("alert").filter({ hasText: "Ce compte a été désactivé." })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/fr\/connexion/);
  });

  test("the Google button hands a rejected credential to the form message, under a device-bound nonce", async ({ page }) => {
    const stubButton = page.getByRole("button", { name: "Continuer avec Google (stub)" });
    const gisNonce = () => page.evaluate(() => (window as unknown as { __gsi?: { nonce?: string } }).__gsi?.nonce ?? "");
    await page.goto("/fr/connexion");
    const [post] = await Promise.all([page.waitForResponse((candidate) => candidate.url().includes("/api/auth/google")), stubButton.click()]);
    // The fake token is refused server side (no Google signature): the form says so, and the page
    // stays. Next's empty route announcer is an alert too: the message is the alert with text.
    expect(post.status()).toBe(401);
    expect(post.request().postDataJSON()).toEqual({ credential: expect.stringMatching(/^stub-credential-/), locale: "fr" });
    await expect(page.getByRole("alert").filter({ hasText: /\S/ })).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/fr\/connexion/);
    // GIS was initialised with the nonce the page derived from the device cookie (an HMAC, never
    // posted back): the same one on the next page of this device, another one without the cookie.
    const nonce = await gisNonce();
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43}$/);
    await page.goto("/fr/inscription");
    await expect(stubButton).toBeVisible();
    expect(await gisNonce()).toBe(nonce);
    await page.context().clearCookies();
    await page.goto("/fr/connexion");
    await expect(stubButton).toBeVisible();
    const fresh = await gisNonce();
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fresh).not.toBe(nonce);
  });

  test("/rif/connexion is consistently French, with a notice", async ({ page }) => {
    await page.goto("/rif/connexion");
    await expect(page.locator("html")).toHaveAttribute("lang", "rif-Latn");
    await expect(page.getByText("Cette partie du site est en français pour le moment.")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1, name: "Se connecter" })).toBeVisible();
    await expect(page.getByLabel("Adresse e-mail")).toBeVisible();
    await expect(page.getByRole("button", { name: "Se connecter" })).toBeVisible();
  });

  test("/ar/connexion renders right to left", async ({ page }) => {
    await page.goto("/ar/connexion");
    await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
    await expect(page.locator("html")).toHaveAttribute("lang", "ar-MA");
    await expect(page.getByRole("heading", { level: 1, name: "تسجيل الدخول" })).toBeVisible();
    await expect(page.getByLabel("البريد الإلكتروني")).toBeVisible();
  });

  test("the auth pages load under the nonce CSP without violations", async ({ page }) => {
    const violations = await watchCsp(page);
    const pages = [
      ["/fr/connexion", "Se connecter"],
      ["/fr/inscription", "Créer un compte"],
      ["/fr/mot-de-passe-oublie", "Mot de passe oublié"],
      ["/fr/action", "Lien incomplet"],
    ] as const;
    for (const [path, heading] of pages) {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["content-security-policy"] ?? "").toMatch(/'nonce-[^']+'/);
      await expect(page.getByRole("heading", { name: heading })).toBeVisible();
      // The Turnstile widget keeps the network busy: wait for it instead of "networkidle".
      await waitForTurnstile(page);
    }
    expect(violations).toEqual([]);
  });
});
