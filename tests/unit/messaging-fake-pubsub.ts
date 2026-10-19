import type { MessagingEvent } from "@/lib/contracts/messaging";
import type { SubscriberConnection } from "@/lib/messaging/bus";
import { eventChannel, type Delivery, type EventPublisher } from "@/lib/messaging/events";

// In-memory stand-in for valkey-queue pub/sub in the messaging tests (unit and API): the
// subscriber connection the bus listens on, and the publisher the write paths call. A publish
// reaches the bus only on a channel it subscribed, like the real server.

type Listener = (...args: string[]) => void;

export class FakePubSub implements SubscriberConnection {
  status = "ready";
  /** Channels subscribed now. */
  readonly channels = new Set<string>();
  /** SUBSCRIBE / UNSUBSCRIBE in the order the bus sent them. */
  readonly commands: string[] = [];
  /** Every delivery published, subscribed or not. */
  readonly published: Delivery[] = [];
  /** subscribe/unsubscribe and publish throw while true (Valkey down). */
  failing = false;
  private readonly listeners = new Map<string, Listener[]>();

  on(event: "message" | "ready" | "close", listener: Listener): this {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), listener]);
    return this;
  }

  emit(event: "ready" | "close"): void {
    for (const listener of this.listeners.get(event) ?? []) listener();
  }

  async subscribe(channel: string): Promise<number> {
    if (this.failing) throw new Error("connection refused");
    this.commands.push(`subscribe ${channel}`);
    this.channels.add(channel);
    return this.channels.size;
  }

  async unsubscribe(channel: string): Promise<number> {
    if (this.failing) throw new Error("connection refused");
    this.commands.push(`unsubscribe ${channel}`);
    this.channels.delete(channel);
    return this.channels.size;
  }

  /** Raw message on a channel (malformed payloads included). */
  push(channel: string, message: string): void {
    if (!this.channels.has(channel)) return;
    for (const listener of this.listeners.get("message") ?? []) listener(channel, message);
  }

  readonly publish: EventPublisher = async (deliveries) => {
    if (this.failing) throw new Error("connection refused");
    for (const delivery of deliveries) {
      this.published.push(delivery);
      this.push(eventChannel(delivery.uid), JSON.stringify(delivery.event));
    }
  };

  /** Events published to `uid`, in order. */
  eventsFor(uid: string): MessagingEvent[] {
    return this.published.filter((delivery) => delivery.uid === uid).map((delivery) => delivery.event);
  }
}
