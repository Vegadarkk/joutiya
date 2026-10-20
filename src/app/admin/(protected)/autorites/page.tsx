import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { EmptyState } from "@/components/feedback/empty-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { requirePageStaff } from "@/lib/auth/current-user";
import { listAuthorityRequests } from "@/lib/decisions/authorities";
import { AUTHORITY_STATUSES, type AuthorityRequestView } from "@/lib/decisions/contracts";
import { HttpError } from "@/lib/http/errors";
import { cn } from "@/lib/utils";
import { AUTHORITY_STATUS_LABEL, COUNTRY_LABEL, formatDateTime, KIND_LABEL } from "../../_lib/moderation-format";
import { linkClassName } from "../../_components/panel";

// Authority requests register (design D17), admin only: removal orders, data and preservation
// requests, newest first, by status.

export const metadata: Metadata = { title: "Autorités" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
type Status = AuthorityRequestView["status"];

const isStatus = (value: unknown): value is Status => typeof value === "string" && (AUTHORITY_STATUSES as readonly string[]).includes(value);

export default async function AuthoritiesPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageStaff(["admin"]);
  const params = await searchParams;
  const status = isStatus(params["etat"]) ? params["etat"] : undefined;
  const after = typeof params["apres"] === "string" ? params["apres"] : undefined;
  const base = status ? `/autorites?etat=${status}` : "/autorites";
  let page: { items: AuthorityRequestView[]; next: string | null };
  try {
    page = await listAuthorityRequests({ limit: 50, ...(status ? { status } : {}), ...(after ? { after } : {}) });
  } catch (error) {
    if (error instanceof HttpError && error.status === 400) redirect(base);
    throw error;
  }
  const tabs: { value: Status | null; label: string }[] = [{ value: null, label: "Toutes" }, ...AUTHORITY_STATUSES.map((value) => ({ value, label: AUTHORITY_STATUS_LABEL[value] }))];

  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Demandes des autorités</h1>
          <p className="mt-1 max-w-prose text-sm text-foreground-muted">
            Injonctions de retrait, demandes de données et de conservation. L&apos;enregistrement conserve les contenus visés et gèle les conversations jusqu&apos;à la clôture.
          </p>
        </div>
        <Button asChild variant="structure" size="sm">
          <Link href="/autorites/nouvelle">Enregistrer une demande</Link>
        </Button>
      </div>
      <nav aria-label="État" className="flex flex-wrap gap-1 border-b border-border">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={tab.value ? `/autorites?etat=${tab.value}` : "/autorites"}
            aria-current={(tab.value ?? null) === (status ?? null) ? "page" : undefined}
            className="-mb-px flex min-h-10 items-center border-b-2 border-transparent px-3 text-sm font-medium text-foreground-muted hover:text-foreground aria-[current=page]:border-primary aria-[current=page]:text-foreground"
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      {page.items.length === 0 ? (
        <EmptyState title="Aucune demande">Les demandes reçues des autorités sont enregistrées ici, avec la vérification de l&apos;identité du demandeur.</EmptyState>
      ) : (
        <div role="region" aria-label="Demandes" tabIndex={0} className="overflow-x-auto rounded-lg border border-border bg-surface">
          <table className="w-full min-w-[48rem] text-sm">
            <thead className="bg-surface-muted text-foreground-muted">
              <tr>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Autorité</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Nature</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Reçue</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">Échéance</th>
                <th scope="col" className="px-4 py-2.5 text-start font-medium">État</th>
              </tr>
            </thead>
            <tbody>
              {page.items.map((item) => (
                <tr key={item.id} className="border-t border-border align-top">
                  <th scope="row" className="px-4 py-3 text-start font-normal">
                    <Link href={`/autorites/${item.id}`} className={cn("font-medium", linkClassName)}>
                      {item.authority}
                    </Link>
                    <span className="block text-xs text-foreground-muted">{COUNTRY_LABEL[item.country]}</span>
                  </th>
                  <td className="px-4 py-3">{KIND_LABEL[item.kind]}</td>
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">{formatDateTime(item.receivedAt)}</td>
                  <td className="px-4 py-3 whitespace-nowrap tabular-nums">{item.dueAt ? formatDateTime(item.dueAt) : "Aucune"}</td>
                  <td className="px-4 py-3">
                    <Badge variant={item.status === "open" ? "warning" : item.status === "answered" ? "success" : "neutral"}>{AUTHORITY_STATUS_LABEL[item.status]}</Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {page.next ? (
        <Link href={`${base}${base.includes("?") ? "&" : "?"}apres=${encodeURIComponent(page.next)}`} className={`text-sm ${linkClassName}`}>
          Demandes suivantes
        </Link>
      ) : null}
    </>
  );
}
