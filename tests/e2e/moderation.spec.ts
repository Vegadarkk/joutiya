import { createHmac, randomBytes } from "node:crypto";
import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

// Notice and appeal (phase 5 lot U2, art. 16 and 20 DSA) against the production build and the
// Firebase emulators (npm run test:e2e). A member reports a listing from its page and reads the
// receipt; a removal decision about that listing is then written straight into the emulator, and
// its seller opens the signed link of the decision mail signed out and files an appeal.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const PASSWORD = ["Souk", "Tanger", "2026!"].join("-");
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
/** src/lib/security/hash.ts: the server's pepper, the dev one when HASH_PEPPER is unset. */
const PEPPER = process.env.HASH_PEPPER ?? "joutiya-dev-pepper-not-a-secret-0000";

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
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

interface Member {
  uid: string;
  publicId: string;
  displayName: string;
}

async function session(page: Page): Promise<Member> {
  const me = (await (await page.request.get("/api/auth/me")).json()) as { session: Member | null };
  expect(me.session?.uid).toBeTruthy();
  return me.session!;
}

/** A published listing of `owner`, without photos (the page shows its placeholder). */
async function seedListing(owner: Member): Promise<{ id: string; slugId: string; title: string }> {
  const now = new Date();
  const id = randomId(8);
  const title = `Lampe en cuivre ${id}`;
  const slugId = `lampe-en-cuivre-fes-${id}`;
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
      attributes: { "decor-type": "luminaire" },
      condition: "good",
      price: 650,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: "03", citySlug: "fes", geo: { lat: 34.03, lng: -5.0 } },
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
      description: "Lampe artisanale en cuivre ciselé, faite main à Fès. Fonctionne parfaitement.",
      photos: [],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  return { id, slugId, title };
}

/** A removal of the listing (template listing.remove.scam) and the signed link of its decision mail. */
async function seedDecision(listingId: string, seller: Member): Promise<{ decisionId: string; token: string }> {
  const now = new Date();
  const deadline = new Date(now.getTime() + 182 * 86_400_000);
  const ref = getFirestore(firebase()).collection("moderationDecisions").doc();
  await ref.set({
    target: { type: "listing", id: listingId },
    affectedUid: seller.uid,
    action: "remove",
    facts: "l'annonce présente des signes d'arnaque (paiement demandé d'avance, objet inexistant, prix irréaliste ou contact hors de Joutiya)",
    origin: "notice",
    automation: { detection: false, decision: false },
    ground: { type: "terms", ref: "CGU, modération (arnaques)", explanation: "nos conditions générales interdisent les annonces trompeuses destinées à obtenir un paiement ou des données" },
    reportIds: [],
    templateId: "listing.remove.scam",
    decidedBy: "e2e-moderator",
    notifiedAt: now,
    appealDeadline: deadline,
    createdAt: now,
    purgeAt: new Date(now.getTime() + 5 * 365 * 86_400_000),
  });
  // src/lib/decisions/appeal-token.ts
  const payload = ["v1", ref.id, "affected", "-", String(Math.floor(deadline.getTime() / 1000))].join(".");
  const signature = createHmac("sha256", PEPPER).update(`appeal:v1:${payload}`).digest("base64url");
  return { decisionId: ref.id, token: `${Buffer.from(payload, "utf8").toString("base64url")}.${signature}` };
}

test.describe("notice and appeal", () => {
  test.setTimeout(180_000);

  test("a member reports a listing and reads the receipt; its seller appeals the removal from the mail's link", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const reporterContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const reporterPage = await reporterContext.newPage();
    const errors: string[] = [];
    for (const page of [sellerPage, reporterPage]) page.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-seller-${stamp}@test.joutiya.ma`, "Karim Vendeur");
    await signUpAndIn(reporterPage, request, `e2e-reporter-${stamp}@test.joutiya.ma`, "Nadia Signale");
    const seller = await session(sellerPage);
    const listing = await seedListing(seller);

    // The owner has no report button on his own listing.
    await sellerPage.goto(`/fr/annonce/${listing.slugId}`);
    await expect(sellerPage.getByRole("heading", { level: 1, name: listing.title })).toBeVisible();
    await expect(sellerPage.getByRole("button", { name: "Signaler l'annonce" })).toHaveCount(0);

    // The member reports it: reason, facts, good faith; no name, e-mail or check asked.
    await reporterPage.goto(`/fr/annonce/${listing.slugId}`);
    await reporterPage.getByRole("button", { name: "Signaler l'annonce" }).click();
    const dialog = reporterPage.getByTestId("report-dialog");
    await expect(dialog).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("button", { name: "Continuer" }).click();
    await expect(dialog.getByRole("alert")).toBeVisible();
    await dialog.getByTestId("reason-scam").click();
    await dialog.getByRole("button", { name: "Continuer" }).click();
    await expect(dialog.getByTestId("report-reason")).toHaveText("Arnaque ou tentative d'escroquerie");
    await expect(dialog.getByLabel("Adresse e-mail")).toHaveCount(0);
    await expect(dialog.locator("[data-turnstile]")).toHaveCount(0);
    await dialog.getByLabel(/Ce que vous avez constaté/).fill(`Le vendeur exige un acompte par Wafacash avant toute visite. ${stamp}`);
    await dialog.getByRole("checkbox", { name: /Je déclare de bonne foi/ }).check();
    await dialog.getByRole("button", { name: "Envoyer le signalement" }).click();

    const receipt = dialog.getByTestId("report-receipt");
    await expect(receipt).toBeVisible({ timeout: 15_000 });
    await expect(receipt).toHaveAttribute("data-duplicate", "false");
    await expect(dialog.getByRole("heading", { name: "Signalement envoyé" })).toBeVisible();
    await expect(dialog.getByTestId("report-reference")).toHaveText(/^[A-Za-z0-9]{20}$/);
    const reportId = (await dialog.getByTestId("report-reference").textContent())!;
    const stored = await getFirestore(firebase()).collection("reports").doc(reportId).get();
    expect(stored.data()).toMatchObject({ target: { type: "listing", id: listing.id }, reasonId: "scam", reporter: { uid: expect.any(String) } });
    await dialog.getByRole("button", { name: "Fermer" }).first().click();
    await expect(dialog).toHaveCount(0);

    // The removal's mail link, opened signed out: the statement, then the appeal.
    const { decisionId, token } = await seedDecision(listing.id, seller);
    const visitorContext = await browser.newContext();
    const visitorPage = await visitorContext.newPage();
    visitorPage.on("pageerror", (error) => errors.push(error.message));
    await visitorPage.goto(`/fr/recours?jeton=${encodeURIComponent(token)}`);
    await expect(visitorPage.getByRole("heading", { level: 1, name: "Contester une décision" })).toBeVisible();
    const card = visitorPage.getByTestId("decision-card");
    await expect(card).toHaveAttribute("data-status", "form");
    await expect(card).toContainText("Annonce retirée");
    await expect(card).toContainText("L'annonce présente des signes d'arnaque");
    await expect(card).toContainText("CGU, modération (arnaques)");
    await expect(card).toContainText(decisionId);
    await card.getByRole("button", { name: "Envoyer mon recours" }).click();
    await expect(card.getByText("Expliquez votre recours en 10 caractères au moins.")).toBeVisible();
    await card.getByLabel(/Pourquoi contestez-vous cette décision/).fill("Je n'ai jamais demandé d'acompte : la remise se fait en main propre à Fès.");
    await card.getByRole("button", { name: "Envoyer mon recours" }).click();
    await expect(card.getByRole("status")).toHaveText("Recours envoyé. Nous vous répondrons sous 14 jours.", { timeout: 15_000 });
    await expect(card).toHaveAttribute("data-status", "open");
    await expect(card.getByTestId("appeal-timeline")).toContainText("Recours déposé");

    const decision = (await getFirestore(firebase()).collection("moderationDecisions").doc(decisionId).get()).data();
    expect(decision?.appeal).toMatchObject({ status: "open", by: "affected", text: "Je n'ai jamais demandé d'acompte : la remise se fait en main propre à Fès." });

    // The same link once the appeal is filed: its state, no second form.
    await visitorPage.reload();
    await expect(visitorPage.getByTestId("decision-card")).toHaveAttribute("data-status", "open");
    await expect(visitorPage.getByTestId("appeal-form")).toHaveCount(0);

    expect(errors).toEqual([]);
    await Promise.all([sellerContext.close(), reporterContext.close(), visitorContext.close()]);
  });
});
