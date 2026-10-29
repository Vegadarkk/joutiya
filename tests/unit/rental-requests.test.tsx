import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { requestedDates } from "@/components/listing/message-dialog";
import { previewText } from "@/components/messages/inbox";
import { rentalFragment } from "@/components/rental/rental-day";
import { RentalRequestCard } from "@/components/rental/rental-request-card";
import { RentalRequestEventItem } from "@/components/rental/rental-request-event";
import { moroccoTime } from "@/lib/appointments/time";
import {
  rentalRequestActionSchema,
  rentalRequestEventOf,
  rentalRequestMarker,
  rentalRequestOpen,
  rentalRequestProblem,
  startConversationRequestSchema,
  type RentalRequestView,
} from "@/lib/contracts/rental-requests";
import type { RentalRequestDoc } from "@/lib/db/schemas";
import { HttpError } from "@/lib/http/errors";
import { dayNumber, dayString } from "@/lib/listings/rental-availability";
import { nextRentalStep } from "@/lib/rental-requests/service";
import { SEARCH_QUERY_KEYS } from "@/lib/search/params";

// Booking requests of a car rental (rental pack §6): the period rules, the step machine of the
// server, the dates carried from the search, and the card and thread steps in FR and AR.

/** Wednesday 4 November 2026, 10:00 in Morocco. */
const NOW = moroccoTime("2026-11-04", 10 * 60);
const TODAY = dayNumber("2026-11-04");
const day = (offset: number) => dayString(TODAY + offset);

function render(node: React.ReactNode, locale: "fr" | "ar" = "fr"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "fr" ? fr : ar} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

function requestDoc(overrides: Partial<RentalRequestDoc> = {}): RentalRequestDoc {
  return { id: "AbCdEfGhIjKl", status: "requested", from: day(3), to: day(6), pickup: "Aéroport Mohammed V", createdAt: new Date(NOW), updatedAt: new Date(NOW), ...overrides };
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

describe("request rules", () => {
  it("takes the bounds of a search by dates", () => {
    expect(rentalRequestProblem({ from: day(0), to: day(0) }, TODAY)).toBeNull();
    expect(rentalRequestProblem({ from: day(180), to: day(240) }, TODAY)).toBeNull();
    expect(rentalRequestProblem({ from: day(-1), to: day(2) }, TODAY)).toBe("past");
    expect(rentalRequestProblem({ from: day(4), to: day(2) }, TODAY)).toBe("reversed");
    expect(rentalRequestProblem({ from: day(181), to: day(182) }, TODAY)).toBe("too_far");
    expect(rentalRequestProblem({ from: day(1), to: day(62) }, TODAY)).toBe("too_long");
    expect(rentalRequestProblem({ from: "2026-02-30", to: day(2) }, TODAY)).toBe("invalid_day");
  });

  it("keeps the card while unanswered with a pick-up ahead, or accepted until the return day", () => {
    expect(rentalRequestOpen({ status: "requested", from: day(0), to: day(2) }, TODAY)).toBe(true);
    expect(rentalRequestOpen({ status: "requested", from: day(-1), to: day(2) }, TODAY)).toBe(false);
    expect(rentalRequestOpen({ status: "accepted", from: day(-3), to: day(0) }, TODAY)).toBe(true);
    expect(rentalRequestOpen({ status: "accepted", from: day(-3), to: day(-1) }, TODAY)).toBe(false);
    expect(rentalRequestOpen({ status: "declined", from: day(3), to: day(4) }, TODAY)).toBe(false);
  });

  it("reads its markers back and refuses the reserved characters in the pick-up place", () => {
    expect(rentalRequestEventOf(rentalRequestMarker("accepted"))).toBe("accepted");
    expect(rentalRequestEventOf("⟦location:paid⟧")).toBeNull();
    expect(rentalRequestEventOf("⟦rdv:confirmed⟧")).toBeNull();
    expect(rentalRequestActionSchema.safeParse({ action: "request", from: day(1), to: day(2), pickup: "Gare ⟦url⟧" }).success).toBe(false);
    expect(rentalRequestActionSchema.safeParse({ action: "accept", id: "AbCdEfGhIjKl" }).success).toBe(false);
    const start = { listingId: "abcd2345", text: "Bonjour", turnstileToken: "ok", rentalRequest: { from: day(1), to: day(2) } };
    expect(startConversationRequestSchema.safeParse(start).success).toBe(true);
    expect(startConversationRequestSchema.safeParse({ ...start, rentalRequest: { from: day(1) } }).success).toBe(false);
  });
});

describe("nextRentalStep", () => {
  const now = new Date(NOW);

  it("lets the renter request, then replace an unanswered request", () => {
    const first = nextRentalStep(undefined, { action: "request", from: day(3), to: day(6), pickup: "Voir www.exemple.com" }, "buyer", now);
    expect(first.event).toBe("requested");
    expect(first.request).toMatchObject({ status: "requested", from: day(3), to: day(6), pickup: "Voir ⟦url⟧" });
    expect(first.request.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const second = nextRentalStep(first.request, { action: "request", from: day(4), to: day(5) }, "buyer", now);
    expect(second.event).toBe("changed");
    expect(second.request.id).not.toBe(first.request.id);
    expect(second.request.pickup).toBeUndefined();
    // After an answer, a new request starts over.
    expect(nextRentalStep(requestDoc({ status: "declined" }), { action: "request", from: day(4), to: day(5) }, "buyer", now).event).toBe("requested");
  });

  it("refuses a request by the agency or with dates out of bounds", () => {
    expect(thrown(() => nextRentalStep(undefined, { action: "request", from: day(3), to: day(4) }, "seller", now)).status).toBe(403);
    const past = thrown(() => nextRentalStep(undefined, { action: "request", from: day(-1), to: day(4) }, "buyer", now));
    expect(past.status).toBe(400);
  });

  it("lets the agency accept, with the days blocked or not, or decline", () => {
    const current = requestDoc();
    const accepted = nextRentalStep(current, { action: "accept", id: current.id, block: true }, "seller", now, true);
    expect(accepted).toMatchObject({ event: "accepted", request: { status: "accepted", blocked: true, from: day(3) } });
    expect(nextRentalStep(current, { action: "accept", id: current.id, block: true }, "seller", now, false).request.blocked).toBeUndefined();
    expect(nextRentalStep(current, { action: "decline", id: current.id }, "seller", now)).toMatchObject({ event: "declined", request: { status: "declined" } });
  });

  it("lets only the renter withdraw, and only an unanswered request", () => {
    const current = requestDoc();
    expect(nextRentalStep(current, { action: "withdraw", id: current.id }, "buyer", now).event).toBe("withdrawn");
    expect(thrown(() => nextRentalStep(current, { action: "withdraw", id: current.id }, "seller", now)).code).toBe("rental_request_changed");
    expect(thrown(() => nextRentalStep(current, { action: "accept", id: current.id, block: false }, "buyer", now)).code).toBe("rental_request_changed");
    expect(thrown(() => nextRentalStep(requestDoc({ status: "accepted" }), { action: "withdraw", id: current.id }, "buyer", now)).code).toBe("rental_request_changed");
    expect(thrown(() => nextRentalStep(current, { action: "decline", id: "ZZZZZZZZZZZZ" }, "seller", now)).code).toBe("rental_request_changed");
  });

  it("refuses to accept once the pick-up day has passed", () => {
    const current = requestDoc({ from: day(-1), to: day(3) });
    expect(thrown(() => nextRentalStep(current, { action: "accept", id: current.id, block: false }, "seller", now)).code).toBe("rental_request_past");
  });
});

describe("dates from the search", () => {
  it("carries the searched days in the card link's fragment and reads them back while they can be requested", () => {
    const fragment = rentalFragment({ from: day(3), to: day(6) });
    expect(fragment).toBe(`#${SEARCH_QUERY_KEYS.rentFrom}=${day(3)}&${SEARCH_QUERY_KEYS.rentTo}=${day(6)}`);
    expect(requestedDates(fragment, TODAY)).toEqual({ from: day(3), to: day(6) });
    expect(requestedDates(rentalFragment({ from: day(-2), to: day(1) }), TODAY)).toEqual({});
    expect(requestedDates("#photo-2", TODAY)).toEqual({});
    expect(requestedDates("", TODAY)).toEqual({});
  });
});

describe("thread", () => {
  const view = (overrides: Partial<RentalRequestView> = {}): RentalRequestView => ({
    id: "AbCdEfGhIjKl",
    status: "requested",
    requestedByMe: false,
    from: day(3),
    to: day(6),
    pickup: "Aéroport, voir ⟦url⟧",
    blocked: false,
    updatedAt: NOW,
    ...overrides,
  });
  const card = (request: RentalRequestView, options: { writable?: boolean; pickup?: boolean; locale?: "fr" | "ar" } = {}) =>
    render(
      <RentalRequestCard
        cid="c000000000000000000001"
        request={request}
        counterpartName="Youssef"
        writable={options.writable ?? true}
        now={NOW}
        onChange={() => {}}
        onPickup={options.pickup === false ? undefined : () => {}}
      />,
      options.locale,
    );

  it("shows the agency the days, the place, block-these-days, available and not available", () => {
    const html = card(view());
    expect(html).toContain('data-status="requested-theirs"');
    expect(html).toContain("⁨Youssef⁩ demande ce véhicule");
    expect(html).toContain("3 jours");
    expect(html).toContain("[lien masqué]");
    expect(html).toContain('data-testid="rental-request-block"');
    expect(html).toContain("Disponible");
    expect(html).toContain("Pas disponible");
    expect(html).toContain("ne prend ni acompte ni caution");
    expect(card(view(), { writable: false })).not.toContain('data-testid="rental-request-accept"');
  });

  it("shows the renter the request sent and its withdrawal, then the pick-up appointment once accepted", () => {
    const mine = card(view({ requestedByMe: true }));
    expect(mine).toContain('data-status="requested-mine"');
    expect(mine).toContain("Retirer ma demande");
    expect(mine).not.toContain('data-testid="rental-request-accept"');
    const accepted = card(view({ requestedByMe: true, status: "accepted" }));
    expect(accepted).toContain("⁨Youssef⁩ confirme la disponibilité");
    expect(accepted).toContain('data-testid="rental-request-pickup"');
    expect(card(view({ status: "accepted", blocked: true }))).toContain("Dates bloquées sur l&#x27;annonce.");
    expect(card(view({ status: "accepted" }), { pickup: false })).not.toContain('data-testid="rental-request-pickup"');
    expect(card(view({ status: "declined" }))).toBe("");
    expect(card(view({ from: day(-1) }))).toBe("");
  });

  it("renders the steps and the inbox preview in French and Arabic", () => {
    const step = { event: "requested" as const, byMe: false, from: day(3), to: day(6), pickup: "Gare de Marrakech" };
    const html = render(<RentalRequestEventItem step={step} counterpartName="Youssef" time="10:02" />);
    expect(html).toContain('data-event="requested"');
    expect(html).toContain("⁨Youssef⁩ demande ce véhicule du sam. 7 nov. au mar. 10 nov.");
    expect(html).toContain("remise : ⁨Gare de Marrakech⁩");
    expect(render(<RentalRequestEventItem step={{ ...step, event: "accepted", byMe: true }} counterpartName="Youssef" time="10:02" />)).not.toContain("remise");
    expect(render(<RentalRequestEventItem step={step} counterpartName="Youssef" time="10:02" />, "ar")).toContain("يطلب");
    expect(card(view(), { locale: "ar" })).toContain("حجب هذه التواريخ في الإعلان");
    const row = { lastMessage: { preview: rentalRequestMarker("declined"), mine: false, at: NOW, flagged: false } };
    expect(previewText(row, { hidden: "", maskedLink: "", rentalRequest: (event) => fr.RentalRequest.preview[event] })).toBe("Pas de véhicule disponible");
  });
});
