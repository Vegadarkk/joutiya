import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/feedback/empty-state";
import { requirePageStaff } from "@/lib/auth/current-user";
import { appealQueue } from "@/lib/decisions/appeals";
import type { AppealQueueResponse } from "@/lib/decisions/contracts";
import { HttpError } from "@/lib/http/errors";
import { plural } from "../../_lib/moderation-format";
import { AppealQueue } from "../../_components/appeal-queue";

// Appeals queue (design D16, D24): open appeals with their 14-day timers. A moderator never
// reviews his own decision; an admin reviews every appeal (a self-review is journaled).

export const metadata: Metadata = { title: "Recours" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default async function AppealsPage({ searchParams }: { searchParams: SearchParams }) {
  const staff = await requirePageStaff(["moderator", "admin"]);
  const after = (await searchParams)["apres"];
  let queue: AppealQueueResponse;
  try {
    queue = await appealQueue({ uid: staff.uid, role: staff.role }, { limit: 50, ...(typeof after === "string" ? { after } : {}) });
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) redirect("/recours");
    throw error;
  }
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Recours</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Réponse sous 14 jours. Un modérateur ne réexamine jamais sa propre décision ; un admin peut le faire, et ce réexamen est journalisé.
        </p>
      </div>
      {queue.items.length === 0 ? (
        <EmptyState title="Aucun recours ouvert">Les recours des personnes concernées et des signalants arrivent ici.</EmptyState>
      ) : (
        <>
          <p className="text-sm text-foreground-muted">{plural(queue.items.length, "recours ouvert", "recours ouverts")}.</p>
          <AppealQueue items={queue.items} renderedAt={new Date().toISOString()} />
          {queue.next ? (
            <Link href={`/recours?apres=${encodeURIComponent(queue.next)}`} className="text-sm text-link underline underline-offset-4 hover:no-underline">
              Recours suivants
            </Link>
          ) : null}
        </>
      )}
    </>
  );
}
