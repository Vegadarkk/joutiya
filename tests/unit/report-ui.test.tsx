import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import ar from "../../messages/ar.json";
import fr from "../../messages/fr.json";
import { FailureMessage } from "@/components/report/report-dialog";
import {
  contactNeed,
  draftProblems,
  EMPTY_DRAFT,
  reasonGroups,
  reportFailure,
  reportRequest,
  slaDelay,
  type ReportDraft,
  type ReportFailure,
} from "@/components/report/report-state";
import { chosenReason, DetailsStep, Receipt, ReasonStep } from "@/components/report/report-steps";
import { reportReason } from "@/config/report-reasons";
import { ApiError } from "@/lib/auth/client";

// The notice form (art. 16 DSA, lot U2): its pure state and its steps as rendered on the server.

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
    .replace(/\s+/g, " ");

const draft = (patch: Partial<ReportDraft>): ReportDraft => ({ ...EMPTY_DRAFT, ...patch });
const VALID = draft({ reasonId: "scam", explanation: "Paiement demandé d'avance par virement.", goodFaith: true });

describe("report state", () => {
  it("groups the reasons by ground, illegal content first, per target type", () => {
    const listing = reasonGroups("listing");
    expect(listing.map((group) => group.ground)).toEqual(["illegal", "terms"]);
    expect(listing.flatMap((group) => group.reasons).every((reason) => reason.targets.includes("listing"))).toBe(true);
    const message = reasonGroups("message").flatMap((group) => group.reasons.map((reason) => reason.id));
    expect(message).toContain("harassment");
    expect(message).not.toContain("wrong_category");
  });

  it("asks a visitor's name and e-mail, optional for an urgent reason, never a member's", () => {
    expect(contactNeed(reportReason("scam"), false)).toBe("required");
    expect(contactNeed(reportReason("minors"), false)).toBe("optional");
    expect(contactNeed(reportReason("scam"), true)).toBe("none");
  });

  it("finds what keeps a notice from being sent", () => {
    expect(draftProblems(EMPTY_DRAFT, true)).toEqual({ reasonId: "required", explanation: "required", goodFaith: "required" });
    expect(draftProblems(VALID, true)).toEqual({});
    expect(draftProblems(VALID, false)).toEqual({ name: "required", email: "required" });
    expect(draftProblems({ ...VALID, explanation: "court", name: "A", email: "pas-un-mail" }, false)).toEqual({ explanation: "short", name: "short", email: "invalid" });
    expect(draftProblems({ ...VALID, reasonId: "minors" }, false)).toEqual({});
  });

  it("sends no contact for a member and the Turnstile token only when given", () => {
    const member = reportRequest({ type: "listing", id: "abcd2345" }, { ...VALID, name: "Ali", email: "ali@example.com" }, true, null);
    expect(member).toEqual({ target: { type: "listing", id: "abcd2345" }, reasonId: "scam", explanation: VALID.explanation, goodFaith: true });
    const visitor = reportRequest({ type: "user", id: "abcdefghjk" }, { ...VALID, name: " Ali ", email: "ali@example.com" }, false, "tok");
    expect(visitor).toMatchObject({ name: "Ali", email: "ali@example.com", turnstileToken: "tok" });
  });

  it("maps refusals to the form's answers", () => {
    expect(reportFailure(new ApiError(401, "unauthenticated"))).toEqual({ kind: "signin" });
    expect(reportFailure(new ApiError(403, "turnstile_required"))).toEqual({ kind: "challenge" });
    expect(reportFailure(new ApiError(400, "invalid_body", { details: [{ path: "explanation", code: "too_small" }] }))).toEqual({ kind: "fields", fields: { explanation: "short" } });
    expect(reportFailure(new ApiError(403, "report_not_allowed"))).toEqual({ kind: "message", key: "report_not_allowed" });
    expect(reportFailure(new ApiError(429, "rate_limited"))).toEqual({ kind: "message", key: "rate_limited" });
    expect(reportFailure(new ApiError(503, "quota_exhausted"))).toEqual({ kind: "message", key: "quota_exhausted" });
    expect(reportFailure(new ApiError(400, "turnstile_failed"))).toEqual({ kind: "message", key: "turnstile_failed" });
    expect(reportFailure(new Error("boom"))).toEqual({ kind: "message", key: null });
  });

  it("states the target delay in the hour, in hours or in days", () => {
    expect(slaDelay(1)).toEqual({ unit: "hour" });
    expect(slaDelay(24)).toEqual({ unit: "hours", count: 24 });
    expect(slaDelay(72)).toEqual({ unit: "days", count: 3 });
  });
});

describe("report steps", () => {
  it("lists the reasons with the urgent ones marked and the ground of the chosen one", () => {
    const html = render(<ReasonStep groups={reasonGroups("listing")} value="scam" onChange={() => {}} />);
    expect(text(html)).toContain(fr.Report.group.illegal);
    expect(text(html)).toContain(fr.Report.urgent);
    expect(html).toContain('data-testid="reason-scam"');
    expect(html.match(/type="radio"/g)?.length).toBe(reasonGroups("listing").flatMap((group) => group.reasons).length);
    expect(text(html)).toContain(fr.Report.ground);
    expect(html.match(/<bdi lang="fr">/g)?.length).toBe(1);
    const arabic = render(<ReasonStep groups={reasonGroups("listing")} value={null} onChange={() => {}} error="x" />, "ar");
    expect(text(arabic)).toContain(ar.Report.reasonLegend);
    expect(arabic).toContain('role="alert"');
  });

  it("asks a visitor for a name and an e-mail, and a member for neither", () => {
    const reason = chosenReason(VALID, reasonGroups("listing"));
    expect(reason?.id).toBe("scam");
    if (!reason) return;
    const visitor = render(<DetailsStep reason={reason} draft={VALID} signedIn={false} problems={{ email: "invalid" }} onChange={() => {}} onChangeReason={() => {}} challenge={<div data-testid="challenge" />} />);
    expect(visitor).toContain('type="email"');
    expect(text(visitor)).toContain(fr.Report.problems.email.invalid);
    expect(text(visitor)).toContain(fr.Report.goodFaith);
    expect(text(visitor)).toContain(fr.Report.host);
    expect(visitor).toContain('data-testid="challenge"');
    const member = render(<DetailsStep reason={reason} draft={VALID} signedIn problems={{}} onChange={() => {}} onChangeReason={() => {}} />, "ar");
    expect(member).not.toContain('type="email"');
    expect(text(member)).toContain(ar.Report.member);
    const urgent = reportReason("minors");
    if (urgent) expect(text(render(<DetailsStep reason={urgent} draft={VALID} signedIn problems={{}} onChange={() => {}} onChangeReason={() => {}} />))).toContain(fr.Report.emergency);
  });

  it("shows the receipt with the reference and the delay, new or duplicate", () => {
    const sent = render(<Receipt receipt={{ reportId: "R1b2C3d4E5f6G7h8I9j0", duplicate: false, priority: "P1", slaHours: 72, mailed: true }} />);
    expect(sent).toContain('data-duplicate="false"');
    expect(text(sent)).toContain("R1b2C3d4E5f6G7h8I9j0");
    expect(text(sent)).toContain(fr.Report.mailed);
    expect(text(sent)).toContain("3 jours");
    const again = render(<Receipt receipt={{ reportId: "R1b2C3d4E5f6G7h8I9j0", duplicate: true, priority: "P0", slaHours: 1, mailed: false }} />, "ar");
    expect(again).toContain('data-duplicate="true"');
    expect(text(again)).toContain(ar.Report.notMailed);
  });

  it("explains a refused notice and offers the e-mail when the form cannot send", () => {
    const failure = (kind: ReportFailure, error: unknown) => render(<FailureMessage failure={{ error, kind }} fallbackEmail="dsa@joutiya.ma" next="/fr/annonce/x" />);
    expect(text(failure({ kind: "message", key: "report_not_allowed" }, new ApiError(403, "report_not_allowed")))).toContain(fr.Report.errors.report_not_allowed);
    expect(failure({ kind: "message", key: "report_not_allowed" }, new ApiError(403, "report_not_allowed"))).not.toContain("mailto:");
    expect(failure({ kind: "message", key: "quota_exhausted" }, new ApiError(503, "quota_exhausted"))).toContain("mailto:dsa@joutiya.ma");
    const signin = failure({ kind: "signin" }, new ApiError(401, "unauthenticated"));
    expect(signin).toContain("/fr/connexion?next=%2Ffr%2Fannonce%2Fx");
    expect(text(signin)).toContain(fr.Report.signIn);
    expect(failure({ kind: "fields", fields: {} }, new ApiError(400, "invalid_body"))).toBe("");
  });
});
