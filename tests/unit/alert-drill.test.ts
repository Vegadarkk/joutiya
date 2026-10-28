import { describe, expect, it, vi } from "vitest";
import type { ChannelOutcome } from "@/lib/alert";
import { drillAlert, runDrill, type DrillDeps } from "../../scripts/alert-drill";

const NOW = new Date("2026-10-28T10:00:00Z");

function deps(channels: string[], outcomes: ChannelOutcome[] = []): DrillDeps & { lines: string[] } {
  const lines: string[] = [];
  return { env: "staging", channels, deliver: vi.fn(async () => outcomes), now: NOW, id: "a1b2c3", log: (line) => lines.push(line), lines };
}

describe("alert drill", () => {
  it("sends a P0 tagged DRILL with a unique title, so the hourly dedupe never hides it", () => {
    expect(drillAlert("a1b2c3", NOW)).toMatchObject({ severity: "P0", title: "DRILL a1b2c3 · exercice d'alerte" });
    expect(drillAlert("a1b2c3", NOW).body).toContain("2026-10-28T10:00:00.000Z");
  });

  it("sends nothing without --apply", async () => {
    const run = deps(["telegram", "email"]);
    expect(await runDrill(false, run)).toBe(0);
    expect(run.deliver).not.toHaveBeenCalled();
    expect(run.lines).toContain("Environment: staging. Channels: telegram, email.");
  });

  it("succeeds only when every channel sent it", async () => {
    const ok = deps(["telegram", "email"], [{ channel: "telegram", status: "sent" }, { channel: "email", status: "sent" }]);
    expect(await runDrill(true, ok)).toBe(0);
    expect(ok.deliver).toHaveBeenCalledTimes(1);
    expect(await runDrill(true, deps(["telegram", "email"], [{ channel: "telegram", status: "sent" }, { channel: "email", status: "off" }]))).toBe(1);
    const failed = deps(["telegram"], [{ channel: "telegram", status: "failed", error: "Error: telegram: HTTP 401" }]);
    expect(await runDrill(true, failed)).toBe(1);
    expect(failed.lines).toContain("telegram: failed (Error: telegram: HTTP 401)");
  });

  it("fails an applied drill when no channel is configured", async () => {
    const none = deps([]);
    expect(await runDrill(true, none)).toBe(1);
    expect(none.deliver).not.toHaveBeenCalled();
    expect(await runDrill(false, deps([]))).toBe(0);
  });
});
