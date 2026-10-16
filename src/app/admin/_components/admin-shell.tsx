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

/**
 * Compact chrome of the signed-in back office: a green frame line, the logo, sections, who is signed
 * in. One row from `md` (the e-mail from `lg`); below, the sections drop to a second row under the logo
 * and the account.
 */
export function AdminShell({ email, role, children }: AdminShellProps) {
  return (
    <div className="flex min-h-dvh flex-col">
      <header className="border-t-[3px] border-b border-border border-t-structure bg-surface">
        <div className="mx-auto flex w-full max-w-5xl flex-wrap items-stretch gap-x-6 px-4 sm:px-6 md:flex-nowrap">
          <Link href="/" className="flex h-14 shrink-0 items-center gap-3 rounded-sm" aria-label="Back-office Joutiya, accueil">
            <Logo label="Joutiya" className="h-7" />
            <Badge variant="pro" className="whitespace-nowrap">
              Back-office
            </Badge>
          </Link>
          <AdminNav
            admin={role === "admin"}
            className="order-last -mx-4 w-[calc(100%+2rem)] border-t border-border px-2 sm:-mx-6 sm:w-[calc(100%+3rem)] sm:px-4 md:order-none md:mx-0 md:w-auto md:border-t-0 md:px-0"
          />
          <div className="ms-auto flex h-14 min-w-0 items-center gap-2 sm:gap-3">
            <span className="hidden max-w-56 truncate text-sm text-foreground-muted lg:inline" title={email}>
              {email}
            </span>
            <Badge variant={role === "admin" ? "featured" : "neutral"} className="whitespace-nowrap">
              {ROLE_LABEL[role]}
            </Badge>
            <LogoutButton />
          </div>
        </div>
      </header>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">{children}</main>
    </div>
  );
}
