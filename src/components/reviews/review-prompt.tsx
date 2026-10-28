"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Star, X } from "lucide-react";
import { useTranslations } from "next-intl";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import type { ReviewDialogProps } from "@/components/reviews/review-dialog";
import { Button } from "@/components/ui/button";
import type { ConversationView } from "@/lib/contracts/messaging";
import { reviewWindow, type ReviewCreated } from "@/lib/contracts/reviews";
import { isolate } from "@/lib/i18n/bidi";

// The thread's invitation to review the seller (vitrine-avis §2): the buyer only, while the window
// is open (24 h after the seller's first reply, until 60 days after the last message), on a
// conversation that can still be written to. "Plus tard" hides it for this conversation in this
// browser; the window stays open.

const ReviewDialog = dynamic(() => loadWithRetry<ReviewDialogProps>(() => import("@/components/reviews/review-dialog").then((module) => module.ReviewDialog), () => null)(), { ssr: false });

const LATER_KEY = "joutiya.review-later";

function laterSet(): Set<string> {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(LATER_KEY) ?? "[]");
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

function rememberLater(cid: string): void {
  try {
    // The 50 most recent are enough: a window closes after 60 days anyway.
    const next = [...laterSet(), cid].slice(-50);
    window.localStorage.setItem(LATER_KEY, JSON.stringify(next));
  } catch {
    // Private mode or storage blocked: hidden for this visit only.
  }
}

/** The thread shows the invitation (pure: the conversation and the clock). */
export function reviewInvited(conversation: ConversationView, now: number): boolean {
  if (conversation.role !== "buyer" || conversation.frozen || conversation.blockedByMe || conversation.blockedMe || conversation.counterpartClosed) return false;
  return reviewWindow({ sellerRepliedAt: conversation.review.sellerRepliedAt, lastActivityAt: conversation.lastMessage.at, reviewedAt: conversation.review.reviewedAt }, now).state === "open";
}

export function ReviewPrompt({ conversation, onReviewed }: { conversation: ConversationView; onReviewed: (created: ReviewCreated) => void }) {
  const t = useTranslations("Messaging.review");
  const [later, setLater] = useState(() => laterSet().has(conversation.cid));
  const [dialog, setDialog] = useState<{ open: boolean } | null>(null);
  // Told to the thread once the confirmation is closed: until then the dialog stays mounted.
  const [created, setCreated] = useState<ReviewCreated | null>(null);
  const name = isolate(conversation.counterpart.displayName);

  return (
    <>
      {later || created ? null : (
        <aside data-testid="review-prompt" aria-label={t("label")} className="mx-3 mb-2 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-featured/50 bg-gold-100/60 px-3 py-2.5 sm:mx-5 lg:mx-8 dark:bg-gold-700/15">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-featured text-featured-foreground">
            <Star className="size-4.5 fill-current" aria-hidden="true" />
          </span>
          <p className="min-w-48 flex-1 text-sm text-pretty">
            <span className="font-medium">{t("title", { name })}</span> <span className="text-foreground-muted max-sm:hidden">{t("body")}</span>
          </p>
          <div className="flex shrink-0 items-center gap-1 max-sm:ms-12">
            <Button type="button" size="sm" className="max-sm:h-11" onClick={() => setDialog({ open: true })}>
              {t("action")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="-me-1"
              aria-label={t("later")}
              onClick={() => {
                rememberLater(conversation.cid);
                setLater(true);
              }}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </aside>
      )}
      {dialog ? (
        <ReviewDialog
          open={dialog.open}
          onOpenChange={(open) => {
            setDialog({ open });
            if (!open && created) onReviewed(created);
          }}
          cid={conversation.cid}
          sellerName={conversation.counterpart.displayName}
          sellerPublicId={conversation.counterpart.publicId}
          listingTitle={conversation.listing.title}
          onDone={setCreated}
        />
      ) : null}
    </>
  );
}
