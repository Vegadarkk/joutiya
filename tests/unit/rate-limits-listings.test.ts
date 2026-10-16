import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RATE_LIMITS, type RateLimitDefinition, type RateLimitId } from "@/config/rate-limits";
import { resetServerEnv } from "@/lib/env";
import { consumeLimit, enforceLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";

// Phase 3 limiters (design §4): the table itself, and the byte-counting upload limiter against
// the in-memory backend (no RATE_LIMIT_REDIS_URL).

const HOUR = 3600;
const DAY = 24 * HOUR;
const MIB = 1024 * 1024;

const expected: Record<string, RateLimitDefinition> = {
  "listing.draft.uid": { points: 120, duration: HOUR, policy: "open", key: "uid" },
  "listing.create.uid": { points: 5, duration: DAY, policy: "open", key: "uid" },
  "listing.create.ip": { points: 30, duration: HOUR, policy: "open", key: "ip" },
  "upload.sign.uid": { points: 30, duration: HOUR, policy: "closed", key: "uid" },
  "upload.bytes.uid": { points: 200 * MIB, duration: DAY, policy: "closed", key: "uid" },
  "reveal.uid.hour": { points: 10, duration: HOUR, policy: "closed", key: "uid" },
  "reveal.uid.day": { points: 30, duration: DAY, policy: "closed", key: "uid" },
  "reveal.device": { points: 20, duration: DAY, policy: "closed", key: "device" },
  "reveal.ip": { points: 60, duration: DAY, policy: "closed", key: "ip" },
  "listing.read.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
  "profile.read.ip": { points: 1200, duration: HOUR, policy: "open", key: "ip" },
};

beforeEach(() => {
  delete process.env.RATE_LIMIT_REDIS_URL;
  resetServerEnv();
  resetRateLimiters();
});

afterEach(() => {
  resetServerEnv();
  resetRateLimiters();
});

describe("phase 3 rate-limit table", () => {
  it("declares every listing, upload and reveal limiter as designed", () => {
    for (const [id, definition] of Object.entries(expected)) expect(RATE_LIMITS[id as RateLimitId], id).toEqual(definition);
  });

  it("keeps every definition well-formed", () => {
    for (const [id, definition] of Object.entries(RATE_LIMITS) as [string, RateLimitDefinition][]) {
      expect(Number.isInteger(definition.points) && definition.points > 0, id).toBe(true);
      expect(Number.isInteger(definition.duration) && definition.duration > 0, id).toBe(true);
      if (definition.blockDuration !== undefined) expect(definition.blockDuration, id).toBeGreaterThanOrEqual(0);
    }
    // What costs money or exposes personal data fails closed; reads and autosave fail open.
    expect(RATE_LIMITS["upload.bytes.uid"].policy).toBe("closed");
    expect(RATE_LIMITS["reveal.ip"].policy).toBe("closed");
    expect(RATE_LIMITS["listing.draft.uid"].policy).toBe("open");
  });
});

describe("upload.bytes.uid", () => {
  it("counts declared bytes per account and refuses past 200 MiB a day", async () => {
    const uid = `uid-${Date.now()}`;
    await expect(enforceLimit("upload.bytes.uid", uid, 150 * MIB)).resolves.toBeUndefined();
    const second = await consumeLimit("upload.bytes.uid", uid, 40 * MIB);
    expect(second).toEqual({ ok: true, remaining: 10 * MIB });
    await expect(enforceLimit("upload.bytes.uid", uid, 11 * MIB)).rejects.toMatchObject({ status: 429, code: "rate_limited" });
    // Another account is not affected.
    await expect(enforceLimit("upload.bytes.uid", `${uid}-other`, 10 * MIB)).resolves.toBeUndefined();
  });
});
