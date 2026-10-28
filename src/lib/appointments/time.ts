// Morocco's wall clock (Africa/Casablanca, offset from the runtime's time zone data: UTC+0 since
// 20 September 2026 in tzdata 2026c, UTC+1 before) <-> epoch ms, for the slot picker: a member
// picks "jeudi 14:30" in Morocco's time whatever the device's zone. Pure.

export const APPOINTMENT_TIME_ZONE = "Africa/Casablanca";

const PARTS = new Intl.DateTimeFormat("en-CA", {
  timeZone: APPOINTMENT_TIME_ZONE,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

/** Morocco's wall clock at `at`: { day: "2026-11-05", minutes: 870 } (minutes since midnight). */
export function moroccoClock(at: number): { day: string; minutes: number } {
  const parts = Object.fromEntries(PARTS.formatToParts(new Date(at)).map((part) => [part.type, part.value]));
  return { day: `${parts.year}-${parts.month}-${parts.day}`, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/** Epoch ms of `minutes` after midnight on `day` ("2026-11-05") in Morocco. */
export function moroccoTime(day: string, minutes: number): number {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  const wall = Date.UTC(year, month - 1, date, 0, minutes);
  // The zone's offset at that instant, measured twice so a change of offset near the time settles.
  let at = wall - 60 * 60_000;
  for (let pass = 0; pass < 2; pass += 1) {
    const clock = moroccoClock(at);
    const [y, m, d] = clock.day.split("-").map(Number) as [number, number, number];
    at += wall - Date.UTC(y, m - 1, d, 0, clock.minutes);
  }
  return at;
}

/** The `count` Morocco days from the one holding `from`, as "YYYY-MM-DD". */
export function nextDays(from: number, count: number): string[] {
  const { day } = moroccoClock(from);
  const [year, month, date] = day.split("-").map(Number) as [number, number, number];
  return Array.from({ length: count }, (_, index) => new Date(Date.UTC(year, month - 1, date + index)).toISOString().slice(0, 10));
}
