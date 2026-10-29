import { randomInt } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Stock import of a Pro shop (Concession pack, design concession/concession.md §4) against the
// Firebase emulators: Pros only, the preview writes nothing, apply creates drafts with their
// fields and updates listings by reference (what the file leaves out stays), refused lines,
// invalid files, the stock list, absent references, and the Pro publish budget.

vi.mock("@/lib/search/queue", () => ({ notifySearchIndex: vi.fn(async () => undefined) }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { DEFAULT_PRICING } from "@/config/pricing";
import { PATCH as patch } from "@/app/api/listings/[id]/route";
import { POST as publish } from "@/app/api/listings/[id]/publish/route";
import { GET as getStock } from "@/app/api/pro/stock/route";
import { POST as postImport } from "@/app/api/pro/stock/import/route";
import type { StockImportResponse, StockListResponse } from "@/lib/contracts/stock-import";
import { getListing } from "@/lib/db/repositories/listings";
import { dayString, moroccoToday } from "@/lib/listings/rental-availability";
import { proProfileRef, proProfileToFirestore } from "@/lib/db/repositories/pro-profiles";
import { COLLECTIONS } from "@/lib/db/schemas";
import { resetServerEnv } from "@/lib/env";
import { db } from "@/lib/firebase/admin";
import { setClaims } from "@/lib/firebase/claims";
import { createSessionForUid } from "@/lib/firebase/session";
import type { ProProfileDoc } from "@/lib/pro/profile-schema";
import { resetRateLimiters } from "@/lib/rate-limit/limiter";
import { csrfToken } from "@/lib/security/csrf";
import { api, member, seedReadyUpload, type ErrorBody, type ListingBody, type Member, type PublishBody } from "../listings/helpers";

beforeAll(() => resetServerEnv());
beforeEach(() => resetRateLimiters());

const PRO_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";
const newProId = () => Array.from({ length: 8 }, () => PRO_ID_ALPHABET[randomInt(PRO_ID_ALPHABET.length)]).join("");
const code = (body: unknown) => (body as ErrorBody).error.code;

/** A verified shop on the Business plan (the stock import's), signed in as its owner. */
async function dealer(extra: Partial<ProProfileDoc> = {}): Promise<Member> {
  const owner = await member({ displayName: "Atlas Auto" });
  const proId = newProId();
  const now = new Date();
  const profile: ProProfileDoc = {
    ownerUid: owner.uid,
    members: { [owner.uid]: "owner" },
    name: "Atlas Auto",
    slug: `atlas-auto-${proId}`,
    description: "Voitures d'occasion contrôlées.",
    whatsapp: false,
    regionCode: "06",
    citySlug: "casablanca",
    legal: { form: "societe", ice: "001234567000089", rc: "12345", if: "1234567" },
    kybc: { status: "verified", iceFormatOk: true, uploadIds: [] },
    lifecycle: "verified",
    plan: "business",
    planSource: "subscription",
    quotas: DEFAULT_PRICING.pro.business,
    createdAt: now,
    updatedAt: now,
    ...extra,
  };
  await proProfileRef(proId).set(proProfileToFirestore(profile));
  await db().collection(COLLECTIONS.users).doc(owner.uid).update({ type: "pro", proId });
  await setClaims(owner.uid, { role: "pro", proId, proRole: "owner" });
  const minted = await createSessionForUid(owner.uid);
  owner.jar.cookies.set("__Host-session", minted.cookie);
  owner.jar.cookies.set("__Host-csrf", csrfToken(minted.cookie));
  return owner;
}

const HEADER = "reference;titre;description;prix;ville;marque;modele;annee;kilometrage;carburant;boite";
const DESCRIPTION = "Dacia Duster entretenu chez le concessionnaire, carnet complet, deux clés, pneus neufs.";
const car = (ref: string, price = "185 000", mileage = "41 000") => `${ref};Dacia Duster ${ref};${DESCRIPTION};${price};Casablanca;Dacia;Duster;2022;${mileage};Diesel;Manuelle`;

const send = (owner: Member, mode: "preview" | "apply", csv: string) => api<StockImportResponse & ErrorBody>(postImport, "POST", "/api/pro/stock/import", { member: owner, body: { mode, csv } });

async function ownerListingCount(uid: string): Promise<number> {
  return (await db().collection(COLLECTIONS.listings).where("ownerUid", "==", uid).count().get()).data().count;
}

describe("POST /api/pro/stock/import", () => {
  it("is for Pro shops only, and refuses a file that is no CSV", async () => {
    const individual = await member();
    expect(code((await send(individual, "preview", `${HEADER}\n${car("A1")}`)).body)).toBe("forbidden");
    const owner = await dealer();
    const broken = await send(owner, "preview", `${HEADER}\n"open`);
    expect(broken.status).toBe(400);
    expect(broken.body.error).toMatchObject({ code: "invalid_csv", details: { reason: "unclosed_quote", line: 2 } });
    expect((await send(owner, "preview", HEADER)).body.error.code).toBe("invalid_csv");
  });

  it("previews without writing, then creates drafts and updates by reference", async () => {
    const owner = await dealer();
    const file = `${HEADER}\n${car("DUS-1")}\n${car("DUS-2")}\n${car("dus-1")}\n${car("BAD").replace("Diesel", "Charbon")}`;
    const preview = await send(owner, "preview", file);
    expect(preview.status).toBe(200);
    expect(preview.body.rows.map((row) => row.action)).toEqual(["create", "create", "error", "error"]);
    expect(preview.body.remaining).toBe(DEFAULT_PRICING.pro.business.activeListings);
    expect(await ownerListingCount(owner.uid)).toBe(0);

    const applied = await send(owner, "apply", file);
    expect(applied.status).toBe(200);
    const [first, second] = applied.body.rows;
    expect(first).toMatchObject({ action: "create", listingId: expect.any(String) });
    const draft = await getListing(first!.listingId!);
    expect(draft).toMatchObject({ status: "draft", sellerType: "pro", subcategoryId: "voitures", categoryId: "vehicules", price: 185000, title: "Dacia Duster DUS-1", location: { citySlug: "casablanca" } });
    expect(draft!.attributes).toMatchObject({ "stock-ref": "DUS-1", "car-brand": "dacia", mileage: 41000 });
    expect(applied.body.remaining).toBe(DEFAULT_PRICING.pro.business.activeListings! - 2);

    // Equipment ticked on the site, then a new file without that column: an update keeps it.
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${second!.listingId}`, { member: owner, body: { attributes: { ...draft!.attributes, "stock-ref": "DUS-2", "car-equipment": ["gps"] } } })).status).toBe(200);
    const again = await send(owner, "apply", `${HEADER}\n${car("DUS-1", "179 000", "42 500")}\n${car("DUS-2")}`);
    expect(again.body.rows.map((row) => [row.action, row.changes ?? []])).toEqual([
      ["update", ["price", "attributes"]],
      ["unchanged", []],
    ]);
    expect(await getListing(first!.listingId!)).toMatchObject({ price: 179000, attributes: { mileage: 42500 } });
    expect((await getListing(second!.listingId!))!.attributes["car-equipment"]).toEqual(["gps"]);
    expect(await ownerListingCount(owner.uid)).toBe(2);

    const stock = await api<StockListResponse>(getStock, "GET", "/api/pro/stock", { member: owner });
    expect(stock.body.listings.map((listing) => [listing.ref, listing.status]).sort()).toEqual([
      ["DUS-1", "draft"],
      ["DUS-2", "draft"],
    ]);
  });

  it("imports a rental fleet with its blocked periods, then changes the periods alone", async () => {
    const owner = await dealer();
    const day = (offset: number) => dayString(moroccoToday(new Date()) + offset);
    const header = "reference;categorie;titre;description;prix;ville;gamme;marque;modele;boite;carburant;kilometrage;indisponible";
    const rental = (ref: string, periods: string) => `${ref};Location de voitures;Dacia Logan ${ref};${DESCRIPTION};300;Marrakech;Berline;Dacia;Logan;Manuelle;Diesel;Illimité;${periods}`;
    const applied = await send(owner, "apply", `${header}\n${rental("LOG-1", `${day(3)}/${day(5)}`)}`);
    expect(applied.body.rows[0]).toMatchObject({ action: "create", issues: [] });
    const id = applied.body.rows[0]!.listingId!;
    const created = await getListing(id);
    expect(created).toMatchObject({ subcategoryId: "location-voitures", attributes: { "stock-ref": "LOG-1", "mileage-policy": "illimite" } });
    expect(created!.rental?.unavailable).toEqual([{ from: day(3), to: day(5) }]);

    const moved = await send(owner, "apply", `${header}\n${rental("LOG-1", `"${day(10)}; ${day(12)}/${day(13)}"`)}`);
    expect(moved.body.rows.map((row) => [row.action, row.changes])).toEqual([["update", ["unavailable"]]]);
    expect((await getListing(id))!.rental?.unavailable).toEqual([
      { from: day(10), to: day(10) },
      { from: day(12), to: day(13) },
    ]);
    expect((await send(owner, "preview", `${header}\n${rental("LOG-1", `"${day(10)}; ${day(12)}/${day(13)}"`)}`)).body.rows[0]!.action).toBe("unchanged");
  });

  it("publishes an imported draft with its photo under the Pro budget, then lists it as absent", async () => {
    const owner = await dealer();
    const applied = await send(owner, "apply", `${HEADER}\n${car("PUB-1")}`);
    const id = applied.body.rows[0]!.listingId!;
    const upload = await seedReadyUpload(owner, id);
    expect((await api<ListingBody>(patch, "PATCH", `/api/listings/${id}`, { member: owner, body: { photos: [upload] } })).status).toBe(200);
    const published = await api<PublishBody>(publish, "POST", `/api/listings/${id}/publish`, { member: owner, body: { acceptRules: true } });
    expect(published.status).toBe(200);
    expect(["published", "pending_review"]).toContain(published.body.status);

    const next = await send(owner, "preview", `${HEADER}\n${car("PUB-2")}`);
    if (published.body.status === "published") expect(next.body.absent.map((listing) => listing.ref)).toEqual(["PUB-1"]);
    expect(next.body.rows[0]!.action).toBe("create");
  });

  it("is for the Business and Premium plans: an Essentiel shop is told to upgrade", async () => {
    const owner = await dealer({ plan: "essentiel", planSource: "launch_offer", quotas: DEFAULT_PRICING.pro.essentiel });
    const preview = await send(owner, "preview", `${HEADER}\n${car("E-1")}`);
    expect(preview.status).toBe(403);
    expect(code(preview.body)).toBe("plan_upgrade_required");
    const stock = await api(getStock, "GET", "/api/pro/stock", { member: owner });
    expect(stock.status).toBe(403);
    expect(code(stock.body)).toBe("plan_upgrade_required");
  });

  it("refuses a suspended shop", async () => {
    const owner = await dealer({ lifecycle: "suspended" });
    expect(code((await send(owner, "preview", `${HEADER}\n${car("S-1")}`)).body)).toBe("pro_not_verified");
  });
});
