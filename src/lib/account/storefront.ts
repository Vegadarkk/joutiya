import "server-only";
import { cityBySlug } from "@/config/regions";
import { DEFAULT_BANNER } from "@/config/storefront";
import { requireUser } from "@/lib/auth/guards";
import { getAbuseRules } from "@/lib/config/runtime";
import { storefrontSchema, type StorefrontSettings } from "@/lib/contracts/account";
import { getUserRecord, type UserRecord } from "@/lib/db/repositories/profiles";
import { updateStorefront, type StorefrontPatch } from "@/lib/db/repositories/users";
import { HttpError, notFound } from "@/lib/http/errors";
import { readJson } from "@/lib/http/json";
import { json } from "@/lib/http/route";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { firstStrictIssue } from "@/lib/moderation/free-text";
import type { CompiledProhibited } from "@/lib/moderation/prohibited";
import { enforceLimit } from "@/lib/rate-limit/limiter";

// Storefront settings of the signed-in member (vitrine-avis §1): the "about" text, the house
// banner and the city shown on /profil. The uid comes from the session, never from the body. The
// bio follows the listing text rules and refuses sensitive data outright: no human queue for it.

export function storefrontSettings(user: UserRecord): StorefrontSettings {
  return { publicId: user.publicId, bio: user.storefront?.bio ?? "", bannerKey: user.storefront?.bannerKey ?? DEFAULT_BANNER, citySlug: user.citySlug ?? null };
}

/** The patch to store, or a 422 `invalid_text` naming the field and the issue; `terms`: config/abuse prohibited lists. */
export function storefrontPatch(input: { bio?: string | null; bannerKey?: string | null; citySlug?: string | null }, terms?: CompiledProhibited): StorefrontPatch {
  const patch: StorefrontPatch = {};
  if (input.bio !== undefined) {
    const bio = input.bio?.trim() ?? "";
    const issue = bio ? firstStrictIssue(bio, terms) : null;
    if (issue) throw new HttpError(422, "invalid_text", "bio refused by the text screen", { details: { field: "bio", issue } });
    patch.bio = bio || null;
  }
  if (input.bannerKey !== undefined) patch.bannerKey = input.bannerKey;
  if (input.citySlug !== undefined) {
    if (input.citySlug === null) patch.city = null;
    else {
      const city = cityBySlug(input.citySlug);
      if (!city) throw new HttpError(400, "invalid_body", "unknown city", { details: [{ path: ["citySlug"], code: "invalid" }] });
      patch.city = { citySlug: city.slug, regionCode: city.regionCode };
    }
  }
  return patch;
}

async function currentUser(uid: string): Promise<UserRecord> {
  const user = await getUserRecord(uid);
  if (!user) throw notFound();
  return user;
}

/** GET /api/account/storefront. */
export async function handleStorefrontRead(request: Request): Promise<Response> {
  const { user } = await requireUser(request);
  return json(storefrontSettings(await currentUser(user.uid)));
}

/** POST /api/account/storefront. */
export async function handleStorefrontUpdate(request: Request): Promise<Response> {
  const context = await requireUser(request, { mutation: true });
  const input = await readJson(request, storefrontSchema);
  const { uid } = context.user;
  await enforceLimit("account.mutation.uid", uid);
  const patch = storefrontPatch(input, (await getAbuseRules()).prohibited);
  if (Object.keys(patch).length > 0) await updateStorefront(uid, patch);
  const user = await currentUser(uid);
  revalidateListingPaths({ publicId: user.publicId });
  return json(storefrontSettings(user));
}
