import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as Turnstile from "@/lib/security/turnstile";

// Search limits on GET /api/search (design D13): past the device budget the API asks for Turnstile
// (403 turnstile_required) before any engine call, a solved token sets the 30-minute pass, the
// pass allows its own budget, then 429. Signed-in members count per account, whatever the device.

const verify = vi.hoisted(() => vi.fn(async () => ({ ok: true, codes: [] as string[] })));
vi.mock("@/lib/security/turnstile", async (importOriginal) => ({ ...(await importOriginal<typeof Turnstile>()), verifyTurnstile: verify }));
vi.mock("@/lib/mail", () => ({ sendMail: vi.fn(async () => undefined) }));

import { RATE_LIMITS } from "@/config/rate-limits";
import type { SearchApiResponse } from "@/lib/contracts/search";
import { resetServerEnv } from "@/lib/env";
import { consumeLimit, resetRateLimiters } from "@/lib/rate-limit/limiter";
import { setSearchEngineForTests } from "@/lib/search/engine";
import type { MemoryEngine } from "@/lib/search/memory";
import { member } from "../listings/helpers";
import { Jar, doc, search, serve, type ErrorBody } from "./search-helpers";

let engine: MemoryEngine;

beforeAll(() => resetServerEnv());
beforeEach(async () => {
  resetRateLimiters();
  verify.mockClear();
  verify.mockResolvedValue({ ok: true, codes: [] });
  engine = await serve([doc({ title: "Vélo de ville", categoryId: "vehicules", subcategoryId: "velos", citySlug: "casablanca", price: 900 })]);
});
afterAll(() => setSearchEngineForTests(null));

/** Device id of the jar's signed __Host-did. */
function deviceOf(jar: Jar): string {
  const value = jar.get("__Host-did");
  if (!value) throw new Error("no device cookie");
  return value.split(".")[0] ?? "";
}

async function spend(id: keyof typeof RATE_LIMITS, key: string, keep = 0): Promise<void> {
  const points = RATE_LIMITS[id].points - keep;
  if (points > 0) await consumeLimit(id, key, points);
}

describe("GET /api/search limits", () => {
  it("sets a device cookie, then escalates: 403 turnstile_required -> token -> pass -> 429", async () => {
    const jar = new Jar();
    const first = await search<SearchApiResponse>("q=velo", { jar });
    expect(first.status).toBe(200);
    expect(first.body.hits).toHaveLength(1);
    const device = deviceOf(jar);
    expect(RATE_LIMITS["search.device.minute"]).toMatchObject({ points: 30, policy: "open" });
    await spend("search.device.minute", `d:${device}`);

    const spy = vi.spyOn(engine, "search");
    const challenged = await search<ErrorBody>("q=velo", { jar });
    expect([challenged.status, challenged.body.error.code]).toEqual([403, "turnstile_required"]);
    expect(challenged.header("cache-control")).toBe("no-store");
    expect(spy).not.toHaveBeenCalled();

    const solved = await search<SearchApiResponse>("q=velo", { jar, headers: { "x-turnstile-token": "solved-token" } });
    expect(solved.status).toBe(200);
    expect(verify).toHaveBeenCalledWith("solved-token", expect.objectContaining({ action: "search" }));
    expect(solved.cookies.some((line) => line.startsWith("__Host-tsv=") && /HttpOnly/.test(line))).toBe(true);
    expect(jar.get("__Host-tsv")).toBeDefined();

    // The pass lifts the limit within its own allowance, without a new challenge.
    verify.mockClear();
    expect((await search<SearchApiResponse>("q=velo", { jar })).status).toBe(200);
    expect(verify).not.toHaveBeenCalled();

    await spend("search.passed.device", `d:${device}`);
    const limited = await search<ErrorBody>("q=velo", { jar });
    expect([limited.status, limited.body.error.code]).toEqual([429, "rate_limited"]);
    expect(Number(limited.header("retry-after"))).toBeGreaterThan(0);
  });

  it("refuses a bad token with 403 turnstile_failed and no pass", async () => {
    const jar = new Jar();
    await search("", { jar });
    await spend("search.device.hour", `d:${deviceOf(jar)}`);
    verify.mockResolvedValueOnce({ ok: false, codes: ["invalid-input-response"] });
    const failed = await search<ErrorBody>("", { jar, headers: { "x-turnstile-token": "forged" } });
    expect([failed.status, failed.body.error.code]).toEqual([403, "turnstile_failed"]);
    expect(failed.cookies.some((line) => line.startsWith("__Host-tsv="))).toBe(false);
  });

  it("escalates past the IP budget even for a new device", async () => {
    const jar = new Jar();
    await spend("search.ip", jar.ip);
    expect((await search<ErrorBody>("", { jar })).body.error.code).toBe("turnstile_required");
  });

  it("counts a signed-in member per account", async () => {
    const owner = await member();
    expect((await search<SearchApiResponse>("", { jar: owner.jar })).status).toBe(200);
    await spend("search.device.minute", `u:${owner.uid}`);
    expect((await search<ErrorBody>("", { jar: owner.jar })).body.error.code).toBe("turnstile_required");
    // Same account from another browser and IP: same budget.
    const other = new Jar();
    for (const name of ["__Host-session"]) other.cookies.set(name, owner.jar.cookies.get(name) ?? "");
    expect((await search<ErrorBody>("", { jar: other })).body.error.code).toBe("turnstile_required");
    // Without the session that browser has its own budget.
    expect((await search<SearchApiResponse>("", { jar: new Jar() })).status).toBe(200);
  });
});
