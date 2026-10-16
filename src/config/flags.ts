import { z } from "@/lib/zod";

// Feature flags (architecture §5 `config/flags`, §10 sales gate). Live values come from Firestore
// `config/flags` (admin-edited, journaled, 5-min server cache in src/lib/config/runtime.ts); this
// file holds the schema and the defaults. Defaults are the production-safe values: no sale until
// the sales gate is passed (owner, 2026-10-16), Pro accounts open from launch (phase 7 before
// launch, owner 2026-10-16).

export const flagsConfigSchema = z
  .object({
    /** Every purchase route and buy button (credits, options, Pro subscriptions). */
    salesEnabled: z.boolean(),
    /** Pro applications (`/devenir-pro`); off = the page shows the presentation only. */
    proSignupEnabled: z.boolean(),
    /** "Paiement en plusieurs fois" stays informative until a licensed lender partners (§8). */
    paymentInstallmentsEnabled: z.boolean(),
  })
  .strict();
export type FlagsConfig = z.infer<typeof flagsConfigSchema>;

export const DEFAULT_FLAGS: FlagsConfig = {
  salesEnabled: false,
  proSignupEnabled: true,
  paymentInstallmentsEnabled: false,
};

/** Firestore value over the defaults; an invalid document is reported and the defaults apply. */
export function resolveFlagsConfig(stored: unknown): { config: FlagsConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_FLAGS, errors: [] };
  const parsed = flagsConfigSchema.safeParse({ ...DEFAULT_FLAGS, ...(typeof stored === "object" ? stored : {}) });
  if (parsed.success) return { config: parsed.data, errors: [] };
  return {
    config: DEFAULT_FLAGS,
    errors: parsed.error.issues.map((issue) => `${issue.path.join(".") || "config/flags"}: ${issue.message}`),
  };
}
