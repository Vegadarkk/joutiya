// Draft autosave with coalescing (design D2): writes happen on step change, on blur and after
// 5 s without typing, never per keystroke. Patches queued while a save is in flight are merged
// and sent once it completes; a failed save keeps its patch (or what `recover` keeps of it).
// Retries follow `retryAfter`: a delay up to QUICK_RETRY_MS (version race, dropped field) is
// retried inside the same save, longer ones back off, refusals wait for a manual retry.
// "Manual" mode (a live listing: every write re-screens it) never saves on its own: only
// `flush({ force: true })` sends. Pure TypeScript, unit-tested with fake timers.

export type AutosaveState = "idle" | "pending" | "saving" | "saved" | "error";

export interface AutosaveOptions<P extends object> {
  /** Sends one merged patch to the server. */
  save: (patch: P) => Promise<void>;
  /** Combines two queued patches (default: shallow merge, the later value wins per key). */
  merge?: (older: P, newer: P) => P;
  /** Idle delay before an automatic save. */
  idleMs?: number;
  onState?: (state: AutosaveState, error?: unknown) => void;
  /** After a failure: the patch to keep for the next attempt (default: all of it); null drops it. */
  recover?: (patch: P, error: unknown) => P | null;
  /**
   * After a failure: delay in ms before an automatic retry, or null to stop automatic saves until
   * a forced flush (a refusal that resending cannot fix). Default: 15 s doubling, at most 2 min.
   */
  retryAfter?: (error: unknown, attempt: number) => number | null;
  /** Starts in manual mode (no idle timer, unforced flushes do nothing). */
  manual?: boolean;
}

export const AUTOSAVE_IDLE_MS = 5_000;
const MAX_RETRY_MS = 120_000;
/** Retries this close are part of the save: no error state, the caller's flush waits for them. */
export const QUICK_RETRY_MS = 1_000;

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class Autosave<P extends object> {
  private pending: P | null = null;
  private inflight: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private flushAfter = false;
  private disposed = false;
  private halted = false;
  private manual: boolean;
  private failures = 0;
  private lastError: unknown = undefined;
  private state: AutosaveState = "idle";
  private readonly idleMs: number;
  private readonly save: (patch: P) => Promise<void>;
  private readonly merge: (older: P, newer: P) => P;
  private readonly onState: ((state: AutosaveState, error?: unknown) => void) | undefined;
  private readonly recover: (patch: P, error: unknown) => P | null;
  private readonly retryAfter: (error: unknown, attempt: number) => number | null;

  constructor(options: AutosaveOptions<P>) {
    this.save = options.save;
    this.merge = options.merge ?? ((older, newer) => ({ ...older, ...newer }));
    this.idleMs = options.idleMs ?? AUTOSAVE_IDLE_MS;
    this.onState = options.onState;
    this.recover = options.recover ?? ((patch) => patch);
    this.retryAfter = options.retryAfter ?? ((_error, attempt) => Math.min(MAX_RETRY_MS, this.idleMs * 3 * 2 ** (attempt - 1)));
    this.manual = options.manual ?? false;
  }

  get currentState(): AutosaveState {
    return this.state;
  }

  get isManual(): boolean {
    return this.manual;
  }

  hasPending(): boolean {
    return this.pending !== null;
  }

  /** Manual mode keeps changes until a forced flush; back to automatic, pending changes save after the idle delay. */
  setManual(manual: boolean): void {
    if (this.manual === manual) return;
    this.manual = manual;
    if (manual) this.clearTimer();
    else if (this.pending && !this.halted) this.armTimer();
  }

  /** Records a change; the save happens later (idle timer) or at the next flush. */
  queue(patch: P): void {
    if (this.disposed) return;
    this.pending = this.pending ? this.merge(this.pending, patch) : patch;
    // Halted automatic saves keep showing why (and the retry); a live listing shows its Save button.
    if (this.halted && !this.manual) this.setState("error", this.lastError);
    else this.setState("pending");
    if (!this.manual && !this.halted) this.armTimer();
  }

  /**
   * Saves what is pending now (step change, blur, page hide; `force` for an explicit save or retry).
   * Resolves true when nothing is left to send, false when changes are still unsaved.
   */
  flush(options: { force?: boolean } = {}): Promise<boolean> {
    if (options.force) this.halted = false;
    else if (this.manual || this.halted) return Promise.resolve(this.pending === null && this.inflight === null);
    this.clearTimer();
    if (this.inflight) {
      // The current request may miss the latest patch: run again right after it.
      if (this.pending) this.flushAfter = true;
      return this.inflight.then(() => (this.pending && (this.flushAfter || options.force) && !this.halted ? this.flush(options) : this.pending === null));
    }
    if (!this.pending) return Promise.resolve(true);
    const patch = this.pending;
    this.pending = null;
    this.flushAfter = false;
    this.setState("saving");
    this.inflight = this.send(patch).finally(() => {
      this.inflight = null;
    });
    return this.inflight.then(() => {
      const failed = this.state === "error";
      if (this.pending && !failed && !this.halted && (this.flushAfter || options.force)) return this.flush(options);
      return this.pending === null && !failed;
    });
  }

  /** One save, with its quick retries; a failure leaves the state "error" and schedules what comes next. */
  private async send(patch: P): Promise<void> {
    let current = patch;
    for (;;) {
      try {
        await this.save(current);
        this.failures = 0;
        this.lastError = undefined;
        this.setState(this.pending ? "pending" : "saved");
        return;
      } catch (error) {
        this.failures += 1;
        this.lastError = error;
        // The failed patch goes back under whatever was typed since: nothing is lost.
        const kept = this.recover(current, error);
        if (kept) this.pending = this.pending ? this.merge(kept, this.pending) : kept;
        const delay = this.retryAfter(error, this.failures);
        if (delay !== null && delay <= QUICK_RETRY_MS && this.pending) {
          await wait(delay);
          if (!this.pending) return;
          current = this.pending;
          this.pending = null;
          continue;
        }
        this.setState("error", error);
        if (delay === null) this.halted = true;
        else if (this.pending && !this.disposed && !this.manual) this.armTimer(delay);
        return;
      }
    }
  }

  /** Stops the timers; pending changes are not sent (the caller flushes first when it wants them saved). */
  dispose(): void {
    this.disposed = true;
    this.clearTimer();
  }

  /** Undoes `dispose` (a component remounted, as React's StrictMode does in development). */
  revive(): void {
    this.disposed = false;
    if (this.pending && !this.manual && !this.halted) this.armTimer();
  }

  /** What is waiting to be sent, without sending it (page hide: handed to a keepalive request). */
  takePending(): P | null {
    const patch = this.pending;
    this.pending = null;
    this.clearTimer();
    return patch;
  }

  private armTimer(delay = this.idleMs): void {
    if (this.disposed) return;
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
