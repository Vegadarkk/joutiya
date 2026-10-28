"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleAlert, Download, FileSpreadsheet, Upload } from "lucide-react";
import { useTranslations } from "next-intl";
import { FormMessage } from "@/components/auth/form-message";
import { ErrorBanner } from "@/components/feedback/error-banner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { textLinkClassName } from "@/components/ui/text-link";
import { Link } from "@/i18n/navigation";
import { isApiError } from "@/lib/auth/client";
import { STOCK_IMPORT_MAX_BYTES, STOCK_IMPORT_MAX_ROWS, type StockImportResponse, type StockListing, type StockRowAction, type StockRowResult } from "@/lib/contracts/stock-import";
import { importStockFile, loadStock } from "@/lib/pro/client";
import { stockTemplateCsv } from "@/lib/pro/stock-import/template";
import { cn } from "@/lib/utils";
import { AbsentStep, PhotosStep, PublishStep } from "./stock-steps";
import { FileDrop, Step } from "./stock-ui";

// /pro/stock: the stock import of a Pro shop (Concession pack, design concession/concession.md §4).
// Five steps in order: the file (template, pick or drop), the server's line-by-line preview, the
// import itself, then the photos matched by file name, the publication of the complete drafts,
// and the references missing from the file (marked sold on request, never automatically).

type StockView = { kind: "loading" } | { kind: "failed"; error: unknown } | { kind: "ready"; listings: StockListing[] };

interface PickedFile {
  name: string;
  text: string;
}

const ACTION_ORDER: readonly StockRowAction[] = ["create", "update", "unchanged", "error"];
const ACTION_TONE: Record<StockRowAction, "success" | "warning" | "neutral" | "danger"> = { create: "success", update: "warning", unchanged: "neutral", error: "danger" };
const ACTION_BAR: Record<StockRowAction, string> = { create: "bg-success", update: "bg-ochre-500", unchanged: "bg-border-strong", error: "bg-danger" };

/** UTF-8 first; a file saved as "CSV" by Excel on Windows is Windows-1252. */
export function decodeCsv(bytes: ArrayBuffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("windows-1252").decode(bytes);
  }
}

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([stockTemplateCsv()], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = "modele-stock.csv";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function StockImport({ nonce }: { nonce?: string }) {
  const t = useTranslations("StockImport");
  const [stock, setStock] = useState<StockView>({ kind: "loading" });
  const [file, setFile] = useState<PickedFile | null>(null);
  const [fileError, setFileError] = useState<"too_large" | "not_csv" | null>(null);
  const [preview, setPreview] = useState<StockImportResponse | null>(null);
  const [applied, setApplied] = useState<StockImportResponse | null>(null);
  const [busy, setBusy] = useState<"preview" | "apply" | null>(null);
  const [error, setError] = useState<unknown>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    try {
      setStock({ kind: "ready", listings: (await loadStock()).listings });
    } catch (caught) {
      setStock({ kind: "failed", error: caught });
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, [refresh]);

  async function send(mode: "preview" | "apply", picked: PickedFile) {
    setBusy(mode);
    setError(null);
    try {
      const result = await importStockFile(mode, picked.text);
      if (mode === "preview") {
        setPreview(result);
        setApplied(null);
      } else {
        setApplied(result);
        await refresh();
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(null);
    }
  }

  async function pick(chosen: File | undefined) {
    if (!chosen) return;
    setPreview(null);
    setApplied(null);
    setError(null);
    if (chosen.size > STOCK_IMPORT_MAX_BYTES) return setFileError("too_large");
    if (!/\.(csv|txt|tsv)$/i.test(chosen.name) && !/csv|text\/plain|tab-separated/.test(chosen.type)) return setFileError("not_csv");
    setFileError(null);
    const picked = { name: chosen.name, text: decodeCsv(await chosen.arrayBuffer()) };
    setFile(picked);
    await send("preview", picked);
  }

  if (stock.kind === "loading") return <Skeleton className="h-64 w-full" />;
  if (stock.kind === "failed") {
    if (!isApiError(stock.error, "forbidden", "pro_not_verified", "role_missing")) return <FormMessage error={stock.error} />;
    return (
      <ErrorBanner tone="warning" title={t("notPro.title")}>
        {t("notPro.body")}{" "}
        <Link href="/pro" className={cn("text-link", textLinkClassName)}>
          {t("notPro.link")}
        </Link>
      </ErrorBanner>
    );
  }

  const result = applied ?? preview;
  const writable = preview ? preview.rows.filter((row) => row.action === "create" || row.action === "update").length : 0;

  return (
    <ol className="flex flex-col gap-10">
      <Step index={1} title={t("file.title")} lead={t("file.lead", { rows: STOCK_IMPORT_MAX_ROWS })}>
        <div className="flex flex-wrap gap-3">
          <Button variant="outline" onClick={downloadTemplate}>
            <Download aria-hidden="true" />
            {t("file.template")}
          </Button>
        </div>
        <FileDrop accept=".csv,text/csv,.txt,.tsv" label={t("file.pick")} hint={file ? t("file.chosen", { name: file.name }) : t("file.hint")} icon={<FileSpreadsheet aria-hidden="true" className="size-6" />} onFiles={(files) => void pick(files[0])} busy={busy === "preview"} />
        {fileError ? <ErrorBanner title={t(`file.errors.${fileError}`)} /> : null}
        <details className="group rounded-md border border-border bg-surface px-4 py-3 text-sm">
          <summary className="cursor-pointer font-medium">{t("file.columnsTitle")}</summary>
          <p className="mt-2 text-foreground-muted text-pretty">{t("file.columns")}</p>
        </details>
      </Step>

      <Step index={2} title={t("preview.title")} lead={t("preview.lead")} muted={!preview && !error}>
        {isApiError(error, "invalid_csv") ? <ErrorBanner title={t(`csvErrors.${csvReason(error.details)}`, { line: csvLine(error.details) })} /> : <FormMessage error={error ?? undefined} />}
        {result ? <Preview result={result} /> : null}
        {preview && !applied ? (
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={writable === 0} loading={busy === "apply"} onClick={() => file && void send("apply", file)}>
              <Upload aria-hidden="true" />
              {t("preview.apply", { count: writable })}
            </Button>
            <p className="text-sm text-foreground-muted">{t("preview.remaining", { count: preview.remaining ?? 0 })}</p>
          </div>
        ) : null}
        {applied ? <p className="text-sm font-medium text-success">{t("preview.done", { created: count(applied.rows, "create"), updated: count(applied.rows, "update") })}</p> : null}
      </Step>

      <PhotosStep stock={stock.listings} onDone={refresh} />
      <PublishStep stock={stock.listings} nonce={nonce} onDone={refresh} />
      <AbsentStep absent={result?.absent ?? []} onDone={refresh} />
    </ol>
  );
}

const count = (rows: readonly StockRowResult[], action: StockRowAction) => rows.filter((row) => row.action === action).length;
const csvReason = (details: unknown) => {
  const reason = (details as { reason?: string } | undefined)?.reason;
  return reason === "unclosed_quote" || reason === "too_many_rows" ? reason : "empty";
};
const csvLine = (details: unknown) => (details as { line?: number } | undefined)?.line ?? 1;

function Preview({ result }: { result: StockImportResponse }) {
  const t = useTranslations("StockImport");
  const [errorsOnly, setErrorsOnly] = useState(false);
  const total = result.rows.length;
  const counts = useMemo(() => Object.fromEntries(ACTION_ORDER.map((action) => [action, count(result.rows, action)])) as Record<StockRowAction, number>, [result.rows]);
  const rows = errorsOnly ? result.rows.filter((row) => row.action === "error" || row.issues.length > 0) : result.rows;
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex h-2.5 w-full overflow-hidden rounded-full bg-surface-muted" aria-hidden="true">
          {ACTION_ORDER.map((action) => (counts[action] > 0 ? <span key={action} className={ACTION_BAR[action]} style={{ width: `${(counts[action] / total) * 100}%` }} /> : null))}
        </div>
        <ul className="flex flex-wrap gap-x-5 gap-y-1 text-sm" aria-label={t("preview.summary")}>
          {ACTION_ORDER.map((action) => (
            <li key={action} className="flex items-center gap-2">
              <span aria-hidden="true" className={cn("size-2.5 rounded-full", ACTION_BAR[action])} />
              <span className="tabular-nums">{t(`actions.${action}Count`, { count: counts[action] })}</span>
            </li>
          ))}
        </ul>
      </div>
      {result.ignoredColumns.length > 0 ? (
        <p className="flex items-start gap-2 text-sm text-foreground-muted">
          <CircleAlert aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
          {t("preview.ignored", { columns: result.ignoredColumns.join(", ") })}
        </p>
      ) : null}
      <label className="flex w-fit items-center gap-2 text-sm">
        <input type="checkbox" checked={errorsOnly} onChange={(event) => setErrorsOnly(event.target.checked)} className="size-4 accent-structure" />
        {t("preview.errorsOnly")}
      </label>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-[36rem] text-start text-sm" data-testid="stock-preview">
          <thead className="bg-surface-muted text-foreground-muted">
            <tr>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("preview.line")}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("preview.ref")}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("preview.vehicle")}
              </th>
              <th scope="col" className="px-3 py-2 text-start font-medium">
                {t("preview.action")}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.line} className="border-t border-border align-top">
                <td className="px-3 py-2.5 tabular-nums text-foreground-muted">{row.line}</td>
                <td className="px-3 py-2.5 font-medium" dir="ltr">
                  {row.ref || "—"}
                </td>
                <td className="px-3 py-2.5">
                  <span className="block">{row.title || "—"}</span>
                  {row.changes?.length ? <span className="block text-xs text-foreground-muted">{t("preview.changes", { fields: row.changes.map((field) => t(`fields.${fieldKey(field)}`)).join(", ") })}</span> : null}
                  {row.issues.length > 0 ? (
                    <ul className="mt-1 flex flex-col gap-0.5 text-xs">
                      {row.issues.map((issue, index) => (
                        <li key={index} className={row.action === "error" ? "text-danger" : "text-warning"}>
                          {t("preview.issue", { column: issue.column, message: t(`codes.${issue.code}`) })}
                          {issue.value && issue.code !== "failed" ? <span className="text-foreground-muted"> « {issue.value} »</span> : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td className="px-3 py-2.5">
                  <Badge variant={ACTION_TONE[row.action]}>{t(`actions.${row.action}`)}</Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const FIELD_KEYS = ["subcategoryId", "title", "description", "price", "priceNegotiable", "condition", "attributes", "location"] as const;
const fieldKey = (field: string) => ((FIELD_KEYS as readonly string[]).includes(field) ? (field as (typeof FIELD_KEYS)[number]) : "attributes");
