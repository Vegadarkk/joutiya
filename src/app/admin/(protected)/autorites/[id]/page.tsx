import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { requirePageStaff } from "@/lib/auth/current-user";
import { authorityView, getAuthorityRequest } from "@/lib/decisions/authorities";
import { docIdSchema } from "@/lib/decisions/contracts";
import { AUTHORITY_STATUS_LABEL, COUNTRY_LABEL, formatDateTime, KIND_LABEL, targetHref } from "../../../_lib/moderation-format";
import { AuthorityUpdateForm } from "../../../_components/authority-forms";
import { Facts, linkClassName, Panel } from "../../../_components/panel";

// One authority request (design D17), admin only: what was asked, how the requester was
// identified, what is held, and the answer.

export const metadata: Metadata = { title: "Demande d'autorité" };

/** Back-office page of a scope entry (`listing:{id}`, `user:{uid}`, `conversation:{cid}`). */
function scopeHref(entry: string): string {
  const [type = "", id = ""] = entry.split(/:(.*)/s);
  if (type === "user") return `/comptes/${encodeURIComponent(id)}`;
  if (type === "conversation") return `/conversations/${encodeURIComponent(id)}`;
  return targetHref(entry);
}

export default async function AuthorityPage({ params }: { params: Promise<{ id: string }> }) {
  await requirePageStaff(["admin"]);
  const id = docIdSchema.safeParse((await params).id);
  if (!id.success) notFound();
  const record = await getAuthorityRequest(id.data);
  if (!record) notFound();
  const request = authorityView(record);

  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/autorites" className={`self-start text-sm ${linkClassName}`}>
          Retour au registre
        </Link>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-balance">{request.authority}</h1>
          <Badge variant={request.status === "open" ? "warning" : request.status === "answered" ? "success" : "neutral"}>{AUTHORITY_STATUS_LABEL[request.status]}</Badge>
        </div>
        <p className="text-sm text-foreground-muted">
          {KIND_LABEL[request.kind]}, {COUNTRY_LABEL[request.country]}. Enregistrée le {formatDateTime(request.createdAt)}.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_24rem] lg:items-start">
        <div className="flex flex-col gap-6">
          <Panel title="Demande">
            <Facts
              rows={[
                ["Fondement", request.legalBasis],
                ["Reçue le", formatDateTime(request.receivedAt)],
                ["Échéance", request.dueAt ? formatDateTime(request.dueAt) : "Aucune"],
                ["Identité vérifiée", `${request.identityCheck.method}, le ${formatDateTime(request.identityCheck.at)}`],
                ["Conservations", request.holds.length > 0 ? `${request.holds.length} en cours` : "Aucune"],
                ...(request.closedAt ? ([["Close le", formatDateTime(request.closedAt)]] as [string, string][]) : []),
              ]}
            />
          </Panel>
          <Panel title="Contenus visés">
            <ul className="flex flex-col gap-1 text-sm">
              {request.scope.map((entry) => (
                <li key={entry}>
                  <Link href={scopeHref(entry)} className={linkClassName}>
                    {entry}
                  </Link>
                </li>
              ))}
            </ul>
            {request.reportIds.length > 0 ? <p className="text-sm text-foreground-muted">Retrait exécuté par {request.reportIds.length} signalement(s) d&apos;autorité et leurs décisions.</p> : null}
          </Panel>
          {request.response ? (
            <Panel title="Réponse">
              <p className="max-w-prose text-sm text-pretty whitespace-pre-line">{request.response}</p>
              {request.respondedAt ? <p className="text-sm text-foreground-muted">Le {formatDateTime(request.respondedAt)}.</p> : null}
            </Panel>
          ) : null}
        </div>
        <aside aria-label="Suite donnée">{request.status === "closed" ? null : <AuthorityUpdateForm request={{ id: request.id, status: request.status, response: request.response }} />}</aside>
      </div>
    </>
  );
}
