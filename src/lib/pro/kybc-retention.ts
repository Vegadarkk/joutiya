import type { UserDoc } from "@/lib/db/schemas";
import type { ProProfileDoc } from "./profile-schema";

// Retention of KYBC pieces (phase 7 design §4, architecture §5 "purgées 6 mois après la fin de la
// relation", §7 retention table): a piece listed by its owner's application is kept while the
// relationship lasts, rechecked every 30 days; it goes 6 months after the relationship ends. The
// end is the earliest of: the rejection (the profile's last change), the downgrade without a
// subscription (`downgradedAt`), the owner's account closure or ban (`closedAt`, else the account's
// last change). A suspended Pro keeps its pieces while the sanction can be lifted. A piece no
// application lists (never sent, or replaced by a resubmission) goes at its purgeAt. Pure:
// purge-quarantine applies it, retention-purge gives rejected profiles the same end, the unit tests
// cover it.

const DAY_MS = 24 * 60 * 60 * 1000;
export const KYBC_RECHECK_MS = 30 * DAY_MS;
/** 6 months after the end of the relationship (spec §7). */
export const KYBC_END_RETENTION_MS = 183 * DAY_MS;

export type KybcRetention = { keep: true; until: Date } | { keep: false };

export type KybcProfileView = Pick<ProProfileDoc, "kybc" | "lifecycle" | "updatedAt" | "downgradedAt">;
export type KybcOwnerView = Pick<UserDoc, "status" | "updatedAt"> & { closedAt?: Date };

/** When the relationship with `profile`'s owner ended, or null while it lasts. */
export function relationshipEndedAt(profile: Pick<ProProfileDoc, "lifecycle" | "updatedAt" | "downgradedAt">, owner: KybcOwnerView): Date | null {
  const ends: number[] = [];
  if (profile.lifecycle === "rejected") ends.push(profile.updatedAt.getTime());
  if (profile.lifecycle === "downgraded") ends.push((profile.downgradedAt ?? profile.updatedAt).getTime());
  if (owner.status === "closed" || owner.status === "banned") ends.push((owner.closedAt ?? owner.updatedAt).getTime());
  return ends.length > 0 ? new Date(Math.min(...ends)) : null;
}

export function kybcRetention(uploadId: string, profile: KybcProfileView | null, owner: KybcOwnerView | null, now: Date): KybcRetention {
  if (!profile || !owner || !profile.kybc.uploadIds.includes(uploadId)) return { keep: false };
  const recheck = now.getTime() + KYBC_RECHECK_MS;
  const ended = relationshipEndedAt(profile, owner);
  if (!ended) return { keep: true, until: new Date(recheck) };
  const end = ended.getTime() + KYBC_END_RETENTION_MS;
  if (end <= now.getTime()) return { keep: false };
  return { keep: true, until: new Date(Math.min(end, recheck)) };
}
