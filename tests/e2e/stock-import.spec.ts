import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { BLURHASH, PASSWORD, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Stock import of a car dealer (Concession pack, design concession/concession.md §4) against the
// production build and the emulators: a verified shop (seeded, the application is covered by
// pro.spec.ts) previews a file, imports the valid line, matches photo names, publishes the draft
// once its photo is attached (the media pipeline's work, seeded here), then a new file lists the
// car as absent and the dealer marks it sold.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

const HEADER = "reference;titre;description;prix;ville;marque;modele;annee;kilometrage;carburant;boite";
const DESCRIPTION = "Dacia Duster entretenu chez le concessionnaire, carnet complet, deux clés, pneus neufs.";

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

async function seedShop(email: string): Promise<string> {
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
      name: "Atlas Auto",
      slug: `atlas-auto-${proId}`,
      description: "Voitures d'occasion contrôlées.",
      whatsapp: false,
      regionCode: "06",
      citySlug: "casablanca",
      legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
      kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
      lifecycle: "verified",
      // The stock import comes with the Business and Premium plans.
      plan: "business",
      planSource: "subscription",
      quotas: { activeListings: 250, photosPerListing: 20, listingsPerDay: 100 },
      createdAt: now,
      updatedAt: now,
    });
  await getFirestore(app).collection("users").doc(uid).update({ type: "pro", proId, updatedAt: now });
  await authEmulator("update", { localId: uid, customAttributes: JSON.stringify({ role: "pro", proId, proRole: "owner", v: 2 }) });
  return proId;
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

async function attachSeededPhoto(ref: string): Promise<void> {
  const db = getFirestore(firebase());
  const snapshot = await db.collection("listings").where("attributes.stock-ref", "==", ref).limit(1).get();
  const listing = snapshot.docs[0]!;
  const photoId = `e2estock${randomId(10)}`;
  const size = await storePhoto(listing.id, photoId);
  await listing.ref.update({ photos: [{ id: photoId, ...size, blurhash: BLURHASH }] });
}

test.describe("Stock import", () => {
  test("a dealer imports, publishes and clears a car from a CSV file", async ({ page, request, browser }) => {
    test.setTimeout(120_000);
    const email = `stock-${randomId(10)}@joutiya.test`;
    const ref = `DUS-${randomId(4).toUpperCase()}`;
    await signUpAndIn(page, request, email, "Atlas Auto");
    const proId = await seedShop(email);
    await signInAgain(page, email);

    // Straight to the import: the Pro space links (and so prefetches) the storefront, whose ISR
    // copy would then predate the published car. The shortcut is checked at the end.
    await page.goto("/fr/pro/stock");
    await expect(page.getByRole("heading", { name: "Importer mon stock", level: 1 })).toBeVisible();

    const file = `${HEADER}\n${ref};Dacia Duster 1.5 dCi;${DESCRIPTION};185 000;Casablanca;Dacia;Duster;2022;41 000;Diesel;Manuelle\nBAD-1;Logan;${DESCRIPTION};90000;Atlantis;Dacia;Logan;2019;90000;Charbon;Manuelle\n`;
    await page.locator('input[type="file"][accept*=".csv"]').setInputFiles({ name: "stock.csv", mimeType: "text/csv", buffer: Buffer.from(file) });
    const preview = page.getByTestId("stock-preview");
    await expect(preview.getByText("Nouveau")).toBeVisible({ timeout: 15_000 });
    await expect(preview.getByText("À corriger")).toBeVisible();
    await expect(preview.getByText(/carburant : valeur non reconnue/)).toBeVisible();
    await expect(preview.getByText(/ville : ville inconnue/)).toBeVisible();
    await page.screenshot({ path: "test-results/stock-preview.png", fullPage: true });

    await page.getByRole("button", { name: "Importer 1 ligne" }).click();
    await expect(page.getByText("Import terminé : 1 brouillon créé, 0 annonce mise à jour.")).toBeVisible({ timeout: 15_000 });

    // Photo names are matched to the reference in the browser.
    await page.locator('input[type="file"][multiple]').setInputFiles([
      { name: `${ref}-1.jpg`, mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff]) },
      { name: "vacances.jpg", mimeType: "image/jpeg", buffer: Buffer.from([0xff, 0xd8, 0xff]) },
    ]);
    await expect(page.getByTestId("stock-photos").getByText("1 photo reconnue pour 1 annonce")).toBeVisible();
    await expect(page.getByText(/1 fichier ne correspond à aucune référence : vacances\.jpg/)).toBeVisible();
    await page.getByRole("button", { name: "Vider la sélection" }).click();

    await attachSeededPhoto(ref);
    await page.reload();
    await expect(page.getByText("1 brouillon prêt, 0 sans photo.")).toBeVisible({ timeout: 15_000 });
    await page.getByRole("checkbox", { name: /Je confirme que ces annonces respectent/ }).check();
    await page.getByRole("button", { name: "Publier 1 brouillon" }).click();
    await expect(page.getByText(/^(1 annonce en ligne|0 annonce en ligne, 1 en vérification)/)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: "test-results/stock-published.png", fullPage: true });

    // Once online, the storefront sums the dealer's vehicles, each chip a search of the shop.
    if ((await page.getByText(/^1 annonce en ligne/).count()) > 0) {
      await page.goto(`/fr/boutique/atlas-auto-${proId}`);
      const dealer = page.getByTestId("dealer-stock");
      await expect(dealer.getByText("1 véhicule en vente")).toBeVisible({ timeout: 15_000 });
      await expect(dealer.getByRole("link", { name: /Dacia/ })).toHaveAttribute("href", /boutique=.*f-car-brand=dacia/);
      await page.screenshot({ path: "test-results/stock-storefront.png", fullPage: true });
      // A visitor sees the test drive request next to the message button.
      const visitor = await browser.newPage();
      await visitor.goto(page.url());
      await visitor.getByRole("link", { name: /Dacia Duster/ }).first().click();
      await expect(visitor.getByRole("button", { name: "Demander un essai" }).first()).toBeVisible({ timeout: 15_000 });
      await visitor.screenshot({ path: "test-results/stock-test-drive.png", fullPage: true });
      await visitor.close();
      await page.goBack();
    }

    // A new file without the car: it is offered as sold, never removed on its own.
    await page.locator('input[type="file"][accept*=".csv"]').setInputFiles({
      name: "stock-2.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(`${HEADER}\nCLIO-1;Renault Clio 5;${DESCRIPTION};140000;Rabat;Renault;Clio;2021;30000;Essence;Manuelle\n`),
    });
    await expect(preview.getByText("Nouveau")).toBeVisible({ timeout: 15_000 });
    const absent = page.getByTestId("stock-absent");
    if ((await absent.count()) > 0) {
      await expect(absent.getByText(ref)).toBeVisible();
      await absent.getByRole("button", { name: "Marquer vendu" }).click();
      await expect(absent.getByText("Vendu")).toBeVisible({ timeout: 15_000 });
    }
    await page.screenshot({ path: "test-results/stock-absent.png", fullPage: true });

    await page.goto("/fr/pro");
    await page.getByRole("link", { name: "Importer mon stock" }).click();
    await expect(page.getByRole("heading", { name: "Importer mon stock", level: 1 })).toBeVisible();
  });
});
