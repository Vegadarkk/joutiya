import { describe, expect, it, vi } from "vitest";
import { GUIDE_SOURCES } from "@/content/guide";
import { acceptLinkState, changeDistance, classifyFetch, hammingDistance, linkDisplay, linkFlags, nextLinkState, pageText, simhash, type LinkState, type PageFetch } from "@/lib/guide/check";
import { fetchGuidePage, isPrivateAddress, MAX_BODY_BYTES } from "@/lib/guide/fetch-page";

// Link checker of the admin procedures guide (design guide-demarches G4): classification of a fetch,
// fingerprint, state between runs, flags, what visitors see, and the guarded fetch.

const URL_A = "https://www.narsa-securiteroutiere.ma/fr/mutation-de-vehicules/";
const page = (over: Partial<PageFetch> = {}): PageFetch => ({ status: 200, finalUrl: URL_A, contentType: "text/html; charset=utf-8", body: `<html><head><title>Mutation de véhicules</title></head><body>${"Le changement de propriétaire se fait auprès de la NARSA. ".repeat(20)}</body></html>`, ...over });

describe("classifyFetch", () => {
  it("tells ok, redirected, broken, blocked, maintenance, parked, offsite and unreachable apart", () => {
    expect(classifyFetch(URL_A, page()).outcome).toBe("ok");
    expect(classifyFetch(URL_A, page({ finalUrl: URL_A.replace(/\/$/, "") })).outcome).toBe("ok");
    expect(classifyFetch(URL_A, page({ finalUrl: "https://www.narsa-securiteroutiere.ma/fr/autre/" })).outcome).toBe("redirected");
    expect(classifyFetch(URL_A, page({ status: 404 })).outcome).toBe("broken");
    expect(classifyFetch(URL_A, page({ status: 503 })).outcome).toBe("broken");
    expect(classifyFetch(URL_A, page({ status: 403 })).outcome).toBe("blocked");
    expect(classifyFetch(URL_A, page({ body: '<html><head><title></title></head><body><script src="/TSPD/abc"></script></body></html>' })).outcome).toBe("blocked");
    expect(classifyFetch(URL_A, page({ body: "<html><title>Request Rejected</title></html>" })).outcome).toBe("blocked");
    expect(classifyFetch(URL_A, page({ body: "<html><head><title>Maintenance</title></head><body>Site en maintenance</body></html>" })).outcome).toBe("soft-error");
    expect(classifyFetch(URL_A, page({ body: "<html><head><title>Portail</title></head><body>En cours de construction</body></html>" })).outcome).toBe("soft-error");
    expect(classifyFetch(URL_A, page({ finalUrl: "https://www.narsa-securiteroutiere.ma/lander" })).outcome).toBe("soft-error");
    expect(classifyFetch(URL_A, page({ status: null, offsite: true, finalUrl: "https://parked.example.com/" }))).toEqual({ outcome: "offsite", detail: "redirection vers https://parked.example.com/" });
    expect(classifyFetch(URL_A, page({ status: null, error: "délai dépassé" }))).toEqual({ outcome: "unreachable", detail: "délai dépassé" });
  });

  it("does not take a long page that mentions maintenance for a maintenance page", () => {
    expect(classifyFetch(URL_A, page({ body: `<title>Vignette</title><p>${"La maintenance du véhicule et la vignette annuelle. ".repeat(30)}</p>` })).outcome).toBe("ok");
  });
});

describe("fingerprint", () => {
  it("extracts the visible text without scripts or styles", () => {
    expect(pageText("<html><head><title>A &amp; B</title><style>p{}</style></head><body><script>x()</script><p>Bonjour&nbsp;<b>tout</b> le monde</p><!-- c --></body></html>")).toEqual({ title: "A & B", text: "Bonjour tout le monde" });
  });

  it("keeps near pages within a few bits and moves a rewritten page far", () => {
    const text = "La mutation inscrit l'acheteur comme nouveau propriétaire du véhicule auprès de la NARSA. Le vendeur présente la carte grise, le contrat de vente légalisé et sa carte nationale. ".repeat(6);
    const a = simhash(text);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
    expect(simhash(text.replace("2025", "2026"))).toBe(a);
    expect(hammingDistance(a, simhash(`${text} Mise à jour du mois.`))).toBeLessThanOrEqual(12);
    expect(hammingDistance(a, simhash("Les bourses de l'enseignement supérieur sont ouvertes aux bacheliers selon des critères sociaux publiés par l'office chaque année au printemps."))).toBeGreaterThan(12);
    expect(hammingDistance(a, "")).toBe(64);
    expect(simhash("")).toBe("");
  });
});

const NOW = new Date("2026-11-02T06:10:00Z");
const later = (weeks: number) => new Date(NOW.getTime() + weeks * 7 * 86_400_000);
const ok = { outcome: "ok" as const, detail: "HTTP 200", httpStatus: 200, finalUrl: URL_A, fingerprint: { simhash: "0123456789abcdef", sha256: "a".repeat(64) } };

describe("link state", () => {
  it("counts a failure streak, keeps the last good fingerprint and takes the first as baseline", () => {
    const first = nextLinkState(undefined, URL_A, ok, NOW);
    expect(first).toMatchObject({ streak: 0, lastOkAt: NOW.toISOString(), baseline: { simhash: "0123456789abcdef", at: NOW.toISOString() } });
    const down = nextLinkState(first, URL_A, { outcome: "broken", detail: "HTTP 404", httpStatus: 404, finalUrl: URL_A }, later(1));
    const still = nextLinkState(down, URL_A, { outcome: "broken", detail: "HTTP 404", httpStatus: 404, finalUrl: URL_A }, later(2));
    expect([down.streak, still.streak]).toEqual([1, 2]);
    expect(still.fingerprint).toEqual(ok.fingerprint);
    expect(still.lastOkAt).toBe(NOW.toISOString());
    // The registry's URL changed: the state starts over.
    expect(nextLinkState(still, "https://www.narsa-securiteroutiere.ma/fr/nouvelle/", ok, later(3))).toMatchObject({ streak: 0, baseline: { at: later(3).toISOString() } });
  });

  it("flags a change past the threshold until a person accepts it", () => {
    const first = nextLinkState(undefined, URL_A, ok, NOW);
    const changed = nextLinkState(first, URL_A, { ...ok, fingerprint: { simhash: "fedcba9876543210", sha256: "b".repeat(64) } }, later(1));
    const source = { url: URL_A, reviewedAt: "2026-10-28", confirmed: true };
    expect(changeDistance(changed)).toBeGreaterThan(12);
    expect(linkFlags(source, changed, later(1))).toEqual(["changed"]);
    const accepted = acceptLinkState(changed, "uid-1", later(1));
    expect(accepted).toMatchObject({ acceptedBy: "uid-1", baseline: { simhash: "fedcba9876543210" } });
    expect(linkFlags(source, accepted, later(1))).toEqual([]);
  });

  it("flags failures after two runs, robot refusals after four, an old review and a never-seen source", () => {
    const source = { url: URL_A, reviewedAt: "2026-10-28", confirmed: true };
    const state = (outcome: LinkState["outcome"], streak: number): LinkState => ({ url: URL_A, outcome, detail: "", httpStatus: null, finalUrl: URL_A, checkedAt: NOW.toISOString(), streak });
    expect(linkFlags(source, state("broken", 1), NOW)).toEqual([]);
    expect(linkFlags(source, state("broken", 2), NOW)).toEqual(["failing"]);
    expect(linkFlags(source, state("blocked", 3), NOW)).toEqual([]);
    expect(linkFlags(source, state("unreachable", 4), NOW)).toEqual(["blocked"]);
    expect(linkFlags(source, undefined, new Date("2027-05-01T00:00:00Z"))).toEqual(["review-due"]);
    expect(linkFlags({ ...source, confirmed: false }, state("unreachable", 1), NOW)).toEqual(["unconfirmed"]);
  });

  it("hides a never-seen source, withdraws a gone or offsite page, keeps a blocked one live", () => {
    const base: LinkState = { url: URL_A, outcome: "ok", detail: "", httpStatus: 200, finalUrl: URL_A, checkedAt: NOW.toISOString(), streak: 0 };
    expect(linkDisplay({ url: URL_A, confirmed: false }, undefined)).toBe("hidden");
    expect(linkDisplay({ url: URL_A, confirmed: false }, { ...base, lastOkAt: NOW.toISOString() })).toBe("live");
    expect(linkDisplay({ url: URL_A, confirmed: true }, undefined)).toBe("live");
    expect(linkDisplay({ url: URL_A, confirmed: true }, { ...base, outcome: "offsite", streak: 1 })).toBe("withdrawn");
    expect(linkDisplay({ url: URL_A, confirmed: true }, { ...base, outcome: "broken", streak: 1 })).toBe("live");
    expect(linkDisplay({ url: URL_A, confirmed: true }, { ...base, outcome: "soft-error", streak: 2 })).toBe("withdrawn");
    expect(linkDisplay({ url: URL_A, confirmed: true }, { ...base, outcome: "blocked", streak: 9 })).toBe("live");
  });
});

describe("fetchGuidePage", () => {
  const publicIp = async () => ["196.200.1.1"];
  const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" }, ...init });

  it("follows a redirect within the official hosts and fingerprints the page", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request, _init?: RequestInit) =>
      String(url) === GUIDE_SOURCES.ancfcc.url ? new Response(null, { status: 301, headers: { location: "/ar" } }) : html("<title>ANCFCC</title><p>Conservation foncière et cadastre du Royaume</p>"),
    );
    const result = await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: fetchImpl as typeof fetch, resolve: publicIp });
    expect(result).toMatchObject({ status: 200, finalUrl: "https://www.ancfcc.gov.ma/ar" });
    expect(result.fingerprint?.simhash).toMatch(/^[0-9a-f]{16}$/);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "manual" });
  });

  it("never fetches an offsite or http redirect target, nor a host with a private address", async () => {
    const offsite = vi.fn(async () => new Response(null, { status: 302, headers: { location: "https://parked.example.com/lander" } }));
    expect(await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: offsite as unknown as typeof fetch, resolve: publicIp })).toMatchObject({ offsite: true, finalUrl: "https://parked.example.com/lander", status: null });
    expect(offsite).toHaveBeenCalledTimes(1);
    const downgrade = vi.fn(async () => new Response(null, { status: 302, headers: { location: "http://www.ancfcc.gov.ma/" } }));
    expect(await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: downgrade as unknown as typeof fetch, resolve: publicIp })).toMatchObject({ offsite: true });
    const never = vi.fn();
    expect(await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: never as unknown as typeof fetch, resolve: async () => ["169.254.169.254"] })).toMatchObject({ status: null, error: "adresse IP non publique" });
    expect(never).not.toHaveBeenCalled();
  });

  it("reports a timeout, caps the body and hashes a PDF's bytes", async () => {
    const timeout = vi.fn(async () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    expect(await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: timeout as unknown as typeof fetch, resolve: publicIp })).toMatchObject({ status: null, error: "délai dépassé" });
    const big = vi.fn(async () => html("a".repeat(MAX_BODY_BYTES + 5000)));
    expect((await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: big as unknown as typeof fetch, resolve: publicIp })).body.length).toBe(MAX_BODY_BYTES);
    const pdf = vi.fn(async () => new Response(new Uint8Array([37, 80, 68, 70]), { status: 200, headers: { "content-type": "application/pdf" } }));
    const result = await fetchGuidePage(GUIDE_SOURCES.ancfcc.url, { fetchImpl: pdf as unknown as typeof fetch, resolve: publicIp });
    expect(result).toMatchObject({ body: "", fingerprint: { simhash: "" } });
    expect(result.fingerprint?.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("recognises private, loopback, link-local and mapped addresses", () => {
    for (const address of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.4", "192.168.1.1", "100.64.0.1", "0.0.0.0", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1", "not-an-ip"]) expect(isPrivateAddress(address), address).toBe(true);
    for (const address of ["196.200.1.1", "41.214.0.1", "2a01:4f8::1"]) expect(isPrivateAddress(address), address).toBe(false);
  });
});
