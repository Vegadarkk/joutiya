import "server-only";
import { randomInt } from "node:crypto";
import { FieldValue, Timestamp } from "firebase-admin/firestore";
import type { Locale } from "@/config/site";
import { db } from "@/lib/firebase/admin";
import { HttpError } from "@/lib/http/errors";
import { pepperedHash } from "@/lib/security/hash";
import { normalizeEmail } from "@/lib/security/email-normalize";
import { COLLECTIONS, emailIndexSchema, userPrivateSchema, userSchema, type UserDoc, type UserPrivateDoc } from "../schemas";

// users, users/{uid}/private/account and emailIndex (§5). The server is the only writer.

const PUBLIC_ID_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

export function newPublicId(): string {
  let id = "";
  for (let i = 0; i < 10; i += 1) id += PUBLIC_ID_ALPHABET[randomInt(PUBLIC_ID_ALPHABET.length)];
  return id;
}

/** HMAC of the normalized e-mail (§6): the key of emailIndex and of the rate limits. */
export function emailNormHash(email: string): string {
  return pepperedHash("email", normalizeEmail(email));
}

export class EmailTakenError extends Error {
  constructor(readonly uid: string) {
    super("e-mail already registered");
    this.name = "EmailTakenError";
  }
}

export interface CreateAccountInput {
  uid: string;
  email: string;
  displayName: string;
  locale: Locale;
  consents: { cguVersion: string; transfersVersion: string; marketing: boolean };
  provider: "password" | "google.com";
  /** Google accounts arrive with a verified e-mail: the account is activated at once. */
  activated?: boolean;
  now?: Date;
}

const userRef = (uid: string) => db().collection(COLLECTIONS.users).doc(uid);
const privateRef = (uid: string) => userRef(uid).collection(COLLECTIONS.userPrivate).doc(COLLECTIONS.userPrivateDoc);
const emailRef = (hash: string) => db().collection(COLLECTIONS.emailIndex).doc(hash);

/**
 * Creates the Firestore documents of a new account in one transaction. Fails with EmailTakenError
 * when the normalized e-mail already belongs to an account (the index document exists).
 */
export async function createAccountDocuments(input: CreateAccountInput): Promise<{ publicId: string }> {
  const now = input.now ?? new Date();
  const publicId = newPublicId();
  const hash = emailNormHash(input.email);
  const user: UserDoc = userSchema.parse({
    publicId,
    displayName: input.displayName,
    type: "individual",
    badges: { emailVerified: input.activated === true, phoneVerified: false, proCertified: false },
    stats: { activeListings: 0, responseRate: 0, medianReplyMin: 0, ratingCount: 0 },
    status: "active",
    activation: input.activated ? "done" : "pending",
    locale: input.locale,
    createdAt: now,
    updatedAt: now,
  });
  const account: UserPrivateDoc = userPrivateSchema.parse({
    email: input.email.trim().toLowerCase(),
    emailNormHash: hash,
    consents: {
      cgu: { version: input.consents.cguVersion, at: now },
      transfers: { version: input.consents.transfersVersion, at: now },
      marketing: input.consents.marketing,
    },
    strikes: { level: 0 },
    reporter: { recent: [], total: 0 },
    providers: [input.provider],
  });
  await db().runTransaction(async (tx) => {
    const existing = await tx.get(emailRef(hash));
    if (existing.exists) throw new EmailTakenError(String(existing.get("uid")));
    tx.create(emailRef(hash), emailIndexSchema.parse({ uid: input.uid, createdAt: now }));
    tx.create(userRef(input.uid), user);
    tx.create(privateRef(input.uid), account);
  });
  return { publicId };
}

/** uid registered under this e-mail (normalized), or null. */
export async function findUidByEmail(email: string): Promise<string | null> {
  const snapshot = await emailRef(emailNormHash(email)).get();
  return snapshot.exists ? String(snapshot.get("uid")) : null;
}

export async function getUser(uid: string): Promise<UserDoc | null> {
  const snapshot = await userRef(uid).get();
  return snapshot.exists ? (snapshot.data() as UserDoc) : null;
}

export async function getUserPrivate(uid: string): Promise<UserPrivateDoc | null> {
  const snapshot = await privateRef(uid).get();
  return snapshot.exists ? (snapshot.data() as UserPrivateDoc) : null;
}

/** Marks the e-mail verified and the account activated (the role claim is set by the caller). */
export async function activateAccount(uid: string, now = new Date()): Promise<void> {
  // A nested map, not a dotted key: set() with merge stores "badges.emailVerified" as a literal field
  // name, which leaves the badge false and makes the strict user schema refuse the document.
  await userRef(uid).set({ activation: "done", badges: { emailVerified: true }, updatedAt: now }, { merge: true });
}

export async function linkProvider(uid: string, provider: "password" | "google.com"): Promise<void> {
  await privateRef(uid).update({ providers: FieldValue.arrayUnion(provider) });
}

/** The account can no longer sign in with this provider (a never-verified password replaced on a Google sign-in). */
export async function unlinkProvider(uid: string, provider: "password" | "google.com"): Promise<void> {
  await privateRef(uid).update({ providers: FieldValue.arrayRemove(provider) });
}

export async function updateDisplayName(uid: string, displayName: string, now = new Date()): Promise<void> {
  await userRef(uid).update({ displayName, updatedAt: now });
}

export async function updateLocale(uid: string, locale: Locale, now = new Date()): Promise<void> {
  await userRef(uid).update({ locale, updatedAt: now });
}

/** Accounts still pending after `before` (purge-unactivated): uids, oldest first. */
export async function listPendingAccounts(before: Date, limit = 200): Promise<string[]> {
  const snapshot = await db()
    .collection(COLLECTIONS.users)
    .where("activation", "==", "pending")
    .where("createdAt", "<", Timestamp.fromDate(before))
    .orderBy("createdAt", "asc")
    .limit(limit)
    .get();
  return snapshot.docs.map((doc) => doc.id);
}

/**
 * Deletes the documents of an account that is still pending (purge-unactivated), in one
 * transaction: an activation that lands between the listing and the purge keeps the account.
 * False, and nothing written, when the user document is gone or no longer pending. The Auth
 * record is deleted by the caller.
 */
export async function deleteAccountDocumentsIfPending(uid: string): Promise<boolean> {
  return db().runTransaction(async (tx) => {
    const [user, account] = await Promise.all([tx.get(userRef(uid)), tx.get(privateRef(uid))]);
    if (!user.exists || user.get("activation") !== "pending") return false;
    const hash: unknown = account.exists ? account.get("emailNormHash") : undefined;
    // The index entry goes only when it is this account's (reads before writes in a transaction).
    const index = typeof hash === "string" && hash ? await tx.get(emailRef(hash)) : null;
    if (index?.exists && String(index.get("uid")) === uid) tx.delete(index.ref);
    if (account.exists) tx.delete(privateRef(uid));
    tx.delete(userRef(uid));
    return true;
  });
}

/** Deletes the documents of an account (Auth record deleted by the caller). */
export async function deleteAccountDocuments(uid: string): Promise<void> {
  const account = await getUserPrivate(uid);
  const batch = db().batch();
  if (account) batch.delete(emailRef(account.emailNormHash));
  batch.delete(privateRef(uid));
  batch.delete(userRef(uid));
  await batch.commit();
}

/** Translates a repository failure into the API answer (never reveals the other account). */
export function isEmailTaken(error: unknown): error is EmailTakenError {
  return error instanceof EmailTakenError;
}

export function assertNotHttp(error: unknown): asserts error is Error {
  if (error instanceof HttpError) throw error;
}
