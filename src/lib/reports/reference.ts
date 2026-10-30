import { LISTING_ID_PATTERN } from "@/lib/listings/ids";

// What a person pastes on the contact page to report a content with no "Signaler" button in front
// of them (DSA art. 16(1), Phase 6 legal review of 29 Oct 2026): the address of a listing or a
// profile, met through a shared link or gone from view, or the listing's reference alone. Pure and
// client-safe: the form and its tests share it. The server resolves the target and refuses what
// the reporter cannot see, as for every notice.

export interface ReportReference {
  type: "listing" | "user";
  id: string;
  /** What the notice form recalls: the listing's path segment or the profile's public id. */
  label: string;
}

/** Same alphabet as users.publicId (src/lib/db/schemas): 10 unambiguous characters. */
const PUBLIC_ID_PATTERN = /^[a-hj-km-np-z2-9]{10}$/;
const LOCALES = new Set(["fr", "ar", "rif"]);
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

function decode(part: string): string {
  try {
    return decodeURIComponent(part);
  } catch {
    return part;
  }
}

/** `/{locale}/annonce/{slug}-{id}` or `/{locale}/profil/{publicId}`, the locale optional. */
function fromPath(pathname: string): ReportReference | null {
  const parts = pathname.split("/").filter(Boolean).map(decode);
  if (parts.length > 0 && LOCALES.has(parts[0]!.toLowerCase())) parts.shift();
  const [kind, segment] = parts;
  if (!kind || !segment) return null;
  if (kind === "annonce") {
    const id = segment.slice(-8).toLowerCase();
    return LISTING_ID_PATTERN.test(id) ? { type: "listing", id, label: segment } : null;
  }
  if (kind === "profil") {
    const id = segment.toLowerCase();
    return PUBLIC_ID_PATTERN.test(id) ? { type: "user", id, label: id } : null;
  }
  return null;
}

/** The target named by an address or a bare reference; null when nothing on the site matches it. */
export function parseReportReference(input: string): ReportReference | null {
  const text = input.trim();
  if (!text || /\s/.test(text)) return null;
  const bare = text.toLowerCase();
  if (LISTING_ID_PATTERN.test(bare)) return { type: "listing", id: bare, label: bare };
  if (PUBLIC_ID_PATTERN.test(bare)) return { type: "user", id: bare, label: bare };
  let url: URL;
  try {
    url = new URL(SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  return fromPath(url.pathname);
}
