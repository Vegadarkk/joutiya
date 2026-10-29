import { BadgeCheck, CornerDownRight } from "lucide-react";
import { ReportButton } from "@/components/report/report-button";
import type { Locale } from "@/config/site";
import type { ReviewView } from "@/lib/contracts/reviews";
import { intlLocale } from "@/lib/listings/client/format";
import { cn } from "@/lib/utils";
import { Stars } from "./stars";

// One published review (vitrine-avis §2) as the storefront shows it: stars, the author's display
// name (never a link: the buyer's profile is not exposed), the "verified exchange" mark, the
// listing it is about, the text, the seller's one reply and "Signaler l'avis" (art. 16 DSA). No
// hooks: the server renders the first page and the "more" button renders the next ones with the
// same labels.

export interface ReviewItemLabels {
  /** "1 étoile sur 5" … "5 étoiles sur 5". */
  stars: readonly string[];
  verified: string;
  verifiedHint: string;
  /** "Annonce :" before the listing title. */
  listing: string;
  /** "Échange du" before the exchange date (the seller's first reply, art. D111-17 C. conso). */
  exchangeOn: string;
  /** "Réponse de {seller}", already filled. */
  reply: string;
  /** The author closed the account: the name is gone. */
  formerMember: string;
}

export function formatReviewDate(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "long", year: "numeric", timeZone: "Africa/Casablanca" }).format(new Date(at));
}

/** The DSA contact (config/legal) and the storefront's canonical URL: the report form's e-mail stand-in. */
export interface ReviewReportContext {
  email: string;
  url: string;
}

export function ReviewItem({ review, labels, locale, report, className }: { review: ReviewView; labels: ReviewItemLabels; locale: Locale; report?: ReviewReportContext; className?: string }) {
  return (
    <article data-testid="review" className={cn("flex flex-col gap-3 py-6 first:pt-0", className)}>
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Stars value={review.rating} label={labels.stars[review.rating - 1]} />
        {review.authorName ? (
          <p dir="auto" className="font-semibold">
            {review.authorName}
          </p>
        ) : (
          <p className="font-semibold text-foreground-muted">{labels.formerMember}</p>
        )}
        <span className="inline-flex items-center gap-1 text-xs font-medium text-success" title={labels.verifiedHint}>
          <BadgeCheck className="size-3.5 shrink-0" aria-hidden="true" />
          {labels.verified}
        </span>
        <time dateTime={new Date(review.createdAt).toISOString()} className="text-sm text-foreground-muted sm:ms-auto">
          {formatReviewDate(review.createdAt, locale)}
        </time>
      </header>
      <p className="flex flex-wrap gap-x-1.5 text-sm text-foreground-muted">
        <span>
          {labels.listing}{" "}
          <span dir="auto" className="text-foreground">
            {review.listingTitle}
          </span>
        </span>
        <span aria-hidden="true">·</span>
        <span>
          {labels.exchangeOn} <time dateTime={new Date(review.experienceAt).toISOString()}>{formatReviewDate(review.experienceAt, locale)}</time>
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
              {labels.reply}
              <span className="font-normal text-foreground-muted"> · {formatReviewDate(review.reply.at, locale)}</span>
            </p>
            <p dir="auto" className="text-sm whitespace-pre-line text-pretty break-words">
              {review.reply.text}
            </p>
          </div>
        </div>
      ) : null}
      {report ? (
        <ReportButton compact target={{ type: "review", id: review.id }} subject={review.authorName || labels.formerMember} quote={review.text} email={report.email} url={report.url} />
      ) : null}
    </article>
  );
}
