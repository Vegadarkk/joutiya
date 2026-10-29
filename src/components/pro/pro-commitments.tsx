"use client";

import { useId } from "react";
import { Check, ExternalLink, Gavel, ScrollText, TriangleAlert } from "lucide-react";
import { useTranslations } from "next-intl";
import { InlineError } from "@/components/feedback/inline-error";
import { textLinkClassName } from "@/components/ui/text-link";
import { SITE_NAME } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { COMMITMENT_GUIDE, COMMITMENT_ITEMS, guideProcedureHref, type CommitmentScope } from "@/lib/pro/commitments";
import { cn } from "@/lib/utils";

// The legal commitments of a shop or an agency (src/lib/pro/commitments.ts), set before the action
// that creates it: what the owner commits to, what a fake shop or agency risks, the procedures of
// the admin guide behind each registration, then one explicit acknowledgment. The guide and the
// terms open in a new tab so that the form keeps what was typed.

interface ProCommitmentsProps {
  scope: CommitmentScope;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  /** Shown under the box (the action was tried without it). */
  error?: string;
  className?: string;
}

export function ProCommitments({ scope, checked, onCheckedChange, error, className }: ProCommitmentsProps) {
  const t = useTranslations("Pro.commitments");
  const titleId = useId();
  const errorId = useId();
  return (
    <section aria-labelledby={titleId} data-testid="pro-commitments" className={cn("flex flex-col gap-5 rounded-lg border border-border bg-surface p-5 sm:p-6", className)}>
      <header className="flex items-start gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-structure/10 text-structure dark:bg-gold-300/15 dark:text-gold-300">
          <Gavel aria-hidden="true" className="size-5" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={titleId} className="font-semibold text-balance">
            {t(`titles.${scope}`)}
          </h3>
          <p className="text-sm text-foreground-muted text-pretty">{t(`leads.${scope}`)}</p>
        </div>
      </header>

      <ul className="flex flex-col gap-2.5 text-sm">
        {COMMITMENT_ITEMS[scope].map((item) => (
          <li key={item} className="flex items-start gap-2.5 text-pretty">
            <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-structure dark:text-gold-300" />
            <span>{t(`items.${item}`, { brand: SITE_NAME })}</span>
          </li>
        ))}
      </ul>

      <div className="flex gap-3 rounded-md border border-warning/30 bg-warning-surface p-4">
        <TriangleAlert aria-hidden="true" className="mt-0.5 size-5 shrink-0 text-warning" />
        <div className="flex min-w-0 flex-col gap-1">
          <p className="text-sm font-medium text-warning">{t("fakeTitle")}</p>
          <p className="text-sm text-foreground text-pretty">{t("fakeBody", { brand: SITE_NAME })}</p>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <h4 className="text-sm font-semibold">{t("guideTitle")}</h4>
        <ul className="flex flex-col gap-1">
          {COMMITMENT_GUIDE[scope].map((entry) => (
            <li key={entry.procedure}>
              <Link
                href={guideProcedureHref(entry)}
                target="_blank"
                rel="noopener"
                className={cn("inline-flex min-h-11 items-center gap-2 rounded-sm text-sm font-medium text-link sm:min-h-9", textLinkClassName)}
              >
                <ScrollText aria-hidden="true" className="size-4 shrink-0 text-structure dark:text-gold-300" />
                {t(`guide.${entry.procedure}`)}
                <ExternalLink aria-hidden="true" className="size-3.5 shrink-0 text-foreground-muted" />
                <span className="sr-only">{t("newTab")}</span>
              </Link>
            </li>
          ))}
        </ul>
        <p className="text-xs text-foreground-muted text-pretty">
          {t("guideNote")}{" "}
          <Link href="/legal/cgu#roles" target="_blank" rel="noopener" className={cn("font-medium text-link", textLinkClassName)}>
            {t("termsLink")}
          </Link>
        </p>
      </div>

      <div className="flex flex-col gap-1.5 border-t border-border pt-4">
        <label className="flex cursor-pointer items-start gap-3 text-sm font-medium text-pretty">
          <input
            type="checkbox"
            checked={checked}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? errorId : undefined}
            onChange={(event) => onCheckedChange(event.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>{t(`accept.${scope}`)}</span>
        </label>
        {error ? <InlineError id={errorId}>{error}</InlineError> : null}
      </div>
    </section>
  );
}
