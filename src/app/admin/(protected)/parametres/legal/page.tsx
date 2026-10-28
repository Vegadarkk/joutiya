import type { Metadata } from "next";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { requirePageStaff } from "@/lib/auth/current-user";
import { readLegalAdmin } from "@/lib/legal/admin";
import { LegalForm } from "../../../_components/legal-form";

// Legal variables of the site (phase 6, D13): admins only; moderators get the 404 of the shell.
// Each save is journaled (`legal.updated`); scripts/legal-config.ts writes the same document.

export const metadata: Metadata = { title: "Mentions légales" };

export default async function LegalSettingsPage() {
  await requirePageStaff(["admin"]);
  const view = await readLegalAdmin();
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Mentions légales</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Valeurs reprises dans les mentions légales, les CGU, la politique de confidentialité et le pied de page. Chaque enregistrement est inscrit au
          journal d&apos;audit avec les champs modifiés. Les pages légales changent dès leur prochaine visite ; le pied de page des autres pages suit dans
          les 5 minutes.
        </p>
      </div>
      {view.errors.length > 0 ? (
        <ErrorBanner title="Le document enregistré est invalide : le site affiche les valeurs par défaut.">
          <ul className="mt-1 list-disc ps-5">
            {view.errors.map((error) => (
              <li key={error}>{error}</li>
            ))}
          </ul>
          Enregistrer ce formulaire le remplace.
        </ErrorBanner>
      ) : null}
      {view.missing.length > 0 ? (
        <ErrorBanner tone="warning" title="Mentions obligatoires manquantes : la production refuse de démarrer.">
          Champs : {view.missing.join(", ")}.
        </ErrorBanner>
      ) : null}
      <LegalForm initial={view} />
    </>
  );
}
