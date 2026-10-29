import { isValidSocialHandle, parseSocialLink, SOCIAL_NETWORKS, socialHref, type SocialLinkProblem, type SocialNetwork } from "@/config/social-links";
import { containsProhibited, type CompiledProhibited } from "@/lib/moderation/prohibited";
import type { SocialLinksDoc } from "./profile-schema";

// Social links of a shop (src/config/social-links.ts). Pure: the save, the storefront, the Pro
// area form and the unit tests share them.

/** A refusal: the address or handle (`SocialLinkProblem`), or a prohibited word in the handle. */
export type SocialLinkIssue = SocialLinkProblem | "prohibited";

/** The handle to store, or why the value is refused (as the form shows it while typing; the save adds the config/abuse `terms`). */
export function checkSocialLink(network: SocialNetwork, raw: string, terms?: CompiledProhibited): { handle: string } | { problem: SocialLinkIssue } {
  const parsed = parseSocialLink(network, raw);
  if ("problem" in parsed) return parsed;
  // The words a listing may not carry may not be a handle either ("cannabis.shop").
  if (containsProhibited(parsed.handle.replace(/[._/-]+/g, " "), terms).hard.length > 0) return { problem: "prohibited" };
  return parsed;
}

export interface PublicSocialLink {
  network: SocialNetwork;
  handle: string;
  href: string;
}

/** Network order of the list, whatever order the shop typed them in. */
export function sortSocialLinks<T extends { network: SocialNetwork }>(links: readonly T[]): T[] {
  return [...links].sort((a, b) => SOCIAL_NETWORKS.indexOf(a.network) - SOCIAL_NETWORKS.indexOf(b.network));
}

/** What the storefront shows: nothing while a moderator hides the links; a handle off its grammar is dropped. */
export function publicSocialLinks(social: SocialLinksDoc | undefined): PublicSocialLink[] {
  return social && !social.hiddenAt ? socialView(social).links : [];
}

/** The owner's and the back office's view of the stored links (hidden ones included). */
export function socialView(social: SocialLinksDoc | undefined): { links: PublicSocialLink[]; hidden: { reason: string; at: string } | null } {
  if (!social) return { links: [], hidden: null };
  return {
    links: sortSocialLinks(social.links.filter((link) => isValidSocialHandle(link.network, link.handle))).map((link) => ({ network: link.network, handle: link.handle, href: socialHref(link.network, link.handle) })),
    hidden: social.hiddenAt ? { reason: social.hiddenReason ?? "", at: social.hiddenAt.toISOString() } : null,
  };
}
