import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

// Building blocks of the back-office detail pages: a titled panel and a list of facts.

interface PanelProps {
  title: ReactNode;
  /** Right side of the title row (a count, a badge, a link). */
  meta?: ReactNode;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, meta, className, children }: PanelProps) {
  return (
    <section className={cn("flex flex-col gap-3 rounded-lg border border-border bg-surface p-5", className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {meta ? <div className="text-sm text-foreground-muted">{meta}</div> : null}
      </div>
      {children}
    </section>
  );
}

export function Facts({ rows, className }: { rows: [string, ReactNode][]; className?: string }) {
  return (
    <dl className={cn("grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm", className)}>
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="text-foreground-muted">{label}</dt>
          <dd className="min-w-0 break-words text-foreground">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

export const linkClassName = "text-link underline underline-offset-4 hover:no-underline";
