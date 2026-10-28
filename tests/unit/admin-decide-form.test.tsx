import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type * as NextNavigation from "next/navigation";
import { decisionTemplate, type DecisionTemplate } from "@/config/decision-templates";
import { decideSchema } from "@/lib/decisions/contracts";
import type { AiProposal } from "@/lib/reports/admin";
import { AiProposalPanel } from "@/app/admin/_components/ai-proposal";
import { AppealReviewForm } from "@/app/admin/_components/appeal-review-form";
import { DecideForm } from "@/app/admin/_components/decide-form";
import {
  aiDirection,
  aiReview,
  aiTemplate,
  buildDecideRequest,
  confirmLabel,
  decideProblems,
  defaultSanction,
  templateAllowed,
  templateGroups,
  type DecideContext,
} from "@/app/admin/_components/decide-state";

// Back-office decision form (lot U3, design D13, D14, D24): the catalogue per target, the ladder's
// proposal, the moderator's limits (ban only to confirm a P0), the request body accepted by the
// API schema, and the agent's proposal shown as advice and marked by the decision.

vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof NextNavigation>()),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn(), back: vi.fn(), forward: vi.fn() }),
}));

const template = (id: string): DecisionTemplate => {
  const found = decisionTemplate(id);
  if (!found) throw new Error(id);
  return found;
};

const MODERATOR: DecideContext = { targetType: "listing", role: "moderator", priorities: ["P1"], strikes: 1 };
const AI_ID = "Ai0000000000000000aa";

function proposal(patch: Partial<AiProposal> = {}): AiProposal {
  return {
    id: AI_ID,
    task: "report_triage",
    provider: "anthropic",
    model: "claude-haiku",
    action: "reject",
    verdict: "founded",
    policy: "scam",
    severity: "P1",
    confidence: 0.82,
    rationale: "Paiement demandé avant la remise.",
    userMessage: null,
    templateId: "listing_remove_scam",
    applied: "pending",
    createdAt: "2026-10-19T09:00:00.000Z",
    ...patch,
  };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

describe("decision catalogue and ladder", () => {
  it("offers a target's templates, measures first, internal ones never", () => {
    const { measures, dismissals } = templateGroups("listing");
    expect(measures.map((item) => item.id)).toContain("listing.remove.scam");
    expect(dismissals.map((item) => item.id)).toEqual(["listing.restore", "listing.no_action"]);
    expect([...measures, ...dismissals].some((item) => item.internal)).toBe(false);
    expect(templateGroups("message").measures.every((item) => item.targets.includes("message"))).toBe(true);
  });

  it("proposes the next ladder step for a sanctioned content measure only", () => {
    expect(defaultSanction(template("listing.remove.scam"), { targetType: "listing", strikes: 0 })).toBe("warn");
    expect(defaultSanction(template("listing.remove.scam"), { targetType: "listing", strikes: 1 })).toBe("suspend_7");
    expect(defaultSanction(template("listing.remove.scam"), { targetType: "listing", strikes: 3 })).toBe("ban");
    expect(defaultSanction(template("listing.remove.misleading"), { targetType: "listing", strikes: 0 })).toBe("none");
    expect(defaultSanction(template("listing.remove.scam"), { targetType: "listing", strikes: null })).toBe("none");
  });

  it("lets a moderator ban only to confirm an open P0 report; an admin always", () => {
    expect(templateAllowed(template("listing.remove.p0"), MODERATOR)).toBe(false);
    expect(templateAllowed(template("listing.remove.p0"), { ...MODERATOR, priorities: ["P0", "P1"] })).toBe(true);
    expect(templateAllowed(template("user.ban"), { role: "moderator", priorities: ["P0"] })).toBe(false);
    expect(templateAllowed(template("user.ban"), { role: "admin", priorities: [] })).toBe(true);
    expect(decideProblems({ template: template("listing.remove.scam"), details: "", sanction: "ban", manifestlyUnfounded: false }, MODERATOR).sanction).toBeDefined();
  });

  it("asks for the moderator's words when the template requires them", () => {
    const draft = { template: template("listing.remove.other"), details: "court", sanction: "none" as const, manifestlyUnfounded: false };
    expect(decideProblems(draft, MODERATOR).details).toMatch(/au moins 10 caractères/);
    expect(decideProblems({ ...draft, details: "Annonce de médicaments sur ordonnance." }, MODERATOR)).toEqual({});
    expect(decideProblems({ ...draft, template: null }, MODERATOR).template).toBeDefined();
  });

  it("builds a body the API schema accepts", () => {
    const remove = buildDecideRequest("listing:abcd2345", { template: template("listing.remove.scam"), details: "  Avance demandée par Wafacash.  ", sanction: "suspend_7", manifestlyUnfounded: true }, MODERATOR, null);
    expect(remove).toEqual({ target: "listing:abcd2345", templateId: "listing.remove.scam", details: "Avance demandée par Wafacash.", sanction: { action: "suspend_account", durationDays: 7 } });
    expect(decideSchema.safeParse(remove).success).toBe(true);
    const dismiss = buildDecideRequest("listing:abcd2345", { template: template("listing.no_action"), details: "", sanction: "warn", manifestlyUnfounded: true }, MODERATOR, null);
    expect(dismiss).toEqual({ target: "listing:abcd2345", templateId: "listing.no_action", manifestlyUnfounded: true });
    expect(decideSchema.safeParse(dismiss).success).toBe(true);
    const warn = buildDecideRequest("user:u-1", { template: template("user.warn"), details: "", sanction: "ban", manifestlyUnfounded: false }, { ...MODERATOR, targetType: "user" }, null);
    expect(warn).toEqual({ target: "user:u-1", templateId: "user.warn" });
    expect(confirmLabel(template("listing.remove.scam"), "listing")).toBe("Retirer l'annonce");
    expect(confirmLabel(template("message.remove.spam"), "message")).toBe("Masquer le message");
  });
});

describe("the agent's proposal", () => {
  it("reads the verdict before the action and maps the snake_case template", () => {
    expect(aiDirection(proposal())).toBe("founded");
    expect(aiDirection(proposal({ verdict: "needs_human" }))).toBeNull();
    expect(aiDirection(proposal({ verdict: null, action: "approve" }))).toBe("unfounded");
    expect(aiDirection(proposal({ verdict: null, action: "escalate" }))).toBeNull();
    expect(aiTemplate(proposal(), "listing")?.id).toBe("listing.remove.scam");
    expect(aiTemplate(proposal({ templateId: "listing_remove_unknown" }), "listing")).toBeNull();
  });

  it("marks it confirmed, edited, rejected or handed over from the decision, pending ones only", () => {
    expect(aiReview(proposal(), template("listing.remove.scam"), "listing")).toEqual({ decisionId: AI_ID, outcome: "confirmed" });
    expect(aiReview(proposal(), template("listing.remove.counterfeit"), "listing")).toEqual({ decisionId: AI_ID, outcome: "edited" });
    expect(aiReview(proposal(), template("listing.restore"), "listing")).toEqual({ decisionId: AI_ID, outcome: "rejected" });
    expect(aiReview(proposal({ templateId: null }), template("listing.remove.counterfeit"), "listing")?.outcome).toBe("confirmed");
    expect(aiReview(proposal({ applied: "confirmed" }), template("listing.remove.scam"), "listing")).toBeNull();
    // No side taken (unclear, needs_human, escalate): the human decided, the proposal leaves "En attente".
    expect(aiReview(proposal({ verdict: "unclear" }), template("listing.remove.scam"), "listing")).toEqual({ decisionId: AI_ID, outcome: "handed_over" });
    expect(aiReview(proposal({ verdict: "needs_human", action: "escalate" }), template("listing.restore"), "listing")?.outcome).toBe("handed_over");
    expect(decideSchema.safeParse(buildDecideRequest("listing:abcd2345", { template: template("listing.remove.scam"), details: "", sanction: "none", manifestlyUnfounded: false }, MODERATOR, proposal({ verdict: "needs_human" }))).success).toBe(true);
    const body = buildDecideRequest("listing:abcd2345", { template: template("listing.remove.scam"), details: "", sanction: "none", manifestlyUnfounded: false }, MODERATOR, proposal());
    expect(body.ai).toEqual({ decisionId: AI_ID, outcome: "confirmed" });
    expect(decideSchema.safeParse(body).success).toBe(true);
  });
});

describe("decision form", () => {
  it("labels a proposal handed over to a human once decided", () => {
    const content = text(renderToStaticMarkup(<AiProposalPanel ai={proposal({ verdict: "needs_human", action: "escalate", applied: "handed_over" })} />));
    expect(content).toContain("Transmise, décidée par un humain");
    expect(content).not.toContain("En attente");
  });

  it("shows the proposal as advice, with its verdict and confidence", () => {
    const content = text(renderToStaticMarkup(<AiProposalPanel ai={proposal()} templateLabel="Retrait : arnaque ou tentative d'escroquerie" />));
    expect(content).toContain("Proposition de l'agent");
    expect(content).toContain("Avis consultatif : rien n'est appliqué sans votre décision.");
    expect(content).toContain("Signalement fondé");
    expect(content).toContain("82 %");
    expect(content).toContain("Modèle suggéré Retrait : arnaque ou tentative d'escroquerie");
    expect(text(renderToStaticMarkup(<AiProposalPanel ai={proposal({ task: "appeal_review", verdict: null, action: "approve" })} />))).toContain("Annuler la décision");
  });

  it("offers the agent's template, the catalogue, and marks the admin-only measures", () => {
    const html = renderToStaticMarkup(<DecideForm targetKey="listing:abcd2345" targetType="listing" role="moderator" priorities={["P1"]} strikes={1} openCount={2} ai={proposal()} />);
    const content = text(html);
    expect(content).toContain("Suggestion de l'agent : Retrait : arnaque ou tentative d'escroquerie");
    expect(content).toContain("Partir de la suggestion");
    expect(html).toMatch(/<optgroup label="Mesures \(signalements fondés\)">/);
    expect(html).toMatch(/<option value="listing\.remove\.p0" disabled="">Retrait P0 confirmé[^<]*\(admin\)<\/option>/);
    expect(content).toContain("Vérifier la décision");
    expect(content).not.toContain("Aucun signalement ouvert");
  });

  it("says when the decision is taken on its own initiative", () => {
    const html = renderToStaticMarkup(<DecideForm targetKey="user:u-1" targetType="user" role="admin" priorities={[]} strikes={2} openCount={0} ai={null} />);
    const content = text(html);
    expect(content).toContain("Aucun signalement ouvert : la décision sera prise d'initiative.");
    expect(content).toContain("Étape proposée par l'échelle : Suspension 30 jours");
    expect(html).toMatch(/<option value="user\.ban">Fermeture définitive du compte<\/option>/);
  });
});

describe("appeal review form", () => {
  it("warns an admin reviewing his own decision", () => {
    const content = text(renderToStaticMarkup(<AppealReviewForm decisionId="D1aaaaaaaaaaaaaaaaaa" restrictive targetType="listing" role="admin" selfReview />));
    expect(content).toContain("Réexamen de votre propre décision");
    expect(content).toContain("journalisé");
    expect(content).toContain("Maintenir la décision");
  });

  it("stays quiet otherwise", () => {
    const content = text(renderToStaticMarkup(<AppealReviewForm decisionId="D1aaaaaaaaaaaaaaaaaa" restrictive targetType="listing" role="moderator" selfReview={false} />));
    expect(content).not.toContain("propre décision");
  });
});
