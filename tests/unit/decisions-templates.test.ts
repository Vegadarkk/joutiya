import { describe, expect, it } from "vitest";
import {
  DECISION_ACTIONS,
  DECISION_TARGET_TYPES,
  DECISION_TEMPLATES,
  DECISION_TEMPLATE_IDS,
  DETAILS_MIN,
  decisionTemplate,
  fillTemplateText,
  sanctionTemplateId,
  templatesFor,
  type DecisionTemplate,
} from "@/config/decision-templates";
import { REPORT_REASON_IDS } from "@/config/report-reasons";
import {
  bulkDismissSchema,
  createAuthorityRequestSchema,
  decideSchema,
  linkAppealSchema,
  openAppealSchema,
  reviewAppealSchema,
  staffConversationQuerySchema,
  updateAuthorityRequestSchema,
} from "@/lib/decisions/contracts";

// D13 template registry (statement of reasons, art. 17) and the back-office contracts (strict Zod).

const TEMPLATES: readonly DecisionTemplate[] = DECISION_TEMPLATES;
const DECISION_ID = "AbCdEfGhIjKlMnOpQrSt";
const LISTING = "listing:abcdefgh";
const MESSAGE = `message:${"c".repeat(22)}/${"M".repeat(20)}`;
const USER = "user:uid-123";

describe("decision templates", () => {
  it("have unique ids, known actions and targets, and a ground ref that fits the schema", () => {
    expect(new Set(TEMPLATES.map((template) => template.id)).size).toBe(TEMPLATES.length);
    expect(DECISION_TEMPLATE_IDS).toHaveLength(TEMPLATES.length);
    for (const template of TEMPLATES) {
      expect(DECISION_ACTIONS).toContain(template.action);
      expect(template.targets.length).toBeGreaterThan(0);
      for (const target of template.targets) expect(DECISION_TARGET_TYPES).toContain(target);
      expect(template.ground.ref.length).toBeGreaterThan(0);
      expect(template.ground.ref.length).toBeLessThanOrEqual(64);
      expect(template.label.length).toBeGreaterThan(0);
    }
  });

  it("state the facts and the explanation in French and Arabic", () => {
    for (const template of TEMPLATES) {
      for (const text of [template.facts, template.explanation]) {
        expect(text.fr.trim().length, template.id).toBeGreaterThan(10);
        expect(text.ar.trim().length, template.id).toBeGreaterThan(5);
        expect(text.ar, template.id).toMatch(/[؀-ۿ]/);
        expect(`${text.fr}${text.ar}`, template.id).not.toMatch(/undefined|TODO/);
      }
    }
  });

  it("match the outcome to the measure (restrictive: founded; restore and no action: unfounded)", () => {
    for (const template of TEMPLATES) {
      const restoring = template.action === "restore" || template.action === "no_action";
      expect(template.outcome, template.id).toBe(restoring ? "unfounded" : "founded");
    }
  });

  it("give the account templates their own measure and the P0 ones a ban", () => {
    expect(decisionTemplate("user.suspend.7")).toMatchObject({ action: "suspend_account", durationDays: 7, targets: ["user"] });
    expect(decisionTemplate("user.suspend.30")).toMatchObject({ action: "suspend_account", durationDays: 30 });
    expect(decisionTemplate("user.ban.p0")).toMatchObject({ action: "ban", p0: true });
    // P0 content templates propose (and force) the ban; the account one is the ban itself.
    for (const template of TEMPLATES.filter((entry) => entry.p0 && entry.action === "remove")) expect(template.defaultSanction, template.id).toBe("ban");
    // `{days}` only where there is a length to fill.
    for (const template of TEMPLATES) {
      const usesDays = /\{days\}/.test(`${template.facts.fr}${template.facts.ar}${template.explanation.fr}${template.explanation.ar}`);
      if (usesDays) expect(template.durationDays, template.id).toBeDefined();
    }
  });

  it("keep the server's own templates out of the back-office lists", () => {
    for (const target of DECISION_TARGET_TYPES) {
      const offered = templatesFor(target);
      expect(offered.length).toBeGreaterThan(0);
      expect(offered.every((template) => !template.internal && template.targets.includes(target))).toBe(true);
    }
    expect(templatesFor("listing").map((template) => template.id)).not.toContain("authority.remove");
    expect(templatesFor("user").map((template) => template.id)).not.toContain("appeal.reversed");
    expect(decisionTemplate("authority.remove")).toMatchObject({ internal: true, action: "remove", ground: { type: "illegal" } });
  });

  it("names the sanction template of a ladder step", () => {
    expect(sanctionTemplateId("warn")).toBe("user.warn");
    expect(sanctionTemplateId("suspend_account", { durationDays: 7 })).toBe("user.suspend.7");
    expect(sanctionTemplateId("suspend_account", { durationDays: 30 })).toBe("user.suspend.30");
    expect(sanctionTemplateId("ban")).toBe("user.ban");
    expect(sanctionTemplateId("ban", { p0: true })).toBe("user.ban.p0");
    expect(fillTemplateText("suspendu {days} jours, {days}", { days: 7 })).toBe("suspendu 7 jours, 7");
    expect(fillTemplateText("sans durée {days}", {})).toBe("sans durée ");
  });
});

describe("decideSchema", () => {
  const parse = (input: unknown) => decideSchema.safeParse(input);

  it("accepts a listing removal with a sanction, a dismissal flagging reports, and an AI mark", () => {
    expect(parse({ target: LISTING, templateId: "listing.remove.scam", sanction: { action: "suspend_account", durationDays: 7 } }).success).toBe(true);
    expect(parse({ target: LISTING, templateId: "listing.no_action", manifestlyUnfounded: true }).success).toBe(true);
    expect(parse({ target: MESSAGE, templateId: "message.no_action", manifestlyUnfounded: [DECISION_ID] }).success).toBe(true);
    expect(parse({ target: USER, templateId: "user.warn", ai: { decisionId: DECISION_ID, outcome: "edited" } }).success).toBe(true);
  });

  it("refuses a template of another target, an internal template, a shop or malformed target", () => {
    expect(parse({ target: USER, templateId: "listing.remove.scam" }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "authority.remove" }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "appeal.reversed" }).success).toBe(false);
    expect(parse({ target: "pro:boutique-test", templateId: "listing.no_action" }).success).toBe(false);
    expect(parse({ target: "listing:not-an-id!", templateId: "listing.no_action" }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "nope" }).success).toBe(false);
  });

  it("requires the moderator's words where the template says so", () => {
    const required = TEMPLATES.find((template) => template.detailsRequired && template.targets.includes("listing") && !template.internal);
    expect(required).toBeDefined();
    expect(parse({ target: LISTING, templateId: required?.id }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: required?.id, details: "x".repeat(DETAILS_MIN) }).success).toBe(true);
  });

  it("refuses a sanction on an account target, a suspension without length, flags on a founded decision, unknown keys", () => {
    expect(parse({ target: USER, templateId: "user.warn", sanction: { action: "warn" } }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "listing.remove.scam", sanction: { action: "suspend_account" } }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "listing.remove.scam", manifestlyUnfounded: true }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "listing.no_action", extra: 1 }).success).toBe(false);
    expect(parse({ target: LISTING, templateId: "listing.no_action", manifestlyUnfounded: ["short"] }).success).toBe(false);
  });

  it("bulk dismissal: 1 to 20 distinct targets", () => {
    expect(bulkDismissSchema.safeParse({ targets: [LISTING, MESSAGE] }).success).toBe(true);
    expect(bulkDismissSchema.safeParse({ targets: [] }).success).toBe(false);
    expect(bulkDismissSchema.safeParse({ targets: [LISTING, LISTING] }).success).toBe(false);
    expect(bulkDismissSchema.safeParse({ targets: ["pro:boutique-test"] }).success).toBe(false);
    expect(bulkDismissSchema.safeParse({ targets: Array.from({ length: 21 }, (_, index) => `user:u${index}`) }).success).toBe(false);
  });
});

describe("appeal contracts", () => {
  it("review: a note always, a template only to reverse, a restrictive one", () => {
    const note = "Après réexamen des pièces.";
    expect(reviewAppealSchema.safeParse({ outcome: "upheld", note }).success).toBe(true);
    expect(reviewAppealSchema.safeParse({ outcome: "upheld", note: "court" }).success).toBe(false);
    expect(reviewAppealSchema.safeParse({ outcome: "upheld", note, templateId: "listing.remove.scam" }).success).toBe(false);
    expect(reviewAppealSchema.safeParse({ outcome: "reversed", note }).success).toBe(true);
    expect(reviewAppealSchema.safeParse({ outcome: "reversed", note, templateId: "listing.remove.scam" }).success).toBe(true);
    expect(reviewAppealSchema.safeParse({ outcome: "reversed", note, templateId: "listing.restore" }).success).toBe(false);
    expect(reviewAppealSchema.safeParse({ outcome: "reversed", note, templateId: "authority.remove" }).success).toBe(false);
  });

  it("opening: a decision id or a signed token, and a 10 to 2000 character text", () => {
    expect(openAppealSchema.safeParse({ decisionId: DECISION_ID, text: "Je conteste cette décision." }).success).toBe(true);
    expect(openAppealSchema.safeParse({ decisionId: DECISION_ID, text: "trop court" }).success).toBe(true);
    expect(openAppealSchema.safeParse({ decisionId: DECISION_ID, text: "court" }).success).toBe(false);
    expect(openAppealSchema.safeParse({ decisionId: "x", text: "Je conteste cette décision." }).success).toBe(false);
    expect(linkAppealSchema.safeParse({ token: `${"a".repeat(60)}.${"b".repeat(43)}`, text: "Je conteste cette décision." }).success).toBe(true);
    expect(linkAppealSchema.safeParse({ token: "not a token", text: "Je conteste cette décision." }).success).toBe(false);
  });

  it("staff reading of a conversation needs a 10 to 300 character reason", () => {
    expect(staffConversationQuerySchema.safeParse({ reason: "Signalement P1 en cours" }).success).toBe(true);
    expect(staffConversationQuerySchema.safeParse({ reason: "court" }).success).toBe(false);
    expect(staffConversationQuerySchema.safeParse({ reason: "x".repeat(301) }).success).toBe(false);
  });
});

describe("authority request contracts", () => {
  const base = {
    authority: "Parquet de Paris",
    country: "FR",
    legalBasis: "Art. 60-1 du code de procédure pénale",
    kind: "data_request",
    scope: [LISTING, "user:uid-123", `conversation:${"c".repeat(22)}`],
    identityCheck: { method: "Rappel du standard du parquet" },
    receivedAt: "2026-10-16T08:00:00.000Z",
  };

  it("accepts a scoped request and refuses malformed scopes and duplicates", () => {
    expect(createAuthorityRequestSchema.safeParse(base).success).toBe(true);
    expect(createAuthorityRequestSchema.safeParse({ ...base, scope: ["listing:../../x"] }).success).toBe(false);
    expect(createAuthorityRequestSchema.safeParse({ ...base, scope: [LISTING, LISTING] }).success).toBe(false);
    expect(createAuthorityRequestSchema.safeParse({ ...base, scope: [MESSAGE] }).success).toBe(false);
  });

  it("asks the report reason of a removal order only", () => {
    const reasonId = REPORT_REASON_IDS[0];
    expect(createAuthorityRequestSchema.safeParse({ ...base, kind: "removal_order" }).success).toBe(false);
    expect(createAuthorityRequestSchema.safeParse({ ...base, kind: "removal_order", reasonId }).success).toBe(true);
    expect(createAuthorityRequestSchema.safeParse({ ...base, reasonId }).success).toBe(false);
  });

  it("an answer needs the response; closing may carry one", () => {
    expect(updateAuthorityRequestSchema.safeParse({ status: "answered" }).success).toBe(false);
    expect(updateAuthorityRequestSchema.safeParse({ status: "answered", response: "Données transmises le 16/10." }).success).toBe(true);
    expect(updateAuthorityRequestSchema.safeParse({ status: "closed" }).success).toBe(true);
    expect(updateAuthorityRequestSchema.safeParse({ status: "open" }).success).toBe(false);
  });
});
