"use client";

import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "radix-ui";
import { Download, KeyRound, LogOut } from "lucide-react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { FormMessage, useApiErrorMessage } from "@/components/auth/form-message";
import { Section } from "@/components/auth/settings-section";
import { EmptyState } from "@/components/feedback/empty-state";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Button } from "@/components/ui/button";
import type { Locale } from "@/config/site";
import { Link, useRouter } from "@/i18n/navigation";
import { numbersLocale } from "@/i18n/params";
import { apiDownload, apiPost, isApiError, setSession, signOut } from "@/lib/auth/client";
import { ACCOUNT_API } from "@/lib/contracts/endpoints";
import type { CloseAccountResponse } from "@/lib/contracts/account";
import { cn } from "@/lib/utils";
import { moroccoTimeZone } from "@/lib/i18n/morocco-time";

// /parametres, last two sections (phase 5 design D26, lot L7): the personal data export (a JSON
// file, three a day) and the account closure. The closure dialog lays out what happens on a time
// line (today, the account data purge one year later, the civil identity five years later: AF §7),
// asks for an explicit acknowledgement, and handles the refusals: a sign-in older than ten minutes
// (sign in again, then come back), a Pro subscription still renewing, purchased credits left. Once
// closed, the settings page gives way to AccountClosedView (a toast would not survive the trip to
// the home page, another root layout, and the session ends with the closure).

/** Saves a downloaded file under its name (an object URL clicked by a detached link). */
function saveFile(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.rel = "noopener";
  document.body.append(link);
  link.click();
  link.remove();
  // Revoked after the click has been handed to the browser's download manager.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function exportName(): string {
  return `aalan-mes-donnees-${new Date().toISOString().slice(0, 10)}.json`;
}

export function DataSection() {
  const t = useTranslations("Account.data");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();

  async function download() {
    setError(undefined);
    setBusy(true);
    try {
      const file = await apiDownload(ACCOUNT_API.export);
      saveFile(file.blob, file.filename ?? exportName());
      toast.success(t("downloaded"));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Section id="data" title={t("title")} body={t("body")}>
      <div className="flex flex-col items-start gap-4">
        <FormMessage error={error} />
        <p className="text-sm text-pretty">{t("contents")}</p>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button type="button" variant="outline" loading={busy} onClick={() => void download()}>
            <Download aria-hidden="true" />
            {t("download")}
          </Button>
          <span className="text-sm text-foreground-muted">{t("limit")}</span>
        </div>
      </div>
    </Section>
  );
}

function addYears(from: Date, years: number): Date {
  const date = new Date(from.getTime());
  date.setUTCFullYear(date.getUTCFullYear() + years);
  return date;
}

/** One step of the closure time line: its date and what happens then. */
function Step({ when, children, tone }: { when: string; children: string; tone: "now" | "later" }) {
  return (
    <li className="relative ps-6">
      <span
        aria-hidden="true"
        className={cn(
          "absolute -start-[5px] top-1.5 size-2.5 rounded-full ring-4 ring-surface",
          tone === "now" ? "bg-danger" : "border-2 border-border-strong bg-surface",
        )}
      />
      <p className="text-sm font-semibold">{when}</p>
      <p className="mt-1 text-sm text-foreground-muted text-pretty">{children}</p>
    </li>
  );
}

type Refusal = "recent_auth" | "pro" | "wallet";

function refusalOf(error: unknown): Refusal | null {
  if (isApiError(error, "recent_auth_required")) return "recent_auth";
  if (isApiError(error, "pro_subscription_active")) return "pro";
  if (isApiError(error, "wallet_not_empty")) return "wallet";
  return null;
}

export function CloseAccountSection({ onClosed }: { onClosed: (closed: CloseAccountResponse) => void }) {
  const t = useTranslations("Account.close");
  const locale = useLocale() as Locale;
  const router = useRouter();
  const message = useApiErrorMessage();
  const checkId = useId();
  const [open, setOpen] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  const refusal = refusalOf(error);

  const now = new Date();
  const day = (date: Date) => new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeZone: moroccoTimeZone(date.getTime()) }).format(date);
  const purgeDay = day(addYears(now, 1));
  const identityDay = day(addYears(now, 5));

  function onOpenChange(next: boolean) {
    if (busy) return;
    setOpen(next);
    if (!next) {
      setAcknowledged(false);
      setError(undefined);
    }
  }

  async function close() {
    setError(undefined);
    setBusy(true);
    try {
      const closed = await apiPost<CloseAccountResponse>(ACCOUNT_API.close, { confirm: true });
      // The page shows the closure first, then the server's cleared cookies are forgotten here too.
      onClosed(closed);
      setSession(null);
    } catch (caught) {
      setError(caught);
      setBusy(false);
    }
  }

  async function signInAgain() {
    await signOut();
    router.replace({ pathname: "/connexion", query: { next: "/parametres" } });
    router.refresh();
  }

  return (
    <Section id="close" title={t("title")} body={t("body")}>
      <Dialog.Root open={open} onOpenChange={onOpenChange}>
        <Dialog.Trigger asChild>
          <Button type="button" variant="outline" className="w-fit border-danger/40 text-danger hover:border-danger hover:bg-danger-surface">
            <LogOut aria-hidden="true" className="rtl:-scale-x-100" />
            {t("open")}
          </Button>
        </Dialog.Trigger>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 z-50 bg-bab-950/50 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
          <Dialog.Content
            className={cn(
              "fixed inset-x-4 bottom-4 z-50 flex max-h-[calc(100dvh-2rem)] flex-col gap-5 overflow-y-auto rounded-lg border border-border bg-surface p-6 shadow-xl shadow-bab-950/20 outline-none",
              "sm:inset-x-auto sm:start-1/2 sm:top-1/2 sm:bottom-auto sm:w-full sm:max-w-lg sm:-translate-x-1/2 sm:-translate-y-1/2 rtl:sm:translate-x-1/2",
              "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95",
            )}
          >
            <div className="flex flex-col gap-2">
              <Dialog.Title className="text-xl font-semibold text-balance">{t("dialogTitle")}</Dialog.Title>
              <Dialog.Description className="text-foreground-muted text-pretty">{t("dialogLead")}</Dialog.Description>
            </div>

            <ol className="ms-[5px] flex flex-col gap-5 border-s border-border-strong">
              <Step when={t("now")} tone="now">
                {t("nowBody")}
              </Step>
              <Step when={purgeDay} tone="later">
                {t("purgeBody")}
              </Step>
              <Step when={identityDay} tone="later">
                {t("identityBody")}
              </Step>
            </ol>

            <p className="rounded-md bg-surface-muted px-4 py-3 text-sm text-pretty">{t("exportFirst")}</p>

            {refusal === "recent_auth" ? (
              <ErrorBanner
                tone="warning"
                title={t("reauthTitle")}
                action={
                  <Button type="button" variant="outline" size="sm" onClick={() => void signInAgain()}>
                    <KeyRound aria-hidden="true" />
                    {t("reauth")}
                  </Button>
                }
              >
                {t("reauthBody")}
              </ErrorBanner>
            ) : refusal === "pro" ? (
              <ErrorBanner tone="warning" title={t("proTitle")}>
                {t("proBody")}
              </ErrorBanner>
            ) : refusal === "wallet" ? (
              <ErrorBanner tone="warning" title={t("walletTitle")}>
                {t("walletBody")}
              </ErrorBanner>
            ) : error ? (
              <ErrorBanner title={message(error)} />
            ) : null}

            <label htmlFor={checkId} className="flex cursor-pointer items-start gap-3 text-sm leading-relaxed">
              <input
                id={checkId}
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
                className="mt-1 size-5 shrink-0 cursor-pointer rounded-sm border-border-strong accent-danger"
              />
              <span className="text-pretty">{t("confirm")}</span>
            </label>

            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
              <Dialog.Close asChild>
                <Button type="button" variant="outline" disabled={busy}>
                  {t("cancel")}
                </Button>
              </Dialog.Close>
              <Button type="button" variant="danger" loading={busy} disabled={!acknowledged || refusal !== null} onClick={() => void close()}>
                {t("submit")}
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </Section>
  );
}

/** What the settings page shows once the account is closed: the purge date, and the way out. */
export function AccountClosedView({ closed }: { closed: CloseAccountResponse }) {
  const t = useTranslations("Account.close");
  const locale = useLocale() as Locale;
  const ref = useRef<HTMLDivElement>(null);
  const date = new Intl.DateTimeFormat(numbersLocale(locale), { dateStyle: "long", timeZone: moroccoTimeZone(new Date(closed.purgeAt).getTime()) }).format(new Date(closed.purgeAt));

  // The dialog and the sections are gone: back to the top of the (now short) page, focus on the message.
  useEffect(() => {
    window.scrollTo({ top: 0 });
    ref.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={ref} tabIndex={-1} role="status" className="rounded-lg outline-none">
      <EmptyState
        title={t("doneTitle")}
        action={
          <Button asChild>
            <Link href="/">{t("home")}</Link>
          </Button>
        }
      >
        {t("doneBody", { date })}
      </EmptyState>
    </div>
  );
}
