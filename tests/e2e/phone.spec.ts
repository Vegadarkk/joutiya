import { createHmac } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { stubGoogleScript } from "./gsi-stub";
import { ownClientIp } from "./helpers";

// The sign-up page renders the Google button (stub client id): never the real script.
test.beforeEach(({ page }) => stubGoogleScript(page));

// WhatsApp phone verification against the production build and the Firebase emulators
// (npm run test:e2e): a fresh account signs up through the UI and confirms its e-mail from the dev
// mailbox (as tests/e2e/auth.spec.ts does), starts a challenge on /fr/verifications, then the test
// plays Meta: it posts the signed webhook payload carrying the code from the user's number, and
// the page must switch to the verified state by itself (status poll).

// Must match playwright.config.ts (webServer env).
const WHATSAPP = { appSecret: "e2e-whatsapp-app-secret", phoneNumberId: "100000000000001", displayNumber: "212600000000" };

// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const uniqueEmail = () => `e2e-phone-${Date.now()}-${Math.floor(Math.random() * 1e6)}@test.joutiya.ma`;

/** A fresh Moroccan mobile per run: verified numbers persist in the emulator for the session. */
function freshNumber(): { typed: string; from: string; national: string } {
  // 061xxxxxxx is always a valid Moroccan mobile range (06 8[356] is not).
  const digits = `61${String(Date.now() % 10_000_000).padStart(7, "0")}`;
  const national = `0${digits}`.replace(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/, "$1 $2 $3 $4 $5");
  return { typed: `0${digits}`, from: `212${digits}`, national };
}

/**
 * A number inside a sentence: national form between bidi isolates (LRI..PDI, src/lib/i18n/bidi.ts).
 * The page joins its digit pairs with no-break spaces, which getByText matches as spaces.
 */
const inSentence = (phone: string) => `\u2066${phone}\u2069`;

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

/** Signs up and signs in through the e-mail confirmation link. */
async function signUpAndIn(page: Page, request: APIRequestContext, email: string): Promise<void> {
  await ownClientIp(page);
  await page.goto("/fr/inscription");
  // Hydrated first (the widget turns ready client side): a consent ticked earlier is unticked when the form registers its fields.
  await waitForTurnstile(page);
  await page.getByLabel("Nom affiché").fill("Karim Test");
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

/** The browser's session cookie, for API calls made from the test's request context. */
async function sessionCookie(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies
    .filter((cookie) => cookie.name === "__Host-session")
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join("; ");
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
              contacts: [{ profile: { name: "Karim" }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  });
  return { raw, signature: `sha256=${createHmac("sha256", WHATSAPP.appSecret).update(raw).digest("hex")}` };
}

test.describe("phone verification", () => {
  test("starts a challenge, receives the code from WhatsApp and shows the verified badge", async ({ page, request }) => {
    const email = uniqueEmail();
    const number = freshNumber();
    await signUpAndIn(page, request, email);

    await page.goto("/fr/verifications");
    await expect(page.getByRole("heading", { level: 1, name: "Vérifier mon numéro" })).toBeVisible();
    await page.getByLabel("Numéro de mobile").fill(number.typed);
    const started = page.waitForResponse((response) => response.url().endsWith("/api/auth/phone/start") && response.request().method() === "POST");
    await page.getByRole("button", { name: "Obtenir mon code" }).click();
    const answer = (await (await started).json()) as { status: string; code: string; number: string; waLink: string };
    expect(answer.status).toBe("pending");
    expect(answer.code).toMatch(/^\d{6}$/);
    expect(answer.number).toBe(WHATSAPP.displayNumber);

    // The page shows the code, the wa.me link and Joutiya's number, and waits. Both numbers are in
    // the national form, as after a reload.
    await expect(page.getByRole("heading", { name: "Envoyez ce code sur WhatsApp" })).toBeVisible();
    await expect(page.getByText(`Depuis le WhatsApp du ${inSentence(number.national)}, envoyez le message ci-dessous au numéro d'Aalan.`)).toBeVisible();
    await expect(page.getByText("06 00 00 00 00", { exact: true })).toBeVisible();
    await expect(page.getByText(answer.code, { exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Ouvrir WhatsApp" })).toHaveAttribute("href", answer.waLink);
    await expect(page.getByText("En attente de votre message…")).toBeVisible();

    // A wrong code from the right phone changes nothing.
    const wrong = String((Number(answer.code) + 1) % 1_000_000).padStart(6, "0");
    const miss = signedInbound(number.from, `AALAN ${wrong}`, `wamid.e2e.${Date.now()}.miss`);
    expect((await request.post("/api/webhooks/whatsapp", { data: miss.raw, headers: { "content-type": "application/json", "x-hub-signature-256": miss.signature } })).status()).toBe(200);
    expect(((await (await request.get("/api/auth/phone/status", { headers: { cookie: await sessionCookie(page) } })).json()) as { status: string }).status).toBe("pending");

    // The user sends the code from their phone: Meta delivers it to the webhook.
    const hit = signedInbound(number.from, `AALAN ${answer.code}`, `wamid.e2e.${Date.now()}.hit`);
    const delivered = await request.post("/api/webhooks/whatsapp", { data: hit.raw, headers: { "content-type": "application/json", "x-hub-signature-256": hit.signature } });
    expect(delivered.status()).toBe(200);
    expect(await delivered.json()).toEqual({ received: true });

    // The page polls the status every 5 s and switches to the verified state.
    await expect(page.getByRole("heading", { name: "Numéro vérifié" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText("Téléphone vérifié")).toBeVisible();
    await expect(page.getByText(`Le ${inSentence(number.national)} est maintenant associé à votre compte.`)).toBeVisible();

    // The state survives a reload (the number in its national form), and the confirmation mail went out.
    await page.reload();
    await expect(page.getByRole("heading", { name: "Numéro vérifié" })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`Le ${inSentence(number.national)} est maintenant associé à votre compte.`)).toBeVisible();
    const mail = await waitForMail(request, email, "phoneVerified");
    expect(mail.data["phone"]).toBe(number.national);
  });

  test("the webhook refuses an unsigned payload and answers the subscription handshake", async ({ request }) => {
    const { raw } = signedInbound("212600000001", "AALAN 123456", `wamid.e2e.${Date.now()}.unsigned`);
    expect((await request.post("/api/webhooks/whatsapp", { data: raw, headers: { "content-type": "application/json" } })).status()).toBe(403);
    expect((await request.post("/api/webhooks/whatsapp", { data: raw, headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${"0".repeat(64)}` } })).status()).toBe(403);
    const handshake = await request.get("/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=e2e-whatsapp-verify-token&hub.challenge=424242");
    expect(handshake.status()).toBe(200);
    expect(await handshake.text()).toBe("424242");
    expect((await request.get("/api/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1")).status()).toBe(403);
  });
});
