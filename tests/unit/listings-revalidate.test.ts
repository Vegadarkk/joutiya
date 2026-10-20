import { beforeEach, describe, expect, it, vi } from "vitest";

// ISR invalidation of the public listing and profile pages, for every locale, safe outside a
// Next request context (worker, tests).

const cache = vi.hoisted(() => ({ revalidatePath: vi.fn<(path: string) => void>() }));
const log = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: cache.revalidatePath }));
vi.mock("@/lib/logging/logger", () => ({ logger: log }));

const { listingPagePaths, listingRevalidationPaths, profilePagePaths, revalidateListingPaths, storefrontPagePaths } = await import("@/lib/listings/revalidate");

beforeEach(() => {
  cache.revalidatePath.mockReset();
  log.debug.mockReset();
});

describe("revalidateListingPaths", () => {
  it("names every locale of the listing and profile pages", () => {
    expect(listingPagePaths("velo-casablanca-abcd2345")).toEqual(["/fr/annonce/velo-casablanca-abcd2345", "/ar/annonce/velo-casablanca-abcd2345", "/rif/annonce/velo-casablanca-abcd2345"]);
    expect(profilePagePaths("k7m2p9q4r8")).toEqual(["/fr/profil/k7m2p9q4r8", "/ar/profil/k7m2p9q4r8", "/rif/profil/k7m2p9q4r8"]);
    expect(listingRevalidationPaths({ publicId: "k7m2p9q4r8" })).toHaveLength(3);
    expect(storefrontPagePaths("atlas-auto-k7m2p9q4")).toEqual(["/fr/boutique/atlas-auto-k7m2p9q4", "/ar/boutique/atlas-auto-k7m2p9q4", "/rif/boutique/atlas-auto-k7m2p9q4"]);
    expect(listingRevalidationPaths({ publicId: "k7m2p9q4r8", shopSegment: "atlas-auto-k7m2p9q4" })).toHaveLength(6);
    expect(listingRevalidationPaths({})).toEqual([]);
  });

  it("revalidates each path once", () => {
    const paths = revalidateListingPaths({ slugId: "velo-casablanca-abcd2345", publicId: "k7m2p9q4r8" });
    expect(paths).toHaveLength(6);
    expect(cache.revalidatePath.mock.calls.map(([path]) => path)).toEqual(paths);
    expect(log.debug).not.toHaveBeenCalled();
  });

  it("swallows the error thrown outside a request context and keeps going", () => {
    cache.revalidatePath.mockImplementation(() => {
      throw new Error("Invariant: static generation store missing");
    });
    expect(() => revalidateListingPaths({ slugId: "velo-casablanca-abcd2345" })).not.toThrow();
    expect(cache.revalidatePath).toHaveBeenCalledTimes(3);
    expect(log.debug).toHaveBeenCalledTimes(3);
  });
});
