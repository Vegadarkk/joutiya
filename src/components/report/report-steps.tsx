"use client";

import { useId, useState, type ReactNode } from "react";
import { Check, Copy, Siren } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { Textarea } from "@/components/post/controls/textarea";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { reportReason, type ReportReason } from "@/config/report-reasons";
import { REPORT_EXPLANATION_MAX, REPORT_EXPLANATION_MIN } from "@/lib/contracts/endpoints";
import { cn } from "@/lib/utils";
import { contactNeed, EMAIL_MAX, NAME_MAX, slaDelay, type DraftProblem, type DraftProblems, type ReasonGroup, type ReportDraft, type ReportReceipt } from "./report-state";

// The steps of the notice form (art. 16 DSA, design D10), stateless: the reason (grouped by ground,
// the urgent ones marked, the ground shown once chosen), the details (explanation, a visitor's name
// and e-mail, the good-faith statement), and the receipt with the reference and the target delay.

/** Reason texts exist in French and Arabic; Tarifit reads the French ones. */
export function reasonText(reason: Pick<ReportReason, "label" | "hint">, locale: string): { label: string; hint: string } {
  const lang = locale === "ar" ? "ar" : "fr";
  return { label: reason.label[lang], hint: reason.hint[lang] };
}

export interface ReasonStepProps {
  groups: ReasonGroup[];
  value: string | null;
  onChange: (reasonId: string) => void;
  error?: ReactNode;
}

export function ReasonStep({ groups, value, onChange, error }: ReasonStepProps) {
  const t = useTranslations("Report");
  const locale = useLocale();
  const name = useId();
  return (
    <fieldset className="flex flex-col gap-5" aria-describedby={error ? `${name}-error` : undefined}>
      <legend className="mb-4 font-medium">{t("reasonLegend")}</legend>
      {groups.map((group) => (
        <div key={group.ground} role="group" aria-labelledby={`${name}-${group.ground}`} className="flex flex-col gap-2">
          <div className="flex flex-col">
            <h3 id={`${name}-${group.ground}`} className="text-sm font-semibold">
              {t(`group.${group.ground}`)}
            </h3>
            <p className="text-xs text-foreground-muted">{t(`groupHint.${group.ground}`)}</p>
          </div>
          <ul className="flex flex-col gap-1.5">
            {group.reasons.map((reason) => {
              const text = reasonText(reason, locale);
              const checked = value === reason.id;
              return (
                <li key={reason.id}>
                  <label
                    data-testid={`reason-${reason.id}`}
                    className={cn(
                      "flex min-h-11 cursor-pointer items-start gap-3 rounded-md border px-3 py-2.5 transition-[border-color,background-color] duration-150 ease-door",
                      checked ? "border-structure bg-bab-50 dark:border-gold-300 dark:bg-surface-muted" : "border-border hover:border-border-strong",
                    )}
                  >
                    <input type="radio" name={name} value={reason.id} checked={checked} onChange={() => onChange(reason.id)} className="mt-1 size-4 shrink-0 cursor-pointer accent-structure" />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-x-2 gap-y-1 font-medium">
                        {text.label}
                        {reason.priority === "P0" ? <Badge variant="warning">{t("urgent")}</Badge> : null}
                      </span>
                      <span className="text-sm text-foreground-muted text-pretty">{text.hint}</span>
                      {checked ? (
                        <span className="text-xs text-foreground-muted">
                          {t("ground")}{" "}
                          <bdi lang="fr">{reason.ground.ref}</bdi>
                        </span>
                      ) : null}
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      {error ? <InlineError id={`${name}-error`}>{error}</InlineError> : null}
    </fieldset>
  );
}

export interface DetailsStepProps {
  reason: ReportReason;
  draft: ReportDraft;
  signedIn: boolean;
  /** Shown after a submission attempt. */
  problems: DraftProblems;
  onChange: (patch: Partial<ReportDraft>) => void;
  onChangeReason: () => void;
  /** The Turnstile widget, when this notice needs one. */
  challenge?: ReactNode;
}

function problemText(t: ReturnType<typeof useTranslations<"Report">>, field: "explanation" | "name" | "email", problem: DraftProblem | undefined): string | undefined {
  if (!problem) return undefined;
  if (field === "email") return t(`problems.email.${problem === "required" ? "required" : "invalid"}`);
  if (field === "name") return t(`problems.name.${problem}`);
  return t(`problems.explanation.${problem}`, { min: REPORT_EXPLANATION_MIN, max: REPORT_EXPLANATION_MAX });
}

export function DetailsStep({ reason, draft, signedIn, problems, onChange, onChangeReason, challenge }: DetailsStepProps) {
  const t = useTranslations("Report");
  const locale = useLocale();
  const id = useId();
  const text = reasonText(reason, locale);
  const need = contactNeed(reason, signedIn);
  const remaining = REPORT_EXPLANATION_MAX - draft.explanation.length;
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-start justify-between gap-3 rounded-md bg-surface-muted px-3 py-2.5">
        <p className="flex min-w-0 flex-col gap-0.5 text-sm">
          <span className="text-foreground-muted">{t("reason")}</span>
          <span className="font-medium" data-testid="report-reason">
            {text.label}
          </span>
          <span className="text-xs text-foreground-muted">
            {t("ground")}{" "}
            <bdi lang="fr">{reason.ground.ref}</bdi>
          </span>
        </p>
        <Button type="button" variant="link" size="sm" className="shrink-0 max-sm:min-h-11" onClick={onChangeReason}>
          {t("change")}
        </Button>
      </div>

      {reason.priority === "P0" ? (
        <p role="note" className="flex gap-2.5 rounded-md border border-warning/30 bg-warning-surface px-3 py-2.5 text-sm text-foreground">
          <Siren className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span className="text-pretty">{t("emergency")}</span>
        </p>
      ) : null}

      <Field label={t("explanation")} hint={t("explanationHint", { min: REPORT_EXPLANATION_MIN })} error={problemText(t, "explanation", problems.explanation)} required>
        <Textarea
          rows={4}
          dir="auto"
          value={draft.explanation}
          maxLength={REPORT_EXPLANATION_MAX}
          placeholder={t("explanationPlaceholder")}
          className="min-h-28"
          onChange={(event) => onChange({ explanation: event.target.value })}
        />
      </Field>
      {remaining <= 200 ? (
        <p className="-mt-3 text-end text-xs text-foreground-muted tabular-nums" aria-live="polite">
          {t("remaining", { count: remaining })}
        </p>
      ) : null}

      {need === "none" ? (
        <p className="text-sm text-foreground-muted text-pretty">
          {t("member")} {t("anonymity")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-foreground-muted text-pretty">
            {need === "optional" ? t("contactOptional") : t("contactHint")} {t("anonymity")}
          </p>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={t("name")} error={problemText(t, "name", problems.name)} required={need === "required"}>
              <Input value={draft.name} maxLength={NAME_MAX} autoComplete="name" dir="auto" onChange={(event) => onChange({ name: event.target.value })} />
            </Field>
            <Field label={t("email")} error={problemText(t, "email", problems.email)} required={need === "required"}>
              <Input type="email" value={draft.email} maxLength={EMAIL_MAX} autoComplete="email" inputMode="email" dir="ltr" onChange={(event) => onChange({ email: event.target.value })} />
            </Field>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${id}-faith`} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
          <input
            id={`${id}-faith`}
            type="checkbox"
            checked={draft.goodFaith}
            aria-invalid={problems.goodFaith ? true : undefined}
            aria-describedby={problems.goodFaith ? `${id}-faith-error` : undefined}
            onChange={(event) => onChange({ goodFaith: event.target.checked })}
            className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
          />
          <span className="text-pretty">{t("goodFaith")}</span>
        </label>
        {problems.goodFaith ? (
          <InlineError id={`${id}-faith-error`} className="ps-8">
            {t("problems.goodFaith")}
          </InlineError>
        ) : null}
      </div>

      {challenge}

      <p className="text-xs text-foreground-muted text-pretty">{t("host")}</p>
    </div>
  );
}

export interface ReceiptProps {
  receipt: ReportReceipt;
}

/** The notice's receipt: an arch, the reference to keep, the target delay (art. 16(4)-(5)). */
export function Receipt({ receipt }: ReceiptProps) {
  const t = useTranslations("Report");
  const [copied, setCopied] = useState(false);
  const delay = slaDelay(receipt.slaHours);
  const delayText = delay.unit === "hour" ? t("delay.hour") : t(`delay.${delay.unit}`, { count: delay.count });

  async function copy() {
    try {
      await navigator.clipboard.writeText(receipt.reportId);
      setCopied(true);
    } catch {
      // Clipboard refused (permissions, insecure context): the reference stays selectable.
    }
  }

  return (
    <div data-testid="report-receipt" data-duplicate={receipt.duplicate} className="flex flex-col items-center gap-5 text-center">
      <div className="relative mt-2 flex w-full max-w-xs flex-col items-center gap-3 rounded-[var(--radius-arch)] border border-border bg-surface-brand px-6 pt-10 pb-6 motion-safe:animate-in motion-safe:fade-in-0 motion-safe:zoom-in-95">
        <span className="flex size-12 items-center justify-center rounded-full bg-structure text-structure-foreground">
          <Check className="size-6" aria-hidden="true" />
        </span>
        <p className="text-sm text-foreground-muted">{t("reference")}</p>
        <p dir="ltr" data-testid="report-reference" className="text-lg font-semibold tracking-wide break-all select-all tabular-nums">
          {receipt.reportId}
        </p>
        <span aria-hidden="true" className="absolute inset-x-6 bottom-0 h-1 rounded-full bg-featured" />
      </div>
      <Button type="button" variant="ghost" size="sm" className="max-sm:min-h-11" onClick={() => void copy()}>
        {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        <span aria-live="polite">{copied ? t("copied") : t("copy")}</span>
      </Button>
      <div className="flex max-w-sm flex-col gap-2 text-pretty">
        <p>{receipt.duplicate ? t("duplicateBody", { delay: delayText }) : t("sentBody", { delay: delayText })}</p>
        <p className="text-sm text-foreground-muted">{receipt.mailed ? t("mailed") : t("notMailed")}</p>
      </div>
    </div>
  );
}

/** The reason of a draft, when it is one of the target's. */
export function chosenReason(draft: ReportDraft, groups: ReasonGroup[]): ReportReason | undefined {
  const reason = draft.reasonId ? reportReason(draft.reasonId) : undefined;
  return reason && groups.some((group) => group.reasons.includes(reason)) ? reason : undefined;
}
