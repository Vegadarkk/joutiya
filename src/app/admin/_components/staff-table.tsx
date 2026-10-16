import { Badge } from "@/components/ui/badge";
import type { StaffMember } from "@/lib/auth/staff";
import { ROLE_LABEL } from "./admin-shell";
import { RevokeButton } from "./revoke-button";

const dateFormat = new Intl.DateTimeFormat("fr-FR", { dateStyle: "medium" });

interface StaffTableProps {
  members: StaffMember[];
  /** The signed-in admin: shown as "vous", never revocable from here. */
  selfUid: string;
}

export function StaffTable({ members, selfUid }: StaffTableProps) {
  if (members.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border-strong p-8 text-center text-sm text-foreground-muted">
        Aucun membre pour l&apos;instant. Invitez le premier avec le formulaire.
      </p>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface">
      <table className="w-full min-w-[40rem] text-sm">
        <thead className="bg-surface-muted text-foreground-muted">
          <tr>
            <th scope="col" className="px-4 py-2.5 text-start font-medium">Membre</th>
            <th scope="col" className="px-4 py-2.5 text-start font-medium">Rôle</th>
            <th scope="col" className="px-4 py-2.5 text-start font-medium">État</th>
            <th scope="col" className="px-4 py-2.5 text-start font-medium">Ajouté le</th>
            <th scope="col" className="px-4 py-2.5 text-end font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {members.map((member) => {
            const self = member.uid === selfUid;
            const revoked = member.revokedAt !== null;
            return (
              <tr key={member.uid} className={revoked ? "border-t border-border align-top text-foreground-muted" : "border-t border-border align-top"}>
                <th scope="row" className="px-4 py-3 text-start font-normal">
                  <span className="block font-medium text-foreground">
                    {member.displayName}
                    {self ? <span className="ms-1.5 text-xs font-normal text-foreground-muted">(vous)</span> : null}
                  </span>
                  <span className="block text-xs text-foreground-muted">{member.email}</span>
                </th>
                <td className="px-4 py-3">
                  <Badge variant={member.role === "admin" ? "featured" : "neutral"}>{ROLE_LABEL[member.role]}</Badge>
                </td>
                <td className="px-4 py-3">
                  {revoked ? (
                    <Badge variant="danger">Révoqué le {dateFormat.format(new Date(member.revokedAt!))}</Badge>
                  ) : (
                    <Badge variant="success">Actif</Badge>
                  )}
                </td>
                <td className="px-4 py-3 tabular-nums">
                  <time dateTime={member.createdAt}>{dateFormat.format(new Date(member.createdAt))}</time>
                  <span className="block text-xs text-foreground-muted">{member.invitedBy === "script" ? "par le script d'amorçage" : "sur invitation"}</span>
                </td>
                <td className="px-4 py-3 text-end">{self || revoked ? null : <RevokeButton uid={member.uid} name={member.displayName} />}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
