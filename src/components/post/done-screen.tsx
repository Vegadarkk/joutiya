"use client";

import { useState } from "react";
import { Check, CircleCheck, CircleX, Clock, Link2, Share2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { StatusPanel } from "@/components/auth/status-panel";
import { Button } from "@/components/ui/button";
import { CANONICAL_ORIGIN } from "@/config/site";
import { Link } from "@/i18n/navigation";
import type { ListingStatus } from "@/lib/contracts/listings";
import { usePublicConfig } from "@/lib/config/client";

// `/deposer/{id}/termine`: published (link + share), pending review (explanation, mail sent) or
// rejected, and the way to the next listing. The panel is the whole page: its title is the h1.

interface DoneScreenProps {
  status: ListingStatus;
  slugId: string | null;
  /** Localized path of the public page when published. */
  url?: string;
  listingId: string;
}

export function DoneScreen({ status, slugId, url, listingId }: DoneScreenProps) {
  const t = useTranslations("Listing.done");
  const locale = useLocale();
  const config = usePublicConfig();
  const [copied, setCopied] = useState(false);
  // The page in the language on screen (the API answers with the seller's stored locale).
  const path = slugId ? `/${locale}/annonce/${slugId}` : (url ?? null);
  const absolute = path ? new URL(path, config?.siteUrl ?? (typeof window !== "undefined" ? window.location.origin : CANONICAL_ORIGIN)).toString() : null;

  async function share() {
    if (!absolute) return;
    try {
      if (typeof navigator.share === "function") {
        await navigator.share({ url: absolute });
        return;
      }
      await navigator.clipboard.writeText(absolute);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // Cancelled share or blocked clipboard: the link stays visible below.
    }
  }

  const another = (
    <Button asChild variant="outline">
      <Link href={{ pathname: "/deposer", query: { nouveau: "1" } }}>{t("another")}</Link>
    </Button>
  );
  const mine = (
    <Button asChild variant="ghost">
      <Link href="/mes-annonces">{t("myListings")}</Link>
    </Button>
  );

  if (status === "published") {
    return (
      <StatusPanel
        icon={CircleCheck}
        title={t("publishedTitle")}
        headingLevel="h1"
        celebrate
        actions={
          <>
            {path ? (
              <Button asChild>
                <a href={path}>{t("viewListing")}</a>
              </Button>
            ) : null}
            {absolute ? (
              <Button type="button" variant="outline" onClick={() => void share()}>
                {copied ? <Check aria-hidden="true" /> : <Share2 aria-hidden="true" />}
                {copied ? t("linkCopied") : t("share")}
              </Button>
            ) : null}
            {another}
            {mine}
          </>
        }
        extra={
          absolute ? (
            <p dir="ltr" className="flex items-center justify-center gap-2 break-all text-center text-sm text-foreground-muted">
              <Link2 className="size-4 shrink-0" aria-hidden="true" />
              {absolute}
            </p>
          ) : null
        }
      >
        {t("publishedBody")}
      </StatusPanel>
    );
  }

  if (status === "rejected") {
    return (
      <StatusPanel
        icon={CircleX}
        title={t("rejectedTitle")}
        headingLevel="h1"
        actions={
          <>
            <Button asChild>
              <Link href={`/deposer/${listingId}/apercu`}>{t("editAgain")}</Link>
            </Button>
            {mine}
          </>
        }
      >
        {t("rejectedBody")}
      </StatusPanel>
    );
  }

  if (status === "pending_review") {
    return (
      <StatusPanel
        icon={Clock}
        title={t("pendingTitle")}
        headingLevel="h1"
        actions={
          <>
            {another}
            {mine}
          </>
        }
      >
        {t("pendingBody")}
      </StatusPanel>
    );
  }

  return (
    <StatusPanel
      icon={CircleCheck}
      title={t("savedTitle")}
      headingLevel="h1"
      actions={
        <>
          {mine}
          {another}
        </>
      }
    >
      {t("savedBody")}
    </StatusPanel>
  );
}
