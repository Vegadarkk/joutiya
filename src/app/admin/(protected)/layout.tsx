import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { currentStaff } from "@/lib/auth/current-user";
import { AdminShell } from "../_components/admin-shell";

// Signed-in part of the back office. This layout is UX only (the shell, a redirect on a full
// load): every page calls requirePageStaff itself, because a client-side navigation renders the
// page without the layout, and every API route re-checks with requireStaff (§6).

export default async function ProtectedAdminLayout({ children }: { children: ReactNode }) {
  const staff = await currentStaff();
  if (!staff) redirect("/connexion");
  return (
    <AdminShell email={staff.email ?? ""} role={staff.role}>
      {children}
    </AdminShell>
  );
}
