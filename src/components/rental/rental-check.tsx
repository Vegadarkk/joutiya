"use client";

import { useRef, useState } from "react";
import { FileSearch, FileText, RefreshCw, ShieldAlert, ShieldCheck, ShieldQuestion } from "lucide-react";
import { useFormatter, useTranslations } from "next-intl";
import { useApiErrorMessage } from "@/components/auth/form-message";
import { InlineError } from "@/components/feedback/inline-error";
import { Button } from "@/components/ui/button";
import type { RentalCheckView } from "@/lib/contracts/pro";
import { loadProMe, submitRentalCheck, uploadKybcPiece } from "@/lib/pro/client";
import { cn } from "@/lib/utils";

// The check of a car rental agency's licence decision (decision 5), in its settings: the agency
// sends the decision (PDF or photo, sanitized and stored privately like the KYBC pieces), an AI
// reading compares it with the reference saved above and the shop's verified identity; consistent,
// the storefront shows « agrément contrôlé sur document le … », else a moderator decides. The
// collection notice sits above the button. Nothing is sent before a reference is saved.

type Phase = { kind: "idle" } | { kind: "uploading"; progress: number } | { kind: "sending" } | { kind: "failed"; message: string };

const STATUS_ICON = { pending: FileSearch, review: ShieldQuestion, verified: ShieldCheck, rejected: ShieldAlert } as const;

export function RentalCheckPanel({ check, savedRef, onChange }: { check: RentalCheckView | null; savedRef: string | null; onChange: (check: RentalCheckView | null) => void }) {
  const t = useTranslations("RentalAgency.check");
  const format = useFormatter();
  const apiMessage = useApiErrorMessage();
  const input = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [refreshing, setRefreshing] = useState(false);
  const busy = phase.kind === "uploading" || phase.kind === "sending";
  const day = (iso: string) => format.dateTime(new Date(iso), { dateStyle: "long", timeZone: "Africa/Casablanca" });

  async function send(file: File) {
    setPhase({ kind: "uploading", progress: 0 });
    try {
      const piece = await uploadKybcPiece(file, (progress) => setPhase({ kind: "uploading", progress }), undefined, "agrement");
      if (piece.status === "rejected") {
        setPhase({ kind: "failed", message: t(`pieceRejected.${piece.reason}`) });
        return;
      }
      setPhase({ kind: "sending" });
      onChange((await submitRentalCheck(piece.uploadId)).rentalCheck);
      setPhase({ kind: "idle" });
    } catch (error) {
      setPhase({ kind: "failed", message: apiMessage(error) });
    }
  }

  async function refresh() {
    setRefreshing(true);
    try {
      onChange((await loadProMe()).shop?.rentalCheck ?? null);
    } catch {
      // The status stays as shown; the next page load reads it again.
    } finally {
      setRefreshing(false);
    }
  }

  if (!savedRef) {
    return <p className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-foreground-muted text-pretty">{t("saveFirst")}</p>;
  }

  const Icon = check ? STATUS_ICON[check.status] : FileText;
  const canSend = !check || check.status !== "pending";
  return (
    <div data-testid="rental-check" data-status={check?.status ?? "none"} className="flex flex-col gap-4 rounded-md border border-border bg-surface-muted/40 p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className={cn(
            "flex size-9 shrink-0 items-center justify-center rounded-full",
            check?.status === "verified" ? "bg-success-surface text-success" : check?.status === "rejected" ? "bg-danger-surface text-danger" : "bg-surface-brand text-structure dark:text-gold-300",
          )}
        >
          <Icon className="size-[1.125rem]" />
        </span>
        <div className="flex min-w-0 flex-col gap-1">
          <h3 className="text-sm font-semibold">{t("title")}</h3>
          <p role="status" data-testid="rental-check-status" className="text-sm text-pretty">
            {!check
              ? t("none")
              : check.status === "verified" && check.checkedAt
                ? t("verified", { date: day(check.checkedAt) })
                : check.status === "pending"
                  ? t("pending")
                  : check.status === "review"
                    ? t("review")
                    : t("rejected")}
          </p>
          {check?.status === "rejected" && check.reason ? (
            <p dir="auto" className="rounded-md bg-surface px-3 py-2 text-sm whitespace-pre-line">
              {check.reason}
            </p>
          ) : null}
          {check?.status === "verified" ? <p className="text-xs text-foreground-muted text-pretty">{t("verifiedNote")}</p> : null}
        </div>
      </div>
      <p className="text-xs text-foreground-muted text-pretty">{t("notice")}</p>
      <div className="flex flex-wrap items-center gap-3">
        <input
          ref={input}
          type="file"
          accept="application/pdf,image/jpeg,image/png"
          className="sr-only"
          tabIndex={-1}
          onChange={(event) => {
            const file = event.target.files?.[0];
            if (input.current) input.current.value = "";
            if (file) void send(file);
          }}
        />
        {canSend ? (
          <Button type="button" variant={check ? "outline" : "structure"} loading={busy} onClick={() => input.current?.click()}>
            <FileText aria-hidden="true" />
            {check ? t("sendAnother") : t("send")}
          </Button>
        ) : (
          <Button type="button" variant="outline" loading={refreshing} onClick={() => void refresh()}>
            <RefreshCw aria-hidden="true" />
            {t("refresh")}
          </Button>
        )}
        {phase.kind === "uploading" ? <span className="text-sm text-foreground-muted tabular-nums">{t("uploading", { percent: Math.round(phase.progress * 100) })}</span> : null}
        {phase.kind === "sending" ? <span className="text-sm text-foreground-muted">{t("sending")}</span> : null}
      </div>
      {phase.kind === "failed" ? <InlineError>{phase.message}</InlineError> : null}
    </div>
  );
}
