import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/auth/current-user";
import { AdminShell } from "../_components/admin-shell";

// Signed-in part of the back office. The session only decides what to show: every API route
// re-checks with requireStaff (§6). Anonymous visitors go to /connexion (outside this group).

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const staff = await currentStaff();
  if (!staff) redirect("/connexion");
  return (
    <AdminShell email={staff.email ?? ""} role={staff.claims.role === "admin" ? "admin" : "moderator"}>
      {children}
    </AdminShell>
  );
}
