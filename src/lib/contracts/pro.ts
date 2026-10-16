import { z } from "@/lib/zod";
import { turnstileTokenSchema } from "@/lib/contracts/auth";
import { citySlugSchema, regionCodeSchema } from "@/lib/contracts/listings";
import { KYBC_MAX_PIECES, KYBC_MIN_PIECES, proLegalSchema } from "@/lib/pro/kybc";
import { PRO_DESCRIPTION_MAX, PRO_NAME_MAX } from "@/lib/pro/profile-schema";

// Pro application (phase 7 design §4): POST /api/pro/apply. Client-safe contract shared by the
// wizard and the route. The KYBC pieces are uploads (purpose `kyb`) the applicant signed before.

export const proApplySchema = z
  .object({
    name: z.string().trim().min(2).max(PRO_NAME_MAX),
    description: z.string().trim().max(PRO_DESCRIPTION_MAX).default(""),
    regionCode: regionCodeSchema,
    citySlug: citySlugSchema,
    legal: proLegalSchema,
    uploadIds: z.array(z.string().min(1).max(64)).min(KYBC_MIN_PIECES).max(KYBC_MAX_PIECES),
    /** Compliance commitment (§7 art. 30-inspired traceability): must be ticked. */
    complianceCommitment: z.literal(true),
    turnstileToken: turnstileTokenSchema,
  })
  .strict();
export type ProApplyInput = z.infer<typeof proApplySchema>;

export interface ProApplyResponse {
  proId: string;
  status: "pending_verification";
}
