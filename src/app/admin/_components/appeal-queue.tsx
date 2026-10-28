"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { APPEAL_SLA_DAYS, type AppealQueueItem } from "@/lib/decisions/contracts";
import { cn } from "@/lib/utils";
import { formatDateTime, orderByUrgency, TARGET_LABEL, templateLabel } from "../_lib/moderation-format";
import { SlaTimer, useNow } from "./sla-timer";

const APPEAL_WINDOW_MS = APPEAL_SLA_DAYS * 24 * 60 * 60 * 1000;
/** Appeals have no priority: the queue sorts them by their due date only (past due first). */
const FLAT = "P1" as const;

/** Open appeals (D16), past due first, with their 14-day timers. */
export function AppealQueue({ items, renderedAt }: { items: AppealQueueItem[]; renderedAt: string }) {
  const now = useNow(renderedAt);
  const ordered = orderByUrgency(
    items.map((item) => ({ item, priority: FLAT, slaDueAt: item.slaDueAt ?? item.openedAt })),
    now,
  );
  return (
    <ol aria-label="Recours ouverts, les plus anciens en premier" className="divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface">
      {ordered.map(({ item }) => {
        const href = `/decisions/${item.decisionId}`;
        const late = item.slaDueAt !== null && Date.parse(item.slaDueAt) < now.getTime();
        return (
          <li key={item.decisionId} className={cn("grid grid-cols-[minmax(0,1fr)] gap-3 p-4 md:grid-cols-[minmax(0,1fr)_auto]", late && "bg-danger-surface/40")}>
            <div className="flex min-w-0 flex-col gap-1.5">
              <Link href={href} className="font-medium underline-offset-4 hover:underline focus-visible:underline">
                {templateLabel(item.templateId)}
              </Link>
              <p className="text-sm text-foreground-muted">
                {TARGET_LABEL[item.target.type] ?? item.target.type} {item.target.id}. Recours {item.by === "reporter" ? "d'un signalant" : "de la personne concernée"}, ouvert le{" "}
                <time dateTime={item.openedAt} suppressHydrationWarning>
                  {formatDateTime(item.openedAt)}
                </time>
                .
              </p>
              <p dir="auto" className="line-clamp-2 max-w-prose text-sm">
                « {item.text} »
              </p>
              <p className="flex flex-wrap gap-1.5">
                {item.reviewable ? null : <Badge variant="neutral">Votre décision : un autre modérateur la réexamine</Badge>}
                {item.aiDecisionId ? <Badge variant="neutral">Proposition de l&apos;agent</Badge> : null}
              </p>
            </div>
            <div className="flex items-center justify-between gap-3 md:flex-col md:items-end md:justify-start">
              {item.slaDueAt ? <SlaTimer dueAt={item.slaDueAt} now={now} windowMs={APPEAL_WINDOW_MS} /> : null}
              <Link href={href} className="text-sm font-medium text-link underline underline-offset-4 hover:no-underline">
                {item.reviewable ? "Réexaminer" : "Consulter"}
              </Link>
            </div>
          </li>
        );
      })}
    </ol>
  );
}
