import { MESSAGING_KEYS } from "@/lib/messaging/unread";
import { FakeValkey } from "./messaging-fake-valkey";

// The messaging tests' in-memory valkey-queue plus the commands of the message-digest job
// (ZRANGEBYSCORE ... WITHSCORES LIMIT, ZREM, PTTL, ZADD XX), for its unit and API tests.

export class DigestValkeyFake extends FakeValkey {
  async zrangebyscore(key: string, min: string | number, max: string | number, _withscores: "WITHSCORES", _limit: "LIMIT", offset: number, count: number): Promise<string[]> {
    if (this.failing) throw new Error("connection refused");
    const low = min === "-inf" ? -Infinity : Number(min);
    const high = max === "+inf" ? Infinity : Number(max);
    return [...(this.zsets.get(key) ?? [])]
      .filter(([, score]) => score >= low && score <= high)
      .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
      .slice(offset, offset + count)
      .flatMap(([member, score]) => [member, String(score)]);
  }

  async zrem(key: string, member: string): Promise<number> {
    if (this.failing) throw new Error("connection refused");
    return this.zsets.get(key)?.delete(member) ? 1 : 0;
  }

  async pttl(key: string): Promise<number> {
    if (this.failing) throw new Error("connection refused");
    return this.ttlMs(key);
  }

  override async zadd(key: string, ...args: (string | number)[]): Promise<number> {
    if (args[0] !== "XX") return super.zadd(key, ...args);
    if (this.failing) throw new Error("connection refused");
    const zset = this.zsets.get(key);
    const member = String(args[2]);
    if (zset?.has(member)) zset.set(member, Number(args[1]));
    return 0;
  }

  /** Due time of `member` in the digest queue, undefined when not queued. */
  score(member: string): number | undefined {
    return this.zsets.get(MESSAGING_KEYS.digest)?.get(member);
  }
}
