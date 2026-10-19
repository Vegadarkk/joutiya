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

/** Editing metadata an admin's write may carry next to the flags: ignored, never an error. */
const METADATA_KEYS: ReadonlySet<string> = new Set(["updatedAt", "updatedBy"]);

/**
 * Firestore value over the defaults, flag by flag: a valid flag applies even when another one is
 * mistyped or unknown (reported, so an admin closing the Pro sign-up with a typo elsewhere in the
 * document does close it). The runtime raises an alert on any error.
 */
export function resolveFlagsConfig(stored: unknown): { config: FlagsConfig; errors: string[] } {
  if (stored === undefined || stored === null) return { config: DEFAULT_FLAGS, errors: [] };
  if (typeof stored !== "object" || Array.isArray(stored)) return { config: DEFAULT_FLAGS, errors: ["config/flags: not an object"] };
  const config: FlagsConfig = { ...DEFAULT_FLAGS };
  const errors: string[] = [];
  for (const [key, value] of Object.entries(stored)) {
    if (METADATA_KEYS.has(key)) continue;
    const field = flagsConfigSchema.shape[key as keyof FlagsConfig] as z.ZodType | undefined;
    if (!field) {
      errors.push(`${key}: unknown flag`);
      continue;
    }
    const parsed = field.safeParse(value);
    if (parsed.success) config[key as keyof FlagsConfig] = parsed.data as boolean;
    else errors.push(`${key}: ${parsed.error.issues[0]?.message ?? "invalid"}`);
  }
  return { config, errors };
}
