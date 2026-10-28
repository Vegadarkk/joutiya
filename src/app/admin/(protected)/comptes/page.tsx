import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Button } from "@/components/ui/button";
import { inputClassName } from "@/components/ui/input";
import { requirePageStaff } from "@/lib/auth/current-user";
import { uidByPublicId } from "@/lib/decisions/users";
import { publicIdSchema } from "@/lib/db/schemas";

// Account lookup (design D24): by the public profile id staff read in a profile link
// (/fr/profil/{publicId}), then the account's moderation page.

export const metadata: Metadata = { title: "Comptes" };

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/** The id from a pasted profile link or the bare id. */
function profileId(raw: string): string {
  const trimmed = raw.trim();
  const match = /\/profil\/([^/?#]+)/.exec(trimmed);
  return match?.[1] ?? trimmed;
}

export default async function AccountsPage({ searchParams }: { searchParams: SearchParams }) {
  await requirePageStaff(["moderator", "admin"]);
  const raw = (await searchParams)["profil"];
  const query = typeof raw === "string" ? profileId(raw) : "";
  let problem: string | null = null;
  if (query) {
    const parsed = publicIdSchema.safeParse(query);
    const uid = parsed.success ? await uidByPublicId(parsed.data) : null;
    if (uid) redirect(`/comptes/${encodeURIComponent(uid)}`);
    problem = parsed.success ? "Aucun compte ne porte cet identifiant de profil." : "Cet identifiant de profil n'a pas le bon format.";
  }
  return (
    <>
      <div>
        <h1 className="text-2xl font-semibold">Comptes</h1>
        <p className="mt-1 max-w-prose text-sm text-foreground-muted">
          Échelle des sanctions, suspension en cours, fiabilité comme signalant et décisions d&apos;un compte. Collez le lien de son profil public ou son identifiant.
        </p>
      </div>
      <form method="get" action="/comptes" className="flex max-w-xl flex-col gap-2 rounded-lg border border-border bg-surface p-5">
        <label htmlFor="profil" className="text-sm font-medium">
          Profil public
        </label>
        <div className="flex gap-2">
          <input
            id="profil"
            name="profil"
            defaultValue={query}
            required
            placeholder="https://joutiya.ma/fr/profil/…"
            aria-invalid={problem ? true : undefined}
            aria-describedby={problem ? "profil-error" : undefined}
            className={inputClassName}
          />
          <Button type="submit" variant="structure">
            Ouvrir
          </Button>
        </div>
        {problem ? (
          <p id="profil-error" role="alert" className="text-sm text-danger">
            {problem}
          </p>
        ) : null}
      </form>
    </>
  );
}
