import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

// POST /api/dev/search/rebuild: development only (APP_ENV=dev), 404 anywhere else (e2e seeds then
// rebuilds the index from Firestore).

const env = { APP_ENV: "dev" as "dev" | "staging" | "prod" };
vi.mock("@/lib/env", () => ({ serverEnv: () => env }));
vi.mock("@/lib/observability/capture", () => ({ captureServerException: vi.fn() }));
vi.mock("@/lib/search/indexer", () => ({ rebuildFromFirestore: vi.fn(async () => ({ indexed: 3, removed: 1, skipped: 0 })) }));

const { rebuildFromFirestore } = await import("@/lib/search/indexer");
const { POST } = await import("@/app/api/dev/search/rebuild/route");

const call = () => POST(new NextRequest("http://localhost:3000/api/dev/search/rebuild", { method: "POST" }), { params: Promise.resolve({}) });

beforeEach(() => {
  env.APP_ENV = "dev";
  vi.mocked(rebuildFromFirestore).mockClear();
});

describe("POST /api/dev/search/rebuild", () => {
  it("rebuilds the index in development", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ indexed: 3, removed: 1, skipped: 0 });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it.each(["staging", "prod"] as const)("does not exist in %s", async (appEnv) => {
    env.APP_ENV = appEnv;
    const response = await call();
    expect(response.status).toBe(404);
    expect(rebuildFromFirestore).not.toHaveBeenCalled();
  });
});
