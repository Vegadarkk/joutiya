import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import fr from "../../messages/fr.json";
import { AppointmentEventItem } from "@/components/appointments/appointment-event";
import { canReport } from "@/components/messages/message-item";
import { RentalRequestEventItem } from "@/components/rental/rental-request-event";
import type { MessageView } from "@/lib/contracts/messaging";
import { HttpError } from "@/lib/http/errors";
import { memberTextOf, staffMemberText, staffPlaceLabel } from "@/lib/messaging/member-text";
import { screenPlace } from "@/lib/messaging/place";

// Audit A-02: an appointment place or a rental pick-up place goes through the message screen
// (payment details refused, links masked), and the step carrying it can be reported like a message.

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="fr" messages={fr} timeZone="UTC">
      {node}
    </NextIntlClientProvider>,
  );
}

const code = (run: () => unknown): string | null => {
  try {
    run();
    return null;
  } catch (error) {
    return error instanceof HttpError ? `${error.status} ${error.code}` : "other";
  }
};

describe("place screen", () => {
  it("refuses bank details and payment terms, masks links, keeps an ordinary place", () => {
    expect(code(() => screenPlace("RIB 011 780 0000123456789012 34 merci"))).toBe("422 place_payment_details");
    expect(code(() => screenPlace("Agence Cash Plus Maârif"))).toBe("422 place_payment_details");
    expect(code(() => screenPlace("Virement avant la visite, WhatsApp 0612345678"))).toBe("422 place_payment_details");
    expect(code(() => screenPlace("عربون قبل الزيارة"))).toBe("422 place_payment_details");
    expect(screenPlace("Café du parc, Maârif")).toBe("Café du parc, Maârif");
    expect(screenPlace("Agence, plan sur www.exemple.com")).toBe("Agence, plan sur ⟦url⟧");
    // A phone number alone is how people meet (D5): not refused.
    expect(screenPlace("Gare Casa-Voyageurs, appelez le 0612345678")).toBe("Gare Casa-Voyageurs, appelez le 0612345678");
  });
});

describe("member text of a message", () => {
  it("is a text message's text, or the place a proposal or a booking request carries", () => {
    expect(memberTextOf({ type: "text", text: "Bonjour" })).toEqual({ field: "text", text: "Bonjour" });
    expect(memberTextOf({ type: "system", text: "⟦rdv:proposed⟧", appointment: { event: "proposed", place: "Café du parc" } })).toEqual({ field: "appointment.place", text: "Café du parc" });
    expect(memberTextOf({ type: "system", text: "⟦rdv:rescheduled⟧", appointment: { event: "rescheduled", place: "Gare" } })?.field).toBe("appointment.place");
    expect(memberTextOf({ type: "system", text: "⟦loc:requested⟧", rentalRequest: { event: "requested", pickup: "Aéroport" } })).toEqual({ field: "rentalRequest.pickup", text: "Aéroport" });
    // Steps without the sender's own words.
    expect(memberTextOf({ type: "system", text: "⟦rdv:proposed⟧", appointment: { event: "proposed" } })).toBeNull();
    expect(memberTextOf({ type: "system", text: "⟦rdv:confirmed⟧", appointment: { event: "confirmed", place: "Café" } })).toBeNull();
    expect(memberTextOf({ type: "system", text: "⟦loc:accepted⟧", rentalRequest: { event: "accepted", pickup: "Aéroport" } })).toBeNull();
    expect(memberTextOf({ type: "system", text: "⟦offre:made⟧", offer: { event: "made" } } as never)).toBeNull();
    expect(memberTextOf({ type: "system", text: "⟦rdv:proposed⟧", appointment: { event: "proposed", place: null } })).toBeNull();
  });

  it("reads for staff with what the place is", () => {
    expect(staffMemberText({ type: "text", text: "Bonjour" })).toBe("Bonjour");
    expect(staffMemberText({ type: "system", appointment: { event: "proposed", place: "Café" } })).toBe("Lieu du rendez-vous proposé : Café");
    expect(staffMemberText({ type: "system", rentalRequest: { event: "changed", pickup: "Gare" } })).toBe("Lieu de prise en charge demandé : Gare");
    expect(staffPlaceLabel({ type: "system", appointment: { event: "proposed" }, hidden: true } as never)).toBe("Lieu du rendez-vous proposé");
    expect(staffPlaceLabel({ type: "text", text: "Bonjour" })).toBeNull();
  });
});

const view = (patch: Partial<MessageView>): MessageView => ({ id: "m1", mine: false, type: "text", text: "Bonjour", flags: [], hidden: false, createdAt: 0, readAt: null, ...patch });

describe("reporting a step", () => {
  it("offers the report on a received proposal or booking request with a place only", () => {
    const proposal = { event: "proposed", kind: "visit", byMe: false, slot: null, reason: null, place: "Café du parc" } as const;
    expect(canReport(view({}))).toBe(true);
    expect(canReport(view({ type: "system", text: "⟦rdv:proposed⟧", appointment: proposal }))).toBe(true);
    expect(canReport(view({ type: "system", text: "⟦rdv:proposed⟧", appointment: { ...proposal, place: null } }))).toBe(false);
    expect(canReport(view({ type: "system", text: "⟦rdv:proposed⟧", appointment: proposal, mine: true }))).toBe(false);
    expect(canReport(view({ type: "system", text: "⟦rdv:proposed⟧", appointment: proposal, hidden: true }))).toBe(false);
    expect(canReport(view({ type: "system", text: "⟦loc:requested⟧", rentalRequest: { event: "requested", byMe: false, from: "2026-11-02", to: "2026-11-04", unit: "day", pickup: "Aéroport" } }))).toBe(true);
    expect(canReport(view({ type: "system", text: "⟦loc:accepted⟧", rentalRequest: { event: "accepted", byMe: false, from: "2026-11-02", to: "2026-11-04", unit: "day", pickup: "Aéroport" } }))).toBe(false);
  });

  it("shows the proposer's place on the step, with the report button when offered", () => {
    const step = { event: "proposed", kind: "visit", byMe: false, slot: null, reason: null, place: "Café du parc, voir ⟦url⟧" } as const;
    const html = render(<AppointmentEventItem step={step} counterpartName="Karim" time="10:00" onReport={() => {}} />);
    expect(html).toContain("lieu : ⁨Café du parc, voir [lien masqué]⁩");
    expect(html).toContain('data-testid="report-message"');
    expect(render(<AppointmentEventItem step={step} counterpartName="Karim" time="10:00" />)).not.toContain("report-message");
    const rental = render(<RentalRequestEventItem step={{ event: "requested", byMe: false, from: "2026-11-02", to: "2026-11-04", unit: "day", pickup: "Aéroport" }} counterpartName="Karim" time="10:00" onReport={() => {}} />);
    expect(rental).toContain('data-testid="report-message"');
  });
});
