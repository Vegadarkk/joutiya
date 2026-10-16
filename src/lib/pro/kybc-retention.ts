import type { ProProfileDoc } from "./profile-schema";

// Retention of KYBC pieces (phase 7 design §4, architecture §5 "purgées 6 mois après la fin de la
// relation"): a piece listed by its owner's application is kept, rechecked every 30 days; once the
// application is rejected, 6 months after the rejection (its last change); a piece no application
// lists (never sent, or replaced by a resubmission) goes at its purgeAt. Pure: purge-quarantine
// applies it, the unit tests cover it.

const DAY_MS = 24 * 60 * 60 * 1000;
export const KYBC_RECHECK_MS = 30 * DAY_MS;
export const KYBC_REJECTED_RETENTION_MS = 183 * DAY_MS;

export type KybcRetention = { keep: true; until: Date } | { keep: false };

export function kybcRetention(uploadId: string, profile: Pick<ProProfileDoc, "kybc" | "lifecycle" | "updatedAt"> | null, now: Date): KybcRetention {
  if (!profile || !profile.kybc.uploadIds.includes(uploadId)) return { keep: false };
  const recheck = new Date(now.getTime() + KYBC_RECHECK_MS);
  if (profile.lifecycle !== "rejected") return { keep: true, until: recheck };
  const end = profile.updatedAt.getTime() + KYBC_REJECTED_RETENTION_MS;
  if (end <= now.getTime()) return { keep: false };
  return { keep: true, until: new Date(Math.min(end, recheck.getTime())) };
}
