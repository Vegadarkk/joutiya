"use client";

import { useEffect, useState, type FormEvent } from "react";
import { BellRing, Pencil, Search, Trash2 } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { Dialog } from "radix-ui";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { EmptyState } from "@/components/feedback/empty-state";
import { ConfirmDialog } from "@/components/post/controls/confirm-dialog";
import { SwitchField } from "@/components/post/controls/switch";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import type { Locale } from "@/config/site";
import { Link } from "@/i18n/navigation";
import { SAVED_SEARCHES_MAX, SAVED_SEARCH_NAME_MAX, type SavedSearchView } from "@/lib/contracts/search";
import { intlLocale } from "@/lib/listings/client/format";
import { deleteSavedSearch, listSavedSearches, updateSavedSearch } from "@/lib/saved-searches/client";
import { searchQueryObject, SEARCH_PATH } from "@/lib/search/params";
import { cn } from "@/lib/utils";
import { useSearchSummary } from "./summary";

// "Mes recherches" (design D18): the saved searches (10 at most), each with its filters, the daily
// alert switch, open, rename and delete. The gold edge of a row marks an active alert.

type View = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; searches: SavedSearchView[] };

export function formatDay(iso: string, locale: Locale): string {
  return new Intl.DateTimeFormat(intlLocale(locale), { day: "numeric", month: "long", timeZone: "Africa/Casablanca" }).format(new Date(iso));
}

function RenameDialog({ search, onClose, onRenamed }: { search: SavedSearchView | null; onClose: () => void; onRenamed: (search: SavedSearchView) => void }) {
  const t = useTranslations("SavedSearches.rename");
  const [name, setName] = useState(search?.name ?? "");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [nameError, setNameError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!search) return;
    const trimmed = name.trim();
    if (!trimmed) {
      setNameError(t("required"));
      return;
    }
    setPending(true);
    setError(null);
    try {
      const { search: updated } = await updateSavedSearch(search.id, { name: trimmed });
      onRenamed(updated);
    } catch (caught) {
      setError(caught);
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog.Root open={search !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          className={cn(
            "fixed inset-x-4 bottom-4 z-50 rounded-lg border border-border bg-surface shadow-xl shadow-bab-950/20 outline-none",
            "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-md sm:-translate-x-1/2 sm:-translate-y-1/2 rtl:sm:translate-x-1/2",
            "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
          )}
        >
          <form onSubmit={(event) => void onSubmit(event)} className="flex flex-col gap-4 p-6" noValidate>
            <Dialog.Title className="text-lg font-semibold text-balance">{t("title")}</Dialog.Title>
            <Dialog.Description className="sr-only">{t("body")}</Dialog.Description>
            <Field label={t("label")} error={nameError ?? undefined} required>
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
            <FormMessage error={error} />
            <div className="mt-2 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
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

function SearchRow({
  search,
  busy,
  onAlert,
  onRename,
  onDelete,
}: {
  search: SavedSearchView;
  busy: boolean;
  onAlert: (on: boolean) => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const t = useTranslations("SavedSearches.page");
  const locale = useLocale() as Locale;
  const { summarize } = useSearchSummary();
  const parts = summarize(search.params);
  const on = search.alert === "daily";
  const status = search.lastAlertAt ? t("lastAlert", { date: formatDay(search.lastAlertAt, locale) }) : on ? t("alertPending") : t("alertOff");

  return (
    <li
      data-testid="saved-search"
      className={cn(
        "flex flex-col gap-4 rounded-lg border border-border bg-surface p-4 ps-5 transition-[border-color] duration-200 ease-door sm:p-5 sm:ps-6",
        "border-s-4",
        on ? "border-s-featured" : "border-s-border-strong",
      )}
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="text-lg font-semibold break-words">{search.name}</h2>
        {parts.length > 0 ? (
          <ul aria-label={t("criteriaOf", { name: search.name })} className="flex flex-wrap gap-1.5">
            {parts.map((part) => (
              <li key={part} className="max-w-full truncate rounded-full bg-surface-muted px-2.5 py-0.5 text-sm text-foreground-muted">
                {part}
              </li>
            ))}
          </ul>
        ) : null}
        <p className="text-xs text-foreground-muted">{t("savedOn", { date: formatDay(search.createdAt, locale) })}</p>
      </div>

      <SwitchField
        className="border-y border-border py-3"
        label={
          <span className="inline-flex items-center gap-2">
            <BellRing className={cn("size-4", on ? "text-featured-foreground dark:text-featured" : "text-foreground-muted")} aria-hidden="true" />
            {t("alert")}
            <span className="sr-only">{t("alertFor", { name: search.name })}</span>
          </span>
        }
        hint={status}
        checked={on}
        disabled={busy}
        onCheckedChange={onAlert}
      />

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild variant="structure" size="sm" className="max-sm:h-11">
          <Link href={{ pathname: SEARCH_PATH, query: searchQueryObject(search.params) }} aria-label={t("openOf", { name: search.name })}>
            <Search aria-hidden="true" />
            {t("open")}
          </Link>
        </Button>
        <Button type="button" variant="ghost" size="sm" className="max-sm:h-11" onClick={onRename} disabled={busy} aria-label={t("renameOf", { name: search.name })}>
          <Pencil aria-hidden="true" />
          <span aria-hidden="true">{t("rename")}</span>
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-danger hover:bg-danger-surface max-sm:h-11"
          onClick={onDelete}
          disabled={busy}
          aria-label={t("deleteOf", { name: search.name })}
        >
          <Trash2 aria-hidden="true" />
          <span aria-hidden="true">{t("delete")}</span>
        </Button>
      </div>
    </li>
  );
}

export function SavedSearchesView() {
  const t = useTranslations("SavedSearches.page");
  const apiMessage = useApiErrorMessage();
  const [view, setView] = useState<View>({ kind: "loading" });
  const [busy, setBusy] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<SavedSearchView | null>(null);
  const [deleting, setDeleting] = useState<SavedSearchView | null>(null);
  // Bumped by retry(): the effect loads the list again.
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let current = true;
    listSavedSearches().then(
      ({ searches }) => {
        if (current) setView({ kind: "ready", searches });
      },
      (error: unknown) => {
        if (current) setView({ kind: "failed", error });
      },
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  function retry() {
    setView({ kind: "loading" });
    setAttempt((value) => value + 1);
  }

  const replace = (search: SavedSearchView) => setView((current) => (current.kind === "ready" ? { kind: "ready", searches: current.searches.map((item) => (item.id === search.id ? search : item)) } : current));

  async function onAlert(search: SavedSearchView, on: boolean) {
    setBusy(search.id);
    replace({ ...search, alert: on ? "daily" : "none" });
    try {
      const { search: updated } = await updateSavedSearch(search.id, { alert: on ? "daily" : "none" });
      replace(updated);
      toast.success(on ? t("toasts.alertOn") : t("toasts.alertOff"));
    } catch (error) {
      replace(search);
      toast.error(apiMessage(error));
    } finally {
      setBusy(null);
    }
  }

  async function onConfirmDelete() {
    const search = deleting;
    if (!search) return;
    setBusy(search.id);
    try {
      await deleteSavedSearch(search.id);
      setView((current) => (current.kind === "ready" ? { kind: "ready", searches: current.searches.filter((item) => item.id !== search.id) } : current));
      setDeleting(null);
      toast.success(t("toasts.deleted"));
    } catch (error) {
      toast.error(apiMessage(error));
    } finally {
      setBusy(null);
    }
  }

  const browse = (
    <Button asChild>
      <Link href="/recherche">{t("browse")}</Link>
    </Button>
  );

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold text-balance">{t("title")}</h1>
        <p className="text-foreground-muted text-pretty">{t("lead")}</p>
        {view.kind === "ready" && view.searches.length > 0 ? (
          <p className="text-sm text-foreground-muted tabular-nums" data-testid="saved-searches-count">
            {t("count", { count: view.searches.length, max: SAVED_SEARCHES_MAX })}
          </p>
        ) : null}
      </header>

      {view.kind === "loading" ? (
        <ul role="status" aria-busy="true" aria-label={t("loading")} className="flex flex-col gap-4">
          {Array.from({ length: 3 }, (_, index) => (
            <li key={index} className="flex flex-col gap-3 rounded-lg border border-border p-5">
              <Skeleton className="h-6 w-1/2" />
              <Skeleton className="h-5 w-3/4" />
              <Skeleton className="h-11 w-full" />
            </li>
          ))}
        </ul>
      ) : view.kind === "failed" ? (
        <FormMessage
          error={view.error}
          title={t("loadFailedTitle")}
          action={
            <Button type="button" variant="outline" size="sm" className="max-sm:h-11" onClick={retry}>
              {t("retry")}
            </Button>
          }
        >
          {apiMessage(view.error)}
        </FormMessage>
      ) : view.searches.length === 0 ? (
        <EmptyState title={t("emptyTitle")} action={browse}>
          {t("emptyBody")}
        </EmptyState>
      ) : (
        <ul className="flex flex-col gap-4" data-testid="saved-searches">
          {view.searches.map((search) => (
            <SearchRow
              key={search.id}
              search={search}
              busy={busy === search.id}
              onAlert={(on) => void onAlert(search, on)}
              onRename={() => setRenaming(search)}
              onDelete={() => setDeleting(search)}
            />
          ))}
        </ul>
      )}

      {renaming ? (
        <RenameDialog
          key={renaming.id}
          search={renaming}
          onClose={() => setRenaming(null)}
          onRenamed={(updated) => {
            replace(updated);
            setRenaming(null);
            toast.success(t("toasts.renamed"));
          }}
        />
      ) : null}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => (open ? undefined : setDeleting(null))}
        title={deleting ? t("confirm.title", { name: deleting.name }) : ""}
        body={t("confirm.body")}
        cancelLabel={t("confirm.cancel")}
        confirmLabel={t("confirm.confirm")}
        loading={deleting !== null && busy === deleting.id}
        onConfirm={() => void onConfirmDelete()}
      />
    </div>
  );
}
