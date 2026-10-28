import { randomBytes } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import sharp from "sharp";
import { PASSWORD, firebase, randomId, signUpAndIn } from "./helpers";

// Car rental listing by a Pro agency (rental pack, design location-voitures/location-voitures.md §2)
// against the production build and the emulators: a verified agency (seeded, the application is
// covered by pro.spec.ts) posts a car through the wizard, fills the folded rental terms, is held
// back by the day price rule and the attestation, then publishes and sees its terms on the page.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

/** Auth emulator admin REST (firebase-admin/auth does not load under the Playwright loader here). */
async function authEmulator<T>(action: string, body: unknown): Promise<T> {
  const project = process.env.FIREBASE_PROJECT_ID ?? "demo-joutiya";
  const response = await fetch(`http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/identitytoolkit.googleapis.com/v1/projects/${project}/accounts:${action}`, {
    method: "POST",
    headers: { authorization: "Bearer owner", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.ok, `auth emulator ${action}`).toBe(true);
  return (await response.json()) as T;
}

async function seedAgency(email: string): Promise<void> {
  const app = firebase();
  const { users } = await authEmulator<{ users: { localId: string }[] }>("lookup", { email: [email] });
  const uid = users[0]!.localId;
  const proId = randomId(8);
  const now = new Date();
  await getFirestore(app)
    .collection("proProfiles")
    .doc(proId)
    .set({
      ownerUid: uid,
      members: { [uid]: "owner" },
      name: "Océan Rent",
      slug: `ocean-rent-${proId}`,
      description: "Location de voitures récentes à Marrakech.",
      whatsapp: false,
      regionCode: "07",
      citySlug: "marrakech",
      legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
      kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
      lifecycle: "verified",
      plan: "essentiel",
      planSource: "launch_offer",
      quotas: { activeListings: 50, photosPerListing: 20, listingsPerDay: 25 },
      createdAt: now,
      updatedAt: now,
    });
  await getFirestore(app).collection("users").doc(uid).update({ type: "pro", proId, updatedAt: now });
  await authEmulator("update", { localId: uid, customAttributes: JSON.stringify({ role: "pro", proId, proRole: "owner", v: 2 }) });
}

/** A fresh session carries the new claims (the old one was minted before them). */
async function signInAgain(page: Page, email: string): Promise<void> {
  await page.context().clearCookies();
  await page.goto("/fr/connexion");
  await page.getByLabel("Adresse e-mail").fill(email);
  await page.getByLabel("Mot de passe", { exact: true }).fill(PASSWORD);
  const widget = page.locator("[data-turnstile]");
  if ((await widget.count()) > 0) await expect(widget.first()).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
  await page.getByRole("button", { name: "Se connecter" }).click();
  await expect(page).not.toHaveURL(/connexion/, { timeout: 15_000 });
}

async function photo(): Promise<Buffer> {
  const grid = randomBytes(26 * 19 * 3);
  return sharp(grid, { raw: { width: 26, height: 19, channels: 3 } }).resize(2600, 1950, { kernel: "nearest" }).jpeg({ quality: 90 }).toBuffer();
}

const next = (page: Page) => page.getByRole("button", { name: "Continuer" }).click();

test.describe("Car rental", () => {
  test("an agency posts a car with its rental terms and its attestation", async ({ page, request }) => {
    test.setTimeout(180_000);
    const email = `rental-${randomId(10)}@joutiya.test`;
    const title = `Dacia Logan ou similaire ${randomId(4)}`;
    await signUpAndIn(page, request, email, "Océan Rent");
    await seedAgency(email);
    await signInAgain(page, email);

    await page.goto("/fr/deposer");
    await page.getByRole("radio", { name: "Véhicules" }).click();
    await page.getByRole("radio", { name: "Location de voitures" }).click();
    await expect(page).toHaveURL(/\/fr\/deposer\/[a-z0-9]+\/criteres$/);

    // The vehicle up front, the terms folded under their own heading.
    await page.getByLabel(/Catégorie de véhicule/).selectOption("berline");
    await page.getByLabel(/^Marque/).selectOption("dacia");
    await page.getByRole("textbox", { name: /^Modèle/ }).fill("Logan");
    await page.getByRole("radiogroup", { name: /Boîte/ }).getByRole("radio", { name: "Manuelle" }).click();
    await page.getByRole("radiogroup", { name: /Carburant/ }).getByRole("radio", { name: "Diesel" }).click();
    await page.getByRole("radiogroup", { name: /Kilométrage/ }).getByRole("radio", { name: "Illimité" }).click();
    const terms = page.getByTestId("criteria-rental");
    await terms.getByText("Conditions de location").click();
    await terms.getByRole("radiogroup", { name: /Assurance incluse/ }).getByRole("radio", { name: "Tous risques sans franchise" }).click();
    await terms.getByRole("textbox", { name: /^Caution/ }).fill("4000");
    await terms.getByRole("textbox", { name: /Âge minimum du conducteur/ }).fill("21");
    await terms.getByRole("group", { name: /Remise du véhicule/ }).getByRole("checkbox", { name: "À l'aéroport" }).click();
    await terms.getByRole("textbox", { name: /Prix par jour dès 7 jours/ }).fill("350");
    await page.screenshot({ path: "test-results/rental-wizard-terms.png", fullPage: true });
    await next(page);

    await expect(page).toHaveURL(/\/titre$/);
    await page.getByRole("textbox", { name: /Titre de l'annonce/ }).fill(title);
    await next(page);
    await expect(page).toHaveURL(/\/description$/);
    await page.getByRole("textbox", { name: /^Description/ }).fill("Berline diesel climatisée, kilométrage illimité, remise à l'aéroport Marrakech Menara. Contrat écrit, état des lieux avec photos.");
    await next(page);

    await expect(page).toHaveURL(/\/photos$/);
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: "logan.jpg", mimeType: "image/jpeg", buffer: await photo() });
    await expect(page.getByText("Couverture", { exact: true })).toBeVisible({ timeout: 60_000 });
    await next(page);

    // A rental needs its day price: "à discuter" is not offered.
    await expect(page).toHaveURL(/\/prix$/);
    await page.getByRole("textbox", { name: /^Prix/ }).fill("300");
    await next(page);
    await expect(page).toHaveURL(/\/lieu$/);
    await page.getByRole("combobox", { name: /Ville/ }).fill("Marrak");
    await page.getByRole("option", { name: "Marrakech", exact: true }).click();
    await next(page);
    await expect(page).toHaveURL(/\/contact$/);
    await next(page);

    // Review: the 7-day rate above the day price is listed, then fixed from the criteria step.
    await expect(page).toHaveURL(/\/apercu$/);
    await expect(page.getByText(/tarif longue durée ne peut pas dépasser le prix par jour/)).toBeVisible({ timeout: 15_000 });
    await page.goto(page.url().replace(/apercu$/, "criteres"));
    await page.getByTestId("criteria-rental").getByRole("textbox", { name: /Prix par jour dès 7 jours/ }).fill("260");
    await page.goto(page.url().replace(/criteres$/, "apercu"));
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible({ timeout: 15_000 });

    await page.getByRole("checkbox", { name: /conditions générales d'utilisation/ }).check();
    const attestation = page.getByRole("checkbox", { name: /agrément de location de voitures sans chauffeur/ });
    await page.getByRole("button", { name: "Publier l'annonce" }).click();
    await expect(page.getByText("Confirmez la déclaration de votre agence pour publier une location.")).toBeVisible();
    await attestation.check();
    await page.screenshot({ path: "test-results/rental-review.png", fullPage: true });
    const published = page.waitForResponse((response) => /\/api\/listings\/[a-z0-9]+\/publish$/.test(response.url()) && response.request().method() === "POST");
    await page.getByRole("button", { name: "Publier l'annonce" }).click();
    const answer = (await (await published).json()) as { status: string; slugId: string };
    expect(["published", "pending_review"]).toContain(answer.status);

    if (answer.status === "published") {
      await page.goto(`/fr/annonce/${answer.slugId}`);
      const shown = page.getByTestId("rental-terms");
      await expect(shown.getByTestId("rental-insurance")).toContainText("Tous risques sans franchise");
      await expect(shown.getByTestId("rental-rates")).toContainText(/260\s+DH par jour dès 7 jours/u);
      await expect(page.getByTestId("rental-guide")).toBeVisible();
      await expect(page.getByTestId("rental-availability-freshness")).toHaveText("Disponibilité à confirmer avec l'agence.");

      // The agency blocks three days from "Mes annonces"; the page shows them, now up to date.
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Casablanca" }).format(new Date());
      const day = (offset: number) => new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
      // Days 3 to 5 may fall in next month: the dialog shows this month and the next one.
      await page.goto("/fr/mes-annonces");
      // The title sits in bidi isolates inside the accessible name.
      await page.getByRole("button", { name: /^Disponibilités de « / }).click();
      const dialog = page.getByTestId("availability-dialog");
      await dialog.locator(`button[data-day="${day(3)}"]`).click();
      await expect(dialog.getByText("Touchez maintenant le dernier jour de la période.")).toBeVisible();
      await dialog.locator(`button[data-day="${day(5)}"]`).click();
      await expect(dialog.getByText("1 période bloquée.")).toBeVisible();
      await expect(dialog.locator(`button[data-day="${day(4)}"]`)).toHaveAttribute("aria-pressed", "true");
      await page.screenshot({ path: "test-results/rental-availability-dialog.png" });
      await dialog.getByRole("button", { name: "Enregistrer" }).click();
      await expect(page.getByText("Disponibilités enregistrées.")).toBeVisible();
      await expect(page.getByTestId("owner-availability")).toContainText("Disponibilités à jour");

      await page.goto(`/fr/annonce/${answer.slugId}`);
      const calendar = page.getByTestId("rental-availability");
      await expect(calendar.getByTestId("rental-availability-freshness")).toContainText("Déclarées par l'agence, mises à jour le");
      await expect(calendar.locator(`[data-day="${day(4)}"]`)).toHaveAttribute("data-state", "blocked");
      await expect(calendar.locator(`[data-day="${day(6)}"]`)).toHaveAttribute("data-state", "free");
      await calendar.scrollIntoViewIfNeeded();
      await page.screenshot({ path: "test-results/rental-availability-page.png", fullPage: true });

      // Search by dates (rental pack §4): hidden over a blocked day, found with its estimate after.
      const word = title.split(" ").at(-1)!;
      const found = async (from: number, to: number) => {
        const body = (await (await request.get(`/api/search?sous-categorie=location-voitures&q=${word}&du=${day(from)}&au=${day(to)}`)).json()) as { hits: { id: string }[] };
        return body.hits.length;
      };
      await expect
        .poll(async () => ((await request.post("/api/dev/search/rebuild")).ok() ? found(6, 9) : -1), { timeout: 20_000, message: "rental indexed" })
        .toBe(1);
      expect(await found(4, 6)).toBe(0);
      await page.goto(`/fr/recherche?sous-categorie=location-voitures&q=${word}&du=${day(6)}&au=${day(9)}`);
      await expect(page.locator("#main").getByTestId("rental-dates-bar")).toBeVisible();
      await expect(page.locator("#main").getByTestId("card-rental")).toContainText("pour 3 jours");
      await page.screenshot({ path: "test-results/rental-search-dates.png", fullPage: true });
    }
  });
});
