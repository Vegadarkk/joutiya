"use client";

import { useState, type ReactNode } from "react";
import { Scale } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import type { AppealableDecision, OpenAppealResponse } from "@/lib/decisions/contracts";
import { isolateLtr } from "@/lib/i18n/bidi";
import { cn } from "@/lib/utils";
import { AppealForm, type AppealMode } from "./appeal-form";
import { appealStatus, formatDecisionDate, isFavorable, measureKey, statementTexts, statusTone, type AppealStatus } from "./appeal-state";

// One decision as its affected user or notifier reads it (art. 17 DSA statement of reasons): the
// measure, the facts, the ground, the origin and the automated means, then where the appeal stands
// (art. 20): the form while the deadline runs, or the appeal's timeline.

const EDGE: Record<ReturnType<typeof statusTone>, string> = {
  neutral: "border-s-border-strong",
  warning: "border-s-warning",
  info: "border-s-structure",
  success: "border-s-success",
  danger: "border-s-danger",
};

const CHIP: Partial<Record<AppealStatus, { key: "appealable" | "open" | "upheld" | "reversed"; variant: "warning" | "pro" | "success" | "danger" }>> = {
  form: { key: "appealable", variant: "warning" },
  open: { key: "open", variant: "pro" },
  upheld: { key: "upheld", variant: "danger" },
  reversed: { key: "reversed", variant: "success" },
};

/** The decision once an appeal is filed, before the next read. */
export function withAppeal(decision: AppealableDecision, response: OpenAppealResponse, now = new Date()): AppealableDecision {
  return { ...decision, appealable: false, appeal: { status: "open", openedAt: now.toISOString(), slaDueAt: response.slaDueAt, closedAt: null, note: null } };
}

export interface DecisionCardProps {
  decision: AppealableDecision;
  mode: AppealMode;
  /** The form shows at once (the link page); otherwise behind "Contester la décision". */
  formOpen?: boolean;
  headingLevel?: "h1" | "h2";
  now?: Date;
}

export function DecisionCard({ decision: initial, mode, formOpen = false, headingLevel = "h2", now }: DecisionCardProps) {
  const t = useTranslations("Appeals");
  const locale = useLocale() as Locale;
  const [decision, setDecision] = useState(initial);
  const [showForm, setShowForm] = useState(formOpen);
  const [filed, setFiled] = useState(false);
  const status = appealStatus(decision, now);
  const reporter = decision.by === "reporter";
  const texts = statementTexts(decision, locale);
  const date = (iso: string) => formatDecisionDate(iso, locale);
  const measure = measureKey(decision);
  const Heading = headingLevel;
  const chip = CHIP[status];
  const automation = decision.automated.decision ? "full" : decision.automated.detection ? "detected" : "human";

  const title = reporter ? (isFavorable(decision.action) ? t("reporter.dismissed") : t("reporter.actioned")) : t(`measure.${measure.key}`, measure.values);
  const facts = reporter && !isFavorable(decision.action) ? null : (texts.facts ?? (texts.legacy ? t(`legacy.${texts.legacy}`) : reporter ? t("reporter.dismissedFacts") : null));

  return (
    <article
      data-testid="decision-card"
      data-status={status}
      data-decision={decision.decisionId}
      className={cn("overflow-hidden rounded-lg border border-s-4 border-border bg-surface shadow-sm shadow-bab-950/5", EDGE[statusTone(status)])}
    >
      <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-5 pt-5 sm:px-6">
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm text-foreground-muted">{t("decidedOn", { date: date(decision.createdAt) })}</p>
          <Heading className="text-lg font-semibold text-balance">{title}</Heading>
        </div>
        {chip ? <Badge variant={chip.variant}>{t(`status.${chip.key}`)}</Badge> : null}
      </header>

      {reporter && !isFavorable(decision.action) ? (
        <p className="px-5 pt-3 text-foreground-muted text-pretty sm:px-6">{t("reporter.actionedBody")}</p>
      ) : (
        <dl className="grid gap-x-6 gap-y-4 px-5 pt-5 sm:grid-cols-[9.5rem_minmax(0,1fr)] sm:px-6">
          {facts ? <Row term={t("facts")}>{facts}</Row> : null}
          {decision.details ? (
            <Row term={t("details")}>
              <blockquote dir="auto" className="border-s-2 border-border-strong ps-3 whitespace-pre-line break-words [unicode-bidi:plaintext]">
                {decision.details}
              </blockquote>
            </Row>
          ) : null}
          <Row term={t("ground")}>
            <span className="flex flex-col gap-1">
              <bdi lang="fr" className="font-medium">
                {decision.ground.ref}
              </bdi>
              {texts.explanation ? <span className="text-foreground-muted">{texts.explanation}</span> : null}
            </span>
          </Row>
          {reporter ? null : <Row term={t("origin")}>{t(`origins.${decision.origin}`)}</Row>}
          <Row term={t("automation")}>{t(`automations.${automation}`)}</Row>
        </dl>
      )}

      <footer className="mt-5 flex flex-col gap-4 border-t border-border bg-surface-muted/60 px-5 py-5 sm:px-6">
        <AppealPart
          status={status}
          decision={decision}
          showForm={showForm}
          filed={filed}
          date={date}
          form={
            <AppealForm
              decisionId={decision.decisionId}
              mode={mode}
              onCancel={formOpen ? undefined : () => setShowForm(false)}
              onFiled={(response) => {
                setDecision((current) => withAppeal(current, response));
                setFiled(true);
              }}
            />
          }
          onStart={() => setShowForm(true)}
        />
        <p className="text-xs text-foreground-muted">
          {t("reference", { id: isolateLtr(decision.decisionId) })}
        </p>
      </footer>
    </article>
  );
}

function Row({ term, children }: { term: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:contents">
      <dt className="text-sm font-medium text-foreground-muted">{term}</dt>
      <dd className="text-pretty">{children}</dd>
    </div>
  );
}

interface AppealPartProps {
  status: AppealStatus;
  decision: AppealableDecision;
  showForm: boolean;
  filed: boolean;
  date: (iso: string) => string;
  form: ReactNode;
  onStart: () => void;
}

function AppealPart({ status, decision, showForm, filed, date, form, onStart }: AppealPartProps) {
  const t = useTranslations("Appeals");
  const deadline = date(decision.appealDeadline);
  if (status === "form") {
    return (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-pretty">{decision.by === "reporter" ? t("appeal.reporterIntro", { date: deadline }) : t("appeal.intro", { date: deadline })}</p>
        {showForm ? (
          form
        ) : (
          <Button type="button" variant="structure" className="self-start max-sm:h-11" onClick={onStart}>
            <Scale aria-hidden="true" />
            {t("appeal.start")}
          </Button>
        )}
      </div>
    );
  }
  if (decision.appeal) {
    const appeal = decision.appeal;
    const answered = appeal.closedAt !== null;
    return (
      <div className="flex flex-col gap-3">
        {filed ? (
          <p role="status" className="font-medium text-success">
            {t("appeal.sent")}
          </p>
        ) : null}
        <h3 className="text-sm font-semibold">{t("appeal.timeline")}</h3>
        <ol className="flex flex-col" data-testid="appeal-timeline">
          <Step label={t("appeal.decided")} detail={date(decision.createdAt)} done />
          <Step label={t("appeal.filed")} detail={date(appeal.openedAt)} done />
          <Step
            label={t("appeal.answer")}
            detail={answered && appeal.closedAt ? date(appeal.closedAt) : appeal.slaDueAt ? t("appeal.answerBy", { date: date(appeal.slaDueAt) }) : null}
            done={answered}
            current={!answered}
            last
          >
            {answered ? (
              <div className="flex flex-col gap-2">
                <p className="font-medium">{appeal.status === "reversed" ? t("appeal.reversed") : t("appeal.upheld")}</p>
                {appeal.note ? (
                  <figure className="flex flex-col gap-1">
                    <figcaption className="text-xs text-foreground-muted">{t("appeal.note")}</figcaption>
                    <blockquote dir="auto" className="border-s-2 border-border-strong ps-3 text-sm whitespace-pre-line break-words [unicode-bidi:plaintext]">
                      {appeal.note}
                    </blockquote>
                  </figure>
                ) : null}
              </div>
            ) : null}
          </Step>
        </ol>
      </div>
    );
  }
  const note = status === "expired" ? t("appeal.expired", { date: deadline }) : status === "authority" ? t("appeal.authority") : status === "superseded" ? t("appeal.superseded") : null;
  return note ? <p className="text-sm text-foreground-muted text-pretty">{note}</p> : null;
}

interface StepProps {
  label: string;
  detail: string | null;
  done?: boolean;
  current?: boolean;
  last?: boolean;
  children?: ReactNode;
}

/** One step of the appeal's sequence: decision, appeal filed, answer. */
function Step({ label, detail, done, current, last, children }: StepProps) {
  return (
    <li className="relative flex gap-3 pb-4 last:pb-0" aria-current={current ? "step" : undefined}>
      {last ? null : <span aria-hidden="true" className="absolute start-[0.4375rem] top-4 bottom-0 w-px bg-border-strong" />}
      <span
        aria-hidden="true"
        className={cn(
          "relative mt-1 size-3.5 shrink-0 rounded-full border-2",
          done ? "border-structure bg-structure" : current ? "border-featured bg-surface ring-4 ring-featured/25" : "border-border-strong bg-surface",
        )}
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <p className="text-sm font-medium">{label}</p>
        {detail ? <p className="text-sm text-foreground-muted">{detail}</p> : null}
        {children ? <div className="mt-1">{children}</div> : null}
      </div>
    </li>
  );
}
