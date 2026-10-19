import type { Metadata } from "next";
import Link from "next/link";
import { requirePageStaff } from "@/lib/auth/current-user";
import { AuthorityCreateForm } from "../../../_components/authority-forms";
import { linkClassName } from "../../../_components/panel";

// Record an authority request (design D17), admin only.

export const metadata: Metadata = { title: "Nouvelle demande d'autorité" };

export default async function NewAuthorityPage() {
  await requirePageStaff(["admin"]);
  return (
    <>
      <div className="flex flex-col gap-2">
        <Link href="/autorites" className={`self-start text-sm ${linkClassName}`}>
          Retour au registre
        </Link>
        <h1 className="text-2xl font-semibold">Enregistrer une demande d&apos;autorité</h1>
        <p className="max-w-prose text-sm text-foreground-muted">
          Vérifiez d&apos;abord l&apos;identité du demandeur. Une injonction de retrait retire les annonces et masque les messages visés dès l&apos;enregistrement.
        </p>
      </div>
      <AuthorityCreateForm />
    </>
  );
}
