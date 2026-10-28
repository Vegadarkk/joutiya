import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { PASSWORD, firebase, randomId, signUpAndIn } from "./helpers";

// Produits du terroir (owner decision of 2026-10-28) against the production build and the
// emulators: a verified cooperative (seeded, the application is covered by pro.spec.ts) picks
// « Miel », the ONSSA number is typed upper case, a malformed one is refused on its field before
// anything is sent, a well-formed one opens the next step.
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

async function seedCooperative(email: string): Promise<void> {
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
      name: "Coopérative Tifawt",
      slug: `tifawt-${proId}`,
      description: "Huile d'argan, huile d'olive et miel.",
      whatsapp: false,
      regionCode: "07",
      citySlug: "essaouira",
      legal: { form: "cooperative", ice: "001234567000089", coopNumber: "12/2019" },
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

test.describe("Produits du terroir", () => {
  test("a cooperative lists honey with its ONSSA number", async ({ page, request }) => {
    const email = `e2e-terroir-${randomId(8)}@example.test`;
    await signUpAndIn(page, request, email, "Coopérative Tifawt");
    await seedCooperative(email);
    await signInAgain(page, email);

    await page.goto("/fr/deposer");
    await page.getByRole("radio", { name: "Produits du terroir" }).click();
    await page.getByRole("radio", { name: "Miel" }).click();
    await expect(page).toHaveURL(/\/fr\/deposer\/[a-z0-9]+\/criteres$/);

    const number = page.getByRole("textbox", { name: /ONSSA/ });
    await number.fill("m.07.113.2");
    await expect(number).toHaveValue("M.07.113.2");
    await page.getByLabel(/Variété de miel/).selectOption({ label: "Thym (zaatar)" });
    await page.getByRole("button", { name: "Continuer" }).click();
    await expect(page.getByText("Format attendu : lettres, province, numéro et année séparés par des points, par exemple M.07.113.20.")).toBeVisible();
    await expect(page).toHaveURL(/\/criteres$/);

    await number.fill("m.07.113.20");
    await expect(number).toHaveValue("M.07.113.20");
    await page.getByRole("button", { name: "Continuer" }).click();
    await expect(page).toHaveURL(/\/fr\/deposer\/[a-z0-9]+\/titre$/);
  });
});
