import { SITE_NAME } from "@/config/site";
import type { Slot } from "@/lib/contracts/appointments";
import { slotEnd } from "./rules";

// "Ajouter à mon agenda": an iCalendar event (RFC 5545) built in the browser from the confirmed
// slot, downloaded as a .ics file. No server call, no third-party calendar link.

const stamp = (at: number) => new Date(at).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** RFC 5545 TEXT escaping, then folding at 75 octets is left to the readers (all accept long lines). */
const text = (value: string) => value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

export interface IcsInput {
  id: string;
  slot: Slot;
  title: string;
  description: string;
  place?: string | null;
  url: string;
  now?: number;
}

export function appointmentIcs(input: IcsInput): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:-//${SITE_NAME}//Rendez-vous//FR`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    "BEGIN:VEVENT",
    `UID:${input.id}@${SITE_NAME.toLowerCase()}.ma`,
    `DTSTAMP:${stamp(input.now ?? Date.now())}`,
    `DTSTART:${stamp(input.slot.start)}`,
    `DTEND:${stamp(slotEnd(input.slot))}`,
    `SUMMARY:${text(input.title)}`,
    `DESCRIPTION:${text(input.description)}`,
    ...(input.place ? [`LOCATION:${text(input.place)}`] : []),
    `URL:${input.url}`,
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "TRIGGER:-PT2H",
    `DESCRIPTION:${text(input.title)}`,
    "END:VALARM",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return `${lines.join("\r\n")}\r\n`;
}

/** Starts the download of `ics` as `name`.ics. */
export function downloadIcs(ics: string, name: string): void {
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `${name}.ics`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
