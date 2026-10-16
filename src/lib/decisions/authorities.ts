import "server-only";
import { Timestamp } from "firebase-admin/firestore";
import { audit } from "@/lib/audit";
import { getListingTx, updateListingTx } from "@/lib/db/repositories/listings";
import { datesToTimestamps, timestampsToDates } from "@/lib/db/repositories/timestamps";
import { COLLECTIONS, authorityRequestSchema, type AuthorityRequestDoc } from "@/lib/db/schemas";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { freezeConversation } from "@/lib/messaging";
import { consume } from "@/lib/quota";
import { createSystemReport } from "@/lib/reports";
import type { AuthorityRequestView, CreateAuthorityRequest, CreateAuthorityResponse, UpdateAuthorityRequest } from "./contracts";
import { decide, type DecisionActor } from "./decide";
import { conversationRef, privateFromSnapshot, privateRef } from "./repository";

// Authority requests register (design D17, admin only): requisitions, removal and preservation
// orders. Creating one sets the hold "authority:{id}" on every scoped document (listing and
// account legalHold: the retention purges skip them) and freezes the scoped conversations (nobody
// can write); closing it removes them. A removal order hides each scoped listing at once through
// an `authority` report (strong signal) and removes it by a decision with origin `authority_order`
// (not appealable on Joutiya: the order is challenged before the issuing State's courts).

export const AUTHORITY_RETENTION_YEARS = 5;
export const AUTHORITY_LIST_LIMIT = 50;
/** purgeAt while the request is open (§5: closedAt + 5 years once closed). */
const OPEN_PURGE_AT = new Date(Date.UTC(9999, 11, 31));
const HOLDS_MAX = 50;

export const authoritiesCol = () => db().collection(COLLECTIONS.authorityRequests);

export interface AuthorityRequestRecord extends AuthorityRequestDoc {
  id: string;
}

export function authorityHold(id: string): string {
  return `authority:${id}`;
}

interface ScopeEntry {
  kind: "listing" | "user" | "conversation";
  id: string;
}

function parseScope(entry: string): ScopeEntry | null {
  const separator = entry.indexOf(":");
  const kind = entry.slice(0, separator);
  const id = entry.slice(separator + 1);
  return kind === "listing" || kind === "user" || kind === "conversation" ? { kind, id } : null;
}

function recordFrom(id: string, data: Record<string, unknown> | undefined): AuthorityRequestRecord | null {
  if (!data) return null;
  const parsed = authorityRequestSchema.safeParse(timestampsToDates(data));
  if (!parsed.success) {
    logger.warn({ id, issues: parsed.error.issues.length }, "authorities: document does not match its schema");
    return null;
  }
  return { id, ...parsed.data };
}

export function authorityView(record: AuthorityRequestRecord): AuthorityRequestView {
  const iso = (date: Date | undefined) => (date ? date.toISOString() : null);
  return {
    id: record.id,
    authority: record.authority,
    country: record.country,
    legalBasis: record.legalBasis,
    kind: record.kind,
    scope: [...record.scope],
    identityCheck: { method: record.identityCheck.method, at: record.identityCheck.at.toISOString(), by: record.identityCheck.by },
    receivedAt: record.receivedAt.toISOString(),
    dueAt: iso(record.dueAt),
    status: record.status,
    response: record.response ?? null,
    respondedAt: iso(record.respondedAt),
    holds: [...record.holds],
    reportIds: [...record.reportIds],
    createdBy: record.createdBy,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
    closedAt: iso(record.closedAt),
  };
}

export async function getAuthorityRequest(id: string): Promise<AuthorityRequestRecord | null> {
  const snapshot = await authoritiesCol().doc(id).get();
  void consume("firestore.reads", 1);
  return recordFrom(snapshot.id, snapshot.data());
}

/** The holds `on` (added) or off (removed) in a list; null when nothing changes. Throws when the list is full. */
function toggled(current: readonly string[] | undefined, hold: string, on: boolean): string[] | null {
  const list = current ?? [];
  if (on === list.includes(hold)) return null;
  if (on && list.length >= HOLDS_MAX) throw new Error("legal hold list full");
  return on ? [...list, hold] : list.filter((entry) => entry !== hold);
}

/** True when changed, false when unchanged, null when the document does not exist. */
async function holdListing(id: string, hold: string, on: boolean, now: Date): Promise<boolean | null> {
  return db().runTransaction(async (tx) => {
    const listing = await getListingTx(tx, id);
    if (!listing || listing.status === "purged") return null;
    const legalHold = toggled(listing.legalHold, hold, on);
    if (!legalHold) return false;
    updateListingTx(tx, id, { legalHold, version: listing.version + 1, updatedAt: now });
    return true;
  });
}

async function holdAccount(uid: string, hold: string, on: boolean): Promise<boolean | null> {
  return db().runTransaction(async (tx) => {
    const snapshot = await tx.get(privateRef(uid));
    void consume("firestore.reads", 1);
    const account = privateFromSnapshot(snapshot);
    if (!account) return null;
    const legalHold = toggled(account.legalHold, hold, on);
    if (!legalHold) return false;
    tx.update(privateRef(uid), { legalHold });
    void consume("firestore.writes", 1);
    return true;
  });
}

async function holdConversation(cid: string, hold: string, on: boolean): Promise<boolean | null> {
  const snapshot = await conversationRef(cid).get();
  void consume("firestore.reads", 1);
  if (!snapshot.exists) return null;
  return freezeConversation(cid, hold, on);
}

/** Sets (or removes) the request's hold on each scoped document; returns the entries not found or not held. */
async function applyHolds(scope: readonly string[], hold: string, on: boolean, now: Date): Promise<string[]> {
  const missing: string[] = [];
  for (const entry of scope) {
    const parsed = parseScope(entry);
    try {
      let result: boolean | null = null;
      if (parsed?.kind === "listing") result = await holdListing(parsed.id, hold, on, now);
      else if (parsed?.kind === "user") result = await holdAccount(parsed.id, hold, on);
      else if (parsed?.kind === "conversation") result = await holdConversation(parsed.id, hold, on);
      if (result === null) missing.push(entry);
    } catch (error) {
      logger.error({ kind: parsed?.kind, err: (error as Error).message }, "authorities: hold not applied");
      missing.push(entry);
    }
  }
  return missing;
}

/**
 * Registers a request (D17): the document, then the holds and freezes, then for a removal order
 * one authority report and one decision per scoped listing. Admin only (checked by the route).
 */
export async function createAuthorityRequest(actor: DecisionActor & { role: "admin" }, input: CreateAuthorityRequest, options: { now?: Date; ip?: string } = {}): Promise<CreateAuthorityResponse> {
  const now = options.now ?? new Date();
  const ref = authoritiesCol().doc();
  const hold = authorityHold(ref.id);
  const doc: AuthorityRequestDoc = authorityRequestSchema.parse({
    authority: input.authority,
    country: input.country,
    legalBasis: input.legalBasis,
    kind: input.kind,
    scope: input.scope,
    identityCheck: { method: input.identityCheck.method, at: now, by: actor.uid },
    receivedAt: new Date(input.receivedAt),
    ...(input.dueAt ? { dueAt: new Date(input.dueAt) } : {}),
    status: "open",
    holds: [hold],
    reportIds: [],
    createdBy: actor.uid,
    createdAt: now,
    updatedAt: now,
    purgeAt: OPEN_PURGE_AT,
  });
  await ref.create(datesToTimestamps(doc));
  void consume("firestore.writes", 1);

  const missing = await applyHolds(input.scope, hold, true, now);
  const reportIds: string[] = [];
  const decisionIds: string[] = [];
  if (input.kind === "removal_order" && input.reasonId) {
    for (const entry of input.scope) {
      const parsed = parseScope(entry);
      if (parsed?.kind !== "listing" || missing.includes(entry)) continue;
      try {
        const report = await createSystemReport({
          target: { type: "listing", id: parsed.id },
          reasonId: input.reasonId,
          explanation: `Injonction de retrait : ${input.authority} (${input.legalBasis}), registre ${ref.id}`,
          source: "authority",
          authorityRequestId: ref.id,
          now,
        });
        reportIds.push(report.reportId);
        const decision = await decide(
          actor,
          { target: { type: "listing", id: parsed.id }, templateId: "authority.remove" },
          { now, origin: "authority_order", notifyAffected: input.notifyAffected !== false, ...(options.ip ? { ip: options.ip } : {}) },
        );
        decisionIds.push(decision.decisionId);
      } catch (error) {
        logger.error({ requestId: ref.id, err: (error as Error).message }, "authorities: removal not executed for a listing");
      }
    }
    if (reportIds.length > 0) {
      await ref.update({ reportIds: [...new Set(reportIds)].slice(0, 50), updatedAt: Timestamp.fromDate(now) });
      void consume("firestore.writes", 1);
    }
  }

  await audit({
    actorUid: actor.uid,
    actorRole: "admin",
    action: "authority.create",
    target: { type: "authorityRequest", id: ref.id },
    automated: false,
    reason: `${input.kind}, ${input.country}; ${input.scope.length} scoped, ${missing.length} missing; ${decisionIds.length} decision(s)`,
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });
  const stored = await getAuthorityRequest(ref.id);
  const record = stored ?? { id: ref.id, ...doc, reportIds };
  return { request: authorityView(record), decisionIds, missing };
}

interface ListCursor {
  receivedAt: number;
  id: string;
}

function encodeCursor(cursor: ListCursor): string {
  return Buffer.from(`${cursor.receivedAt}.${cursor.id}`, "utf8").toString("base64url");
}

function decodeCursor(value: string): ListCursor | null {
  const match = /^(-?\d{1,15})\.([A-Za-z0-9]{20})$/.exec(Buffer.from(value, "base64url").toString("utf8"));
  return match?.[1] && match[2] ? { receivedAt: Number(match[1]), id: match[2] } : null;
}

/** The register, newest received first (index status asc, receivedAt desc when filtered). */
export async function listAuthorityRequests(input: { status?: AuthorityRequestDoc["status"]; limit?: number; after?: string } = {}): Promise<{ items: AuthorityRequestView[]; next: string | null }> {
  const limit = Math.min(Math.max(input.limit ?? AUTHORITY_LIST_LIMIT, 1), 100);
  let query = input.status ? authoritiesCol().where("status", "==", input.status) : authoritiesCol();
  query = query.orderBy("receivedAt", "desc").orderBy("__name__", "desc");
  if (input.after) {
    const cursor = decodeCursor(input.after);
    if (!cursor) throw new HttpError(400, "invalid_body", undefined, { details: [{ path: "after", code: "invalid_value" }] });
    query = query.startAfter(Timestamp.fromMillis(cursor.receivedAt), cursor.id);
  }
  const snapshot = await query.limit(limit + 1).get();
  void consume("firestore.reads", Math.max(1, snapshot.size));
  const records = snapshot.docs.map((doc) => recordFrom(doc.id, doc.data())).filter((record): record is AuthorityRequestRecord => record !== null);
  const page = records.slice(0, limit);
  const last = page[page.length - 1];
  return { items: page.map(authorityView), next: records.length > limit && last ? encodeCursor({ receivedAt: last.receivedAt.getTime(), id: last.id }) : null };
}

/** Answered (response sent) or closed (holds removed, conversations released, purge in 5 years). */
export async function updateAuthorityRequest(actor: DecisionActor & { role: "admin" }, id: string, input: UpdateAuthorityRequest, options: { now?: Date; ip?: string } = {}): Promise<AuthorityRequestView> {
  const now = options.now ?? new Date();
  const ref = authoritiesCol().doc(id);
  const before = await db().runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    void consume("firestore.reads", 1);
    const record = recordFrom(snapshot.id, snapshot.data());
    if (!record) throw notFound();
    if (record.status === "closed") throw new HttpError(409, "conflict", "request already closed");
    const at = Timestamp.fromDate(now);
    const response = input.response ? { response: input.response, respondedAt: at } : {};
    if (input.status === "answered") tx.update(ref, { status: "answered", ...response, updatedAt: at });
    else {
      const purgeAt = new Date(now.getTime());
      purgeAt.setUTCFullYear(purgeAt.getUTCFullYear() + AUTHORITY_RETENTION_YEARS);
      tx.update(ref, { status: "closed", ...response, closedAt: at, purgeAt: Timestamp.fromDate(purgeAt), updatedAt: at });
    }
    void consume("firestore.writes", 1);
    return record;
  });
  const missing = input.status === "closed" ? await applyHolds(before.scope, authorityHold(id), false, now) : [];
  await audit({
    actorUid: actor.uid,
    actorRole: "admin",
    action: input.status === "closed" ? "authority.close" : "authority.answer",
    target: { type: "authorityRequest", id },
    automated: false,
    reason: input.status === "closed" ? `holds released (${before.scope.length - missing.length}/${before.scope.length})` : "response recorded",
    ...(options.ip ? { ip: options.ip } : {}),
    at: now,
  });
  const after = await getAuthorityRequest(id);
  if (!after) throw notFound();
  return authorityView(after);
}

/** Open requests among these ids (D18: a conversation is readable under an open request's hold). */
export async function openAuthorityIds(ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)].filter((id) => /^[A-Za-z0-9]{20}$/.test(id)).slice(0, 10);
  if (unique.length === 0) return [];
  const snapshots = await db().getAll(...unique.map((id) => authoritiesCol().doc(id)));
  void consume("firestore.reads", snapshots.length);
  return snapshots.filter((snapshot) => snapshot.exists && snapshot.get("status") !== "closed").map((snapshot) => snapshot.id);
}
