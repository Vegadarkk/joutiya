import "server-only";
import type { Redis } from "ioredis";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";
import { phoneKey } from "./codes";

// Pending challenges live in valkey-queue (noeviction: a challenge is never evicted under memory
// pressure, §2) for the 10 minutes of their validity, plus a grace period so the account page can
// say "expired" rather than "none". Without QUEUE_REDIS_URL (dev, tests) an in-memory store applies
// the same semantics. Webhook message ids (wamid) are remembered 24 h to absorb Meta's retries.
//
// Three keys per challenge: uid -> challenge, number -> uid (the latest start for the number) and
// (number, code) -> uid. The last one lets the code in the inbound message pick the right account
// when several accounts hold a challenge for the same number, so nobody can block a number by
// starting a challenge for it.

export interface ChallengeInput {
  phoneE164: string;
  codeHash: string;
  /** Key material of the (number, code) index (codes.ts phoneCodeKey); stored as a key, never the code. */
  codeKey: string;
  /** Milliseconds since the epoch. */
  expiresAt: number;
}

export interface StoredChallenge extends ChallengeInput {
  uid: string;
}

export interface ChallengeStore {
  /** Stores the challenge of `uid`, replacing any previous one (the number and code indexes follow). */
  put(uid: string, challenge: ChallengeInput): Promise<void>;
  getByUid(uid: string): Promise<StoredChallenge | null>;
  /** Challenge currently attached to this number (the latest `put` for the number wins). */
  getByPhone(e164: string): Promise<StoredChallenge | null>;
  /** Challenge of this number whose code produced `codeKey`, whichever account started it. */
  getByCode(e164: string, codeKey: string): Promise<StoredChallenge | null>;
  delete(uid: string): Promise<void>;
  /** True when this wamid was already processed; otherwise marks it for 24 h. */
  seen(wamid: string): Promise<boolean>;
  /** Unmarks a wamid whose processing failed, so Meta's retry is processed again. */
  forget(wamid: string): Promise<void>;
}

/** Validity of a challenge. */
export const CHALLENGE_TTL_SECONDS = 10 * 60;
/** An expired challenge stays readable this long, so status() can answer "expired". */
export const EXPIRED_GRACE_SECONDS = 30 * 60;
export const WAMID_TTL_SECONDS = 24 * 60 * 60;

const uidKey = (uid: string) => `pv:u:${uid}`;
const phoneRef = (e164: string) => `pv:p:${phoneKey(e164)}`;
const codeRef = (codeKey: string) => `pv:pc:${codeKey}`;
const wamidKey = (wamid: string) => `pv:m:${wamid}`;

/** Seconds to keep a challenge: until it expires, plus the grace period. */
function keepSeconds(expiresAt: number, now: number): number {
  return Math.max(1, Math.ceil((expiresAt - now) / 1000) + EXPIRED_GRACE_SECONDS);
}

function parseStored(uid: string, raw: string | null): StoredChallenge | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as Partial<ChallengeInput> | null;
    if (!value || typeof value.phoneE164 !== "string" || typeof value.codeHash !== "string" || typeof value.codeKey !== "string" || typeof value.expiresAt !== "number") return null;
    return { uid, phoneE164: value.phoneE164, codeHash: value.codeHash, codeKey: value.codeKey, expiresAt: value.expiresAt };
  } catch {
    return null;
  }
}

/** The subset of the client the store needs (fakeable in tests). */
export type ChallengeClient = Pick<Redis, "get" | "set" | "del">;

export class ValkeyChallengeStore implements ChallengeStore {
  constructor(
    private readonly client: ChallengeClient,
    private readonly now: () => number = Date.now,
  ) {}

  async put(uid: string, challenge: ChallengeInput): Promise<void> {
    const previous = await this.getByUid(uid);
    if (previous) await this.releaseIndexes(previous, uid, previous.phoneE164 !== challenge.phoneE164);
    const ttl = keepSeconds(challenge.expiresAt, this.now());
    const value: ChallengeInput = { phoneE164: challenge.phoneE164, codeHash: challenge.codeHash, codeKey: challenge.codeKey, expiresAt: challenge.expiresAt };
    await this.client.set(uidKey(uid), JSON.stringify(value), "EX", ttl);
    await this.client.set(phoneRef(challenge.phoneE164), uid, "EX", ttl);
    await this.client.set(codeRef(challenge.codeKey), uid, "EX", ttl);
  }

  async getByUid(uid: string): Promise<StoredChallenge | null> {
    return parseStored(uid, await this.client.get(uidKey(uid)));
  }

  async getByPhone(e164: string): Promise<StoredChallenge | null> {
    const uid = await this.client.get(phoneRef(e164));
    if (!uid) return null;
    const challenge = await this.getByUid(uid);
    // The pointer may outlive a challenge replaced by another number: never trust it alone.
    return challenge && challenge.phoneE164 === e164 ? challenge : null;
  }

  async getByCode(e164: string, codeKey: string): Promise<StoredChallenge | null> {
    const uid = await this.client.get(codeRef(codeKey));
    if (!uid) return null;
    const challenge = await this.getByUid(uid);
    return challenge && challenge.phoneE164 === e164 && challenge.codeKey === codeKey ? challenge : null;
  }

  async delete(uid: string): Promise<void> {
    const current = await this.getByUid(uid);
    await this.client.del(uidKey(uid));
    if (current) await this.releaseIndexes(current, uid, true);
  }

  async seen(wamid: string): Promise<boolean> {
    const result = await this.client.set(wamidKey(wamid), "1", "EX", WAMID_TTL_SECONDS, "NX");
    return result === null;
  }

  async forget(wamid: string): Promise<void> {
    await this.client.del(wamidKey(wamid));
  }

  /** Drops the indexes of `challenge` only while they still name `uid`: another account may have claimed them. */
  private async releaseIndexes(challenge: StoredChallenge, uid: string, phone: boolean): Promise<void> {
    if (phone && (await this.client.get(phoneRef(challenge.phoneE164))) === uid) await this.client.del(phoneRef(challenge.phoneE164));
    if ((await this.client.get(codeRef(challenge.codeKey))) === uid) await this.client.del(codeRef(challenge.codeKey));
  }
}

interface MemoryEntry extends StoredChallenge {
  /** Milliseconds since the epoch: forgotten afterwards (expiry + grace). */
  keepUntil: number;
}

export class MemoryChallengeStore implements ChallengeStore {
  private readonly byUid = new Map<string, MemoryEntry>();
  private readonly byPhone = new Map<string, string>();
  private readonly byCode = new Map<string, string>();
  private readonly wamids = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  async put(uid: string, challenge: ChallengeInput): Promise<void> {
    const previous = this.entry(uid);
    if (previous) this.releaseIndexes(previous, uid, previous.phoneE164 !== challenge.phoneE164);
    this.byUid.set(uid, { uid, phoneE164: challenge.phoneE164, codeHash: challenge.codeHash, codeKey: challenge.codeKey, expiresAt: challenge.expiresAt, keepUntil: challenge.expiresAt + EXPIRED_GRACE_SECONDS * 1000 });
    this.byPhone.set(challenge.phoneE164, uid);
    this.byCode.set(challenge.codeKey, uid);
  }

  async getByUid(uid: string): Promise<StoredChallenge | null> {
    const entry = this.entry(uid);
    return entry ? { uid: entry.uid, phoneE164: entry.phoneE164, codeHash: entry.codeHash, codeKey: entry.codeKey, expiresAt: entry.expiresAt } : null;
  }

  async getByPhone(e164: string): Promise<StoredChallenge | null> {
    const uid = this.byPhone.get(e164);
    if (!uid) return null;
    const challenge = await this.getByUid(uid);
    if (!challenge || challenge.phoneE164 !== e164) {
      this.byPhone.delete(e164);
      return null;
    }
    return challenge;
  }

  async getByCode(e164: string, codeKey: string): Promise<StoredChallenge | null> {
    const uid = this.byCode.get(codeKey);
    if (!uid) return null;
    const challenge = await this.getByUid(uid);
    if (!challenge || challenge.codeKey !== codeKey) {
      this.byCode.delete(codeKey);
      return null;
    }
    return challenge.phoneE164 === e164 ? challenge : null;
  }

  async delete(uid: string): Promise<void> {
    const current = this.byUid.get(uid);
    this.byUid.delete(uid);
    if (current) this.releaseIndexes(current, uid, true);
  }

  async seen(wamid: string): Promise<boolean> {
    const now = this.now();
    const until = this.wamids.get(wamid);
    if (until !== undefined && until > now) return true;
    if (this.wamids.size > 10_000) for (const [key, expiry] of this.wamids) if (expiry <= now) this.wamids.delete(key);
    this.wamids.set(wamid, now + WAMID_TTL_SECONDS * 1000);
    return false;
  }

  async forget(wamid: string): Promise<void> {
    this.wamids.delete(wamid);
  }

  private releaseIndexes(challenge: StoredChallenge, uid: string, phone: boolean): void {
    if (phone && this.byPhone.get(challenge.phoneE164) === uid) this.byPhone.delete(challenge.phoneE164);
    if (this.byCode.get(challenge.codeKey) === uid) this.byCode.delete(challenge.codeKey);
  }

  private entry(uid: string): MemoryEntry | null {
    const entry = this.byUid.get(uid);
    if (!entry) return null;
    if (entry.keepUntil <= this.now()) {
      this.byUid.delete(uid);
      this.releaseIndexes(entry, uid, true);
      return null;
    }
    return entry;
  }
}

let instance: ChallengeStore | undefined;

export function challengeStore(): ChallengeStore {
  instance ??= isValkeyConfigured("queue") ? new ValkeyChallengeStore(valkey("queue")) : new MemoryChallengeStore();
  return instance;
}

/** Tests only: forget the singleton (and every in-memory challenge). */
export function resetChallengeStoreForTests(): void {
  instance = undefined;
}
