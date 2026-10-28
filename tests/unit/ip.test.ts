import { describe, expect, it } from "vitest";
import { clientIp, expandIpv6, ipBuckets } from "@/lib/security/ip";

// Client IP and its rate-limit buckets (§6 "Les clés"): the key of every IP limiter and of
// connectionLogs. A regression here would let a client pick its own bucket.

const headers = (init: Record<string, string>) => new Headers(init);
const ZEROS = Array<string>(8).fill("0000");

describe("clientIp", () => {
  it("takes CF-Connecting-IP first, deployed or not", () => {
    expect(clientIp(headers({ "cf-connecting-ip": " 203.0.113.9 ", "x-forwarded-for": "198.51.100.1" }), true)).toBe("203.0.113.9");
    expect(clientIp(headers({ "cf-connecting-ip": "2001:db8::1", "x-forwarded-for": "198.51.100.1" }), false)).toBe("2001:db8::1");
  });

  it("ignores X-Forwarded-For when deployed: the origin only hears Cloudflare", () => {
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1" }), true)).toBe("0.0.0.0");
    expect(clientIp(headers({ "cf-connecting-ip": "not-an-ip", "x-forwarded-for": "198.51.100.1" }), true)).toBe("0.0.0.0");
    expect(clientIp(headers({}), true)).toBe("0.0.0.0");
  });

  it("takes the first X-Forwarded-For hop in development, else loopback", () => {
    expect(clientIp(headers({ "x-forwarded-for": "198.51.100.1, 10.0.0.2" }), false)).toBe("198.51.100.1");
    expect(clientIp(headers({ "x-forwarded-for": " 2001:db8::7 ,10.0.0.2" }), false)).toBe("2001:db8::7");
    expect(clientIp(headers({ "x-forwarded-for": "garbage, 198.51.100.1" }), false)).toBe("127.0.0.1");
    expect(clientIp(headers({ "x-forwarded-for": "" }), false)).toBe("127.0.0.1");
    expect(clientIp(headers({}), false)).toBe("127.0.0.1");
  });
});

describe("ipBuckets", () => {
  it("keys an IPv4 address on itself", () => {
    expect(ipBuckets(" 203.0.113.9 ")).toEqual({ ip: "203.0.113.9", subscriber: "203.0.113.9", network: "203.0.113.9", version: 4 });
  });

  it("reduces an IPv6 address to its /64 subscriber and /48 network", () => {
    expect(ipBuckets("2001:DB8:abcd:12:aaaa:bbbb:cccc:1")).toEqual({
      ip: "2001:DB8:abcd:12:aaaa:bbbb:cccc:1",
      subscriber: "2001:0db8:abcd:0012::/64",
      network: "2001:0db8:abcd::/48",
      version: 6,
    });
    // Another host of the same /64 shares the bucket; another /64 of the /48 shares the network only.
    expect(ipBuckets("2001:db8:abcd:12::ffff")?.subscriber).toBe("2001:0db8:abcd:0012::/64");
    const sibling = ipBuckets("2001:db8:abcd:13::1");
    expect(sibling?.subscriber).toBe("2001:0db8:abcd:0013::/64");
    expect(sibling?.network).toBe("2001:0db8:abcd::/48");
    expect(ipBuckets("::1")).toMatchObject({ subscriber: "0000:0000:0000:0000::/64", network: "0000:0000:0000::/48", version: 6 });
  });

  it("treats an IPv4-mapped IPv6 address as its IPv4 client", () => {
    const v4 = { ip: "203.0.113.9", subscriber: "203.0.113.9", network: "203.0.113.9", version: 4 };
    expect(ipBuckets("::ffff:203.0.113.9")).toEqual(v4);
    expect(ipBuckets("::FFFF:cb00:7109")).toEqual(v4);
    // Not the mapped prefix: an IPv6 address like any other.
    expect(ipBuckets("64:ff9b::203.0.113.9")?.version).toBe(6);
  });

  it("answers null for anything that is not an address", () => {
    for (const value of ["", "not-an-ip", "203.0.113.999", "203.0.113.9:443", "2001:db8::1::2", "::ffff:1.2.3", "2001:db8:1:2:3:4:5:6:7"]) {
      expect(ipBuckets(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("expandIpv6", () => {
  it("expands :: and drops the zone id", () => {
    expect(expandIpv6("::")).toEqual(ZEROS);
    expect(expandIpv6("::1")).toEqual([...ZEROS.slice(0, 7), "0001"]);
    expect(expandIpv6("2001:db8::8:800:200C:417A")).toEqual(["2001", "0db8", "0000", "0000", "0008", "0800", "200c", "417a"]);
    expect(expandIpv6("fe80::1%eth0")).toEqual(["fe80", "0000", "0000", "0000", "0000", "0000", "0000", "0001"]);
    expect(expandIpv6("2001:db8:1:2:3:4:5:6")).toEqual(["2001", "0db8", "0001", "0002", "0003", "0004", "0005", "0006"]);
  });

  it("turns an embedded IPv4 tail into two groups", () => {
    expect(expandIpv6("::ffff:192.0.2.128")).toEqual(["0000", "0000", "0000", "0000", "0000", "ffff", "c000", "0280"]);
    expect(expandIpv6("64:ff9b::203.0.113.9")).toEqual(["0064", "ff9b", "0000", "0000", "0000", "0000", "cb00", "7109"]);
  });

  it("answers null for IPv4 and garbage", () => {
    for (const value of ["203.0.113.9", "x", "", "2001:db8"]) expect(expandIpv6(value), JSON.stringify(value)).toBeNull();
  });
});
