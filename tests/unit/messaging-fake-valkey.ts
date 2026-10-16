import { REBUILD_SCRIPT, type MessagingValkey } from "@/lib/messaging/unread";

// In-memory stand-in for valkey-queue in the messaging tests (unit and API): strings, hashes and
// sorted sets with expiry, MULTI/EXEC, and the unread rebuild script's semantics. The commands
// and the Lua script were checked against a real server with the same assertions.

type Command = [name: string, args: unknown[]];

export class FakeValkey {
  readonly strings = new Map<string, string>();
  readonly hashes = new Map<string, Map<string, string>>();
  readonly zsets = new Map<string, Map<string, number>>();
  readonly expiry = new Map<string, number>();
  /** Every command throws while true (Valkey down). */
  failing = false;
  /** Commands run, in order (names only). */
  readonly calls: string[] = [];

  constructor(private readonly clock: () => number = () => Date.now()) {}

  asClient(): MessagingValkey {
    return this as unknown as MessagingValkey;
  }

  private check(name: string): void {
    if (this.failing) throw new Error("connection refused");
    this.calls.push(name);
  }

  private sweep(key: string): void {
    const at = this.expiry.get(key);
    if (at !== undefined && at <= this.clock()) this.drop(key);
  }

  private drop(key: string): boolean {
    const existed = this.strings.delete(key) || this.hashes.delete(key) || this.zsets.delete(key);
    this.expiry.delete(key);
    return existed;
  }

  private has(key: string): boolean {
    this.sweep(key);
    return this.strings.has(key) || this.hashes.has(key) || this.zsets.has(key);
  }

  ttlMs(key: string): number {
    this.sweep(key);
    if (!this.has(key)) return -2;
    const at = this.expiry.get(key);
    return at === undefined ? -1 : at - this.clock();
  }

  async get(key: string): Promise<string | null> {
    this.check("get");
    this.sweep(key);
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, ...options: (string | number)[]): Promise<"OK" | null> {
    this.check("set");
    this.sweep(key);
    const upper = options.map((option) => (typeof option === "string" ? option.toUpperCase() : option));
    if (upper.includes("NX") && this.has(key)) return null;
    this.drop(key);
    this.strings.set(key, String(value));
    const ex = upper.indexOf("EX");
    const px = upper.indexOf("PX");
    if (ex !== -1) this.expiry.set(key, this.clock() + Number(upper[ex + 1]) * 1000);
    if (px !== -1) this.expiry.set(key, this.clock() + Number(upper[px + 1]));
    return "OK";
  }

  async del(...keys: string[]): Promise<number> {
    this.check("del");
    return keys.filter((key) => this.has(key) && this.drop(key)).length;
  }

  async exists(key: string): Promise<number> {
    this.check("exists");
    return this.has(key) ? 1 : 0;
  }

  async incr(key: string): Promise<number> {
    this.check("incr");
    this.sweep(key);
    const next = Number(this.strings.get(key) ?? "0") + 1;
    this.strings.set(key, String(next));
    return next;
  }

  async pexpire(key: string, ms: number | string): Promise<number> {
    this.check("pexpire");
    if (!this.has(key)) return 0;
    this.expiry.set(key, this.clock() + Number(ms));
    return 1;
  }

  async hincrby(key: string, field: string, delta: number): Promise<number> {
    this.check("hincrby");
    this.sweep(key);
    const hash = this.hashes.get(key) ?? new Map<string, string>();
    const next = Number(hash.get(field) ?? "0") + Number(delta);
    hash.set(field, String(next));
    this.hashes.set(key, hash);
    return next;
  }

  async hvals(key: string): Promise<string[]> {
    this.check("hvals");
    this.sweep(key);
    return [...(this.hashes.get(key)?.values() ?? [])];
  }

  async hgetall(key: string): Promise<Record<string, string>> {
    this.check("hgetall");
    this.sweep(key);
    return Object.fromEntries(this.hashes.get(key) ?? []);
  }

  async hdel(key: string, ...fields: string[]): Promise<number> {
    this.check("hdel");
    this.sweep(key);
    const hash = this.hashes.get(key);
    if (!hash) return 0;
    const removed = fields.filter((field) => hash.delete(field)).length;
    if (hash.size === 0) this.drop(key);
    return removed;
  }

  async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    this.check("zadd");
    this.sweep(key);
    const nx = args[0] === "NX";
    const pairs = nx ? args.slice(1) : args;
    const zset = this.zsets.get(key) ?? new Map<string, number>();
    let added = 0;
    for (let index = 0; index < pairs.length; index += 2) {
      const member = String(pairs[index + 1]);
      if (zset.has(member) && nx) continue;
      if (!zset.has(member)) added += 1;
      zset.set(member, Number(pairs[index]));
    }
    this.zsets.set(key, zset);
    return added;
  }

  async zscore(key: string, member: string): Promise<string | null> {
    this.check("zscore");
    this.sweep(key);
    const score = this.zsets.get(key)?.get(member);
    return score === undefined ? null : String(score);
  }

  async zremrangebyscore(key: string, min: string | number, max: string | number): Promise<number> {
    this.check("zremrangebyscore");
    this.sweep(key);
    const zset = this.zsets.get(key);
    if (!zset) return 0;
    const low = min === "-inf" ? -Infinity : Number(min);
    const high = max === "+inf" ? Infinity : Number(max);
    let removed = 0;
    for (const [member, score] of zset) {
      if (score >= low && score <= high) {
        zset.delete(member);
        removed += 1;
      }
    }
    if (zset.size === 0) this.drop(key);
    return removed;
  }

  async zrange(key: string, start: number | string, stop: number | string): Promise<string[]> {
    this.check("zrange");
    this.sweep(key);
    const members = [...(this.zsets.get(key) ?? [])].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).map(([member]) => member);
    const end = Number(stop) < 0 ? members.length + Number(stop) + 1 : Number(stop) + 1;
    return members.slice(Number(start), end);
  }

  async eval(script: string, keyCount: number, ...rest: (string | number)[]): Promise<number> {
    this.check("eval");
    if (script !== REBUILD_SCRIPT || keyCount !== 3) throw new Error("unknown script");
    const [hashKey, initKey, versionKey, expected, ttl, ...pairs] = rest.map(String) as string[];
    this.sweep(versionKey!);
    if ((this.strings.get(versionKey!) ?? "0") !== expected) return 0;
    this.drop(hashKey!);
    if (pairs.length > 0) {
      const hash = new Map<string, string>();
      for (let index = 0; index < pairs.length; index += 2) hash.set(pairs[index]!, pairs[index + 1]!);
      this.hashes.set(hashKey!, hash);
      this.expiry.set(hashKey!, this.clock() + Number(ttl));
    }
    this.drop(initKey!);
    this.strings.set(initKey!, "1");
    this.expiry.set(initKey!, this.clock() + Number(ttl));
    return 1;
  }

  multi(): unknown {
    const queue: Command[] = [];
    const chain: Record<string, unknown> = new Proxy(
      {},
      {
        get: (_target, name: string) => {
          if (name === "exec") {
            return async () => {
              if (this.failing) throw new Error("connection refused");
              const out: [Error | null, unknown][] = [];
              for (const [command, args] of queue) {
                const method = (this as unknown as Record<string, (...values: unknown[]) => Promise<unknown>>)[command];
                if (!method) throw new Error(`fake valkey: ${command} not implemented`);
                out.push([null, await method.apply(this, args)]);
              }
              return out;
            };
          }
          return (...args: unknown[]) => {
            queue.push([name, args]);
            return chain;
          };
        },
      },
    );
    return chain;
  }
}
