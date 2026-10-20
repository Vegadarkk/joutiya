import "server-only";
import { cidSchema, messageIdSchema, type ConversationView, type MessageView } from "@/lib/contracts/messaging";
import { counterpartOf, type ConversationRecord, type MessageRecord, type PagePosition } from "./repository";

// What a participant sees of a conversation and its messages (design D2): documents mapped to the
// client contracts, and the opaque page cursors. Never the evidence, never the other side's count.

export function conversationView(conversation: ConversationRecord, uid: string): ConversationView {
  const buyer = conversation.buyerUid === uid;
  const other = counterpartOf(conversation, uid);
  const { listingSnapshot: listing, lastMessage } = conversation;
  return {
    cid: conversation.cid,
    listingId: conversation.listingId,
    listingSlugId: conversation.listingSlugId,
    listing: { title: listing.title, price: listing.price, isDonation: listing.isDonation, photo: listing.photo ? { id: listing.photo.id, blurhash: listing.photo.blurhash } : null },
    role: buyer ? "buyer" : "seller",
    counterpart: buyer ? { publicId: conversation.sellerPublicId, displayName: conversation.sellerName } : { publicId: conversation.buyerPublicId, displayName: conversation.buyerName },
    lastMessage: { preview: lastMessage.preview, mine: lastMessage.senderUid === uid, at: lastMessage.at.getTime(), flagged: lastMessage.flagged },
    unread: conversation.unread[uid] ?? 0,
    archived: conversation.archivedBy.includes(uid),
    blockedByMe: conversation.blockedBy.includes(uid),
    blockedMe: conversation.blockedBy.includes(other),
    frozen: conversation.status === "frozen",
    counterpartClosed: (conversation.accountClosed ?? []).includes(other),
    updatedAt: conversation.updatedAt.getTime(),
  };
}

/** A hidden message keeps its place: HIDDEN_MARKER text, `hidden: true` (D11, D13). */
export function messageView(message: MessageRecord, uid: string): MessageView {
  return {
    id: message.id,
    mine: message.senderUid === uid,
    type: message.type,
    text: message.text,
    flags: message.risk?.flags ?? [],
    hidden: message.hidden === true,
    createdAt: message.createdAt.getTime(),
    readAt: message.readAt?.getTime() ?? null,
  };
}

/** Visible in the inbox of `uid`: a participant who did not delete it for himself (D7). */
export const isVisibleTo = (conversation: ConversationRecord, uid: string): boolean => conversation.participants.includes(uid) && !conversation.hiddenFor.includes(uid);

export type CursorKind = "conversation" | "message";

const CURSOR = /^[A-Za-z0-9_-]{4,64}$/;
const ID_SCHEMA = { conversation: cidSchema, message: messageIdSchema } as const;

/** base64url("{epoch ms}.{document id}"). */
export function encodeCursor(position: PagePosition): string {
  return Buffer.from(`${position.at.getTime()}.${position.id}`, "utf8").toString("base64url");
}

/** null for anything this server did not produce (or a cursor of the other kind). */
export function decodeCursor(value: string, kind: CursorKind): PagePosition | null {
  if (!CURSOR.test(value)) return null;
  const text = Buffer.from(value, "base64url").toString("utf8");
  const dot = text.indexOf(".");
  const ms = text.slice(0, dot);
  const id = text.slice(dot + 1);
  if (dot < 1 || !/^\d{1,15}$/.test(ms) || !ID_SCHEMA[kind].safeParse(id).success) return null;
  const at = new Date(Number(ms));
  return Number.isNaN(at.getTime()) ? null : { at, id };
}
