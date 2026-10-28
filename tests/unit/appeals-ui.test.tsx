import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { AppealForm, appealTextProblem } from "@/components/appeals/appeal-form";
import { appealStatus, formatDecisionDate, measureKey, sentence, statementTexts, statusTone, visibleDecisions } from "@/components/appeals/appeal-state";
import { DecisionCard, withAppeal } from "@/components/appeals/decision-card";
import type { AppealableDecision } from "@/lib/decisions/contracts";

// The decisions page and the appeal link page (art. 17 and 20 DSA, lot U2): where a decision
// stands, its statement texts, and the card and form as rendered on the server.

function render(node: ReactNode, locale: "fr" | "ar" = "fr") {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={locale === "ar" ? ar : fr} timeZone="Africa/Casablanca">
      {node}
    </NextIntlClientProvider>,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/[⁦-⁩]/g, "")
    .replace(/\s+/g, " ");

const NOW = new Date("2026-10-19T10:00:00Z");

function decision(patch: Partial<AppealableDecision> = {}): AppealableDecision {
  return {
    decisionId: "D1b2C3d4E5f6G7h8I9j0",
    by: "affected",
    action: "remove",
    targetType: "listing",
    templateId: "listing.remove.scam",
    durationDays: null,
    origin: "notice",
    automated: { detection: false, decision: false },
    ground: { type: "terms", ref: "CGU, modération (arnaques)" },
    details: null,
    createdAt: "2026-10-12T09:00:00.000Z",
    appealDeadline: "2027-04-12T09:00:00.000Z",
    appealable: true,
    appeal: null,
    ...patch,
  };
}

const OPEN = { status: "open" as const, openedAt: "2026-10-14T09:00:00.000Z", slaDueAt: "2026-10-28T09:00:00.000Z", closedAt: null, note: null };

describe("appeal state", () => {
  it("hides the phase-3 publication holds and approvals", () => {
    const items = [decision(), decision({ templateId: "listingPendingReview" }), decision({ templateId: "listingApproved" }), decision({ templateId: "listingRejected" })];
    expect(visibleDecisions(items).map((item) => item.templateId)).toEqual(["listing.remove.scam", "listingRejected"]);
  });

  it("tells where a decision stands, as the server's appeal refusal would", () => {
    expect(appealStatus(decision(), NOW)).toBe("form");
    expect(appealStatus(decision({ appealable: false, appeal: OPEN }), NOW)).toBe("open");
    expect(appealStatus(decision({ appealable: false, appeal: { ...OPEN, status: "reversed", closedAt: "2026-10-20T09:00:00.000Z" } }), NOW)).toBe("reversed");
    expect(appealStatus(decision({ appealable: false, origin: "authority_order" }), NOW)).toBe("authority");
    expect(appealStatus(decision({ appealable: false, appealDeadline: "2026-10-01T00:00:00.000Z" }), NOW)).toBe("expired");
    expect(appealStatus(decision({ appealable: false }), NOW)).toBe("superseded");
    expect(appealStatus(decision({ appealable: false, action: "restore" }), NOW)).toBe("favorable");
    expect(appealStatus(decision({ appealable: false, by: "reporter" }), NOW)).toBe("reporterActioned");
    expect(statusTone("form")).toBe("warning");
    expect(statusTone("upheld")).toBe("danger");
  });

  it("names the measure and states the template's facts and ground in the reader's language", () => {
    expect(measureKey(decision())).toEqual({ key: "remove.listing" });
    expect(measureKey(decision({ targetType: "user" }))).toEqual({ key: "remove.other" });
    expect(measureKey(decision({ action: "suspend_account", durationDays: 7 }))).toEqual({ key: "suspend_account", values: { days: 7 } });
    const french = statementTexts(decision(), "fr");
    expect(french.facts).toMatch(/^L'annonce présente des signes d'arnaque.*\.$/);
    expect(french.explanation).toMatch(/^Nos conditions générales/);
    expect(statementTexts(decision(), "ar").facts).toMatch(/^يحمل الإعلان/);
    expect(statementTexts(decision(), "rif").facts).toBe(french.facts);
    expect(statementTexts(decision({ templateId: "photoRejectedNsfw" }), "fr")).toEqual({ facts: null, legacy: "photoRejectedNsfw", explanation: null });
    expect(statementTexts(decision({ templateId: "unknown" }), "fr")).toEqual({ facts: null, legacy: null, explanation: null });
    expect(sentence("déjà fini.")).toBe("Déjà fini.");
    expect(formatDecisionDate("2026-10-12T09:00:00.000Z", "fr")).toBe("12 octobre 2026");
  });

  it("requires a few words to appeal", () => {
    expect(appealTextProblem("   court   ")).toBe("short");
    expect(appealTextProblem("Je conteste : l'objet existe bien, photos à l'appui.")).toBeNull();
  });
});

describe("decision card", () => {
  it("states the measure, facts, ground, origin and automated means, then offers the appeal", () => {
    const html = render(<DecisionCard decision={decision({ details: "Plusieurs acheteurs ont payé sans recevoir l'objet." })} mode={{ kind: "member" }} now={NOW} />);
    expect(html).toContain('data-status="form"');
    const content = text(html);
    expect(content).toContain(fr.Appeals.measure.remove.listing);
    expect(content).toContain("Décision du 12 octobre 2026");
    expect(content).toContain(fr.Appeals.facts);
    expect(content).toContain("Plusieurs acheteurs ont payé sans recevoir l'objet.");
    expect(content).toContain("CGU, modération (arnaques)");
    expect(content).toContain(fr.Appeals.origins.notice);
    expect(content).toContain(fr.Appeals.automations.human);
    expect(content).toContain(fr.Appeals.status.appealable);
    expect(content).toContain("jusqu'au 12 avril 2027");
    expect(content).toContain(fr.Appeals.appeal.start);
    expect(html).not.toContain('data-testid="appeal-form"');
    expect(content).toContain("D1b2C3d4E5f6G7h8I9j0");
  });

  it("opens the form at once on the link page and shows the appeal's timeline once filed", () => {
    const link = render(<DecisionCard decision={decision()} mode={{ kind: "link", token: "t" }} formOpen headingLevel="h1" now={NOW} />);
    expect(link).toContain('data-testid="appeal-form"');
    expect(link).toContain("<h1");
    const filed = withAppeal(decision(), { decisionId: "D1b2C3d4E5f6G7h8I9j0", by: "affected", status: "open", slaDueAt: "2026-10-28T09:00:00.000Z" }, new Date("2026-10-14T09:00:00Z"));
    expect(filed).toMatchObject({ appealable: false, appeal: { status: "open", openedAt: "2026-10-14T09:00:00.000Z" } });
    const open = render(<DecisionCard decision={filed} mode={{ kind: "member" }} now={NOW} />, "ar");
    expect(open).toContain('data-testid="appeal-timeline"');
    expect(open).toContain('aria-current="step"');
    expect(text(open)).toContain(ar.Appeals.status.open);
    const answered = render(<DecisionCard decision={decision({ appealable: false, appeal: { ...OPEN, status: "upheld", closedAt: "2026-10-20T09:00:00.000Z", note: "Les éléments fournis ne changent pas la décision." } })} mode={{ kind: "member" }} now={NOW} />);
    expect(text(answered)).toContain(fr.Appeals.appeal.upheld);
    expect(text(answered)).toContain("Les éléments fournis ne changent pas la décision.");
  });

  it("tells a notifier the outcome of the notice, without the words written about the other user", () => {
    const dismissed = render(<DecisionCard decision={decision({ by: "reporter", action: "no_action", templateId: "unknown", details: null })} mode={{ kind: "link", token: "t" }} now={NOW} />);
    expect(text(dismissed)).toContain(fr.Appeals.reporter.dismissed);
    expect(text(dismissed)).toContain(fr.Appeals.reporter.dismissedFacts);
    expect(text(dismissed)).not.toContain(fr.Appeals.origin);
    const actioned = render(<DecisionCard decision={decision({ by: "reporter", appealable: false })} mode={{ kind: "member" }} now={NOW} />);
    expect(text(actioned)).toContain(fr.Appeals.reporter.actionedBody);
    expect(text(actioned)).not.toContain(fr.Appeals.facts);
  });

  it("says why there is no appeal any more", () => {
    expect(text(render(<DecisionCard decision={decision({ appealable: false, origin: "authority_order" })} mode={{ kind: "member" }} now={NOW} />))).toContain(fr.Appeals.appeal.authority);
    expect(text(render(<DecisionCard decision={decision({ appealable: false, appealDeadline: "2026-10-01T00:00:00.000Z" })} mode={{ kind: "member" }} now={NOW} />))).toContain("Le délai de recours a expiré le 1 octobre 2026");
    expect(text(render(<DecisionCard decision={decision({ action: "suspend_account", durationDays: 30, targetType: "user", templateId: "user.suspend.30" })} mode={{ kind: "member" }} now={NOW} />))).toContain("Compte suspendu 30 jours");
  });
});

describe("appeal form", () => {
  it("asks the reasons with their bounds, in French and Arabic", () => {
    const html = render(<AppealForm decisionId="D1b2C3d4E5f6G7h8I9j0" mode={{ kind: "member" }} onFiled={() => {}} onCancel={() => {}} />);
    expect(text(html)).toContain(fr.Appeals.appeal.label);
    expect(html).toContain('maxLength="2000"');
    expect(text(html)).toContain(fr.Appeals.appeal.cancel);
    const arabic = render(<AppealForm decisionId="D1b2C3d4E5f6G7h8I9j0" mode={{ kind: "link", token: "t" }} onFiled={() => {}} />, "ar");
    expect(text(arabic)).toContain(ar.Appeals.appeal.submit);
    expect(text(arabic)).not.toContain(ar.Appeals.appeal.cancel);
  });
});
