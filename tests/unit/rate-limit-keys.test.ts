import { describe, expect, it } from "vitest";
import { RATE_LIMITS } from "@/config/rate-limits";
import { requestIdentity } from "@/lib/rate-limit/keys";

// The wider IPv6 counter of §6 "Les clés" (audit A2-02): an IPv6 client carries its /48, an IPv4
// client none, and every `ip48` limiter is ten times its /64 counterpart.

const identity = (ip: string) => requestIdentity(new Headers({ "x-forwarded-for": ip }));

describe("requestIdentity ip48", () => {
  it("is the /48 of an IPv6 client and null for IPv4, IPv4-mapped included", () => {
    expect(identity("2001:db8:abcd:12::7")).toMatchObject({ ipBucket: "2001:0db8:abcd:0012::/64", ip48: "2001:0db8:abcd::/48" });
    expect(identity("2001:db8:abcd:ffff::1").ip48).toBe(identity("2001:db8:abcd:12::7").ip48);
    expect(identity("203.0.113.9").ip48).toBeNull();
    expect(identity("::ffff:203.0.113.9").ip48).toBeNull();
  });
});

describe("ip48 limiters", () => {
  it("allow ten times the /64 counter, with the same window and failure policy", () => {
    const pairs = [
      ["pages.ip48", "pages.ip"],
      ["search.ip48", "search.ip"],
      ["login.ip48", "login.ip"],
      ["signup.ip48", "signup.ip"],
      ["challenge.ip48.hard", "challenge.ip.hard"],
    ] as const;
    for (const [wide, narrow] of pairs) {
      expect(RATE_LIMITS[wide], wide).toEqual({ ...RATE_LIMITS[narrow], points: RATE_LIMITS[narrow].points * 10, key: "ip48" });
    }
  });
});
