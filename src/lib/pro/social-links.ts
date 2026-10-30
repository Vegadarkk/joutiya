import "server-only";
import { audit } from "@/lib/audit";
import type { AuthContext, StaffContext } from "@/lib/auth/guards";
import { getAbuseRules } from "@/lib/config/runtime";
import type { ProSocialInput, ProSocialResponse, ProSocialView } from "@/lib/contracts/pro";
import { getProProfile, proProfileRef, proProfileToFirestore, type ProProfileRecord } from "@/lib/db/repositories/pro-profiles";
import { db } from "@/lib/firebase/admin";
import { HttpError, notFound } from "@/lib/http/errors";
import { storefrontSegment } from "@/lib/listings/public";
import { revalidateListingPaths } from "@/lib/listings/revalidate";
import { logger } from "@/lib/logging/logger";
import { sendMail } from "@/lib/mail";
import { listingRecipient } from "@/lib/mail/recipients";
import { consume } from "@/lib/quota";
import { storefrontShown } from "./lifecycle";
import type { SocialLinksDoc } from "./profile-schema";
import { ownedPublishingShop } from "./service";
import { checkSocialLink, socialView, sortSocialLinks } from "./social-links-rules";

// A shop's social links (owner ask 2026-10-29, src/config/social-links.ts):
// - the owner of a verified shop that publishes saves them (PUT /api/pro/me/social), replaced
//   whole; each value is reduced to its handle, the link is rebuilt from the network's template;
// - they show on the storefront only (never on a listing), with rel="nofollow ugc noopener noreferrer";
// - a moderator hides or restores them all (report « Lien de réseau social suspect »), with a
//   reason mailed to the owner; editing them while hidden keeps them hidden.
// The server never fetches a link.

function withoutId(profile: ProProfileRecord) {
  const { proId: _proId, ...doc } = profile;
  return doc;
}

function revalidateShop(profile: ProProfileRecord): void {
  if (storefrontShown(profile.lifecycle, profile.plan)) revalidateListingPaths({ shopSegment: storefrontSegment(profile.slug, profile.proId) });
}

/** PUT /api/pro/me/social: the owner's links, replaced whole (an empty list removes them). */
export async function updateSocialLinks(auth: AuthContext, input: ProSocialInput, now = new Date()): Promise<ProSocialResponse> {
  const [owned, { prohibited }] = await Promise.all([ownedPublishingShop(auth), getAbuseRules()]);
  const links: SocialLinksDoc["links"] = [];
  for (const link of input.links) {
    if (link.value.trim() === "") continue;
    const checked = checkSocialLink(link.network, link.value, prohibited);
    if ("problem" in checked) throw new HttpError(422, "social_link_invalid", "social link refused", { details: { network: link.network, problem: checked.problem } });
    links.push({ network: link.network, handle: checked.handle });
  }
  const profile = await db().runTransaction(async (tx) => {
    const current = await getProProfile(owned.proId, tx);
    if (!current || current.ownerUid !== auth.user.uid) throw notFound();
    const before = current.social;
    // A moderator's hiding outlives the owner's edits: only a moderator restores the links.
    const social: SocialLinksDoc | undefined =
      links.length > 0 || before?.hiddenAt
        ? { links: sortSocialLinks(links), ...(before?.hiddenAt ? { hiddenAt: before.hiddenAt, hiddenReason: before.hiddenReason } : {}), updatedAt: now }
        : undefined;
    const { social: _previous, ...rest } = withoutId(current);
    tx.set(proProfileRef(owned.proId), proProfileToFirestore({ ...rest, ...(social ? { social } : {}), updatedAt: now }));
    return { ...current, social };
  });
  void consume("firestore.writes", 1);
  revalidateShop(profile);
  return { social: socialView(profile.social) };
}

/** The shop's links in the back office (hidden ones included). */
export async function shopSocialAdmin(proId: string): Promise<ProSocialView> {
  const profile = await getProProfile(proId);
  if (!profile) throw notFound();
  return socialView(profile.social);
}

/** A moderator hides or restores all the shop's links (its listings and storefront stay online). */
export async function setShopSocialHidden(staff: StaffContext, proId: string, input: { action: "hide" | "restore"; reason: string }, now = new Date()): Promise<ProSocialView> {
  const profile = await db().runTransaction(async (tx) => {
    const current = await getProProfile(proId, tx);
    if (!current) throw notFound();
    const social = current.social;
    if (!social) throw new HttpError(409, "conflict", "the shop has no social links");
    if ((input.action === "hide") === (social.hiddenAt !== undefined)) return null;
    const { hiddenAt: _at, hiddenReason: _reason, ...rest } = social;
    const next: SocialLinksDoc = input.action === "hide" ? { ...rest, hiddenAt: now, hiddenReason: input.reason, updatedAt: now } : { ...rest, updatedAt: now };
    tx.set(proProfileRef(proId), proProfileToFirestore({ ...withoutId(current), social: next, updatedAt: now }));
    return { ...current, social: next };
  });
  if (profile) {
    void consume("firestore.writes", 1);
    await audit({ actorUid: staff.user.uid, actorRole: staff.role, action: input.action === "hide" ? "pro.social.hidden" : "pro.social.restored", target: { type: "pro", id: proId }, automated: false, reason: input.reason, at: now });
    await notifyOwner(profile, input.action === "hide" ? { kind: "hidden", reason: input.reason } : { kind: "restored" }, `${input.action}-${now.getTime()}`);
    revalidateShop(profile);
  }
  return shopSocialAdmin(proId);
}

/** Tells the shop's owner its links were hidden or restored (statement of reasons). Never throws. */
async function notifyOwner(profile: Pick<ProProfileRecord, "proId" | "ownerUid" | "name">, data: { kind: "hidden" | "restored"; reason?: string }, key: string): Promise<void> {
  try {
    const to = await listingRecipient(profile.ownerUid);
    if (!to) return;
    await sendMail({
      template: "socialLinksNotice",
      locale: to.locale,
      to: to.email,
      priority: "transactional",
      idempotencyKey: `social-links-${profile.proId}-${key}`,
      data: { displayName: to.displayName, shopName: profile.name, ...data },
    });
  } catch (error) {
    logger.error({ proId: profile.proId, err: (error as Error).message }, "social links mail not sent");
  }
}
