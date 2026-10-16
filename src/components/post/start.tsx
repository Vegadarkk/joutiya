"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Subcategory } from "@/config/categories";
import { Link, useRouter } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import { createListing, listMine } from "@/lib/listings/client/api";
import { wizardPath } from "@/lib/listings/client/routes";
import { CategoryPicker } from "./category-picker";

// `/deposer` without an id (design D3): resumes the most recent draft, or shows the category grid
// and creates the draft after the subcategory pick. `?nouveau=1` skips the resume (another listing).

type State = { kind: "checking" } | { kind: "pick"; failed?: unknown } | { kind: "creating" } | { kind: "resuming" } | { kind: "draftLimit" };

export function WizardStart() {
  const t = useTranslations("Listing.start");
  const apiMessage = useApiErrorMessage();
  const router = useRouter();
  const params = useSearchParams();
  const forceNew = params.get("nouveau") === "1";
  const [state, setState] = useState<State>({ kind: forceNew ? "pick" : "checking" });
  const [categoryId, setCategoryId] = useState<string | null>(null);
  const started = useRef(false);
  const creating = useRef(false);

  useEffect(() => {
    if (forceNew || started.current) return;
    started.current = true;
    void (async () => {
      try {
        const { listings } = await listMine("drafts");
        const latest = [...listings].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))[0];
        if (latest) {
          setState({ kind: "resuming" });
          router.replace(wizardPath(latest.id));
          return;
        }
      } catch {
        // The list is a convenience: without it the person simply starts a new listing.
      }
      setState({ kind: "pick" });
    })();
  }, [forceNew, router]);

  const onSubcategory = useCallback(
    async (subcategory: Subcategory) => {
      // One draft per pick, however fast the double tap.
      if (creating.current) return;
      creating.current = true;
      setState({ kind: "creating" });
      try {
        const { id } = await createListing({ categoryId: subcategory.categoryId, subcategoryId: subcategory.id });
        router.replace(wizardPath(id, "criteres"));
      } catch (error) {
        creating.current = false;
        if (isApiError(error, "draft_limit")) setState({ kind: "draftLimit" });
        else setState({ kind: "pick", failed: error });
      }
    },
    [router],
  );

  if (state.kind === "checking" || state.kind === "resuming" || state.kind === "creating") {
    return (
      <div role="status" aria-busy="true" className="flex flex-col items-center gap-4 py-16 text-foreground-muted">
        <Spinner className="size-8 text-primary" />
        <p>{state.kind === "creating" ? t("creating") : t("resuming")}</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
      </header>
      {state.kind === "draftLimit" ? (
        <ErrorBanner
          tone="warning"
          title={t("draftLimitTitle")}
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/mes-annonces">{t("myListings")}</Link>
            </Button>
          }
        >
          {t("draftLimitBody")}
        </ErrorBanner>
      ) : null}
      {state.kind === "pick" && state.failed ? (
        <FormMessage error={state.failed} title={t("createFailed")}>
          {apiMessage(state.failed)}
        </FormMessage>
      ) : null}
      <CategoryPicker categoryId={categoryId} subcategoryId={null} onCategory={setCategoryId} onSubcategory={(subcategory) => void onSubcategory(subcategory)} />
    </div>
  );
}
