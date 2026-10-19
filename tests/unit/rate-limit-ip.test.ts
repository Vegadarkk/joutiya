import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as RateLimiterFlexible from "rate-limiter-flexible";
import { IP48_FACTOR, RATE_LIMITS, type RateLimitDefinition, type RateLimitId } from "@/config/rate-limits";
import { resetServerEnv } from "@/lib/env";
import { requestIdentity } from "@/lib/rate-limit/keys";
import { consumeIpLimit, consumeLimit, enforceIpLimit, ipLimitSpent, limitKey, resetRateLimiters, type IpIdentity } from "@/lib/rate-limit/limiter";

// IPv6 /48 siblings of the "ip" limiters (§6 "un second compteur plus large sur le /48 pour les
// sources agressives"): the identity flag, consumeIpLimit (one store call for IPv4, both buckets
// for IPv6, the worse outcome), and guards on the table and on every call site under src.

const stub = vi.hoisted(() => ({
  calls: [] as { method: "consume" | "get"; id: string; key: string; points?: number }[],
  answers: new Map<string, () => Promise<unknown>>(),
}));

vi.mock("@/lib/valkey/clients", () => ({ isValkeyConfigured: () => Boolean(process.env.RATE_LIMIT_REDIS_URL), valkey: () => ({}) }));
vi.mock("rate-limiter-flexible", async (importOriginal) => {
  const actual = await importOriginal<typeof RateLimiterFlexible>();
  class StubRedisLimiter {
    id: string;
    constructor(options: { keyPrefix: string }) {
      this.id = options.keyPrefix.slice("rl:".length);
    }
    consume(key: string, points: number): Promise<unknown> {
      stub.calls.push({ method: "consume", id: this.id, key, points });
      return stub.answers.get(this.id)?.() ?? Promise.resolve({ remainingPoints: 7 });
    }
    get(key: string): Promise<unknown> {
      stub.calls.push({ method: "get", id: this.id, key });
      return Promise.resolve(null);
    }
  }
  return { ...actual, RateLimiterRedis: StubRedisLimiter };
});

const V4: IpIdentity = { ipBucket: "203.0.113.7", ipNetwork: "203.0.113.7", ipv6: false };
const V6: IpIdentity = { ipBucket: "2001:0db8:0001:0002::/64", ipNetwork: "2001:0db8:0001::/48", ipv6: true };

const IP_IDS = (Object.entries(RATE_LIMITS) as [RateLimitId, RateLimitDefinition][]).filter(([, definition]) => definition.key === "ip").map(([id]) => id);
const IP48_IDS = (Object.entries(RATE_LIMITS) as [RateLimitId, RateLimitDefinition][]).filter(([, definition]) => definition.key === "ip48").map(([id]) => id);

beforeEach(() => {
  process.env.APP_ENV = "dev";
  resetServerEnv();
  resetRateLimiters();
  stub.calls.length = 0;
  stub.answers.clear();
});

afterEach(() => {
  delete process.env.RATE_LIMIT_REDIS_URL;
  resetServerEnv();
});

describe("requestIdentity", () => {
  const identity = (ip: string) => requestIdentity(new Headers({ "x-forwarded-for": ip }));

  it("flags IPv6 clients, with the /64 bucket and the /48 network", () => {
    expect(identity("2001:db8:1:2:aaaa::1")).toMatchObject({ ipBucket: "2001:0db8:0001:0002::/64", ipNetwork: "2001:0db8:0001::/48", ipv6: true });
  });

  it("keeps IPv4 and IPv4-mapped clients on their address", () => {
    expect(identity("203.0.113.7")).toMatchObject({ ipBucket: "203.0.113.7", ipNetwork: "203.0.113.7", ipv6: false });
    expect(identity("::ffff:203.0.113.7")).toMatchObject({ ip: "203.0.113.7", ipBucket: "203.0.113.7", ipNetwork: "203.0.113.7", ipv6: false });
  });
});

describe("consumeIpLimit on the store", () => {
  beforeEach(() => {
    process.env.RATE_LIMIT_REDIS_URL = "redis://stub";
    resetServerEnv();
    resetRateLimiters();
  });

  const limited = async (seconds: number) => {
    const { RateLimiterRes } = await import("rate-limiter-flexible");
    return () => Promise.reject(new RateLimiterRes(0, seconds * 1000, 99, false));
  };
  const down = () => Promise.reject(new Error("Redis connection is not ready"));

  it("costs IPv4 one store call, on its address", async () => {
    await expect(consumeIpLimit("pages.ip", V4, 2)).resolves.toEqual({ ok: true, remaining: 7 });
    expect(stub.calls).toEqual([{ method: "consume", id: "pages.ip", key: limitKey("pages.ip", V4.ipBucket), points: 2 }]);
  });

  it("consumes IPv6 on the /64 and the /48 sibling, same points", async () => {
    stub.answers.set("pages.ip48", () => Promise.resolve({ remainingPoints: 3 }));
    await expect(consumeIpLimit("pages.ip", V6, 2)).resolves.toEqual({ ok: true, remaining: 3 });
    expect(stub.calls).toEqual([
      { method: "consume", id: "pages.ip", key: limitKey("pages.ip", V6.ipBucket), points: 2 },
      { method: "consume", id: "pages.ip48", key: limitKey("pages.ip48", V6.ipNetwork), points: 2 },
    ]);
  });

  it("answers the worse outcome: limited (longest wait), then unavailable", async () => {
    stub.answers.set("search.ip48", await limited(40));
    await expect(consumeIpLimit("search.ip", V6)).resolves.toEqual({ ok: false, reason: "limited", retryAfterSeconds: 40 });
    stub.answers.set("search.ip", await limited(90));
    await expect(consumeIpLimit("search.ip", V6)).resolves.toEqual({ ok: false, reason: "limited", retryAfterSeconds: 90 });
    stub.answers.set("search.ip", down);
    await expect(consumeIpLimit("search.ip", V6)).resolves.toEqual({ ok: false, reason: "limited", retryAfterSeconds: 40 });
    stub.answers.delete("search.ip48");
    await expect(consumeIpLimit("search.ip", V6)).resolves.toEqual({ ok: false, reason: "unavailable" });
  });

  it("applies the limiter's policy when the /48 store call fails", async () => {
    stub.answers.set("signup.ip48", down);
    expect(RATE_LIMITS["signup.ip"].policy).toBe("closed");
    await expect(enforceIpLimit("signup.ip", V6)).rejects.toMatchObject({ status: 503, code: "unavailable" });
    stub.answers.set("pages.ip48", down);
    expect(RATE_LIMITS["pages.ip"].policy).toBe("open");
    await expect(enforceIpLimit("pages.ip", V6)).resolves.toBeUndefined();
    stub.answers.set("signup.ip48", await limited(30));
    await expect(enforceIpLimit("signup.ip", V6)).rejects.toMatchObject({ status: 429, headers: { "Retry-After": "30" } });
  });

  it("reads one bucket for IPv4 and both for IPv6", async () => {
    await expect(ipLimitSpent("challenge.ip", V4)).resolves.toBeNull();
    expect(stub.calls.map((call) => [call.method, call.id])).toEqual([["get", "challenge.ip"]]);
    stub.calls.length = 0;
    await ipLimitSpent("challenge.ip", V6);
    expect(stub.calls.map((call) => [call.method, call.id])).toEqual([
      ["get", "challenge.ip"],
      ["get", "challenge.ip48"],
    ]);
  });
});

describe("ip limiters in memory", () => {
  it("holds a source rotating /64s inside one /48 at the sibling's ceiling", async () => {
    const subscriber = (n: number): IpIdentity => ({ ...V6, ipBucket: `2001:0db8:0001:${n.toString(16).padStart(4, "0")}::/64` });
    // Earlier /64s of this /48 spent all but one point of its hard ceiling.
    await consumeLimit("challenge.ip.hard48", V6.ipNetwork, RATE_LIMITS["challenge.ip.hard48"].points - 1);
    await expect(ipLimitSpent("challenge.ip.hard", subscriber(2))).resolves.toBeNull();
    expect(await consumeIpLimit("challenge.ip.hard", subscriber(2))).toEqual({ ok: true, remaining: 0 });
    // A fresh /64 of the same /48: spent; another /48 or an IPv4 client: not.
    expect(await ipLimitSpent("challenge.ip.hard", subscriber(3))).toBeGreaterThan(0);
    expect(await consumeIpLimit("challenge.ip.hard", subscriber(3))).toMatchObject({ ok: false, reason: "limited" });
    await expect(ipLimitSpent("challenge.ip.hard", { ...V6, ipNetwork: "2001:0db8:0002::/48" })).resolves.toBeNull();
    await expect(ipLimitSpent("challenge.ip.hard", V4)).resolves.toBeNull();
  });
});

describe("ip48 siblings in the table", () => {
  it("gives every ip limiter a /48 sibling, IP48_FACTOR times wider, same window, block and policy", () => {
    expect(IP_IDS.length).toBeGreaterThan(10);
    expect(IP48_FACTOR).toBe(10);
    for (const id of IP_IDS) {
      const base = RATE_LIMITS[id];
      expect(RATE_LIMITS[`${id}48` as RateLimitId], id).toEqual({ ...base, points: base.points * IP48_FACTOR, key: "ip48" });
    }
    expect([...IP48_IDS].sort()).toEqual(IP_IDS.map((id) => `${id}48`).sort());
  });
});

// Every "ip" limiter goes through the ip helpers of limiter.ts: an id literal of an "ip" or "ip48"
// limiter anywhere under src (outside the table) must be an argument of a call to one of them, or
// to a function whose parameter is typed IpRateLimitId (escalateOnIp), or a RATE_LIMITS[...] read.
// So consumeLimit / enforceLimit / assertLimit / limitState... never see one, even through a tuple.

const SRC = path.resolve(__dirname, "../../src");
const TABLE = path.join(SRC, "config/rate-limits.ts");
const IP_HELPERS = ["consumeIpLimit", "enforceIpLimit", "assertIpLimit", "ipLimitSpent"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(name) ? [full] : [];
  });
}

function walk(node: ts.Node, visit: (node: ts.Node) => void): void {
  visit(node);
  node.forEachChild((child) => walk(child, visit));
}

const calleeName = (call: ts.CallExpression): string | null => {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text;
  if (ts.isPropertyAccessExpression(callee)) return callee.name.text;
  return null;
};

describe("ip limiter call sites", () => {
  it("never passes an ip limiter id to the plain limiter functions", () => {
    const files = sourceFiles(SRC)
      .filter((file) => file !== TABLE)
      .map((file) => ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS));

    // Functions taking an IpRateLimitId parameter count as ip helpers.
    const helpers = new Set(IP_HELPERS);
    for (const file of files) {
      walk(file, (node) => {
        if (!ts.isFunctionDeclaration(node) || !node.name) return;
        if (node.parameters.some((parameter) => parameter.type?.getText(file).includes("IpRateLimitId"))) helpers.add(node.name.text);
      });
    }

    const ids = new Set<string>([...IP_IDS, ...IP48_IDS]);
    const violations: string[] = [];
    let allowed = 0;
    for (const file of files) {
      walk(file, (node) => {
        if (!(ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) || !ids.has(node.text)) return;
        const parent = node.parent;
        const ok =
          (ts.isCallExpression(parent) && parent.arguments.includes(node as ts.Expression) && helpers.has(calleeName(parent) ?? "")) ||
          (ts.isElementAccessExpression(parent) && parent.expression.getText(file) === "RATE_LIMITS");
        if (ok) allowed += 1;
        else violations.push(`${path.relative(SRC, file.fileName)}:${file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1} "${node.text}"`);
      });
    }
    expect(violations).toEqual([]);
    // The scan sees the real call sites (pages, search, challenge, auth, reveal...).
    expect(allowed).toBeGreaterThan(15);
  });
});
