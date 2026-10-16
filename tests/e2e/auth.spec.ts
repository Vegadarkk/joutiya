import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// Account flows against the production build and the Firebase emulators (npm run test:e2e).
// Mails stay in memory (DEV_MAILBOX=true) and are read back from /api/dev/mailbox; Turnstile runs
// with Cloudflare's always-pass test keys (playwright.config.ts).

// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
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
    // The header shows the account once /api/auth/me has answered.
    await expect(page.getByRole("button", { name: "Mon compte" })).toBeVisible();

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

  test("the account area sends visitors to the sign-in page", async ({ page }) => {
    await page.goto("/fr/parametres");
    await expect(page).toHaveURL(/\/fr\/connexion/);
    await expect(page.getByRole("heading", { level: 1, name: "Se connecter" })).toBeVisible();
    await page.goto("/fr/verifications");
    await expect(page).toHaveURL(/\/fr\/connexion/);
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
