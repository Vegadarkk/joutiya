import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { PASSWORD, firebase, randomId, signUpAndIn } from "./helpers";

// Emploi (UX/UI pass, PR 14) against the production build and the emulators: a job seeker's ad by
// an individual (eight steps, no amount, no photo, messaging only), a job offer by a Pro (the price
// step in salary words, « Salaire à convenir », the offer's frame on the page) and a second offer
// abroad (the form's notice, then held for a moderator: `work_abroad`); a Pro cannot pick
// « Demandes d'emploi ».
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";

const next = (page: Page) => page.getByRole("button", { name: "Continuer" }).click();
const stepsNav = (page: Page) => page.locator('nav[aria-label="Étapes du dépôt"]');

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

/** The signed-up member becomes the owner of a verified company (the application itself is covered by pro.spec.ts). */
async function seedCompany(email: string): Promise<void> {
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
      name: "Riad Al Bahr",
      slug: `riad-al-bahr-${proId}`,
      description: "Hôtel-restaurant à Essaouira, et sa table d'été en Espagne.",
      whatsapp: false,
      regionCode: "07",
      citySlug: "essaouira",
      legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "12345678" },
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

/** The category and the subcategory; the draft is created on the subcategory pick. */
async function pickSubcategory(page: Page, subcategory: RegExp): Promise<string> {
  const created = page.waitForResponse((response) => response.url().endsWith("/api/listings") && response.request().method() === "POST");
  await page.getByRole("radio", { name: subcategory }).click();
  expect((await created).status()).toBe(201);
  await expect(page).toHaveURL(/\/fr\/deposer\/[a-z0-9]+\/criteres$/);
  return new URL(page.url()).pathname.split("/")[3]!;
}

/** From the review step: the rules, Publish, the result screen (online, or held for a moderator); the answer. */
async function publish(page: Page, listingId: string, expected: "published" | "pending_review" = "published"): Promise<{ slugId: string; flags?: string[] }> {
  await page.getByRole("checkbox", { name: /conditions générales d'utilisation/ }).check();
  const published = page.waitForResponse((response) => response.url().endsWith(`/api/listings/${listingId}/publish`) && response.request().method() === "POST");
  await page.getByRole("button", { name: "Publier l'annonce" }).click();
  const answer = (await (await published).json()) as { status: string; slugId: string; flags?: string[] };
  expect(answer.status).toBe(expected);
  await expect(page.getByRole("heading", { level: 1, name: expected === "published" ? "Votre annonce est en ligne" : "Votre annonce est en cours de vérification" })).toBeVisible();
  return answer;
}

/**
 * A Pro's offer from the criteria step to the review: a seasonal post in catering, in Morocco or
 * abroad (the form's notice follows the place), the texts, no photo, the salary left to agree
 * (the switch starts on and locks the box; off, an amount is grouped as typed; back on, it is dropped).
 */
async function offerSteps(page: Page, input: { title: string; description: string; abroad: boolean }): Promise<void> {
  await page.getByRole("radiogroup", { name: /Type de contrat/ }).getByRole("radio", { name: "Saisonnier" }).click();
  await page.getByLabel(/^Secteur/).selectOption({ label: "Restauration, hôtellerie" });
  await page.getByRole("radiogroup", { name: /Expérience/ }).getByRole("radio", { name: "1 à 3 ans" }).click();
  await page.getByRole("radiogroup", { name: /Mode de travail/ }).getByRole("radio", { name: "Sur place" }).click();
  const abroadNotice = page.getByRole("status").filter({ hasText: "Emploi à l'étranger" });
  await page.getByRole("radiogroup", { name: /Poste situé/ }).getByRole("radio", { name: input.abroad ? "À l'étranger" : "Au Maroc" }).click();
  if (input.abroad) {
    await expect(abroadNotice).toBeVisible();
    await expect(abroadNotice).toContainText("un modérateur vérifie l'offre avant sa mise en ligne");
    await expect(abroadNotice).toContainText("ANAPEC");
  } else {
    await expect(abroadNotice).toHaveCount(0);
  }
  await next(page);

  await expect(page).toHaveURL(/\/titre$/);
  await page.getByRole("textbox", { name: /Titre de l'annonce/ }).fill(input.title);
  await next(page);
  await expect(page).toHaveURL(/\/description$/);
  await page.getByRole("textbox", { name: /^Description/ }).fill(input.description);
  await next(page);
  await expect(page).toHaveURL(/\/photos$/);
  await next(page);

  await expect(page).toHaveURL(/\/prix$/);
  await expect(page.getByRole("heading", { level: 1, name: "Salaire", exact: true })).toBeVisible();
  const salary = page.getByRole("textbox", { name: /Salaire mensuel brut/ });
  const toAgree = page.getByRole("switch", { name: "Salaire à convenir" });
  await expect(toAgree).toBeChecked();
  await expect(salary).toBeDisabled();
  await toAgree.click();
  await expect(salary).toBeEnabled();
  await salary.fill("4500");
  await expect(salary).toHaveValue(/4\s500/);
  await toAgree.click();
  await expect(salary).toBeDisabled();
  await expect(salary).toHaveValue("");
  await next(page);

  await expect(page).toHaveURL(/\/lieu$/);
  await page.getByRole("combobox", { name: /Ville/ }).fill("Essaou");
  await page.getByRole("option", { name: "Essaouira", exact: true }).click();
  await next(page);
  await expect(page).toHaveURL(/\/contact$/);
  await next(page);

  // Review: the salary section says « Salaire à convenir ».
  await expect(page).toHaveURL(/\/apercu$/);
  await expect(page.getByRole("heading", { level: 2, name: input.title })).toBeVisible();
  await expect(page.getByRole("button", { name: "Modifier : Salaire" })).toBeVisible();
  await expect(page.getByText("Salaire à convenir", { exact: true })).toBeVisible();
}

test.describe("Emploi", () => {
  test.setTimeout(180_000);

  test("an individual posts a job-seeker ad: eight steps, no amount, no photo, messaging only", async ({ page, request }) => {
    const id = randomId(6);
    const email = `e2e-emploi-${id}@example.test`;
    const title = `Réceptionniste trilingue ${id}`;
    await signUpAndIn(page, request, email, "Imane Test");

    await page.goto("/fr/deposer");
    await page.getByRole("radio", { name: "Emploi", exact: true }).click();
    const listingId = await pickSubcategory(page, /Demandes d'emploi/);

    // Eight steps: no amount on a job-seeker ad, so no price step.
    await expect(stepsNav(page)).toContainText("Étape 2 sur 8");
    await expect(stepsNav(page)).not.toContainText("Prix");

    // The sector is a select (21 options); the shorter lists are chips.
    await page.getByLabel(/^Secteur/).selectOption({ label: "Restauration, hôtellerie" });
    await page.getByRole("radiogroup", { name: /Expérience/ }).getByRole("radio", { name: "3 à 5 ans" }).click();
    await page.getByRole("radiogroup", { name: /Mobilité/ }).getByRole("radio", { name: "Ma région" }).click();
    await next(page);

    await expect(page).toHaveURL(/\/titre$/);
    await page.getByRole("textbox", { name: /Titre de l'annonce/ }).fill(title);
    await next(page);
    await expect(page).toHaveURL(/\/description$/);
    await page
      .getByRole("textbox", { name: /^Description/ })
      .fill("Trois ans d'expérience à la réception d'hôtels quatre étoiles à Agadir : accueil, réservations et facturation. Arabe, français et anglais courants, disponible immédiatement.");
    await next(page);

    // Photos are optional on a job ad: said on the step, and Continuer goes on with none.
    await expect(page).toHaveURL(/\/photos$/);
    await expect(page.getByText("Les photos sont facultatives pour une annonce d'emploi.")).toBeVisible();
    await next(page);

    // Straight to the place: no price step.
    await expect(page).toHaveURL(/\/lieu$/);
    await page.getByRole("combobox", { name: /Ville/ }).fill("Agad");
    await page.getByRole("option", { name: "Agadir", exact: true }).click();
    await next(page);

    // Contact: the messaging only, the phone switch off and locked.
    await expect(page).toHaveURL(/\/contact$/);
    await expect(page.getByText("les personnes intéressées vous écrivent uniquement par la messagerie Aalan")).toBeVisible();
    await expect(page.getByRole("switch", { name: /Afficher mon numéro sur l'annonce/ })).toBeDisabled();
    await next(page);

    // Review: the title, no amount section, then Publish.
    await expect(page).toHaveURL(/\/apercu$/);
    await expect(page.getByRole("heading", { level: 2, name: title })).toBeVisible();
    await expect(page.getByRole("button", { name: "Modifier : Titre" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Modifier : (Prix|Salaire)/ })).toHaveCount(0);
    await expect(page.getByText("Prix à discuter")).toHaveCount(0);
    const { slugId } = await publish(page, listingId);

    // The public page: the frame of a job-seeker ad, no price, no number, a briefcase for a gallery.
    await page.goto(`/fr/annonce/${slugId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByTestId("listing-price")).toHaveCount(0);
    await expect(page.locator('[data-placeholder="jobs"]')).toContainText("Annonce sans photo");
    const notice = page.getByTestId("job-notice");
    await expect(notice).toHaveAttribute("data-kind", "seeker");
    await expect(notice).toContainText("Aalan n'est ni une agence de placement, ni partie à l'embauche.");
    await expect(notice.getByRole("link", { name: "Règles des annonces d'emploi" })).toHaveAttribute("href", /\/fr\/legal\/cgu/);
    await expect(notice.getByRole("link", { name: "Signaler cette annonce" })).toHaveAttribute("href", "#signaler");
    await expect(page.getByTestId("job-abroad-notice")).toHaveCount(0);
    await expect(page.getByTestId("safety-tips")).toContainText("Ne payez jamais pour postuler");
    await expect(page.getByRole("button", { name: "Voir le numéro" })).toHaveCount(0);
  });

  test("a Pro posts a job offer with the salary to agree, then one abroad that waits for a moderator; job-seeker ads are for individuals", async ({ page, request }) => {
    const id = randomId(6);
    const email = `e2e-emploi-pro-${id}@example.test`;
    const title = `Commis de cuisine, saison à Essaouira ${id}`;
    await signUpAndIn(page, request, email, "Riad Al Bahr");
    await seedCompany(email);
    await signInAgain(page, email);

    await page.goto("/fr/deposer");
    await page.getByRole("radio", { name: "Emploi", exact: true }).click();
    // The job-seeker ads are listed, locked for a Pro.
    const seeker = page.getByRole("radio", { name: /Demandes d'emploi/ });
    await expect(seeker).toHaveAttribute("aria-disabled", "true");
    await expect(seeker).toContainText("Réservé aux particuliers");
    const listingId = await pickSubcategory(page, /Offres d'emploi/);

    // Nine steps, the price step in salary words.
    await expect(stepsNav(page)).toContainText("Étape 2 sur 9");
    await expect(stepsNav(page)).toContainText("Salaire");
    await expect(stepsNav(page)).not.toContainText("Prix");
    await offerSteps(page, {
      title,
      description: "Notre hôtel-restaurant d'Essaouira recrute un commis de cuisine de juin à septembre : contrat saisonnier déclaré, logement fourni, aucun frais demandé au candidat.",
      abroad: false,
    });
    const { slugId } = await publish(page, listingId);

    // The public page: the salary to agree, the offer's frame (no abroad notice: the post is in Morocco), the job safety tips.
    await page.goto(`/fr/annonce/${slugId}`);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText(title);
    await expect(page.getByTestId("listing-price")).toContainText("Salaire à convenir");
    await expect(page.locator('[data-placeholder="jobs"]')).toBeVisible();
    const notice = page.getByTestId("job-notice");
    await expect(notice).toHaveAttribute("data-kind", "offer");
    await expect(notice).toContainText("ni une agence de recrutement, ni partie à l'embauche");
    await expect(page.getByTestId("job-abroad-notice")).toHaveCount(0);
    await expect(page.getByTestId("safety-tips")).toContainText("Ne payez jamais pour postuler");

    // A second offer, for a post in Spain: the form says what the law asks, and the offer waits for a
    // moderator (`work_abroad`) instead of going public.
    await page.goto("/fr/deposer");
    await page.getByRole("radio", { name: "Emploi", exact: true }).click();
    const abroadId = await pickSubcategory(page, /Offres d'emploi/);
    await offerSteps(page, {
      title: `Commis de cuisine, saison en Espagne ${id}`,
      description: "Notre table d'été de Valence recrute un commis de cuisine de juin à septembre : contrat de travail espagnol visé avant le départ, logement fourni, aucun frais demandé au candidat.",
      abroad: true,
    });
    const held = await publish(page, abroadId, "pending_review");
    expect(held.flags).toContain("work_abroad");
  });
});
