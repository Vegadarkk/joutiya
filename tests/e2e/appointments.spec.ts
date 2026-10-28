import { expect, test, type Page } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { isolate } from "../../src/lib/i18n/bidi";
import { BLURHASH, firebase, randomId, signUpAndIn, storePhoto } from "./helpers";

// Appointments in messaging (architecture §5, 28 Oct) against the production build and the
// emulators: the buyer writes about a listing, opens the slot picker from the thread
// (`?rdv=visit`), proposes two slots with a place; the seller sees the card, picks one and
// confirms; both see the confirmed door and the steps in the thread. No Valkey: the threads poll.
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

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
  const title = `Appartement Maârif ${id}`;
  const slugId = `appartement-maarif-casablanca-${id}`;
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
      price: 2400,
      priceNegotiable: true,
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
      description: "Grand tapis tissé main, laine naturelle, à voir sur place à Casablanca.",
      photos: [{ id: photoId, ...size, blurhash: BLURHASH }],
      adsEligible: true,
      publishedAt: now,
      expiresAt: new Date(now.getTime() + 60 * 86_400_000),
    });
  return { slugId, title };
}

const shots = process.env.APPOINTMENT_SCREENSHOTS;
async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png`, fullPage: false });
}

test.describe("appointments", () => {
  test.setTimeout(180_000);

  test("the buyer proposes two slots, the seller confirms one, both see the confirmed appointment", async ({ browser, request }) => {
    const stamp = `${Date.now().toString(36)}${randomId(4)}`;
    const sellerContext = await browser.newContext();
    const buyerContext = await browser.newContext();
    const sellerPage = await sellerContext.newPage();
    const buyerPage = await buyerContext.newPage();
    const errors: string[] = [];
    for (const page of [sellerPage, buyerPage]) page.on("pageerror", (error) => errors.push(error.message));

    await signUpAndIn(sellerPage, request, `e2e-rdv-seller-${stamp}@test.joutiya.ma`, "Salma Vendeuse");
    await signUpAndIn(buyerPage, request, `e2e-rdv-buyer-${stamp}@test.joutiya.ma`, "Youssef Acheteur");
    const seller = await session(sellerPage);
    const listing = await seedListing(seller);

    await buyerPage.goto(`/fr/annonce/${listing.slugId}`);
    await buyerPage.getByTestId("contact-bar").getByRole("button", { name: "Envoyer un message" }).click();
    const first = buyerPage.getByRole("dialog", { name: `Écrire à ${isolate(seller.displayName)}` });
    await first.getByLabel("Votre message").fill(`Bonjour, je peux passer le voir ? ${stamp}`);
    await expect(first.locator("[data-turnstile]")).toHaveAttribute("data-turnstile", "ready", { timeout: 20_000 });
    await first.getByRole("button", { name: "Envoyer le message" }).click();
    await expect(buyerPage).toHaveURL(/\/fr\/messages\/[A-Za-z0-9_-]{22}$/, { timeout: 20_000 });
    const cid = new URL(buyerPage.url()).pathname.split("/").at(-1)!;

    // The entry point of the packs: ?rdv=visit opens the picker with that kind, then the parameter goes.
    await buyerPage.goto(`/fr/messages/${cid}?rdv=visit`);
    const picker = buyerPage.getByTestId("appointment-dialog");
    await expect(picker).toBeVisible({ timeout: 15_000 });
    await expect(buyerPage).toHaveURL(new RegExp(`/fr/messages/${cid}$`));
    await expect(picker.getByRole("radio", { name: "Visite" })).toBeChecked();
    // Tomorrow, two start times.
    await picker.getByTestId("slot-day").nth(1).click();
    const times = picker.getByTestId("slot-times");
    await times.getByRole("button", { name: "10:00" }).click();
    await times.getByRole("button", { name: "16:30" }).click();
    await picker.getByLabel("Lieu (facultatif)").fill("Café du parc, Maârif");
    await expect(picker.getByTestId("slot-picked").getByRole("listitem")).toHaveCount(2);
    await shot(buyerPage, "1-picker-desktop");
    await picker.getByRole("button", { name: "Proposer 2 créneaux" }).click();
    await expect(picker).toBeHidden({ timeout: 15_000 });
    const mine = buyerPage.getByTestId("appointment-card");
    await expect(mine).toHaveAttribute("data-status", "proposed-mine");
    await expect(buyerPage.getByTestId("appointment-event").first()).toContainText("Vous avez proposé une visite", { timeout: 15_000 });
    await shot(buyerPage, "2-proposed-buyer");

    // The seller picks the 16:30 slot and confirms.
    await sellerPage.goto(`/fr/messages/${cid}`);
    const card = sellerPage.getByTestId("appointment-card");
    await expect(card).toHaveAttribute("data-status", "proposed-theirs", { timeout: 15_000 });
    await expect(card).toContainText("Café du parc, Maârif");
    await expect(card.getByTestId("appointment-slot")).toHaveCount(2);
    await shot(sellerPage, "3-proposed-seller");
    await card.getByTestId("appointment-slot").filter({ hasText: "16:30" }).click();
    await card.getByTestId("appointment-confirm").click();
    await expect(card).toHaveAttribute("data-status", "confirmed", { timeout: 15_000 });
    await expect(card).toContainText("Visite confirmée");
    await expect(card).toContainText("16:30");
    await shot(sellerPage, "4-confirmed-seller");

    // The buyer's open thread follows (polling), and the inbox row names the step.
    await expect(buyerPage.getByTestId("appointment-card")).toHaveAttribute("data-status", "confirmed", { timeout: 40_000 });
    await expect(buyerPage.getByTestId("appointment-event").filter({ hasText: "a confirmé une visite" })).toBeVisible();
    await buyerPage.setViewportSize({ width: 360, height: 780 });
    await shot(buyerPage, "5-confirmed-buyer-mobile");
    expect(await buyerPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    expect(errors).toEqual([]);
    await sellerContext.close();
    await buyerContext.close();
  });
});
