import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ProProfileRecord } from "@/lib/db/repositories/pro-profiles";

// pro-effects-sync (03:50 UTC, phase 7): verified shops whose claims grant or listings retag failed
// after the decision get the effects again; shops that left the Pro states are skipped; the job
// waits when Firebase is missing or the write quota is degraded.

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));
const configured = { value: true };
vi.mock("@/lib/firebase/admin", () => ({ isFirestoreConfigured: () => configured.value, isFirebaseConfigured: () => configured.value, db: vi.fn() }));
vi.mock("@/lib/quota", () => ({ isDegraded: vi.fn(async () => false), consume: vi.fn(async () => ({ level: "ok" })) }));
vi.mock("@/lib/db/repositories/pro-profiles", () => ({ listProEffectsPending: vi.fn(async () => []) }));
vi.mock("@/lib/pro/effects", () => ({ applyVerificationEffects: vi.fn(async () => ({ ok: true, retagged: 0, claimsGranted: true })) }));

const { listProEffectsPending } = await import("@/lib/db/repositories/pro-profiles");
const { applyVerificationEffects } = await import("@/lib/pro/effects");
const { isDegraded } = await import("@/lib/quota");
const { JOBS, SCHEDULES } = await import("@/worker/jobs");
const { PRO_EFFECTS_SYNC_BATCH, proEffectsSync } = await import("@/worker/jobs/pro-effects-sync");

const NOW = new Date("2026-10-20T03:50:00Z");

function profile(proId: string, overrides: Partial<ProProfileRecord> = {}): ProProfileRecord {
  return { proId, ownerUid: `owner-${proId}`, lifecycle: "verified", kybc: { status: "verified", iceFormatOk: true, uploadIds: [] }, effectsPendingSince: new Date(NOW.getTime() - 3_600_000), ...overrides } as unknown as ProProfileRecord;
}

beforeEach(() => {
  configured.value = true;
  vi.mocked(listProEffectsPending).mockReset().mockResolvedValue([]);
  vi.mocked(applyVerificationEffects).mockReset().mockResolvedValue({ ok: true, retagged: 0, claimsGranted: true });
  vi.mocked(isDegraded).mockReset().mockResolvedValue(false);
});

describe("pro-effects-sync", () => {
  it("reruns the effects of every pending verified shop and reports what is still pending", async () => {
    vi.mocked(listProEffectsPending).mockResolvedValue([profile("shop0001"), profile("shop0002", { lifecycle: "active" }), profile("shop0003")]);
    vi.mocked(applyVerificationEffects).mockResolvedValueOnce({ ok: true, retagged: 2, claimsGranted: true }).mockResolvedValueOnce({ ok: false, retagged: 0, claimsGranted: false }).mockResolvedValueOnce({ ok: true, retagged: 0, claimsGranted: false });

    expect(await proEffectsSync(NOW)).toEqual({ repaired: 2, pending: 1, skipped: 0 });
    expect(listProEffectsPending).toHaveBeenCalledWith(NOW, PRO_EFFECTS_SYNC_BATCH);
    expect(applyVerificationEffects).toHaveBeenCalledWith("owner-shop0001", "shop0001", NOW);
    expect(applyVerificationEffects).toHaveBeenCalledWith("owner-shop0002", "shop0002", NOW);
  });

  it("skips a shop that left the Pro states or whose KYBC is no longer verified", async () => {
    vi.mocked(listProEffectsPending).mockResolvedValue([
      profile("shop0004", { lifecycle: "suspended" }),
      profile("shop0005", { lifecycle: "rejected", kybc: { status: "rejected", iceFormatOk: true, uploadIds: [] } }),
      profile("shop0006", { lifecycle: "pending_verification", kybc: { status: "submitted", iceFormatOk: true, uploadIds: [] } }),
    ]);
    expect(await proEffectsSync(NOW)).toEqual({ repaired: 0, pending: 0, skipped: 3 });
    expect(applyVerificationEffects).not.toHaveBeenCalled();
  });

  it("waits without Firebase or while the Firestore write quota is degraded", async () => {
    vi.mocked(listProEffectsPending).mockResolvedValue([profile("shop0007")]);
    configured.value = false;
    expect(await proEffectsSync(NOW)).toEqual({ repaired: 0, pending: 0, skipped: 0 });
    configured.value = true;
    vi.mocked(isDegraded).mockResolvedValue(true);
    expect(await proEffectsSync(NOW)).toEqual({ repaired: 0, pending: 0, skipped: 0 });
    expect(listProEffectsPending).not.toHaveBeenCalled();
  });

  it("is registered on the system queue, nightly after the backup", () => {
    expect(JOBS["pro-effects-sync"]).toBeTypeOf("function");
    expect(SCHEDULES["pro-effects-sync-nightly"]).toEqual({ pattern: "50 3 * * *", job: "pro-effects-sync" });
  });
});
