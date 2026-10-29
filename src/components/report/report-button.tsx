"use client";

import { useState } from "react";
import dynamic from "next/dynamic";
import { Flag, RotateCw } from "lucide-react";
import { useTranslations } from "next-intl";
import { loadWithRetry } from "@/components/layout/chunk-retry";
import { Button } from "@/components/ui/button";
import { textLinkClassName } from "@/components/ui/text-link";
import { loadSession, useSession } from "@/lib/auth/client";
import { cn } from "@/lib/utils";
import type { ReportDialogProps } from "./report-dialog";

// "Signaler" on the listing and profile pages and under each storefront review (art. 16 DSA, design
// D10): opens the notice form, loaded on demand (most visitors never need it). Hidden from the owner
// looking at their own listing or profile (the server refuses it anyway; a review's author is not
// known to the page, the server refuses their own notice). When the form's chunk cannot be downloaded,
// an e-mail to the DSA point of contact (config/legal) with the content's id and address stands in.

/** `mailto:` with a subject and a body; spaces as %20 (mail clients show "+" literally). */
export function reportMailto(email: string, subject: string, body: string): string {
  const params = new URLSearchParams({ subject, body });
  return `mailto:${email}?${params.toString().replace(/\+/g, "%20")}`;
}

/** The dialog's chunk is missing: the e-mail to the DSA contact and a reload. */
function ReportFallback({ open, target, fallbackEmail, pageUrl }: ReportDialogProps & { pageUrl?: string }) {
  const t = useTranslations("Report");
  if (!open || !fallbackEmail) return null;
  const subject = t(`mail.${target.type === "message" ? "user" : target.type}`, { id: target.id });
  return (
    <div role="alert" className="flex flex-col items-start gap-2 rounded-md border border-border bg-surface-muted p-3 text-sm">
      <p className="text-pretty">
        {t("fallback")}{" "}
        <a href={reportMailto(fallbackEmail, subject, t("mail.body", { url: pageUrl ?? "" }))} dir="ltr" className={cn("font-medium text-link", textLinkClassName)}>
          {fallbackEmail}
        </a>
      </p>
      <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={() => window.location.reload()}>
        <RotateCw aria-hidden="true" />
        {t("reload")}
      </Button>
    </div>
  );
}

export const loadReportDialog = loadWithRetry<ReportDialogProps & { pageUrl?: string }>(() => import("./report-dialog").then((module) => module.ReportDialog), ReportFallback);
const ReportDialog = dynamic(() => loadReportDialog(), { ssr: false });

export interface ReportButtonProps {
  target: { type: "listing" | "user" | "review"; id: string };
  /** Listing title or display name (a review: its author's), recalled in the dialog. */
  subject: string;
  /** publicId of the owner: the button hides from them. */
  ownerPublicId?: string;
  /** The reported review's text, quoted in the dialog. */
  quote?: string;
  /** A small "Signaler" without the hint line (under a review). */
  compact?: boolean;
  /** dsaContactEmail of the legal config. */
  email: string;
  /** Absolute canonical URL of the page (the e-mail stand-in). */
  url: string;
  className?: string;
}

export function ReportButton({ target, subject, ownerPublicId, quote, compact, email, url, className }: ReportButtonProps) {
  const t = useTranslations("Report");
  const { status, session } = useSession();
  const [state, setState] = useState<"closed" | "checking" | "open">("closed");
  const [mounted, setMounted] = useState(false);
  const context = target.type;

  if (ownerPublicId && status === "ready" && session?.publicId === ownerPublicId) return null;

  async function openDialog() {
    if (state === "checking") return;
    setState("checking");
    // The form differs for members and visitors: know which before it opens.
    const viewer = await loadSession();
    if (ownerPublicId && viewer?.publicId === ownerPublicId) {
      setState("closed");
      return;
    }
    setMounted(true);
    setState("open");
  }

  return (
    <div className={cn("flex flex-col gap-1", className)}>
      <Button
        type="button"
        variant="ghost"
        loading={state === "checking"}
        aria-haspopup="dialog"
        onClick={() => void openDialog()}
        size={compact ? "sm" : undefined}
        className={cn("-ms-2 self-start px-2 font-medium text-foreground-muted hover:text-foreground", compact ? "text-xs max-sm:h-11" : "text-sm")}
      >
        <Flag aria-hidden="true" />
        {t(`trigger.${context}`)}
      </Button>
      {compact ? null : <p className="text-xs text-foreground-muted text-pretty">{t("hint")}</p>}
      {mounted ? (
        <ReportDialog
          open={state === "open"}
          onOpenChange={(open) => setState(open ? "open" : "closed")}
          target={target}
          context={context}
          subject={subject}
          {...(quote ? { quote } : {})}
          fallbackEmail={email}
          pageUrl={url}
        />
      ) : null}
    </div>
  );
}
