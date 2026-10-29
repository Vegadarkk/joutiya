import type { Metadata } from "next";
import Link from "next/link";
import { EmptyState } from "@/components/feedback/empty-state";
import { Badge } from "@/components/ui/badge";
import { cityBySlug, cityName } from "@/config/regions";
import { requirePageStaff } from "@/lib/auth/current-user";
import { rentalCheckQueue } from "@/lib/pro/rental-check";
import { proQueue } from "@/lib/pro/review";
import { LEGAL_FORM_LABEL, RENTAL_CHECK_ISSUE_LABEL, formatIce } from "../../_components/pro-labels";

// KYBC queue of the back office (phase 7 design §4): submitted Pro applications, oldest first;
// then the car rental licence documents the AI check left in doubt (decision 5). Moderators and admins.

export const metadata: Metadata = { title: "Comptes Pro" };

const dateTime = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Casablanca" });

export default async function ProQueuePage() {
  await requirePageStaff(["moderator", "admin"]);
  const [queue, checks] = await Promise.all([proQueue(), rentalCheckQueue()]);
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Demandes de compte Pro</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Demandes à vérifier, les plus anciennes en premier. Vérifiez les identifiants au registre et les justificatifs, appelez le numéro du demandeur
          s’il n’est pas encore vérifié, puis validez ou refusez avec un motif.
        </p>
      </div>
      {queue.items.length === 0 ? (
        <EmptyState title="Aucune demande en attente">Les nouvelles demandes de compte Pro apparaîtront ici.</EmptyState>
      ) : (
        <>
          <ul className="flex flex-col gap-3" data-testid="pro-queue">
            {queue.items.map((item) => {
              const city = cityBySlug(item.citySlug);
              return (
                <li key={item.proId}>
                  <Link
                    href={`/pros/${item.proId}`}
                    className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between"
                  >
                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="truncate font-semibold" dir="auto">
                        {item.name}
                      </span>
                      <span className="text-sm text-foreground-muted">
                        {LEGAL_FORM_LABEL[item.legalForm] ?? item.legalForm}
                        {city ? ` à ${cityName(city, "fr")}` : ""}
                        {item.owner ? `, demandé par ${item.owner.displayName}` : ""}
                      </span>
                    </span>
                    <span className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="font-mono tabular-nums" dir="ltr">
                        ICE {formatIce(item.ice)}
                      </span>
                      {item.iceFormatOk ? null : <Badge variant="warning">Format ICE à vérifier</Badge>}
                      <Badge>{item.pieces > 1 ? `${item.pieces} pièces` : "1 pièce"}</Badge>
                      <span className="text-foreground-muted">{dateTime.format(new Date(item.submittedAt))}</span>
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
          {queue.hasMore ? <p className="text-sm text-foreground-muted">Seules les {queue.items.length} plus anciennes sont affichées : traitez-les pour voir les suivantes.</p> : null}
        </>
      )}

      <section aria-labelledby="rental-checks" className="flex flex-col gap-3">
        <div>
          <h2 id="rental-checks" className="text-xl font-semibold">
            Agréments de location à contrôler
          </h2>
          <p className="mt-1 max-w-prose text-sm text-foreground-muted">Décisions d’agrément que la lecture IA n’a pas pu confirmer, les plus anciennes en premier.</p>
        </div>
        {checks.items.length === 0 ? (
          <p className="text-sm text-foreground-muted">Aucun document en attente.</p>
        ) : (
          <ul className="flex flex-col gap-3" data-testid="rental-check-queue">
            {checks.items.map((item) => (
              <li key={item.proId}>
                <Link
                  href={`/pros/${item.proId}#agrement`}
                  className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-4 transition-colors hover:border-border-strong focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring sm:flex-row sm:items-center sm:justify-between"
                >
                  <span className="flex min-w-0 flex-col gap-1">
                    <span className="truncate font-semibold" dir="auto">
                      {item.name}
                    </span>
                    <span className="text-sm text-foreground-muted">{item.issues.map((issue) => RENTAL_CHECK_ISSUE_LABEL[issue] ?? issue).join(" · ") || "À contrôler"}</span>
                  </span>
                  <span className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-mono tabular-nums" dir="ltr">
                      N° {item.agrementRef}
                    </span>
                    <span className="text-foreground-muted">{dateTime.format(new Date(item.submittedAt))}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        )}
        {checks.hasMore ? <p className="text-sm text-foreground-muted">Seuls les {checks.items.length} plus anciens sont affichés.</p> : null}
      </section>
    </>
  );
}
