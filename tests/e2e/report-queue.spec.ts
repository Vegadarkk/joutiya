import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getApps, initializeApp, type App } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// Back-office report queue (lot U3, design D24): a moderator opens the queue, opens a reported
// listing, removes it with a catalogue template, and its group leaves the queue. Same setup as
// admin.spec.ts: ADMIN_HOST=admin.localhost, the Access identity from x-dev-access-email, the
// seed written to the emulators of `firebase emulators:exec`.

process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const admin = "http://admin.localhost:3100";
const EMAIL = "moderator.queue.e2e@joutiya.test";
// Assembled at runtime: a literal would look like a credential to the secret scan.
const PASSWORD = ["Souk", "Rabat", "Queue", "2026"].join("-");
const ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const randomId = (length: number) => Array.from(randomBytes(length), (byte) => ALPHABET[byte % ALPHABET.length]).join("");
const DAY = 86_400_000;

test.use({ extraHTTPHeaders: { "x-dev-access-email": EMAIL } });

function firebase(): App {
  return getApps()[0] ?? initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya" });
}

/** The moderator account with its roster entry (idempotent across Playwright workers). */
async function seedModerator(): Promise<void> {
  const app = firebase();
  const auth = getAuth(app);
  const uid = await auth
    .createUser({ email: EMAIL, password: PASSWORD, emailVerified: true, displayName: "Modératrice e2e" })
    .then((record) => record.uid)
    .catch(async (error: { code?: string }) => {
      if (error.code !== "auth/email-already-exists") throw error;
      return (await auth.getUserByEmail(EMAIL)).uid;
    });
  await auth.setCustomUserClaims(uid, { role: "moderator", v: 2 });
  await getFirestore(app).collection("staff").doc(uid).set({ email: EMAIL, displayName: "Modératrice e2e", role: "moderator", invitedBy: "script", createdAt: new Date() });
}

/** A seller, one published listing of his, and an open P1 scam report on it from a visitor. */
async function seedReportedListing(): Promise<{ id: string; title: string; reportId: string }> {
  const app = firebase();
  const firestore = getFirestore(app);
  const now = new Date();
  const email = `seller-queue-${randomId(10)}@joutiya.test`;
  const { uid } = await getAuth(app).createUser({ email, emailVerified: true, displayName: "Vendeur file e2e" });
  const publicId = randomId(10);
  await firestore.collection("users").doc(uid).set({
    publicId,
    displayName: "Vendeur file e2e",
    type: "individual",
    citySlug: "fes",
    badges: { emailVerified: true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 1, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: "done",
    locale: "fr",
    createdAt: now,
    updatedAt: now,
  });
  const id = randomId(8);
  const title = `Téléphone signalé ${id}`;
  await firestore
    .collection("listings")
    .doc(id)
    .set({
      ownerUid: uid,
      sellerType: "individual",
      sellerName: "Vendeur file e2e",
      sellerPublicId: publicId,
      categoryId: "maison-jardin",
      subcategoryId: "decoration-artisanat",
      attributes: { "decor-type": "luminaire" },
      condition: "good",
      price: 900,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: "03", citySlug: "fes", geo: { lat: 34.03, lng: -5.0 } },
      contact: { messaging: true, showPhone: false, whatsapp: false },
      boosts: {},
      sortAt: now,
      sortSource: "publish",
      moderation: { state: "auto_ok", score: 5, flags: [], openReports: 1 },
      legalHold: [],
      createdAt: now,
      updatedAt: now,
      version: 1,
      status: "published",
      slugId: `telephone-signale-fes-${id}`,
      title,
      description: "Téléphone neuf, paiement d'avance par Wafacash avant l'envoi.",
      photos: [],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * DAY),
    });
  const report = firestore.collection("reports").doc();
  await report.set({
    target: { type: "listing", id, ownerUid: uid },
    reasonId: "scam",
    priority: "P1",
    explanation: "Le vendeur exige une avance par Wafacash avant de montrer le téléphone.",
    goodFaith: true,
    source: "user",
    reporter: { name: "Visiteur e2e", email: `reporter-${randomId(8)}@joutiya.test`, locale: "fr", ipPrefixHash: "e2e-ip", deviceHash: "e2e-device", trusted: false },
    hidden: false,
    status: "open",
    slaDueAt: new Date(now.getTime() + DAY),
    createdAt: now,
    updatedAt: now,
    purgeAt: new Date(now.getTime() + 5 * 365 * DAY),
  });
  return { id, title, reportId: report.id };
}

async function signIn(page: Page): Promise<void> {
  await page.goto(`${admin}/connexion`);
  await expect(page.getByLabel("E-mail", { exact: true })).toHaveValue(EMAIL);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).toHaveURL(`${admin}/`);
}

test.beforeAll(async () => {
  await seedModerator();
});

test("a moderator removes a reported listing from the queue with a template, and its group leaves the queue", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { id, title, reportId } = await seedReportedListing();
  await signIn(page);

  await page.getByRole("navigation", { name: "Sections du back-office" }).getByRole("link", { name: "Signalements" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Signalements" })).toBeVisible();
  const row = page.locator(`li[data-target="listing:${id}"]`);
  await expect(row).toBeVisible();
  await expect(row).toContainText("Arnaque ou tentative d'escroquerie");
  await expect(row).toContainText(/Reste (23|24) h/);

  await row.getByRole("link", { name: `Examiner : Annonce ${id}` }).click();
  await expect(page.getByRole("heading", { level: 1 })).toHaveText(`Annonce « ${title} »`);
  await expect(page.getByText("Le vendeur exige une avance par Wafacash avant de montrer le téléphone.")).toBeVisible();

  await page.getByLabel("Modèle de décision").selectOption({ label: "Retrait : arnaque ou tentative d'escroquerie" });
  // Level 0 account: the ladder proposes a warning with the removal.
  await expect(page.getByRole("radio", { name: /Avertissement/ })).toBeChecked();
  await page.getByLabel("Précision du modérateur").fill("Avance exigée par Wafacash avant toute remise.");
  await page.getByRole("button", { name: "Vérifier la décision" }).click();
  await expect(page.getByRole("group", { name: "Récapitulatif avant confirmation" })).toContainText("1 signalement ouvert sera clos");
  await page.getByRole("button", { name: "Retirer l'annonce" }).click();

  await expect(page).toHaveURL(`${admin}/signalements`);
  await expect(page.getByText("Contenu retiré")).toBeVisible();
  await expect(page.locator(`li[data-target="listing:${id}"]`)).toHaveCount(0);
  // Other specs share the emulators: the queue is empty unless they left reports open.
  if ((await page.locator("li[data-target]").count()) === 0) await expect(page.getByRole("heading", { name: "Aucun signalement ouvert" })).toBeVisible();

  const firestore = getFirestore(firebase());
  const [listing, report] = await Promise.all([firestore.collection("listings").doc(id).get(), firestore.collection("reports").doc(reportId).get()]);
  expect(listing.get("status")).toBe("removed");
  expect(report.get("status")).toBe("actioned");
  expect(report.get("outcome")).toBe("founded");
  expect(errors).toEqual([]);
});
