"use client";

import { useId, useState, type FormEvent } from "react";
import { CircleCheck, Clock, Star, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { FormMessage } from "@/components/auth/form-message";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { REVIEW_TEXT_MAX, REVIEW_TEXT_MIN } from "@/config/reviews";
import { Link } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import type { ReviewCreated } from "@/lib/contracts/reviews";
import { isolate } from "@/lib/i18n/bidi";
import { FREE_TEXT_ISSUES, firstStrictIssue, type FreeTextIssue } from "@/lib/moderation/free-text";
import { submitReview } from "@/lib/reviews/client";
import { cn } from "@/lib/utils";

// The buyer's review of a conversation (vitrine-avis §2), loaded on demand from the thread: a note
// from 1 to 5, a text of 20 to 1 000 characters screened as it is typed (the API screens it
// again), and the buyer's own statement that an exchange or a meeting took place. A text with
// sensitive data is held for a moderator instead of published.

export interface ReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  cid: string;
  sellerName: string;
  sellerPublicId: string;
  listingTitle: string;
  /** The review was taken: the thread stops offering it. */
  onDone: (created: ReviewCreated) => void;
}

type Problems = { rating?: boolean; text?: "short" | FreeTextIssue; confirm?: boolean };

export function textLength(text: string): number {
  return [...text.trim()].length;
}

export function ReviewDialog({ open, onOpenChange, cid, sellerName, sellerPublicId, listingTitle, onDone }: ReviewDialogProps) {
  const t = useTranslations("Reviews.dialog");
  const stars = useTranslations("Reviews");
  const issues = useTranslations("FreeText");
  const id = useId();
  const [rating, setRating] = useState(0);
  const [hover, setHover] = useState(0);
  const [text, setText] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [problems, setProblems] = useState<Problems>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [created, setCreated] = useState<ReviewCreated | null>(null);

  const length = textLength(text);
  const liveIssue = text.trim() ? firstStrictIssue(text.trim()) : null;
  const textProblem = liveIssue ?? problems.text;
  const shown = hover || rating;
  const name = isolate(sellerName);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (pending) return;
    const next: Problems = {};
    if (rating < 1) next.rating = true;
    if (liveIssue) next.text = liveIssue;
    else if (length < REVIEW_TEXT_MIN) next.text = "short";
    if (!confirmed) next.confirm = true;
    setProblems(next);
    if (Object.keys(next).length > 0) return;
    setPending(true);
    setError(undefined);
    try {
      const result = await submitReview({ cid, rating, text: text.trim(), exchangeConfirmed: true });
      setCreated(result);
      onDone(result);
    } catch (failure) {
      const issue = isApiError(failure, "invalid_text") ? (failure.details as { issue?: unknown } | undefined)?.issue : undefined;
      if (typeof issue === "string" && (FREE_TEXT_ISSUES as readonly string[]).includes(issue)) setProblems({ text: issue as FreeTextIssue });
      else setError(failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={open} onOpenChange={(value) => !pending && onOpenChange(value)}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="review-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:max-h-[88dvh] sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          {created ? (
            <div className="flex flex-col items-center gap-4 px-6 pt-10 pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center">
              <span className={cn("flex size-14 items-center justify-center rounded-full", created.status === "published" ? "bg-success-surface text-success" : "bg-warning-surface text-warning")}>
                {created.status === "published" ? <CircleCheck className="size-7" aria-hidden="true" /> : <Clock className="size-7" aria-hidden="true" />}
              </span>
              <Dialog.Title className="text-xl font-semibold text-balance">{created.status === "published" ? t("publishedTitle") : t("pendingTitle")}</Dialog.Title>
              <Dialog.Description className="max-w-sm text-sm text-pretty text-foreground-muted">
                {created.status === "published" ? t("publishedBody", { name }) : t("pendingBody")}
              </Dialog.Description>
              <div className="mt-2 flex w-full flex-col-reverse gap-2 sm:w-auto sm:flex-row">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline">
                    {t("close")}
                  </Button>
                </Dialog.Close>
                {created.status === "published" ? (
                  <Button asChild>
                    <Link href={`/profil/${sellerPublicId}#avis`} prefetch={false}>
                      {t("viewStorefront")}
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : (
            <form onSubmit={(event) => void onSubmit(event)} noValidate className="flex min-h-0 flex-1 flex-col">
              <header className="flex items-start gap-3 border-b border-border px-5 pt-5 pb-4 sm:px-6">
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <Dialog.Title className="text-xl font-semibold text-balance">{t("title", { name })}</Dialog.Title>
                  <Dialog.Description dir="auto" className="truncate text-sm text-foreground-muted">
                    {t("listing", { title: isolate(listingTitle) })}
                  </Dialog.Description>
                </div>
                <Dialog.Close asChild>
                  <Button type="button" variant="ghost" size="icon" className="-me-2 -mt-1 shrink-0" aria-label={t("close")} disabled={pending}>
                    <X aria-hidden="true" />
                  </Button>
                </Dialog.Close>
              </header>

              <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
                <FormMessage error={error} />
                <fieldset className="flex flex-col gap-2" aria-describedby={problems.rating && rating < 1 ? `${id}-rating-error` : undefined}>
                  <legend className="mb-1 text-sm font-medium">{t("rating")}</legend>
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="flex items-center" onMouseLeave={() => setHover(0)}>
                      {[1, 2, 3, 4, 5].map((value) => (
                        <label key={value} className="group relative cursor-pointer p-1" onMouseEnter={() => setHover(value)}>
                          <input
                            type="radio"
                            name={`${id}-rating`}
                            value={value}
                            checked={rating === value}
                            onChange={() => {
                              setRating(value);
                              setProblems((current) => ({ ...current, rating: undefined }));
                            }}
                            className="peer sr-only"
                          />
                          <span className="sr-only">{stars("stars", { count: value })}</span>
                          <Star
                            aria-hidden="true"
                            strokeWidth={1.5}
                            className={cn(
                              "size-9 rounded-sm transition-transform duration-150 ease-door group-active:scale-90 peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-ring",
                              value <= shown ? "fill-featured text-featured" : "text-border-strong",
                            )}
                          />
                        </label>
                      ))}
                    </div>
                    <p aria-live="polite" className={cn("text-sm font-medium", shown ? "text-foreground" : "text-foreground-muted")}>
                      {shown ? t(`words.${shown as 1 | 2 | 3 | 4 | 5}`) : t("ratingHint")}
                    </p>
                  </div>
                  {problems.rating && rating < 1 ? <InlineError id={`${id}-rating-error`}>{t("problems.rating")}</InlineError> : null}
                </fieldset>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-text`} className="text-sm font-medium">
                    {t("text")}
                  </label>
                  <textarea
                    id={`${id}-text`}
                    rows={4}
                    maxLength={REVIEW_TEXT_MAX}
                    value={text}
                    dir="auto"
                    aria-invalid={textProblem ? true : undefined}
                    aria-describedby={`${id}-text-help`}
                    onChange={(event) => {
                      setText(event.target.value);
                      setProblems((current) => ({ ...current, text: undefined }));
                    }}
                    className={cn(inputClassName, "h-auto min-h-28 py-3 leading-relaxed")}
                  />
                  <div id={`${id}-text-help`} className="flex items-start justify-between gap-4">
                    {textProblem ? (
                      <InlineError>{textProblem === "short" ? t("problems.short", { count: REVIEW_TEXT_MIN - length }) : issues(textProblem)}</InlineError>
                    ) : (
                      <p className="text-sm text-pretty text-foreground-muted">{t("textHint")}</p>
                    )}
                    <p className={cn("shrink-0 text-xs tabular-nums", length < REVIEW_TEXT_MIN ? "text-foreground-muted" : length > REVIEW_TEXT_MAX - 50 ? "text-warning" : "text-success")}>
                      {t("count", { count: length, max: REVIEW_TEXT_MAX })}
                    </p>
                  </div>
                </div>

                <div className="flex flex-col gap-1.5">
                  <label htmlFor={`${id}-confirm`} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
                    <input
                      id={`${id}-confirm`}
                      type="checkbox"
                      checked={confirmed}
                      aria-required="true"
                      aria-invalid={problems.confirm && !confirmed ? true : undefined}
                      aria-describedby={`${id}-confirm-hint`}
                      onChange={(event) => {
                        setConfirmed(event.target.checked);
                        setProblems((current) => ({ ...current, confirm: undefined }));
                      }}
                      className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-primary"
                    />
                    <span className="font-medium text-pretty">{t("confirm")}</span>
                  </label>
                  {problems.confirm && !confirmed ? <InlineError className="ps-8">{t("problems.confirm")}</InlineError> : null}
                  <p id={`${id}-confirm-hint`} className="ps-8 text-sm text-pretty text-foreground-muted">
                    {t("confirmHint")}
                  </p>
                </div>

                <p className="rounded-md bg-surface-muted p-3 text-xs text-pretty text-foreground-muted">{t("public")}</p>
              </div>

              <footer className="flex flex-col-reverse gap-2 border-t border-border px-5 pt-4 pb-[max(1rem,env(safe-area-inset-bottom))] sm:flex-row sm:justify-end sm:px-6">
                <Dialog.Close asChild>
                  <Button type="button" variant="outline" disabled={pending}>
                    {t("cancel")}
                  </Button>
                </Dialog.Close>
                <Button type="submit" loading={pending}>
                  {t("submit")}
                </Button>
              </footer>
            </form>
          )}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
