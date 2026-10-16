import "server-only";
import { createHash } from "node:crypto";

// Conversation id (design D1): one conversation per (listing, buyer), derived on the server so no
// lookup query is needed and no uid appears in /messages/{cid}. The browser never derives it: it
// gets the cid from POST /api/conversations or from its realtime inbox.

const VERSION = "conv:v1";

/** base64url(sha256("conv:v1:" + listingId + ":" + buyerUid)), 22 characters (132 bits). */
export function conversationId(listingId: string, buyerUid: string): string {
  return createHash("sha256").update(`${VERSION}:${listingId}:${buyerUid}`).digest("base64url").slice(0, 22);
}
