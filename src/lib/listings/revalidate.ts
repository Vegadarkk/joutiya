import "server-only";
import { revalidatePath } from "next/cache";
import { LOCALES } from "@/config/site";
import { logger } from "@/lib/logging/logger";

// ISR invalidation of the public listing and profile pages (design §4): every locale of
// /annonce/{slugId} and /profil/{publicId}. Harmless outside a Next request context (the worker,
// unit tests): revalidatePath then throws, which is logged at debug and swallowed.

export interface RevalidateListingInput {
  /** The listing's URL segment, "{slug}-{id}". */
  slugId?: string;
  /** The seller's public profile id. */
  publicId?: string;
}

export function listingPagePaths(slugId: string): string[] {
  return LOCALES.map((locale) => `/${locale}/annonce/${slugId}`);
}

export function profilePagePaths(publicId: string): string[] {
  return LOCALES.map((locale) => `/${locale}/profil/${publicId}`);
}

/** Paths to revalidate for the given ids (either may be omitted). */
export function listingRevalidationPaths({ slugId, publicId }: RevalidateListingInput): string[] {
  return [...(slugId ? listingPagePaths(slugId) : []), ...(publicId ? profilePagePaths(publicId) : [])];
}

/** Revalidates every path of `listingRevalidationPaths`; returns the paths it attempted. */
export function revalidateListingPaths(input: RevalidateListingInput): string[] {
  const paths = listingRevalidationPaths(input);
  for (const path of paths) {
    try {
      revalidatePath(path);
    } catch (error) {
      logger.debug({ path, err: (error as Error).message }, "revalidatePath skipped (no request context)");
    }
  }
  return paths;
}
