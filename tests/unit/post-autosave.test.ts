import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOSAVE_IDLE_MS, Autosave, type AutosaveState } from "@/lib/listings/client/autosave";

// Coalescing rules of design D2: never a write per keystroke; one merged write after 5 s idle, on
// step change or on blur (flush); a failed write keeps its patch for the next trigger.

type Patch = Record<string, unknown>;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("Autosave", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends one merged patch after the idle delay, not one per keystroke", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const states: AutosaveState[] = [];
    const autosave = new Autosave<Patch>({ save, onState: (state) => states.push(state) });
    for (const title of ["D", "Da", "Dac", "Daci", "Dacia"]) {
      autosave.queue({ title });
      await vi.advanceTimersByTimeAsync(1000);
    }
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith({ title: "Dacia" });
    expect(states.at(-1)).toBe("saved");
  });

  it("merges different fields into one request", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ title: "Vélo" });
    autosave.queue({ price: 1500 });
    autosave.queue({ title: "Vélo de ville" });
    await autosave.flush();
    expect(save).toHaveBeenCalledWith({ title: "Vélo de ville", price: 1500 });
  });

  it("flushes immediately on step change or blur and cancels the timer", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ description: "..." });
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
    expect(save).toHaveBeenCalledTimes(1);
    expect(autosave.hasPending()).toBe(false);
  });

  it("queues what is typed during a save and sends it after", async () => {
    const first = deferred<void>();
    const save = vi.fn((_patch: Patch) => first.promise);
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ title: "A" });
    const flushing = autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    autosave.queue({ title: "AB" });
    expect(autosave.currentState).toBe("pending");
    save.mockImplementation(async () => {});
    first.resolve();
    await flushing;
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ title: "AB" });
  });

  it("keeps a failed patch and retries it on the next flush", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("offline"));
    const states: AutosaveState[] = [];
    const autosave = new Autosave<Patch>({ save, onState: (state) => states.push(state) });
    autosave.queue({ title: "Lost?" });
    await autosave.flush();
    expect(states.at(-1)).toBe("error");
    expect(autosave.hasPending()).toBe(true);
    autosave.queue({ price: 10 });
    await autosave.flush();
    expect(save).toHaveBeenLastCalledWith({ title: "Lost?", price: 10 });
    expect(autosave.currentState).toBe("saved");
  });

  it("does nothing after dispose", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ title: "x" });
    autosave.dispose();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
    expect(save).not.toHaveBeenCalled();
    autosave.queue({ title: "y" });
    expect(autosave.hasPending()).toBe(true);
  });

  it("resolves the flush with whether everything was saved", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("offline"));
    const autosave = new Autosave<Patch>({ save, retryAfter: () => null });
    expect(await autosave.flush()).toBe(true);
    autosave.queue({ title: "a" });
    expect(await autosave.flush()).toBe(false);
    expect(await autosave.flush({ force: true })).toBe(true);
  });

  it("retries a transient failure by itself after the backoff delay", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("offline"));
    const autosave = new Autosave<Patch>({ save, retryAfter: (_error, attempt) => attempt * 15_000 });
    autosave.queue({ title: "a" });
    await autosave.flush();
    expect(autosave.currentState).toBe("error");
    await vi.advanceTimersByTimeAsync(14_999);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(autosave.currentState).toBe("saved");
  });

  it("halts on a refusal until a forced flush, without losing what is typed meanwhile", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("refused"));
    const autosave = new Autosave<Patch>({ save, retryAfter: () => null });
    autosave.queue({ title: "a" });
    await autosave.flush();
    autosave.queue({ price: 5 });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 10);
    await autosave.flush();
    expect(save).toHaveBeenCalledTimes(1);
    expect(await autosave.flush({ force: true })).toBe(true);
    expect(save).toHaveBeenLastCalledWith({ title: "a", price: 5 });
  });

  it("keeps only what recover returns after a failure", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("invalid title"));
    const autosave = new Autosave<Patch>({
      save,
      recover: (patch) => {
        const { title: _title, ...rest } = patch;
        return Object.keys(rest).length > 0 ? rest : null;
      },
      retryAfter: () => 0,
    });
    autosave.queue({ title: "<bad>", price: 10 });
    const flushing = autosave.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(await flushing).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ price: 10 });
  });

  it("retries a quick race inside the same save, without an error state", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    save.mockRejectedValueOnce(new Error("conflict"));
    const states: AutosaveState[] = [];
    const autosave = new Autosave<Patch>({ save, onState: (state) => states.push(state), retryAfter: (_error, attempt) => (attempt <= 1 ? 400 : null) });
    autosave.queue({ photos: ["a"] });
    const flushing = autosave.flush({ force: true });
    autosave.queue({ title: "typed meanwhile" });
    await vi.advanceTimersByTimeAsync(400);
    expect(await flushing).toBe(true);
    expect(save).toHaveBeenLastCalledWith({ photos: ["a"], title: "typed meanwhile" });
    expect(states).not.toContain("error");
    expect(states.at(-1)).toBe("saved");
  });

  it("in manual mode saves only on a forced flush", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save, manual: true });
    autosave.queue({ title: "live" });
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
    expect(await autosave.flush()).toBe(false);
    expect(save).not.toHaveBeenCalled();
    expect(autosave.currentState).toBe("pending");
    expect(await autosave.flush({ force: true })).toBe(true);
    expect(save).toHaveBeenCalledWith({ title: "live" });
  });

  it("switching back to automatic saves what is pending after the idle delay", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save, manual: true });
    autosave.queue({ title: "x" });
    autosave.setManual(false);
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("a forced flush during a save sends the newer changes right after it", async () => {
    const first = deferred<void>();
    const save = vi.fn((_patch: Patch) => first.promise);
    const autosave = new Autosave<Patch>({ save, manual: true });
    autosave.queue({ title: "A" });
    const one = autosave.flush({ force: true });
    autosave.queue({ title: "AB" });
    save.mockImplementation(async () => {});
    const two = autosave.flush({ force: true });
    first.resolve();
    expect(await one).toBe(true);
    expect(await two).toBe(true);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith({ title: "AB" });
  });

  it("revives after a StrictMode remount and re-arms the timer", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ title: "x" });
    autosave.dispose();
    autosave.revive();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it("hands what is pending over without sending it (page hide)", async () => {
    const save = vi.fn(async (_patch: Patch) => {});
    const autosave = new Autosave<Patch>({ save });
    autosave.queue({ title: "x" });
    expect(autosave.takePending()).toEqual({ title: "x" });
    expect(autosave.takePending()).toBeNull();
    await vi.advanceTimersByTimeAsync(AUTOSAVE_IDLE_MS * 2);
    expect(save).not.toHaveBeenCalled();
  });
});
