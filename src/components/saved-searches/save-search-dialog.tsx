"use client";

import { useId, useState, type FormEvent } from "react";
import { BellRing } from "lucide-react";
import { useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { FormMessage } from "@/components/auth/form-message";
import { SwitchField } from "@/components/post/controls/switch";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Link } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import { SAVED_SEARCH_NAME_MAX, type SavedSearchView } from "@/lib/contracts/search";
import { existingSearchId, saveSearch } from "@/lib/saved-searches/client";
import type { SearchParams } from "@/lib/search/params";
import { cn } from "@/lib/utils";

// "Sauvegarder la recherche" (design D18): name (proposed from the filters), the daily alert (on
// by default), the criteria being saved. A bottom sheet on phones, a centred dialog from sm (the
// ConfirmDialog frame). The same search saved before answers 409 with its id: reported as saved.

export interface SaveSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  params: SearchParams;
  suggestedName: string;
  summary: string[];
  /** Saved now, or found already saved (`existing`). */
  onSaved: (search: { id: string; existing: boolean; view?: SavedSearchView }) => void;
}

export function SaveSearchDialog({ open, onOpenChange, params, suggestedName, summary, onSaved }: SaveSearchDialogProps) {
  const t = useTranslations("SavedSearches.dialog");
  const summaryId = useId();
  const [name, setName] = useState(suggestedName);
  const [alert, setAlert] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  function onOpen(next: boolean) {
    if (next) {
      setName(suggestedName);
      setAlert(true);
      setError(null);
      setNameError(null);
    }
    onOpenChange(next);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t("nameRequired"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { search } = await saveSearch({ name: trimmed, params, alert: alert ? "daily" : "none" });
      onSaved({ id: search.id, existing: false, view: search });
    } catch (caught) {
      const existing = isApiError(caught, "saved_search_exists") ? existingSearchId(caught.details) : null;
      if (existing) onSaved({ id: existing, existing: true });
      else setError(caught);
    } finally {
      setPending(false);
    }
  }

  const limitReached = isApiError(error, "saved_search_limit");

  return (
    <Dialog.Root open={open} onOpenChange={onOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          data-testid="save-search-dialog"
          className={cn(
            "fixed inset-x-0 bottom-0 z-50 flex max-h-[92dvh] flex-col overflow-y-auto rounded-t-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 sm:rounded-lg rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-5 p-6 pb-[max(1.5rem,env(safe-area-inset-bottom))]" noValidate>
            <div className="flex flex-col gap-1.5">
              <Dialog.Title className="text-xl font-semibold text-balance">{t("title")}</Dialog.Title>
              <Dialog.Description className="text-foreground-muted text-pretty">{t("body")}</Dialog.Description>
            </div>

            {summary.length > 0 ? (
              <div className="flex flex-col gap-2">
                <p id={summaryId} className="text-sm font-medium">
                  {t("criteria")}
                </p>
                <ul aria-labelledby={summaryId} className="flex flex-wrap gap-1.5">
                  {summary.map((part) => (
                    <li key={part} className="max-w-full truncate rounded-full border border-structure/25 bg-surface-brand px-3 py-1 text-sm">
                      {part}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}

            <Field label={t("name")} hint={t("nameHint")} error={nameError ?? undefined} required>
              <Input
                value={name}
                maxLength={SAVED_SEARCH_NAME_MAX}
                autoComplete="off"
                onChange={(event) => {
                  setName(event.target.value);
                  if (nameError) setNameError(null);
                }}
              />
            </Field>

            <div className="rounded-md border border-border bg-surface-muted/60 px-4 py-2">
              <SwitchField
                label={
                  <span className="inline-flex items-center gap-2">
                    <BellRing className="size-4 text-featured-foreground dark:text-featured" aria-hidden="true" />
                    {t("alert")}
                  </span>
                }
                hint={t("alertHint")}
                checked={alert}
                onCheckedChange={setAlert}
              />
            </div>

            {error ? (
              <FormMessage
                error={error}
                action={
                  limitReached ? (
                    <Button asChild variant="outline" size="sm" className="max-sm:h-11">
                      <Link href="/recherches">{t("manage")}</Link>
                    </Button>
                  ) : undefined
                }
              />

            ) : null}

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <Button type="button" variant="outline">
                  {t("cancel")}
                </Button>
              </Dialog.Close>
              <Button type="submit" loading={pending}>
                {t("submit")}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
