import "server-only";
import { FieldPath } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { COLLECTIONS, publicIdSchema, userSchema, type UserDoc } from "../schemas";
import { timestampsToDates } from "./timestamps";

// Public profile lookups (§5: no uid in a public URL, /profil/{publicId}). Read side of the users
// collection for the listing pages; the users repository keeps the account writes.

export interface UserRecord extends UserDoc {
  uid: string;
}

/** Stats counters a stray decrement can push below 0 (users.stats is denormalised, not authoritative). */
const STAT_COUNTERS = ["activeListings", "ratingCount", "ratingSum", "medianReplyMin"] as const;

/**
 * users/{uid} snapshot data -> UserRecord, or null when absent or invalid. Negative stats counters
 * are read as 0, so one bad counter never locks the account out ("account record missing", staging
 * 28 Oct); any other mismatch is logged with its field paths (never values).
 */
export function parseUserRecord(uid: string, raw: Record<string, unknown> | undefined): UserRecord | null {
  if (!raw) return null;
  const data = timestampsToDates(raw);
  const stats = data["stats"];
  if (stats && typeof stats === "object") {
    const fixed: Record<string, unknown> = { ...(stats as Record<string, unknown>) };
    for (const key of STAT_COUNTERS) if (typeof fixed[key] === "number" && (fixed[key] as number) < 0) fixed[key] = 0;
    data["stats"] = fixed;
  }
  const parsed = userSchema.safeParse(data);
  if (parsed.success) return { uid, ...parsed.data };
  logger.error({ uid, fields: [...new Set(parsed.error.issues.map((issue) => issue.path.join(".")))].slice(0, 10) }, "user record invalid");
  return null;
}

/** Account behind a public id (single-field index on `publicId`), or null. */
export async function findUserByPublicId(publicId: string): Promise<UserRecord | null> {
  if (!publicIdSchema.safeParse(publicId).success) return null;
  const snapshot = await db().collection(COLLECTIONS.users).where("publicId", "==", publicId).limit(1).get();
  void consume("firestore.reads", 1);
  const doc = snapshot.docs[0];
  return doc ? parseUserRecord(doc.id, doc.data()) : null;
}

/** users/{uid} with Dates (the users repository returns raw Timestamps). */
export async function getUserRecord(uid: string): Promise<UserRecord | null> {
  const snapshot = await db().collection(COLLECTIONS.users).doc(uid).get();
  void consume("firestore.reads", 1);
  return parseUserRecord(snapshot.id, snapshot.data());
}

/** A page of users/{uid} in document id order, after `afterUid` (jobs that visit every account). */
export async function listUserRecordsAfter(afterUid: string | null, limit: number): Promise<{ users: UserRecord[]; read: number; lastUid: string | null }> {
  let query = db().collection(COLLECTIONS.users).orderBy(FieldPath.documentId()).limit(limit);
  if (afterUid) query = query.startAfter(afterUid);
  const snapshot = await query.get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const users: UserRecord[] = [];
  for (const doc of snapshot.docs) {
    const user = parseUserRecord(doc.id, doc.data());
    if (user) users.push(user);
  }
  return { users, read: snapshot.size, lastUid: snapshot.docs.at(-1)?.id ?? null };
}
