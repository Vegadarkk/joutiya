import { expect, test, type Page } from "@playwright/test";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { isolate } from "../../src/lib/i18n/bidi";
import { BLURHASH, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Verified reviews (vitrine-avis §2) against the production build and the Firebase emulators
// (npm run test:e2e): a buyer writes to a seller, the seller answers, and once the 24 h delay has
// passed (the reply's date moved back in the emulator) the thread invites the buyer to review. The
// review shows on the seller's storefront with its average; the seller answers it once from "Mes
// avis"; the buyer deletes it from theirs.

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

async function seedListing(owner: Member): Promise<{ slugId: string; title: string }> {
  const now = new Date();
  const id = randomId(8);
  const title = `Lampe en laiton ${id}`;
  const slugId = `lampe-en-laiton-casablanca-${id}`;
  const photoId = `e2ephoto${randomId(8)}`;
  const size = await storePhoto(id, photoId);
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
      attributes: { "decor-type": "tapis" },
      condition: "very_good",
      price: 650,
      priceNegotiable: false,
      isDonation: false,
      location: { regionCode: "06", citySlug: "casablanca", geo: { lat: 33.57, lng: -7.59 } },
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
      description: "Lampe ciselée à la main par un artisan de Fès, laiton massif, hauteur 45 cm.",
      photos: [{ id: photoId, ...size, blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  return { slugId, title };
}

test.describe("verified reviews", () => {
  test.setTimeout(240_000);

  test("the buyer reviews after the exchange, the seller answers, the buyer deletes", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const buyerPage = await buyerContext.newPage();
    const errors: string[] = [];
    for (const page of [sellerPage, buyerPage]) page.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-avis-vendeur-${stamp}@test.joutiya.ma`, "Salma Vendeuse");
    await signUpAndIn(buyerPage, request, `e2e-avis-acheteur-${stamp}@test.joutiya.ma`, "Youssef Acheteur");
    const seller = await session(sellerPage);
    const listing = await seedListing(seller);

    // The buyer writes; no invitation before the seller answers.
    await buyerPage.goto(`/fr/annonce/${listing.slugId}`);
    await buyerPage.getByTestId("contact-bar").getByRole("button", { name: "Envoyer un message" }).click();
    const first = buyerPage.getByRole("dialog", { name: `Écrire à ${isolate(seller.displayName)}` });
    await expect(first).toBeVisible({ timeout: 15_000 });
    await first.getByLabel("Votre message").fill(`Bonjour, la lampe est-elle disponible ? ${stamp}`);
    await expect(first.locator("[data-turnstile]")).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
    await first.getByRole("button", { name: "Envoyer le message" }).click();
    await expect(buyerPage).toHaveURL(/\/fr\/messages\/[A-Za-z0-9_-]{22}$/, { timeout: 20_000 });
    const cid = new URL(buyerPage.url()).pathname.split("/").at(-1)!;
    await expect(buyerPage.getByTestId("review-prompt")).toHaveCount(0);

    // The seller answers.
    await sellerPage.goto(`/fr/messages/${cid}`);
    await sellerPage.getByTestId("composer").getByLabel("Votre message").fill("Oui, passez demain à 18 h.");
    await sellerPage.getByTestId("composer").getByRole("button", { name: "Envoyer", exact: true }).click();
    await expect(sellerPage.getByTestId("thread").getByText("Oui, passez demain à 18 h.")).toBeVisible({ timeout: 15_000 });
    await expect(sellerPage.getByTestId("review-prompt")).toHaveCount(0);

    // Still too early for the buyer; two days later the thread invites them.
    await buyerPage.reload();
    await expect(buyerPage.getByTestId("thread").getByText("Oui, passez demain à 18 h.")).toBeVisible({ timeout: 15_000 });
    await expect(buyerPage.getByTestId("review-prompt")).toHaveCount(0);
    await getFirestore(firebase()).collection("conversations").doc(cid).update({ sellerRepliedAt: Timestamp.fromMillis(Date.now() - 2 * 86_400_000) });
    await buyerPage.reload();
    const prompt = buyerPage.getByTestId("review-prompt");
    await expect(prompt).toContainText(`Comment s'est passé votre échange avec ${isolate(seller.displayName)} ?`, { timeout: 15_000 });
    await prompt.getByRole("button", { name: "Donner mon avis" }).click();

    const dialog = buyerPage.getByTestId("review-dialog");
    await expect(dialog.getByRole("heading", { name: `Votre avis sur ${isolate(seller.displayName)}` })).toBeVisible({ timeout: 15_000 });
    // Nothing is sent before the note, the text and the statement are there.
    await dialog.getByRole("button", { name: "Publier mon avis" }).click();
    await expect(dialog.getByText("Choisissez une note.")).toBeVisible();
    await expect(dialog.getByText("Cochez cette case pour confirmer l'échange.")).toBeVisible();
    await dialog.locator("label").filter({ hasText: "4 étoiles sur 5" }).click();
    await expect(dialog.getByRole("radio", { name: "4 étoiles sur 5" })).toBeChecked();
    await expect(dialog.getByText("Bien", { exact: true })).toBeVisible();
    const text = dialog.getByLabel("Votre avis");
    await text.fill("Très bon contact, appelez-moi au 06 12 34 56 78");
    await expect(dialog.getByText("Retirez le numéro de téléphone")).toBeVisible();
    const review = `Vendeuse ponctuelle et aimable, la lampe était conforme aux photos. ${stamp}`;
    await text.fill(review);
    await dialog.getByRole("checkbox", { name: "Nous avons conclu un échange ou une rencontre" }).check();
    await dialog.getByRole("button", { name: "Publier mon avis" }).click();
    await expect(dialog.getByRole("heading", { name: "Merci, votre avis est publié" })).toBeVisible({ timeout: 15_000 });
    await dialog.getByRole("link", { name: "Voir la vitrine" }).click();

    // The storefront shows the review, its average and the verified mark.
    await expect(buyerPage).toHaveURL(new RegExp(`/fr/profil/${seller.publicId}#avis$`), { timeout: 15_000 });
    const block = buyerPage.getByTestId("seller-reviews");
    await expect(block.getByRole("heading", { level: 2, name: "Avis (1)" })).toBeVisible();
    await expect(block.getByTestId("rating-average")).toHaveText("4,0");
    await expect(block.getByTestId("review")).toContainText(review);
    await expect(block.getByTestId("review")).toContainText("Échange vérifié");
    await expect(buyerPage.getByTestId("profile-header").getByTestId("rating-link")).toContainText("1 avis vérifié");

    // The conversation no longer invites the buyer.
    await buyerPage.goto(`/fr/messages/${cid}`);
    await expect(buyerPage.getByTestId("thread").getByText("Oui, passez demain à 18 h.")).toBeVisible({ timeout: 15_000 });
    await expect(buyerPage.getByTestId("review-prompt")).toHaveCount(0);

    // The seller answers once from "Mes avis".
    await sellerPage.goto("/fr/mes-avis");
    const received = sellerPage.getByTestId("my-review");
    await expect(received).toContainText(review, { timeout: 15_000 });
    await expect(received).toContainText(`De ${isolate("Youssef Acheteur")}`);
    await received.getByRole("button", { name: "Répondre" }).click();
    await received.getByLabel("Votre réponse publique").fill("Merci Youssef, bonne lecture à la lumière de la lampe !");
    await received.getByRole("button", { name: "Publier la réponse" }).click();
    await expect(sellerPage.getByText("Réponse publiée")).toBeVisible();
    await expect(received).toContainText("Votre réponse");
    await expect(received.getByRole("button", { name: "Répondre" })).toHaveCount(0);

    // The seller may also report the review from the storefront (art. 16 DSA).
    await sellerPage.goto(`/fr/profil/${seller.publicId}#avis`);
    await sellerPage.getByTestId("review").getByRole("button", { name: "Signaler l'avis" }).click();
    const notice = sellerPage.getByTestId("report-dialog");
    await expect(notice.getByRole("heading", { name: "Signaler cet avis" })).toBeVisible({ timeout: 15_000 });
    await expect(notice).toContainText(`Avis de ${isolate("Youssef Acheteur")}`);
    await expect(notice.getByTestId("reason-illegal_item")).toHaveCount(0);
    await notice.getByTestId("reason-fake_review").click();
    await notice.getByRole("button", { name: "Continuer" }).click();
    await expect(notice.getByTestId("report-reason")).toHaveText("Avis faux ou sans rapport avec l'échange");
    await notice.getByLabel(/Ce que vous avez constaté/).fill(`Je n'ai jamais rencontré cet acheteur, l'avis décrit une autre vente. ${stamp}`);
    await notice.getByRole("checkbox", { name: /Je déclare de bonne foi/ }).check();
    await notice.getByRole("button", { name: "Envoyer le signalement" }).click();
    await expect(notice.getByRole("heading", { name: "Signalement envoyé" })).toBeVisible({ timeout: 15_000 });
    await notice.getByRole("button", { name: "Fermer" }).first().click();

    // The buyer sees the reply and deletes the review.
    await buyerPage.goto("/fr/mes-avis");
    await buyerPage.getByRole("tab", { name: "Donnés" }).click();
    const given = buyerPage.getByTestId("my-review");
    await expect(given).toContainText(`Pour ${isolate(seller.displayName)}`, { timeout: 15_000 });
    await expect(given).toContainText("Merci Youssef");
    await given.getByRole("button", { name: "Supprimer mon avis" }).click();
    await buyerPage.getByRole("dialog").getByRole("button", { name: "Supprimer", exact: true }).click();
    await expect(buyerPage.getByText("Avis supprimé")).toBeVisible();
    await expect(buyerPage.getByText("Vous n'avez pas encore donné d'avis")).toBeVisible();

    await buyerPage.goto(`/fr/profil/${seller.publicId}`);
    await expect(buyerPage.getByTestId("seller-reviews")).toContainText("Pas encore d'avis");

    expect(errors).toEqual([]);
    await sellerContext.close();
    await buyerContext.close();
  });
});
