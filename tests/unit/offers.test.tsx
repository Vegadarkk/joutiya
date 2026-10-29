import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { threadHref } from "@/components/listing/contact-bar";
import { previewText } from "@/components/messages/inbox";
import { canOffer, requestedOffer } from "@/components/messages/thread-view";
import { amountProblem, suggestedAmounts } from "@/components/offers/amount-field";
import { OfferCard, offerCardShown } from "@/components/offers/offer-card";
import { OfferEventItem } from "@/components/offers/offer-event";
import { RATE_LIMITS } from "@/config/rate-limits";
import {
  OFFER_TTL_MS,
  offerActionSchema,
  offerBounds,
  offerEventOf,
  offerFinalAmount,
  offerMarker,
  offerPending,
  offerProblem,
  offerReferencePrice,
  offerStatusAt,
  startConversationOfferSchema,
  type OfferView,
} from "@/lib/contracts/offers";
import type { OfferDoc } from "@/lib/db/schemas";
import { HttpError } from "@/lib/http/errors";
import { offerAllowed } from "@/lib/offers/eligibility";
import { nextOfferStep } from "@/lib/offers/service";
import { offerView } from "@/lib/offers/views";

// Price offers (Carte vivante lot 5): the bounds, the step machine of the server, the 48 h expiry,
// which listings take offers, the limits, and the card and thread steps in FR and AR.

const NOW = Date.UTC(2026, 10, 4, 9);
const HOUR = 60 * 60 * 1000;

function render(node: React.ReactNode, locale: "fr" | "ar" = "fr"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "fr" ? fr : ar} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

function offerDoc(overrides: Partial<OfferDoc> = {}): OfferDoc {
  return { id: "AbCdEfGhIjKl", status: "open", amount: 900, price: 1000, createdAt: new Date(NOW), updatedAt: new Date(NOW), expiresAt: new Date(NOW + OFFER_TTL_MS), ...overrides };
}

const thrown = (run: () => unknown): HttpError => {
  try {
    run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  throw new Error("expected an HttpError");
};

describe("bounds", () => {
  it("takes whole dirhams from 30 % of the price (rounded up) to the price", () => {
    expect(offerBounds(1000)).toEqual({ min: 300, max: 1000 });
    expect(offerBounds(999)).toEqual({ min: 300, max: 999 });
    expect(offerBounds(1)).toEqual({ min: 1, max: 1 });
    expect(offerProblem(300, 1000)).toBeNull();
    expect(offerProblem(1000, 1000)).toBeNull();
    expect(offerProblem(299, 1000)).toBe("too_low");
    expect(offerProblem(1001, 1000)).toBe("too_high");
    expect(offerProblem(450.5, 1000)).toBe("not_whole");
    expect(offerProblem(0, 1000)).toBe("not_whole");
    expect(offerProblem(-5, 1000)).toBe("not_whole");
  });

  it("puts a counter-offer above the offer it answers", () => {
    expect(offerProblem(900, 1000, 900)).toBe("not_above_offer");
    expect(offerProblem(950, 1000, 900)).toBeNull();
    expect(offerProblem(1100, 1000, 900)).toBe("too_high");
  });

  it("reads typed amounts (spaces, Arabic-Indic digits) and suggests rounded ones under the price", () => {
    expect(amountProblem("", 1000)).toBe("empty");
    expect(amountProblem("850", 1000)).toBeNull();
    expect(amountProblem("٨٥٠", 1000)).toBeNull();
    expect(amountProblem("1 200", 1000)).toBe("too_high");
    expect(suggestedAmounts(1000)).toEqual([950, 900, 850]);
    expect(suggestedAmounts(185_000)).toEqual([175_000, 165_000, 155_000]);
    // Counter-offer: only amounts above the offer.
    expect(suggestedAmounts(1000, 920)).toEqual([950]);
  });

  it("measures offers against the running promotion's lowest price", () => {
    const promo = { startsAt: NOW - HOUR, endsAt: NOW + HOUR, prices: [{ price: 800 }, { price: 850 }] };
    expect(offerReferencePrice({ price: 1000, promo }, NOW)).toBe(800);
    expect(offerReferencePrice({ price: 1000, promo }, NOW + 2 * HOUR)).toBe(1000);
    expect(offerReferencePrice({ price: 1000, promo: null }, NOW)).toBe(1000);
    expect(offerReferencePrice({ price: null }, NOW)).toBeNull();
  });
});

describe("contracts", () => {
  it("reads its markers back and refuses reserved characters in the note", () => {
    expect(offerEventOf(offerMarker("countered"))).toBe("countered");
    expect(offerEventOf("⟦offre:paid⟧")).toBeNull();
    expect(offerEventOf("⟦rdv:confirmed⟧")).toBeNull();
    expect(offerActionSchema.safeParse({ action: "make", amount: 900, note: "Je passe samedi" }).success).toBe(true);
    expect(offerActionSchema.safeParse({ action: "make", amount: 900, note: "⟦url⟧" }).success).toBe(false);
    expect(offerActionSchema.safeParse({ action: "make", amount: 900.5 }).success).toBe(false);
    expect(offerActionSchema.safeParse({ action: "make", amount: 900, note: "x".repeat(301) }).success).toBe(false);
    expect(offerActionSchema.safeParse({ action: "counter", id: "AbCdEfGhIjKl", amount: 950 }).success).toBe(true);
    expect(offerActionSchema.safeParse({ action: "accept", id: "short" }).success).toBe(false);
  });

  it("takes an offer with the first message, never with a booking request", () => {
    const start = { listingId: "abcd2345", text: "Bonjour", turnstileToken: "ok" };
    expect(startConversationOfferSchema.safeParse({ ...start, offer: { amount: 900 } }).success).toBe(true);
    expect(startConversationOfferSchema.safeParse({ ...start, offer: { amount: 0 } }).success).toBe(false);
    expect(startConversationOfferSchema.safeParse({ ...start, offer: { amount: 900 }, rentalRequest: { from: "2026-11-10", to: "2026-11-12" } }).success).toBe(false);
  });
});

describe("eligibility", () => {
  const base = { subcategoryId: "velos", price: 1000, isDonation: false };

  it("takes goods with one price", () => {
    expect(offerAllowed(base)).toBe(true);
    expect(offerAllowed({ ...base, subcategoryId: "voitures" })).toBe(true);
  });

  it("refuses donations, examples, sold-out, several prices, no price, services and rentals", () => {
    expect(offerAllowed({ ...base, isDonation: true })).toBe(false);
    expect(offerAllowed({ ...base, example: true })).toBe(false);
    expect(offerAllowed({ ...base, soldOut: true })).toBe(false);
    expect(offerAllowed({ ...base, severalPrices: true })).toBe(false);
    expect(offerAllowed({ ...base, price: null })).toBe(false);
    expect(offerAllowed({ ...base, price: 0 })).toBe(false);
    expect(offerAllowed({ ...base, subcategoryId: "inconnue" })).toBe(false);
    expect(offerAllowed({ ...base, subcategoryId: "cours" })).toBe(false);
    expect(offerAllowed({ ...base, subcategoryId: "location-voitures" })).toBe(false);
    expect(offerAllowed({ ...base, subcategoryId: "location" })).toBe(false);
  });
});

describe("nextOfferStep", () => {
  const now = new Date(NOW);

  it("lets the buyer make an offer within the bounds, open for 48 h", () => {
    const step = nextOfferStep(undefined, { action: "make", amount: 850 }, "buyer", now, 1000);
    expect(step).toMatchObject({ event: "made", amount: 850, offer: { status: "open", amount: 850, price: 1000 } });
    expect(step.offer.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(step.offer.expiresAt.getTime()).toBe(NOW + OFFER_TTL_MS);
  });

  it("refuses an offer by the seller, out of bounds, without a price or while one is pending", () => {
    expect(thrown(() => nextOfferStep(undefined, { action: "make", amount: 850 }, "seller", now, 1000)).status).toBe(403);
    const low = thrown(() => nextOfferStep(undefined, { action: "make", amount: 100 }, "buyer", now, 1000));
    expect(low.status).toBe(400);
    expect(low.code).toBe("invalid_body");
    expect(thrown(() => nextOfferStep(undefined, { action: "make", amount: 1100 }, "buyer", now, 1000)).status).toBe(400);
    expect(thrown(() => nextOfferStep(undefined, { action: "make", amount: 850 }, "buyer", now)).code).toBe("offer_unavailable");
    expect(thrown(() => nextOfferStep(offerDoc(), { action: "make", amount: 850 }, "buyer", now, 1000)).code).toBe("offer_pending");
    expect(thrown(() => nextOfferStep(offerDoc({ status: "countered", counter: 950 }), { action: "make", amount: 850 }, "buyer", now, 1000)).code).toBe("offer_pending");
    // Once answered or expired, a new offer starts over.
    expect(nextOfferStep(offerDoc({ status: "declined" }), { action: "make", amount: 850 }, "buyer", now, 1000).event).toBe("made");
    expect(nextOfferStep(offerDoc({ expiresAt: new Date(NOW - 1) }), { action: "make", amount: 850 }, "buyer", now, 1000).event).toBe("made");
  });

  it("lets the seller accept, decline or counter once, above the offer and within the bounds", () => {
    const current = offerDoc();
    expect(nextOfferStep(current, { action: "accept", id: current.id }, "seller", now)).toMatchObject({ event: "accepted", amount: 900, offer: { status: "accepted" } });
    expect(nextOfferStep(current, { action: "decline", id: current.id }, "seller", now)).toMatchObject({ event: "declined", offer: { status: "declined" } });
    const later = new Date(NOW + 10 * HOUR);
    const counter = nextOfferStep(current, { action: "counter", id: current.id, amount: 950 }, "seller", later);
    expect(counter).toMatchObject({ event: "countered", amount: 950, offer: { status: "countered", counter: 950, amount: 900 } });
    expect(counter.offer.expiresAt.getTime()).toBe(later.getTime() + OFFER_TTL_MS);
    expect(thrown(() => nextOfferStep(current, { action: "counter", id: current.id, amount: 900 }, "seller", now)).code).toBe("invalid_body");
    expect(thrown(() => nextOfferStep(current, { action: "counter", id: current.id, amount: 1200 }, "seller", now)).code).toBe("invalid_body");
    // One counter-offer only.
    expect(thrown(() => nextOfferStep(counter.offer, { action: "counter", id: current.id, amount: 980 }, "seller", now)).code).toBe("offer_changed");
  });

  it("lets the buyer accept the counter-offer or withdraw, never answer his own offer", () => {
    const countered = offerDoc({ status: "countered", counter: 950 });
    expect(nextOfferStep(countered, { action: "accept", id: countered.id }, "buyer", now)).toMatchObject({ event: "accepted", amount: 950 });
    expect(nextOfferStep(countered, { action: "withdraw", id: countered.id }, "buyer", now)).toMatchObject({ event: "withdrawn", amount: 950 });
    const open = offerDoc();
    expect(nextOfferStep(open, { action: "withdraw", id: open.id }, "buyer", now).event).toBe("withdrawn");
    expect(thrown(() => nextOfferStep(open, { action: "accept", id: open.id }, "buyer", now)).code).toBe("offer_changed");
    expect(thrown(() => nextOfferStep(open, { action: "withdraw", id: open.id }, "seller", now)).code).toBe("offer_changed");
    expect(thrown(() => nextOfferStep(countered, { action: "accept", id: countered.id }, "seller", now)).code).toBe("offer_changed");
    expect(thrown(() => nextOfferStep(open, { action: "decline", id: "ZZZZZZZZZZZZ" }, "seller", now)).code).toBe("offer_changed");
    expect(thrown(() => nextOfferStep(undefined, { action: "decline", id: open.id }, "seller", now)).code).toBe("offer_changed");
    expect(thrown(() => nextOfferStep(offerDoc({ status: "accepted" }), { action: "withdraw", id: open.id }, "buyer", now)).code).toBe("offer_changed");
  });

  it("refuses every answer once the 48 h are over", () => {
    const open = offerDoc({ expiresAt: new Date(NOW) });
    expect(thrown(() => nextOfferStep(open, { action: "accept", id: open.id }, "seller", now)).code).toBe("offer_expired");
    expect(thrown(() => nextOfferStep(open, { action: "withdraw", id: open.id }, "buyer", now)).code).toBe("offer_expired");
  });
});

describe("expiry", () => {
  it("reads a pending offer past its 48 h as expired, before the sweep writes it", () => {
    const offer = { status: "open" as const, expiresAt: NOW + HOUR };
    expect(offerPending(offer, NOW)).toBe(true);
    expect(offerStatusAt(offer, NOW)).toBe("open");
    expect(offerPending(offer, NOW + HOUR)).toBe(false);
    expect(offerStatusAt(offer, NOW + HOUR)).toBe("expired");
    expect(offerStatusAt({ status: "accepted", expiresAt: NOW - HOUR }, NOW)).toBe("accepted");
    expect(offerStatusAt({ status: "countered", expiresAt: NOW - HOUR }, NOW)).toBe("expired");
    expect(offerView(offerDoc({ expiresAt: new Date(NOW - 1) }), true, NOW).status).toBe("expired");
    expect(offerFinalAmount({ amount: 900, counter: 950 })).toBe(950);
    expect(offerFinalAmount({ amount: 900, counter: null })).toBe(900);
  });
});

describe("limits", () => {
  it("caps offers per buyer and per conversation like the messaging", () => {
    expect(RATE_LIMITS["offer.thread"]).toMatchObject({ points: 5, key: "uid+cid" });
    expect(RATE_LIMITS["offer.uid"].points).toBeGreaterThan(RATE_LIMITS["offer.thread"].points);
  });
});

describe("entry points", () => {
  const conversation = (overrides: Partial<Parameters<typeof canOffer>[0]> = {}): Parameters<typeof canOffer>[0] =>
    ({ role: "buyer", offersAllowed: true, offer: null, listing: { price: 1000 }, ...overrides }) as Parameters<typeof canOffer>[0];
  const view = (overrides: Partial<OfferView> = {}): OfferView => ({ id: "AbCdEfGhIjKl", status: "open", madeByMe: true, amount: 900, counter: null, price: 1000, expiresAt: NOW + 20 * HOUR, updatedAt: NOW, ...overrides });

  it("opens the thread on the offer dialog, for the buyer of a listing that takes offers", () => {
    expect(threadHref("c1", "offer")).toBe("/messages/c1?offre=1");
    expect(requestedOffer("?offre=1")).toBe(true);
    expect(requestedOffer("?rdv=visit")).toBe(false);
    expect(canOffer(conversation(), NOW)).toBe(true);
    expect(canOffer(conversation({ role: "seller" }), NOW)).toBe(false);
    expect(canOffer(conversation({ offersAllowed: false }), NOW)).toBe(false);
    expect(canOffer(conversation({ offer: view() }), NOW)).toBe(false);
    expect(canOffer(conversation({ offer: view({ status: "declined" }) }), NOW)).toBe(true);
    expect(canOffer(conversation({ offer: view({ expiresAt: NOW - 1 }) }), NOW)).toBe(true);
  });

  it("pins the card while pending and a week once accepted", () => {
    expect(offerCardShown(view(), NOW)).toBe(true);
    expect(offerCardShown(view({ status: "countered" }), NOW)).toBe(true);
    expect(offerCardShown(view({ status: "accepted", updatedAt: NOW - 6 * 24 * HOUR }), NOW)).toBe(true);
    expect(offerCardShown(view({ status: "accepted", updatedAt: NOW - 8 * 24 * HOUR }), NOW)).toBe(false);
    expect(offerCardShown(view({ status: "declined" }), NOW)).toBe(false);
  });
});

describe("thread", () => {
  const view = (overrides: Partial<OfferView> = {}): OfferView => ({ id: "AbCdEfGhIjKl", status: "open", madeByMe: false, amount: 900, counter: null, price: 1000, expiresAt: NOW + 20 * HOUR, updatedAt: NOW, ...overrides });
  const card = (offer: OfferView, options: { writable?: boolean; locale?: "fr" | "ar" } = {}) =>
    render(<OfferCard cid="c000000000000000000001" offer={offer} counterpartName="Youssef" writable={options.writable ?? true} now={NOW} onChange={() => {}} onCounter={() => {}} />, options.locale);

  it("shows the seller the offer against the price, and accept, counter, decline", () => {
    const html = card(view());
    expect(html).toContain('data-role="seller"');
    expect(html).toContain("⁨Youssef⁩ vous propose");
    expect(html).toContain('data-testid="offer-accept"');
    expect(html).toContain('data-testid="offer-counter"');
    expect(html).toContain('data-testid="offer-decline"');
    expect(html).toContain("Expire dans 20 heures");
    expect(html).toContain("n&#x27;engage ni à vendre ni à acheter");
    expect(card(view(), { writable: false })).not.toContain('data-testid="offer-accept"');
  });

  it("shows the buyer his offer to withdraw, then the counter-offer to accept", () => {
    const mine = card(view({ madeByMe: true }));
    expect(mine).toContain('data-role="buyer"');
    expect(mine).toContain('data-testid="offer-withdraw"');
    expect(mine).not.toContain('data-testid="offer-accept"');
    const countered = card(view({ madeByMe: true, status: "countered", counter: 950 }));
    expect(countered).toContain("contre-offre");
    expect(countered).toContain('data-testid="offer-accept"');
    expect(card(view({ status: "accepted", counter: 950 }))).toContain("Offre acceptée");
    expect(card(view({ status: "withdrawn" }))).toBe("");
  });

  it("renders the steps and the inbox preview in French and Arabic", () => {
    const step = { event: "countered" as const, byMe: false, amount: 950 };
    const html = render(<OfferEventItem step={step} counterpartName="Youssef" time="10:02" />);
    expect(html).toContain('data-event="countered"');
    expect(html).toContain("⁨Youssef⁩ fait une contre-offre");
    expect(render(<OfferEventItem step={{ event: "expired", byMe: false, amount: 900 }} counterpartName="Youssef" time="10:02" />)).toContain("a expiré sans réponse");
    expect(render(<OfferEventItem step={step} counterpartName="Youssef" time="10:02" />, "ar")).toContain("عرضًا مضادًا");
    expect(card(view(), { locale: "ar" })).toContain("العرض المقبول لا يحجز السلعة ولا يُلزم بالبيع ولا بالشراء");
    const row = { lastMessage: { preview: offerMarker("accepted"), mine: false, at: NOW, flagged: false } };
    expect(previewText(row, { hidden: "", maskedLink: "", offer: (event) => fr.Offers.preview[event] })).toBe("Offre acceptée");
  });

  it("has the same offer and price guide keys in French and Arabic", () => {
    const keys = (value: unknown, prefix = ""): string[] =>
      value && typeof value === "object" ? Object.entries(value).flatMap(([key, child]) => keys(child, `${prefix}${key}.`)) : [prefix.slice(0, -1)];
    expect(keys(ar.Offers)).toEqual(keys(fr.Offers));
    expect(keys(ar.PriceGuide)).toEqual(keys(fr.PriceGuide));
  });
});
