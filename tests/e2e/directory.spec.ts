import { expect, test, type APIRequestContext, type Browser } from "@playwright/test";
import { getFirestore } from "firebase-admin/firestore";
import { firebase, randomId, signUpAndIn } from "./helpers";

// The directory of verified shops and agencies (/boutiques, UX journeys counter-review) against
// the production build and the Firebase emulators: a verified shop in Fès, a certified real-estate
// agency in Casablanca, a shop whose owner is suspended and a shop without an owner are written
// straight into the emulator. The directory lists the first two, filters by activity and by city,
// answers in Arabic, hides an empty filter from search engines, is a 404 on an unknown segment, and
// the storefront and the public Pro page link back to it.
process.env.FIREBASE_AUTH_EMULATOR_HOST ??= "127.0.0.1:9099";
process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";

const STATE = { cookies: [], origins: [{ origin: "http://localhost:3100", localStorage: [{ name: "welcome", value: "seen" }, { name: "door", value: "opened" }] }] };

/** Signs a member up in a context of their own and returns their uid. */
async function member(browser: Browser, request: APIRequestContext, email: string, displayName: string): Promise<string> {
  const context = await browser.newContext({ storageState: STATE });
  const page = await context.newPage();
  await signUpAndIn(page, request, email, displayName);
  const { session } = (await (await page.request.get("/api/auth/me")).json()) as { session: { uid: string } };
  await context.close();
  return session.uid;
}

/** A verified shop on the launch offer, as the Pro application leaves it. */
function shopDoc(ownerUid: string, name: string, slug: string, city: { slug: string; region: string }, extra: Record<string, unknown>, now: Date) {
  return {
    ownerUid,
    members: { [ownerUid]: "owner" },
    name,
    slug,
    description: "Caftans, robes et babouches cousus dans notre atelier.\n\nOuvert du lundi au samedi.",
    whatsapp: false,
    regionCode: city.region,
    citySlug: city.slug,
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "essentiel",
    planSource: "launch_offer",
    quotas: { activeListings: 50, listingsPerDay: 20, photosPerListing: 15 },
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
}

const FES = { slug: "fes", region: "03" };
const CASABLANCA = { slug: "casablanca", region: "06" };

test("lists the verified shops by city and activity", async ({ browser, page, request }) => {
  test.setTimeout(300_000);
  const stamp = `${Date.now().toString(36)}${randomId(4)}`.toLowerCase();
  const firestore = getFirestore(firebase());
  const now = new Date();
  const names = { shop: `Maison Lalla ${stamp}`, agency: `Atlas Immo ${stamp}`, suspended: `Souk Fermé ${stamp}`, ghost: `Fantôme ${stamp}` };

  const shopUid = await member(browser, request, `dir-shop-${stamp}@test.joutiya.ma`, "Lalla Test");
  const agencyUid = await member(browser, request, `dir-agency-${stamp}@test.joutiya.ma`, "Atlas Test");
  const suspendedUid = await member(browser, request, `dir-suspended-${stamp}@test.joutiya.ma`, "Karim Test");
  const shopId = randomId(8);
  const agencyId = randomId(8);
  const suspendedId = randomId(8);
  const ghostId = randomId(8);
  const shopSlug = `maison-lalla-${stamp}`;
  await firestore.collection("proProfiles").doc(shopId).set(shopDoc(shopUid, names.shop, shopSlug, FES, {}, now));
  await firestore
    .collection("proProfiles")
    .doc(agencyId)
    .set(shopDoc(agencyUid, names.agency, `atlas-immo-${stamp}`, CASABLANCA, { description: "Appartements et villas à Casablanca.", sector: "real_estate", lifecycle: "active", plan: "business", certified: { at: now, by: agencyUid } }, now));
  await firestore.collection("proProfiles").doc(suspendedId).set(shopDoc(suspendedUid, names.suspended, `souk-ferme-${stamp}`, CASABLANCA, {}, now));
  await firestore.collection("proProfiles").doc(ghostId).set(shopDoc(`ghost-${stamp}`, names.ghost, `fantome-${stamp}`, FES, {}, now));
  await firestore.collection("users").doc(shopUid).update({ proId: shopId, type: "pro", "badges.phoneVerified": true, "stats.activeListings": 3, updatedAt: now });
  await firestore.collection("users").doc(agencyUid).update({ proId: agencyId, type: "pro", "badges.phoneVerified": true, "badges.proCertified": true, updatedAt: now });
  await firestore.collection("users").doc(suspendedUid).update({ proId: suspendedId, type: "pro", "badges.phoneVerified": true, status: "suspended", updatedAt: now });

  // The whole directory: the two shops with their activity, city, badge and listings; the others never.
  await page.goto("/fr/boutiques");
  await expect(page.getByRole("heading", { level: 1, name: "Boutiques et agences vérifiées" })).toBeVisible();
  await expect(page).toHaveTitle(/Annuaire des professionnels/);
  const list = page.getByTestId("directory-list");
  const shopCard = list.locator("li", { hasText: names.shop });
  await expect(shopCard).toContainText("Boutique");
  await expect(shopCard).toContainText("Fès");
  await expect(shopCard).toContainText("Vérifiée");
  await expect(shopCard).toContainText("3 annonces en ligne");
  await expect(shopCard).toContainText("Caftans, robes et babouches cousus dans notre atelier.");
  await expect(shopCard).not.toContainText("Ouvert du lundi");
  await expect(shopCard.getByRole("link", { name: names.shop })).toHaveAttribute("href", `/fr/boutique/${shopSlug}-${shopId}`);
  const agencyCard = list.locator("li", { hasText: names.agency });
  await expect(agencyCard).toContainText("Agence immobilière");
  await expect(agencyCard).toContainText("Casablanca");
  await expect(agencyCard).toContainText("Certifiée");
  await expect(agencyCard).toContainText("Aucune annonce en ligne");
  await expect(list).not.toContainText(names.suspended);
  await expect(list).not.toContainText(names.ghost);

  // By activity, from the chips: the agency only, and the way back to the whole directory.
  await page.getByRole("navigation", { name: "Activités" }).getByRole("link", { name: /^Agences immobilières/ }).click();
  await expect(page).toHaveURL(/\/fr\/boutiques\/activite\/agences-immobilieres$/);
  await expect(page.getByRole("heading", { level: 1, name: "Agences immobilières" })).toBeVisible();
  await expect(page.getByTestId("directory-list")).toContainText(names.agency);
  await expect(page.getByTestId("directory-list")).not.toContainText(names.shop);
  await expect(page.locator("#main").getByRole("link", { name: "Annuaire des boutiques" })).toHaveAttribute("href", "/fr/boutiques");
  await expect(page.getByRole("navigation", { name: "Villes" }).getByRole("link", { name: /^Casablanca/ })).toHaveAttribute("href", "/fr/boutiques/ville/casablanca/activite/agences-immobilieres");

  // By city: the shop only.
  await page.goto("/fr/boutiques/ville/fes");
  await expect(page.getByRole("heading", { level: 1, name: "Boutiques et agences à Fès" })).toBeVisible();
  await expect(page.getByTestId("directory-list")).toContainText(names.shop);
  await expect(page.getByTestId("directory-list")).not.toContainText(names.agency);

  // An empty combination: the empty state, out of the search engines, back to the whole directory.
  await page.goto("/fr/boutiques/ville/fes/activite/location-saisonniere");
  await expect(page.getByRole("heading", { level: 1, name: "Location saisonnière à Fès" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Aucune boutique ici pour le moment" })).toBeVisible();
  await expect(page.locator("#main").getByRole("link", { name: "Voir toutes les boutiques" })).toHaveAttribute("href", "/fr/boutiques");
  await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);

  // Unknown segments are 404s.
  for (const path of ["/fr/boutiques/atlantis", "/fr/boutiques/ville/atlantis", "/fr/boutiques/activite/banques", "/fr/boutiques/activite/boutiques/ville/fes"]) {
    const response = await page.goto(path);
    expect(response?.status(), path).toBe(404);
  }

  // Arabic, right to left.
  await page.goto("/ar/boutiques");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.getByRole("heading", { level: 1, name: "متاجر ووكالات موثّقة" })).toBeVisible();
  await expect(page.getByTestId("directory-list")).toContainText(names.agency);
  await expect(page.getByTestId("directory-list").locator("li", { hasText: names.agency })).toContainText("وكالة عقارية");

  // The storefront and the public Pro page lead back to the directory.
  await page.goto(`/fr/boutique/${shopSlug}-${shopId}`);
  await expect(page.locator("#main").getByRole("link", { name: "Annuaire des boutiques" })).toHaveAttribute("href", "/fr/boutiques");
  await page.goto("/fr/professionnels");
  await expect(page.locator("#main").getByRole("link", { name: /annuaire des boutiques/i })).toHaveAttribute("href", "/fr/boutiques");
});
