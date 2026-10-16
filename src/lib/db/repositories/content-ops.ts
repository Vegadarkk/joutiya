import "server-only";
import type { Transaction } from "firebase-admin/firestore";
import { db } from "@/lib/firebase/admin";
import { consume } from "@/lib/quota";
import { COLLECTIONS, contentOpSchema, type ContentOpDoc } from "../schemas";
import { datesToTimestamps } from "./timestamps";

// contentOps/{id} (§5, §6 "Journaux"): who published what from which IP. The IP is stored in clear
// (LCEN obligation), readable by an admin under a requisition only, purged after one year.

export const CONTENT_OP_RETENTION_MONTHS = 12;

export interface ContentOpInput {
  uid: string;
  op: ContentOpDoc["op"];
  /** "listings/{id}" or "uploads/{id}". */
  contentRef: string;
  ip: string;
  now?: Date;
}

/** `contentRef` of a listing. */
export function listingContentRef(listingId: string): string {
  return `${COLLECTIONS.listings}/${listingId}`;
}

export function buildContentOp(input: ContentOpInput): ContentOpDoc {
  const now = input.now ?? new Date();
  const purgeAt = new Date(now.getTime());
  purgeAt.setUTCMonth(purgeAt.getUTCMonth() + CONTENT_OP_RETENTION_MONTHS);
  return contentOpSchema.parse({ uid: input.uid, op: input.op, contentRef: input.contentRef, ip: input.ip.slice(0, 45), at: now, purgeAt });
}

const ops = () => db().collection(COLLECTIONS.contentOps);

/** Appends an entry (auto id). */
export async function recordContentOp(input: ContentOpInput): Promise<string> {
  const ref = await ops().add(datesToTimestamps(buildContentOp(input)));
  void consume("firestore.writes", 1);
  return ref.id;
}

/** Appends an entry inside the transaction that changes the content. */
export function recordContentOpTx(tx: Transaction, input: ContentOpInput): void {
  tx.create(ops().doc(), datesToTimestamps(buildContentOp(input)));
  void consume("firestore.writes", 1);
}

/** Tests: entries about a content reference, oldest first. */
export async function listContentOps(contentRef: string): Promise<ContentOpDoc[]> {
  const snapshot = await ops().where("contentRef", "==", contentRef).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  return snapshot.docs
    .map((doc) => contentOpSchema.safeParse({ ...doc.data(), at: doc.get("at")?.toDate(), purgeAt: doc.get("purgeAt")?.toDate() }))
    .flatMap((parsed) => (parsed.success ? [parsed.data] : []))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}
