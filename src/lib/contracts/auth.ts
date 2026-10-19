import { z } from "@/lib/zod";
import { LOCALES } from "@/config/site";
import { PASSWORD_MAX, PASSWORD_MIN } from "./endpoints";

// Shared client/server contracts of the authentication API (phase 2). Imported by the forms
// (react-hook-form + zodResolver) and by the route handlers: one validation, same messages.
// Objects are strict: unknown fields are refused (§6 injection).

/** Version strings recorded with the consents (users/{uid}/private.consents). */
export const CGU_VERSION = "2026-10";
export const TRANSFERS_CONSENT_VERSION = "2026-10";

export { AUTH_API, PASSWORD_MAX, PASSWORD_MIN } from "./endpoints";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

/** Length only here; strength (common passwords, repetition) is checked by src/lib/auth/password-policy.ts. */
export const passwordSchema = z.string().min(PASSWORD_MIN).max(PASSWORD_MAX);

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  .regex(/^[\p{L}\p{M}\p{N} .'’-]+$/u);

export const localeSchema = z.enum(LOCALES);

/** Turnstile widget token (max 2048 characters, documented). */
export const turnstileTokenSchema = z.string().min(1).max(2048);

/**
 * Turnstile `action` names: the widget declares one, siteverify echoes it and the server refuses a
 * token solved for another action. One list for both sides (a mismatch is a hard 403 in prod).
 */
export const TURNSTILE_ACTIONS = ["signup", "login", "reset", "google", "verify-resend", "staff-login", "phone", "listing", "search", "pages", "pro-apply"] as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[number];

export const consentsSchema = z
  .object({
    /** CGU acceptance. */
    cgu: z.literal(true),
    /** Express consent to transfers outside Morocco (art. 44 loi 09-08). */
    transfers: z.literal(true),
    marketing: z.boolean().default(false),
  })
  .strict();

export const signupSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    displayName: displayNameSchema,
    locale: localeSchema,
    consents: consentsSchema,
    turnstileToken: turnstileTokenSchema,
  })
  .strict();
export type SignupInput = z.infer<typeof signupSchema>;

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(PASSWORD_MAX),
    /** Required from the 3rd failure on this account (the previous answer says `turnstile_required`). */
    turnstileToken: turnstileTokenSchema.optional(),
  })
  .strict();
export type LoginInput = z.infer<typeof loginSchema>;

export const googleSchema = z
  .object({
    /** Google ID token from Google Identity Services. */
    credential: z.string().min(20).max(4096),
    /** Random value the page gave GIS (`initialize({ nonce })`); must match the token's `nonce` claim. */
    nonce: z.string().min(16).max(256),
    /** Sign-up only: consents and Turnstile; absent on a first call, the answer is `needs_consent`. */
    consents: consentsSchema.optional(),
    turnstileToken: turnstileTokenSchema.optional(),
    locale: localeSchema.default("fr"),
  })
  .strict();
export type GoogleInput = z.infer<typeof googleSchema>;

export const sessionSchema = z.object({ idToken: z.string().min(20).max(4096) }).strict();

export const resetRequestSchema = z.object({ email: emailSchema, locale: localeSchema.default("fr"), turnstileToken: turnstileTokenSchema }).strict();
export type ResetRequestInput = z.infer<typeof resetRequestSchema>;

export const resetConfirmSchema = z.object({ oobCode: z.string().min(10).max(512), password: passwordSchema }).strict();
export type ResetConfirmInput = z.infer<typeof resetConfirmSchema>;

export const passwordChangeSchema = z.object({ currentPassword: z.string().min(1).max(PASSWORD_MAX), password: passwordSchema }).strict();

export const actionSchema = z
  .object({
    mode: z.enum(["verifyEmail", "resetPassword"]),
    oobCode: z.string().min(10).max(512),
  })
  .strict();
export type ActionInput = z.infer<typeof actionSchema>;

/** An unverified account has no session: the e-mail identifies it, Turnstile protects the send. */
export const verifyResendSchema = z.object({ email: emailSchema, locale: localeSchema.default("fr"), turnstileToken: turnstileTokenSchema }).strict();
export type VerifyResendInput = z.infer<typeof verifyResendSchema>;

export const profileSchema = z.object({ displayName: displayNameSchema.optional(), locale: localeSchema.optional() }).strict();

/** Moroccan mobile only (06, 07): national or international format, as typed by the user. */
export const phoneStartSchema = z.object({ phone: z.string().trim().min(9).max(20) }).strict();

/** Answers. */
export interface SessionSummary {
  uid: string;
  email: string | null;
  emailVerified: boolean;
  role: "individual" | "pro" | "moderator" | "admin" | null;
  suspended: boolean;
  displayName: string | null;
  publicId: string | null;
  phoneVerified: boolean;
  locale: (typeof LOCALES)[number] | null;
  providers: ("password" | "google.com")[];
}

export type SignupResponse = { status: "verification_sent" };
export type LoginResponse = { status: "signed_in"; session: SessionSummary } | { status: "turnstile_required" } | { status: "verification_required" };
export type GoogleResponse = { status: "signed_in"; session: SessionSummary } | { status: "needs_consent"; email: string; displayName: string | null };
export type ResetRequestResponse = { status: "sent" };
export type ActionResponse = { status: "verified"; session: SessionSummary | null } | { status: "reset_ok"; email: string };
export type PhoneStartResponse = { status: "pending"; code: string; waLink: string; number: string; expiresAt: string };
export type PhoneStatusResponse = { status: "none" | "pending" | "verified" | "expired"; phone: string | null };
export type VerifyResendResponse = { status: "verification_sent" };
export type ResetConfirmResponse = { status: "password_reset" };
export type PasswordChangeResponse = { status: "changed"; session: SessionSummary };
export type ProfileResponse = { session: SessionSummary };
export type SessionResponse = { status: "signed_in"; session: SessionSummary };
export type MeResponse = { session: SessionSummary | null };
export type ClientTokenResponse = { token: string };
