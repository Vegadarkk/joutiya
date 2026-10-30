import { BriefcaseBusiness, Plane } from "lucide-react";
import { useTranslations } from "next-intl";
import { textLinkClassName } from "@/components/ui/text-link";
import { jobOfferAbroad, subcategoryById } from "@/config/categories";
import { Link } from "@/i18n/navigation";
import type { ListingAttributes } from "@/lib/contracts/listings";
import { cn } from "@/lib/utils";

// The host's notice on a job ad (Phase 6 frame of 2026-10-30, rule 10): Aalan publishes job offers
// and job-seeker ads like a publication (Code du travail art. 491), is no recruitment agency,
// checks nothing beyond the moderation and is no party to the hiring; a candidate never pays
// (arts. 480, 485). An offer abroad adds the ministry's visa and ANAPEC (arts. 489, 512-515).
// Links: the CGU rules (§7.11 once Phase 6 ships it, the page until then) and the report control.

const OFFER_POINTS = ["publisher", "moderation", "noFees"] as const;
const SEEKER_POINTS = ["publisher", "contact"] as const;

export interface JobNoticeProps {
  subcategoryId: string;
  attributes: ListingAttributes;
  className?: string;
}

export function JobNotice({ subcategoryId, attributes, className }: JobNoticeProps) {
  const t = useTranslations("ListingPage.jobs");
  const seeker = subcategoryById(subcategoryId)?.individualOnly === true;
  const abroad = jobOfferAbroad(subcategoryId, attributes);
  return (
    <section data-testid="job-notice" data-kind={seeker ? "seeker" : "offer"} aria-labelledby="job-notice-title" className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface p-5", className)}>
      <h2 id="job-notice-title" className="flex items-center gap-2 text-lg font-semibold">
        <BriefcaseBusiness className="size-5 shrink-0 text-structure dark:text-gold-300" aria-hidden="true" />
        {t("title")}
      </h2>
      <ul className="flex list-disc flex-col gap-1.5 ps-5 text-sm text-pretty">
        {seeker ? SEEKER_POINTS.map((key) => <li key={key}>{t(`seeker.${key}`)}</li>) : OFFER_POINTS.map((key) => <li key={key}>{t(`offer.${key}`)}</li>)}
      </ul>
      {abroad ? (
        <p data-testid="job-abroad-notice" className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-surface px-3 py-2 text-sm text-foreground text-pretty">
          <Plane className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            <strong className="font-semibold">{t("abroad.title")}</strong> {t("abroad.body")}
          </span>
        </p>
      ) : null}
      <p className="text-sm">
        {t.rich("links", {
          rules: (chunks) => (
            <Link href="/legal/cgu" className={cn("font-medium text-link", textLinkClassName)}>
              {chunks}
            </Link>
          ),
          report: (chunks) => (
            <a href="#signaler" className={cn("font-medium text-link", textLinkClassName)}>
              {chunks}
            </a>
          ),
        })}
      </p>
    </section>
  );
}
