import { describe, expect, it } from "vitest";
import { RENTAL_PERIODS_MAX, blockedDays, dayNumber, dayString, isFresh, moroccoToday, normalizePeriods, periodsOf } from "@/lib/listings/rental-availability";

// Car rental availability (rental pack §3): Morocco days, merged periods, horizon, freshness.

const today = dayNumber("2026-11-02");
const d = (offset: number) => dayString(today + offset);

describe("days", () => {
  it("round-trips day numbers and refuses days that do not exist", () => {
    expect(dayString(dayNumber("2026-12-31"))).toBe("2026-12-31");
    expect(dayNumber("2026-02-30")).toBeNaN();
    expect(dayNumber("2026-1-02")).toBeNaN();
  });

  it("takes today from Morocco's calendar, not the device's", () => {
    // 22:30 UTC on 1 November is still 1 November in Morocco (UTC+0 since 20 September 2026, UTC+1
    // in older time zone data), already 2 November for a device in Cairo.
    expect(dayString(moroccoToday(Date.parse("2026-11-01T22:30:00Z")))).toBe("2026-11-01");
  });
});

describe("normalizePeriods", () => {
  it("drops past days, merges overlapping and touching periods, sorts", () => {
    const result = normalizePeriods(
      [
        { from: d(10), to: d(12) },
        { from: d(-5), to: d(1) },
        { from: d(13), to: d(14) },
        { from: d(11), to: d(11) },
        { from: d(-9), to: d(-2) },
      ],
      today,
    );
    expect(result).toEqual({
      periods: [
        { from: d(0), to: d(1) },
        { from: d(10), to: d(14) },
      ],
    });
  });

  it("refuses reversed periods, invalid days, days past the horizon and too many periods", () => {
    expect(normalizePeriods([{ from: d(3), to: d(2) }], today)).toEqual({ problem: "reversed" });
    expect(normalizePeriods([{ from: "2026-02-30", to: d(2) }], today)).toEqual({ problem: "invalid_day" });
    expect(normalizePeriods([{ from: d(360), to: d(365) }], today)).toEqual({ problem: "too_far" });
    expect("periods" in normalizePeriods([{ from: d(360), to: d(364) }], today)).toBe(true);
    const many = Array.from({ length: RENTAL_PERIODS_MAX + 1 }, (_, index) => ({ from: d(index * 2), to: d(index * 2) }));
    expect(normalizePeriods(many, today)).toEqual({ problem: "too_many" });
  });
});

describe("blocked days and periods", () => {
  it("lists blocked days from today on and rebuilds periods from days", () => {
    expect(blockedDays([{ from: d(-2), to: d(1) }, { from: d(5), to: d(5) }], today)).toEqual([today, today + 1, today + 5]);
    expect(periodsOf([today + 3, today + 1, today + 2, today + 7])).toEqual([
      { from: d(1), to: d(3) },
      { from: d(7), to: d(7) },
    ]);
    expect(periodsOf([])).toEqual([]);
  });

  it("counts an availability fresh for 14 days", () => {
    const saved = Date.parse("2026-11-02T10:00:00Z");
    expect(isFresh(saved, saved + 13 * 86_400_000)).toBe(true);
    expect(isFresh(saved, saved + 14 * 86_400_000)).toBe(false);
    expect(isFresh(null, saved)).toBe(false);
  });
});
