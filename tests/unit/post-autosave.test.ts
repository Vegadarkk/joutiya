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
});
