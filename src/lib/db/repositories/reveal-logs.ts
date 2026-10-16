import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { pepperedHash } from "@/lib/security/hash";
import { ipBuckets } from "@/lib/security/ip";
import { COLLECTIONS, revealLogSchema, type RevealLogDoc } from "../schemas";
import { datesToTimestamps } from "./timestamps";

// revealLogs/{id} (§5, §6 phone reveal): one entry per phone reveal, 90 days. No IP, no device id
// in clear: the IP prefix (/24 or /48) and the device key are peppered HMACs (phase 2 hashing).

export const REVEAL_LOG_RETENTION_DAYS = 90;

/** /24 of an IPv4 address, /48 of an IPv6 one (CGNAT: the subscriber block, not the exact address). */
export function ipPrefix(ip: string): string {
  const buckets = ipBuckets(ip);
  if (!buckets) return ip;
  if (buckets.version === 6) return buckets.network;
  const parts = buckets.ip.split(".");
  return `${parts.slice(0, 3).join(".")}.0/24`;
}

export function ipPrefixHash(ip: string): string {
  return pepperedHash("ip-prefix", ipPrefix(ip)).slice(0, 43);
}

export function deviceHash(deviceKey: string): string {
  return pepperedHash("device", deviceKey).slice(0, 43);
}

export interface RevealLogInput {
  viewerUid: string;
  listingId: string;
  ip: string;
  /** Rate-limit device key (`d:<id>` or `anon:<ip bucket>`). */
  deviceKey: string;
  now?: Date;
}

export function buildRevealLog(input: RevealLogInput): RevealLogDoc {
  const now = input.now ?? new Date();
  return revealLogSchema.parse({
    viewerUid: input.viewerUid,
    listingId: input.listingId,
    ipPrefixHash: ipPrefixHash(input.ip),
    deviceHash: deviceHash(input.deviceKey),
    at: now,
    purgeAt: new Date(now.getTime() + REVEAL_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000),
  });
}

const logs = () => db().collection(COLLECTIONS.revealLogs);

export async function recordReveal(input: RevealLogInput): Promise<string> {
  const ref = await logs().add(datesToTimestamps(buildRevealLog(input)));
  void consume("firestore.writes", 1);
  return ref.id;
}

/** True when this account already revealed this listing (a repeat does not count, §6). */
export async function hasRevealed(viewerUid: string, listingId: string): Promise<boolean> {
  const result = await logs().where("viewerUid", "==", viewerUid).where("listingId", "==", listingId).limit(1).count().get();
  void consume("firestore.reads", 1);
  return result.data().count > 0;
}

/** Reveals of one listing since `since` (alert past 100 a day; index listingId asc, at asc). */
export async function countRevealsSince(listingId: string, since: Date): Promise<number> {
  const result = await logs().where("listingId", "==", listingId).where("at", ">=", Timestamp.fromDate(since)).count().get();
  void consume("firestore.reads", 1);
  return result.data().count;
}

/** Tests: entries of a listing. */
export async function listRevealLogs(listingId: string): Promise<RevealLogDoc[]> {
  const snapshot = await logs().where("listingId", "==", listingId).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs
    .map((doc) => revealLogSchema.safeParse({ ...doc.data(), at: doc.get("at")?.toDate(), purgeAt: doc.get("purgeAt")?.toDate() }))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []));
}
