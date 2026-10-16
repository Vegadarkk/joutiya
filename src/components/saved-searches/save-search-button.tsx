"use client";

import { useState } from "react";
import { BellPlus, Check } from "lucide-react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Link, useRouter } from "@/i18n/navigation";
import { loadSession } from "@/lib/auth/client";
import { isBlankSearch, sameSearch, type SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { SaveSearchDialog } from "./save-search-dialog";
import { useSearchSummary } from "./summary";

// "Sauvegarder la recherche" on /recherche (design D18), placed in the results toolbar slot.
// Anonymous visitors go to sign-in and come back to the same search. Nothing is read before the
// click (a saved search costs Firestore reads): an already saved search is recognised by the 409
// of the save itself. A blank search (no words, no filter) cannot be saved: no button.

export interface SaveSearchButtonProps {
  params: SearchParams;
  className?: string;
}

export function SaveSearchButton({ params, className }: SaveSearchButtonProps) {
  const t = useTranslations("SavedSearches.button");
  const router = useRouter();
  const { summarize, suggest } = useSearchSummary();
  const [open, setOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  // The search last saved from this button: the button says so until the filters change.
  const [savedFor, setSavedFor] = useState<SearchParams | null>(null);

  if (isBlankSearch(params)) return null;
  const saved = savedFor !== null && sameSearch(savedFor, params);

  async function onClick() {
    setChecking(true);
    const viewer = await loadSession();
    setChecking(false);
    if (!viewer) {
      router.push({ pathname: "/connexion", query: { next: `${window.location.pathname}${window.location.search}` } });
      return;
    }
    setOpen(true);
  }

  if (saved) {
    return (
      <Button asChild variant="outline" className={cn("border-structure/40", className)} data-testid="save-search-button" data-saved="true">
        <Link href="/recherches">
          <Check aria-hidden="true" className="text-success" />
          {t("saved")}
        </Link>
      </Button>
    );
  }

  return (
    <>
      <Button type="button" variant="outline" loading={checking} onClick={() => void onClick()} className={className} data-testid="save-search-button">
        {checking ? null : <BellPlus aria-hidden="true" />}
        {t("save")}
      </Button>
      {open ? (
        <SaveSearchDialog
          open={open}
          onOpenChange={setOpen}
          params={params}
          suggestedName={suggest(params)}
          summary={summarize(params)}
          onSaved={({ existing }) => {
            setOpen(false);
            setSavedFor(params);
            const action = { label: t("view"), onClick: () => router.push("/recherches") };
            if (existing) toast.info(t("exists"), { action });
            else toast.success(t("done"), { action });
          }}
        />
      ) : null}
    </>
  );
}
