import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as NextNavigation from "next/navigation";
import { AppealQueue } from "@/app/admin/_components/appeal-queue";
import { reasonSummary, ReportQueue, targetName } from "@/app/admin/_components/report-queue";
import { startClock } from "@/app/admin/_components/sla-timer";
import { formatSpan, orderByUrgency, slaState } from "@/app/admin/_lib/moderation-format";
import type { AppealQueueItem } from "@/lib/decisions/contracts";
import type { ReportQueueGroup, ReportQueueItem } from "@/lib/reports/admin";

// Back-office report queue (lot U3, design D12, D24): past due first, then priority and due
// date; the SLA timers follow the clock (fake timers) and reorder the queue without a reload.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const T0 = new Date("2026-10-19T10:00:00.000Z");
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function item(id: string, patch: Partial<ReportQueueItem> = {}): ReportQueueItem {
  return {
    id,
    targetKey: "listing:abcd2345",
    target: { type: "listing", id: "abcd2345", publicId: null, listingId: null },
    reasonId: "scam",
    priority: "P1",
    status: "open",
    source: "user",
    excerpt: "Le vendeur demande une avance.",
    reporter: { kind: "account", trusted: false },
    strongSignal: null,
    hidden: false,
    slaDueAt: at(20 * HOUR),
    createdAt: at(-4 * HOUR),
    closedAt: null,
    overdue: false,
    assignee: null,
    aiDecisionId: null,
    ...patch,
  };
}

const group = (key: string, priority: ReportQueueGroup["priority"], dueIn: number, reportIds: string[]): ReportQueueGroup => ({ targetKey: key, priority, slaDueAt: at(dueIn), reportIds });

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** Target keys in the rendered order. */
const order = (html: string) => [...html.matchAll(/data-target="([^"]+)"/g)].map((match) => match[1]);

describe("SLA arithmetic", () => {
  it("formats spans rounded down", () => {
    expect(formatSpan(30_000)).toBe("moins d'1 min");
    expect(formatSpan(42 * MINUTE + 59_000)).toBe("42 min");
    expect(formatSpan(3 * HOUR + 5 * MINUTE)).toBe("3 h 05");
    expect(formatSpan(5 * HOUR)).toBe("5 h");
    expect(formatSpan(52 * HOUR)).toBe("2 j 4 h");
    expect(formatSpan(-(70 * MINUTE))).toBe("1 h 10");
  });

  it("turns amber in the last quarter of the delay and red once past due", () => {
    expect(slaState(at(20 * HOUR), T0, 24 * HOUR)).toMatchObject({ overdue: false, tone: "neutral", label: "Reste 20 h" });
    expect(slaState(at(5 * HOUR), T0, 24 * HOUR)).toMatchObject({ overdue: false, tone: "warning", label: "Reste 5 h" });
    expect(slaState(at(-12 * MINUTE), T0, HOUR)).toMatchObject({ overdue: true, tone: "danger", label: "En retard de 12 min" });
  });

  it("orders past due first, then by priority, then by due date", () => {
    const groups = [group("a", "P0", 30 * MINUTE, []), group("b", "P3", -2 * HOUR, []), group("c", "P1", 2 * HOUR, []), group("d", "P1", -MINUTE, []), group("e", "P0", 10 * MINUTE, [])];
    expect(orderByUrgency(groups, T0).map((entry) => entry.targetKey)).toEqual(["d", "b", "e", "a", "c"]);
  });
});

describe("report queue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const items = [
    item("r1", { targetKey: "listing:abcd2345", priority: "P0", reasonId: "terrorism", slaDueAt: at(40 * MINUTE), strongSignal: "trusted", hidden: true }),
    item("r2", { targetKey: "listing:wxyz2345", target: { type: "listing", id: "wxyz2345", publicId: null, listingId: null }, priority: "P1", slaDueAt: at(30 * MINUTE) }),
    item("r3", { targetKey: "listing:wxyz2345", target: { type: "listing", id: "wxyz2345", publicId: null, listingId: null }, priority: "P2", reasonId: "misleading", slaDueAt: at(60 * HOUR) }),
    item("r4", { targetKey: "user:u1", target: { type: "user", id: "u1", publicId: "k7m2p9q4rs", listingId: null }, priority: "P3", reasonId: "spam", slaDueAt: at(6 * 24 * HOUR), source: "system", reporter: { kind: "system", trusted: false } }),
  ];
  const groups = [group("listing:abcd2345", "P0", 40 * MINUTE, ["r1"]), group("listing:wxyz2345", "P1", 30 * MINUTE, ["r2", "r3"]), group("user:u1", "P3", 6 * 24 * HOUR, ["r4"])];

  it("names targets and sums up a group's reasons", () => {
    expect(targetName(items[3]!)).toBe("Compte k7m2p9q4rs");
    expect(targetName(item("m", { target: { type: "message", id: "c/m", publicId: null, listingId: "abcd2345" } }))).toBe("Message, conversation de l'annonce abcd2345");
    expect(reasonSummary([item("a"), item("b", { reasonId: "counterfeit" }), item("c")])).toBe("Arnaque ou tentative d'escroquerie (2), Contrefaçon");
  });

  it("renders groups by urgency with their timers and signals", () => {
    const html = renderToStaticMarkup(<ReportQueue items={items} groups={groups} renderedAt={T0.toISOString()} />);
    expect(order(html)).toEqual(["listing:abcd2345", "listing:wxyz2345", "user:u1"]);
    const content = text(html);
    expect(content).toContain("Reste 40 min");
    expect(content).toContain("Reste 30 min");
    expect(content).toContain("2 signalements");
    expect(content).toContain("Signal fort : signalant fiable");
    expect(content).toContain("Masqué en attente");
    expect(content).toContain("Système");
    expect(html).toContain('href="/signalements/cible?cle=listing%3Aabcd2345"');
  });

  it("follows the clock: a group past due moves ahead of a P0 still on time", () => {
    const ticks: Date[] = [];
    const stop = startClock((now) => ticks.push(now), 15_000);
    vi.advanceTimersByTime(35 * MINUTE);
    stop();
    expect(ticks).toHaveLength((35 * 60) / 15);
    const now = ticks.at(-1)!;
    expect(now.toISOString()).toBe(at(35 * MINUTE));
    vi.advanceTimersByTime(HOUR);
    expect(ticks).toHaveLength((35 * 60) / 15);

    const html = renderToStaticMarkup(<ReportQueue items={items} groups={groups} renderedAt={now.toISOString()} />);
    expect(order(html)).toEqual(["listing:wxyz2345", "listing:abcd2345", "user:u1"]);
    const content = text(html);
    expect(content).toContain("En retard de 5 min");
    expect(content).toContain("Reste 5 min");
  });
});

describe("appeal queue", () => {
  it("lists appeals past due first and tells a moderator which ones are his", () => {
    const appeal = (id: string, dueIn: number, reviewable: boolean): AppealQueueItem => ({
      decisionId: id,
      target: { type: "listing", id: "abcd2345" },
      action: "remove",
      templateId: "listing.remove.scam",
      by: "affected",
      text: "Mon annonce était honnête.",
      openedAt: at(dueIn - 14 * 24 * HOUR),
      slaDueAt: at(dueIn),
      overdue: dueIn < 0,
      decidedBy: "mod-1",
      reviewable,
      aiDecisionId: null,
    });
    const html = renderToStaticMarkup(<AppealQueue items={[appeal("D1aaaaaaaaaaaaaaaaaa", 3 * 24 * HOUR, true), appeal("D2aaaaaaaaaaaaaaaaaa", -HOUR, false)]} renderedAt={T0.toISOString()} />);
    expect(html.indexOf("D2aaaaaaaaaaaaaaaaaa")).toBeLessThan(html.indexOf("D1aaaaaaaaaaaaaaaaaa"));
    const content = text(html);
    expect(content).toContain("En retard de 1 h");
    expect(content).toContain("Reste 3 j");
    expect(content).toContain("Votre décision : un autre modérateur la réexamine");
    expect(content).toContain("Retrait : arnaque ou tentative d'escroquerie");
  });
});
