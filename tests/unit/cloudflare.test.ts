import { describe, expect, it } from "vitest";
import { dnsChange, readEdgeFile, substitute, tunnelHostnames, validateEdge, type DnsRecord, type TunnelConfig } from "../../scripts/cloudflare";

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
