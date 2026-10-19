"use client";

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { LogIn, X } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { formatWait, FormMessage } from "@/components/auth/form-message";
import { TurnstileWidget, type TurnstileHandle } from "@/components/auth/turnstile-widget";
import { Button } from "@/components/ui/button";
import { Link, usePathname } from "@/i18n/navigation";
import { ApiError, useSession } from "@/lib/auth/client";
import { isolate } from "@/lib/i18n/bidi";
import { submitReport } from "@/lib/reports/client";
import { cn } from "@/lib/utils";
import { chosenReason, DetailsStep, Receipt, ReasonStep } from "./report-steps";
import {
  draftProblems,
  EMPTY_DRAFT,
  reasonGroups,
  reportFailure,
  reportRequest,
  type DraftProblems,
  type ReportContext,
  type ReportDraft,
  type ReportFailure,
  type ReportReceipt,
  type ReportTarget,
} from "./report-state";

// The notice-and-action form (art. 16 DSA, design D10), loaded on demand by the report buttons of
// the listing and profile pages and by the messaging pages. Two steps (the reason, then the facts
// and the good-faith statement) and a receipt with the reference and the target delay. Visitors
// give a name and an e-mail (optional for P0) and pass Turnstile; a member reports with the account
// and meets Turnstile only past the IP allowance (403 turnstile_required). An open notice of the
// same reporter on the same target answers its own receipt (200, duplicate).

export interface ReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: ReportTarget;
  context: ReportContext;
  /** Listing title (listing) or the person's display name (profile, conversation, message). */
  subject?: string;
  /** The reported message, as its reader sees it (message context). */
  quote?: string;
  /** DSA point of contact (config/legal), offered when the form cannot send. */
  fallbackEmail?: string;
}

type Step = "reason" | "details" | "done";

export function ReportDialog({ open, onOpenChange, target, context, subject, quote, fallbackEmail }: ReportDialogProps) {
  const t = useTranslations("Report");
  const locale = useLocale();
  const pathname = usePathname();
  const { session } = useSession();
  const signedIn = session !== null;
  const groups = useMemo(() => reasonGroups(target.type), [target.type]);
  const turnstile = useRef<TurnstileHandle>(null);
  const stepHeading = useRef<HTMLDivElement>(null);
  const [step, setStep] = useState<Step>("reason");
  const [draft, setDraft] = useState<ReportDraft>(EMPTY_DRAFT);
  const [problems, setProblems] = useState<DraftProblems>({});
  const [failure, setFailure] = useState<{ error: unknown; kind: ReportFailure } | null>(null);
  const [pending, setPending] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  /** A member asked for the check by the server (403 turnstile_required). */
  const [challenged, setChallenged] = useState(false);
  const [challengeMissing, setChallengeMissing] = useState(false);
  const [receipt, setReceipt] = useState<ReportReceipt | null>(null);

  const reason = chosenReason(draft, groups);
  const needsChallenge = !signedIn || challenged;

  // A new step: focus its start, so screen readers and keyboards follow.
  useEffect(() => {
    if (open) stepHeading.current?.focus({ preventScroll: true });
  }, [step, open]);

  function reset() {
    setStep("reason");
    setDraft(EMPTY_DRAFT);
    setProblems({});
    setFailure(null);
    setReceipt(null);
    setChallenged(false);
  }

  function change(next: boolean) {
    if (pending) return;
    onOpenChange(next);
    // A receipt is final: the next opening starts a new notice. A draft survives an accidental close.
    if (!next && step === "done") reset();
  }

  function update(patch: Partial<ReportDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    if (Object.keys(problems).length > 0) setProblems((current) => withoutFields(current, patch));
  }

  function next() {
    if (!reason) {
      setProblems({ reasonId: "required" });
      return;
    }
    setProblems({});
    setStep("details");
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (step === "reason") {
      next();
      return;
    }
    if (pending || step !== "details") return;
    const found = draftProblems(draft, signedIn);
    setProblems(found);
    if (Object.keys(found).length > 0) return;
    if (needsChallenge && !token) {
      setChallengeMissing(true);
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      const response = await submitReport(reportRequest(target, draft, signedIn, needsChallenge ? token : null));
      setReceipt({ ...response, mailed: signedIn || draft.email.trim().length > 0 });
      setStep("done");
    } catch (error) {
      const kind = reportFailure(error);
      if (kind.kind === "challenge") setChallenged(true);
      if (kind.kind === "fields") setProblems(kind.fields);
      else setFailure({ error, kind });
    } finally {
      setPending(false);
      // A token is single use: a fresh one for the next attempt, whatever happened.
      setToken(null);
      turnstile.current?.reset();
    }
  }

  const titleValues = { name: isolate(subject ?? ""), title: isolate(subject ?? "") };
  const nextPath = `/${locale}${pathname === "/" ? "" : pathname}`;

  return (
    <Dialog.Root open={open} onOpenChange={change}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="report-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex min-h-0 flex-1 flex-col">
            <header className="flex items-start gap-3 border-b border-border px-5 pt-5 pb-4 sm:px-6">
              <div ref={stepHeading} tabIndex={-1} className="flex min-w-0 flex-1 flex-col gap-1 outline-none">
                <Dialog.Title className="text-xl font-semibold text-balance">{step === "done" && receipt ? (receipt.duplicate ? t("duplicate") : t("sent")) : t(`title.${context}`, titleValues)}</Dialog.Title>
                <Dialog.Description className={cn("text-sm text-foreground-muted text-pretty", !subject && "sr-only")}>
                  {subject ? t(`subject.${context}`, titleValues) : t(`title.${context}`, titleValues)}
                </Dialog.Description>
                {quote && step !== "done" ? (
                  <blockquote dir="auto" className="mt-1 line-clamp-3 border-s-2 border-border-strong ps-3 text-sm break-words text-foreground [unicode-bidi:plaintext]">
                    {quote}
                  </blockquote>
                ) : null}
              </div>
              <Dialog.Close asChild>
                <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-1 shrink-0" aria-label={t("close")} disabled={pending}>
                  <X aria-hidden="true" />
                </Button>
              </Dialog.Close>
            </header>

            <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
              {step === "reason" ? (
                <ReasonStep
                  groups={groups}
                  value={draft.reasonId}
                  onChange={(reasonId) => {
                    update({ reasonId });
                    setProblems({});
                  }}
                  error={problems.reasonId ? t("problems.reasonId") : undefined}
                />
              ) : step === "details" && reason ? (
                <div className="flex flex-col gap-5">
                  <DetailsStep
                    reason={reason}
                    draft={draft}
                    signedIn={signedIn}
                    problems={problems}
                    onChange={update}
                    onChangeReason={() => setStep("reason")}
                    challenge={
                      needsChallenge ? (
                        <TurnstileWidget
                          ref={turnstile}
                          action="report"
                          cData={`report-${context}`}
                          onToken={(value) => {
                            setToken(value);
                            if (value) setChallengeMissing(false);
                          }}
                          error={challengeMissing || failure?.kind.kind === "challenge" ? t("challenge") : undefined}
                        />
                      ) : null
                    }
                  />
                  {failure ? <FailureMessage failure={failure} fallbackEmail={fallbackEmail} next={nextPath} /> : null}
                </div>
              ) : receipt ? (
                <Receipt receipt={receipt} />
              ) : null}
            </div>

            <footer className="flex flex-col-reverse gap-2 border-t border-border px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:px-6">
              {step === "done" ? (
                <Dialog.Close asChild>
                  <Button type="button">{t("close")}</Button>
                </Dialog.Close>
              ) : step === "details" ? (
                <>
                  <Button type="button" variant="outline" disabled={pending} onClick={() => setStep("reason")}>
                    {t("back")}
                  </Button>
                  <Button type="submit" loading={pending}>
                    {t("submit")}
                  </Button>
                </>
              ) : (
                <>
                  <Dialog.Close asChild>
                    <Button type="button" variant="outline">
                      {t("cancel")}
                    </Button>
                  </Dialog.Close>
                  <Button type="submit">{t("continue")}</Button>
                </>
              )}
            </footer>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function withoutFields(problems: DraftProblems, patch: Partial<ReportDraft>): DraftProblems {
  const next = { ...problems };
  for (const key of Object.keys(patch) as (keyof ReportDraft)[]) delete next[key];
  return next;
}

export interface FailureMessageProps {
  failure: { error: unknown; kind: ReportFailure };
  fallbackEmail?: string;
  /** Where the sign-in brings the reporter back. */
  next: string;
}

/** A refused notice in the form's words: sign in again, the check again, or the reason why. */
export function FailureMessage({ failure, fallbackEmail, next }: FailureMessageProps) {
  const t = useTranslations("Report");
  const locale = useLocale();
  const { error, kind } = failure;
  if (kind.kind === "fields") return null;
  if (kind.kind === "challenge") return <FormMessage error={error} tone="info" title={t("challenge")} />;
  if (kind.kind === "signin") {
    return (
      <FormMessage
        error={error}
        tone="info"
        title={t("signInBody")}
        action={
          <Button asChild variant="structure" size="sm" className="max-sm:h-11">
            <Link href={{ pathname: "/connexion", query: { next } }}>
              <LogIn aria-hidden="true" />
              {t("signIn")}
            </Link>
          </Button>
        }
      />
    );
  }
  const key = kind.key;
  const title =
    key === "rate_limited"
      ? t("errors.rate_limited", { wait: formatWait(locale, error instanceof ApiError ? error.retryAfter : undefined, t("errors.later")) })
      : key
        ? t(`errors.${key}`)
        : undefined;
  const offerMail = fallbackEmail && (key === null || key === "unavailable" || key === "quota_exhausted");
  return (
    <FormMessage error={error} title={title}>
      {offerMail ? (
        <span>
          {t("errors.byMail")}{" "}
          <a href={`mailto:${fallbackEmail}`} dir="ltr" className="font-medium text-link underline underline-offset-4 hover:no-underline">
            {fallbackEmail}
          </a>
        </span>
      ) : null}
    </FormMessage>
  );
}
