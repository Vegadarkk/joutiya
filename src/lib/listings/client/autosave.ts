// Draft autosave with coalescing (design D2): writes happen on step change, on blur and after
// 5 s without typing, never per keystroke. Patches queued while a save is in flight are merged
// and sent once it completes; a failed save keeps its patch so the next trigger retries it.
// Pure TypeScript (timers injected via globalThis), unit-tested with fake timers.

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutosaveOptions<P extends object> {
  /** Sends one merged patch to the server. */
  save: (patch: P) => Promise<void>;
  /** Combines two queued patches (default: shallow merge, the later value wins per key). */
  merge?: (older: P, newer: P) => P;
  /** Idle delay before an automatic save. */
  idleMs?: number;
  onState?: (state: AutosaveState, error?: unknown) => void;
}

export const AUTOSAVE_IDLE_MS = 5_000;

export class Autosave<P extends object> {
  private pending: P | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushAfter = false;
  private disposed = false;
  private state: AutosaveState = "idle";
  private readonly idleMs: number;
  private readonly save: (patch: P) => Promise<void>;
  private readonly merge: (older: P, newer: P) => P;
  private readonly onState: ((state: AutosaveState, error?: unknown) => void) | undefined;

  constructor(options: AutosaveOptions<P>) {
    this.save = options.save;
    this.merge = options.merge ?? ((older, newer) => ({ ...older, ...newer }));
    this.idleMs = options.idleMs ?? AUTOSAVE_IDLE_MS;
    this.onState = options.onState;
  }

  get currentState(): AutosaveState {
    return this.state;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Records a change; the save happens later (idle timer) or at the next flush. */
  queue(patch: P): void {
    if (this.disposed) return;
    this.pending = this.pending ? this.merge(this.pending, patch) : patch;
    this.setState("pending");
    this.armTimer();
  }

  /** Saves what is pending now (step change, blur, page hide); resolves when nothing is left to send. */
  flush(): Promise<void> {
    this.clearTimer();
    if (this.inflight) {
      // The current request may miss the latest patch: run again right after it.
      if (this.pending) this.flushAfter = true;
      return this.inflight.then(() => (this.flushAfter || this.pending ? this.flush() : undefined));
    }
    if (!this.pending) return Promise.resolve();
    const patch = this.pending;
    this.pending = null;
    this.flushAfter = false;
    this.setState("saving");
    this.inflight = this.save(patch).then(
      () => {
        this.inflight = null;
        if (!this.pending) this.setState("saved");
      },
      (error: unknown) => {
        this.inflight = null;
        // The failed patch goes back under whatever was typed since: nothing is lost.
        this.pending = this.pending ? this.merge(patch, this.pending) : patch;
        this.setState("error", error);
        // A retry happens on the next trigger (queue/flush), not in a tight loop; one slow retry
        // is scheduled so a transient outage heals without user action.
        this.armTimer(this.idleMs * 3);
      },
    );
    return this.inflight.then(() => (this.flushAfter && this.pending ? this.flush() : undefined));
  }

  /** Stops the timers; pending changes are not sent (the caller flushes first when it wants them saved). */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  private armTimer(delay = this.idleMs): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private setState(state: AutosaveState, error?: unknown): void {
    this.state = state;
    this.onState?.(state, error);
  }
}
