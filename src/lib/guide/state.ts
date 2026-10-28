import "server-only";
import type { Firestore } from "firebase-admin/firestore";
import { GUIDE_SOURCES, isGuideSourceId, type GuideSourceId } from "@/content/guide/sources";
import { COLLECTIONS } from "@/lib/db/schemas";
import { db, isFirestoreConfigured } from "@/lib/firebase/admin";
import { notFound } from "@/lib/http/errors";
import { logger } from "@/lib/logging/logger";
import { consume } from "@/lib/quota";
import { z } from "@/lib/zod";
import { acceptLinkState, LINK_OUTCOMES, type LinkState } from "./check";

// State of the guide's link checker (design guide-demarches G4): one document, system/guide-links,
// read once and written once per weekly run (src/worker/jobs/guide-links.ts); the guide pages read
// it through a 5-minute cache, the back office fresh. An entry that fails its schema is dropped (the
// next run rebuilds it).

export const GUIDE_STATE_DOC = "guide-links";

const iso = z.string().max(40);
const fingerprintSchema = z.object({ simhash: z.string().max(16), sha256: z.string().max(64) }).strict();
const linkStateSchema = z
  .object({
    url: z.string().max(500),
    outcome: z.enum(LINK_OUTCOMES),
    detail: z.string().max(300),
    httpStatus: z.number().int().nullable(),
    finalUrl: z.string().max(1000),
    checkedAt: iso,
    streak: z.number().int().min(0),
    lastOkAt: iso.optional(),
    fingerprint: fingerprintSchema.optional(),
    baseline: fingerprintSchema.extend({ at: iso }).optional(),
    acceptedAt: iso.optional(),
    acceptedBy: z.string().max(128).optional(),
  })
  .strict();

export interface GuideState {
  runAt: string | null;
  links: Partial<Record<GuideSourceId, LinkState>>;
}

const EMPTY: GuideState = { runAt: null, links: {} };

export function parseGuideState(data: unknown): GuideState {
  if (!data || typeof data !== "object") return { runAt: null, links: {} };
  const record = data as { runAt?: unknown; links?: unknown };
  const links: GuideState["links"] = {};
  if (record.links && typeof record.links === "object") {
    for (const [id, value] of Object.entries(record.links)) {
      if (!isGuideSourceId(id)) continue;
      const parsed = linkStateSchema.safeParse(value);
      if (parsed.success) links[id] = parsed.data as LinkState;
    }
  }
  return { runAt: typeof record.runAt === "string" ? record.runAt : null, links };
}

const ref = (firestore: Firestore) => firestore.collection(COLLECTIONS.system).doc(GUIDE_STATE_DOC);

export async function readGuideState(firestore: Firestore = db()): Promise<GuideState> {
  const snapshot = await ref(firestore).get();
  void consume("firestore.reads", 1);
  return parseGuideState(snapshot.data());
}

export async function writeGuideState(state: GuideState, firestore: Firestore = db()): Promise<void> {
  await ref(firestore).set(state);
  void consume("firestore.writes", 1);
}

const CACHE_MS = 5 * 60_000;
let cache: { value: GuideState; expires: number } | undefined;

export function resetGuideStateCache(): void {
  cache = undefined;
}

/** For the guide pages: never throws; the last value, then an empty state (every confirmed link live). */
export async function getGuideState(now = Date.now()): Promise<GuideState> {
  if (cache && cache.expires > now) return cache.value;
  if (!isFirestoreConfigured()) return EMPTY;
  try {
    const value = await readGuideState();
    cache = { value, expires: now + CACHE_MS };
    return value;
  } catch (error) {
    logger.error({ err: (error as Error).message }, "system/guide-links unreachable: last known state rendered");
    return cache?.value ?? EMPTY;
  }
}

/** Staff "verified" on one source: its current page becomes the reference (transaction). */
export async function acceptGuideLink(id: string, uid: string, now = new Date(), firestore: Firestore = db()): Promise<LinkState> {
  if (!isGuideSourceId(id)) throw notFound();
  const accepted = await firestore.runTransaction(async (transaction) => {
    const snapshot = await transaction.get(ref(firestore));
    const state = parseGuideState(snapshot.data());
    const current = state.links[id];
    if (!current || current.url !== GUIDE_SOURCES[id].url) throw notFound("Not checked yet");
    const next = acceptLinkState(current, uid, now);
    transaction.set(ref(firestore), { ...state, links: { ...state.links, [id]: next } });
    return next;
  });
  void consume("firestore.reads", 1);
  void consume("firestore.writes", 1);
  cache = undefined;
  return accepted;
}
