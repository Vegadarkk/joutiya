"use client";

import { Flag } from "lucide-react";
import { useTranslations } from "next-intl";
import { cn } from "@/lib/utils";

/** The report button beside a received item (shown on hover or focus where a pointer hovers). */
export function ReportButton({ onClick }: { onClick: () => void }) {
  const report = useTranslations("Report.trigger");
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={report("message")}
      title={report("message")}
      data-testid="report-message"
      className={cn(
        "inline-flex size-10 shrink-0 items-center justify-center rounded-full text-foreground-muted transition-opacity duration-150 ease-door hover:bg-surface-muted hover:text-foreground",
        "[@media(hover:hover)]:opacity-0 group-hover/message:opacity-100 focus-visible:opacity-100",
      )}
    >
      <Flag className="size-4" aria-hidden="true" />
    </button>
  );
}
