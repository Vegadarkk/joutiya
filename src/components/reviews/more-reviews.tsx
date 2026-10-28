"use client";

import { useState } from "react";
import { ChevronDown } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import type { ReviewView } from "@/lib/contracts/reviews";
import { fetchSellerReviews } from "@/lib/reviews/client";
import { ReviewItem, type ReviewItemLabels } from "./review-item";

// The storefront's older reviews, page by page (GET /api/reviews, public and rate limited). The
// first page is in the HTML; the labels come from the server (no client message namespace on the
// public pages).

export interface MoreReviewsLabels extends ReviewItemLabels {
  more: string;
  failed: string;
}

export function MoreReviews({ publicId, next, labels, locale }: { publicId: string; next: string; labels: MoreReviewsLabels; locale: Locale }) {
  const [reviews, setReviews] = useState<ReviewView[]>([]);
  const [cursor, setCursor] = useState<string | null>(next);
  const [state, setState] = useState<"idle" | "loading" | "failed">("idle");

  async function load() {
    if (!cursor) return;
    setState("loading");
    try {
      const page = await fetchSellerReviews(publicId, cursor);
      setReviews((current) => [...current, ...page.reviews.filter((review) => !current.some((seen) => seen.id === review.id))]);
      setCursor(page.next);
      setState("idle");
    } catch {
      setState("failed");
    }
  }

  return (
    <>
      {reviews.map((review) => (
        <ReviewItem key={review.id} review={review} labels={labels} locale={locale} />
      ))}
      {cursor ? (
        <div className="flex flex-col items-start gap-2 pt-6">
          <Button type="button" variant="outline" loading={state === "loading"} onClick={() => void load()}>
            <ChevronDown aria-hidden="true" />
            {labels.more}
          </Button>
          {state === "failed" ? (
            <p role="alert" className="text-sm text-danger">
              {labels.failed}
            </p>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
