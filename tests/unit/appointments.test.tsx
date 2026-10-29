import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { AppointmentCard, cancelReasonsFor } from "@/components/appointments/appointment-card";
import { AppointmentEventItem } from "@/components/appointments/appointment-event";
import { GRID_MINUTES, SlotPicker, firstOpenDay, timeOff } from "@/components/appointments/slot-picker";
import { previewText } from "@/components/messages/inbox";
import { requestedKind } from "@/components/messages/thread-view";
import { appointmentIcs } from "@/lib/appointments/ics";
import { isActive, nextReminderAt, slotsProblem } from "@/lib/appointments/rules";
import { nextStep } from "@/lib/appointments/service";
import { moroccoClock, moroccoTime, nextDays } from "@/lib/appointments/time";
import { appointmentEventOf, appointmentMarker, appointmentActionSchema, type AppointmentView, type Slot } from "@/lib/contracts/appointments";
import { HttpError } from "@/lib/http/errors";

// Appointments in messaging (architecture §5, 28 Oct): slot rules, Morocco's clock, reminders, the
// step machine of the server, the .ics file, and the picker, card and thread steps in FR and AR.

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Wednesday 4 November 2026, 10:00 in Morocco, whatever the offset the time zone data gives
 *  (UTC+1 before tzdata 2026c, UTC+0 since: Morocco left UTC+1 on 20 September 2026). */
const NOW = moroccoTime("2026-11-04", 10 * 60);
const at = (hours: number) => NOW + hours * HOUR;
const slot = (hours: number, minutes: Slot["minutes"] = 30): Slot => ({ start: at(hours), minutes });

function render(node: React.ReactNode, locale: "fr" | "ar" = "fr"): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "fr" ? fr : ar} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

describe("slot rules", () => {
  it("refuses slots within the hour, beyond 60 days, overlapping or repeated", () => {
    expect(slotsProblem([slot(2), slot(26)], NOW)).toBeNull();
    expect(slotsProblem([slot(0.5)], NOW)).toEqual([0, "too_soon"]);
    expect(slotsProblem([slot(2), slot(61 * 24)], NOW)).toEqual([1, "too_far"]);
    expect(slotsProblem([slot(2, 60), slot(2.5)], NOW)).toEqual([1, "overlap"]);
    expect(slotsProblem([slot(2), slot(2)], NOW)).toEqual([1, "duplicate"]);
    // Back to back is fine.
    expect(slotsProblem([slot(2, 60), slot(3)], NOW)).toBeNull();
  });

  it("keeps a proposal active while one slot is ahead, a confirmation until its end", () => {
    expect(isActive({ status: "proposed", slots: [slot(-1), slot(2)] }, NOW)).toBe(true);
    expect(isActive({ status: "proposed", slots: [slot(-1)] }, NOW)).toBe(false);
    expect(isActive({ status: "confirmed", slots: [slot(-0.25)], chosen: slot(-0.25) }, NOW)).toBe(true);
    expect(isActive({ status: "confirmed", slots: [slot(-1)], chosen: slot(-1) }, NOW)).toBe(false);
    expect(isActive({ status: "cancelled", slots: [slot(2)], chosen: slot(2) }, NOW)).toBe(false);
  });

  it("reminds the day before, then two hours before, never after the start", () => {
    expect(nextReminderAt(slot(48), NOW)).toBe(at(24));
    expect(nextReminderAt(slot(48), at(24))).toBe(at(46));
    expect(nextReminderAt(slot(10), NOW)).toBe(at(8));
    expect(nextReminderAt(slot(1.5), NOW)).toBeNull();
  });
});

describe("Morocco's clock", () => {
  it("turns a wall-clock time into epoch ms and back, whatever the offset", () => {
    // June 2026: UTC+1 in every version of the time zone data.
    expect(moroccoTime("2026-06-15", 14 * 60 + 30)).toBe(Date.UTC(2026, 5, 15, 13, 30));
    for (const day of ["2026-11-05", "2027-02-20", "2027-03-01", "2027-06-15"]) {
      for (const minutes of [8 * 60, 14 * 60 + 30, 21 * 60 + 30]) expect(moroccoClock(moroccoTime(day, minutes))).toEqual({ day, minutes });
    }
  });

  it("lists the next days from today in Morocco", () => {
    // 23:30 UTC on 15 June 2026 is 00:30 on 16 June in Morocco (UTC+1 then).
    expect(nextDays(Date.UTC(2026, 5, 15, 23, 30), 3)).toEqual(["2026-06-16", "2026-06-17", "2026-06-18"]);
  });

  it("offers grid times from an hour ahead, minus overlaps with picked slots", () => {
    const today = moroccoClock(NOW).day;
    expect(firstOpenDay([today], NOW)).toBe(today);
    expect(timeOff(moroccoTime(today, 10 * 60 + 30), 30, [], NOW)).toBe(true);
    expect(timeOff(moroccoTime(today, 11 * 60), 30, [], NOW)).toBe(false);
    const picked = [{ start: moroccoTime(today, 14 * 60), minutes: 60 as const }];
    expect(timeOff(moroccoTime(today, 14 * 60 + 30), 30, picked, NOW)).toBe(true);
    expect(timeOff(moroccoTime(today, 15 * 60), 30, picked, NOW)).toBe(false);
    // The picked start itself stays clickable (to remove it).
    expect(timeOff(moroccoTime(today, 14 * 60), 30, picked, NOW)).toBe(false);
    expect(GRID_MINUTES[0]).toBe(8 * 60);
    expect(GRID_MINUTES.at(-1)).toBe(21 * 60 + 30);
  });
});

describe("contract", () => {
  it("accepts the five actions and refuses the rest", () => {
    const start = Date.UTC(2026, 10, 5, 13, 30);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "visit", slots: [{ start, minutes: 30 }], place: "Agence Maârif" }).success).toBe(true);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "visit", slots: [{ start: start + 60_000, minutes: 30 }] }).success).toBe(false);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "visit", slots: [{ start, minutes: 25 }] }).success).toBe(false);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "boat", slots: [{ start, minutes: 30 }] }).success).toBe(false);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "visit", slots: [] }).success).toBe(false);
    expect(appointmentActionSchema.safeParse({ action: "propose", kind: "visit", slots: [{ start, minutes: 30 }], place: "⟦url⟧" }).success).toBe(false);
    expect(appointmentActionSchema.safeParse({ action: "confirm", id: "abcdefghijkl", start }).success).toBe(true);
    expect(appointmentActionSchema.safeParse({ action: "cancel", id: "abcdefghijkl", reason: "sold" }).success).toBe(true);
    expect(appointmentActionSchema.safeParse({ action: "cancel", id: "abc" }).success).toBe(false);
  });

  it("marks each step's text for the inbox preview", () => {
    expect(appointmentEventOf(appointmentMarker("confirmed"))).toBe("confirmed");
    expect(appointmentEventOf("⟦rdv:nope⟧")).toBeNull();
    const preview = (text: string) => previewText({ lastMessage: { preview: text, mine: false, at: NOW, flagged: false } }, { hidden: "H", maskedLink: "L", appointment: (event) => `rdv:${event}` });
    expect(preview(appointmentMarker("reminder"))).toBe("rdv:reminder");
    expect(preview("Bonjour")).toBe("Bonjour");
  });

  it("reads ?rdv= on the thread's URL", () => {
    expect(requestedKind("?rdv=test_drive")).toBe("test_drive");
    expect(requestedKind("?archived=1&rdv=visit")).toBe("visit");
    expect(requestedKind("?rdv=boat")).toBeNull();
    expect(requestedKind("")).toBeNull();
  });
});

describe("step machine", () => {
  const now = new Date(NOW);
  const propose = (uid = "seller") => nextStep(undefined, { action: "propose", kind: "visit", slots: [slot(26), slot(2)], place: "Voir www.exemple.com" }, uid, now);

  it("proposes sorted slots with the place's links masked", () => {
    const step = propose();
    expect(step.event).toBe("proposed");
    expect(step.appointment).toMatchObject({ kind: "visit", proposedBy: "seller", status: "proposed", place: "Voir ⟦url⟧" });
    expect(step.appointment.slots.map((item) => item.start.getTime())).toEqual([at(2), at(26)]);
    expect(step.appointment.id).toMatch(/^[A-Za-z0-9_-]{12}$/);
    expect(step.remindAt).toBeNull();
  });

  it("refuses an invalid slot with its index", () => {
    try {
      nextStep(undefined, { action: "propose", kind: "visit", slots: [slot(2), slot(0.5)] }, "seller", now);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(HttpError);
      expect((error as HttpError).status).toBe(400);
    }
  });

  it("lets the other participant confirm one of the slots, with its first reminder", () => {
    const { appointment } = propose();
    const step = nextStep(appointment, { action: "confirm", id: appointment.id, start: at(26) }, "buyer", now);
    expect(step.event).toBe("confirmed");
    expect(step.appointment.status).toBe("confirmed");
    expect(step.appointment.chosen?.start.getTime()).toBe(at(26));
    expect(step.remindAt?.getTime()).toBe(at(2));
    const code = (run: () => unknown) => {
      try {
        run();
      } catch (error) {
        return (error as HttpError).code;
      }
      return null;
    };
    // The proposer cannot confirm his own slots, nor anyone a slot that was not proposed or an old id.
    expect(code(() => nextStep(appointment, { action: "confirm", id: appointment.id, start: at(26) }, "seller", now))).toBe("appointment_changed");
    expect(code(() => nextStep(appointment, { action: "confirm", id: appointment.id, start: at(27) }, "buyer", now))).toBe("appointment_changed");
    expect(code(() => nextStep(appointment, { action: "confirm", id: "zzzzzzzzzzzz", start: at(26) }, "buyer", now))).toBe("appointment_changed");
    expect(code(() => nextStep(appointment, { action: "confirm", id: appointment.id, start: at(2) }, "buyer", new Date(at(3))))).toBe("appointment_slot_past");
    expect(code(() => nextStep(appointment, { action: "withdraw", id: appointment.id }, "buyer", now))).toBe("appointment_changed");
    expect(code(() => nextStep(appointment, { action: "decline", id: appointment.id }, "seller", now))).toBe("appointment_changed");
    expect(code(() => nextStep(appointment, { action: "cancel", id: appointment.id }, "buyer", now))).toBe("appointment_changed");
  });

  it("declines, withdraws, cancels with a reason, and reschedules an active appointment", () => {
    const { appointment } = propose();
    expect(nextStep(appointment, { action: "decline", id: appointment.id }, "buyer", now).appointment.status).toBe("declined");
    expect(nextStep(appointment, { action: "withdraw", id: appointment.id }, "seller", now).appointment.status).toBe("withdrawn");
    const confirmed = nextStep(appointment, { action: "confirm", id: appointment.id, start: at(2) }, "buyer", now).appointment;
    const cancelled = nextStep(confirmed, { action: "cancel", id: confirmed.id, reason: "sold" }, "seller", now);
    expect(cancelled).toMatchObject({ event: "cancelled", remindAt: null, appointment: { status: "cancelled", cancelledBy: "seller", reason: "sold" } });
    expect(nextStep(confirmed, { action: "propose", kind: "visit", slots: [slot(30)] }, "buyer", now).event).toBe("rescheduled");
    expect(nextStep(cancelled.appointment, { action: "propose", kind: "visit", slots: [slot(30)] }, "buyer", now).event).toBe("proposed");
  });
});

describe(".ics", () => {
  it("is one event in UTC with an alarm two hours before", () => {
    const ics = appointmentIcs({ id: "abcdefghijkl", slot: { start: Date.UTC(2026, 10, 5, 13, 30), minutes: 30 }, title: "Visite avec Salma, Joutiya", description: "Appartement; Maârif", place: "Agence", url: "https://joutiya.ma/fr/messages/x", now: NOW });
    expect(ics).toContain("DTSTART:20261105T133000Z\r\n");
    expect(ics).toContain("DTEND:20261105T140000Z\r\n");
    expect(ics).toContain("SUMMARY:Visite avec Salma\\, Joutiya\r\n");
    expect(ics).toContain("DESCRIPTION:Appartement\\; Maârif\r\n");
    expect(ics).toContain("TRIGGER:-PT2H");
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
  });
});

const view = (patch: Partial<AppointmentView> = {}): AppointmentView => ({
  id: "abcdefghijkl",
  kind: "visit",
  status: "proposed",
  proposedByMe: false,
  slots: [slot(26), slot(28)],
  chosen: null,
  place: "Agence ⟦url⟧",
  cancelledByMe: null,
  reason: null,
  updatedAt: NOW,
  ...patch,
});

describe("components", () => {
  const card = (appointment: AppointmentView, locale: "fr" | "ar" = "fr", writable = true) =>
    render(<AppointmentCard cid="c000000000000000000001" appointment={appointment} role="buyer" counterpartName="Salma" listingTitle="Appartement" writable={writable} now={NOW} onChange={() => {}} onReschedule={() => {}} />, locale);

  it("shows the slots to pick from, confirm and none-suits-me to the one who answers", () => {
    const html = card(view());
    expect(html).toContain('data-status="proposed-theirs"');
    expect(html).toContain("\u2068Salma\u2069 vous propose une visite");
    expect(html.match(/data-testid="appointment-slot"/g)).toHaveLength(2);
    expect(html).toContain("Confirmer ce créneau");
    expect(html).toContain("Aucun ne me convient");
    expect(html).toContain("[lien masqué]");
    expect(html).toContain("ne versez jamais d&#x27;acompte");
  });

  it("shows the proposer what was sent, and nothing to act on when read-only", () => {
    expect(card(view({ proposedByMe: true }))).toContain("Retirer ma proposition");
    expect(card(view({ proposedByMe: true }), "fr", false)).not.toContain("Retirer ma proposition");
    expect(card(view(), "fr", false)).not.toContain("Confirmer ce créneau");
  });

  it("shows a confirmed slot as a door with add to calendar, reschedule and cancel", () => {
    const html = card(view({ status: "confirmed", chosen: slot(26) }));
    expect(html).toContain('data-status="confirmed"');
    expect(html).toContain("Visite confirmée");
    expect(html).toContain("Ajouter à mon agenda");
    expect(html).toContain("Reporter");
    expect(card(view({ status: "confirmed", chosen: slot(26) }), "ar")).toContain("تأكّدت الزيارة");
  });

  it("offers the item-gone reason to the seller only", () => {
    expect(cancelReasonsFor("seller")).toEqual(["unavailable", "sold", "other"]);
    expect(cancelReasonsFor("buyer")).toEqual(["unavailable", "other"]);
  });

  it("hides an ended appointment", () => {
    expect(card(view({ status: "cancelled", chosen: slot(26) }))).toBe("");
    expect(card(view({ slots: [slot(-2)] }))).toBe("");
  });

  it("renders each thread step in French and Arabic", () => {
    const step = (patch: Partial<Parameters<typeof AppointmentEventItem>[0]["step"]>) => ({ event: "proposed" as const, kind: "test_drive" as const, byMe: false, slot: null, reason: null, ...patch });
    expect(render(<AppointmentEventItem step={step({})} counterpartName="Karim" time="10:00" />)).toContain("\u2068Karim\u2069 propose un essai");
    expect(render(<AppointmentEventItem step={step({ event: "confirmed", byMe: true, slot: { start: moroccoTime("2026-11-05", 14 * 60 + 30), minutes: 30 } })} counterpartName="Karim" time="10:00" />)).toContain(
      "Vous avez confirmé un essai : jeudi 5 novembre à 14:30",
    );
    expect(render(<AppointmentEventItem step={step({ event: "cancelled", reason: "sold", slot: slot(26) })} counterpartName="Karim" time="10:00" />)).toContain("L&#x27;article n&#x27;est plus disponible");
    expect(render(<AppointmentEventItem step={step({ event: "reminder", slot: slot(26) })} counterpartName="Karim" time="10:00" />, "ar")).toContain("تذكير");
  });

  it("renders the picker with the day strip, the grid and the safety note", () => {
    const html = render(<SlotPicker defaultKind="test_drive" now={NOW} onSubmit={() => {}} />);
    expect(html.match(/data-testid="slot-day"/g)).toHaveLength(14);
    expect(html).toContain("Heure du Maroc");
    expect(html).toContain("Essai");
    expect(html).toContain("n&#x27;intervient pas dans la transaction");
    expect(render(<SlotPicker now={NOW} onSubmit={() => {}} />, "ar")).toContain("بتوقيت المغرب");
  });

  it("keeps the picker's 60-day horizon in its date field", () => {
    const html = render(<SlotPicker now={NOW} onSubmit={() => {}} />);
    expect(html).toContain(`max="${moroccoClock(NOW + 60 * DAY).day}"`);
  });
});

