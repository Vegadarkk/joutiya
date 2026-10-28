import { REVIEW_REPLY_MAX, REVIEW_TEXT_MAX, REVIEW_TEXT_MIN } from "@/config/reviews";
import { cidSchema, stripFormatCharacters } from "@/lib/contracts/messaging";
import { z } from "@/lib/zod";

// Request bodies of the reviews API (vitrine-avis §2), checked by the route handlers.

/** Review id: 22 base64url characters derived from the conversation on the server. */
export const reviewIdSchema = z.string().regex(/^[A-Za-z0-9_-]{22}$/);

const textSchema = (min: number, max: number) =>
  z.preprocess(
    (value) => (typeof value === "string" ? stripFormatCharacters(value) : value),
    z
      .string()
      .trim()
      .min(min)
      .max(max)
      .refine((text) => !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text), { message: "control_characters" }),
  );

export const reviewInputSchema = z
  .object({
    cid: cidSchema,
    rating: z.number().int().min(1).max(5),
    text: textSchema(REVIEW_TEXT_MIN, REVIEW_TEXT_MAX),
    /** "Nous avons conclu un échange ou une rencontre": the author's own statement. */
    exchangeConfirmed: z.literal(true),
  })
  .strict();

export const reviewReplySchema = z.object({ text: textSchema(1, REVIEW_REPLY_MAX) }).strict();

