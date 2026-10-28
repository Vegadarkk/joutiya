import { describe, expect, it } from "vitest";
import registry from "../../infra/targets.json";
import type { Targets } from "../../scripts/assert-target";
import {
  containsEdge,
  dnsChange,
  googleIdp,
  LOADTEST_RULE_REF,
  loadtestRule,
  loadtestRuleset,
  redact,
  needsAccess,
  preflightErrors,
  readEdgeFile,
  rulesetDrift,
  settingsDrift,
  substitute,
  tunnelHostnames,
  validateEdge,
  validateR2,
  WEBHOOK_BYPASS,
  type AccessApp,
  type DnsRecord,
  type R2CorsRule,
  type R2Settings,
  type Ruleset,
  type TunnelConfig,
  type ZoneSettings,
} from "../../scripts/cloudflare";

const record = (type: string, content: string, proxied = true): DnsRecord => ({ id: `${type}-${content}`, type, name: "joutiya.ma", content, proxied });
const TARGET = "0f0e0d0c-0b0a-4908-8706-050403020100.cfargotunnel.com";

describe("infra/cloudflare", () => {
  it("fits Cloudflare Free and guards every private hostname with Access", () => {
    expect(validateEdge()).toEqual([]);
  });

  it("flags a staging hostname without Access, a second-level hostname and a missing catch-all", () => {
    const tunnel: TunnelConfig = {
      config: {
        ingress: [
          { hostname: "preview.staging.joutiya.ma", service: "http://web:3000" },
          { hostname: "beta.joutiya.ma", service: "http://web:3000" },
          { hostname: "ssh.joutiya.ma", service: "ssh://localhost:22" },
        ],
      },
    };
    const read = <T,>(name: string): T => (name.startsWith("tunnel.staging") ? tunnel : readEdgeFile(name)) as T;
    const errors = validateEdge(read);
    expect(errors).toContain("tunnel.staging.json: the last ingress rule must be a catch-all http_status");
    expect(errors).toContain("tunnel.staging.json: preview.staging.joutiya.ma is not covered by Universal SSL");
    expect(errors).toContain("tunnel.staging.json: beta.joutiya.ma has no Access application");
    expect(errors).toContain("tunnel.staging.json: ssh.joutiya.ma: SSH goes through tunnel.ssh.json only");
  });

  it("lets staff in with the Google login method only", () => {
    const { apps } = readEdgeFile<{ apps: AccessApp[] }>("access-apps.json");
    const withOtp = { apps: apps.map((app, index) => (index === 0 ? { ...app, allowed_idps: [] } : app)) };
    const read = <T,>(name: string): T => (name === "access-apps.json" ? withOtp : readEdgeFile(name)) as T;
    expect(validateEdge(read)).toEqual(["access-apps.json: admin.joutiya.ma must allow the Google login method only (§6)"]);
  });

  it("lets only the staging webhook path bypass Access", () => {
    const { apps } = readEdgeFile<{ apps: AccessApp[] }>("access-apps.json");
    const bypass = { name: "Open", decision: "bypass", include: [{ everyone: {} }] };
    const changed = {
      apps: [
        ...apps.map((app) => (app.domain === WEBHOOK_BYPASS || app.domain === "admin-staging.joutiya.ma" ? { ...app, policies: [...app.policies, bypass] } : app)),
        { name: "Open API", domain: "staging.joutiya.ma/api", type: "self_hosted", session_duration: "24h", policies: [bypass] },
      ],
    };
    const read = <T,>(name: string): T => (name === "access-apps.json" ? changed : readEdgeFile(name)) as T;
    expect(validateEdge(read)).toEqual([
      `access-apps.json: ${WEBHOOK_BYPASS} must have a single bypass policy`,
      `access-apps.json: admin-staging.joutiya.ma: only ${WEBHOOK_BYPASS} may bypass Access`,
      `access-apps.json: staging.joutiya.ma/api: only ${WEBHOOK_BYPASS} may bypass Access`,
    ]);
  });

  it("picks the account's only Google login method", () => {
    expect(googleIdp([{ id: "otp", type: "onetimepin" }, { id: "g1", type: "google" }])).toBe("g1");
    expect(() => googleIdp([{ id: "otp", type: "onetimepin" }])).toThrow("found 0");
    expect(() => googleIdp([{ id: "g1", type: "google" }, { id: "g2", type: "google" }])).toThrow("found 2");
  });

  it("guards every tunnel hostname except the public production site", () => {
    expect(needsAccess("prod", "joutiya.ma")).toBe(false);
    expect(needsAccess("prod", "www.joutiya.ma")).toBe(false);
    expect(needsAccess("prod", "admin.joutiya.ma")).toBe(true);
    expect(needsAccess("staging", "staging.joutiya.ma")).toBe(true);
    expect(needsAccess("ssh", "ssh.joutiya.ma")).toBe(true);
  });

  it("lists the tunnel hostnames", () => {
    expect(tunnelHostnames(readEdgeFile<TunnelConfig>("tunnel.prod.json"))).toEqual(["joutiya.ma", "www.joutiya.ma", "admin.joutiya.ma"]);
    expect(tunnelHostnames(readEdgeFile<TunnelConfig>("tunnel.ssh.json"))).toEqual(["ssh.joutiya.ma"]);
  });
});

describe("substitute", () => {
  it("fills ${NAME} from the environment and reports what is missing", () => {
    const template = { include: [{ email: { email: "${ACCESS_OWNER_EMAIL}" } }], token: "${ACCESS_CI_TOKEN_ID}", count: 2 };
    const { value, missing } = substitute(template, { ACCESS_OWNER_EMAIL: " owner@example.com " });
    expect(value).toEqual({ include: [{ email: { email: "owner@example.com" } }], token: "", count: 2 });
    expect(missing).toEqual(["ACCESS_CI_TOKEN_ID"]);
  });
});

describe("dnsChange", () => {
  it("creates the CNAME when nothing is in the way, and keeps MX and TXT", () => {
    expect(dnsChange([record("MX", "route1.mx.cloudflare.net"), record("TXT", "v=spf1")], TARGET, false)).toEqual({ create: true, deletes: [], conflicts: [] });
  });

  it("does nothing when the proxied CNAME already exists", () => {
    expect(dnsChange([record("CNAME", TARGET)], TARGET, false)).toEqual({ create: false, deletes: [], conflicts: [] });
  });

  it("never replaces an existing record without --replace-dns", () => {
    const parking = record("A", "203.0.113.10");
    expect(dnsChange([parking], TARGET, false)).toEqual({ create: false, deletes: [], conflicts: [parking] });
    expect(dnsChange([parking], TARGET, true)).toEqual({ create: true, deletes: [parking], conflicts: [] });
    const unproxied = record("CNAME", TARGET, false);
    expect(dnsChange([unproxied], TARGET, false).conflicts).toEqual([unproxied]);
  });
});

describe("r2-buckets.json", () => {
  const targets = registry as unknown as Targets;

  it("names registry buckets only, with each role's methods and each environment's origins", () => {
    expect(validateR2(readEdgeFile<R2Settings>("r2-buckets.json"), targets)).toEqual([]);
  });

  it("flags another environment's origin, a write on media and a rule that would empty a private bucket", () => {
    const settings: R2Settings = {
      jurisdiction: "eu",
      defaultMultipartAbort: { name: "Default Multipart Abort Rule", abortAfterDays: 7 },
      buckets: {
        "joutiya-staging-quarantine": { cors: [{ AllowedOrigins: ["https://joutiya.ma"], AllowedMethods: ["PUT"] }] },
        "joutiya-prod-media": { cors: [{ AllowedOrigins: ["https://joutiya.ma"], AllowedMethods: ["GET", "PUT"] }] },
        "joutiya-prod-private": { lifecycle: [{ name: "purge", prefix: "", deleteAfterDays: 0 }] },
        "joutiya-prod-backups": {},
      },
    };
    expect(validateR2(settings, targets)).toEqual([
      "r2-buckets.json: joutiya-staging-quarantine must not admit https://joutiya.ma",
      "r2-buckets.json: joutiya-prod-media must not allow PUT",
      "r2-buckets.json: joutiya-prod-private: purge needs a whole number of days",
      "r2-buckets.json: joutiya-prod-private: purge would empty the bucket",
      "r2-buckets.json: joutiya-prod-backups is not a bucket of infra/targets.json",
    ]);
  });
});

describe("preflightErrors", () => {
  const rule: R2CorsRule = { AllowedOrigins: ["https://joutiya.ma"], AllowedMethods: ["PUT"], AllowedHeaders: ["Content-Type"], MaxAgeSeconds: 3600 };

  it("accepts an answer that allows the origin, method and headers", () => {
    const headers = new Headers({
      "access-control-allow-origin": "https://joutiya.ma",
      "access-control-allow-methods": "PUT",
      "access-control-allow-headers": "content-type",
      "access-control-max-age": "3600",
    });
    expect(preflightErrors(rule, "https://joutiya.ma", "PUT", 204, headers)).toEqual([]);
    expect(preflightErrors(rule, "https://joutiya.ma", "PUT", 200, headers)).toEqual([]);
  });

  it("reports a bucket without CORS and an answer that lacks the method, headers and max age", () => {
    expect(preflightErrors(rule, "https://joutiya.ma", "PUT", 403, new Headers())).toEqual(["HTTP 403"]);
    const partial = new Headers({ "access-control-allow-origin": "https://joutiya.ma", "access-control-allow-methods": "GET, HEAD" });
    expect(preflightErrors(rule, "https://joutiya.ma", "PUT", 200, partial)).toEqual(["allow-methods lacks PUT", "allow-headers lacks Content-Type", "max-age missing"]);
  });
});

describe("zone --check", () => {
  const transform = readEdgeFile<Ruleset>("transform-rules.json");
  // The API answers each rule with its id, version and defaults on top of what was sent.
  const live = transform.rules.map((rule, index) => ({ ...rule, id: `r${index}`, version: "1", enabled: true, last_updated: "2026-10-15T22:43:00Z" }));

  it("accepts the live rules when they hold every field of the file", () => {
    expect(rulesetDrift(transform, live)).toEqual([]);
    expect(containsEdge({ a: [1, { b: "x" }] }, { a: [1, { b: "x", c: 2 }], d: 3 })).toBe(true);
    expect(containsEdge({ a: [1] }, { a: [1, 2] })).toBe(false);
  });

  it("reports a missing ruleset, a dropped or reordered rule and an edited one", () => {
    expect(rulesetDrift(transform, null)).toEqual(["http_request_late_transform: no ruleset on the zone (2 rules expected)"]);
    expect(rulesetDrift(transform, live.slice(0, 1))).toEqual(["http_request_late_transform: rules verified_bot_reset instead of verified_bot_reset, verified_bot_set"]);
    expect(rulesetDrift(transform, [...live].reverse())[0]).toMatch(/^http_request_late_transform: rules verified_bot_set, verified_bot_reset instead of/);
    const edited = live.map((rule) => (rule.ref === "verified_bot_set" ? { ...rule, expression: "true" } : rule));
    expect(rulesetDrift(transform, edited)).toEqual(["http_request_late_transform: rule verified_bot_set differs from the file"]);
  });

  it("compares every zone setting", () => {
    const settings = readEdgeFile<ZoneSettings>("zone-settings.json");
    const values = Object.fromEntries(settings.settings.map((setting) => [setting.id, setting.value]));
    expect(settingsDrift(settings, values)).toEqual([]);
    expect(settingsDrift(settings, { ...values, email_obfuscation: "on" })).toEqual(['setting email_obfuscation is "on", expected "off"']);
  });
});

describe("load test rule", () => {
  const secret = "a".repeat(20) + "B9".repeat(10);
  const waf = readEdgeFile<Ruleset>("waf-rules.json");

  it("skips the edge limits for staging requests carrying the secret header only", () => {
    const rule = loadtestRule(secret);
    expect(rule.expression).toBe(`http.host eq "staging.joutiya.ma" and any(http.request.headers["x-joutiya-loadtest"][*] eq "${secret}")`);
    expect(rule.action_parameters).toEqual({ phases: ["http_ratelimit", "http_request_firewall_managed"], products: ["bic", "securityLevel"] });
  });

  it("refuses a secret that could change the expression", () => {
    for (const bad of ["short", `${"a".repeat(32)}" or true or "`, `${"a".repeat(31)} `]) expect(() => loadtestRule(bad)).toThrow(/32 to 128/);
  });

  it("goes first, within the Free limit, and goes away with the committed rules", () => {
    const on = loadtestRuleset(waf, secret);
    expect(on.rules.map((rule) => rule.ref)).toEqual([LOADTEST_RULE_REF, ...waf.rules.map((rule) => rule.ref)]);
    expect(loadtestRuleset(on, secret).rules).toHaveLength(on.rules.length);
    expect(loadtestRuleset(waf, null)).toBe(waf);
    expect(() => loadtestRuleset({ ...waf, rules: [...waf.rules, { ...waf.rules[0]!, ref: "extra" }] }, secret)).toThrow(/Free allows 5/);
  });

  it("never prints the secret", () => {
    const shown = JSON.stringify(redact({ rules: loadtestRuleset(waf, secret).rules }, secret));
    expect(shown).not.toContain(secret);
    expect(shown).toContain('eq \\"***\\"');
  });
});
