import { z } from "@/lib/zod";
import { PRO_PLANS, listingQuotasSchema } from "@/config/pricing";
import { citySlugSchema, regionCodeSchema } from "@/lib/contracts/listings";
import { KYBC_MAX_PIECES, KYBC_STATUSES, proLegalSchema } from "./kybc";
import { PLAN_SOURCES, PRO_STATES } from "./lifecycle";

// proProfiles/{proId} (architecture §5 `ProProfile`, phase 7 design §3). No server import: the
// repository (src/lib/db/repositories/pro-profiles.ts) and the unit tests share this schema.
// The registration IP is in connectionLogs, never here. Written by the server only.

export const PRO_ID_PATTERN = /^[a-hj-km-np-z2-9]{8}$/;
export const proIdSchema = z.string().regex(PRO_ID_PATTERN);

export const PRO_NAME_MAX = 80;
export const PRO_DESCRIPTION_MAX = 2000;
export const PRO_SLUG_MAX = 60;

const uid = z.string().min(1).max(128);
const ts = z.date();

export const proProfileSchema = z
  .object({
    ownerUid: uid,
    /** `editor` seats arrive in V1.1 (§6); the MVP has the owner only. */
    members: z.record(uid, z.enum(["owner", "editor"])),
    name: z.string().trim().min(2).max(PRO_NAME_MAX),
    slug: z.string().min(1).max(PRO_SLUG_MAX).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    description: z.string().max(PRO_DESCRIPTION_MAX),
    logoKey: z.string().max(200).optional(),
    coverKey: z.string().max(200).optional(),
    /** Verified number, revealed under quota like an individual's (never in the HTML). */
    phonePublic: z.string().max(20).optional(),
    whatsapp: z.boolean(),
    website: z.url({ protocol: /^https$/ }).max(200).optional(),
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    legal: proLegalSchema,
    kybc: z
      .object({
        status: z.enum(KYBC_STATUSES),
        iceFormatOk: z.boolean(),
        registryCheck: z.object({ source: z.enum(["ompic", "directinfo"]), at: ts, by: uid }).strict().optional(),
        /** Pieces in the private bucket (uploads purpose `kyb`), purged 6 months after the relationship ends. */
        uploadIds: z.array(z.string().min(1).max(64)).max(KYBC_MAX_PIECES),
        complianceCommitmentAt: ts.optional(),
        submittedAt: ts.optional(),
        rejectReason: z.string().max(1000).optional(),
        decisionId: z.string().max(64).optional(),
      })
      .strict(),
    /** Badge « Certifié »: pieces checked in detail (Business). */
    certified: z.object({ at: ts, by: uid }).strict().optional(),
    lifecycle: z.enum(PRO_STATES),
    /** Copy of subscriptions/pro_{proId}, or the launch offer's plan. */
    plan: z.enum(PRO_PLANS),
    planSource: z.enum(PLAN_SOURCES),
    graceUntil: ts.optional(),
    downgradedAt: ts.optional(),
    suspendedFrom: z.enum(PRO_STATES).optional(),
    launchOfferNoticeSentAt: ts.optional(),
    /** Derived from config/pricing for `plan`. */
    quotas: listingQuotasSchema,
    createdAt: ts,
    updatedAt: ts,
  })
  .strict();
export type ProProfileDoc = z.infer<typeof proProfileSchema>;
