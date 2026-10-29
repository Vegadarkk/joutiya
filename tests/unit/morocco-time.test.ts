import { describe, expect, it } from "vitest";
import { formatSlotDay, formatSlotRange } from "@/components/appointments/format";
import { formatClock } from "@/components/messages/format";
import { dayKey } from "@/components/messages/thread-state";
import { moroccoClock, moroccoTime } from "@/lib/appointments/time";
import { MOROCCO_UTC_SINCE, moroccoTimeZone } from "@/lib/i18n/morocco-time";
import { formatAppointmentTime } from "@/lib/mail/templates/appointmentReminder";

// Morocco is on UTC+0 since 20 September 2026 whatever the runtime's time zone data: Chrome 153
// (29 Oct 2026) and Node 22 still ship UTC+1, so these hold on old data as on new.

describe("Morocco's time zone", () => {
  it("is UTC from the switch, Africa/Casablanca (UTC+1 then) before", () => {
    expect(moroccoTimeZone(MOROCCO_UTC_SINCE - 1)).toBe("Africa/Casablanca");
    expect(moroccoTimeZone(MOROCCO_UTC_SINCE)).toBe("UTC");
    expect(moroccoClock(MOROCCO_UTC_SINCE - 60_000)).toEqual({ day: "2026-09-20", minutes: 119 });
    expect(moroccoClock(MOROCCO_UTC_SINCE)).toEqual({ day: "2026-09-20", minutes: 60 });
  });

  it("stores the slot a member picks at the Moroccan time shown", () => {
    const start = moroccoTime("2026-11-05", 14 * 60 + 30);
    expect(start).toBe(Date.UTC(2026, 10, 5, 14, 30));
    expect(formatSlotRange({ start, minutes: 30 }, "fr")).toMatch(/^14:30\D+15:00$/);
    expect(formatSlotDay(start, "fr")).toBe("jeudi 5 novembre");
    expect(formatAppointmentTime(new Date(start).toISOString(), "fr")).toBe("jeudi 5 novembre à 14:30");
  });

  it("shows message times and days in Morocco's time", () => {
    expect(formatClock(Date.UTC(2026, 9, 29, 1, 32), "fr")).toBe("01:32");
    expect(dayKey(Date.UTC(2026, 9, 28, 23, 30))).toBe("2026-10-28");
  });
});
