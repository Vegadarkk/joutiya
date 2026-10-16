import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { currentStaff } from "@/lib/auth/current-user";
import { list } from "@/lib/auth/staff";
import { InviteForm } from "../../_components/invite-form";
import { StaffTable } from "../../_components/staff-table";

// Roster of the back office (§6 "Personnel"): admins only; moderators get the 404 of the shell.

export const metadata: Metadata = { title: "Personnel" };

export default async function PersonnelPage() {
  const staff = await currentStaff();
  if (!staff || staff.claims.role !== "admin") notFound();
  const { staff: members } = await list();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Personnel</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Modérateurs et admins du back-office. Ces comptes sont séparés des comptes acheteurs et vendeurs : un compte Joutiya existant ne peut pas
          devenir membre du personnel, et personne ne modifie son propre rôle.
        </p>
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_22rem] lg:items-start">
        <StaffTable members={members} selfUid={staff.uid} />
        <InviteForm />
      </div>
    </>
  );
}
