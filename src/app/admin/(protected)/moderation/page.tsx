import type { Metadata } from "next";
import { EmptyState } from "@/components/feedback/empty-state";
import { requirePageStaff } from "@/lib/auth/current-user";
import { moderationQueue } from "@/lib/listings/moderation-actions";
import { mediaBaseUrl } from "@/lib/storage/keys";
import { catalogLabels } from "../../_components/moderation-labels";
import { ModerationQueue } from "../../_components/moderation-queue";

// Minimal moderation queue (design D9, phase 5 preview): listings held by the pre-moderation,
// oldest first. Moderators and admins.

export const metadata: Metadata = { title: "Modération" };

export default async function ModerationPage() {
  await requirePageStaff(["moderator", "admin"]);
  const [queue, labels] = await Promise.all([moderationQueue(), catalogLabels()]);
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Annonces à vérifier</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Annonces retenues par le contrôle automatique avant publication, les plus anciennes en premier. Le vendeur reçoit votre décision par e-mail,
          avec le motif en cas de refus.
        </p>
      </div>
      {queue.items.length === 0 ? (
        <EmptyState title="Aucune annonce en attente">Les annonces retenues par le contrôle automatique apparaîtront ici.</EmptyState>
      ) : (
        <>
          <ModerationQueue items={queue.items} labels={labels} mediaBaseUrl={mediaBaseUrl()} />
          {queue.hasMore ? (
            <p className="text-sm text-foreground-muted">
              Seules les {queue.items.length} plus anciennes sont affichées : traitez-les pour voir les suivantes.
            </p>
          ) : null}
        </>
      )}
    </>
  );
}
