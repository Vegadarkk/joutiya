import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { listingIdSchema } from "@/lib/contracts/listings";

// Messaging contracts shared by the browser and the route handlers (design D1-D7). Messages are plain
// text; the server masks URLs before storage and the reader renders the markers below as chips.

export const MESSAGE_TEXT_MAX = 2000;
/** Stored in place of every URL of a message (D5); the UI shows a localized "link hidden" chip. */
export const URL_MARKER = "⟦url⟧";
/** Text of a message hidden by moderation. */
export const HIDDEN_MARKER = "⟦hidden⟧";
/** Inbox page size of the realtime listener (D2). */
export const INBOX_PAGE = 30;
/** Thread page size of the realtime listener and of older pages (D2). */
export const THREAD_PAGE = 50;

export const MESSAGE_RISK_FLAGS = ["external_url", "iban", "payment_kw", "contact_with_payment_kw"] as const;
export type MessageRiskFlag = (typeof MESSAGE_RISK_FLAGS)[number];

/** Conversation id: 22 base64url characters derived on the server (D1). */
export const cidSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);
/** Firestore auto id of a message. */
export const messageIdSchema = z.string().regex(/^[A-Za-z0-9]{20}$/);

/**
 * Format characters (Unicode Cf: zero-width spaces, bidi marks and overrides, soft hyphen, BOM...)
 * except ZWNJ and ZWJ (U+200C, U+200D: Arabic and emoji sequences need them). Invisible, they split
 * a keyword, a bank account or a domain past the risk rules and spoof the display direction.
 */
const FORMAT_CHARACTERS = /(?![‌‍])\p{Cf}/gu;

/** `text` without its format characters: applied before validation and risk analysis (D5). */
export const stripFormatCharacters = (text: string): string => text.replace(FORMAT_CHARACTERS, "");

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

/** What the browser maps a conversation document to (listener, D2). Dates are epoch ms. */
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
