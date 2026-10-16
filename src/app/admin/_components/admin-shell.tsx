import Link from "next/link";
import type { ReactNode } from "react";
import { Logo } from "@/components/layout/logo";
import { Badge } from "@/components/ui/badge";
import type { StaffRole } from "@/lib/db/repositories/staff";
import { AdminNav } from "./admin-nav";
import { LogoutButton } from "./logout-button";

export const ROLE_LABEL: Record<StaffRole, string> = { admin: "Admin", moderator: "Modérateur" };

interface AdminShellProps {
  email: string;
  role: StaffRole;
  children: ReactNode;
}

/** Compact chrome of the signed-in back office: a green frame line, the logo, sections, who is signed in. */
export function AdminShell({ email, role, children }: AdminShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-t-[3px] border-b border-border border-t-structure bg-surface">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-stretch gap-6 px-4 sm:px-6">
          <Link href="/" className="flex items-center gap-3" aria-label="Back-office Joutiya, accueil">
            <Logo label="Joutiya" className="h-7" />
            <Badge variant="pro">Back-office</Badge>
          </Link>
          <AdminNav admin={role === "admin"} />
          <div className="ms-auto flex items-center gap-3">
            <span className="hidden max-w-56 truncate text-sm text-foreground-muted md:inline" title={email}>
              {email}
            </span>
            <Badge variant={role === "admin" ? "featured" : "neutral"}>{ROLE_LABEL[role]}</Badge>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
