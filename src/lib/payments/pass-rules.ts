import type { PassConfig } from "@/config/pricing";

// Pass Boutique rules (owner decision 2026-10-28, design phase-7/boutique-temporaire.md §1). Pure:
// the checkout, the webhook, the nightly end and the unit tests share them.

const DAY_MS = 24 * 60 * 60 * 1000;
/** Notices before the end of a pass, in days. */
export const PASS_NOTICE_DAYS = [7, 1] as const;

/** End of the shop's running pass, or null (no pass, ended, or replaced by a subscription). */
export function runningPassEnd(profile: { planSource: string; passEndsAt?: Date }, now: Date): Date | null {
  return profile.planSource === "pass" && profile.passEndsAt && profile.passEndsAt.getTime() > now.getTime() ? profile.passEndsAt : null;
}

/**
 * End of a pass bought at `now`: it starts at the end of the running one (an extension) or now.
 * Null when that end would lie more than `maxAheadDays` ahead (the checkout refuses it).
 */
export function passEndAfter(running: Date | null, pass: Pick<PassConfig, "days" | "maxAheadDays">, now: Date): Date | null {
  const end = new Date((running ?? now).getTime() + pass.days * DAY_MS);
  return end.getTime() - now.getTime() > pass.maxAheadDays * DAY_MS ? null : end;
}

/** The notice step due now (days before the end), or null: not yet, past the end, or already sent. */
export function passNoticeDue(endsAt: Date, sentAt: Date | undefined, now: Date): number | null {
  if (now.getTime() >= endsAt.getTime()) return null;
  const due = [...PASS_NOTICE_DAYS].sort((a, b) => a - b).find((days) => now.getTime() >= endsAt.getTime() - days * DAY_MS);
  if (due === undefined) return null;
  return sentAt && sentAt.getTime() >= endsAt.getTime() - due * DAY_MS ? null : due;
}
