import { describe, expect, it, vi } from "vitest";
import { decisionTemplate, type DecisionTemplate } from "@/config/decision-templates";
import { canBan, levelAfter, levelAfterReversal, nextStep, sanctionOf, suspensionUntil } from "@/lib/decisions/ladder";
import { appealRefusal, appealableView, decisionView } from "@/lib/decisions/views";
import type { DecisionRecord } from "@/lib/decisions/repository";

vi.mock("@/lib/logging/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() } }));

const { planAccount } = await import("@/lib/decisions/decide");

// D14 sanctions ladder (warn -> 7 d -> 30 d -> ban), who may ban, and D16 appeal eligibility.

const template = (id: string): DecisionTemplate => {
  const found = decisionTemplate(id);
  if (!found) throw new Error(id);
  return found;
};
const NOW = new Date("2026-10-16T10:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;

describe("ladder", () => {
  it("proposes the next step from the strike level", () => {
    expect(nextStep(0)).toEqual({ action: "warn", durationDays: null });
    expect(nextStep(1)).toEqual({ action: "suspend_account", durationDays: 7 });
    expect(nextStep(2)).toEqual({ action: "suspend_account", durationDays: 30 });
    expect(nextStep(3)).toEqual({ action: "ban", durationDays: null });
    expect(nextStep(7)).toEqual({ action: "ban", durationDays: null });
  });

  it("raises the level to the sanction's step, never lowers it, and a reversal takes one off", () => {
    expect(levelAfter(0, { action: "warn" })).toBe(1);
    expect(levelAfter(0, { action: "suspend_account", durationDays: 7 })).toBe(2);
    expect(levelAfter(1, { action: "suspend_account", durationDays: 30 })).toBe(3);
    expect(levelAfter(2, { action: "warn" })).toBe(2);
    expect(levelAfter(0, { action: "ban" })).toBe(3);
    expect(levelAfterReversal(3)).toBe(2);
    expect(levelAfterReversal(0)).toBe(0);
  });

  it("ends a suspension after its length, keeping a longer one running", () => {
    expect(suspensionUntil(NOW, 7)).toEqual(new Date(NOW.getTime() + 7 * DAY));
    const later = new Date(NOW.getTime() + 20 * DAY);
    expect(suspensionUntil(NOW, 7, later)).toBe(later);
    expect(suspensionUntil(NOW, 30, later)).toEqual(new Date(NOW.getTime() + 30 * DAY));
  });

  it("lets a moderator ban only to confirm an open P0 report with a P0 template; an admin always", () => {
    expect(canBan({ role: "admin", template: template("user.ban"), priorities: [] })).toBe(true);
    expect(canBan({ role: "moderator", template: template("user.ban"), priorities: ["P0"] })).toBe(false);
    expect(canBan({ role: "moderator", template: template("user.ban.p0"), priorities: ["P1"] })).toBe(false);
    expect(canBan({ role: "moderator", template: template("user.ban.p0"), priorities: ["P2", "P0"] })).toBe(true);
    expect(canBan({ role: "moderator", template: template("listing.remove.p0"), priorities: ["P0"] })).toBe(true);
  });

  it("derives the sanction: the account template's own, a ban for P0 content, else the moderator's choice", () => {
    expect(sanctionOf(template("user.warn"), undefined)).toEqual({ action: "warn" });
    expect(sanctionOf(template("user.suspend.30"), undefined)).toEqual({ action: "suspend_account", durationDays: 30 });
    expect(sanctionOf(template("listing.remove.p0"), { action: "warn" })).toEqual({ action: "ban" });
    expect(sanctionOf(template("listing.remove.scam"), undefined)).toBeNull();
    expect(sanctionOf(template("listing.remove.scam"), { action: "suspend_account", durationDays: 7 })).toEqual({ action: "suspend_account", durationDays: 7 });
    expect(sanctionOf(template("listing.restore"), { action: "warn" })).toBeNull();
  });
});

describe("planAccount", () => {
  const owner = { uid: "owner-1", status: "active" } as never;
  const base = { actor: { uid: "mod-1", role: "moderator" as const }, owner, superseded: null, suspension: null, priorities: [] };

  it("plans a separate sanction decision with a content decision, none without a chosen sanction", () => {
    expect(planAccount({ ...base, template: template("listing.remove.scam"), target: { type: "listing", id: "abcdefgh" }, chosen: undefined })).toBeNull();
    expect(planAccount({ ...base, template: template("listing.remove.scam"), target: { type: "listing", id: "abcdefgh" }, chosen: { action: "suspend_account", durationDays: 30 } })).toEqual({
      kind: "sanction",
      sanction: { action: "suspend_account", durationDays: 30 },
      separate: true,
      templateId: "user.suspend.30",
      p0: false,
    });
    expect(planAccount({ ...base, template: template("user.suspend.7"), target: { type: "user", id: "owner-1" }, chosen: undefined })).toMatchObject({ separate: false, templateId: "user.suspend.7" });
  });

  it("refuses a moderator's ban outside a P0 report and any automated sanction", () => {
    const listing = { type: "listing" as const, id: "abcdefgh" };
    expect(() => planAccount({ ...base, template: template("listing.remove.scam"), target: listing, chosen: { action: "ban" } })).toThrow(expect.objectContaining({ status: 403, code: "sanction_not_allowed" }));
    expect(() => planAccount({ ...base, template: template("listing.remove.p0"), target: listing, chosen: undefined })).toThrow(expect.objectContaining({ code: "sanction_not_allowed" }));
    expect(planAccount({ ...base, template: template("listing.remove.p0"), target: listing, chosen: undefined, priorities: ["P0"] })).toMatchObject({ sanction: { action: "ban" }, templateId: "user.ban.p0", p0: true });
    expect(() => planAccount({ ...base, actor: { uid: "system", role: "system" }, template: template("listing.remove.scam"), target: listing, chosen: { action: "warn" } })).toThrow(expect.objectContaining({ code: "sanction_not_allowed" }));
  });

  it("drops a content decision's sanction on a banned or closed account; an account decision answers 409", () => {
    const listing = { type: "listing" as const, id: "abcdefgh" };
    expect(planAccount({ ...base, owner: { status: "banned" } as never, template: template("listing.remove.scam"), target: listing, chosen: { action: "warn" } })).toBeNull();
    expect(planAccount({ ...base, owner: { status: "closed" } as never, template: template("listing.remove.scam"), target: listing, chosen: { action: "warn" } })).toBeNull();
    expect(() => planAccount({ ...base, actor: { uid: "adm", role: "admin" }, owner: { status: "banned" } as never, template: template("user.ban"), target: { type: "user", id: "owner-1" }, chosen: undefined })).toThrow(
      expect.objectContaining({ status: 409 }),
    );
  });

  it("plans the reversal of a sanction (strike off; the suspension lifted when it is this decision's)", () => {
    const superseded = { id: "D".repeat(20), action: "suspend_account" } as DecisionRecord;
    const target = { type: "user" as const, id: "owner-1" };
    expect(planAccount({ ...base, template: template("appeal.reversed"), target, chosen: undefined, superseded, suspension: { decisionId: "D".repeat(20), until: NOW, createdAt: NOW } })).toEqual({
      kind: "reverse",
      action: "suspend_account",
      decisionId: "D".repeat(20),
      suspensionLifted: true,
    });
    expect(planAccount({ ...base, template: template("appeal.reversed"), target, chosen: undefined, superseded, suspension: null })).toMatchObject({ suspensionLifted: false });
    expect(planAccount({ ...base, template: template("appeal.reversed"), target: { type: "listing", id: "abcdefgh" }, chosen: undefined, superseded: { ...superseded, action: "remove" } })).toBeNull();
  });
});

describe("appeal eligibility and views", () => {
  const record = (overrides: Partial<DecisionRecord> = {}): DecisionRecord => ({
    id: "AbCdEfGhIjKlMnOpQrSt",
    target: { type: "listing", id: "abcdefgh" },
    affectedUid: "owner-1",
    action: "remove",
    facts: "faits",
    origin: "notice",
    automation: { detection: false, decision: false },
    ground: { type: "terms", ref: "CGU", explanation: "explication" },
    reportIds: ["R".repeat(20)],
    templateId: "listing.remove.scam",
    decidedBy: "mod-1",
    appealDeadline: new Date(NOW.getTime() + 180 * DAY),
    createdAt: NOW,
    purgeAt: new Date(NOW.getTime() + 5 * 365 * DAY),
    ...overrides,
  });

  it("lets the affected user appeal a restrictive measure and a notifier a dismissal, once, before the deadline", () => {
    expect(appealRefusal(record(), "affected", NOW)).toBeNull();
    expect(appealRefusal(record(), "reporter", NOW)).toBe("appeal_not_allowed");
    expect(appealRefusal(record({ action: "no_action" }), "reporter", NOW)).toBeNull();
    expect(appealRefusal(record({ action: "restore" }), "affected", NOW)).toBe("appeal_not_allowed");
    expect(appealRefusal(record({ appeal: { status: "open", openedAt: NOW } }), "affected", NOW)).toBe("appeal_exists");
    expect(appealRefusal(record({ appealDeadline: NOW }), "affected", NOW)).toBe("appeal_closed");
    expect(appealRefusal(record({ supersededBy: "X".repeat(20) }), "affected", NOW)).toBe("appeal_closed");
    expect(appealRefusal(record({ origin: "authority_order" }), "affected", NOW)).toBe("appeal_closed");
  });

  it("shows the affected user no staff id and the back office the whole record", () => {
    const view = appealableView(record(), "affected", NOW);
    expect(view).toMatchObject({ decisionId: "AbCdEfGhIjKlMnOpQrSt", by: "affected", appealable: true, appeal: null, targetType: "listing" });
    expect(JSON.stringify(view)).not.toContain("mod-1");
    const staff = decisionView(record({ appeal: { status: "open", by: "affected", text: "texte", openedAt: NOW, slaDueAt: new Date(NOW.getTime() + 14 * DAY) } }));
    expect(staff).toMatchObject({ decidedBy: "mod-1", appeal: { status: "open", by: "affected", slaDueAt: new Date(NOW.getTime() + 14 * DAY).toISOString(), reviewer: null } });
  });
});
