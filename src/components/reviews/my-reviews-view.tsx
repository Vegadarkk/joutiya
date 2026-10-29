"use client";

import { useEffect, useId, useState, type FormEvent } from "react";
import { CornerDownRight, MessageSquareReply, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { InlineError } from "@/components/feedback/inline-error";
import { ConfirmDialog } from "@/components/post/controls/confirm-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { REVIEW_REPLY_MAX } from "@/config/reviews";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import type { MyReviewView } from "@/lib/contracts/reviews";
import { isolate } from "@/lib/i18n/bidi";
import { firstStrictIssue, FREE_TEXT_ISSUES, type FreeTextIssue } from "@/lib/moderation/free-text";
import { fetchMyReviews, removeReview, replyReview } from "@/lib/reviews/client";
import { cn } from "@/lib/utils";
import { formatReviewDate } from "./review-item";
import { Stars } from "./stars";

// "Mes avis" (vitrine-avis §2): the reviews I received as a seller (published ones, with my one
// public reply) and the ones I gave (with their state, and delete). Read from GET
// /api/account/reviews; the replies and deletes go through the reviews API.

type Side = "recus" | "donnes";
type View = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; reviews: MyReviewView[] };

export function MyReviewsView() {
  const t = useTranslations("Reviews.mine");
  const [side, setSide] = useState<Side>("recus");
  const [view, setView] = useState<View>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const tabsId = useId();

  useEffect(() => {
    let live = true;
    fetchMyReviews(side).then(
      (page) => live && setView({ kind: "ready", reviews: page.reviews }),
      (error: unknown) => live && setView({ kind: "failed", error }),
    );
    return () => {
      live = false;
    };
  }, [side, attempt]);

  function choose(next: Side) {
    if (next === side) return;
    setView({ kind: "loading" });
    setSide(next);
  }

  function replace(review: MyReviewView | null, id: string) {
    setView((current) => (current.kind === "ready" ? { ...current, reviews: review ? current.reviews.map((item) => (item.id === id ? review : item)) : current.reviews.filter((item) => item.id !== id) } : current));
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="max-w-prose text-pretty text-foreground-muted">{t("intro")}</p>
      </header>

      <div role="tablist" aria-label={t("tabs.label")} className="flex w-fit gap-1 rounded-lg bg-surface-muted p-1">
        {(["recus", "donnes"] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            id={`${tabsId}-${value}`}
            aria-selected={side === value}
            aria-controls={`${tabsId}-panel`}
            onClick={() => choose(value)}
            className={cn("min-h-10 rounded-md px-4 text-sm font-medium transition-colors", side === value ? "bg-surface text-foreground shadow-sm" : "text-foreground-muted hover:text-foreground")}
          >
            {value === "recus" ? t("tabs.received") : t("tabs.given")}
          </button>
        ))}
      </div>

      <div role="tabpanel" id={`${tabsId}-panel`} aria-labelledby={`${tabsId}-${side}`} data-testid="my-reviews">
        {view.kind === "loading" ? (
          <div role="status" aria-busy="true" className="flex flex-col gap-4">
            <span className="sr-only">{t("loading")}</span>
            {[0, 1, 2].map((key) => (
              <Skeleton key={key} className="h-32 w-full" />
            ))}
          </div>
        ) : view.kind === "failed" ? (
          <FormMessage
            error={view.error}
            action={
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => {
                  setView({ kind: "loading" });
                  setAttempt((count) => count + 1);
                }}
              >
                {t("retry")}
              </Button>
            }
          />
        ) : view.reviews.length === 0 ? (
          <EmptyState
            title={side === "recus" ? t("emptyReceived") : t("emptyGiven")}
            action={
              <Button asChild variant="outline">
                <Link href="/messages">{t("toMessages")}</Link>
              </Button>
            }
          >
            {side === "recus" ? t("emptyReceivedBody") : t("emptyGivenBody")}
          </EmptyState>
        ) : (
          <ul className="flex flex-col gap-4">
            {view.reviews.map((review) => (
              <li key={review.id}>
                <MyReviewCard review={review} side={side} onChange={(next) => replace(next, review.id)} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function MyReviewCard({ review, side, onChange }: { review: MyReviewView; side: Side; onChange: (next: MyReviewView | null) => void }) {
  const t = useTranslations("Reviews.mine");
  const stars = useTranslations("Reviews");
  const locale = useLocale() as Locale;
  const errorMessage = useApiErrorMessage();
  const [replying, setReplying] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const name = review.counterpartName ? isolate(review.counterpartName) : stars("formerMember");

  async function remove() {
    setDeleting(true);
    try {
      await removeReview(review.id);
      toast.success(t("deleted"));
      setConfirm(false);
      onChange(null);
    } catch (error) {
      toast.error(errorMessage(error));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article data-testid="my-review" className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Stars value={review.rating} label={stars("stars", { count: review.rating })} />
        <p className="font-semibold">{!review.counterpartName && side === "recus" ? t("fromFormer") : side === "recus" ? t("from", { name }) : t("to", { name })}</p>
        {review.status === "pending" ? <Badge variant="warning">{t("status.pending")}</Badge> : review.status === "hidden" ? <Badge variant="danger">{t("status.hidden")}</Badge> : null}
        <time dateTime={new Date(review.createdAt).toISOString()} className="text-sm text-foreground-muted sm:ms-auto">
          {formatReviewDate(review.createdAt, locale)}
        </time>
      </header>
      <p className="text-sm text-foreground-muted">
        {stars("listing")}{" "}
        <span dir="auto" className="text-foreground">
          {review.listingTitle}
        </span>
      </p>
      <p dir="auto" className="whitespace-pre-line text-pretty break-words">
        {review.text}
      </p>
      {review.reply ? (
        <div className="flex gap-3 rounded-md bg-surface-muted p-4">
          <CornerDownRight className="mt-0.5 size-4 shrink-0 text-foreground-muted rtl:-scale-x-100" aria-hidden="true" />
          <div className="flex min-w-0 flex-col gap-1">
            <p className="text-sm font-medium">
              {side === "recus" ? t("yourReply") : t("theirReply", { name })}
              <span className="font-normal text-foreground-muted"> · {formatReviewDate(review.reply.at, locale)}</span>
            </p>
            <p dir="auto" className="text-sm whitespace-pre-line text-pretty break-words">
              {review.reply.text}
            </p>
          </div>
        </div>
      ) : null}
      {replying ? (
        <ReplyForm
          id={review.id}
          onCancel={() => setReplying(false)}
          onDone={(reply) => {
            setReplying(false);
            onChange({ ...review, reply, canReply: false });
          }}
        />
      ) : review.canReply || review.canDelete ? (
        <div className="flex flex-wrap gap-2">
          {review.canReply ? (
            <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={() => setReplying(true)}>
              <MessageSquareReply aria-hidden="true" />
              {t("reply")}
            </Button>
          ) : null}
          {review.canDelete ? (
            <Button type="button" variant="ghost" size="sm" className="text-danger max-sm:h-11" onClick={() => setConfirm(true)}>
              <Trash2 aria-hidden="true" />
              {t("delete")}
            </Button>
          ) : null}
        </div>
      ) : null}
      <ConfirmDialog
        open={confirm}
        onOpenChange={(open) => !deleting && setConfirm(open)}
        title={t("deleteTitle")}
        body={t("deleteBody", { name })}
        cancelLabel={t("cancel")}
        confirmLabel={t("deleteConfirm")}
        loading={deleting}
        onConfirm={() => void remove()}
      />
    </article>
  );
}

function ReplyForm({ id, onCancel, onDone }: { id: string; onCancel: () => void; onDone: (reply: { text: string; at: number }) => void }) {
  const t = useTranslations("Reviews.mine");
  const issues = useTranslations("FreeText");
  const fieldId = useId();
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>();
  const [serverIssue, setServerIssue] = useState<FreeTextIssue | null>(null);
  const trimmed = text.trim();
  // The reply is public and checked by nobody: sensitive data is refused, not held.
  const issue = trimmed ? (firstStrictIssue(trimmed) ?? serverIssue) : null;

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!trimmed || issue || pending) return;
    setPending(true);
    setError(undefined);
    try {
      const review = await replyReview(id, trimmed);
      toast.success(t("replied"));
      if (review.reply) onDone(review.reply);
    } catch (failure) {
      const value = isApiError(failure, "invalid_text") ? (failure.details as { issue?: unknown } | undefined)?.issue : undefined;
      if (typeof value === "string" && (FREE_TEXT_ISSUES as readonly string[]).includes(value)) setServerIssue(value as FreeTextIssue);
      else setError(failure);
    } finally {
      setPending(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="flex flex-col gap-3 border-t border-border pt-4">
      <FormMessage error={error} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={fieldId} className="text-sm font-medium">
          {t("replyLabel")}
        </label>
        <textarea
          id={fieldId}
          rows={4}
          maxLength={REVIEW_REPLY_MAX}
          value={text}
          dir="auto"
          aria-invalid={issue ? true : undefined}
          aria-describedby={`${fieldId}-help`}
          onChange={(event) => {
            setText(event.target.value);
            setServerIssue(null);
          }}
          className={cn(inputClassName, "h-auto min-h-24 py-3 leading-relaxed")}
        />
        {issue ? (
          <InlineError id={`${fieldId}-help`}>{issues(issue)}</InlineError>
        ) : (
          <p id={`${fieldId}-help`} className="text-sm text-pretty text-foreground-muted">
            {t("replyHint")}
          </p>
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" className="max-sm:h-11" loading={pending} disabled={!trimmed || issue !== null}>
          {t("replySubmit")}
        </Button>
        <Button type="button" variant="ghost" size="sm" className="max-sm:h-11" disabled={pending} onClick={onCancel}>
          {t("cancel")}
        </Button>
      </div>
    </form>
  );
}
