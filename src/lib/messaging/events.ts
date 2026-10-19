import "server-only";
import type { MessagingEvent } from "@/lib/contracts/messaging";
import { logger } from "@/lib/logging/logger";
import { isValkeyConfigured, valkey } from "@/lib/valkey/clients";

// Live messaging events (design D2): after each committed write the server publishes ids, never a
// message text, on the valkey-queue channel `msg:events:{uid}` of every account concerned; each web
// process subscribed for that uid (bus.ts) fans them out to the account's open streams (stream.ts).
// Best effort: a failure is logged and the write it follows stands; a client that missed an event
// catches up on its next refetch (every reconnection starts with a resync event).

export const EVENT_CHANNEL_PREFIX = "msg:events:";
export const eventChannel = (uid: string) => `${EVENT_CHANNEL_PREFIX}${uid}`;

export interface Delivery {
  uid: string;
  event: MessagingEvent;
}

export type EventPublisher = (deliveries: readonly Delivery[]) => Promise<void>;

/** Request path: a slow Valkey must not hold a write's response. */
const PUBLISH_TIMEOUT_MS = 800;

let publisherForTests: EventPublisher | null | undefined;

/** Tests: an in-memory publisher (null = Valkey not configured); undefined restores the real one. */
export function setEventPublisherForTests(publisher: EventPublisher | null | undefined): void {
  publisherForTests = publisher;
}

async function valkeyPublish(deliveries: readonly Delivery[]): Promise<void> {
  const pipeline = valkey("queue").pipeline();
  for (const { uid, event } of deliveries) pipeline.publish(eventChannel(uid), JSON.stringify(event));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("valkey timeout")), PUBLISH_TIMEOUT_MS);
  });
  const results = await Promise.race([pipeline.exec(), timeout]).finally(() => clearTimeout(timer));
  const failed = results?.find(([error]) => error)?.[0];
  if (!results || failed) throw failed ?? new Error("valkey pipeline aborted");
}

function publisher(): EventPublisher | null {
  if (publisherForTests !== undefined) return publisherForTests;
  return isValkeyConfigured("queue") ? valkeyPublish : null;
}

/** Publishes after a committed write; never throws. */
export async function publishEvents(deliveries: readonly Delivery[]): Promise<void> {
  const publish = publisher();
  if (!publish || deliveries.length === 0) return;
  try {
    await publish(deliveries);
  } catch (error) {
    logger.warn({ err: (error as Error).message, events: deliveries.length }, "messaging: live event publish failed");
  }
}

const unreadEvent = (uid: string, total: number | null): Delivery[] => (total === null ? [] : [{ uid, event: { type: "unread", total } }]);

/** A new message (start or send): both participants, and the recipient's new badge total when known. */
export function publishNewMessage(input: { cid: string; mid: string; senderUid: string; recipientUid: string; recipientUnread: number | null; at: Date }): Promise<void> {
  const event: MessagingEvent = { type: "message", cid: input.cid, mid: input.mid, at: input.at.getTime() };
  return publishEvents([{ uid: input.senderUid, event }, { uid: input.recipientUid, event }, ...unreadEvent(input.recipientUid, input.recipientUnread)]);
}

/** `readerUid` read `cid`: the receipt to the other participant, the row and the badge to the reader's tabs. */
export function publishRead(input: { cid: string; readerUid: string; otherUid: string; readerUnread: number | null; at: Date }): Promise<void> {
  const at = input.at.getTime();
  return publishEvents([
    { uid: input.otherUid, event: { type: "read", cid: input.cid, at } },
    { uid: input.readerUid, event: { type: "conversation", cid: input.cid, at } },
    ...unreadEvent(input.readerUid, input.readerUnread),
  ]);
}

/** The inbox row of `cid` changed for `uids` (archive, delete for me, block, freeze). */
export function publishConversationChange(cid: string, uids: readonly string[], at: Date, unread?: { uid: string; total: number | null }): Promise<void> {
  const event: MessagingEvent = { type: "conversation", cid, at: at.getTime() };
  return publishEvents([...[...new Set(uids)].map((uid) => ({ uid, event })), ...(unread ? unreadEvent(unread.uid, unread.total) : [])]);
}

/** A message hidden or restored by moderation: its participants refetch it. */
export function publishMessageUpdate(cid: string, mid: string, uids: readonly string[], at: Date): Promise<void> {
  const event: MessagingEvent = { type: "message_updated", cid, mid, at: at.getTime() };
  return publishEvents([...new Set(uids)].map((uid) => ({ uid, event })));
}

/** Ban or suspension (D2 security): every web process closes this account's open streams. */
export function publishRevoked(uid: string): Promise<void> {
  return publishEvents([{ uid, event: { type: "revoked" } }]);
}
