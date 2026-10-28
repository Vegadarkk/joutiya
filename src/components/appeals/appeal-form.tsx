"use client";

import { useState, type FormEvent } from "react";
import { useLocale, useTranslations } from "next-intl";
import { formatWait, FormMessage } from "@/components/auth/form-message";
import { Textarea } from "@/components/post/controls/textarea";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { ApiError } from "@/lib/auth/client";
import { APPEAL_TEXT_MAX, APPEAL_TEXT_MIN } from "@/lib/contracts/endpoints";
import { openAppeal, openLinkAppeal } from "@/lib/decisions/client";
import type { OpenAppealResponse } from "@/lib/decisions/contracts";

// The appeal of one decision (art. 20 DSA, design D16): the reasons in the appellant's words. A
// member appeals with the session; the mail's signed link appeals without one (banned accounts,
// notifiers without an account). The refusal codes (appeal_exists, appeal_closed,
// appeal_not_allowed) read from Auth.errors.

export type AppealMode = { kind: "member" } | { kind: "link"; token: string };

export interface AppealFormProps {
  decisionId: string;
  mode: AppealMode;
  onFiled: (response: OpenAppealResponse) => void;
  onCancel?: () => void;
}

/** The text's problem, if any, once the appellant tries to send. */
export function appealTextProblem(text: string): "short" | null {
  return text.trim().length < APPEAL_TEXT_MIN ? "short" : null;
}

export function AppealForm({ decisionId, mode, onFiled, onCancel }: AppealFormProps) {
  const t = useTranslations("Appeals");
  const locale = useLocale();
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<"short" | null>(null);
  const [error, setError] = useState<unknown>(undefined);
  const [pending, setPending] = useState(false);
  const remaining = APPEAL_TEXT_MAX - text.length;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    const found = appealTextProblem(text);
    setProblem(found);
    if (found) return;
    setPending(true);
    setError(undefined);
    try {
      const value = text.trim();
      onFiled(mode.kind === "link" ? await openLinkAppeal(mode.token, value) : await openAppeal(decisionId, value));
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  const code = error instanceof ApiError ? error.code : null;
  const title =
    code === "rate_limited"
      ? t("errors.rate_limited", { wait: formatWait(locale, error instanceof ApiError ? error.retryAfter : undefined, t("errors.later")) })
      : code === "not_found" || code === "unavailable"
        ? t(`errors.${code}`)
        : error !== undefined && !(error instanceof ApiError)
          ? t("errors.unavailable")
          : undefined;

  return (
    <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex flex-col gap-4" data-testid="appeal-form">
      <Field label={t("appeal.label")} hint={t("appeal.hint", { min: APPEAL_TEXT_MIN })} error={problem ? t("appeal.short", { min: APPEAL_TEXT_MIN }) : undefined} required>
        <Textarea rows={5} dir="auto" value={text} maxLength={APPEAL_TEXT_MAX} className="min-h-32" onChange={(event) => setText(event.target.value)} />
      </Field>
      {remaining <= 200 ? (
        <p className="-mt-3 text-end text-xs text-foreground-muted tabular-nums" aria-live="polite">
          {t("appeal.remaining", { count: remaining })}
        </p>
      ) : null}
      <FormMessage error={error} title={title} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        {onCancel ? (
          <Button type="button" variant="outline" disabled={pending} onClick={onCancel}>
            {t("appeal.cancel")}
          </Button>
        ) : null}
        <Button type="submit" loading={pending}>
          {t("appeal.submit")}
        </Button>
      </div>
    </form>
  );
}
