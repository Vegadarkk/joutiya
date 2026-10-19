import "server-only";
import { isDeployed } from "@/lib/env";
import { DEVICE_COOKIE } from "@/lib/security/cookies";
import { readDeviceId } from "@/lib/security/device";
import { clientIp, ipBuckets } from "@/lib/security/ip";
import { readCookie } from "@/lib/http/cookies";

// Rate-limit identity of a request (§6 "Les clés"): IP bucket, wider IPv6 bucket, and the signed
// device id when the browser sent one. An unknown device counts on its IP with low thresholds.
// "ip" limiters take the whole identity (limiter.ts consumeIpLimit): the /64 and, for IPv6, the /48.

export interface RequestIdentity {
  /** Exact client IP (connectionLogs only). */
  ip: string;
  /** IPv4 address or IPv6 /64 prefix: the per-subscriber bucket. */
  ipBucket: string;
  /** IPv6 /48 (or the IPv4 address). */
  ipNetwork: string;
  /** IPv6 client (an IPv4-mapped address counts as IPv4): the "ip48" siblings apply to ipNetwork. */
  ipv6: boolean;
  /** Device id from the signed __Host-did cookie, or null. */
  deviceId: string | null;
  /** Key for device-scoped limits: the device, else "unknown device on this IP". */
  deviceKey: string;
}

export function requestIdentity(headers: Headers): RequestIdentity {
  const ip = clientIp(headers, isDeployed());
  const buckets = ipBuckets(ip) ?? { ip, subscriber: ip, network: ip, version: 4 as const };
  const deviceId = readDeviceId(readCookie(headers, DEVICE_COOKIE));
  return {
    ip: buckets.ip,
    ipBucket: buckets.subscriber,
    ipNetwork: buckets.network,
    ipv6: buckets.version === 6,
    deviceId,
    deviceKey: deviceId ? `d:${deviceId}` : `anon:${buckets.subscriber}`,
  };
}
