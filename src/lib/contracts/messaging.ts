import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { MESSAGE_TEXT_MAX } from "@/lib/contracts/endpoints";
import { listingIdSchema } from "@/lib/contracts/listings";

// Messaging contracts shared by the browser and the route handlers (design D1-D7). Messages are plain
// text; the server masks URLs before storage and the reader renders the markers below as chips.

// The limit lives in endpoints.ts: the listing page's message button needs it without zod.
export { MESSAGE_TEXT_MAX };
/** Stored in place of every URL of a message (D5); the UI shows a localized "link hidden" chip. */
export const URL_MARKER = "⟦url⟧";
/** Text of a message hidden by moderation. */
export const HIDDEN_MARKER = "⟦hidden⟧";
/** Inbox page size of GET /api/conversations (D2). */
export const INBOX_PAGE = 30;
/** Thread page size of GET /api/conversations/{cid}/messages (D2). */
export const THREAD_PAGE = 50;

export const MESSAGE_RISK_FLAGS = ["external_url", "iban", "payment_kw", "contact_with_payment_kw"] as const;
export type MessageRiskFlag = (typeof MESSAGE_RISK_FLAGS)[number];

/** Conversation id: 22 base64url characters derived on the server (D1). */
export const cidSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** Firestore auto id of a message. */
export const messageIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/);

/**
 * Format characters (Unicode Cf: zero-width spaces and joiners, bidi marks and overrides, soft
 * hyphen, BOM...). Invisible, they split a keyword, a bank account or a domain past the risk rules
 * and spoof the display direction. ZWNJ and ZWJ (U+200C, U+200D) stay only where scripts need them:
 * between two Arabic-script characters, and inside an emoji sequence (after a pictograph, a skin
 * tone or VS16, before a pictograph). Anywhere else they go too (audit D1a-11: "w\u200Dhatsapp").
 */
const FORMAT_CHARACTERS = /\p{Cf}/gu;
const ARABIC = /^\p{Script=Arabic}$/u;
const EMOJI_BEFORE = /^[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u;
const EMOJI_AFTER = /^\p{Extended_Pictographic}$/u;

function joinerNeeded(text: string, offset: number): boolean {
  const before = Array.from(text.slice(Math.max(0, offset - 2), offset)).pop() ?? "";
  const next = text.codePointAt(offset + 1);
  const after = next === undefined ? "" : String.fromCodePoint(next);
  return (ARABIC.test(before) && ARABIC.test(after)) || (EMOJI_BEFORE.test(before) && EMOJI_AFTER.test(after));
}

/** `text` without its format characters: applied before validation and risk analysis (D5). */
export const stripFormatCharacters = (text: string): string =>
  text.replace(FORMAT_CHARACTERS, (char: string, offset: number) => ((char === "\u200C" || char === "\u200D") && joinerNeeded(text, offset) ? char : ""));

const messageTextSchema = z.preprocess(
  (value) => (typeof value === "string" ? stripFormatCharacters(value) : value),
  z
    .string()
    .trim()
    .min(1)
    .max(MESSAGE_TEXT_MAX)
    // No control characters except tab and newlines; the markers are reserved for the server.
    .refine((text) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text), { message: "control_characters" })
    .refine((text) => !text.includes("⟦") && !text.includes("⟧"), { message: "reserved_marker" }),
);

export const startConversationSchema = z
  .object({ listingId: listingIdSchema, text: messageTextSchema, turnstileToken: turnstileTokenSchema })
  .strict();
export type StartConversationRequest = z.infer<typeof startConversationSchema>;

export const sendMessageSchema = z.object({ text: messageTextSchema }).strict();
export type SendMessageRequest = z.infer<typeof sendMessageSchema>;

/** One change per call: archive/unarchive, hide for me, block/unblock the other participant. */
export const conversationStateSchema = z.union([
  z.object({ archived: z.boolean() }).strict(),
  z.object({ hidden: z.literal(true) }).strict(),
  z.object({ blocked: z.boolean() }).strict(),
]);
export type ConversationStateRequest = z.infer<typeof conversationStateSchema>;

export interface StartConversationResponse {
  cid: string;
  messageId: string;
  /** true when the conversation already existed: the message was appended. */
  existing: boolean;
}

export interface SendMessageResponse {
  messageId: string;
  flags: MessageRiskFlag[];
}

export interface UnreadResponse {
  total: number;
}

/** One conversation as its participant sees it (inbox row, thread header; D2). Dates are epoch ms. */
export interface ConversationView {
  cid: string;
  listingId: string;
  listingSlugId: string;
  listing: { title: string; price: number | null; isDonation: boolean; photo: { id: string; blurhash: string } | null };
  role: "buyer" | "seller";
  counterpart: { publicId: string; displayName: string };
  lastMessage: { preview: string; mine: boolean; at: number; flagged: boolean };
  unread: number;
  archived: boolean;
  blockedByMe: boolean;
  blockedMe: boolean;
  frozen: boolean;
  updatedAt: number;
}

export interface MessageView {
  id: string;
  mine: boolean;
  type: "text" | "system";
  text: string;
  flags: MessageRiskFlag[];
  hidden: boolean;
  createdAt: number;
  readAt: number | null;
}

/**
 * GET /api/conversations?cursor=&archived=1: the caller's conversations, newest activity first.
 * Conversations deleted for the caller never appear; archived ones only with `archived=1`. A page
 * scans INBOX_PAGE conversations, so it may hold fewer rows (even none) while `next` is set.
 */
export interface ConversationsPage {
  conversations: ConversationView[];
  /** Opaque cursor of the next page; absent at the end. */
  next?: string;
}

/** GET /api/conversations/{cid}: one inbox row (404 when deleted for the caller). */
export interface ConversationResponse {
  conversation: ConversationView;
}

/**
 * GET /api/conversations/{cid}/messages?cursor= (older page) or ?after= (only newer messages):
 * the conversation and up to THREAD_PAGE messages, newest first. Hidden messages keep their place
 * with `hidden: true` and the HIDDEN_MARKER text.
 */
export interface MessagesPage {
  conversation: ConversationView;
  messages: MessageView[];
  /** Cursor of the older page; absent at the beginning of the conversation. */
  next?: string;
  /** First page and `after` reads: position of the newest message (else the `after` given), the next `after`. */
  latest?: string;
  /** `after` only: more than THREAD_PAGE newer messages exist; reload the first page instead. */
  gap?: boolean;
}

// Live stream (GET /api/messages/stream, D2): server-sent events, each one `data:` JSON of a
// MessagingEvent (no event name). Ids only, never a message text: the page refetches through the API.
export const MESSAGING_EVENT_TYPES = ["ready", "resync", "message", "message_updated", "read", "conversation", "unread", "revoked"] as const;
export type MessagingEventType = (typeof MESSAGING_EVENT_TYPES)[number];

export type MessagingEvent =
  /** First event of a stream opened without Last-Event-ID: live from now on. */
  | { type: "ready" }
  /** First event of a reconnection (Last-Event-ID): events may have been missed, refetch. */
  | { type: "resync" }
  /** A new message in `cid` (either participant's). */
  | { type: "message"; cid: string; mid: string; at: number }
  /** A message hidden or restored by moderation: refetch the page holding it. */
  | { type: "message_updated"; cid: string; mid: string; at: number }
  /** The other participant read `cid` at `at` (read receipt of my messages). */
  | { type: "read"; cid: string; at: number }
  /** The inbox row of `cid` changed: read here or in another tab, archived, deleted for me, blocked, frozen. */
  | { type: "conversation"; cid: string; at: number }
  /** New unread total of the badge. */
  | { type: "unread"; total: number }
  /** The account was banned or suspended: the stream ends, do not reconnect before /api/auth/me. */
  | { type: "revoked" };
