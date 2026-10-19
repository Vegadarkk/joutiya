import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { REPORT_PRIORITIES, type ReportPriority } from "@/config/report-reasons";
import { EmptyState } from "@/components/feedback/empty-state";
import { requirePageStaff } from "@/lib/auth/current-user";
import { HttpError } from "@/lib/http/errors";
import { listQueue, QUEUE_LIMIT_DEFAULT, type ReportQueueResponse } from "@/lib/reports/admin";
import { cn } from "@/lib/utils";
import { plural, PRIORITY_DELAY } from "../../_lib/moderation-format";
import { ReportQueue } from "../../_components/report-queue";

// Report queues (design D12, D24): open reports grouped by target, past due first, then by
// priority and due date, with live SLA timers. Moderators and admins.

export const metadata: Metadata = { title: "Signalements" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const TABS: { value: ReportPriority | null; label: string }[] = [{ value: null, label: "Toutes" }, ...REPORT_PRIORITIES.map((priority) => ({ value: priority, label: priority }))];

const isPriority = (value: unknown): value is ReportPriority => typeof value === "string" && (REPORT_PRIORITIES as readonly string[]).includes(value);

export default async function ReportsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageStaff(["moderator", "admin"]);
  const params = await searchParams;
  const priority = isPriority(params["priorite"]) ? params["priorite"] : undefined;
  const after = typeof params["apres"] === "string" ? params["apres"] : undefined;
  const base = priority ? `/signalements?priorite=${priority}` : "/signalements";
  let queue: ReportQueueResponse;
  try {
    queue = await listQueue({ limit: QUEUE_LIMIT_DEFAULT, ...(priority ? { priority } : {}), ...(after ? { after } : {}) });
  } catch (error) {
    // A stale or edited cursor: back to the first page.
    if (error instanceof HttpError && error.status === 400 && after) redirect(base);
    throw error;
  }
  const renderedAt = new Date().toISOString();

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Signalements</h1>
          <p className="mt-1 max-w-prose text-sm text-foreground-muted">
            Une ligne par contenu signalé : une décision clôt tous ses signalements. Les retards passent en tête, puis la priorité et l&apos;échéance.
          </p>
        </div>
        <Link href="/statistiques" className="text-sm text-link underline underline-offset-4 hover:no-underline">
          Délais et statistiques
        </Link>
      </div>

      <nav aria-label="Priorité" className="flex flex-wrap gap-1 border-b border-border">
        {TABS.map((tab) => {
          const current = (tab.value ?? null) === (priority ?? null);
          return (
            <Link
              key={tab.label}
              href={tab.value ? `/signalements?priorite=${tab.value}` : "/signalements"}
              aria-current={current ? "page" : undefined}
              title={tab.value ? `Délai cible : ${PRIORITY_DELAY[tab.value]}` : undefined}
              className={cn(
                "-mb-px flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-foreground-muted transition-colors hover:text-foreground",
                "aria-[current=page]:border-primary aria-[current=page]:text-foreground",
              )}
            >
              {tab.label}
            </Link>
          );
        })}
      </nav>

      {queue.groups.length === 0 ? (
        <EmptyState title={priority ? `Aucun signalement ${priority} ouvert` : "Aucun signalement ouvert"}>
          Les nouveaux signalements arrivent ici, les plus urgents en premier.
        </EmptyState>
      ) : (
        <>
          <p className="text-sm text-foreground-muted" aria-live="polite">
            {plural(queue.groups.length, "contenu", "contenus")}, {plural(queue.items.length, "signalement ouvert", "signalements ouverts")}
            {after ? " sur cette page" : ""}.
          </p>
          <ReportQueue items={queue.items} groups={queue.groups} renderedAt={renderedAt} />
          <div className="flex flex-wrap gap-4 text-sm">
            {after ? (
              <Link href={base} className="text-link underline underline-offset-4 hover:no-underline">
                Revenir aux plus urgents
              </Link>
            ) : null}
            {queue.next ? (
              <Link href={`${base}${base.includes("?") ? "&" : "?"}apres=${encodeURIComponent(queue.next)}`} className="text-link underline underline-offset-4 hover:no-underline">
                Signalements suivants
              </Link>
            ) : null}
          </div>
        </>
      )}
    </>
  );
}
