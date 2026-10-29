// Social links of a Pro shop (owner ask 2026-10-29): shown on its storefront only, never on a
// listing (listing text keeps its contact screen, messaging stays the channel on a listing). A
// closed list of networks, each with its exact hosts (no wildcard, no shortener) and its handle
// grammar. The shop types a handle or pastes its profile address; only the handle is stored and
// the link is rebuilt from the network's fixed template, so a stored link can only ever open that
// network's own profile page over https. WhatsApp takes the Business short link only
// (wa.me/message/CODE): a wa.me/<number> link would put the number in the page. Client-safe.

export const SOCIAL_NETWORKS = ["instagram", "tiktok", "facebook", "youtube", "x", "linkedin", "snapchat", "whatsapp"] as const;
export type SocialNetwork = (typeof SOCIAL_NETWORKS)[number];

/** What a shop may type in one field (a pasted address included). */
export const SOCIAL_INPUT_MAX = 300;
/** Longest stored handle ("company/" + a 100-character LinkedIn slug). */
export const SOCIAL_HANDLE_MAX = 110;

/**
 * Why a link is refused: not an address or handle, another site than the network's own (a
 * shortener, a link page), a page of the network that is not a profile (a post, a group, a share
 * dialog), a handle outside the network's grammar, a phone number.
 */
export type SocialLinkProblem = "invalid" | "host" | "profile" | "handle" | "phone";

interface NetworkRule {
  /** Exact host names a pasted address may use. */
  hosts: readonly string[];
  /** A bare handle may be typed (else only a pasted address is understood). */
  bare: boolean;
  /** The handle in a profile address (decoded path segments), or null for another page. */
  fromPath: (segments: string[], query: URLSearchParams) => string | null;
  /** A bare handle as typed (after the leading "@"), into the stored form. */
  fromBare?: (handle: string) => string;
  /** Grammar of the stored handle. */
  pattern: RegExp;
  /** First path segments that are the network's own pages, not profiles. */
  reserved?: ReadonlySet<string>;
  /** Handles are case-insensitive on the network: stored lower-case. */
  lowerCase: boolean;
  href: (handle: string) => string;
}

const first = (segments: string[]): string | null => segments[0] ?? null;
const atHandle = (segments: string[]): string | null => {
  const segment = segments[0];
  return segment && segment.startsWith("@") ? segment.slice(1) : null;
};

const RULES: Record<SocialNetwork, NetworkRule> = {
  instagram: {
    hosts: ["instagram.com", "www.instagram.com", "m.instagram.com"],
    bare: true,
    fromPath: first,
    pattern: /^(?!\.)(?!.*\.\.)(?!.*\.$)[a-z0-9._]{1,30}$/,
    reserved: new Set(["p", "reel", "reels", "stories", "explore", "accounts", "direct", "tv", "about", "legal", "developer", "web", "challenge"]),
    lowerCase: true,
    href: (handle) => `https://www.instagram.com/${handle}/`,
  },
  tiktok: {
    hosts: ["tiktok.com", "www.tiktok.com", "m.tiktok.com"],
    bare: true,
    fromPath: atHandle,
    pattern: /^(?!.*\.$)[a-z0-9._]{2,24}$/,
    lowerCase: true,
    href: (handle) => `https://www.tiktok.com/@${handle}`,
  },
  facebook: {
    hosts: ["facebook.com", "www.facebook.com", "m.facebook.com", "web.facebook.com"],
    bare: true,
    fromPath: (segments, query) => {
      if (segments[0] === "profile.php") return query.get("id");
      // facebook.com/people/{Name}/{id}: the numeric id is the page.
      if (segments[0] === "people") return segments[2] ?? null;
      return first(segments);
    },
    // A username (5 to 50 letters, digits, dots) or a page's numeric id (14 digits or more: a
    // Moroccan number, even with +212, is shorter).
    pattern: /^(?:[1-9]\d{13,19}|(?=.*[a-z])(?!\.)(?!.*\.$)(?!.*\.php$)[a-z0-9.]{5,50})$/,
    reserved: new Set([
      "pages", "groups", "events", "watch", "marketplace", "sharer", "sharer.php", "share", "share.php", "login", "login.php", "dialog", "plugins", "l.php", "photo.php", "photo", "photos",
      "story.php", "permalink.php", "home.php", "gaming", "help", "policies", "privacy", "settings", "messages", "notifications", "reel", "reels", "stories", "hashtag", "search",
      "friends", "bookmarks", "business", "ads", "legal", "video.php", "videos", "media",
    ]),
    lowerCase: true,
    href: (handle) => (/^\d+$/.test(handle) ? `https://www.facebook.com/profile.php?id=${handle}` : `https://www.facebook.com/${handle}`),
  },
  youtube: {
    hosts: ["youtube.com", "www.youtube.com", "m.youtube.com"],
    bare: true,
    // Every channel has an @handle: the old /channel/ and /c/ addresses are refused as "profile".
    fromPath: atHandle,
    pattern: /^[a-z0-9._-]{3,30}$/,
    lowerCase: true,
    href: (handle) => `https://www.youtube.com/@${handle}`,
  },
  x: {
    hosts: ["x.com", "www.x.com", "mobile.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"],
    bare: true,
    fromPath: first,
    pattern: /^[a-z0-9_]{1,15}$/,
    reserved: new Set(["home", "i", "intent", "share", "search", "explore", "settings", "login", "logout", "signup", "tos", "privacy", "messages", "notifications", "hashtag", "compose", "about", "download"]),
    lowerCase: true,
    href: (handle) => `https://x.com/${handle}`,
  },
  linkedin: {
    hosts: ["linkedin.com", "www.linkedin.com", "ma.linkedin.com", "fr.linkedin.com"],
    bare: true,
    // Stored with its kind: "company/{slug}" (a bare slug is a company page) or "in/{slug}".
    fromPath: (segments) => {
      const [kind, slug] = segments;
      return (kind === "company" || kind === "in" || kind === "showcase" || kind === "school") && slug ? `${kind}/${slug}` : null;
    },
    fromBare: (slug) => `company/${slug}`,
    pattern: /^(?:company|in|showcase|school)\/[a-z0-9][a-z0-9_-]{1,99}$/,
    lowerCase: true,
    href: (handle) => `https://www.linkedin.com/${handle}/`,
  },
  snapchat: {
    hosts: ["snapchat.com", "www.snapchat.com"],
    bare: true,
    fromPath: (segments) => (segments[0] === "add" ? (segments[1] ?? null) : null),
    pattern: /^[a-z][a-z0-9._-]{1,13}[a-z0-9]$/,
    lowerCase: true,
    href: (handle) => `https://www.snapchat.com/add/${handle}`,
  },
  whatsapp: {
    hosts: ["wa.me"],
    // A bare value would be a phone number: only the Business short link is understood.
    bare: false,
    fromPath: (segments) => (segments[0] === "message" ? (segments[1] ?? null) : null),
    pattern: /^[A-Z0-9]{8,20}$/,
    lowerCase: false,
    href: (handle) => `https://wa.me/message/${handle}`,
  },
};

/** The network's host names (shown as a hint in the form). */
export function socialHosts(network: SocialNetwork): readonly string[] {
  return RULES[network].hosts;
}

export function isSocialNetwork(value: string): value is SocialNetwork {
  return (SOCIAL_NETWORKS as readonly string[]).includes(value);
}

/** Whether a stored handle still follows its network's grammar (a link off it is not shown). */
export function isValidSocialHandle(network: SocialNetwork, handle: string): boolean {
  return handle.length <= SOCIAL_HANDLE_MAX && RULES[network].pattern.test(handle) && !RULES[network].reserved?.has(handle);
}

/** The public link of a stored handle: always https, always the network's own profile page. */
export function socialHref(network: SocialNetwork, handle: string): string {
  return RULES[network].href(handle);
}

/** Many digits in a row, whatever the separators: a phone number dressed as a handle. */
const PHONE_LIKE = /(?:\d[._-]?){9,}/;

/**
 * The handle of what the shop typed (a handle, "@handle" or its profile address), or why it is
 * refused. The text screen of the shop's other fields runs apart (social-links-rules.ts).
 */
export function parseSocialLink(network: SocialNetwork, raw: string): { handle: string } | { problem: SocialLinkProblem } {
  const rule = RULES[network];
  const text = raw.trim();
  if (text.length === 0 || text.length > SOCIAL_INPUT_MAX || /\s/.test(text)) return { problem: "invalid" };
  let candidate: string | null;
  if (!text.includes("/")) {
    if (!rule.bare) return { problem: /^\+?[\d.-]+$/.test(text) ? "phone" : "invalid" };
    const bare = text.replace(/^@/, "");
    candidate = rule.fromBare ? rule.fromBare(bare) : bare;
  } else {
    // "instagram.com/name" is understood as its https address.
    const address = /^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text.replace(/^\/+/, "")}`;
    let url: URL;
    try {
      url = new URL(address);
    } catch {
      return { problem: "invalid" };
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") return { problem: "invalid" };
    if (url.username || url.password || url.port) return { problem: "host" };
    if (!rule.hosts.includes(url.hostname.toLowerCase())) return { problem: "host" };
    let segments: string[];
    try {
      segments = url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
    } catch {
      return { problem: "invalid" };
    }
    // wa.me/212612345678: a number in the page, refused.
    if (network === "whatsapp" && segments[0] && /^\+?\d+$/.test(segments[0])) return { problem: "phone" };
    candidate = rule.fromPath(segments, url.searchParams);
    if (candidate === null || candidate === "") return { problem: "profile" };
  }
  const handle = rule.lowerCase ? candidate.toLowerCase() : candidate;
  if (rule.reserved?.has(handle)) return { problem: "profile" };
  if (!rule.pattern.test(handle) || handle.length > SOCIAL_HANDLE_MAX) return { problem: "handle" };
  // A page's numeric id is not a phone number; anything else with nine digits or more is treated as one.
  if (!(network === "facebook" && /^\d+$/.test(handle)) && network !== "whatsapp" && PHONE_LIKE.test(handle)) return { problem: "phone" };
  return { handle };
}
