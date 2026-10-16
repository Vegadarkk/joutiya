import { z } from "@/lib/zod";
import { LOCALES } from "@/config/site";
import { ROLES } from "@/lib/firebase/claims";

// Firestore documents (architecture §5), one Zod schema per collection written in phase 2.
// `.strict()` everywhere: no unknown field reaches Firestore. Timestamps are stored as Firestore
// Timestamps; the schemas accept Date for construction and validate the shape only.

const ts = z.date();
const uid = z.string().min(1).max(128);

export const localeSchema = z.enum(LOCALES);

/** 10 random characters from an unambiguous alphabet: /profil/{publicId}. */
export const publicIdSchema = z.string().regex(/^[a-hj-km-np-z2-9]{10}$/);

export const displayNameSchema = z
  .string()
  .trim()
  .min(2)
  .max(40)
  // Letters of any script, digits, spaces and a few separators: no URLs, no control characters.
  .regex(/^[\p{L}\p{M}\p{N} .'’-]+$/u);

export const userStatusSchema = z.enum(["active", "restricted", "suspended", "banned", "closed"]);

/** users/{uid}: public profile, rendered by the server. */
export const userSchema = z
  .object({
    publicId: publicIdSchema,
    displayName: displayNameSchema,
    avatarKey: z.string().max(200).optional(),
    type: z.enum(["individual", "pro"]),
    proId: z.string().max(64).optional(),
    regionCode: z.string().regex(/^(0[1-9]|1[0-2])$/).optional(),
    citySlug: z.string().max(64).optional(),
    badges: z.object({ emailVerified: z.boolean(), phoneVerified: z.boolean(), proCertified: z.boolean() }).strict(),
    stats: z
      .object({ activeListings: z.number().int().min(0), responseRate: z.number().min(0).max(1), medianReplyMin: z.number().min(0), ratingAvg: z.number().min(0).max(5).optional(), ratingCount: z.number().int().min(0) })
      .strict(),
    status: userStatusSchema,
    /** "pending" until the e-mail is verified and the role claim set; purge-unactivated deletes pending accounts after 24 h. */
    activation: z.enum(["pending", "done"]),
    locale: localeSchema,
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type UserDoc = z.infer<typeof userSchema>;

export const consentSchema = z.object({ version: z.string().min(1).max(20), at: ts }).strict();

/** users/{uid}/private/account: never exposed to the client. */
export const userPrivateSchema = z
  .object({
    email: z.string().email().max(254),
    /** HMAC of the normalized e-mail (Gmail dots, +tag): limits and duplicates. */
    emailNormHash: z.string().min(16).max(64),
    phoneE164: z.string().regex(/^\+212[5-7]\d{8}$/).optional(),
    phoneVerifiedAt: ts.optional(),
    legalName: z.string().max(120).optional(),
    consents: z
      .object({
        cgu: consentSchema,
        /** Art. 44 loi 09-08: express consent to data transfers outside Morocco. */
        transfers: consentSchema,
        marketing: z.boolean(),
      })
      .strict(),
    strikes: z.object({ level: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]), lastAt: ts.optional(), suspendedUntil: ts.optional() }).strict(),
    reporter: z.object({ recent: z.array(z.boolean()).max(10), total: z.number().int().min(0), abusiveUntil: ts.optional() }).strict(),
    /** Sign-in providers linked to the account ("password", "google.com"). */
    providers: z.array(z.enum(["password", "google.com"])).max(2),
    closedAt: ts.optional(),
    purgeAt: ts.optional(),
    identityPurgeAt: ts.optional(),
  })
  .strict();
export type UserPrivateDoc = z.infer<typeof userPrivateSchema>;

/** emailIndex/{emailNormHash}: one account per normalized e-mail, enforced in a transaction. */
export const emailIndexSchema = z.object({ uid, createdAt: ts }).strict();
export type EmailIndexDoc = z.infer<typeof emailIndexSchema>;

/** connectionLogs/{id}: IP in clear (décret 2021-1362), admin-only under a requisition, purged after 1 year. */
export const connectionLogSchema = z
  .object({
    uid,
    event: z.enum(["signup", "login", "google_login", "google_signup", "staff_login", "password_reset", "password_change", "logout"]),
    ip: z.string().max(45),
    userAgent: z.string().max(200).optional(),
    at: ts,
    purgeAt: ts,
  })
  .strict();
export type ConnectionLogDoc = z.infer<typeof connectionLogSchema>;

/** auditLogs/{id}: append-only journal of staff and system actions (§5, 5 years). */
export const auditLogSchema = z
  .object({
    actorUid: z.string().max(128),
    actorRole: z.enum([...ROLES, "system"]),
    action: z.string().min(1).max(64),
    target: z.object({ type: z.string().min(1).max(32), id: z.string().min(1).max(128) }).strict(),
    automated: z.boolean(),
    reason: z.string().max(500).optional(),
    ipHash: z.string().max(64).optional(),
    at: ts,
  })
  .strict();
export type AuditLogDoc = z.infer<typeof auditLogSchema>;

/** mailSuppressions/{emailHash}: no non-transactional mail to these addresses (webhook of the ESP). */
export const mailSuppressionSchema = z
  .object({ reason: z.enum(["bounce", "complaint"]), provider: z.string().max(20), at: ts })
  .strict();
export type MailSuppressionDoc = z.infer<typeof mailSuppressionSchema>;

export const COLLECTIONS = {
  users: "users",
  userPrivate: "private",
  userPrivateDoc: "account",
  emailIndex: "emailIndex",
  connectionLogs: "connectionLogs",
  auditLogs: "auditLogs",
  mailSuppressions: "mailSuppressions",
  /** staff/{uid}: back-office roster (src/lib/db/repositories/staff.ts). */
  staff: "staff",
} as const;
