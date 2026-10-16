import { isIP } from "node:net";

// Client IP and its rate-limit buckets (§6 "Les clés"). Traffic reaches the VM only through the
// Cloudflare Tunnel, so CF-Connecting-IP is trustworthy there. An IPv6 address is reduced to its
// /64 (one subscriber) with a wider /48 bucket for aggressive sources.

export interface IpBuckets {
  /** Exact address, as received (stored in clear only in connectionLogs). */
  ip: string;
  /** Rate-limit bucket: the IPv4 address, or the IPv6 /64 prefix. */
  subscriber: string;
  /** Wider IPv6 bucket (/48); the IPv4 address otherwise. */
  network: string;
  version: 4 | 6;
}

/** Expands an IPv6 address to 8 groups of 4 hex digits; null when it is not one. */
export function expandIpv6(address: string): string[] | null {
  if (isIP(address) !== 6) return null;
  let value = address.toLowerCase().split("%")[0] ?? "";
  // Embedded IPv4 tail (::ffff:1.2.3.4): two groups.
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(value);
  if (v4?.[1]) {
    const bytes = v4[1].split(".").map(Number);
    const tail = [((bytes[0] ?? 0) << 8) | (bytes[1] ?? 0), ((bytes[2] ?? 0) << 8) | (bytes[3] ?? 0)].map((n) => n.toString(16));
    value = value.slice(0, -v4[1].length) + tail.join(":");
  }
  const [head = "", tail] = value.split("::");
  const left = head ? head.split(":") : [];
  const right = tail ? tail.split(":") : [];
  const missing = 8 - left.length - right.length;
  const groups = tail === undefined ? left : [...left, ...Array<string>(missing).fill("0"), ...right];
  return groups.length === 8 ? groups.map((group) => group.padStart(4, "0")) : null;
}

export function ipBuckets(address: string): IpBuckets | null {
  const value = address.trim();
  if (isIP(value) === 4) return { ip: value, subscriber: value, network: value, version: 4 };
  const groups = expandIpv6(value);
  if (!groups) return null;
  // IPv4-mapped IPv6 (::ffff:a.b.c.d) is an IPv4 client.
  if (groups.slice(0, 5).every((group) => group === "0000") && groups[5] === "ffff") {
    const n = (group: string | undefined) => Number.parseInt(group ?? "0", 16);
    const v4 = [n(groups[6]) >> 8, n(groups[6]) & 255, n(groups[7]) >> 8, n(groups[7]) & 255].join(".");
    return { ip: v4, subscriber: v4, network: v4, version: 4 };
  }
  return { ip: value, subscriber: `${groups.slice(0, 4).join(":")}::/64`, network: `${groups.slice(0, 3).join(":")}::/48`, version: 6 };
}

/**
 * Client IP of a request. Deployed: CF-Connecting-IP only (set by Cloudflare at the edge; the
 * origin has no other entry). Development: the first X-Forwarded-For hop, else loopback.
 */
export function clientIp(headers: Headers, deployed: boolean): string {
  const cf = headers.get("cf-connecting-ip")?.trim();
  if (cf && isIP(cf)) return cf;
  if (deployed) return "0.0.0.0";
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded && isIP(forwarded) ? forwarded : "127.0.0.1";
}
